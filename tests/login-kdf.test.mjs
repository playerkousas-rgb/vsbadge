import { gasHmac, gasBlob } from './gas-hmac-mock.mjs';
// ============================================================
// 登入 KDF 成本回歸測試 — 對應「PBKDF2 登入逾時」事故修法
//
//   1) 每條登入路徑嘅 KDF 成本：
//      ① 目前格式帳號登入＝1 次驗證 KDF（用雜湊自帶 iter）
//      ② 舊 64-hex 帳號首次登入＝0 次驗證 KDF（單次 SHA-256）＋1 次升級 KDF（目前 iter，一次性）
//      ③ 舊高迭代 pbkdf2$ 帳號首次登入＝1 次驗證 KDF（舊 iter）＋1 次升級 KDF（目前 iter，一次性）
//      ④ 帳號不存在＝1 次 dummy KDF；⑤ 鎖定中＝1 次 dummy KDF（唔准提早 return）
//      ⑥ changePassword＝1 次驗證＋1 次新雜湊（必然兩次，屬改密路徑成本）
//   2) dummy 雜湊用 CacheService 重用（6 小時 TTL）：新執行（新 VM）共享同一 cache 時
//      唔會再燒一次生成 KDF；每次「帳號不存在」登入仍然只做 1 次 KDF
//   3) 舊雜湊透明升級後密碼不變、唔使重設；升級後登入只剩 1 次 KDF
//   4) benchmarkPasswordKdf() 喺 GAS 原路徑（Utilities.computeHmacSha256Signature）量度，
//      回傳各迭代次數嘅真實毫秒結構
//
//   禁區守護：迭代次數全部由 Code.gs 常數推導，測試唔硬編碼；唔回退單次 SHA-256。
//
// 執行：node --test tests/login-kdf.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, createHmac, pbkdf2Sync, randomUUID } from 'node:crypto';

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
// sharedCache：跨 VM（模擬 GAS 新執行）共用同一個 CacheService，驗證 dummy 雜湊重用。
function buildNode(sharedCache) {
  const ss = makeSpreadsheet('login-kdf-test');
  const props = new Map();
  props.set('API_KEY', 'test-api-key');
  const scriptProps = {
    getProperty: k => (props.has(String(k)) ? props.get(String(k)) : null),
    setProperty: (k, v) => { props.set(String(k), String(v)); },
    deleteProperty: k => { props.delete(String(k)); },
    getProperties: () => Object.fromEntries(props)
  };
  const cache = sharedCache || new Map();
  const cachePuts = [];
  const kdfRuns = []; // 每次 pbkdf2HmacSha256_ 呼叫記低 {iter}
  const context = vm.createContext({
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => scriptProps },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache.has(String(k)) ? cache.get(String(k)) : null),
        put: (k, v, ttl) => { cache.set(String(k), String(v)); cachePuts.push({ key: String(k), ttl }); },
        remove: k => { cache.delete(String(k)); }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/KDF_TEST/exec' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => null },
    MailApp: { sendEmail: () => {} },
    Utilities: {
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algo, value) => Array.from(createHash('sha256').update(String(value), 'utf8').digest()),
      computeHmacSha256Signature: gasHmac, newBlob: gasBlob,
      formatDate: formatDateStub
    },
    DriveApp: { getRootFolder: () => ({ createFile: () => { throw new Error('test should not export'); } }) },
    UrlFetchApp: { fetch: () => { throw new Error('test should not call network'); } },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ setMimeType: () => ({ getContent: () => text }) }) }
  });
  vm.runInContext(GAS_SOURCE, context);
  context.jsonResponse = obj => obj;
  // 包住 GAS 原路徑 KDF：內部函式呼叫經 global 解析，會行到呢個 wrapper（同 jsonResponse 覆蓋原理）
  const origKdf = context.pbkdf2HmacSha256_;
  context.pbkdf2HmacSha256_ = function (password, salt, iterations) {
    kdfRuns.push(iterations);
    return origKdf(password, salt, iterations);
  };
  return { ss, props, context, cache, cachePuts, kdfRuns };
}
const gasConst = (node, name) => vm.runInContext(name, node.context);
function freshNode(sharedCache) {
  const node = buildNode(sharedCache);
  node.context.initializeSheets();
  node.kdfRuns.length = 0; // 唔計初始化（建管理員）嘅 KDF
  node.cachePuts.length = 0;
  return node;
}
const USER_HEADERS = ['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'auth_by', 'auth_date', 'created_at', 'last_login', 'status', 'allowed_badges', 'force_change_password'];
function seedUser(node, { ymis, name = '測試用戶', email = '', role = 'member', hash, canTick = false, status = 'active' }) {
  const sheet = node.ss.getSheetByName('Users') || node.ss.insertSheet('Users');
  if (sheet.getLastRow() === 0) sheet.appendRow(USER_HEADERS);
  const row = new Array(USER_HEADERS.length).fill('');
  row[0] = ymis; row[1] = name; row[2] = email; row[3] = role; row[4] = hash;
  row[5] = 'b4'; row[6] = canTick; row[7] = 'system'; row[8] = '2026-01-01';
  row[9] = '2026-01-01'; row[10] = ''; row[11] = status; row[12] = '*'; row[13] = false;
  sheet.appendRow(row);
}
const post = (node, body) => node.context.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } });
const login = (node, id, pw) => post(node, { action: 'login', login_id: id, password: pw });
const storedHash = (node, ymis) => { const rec = node.context.findUserRecord(ymis); return rec ? String(rec.data[rec.map.password_hash] || '') : ''; };
// 由常數推導嘅「舊高迭代」次數（例如常數 10,000 → 120,000），唔硬編碼
const legacyIter = node => Math.min(gasConst(node, 'PBKDF2_MAX_ITERATIONS'), gasConst(node, 'PBKDF2_ITERATIONS') * 12);
function makePbkdf2Hash(password, iterations) {
  const saltHex = 'ab'.repeat(16);
  const dk = pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256').toString('hex');
  return `pbkdf2$${iterations}$${saltHex}$${dk}`;
}

test('① 目前格式登入：只做 1 次 KDF（用雜湊自帶 iter），成功回應帶 gsVersion', () => {
  const node = freshNode();
  const ITER = gasConst(node, 'PBKDF2_ITERATIONS');
  const original = makePbkdf2Hash('Pass!1234', ITER);
  seedUser(node, { ymis: '1234560001', hash: original });
  const r = login(node, '1234560001', 'Pass!1234');
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(node.kdfRuns, [ITER], '每次登入只做 1 次 KDF');
  assert.equal(r.gsVersion, gasConst(node, 'VS_GS_VERSION'), '成功登入回報 GS 版本供 Proxy／前端核對');
  assert.equal(storedHash(node, '1234560001'), original, '目前格式唔使改寫');
  node.kdfRuns.length = 0;
  assert.equal(login(node, '1234560001', 'Pass!1234').success, true);
  assert.deepEqual(node.kdfRuns, [ITER], '第二次登入都係 1 次');
});

test('② 舊 64-hex 首次登入：驗證用單次 SHA-256＋1 次升級 KDF；密碼不變，之後只剩 1 次', () => {
  const node = freshNode();
  const ITER = gasConst(node, 'PBKDF2_ITERATIONS');
  seedUser(node, { ymis: '1234560002', hash: sha256('OldPass!1') });
  const r = login(node, '1234560002', 'OldPass!1');
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(node.kdfRuns, [ITER], '舊 hash 登入＝1 次 KDF（升級用，目前 iter）');
  const upgraded = storedHash(node, '1234560002');
  assert.match(upgraded, new RegExp('^pbkdf2\\$' + ITER + '\\$[0-9a-f]{32}\\$[0-9a-f]{64}$'), '透明升級做目前格式');
  assert.equal(node.context.verifyPassword('OldPass!1', upgraded), true, '密碼不變');
  node.kdfRuns.length = 0;
  assert.equal(login(node, '1234560002', 'OldPass!1').success, true, '升級後同一密碼照入');
  assert.deepEqual(node.kdfRuns, [ITER], '升級後登入只剩 1 次驗證 KDF');
  assert.equal(storedHash(node, '1234560002'), upgraded, '唔再重覆改寫');
});

test('③ 舊高迭代 pbkdf2$ 首次登入：1 次驗證（舊 iter）＋1 次升級（目前 iter）；之後只剩 1 次', () => {
  const node = freshNode();
  const ITER = gasConst(node, 'PBKDF2_ITERATIONS');
  const OLD = legacyIter(node);
  assert.notEqual(OLD, ITER, '舊迭代 fixture 必須唔等於目前常數');
  seedUser(node, { ymis: '1234560003', hash: makePbkdf2Hash('HeavyPass!1', OLD) });
  const r = login(node, '1234560003', 'HeavyPass!1');
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(node.kdfRuns, [OLD, ITER], '首次＝1 次驗證 KDF（舊 iter）＋1 次一次性升級 KDF（目前 iter）');
  const upgraded = storedHash(node, '1234560003');
  assert.match(upgraded, new RegExp('^pbkdf2\\$' + ITER + '\\$'), '透明改寫做目前迭代');
  assert.equal(node.context.verifyPassword('HeavyPass!1', upgraded), true, '密碼不變、毋須重設');
  node.kdfRuns.length = 0;
  assert.equal(login(node, '1234560003', 'HeavyPass!1').success, true);
  assert.deepEqual(node.kdfRuns, [ITER], '升級後每次登入只做 1 次 KDF');
});

test('④ 帳號不存在：每次登入只做 1 次 dummy KDF；CacheService 重用 6 小時，新執行唔再燒生成成本', () => {
  const shared = new Map();
  const node = freshNode(shared);
  const ITER = gasConst(node, 'PBKDF2_ITERATIONS');
  const r1 = login(node, '9999999999', 'whatever1');
  assert.equal(r1.success, false);
  assert.equal(r1.error, '帳號或密碼錯誤');
  assert.deepEqual(node.kdfRuns, [ITER], '帳號不存在＝1 次 dummy KDF（目前 iter 成本）');
  assert.equal(node.cachePuts.length, 1, 'dummy 雜湊寫入 CacheService 一次');
  assert.equal(node.cachePuts[0].ttl, 6 * 60 * 60, 'TTL 6 小時');
  assert.ok(node.cachePuts[0].key.includes(String(ITER)), 'cache key 帶迭代次數（改常數唔會重用舊成本 dummy）');

  // 模擬 GAS 新執行（新 VM、__dummyPasswordHash_ 重置）但 CacheService 暖住：
  // 仍然只做 1 次 KDF（dummy 驗證），唔會再燒一次生成 KDF。
  const node2 = freshNode(shared);
  const r2 = login(node2, '8888888888', 'whatever2');
  assert.equal(r2.success, false);
  assert.equal(r2.error, '帳號或密碼錯誤', '中性訊息完全一致');
  assert.deepEqual(node2.kdfRuns, [ITER], '新執行每次登入都係 1 次 KDF');
  assert.equal(node2.cachePuts.length, 0, '暖 cache 命中：唔再重新生成 dummy');
});

test('⑤ 鎖定中：照做 1 次 dummy KDF（唔准提早 return），訊息與帳號不存在完全一致', () => {
  const node = freshNode();
  const ITER = gasConst(node, 'PBKDF2_ITERATIONS');
  seedUser(node, { ymis: '1234560005', hash: makePbkdf2Hash('LockPass!1', ITER) });
  const maxFails = gasConst(node, 'LOGIN_MAX_FAILS');
  for (let i = 0; i < maxFails; i++) {
    node.kdfRuns.length = 0;
    const r = login(node, '1234560005', 'wrong-' + i);
    assert.equal(r.success, false);
    assert.deepEqual(node.kdfRuns, [ITER], '錯密碼：每次只做 1 次驗證 KDF');
  }
  node.kdfRuns.length = 0;
  const locked = login(node, '1234560005', 'LockPass!1'); // 鎖定期間連正確密碼都拒
  assert.equal(locked.success, false);
  assert.equal(locked.error, '帳號或密碼錯誤');
  assert.equal(locked.token, undefined);
  assert.deepEqual(node.kdfRuns, [ITER], '鎖定中都要做 1 次 dummy KDF，唔可以 0 次提早 return');
  const ghost = login(node, '9999999999', 'whatever');
  assert.equal(ghost.error, locked.error, '鎖定 vs 不存在：訊息一致（時序而家亦一致）');
});

test('⑥ changePassword：1 次驗證＋1 次新雜湊（改密路徑必然兩次 KDF）', () => {
  const node = freshNode();
  const ITER = gasConst(node, 'PBKDF2_ITERATIONS');
  seedUser(node, { ymis: '1234560006', hash: makePbkdf2Hash('Before!1', ITER) });
  const s = login(node, '1234560006', 'Before!1');
  assert.equal(s.success, true);
  node.kdfRuns.length = 0;
  const change = post(node, { action: 'changePassword', token: s.token, old_password: 'Before!1', new_password: 'After!2' });
  assert.equal(change.success, true, JSON.stringify(change));
  assert.deepEqual(node.kdfRuns, [ITER, ITER], '改密＝驗證舊密碼 1 次＋寫新雜湊 1 次');
  assert.equal(login(node, '1234560006', 'After!2').success, true);
});

test('benchmarkPasswordKdf()：GAS 原路徑量度，回傳各迭代次數毫秒結構（次數由常數推導）', () => {
  const node = freshNode();
  const ITER = gasConst(node, 'PBKDF2_ITERATIONS');
  const report = node.context.benchmarkPasswordKdf(1);
  assert.equal(report.success, true);
  assert.equal(report.defaultIterations, ITER);
  assert.equal(report.gsVersion, gasConst(node, 'VS_GS_VERSION'));
  const iters = Array.from(report.results, r => r.iterations); // VM realm → host realm
  assert.ok(iters.includes(120000) && iters.includes(10000) && iters.includes(ITER), '量度 120,000 vs 10,000（及目前常數）');
  for (const r of report.results) {
    assert.equal(typeof r.avgMs, 'number');
    assert.ok(r.avgMs >= 0 && r.bestMs <= r.avgMs);
  }
  // wrapper 計到嘅 KDF 行數同報告一致（每個次數跑 1 次）
  assert.deepEqual(node.kdfRuns.slice().sort((a, b) => a - b), iters.slice().sort((a, b) => a - b));
});
