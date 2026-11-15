'use strict';

/*
 * YMIS 獎章匯出（試行版，深資童軍支部）測試
 *
 * 守住：
 *   1. 四欄欄名、支部固定值、四款獎章字串與 YMIS 範本／使用者提供的字串逐字一致
 *   2. SCOUT ID／日期／獎章／重複行驗證
 *   3. 工作表只有表頭＋領袖指定的紀錄，全部以文字寫入（保留前導零）
 *   4. index.html 接線：領袖專用入口、試行提示、不由考核完成度推斷、不呼叫後端
 *
 * 界線：只驗證本地產生的資料；未（亦無法）驗證 YMIS 伺服器是否接受檔案。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
// 與 tests/ymis_parse.test.cjs 相同做法：assets 檔以 UMD 掛上 globalThis（repo 為 "type":"module"）
require('../assets/ymis-export.js');
const api = globalThis.YmisExport;
if (!api) throw new Error('YmisExport not loaded from assets/ymis-export.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const BADGES = ['Membership Badge', 'The Venture Scout Award', 'The Dragon Scout Award', "King's Scout Award"];
const base = { ymis: '0123456789', badge: 'Membership Badge', date: '2026-11-14' };

test('exact YMIS headers, Venture Scout section and the four supported award names', () => {
  assert.deepEqual(api.headers, ['Scout ID', 'Badge-Section', 'Badge-Badge', 'Badge-award date (YYYYMMDD)']);
  assert.equal(api.section, 'Venture Scout');
  assert.deepEqual(api.badges.map((b) => b[1]), BADGES);
  assert.deepEqual(api.badges.map((b) => b[0]), ['會員章', '深資童軍獎章', '榮譽童軍獎章', '英皇童軍獎章']);
  for (const badge of BADGES) {
    assert.deepEqual(api.buildRows([{ ymis: '0123456789', badge, date: '2024-02-29' }]), [['0123456789', 'Venture Scout', badge, '20240229']]);
  }
});

test('mapping is frozen and matches the Chinese award names in data/items.json', () => {
  assert.ok(Object.isFrozen(api.headers) && Object.isFrozen(api.badges) && api.badges.every(Object.isFrozen));
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'items.json'), 'utf8'));
  const byId = new Map(items.badges.map((b) => [b.id, b]));
  // L1 / L3 / L4 的中文正名要與 L1–L4 一致（英皇童軍獎章在綱要中沒有進度項目，故不在此比對）
  assert.equal(api.badges[0][0], byId.get('L1').name, '會員章要用 L1 正名');
  assert.equal(api.badges[1][0], byId.get('L3').name, '深資童軍獎章要用 L3 正名');
  assert.equal(api.badges[2][0], byId.get('L4').name, '榮譽童軍獎章要用 L4 正名');
});

test('rejects missing/invalid IDs, dates, unsupported badges and duplicates', () => {
  const bad = [
    { ymis: '' }, { ymis: '123' }, { ymis: '12345678901' }, { ymis: '12345abcde' },
    { badge: '' }, { badge: 'Scout Standard Award' }, { badge: 'Venture Scout Award' },
    { badge: 'The Dragon Scout Award ' }, { badge: "king's scout award" },
    { date: '' }, { date: '2026-02-29' }, { date: '2026-04-31' }, { date: '20261114' }, { date: '14/11/2026' }
  ];
  for (const delta of bad) assert.throws(() => api.buildRows([{ ...base, ...delta }]), undefined, JSON.stringify(delta));
  assert.throws(() => api.buildRows([]));
  assert.throws(() => api.buildRows(null));
  assert.throws(() => api.buildRows([base, base]), /Duplicate/);
  assert.equal(api.buildRows([base, { ...base, badge: 'The Venture Scout Award' }]).length, 2);
  assert.equal(api.buildRows([base, { ...base, ymis: '0123456780' }]).length, 2);
});

test('keeps IDs as text with leading zeroes and accepts the scoutId alias', () => {
  assert.deepEqual(api.buildRows([{ ymis: '0000000042', badge: 'Membership Badge', date: '2026-01-05' }]), [['0000000042', 'Venture Scout', 'Membership Badge', '20260105']]);
  assert.deepEqual(api.buildRows([{ ymis: ' 0123456789 ', badge: 'Membership Badge', date: '2026-01-05' }])[0][0], '0123456789');
  assert.deepEqual(api.buildRows([{ scoutId: '0123456789', badge: 'Membership Badge', date: '2026-01-05' }])[0][0], '0123456789');
  // 數字型別（Sheet 丟失前導零）不可被當成有效編號
  assert.throws(() => api.buildRows([{ ...base, ymis: 123456789 }]));
});

test('workbook has only the header row and the declared records, all as strings', () => {
  let table; let sheet;
  const fake = { utils: {
    aoa_to_sheet(a) { table = a; sheet = {}; return sheet; },
    book_new() { return {}; },
    book_append_sheet(w, s, n) { w.sheet = s; w.name = n; }
  } };
  const rows = api.buildRows([base, { ...base, ymis: '1234560001', date: '2025-12-31' }]);
  const wb = api.workbook(fake, rows);
  assert.equal(wb.name, 'Sheet1');
  assert.equal(wb.sheet, sheet);
  assert.deepEqual(table, [
    ['Scout ID', 'Badge-Section', 'Badge-Badge', 'Badge-award date (YYYYMMDD)'],
    ['0123456789', 'Venture Scout', 'Membership Badge', '20261114'],
    ['1234560001', 'Venture Scout', 'Membership Badge', '20251231']
  ]);
  assert.ok(table.flat().every((cell) => typeof cell === 'string'), '所有儲存格都要係文字');
  assert.equal(api.headers.length, 4, 'workbook() 不可改動原本的表頭陣列');
});

test('index.html wires the export as a leader-only, explicit, beta feature', () => {
  assert.ok(html.includes('<script src="assets/ymis-export.js"></script>'), '要載入 assets/ymis-export.js');
  const start = html.indexOf('/* ---------- YMIS 獎章匯出');
  const end = html.indexOf('function showOverviewSubTab(');
  assert.ok(start >= 0 && end > start, '找不到 YMIS 匯出程式段');
  const code = html.slice(start, end);

  // 領袖專用：入口只向領袖顯示，兩個函式亦各自檢查角色
  const cardStart = html.indexOf("${(currentUser&&canUserTickRole(currentUser.role))?`<div class=\"info-section\"");
  assert.ok(cardStart >= 0 && html.slice(cardStart, cardStart + 1200).includes('onclick="openYmisExport()"'), '入口只向領袖顯示');
  assert.match(code, /function openYmisExport\(\)\{\s*if\(!currentUser\|\|!canUserTickRole\(currentUser\.role\)\)/);
  assert.match(code, /async function downloadYmisAwards\(\)\{\s*if\(!currentUser\|\|!canUserTickRole\(currentUser\.role\)\)/);

  // 不由考核完成度推斷、不寫回進度、不呼叫後端、不讀其他獎章／活動紀錄
  for (const forbidden of ['progressFlat', 'progressRich', 'pendingChanges', 'apiRequest', 'otherBadgesMap', 'todayISO()', 'legacyTransition', 'activities']) {
    assert.ok(!code.includes(forbidden), `YMIS 匯出不可使用 ${forbidden}`);
  }
  assert.ok(!/id="ymisExportDate_[^"]*"[^>]*\svalue=/.test(code), '獲獎日期不可有預設值');
  assert.ok(code.includes('ymisExportConfirm') && code.includes("i18n('ymisExport.confirm')"), '下載前必須勾選確認');

  // 外部 SheetJS 以 SRI 固定版本（cdnjs → jsDelivr → unpkg）
  assert.ok(code.includes('xlsx/0.18.5/xlsx.full.min.js') && /SHEETJS_SRI='sha512-[A-Za-z0-9+/=]+'/.test(code) && code.includes("s.setAttribute('integrity',SHEETJS_SRI)") && code.includes("s.setAttribute('crossorigin','anonymous')"));
  assert.ok(code.includes('cdn.jsdelivr.net/npm/xlsx@0.18.5') && code.includes('unpkg.com/xlsx@0.18.5'), '要有第二及第三個 CDN 來源');

  // 成員編號欄位跟 VSBADGE 慣例：YMIS
  assert.ok(code.includes('String(m.ymis==null'), '成員編號要用 VSBADGE 的 ymis 欄位');
});

test('beta warning, upload path and the "not imported" wording exist in both languages', () => {
  const start = html.indexOf('const I18N={');
  const end = html.indexOf('\nfunction i18n(');
  assert.ok(start >= 0 && end > start, '找不到 I18N 字典');
  const I18N = new Function(html.slice(start, end) + '; return I18N;')();
  const keys = Object.keys(I18N.zh).filter((k) => k.startsWith('ymisExport.'));
  assert.ok(keys.length >= 20, `ymisExport.* 字串不足：${keys.length}`);
  for (const k of keys) assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k], `英文缺少 ${k}`);
  assert.deepEqual(keys.sort(), Object.keys(I18N.en).filter((k) => k.startsWith('ymisExport.')).sort(), '中英字串要一對一');

  assert.ok(I18N.zh['ymisExport.btn'].includes('匯出 YMIS 獎章（試行）'));
  assert.match(I18N.zh['ymisExport.beta'], /試行版/);
  assert.match(I18N.zh['ymisExport.beta'], /尚未以真實資料在 YMIS 實測/);
  assert.match(I18N.zh['ymisExport.beta'], /匯出不代表已匯入/);
  assert.match(I18N.en['ymisExport.beta'], /Beta/);
  assert.match(I18N.en['ymisExport.beta'], /not yet tested in YMIS/);
  assert.match(I18N.en['ymisExport.beta'], /does NOT mean imported/);
  assert.match(I18N.zh['ymisExport.cardDesc'], /尚未經 YMIS 實測/);
  assert.match(I18N.zh['ymisExport.explicit'], /完成考核不等於已頒章/);
  assert.match(I18N.zh['ymisExport.uploadHint'], /成員註冊 → 資料檔案上傳 → 新增支部獎章紀錄/);
  assert.match(I18N.zh['ymisExport.uploadHint'], /不會偵測跨次重複上傳/);
  assert.match(I18N.zh['ymisExport.done'], /尚未確認已匯入 YMIS/);
  assert.match(I18N.en['ymisExport.done'], /NOT confirmed/);
});

test('documentation keeps the beta boundary', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'YMIS_BADGE_EXPORT.md'), 'utf8');
  for (const s of ['試行', '尚無真實資料在 YMIS 驗證', '匯出不等於匯入成功', '新增支部獎章紀錄', 'Venture Scout', ...api.headers, ...BADGES]) {
    assert.ok(doc.includes(s), `docs/YMIS_BADGE_EXPORT.md 缺少：${s}`);
  }
});
