/*!
 * ymis-export.js — YMIS「新增支部獎章紀錄」上傳檔（深資童軍支部，試行版）
 *
 * 由 SCOUTBADGE（童軍支部）移植，欄名依使用者提供的 YMIS 範本，獎章名稱依使用者提供的深資童軍支部字串。
 * 只輸出領袖明確指定的「成員＋獎章＋實際獲獎日期」，不會由考核完成度推斷已頒章，亦不寫回任何進度。
 * 尚未以真實資料在 YMIS 實測 —— 匯出不等於匯入成功。
 *
 * 本檔同時支援瀏覽器 (window.YmisExport) 及 Node (require)，方便寫單元測試。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YmisExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 四欄：次序及寫法必須與 YMIS 範本完全一致
  var headers = Object.freeze(['Scout ID', 'Badge-Section', 'Badge-Badge', 'Badge-award date (YYYYMMDD)']);

  // 支部固定值（深資童軍支部；寫法已由使用者確認）
  var section = 'Venture Scout';

  // [介面中文名, YMIS Badge-Badge 值]；字串已由使用者確認，逐字照抄
  var badges = Object.freeze([
    ['會員章', 'Membership Badge'],
    ['深資童軍獎章', 'The Venture Scout Award'],
    ['榮譽童軍獎章', 'The Dragon Scout Award'],
    ['英皇童軍獎章', "King's Scout Award"]
  ].map(Object.freeze));

  function isSupportedBadge(badge) {
    return badges.some(function (b) { return b[1] === badge; });
  }

  // 'YYYY-MM-DD'（<input type="date"> 的值）→ 'YYYYMMDD'；不接受其他寫法或不存在的日期
  function normalizeDate(value) {
    var s = String(value == null ? '' : value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('日期必須為 YYYY-MM-DD / Date must be YYYY-MM-DD');
    var d = new Date(s + 'T00:00:00Z');
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error('無效日期 / Invalid date: ' + s);
    return s.replace(/-/g, '');
  }

  // records: [{ymis, badge, date}]（舊欄位 scoutId 照收）→ [[Scout ID, Section, Badge, YYYYMMDD], ...]
  function buildRows(records) {
    if (!Array.isArray(records) || !records.length) throw new Error('請先選擇成員 / Select members first');
    var seen = new Set();
    return records.map(function (r) {
      r = r || {};
      var raw = r.ymis != null && r.ymis !== '' ? r.ymis : r.scoutId;
      var id = String(raw == null ? '' : raw).trim();
      if (!/^\d{10}$/.test(id)) throw new Error('SCOUT ID 必須為 10 位數字 / SCOUT ID must be 10 digits: ' + (id || '—'));
      if (!isSupportedBadge(r.badge)) throw new Error('不支援的獎章 / Unsupported badge');
      var date;
      try { date = normalizeDate(r.date); }
      catch (e) { throw new Error(id + '：' + e.message); }
      var key = id + '|' + r.badge;
      if (seen.has(key)) throw new Error('同一成員獎章重複 / Duplicate member badge: ' + id);
      seen.add(key);
      return [id, section, r.badge, date];
    });
  }

  // XLSX = SheetJS。所有儲存格以文字寫入（保留 SCOUT ID 前導零、日期不被轉成數字）。
  function workbook(XLSX, rows) {
    var ws = XLSX.utils.aoa_to_sheet([headers.slice()].concat(rows));
    ws['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 40 }, { wch: 34 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return wb;
  }

  return { headers: headers, section: section, badges: badges, normalizeDate: normalizeDate, buildRows: buildRows, workbook: workbook };
});
