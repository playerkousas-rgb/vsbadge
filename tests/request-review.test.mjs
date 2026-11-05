// ============================================================
// 待批完成／審批寫入回歸測試 — 對應 VSBOOK 跨系統對接需求
//
//   1) handleRequestComplete 冪等去重：同一 (requesterYmis, itemId) 已有 pending 列
//      → 更新申請日期（第 6 欄）／證明（第 7 欄）、回傳既有 request_id，唔新增列；
//      支援批次 body.items[]（向下相容單筆 body.itemId），全部寫入 pending
//   2) handleReviewRequest 批准：OT-* 寫「其他獎章」（handleLoad.otherBadges 可見）、
//      其餘項目經 handleSave 做 (ymis,itemId) Upsert，唔再重覆 appendRow
//   3) 工作表欄名／結構完全不變（禁區守護）
//   4) Proxy 相容：冇 Origin／Sec-Fetch-Site 嘅伺服器對伺服器請求（VSBOOK 後端轉發
//      login／logout／load／requestComplete）照常受理；GET /api/troops 維持
//      { troops: { [id]: { name, en } } }
//   5) slow_password_kdf 日誌：密碼操作慢過門檻／逾時都有 metadata 紀錄（唔含密碼／token）
//
// 執行：node --test tests/request-review.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, createHmac, randomUUID } from 'node:crypto';

// ---- Proxy env 必須喺 import 前設定（模組載入時讀取）----
process.env.TROOP_9001_NAME = '測試旅';
process.env.TROOP_9001_EN = 'Test Group';
process.env.TROOP_9001_BACKEND = 'https://script.google.com/macros/s/TEST_DEPLOYMENT_9001/exec';
process.env.TROOP_9001_APIKEY = 'secret-key-9001';
process.env.VSBADGE_SLOW_KDF_MS = '0'; // 記錄每一次密碼操作，方便斷言日誌
const { default: proxy } = await import('../api/proxy.js');
const { default: troops } = await import('../api/troops.js');

const GAS_SOURCE = fs.readFileSync('apps-script/Code.gs', 'utf8');
const sha256 = value => createHash('sha256').update(String(value), 'utf8').digest('hex');

// ---- in-memory SpreadsheetApp（與其他後端守護測試同款做法）----
function makeSheet(name) {
  const rows = [];
  const cell = (r, c) => { const row = rows[r - 1]; if (!row) return ''; const v = row[c - 1]; return v === undefined ? '' : v; };
  const setCell = (r, c, v) => {
    while (rows.length < r) rows.push([]);
    const row = rows[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  };
  function makeRange(r, c, nr, nc) {
    const api = {
      getValue: () => cell(r, c),
      getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const line = []; for (let j = 0; j < nc; j++) line.push(cell(r + i, c + j)); out.push(line); } return out; },
      setValue(v) { setCell(r, c, v); return api; },
      setValues(vals) { for (let i = 0; i < vals.length; i++) for (let j = 0; j < vals[i].length; j++) setCell(r + i, c + j, vals[i][j]); return api; },
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
  const map = { yyyy: String(date.getFullYear()), MM: p(date.getMonth() + 1), dd: p(date.getDate()), HH: p(date.getHours()), mm: p(date.getMinutes()), ss: p(date.getSeconds()) };
  return String(fmt).replace(/yyyy|MM|dd|HH|mm|ss/g, token => map[token]);
}
function buildNode() {
  const ss = makeSpreadsheet('request-review-test');
  const props = new Map();
  props.set('API_KEY', 'test-api-key');
  const scriptProps = {
    getProperty: k => (props.has(String(k)) ? props.get(String(k)) : null),
    setProperty: (k, v) => { props.set(String(k), String(v)); },
    deleteProperty: k => { props.delete(String(k)); },
    getProperties: () => Object.fromEntries(props)
  };
  const cache = new Map();
  const context = vm.createContext({
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => scriptProps },
    CacheService: { getScriptCache: () => ({ get: k => (cache.has(String(k)) ? cache.get(String(k)) : null), put: (k, v) => { cache.set(String(k), String(v)); }, remove: k => { cache.delete(String(k)); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/REQ_TEST/exec' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => null },
    MailApp: { sendEmail: () => {} },
    Utilities: {
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algo, value) => Array.from(createHash('sha256').update(String(value), 'utf8').digest()),
      computeHmacSha256Signature: (value, key) => Array.from(createHmac('sha256', String(key)).update(Array.isArray(value) ? Buffer.from(value.map(b => b & 0xFF)) : Buffer.from(String(value), 'utf8')).digest()),
      formatDate: formatDateStub
    },
    DriveApp: { getRootFolder: () => ({ createFile: () => { throw new Error('test should not export'); } }) },
    UrlFetchApp: { fetch: () => { throw new Error('test should not call network'); } },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ setMimeType: () => ({ getContent: () => text }) }) }
  });
  vm.runInContext(GAS_SOURCE, context);
  context.jsonResponse = obj => obj;
  return { ss, props, context };
}
const USER_HEADERS = ['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'auth_by', 'auth_date', 'created_at', 'last_login', 'status', 'allowed_badges', 'force_change_password'];
function seedUser(node, { ymis, name, role, pass, canTick = false, email = '' }) {
  const sheet = node.ss.getSheetByName('Users');
  const row = new Array(USER_HEADERS.length).fill('');
  row[0] = ymis; row[1] = name; row[2] = email; row[3] = role; row[4] = sha256(pass);
  row[5] = 'b4'; row[6] = canTick; row[7] = 'system'; row[8] = '2026-01-01';
  row[9] = '2026-01-01'; row[10] = ''; row[11] = 'active'; row[12] = '*'; row[13] = false;
  sheet.appendRow(row);
}
const post = (node, body) => node.context.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } });
const rowsOf = (node, name) => node.ss.getSheetByName(name).getDataRange().getValues();
function setup() {
  const node = buildNode();
  node.context.initializeSheets();
  seedUser(node, { ymis: '1234560010', name: '領袖甲', role: 'group_leader', pass: 'Leader!1', canTick: true, email: 'leader@example.org' });
  seedUser(node, { ymis: '1234560011', name: '團員乙', role: 'member', pass: 'Member!1' });
  const leader = post(node, { action: 'login', login_id: '1234560010', password: 'Leader!1' });
  const member = post(node, { action: 'login', login_id: '1234560011', password: 'Member!1' });
  assert.equal(leader.success, true); assert.equal(member.success, true);
  return { node, leaderToken: leader.token, memberToken: member.token };
}

test('requestComplete 冪等去重：重按送出同一項目只更新既有 pending 列，回傳原有 request_id', () => {
  const { node, memberToken } = setup();
  const r1 = post(node, { action: 'requestComplete', token: memberToken, itemId: 'L2', itemName: '領袖訓練', requested_date: '2026-11-01', evidence: '相1' });
  assert.equal(r1.success, true, JSON.stringify(r1));
  assert.equal(rowsOf(node, '待批完成').length, 2, 'header＋1 列');
  const r2 = post(node, { action: 'requestComplete', token: memberToken, itemId: 'L2', itemName: '領袖訓練', requested_date: '2026-11-03', evidence: '相2（更新）' });
  assert.equal(r2.success, true);
  assert.equal(r2.request_id, r1.request_id, '回傳既有 request_id');
  assert.equal(r2.deduplicated, true);
  const rows = rowsOf(node, '待批完成');
  assert.equal(rows.length, 2, '唔會新增重覆列');
  assert.equal(String(rows[1][5]), '2026-11-03', '第 6 欄申請日期已更新');
  assert.equal(String(rows[1][6]), '相2（更新）', '第 7 欄證明已更新');
  assert.equal(String(rows[1][7]), 'pending');
  // 唔同項目照常新增
  const r3 = post(node, { action: 'requestComplete', token: memberToken, itemId: 'L3', itemName: '進階訓練' });
  assert.equal(r3.success, true);
  assert.notEqual(r3.request_id, r1.request_id);
  assert.equal(rowsOf(node, '待批完成').length, 3);
});

test('requestComplete 批次 items[]：全部 pending、批次內＋跨批次去重、向下相容單筆', () => {
  const { node, memberToken } = setup();
  const first = post(node, { action: 'requestComplete', token: memberToken, itemId: 'L2', itemName: '領袖訓練' });
  assert.equal(first.success, true);
  const batch = post(node, {
    action: 'requestComplete', token: memberToken,
    items: [
      { itemId: 'L2', itemName: '領袖訓練', requested_date: '2026-11-04', evidence: '批次更新' },
      { itemId: 'OT-FA', itemName: '急救章', requested_date: '2026-11-02', evidence: '證書' },
      { itemId: 'OT-FA', itemName: '急救章', requested_date: '2026-11-02', evidence: '證書（重覆）' }
    ]
  });
  assert.equal(batch.success, true, JSON.stringify(batch));
  assert.equal(batch.processed, 3);
  assert.equal(batch.request_ids.length, 3);
  assert.equal(batch.requests[0].request_id, first.request_id, '已有 pending → 去重');
  assert.equal(batch.requests[0].deduplicated, true);
  assert.equal(batch.requests[1].deduplicated, false);
  assert.equal(batch.requests[2].request_id, batch.requests[1].request_id, '批次內重覆都去重');
  const rows = rowsOf(node, '待批完成');
  assert.equal(rows.length, 3, 'header＋L2＋OT-FA');
  assert.ok(rows.slice(1).every(r => String(r[7]) === 'pending'), '全部一律 pending');
  assert.equal(String(rows.find(r => String(r[3]) === 'L2')[6]), '批次更新');
  // 壞批次：缺 itemId 一律拒，唔寫任何列
  const before = rowsOf(node, '待批完成').length;
  const bad = post(node, { action: 'requestComplete', token: memberToken, items: [{ itemId: 'L4' }, { itemName: '冇 ID' }] });
  assert.equal(bad.success, false);
  assert.equal(rowsOf(node, '待批完成').length, before);
});

test('reviewRequest 批准 OT-*：寫「其他獎章」而唔係「進度追蹤」；load.otherBadges 即時可見；重覆批准 Upsert', () => {
  const { node, leaderToken, memberToken } = setup();
  const req = post(node, { action: 'requestComplete', token: memberToken, itemId: 'OT-FA', itemName: '急救章', requested_date: '2026-10-20', evidence: '證書編號 FA-1' });
  assert.equal(req.success, true);
  const progressBefore = rowsOf(node, '進度追蹤').length;
  const ok = post(node, { action: 'reviewRequest', token: leaderToken, request_id: req.request_id, decision: 'approved', review_note: '核實證書', confirmed_date: '2026-11-01' });
  assert.equal(ok.success, true, JSON.stringify(ok));
  const other = rowsOf(node, '其他獎章');
  assert.equal(other.length, 2, '其他獎章得 1 列');
  assert.equal(String(other[1][0]), '1234560011');
  assert.equal(String(other[1][1]), 'OT-FA');
  assert.equal(String(other[1][2]), '急救章');
  assert.equal(String(other[1][3]), '2026-11-01', '用 confirmed_date');
  assert.equal(String(other[1][5]), '由申請轉入：核實證書');
  assert.equal(rowsOf(node, '進度追蹤').length, progressBefore, 'OT-* 唔可以寫入進度追蹤');
  const load = node.context.handleLoad(); // load 係 doGet action（Proxy GET_ACTIONS）
  assert.equal(load.success, true);
  assert.equal(load.otherBadges['1234560011']['OT-FA'].date, '2026-11-01', 'handleLoad.otherBadges 讀到批准結果');
  // 另一個團員同一獎章嘅申請批准後，同一 (ymis,badgeId) 再批准係 Upsert（例如補返日期）
  const req2 = post(node, { action: 'requestComplete', token: memberToken, itemId: 'OT-FA', itemName: '急救章（深資）', requested_date: '2026-11-02' });
  assert.equal(req2.success, true, '批准後再申報係新申請');
  const ok2 = post(node, { action: 'reviewRequest', token: leaderToken, request_id: req2.request_id, decision: 'approved', review_note: '更新', confirmed_date: '2026-11-05' });
  assert.equal(ok2.success, true);
  const other2 = rowsOf(node, '其他獎章');
  assert.equal(other2.length, 2, '(ymis,badgeId) Upsert，唔重覆');
  assert.equal(String(other2[1][3]), '2026-11-05');
  assert.equal(String(other2[1][2]), '急救章（深資）');
});

test('reviewRequest 批准一般項目：handleSave Upsert（既有列更新、冇列先 append）；拒絕唔寫進度', () => {
  const { node, leaderToken, memberToken } = setup();
  // 預先有一列 (ymis,L2) 舊紀錄
  node.ss.getSheetByName('進度追蹤').appendRow(['1234560011', 'L2', '2026-01-01', '2026-01-02', '舊領袖', '舊備註']);
  const reqL2 = post(node, { action: 'requestComplete', token: memberToken, itemId: 'L2', itemName: '領袖訓練', requested_date: '2026-10-01' });
  const reqL3 = post(node, { action: 'requestComplete', token: memberToken, itemId: 'L3', itemName: '進階訓練' });
  const reqL4 = post(node, { action: 'requestComplete', token: memberToken, itemId: 'L4', itemName: '挑戰項目' });
  const okL2 = post(node, { action: 'reviewRequest', token: leaderToken, request_id: reqL2.request_id, decision: 'approved', review_note: 'OK', confirmed_date: '2026-11-01' });
  assert.equal(okL2.success, true);
  let progress = rowsOf(node, '進度追蹤');
  assert.equal(progress.length, 2, '既有 (ymis,L2) 列原地更新，唔會多一行');
  assert.equal(String(progress[1][2]), '2026-11-01');
  assert.equal(String(progress[1][4]), '1234560010', '確認者＝審批領袖');
  assert.equal(String(progress[1][5]), '由申請轉入：OK');
  const okL3 = post(node, { action: 'reviewRequest', token: leaderToken, request_id: reqL3.request_id, decision: 'approved', review_note: '' });
  assert.equal(okL3.success, true);
  progress = rowsOf(node, '進度追蹤');
  assert.equal(progress.length, 3, '冇既有列先 append 一列');
  assert.equal(String(progress[2][1]), 'L3');
  const noL4 = post(node, { action: 'reviewRequest', token: leaderToken, request_id: reqL4.request_id, decision: 'rejected', review_note: '未達標' });
  assert.equal(noL4.success, true);
  assert.equal(rowsOf(node, '進度追蹤').length, 3, '拒絕唔寫進度');
  assert.equal(String(rowsOf(node, '待批完成').find(r => String(r[0]) === reqL4.request_id)[7]), 'rejected');
});

test('禁區守護：待批完成／其他獎章／進度追蹤欄名及欄數完全不變', () => {
  const { node } = setup();
  assert.deepEqual(rowsOf(node, '待批完成')[0], ['request_id', 'ymis', 'name', 'item_id', 'item_name', 'requested_date', 'evidence', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'review_note', 'confirmed_date']);
  assert.deepEqual(rowsOf(node, '其他獎章')[0], ['YMIS', '獎章 ID', '獎章名稱', '完成日期', '證書編號', '備註', '更新時間']);
  assert.deepEqual(rowsOf(node, '進度追蹤')[0], ['YMIS', '項目 ID', '完成日期', '更新時間', '確認者', '備註']);
});

// ---- Proxy：VSBOOK 伺服器對伺服器相容 + slow_password_kdf 日誌 ----
function res() {
  return { headers: {}, code: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } };
}
async function callProxy(body, headers = {}) {
  const r = res();
  // 刻意唔帶 Origin／Sec-Fetch-Site／Referer：模擬 VSBOOK 後端 Node fetch
  await proxy({ method: 'POST', headers, body }, r);
  return r;
}
function mockUpstream(payloadFor) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : Object.fromEntries(new URL(url).searchParams);
    sent.push({ url, method: init.method, body });
    return { status: 200, text: async () => JSON.stringify(payloadFor(body.action)) };
  };
  return { sent, restore: () => { globalThis.fetch = original; } };
}
function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve(fn()).finally(() => { console.log = original; }).then(() => lines);
}

test('Proxy 受理冇瀏覽器 header 嘅 VSBOOK 伺服器請求：login／logout／load／requestComplete 全部轉發', async () => {
  const mock = mockUpstream(action => {
    if (action === 'login') return { success: true, token: 'tok-123456', user: { ymis: '1234560011', role: 'member' }, gsVersion: 'v9.5' };
    if (action === 'load') return { success: true, members: [], progress: {} };
    if (action === 'requestComplete') return { success: true, request_id: 'REQ_1' };
    return { success: true };
  });
  try {
    const login = await callProxy({ troopId: '9001', action: 'login', data: { login_id: '1234560011', password: 'Member!1' } });
    assert.equal(login.code, 200); assert.equal(login.body.success, true);
    const load = await callProxy({ troopId: '9001', action: 'load', data: { token: 'tok-123456' } });
    assert.equal(load.code, 200); assert.equal(load.body.success, true);
    const req = await callProxy({ troopId: '9001', action: 'requestComplete', data: { token: 'tok-123456', items: [{ itemId: 'L2', itemName: '領袖訓練' }] } });
    assert.equal(req.code, 200); assert.equal(req.body.request_id, 'REQ_1');
    assert.deepEqual(mock.sent.find(s => s.body.action === 'requestComplete').body.items, [{ itemId: 'L2', itemName: '領袖訓練' }], '批次 items 原樣轉發');
    const logout = await callProxy({ troopId: '9001', action: 'logout', data: { token: 'tok-123456' } });
    assert.equal(logout.code, 200); assert.equal(logout.body.success, true);
    // apikey 由伺服器端注入，請求 body 唔使自帶
    assert.ok(mock.sent.every(s => (s.body.apikey || new URL(s.url).searchParams.get('apikey')) === 'secret-key-9001'));
  } finally { mock.restore(); }
});

test('GET /api/troops 維持 { troops: { [id]: { name, en } } }（VSBOOK 下拉選單契约）', async () => {
  const r = res();
  await troops({ method: 'GET' }, r);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.troops['9001'], { name: '測試旅', en: 'Test Group' });
  assert.ok(!JSON.stringify(r.body).includes('secret-key-9001') && !JSON.stringify(r.body).includes('script.google'));
});

test('slow_password_kdf 日誌：慢登入記低 ms＋gsVersion；逾時記 timeout:true；唔含密碼／token／apikey', async () => {
  const mock = mockUpstream(() => ({ success: true, token: 'tok-secret-xyz', user: { ymis: '1234560011' }, gsVersion: 'v9.4' }));
  let lines;
  try {
    lines = await captureLogs(() => callProxy({ troopId: '9001', action: 'login', data: { login_id: '1234560011', password: 'Member!1' } }));
  } finally { mock.restore(); }
  const slow = lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(x => x && x.result === 'slow_password_kdf');
  assert.equal(slow.length, 1, '慢過門檻要有 slow_password_kdf 紀錄');
  assert.equal(slow[0].action, 'login');
  assert.equal(slow[0].troopId, '9001');
  assert.equal(slow[0].gsVersion, 'v9.4', '記低 GS 版本供分辨未更新旅團');
  assert.equal(typeof slow[0].ms, 'number');
  assert.ok(!lines.join('\n').includes('Member!1') && !lines.join('\n').includes('tok-secret-xyz') && !lines.join('\n').includes('secret-key-9001'), '日誌唔可以含密碼／token／apikey');

  // 逾時路徑：都要有 slow_password_kdf（timeout:true）＋ 504
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  let timeoutLines, timeoutRes;
  try {
    timeoutLines = await captureLogs(async () => { timeoutRes = await callProxy({ troopId: '9001', action: 'login', data: { login_id: '1234560011', password: 'Member!1' } }); });
  } finally { globalThis.fetch = original; }
  assert.equal(timeoutRes.code, 504);
  const timeoutSlow = timeoutLines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(x => x && x.result === 'slow_password_kdf');
  assert.equal(timeoutSlow.length, 1);
  assert.equal(timeoutSlow[0].timeout, true);
});
