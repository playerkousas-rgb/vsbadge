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
    config: { allow_member_view_others: 'false' },
    apikey,
    mode: 'normal',               // normal | html-error | http500 | slow
    slowMs: 0,
    lastExecPath: '',             // 观测上游實際被打的 URL（SSRF 测试用）
    execCount: 0
  };
  for (const u of users) state.users[u.ymis] = { status: 'active', email: '', ...u };

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
        state.applications.push({ app_id: 'APP_' + Date.now(), ymis: body.ymis, name: body.name, status: 'pending' });
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
          otherBadges: state.otherBadges
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
      case 'getApplications':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, applications: state.applications.filter(a => a.status === 'pending') };
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
