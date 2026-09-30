import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import items from '../data/items.json' with { type: 'json' };

const gasSource = fs.readFileSync('apps-script/Code.gs', 'utf8');
const htmlSource = fs.readFileSync('index.html', 'utf8');

function collectItems(value, out = []) {
  if (Array.isArray(value)) { value.forEach(x => collectItems(x, out)); return out; }
  if (!value || typeof value !== 'object') return out;
  if (typeof value.id === 'string') out.push(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') collectItems(child, out);
  return out;
}

function extractFunctions(startName, nextName) {
  const start = htmlSource.indexOf(`function ${startName}(`);
  assert.notEqual(start, -1, `missing function ${startName}`);
  const end = htmlSource.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(end, -1, `missing function ${nextName} after ${startName}`);
  return htmlSource.slice(start, end);
}

function makeMemorySheet(name, rows = []) {
  const data = rows.map(row => [...row]);
  const getCell = (r, c) => data[r - 1]?.[c - 1] ?? '';
  const setCell = (r, c, value) => {
    while (data.length < r) data.push([]);
    while (data[r - 1].length < c) data[r - 1].push('');
    data[r - 1][c - 1] = value;
  };
  function range(r, c, numRows = 1, numCols = 1) {
    const api = {
      getValue: () => getCell(r, c),
      getValues: () => Array.from({ length: numRows }, (_, ri) => Array.from({ length: numCols }, (_, ci) => getCell(r + ri, c + ci))),
      setValue(value) { setCell(r, c, value); return api; },
      setValues(values) { values.forEach((row, ri) => row.forEach((value, ci) => setCell(r + ri, c + ci, value))); return api; }
    };
    return api;
  }
  const sheet = {
    getName: () => name,
    getDataRange: () => range(1, 1, Math.max(data.length, 1), Math.max(1, ...data.map(row => row.length))),
    getRange: (r, c, nr, nc) => range(r, c, nr || 1, nc || 1),
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(0, ...data.map(row => row.length)),
    appendRow(row) { data.push([...row]); return sheet; },
    deleteRow(row) { data.splice(row - 1, 1); },
    _rows: data
  };
  return sheet;
}

function makeGasContext(initialSheets = {}) {
  const sheets = new Map(Object.entries(initialSheets));
  const spreadsheet = { getSheetByName: name => sheets.get(name) || null };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    Utilities: { formatDate: date => date instanceof Date ? date.toISOString().slice(0, 10) : String(date).split(' ')[0] },
    Logger: { log() {} }
  });
  vm.runInContext(gasSource, context, { filename: 'apps-script/Code.gs' });
  context.getSheet = () => spreadsheet;
  context.jsonResponse = value => value;
  context.getMembers = () => [];
  context.getLogRecordsList = () => [];
  context.getLogRequestsList = () => [];
  return { context, sheets };
}

function makeUiContext(extra = {}) {
  const toasts = [];
  const context = vm.createContext({
    itemsData: items,
    progressFlat: {}, progressRich: {}, pendingChanges: [],
    members: [{ ymis: '1234567890', name: '測試成員' }],
    currentUser: { ymis: '1234567890', name: '測試領袖', role: 'group_leader', can_tick: true, allowed_badges: '*' },
    currentLang: 'zh',
    canUserTickRole: () => true,
    canCurrentUserTickItem: () => true,
    isMember: () => false,
    todayISO: () => '2026-09-30',
    isEn: () => false,
    tx: (obj, field = 'name') => context.currentLang === 'en' ? (field === 'name' && obj?.en ? obj.en : obj?.['en' + field[0].toUpperCase() + field.slice(1)] || obj?.[field] || '') : (obj?.[field] || ''),
    i18n: (key, vars = {}) => Object.keys(vars).reduce((s, k) => s.replaceAll(`{${k}}`, vars[k]), key),
    escapeHtmlText: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
    escapeAttr: value => String(value ?? '').replace(/'/g, "\\'").replace(/"/g, '&quot;'),
    showToast: (...args) => toasts.push(args),
    updateSaveBar() {},
    savePendingToLocal() {},
    confirm: () => true,
    ...extra
  });
  context.__toasts = toasts;
  return context;
}

test('legacy crosswalk covers the policy and all referenced item IDs exist', () => {
  const transition = items.legacyTransition;
  assert.equal(transition.effectiveDate, '2026-08-15');
  assert.equal(transition.deadline, '2029-08-14');
  assert.match(transition.sourceUrl, /p022-26\.pdf$/);
  assert.equal(transition.badgeMappings.length, 11);
  assert.equal(transition.detailMappings.length, 30);
  assert.ok(!transition.detailMappings.some(row => ['999B', '999R', '999U'].includes(row.code)), 'new A-999 options are not presented as official legacy codes');
  assert.ok(!JSON.stringify(transition).match(/INTEREST-999[BRU]/), 'removed INTEREST-999B/R/U records stay absent');
  assert.equal(transition.quickTransfers.length, 14);
  assert.match(htmlSource, /'legacy\.historyProgress':'已保存的舊進度'/);
  assert.match(htmlSource, /'legacy\.historyProgress':'Preserved old progress'/);
  assert.match(htmlSource, /'legacy\.historyDone':'Completion record found'/);
  assert.match(htmlSource, /'legacy\.historyNoRecord':'No completion record found'/);
  assert.match(transition.mappingScope, /章級／範疇級/);
  assert.ok(transition.unmatchedItems.some(row => row.id === 'world-scout-environment'));
  assert.ok(transition.categoryOnlyNotes.some(row => row.id === 'interests'), 'old A-203–A-240/A-999 is only category-mapped');

  const allIds = new Set(collectItems(items.badges).map(item => item.id));
  const transferIds = new Set();
  for (const row of transition.quickTransfers) {
    assert.ok(!transferIds.has(row.recordId), `duplicate transition record ${row.recordId}`);
    transferIds.add(row.recordId);
    assert.ok(allIds.has(row.permissionItemId), `permission item is missing: ${row.permissionItemId}`);
    assert.ok(items.badges.some(badge => badge.segments.some(segment => segment.code === row.targetSegmentCode)), `segment is missing: ${row.targetSegmentCode}`);
  }
  for (const row of transition.detailMappings) {
    const ids = String(row.newItemId || '').match(/L[34]-[A-Z0-9]+(?:-[A-Z0-9]+)*/g) || [];
    for (const id of ids) assert.ok(allIds.has(id), `${row.code}: new item ${id} is missing`);
  }

  const canonicalIds = new Set(items.otherBadges.map(badge => badge.id));
  assert.ok(canonicalIds.has('OT-RELIGION'));
  assert.ok(canonicalIds.has('OT-LIFESAVING-BRONZE'));
  const aliases = items.otherBadges.flatMap(badge => badge.aliases || []);
  assert.equal(new Set(aliases).size, aliases.length, 'aliases must be unique');
  assert.ok(aliases.every(alias => !canonicalIds.has(alias)), 'an alias must not shadow a canonical badge');

  const sportItems = collectItems(items.badges).filter(item => /^L[34]-ACT-V11-SPORT-(2X20|52)$/.test(item.id));
  assert.equal(sportItems.length, 4);
  assert.ok(sportItems.every(item => item.activityOptions?.length === 12));
  const experienceTypes = collectItems(items.badges).filter(item => /^L[34]-ACT-V11-NEW-(AIR|SEA|IT|OVERSEAS|ARTS|INTERESTS)$/.test(item.id));
  assert.equal(experienceTypes.length, 12);
  assert.ok(experienceTypes.every(item => item.activityOptions?.length));
});

test('other-badge alias resolution reuses legacy IDs or names instead of creating duplicates', () => {
  const ymis = '1234567890';
  const context = makeUiContext({ otherBadgesMap: { [ymis]: {
    old_unknown_religion_key: { name: 'Religious Badge', date: '2025-01-02', cert: 'REL-1' },
    'OT-BRONZE-MEDALLION': { name: 'Old bronze badge name', date: '2025-02-03', cert: 'BR-1' }
  } } });
  vm.runInContext(extractFunctions('resolveOtherBadgeRecord', 'isActivityDetailItem'), context);
  const religion = items.otherBadges.find(badge => badge.id === 'OT-RELIGION');
  const bronze = items.otherBadges.find(badge => badge.id === 'OT-LIFESAVING-BRONZE');
  assert.equal(context.resolveOtherBadgeRecord(ymis, religion).id, 'old_unknown_religion_key');
  assert.equal(context.resolveOtherBadgeRecord(ymis, bronze).id, 'OT-BRONZE-MEDALLION');
});

test('other-badge cards show official links, explain legacy-only records, and reject unsafe link schemes', () => {
  const context = makeUiContext({ otherBadgesMap: {}, selectedProgressYmis: '' });
  const container = { innerHTML: '' };
  context.document = { getElementById: id => id === 'tab-other' ? container : null };
  vm.runInContext(extractFunctions('safeExternalUrl', 'renderLegacyTransitionPanel'), context);
  vm.runInContext(extractFunctions('resolveOtherBadgeRecord', 'isActivityDetailItem'), context);
  vm.runInContext(extractFunctions('renderOtherBadgesTab', 'onOtherMemberChange'), context);
  context.renderOtherBadgesTab();
  assert.match(container.innerHTML, /other-badge-links/);
  assert.match(container.innerHTML, /https:\/\/earthtribe\.scouting\.org\.hk/);
  assert.match(container.innerHTML, /世界童軍環境章/);
  assert.doesNotMatch(container.innerHTML, /href="javascript:/);

  const linkHtml = context.renderExternalLinks([
    { title: '<bad title>', url: 'https://example.org/?a=1&b=2' },
    { title: 'unsafe', url: 'javascript:alert(1)' }
  ]);
  assert.match(linkHtml, /&lt;bad title&gt;/);
  assert.match(linkHtml, /a=1&amp;b=2/);
  assert.doesNotMatch(linkHtml, /javascript:/);
});

test('activity detail editor displays choices, escapes saved notes, and queues edits without changing completion dates', () => {
  const context = makeUiContext();
  vm.runInContext(extractFunctions('getProgressNote', 'renderLegacySegmentTag'), context);
  vm.runInContext(extractFunctions('isActivityDetailItem', 'applyActivityDetailOption'), context);
  vm.runInContext(extractFunctions('addOrUpdatePending', 'savePendingToLocal'), context);
  vm.runInContext(extractFunctions('saveActivityDetail', 'renderLegacyTransitionPanel'), context);

  const id = 'L3-ACT-SPORT-301';
  context.progressFlat['1234567890'] = { [id]: '2026-09-01' };
  context.progressRich['1234567890'] = { [id]: { date: '2026-09-01', note: '<badminton>' } };
  const item = { id, activityOptions: [{ name: '羽毛球', en: 'Badminton' }, { name: '游泳', en: 'Swimming' }] };
  const html = context.renderActivityDetailEditor(item, '1234567890', true);
  assert.match(html, /<select/);
  assert.match(html, /羽毛球/);
  context.currentLang = 'en';
  assert.match(context.renderActivityDetailEditor(item, '1234567890', true), /Badminton/);
  context.currentLang = 'zh';
  assert.match(html, /&lt;badminton&gt;/);
  assert.match(html, /saveActivityDetail/);

  context.saveActivityDetail(id, '1234567890', '  Badminton  ');
  assert.equal(context.progressRich['1234567890'][id].date, '2026-09-01');
  assert.equal(context.progressRich['1234567890'][id].note, 'Badminton');
  assert.equal(context.pendingChanges.at(-1).note, 'Badminton');
  context.progressRich['1234567890'][id].note = 'old cloud note';
  assert.equal(context.getProgressNote('1234567890', id), 'Badminton', 'reloaded drafts show the staged note before cloud save');

  // A date-only edit with no explicit note must carry a staged activity note forward.
  context.addOrUpdatePending('1234567890', id, '2026-09-02', false);
  assert.equal(context.pendingChanges.at(-1).note, 'Badminton');
});

test('legacy transfer panel is actionable, eligibility-gated, and records only a separate equivalence marker', () => {
  const context = makeUiContext();
  vm.runInContext(extractFunctions('hasProgressRecord', 'getProgressNote'), context);
  vm.runInContext(extractFunctions('getProgressNote', 'renderLegacySegmentTag'), context);
  vm.runInContext(extractFunctions('renderLegacySegmentTag', 'resolveOtherBadgeRecord'), context);
  vm.runInContext(extractFunctions('addOrUpdatePending', 'savePendingToLocal'), context);
  vm.runInContext(extractFunctions('safeExternalUrl', 'renderLegacyTransitionPanel'), context);
  vm.runInContext(extractFunctions('renderLegacyTransitionPanel', 'queueLegacyTransfers'), context);
  vm.runInContext(extractFunctions('queueLegacyTransfers', 'removeLegacyTransfer'), context);
  vm.runInContext(extractFunctions('removeLegacyTransfer', 'openLegacyTransferForMember'), context);

  context.progressFlat['1234567890'] = { 'L3-ACT-SCOUT-101': '2019-04-12' };
  const panelHtml = context.renderLegacyTransitionPanel('1234567890', true);
  assert.match(panelHtml, /legacyEligibility_1234567890/);
  assert.match(panelHtml, /eligibilityConfirm/);
  assert.match(panelHtml, /legacy-detail-list/);
  assert.match(panelHtml, /30/);
  assert.match(panelHtml, /世界童軍環境章/);
  assert.match(panelHtml, /直接兌換項/);
  assert.match(panelHtml, /PROJECT-ACHIEVEMENT/);
  assert.match(panelHtml, /L3-ACT-SCOUT-101/);
  assert.match(panelHtml, /legacy.historyDone/);
  assert.match(panelHtml, /legacy.historyNoRecord/);
  assert.match(panelHtml, /2019-04-12/);
  context.progressFlat['1234567890']['L3-ACT-SCOUT-101'] = '2019-04-12 <img src=x onerror=alert(1)>';
  const unsafeHistoryHtml = context.renderLegacyTransitionPanel('1234567890', true);
  assert.match(unsafeHistoryHtml, /2019-04-12 &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(unsafeHistoryHtml, /<img src=x/);
  context.progressFlat['1234567890']['L3-ACT-SCOUT-101'] = '2019-04-12';

  const transfer = items.legacyTransition.quickTransfers[0];
  let eligibility = false;
  let selected = true;
  const panel = { open: false, scrollIntoView() {} };
  context.document = {
    getElementById(id) {
      if (id === 'legacyEligibility_1234567890') return { checked: eligibility };
      if (id === 'legacyTransitionDetails') return panel;
      return null;
    },
    querySelectorAll() { return selected ? [{ dataset: { transferId: transfer.id } }] : []; },
    querySelector() { return { value: '' }; }
  };
  context.renderProgressTab = () => {};

  context.queueLegacyTransfers('1234567890');
  assert.equal(context.progressFlat['1234567890'][transfer.recordId], undefined, 'no transition record is queued until eligibility is confirmed');
  assert.equal(context.__toasts.at(-1)[0], 'legacy.eligibilityConfirm');

  eligibility = true;
  context.queueLegacyTransfers('1234567890');
  assert.equal(context.progressFlat['1234567890'][transfer.recordId], '', 'an unknown old-award date stays blank');
  assert.equal(context.progressFlat['1234567890'][transfer.permissionItemId], undefined, 'transfer does not tick new checklist items');
  assert.match(context.progressRich['1234567890'][transfer.recordId].note, /P022\/2026/);
  assert.ok(context.pendingChanges.some(change => change.itemId === transfer.recordId && change.note.includes('P022/2026')));
  assert.match(context.renderLegacySegmentTag('1234567890', transfer.targetSegmentCode), /legacy\.equivalent/);
  assert.equal(panel.open, true);

  context.removeLegacyTransfer('1234567890', transfer.recordId);
  assert.equal(context.progressFlat['1234567890'][transfer.recordId], undefined);
  assert.equal(context.progressFlat['1234567890']['L3-ACT-SCOUT-101'], '2019-04-12', 'removing an equivalence marker never deletes old checklist progress');
  assert.ok(context.pendingChanges.some(change => change.itemId === transfer.recordId && change.uncomplete));
  assert.equal(context.renderLegacySegmentTag('1234567890', transfer.targetSegmentCode), '', 'removal draft hides the equivalence marker until saved');
});

test('new-scheme category/route parents cannot tick unverified child items as a group', () => {
  const context = makeUiContext();
  context.renderActivityDetailEditor = () => '';
  vm.runInContext(extractFunctions('safeExternalUrl', 'renderLegacyTransitionPanel'), context);
  vm.runInContext(extractFunctions('renderItemRow', 'escapeAttr'), context);
  vm.runInContext(extractFunctions('findProgressItemById', 'handleDateChange'), context);
  vm.runInContext(extractFunctions('checkCascading', 'updateProgressDisplay'), context);

  const parent = items.badges.find(badge => badge.id === 'L3').segments.find(segment => segment.code === 'L3-ACTIVITY').items.find(item => item.id === 'L3-ACT-V11-SPORT');
  const html = context.renderItemRow(parent, {}, '1234567890', true);
  assert.match(html, /checkbox-placeholder/);
  assert.match(html, /parentNoDirect/);
  assert.doesNotMatch(html, /handleCheckboxToggle\('L3-ACT-V11-SPORT'/, 'the category parent has no direct checkbox handler');
  assert.match(html, /handleCheckboxToggle\('L3-ACT-V11-SPORT-2X20'/, 'verified route items stay individually selectable');

  context.handleCheckboxToggle(parent.id, true, '1234567890', true);
  assert.equal(context.pendingChanges.length, 0, 'direct parent calls are rejected even if invoked manually');
  assert.equal(context.progressFlat['1234567890'], undefined);
  context.progressFlat['1234567890'] = Object.fromEntries(parent.subItems.map(item => [item.id, '2026-09-30']));
  context.checkCascading('1234567890');
  assert.equal(context.progressFlat['1234567890'][parent.id], undefined, 'cascading never creates a category-parent completion record');
});

test('Apps Script loads and preserves existing progress notes, supports optional dates, and safely saves activity detail', () => {
  const progress = makeMemorySheet('進度追蹤', [
    ['YMIS', '項目ID', '完成日期', '更新時間', '確認者', '備註'],
    ['1234567890', 'L3-ACT-SPORT-301', '2026-09-01', 'old-update', 'Leader', 'Badminton training']
  ]);
  const { context: gas } = makeGasContext({ '進度追蹤': progress });
  const loaded = gas.handleLoad();
  assert.equal(loaded.progress['1234567890']['L3-ACT-SPORT-301'].note, 'Badminton training');
  assert.equal(loaded.flatProgress['1234567890']['L3-ACT-SPORT-301'], '2026-09-01');

  gas.handleSave([{ ymis: '1234567890', itemId: 'L3-ACT-SPORT-301', date: '2026-09-02' }], 'Leader');
  assert.equal(progress._rows[1][5], 'Badminton training', 'older frontends that omit note do not erase it');
  gas.handleSave([{ ymis: '1234567890', itemId: 'L3-ACT-SPORT-301', date: '2026-09-02', note: '=formula detail' }], 'Leader');
  assert.equal(progress._rows[1][5], "'=formula detail", 'note values are formula-safe');
  gas.handleSave([{ ymis: '1234567890', itemId: 'LEGACY-V10-PROJECT-ACHIEVEMENT', date: '', note: 'P022/2026 equivalence' }], 'Leader');
  const marker = progress._rows.find(row => row[1] === 'LEGACY-V10-PROJECT-ACHIEVEMENT');
  assert.equal(marker[2], '', 'optional legacy award date remains blank');
  assert.equal(marker[5], 'P022/2026 equivalence');
});

test('Apps Script updates existing other-badge columns in place, preserves omitted notes, and deletes only on explicit uncheck', () => {
  const other = makeMemorySheet('其他獎章', [
    ['YMIS', '獎章ID', '獎章名稱', '完成日期', '證書編號', '備註', '更新時間'],
    ['1234567890', 'OT-RELIGION', 'Old Religious Badge', '2025-02-03', 'OLD-CERT', 'Keep this note', 'old-update'],
    ['1234567890', 'OT-ENV', 'World Environment Badge', '2025-03-04', 'ENV-CERT', 'Other record', 'old-update']
  ]);
  const { context: gas } = makeGasContext({ '其他獎章': other });

  gas.handleSaveOtherBadge([{ ymis: '1234567890', badgeId: 'OT-RELIGION', name: '=宗教章', date: '2026-09-10', cert: 'NEW-CERT' }]);
  assert.equal(other._rows[1][2], "'=宗教章", 'badge name is formula-safe');
  assert.equal(other._rows[1][3], '2026-09-10');
  assert.equal(other._rows[1][4], 'NEW-CERT');
  assert.equal(other._rows[1][5], 'Keep this note', 'an omitted note is preserved');
  assert.equal(typeof other._rows[1][6]?.getTime, 'function', 'updated-at stays in the seventh column');
  assert.equal(other._rows[2][1], 'OT-ENV', 'unrelated records are untouched');

  gas.handleSaveOtherBadge([{ ymis: '1234567890', badgeId: 'OT-LIFESAVING-BRONZE', name: '拯溺銅章', date: '2026-09-11', cert: 'BRONZE-1', note: '=certificate' }]);
  const bronze = other._rows.find(row => row[1] === 'OT-LIFESAVING-BRONZE');
  assert.equal(bronze[2], '拯溺銅章');
  assert.equal(bronze[3], '2026-09-11');
  assert.equal(bronze[4], 'BRONZE-1');
  assert.equal(bronze[5], "'=certificate");

  gas.handleSaveOtherBadge([{ ymis: '1234567890', badgeId: 'OT-RELIGION', uncomplete: true }]);
  assert.equal(other._rows.some(row => row[1] === 'OT-RELIGION'), false);
  assert.equal(other._rows.some(row => row[1] === 'OT-ENV'), true);
  assert.equal(other._rows.some(row => row[1] === 'OT-LIFESAVING-BRONZE'), true);
});

// The additions above are deliberately limited to current columns/tabs; no SETUP/initializeSheets is called by tests.
