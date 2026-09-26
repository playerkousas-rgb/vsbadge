// 旅系統（旅 > 團 > 進度）上下游接駁守護測試
// 用 in-memory GAS stub 載入真實 apps-script/Code.gs，起兩個節點（上游／下游）經假網路對打，
// 驗證：sig 簽署與驗證、直接入口掣（ALLOW_LOCAL_LOGIN）、開戶落下游、匯出 JSON（含 hash）→ 匯入 upsertUser、
//       以及 ABCD 四項登記資料只存 Script Properties、絕不寫入任何工作表。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const GAS_SOURCE = fs.readFileSync('apps-script/Code.gs', 'utf8');
const sha256 = value => createHash('sha256').update(String(value), 'utf8').digest('hex');

// ---- in-memory SpreadsheetApp ----
function makeSheet(name) {
  const rows = [];
  const cell = (r, c) => {
    const row = rows[r - 1];
    if (!row) return '';
    const v = row[c - 1];
    return v === undefined ? '' : v;
  };
  const setCell = (r, c, v) => {
    while (rows.length < r) rows.push([]);
    const row = rows[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  };
  function makeRange(r, c, nr, nc) {
    const api = {
      getValue: () => cell(r, c),
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const line = [];
          for (let j = 0; j < nc; j++) line.push(cell(r + i, c + j));
          out.push(line);
        }
        return out;
      },
      setValue(v) { setCell(r, c, v); return api; },
      setValues(vals) {
        for (let i = 0; i < vals.length; i++) {
          for (let j = 0; j < vals[i].length; j++) setCell(r + i, c + j, vals[i][j]);
        }
        return api;
      },
      setFontWeight: () => api, setBackground: () => api, setFontColor: () => api, setNumberFormat: () => api
    };
    return api;
  }
  const sheet = {
    getName: () => name,
    appendRow(values) { rows.push(Array.from(values)); return sheet; },
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => makeRange(1, 1, Math.max(rows.length, 1), Math.max(sheet.getLastColumn(), 1)),
    getRange: (r, c, nr, nc) => makeRange(r, c, nr || 1, nc || 1),
    deleteRow(rowIndex) { rows.splice(rowIndex - 1, 1); },
    setFrozenRows: () => sheet,
    _rows: rows
  };
  return sheet;
}

function makeSpreadsheet(name) {
  const sheets = new Map();
  return {
    getName: () => name,
    getId: () => 'ss-' + name,
    getSheetByName: n => sheets.get(n) || null,
    insertSheet(n) { const s = makeSheet(n); sheets.set(n, s); return s; },
    getSheets: () => Array.from(sheets.values()),
    _sheets: sheets
  };
}

function formatDateStub(d, tz, fmt) {
  const date = d instanceof Date ? d : new Date(d);
  const p = n => String(n).padStart(2, '0');
  const map = {
    yyyy: String(date.getFullYear()), MM: p(date.getMonth() + 1), dd: p(date.getDate()),
    HH: p(date.getHours()), mm: p(date.getMinutes()), ss: p(date.getSeconds())
  };
  return String(fmt).replace(/yyyy|MM|dd|HH|mm|ss/g, token => map[token]);
}

// 假網路：url（不含 query）→ 節點。UrlFetchApp.fetch 會把請求送到對應節點的 doPost。
const net = new Map();
// 假 Drive：同一個操作員的 Drive（搬舊數時，匯出檔要能被新支部讀到）
const driveStore = new Map();

function makeNode({ name, apikey, url }) {
  const ss = makeSpreadsheet(name);
  const props = new Map();
  const cache = new Map();
  const driveFiles = driveStore;
  if (apikey) props.set('API_KEY', apikey);
  const scriptProps = {
    getProperty: k => (props.has(String(k)) ? props.get(String(k)) : null),
    setProperty: (k, v) => { props.set(String(k), String(v)); },
    deleteProperty: k => { props.delete(String(k)); },
    getProperties: () => Object.fromEntries(props)
  };
  function makeFolder(id) {
    return {
      getId: () => id,
      createFile(fileName, content, mime) {
        const fileId = 'file-' + randomUUID();
        const file = {
          getId: () => fileId, getUrl: () => 'https://drive.google.com/file/d/' + fileId + '/view',
          getName: () => fileName, getMimeType: () => mime,
          getBlob: () => ({ getDataAsString: () => content }),
          setSharingAccess: () => file, setSharingPermission: () => file
        };
        driveFiles.set(fileId, { file, content, fileName });
        return file;
      }
    };
  }
  const node = { name, url, ss, props, cache, driveFiles, fetched: [] };
  const context = vm.createContext({
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => scriptProps },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache.has(String(k)) ? cache.get(String(k)) : null),
        put: (k, v) => { cache.set(String(k), String(v)); },
        remove: k => { cache.delete(String(k)); }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getService: () => ({ getUrl: () => url }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => null },
    Utilities: {
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algo, value) => Array.from(createHash('sha256').update(String(value), 'utf8').digest()),
      computeHmacSha256Signature: (value, key) => Array.from(createHmac('sha256', String(key)).update(String(value), 'utf8').digest()),
      formatDate: formatDateStub
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' },
      getRootFolder: () => makeFolder('root'),
      getFileById(id) {
        if (driveFiles.has(String(id))) return driveFiles.get(String(id)).file;
        if (String(id) === ss.getId()) return { getParents: () => ({ hasNext: () => false, next: () => makeFolder('root') }) };
        throw new Error('Drive 檔案不存在：' + id);
      }
    },
    UrlFetchApp: {
      fetch(target, opts) {
        node.fetched.push({ url: String(target), opts: opts || {} });
        const [base, qs] = String(target).split('?');
        const peer = net.get(base.replace(/\/$/, ''));
        if (!peer) return { getResponseCode: () => 404, getContentText: () => '<HTML>not found</HTML>' };
        const params = Object.fromEntries(new URLSearchParams(qs || ''));
        const result = peer.context.doPost({ parameter: params, postData: { contents: String((opts && opts.payload) || '') } });
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(result) };
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ setMimeType: () => ({ getContent: () => text }) })
    }
  });
  vm.runInContext(GAS_SOURCE, context);
  context.jsonResponse = obj => obj; // 測試直接取回應物件
  node.context = context;
  net.set(url.replace(/\/$/, ''), node);
  return node;
}

// 測試用的獨立 sig 實作（照規格寫，不是抄 Code.gs 的程式路徑）
//   sigKey = HMAC-SHA256(message='vsbadge-troop-sig-v1', key=該節點 SHEET KEY) 的 hex
//   sig    = HMAC-SHA256(message=action\n ts\n nonce\n SHA256(rawBody), key=sigKey) 的 hex
const SIG_PURPOSE = 'vsbadge-troop-sig-v1';
function signRequest(node, action, rawBody, keyOverride, tsOverride, nonceOverride) {
  const key = keyOverride === undefined ? node.props.get('API_KEY') : keyOverride;
  const sigKey = createHmac('sha256', String(key)).update(SIG_PURPOSE, 'utf8').digest('hex');
  const ts = tsOverride === undefined ? String(Date.now()) : String(tsOverride);
  const nonce = nonceOverride === undefined ? randomUUID().replace(/-/g, '') : nonceOverride;
  const canonical = [action, ts, nonce, sha256(rawBody || '')].join('\n');
  return { sig: createHmac('sha256', sigKey).update(canonical, 'utf8').digest('hex'), ts, nonce };
}

function postTo(node, body, sig, useQuery) {
  const raw = JSON.stringify(body);
  const params = sig && useQuery !== false
    ? { sig: sig.sig, sts: sig.ts, snonce: sig.nonce }
    : {};
  return node.context.doPost({ parameter: params, postData: { contents: raw } });
}

function sheetRows(node, sheetName) {
  const sheet = node.ss.getSheetByName(sheetName);
  return sheet ? sheet._rows : [];
}

function allSheetText(node) {
  let text = '';
  for (const sheet of node.ss.getSheets()) text += JSON.stringify(sheet._rows) + '\n';
  return text;
}

const UPSTREAM_URL = 'https://script.google.com/macros/s/UPSTREAM_BRANCH_NODE/exec';
const DOWNSTREAM_URL = 'https://script.google.com/macros/s/DOWNSTREAM_PROGRESS_NODE/exec';
const UPSTREAM_KEY = 'vs_upstream_branch_key_0001';
const DOWNSTREAM_KEY = 'vs_downstream_progress_key_0002';

function buildPair() {
  const up = makeNode({ name: '第 82 旅 深資（團）', apikey: UPSTREAM_KEY, url: UPSTREAM_URL });
  const down = makeNode({ name: '第 82 旅 深資（進度）', apikey: DOWNSTREAM_KEY, url: DOWNSTREAM_URL });
  up.context.initializeSheets();
  down.context.initializeSheets();
  return { up, down };
}

test('直接入口掣：未設定時現有旅團行為完全不變', () => {
  const node = makeNode({ name: '獨立旅團', apikey: 'vs_standalone_key_0003', url: 'https://script.google.com/macros/s/STANDALONE_NODE/exec' });
  const g = node.context;
  g.initializeSheets();
  assert.equal(g.localLoginAllowed(), true, '未設定 ALLOW_LOCAL_LOGIN 應視為開啟');
  assert.equal(String(node.props.get('ALLOW_LOCAL_LOGIN') || ''), '', '掣不應該被自動寫入');
  const login = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'login', login_id: '1111111111', password: 'changeme' }) } });
  assert.equal(login.success, true, '直接入口開放時登入照舊');
  assert.ok(String(login.token).length > 10);
  const load = g.doGet({ parameter: { action: 'load' } });
  assert.equal(load.success, true);
  const mode = g.doGet({ parameter: { action: 'getLoginMode' } });
  assert.equal(mode.local_login, undefined, '公開登入模式不暴露入口閘門狀態');
  assert.equal(g.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'getAllUsers', token: login.token }) } }).success, true);
});

test('閂口後：直接登入／申請／load 全部拒絕，只收 sig', () => {
  const { down } = buildPair();
  const g = down.context;
  const existingUser = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'login', login_id: '1111111111', password: 'changeme' }) } });
  assert.equal(existingUser.success, true, '關門前一般用戶可正常登入');
  g.setLocalLoginAllowed(false, 'test');
  assert.equal(g.localLoginAllowed(), false);
  assert.equal(String(down.props.get('ALLOW_LOCAL_LOGIN')), 'false', '掣寫在下游 Script Properties');
  const login = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'login', login_id: '1111111111', password: 'changeme' }) } });
  assert.equal(login.success, false);
  assert.equal(login.local_login, undefined);
  assert.equal(login.upstream_only, undefined);
  assert.match(login.error, /登入服務暫時無法使用/);
  assert.doesNotMatch(login.error, /ALLOW_LOCAL_LOGIN|sig|閂口/);
  const existingSession = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'getAllUsers', token: existingUser.token }) } });
  assert.equal(existingSession.success, false, '關門後一般既有 session 亦被鎖住');
  assert.doesNotMatch(existingSession.error, /ALLOW_LOCAL_LOGIN|sig|閂口/);
  const apply = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'apply', ymis: '1234567890', name: '測試', requested_role: 'member' }) } });
  assert.equal(apply.success, false);
  assert.equal(g.doGet({ parameter: { action: 'load' } }).success, false, '閂口後 GET load 亦拒絕');
  // 舊 API key 路徑（save）喺閂口後唔再生效
  const save = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'save', apikey: DOWNSTREAM_KEY, changes: [{ ymis: '1234567890', itemId: 'L1', date: '2026-01-01' }] }) } });
  assert.equal(save.success, false, '閂口後只收 sig，apikey 直接寫入要被拒');
});

test('關門後超管仍可救援登入；無狀態超管與任何 Sheet 紀錄隔離', () => {
  const { down } = buildPair();
  const g = down.context;
  g.setLocalLoginAllowed(false, 'test');
  const superUser = g.getSuperAdminUser();
  // 舊版可能曾留下超管資料；只在明確執行初始化升級清理，不在超管登入時讀寫 Sheet。
  const usersSheet=down.ss.getSheetByName('Users');
  usersSheet.appendRow([superUser.ymis,superUser.name,'', 'super_admin','','',true,'','','','', 'active','*',false]);
  usersSheet.appendRow(['1234567891','舊版帳戶','','member','hash','',false,superUser.ymis,'','','','active','',false]);
  down.ss.getSheetByName('Tokens').appendRow(['vs-super-v1-legacy',superUser.ymis,'','2099-01-01']);
  down.ss.getSheetByName('操作紀錄').appendRow([new Date(),superUser.ymis,'legacy_login',superUser.ymis,'legacy']);
  down.ss.getSheetByName('進度追蹤').appendRow([superUser.ymis,'legacy-item','2024-01-01',new Date(),superUser.ymis,'']);
  down.ss.getSheetByName('成員名單').appendRow([superUser.ymis,superUser.name,'','','']);
  down.ss.getSheetByName('活動履歷').appendRow(['legacy-log','activity','1234567890','Member','2024-01-01','Legacy','','','','',superUser.ymis,new Date(),'']);
  g.initializeSheets();
  assert.equal(sheetRows(down, 'Users').some(row => String(row[0]) === superUser.ymis || String(row[3]) === 'super_admin'), false, '升級清理會移除舊 Users 超管列');
  assert.equal(sheetRows(down, 'Users').find(row => String(row[0])==='1234567891')[7], 'system', '升級清理匿名化普通帳戶中留下的超管操作者欄');
  assert.equal(sheetRows(down, 'Tokens').some(row => String(row[0]).startsWith('vs-super-v1-') || String(row[1]) === superUser.ymis), false, '升級清理會移除舊 Tokens 超管列');
  assert.equal(sheetRows(down, '操作紀錄').some(row => String(row[1]) === superUser.ymis || String(row[3]) === superUser.ymis), false, '升級清理會移除舊超管審計痕跡');
  assert.equal(sheetRows(down, '進度追蹤').some(row => String(row[0]) === superUser.ymis), false, '升級清理會移除超管成員進度列');
  assert.equal(sheetRows(down, '成員名單').some(row => String(row[0]) === superUser.ymis), false, '升級清理會移除超管名單列');
  assert.equal(sheetRows(down, '活動履歷').some(row => String(row[2]) === superUser.ymis || String(row[10]) === superUser.ymis), false, '升級清理移除或匿名化超管活動履歷痕跡');

  g.verifySuperTicket = ticket => ticket === 'verified-ticket';
  const beforeLogin = allSheetText(down);
  const result = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({
    action: 'login', login_id: superUser.ymis, super_ticket: 'verified-ticket'
  }) } });
  assert.equal(result.success, true, '有效中央票據在閘門關閉後仍可登入');
  assert.equal(g.validateToken(result.token), superUser.ymis);
  assert.equal(result.token, g.superAdminSessionToken(), '登入 token 為無狀態 HMAC，不依賴 Cache TTL');
  assert.equal(allSheetText(down), beforeLogin, '超管登入本身完全不讀寫 Sheet');
  assert.equal(Object.keys(Object.fromEntries(down.props)).some(key => /SUPER_ADMIN_LAST_LOGIN/.test(key)), false, '不記錄超管登入時間');
  assert.equal(g.doGet({ parameter: { action: 'load', token: result.token } }).success, true, '關門後有效超管可用 GET 載入資料');
  const superList = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'getAllUsers', token: result.token }) } });
  assert.equal(superList.success, true, '關門後有效超管仍可在 APP 內操作：'+JSON.stringify(superList));
  const reset = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'resetPassword', token: result.token, target_ymis: '1111111111', new_password: 'rescue-temp' }) } });
  assert.equal(reset.success, true, '超管可在閉閘後救援成員帳戶');
  assert.equal(sheetRows(down, 'Users').find(row => String(row[0])==='1111111111')[7], 'system', '救援操作不把超管身份寫入 Users.auth_by');
  assert.equal(allSheetText(down).includes(superUser.ymis), false, '超管救援後沒有任何 Sheet 身份痕跡');

  // 後端與前端皆無論登入者角色，都不列出超管殘留帳戶。
  usersSheet.appendRow(['legacy-super-row','舊版保留帳號','','super_admin','','',true,'','','','', 'active','*',false]);
  down.ss.getSheetByName('成員名單').appendRow([superUser.ymis,superUser.name,'','','']);
  assert.equal(g.getAllUsers().some(user => user.role==='super_admin' || String(user.ymis)===superUser.ymis), false, '後端用戶清單不回傳超管');
  assert.equal(g.getMembers().some(member => String(member.ymis)===superUser.ymis), false, '合併成員名單不回傳超管');
  assert.equal(g.buildUsersExport().users.some(user => user.role==='super_admin' || String(user.ymis)===superUser.ymis), false, '帳戶匯出不帶超管殘留列');
  const indexHtml=fs.readFileSync('index.html','utf8');
  assert.match(indexHtml,/adminUsersCache=\(d\.users\|\|\[\]\)\.filter\(u=>u\.role!=='super_admin'/, '前端一律隱藏 super_admin 列');
  assert.doesNotMatch(indexHtml,/setAllowLocalLogin|ALLOW_LOCAL_LOGIN/, '下游 APP 不提供直接入口開關或狀態');

  const audit = sheetRows(down, '操作紀錄');
  const count = audit.length;
  g.writeAudit(superUser.ymis, 'rescue_action', 'target', 'details');
  assert.equal(audit.length, count, '超管操作不寫入操作紀錄');
  const normal = g.doPost({ parameter: {}, postData: { contents: JSON.stringify({
    action: 'login', login_id: '1111111111', password: 'changeme', super_ticket: 'verified-ticket'
  }) } });
  assert.equal(normal.success, false, '一般帳號不能借用救援票據繞過閘門');
  assert.doesNotMatch(normal.error, /ALLOW_LOCAL_LOGIN|sig|閂口/);
});

test('上游登記下游 SHEET KEY 後，sig 請求可讀可寫下游', () => {
  const { up, down } = buildPair();
  const bad = up.context.registerDownstream('progress', 'https://evil.example.com/exec', DOWNSTREAM_KEY, '假下游');
  assert.equal(bad.success, false, '非 GAS /exec URL 必須被拒');
  assert.equal(up.context.registerDownstream('progress', DOWNSTREAM_URL, 'short', '進度').success, false, 'SHEET KEY 太短要被拒');
  const reg = up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
  assert.equal(reg.success, true);
  assert.equal(String(up.props.get('DOWNSTREAM_progress_KEY')), DOWNSTREAM_KEY, 'SHEET KEY 只存 Script Properties');

  const ping = up.context.pingDownstream('progress');
  assert.equal(ping.success, true, 'sig 連線測試要通過');
  assert.equal(ping.allow_local_login, true);
  assert.match(String(ping.node), /進度/);

  // 寫：經 sig 落下游寫進度
  const saved = up.context.callDownstream('progress', 'save', { changes: [{ ymis: '1234567890', itemId: 'L1', date: '2026-02-02' }], confirmer: '上游團長', on_behalf: '1111111111' });
  assert.equal(saved.success, true);
  assert.equal(saved.processed, 1);
  const rows = sheetRows(down, '進度追蹤');
  assert.equal(rows.some(r => String(r[0]) === '1234567890' && String(r[1]) === 'L1'), true, '進度應已寫入下游工作表');

  // 讀：上游可讀下游全量
  const load = up.context.callDownstream('progress', 'load', {});
  assert.equal(load.success, true);
  assert.equal(load.flatProgress['1234567890'].L1, '2026-02-02');

  // 掣在上游：由上游閂下游直接入口
  const closed = up.context.setDownstreamLocalLogin('progress', false);
  assert.equal(closed.success, true);
  assert.equal(down.context.localLoginAllowed(), false, '下游掣應被上游閂上');
  const stillWorks = up.context.callDownstream('progress', 'getLinkState', {});
  assert.equal(stillWorks.success, true, '閂口後上游 sig 仍然可讀可寫');
  assert.equal(stillWorks.allow_local_login, false);
});

test('sig 防護：錯誤 key、竄改 body、過期時間戳、重放 nonce、白名單外 action 全部被拒', () => {
  const { up, down } = buildPair();
  up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
  const body = { action: 'save', changes: [{ ymis: '1234567890', itemId: 'L1', date: '2026-03-03' }], on_behalf: '1111111111' };
  const raw = JSON.stringify(body);

  const wrongKey = signRequest(down, 'save', raw, 'vs_not_the_registered_key');
  assert.equal(postTo(down, body, wrongKey).success, false, '用錯 key 簽署必須被拒');

  const good = signRequest(down, 'save', raw);
  const tampered = { ...body, changes: [{ ymis: '9999999999', itemId: 'L1', date: '2026-03-03' }] };
  assert.equal(postTo(down, tampered, good).success, false, '竄改 body 必須被拒');

  const expired = signRequest(down, 'save', raw, undefined, Date.now() - 10 * 60 * 1000);
  assert.equal(postTo(down, body, expired).success, false, '超出時間窗口必須被拒');

  const future = signRequest(down, 'save', raw, undefined, Date.now() + 10 * 60 * 1000);
  assert.equal(postTo(down, body, future).success, false, '未來時間戳必須被拒');

  const once = signRequest(down, 'save', raw);
  assert.equal(postTo(down, body, once).success, true, '有效 sig 應通過');
  assert.equal(postTo(down, body, once).success, false, '同一 nonce 重放必須被拒');

  // body 內送 sig（GAS 302 丟失 query 時的後備）亦要通過，並同樣防重放
  const inner = signRequest(down, 'save', raw);
  const bodySig = { ...body, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
  assert.equal(postTo(down, bodySig, null, false).success, true, 'body 傳送的 sig 應通過');
  assert.equal(postTo(down, bodySig, null, false).success, false, 'body sig 都要防重放');

  // 混合傳送重放：上游一次送齊 query + body 兩組 sig；
  // 即使第一次只驗到 body（模擬 GAS 302 丟失 query），重放時帶回 query 都要被拒
  const mixedRaw = JSON.stringify(body);
  const mixedInner = signRequest(down, 'save', mixedRaw);
  const mixedBody = { ...body, sig: mixedInner.sig, sig_ts: mixedInner.ts, sig_nonce: mixedInner.nonce };
  const mixedRawOutgoing = JSON.stringify(mixedBody);
  const mixedOuter = signRequest(down, 'save', mixedRawOutgoing);
  const mixedParams = { sig: mixedOuter.sig, sts: mixedOuter.ts, snonce: mixedOuter.nonce };
  const firstTry = down.context.doPost({ parameter: {}, postData: { contents: mixedRawOutgoing } }); // query 丢失
  assert.equal(firstTry.success, true);
  const replay = down.context.doPost({ parameter: mixedParams, postData: { contents: mixedRawOutgoing } });
  assert.equal(replay.success, false, '用另一組 nonce 重放必須被拒');

  const forbidden = signRequest(down, 'login', JSON.stringify({ action: 'login', login_id: '1111111111', password: 'changeme' }));
  const refused = postTo(down, { action: 'login', login_id: '1111111111', password: 'changeme' }, forbidden);
  assert.equal(refused.success, false, 'login 不可經 sig 執行');
  assert.match(refused.error, /不接受此操作/);
});

test('ABCD 四項登記資料只存 Script Properties，絕不寫入任何工作表', () => {
  const { up, down } = buildPair();
  up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
  up.context.createAccountForDownstream('progress', { ymis: '1234567890', name: '陳大文', role: 'member', password: '1234' }, { ymis: '1111111111', name: '管理員', role: 'admin' });
  up.context.setDownstreamLocalLogin('progress', false);
  up.context.exportUsersJson();
  for (const node of [up, down]) {
    const text = allSheetText(node);
    assert.equal(text.includes(DOWNSTREAM_KEY), false, node.name + '：工作表不可出現下游 SHEET KEY');
    assert.equal(text.includes(UPSTREAM_KEY), false, node.name + '：工作表不可出現本機 API KEY');
    assert.equal(text.includes('script.google.com/macros'), false, node.name + '：工作表不可出現後端 URL');
    assert.equal(text.includes('ALLOW_LOCAL_LOGIN'), false, node.name + '：工作表不可出現掣名稱');
  }
  assert.equal(String(up.props.get('DOWNSTREAM_progress_URL')), DOWNSTREAM_URL);
  assert.equal(String(down.props.get('ALLOW_LOCAL_LOGIN')), 'false');
});

test('開戶：上游揀團開戶，經 sig 落下游寫（兩邊同一 password_hash）', () => {
  const { up, down } = buildPair();
  up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
  up.context.setDownstreamLocalLogin('progress', false); // 閂口後先開戶
  const result = up.context.createAccountForDownstream('progress', {
    ymis: '2345678901', name: '李四', email: 'li4@example.com', role: 'exec_committee', password: '4321'
  }, { ymis: '1111111111', name: '管理員', role: 'admin' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.ymis, '2345678901');
  const upstreamHash = up.context.findUserRecord('2345678901');
  const downstreamHash = down.context.findUserRecord('2345678901');
  assert.ok(upstreamHash && downstreamHash, '上下游都應有帳戶');
  assert.equal(
    String(upstreamHash.data[upstreamHash.map.password_hash]),
    String(downstreamHash.data[downstreamHash.map.password_hash]),
    '下游必須直插同一 hash'
  );
  assert.equal(String(downstreamHash.data[downstreamHash.map.password_hash]), sha256('4321'));
  assert.equal(downstreamHash.user.role, 'exec_committee');
  // 下游已閂口，但上游仍可直接寫下游進度
  assert.equal(up.context.callDownstream('progress', 'save', { changes: [{ ymis: '2345678901', itemId: 'L1', date: '2026-04-04' }] }).success, true);
  // 重複推送同一帳戶 → upsert 更新而非重複開戶
  const again = up.context.createAccountForDownstream('progress', { ymis: '2345678901', name: '李四', role: 'exec_committee', password: '4321' }, { ymis: '1111111111', name: '管理員', role: 'admin' });
  assert.equal(again.success, false, '上游不可重複開同一帳戶');
  // 冇帶 branch 的同步不可洗走下游既有支部
  assert.equal(up.context.callDownstream('progress', 'upsertUser', { user: { ymis: '2345678901', name: '李四', role: 'exec_committee', branch: '第 82 旅深資' }, on_behalf: '1111111111' }).success, true);
  assert.equal(down.context.findUserRecord('2345678901').user.branch, '第 82 旅深資');
  const mirrored = up.context.callDownstream('progress', 'upsertUser', { user: { ymis: '2345678901', name: '李四（改名）', role: 'exec_committee' }, on_behalf: '1111111111' });
  assert.equal(mirrored.success, true);
  assert.equal(mirrored.action, 'updated');
  assert.equal(mirrored.password_kept, true, '冇帶 hash 時必須保留原密碼');
  assert.equal(down.context.findUserRecord('2345678901').user.name, '李四（改名）');
  assert.equal(down.context.findUserRecord('2345678901').user.branch, '第 82 旅深資', '冇帶 branch 不可洗走既有支部');
  assert.equal(String(down.context.findUserRecord('2345678901').data[down.context.findUserRecord('2345678901').map.password_hash]), sha256('4321'));
  assert.equal(sheetRows(down, 'Users').filter(r => String(r[0]) === '2345678901').length, 1, '不可出現重複列');
});

test('吐 JSON：匯出含 hash，匯入逐個 upsertUser 直插 hash（保留舊密碼）', () => {
  const oldNode = makeNode({ name: '舊進度', apikey: 'vs_old_progress_key_0004', url: 'https://script.google.com/macros/s/OLD_PROGRESS_NODE/exec' });
  const newNode = makeNode({ name: '新支部', apikey: 'vs_new_branch_key_0005', url: 'https://script.google.com/macros/s/NEW_BRANCH_NODE/exec' });
  oldNode.context.initializeSheets();
  newNode.context.initializeSheets();
  const manager = { ymis: '1111111111', name: '管理員', role: 'admin' };
  assert.equal(oldNode.context.createUsersBatch([
    { ymis: '1234567890', name: '陳大文', email: 'chan@example.com', role: 'member', password: 'abcd' },
    { ymis: '2345678901', name: '李四', email: 'li@example.com', role: 'exec_committee', password: 'wxyz' }
  ], manager).created, 2);
  // 舊密碼被用戶自行改過，hash 必須原樣搬走
  oldNode.context.handleChangePassword('1234567890', 'abcd', 'newpass1');

  const exported = oldNode.context.exportUsersJson();
  assert.equal(exported.success, true);
  assert.equal(exported.count, 3, '含內置管理員共 3 個帳戶');
  assert.ok(exported.file_id && exported.drive_error === '', '應寫成 Drive 檔：' + exported.drive_error);
  const stored = oldNode.driveFiles.get(exported.file_id);
  assert.ok(stored, 'Drive 檔應存在');
  const payload = JSON.parse(stored.content);
  assert.equal(payload.format, 'vsbadge-users-export');
  const chen = payload.users.find(u => u.ymis === '1234567890');
  assert.equal(chen.password_hash, sha256('newpass1'), '匯出必須含 hash');
  assert.equal(chen.email, 'chan@example.com');
  assert.equal(JSON.stringify(sheetRows(oldNode, '操作紀錄')).includes(chen.password_hash), false, 'hash 不可寫入操作紀錄');
  assert.equal(oldNode.ss.getSheets().some(sh => sh.getName().includes('匯出')), false, '匯出不可另開工作表');

  // 新支部匯入
  const imported = newNode.context.importUsersFromDrive(exported.file_url, 'menu-import');
  assert.equal(imported.success, true, JSON.stringify(imported));
  // 新支部 initializeSheets() 已有內置管理員 → 同 YMIS 會被 upsert 更新而不是重複開戶
  assert.equal(imported.created, 2);
  assert.equal(imported.updated, 1);
  assert.equal(imported.failed, 0);
  const rec = newNode.context.findUserRecord('1234567890');
  assert.equal(String(rec.data[rec.map.password_hash]), sha256('newpass1'), '舊密碼必須保留');
  assert.equal(rec.user.force_change_password, false, '搬舊數唔應該強制改密碼');
  // 舊密碼喺新支部直接可用
  const login = newNode.context.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'login', login_id: '1234567890', password: 'newpass1' }) } });
  assert.equal(login.success, true, '匯入後應可用舊密碼登入');
  assert.equal(newNode.context.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'login', login_id: '1234567890', password: 'abcd' }) } }).success, false);

  // 重複匯入 = 冪等更新，唔會開重複帳戶
  const again = newNode.context.importUsersFromText(stored.content, 'menu-import');
  assert.equal(again.success, true);
  assert.equal(again.created, 0);
  assert.equal(again.updated, 3);
  assert.equal(sheetRows(newNode, 'Users').filter(r => String(r[0]) === '1234567890').length, 1);

  // 匯入守衛：明文密碼、假 hash、壞 JSON、缺 YMIS
  assert.equal(newNode.context.importUsersFromText(JSON.stringify({ users: [{ ymis: '3456789012', name: '王五', password: 'plain1' }] }), 'x').success, false);
  assert.match(newNode.context.upsertUser({ ymis: '3456789012', name: '王五', password: 'plain1' }, 'x').error, /明文/);
  assert.match(newNode.context.upsertUser({ ymis: '3456789012', name: '王五', password_hash: 'not-a-hash' }, 'x').error, /64 位/);
  assert.equal(newNode.context.upsertUser({ ymis: '3456789012', name: '王五' }, 'x').success, false, '新帳戶冇 hash 要被拒');
  assert.equal(newNode.context.upsertUser({ name: '無 YMIS', password_hash: sha256('x') }, 'x').success, false);
  assert.equal(newNode.context.importUsersFromText('{ 壞 JSON', 'x').success, false);
  assert.equal(sheetRows(newNode, 'Users').some(r => String(r[0]) === '3456789012'), false, '被拒的匯入不可留下帳戶');

  // 搬完舊數 → 閂下游直接入口
  newNode.context.setLocalLoginAllowed(false, 'menu');
  assert.equal(newNode.context.localLoginAllowed(), false);
  assert.equal(newNode.context.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'login', login_id: '1234567890', password: 'newpass1' }) } }).success, false);
});

test('上游以 sig 批量匯入下游（importUsers）與讀取用戶清單', () => {
  const { up, down } = buildPair();
  up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
  const users = [
    { ymis: '1234567890', name: '陳大文', role: 'member', password_hash: sha256('abcd') },
    { ymis: '2345678901', name: '李四', role: 'exec_committee', password_hash: sha256('wxyz'), email: 'li@example.com' }
  ];
  const pushed = up.context.callDownstream('progress', 'importUsers', { users, on_behalf: '1111111111' });
  assert.equal(pushed.success, true, JSON.stringify(pushed));
  assert.equal(pushed.created, 2);
  const list = up.context.callDownstream('progress', 'getAllUsers', { on_behalf: '1111111111' });
  assert.equal(list.success, true);
  assert.equal(list.users.some(u => u.ymis === '2345678901'), true);
  // 簽名請求唔會洩漏 password_hash
  assert.equal(JSON.stringify(list).includes(sha256('wxyz')), false, 'getAllUsers 不可回傳 hash');
});

test('上游傳來的標籤不可變成工作表算式（auth_by／操作紀錄）', () => {
  const { up, down } = buildPair();
  up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
  const evil = '=CMD("calc")';
  const pushed = up.context.callDownstream('progress', 'upsertUser', {
    user: { ymis: '1234567890', name: '陳大文', password_hash: sha256('abcd') },
    on_behalf: evil, on_behalf_name: evil
  });
  assert.equal(pushed.success, true, JSON.stringify(pushed));
  for (const sheetName of ['Users', '成員名單', '操作紀錄']) {
    for (const row of sheetRows(down, sheetName)) {
      for (const cell of row) {
        assert.equal(String(cell).startsWith('='), false, sheetName + ' 不可有以 = 開頭的儲存格：' + String(cell).slice(0, 40));
      }
    }
  }
  const rec = down.context.findUserRecord('1234567890');
  assert.match(String(rec.data[rec.map.auth_by]), /^[0-9A-Za-z_.@-]+$/, 'auth_by 只留安全字元');
});

test('GS 程式內不留版號註解（版號只留 MD）', () => {
  for (const file of ['apps-script/Code.gs', 'assets/batch-onboard/Code.gs']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/\/\/\s*v\d+\.\d+/.test(text), false, file + ' 仍有 // vX.X 註解');
    assert.equal(/\bv\d+\.\d+(\.\d+)?\b/.test(text), false, file + ' 仍有版號字樣');
  }
});
