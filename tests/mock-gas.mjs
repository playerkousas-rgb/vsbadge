// Mock GAS /exec 伺服器（測試專用）
// 模擬真實 GAS 行為：
//   - POST/GET /exec 一律 302 redirect 到 /usercontent/<rid>（模擬 script.google.com → script.googleusercontent.com）
//   - 路由 action 與 Code.gs 相同，回應 JSON
//   - 可用 /__control 切換故障模式：html-error / http500 / slow
//   - 獨立 in-memory store，方便驗證多旅團隔離
import http from 'http';

export function startMockGas({ port, name, users, apikey = '' }) {
  const state = {
    name,
    users: {},                    // ymis -> {ymis,name,email,role,pass,can_tick,status}
    tokens: {},                   // token -> ymis
    progress: {},                 // ymis -> {itemId:{date,confirmer}}
    otherBadges: {},              // ymis -> {badgeId:{name,date,cert}}
    requests: [],                 // {request_id,ymis,name,item_id,item_name,requested_date,evidence,status}
    applications: [],
    logs: [],                      // v8.1 活動履歷
    logRequests: [],               // v8.4 待批履歷（團員自行申報）
    config: { allow_member_view_others: 'false' },
    apikey,
    mode: 'normal',               // normal | html-error | http500 | slow
    slowMs: 0,
    lastExecPath: '',             // 观测上游實際被打的 URL（SSRF 测试用）
    execCount: 0
  };
  for (const u of users) state.users[u.ymis] = { status: 'active', email: '', ...u };

  // 與 Code.gs 一致的角色層級及可管理範圍（v8.2 帳戶申請審批用）
  const ROLE_LEVEL = { super_admin: 100, admin: 80, group_leader: 60, branch_leader: 40, exec_committee: 20, member: 0 };
  const CAN_MANAGE_ROLES = {
    super_admin: ['admin', 'group_leader', 'branch_leader', 'exec_committee', 'member'],
    admin: ['group_leader', 'branch_leader', 'exec_committee', 'member'],
    group_leader: ['branch_leader', 'exec_committee', 'member'],
    branch_leader: ['exec_committee', 'member']
  };

  const pendingRedirects = new Map(); // rid -> payload

  function routeAction(action, body) {
    const validKey = state.apikey && body.apikey === state.apikey;
    const tokenYmis = body.token && state.tokens[body.token] ? state.tokens[body.token] : null;
    switch (action) {
      case 'login': {
        const u = state.users[body.login_id] || Object.values(state.users).find(x => x.email && x.email === body.login_id);
        if (!u) return { success: false, error: '找不到此帳號或帳號已停用' };
        if (u.pass !== String(body.password || '')) return { success: false, error: '密碼錯誤' };
        const token = 'tok_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        state.tokens[token] = u.ymis;
        return { success: true, token, user: { ymis: u.ymis, name: u.name, role: u.role, can_tick: u.can_tick, allowed_badges: '*' } };
      }
      case 'logout': {
        delete state.tokens[body.token];
        return { success: true };
      }
      case 'apply': {
        // v8.2：只接受 member/exec_committee/branch_leader；branch 由前端自動帶旅團名
        const reqRole = String(body.requested_role || 'member');
        if (!['member', 'exec_committee', 'branch_leader'].includes(reqRole)) return { success: false, error: '無效的申請角色' };
        if (reqRole !== 'member' && !String(body.email || '').trim()) return { success: false, error: '執委／領袖申請必須填寫聯絡電郵' };
        state.applications.push({
          app_id: 'APP_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          ymis: body.ymis, name: body.name, email: body.email || '', requested_role: reqRole,
          branch: body.branch || '', status: 'pending', applied_at: '2026-08-17'
        });
        return { success: true, message: '申請已提交' };
      }
      case 'load': {
        // 與 Code.gs 一致：有提供 apikey 就必須正確
        if (state.apikey && body.apikey && body.apikey !== state.apikey) return { success: false, error: 'Invalid API Key' };
        if (state.apikey && !body.apikey) return { success: false, error: 'Invalid API Key' }; // mock 嚴格模式：設了 key 就必須帶
        const flat = {};
        for (const [y, items] of Object.entries(state.progress)) {
          flat[y] = {};
          for (const [iid, rec] of Object.entries(items)) flat[y][iid] = rec.date;
        }
        return {
          success: true,
          members: Object.values(state.users).map(u => ({ ymis: u.ymis, name: u.name })),
          flatProgress: flat,
          pendingRequests: state.requests.filter(r => r.status === 'pending'),
          otherBadges: state.otherBadges,
          logs: state.logs,
          logsSupported: true,
          logRequests: state.logRequests.filter(r => r.status === 'pending'),
          logRequestsSupported: true
        };
      }
      case 'save':
      case 'saveOtherBadge': {
        if (!validKey && !tokenYmis) return { success: false, error: '未授權 - 請重新登入' };
        if (action === 'save') {
          let processed = 0;
          for (const c of body.changes || []) {
            if (!state.progress[c.ymis]) state.progress[c.ymis] = {};
            if (c.uncomplete) { delete state.progress[c.ymis][c.itemId]; }
            else { state.progress[c.ymis][c.itemId] = { date: c.date, confirmer: body.confirmer || '' }; }
            processed++;
          }
          return { success: true, processed };
        }
        let c = 0;
        for (const r of body.records || []) {
          if (!state.otherBadges[r.ymis]) state.otherBadges[r.ymis] = {};
          state.otherBadges[r.ymis][r.badgeId] = { name: r.name, date: r.date, cert: r.cert || '' };
          c++;
        }
        return { success: true, processed: c };
      }
      case 'requestComplete': {
        if (!tokenYmis) return { success: false, error: '未授權，請重新登入' };
        const rid = 'REQ_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        state.requests.push({
          request_id: rid, ymis: tokenYmis, name: body.name || tokenYmis,
          item_id: body.itemId, item_name: body.itemName || body.itemId,
          requested_date: body.requested_date, evidence: body.evidence || '', status: 'pending'
        });
        return { success: true, request_id: rid };
      }
      case 'getPendingRequests': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, requests: state.requests.filter(r => r.status === 'pending') };
      }
      case 'reviewRequest': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const req = state.requests.find(r => r.request_id === body.request_id);
        if (!req) return { success: false, error: '找不到申請' };
        req.status = body.decision;
        if (body.decision === 'approved') {
          if (!state.progress[req.ymis]) state.progress[req.ymis] = {};
          state.progress[req.ymis][req.item_id] = { date: body.confirmed_date || req.requested_date, confirmer: tokenYmis };
          return { success: true, message: '已批准並寫入進度' };
        }
        return { success: true, message: '已拒絕' };
      }
      case 'getConfig':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, config: state.config };
      case 'updateConfig':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        state.config[body.key] = body.value;
        return { success: true };
      case 'getAllUsers':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, users: Object.values(state.users).map(u => ({ ymis: u.ymis, name: u.name, role: u.role, can_tick: u.can_tick, status: u.status })) };
      case 'getApplications': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const manager = state.users[tokenYmis];
        if (!manager || (ROLE_LEVEL[manager.role] || 0) < 40) return { success: false, error: '權限不足，需支部領袖或以上' };
        return { success: true, applications: state.applications.filter(a => a.status === 'pending') };
      }
      case 'reviewApplication': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const manager = state.users[tokenYmis];
        if (!manager || (ROLE_LEVEL[manager.role] || 0) < 40) return { success: false, error: '權限不足' };
        const app = state.applications.find(a => a.app_id === body.app_id);
        if (!app || app.status !== 'pending') return { success: false, error: '找不到待審批申請' };
        if (body.decision === 'rejected') { app.status = 'rejected'; return { success: true, message: '已拒絕申請' }; }
        if (body.decision !== 'approved') return { success: false, error: '無效決定' };
        const password = String(body.temp_password || '1234');
        const reqRole = app.requested_role || 'member';
        const finalRole = (CAN_MANAGE_ROLES[manager.role] || []).includes(reqRole) ? reqRole : 'member';
        state.users[app.ymis] = {
          ymis: app.ymis, name: app.name, email: app.email || '', role: finalRole, pass: password,
          can_tick: finalRole !== 'member', status: 'active'
        };
        app.status = 'approved';
        return { success: true, message: '已批准並建立帳號', temp_password: password, final_role: finalRole };
      }
      case 'updateUserRole': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const u = state.users[body.target_ymis];
        if (!u) return { success: false, error: '找不到目標用戶' };
        if (body.new_role) u.role = body.new_role;
        if (body.can_tick !== undefined) u.can_tick = body.can_tick === true || body.can_tick === 'true';
        return { success: true };
      }
      case 'getLogRecords':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, logs: state.logs };
      case 'saveLogRecord': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const writer = state.users[tokenYmis];
        if (!writer || !['admin', 'group_leader', 'branch_leader', 'exec_committee', 'super_admin'].includes(writer.role) || writer.can_tick !== true)
          return { success: false, error: '權限不足，需已獲勾選權限的領袖' };
        const results = [];
        let processed = 0;
        for (const r of (body.records || [])) {
          if (!r.ymis || !r.title || !r.date) { results.push({ success: false, ymis: r.ymis, error: 'YMIS、名稱及日期必填' }); continue; }
          if (r.record_id) {
            const idx = state.logs.findIndex(x => x.record_id === r.record_id);
            if (idx < 0) { results.push({ success: false, record_id: r.record_id, error: '找不到紀錄' }); continue; }
            state.logs[idx] = { ...state.logs[idx], ...r, recorder: body.recorder_name || String(tokenYmis) };
            results.push({ success: true, record_id: r.record_id });
            processed++;
            continue;
          }
          const nid = 'LOG_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
          state.logs.push({ ...r, record_id: nid, recorder: body.recorder_name || String(tokenYmis), recorded_at: '2026-08-06' });
          results.push({ success: true, record_id: nid });
          processed++;
        }
        const failed = results.filter(x => !x.success).length;
        return { success: results.length > 0 && failed === 0, processed, results, message: processed + ' 筆已儲存' + (failed ? '，' + failed + ' 筆失敗' : '') };
      }
      case 'deleteLogRecord': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const writer = state.users[tokenYmis];
        if (!writer || !['admin', 'group_leader', 'branch_leader', 'exec_committee', 'super_admin'].includes(writer.role) || writer.can_tick !== true)
          return { success: false, error: '權限不足，需已獲勾選權限的領袖' };
        const idx = state.logs.findIndex(x => x.record_id === body.record_id);
        if (idx < 0) return { success: false, error: '找不到紀錄' };
        state.logs.splice(idx, 1);
        return { success: true, message: '已刪除紀錄' };
      }
      // v8.4 履歷申報：團員自行申報 → 領袖審批（與 Code.gs 行為一致）
      case 'requestLogRecord': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const u = state.users[tokenYmis];
        const rec = body.record || {};
        if (!rec.title || !rec.date) return { success: false, error: '名稱及日期必填' };
        const kind = body.kind === 'edit' ? 'edit' : 'new';
        let targetId = '';
        let type = ['service', 'activity', 'training'].includes(rec.type) ? rec.type : 'activity';
        if (kind === 'edit') {
          targetId = String(body.target_record_id || '');
          if (!targetId) return { success: false, error: '缺少 target_record_id' };
          const orig = state.logs.find(x => x.record_id === targetId);
          if (!orig) return { success: false, error: '找不到原紀錄，可能已被刪除，請重新載入' };
          if (String(orig.ymis) !== String(tokenYmis)) return { success: false, error: '只可申請修改自己的紀錄' };
          if (state.logRequests.some(q => q.status === 'pending' && q.target_record_id === targetId))
            return { success: false, error: '此紀錄已有待批修改申報，請等待領袖審批或先取消' };
          type = orig.type || type;
        }
        const rid = 'LREQ_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        state.logRequests.push({
          request_id: rid, kind, target_record_id: targetId, type,
          ymis: tokenYmis, name: u.name, date: rec.date, title: rec.title,
          role: rec.role || '', hours: rec.hours || '', cert_no: rec.cert_no || '', detail: rec.detail || '',
          status: 'pending', created_at: '2026-08-28'
        });
        return { success: true, request_id: rid, message: '申報已提交，待領袖審批' };
      }
      case 'getLogRequests': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const u = state.users[tokenYmis];
        const isReviewer = ['admin', 'group_leader', 'branch_leader', 'exec_committee', 'super_admin'].includes(u.role) && u.can_tick === true;
        return { success: true, requests: state.logRequests.filter(r => r.status === 'pending' && (isReviewer || r.ymis === tokenYmis)) };
      }
      case 'reviewLogRequest': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const reviewer = state.users[tokenYmis];
        if (!reviewer || !['admin', 'group_leader', 'branch_leader', 'exec_committee', 'super_admin'].includes(reviewer.role) || reviewer.can_tick !== true)
          return { success: false, error: '權限不足，需已獲勾選權限的領袖' };
        if (body.decision !== 'approved' && body.decision !== 'rejected') return { success: false, error: '無效決定' };
        const req = state.logRequests.find(r => r.request_id === body.request_id && r.status === 'pending');
        if (!req) return { success: false, error: '找不到待批申報' };
        if (body.decision === 'rejected') { req.status = 'rejected'; return { success: true, message: '已拒絕申報' }; }
        let record;
        if (req.kind === 'edit') {
          const idx = state.logs.findIndex(x => x.record_id === req.target_record_id);
          if (idx < 0) return { success: false, error: '找不到原紀錄（可能已被刪除），無法批准修改' };
          state.logs[idx] = { ...state.logs[idx], type: req.type, date: req.date, title: req.title, role: req.role, hours: req.hours, cert_no: req.cert_no, detail: req.detail };
          record = state.logs[idx];
        } else {
          record = {
            record_id: 'LOG_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            type: req.type, ymis: req.ymis, name: req.name, date: req.date, title: req.title,
            role: req.role, hours: req.hours, cert_no: req.cert_no, detail: req.detail,
            recorder: req.name + '（自行申報）', recorded_at: '2026-08-28'
          };
          state.logs.push(record);
        }
        req.status = 'approved';
        return { success: true, message: req.kind === 'edit' ? '已批准修改並更新紀錄' : '已批准並寫入活動履歷', record_id: record.record_id, record };
      }
      case 'cancelLogRequest': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const u = state.users[tokenYmis];
        const idx = state.logRequests.findIndex(r => r.request_id === body.request_id);
        if (idx < 0) return { success: false, error: '找不到申報' };
        const req = state.logRequests[idx];
        if (req.status !== 'pending') return { success: false, error: '此申報已被審批，不能取消' };
        const isReviewer = ['admin', 'group_leader', 'branch_leader', 'exec_committee', 'super_admin'].includes(u.role) && u.can_tick === true;
        if (!isReviewer && String(req.ymis) !== String(tokenYmis)) return { success: false, error: '只可取消自己的申報' };
        state.logRequests.splice(idx, 1);
        return { success: true, message: '已取消申報' };
      }
      case 'getAuditLog':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, records: [] };
      case 'getLoginMode':
        return { success: true, login_mode: 'standalone' };
      default:
        return { success: false, error: 'Unknown action' };
    }
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock.local');

    const sendJson = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    // ---- 測試控制通道（不經 proxy，測試腳本直連） ----
    if (u.pathname === '/__control' && req.method === 'POST') {
      let b = ''; req.on('data', c => b += c);
      req.on('end', () => {
        const c = JSON.parse(b);
        if (c.mode) state.mode = c.mode;
        if (c.slowMs !== undefined) state.slowMs = c.slowMs;
        sendJson({ ok: true, mode: state.mode });
      });
      return;
    }
    if (u.pathname === '/__state') {
      return sendJson({
        name: state.name,
        progress: state.progress,
        requests: state.requests,
        otherBadges: state.otherBadges,
        logs: state.logs,
        tokenCount: Object.keys(state.tokens).length,
        lastExecPath: state.lastExecPath,
        execCount: state.execCount
      });
    }

    // ---- GAS /exec：收請求 → 302 → /usercontent/<rid> ----
    if (u.pathname === '/exec') {
      state.execCount++;
      state.lastExecPath = u.pathname;
      if (req.method === 'GET') {
        const obj = {};
        for (const [k, v] of u.searchParams.entries()) obj[k] = v;
        pendingRedirects.set('r' + state.execCount, obj);
      }
      if (req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          let obj = {};
          try { obj = JSON.parse(b); } catch (e) { obj = {}; }
          pendingRedirects.set('r' + state.execCount, obj);
          res.writeHead(302, { Location: '/usercontent/r' + state.execCount });
          res.end();
        });
        return;
      }
      res.writeHead(302, { Location: '/usercontent/r' + state.execCount });
      res.end();
      return;
    }

    // ---- GAS redirect 目標：真正回應內容 ----
    if (u.pathname.startsWith('/usercontent/')) {
      const rid = u.pathname.split('/')[2];
      const body = pendingRedirects.get(rid) || {};
      pendingRedirects.delete(rid);
      respondFinal(body);
      return;
    }

    function respondFinal(body) {
      if (state.mode === 'html-error') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Google Apps Script</title></head><body>Script not found or error</body></html>');
        return;
      }
      if (state.mode === 'http500') {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<html><body>Internal error</body></html>');
        return;
      }
      if (state.mode === 'slow') {
        setTimeout(() => sendJson(routeAction(String(body.action || ''), body)), state.slowMs || 10000);
        return;
      }
      sendJson(routeAction(String(body.action || ''), body));
    }

    if (!u.pathname.startsWith('/usercontent/') && u.pathname !== '/exec') {
      res.writeHead(404); res.end('not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${port}/exec` }));
  });
}

// CLI 模式：node tests/mock-gas.mjs <port>
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.argv[2] || '3901', 10);
  startMockGas({ port, name: 'mock', users: [{ ymis: '1234567890', name: '測試', role: 'group_leader', pass: 'Passw0rd!x', can_tick: true }] })
    .then(m => console.log('mock GAS on', m.url));
}
