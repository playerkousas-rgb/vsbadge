/*!
 * ymis-parse.js — 解析 YMIS「自訂報表」PDF / 文字，轉成批量開戶所需的成員陣列
 *
 * 支援的 YMIS 匯出格式（欄位次序必須為）：
 *   第一欄 童軍成員編號 → 第二欄 中文姓名 → 第三欄 電郵地址
 *
 * 本檔同時支援瀏覽器 (window.YmisParse) 及 Node (require) ，方便寫單元測試。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YmisParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var YMIS_TOKEN_RE = /\b\d{6,12}\b/;

  // 報表抬頭 / 頁尾 / 欄位標題，遇到即整行略過
  // 抬頭 / 欄名 / 頁尾等非資料列（多頁報表每頁都會重複出現）
  var SKIP_PATTERNS = [
    // 中文欄名 / 抬頭
    /童軍成員編號/, /成員編號/, /中文姓名/, /英文姓名/, /電郵地址/, /聯絡電郵/,
    /香港童軍總會/, /青少年成員資訊系統/, /自訂報表/, /報告/, /列印日期/, /列印時間/,
    /總數|合共|小計|以上/,
    // 英文欄名 / 抬頭（YMIS 報表為中英雙行標題）
    /Scout\s*Association/i, /^scout\s*id$/i, /Member\s*(No|Number|ID)/i,
    /Name\s*in\s*Chinese/i, /Chinese\s*Name/i, /^name$/i,
    /Email\s*Address/i, /^e-?mail$/i,
    /Hong\s*Kong\s*Group/i, /^group\b/i, /^district\b/i, /^region\b/i, /^total\b/i,
    // 頁碼 / 頁尾
    /^page\s*\d+/i, /page\s*\d+\s*(of|\/)\s*\d+/i, /^第\s*\d+\s*頁/, /共\s*\d+\s*頁/,
    /^\d+\s*\/\s*\d+$/,
    // 日期時間戳
    /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}([\s,]+\d{1,2}:\d{2}(:\d{2})?)?$/,
    /^\d{1,2}:\d{2}(:\d{2})?$/
  ];

  function isSkipLine(text) {
    var s = String(text || '').trim();
    if (!s) return true;
    for (var i = 0; i < SKIP_PATTERNS.length; i++) {
      if (SKIP_PATTERNS[i].test(s)) return true;
    }
    return false;
  }

  function cleanCell(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/[，、｜|]+$/g, '')
      .trim();
  }

  /**
   * 把 pdf.js 的 textContent.items 轉成「列 → 儲存格」結構。
   * @param {Array<{str:string,x:number,y:number,width?:number}>} items
   * @param {{rowTolerance?:number, cellGap?:number}} [opts]
   * @returns {Array<Array<string>>}
   */
  function itemsToRows(items, opts) {
    opts = opts || {};
    var rowTol = opts.rowTolerance == null ? 3 : opts.rowTolerance;
    var cellGap = opts.cellGap == null ? 8 : opts.cellGap;

    var list = (items || [])
      .map(function (it) {
        return {
          str: String(it.str == null ? '' : it.str),
          x: Number(it.x) || 0,
          y: Number(it.y) || 0,
          width: Number(it.width) || 0
        };
      })
      .filter(function (it) { return it.str.trim() !== ''; });

    if (!list.length) return [];

    // 依 y 由大到小（PDF 座標由下往上）分列
    list.sort(function (a, b) { return b.y - a.y || a.x - b.x; });

    var rows = [];
    var cur = null;
    list.forEach(function (it) {
      if (!cur || Math.abs(cur.y - it.y) > rowTol) {
        cur = { y: it.y, items: [] };
        rows.push(cur);
      }
      cur.items.push(it);
    });

    return rows.map(function (row) {
      row.items.sort(function (a, b) { return a.x - b.x; });
      var cells = [];
      var buf = '';
      var prevEnd = null;
      row.items.forEach(function (it) {
        if (prevEnd !== null && it.x - prevEnd > cellGap) {
          cells.push(buf);
          buf = '';
        }
        buf += it.str;
        prevEnd = it.x + (it.width || it.str.length * 6);
      });
      if (buf !== '') cells.push(buf);
      return cells.map(cleanCell).filter(function (c) { return c !== ''; });
    }).filter(function (cells) { return cells.length > 0; });
  }

  /** 把純文字（複製自 PDF / TXT）切成列 → 儲存格 */
  function textToRows(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map(function (line) {
        return line
          .split(/\t|\s{2,}|\s*[,;|｜]\s*/)
          .map(cleanCell)
          .filter(function (c) { return c !== ''; });
      })
      .filter(function (cells) { return cells.length > 0; });
  }

  function looksLikeName(s) {
    if (!s) return false;
    if (EMAIL_RE.test(s)) return false;
    if (/^\d+$/.test(s)) return false;
    if (/^\d{1,3}%$/.test(s)) return false;
    return /[\u3400-\u9fff\u00c0-\u024fA-Za-z]/.test(s);
  }

  /**
   * 由列陣列解析成員。每列預期為：童軍成員編號 / 中文姓名 / 電郵地址
   * 亦容忍欄位錯位、多餘欄位或缺電郵。
   * @param {Array<Array<string>>} rows
   * @param {{padTo10?:boolean}} [opts]
   */
  function parseRows(rows, opts) {
    opts = opts || {};
    var out = [];
    var skipped = [];
    var seen = Object.create(null);

    (rows || []).forEach(function (cells, idx) {
      var joined = cells.join(' ').trim();
      if (isSkipLine(joined)) return;

      var ymis = '';
      var email = '';
      var nameParts = [];

      cells.forEach(function (cell) {
        var c = cleanCell(cell);
        if (!c) return;
        // 1) 先抽電郵（電郵含數字，必須先移除才抽編號）
        var em = c.match(EMAIL_RE);
        if (em) {
          if (!email) email = em[0];
          c = cleanCell(c.replace(em[0], ''));
          if (!c) return;
        }
        // 2) 再抽童軍成員編號（姓名不會含 6–12 位連續數字）
        if (!ymis) {
          var num = c.match(YMIS_TOKEN_RE);
          if (num) {
            ymis = num[0];
            c = cleanCell(c.replace(num[0], ''));
            if (!c) return;
          }
        }
        // 3) 餘下視為姓名
        if (looksLikeName(c)) nameParts.push(c);
      });

      var name = nameParts.join(' ').replace(/\s+/g, ' ').trim();

      if (!ymis) {
        // 續行：長電郵被 PDF 換行拆到下一行 → 補回上一位成員
        if (email && out.length && !out[out.length - 1].email) {
          var prev = out[out.length - 1];
          prev.email = email;
          prev.warn = prev.warn.filter(function (w) { return w !== 'no_email'; });
          return;
        }
        skipped.push({ line: idx + 1, text: joined, reason: 'no_ymis' });
        return;
      }

      // 只有數字、既無姓名亦無電郵 → 多數是頁尾流水號 / 時間戳，不當成成員
      if (!name && !email) { skipped.push({ line: idx + 1, text: joined, reason: 'no_name_email' }); return; }

      var digits = ymis.replace(/\D/g, '');
      if (opts.padTo10 && digits.length < 10) digits = ('0000000000' + digits).slice(-10);

      if (seen[digits]) { skipped.push({ line: idx + 1, text: joined, reason: 'duplicate' }); return; }
      seen[digits] = true;

      var warn = [];
      if (digits.length !== 10) warn.push('ymis_len');
      if (!name) warn.push('no_name');
      if (!email) warn.push('no_email');

      out.push({ ymis: digits, name: name, email: email, warn: warn, raw: joined });
    });

    return { members: out, skipped: skipped };
  }

  /** 由 pdf.js text items 直接解析 */
  function parseItems(items, opts) {
    return parseRows(itemsToRows(items, opts), opts);
  }

  /**
   * 多頁報表：pages = [ rowsOfPage1, rowsOfPage2, ... ]
   * 每頁重複出現的抬頭／欄名／頁碼會自動略過，成員編號重複亦只取一次。
   */
  function parsePages(pages, opts) {
    var flat = [];
    var pageOf = [];
    (pages || []).forEach(function (rows, pi) {
      (rows || []).forEach(function (r) { flat.push(r); pageOf.push(pi + 1); });
    });
    var res = parseRows(flat, opts);
    res.pages = (pages || []).length;
    res.skipped.forEach(function (s) { s.page = pageOf[s.line - 1] || 1; });
    return res;
  }

  /** 由純文字解析 */
  function parseText(text, opts) {
    return parseRows(textToRows(text), opts);
  }

  function padTo10(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (!d) return '';
    return d.length >= 10 ? d.slice(-10) : ('0000000000' + d).slice(-10);
  }

  return {
    EMAIL_RE: EMAIL_RE,
    itemsToRows: itemsToRows,
    textToRows: textToRows,
    parseRows: parseRows,
    parseItems: parseItems,
    parsePages: parsePages,
    parseText: parseText,
    padTo10: padTo10,
    isSkipLine: isSkipLine
  };
});
