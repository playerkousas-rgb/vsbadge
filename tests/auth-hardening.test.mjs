// ============================================================
// 登入安全強化回歸測試 — 對應 readme repo PLAYBOOK 硬規則 A3／A5／A17 及重設密碼授權
//
//   A3 密碼雜湊：新開戶／批量／改密碼／領袖重設／電郵重設一律寫 PBKDF2-HMAC-SHA256
//      （120000 迭代＋每用戶 16-byte 隨機鹽，格式 pbkdf2$<iter>$<salt>$<dk>）；
//      舊單次 SHA-256 仍可登入並於成功登入時自動升級；upsertUser／importUsers 同時接受兩種格式
//   A5 登入閘：同一帳號連續 5 次失敗鎖 15 分鐘（ScriptProperties LOGIN_FAIL:<ymis>，審計 login_locked）；
//      鎖定期間正確密碼都拒；改密碼後踢走其他 session 保留當前 token；重設後清鎖定＋踢走全部舊 session
//   A17 防枚舉（只限未登入公開端點）：找不到帳號／已停用／密碼錯誤／鎖定中回完全相同訊息，
//      找不到帳號時做假 KDF；後台管理查詢（getAllUsers 等）保持正常，領袖仍可搵到成員
//   重設授權：檢查在 handleResetPassword 內部（上游 sig 入口都受管），只有可管理該角色者可重設；
//      admin 不可改 admin、同級不可互改、成員不可改任何人；被拒時目標雜湊完全不變
//
// 執行：node --test tests/auth-hardening.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, createHmac, pbkdf2Sync, randomUUID } from 'node:crypto';
import { accountId as SUPER_ID } from '../api/_super.js';

const GAS_SOURCE = fs.readFileSync('apps-script/Code.gs', 'utf8');
const sha256 = value => createHash('sha256').update(String(value), 'utf8').digest('hex');
const isV2 = h => /^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]{64}$/i.test(String(h || ''));

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
  const ss = makeSpreadsheet('auth-hardening-test');
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
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/AUTH_TEST/exec' }) },
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
function seedUser(node, { ymis, name = '測試用戶', email = '', role = 'member', pass = 'InitPass1', hash = null, canTick = false, status = 'active', forceChange = false }) {
  const sheet = node.ss.getSheetByName('Users') || node.ss.insertSheet('Users');
  if (sheet.getLastRow() === 0) sheet.appendRow(USER_HEADERS);
  const row = new Array(USER_HEADERS.length).fill('');
  row[0] = ymis; row[1] = name; row[2] = email; row[3] = role;
  row[4] = hash !== null ? hash : sha256(pass); // 預設舊格式 seed（單次 SHA-256）
  row[5] = 'b4'; row[6] = canTick; row[7] = 'system'; row[8] = '2026-01-01';
  row[9] = '2026-01-01'; row[10] = ''; row[11] = status; row[12] = '*'; row[13] = forceChange;
  sheet.appendRow(row);
}
function freshNode() {
  const node = buildNode();
  node.context.initializeSheets(); // 建立內置管理員 1111111111／changeme（PBKDF2）
  return node;
}
const post = (node, body) => node.context.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } });
const login = (node, id, pw) => post(node, { action: 'login', login_id: id, password: pw });
const storedHash = (node, ymis) => { const rec = node.context.findUserRecord(ymis); return rec ? String(rec.data[rec.map.password_hash] || '') : ''; };
const forceFlag = (node, ymis) => { const rec = node.context.findUserRecord(ymis); return rec ? rec.user.force_change_password : null; };
const auditRows = (node, action) => node.ss.getSheetByName('操作紀錄').getDataRange().getValues().slice(1).filter(r => String(r[2]) === action);

test('A3 PBKDF2 實作與 Node crypto 對照一致；hashPasswordV2 格式及鹽隨機', () => {
  const node = buildNode(); // 純函數測試，唔使 initializeSheets
  const saltBytes = Array.from(Buffer.from('salt', 'utf8'));
  const expected = pbkdf2Sync('password', 'salt', 4096, 32, 'sha256').toString('hex');
  const actual = node.context.toHex(node.context.pbkdf2HmacSha256_('password', saltBytes, 4096));
  assert.equal(actual, expected, 'PBKDF2-HMAC-SHA256 迭代結果要同標準實作一致');

  const h1 = node.context.hashPasswordV2('Correct!1');
  const h2 = node.context.hashPasswordV2('Correct!1');
  assert.match(h1, /^pbkdf2\$120000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(h1.split('$')[2], h2.split('$')[2], '每次鹽都唔同');
  assert.equal(node.context.verifyPassword('Correct!1', h1), true);
  assert.equal(node.context.verifyPassword('Wrong!1', h1), false);
  // 外部以 120000 迭代產生的 pbkdf2$ 字串（跨節點格式）照樣驗證得到
  const saltHex = 'ab'.repeat(16);
  const dk = pbkdf2Sync('Correct!1', Buffer.from(saltHex, 'hex'), 120000, 32, 'sha256').toString('hex');
  assert.equal(node.context.verifyPassword('Correct!1', `pbkdf2$120000$${saltHex}$${dk}`), true);
  // 舊格式及壞格式
  assert.equal(node.context.verifyPassword('oldpw', sha256('oldpw')), true);
  assert.equal(node.context.isLegacyPasswordHash_(sha256('oldpw')), true);
  assert.equal(node.context.isLegacyPasswordHash_(h1), false);
  assert.equal(node.context.verifyPassword('oldpw', ''), false);
  assert.equal(node.context.verifyPassword('oldpw', 'pbkdf2$999$zz$yy'), false, '迭代不足／壞格式拒絕');
});

test('A3 新開戶密碼以 PBKDF2 儲存並可登入；預設管理員觸發強制改密', () => {
  const node = freshNode();
  const root = login(node, '1111111111', 'changeme');
  assert.equal(root.success, true);
  assert.equal(root.force_change_password, true, '新格式的預設密碼應觸發強制改密');
  assert.ok(isV2(storedHash(node, '1111111111')), 'initializeSheets 建立的管理員應直接用 PBKDF2');
  const r = post(node, { action: 'addUser', token: root.token, ymis: '1234560201', name: '測試甲', email: 't1@example.org', role: 'group_leader', password: 'Pass!1234', can_tick: true });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(isV2(storedHash(node, '1234560201')), '新開戶 hash 應為 pbkdf2$ 格式');
  assert.equal(login(node, '1234560201', 'Pass!1234').success, true);
  const wrong = login(node, '1234560201', 'wrong-pass');
  assert.equal(wrong.success, false);
  assert.equal(wrong.error, '帳號或密碼錯誤');
});

test('A3 舊 SHA-256 帳戶可登入並自動升級為 PBKDF2（密碼不變）；舊預設密碼照樣強制改密', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234560201', name: '測試甲', email: 't1@example.org', role: 'group_leader', pass: 'Pass!1234', canTick: true });
  assert.equal(storedHash(node, '1234560201'), sha256('Pass!1234'));
  const r = login(node, '1234560201', 'Pass!1234');
  assert.equal(r.success, true, JSON.stringify(r));
  const upgraded = storedHash(node, '1234560201');
  assert.ok(isV2(upgraded), '成功登入後應自動升級：' + upgraded);
  assert.equal(login(node, '1234560201', 'Pass!1234').success, true, '升級後同一密碼仍可登入');
  assert.equal(storedHash(node, '1234560201'), upgraded, '已是新格式就唔再改寫');

  seedUser(node, { ymis: '1234560299', name: '舊管', email: 'old-admin@example.org', role: 'admin', pass: 'changeme', canTick: true, forceChange: false });
  const r2 = login(node, '1234560299', 'changeme');
  assert.equal(r2.success, true);
  assert.equal(r2.force_change_password, true, '舊格式的預設密碼仍應觸發強制改密');
});

test('A5 連續 5 次失敗鎖 15 分鐘：正確密碼都拒、審計 login_locked、期後可登入、成功清零', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234560201', name: '測試甲', pass: 'Pass!1234' });
  seedUser(node, { ymis: '1234560202', name: '測試乙', pass: 'Pass!5678' });
  const key = 'LOGIN_FAIL:1234560201';
  for (let i = 1; i <= 5; i++) {
    const r = login(node, '1234560201', 'wrong-' + i);
    assert.equal(r.success, false);
    assert.equal(r.error, '帳號或密碼錯誤', '第 ' + i + ' 次訊息要統一');
  }
  const rec = JSON.parse(node.props.get(key));
  assert.equal(rec.f, 5);
  assert.ok(rec.until > Date.now() + 14 * 60 * 1000 && rec.until <= Date.now() + 15 * 60 * 1000 + 5000, '鎖定約 15 分鐘');
  const locked = login(node, '1234560201', 'Pass!1234');
  assert.equal(locked.success, false, '鎖定期間正確密碼都拒');
  assert.equal(locked.error, '帳號或密碼錯誤', '鎖定中回應與密碼錯誤完全一致（A17）');
  const lockedAudit = auditRows(node, 'login_locked');
  assert.equal(lockedAudit.length, 1);
  assert.equal(lockedAudit[0][1], 'system');
  assert.equal(String(lockedAudit[0][3]), '1234560201');
  // 鎖定期過後可再登入，成功後清走記錄
  node.props.set(key, JSON.stringify({ f: rec.f, until: Date.now() - 1000 }));
  assert.equal(login(node, '1234560201', 'Pass!1234').success, true, '鎖定期過後應可登入');
  assert.equal(node.props.has(key), false, '成功登入後清走失敗記錄');
  // 未達上限前成功登入亦清零（第 4 次失敗後成功，唔會累積到下次）
  for (let i = 1; i <= 4; i++) login(node, '1234560202', 'bad-' + i);
  assert.equal(JSON.parse(node.props.get('LOGIN_FAIL:1234560202')).f, 4);
  assert.equal(login(node, '1234560202', 'Pass!5678').success, true);
  assert.equal(node.props.has('LOGIN_FAIL:1234560202'), false);
});

test('A17 找不到帳號／已停用帳號／密碼錯誤回完全相同訊息（公開登入防枚舉）', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234560201', name: '測試甲', pass: 'Pass!1234' });
  seedUser(node, { ymis: '1234560203', name: '停用丙', pass: 'Pass!1234', status: 'inactive' });
  const ghost = login(node, '9999999999', 'whatever1');
  const wrongPw = login(node, '1234560201', 'whatever1');
  const inactive = login(node, '1234560203', 'Pass!1234');
  for (const r of [ghost, wrongPw, inactive]) {
    assert.equal(r.success, false);
    assert.equal(r.error, '帳號或密碼錯誤');
    assert.equal(r.token, undefined);
  }
  assert.equal(node.props.has('LOGIN_FAIL:9999999999'), false, '不存在帳號唔建立失敗記錄（冇嘢可鎖）');
});

test('A5 改密碼後：寫 PBKDF2、舊密碼失效、其他 session 被踢、當前 token 保留', () => {
  const node = freshNode();
  seedUser(node, { ymis: '1234560201', name: '測試甲', email: 't1@example.org', role: 'group_leader', pass: 'Pass!1234', canTick: true });
  const s1 = login(node, '1234560201', 'Pass!1234');
  const s2 = login(node, 't1@example.org', 'Pass!1234'); // 第二部裝置
  assert.equal(s1.success, true); assert.equal(s2.success, true);
  assert.notEqual(s1.token, s2.token);
  const change = post(node, { action: 'changePassword', token: s1.token, old_password: 'Pass!1234', new_password: 'BrandNew!9' });
  assert.equal(change.success, true, JSON.stringify(change));
  assert.ok(isV2(storedHash(node, '1234560201')), '改密碼寫 PBKDF2');
  assert.equal(login(node, '1234560201', 'Pass!1234').success, false, '舊密碼失效');
  assert.equal(login(node, '1234560201', 'BrandNew!9').success, true, '新密碼可登入');
  assert.equal(post(node, { action: 'getAllUsers', token: s2.token }).success, false, '另一部裝置的 session 被踢走');
  assert.equal(post(node, { action: 'getAllUsers', token: s1.token }).success, true, '當前 session 保留');
  const bad = post(node, { action: 'changePassword', token: s1.token, old_password: 'nope-nope', new_password: 'Another!1' });
  assert.equal(bad.success, false, '原密碼錯誤要拒絕');
});

test('A3 upsertUser／importUsers 同時接受舊 SHA-256 與 PBKDF2，拒壞格式與明文（跨節點搬數）', () => {
  const node = freshNode();
  const r1 = node.context.upsertUser({ ymis: '1234560301', name: '舊搬來', password_hash: sha256('legacy1') }, 'admin');
  assert.equal(r1.success, true, JSON.stringify(r1));
  assert.equal(storedHash(node, '1234560301'), sha256('legacy1'), '舊 hash 原樣直插（保留舊密碼）');
  assert.equal(login(node, '1234560301', 'legacy1').success, true, '匯入的舊 hash 可直接登入');

  const v2 = 'pbkdf2$120000$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(32);
  const r2 = node.context.upsertUser({ ymis: '1234560302', name: '新搬來', password_hash: v2 }, 'admin');
  assert.equal(r2.success, true, JSON.stringify(r2));
  assert.equal(storedHash(node, '1234560302'), v2, '新 hash 原樣直插');

  assert.match(node.context.upsertUser({ ymis: '1234560303', name: '壞', password_hash: 'nope' }, 'x').error, /SHA-256|pbkdf2/);
  assert.match(node.context.upsertUser({ ymis: '1234560303', name: '壞', password: 'plain' }, 'x').error, /明文/);

  const imported = node.context.importUsersFromText(JSON.stringify({ users: [
    { ymis: '1234560304', name: '匯入舊', password_hash: sha256('imp-old') },
    { ymis: '1234560305', name: '匯入新', password_hash: 'pbkdf2$120000$' + 'ef'.repeat(16) + '$' + '01'.repeat(32) }
  ] }), 'admin');
  assert.equal(imported.success, true, JSON.stringify(imported));
  assert.equal(imported.created, 2);
  // 匯出保留 pbkdf2$ 字串，搬去另一節點可原樣再匯入
  const exported = node.context.collectUsersForExport().find(u => u.ymis === '1234560302');
  assert.equal(exported.password_hash, v2);
});

const ADMIN2 = { ymis: '1234560401', name: '第二管理員', email: 'admin2@example.org', role: 'admin', pass: 'Admin2!pw', canTick: true };
const GL = { ymis: '1234560402', name: '團長乙', email: 'gl@example.org', role: 'group_leader', pass: 'GroupL!pw', canTick: true };
const GL2 = { ymis: '1234560406', name: '團長丙', email: 'gl2@example.org', role: 'group_leader', pass: 'GroupL2!pw', canTick: true };
const BL = { ymis: '1234560403', name: '支部領袖丙', email: 'bl@example.org', role: 'branch_leader', pass: 'BranchL!pw', canTick: true };
const EC = { ymis: '1234560405', name: '執委戊', email: 'ec@example.org', role: 'exec_committee', pass: 'ExecC!pw', canTick: true };
const MEM = { ymis: '1234560404', name: '團員丁', email: '', role: 'member', pass: 'Member!pw' };
const mgrObj = u => ({ ymis: u.ymis, name: u.name, role: u.role });

test('重設授權：handler 內部把關（admin 不可改 admin、同級／低級不可越級、成員不可改任何人、sig 入口受管）', () => {
  const node = freshNode();
  for (const u of [ADMIN2, GL, GL2, BL, EC, MEM]) seedUser(node, u);
  seedUser(node, { ymis: '5555555555', name: '保留列', email: '', role: 'super_admin', pass: 'Keep!1234', canTick: true });
  const admin2Hash = storedHash(node, ADMIN2.ymis);
  const glHash = storedHash(node, GL.ymis);
  const reset = (target, mgr, pw = 'Hijack!1') => node.context.handleResetPassword(target, pw, mgr);
  const rootAdmin = { ymis: '1111111111', name: '管理員', role: 'admin' };

  assert.equal(reset(ADMIN2.ymis, rootAdmin).success, false, 'admin → admin 拒絕');
  assert.match(reset(ADMIN2.ymis, rootAdmin).error, /權限不足/);
  assert.match(reset(ADMIN2.ymis, mgrObj(GL)).error, /權限不足/, '團長 → admin 拒絕');
  assert.match(reset(GL.ymis, mgrObj(BL)).error, /權限不足/, '支部領袖 → 團長 拒絕');
  assert.match(reset(GL2.ymis, mgrObj(GL)).error, /權限不足/, '同級（團長 → 團長）拒絕');
  assert.match(reset(MEM.ymis, mgrObj(EC)).error, /權限不足/, '執委冇用戶管理權');
  assert.match(reset(GL.ymis, mgrObj(MEM)).error, /權限不足/, '成員不可改任何人');
  assert.equal(reset(MEM.ymis, null).success, false, '冇 manager 物件拒絕');
  assert.equal(reset(MEM.ymis, '1111111111').success, false, '淨係傳 ymis 字串唔當已驗證管理員');
  // 上游 sig 入口：完全唔經 doPost 角色閘，靠 handler 檢查（on_behalf_role 決定 linkManager 角色）
  const signed = node.context.handleSignedRequest('resetPassword', { target_ymis: GL.ymis, new_password: 'Hijack!9', on_behalf: 'upstreamX', on_behalf_role: 'branch_leader' });
  assert.equal(signed.success, false);
  assert.match(signed.error, /權限不足/, 'sig 入口的支部領袖都唔可以改團長');
  const signedDefault = node.context.handleSignedRequest('resetPassword', { target_ymis: ADMIN2.ymis, new_password: 'Hijack!9', on_behalf: 'upstreamX' });
  assert.match(signedDefault.error, /權限不足/, 'sig 入口預設 admin 都唔可以改 admin');

  // 被拒後目標雜湊完全不變、原密碼仍有效
  assert.equal(storedHash(node, ADMIN2.ymis), admin2Hash);
  assert.equal(storedHash(node, GL.ymis), glHash);
  assert.equal(node.context.verifyPassword(ADMIN2.pass, admin2Hash), true);
  assert.equal(node.context.verifyPassword('Hijack!1', admin2Hash), false);

  // 只有最高管理層（super_admin 物件）可重設 admin；保留帳號本身永遠不可被重設
  const superMgr = { ymis: SUPER_ID, name: '管理員', role: 'super_admin' };
  const ok = reset(ADMIN2.ymis, superMgr, 'SuperSet!9');
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.ok(isV2(storedHash(node, ADMIN2.ymis)), '重設寫 PBKDF2');
  assert.equal(node.context.verifyPassword('SuperSet!9', storedHash(node, ADMIN2.ymis)), true);
  assert.equal(reset('5555555555', superMgr).success, false, 'super_admin 角色列不可被重設');
  assert.equal(reset(SUPER_ID, superMgr).success, false, '保留帳號不可被重設');
});

test('重設善後：清走登入鎖定、踢走目標舊 session（管理員不動）、force_change_password、即時可登入', () => {
  const node = freshNode();
  seedUser(node, MEM);
  seedUser(node, GL);
  const memToken = node.context.createToken(MEM.ymis);
  const glToken = node.context.createToken(GL.ymis);
  assert.equal(node.context.validateToken(memToken), MEM.ymis);
  for (let i = 1; i <= 5; i++) login(node, MEM.ymis, 'bad-' + i);
  assert.equal(login(node, MEM.ymis, MEM.pass).success, false, '鎖定中正確密碼都拒');
  assert.ok(node.props.get('LOGIN_FAIL:' + MEM.ymis));

  const r = post(node, { action: 'resetPassword', token: glToken, target_ymis: MEM.ymis, new_password: 'Reset!234' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(isV2(storedHash(node, MEM.ymis)));
  assert.equal(forceFlag(node, MEM.ymis), true, '設強制首登改密');
  assert.equal(node.props.has('LOGIN_FAIL:' + MEM.ymis), false, '重設清走失敗鎖定');
  assert.equal(node.context.validateToken(memToken), null, '目標舊 session 已踢走');
  assert.equal(node.context.validateToken(glToken), GL.ymis, '管理員自己 session 冇事');
  const after = login(node, MEM.ymis, 'Reset!234');
  assert.equal(after.success, true, '鎖定清走後即刻可用新密碼登入');
  assert.equal(after.force_change_password, true);
  const audit = auditRows(node, 'reset_password');
  assert.ok(audit.length >= 1);
  assert.equal(JSON.stringify(audit).includes('Reset!234'), false, '審計不含新密碼');
});

test('後台管理查詢不受防枚舉影響：領袖可見成員名單／電郵，重設不存在帳號有明確回覆', () => {
  const node = freshNode();
  seedUser(node, { ymis: MEM.ymis, name: MEM.name, email: 'member@example.org', role: 'member', pass: MEM.pass });
  seedUser(node, GL);
  const glToken = node.context.createToken(GL.ymis);
  const list = post(node, { action: 'getAllUsers', token: glToken });
  assert.equal(list.success, true);
  const found = list.users.find(u => u.ymis === MEM.ymis);
  assert.ok(found, '領袖要喺名單搵到成員先重設到密碼');
  assert.equal(found.email, 'member@example.org', '後台可見登記電郵');
  const missing = node.context.handleResetPassword('9876543210', 'Temp!1234', mgrObj(GL));
  assert.equal(missing.success, false);
  assert.match(missing.error, /找不到帳號/, '已登入的後台操作可明確話畀領袖知搵唔到人');
  const pub = login(node, '9876543210', 'Temp!1234');
  assert.equal(pub.error, '帳號或密碼錯誤', '同一識別碼喺公開登入只會得到中性訊息');
});
