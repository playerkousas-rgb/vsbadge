// ===== 批量開戶 Apps Script（直接寫入主資料表版本，vsbadge 後備）=====
// 適用：你已有一份「我們的 Sheet」（即 vsbadge 後端所用的 Google Sheet），
//       想把成員一次過寫入其中的 Users 工作表。
//
// 一般情況請優先使用前端「📥 批量開戶」（YMIS PDF／CSV／JSON），
// 本腳本只作進階後備（例如大量資料、離線整理後一次寫入）。
//
// 用法：
//   1. 在 Google Sheets 新建試算表，選單「檔案 > 匯入 > 上載 > 選取本機 CSV」匯入 members_template.csv
//      （或從 app 的「批量開戶」下載同一份 CSV 再匯入）
//   2. 擴充套件 > Apps Script，貼上本檔，儲存
//   3. 回到試算表，重新整理，出現「批量開戶」選單
//   4. 填好資料後：
//      -「✍️ 直接寫入主資料表」：最快，不需後端，直接 append 到我們的 Sheet（支援全新空白 Sheet）
//      -「📤 轉JSON並推送後端」：逐列經 app 後端 addUser（需有效管理層 token，見下方說明）
//
// 欄位：ymis,name,email,branch,role,can_tick,password,note
//   ymis      ：10 位數字（必填，作為帳號）
//   name      ：姓名（必填）
//   email     ：電郵（執委／領袖必填；團員可留空）
//   branch    ：支部／單位（例如旅團名稱）
//   role      ：member / exec_committee / branch_leader / group_leader / admin
//   can_tick  ：true / false（可否勾選進度；member 不會獲得勾選權）
//   password  ：有填則開立可登入帳號（至少 4 位；建議用 1234 作初始密碼，直接寫入會以 SHA-256 雜湊儲存，與 app 後端完全一致）
//   note      ：備註（Users 工作表無此欄，僅作填寫提醒）
//
// 直接寫入的工作表結構會與 app 後端 Users 工作表完全相同：
//   ymis,name,email,role,password_hash,branch,can_tick,auth_by,auth_date,
//   created_at,last_login,status,allowed_badges,force_change_password

var CONFIG = {
  BACKEND_URL: 'https://script.google.com/macros/s/你的部署ID/exec', // app 的 doPost 網址（用推送後端時需要）
  TOKEN: '管理層登入後的 token',      // vsbadge 帳戶管理必須用登入 token，不能只用 API Key
  MAIN_SHEET_ID: '你的主資料表ID',     // 直接寫入主資料表時使用（我們的 Sheet）
  USERS_SHEET: 'Users'                // 主資料表內存放成員的工作表名稱（需與 app 後端相同：Users）
};

// Users 工作表標準欄位（與 app 後端 initializeSheets 完全一致）
var USERS_HEADER = ['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','force_change_password'];
var VALID_ROLES = ['admin','group_leader','branch_leader','exec_committee','member'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('批量開戶')
    .addItem('✍️ 直接寫入主資料表', 'writeToMainSheet')
    .addItem('📤 轉JSON並推送後端', 'pushToBackend')
    .addItem('📝 預覽JSON', 'previewJson')
    .addToUi();
}

// 與 app 後端相同的 SHA-256 雜湊（確保直接寫入的密碼可以登入）
function hashPassword(p) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function readRows() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    headers.forEach(function (h, idx) { obj[h] = data[i][idx]; });
    if (obj.ymis) rows.push(obj);
  }
  return rows;
}

function toJson(rows) {
  return rows.map(function (r) {
    return {
      ymis: String(r.ymis).trim(),
      name: String(r.name || '').trim(),
      email: String(r.email || '').trim(),
      branch: String(r.branch || r.squad || '').trim(),
      role: String(r.role || 'member').trim(),
      can_tick: ['true', '1', 'yes', 'y', '是'].indexOf(String(r.can_tick || '').trim().toLowerCase()) >= 0,
      // v8.3：留空時預設初始密碼 1234
      password: String(r.password || '').trim() || '1234'
    };
  });
}

function previewJson() {
  var json = toJson(readRows());
  SpreadsheetApp.getUi().alert('將轉換 ' + json.length + ' 筆：\n\n' + JSON.stringify(json, null, 2).slice(0, 4000));
}

// 方法 A：透過 app 後端寫入（重複使用 addUser；vsbadge 帳戶管理必須帶管理層 token）
function pushToBackend() {
  var json = toJson(readRows());
  if (!json.length) { SpreadsheetApp.getUi().alert('沒有資料'); return; }
  var ok = 0, fail = 0, fails = [];
  json.forEach(function (m) {
    var payload = {
      action: 'addUser',
      token: CONFIG.TOKEN,
      ymis: m.ymis,
      name: m.name,
      email: m.email,
      branch: m.branch,
      role: m.role,
      can_tick: m.can_tick,
      password: m.password
    };
    try {
      var res = UrlFetchApp.fetch(CONFIG.BACKEND_URL, {
        method: 'post',
        contentType: 'text/plain',
        payload: JSON.stringify(payload)
      });
      var d = JSON.parse(res.getContentText());
      if (d.success) ok++; else { fail++; fails.push(m.ymis + ': ' + (d.error || '失敗')); }
    } catch (e) { fail++; fails.push(m.ymis + ': ' + e.message); }
  });
  SpreadsheetApp.getUi().alert('推送完成：成功 ' + ok + ' 筆，失敗 ' + fail + ' 筆' + (fails.length ? '\n\n' + fails.join('\n') : ''));
}

// 確保主資料表存在 Users 工作表；若為全新/空白工作表則自動建立標準表頭
function ensureUsersSheet(ss) {
  var sh = ss.getSheetByName(CONFIG.USERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.USERS_SHEET);
  }
  var needsHeader = true;
  if (sh.getLastRow() >= 1 && sh.getLastColumn() >= 1) {
    var firstRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    if (firstRow.indexOf('ymis') >= 0) needsHeader = false;
  }
  if (needsHeader) {
    sh.clearContents();
    sh.getRange(1, 1, 1, USERS_HEADER.length).setValues([USERS_HEADER]);
    sh.getRange(1, 1, 1, USERS_HEADER.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return { sh: sh, needsHeader: needsHeader };
}

function defaultAllowedBadges(role) {
  if (role === 'member') return '';
  if (role === 'exec_committee') return 'L1,L3-ACT,OTHER';
  return '*';
}

// 方法 B：直接寫入主資料表（不需後端，以案主資料表權限寫入）
// 支援「全新 Sheet」：自動建立 Users 工作表 + 標準表頭；密碼以 SHA-256 雜湊儲存，開戶即可登入。
function writeToMainSheet() {
  var json = toJson(readRows());
  if (!json.length) { SpreadsheetApp.getUi().alert('沒有資料'); return; }
  var ss = SpreadsheetApp.openById(CONFIG.MAIN_SHEET_ID);
  var info = ensureUsersSheet(ss);
  var sh = info.sh;

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var ymisCol = headers.indexOf('ymis');
  if (ymisCol < 0) { SpreadsheetApp.getUi().alert('主資料表找不到 ymis 欄位'); return; }

  var lastRow = sh.getLastRow();
  var existing = lastRow > 1
    ? sh.getRange(2, ymisCol + 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); })
    : [];

  // 讀取成員名單已有的 YMIS，避免重複寫入
  var mSheet = null, mExisting = {};
  try {
    mSheet = ss.getSheetByName('成員名單');
    if (mSheet && mSheet.getLastRow() > 1) {
      var mData = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 1).getValues();
      mData.forEach(function (r) { mExisting[String(r[0]).trim()] = true; });
    }
  } catch (e) { mSheet = null; }

  var nowStr = Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss');
  var added = 0, dup = 0, skipped = 0;
  json.forEach(function (m) {
    if (existing.indexOf(m.ymis) >= 0) { dup++; return; }
    if (!/^\d{10}$/.test(m.ymis)) { skipped++; return; }
    if (VALID_ROLES.indexOf(m.role) < 0) { skipped++; return; }
    var row = new Array(headers.length).fill('');
    function set(name, val) { var c = headers.indexOf(name); if (c >= 0) row[c] = (val === undefined ? '' : val); }
    set('ymis', m.ymis);
    set('name', m.name);
    set('email', m.email);
    set('role', m.role);
    set('branch', m.branch);
    set('can_tick', (m.role !== 'member' && m.can_tick) ? 'TRUE' : 'FALSE');
    // v8.3：留空時預設初始密碼 1234（仍在首次登入強制更改）
    var pass = String(m.password || '').trim() || '1234';
    set('password_hash', hashPassword(pass));
    set('auth_by', 'bulk_onboard');
    set('auth_date', nowStr);
    set('status', 'active');
    set('allowed_badges', defaultAllowedBadges(m.role));
    set('force_change_password', 'TRUE');
    set('created_at', nowStr);
    sh.appendRow(row);
    added++;
    if (mSheet && !mExisting[m.ymis]) {
      mSheet.appendRow([m.ymis, m.name, new Date(), m.branch, '']);
      mExisting[m.ymis] = true;
    }
  });
  SpreadsheetApp.getUi().alert('寫入主資料表完成：新增 ' + added + ' 筆，略過重複 ' + dup + ' 筆' + (skipped ? '，跳過無效 ' + skipped + ' 筆' : '') + (info.needsHeader ? '（已自動建立 Users 表頭）' : ''));
}
