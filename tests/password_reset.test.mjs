// 忘記密碼守護測試（8 位重設碼＋公開入口中性回應）
// 1) 免登入入口不洩露帳號是否存在：不存在／未登記電郵／寄件失敗／成功寄出回應完全一致（A17）
// 2) 重設碼只以加鹽雜湊儲存，15 分鐘有效、最多 5 次嘗試、單次使用；新申請令舊碼即時失效
// 3) 重設成功以 PBKDF2 更新密碼、撤銷所有既有登入、清走登入失敗鎖定、寫入操作紀錄，並把請求結案
// 4) 領袖重設臨時密碼會自動結案；非管理層不可讀取／處理請求
// 5) initializeSheets() 只補建「密碼重設」工作表，重跑不改寫任何現有資料
// 6) Proxy 白名單及前端登入頁／審批中心／中英 i18n 同步
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import proxy from '../api/proxy.js';

const GAS_SOURCE = fs.readFileSync('apps-script/Code.gs', 'utf8');
const HTML = fs.readFileSync('index.html', 'utf8');
const PROXY_SOURCE = fs.readFileSync('api/proxy.js', 'utf8');
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
  const ss = makeSpreadsheet('password-reset-test');
  const props = new Map();
  props.set('API_KEY', 'test-api-key');
  const scriptProps = {
    getProperty: k => (props.has(String(k)) ? props.get(String(k)) : null),
    setProperty: (k, v) => { props.set(String(k), String(v)); },
    deleteProperty: k => { props.delete(String(k)); },
    getProperties: () => Object.fromEntries(props)
  };
  const mails = [];
  const cache = new Map();
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
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/RESET_TEST/exec' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => null },
    MailApp: { sendEmail: opts => { mails.push(opts); } },
    Utilities: {
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algo, value) => Array.from(createHash('sha256').update(String(value), 'utf8').digest()),
      // 真 GAS 接受 String 或 Byte[] 作 data；PBKDF2 會傳 byte[]，stub 要同 semantics
      computeHmacSha256Signature: (value, key) => Array.from(createHmac('sha256', String(key)).update(Array.isArray(value) ? Buffer.from(value.map(b => b & 0xFF)) : Buffer.from(String(value), 'utf8')).digest()),
      formatDate: formatDateStub
    },
    DriveApp: { getRootFolder: () => ({ createFile: () => { throw new Error('test should not export'); } }) },
    UrlFetchApp: { fetch: () => { throw new Error('test should not call network'); } },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ setMimeType: () => ({ getContent: () => text }) }) }
  });
  vm.runInContext(GAS_SOURCE, context);
  context.jsonResponse = obj => obj; // 測試直接取回應物件
  return { ss, props, context, mails, cache };
}

const USER_HEADERS = ['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'auth_by', 'auth_date', 'created_at', 'last_login', 'status', 'allowed_badges', 'force_change_password'];
function seedUser(node, { ymis, name = '測試用戶', email = '', role = 'member', pass = 'InitPass1', canTick = false, status = 'active', forceChange = false }) {
  const sheet = node.ss.getSheetByName('Users') || node.ss.insertSheet('Users');
  if (sheet.getLastRow() === 0) sheet.appendRow(USER_HEADERS);
  const row = new Array(USER_HEADERS.length).fill('');
  row[0] = ymis; row[1] = name; row[2] = email; row[3] = role;
  row[4] = sha256(pass); row[5] = 'b4'; row[6] = canTick; row[7] = 'system'; row[8] = '2026-01-01';
  row[9] = '2026-01-01'; row[10] = ''; row[11] = status; row[12] = ''; row[13] = forceChange;
  sheet.appendRow(row);
}
function resetRows(node) {
  const sheet = node.ss.getSheetByName('密碼重設');
  if (!sheet) return [];
  const map = node.context.getHeaderMap(sheet);
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][map.request_id]) continue;
    const rec = {};
    Object.keys(map).forEach(k => { rec[k] = data[i][map[k]]; });
    out.push(rec);
  }
  return out;
}
function setResetCell(node, requestId, field, value) {
  const sheet = node.ss.getSheetByName('密碼重設');
  const map = node.context.getHeaderMap(sheet);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][map.request_id]) === String(requestId)) {
      sheet.getRange(i + 1, map[field] + 1).setValue(value);
      return;
    }
  }
  throw new Error('reset row not found: ' + requestId);
}
function freshNode() {
  const node = buildNode();
  node.context.initializeSheets();
  seedUser(node, { ymis: '1111111111', name: '管理員', email: 'admin@example.org', role: 'admin', pass: 'AdminPass1', canTick: true });
  return node;
}
const NEUTRAL_MESSAGE = '如該帳號已登記電郵，重設碼會寄到登記電郵，請於 15 分鐘內輸入。如收唔到信，請先檢查垃圾郵件，再聯絡領袖協助。';
// handler 回應物件喺 vm realm 建立，唔可以用 deepStrictEqual 同 host 物件比對；逐欄驗證形狀完全一致
const assertNeutral = (res, label) => {
  assert.equal(res.success, true, label);
  assert.equal(res.message, NEUTRAL_MESSAGE, label);
  assert.deepEqual(Object.keys(res).sort(), ['message', 'success'], (label || '') + '：回應只准有 success+message，冇 channel/email_hint 等洩漏欄位');
};
const codeFromMail = mail => {
  const match = String(mail.body || '').match(/\b(\d{8})\b/);
  return match ? match[1] : '';
};

test('不存在的帳號只回覆中性訊息，不建立紀錄、不寄電郵', () => {
  const node = freshNode();
  const before = node.mails.length;
  const res = node.context.handleRequestPasswordReset('9999999999');
  assertNeutral(res);
  assert.equal(node.mails.length, before, '不存在帳號不會寄出任何電郵');
  assert.equal(resetRows(node).length, 0, '不存在帳號不會寫入密碼重設表');
  assert.doesNotMatch(JSON.stringify(res), /9999999999/, '回應不會回傳帳號');
});

test('未登記電郵：不建立任何請求、不寄電郵，回應與其他情況完全一致（不再提示「未登記電郵」）', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234567890', name: '陳大文', email: '', role: 'member' });
  const res = node.context.handleRequestPasswordReset('1234567890');
  assertNeutral(res, '未登記電郵不可由回應分辨（A17）');
  assert.doesNotMatch(JSON.stringify(res), /未有登記電郵|未登記電郵/);
  assert.equal(node.mails.length, 0, '沒有電郵不會寄出任何電郵');
  assert.equal(resetRows(node).length, 0, '沒有電郵不會寫入密碼重設表（不產生待批請求）');
  assert.equal(typeof node.context.getPasswordResetRequestsList, 'undefined', '已移除領袖待批清單功能');
  assert.equal(typeof node.context.handleResolvePasswordResetRequest, 'undefined');
});

test('已登記電郵：寄出 8 位重設碼，只儲存加鹽雜湊（不存明文），回應仍是同一中性訊息', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234567890', name: '陳大文', email: 'member@example.org', role: 'member' });
  const res = node.context.handleRequestPasswordReset('member@example.org');
  assertNeutral(res, '成功寄出亦不可由回應分辨（唔洩漏 email 提示）');
  assert.equal(node.mails.length, 1);
  assert.equal(node.mails[0].to, 'member@example.org');
  const code = codeFromMail(node.mails[0]);
  assert.match(code, /^\d{8}$/, '電郵包含 8 位重設碼');
  const rows = resetRows(node);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'email');
  assert.equal(rows[0].code_hash.length, 64);
  assert.notEqual(rows[0].code_hash, sha256(code), '不是單純 SHA-256，而是加鹽雜湊');
  assert.notEqual(rows[0].code_hash, code);
  assert.equal(JSON.stringify(rows).includes(code), false, '工作表內不得出現驗證碼明文');
  assert.match(String(rows[0].expires_at), /^\d{4}-\d{2}-\d{2}T/, '到期時間以 ISO 儲存');
  assert.equal(rows[0].attempts, 0);
});

test('電郵寄件失敗（未授權 MailApp）會作廢重設碼，回應與成功完全一致（條件句不聲稱已寄出）', () => {
  const node = buildNode();
  node.context.initializeSheets();
  seedUser(node, { ymis: '1234567890', name: '陳大文', email: 'member@example.org', role: 'member' });
  node.context.MailApp = undefined;
  const res = node.context.handleRequestPasswordReset('1234567890');
  assertNeutral(res, '寄件失敗回應與成功一模一樣');
  assert.doesNotMatch(res.message, /已寄出|已發送至/, '中性訊息用條件句，不會假裝已寄出');
  const rows = resetRows(node);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].code_hash, '', '寄件失敗會清空未送出的驗證碼');
  assert.match(rows[0].note, /電郵發送失敗/);
});

test('驗證碼可完成重設：更新密碼、撤銷所有既有登入、寫入操作紀錄並結案', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234567890', name: '陳大文', email: 'member@example.org', role: 'member', pass: 'OldPass1', forceChange: true });
  const tokens = node.ss.getSheetByName('Tokens');
  tokens.appendRow(['tok-old-1', '1234567890', '2026-01-01', '2099-01-01']);
  tokens.appendRow(['tok-other', '1111111111', '2026-01-01', '2099-01-01']);

  // 先製造登入失敗鎖定紀錄，驗證自助重設成功後會一併清走（即刻可用新密碼登入）
  node.props.set('LOGIN_FAIL:1234567890', JSON.stringify({ f: 5, until: Date.now() + 15 * 60 * 1000 }));
  node.context.handleRequestPasswordReset('1234567890');
  const code = codeFromMail(node.mails[0]);
  // 貼上時夾雜空格／連字號都可完成（自動去除）
  const res = node.context.handleCompletePasswordReset('1234567890', code.slice(0, 4) + ' - ' + code.slice(4), 'BrandNew1');
  assert.equal(res.success, true);
  assert.match(res.message, /密碼已重設/);

  const users = node.ss.getSheetByName('Users');
  const map = node.context.getHeaderMap(users);
  const data = users.getDataRange().getValues();
  const row = data.find(r => String(r[map.ymis]) === '1234567890');
  const iter = vm.runInContext('PBKDF2_ITERATIONS', node.context); // 唔硬編碼迭代次數
  assert.match(String(row[map.password_hash]), new RegExp('^pbkdf2\\$' + iter + '\\$[0-9a-f]{32}\\$[0-9a-f]{64}$'), '新密碼以 PBKDF2 寫入');
  assert.equal(node.context.verifyPassword('BrandNew1', String(row[map.password_hash])), true, '新密碼可驗證');
  assert.equal(row[map.force_change_password], false, '自助重設不需要再強制改密碼');
  const remainTokens = tokens.getDataRange().getValues().slice(1).map(r => String(r[0]));
  assert.equal(remainTokens.includes('tok-old-1'), false, '該用戶既有登入全部撤銷');
  assert.equal(remainTokens.includes('tok-other'), true, '不影響其他用戶登入');
  const rows = resetRows(node);
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].code_hash, '', '完成後清空雜湊');
  assert.equal(rows[0].handled_by, 'self');
  const audit = node.ss.getSheetByName('操作紀錄').getDataRange().getValues();
  assert.ok(audit.some(r => r[2] === 'self_reset_password' && String(r[3]) === '1234567890'), '寫入操作紀錄');
  assert.equal(resetRows(node).filter(r => r.status === 'pending').length, 0, '完成後沒有殘留可用的驗證碼');
  assert.equal(node.props.has('LOGIN_FAIL:1234567890'), false, '重設成功清走登入失敗鎖定');
  assert.equal(JSON.stringify(audit).includes('BrandNew1'), false, '審計不含新密碼');
  assert.equal(JSON.stringify(audit).includes(code), false, '審計不含重設碼');
});

test('重設碼錯誤遞增嘗試次數，5 次後鎖定；過期重設碼即時失效；所有失敗回同一句', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234567890', name: '陳大文', email: 'member@example.org' });
  node.context.handleRequestPasswordReset('1234567890');
  const good = codeFromMail(node.mails[0]);
  const wrong = good === '00000000' ? '11111111' : '00000000';
  for (let i = 1; i <= 4; i++) {
    const res = node.context.handleCompletePasswordReset('1234567890', wrong, 'Another1');
    assert.equal(res.success, false);
    assert.equal(res.error, '重設碼不正確或已過期，請重新申請');
    assert.equal(Number(resetRows(node)[0].attempts), i);
  }
  const fifth = node.context.handleCompletePasswordReset('1234567890', wrong, 'Another1');
  assert.equal(fifth.error, '重設碼不正確或已過期，請重新申請', '鎖定後亦不透露次數（A17）');
  assert.equal(resetRows(node)[0].status, 'locked');
  assert.equal(resetRows(node)[0].code_hash, '', '鎖定後清空雜湊');
  const afterLock = node.context.handleCompletePasswordReset('1234567890', good, 'Another1');
  assert.equal(afterLock.success, false, '鎖定後即使驗證碼正確亦不可用');

  // 過期：重新申請後把到期時間調到過去
  node.cache.clear();
  node.context.handleRequestPasswordReset('1234567890');
  const rows = resetRows(node);
  const latest = rows[rows.length - 1];
  setResetCell(node, latest.request_id, 'expires_at', new Date(Date.now() - 60000).toISOString());
  const expired = node.context.handleCompletePasswordReset('1234567890', codeFromMail(node.mails[node.mails.length - 1]), 'Another1');
  assert.equal(expired.success, false);
  assert.equal(resetRows(node).find(r => r.request_id === latest.request_id).status, 'expired');
});

test('新申請令舊驗證碼失效；未登記電郵的帳號不可用驗證碼流程', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234567890', name: '陳大文', email: 'member@example.org' });
  node.context.handleRequestPasswordReset('1234567890');
  const firstCode = codeFromMail(node.mails[0]);
  node.cache.clear();
  node.context.handleRequestPasswordReset('1234567890');
  const secondCode = codeFromMail(node.mails[1]);
  const rows = resetRows(node);
  assert.equal(rows.filter(r => r.status === 'superseded').length, 1, '舊請求被取代');
  assert.equal(rows.filter(r => r.status === 'pending').length, 1);
  const oldTry = node.context.handleCompletePasswordReset('1234567890', firstCode, 'NewPass12');
  assert.equal(oldTry.success, false, '舊驗證碼不可用');
  const newTry = node.context.handleCompletePasswordReset('1234567890', secondCode, 'NewPass12');
  assert.equal(newTry.success, true);

  seedUser(node, { ymis: '2233445566', name: '無電郵', email: '' });
  node.cache.clear();
  const noMail = node.context.handleRequestPasswordReset('2233445566');
  assertNeutral(noMail);
  assert.equal(resetRows(node).filter(r => r.ymis === '2233445566').length, 0, '沒有電郵的帳號不會產生驗證碼紀錄');
  const leaderOnly = node.context.handleCompletePasswordReset('2233445566', '12345678', 'NewPass12');
  assert.equal(leaderOnly.success, false);
  assert.equal(leaderOnly.error, '重設碼不正確或已過期，請重新申請');
});

test('同一帳號有冷卻時間，避免密集寄送驗證碼', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234567890', name: '陳大文', email: 'member@example.org' });
  assert.equal(node.context.handleRequestPasswordReset('1234567890').success, true);
  const second = node.context.handleRequestPasswordReset('1234567890');
  assert.equal(second.success, false);
  assert.match(second.error, /過於頻密/);
  assert.equal(node.mails.length, 1);
});

test('領袖重設臨時密碼會作廢未用驗證碼；免登入流程不設任何待批清單', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234567890', name: '陳大文', email: 'member@example.org' });
  node.context.handleRequestPasswordReset('1234567890');
  const code = codeFromMail(node.mails[0]);
  assert.equal(resetRows(node).length, 1);

  const manager = { ymis: '1111111111', name: '管理員', role: 'admin' };
  const reset = node.context.handleResetPassword('1234567890', 'Temp1234', manager);
  assert.equal(reset.success, true);
  assert.match(reset.message, /未使用的驗證碼已作廢/);
  const rows = resetRows(node);
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].handled_by, '1111111111');
  assert.equal(rows[0].code_hash, '');
  const after = node.context.handleCompletePasswordReset('1234567890', code, 'Another1');
  assert.equal(after.success, false, '領袖重設後舊驗證碼不可再用');

  // 舊版領袖清單 action 已移除：即使帶管理員 token 亦不會被處理
  const managerToken = node.context.createToken('1111111111');
  for (const action of ['getPasswordResetRequests', 'resolvePasswordResetRequest']) {
    const res = node.context.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action, token: managerToken }) } });
    assert.equal(res.success, false);
    assert.match(res.error, /Unknown action/);
  }
});

test('initializeSheets() 補建「密碼重設」表且重跑不改寫任何現有資料', () => {
  const node = buildNode();
  seedUser(node, { ymis: '1234567890', name: '陳大文', email: 'member@example.org', pass: 'KeepMe1' });
  assert.equal(node.ss.getSheetByName('密碼重設'), null, '初始化前未有密碼重設表');

  const init1 = node.context.initializeSheets();
  assert.equal(init1.success, true);
  const usersBefore = JSON.parse(JSON.stringify(node.ss.getSheetByName('Users')._rows));
  assert.ok(node.ss.getSheetByName('密碼重設'), '初始化補建密碼重設表');
  const headers = node.ss.getSheetByName('密碼重設')._rows[0];
  for (const field of ['request_id', 'ymis', 'channel', 'code_hash', 'expires_at', 'status', 'attempts', 'handled_by']) {
    assert.ok(headers.includes(field), '缺少欄位 ' + field);
  }

  node.context.handleRequestPasswordReset('1234567890');
  const resetBefore = JSON.parse(JSON.stringify(node.ss.getSheetByName('密碼重設')._rows));
  const init2 = node.context.initializeSheets();
  assert.equal(init2.success, true);
  assert.deepEqual(node.ss.getSheetByName('密碼重設')._rows, resetBefore, '重跑初始化保留密碼重設紀錄');
  assert.deepEqual(node.ss.getSheetByName('Users')._rows, usersBefore, '初始化不改寫用戶資料');
  assert.equal(node.props.get('API_KEY'), 'test-api-key', '初始化不更換 API Key');
});

test('Proxy 白名單：只放行兩個公開重設入口，沒有領袖待批 action', () => {
  assert.match(PROXY_SOURCE, /PUBLIC_ACTIONS = new Set\(\[[^\]]*'requestPasswordReset'[^\]]*'completePasswordReset'/, '公開白名單');
  assert.doesNotMatch(PROXY_SOURCE, /getPasswordResetRequests|resolvePasswordResetRequest/, '已移除領袖待批 action');
});

test('Proxy 轉發 requestPasswordReset 時注入 API Key，未登記的 action 一律拒絕', async () => {
  process.env.TROOP_0082_NAME = '第 82 旅';
  process.env.TROOP_0082_BACKEND = 'https://script.google.com/macros/s/TEST_RESET_0082/exec';
  process.env.TROOP_0082_APIKEY = 'secret-api-key';
  const makeRes = () => ({ headers: {}, code: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } });
  const originalFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, init };
    return { status: 200, text: async () => JSON.stringify({ success: true, message: NEUTRAL_MESSAGE }) };
  };
  try {
    const resA = makeRes();
    await proxy({ method: 'POST', body: { troopId: '0082', action: 'requestPasswordReset', data: { login_id: 'member@example.org' } } }, resA);
    assert.equal(resA.code, 200);
    assert.equal(resA.body.message, NEUTRAL_MESSAGE);
    assert.equal('channel' in resA.body, false, '新版回應唔帶 channel／email_hint 等可分辨欄位');
    const forwarded = JSON.parse(sent.init.body);
    assert.equal(forwarded.action, 'requestPasswordReset');
    assert.equal(forwarded.login_id, 'member@example.org');
    assert.equal(forwarded.apikey, 'secret-api-key', 'API Key 由伺服器端注入，瀏覽器不會看到');

    const resB = makeRes();
    await proxy({ method: 'POST', body: { troopId: '0082', action: 'getPasswordResetRequests', data: {} } }, resB);
    assert.equal(resB.code, 400, '已移除的 action 不在白名單');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('前端：登入頁連結、重設三步流程及中英 i18n 齊全（中性訊息＋收唔到信指引）', () => {
  assert.match(HTML, /onclick="showPasswordResetModal\(\);return false"[\s\S]{0,220}data-i18n="pwreset\.loginLink"/, '登入頁有明顯的「忘記密碼」入口');
  for (const id of ['passwordResetModal', 'passwordResetStep1', 'passwordResetStep2', 'passwordResetStep3', 'btnRequestPasswordReset', 'btnCompletePasswordReset']) {
    assert.ok(HTML.includes('id="' + id + '"'), '缺少元素 #' + id);
  }
  assert.match(HTML, /apiRequest\('requestPasswordReset',\{login_id:/, '前端呼叫 requestPasswordReset');
  assert.match(HTML, /apiRequest\('completePasswordReset',\{login_id:passwordResetContext\.loginId,code,new_password:newP\}\)/, '前端呼叫 completePasswordReset');
  assert.doesNotMatch(HTML, /getPasswordResetRequests|resolvePasswordResetRequest|approvalResetView/, '已移除領袖待批清單 UI');
  // 新版中性回應一律去輸入重設碼嗰步並顯示本機語言中性指引；舊版 GS 的 channel 只作兼容分支
  assert.match(HTML, /passwordResetContext\.channel=d\.channel\|\|'neutral'/, '冇 channel 當中性回應');
  assert.match(HTML, /msg\.textContent=i18n\('pwreset\.sentGeneric'\)[\s\S]{0,120}setPasswordResetStep\(2\)/, '中性回應去第 2 步輸入重設碼');
  assert.match(HTML, /d\.channel==='leader'\|\|d\.channel==='none'/, '舊版 GS 兼容分支保留');
  assert.match(HTML, /data-i18n="pwreset\.noMailHelp"/, '有「收唔到信？」逐步指引');
  assert.match(HTML, /id="pwResetCode"[^>]*maxlength="12"/, '重設碼輸入容許貼上連空格的 8 位碼');
  assert.match(HTML, /code\.length!==8&&code\.length!==6/, '新 8 位碼為主，升級前舊 6 位碼仍可輸入');
  assert.match(HTML, /i18n\('pwreset\.badCode'\)/, '後端統一失敗句轉做當前語言');

  const zh = HTML.slice(HTML.indexOf('zh:{'), HTML.indexOf('en:{'));
  const en = HTML.slice(HTML.indexOf('en:{'));
  const keys = ['pwreset.loginLink', 'pwreset.title', 'pwreset.hint', 'pwreset.request', 'pwreset.codeLabel', 'pwreset.submit', 'pwreset.done', 'pwreset.noMailHelp', 'pwreset.badCode', 'pwreset.sentGeneric'];
  for (const key of keys) {
    assert.ok(zh.includes("'" + key + "':"), '中文缺少 i18n 鍵 ' + key);
    assert.ok(en.includes("'" + key + "':"), '英文缺少 i18n 鍵 ' + key);
  }
});
