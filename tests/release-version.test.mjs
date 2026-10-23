// 最新版本公告、GS 初始化核對及用戶資料保全守護測試
// 1) 前端 LATEST_RELEASE 同 GS 的 VS_GS_VERSION 必須一致（唔一致公告會永遠顯示「未更新」）
// 2) ecStatus／load 回報 gsVersion + initializedGsVersion；initializeSheets() 之後先記錄初始化版本
// 3) 初始化唔准改寫用戶現有資料（帳號、成員、YMIS、新舊 ID 進度、獎章、活動履歷、Token、操作紀錄、設定），
//    重複初始化安全（idempotent），現有 API Key 唔得更換
// 4) Proxy 放行 ecStatus 並喺伺服器端注入 API Key
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import proxy from '../api/proxy.js';

const GAS_SOURCE = fs.readFileSync('apps-script/Code.gs', 'utf8');
const sha256 = value => createHash('sha256').update(String(value), 'utf8').digest('hex');

// ---- in-memory SpreadsheetApp（同 troop_link 守護測試同款做法）----
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
  const ss = makeSpreadsheet('release-test');
  const props = new Map();
  props.set('API_KEY', 'test-api-key-keep-me');
  const scriptProps = {
    getProperty: k => (props.has(String(k)) ? props.get(String(k)) : null),
    setProperty: (k, v) => { props.set(String(k), String(v)); },
    deleteProperty: k => { props.delete(String(k)); },
    getProperties: () => Object.fromEntries(props)
  };
  const context = vm.createContext({
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => scriptProps },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/RELEASE_TEST/exec' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => null },
    Utilities: {
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algo, value) => Array.from(createHash('sha256').update(String(value), 'utf8').digest()),
      formatDate: formatDateStub
    },
    DriveApp: { getRootFolder: () => ({ createFile: () => { throw new Error('test should not export'); } }) },
    UrlFetchApp: { fetch: () => { throw new Error('test should not call network'); } },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ setMimeType: () => ({ getContent: () => text }) }) }
  });
  vm.runInContext(GAS_SOURCE, context);
  context.jsonResponse = obj => obj; // 測試直接取回應物件
  return { ss, props, context };
}
function snapshotRows(node, names) {
  return Object.fromEntries(names.map(name => [name, JSON.parse(JSON.stringify(node.ss.getSheetByName(name)._rows))]));
}

test('最新 GS 發佈喺前端公告同 Apps Script 之間保持一致', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const gas = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const release = html.match(/const LATEST_RELEASE=Object\.freeze\(\{updated:'([^']+)',gsVersion:'([^']+)',initializeRequired:(true|false)\}\)/);
  assert.ok(release, '前端只有一個最新發佈宣告（不設逐級補丁清單）');
  const gs = gas.match(/const VS_GS_VERSION = '([^']+)'/);
  assert.ok(gs, 'Apps Script 端有最新 GS 發佈識別');
  assert.equal(release[1], '2026-10-23', '公告日期');
  assert.equal(release[2], gs[1], '前端要求嘅 GS 版本同後端回報必須一致');
  assert.equal(release[3], 'true', '呢個版本必須明確要求 initializeSheets()');
  assert.match(gas, /setProperty\(VS_GS_INITIALIZED_PROP,VS_GS_VERSION\)/, 'initializeSheets() 成功完成後寫入初始化標記');
  assert.doesNotMatch(gas, /VERSION_HISTORY|SEQUENTIAL_PATCH|PATCH_LIST/, '唔准出現逐級補丁清單');
  const proxySource = fs.readFileSync(new URL('../api/proxy.js', import.meta.url), 'utf8');
  assert.match(proxySource, /PUBLIC_ACTIONS = new Set\(\[[^\]]*'ecStatus'/, 'Proxy 白名單放行 ecStatus');
  // 首頁、登入頁及登入後主頁三個公告位都要存在
  for (const hostId of ['homeReleaseNotice', 'loginReleaseNotice', 'mainReleaseNotice']) {
    assert.ok(html.includes('id="' + hostId + '"'), '公告位 ' + hostId + ' 存在');
  }
});

test('GS 版本同初始化獨立核對；初始化 idempotent 而且唔會改寫用戶資料、唔會更換 API Key', () => {
  const node = buildNode();
  const { ss, props, context } = node;
  // 模擬一個已有資料的旅團後端（舊版 GS，從未寫過初始化標記）
  const seed = (name, header, row) => { const s = ss.insertSheet(name); s.appendRow(header); if (row) s.appendRow(row); };
  seed('進度追蹤', ['YMIS', '項目 ID', '完成日期', '更新時間', '確認者', '備註'], ['1234567890', 'OLD-ID-01', '2025-01-01', '2025-01-02', '舊領袖', '舊 ID 進度備註']);
  seed('成員名單', ['YMIS', '姓名', '加入日期', '支部', '聯絡'], ['1234567890', '陳大文', '2025-01-01', '深資童軍', '舊聯絡']);
  ss.insertSheet('Users').appendRow(['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'auth_by', 'auth_date', 'created_at', 'last_login', 'status', 'allowed_badges', 'force_change_password']);
  ss.getSheetByName('Users').appendRow(['1111111111', '管理員', 'admin@example.com', 'admin', sha256('changeme'), 'b4', true, 'system', '2026-01-01', '2026-01-01', '', 'active', '', true]);
  ss.getSheetByName('Users').appendRow(['1234567890', '陳大文', 'member@example.org', 'member', 'existing-hash', 'b4', false, '舊領袖', '2025-01-01', '2025-01-01', '2026-01-02', 'active', '', false]);
  seed('Applications', ['app_id', 'ymis', 'name', 'email', 'role', 'branch', 'status', 'applied_at', 'reviewed_by', 'reviewed_at', 'note'], ['APP-1', '1234567890', '陳大文', 'member@example.org', 'member', '深資童軍', 'approved', '2025-01-01', '舊領袖', '2025-01-02', '舊申請']);
  seed('Tokens', ['token', 'ymis', 'created_at', 'expires_at'], ['token-user', '1234567890', '2026-01-01', '2099-01-01']);
  seed('待批完成', ['request_id', 'ymis', 'name', 'item_id', 'item_name', 'requested_date', 'evidence', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'review_note', 'confirmed_date'], ['REQ-1', '1234567890', '陳大文', 'OLD-ID-01', '舊項目', '2025-01-01', '舊證據', 'approved', '2025-01-01', '舊領袖', '2025-01-02', '', '2025-01-01']);
  seed('其他獎章', ['YMIS', '獎章 ID', '獎章名稱', '完成日期', '證書編號', '備註', '更新時間'], ['1234567890', 'ACT-07', '游泳章', '2024-01-01', 'CERT-OLD', '舊徽章備註', '2024-01-02']);
  seed('操作紀錄', ['時間', '操作者', '操作', '對象', '詳情'], ['2026-01-01', '領袖', 'update', '1234567890', '原有操作紀錄']);
  seed('活動履歷', ['record_id', 'type', 'ymis', 'name', 'date', 'title', 'role', 'hours', 'cert_no', 'detail', 'recorder', 'recorded_at', 'updated_at'], ['LOG_OLD', 'service', '1234567890', '陳大文', '2024-01-01', '舊服務', '義工', '2', 'CERT', '舊內容', '舊領袖', '2024-01-02', '']);
  seed('待批履歷', ['request_id', 'kind', 'target_record_id', 'type', 'ymis', 'name', 'date', 'title', 'role', 'hours', 'cert_no', 'detail', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'review_note'], ['LOGREQ-1', 'new', '', 'service', '1234567890', '陳大文', '2024-01-01', '舊申報', '義工', '2', '', '舊詳情', 'approved', '2024-01-01', '舊領袖', '2024-01-02', '']);
  seed('SystemConfig', ['key', 'value', 'updated_at', 'updated_by'], ['custom_setting', 'keep-me', '2026-01-01', 'keep-actor']);

  const preservedSheetNames = ['進度追蹤', '成員名單', 'Users', 'Applications', 'Tokens', '待批完成', '其他獎章', '操作紀錄', '活動履歷', '待批履歷'];
  const originalRows = snapshotRows(node, preservedSheetNames);
  const originalCustomConfig = ss.getSheetByName('SystemConfig')._rows[1].slice();

  const post = body => context.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } });

  // 未初始化（淨貼新 Code.gs）：仲係「已更新但未初始化」，唔可以當完成
  const badKey = post({ action: 'ecStatus', apikey: 'wrong' });
  assert.equal(badKey.success, false, 'ecStatus 要驗 API Key');
  const before = post({ action: 'ecStatus', apikey: 'test-api-key-keep-me' });
  assert.equal(before.success, true);
  assert.equal(before.gsVersion, 'v9.1', '程式版本即時反映新 Code.gs');
  assert.equal(before.initializedGsVersion, '', '淨貼新 Code.gs 唔會當已初始化');
  assert.equal(before.gsInitializationCurrent, false);

  const init1 = context.initializeSheets();
  assert.equal(init1.success, true);
  assert.equal(init1.gsVersion, 'v9.1');
  assert.equal(init1.initializedGsVersion, 'v9.1');
  assert.equal(init1.gsInitializationCurrent, true);
  assert.equal(props.get('API_KEY'), 'test-api-key-keep-me', '初始化唔得更換現有 API Key');
  assert.deepEqual(snapshotRows(node, preservedSheetNames), originalRows, '初始化唔准修改、刪除、覆寫、重置、重新編號或遷移任何現有用戶資料');
  assert.deepEqual(ss.getSheetByName('SystemConfig')._rows[1], originalCustomConfig, '已有旅團設定唔准被預設值覆寫');
  const cfgKeysAfterInit1 = ss.getSheetByName('SystemConfig')._rows.slice(1).map(r => r[0]);
  assert.equal(cfgKeysAfterInit1.filter(k => k === 'allow_member_view_others').length, 1, '缺失設定只補一次預設值');
  const appendedDefault = ss.getSheetByName('SystemConfig')._rows.find(r => r[0] === 'allow_member_view_others');
  assert.equal(appendedDefault[1], 'false', '補建嘅預設值');

  const after = post({ action: 'ecStatus', apikey: 'test-api-key-keep-me' });
  assert.equal(after.gsVersion, 'v9.1');
  assert.equal(after.initializedGsVersion, 'v9.1');
  assert.equal(after.gsInitializationCurrent, true, '呢個組合先係綠色「已核對」');

  const load = context.handleLoad();
  assert.equal(load.success, true);
  assert.equal(load.gsVersion, 'v9.1', '登入後 load 都要回報 GS 程式版本');
  assert.equal(load.initializedGsVersion, 'v9.1', '登入後 load 都要回報初始化版本');
  assert.equal(load.gsInitializationCurrent, true);

  // 重複初始化：安全、idempotent、資料同 API Key 原封不動
  const init2 = context.initializeSheets();
  assert.equal(init2.success, true);
  assert.equal(props.get('API_KEY'), 'test-api-key-keep-me', '重複初始化都唔得更換 API Key');
  assert.deepEqual(snapshotRows(node, preservedSheetNames), originalRows, '重複初始化照樣保留全部現有值');
  assert.deepEqual(ss.getSheetByName('SystemConfig')._rows[1], originalCustomConfig);
  assert.equal(ss.getSheetByName('SystemConfig')._rows.slice(1).filter(r => r[0] === 'allow_member_view_others').length, 1, '預設值唔會因重複初始化而重複');
});

test('Proxy 放行 ecStatus 並喺伺服器端注入 API Key（瀏覽器永遠見唔到 Key）', async () => {
  process.env.TROOP_0082_NAME = '第 82 旅 <測試>';
  process.env.TROOP_0082_BACKEND = 'https://script.google.com/macros/s/TEST_DEPLOYMENT_0082/exec';
  process.env.TROOP_0082_APIKEY = 'secret-api-key';
  const res = { headers: {}, code: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } };
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, init }; return { status: 200, text: async () => JSON.stringify({ success: true, gsVersion: 'v9.1', initializedGsVersion: 'v9.1', gsInitializationCurrent: true }) }; };
  try {
    await proxy({ method: 'POST', body: { troopId: '0082', action: 'ecStatus', data: {} } }, res);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(res.code, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.gsVersion, 'v9.1');
  assert.equal(res.body.gsInitializationCurrent, true);
  const forwarded = JSON.parse(sent.init.body);
  assert.equal(forwarded.action, 'ecStatus');
  assert.equal(forwarded.apikey, 'secret-api-key', 'API Key 由伺服器端注入');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
