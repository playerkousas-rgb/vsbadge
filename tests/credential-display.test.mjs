// 接入資料只准顯示 API Key，絕不顯示自動取得／推算／快取的部署 URL。
// 用戶流程固定：初始化生成／保留 API Key → 在 Google 部署視窗取得 URL →
// 自己在原有 ADMIN FORM 填旅團編號、名稱、URL 和 API Key。
// 不要求預先設定旅團編號，亦不新增把 URL 貼入 GS 的設定步驟。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { normalizeGasUrl, isTrustedExecUrl, getTrustedTroop, listPublicTroops } from '../api/_registry.js';

const GAS_SOURCE = fs.readFileSync('apps-script/Code.gs', 'utf8');
const FALSE_URLS = [
  'https://script.google.com/macros/s/WRONG_INITIALIZER_NODE/exec',
  'https://script.google.com/a/example.org/macros/s/WRONG_MENU_NODE/exec',
  'https://script.google.com/macros/s/WRONG_CACHED_NODE/exec'
];
const KEY = 'vs_display_test_0123456789abcdef';

// ---- in-memory SpreadsheetApp（同 release-version 守護測試同款做法）----
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

function setup({ fresh = false } = {}) {
  const ss = makeSpreadsheet('credential-test');
  const props = new Map();
  if (!fresh) {
    props.set('API_KEY', KEY);
    // 舊版可能留下的快取／設定：原樣保留，但絕不准攞嚟顯示
    props.set('WEBAPP_URL', FALSE_URLS[2]);
    props.set('BACKEND_EXEC_URL', FALSE_URLS[0]);
    props.set('WEBAPP_URL_VERIFIED', 'true');
    props.set('TROOP_ID', '0082');
    props.set('TROOP_NAME', '第 82 旅');
  }
  const alerts = [], logs = [], items = [], prompts = [];
  const calls = { getUrl: 0, fetch: 0 };
  const state = { ss, serviceThrows: false };
  const scriptProps = {
    getProperty: k => (props.has(String(k)) ? props.get(String(k)) : null),
    setProperty: (k, v) => { props.set(String(k), String(v)); },
    deleteProperty: k => { props.delete(String(k)); },
    getProperties: () => Object.fromEntries(props)
  };
  const ui = {
    Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' },
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
    alert(...args) { alerts.push(args); return 'OK'; },
    prompt(...args) {
      prompts.push(args);
      return { getSelectedButton: () => 'CANCEL', getResponseText: () => '' };
    },
    createMenu(title) {
      const menu = {
        addItem(label, handler) { items.push({ title, label, handler }); return menu; },
        addSeparator() { return menu; },
        addSubMenu() { return menu; },
        addToUi() { return menu; }
      };
      return menu;
    }
  };
  state.ui = ui;
  const cacheStore = new Map();
  const context = vm.createContext({
    Logger: { log: message => logs.push(String(message)) },
    PropertiesService: { getScriptProperties: () => scriptProps },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cacheStore.has(k) ? cacheStore.get(k) : null),
        put: (k, v) => { cacheStore.set(k, v); },
        remove: k => { cacheStore.delete(k); }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {} }) },
    ScriptApp: {
      getService: () => ({
        getUrl() {
          const value = FALSE_URLS[calls.getUrl % FALSE_URLS.length];
          calls.getUrl++;
          if (state.serviceThrows) throw new Error('No service context');
          return value;
        }
      })
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => state.ss, getUi: () => state.ui },
    Utilities: {
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algo, value) => Array.from(createHash('sha256').update(String(value), 'utf8').digest()),
      computeHmacSha256Signature: (message, key) => Array.from(createHmac('sha256', String(key)).update(String(message), 'utf8').digest()),
      formatDate: formatDateStub
    },
    DriveApp: { getRootFolder: () => ({ createFile: () => { throw new Error('test should not export'); } }) },
    UrlFetchApp: { fetch: () => { calls.fetch++; throw new Error('顯示功能絕不准探測任何 URL'); } },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ setMimeType: () => ({ getContent: () => text }) }) }
  });
  vm.runInContext(GAS_SOURCE, context);
  context.jsonResponse = obj => obj; // 測試直接取回應物件（同 release-version 做法）
  return { backend: context, ss, props, scriptProps, alerts, logs, items, prompts, calls, state };
}

function assertNoDeploymentUrl(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const url of FALSE_URLS) assert.ok(!text.includes(url), `絕不准顯示 ${url}`);
  assert.doesNotMatch(text, /https?:\/\//, '接入資料顯示絕不准包含任何 URL 值');
  assert.doesNotMatch(text, /_BACKEND\s*=|已核實|ID 長度|56 字元|74 字元/);
}

test('initializeSheets 彈窗及執行回傳只提供現有 API Key，三個不同 Google 回報 URL 加舊快取都唔洩出', () => {
  const { backend, alerts, logs, calls, prompts, scriptProps } = setup();
  const result = backend.initializeSheets();
  assert.equal(result.success, true);
  assert.equal(result.apiKey, KEY, '沿用現有 API Key，唔會更換');
  assert.equal(Object.hasOwn(result, 'scriptUrl'), false, '回傳值唔准帶推算的 scriptUrl');
  assert.equal(Object.hasOwn(result, 'backend'), false, '回傳值唔准帶 backend');
  assert.ok(alerts.length > 0, '要測真彈窗，唔係淨測 helper');
  const alertText = JSON.stringify(alerts);
  assert.match(alertText, /初始化完成/);
  assert.ok(alertText.includes('API Key = ' + KEY), '領袖即場讀到統一格式的 API Key');
  // 深資原有首次登入提示必須保留
  assert.match(alertText, /管理員 YMIS: 1111111111/);
  assert.match(alertText, /首次登入必須更改/);
  assert.match(alertText, /密碼最短 4 位/);
  assert.match(alertText, /ADMIN FORM/);
  assertNoDeploymentUrl(alerts);
  assertNoDeploymentUrl(result);
  assertNoDeploymentUrl(logs);
  assert.deepEqual(calls, { getUrl: 0, fetch: 0 }, '顯示路徑絕不讀取 Google service URL，亦不發任何請求');
  assert.equal(prompts.length, 0, '初始化唔准提示輸入旅團編號／名稱／URL');
  assert.equal(scriptProps.getProperty('WEBAPP_URL'), FALSE_URLS[2], '舊快取原樣保留，只是唔再攞嚟顯示');
});

test('全部接入顯示入口（vercelEnvLines／showVercelEnv／showApiKey／旅系統選單）只提供同一隻 API Key', () => {
  const { backend, alerts, logs, calls, prompts } = setup();
  const lines = backend.vercelEnvLines();
  assert.deepEqual(Array.from(lines), ['API Key = ' + KEY]);
  const shown = backend.showVercelEnv();
  assert.deepEqual(Array.from(shown), Array.from(lines));
  assert.equal(backend.showApiKey(), KEY, '保留 showApiKey 既有回傳值契約');
  const menuText = backend.menuShowLinkCredentials();
  assert.ok(menuText.includes('API Key = ' + KEY));
  assert.ok(menuText.includes('Google「部署 → 管理部署」'));
  assert.ok(menuText.includes('ADMIN FORM'));
  assert.doesNotMatch(JSON.stringify([menuText, alerts, logs]), /TROOP_<|未設定旅團編號|TROOP_\S*_APIKEY\s*=/,
    '唔准出現未設定編號警告或佔位功能變數名');
  for (const value of [lines, shown, menuText, alerts, logs]) assertNoDeploymentUrl(value);
  assert.deepEqual(calls, { getUrl: 0, fetch: 0 });
  assert.equal(prompts.length, 0, '絕不准叫領袖貼 URL 或設定 BACKEND');
});

test('Google URL 讀取及網路同時失敗，顯示功能照常運作（證明根本冇依賴佢哋）', () => {
  const { backend, alerts, calls, state } = setup();
  state.serviceThrows = true;
  assert.doesNotThrow(() => backend.initializeSheets());
  assert.equal(backend.showApiKey(), KEY);
  assert.doesNotThrow(() => backend.showVercelEnv());
  assert.doesNotThrow(() => backend.menuShowLinkCredentials());
  assertNoDeploymentUrl(alerts);
  assert.deepEqual(calls, { getUrl: 0, fetch: 0 });
});

test('舊 URL 快取／旅團設定屬性原樣保留，永遠唔會變成顯示出嚟嘅部署資料；唔存在貼 URL 設定入口', () => {
  const { backend, alerts, calls, scriptProps } = setup();
  backend.initializeSheets();
  backend.showApiKey();
  backend.showVercelEnv();
  backend.menuShowLinkCredentials();
  assertNoDeploymentUrl(alerts);
  assert.equal(scriptProps.getProperty('WEBAPP_URL'), FALSE_URLS[2]);
  assert.equal(scriptProps.getProperty('BACKEND_EXEC_URL'), FALSE_URLS[0]);
  assert.equal(scriptProps.getProperty('WEBAPP_URL_VERIFIED'), 'true');
  assert.equal(scriptProps.getProperty('TROOP_ID'), '0082', '既有屬性唔准因今次 UI 修正被刪改');
  assert.equal(scriptProps.getProperty('TROOP_NAME'), '第 82 旅');
  for (const name of ['getScriptUrl', 'resolveBackendUrl', 'rememberWebAppUrlFromRequest', 'setBackendUrl', 'menuSetBackendUrl', 'selfUrlPayload', 'looksLikeHeadDeployment']) {
    assert.equal(typeof backend[name], 'undefined', `唔准存在 ${name}`);
  }
  assert.deepEqual(calls, { getUrl: 0, fetch: 0 });
});

test('普通 HTTP 請求唔會發現、儲存或回傳自報的 backend URL；唔存在 selfUrl 自我核實入口', () => {
  const { backend, calls, scriptProps } = setup();
  const before = { ...scriptProps.getProperties() };
  const get = backend.doGet({ parameter: { action: 'getLoginMode', backend: FALSE_URLS[0] } });
  assert.equal(get.success, true);
  const post = backend.doPost({
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'ecStatus', apikey: KEY, backend: FALSE_URLS[1] }) }
  });
  assert.equal(post.success, true);
  assert.equal(post.gsVersion, 'v9.2');
  for (const apikey of ['', 'wrong', KEY]) {
    const self = backend.doGet({ parameter: { action: 'selfUrl', apikey } });
    assert.equal(self.success, false, 'selfUrl 循環自我核實入口唔准存在');
    assert.equal(Object.hasOwn(self, 'scriptUrl'), false);
    assertNoDeploymentUrl(self);
  }
  assert.deepEqual({ ...scriptProps.getProperties() }, before, '普通請求唔准改寫任何 Script Properties（包括舊 URL 快取）');
  assert.deepEqual(calls, { getUrl: 0, fetch: 0 });
});

test('旅系統選單改稱「顯示 API KEY」，冇自動驗證／手動設定 BACKEND 或旅團編號嘅選單', () => {
  const { backend, items } = setup();
  backend.onOpen();
  const credentials = items.find(item => item.handler === 'menuShowLinkCredentials');
  assert.ok(credentials, '保留既有 handler，舊選單綁定繼續有效');
  assert.equal(credentials.label, '🔑 顯示 API KEY（交 ADMIN）');
  assert.ok(!items.some(item => /顯示 BACKEND|驗證 BACKEND|設定 BACKEND/.test(item.label)));
  assert.ok(!items.some(item => /SetBackend|VerifyBackend/.test(item.handler)));
  assert.ok(!items.some(item => /設定旅團編號/.test(item.label)), '旅團編號喺 ADMIN FORM 填，唔加 GS 設定選單');
});

test('重複初始化及查看 Key：API Key、業務資料、既有屬性全部原封不動', () => {
  const { backend, ss, alerts, scriptProps } = setup();
  backend.initializeSheets();
  ss.getSheetByName('成員名單')._rows.push(['1234567890', '陳大文', '2025-01-01', '深資童軍', '舊聯絡']);
  ss.getSheetByName('進度追蹤')._rows.push(['1234567890', 'OLD-ID-01', '2025-01-01', '2025-01-02', '舊領袖', '保留備註']);
  ss.getSheetByName('其他獎章')._rows.push(['1234567890', 'ACT-07', '游泳章', '2024-01-01', 'CERT-OLD', '舊徽章備註', '2024-01-02']);
  const snapshotSheets = () => JSON.stringify(Object.fromEntries(Array.from(ss._sheets.entries()).map(([name, sheet]) => [name, sheet._rows])));
  const sheetsBefore = snapshotSheets();
  const propsBefore = { ...scriptProps.getProperties() };
  backend.initializeSheets();
  backend.initializeSheets();
  backend.showApiKey();
  backend.showVercelEnv();
  backend.menuShowLinkCredentials();
  assert.equal(backend.getApiKey(), KEY);
  assert.deepEqual({ ...scriptProps.getProperties() }, propsBefore);
  assert.equal(snapshotSheets(), sheetsBefore, '重跑初始化唔准改寫、刪除或重新編號任何業務資料');
  assertNoDeploymentUrl(alerts);
});

test('全新安裝：冇旅團編號／名稱／Key 亦可直接初始化生成 API Key，冇任何設定提示', () => {
  const { backend, alerts, prompts, calls, scriptProps } = setup({ fresh: true });
  const result = backend.initializeSheets();
  assert.equal(result.success, true);
  assert.match(result.apiKey, /^vs_[0-9a-f]{24}$/, 'Key 不存在先生成（沿用深資既有格式）');
  assert.equal(Object.hasOwn(result, 'scriptUrl'), false);
  assert.equal(scriptProps.getProperty('TROOP_ID'), null, '唔准推斷或新增本機旅團編號設定');
  assert.equal(scriptProps.getProperty('TROOP_NAME'), null);
  assert.equal(prompts.length, 0, '初始化唔准問編號、名稱或 URL');
  const alertText = JSON.stringify(alerts);
  assert.ok(alertText.includes('API Key = ' + result.apiKey));
  assert.match(alertText, /ADMIN FORM/);
  assert.doesNotMatch(alertText, /TROOP_<|未設定旅團編號/);
  assertNoDeploymentUrl(alerts);
  assert.deepEqual(calls, { getUrl: 0, fetch: 0 });

  const generated = result.apiKey;
  backend.showApiKey();
  backend.showVercelEnv();
  backend.menuShowLinkCredentials();
  backend.initializeSheets();
  assert.equal(backend.getApiKey(), generated, '其後查看及重跑初始化沿用同一隻 Key');
  assert.equal(prompts.length, 0);
  assert.equal(scriptProps.getProperty('TROOP_ID'), null);
});

test('未初始化、冇旅團編號時由選單查看 Key 亦可即時生成，同樣冇任何設定提示', () => {
  const { backend, prompts, calls, scriptProps } = setup({ fresh: true });
  const text = backend.menuShowLinkCredentials();
  const key = scriptProps.getProperty('API_KEY');
  assert.match(key, /^vs_[0-9a-f]{24}$/);
  assert.ok(text.includes('API Key = ' + key));
  assert.match(text, /ADMIN FORM/);
  assert.doesNotMatch(text, /TROOP_<|未設定旅團編號/);
  assertNoDeploymentUrl(text);
  assert.equal(prompts.length, 0);
  assert.equal(scriptProps.getProperty('TROOP_ID'), null);
  assert.deepEqual(calls, { getUrl: 0, fetch: 0 });
});

test('冇試算表 context 時 showApiKey 仍然回傳 Key（唔需要 Sheet、唔探測 URL）', () => {
  const { backend, logs, calls, state } = setup();
  state.ss = null;
  assert.equal(backend.showApiKey(), KEY);
  assertNoDeploymentUrl(logs);
  assert.deepEqual(calls, { getUrl: 0, fetch: 0 });
});

test('前端中英部署說明唔再承諾自動核實網址，亦冇新增貼 URL 設定步驟', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /GS 彈窗及選單只提供 API Key/);
  assert.match(html, /dialogs and menus provide only the API Key/);
  assert.match(html, /旅團編號直接在 ADMIN FORM 填寫/);
  assert.match(html, /Enter the Group number directly in the ADMIN FORM/);
  assert.match(html, /Google 部署視窗/);
  assert.doesNotMatch(html, /GS 會自動記低正確網址|script then remembers the correct URL|開一次 \/exec 就記啱/);
  assert.doesNotMatch(GAS_SOURCE, /function (?:setBackendUrl|menuSetBackendUrl|rememberWebAppUrlFromRequest|selfUrlPayload|looksLikeHeadDeployment)\s*\(/);
  assert.doesNotMatch(GAS_SOURCE, /WEBAPP_URL_PROP|URL_MISMATCH_WARNING/);
  assert.doesNotMatch(GAS_SOURCE, /顯示 BACKEND／APIKEY/);
});

test('Workspace 網域內 URL 只轉成相同部署 ID 的公開路徑；正規化不得放寬白名單', () => {
  const id = 'AKfycbWorkspaceNode01';
  const workspace = `https://script.google.com/a/scouting.example.hk/macros/s/${id}/exec`;
  const pub = `https://script.google.com/macros/s/${id}/exec`;
  assert.equal(normalizeGasUrl(workspace), pub);
  assert.equal(normalizeGasUrl(pub), pub, '公開網址原樣');
  assert.equal(normalizeGasUrl(''), '');
  assert.equal(normalizeGasUrl('not a url'), 'not a url', '非 URL 原樣交回白名單處理');

  assert.equal(isTrustedExecUrl(pub), true);
  assert.equal(isTrustedExecUrl(workspace), true, 'Workspace 格式經正規化後可信');
  const invalid = [
    `http://script.google.com/macros/s/${id}/exec`,
    `http://script.google.com/a/scouting.example.hk/macros/s/${id}/exec`,
    `https://script.google.com/macros/s/${id}/dev`,
    `https://script.google.com/a/scouting.example.hk/macros/s/${id}/dev`,
    `https://script.google.com/macros/s/${id}/exec?x=1`,
    `https://script.google.com/a/scouting.example.hk/macros/s/${id}/exec?x=1`,
    `https://script.google.com/a/scouting.example.hk/macros/s/${id}/exec#section`,
    `https://user:pass@script.google.com/a/scouting.example.hk/macros/s/${id}/exec`,
    `https://user:pass@script.google.com/macros/s/${id}/exec`,
    `https://script.google.com:8443/a/scouting.example.hk/macros/s/${id}/exec`,
    `https://script.google.com:8443/macros/s/${id}/exec`,
    `https://evil.example/macros/s/${id}/exec`,
    'https://script.google.com/macros/s/short/exec',
    'https://script.google.com/a/scouting.example.hk/macros/s/short/exec'
  ];
  for (const bad of invalid) {
    assert.equal(isTrustedExecUrl(bad), false, `正規化不得接受：${bad}`);
  }

  // Registry 讀取 env 時實際連線目標是公開格式，前端公開清單仍不洩 URL／Key
  process.env.TROOP_7777_NAME = '測試旅';
  process.env.TROOP_7777_BACKEND = workspace;
  process.env.TROOP_7777_APIKEY = 'ws-secret-key';
  try {
    const troop = getTrustedTroop('7777');
    assert.ok(troop);
    assert.equal(troop.backend, pub);
    const list = listPublicTroops();
    assert.equal(list['7777'].name, '測試旅');
    assert.ok(!JSON.stringify(list).includes('script.google'));
    assert.ok(!JSON.stringify(list).includes('ws-secret-key'));
  } finally {
    delete process.env.TROOP_7777_NAME;
    delete process.env.TROOP_7777_BACKEND;
    delete process.env.TROOP_7777_APIKEY;
  }
});
