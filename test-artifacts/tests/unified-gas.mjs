#!/usr/bin/env node
/* Isolated unified GS contract tests.  No deployment or network access. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { unifiedGasTemplate, UNIFIED_GAS_SHA256 } from '../assets/js/lib/unifiedtemplate.generated.js';

const SOURCE = fs.readFileSync(new URL('../apps-script/UnifiedCode.gs', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../apps-script/unified-src/manifest.json', import.meta.url), 'utf8'));
let passed = 0;
function ok(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

function signedBytes(buffer) { return Array.from(buffer, b => b > 127 ? b - 256 : b); }
function bytes(value) {
  if (Array.isArray(value)) return Buffer.from(value.map(v => v & 255));
  return Buffer.from(String(value ?? ''), 'utf8');
}

function makeSheet(name, initial = []) {
  const rows = initial.map(r => Array.from(r));
  const formats = new Map();
  const setCell = (r, c, value) => {
    while (rows.length < r) rows.push([]);
    while (rows[r - 1].length < c) rows[r - 1].push('');
    rows[r - 1][c - 1] = value;
  };
  const cell = (r, c) => (rows[r - 1] && rows[r - 1][c - 1] !== undefined ? rows[r - 1][c - 1] : '');
  function range(r, c, nr = 1, nc = 1) {
    const api = {
      getValue: () => cell(r, c),
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
      setValue(value) { setCell(r, c, value); return api; },
      setValues(values) { values.forEach((line, i) => line.forEach((value, j) => setCell(r + i, c + j, value))); return api; },
      setFontWeight: () => api, setBackground: () => api, setFontColor: () => api,
      setWrap: () => api, setHorizontalAlignment: () => api, setFontSize: () => api,
      setBorder: () => api, setFontFamily: () => api,
      setNumberFormat(fmt) {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) formats.set(`${r + i}:${c + j}`, fmt);
        return api;
      },
      clearContent() {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) setCell(r + i, c + j, '');
        return api;
      }
    };
    return api;
  }
  const sheet = {
    _rows: rows,
    getName: () => name,
    appendRow(values) { rows.push(Array.from(values)); return sheet; },
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => range(1, 1, Math.max(rows.length, 1), Math.max(sheet.getLastColumn(), 1)),
    getRange: (r, c, nr, nc) => range(r, c, nr || 1, nc || 1),
    deleteRow(row) { rows.splice(row - 1, 1); },
    deleteRows(row, count) { rows.splice(row - 1, count); },
    clear() { rows.length = 0; return sheet; },
    clearContents() { rows.length = 0; return sheet; },
    setFrozenRows: () => sheet, setColumnWidth: () => sheet, autoResizeColumn: () => sheet,
    hideSheet: () => sheet, showSheet: () => sheet, setTabColor: () => sheet,
    getFilter: () => null, getSheetId: () => 1
  };
  return sheet;
}

function makeNode() {
  const sheets = new Map();
  const props = new Map([
    ['API_KEY', 'existing-api-key-do-not-change']
  ]);
  const cache = new Map();
  const cacheWrites = [];
  const mail = [];
  const lockStats = { waits: 0, releases: 0 };
  const spreadsheet = {
    getName: () => 'Unified test branch sheet', getId: () => 'unified-test-sheet',
    getSheetByName: name => sheets.get(name) || null,
    insertSheet(name) { const sheet = makeSheet(name); sheets.set(name, sheet); return sheet; },
    getSheets: () => [...sheets.values()], deleteSheet: sheet => sheets.delete(sheet.getName()),
    setSpreadsheetTimeZone: () => spreadsheet, getSpreadsheetTimeZone: () => 'Asia/Hong_Kong'
  };
  const scriptProps = {
    getProperty: key => (props.has(String(key)) ? props.get(String(key)) : null),
    setProperty: (key, value) => { props.set(String(key), String(value)); },
    deleteProperty: key => { props.delete(String(key)); },
    getProperties: () => Object.fromEntries(props)
  };
  let uuidCounter = 0;
  const content = text => ({
    _text: String(text), setMimeType() { return this; }, getContent() { return this._text; }
  });
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, getUi: () => null, flush: () => {} },
    PropertiesService: { getScriptProperties: () => scriptProps },
    CacheService: { getScriptCache: () => ({
      get: key => cache.get(String(key)) || null,
      put: (key, value, ttl) => {
        cache.set(String(key), String(value));
        cacheWrites.push({ key: String(key), value: String(value), ttl: Number(ttl || 0) });
      },
      remove: key => cache.delete(String(key))
    }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { lockStats.waits++; return true; },
      waitLock: () => { lockStats.waits++; return true; },
      releaseLock: () => { lockStats.releases++; }
    }) },
    Utilities: {
      getUuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => signedBytes(crypto.createHash('sha256').update(bytes(value)).digest()),
      computeHmacSha256Signature: (value, key) => signedBytes(crypto.createHmac('sha256', bytes(key)).update(bytes(value)).digest()),
      base64EncodeWebSafe: value => bytes(value).toString('base64url'),
      base64DecodeWebSafe: value => signedBytes(Buffer.from(String(value), 'base64url')),
      base64Encode: value => bytes(value).toString('base64'),
      base64Decode: value => signedBytes(Buffer.from(String(value), 'base64')),
      newBlob: value => ({
        getBytes: () => signedBytes(bytes(value)),
        getDataAsString: () => bytes(value).toString('utf8'),
        setName() { return this; }
      }),
      formatDate: value => new Date(value).toISOString().replace('T', ' ').slice(0, 19),
      sleep: () => {}
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: content },
    Logger: { log: () => {} },
    MailApp: { sendEmail: (...args) => { mail.push(args); } },
    Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.test' }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/UNIFIED_TEST_123/exec' }) },
    DriveApp: {
      getRootFolder: () => ({ createFile: () => ({ getId: () => 'file', getUrl: () => 'https://drive.test/file' }) }),
      getFileById: () => ({ getParents: () => ({ hasNext: () => false }), getBlob: () => ({ getDataAsString: () => '{}' }) })
    },
    UrlFetchApp: { fetch: () => { throw new Error('network disabled in unified test'); } },
    console, JSON, Date, Math, String, Number, Object, Array, Boolean,
    isFinite, isNaN, parseInt, parseFloat, RegExp, Error, encodeURIComponent, decodeURIComponent
  });
  vm.runInContext(SOURCE, context, { filename: 'UnifiedCode.gs' });
  function post(body, parameter = {}) {
    const out = context.doPost({ parameter, postData: { contents: JSON.stringify(body) } });
    return JSON.parse(out.getContent());
  }
  return { context, post, props, sheets, spreadsheet, cache, cacheWrites, mail, lockStats };
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function ssoToken(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function exchangeToken(payload, apiKey = 'existing-api-key-do-not-change') {
  const key = crypto.createHmac('sha256', apiKey).update('vs-portal-branch-exchange-v1').digest('hex');
  return ssoToken(key, payload);
}
function assertion(unit, subject, role, name, scopes = null) {
  const now = Date.now();
  return exchangeToken({
    typ: 'central-sso-exchange', u: unit, sub: subject, role, name,
    scope: scopes || ['identity:read', 'branch:read', ...(role === 'member' ? [] : ['branch:write']),
      ...(['leader', 'chief', 'admin'].includes(role) ? ['branch:repair', 'identity:manage'] : [])],
    src: 'central-travel-system', iss: 'vs-portal', aud: `unified-gas:branch:${unit}`,
    iat: now, exp: now + 60_000, jti: crypto.randomUUID()
  });
}
function signedRequest(action, payload, key = 'existing-api-key-do-not-change') {
  const signKey = crypto.createHmac('sha256', key).update('vsbadge-troop-sig-v1').digest('hex');
  const make = (raw) => {
    const ts = String(Date.now());
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const digest = sha256(raw);
    const canonical = [action, ts, nonce, digest].join('\n');
    return { sig: crypto.createHmac('sha256', signKey).update(canonical).digest('hex'), ts, nonce };
  };
  const unsigned = { action, ...payload };
  const inner = make(JSON.stringify(unsigned));
  const body = { ...unsigned, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
  const outer = make(JSON.stringify(body));
  return { body, parameter: { sig: outer.sig, sts: outer.ts, snonce: outer.nonce } };
}

console.log('\nUnified GS');
ok('generated contract module is byte-for-byte the UnifiedCode.gs artifact', unifiedGasTemplate() === SOURCE);
ok('generated contract module records the artifact SHA-256', UNIFIED_GAS_SHA256 === sha256(SOURCE));
ok('artifact is explicitly isolated-test-only and not deployed', MANIFEST.releaseChannel === 'isolated-test-only'
  && SOURCE.includes('Release channel: isolated test only; copied here for integration review; not deployed.'));
ok('composed artifact contains no legacy PORTAL_SESSION_SECRET dependency', !SOURCE.includes('PORTAL_SESSION_SECRET'));
ok('build includes exact pinned vsbadge commit provenance', SOURCE.includes(MANIFEST.baseline.commit));
ok('generated artifact declares complete backend with full-featured and lightweight frontends',
  SOURCE.includes('complete Unified branch backend')
    && SOURCE.includes('vs_portal is the full-featured frontend')
    && SOURCE.includes('vsbadge is the lightweight frontend'));
ok('generated architecture keeps client surface separate from server authorization',
  SOURCE.includes('Client surface never replaces server authorization')
    && SOURCE.includes('complete branch capability superset')
    && SOURCE.includes('not a second reduced GS')
    && SOURCE.includes('allowed action')
    && SOURCE.includes('session, role, and scope authorization'));
ok('vsbadge v9.6 baseline is still present', SOURCE.includes("const VS_GS_VERSION = 'v9.6';"));
ok('legacy Portal is namespaced instead of shadowing baseline globals', SOURCE.includes('var PortalAdminCompat_ = (function () {'));
ok('generated pinned menu labels branch local login as required', SOURCE.includes(".addItem('ℹ️ 支部本地登入必須保持開啟','menuLocalLoginOff')"));
const activeMenuSource = SOURCE.slice(SOURCE.lastIndexOf('function onOpen()'), SOURCE.lastIndexOf('function doGet(e)'));
ok('active Sheet menu exposes only branch-safe controls',
  activeMenuSource.includes("createMenu('🔗 支部系統')")
    && activeMenuSource.includes("'menuLocalLoginOn'")
    && !activeMenuSource.includes('menuLocalLoginOff')
    && !activeMenuSource.includes('menuRegisterDownstream')
    && !activeMenuSource.includes('badgeOnOpen_'));
ok('unfinished legacy authChangePassword is not an exposed compatibility route', !/PortalAdminCompat_\.authChangePassword/.test(SOURCE));

const node = makeNode();
const USER_HEADERS = ['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','force_change_password'];
node.sheets.set('Users', makeSheet('Users', [
  USER_HEADERS,
  ['1111111111', '既有管理員', 'admin@example.com', 'admin', sha256('changeme'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', true]
]));
node.sheets.set('進度追蹤', makeSheet('進度追蹤', [
  ['YMIS','項目 ID','完成日期','更新時間','確認者','備註'],
  ['9000000001', 'L1-KEEP', '2026-01-01', '2026-01-01', 'leader', 'must survive']
]));
node.sheets.set('成員名單', makeSheet('成員名單', [
  ['YMIS','姓名','加入日期','支部','聯絡'],
  ['9000000001', '中央團員', '2025-01-01', 'VS', 'member@example.test'],
  ['9000000002', '中央領袖', '2025-01-01', 'VS', 'leader@example.test']
]));

const initialized = node.context.initializeSheets();
ok('combined initializer succeeds', initialized.success === true, JSON.stringify(initialized));
ok('initializer preserves existing API key', node.props.get('API_KEY') === 'existing-api-key-do-not-change');
ok('initializer does not create or require a separate PORTAL_SESSION_SECRET', !node.props.has('PORTAL_SESSION_SECRET'));
ok('initializer restores branch local login as the required normal entrance', node.props.get('ALLOW_LOCAL_LOGIN') === 'true');
ok('initializer preserves existing progress row', node.sheets.get('進度追蹤')._rows.some(r => r[1] === 'L1-KEEP' && r[5] === 'must survive'));
ok('initializer records isolated unified version', node.props.get('UNIFIED_GS_INITIALIZED_VERSION') === 'v9.6-u1-test');
ok('initializer adds administrative tabs without replacing progress baseline', node.sheets.has('資料表') && node.sheets.has('Users') && node.sheets.has('活動履歷'));

/* One action dispatcher reads the different Progress tabs from this same active Sheet. */
node.sheets.get('其他獎章').appendRow(['9000000001', 'OB-1', '急救章', '2026-02-01', 'CERT-1', '', '2026-02-01']);
node.sheets.get('待批完成').appendRow(['REQ-1', '9000000002', '中央領袖', 'L1-PENDING', '待批項目', '2026-02-02', '', 'pending', '2026-02-03']);
node.sheets.get('活動履歷').appendRow(['LOG-1', 'service', '9000000001', '中央團員', '2026-02-04', '社區服務', '組員', '2', '', '', 'leader', '2026-02-05', '2026-02-05']);
node.sheets.get('待批履歷').appendRow(['LOGREQ-1', 'new', '', 'service', '9000000002', '中央領袖', '2026-02-06', '待批服務', '組員', '1', '', '', 'pending', '2026-02-07', '', '', '']);
const unifiedLoadRequest = signedRequest('load', { unit: '0082' });
const unifiedLoad = node.post(unifiedLoadRequest.body, unifiedLoadRequest.parameter);
ok('one Unified load action returns normal members and progress from the same active Sheet',
  unifiedLoad.success === true
    && unifiedLoad.members.some(member => member.ymis === '9000000001')
    && unifiedLoad.progress['9000000001']?.['L1-KEEP']?.note === 'must survive',
  JSON.stringify(unifiedLoad));
ok('the same Unified load action reads each Progress tab instead of treating tabs as separate backends',
  unifiedLoad.otherBadges['9000000001']?.['OB-1']?.name === '急救章'
    && unifiedLoad.pendingRequests.some(request => request.request_id === 'REQ-1')
    && unifiedLoad.logs.some(log => log.record_id === 'LOG-1')
    && unifiedLoad.logRequests.some(request => request.request_id === 'LOGREQ-1'),
  JSON.stringify(unifiedLoad));

/* BOOK may submit import candidates, but requestComplete must stop in the pending tab.
   Only a real branch leader/admin review may turn that candidate into an official record. */
const bookImportRequest = signedRequest('requestComplete', {
  on_behalf: '9000000001', on_behalf_role: 'member', on_behalf_name: 'VSBOOK',
  items: [{ itemId: 'L1-BOOK-IMPORT', itemName: 'BOOK 匯入候選',
    requested_date: '2026-02-08', evidence: 'book-import-test' }]
});
const bookImport = node.post(bookImportRequest.body, bookImportRequest.parameter);
const bookPendingRow = node.sheets.get('待批完成')._rows.find(row => String(row[0]) === String(bookImport.request_id));
ok('BOOK import is accepted only as a pending candidate, not an official progress record',
  bookImport.success === true && bookPendingRow?.[7] === 'pending'
    && !node.sheets.get('進度追蹤')._rows.some(row => row[0] === '9000000001' && row[1] === 'L1-BOOK-IMPORT'),
  JSON.stringify(bookImport));
const bookReviewerYmis = '2222222222';
node.sheets.get('Users').appendRow([
  bookReviewerYmis, 'BOOK 匯入確認領袖', 'book-reviewer@example.test', 'branch_leader',
  sha256('bookleader9'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', false
]);
const bookReviewerLogin = node.post({ action: 'login', login_id: bookReviewerYmis, password: 'bookleader9' });
const bookReview = node.post({ action: 'reviewRequest', token: bookReviewerLogin.token,
  request_id: bookImport.request_id, decision: 'approved', review_note: '領袖確認 BOOK 匯入',
  confirmed_date: '2026-02-09' });
ok('BOOK import becomes official only after an authenticated branch leader review',
  bookReviewerLogin.success === true && bookReviewerLogin.user?.role === 'branch_leader'
    && bookReview.success === true
    && node.sheets.get('進度追蹤')._rows.some(row => row[0] === '9000000001'
      && row[1] === 'L1-BOOK-IMPORT' && row[2] === '2026-02-09'),
  JSON.stringify(bookReview));

/* Full frontend bulk approval is one signed action.  It may contain normal Progress
   and activity-log rows, but validates the complete selection before the first write. */
node.sheets.get('待批完成').appendRow([
  'REQ-BULK-1', '9000000001', '中央團員', 'L1-BULK', '批量進度', '2026-02-10', '', 'pending', '2026-02-10', '', '', '', ''
]);
const bulkReviewRequest = signedRequest('bulkReviewRequests', {
  unit: '0082', sessionToken: bookReviewerLogin.token,
  requests: [
    { kind: 'req', request_id: 'REQ-BULK-1' },
    { kind: 'log', request_id: 'LOGREQ-1' }
  ], decision: 'approved', confirmed_date: '2026-02-11'
});
const bulkReview = node.post(bulkReviewRequest.body, bulkReviewRequest.parameter);
ok('one signed bulkReviewRequests action approves mixed Progress and log selections',
  bulkReview.success === true && bulkReview.processed === 2
    && bulkReview.progressRequests === 1 && bulkReview.logRequests === 1,
  JSON.stringify(bulkReview));
ok('bulk approval writes both destinations and closes both pending rows',
  node.sheets.get('進度追蹤')._rows.some(row => row[0] === '9000000001'
    && row[1] === 'L1-BULK' && row[2] === '2026-02-11')
  && node.sheets.get('活動履歷')._rows.some(row => row[5] === '待批服務')
  && node.sheets.get('待批完成')._rows.find(row => row[0] === 'REQ-BULK-1')?.[7] === 'approved'
  && node.sheets.get('待批履歷')._rows.find(row => row[0] === 'LOGREQ-1')?.[12] === 'approved');
const emptyBulkRequest = signedRequest('bulkReviewRequests', {
  unit: '0082', sessionToken: bookReviewerLogin.token, requests: [], decision: 'approved'
});
const emptyBulk = node.post(emptyBulkRequest.body, emptyBulkRequest.parameter);
ok('bulk approval rejects an empty selection before writing',
  emptyBulk.success === false && emptyBulk.code === 'NO_SELECTION');
node.context.destroyToken(bookReviewerLogin.token);
const bookReviewerRow = node.sheets.get('Users')._rows.findIndex(row => row[0] === bookReviewerYmis);
if (bookReviewerRow >= 0) node.sheets.get('Users').deleteRow(bookReviewerRow + 1);

node.props.set('ALLOW_LOCAL_LOGIN', 'false');
const blockedToggleRequest = signedRequest('setLocalLogin', { allow: 'false' });
const blockedToggle = node.post(blockedToggleRequest.body, blockedToggleRequest.parameter);
ok('Unified public router rejects legacy entrance control and restores local login',
  blockedToggle.success === false && blockedToggle.code === 'BRANCH_LOCAL_LOGIN_REQUIRED'
    && node.props.get('ALLOW_LOCAL_LOGIN') === 'true', JSON.stringify(blockedToggle));
const blockedStateRequest = signedRequest('getLinkState', {});
const blockedState = node.post(blockedStateRequest.body, blockedStateRequest.parameter);
ok('Unified public router does not expose legacy entrance state',
  blockedState.success === false && blockedState.code === 'BRANCH_LOCAL_LOGIN_REQUIRED'
    && !Object.prototype.hasOwnProperty.call(blockedState, 'allow_local_login'), JSON.stringify(blockedState));

/* A header-only progress tab is a successful zero-record action result. */
const emptyProgressNode = makeNode();
const emptyInitialized = emptyProgressNode.context.initializeSheets();
emptyProgressNode.sheets.get('成員名單').appendRow(['9000000099', '空進度團員', '2026-01-01', 'VS', 'empty@example.test']);
const emptyLoadRequest = signedRequest('load', { unit: '0082' });
const emptyLoad = emptyProgressNode.post(emptyLoadRequest.body, emptyLoadRequest.parameter);
ok('header-only progress tab returns success, a normal member, and zero progress records',
  emptyInitialized.success === true && emptyLoad.success === true
    && emptyLoad.members.some(member => member.ymis === '9000000099')
    && Object.keys(emptyLoad.progress || {}).length === 0,
  JSON.stringify(emptyLoad));
ok('Progress load response contains business data only, not integration or entrance state',
  !Object.prototype.hasOwnProperty.call(emptyLoad, 'allow_local_login')
    && !Object.prototype.hasOwnProperty.call(emptyLoad, 'link_flag_set')
    && !Object.prototype.hasOwnProperty.call(emptyLoad, 'upstream_only'),
  JSON.stringify(emptyLoad));

const forgot = node.post({ action: 'authForgotPassword', unit: '0082', email: 'admin@example.com' });
const forgotMailBody = String(node.mail[0]?.[0]?.body || '');
const forgotCode = (/重設碼：(\d{8})/.exec(forgotMailBody) || [])[1] || '';
ok('unified forgot-password uses pinned baseline code flow and tells Portal to show code form',
  forgot.success === true && forgot.resetMode === 'code' && !!forgotCode, JSON.stringify(forgot));
const completedForgot = node.post({ action: 'authCompletePasswordReset', unit: '0082',
  email: 'admin@example.com', code: forgotCode, newPassword: 'changed99' });
ok('unified code completion resets baseline credential without exposing legacy Portal token flow',
  completedForgot.success === true && completedForgot.ok === true, JSON.stringify(completedForgot));
const completedForgotReplay = node.post({ action: 'authCompletePasswordReset', unit: '0082',
  email: 'admin@example.com', code: forgotCode, newPassword: 'changed98' });
ok('unified password-reset code is single-use', completedForgotReplay.success === false);

/* The full branch frontend account aliases write pinned BADGE Users directly; no
   Portal accounts/password collection is created. */
const accountAdmin = node.post({ action: 'authLogin', unit: '0082', username: 'admin@example.com', password: 'changed99' });
node.sheets.get('成員名單').appendRow(['9000000010', '支部直接開戶', '2026-02-12', 'VS', '']);
const openedAccounts = node.post({
  action: 'authOpenAccounts', unit: '0082', sessionToken: accountAdmin.sessionToken,
  users: [{ ymis: '9000000010', name: '支部直接開戶', role: 'member', password: '1234', branch: 'VS' }]
});
const openedUserRow = node.sheets.get('Users')._rows.find(row => String(row[0]) === '9000000010');
ok('branch leader/admin can directly open an account in pinned Unified Users',
  accountAdmin.success === true && openedAccounts.success === true && openedAccounts.created === 1
    && openedUserRow?.[11] === 'active' && openedUserRow?.[13] === true,
  JSON.stringify(openedAccounts));
const openedLogin = node.post({ action: 'authLogin', unit: '0082', username: '9000000010', password: '1234' });
ok('directly opened account immediately logs in through the normal branch authority',
  openedLogin.success === true && openedLogin.account?.ymis === '9000000010');
openedUserRow[3] = 'generic-platform-admin';
const foreignRoleLogin = node.post({ action: 'authLogin', unit: '0082', username: '9000000010', password: '1234' });
ok('unknown backend role fails closed instead of silently becoming member',
  foreignRoleLogin.success === false && foreignRoleLogin.code === 'ROLE_NOT_ALLOWED', JSON.stringify(foreignRoleLogin));
openedUserRow[3] = 'member';
const resetOpened = node.post({ action: 'authResetPassword', unit: '0082',
  sessionToken: accountAdmin.sessionToken, targetYmis: '9000000010', newPassword: '5678' });
ok('full frontend password reset delegates to pinned Users handler', resetOpened.success === true, JSON.stringify(resetOpened));
const disabledOpened = node.post({ action: 'authDeleteAccount', unit: '0082',
  sessionToken: accountAdmin.sessionToken, targetYmis: '9000000010' });
ok('full frontend account removal revokes login but preserves the Users/roster identity',
  disabledOpened.success === true
    && node.sheets.get('Users')._rows.find(row => String(row[0]) === '9000000010')?.[11] === 'inactive'
    && node.sheets.get('成員名單')._rows.some(row => String(row[0]) === '9000000010'),
  JSON.stringify(disabledOpened));
const restoredOpened = node.post({ action: 'authRestoreAccount', unit: '0082',
  sessionToken: accountAdmin.sessionToken, targetYmis: '9000000010', newPassword: '1234' });
ok('full frontend can restore the same Unified Users account with a new temporary password',
  restoredOpened.success === true
    && node.sheets.get('Users')._rows.find(row => String(row[0]) === '9000000010')?.[11] === 'active',
  JSON.stringify(restoredOpened));

const forgedServerSuper = node.post({ action: 'loadTables', unit: '0082', unified_super: true, on_behalf: 'sheep' });
ok('client cannot claim the platform-super server path without a valid branch signature',
  forgedServerSuper.success === false && forgedServerSuper.code === 'SESSION_REQUIRED');
const forgedInternalMarker = node.post({ action: 'loadTables', unit: '0082', __serverSigned: true });
ok('client-supplied compatibility marker is stripped before unified routing',
  forgedInternalMarker.success === false && forgedInternalMarker.code === 'SESSION_REQUIRED');
const serverReadRequest = signedRequest('loadTables', {
  unit: '0082', apiKey: 'existing-api-key-do-not-change', unified_super: true, on_behalf: 'sheep'
});
const serverRead = node.post(serverReadRequest.body, serverReadRequest.parameter);
ok('platform super server signature reaches Portal administrative compatibility routes',
  serverRead.success === true && serverRead.unifiedGsVersion === 'v9.6-u1-test', JSON.stringify(serverRead));
const replayedServerRead = node.post(serverReadRequest.body, serverReadRequest.parameter);
ok('platform super server signature rejects nonce replay', replayedServerRead.success === false);
const largeServerReadRequest = signedRequest('loadTables', {
  unit: '0082', apiKey: 'existing-api-key-do-not-change', unified_super: true, on_behalf: 'sheep',
  signedEnvelopeProbe: 'x'.repeat(950000)
});
const largeServerRead = node.post(largeServerReadRequest.body, largeServerReadRequest.parameter);
ok('unified server signature accepts legitimate admin payloads above pinned baseline 900 KB limit', largeServerRead.success === true);
const signedLegacyAccount = signedRequest('authCreateAccount', { unit: '0082', apiKey: 'existing-api-key-do-not-change',
  unified_super: true, on_behalf: 'sheep', role: 'exco', username: 'shadow@example.test', memberId: '9000000001' });
const rejectedLegacyAccount = node.post(signedLegacyAccount.body, signedLegacyAccount.parameter);
ok('platform super signature cannot create a second Portal identity source in unified mode',
  rejectedLegacyAccount.success === false && rejectedLegacyAccount.code === 'BRANCH_IDENTITY_MANAGED');

const personalReadRequest = signedRequest('loadMine', { unit: '0082', ymis: '9000000001' });
const personalRead = node.post(personalReadRequest.body, personalReadRequest.parameter);
ok('signed personal bridge accepts unified-only loadMine and fixes identity to one YMIS',
  personalRead.success === true && Object.keys(personalRead.progress || {}).length === 1
    && Object.prototype.hasOwnProperty.call(personalRead.progress || {}, '9000000001'));

const wrongPurposeNow = Date.now();
const oldSeparateSecretToken = ssoToken('central-sso-session-secret-at-least-32-chars', {
  typ: 'central-sso-exchange', u: '0082', sub: '9000000001', role: 'member', name: '中央團員',
  scope: ['identity:read', 'branch:read', 'progress:self'], src: 'central-travel-system',
  iss: 'vs-portal', aud: 'unified-gas:branch:0082', iat: wrongPurposeNow,
  exp: wrongPurposeNow + 60_000, jti: crypto.randomUUID()
});
const rejectedOldSecret = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: oldSeparateSecretToken });
ok('branch GS rejects the removed standalone Portal secret and derives exchange key from API_KEY purpose',
  rejectedOldSecret.code === 'SSO_TOKEN_INVALID');

const wrongUnitToken = assertion('0099', '9000000001', 'member', '中央團員');
const wrongUnitExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: wrongUnitToken });
ok('branch GS rejects a purpose token issued for another unit', wrongUnitExchange.code === 'SSO_UNIT_MISMATCH');
const expiredNow = Date.now();
const expiredToken = exchangeToken({
  typ: 'central-sso-exchange', u: '0082', sub: '9000000001', role: 'member', name: '中央團員',
  scope: ['identity:read', 'branch:read', 'progress:self'], src: 'central-travel-system',
  iss: 'vs-portal', aud: 'unified-gas:branch:0082',
  iat: expiredNow - 80_000, exp: expiredNow - 20_000, jti: crypto.randomUUID()
});
const expiredExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: expiredToken });
ok('branch GS rejects an expired purpose token before creating a session', expiredExchange.code === 'SSO_TOKEN_EXPIRED');

const memberPurposeToken = assertion('0082', '9000000001', 'member', '中央團員');
const memberExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: memberPurposeToken });
ok('isolated auth fixture exchanges a short assertion for an opaque branch session', memberExchange.success === true && /^sso_/.test(memberExchange.sessionToken || ''));
const replayedExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: memberPurposeToken });
ok('branch GS rejects replay of the one-use SSO exchange token', replayedExchange.code === 'SSO_TOKEN_REPLAYED');
ok('replay protection uses shared Script Cache under an atomic Script Lock',
  node.cacheWrites.some(write => write.key.startsWith('unified-sso-jti:') && write.ttl === 180)
    && node.lockStats.waits >= 2 && node.lockStats.waits === node.lockStats.releases);
ok('isolated auth fixture creates only a passwordless authorization mirror', (() => {
  const row = node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000001');
  return row && row[4] === '' && row[3] === 'member';
})());
const memberWho = node.post({ action: 'authWhoAmI', unit: '0082', sessionToken: memberExchange.sessionToken });
ok('authWhoAmI derives identity from server session, not client role', memberWho.success === true && memberWho.account.role === 'member');
const memberWrite = node.post({ action: 'saveTables', unit: '0082', sessionToken: memberExchange.sessionToken,
  __serverSigned: true, __serverActorRole: 'super', __serverActorSubject: 'sheep',
  tables: { notices: [] }, refreshReports: false });
ok('member session is denied administrative write scope and cannot forge internal actor markers',
  memberWrite.code === 'ACTION_SCOPE_DENIED');
const promoted = node.post({ action: 'authPortalExchange', unit: '0082',
  portalToken: assertion('0082', '9000000001', 'exco', '中央團員') });
ok('fixture role changes update only the passwordless authorization mirror', promoted.success === true
  && promoted.account.role === 'exco' && node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000001')?.[4] === '');

const leaderExchange = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: assertion('0082', 'leader@example.test', 'leader', '中央領袖') });
ok('isolated auth fixture maps an e-mail subject to the branch roster', leaderExchange.success === true && leaderExchange.account.ymis === '9000000002', JSON.stringify(leaderExchange));
ok('leader mirror has branch-leader ceiling and no local credential', (() => {
  const row = node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000002');
  return row && row[3] === 'branch_leader' && row[4] === '';
})());
const readOnlyLeader = node.post({ action: 'authPortalExchange', unit: '0082',
  portalToken: assertion('0082', '9000000002', 'leader', '中央領袖', ['identity:read', 'branch:read']) });
const readOnlyWrite = node.post({ action: 'saveTables', unit: '0082', sessionToken: readOnlyLeader.sessionToken,
  tables: { notices: [] }, refreshReports: false });
ok('action scope is enforced independently of role label', readOnlyLeader.success === true && readOnlyWrite.code === 'ACTION_SCOPE_DENIED');

const saved = node.post({
  action: 'saveTables', unit: '0082', sessionToken: leaderExchange.sessionToken, refreshReports: false,
  tables: {
    members: [
      { id: 'm1', ymis: '9000000001', name: '中央團員（更新）', identity: 'member', email: 'member@example.test' },
      { id: 'm2', ymis: '9000000002', name: '中央領袖', identity: 'leader', email: 'leader@example.test' }
    ],
    accounts: [{ id: 'evil', username: 'shadow', pw: { hash: 'must-not-persist' }, role: 'super' }],
    notices: []
  }
});
ok('authorised leader can write administrative tables', saved.success === true && saved.confirmed === true, JSON.stringify(saved));
const loaded = node.post({ action: 'loadTables', unit: '0082', sessionToken: leaderExchange.sessionToken });
ok('all clients read one administrative data copy', loaded.success === true && Array.isArray(loaded.db?.members));
ok('canonical roster overlays Portal member identity fields', loaded.db.members.some(m => m.ymis === '9000000001' && m.name === '中央團員（更新）'));
ok('legacy account payload is replaced by safe pinned Users projection', loaded.db.accounts.every(a => !a.pw && !a.password && a.source === 'unified-users'));
ok('no client-supplied shadow account survives', !loaded.db.accounts.some(a => a.username === 'shadow'));

/* A compatibility rejection must be side-effect free. Historically the unified
   router updated 成員名單／Users before the stale-version check ran. */
const rejectedRosterDb = JSON.parse(JSON.stringify(loaded.db));
rejectedRosterDb.members.find(m => m.ymis === '9000000001').name = '拒絕請求不可先改名';
rejectedRosterDb.members.find(m => m.ymis === '9000000001').email = 'rejected@example.test';
const rosterNameBeforeReject = node.sheets.get('成員名單')._rows.find(r => String(r[0]) === '9000000001')?.[1];
const userBeforeReject = node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000001')?.slice();
const rejectedRosterSave = node.post({ action: 'saveDb', unit: '0082', sessionToken: leaderExchange.sessionToken,
  db: rejectedRosterDb, baseVersion: 'definitely-stale-version', refreshReports: false });
const rosterAfterReject = node.sheets.get('成員名單')._rows.find(r => String(r[0]) === '9000000001');
const userAfterReject = node.sheets.get('Users')._rows.find(r => String(r[0]) === '9000000001');
ok('stale compatibility save is rejected before any roster or Users mirror side effect',
  rejectedRosterSave.success === false && rosterAfterReject?.[1] === rosterNameBeforeReject
    && JSON.stringify(userAfterReject) === JSON.stringify(userBeforeReject), JSON.stringify(rejectedRosterSave));

/* Unified account aliases bypass Portal's ordinary save dispatcher, but must still
   obey this branch DB's admin.accounts ACL after the compatibility DB exists. */
const aclReadRequest = signedRequest('loadTables', {
  unit: '0082', apiKey: 'existing-api-key-do-not-change', unified_super: true, on_behalf: 'sheep'
});
const aclFull = node.post(aclReadRequest.body, aclReadRequest.parameter);
const aclDeniedDb = JSON.parse(JSON.stringify(aclFull.db));
aclDeniedDb.permOverrides = aclDeniedDb.permOverrides || {};
aclDeniedDb.permOverrides['admin.accounts'] = {
  ...(aclDeniedDb.permOverrides['admin.accounts'] || {}),
  member: 0, exco: 0, leader: 0, chief: 0
};
aclDeniedDb.permOverrides['member.create'] = {
  ...(aclDeniedDb.permOverrides['member.create'] || {}), member: 0, exco: 0
};
const aclSaveRequest = signedRequest('saveDb', {
  unit: '0082', apiKey: 'existing-api-key-do-not-change', unified_super: true, on_behalf: 'sheep',
  db: aclDeniedDb, baseVersion: aclFull.version, refreshReports: false
});
const aclSaved = node.post(aclSaveRequest.body, aclSaveRequest.parameter);
const unifiedAclDenied = [
  node.post({ action: 'authResetPassword', unit: '0082', sessionToken: accountAdmin.sessionToken,
    targetYmis: '9000000010', newPassword: '9999' }),
  node.post({ action: 'authDeleteAccount', unit: '0082', sessionToken: accountAdmin.sessionToken,
    targetYmis: '9000000010' }),
  node.post({ action: 'authRestoreAccount', unit: '0082', sessionToken: accountAdmin.sessionToken,
    targetYmis: '9000000010' }),
  node.post({ action: 'authCreateAccount', unit: '0082', sessionToken: accountAdmin.sessionToken,
    targetYmis: '9000000001', role: 'member', password: '1234' })
];
ok('Unified reset/delete/restore/create aliases obey branch admin.accounts ACL',
  aclSaved.success === true
    && unifiedAclDenied.every(result => result.success === false && result.code === 'ACTION_SCOPE_DENIED'),
  JSON.stringify({ aclSaved, unifiedAclDenied }));
const loadedAfterAcl = node.post({ action: 'loadTables', unit: '0082', sessionToken: leaderExchange.sessionToken });

/* Confidential identities omitted by a projection are restored before validation;
   that restoration must never be confused with a genuinely client-invented row. */
const excoProjectedAfterAcl = node.post({ action: 'loadTables', unit: '0082', sessionToken: promoted.sessionToken });
const inventedUnifiedMembers = JSON.parse(JSON.stringify(excoProjectedAfterAcl.db.members));
inventedUnifiedMembers.push({ id: 'forged-unified-member', ymis: '9999999998',
  name: '偽造 Unified 成員', identity: 'member' });
const deniedUnifiedProjectedCreate = node.post({ action: 'saveTables', unit: '0082',
  sessionToken: promoted.sessionToken, baseVersion: excoProjectedAfterAcl.version, refreshReports: false,
  tables: { members: inventedUnifiedMembers } });
ok('unified projected rows cannot bypass a denied member.create permission',
  excoProjectedAfterAcl.success === true && deniedUnifiedProjectedCreate.success === false
    && deniedUnifiedProjectedCreate.code === 'ACTION_SCOPE_DENIED', JSON.stringify(deniedUnifiedProjectedCreate));
ok('generated Unified compatibility checkpoint contains no missing-projection create bypass',
  !SOURCE.includes('__allowMissingProjectedRows'));

const stagedIdentityDb = JSON.parse(JSON.stringify(loadedAfterAcl.db));
stagedIdentityDb.members.find(m => m.ymis === '9000000001').identity = 'chief';
const stagedIdentitySaveId = '0082-stg-unified-identity-guard';
const stagedIdentityPart = node.post({ action: 'saveDbPart', unit: '0082', sessionToken: promoted.sessionToken,
  saveId: stagedIdentitySaveId, partIdx: 0, parts: 1, data: stagedIdentityDb, baseVersion: loadedAfterAcl.version });
const stagedIdentityCommit = node.post({ action: 'saveDbCommit', unit: '0082', sessionToken: promoted.sessionToken,
  saveId: stagedIdentitySaveId, parts: 1, baseVersion: loadedAfterAcl.version, refreshReports: false });
ok('unified delegated exco cannot use staged saveDbCommit to bypass identity field authorization',
  stagedIdentityPart.success === true && stagedIdentityCommit.success === false
    && stagedIdentityCommit.code === 'PROTECTED_AUTH_FIELD', JSON.stringify(stagedIdentityCommit));

/* 團員入口唔再用行政 loadDb/saveDb：有效 session 只收本人安全投影，

   RSVP／答卷／請假亦由 GS 固定 memberId，client 偽造身份冇作用。 */
const hubDb = JSON.parse(JSON.stringify(loadedAfterAcl.db));
hubDb.schema = 2;
hubDb.settings = { troopLinks: { facebook: 'https://facebook.example/member' }, publicLinks: {} };
hubDb.publicProfile = {
  about: { text: '團員可見簡介', vis: 'member' }, site: { url: '', vis: 'member' },
  socials: [
    { id: 'social-member', kind: 'instagram', title: '團員 IG', url: 'https://instagram.example/member', vis: 'member' },
    { id: 'social-leader', kind: 'whatsapp', title: '領袖秘密群', url: 'https://chat.example/leaders', vis: 'leader' }
  ], albums: [], links: []
};
hubDb.events = [
  { id: 'event-member', title: '團員活動', date: '2099-12-01', status: 'confirmed', vis: 'member', adminSecret: 'EVENT-SECRET',
    rsvp: { m2: { status: 'present', name: '中央領袖', auditSecret: 'RSVP-SECRET' } }, rollcall: { m2: { status: 'present' } } },
  { id: 'event-leader', title: '領袖秘密活動', date: '2099-12-02', status: 'confirmed', vis: 'leader', rsvp: {} }
];
hubDb.quizzes = [
  { id: 'quiz-member', title: '團員試卷', status: 'open', vis: 'member', gradingSecret: 'QUIZ-SECRET',
    questions: [{ id: 'q1', prompt: '一加一', type: 'single', options: ['1', '2'], required: true, answerKey: 'QUESTION-SECRET' }],
    responses: { m2: { name: '中央領袖', answers: { q1: '2' }, markerNote: 'RESPONSE-SECRET' } } },
  { id: 'quiz-leader', title: '領袖試卷', status: 'open', vis: 'leader', questions: [], responses: {} }
];
hubDb.notices = [
  { id: 'notice-member', title: { zh: '團員通告' }, status: 'published', vis: 'member', internalRecipients: 'NOTICE-SECRET', signups: [{ memberId: 'm2', name: '中央領袖' }] },
  { id: 'notice-leader', title: { zh: '領袖通告' }, status: 'published', vis: 'leader', signups: [] }
];
hubDb.absences = [
  { id: 'absence-mine', memberId: 'm1', ymis: '9000000001', date: '2099-11-01', status: 'approved', reason: '本人原因' },
  { id: 'absence-other', memberId: 'm2', ymis: '9000000002', date: '2099-11-01', status: 'approved', reason: '他人私隱' }
];
const hubSeed = node.post({ action: 'saveDb', unit: '0082', sessionToken: leaderExchange.sessionToken,
  db: hubDb, baseVersion: loadedAfterAcl.version, refreshReports: false });
ok('leader seeds member-hub administrative source through the normal authorised route', hubSeed.success === true, JSON.stringify(hubSeed));
const anonymousHub = node.post({ action: 'hubLoad', unit: '0082' });
ok('member hub rejects a client without an opaque branch session', anonymousHub.code === 'SESSION_REQUIRED');
const memberHub = node.post({ action: 'hubLoad', unit: '0082', sessionToken: memberExchange.sessionToken,
  role: 'chief', memberId: 'm2' });
ok('member hub returns one canonical self and no account/password collection', memberHub.success === true
  && memberHub.db.members.length === 1 && memberHub.db.members[0].id === 'm1'
  && memberHub.db.members[0].identity === 'member' && memberHub.db.accounts.length === 0
  && !/password|password_hash|hubPw|他人私隱/.test(JSON.stringify(memberHub.db)), JSON.stringify(memberHub));
ok('member hub filters leader-only content and every other member response server-side',
  memberHub.db.events.length === 1 && memberHub.db.events[0].id === 'event-member'
  && Object.keys(memberHub.db.events[0].rsvp).length === 0 && !memberHub.db.events[0].rollcall
  && memberHub.db.quizzes.length === 1 && Object.keys(memberHub.db.quizzes[0].responses).length === 0
  && memberHub.db.notices.length === 1 && memberHub.db.absences.length === 1
  && !JSON.stringify(memberHub.db).includes('領袖秘密'));
ok('unified event/quiz/notice projection is a positive field allowlist',
  !/EVENT-SECRET|RSVP-SECRET|QUIZ-SECRET|QUESTION-SECRET|RESPONSE-SECRET|NOTICE-SECRET/.test(JSON.stringify(memberHub.db)));
const memberRsvp = node.post({ action: 'hubRsvp', unit: '0082', sessionToken: memberExchange.sessionToken,
  eventId: 'event-member', status: 'late', time: '19:30', memberId: 'm2', role: 'chief' });
ok('member RSVP ignores forged memberId/role and writes only the session actor', memberRsvp.success === true
  && memberRsvp.db.events[0].rsvp.m1?.status === 'late' && !memberRsvp.db.events[0].rsvp.m2,
  JSON.stringify(memberRsvp));
const publicReceipt = node.post({ action: 'operationStatus', unit: '0082', operationId: memberRsvp.operationId });
ok('unpredictable operation ID is a read-only capability receipt (no session, metadata only)',
  publicReceipt.ok === true && publicReceipt.found === true && publicReceipt.outcome === 'applied'
    && publicReceipt.operation?.id === memberRsvp.operationId
    && !Object.prototype.hasOwnProperty.call(publicReceipt.operation || {}, 'resultJson'),
  JSON.stringify(publicReceipt));
const hiddenRsvp = node.post({ action: 'hubRsvp', unit: '0082', sessionToken: memberExchange.sessionToken,
  eventId: 'event-leader', status: 'present' });
ok('member cannot write a leader-only event by guessing its id', hiddenRsvp.success === false);
const memberQuiz = node.post({ action: 'hubQuiz', unit: '0082', sessionToken: memberExchange.sessionToken,
  quizId: 'quiz-member', answers: { q1: '2', injected: 'must-drop' }, memberId: 'm2' });
ok('member quiz keeps only defined answers under the session actor', memberQuiz.success === true
  && memberQuiz.db.quizzes[0].responses.m1?.answers?.q1 === '2'
  && memberQuiz.db.quizzes[0].responses.m1?.answers?.injected === undefined);
const memberAbsencePayload = { action: 'hubAbsence', unit: '0082', sessionToken: memberExchange.sessionToken,
  op: 'create', id: 'ab_member_test', date: '2099-12-03', slot: 'pm', reason: '測試請假', memberId: 'm2' };
const memberAbsence = node.post(memberAbsencePayload);
ok('member absence is fixed to the session actor and still hides every other absence', memberAbsence.success === true
  && memberAbsence.db.absences.some(a => a.id === 'ab_member_test' && a.memberId === 'm1' && a.ymis === '9000000001')
  && !memberAbsence.db.absences.some(a => a.id === 'absence-other'));
const memberAbsenceRetry = node.post(memberAbsencePayload);
ok('unified absence create retry is idempotent', memberAbsenceRetry.success === true
  && memberAbsenceRetry.db.absences.filter(a => a.id === 'ab_member_test').length === 1);
const memberWithdraw = node.post({ action: 'hubAbsence', unit: '0082', sessionToken: memberExchange.sessionToken,
  op: 'withdraw', id: 'ab_member_test' });
const memberWithdrawRetry = node.post({ action: 'hubAbsence', unit: '0082', sessionToken: memberExchange.sessionToken,
  op: 'withdraw', id: 'ab_member_test' });
ok('unified absence withdraw retry is idempotent', memberWithdraw.success === true && memberWithdrawRetry.success === true
  && !memberWithdrawRetry.db.absences.some(a => a.id === 'ab_member_test'));
const adminAfterHub = node.post({ action: 'loadDb', unit: '0082', sessionToken: leaderExchange.sessionToken });
ok('administrative copy receives member writes without losing other members data', adminAfterHub.success === true
  && adminAfterHub.db.events.find(e => e.id === 'event-member')?.rsvp?.m1?.status === 'late'
  && adminAfterHub.db.events.find(e => e.id === 'event-member')?.rsvp?.m2?.status === 'present'
  && adminAfterHub.db.quizzes.find(q => q.id === 'quiz-member')?.responses?.m2
  && adminAfterHub.db.absences.some(a => a.id === 'absence-other'));

const centralPassword = node.post({ action: 'authChangePassword', unit: '0082', sessionToken: leaderExchange.sessionToken,
  oldPassword: 'x', newPassword: 'y1234' });
ok('auth-fixture session cannot create a second local password', centralPassword.code === 'CENTRAL_IDENTITY_MANAGED');

const localNormal = node.post({ action: 'authLogin', unit: '0082', username: '1111111111', password: 'changed99' });
ok('local branch account is the normal login source', localNormal.success === true
  && typeof localNormal.sessionToken === 'string' && localNormal.sessionToken.length > 10
  && localNormal.localLogin === true, JSON.stringify(localNormal));
const menuClose = node.context.menuLocalLoginOff();
ok('Sheet menu cannot close the branch local login entrance', menuClose.success === false
  && menuClose.code === 'BRANCH_LOCAL_LOGIN_REQUIRED' && node.context.localLoginAllowed() === true);

/* Isolated auth-fixture regression only: directly exercise pinned compatibility code.
   This is not a deployment state or a future travel-system contract. */
node.context.setLocalLoginAllowed(false, 'test-isolated-auth-fixture');
const localClosed = node.post({ action: 'authLogin', unit: '0082', username: '1111111111', password: 'changeme' });
ok('auth fixture can exercise the legacy closed-gate branch', localClosed.success === false
  && /本地入口|旅團入口/.test(localClosed.error || ''), JSON.stringify(localClosed));
const centralStillWorks = node.post({ action: 'authPortalExchange', unit: '0082', portalToken: assertion('0082', '9000000002', 'leader', '中央領袖') });
ok('isolated exchange fixture still exercises its dedicated token path', centralStillWorks.success === true);
node.context.setLocalLoginAllowed(true, 'test-fixture-cleanup');

const beforeRows = node.sheets.get('進度追蹤')._rows.map(r => JSON.stringify(r));
const again = node.context.initializeSheets();
ok('unified initializer is safely repeatable', again.success === true);
ok('repeat initialization does not rewrite progress', JSON.stringify(node.sheets.get('進度追蹤')._rows.map(r => JSON.stringify(r))) === JSON.stringify(beforeRows));
ok('repeat initialization still preserves API key', node.props.get('API_KEY') === 'existing-api-key-do-not-change');

/* Keep the merged Badge repair intact inside the full Unified build. */
const repairNode = makeNode();
repairNode.sheets.set('Users', makeSheet('Users', [
  USER_HEADERS,
  ['1111111111', '既有管理員', 'admin@example.com', 'admin', sha256('changeme'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', true],
  ['L9000000001', '支部領袖', 'leader@example.test', 'branch_leader', sha256('leaderpass9'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', false],
  ['9000000001', '團員甲', 'member@example.test', 'member', sha256('memberpass9'), 'b4', true, 'existing', '2026-01-01', '2026-01-01', '', 'active', '*', false]
]));
repairNode.sheets.set('進度追蹤', makeSheet('進度追蹤', [
  ['YMIS','項目 ID','完成日期','更新時間','確認者','備註']
]));
repairNode.sheets.set('成員名單', makeSheet('成員名單', [
  ['YMIS','姓名','加入日期','支部','聯絡'],
  ['L9000000001', '支部領袖', '2025-01-01', 'VS', 'leader@example.test'],
  ['9000000001', '團員甲', '2025-01-01', 'VS', 'member@example.test']
]));
repairNode.context.initializeSheets();
const repairAdmin = repairNode.post({ action: 'login', login_id: '1111111111', password: 'changeme' });
const repairLeader = repairNode.post({ action: 'login', login_id: 'LEADER@example.test', password: 'leaderpass9' });
const scopeOnly = repairNode.post({ action: 'updatePermissions', token: repairAdmin.token,
  target_ymis: 'L9000000001', allowed_badges: 'L1,L2' });
ok('Unified scope-only update preserves branch leader role and can_tick',
  repairAdmin.success === true && scopeOnly.success === true
    && scopeOnly.role === 'branch_leader' && scopeOnly.can_tick === true
    && repairNode.context.findUserRecord('L9000000001').user.allowed_badges === 'L1,L2',
  JSON.stringify(scopeOnly));
const repairLoadOut = repairNode.context.doGet({ parameter: {
  action: 'load', token: repairLeader.token, apikey: 'existing-api-key-do-not-change'
} });
const repairLoad = JSON.parse(repairLoadOut.getContent());
ok('Unified authenticated load returns latest Badge session role, tick and scope without identifiers',
  repairLoad.success === true && repairLoad.me?.role === 'branch_leader'
    && repairLoad.me?.can_tick === true && repairLoad.me?.allowed_badges === 'L1,L2'
    && repairLoad.me?.ymis === undefined && repairLoad.me?.email === undefined,
  JSON.stringify(repairLoad.me));
const repairMemberLogin = repairNode.post({ action: 'login', login_id: 'member@example.test', password: 'memberpass9' });
const deniedMemberWrite = repairNode.post({ action: 'save', token: repairMemberLogin.token,
  changes: [{ ymis: '9000000001', itemId: 'L1', date: '2026-11-20' }] });
ok('Unified still denies member progress writes even when the stored can_tick flag is true',
  repairMemberLogin.success === true && deniedMemberWrite.success === false
    && /沒有直接寫入進度權限/.test(deniedMemberWrite.error || '')
    && !repairNode.sheets.get('進度追蹤')._rows.some(row => row[0] === '9000000001' && row[1] === 'L1'),
  JSON.stringify(deniedMemberWrite));

console.log(`\n${passed} passed, 0 failed\n`);
