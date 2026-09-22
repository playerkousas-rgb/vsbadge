// ============================================================
// 深資童軍進度及行政平台 - Apps Script 後端
// 全前端帳戶管理、批量開戶、首次登入改密碼、角色驗證及操作紀錄
// 活動履歷（服務紀錄／活動紀錄／訓練班紀錄）：工作表「活動履歷」；
//   action：getLogRecords / saveLogRecord（支援批量 records[]）/ deleteLogRecord；handleLoad 回傳 logs + logsSupported
// 活動履歷申報（團員自行申報 → 領袖審批）：工作表「待批履歷」；
//   action：requestLogRecord / getLogRequests / reviewLogRequest / cancelLogRequest；handleLoad 回傳 logRequests + logRequestsSupported
// 帳戶自助申請（成員／執委／領袖）：apply 接受 requested_role（只限 member/exec_committee/branch_leader），
//   getApplications 回傳申請角色，reviewApplication 按角色開戶並回傳 final_role
// 用戶管理及唯一身份：YMIS / Email 在單筆、批量、申請及編輯流程均由後端鎖內檢查，不可重複；
//   getAllUsers 合併「Users」及「成員名單」；領袖可重設成員密碼；刪除後保留識別碼 tombstone 及歷史進度
// 密碼原則：最短 4 位；批量開戶／審批初始密碼統一 1234
// 旅系統（旅 > 團 > 進度）：上游登記下游 URL 及 SHEET KEY，經 sig 讀寫下游；下游 ALLOW_LOCAL_LOGIN 閂口後只收 sig；
//   選單「🔗 旅系統」提供匯出 JSON（含 hash）／匯入（upsertUser）／登記下游／直接入口掣
// 初始化：只有全新後端或缺少工作表才執行 initializeSheets()；升級既有部署不要重跑
// 版號只記錄在 operations/TROOP_LINK_UPGRADE.md，程式內不留版號註解
// ============================================================

const ADMIN_YMIS = '1111111111';
const ADMIN_NAME = '管理員';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASS = 'changeme';
// 自架網站時改成自己的正式 Vercel 網址，不能從登入請求讀取此 URL。
const SUPER_VERIFY_URL = 'https://vsbadge.vercel.app/api/super';
const SUPER_ADMIN_ID = 'sheep';
const SUPER_ADMIN_NAME = '管理員';
const SUPER_ADMIN_EMAIL = SUPER_ADMIN_ID + '@vsbadge.local';
const MIN_PASSWORD_LEN = 4;
const MAX_PASSWORD_LEN = 128;
const DEFAULT_TEMP_PASSWORD = '1234';

// 升級既有部署：只須更新部署版本，不要重跑 initializeSheets()，不改 Sheet 結構或資料。
// ===== 工具 =====
function getSheet() { return SpreadsheetApp.getActiveSpreadsheet(); }
function getApiKey() {
  const props = PropertiesService.getScriptProperties();
  let apiKey = props.getProperty('API_KEY');
  if (!apiKey) {
    apiKey = 'vs_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', apiKey);
  }
  return apiKey;
}
function showApiKey() {
  const apiKey = getApiKey();
  const ui = SpreadsheetApp.getUi();
  if (ui) ui.alert('API Key', '你的 API Key：\n\n' + apiKey, ui.ButtonSet.OK);
  Logger.log('API Key: ' + apiKey);
  return apiKey;
}
function hashPassword(p) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
  return raw.map(function(b){return ('0' + (b & 0xFF).toString(16)).slice(-2);}).join('');
}
function generateToken(){ return Utilities.getUuid().replace(/-/g,'') + Date.now().toString(36); }
function now(){ return Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss'); }
function formatDate(d){ if(!d) return ''; if(d instanceof Date) return Utilities.formatDate(d,'Asia/Hong_Kong','yyyy-MM-dd'); return d.toString().split(' ')[0]; }
function jsonResponse(obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

const ROLE_HIERARCHY = { 'super_admin':100,'admin':80,'group_leader':60,'branch_leader':40,'exec_committee':20,'member':0 };
const CAN_TICK_ROLES = ['admin','group_leader','branch_leader','exec_committee','super_admin'];
const CAN_MANAGE_ROLES = { 
  'super_admin': ['admin','group_leader','branch_leader','exec_committee','member'],
  'admin': ['group_leader','branch_leader','exec_committee','member'], 
  'group_leader': ['branch_leader','exec_committee','member'], 
  'branch_leader': ['exec_committee','member'] 
};
function canUserTick(r){ return CAN_TICK_ROLES.indexOf(r)>=0; }
function getRoleLevel(r){ return ROLE_HIERARCHY[r]||0; }
function canManageRole(m,t){ return (CAN_MANAGE_ROLES[m]||[]).indexOf(t)>=0; }

const USER_HEADERS = ['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','force_change_password'];
const VALID_ROLES = ['admin','group_leader','branch_leader','exec_committee','member'];
// 公開申請入口只接受這三個角色；團長／管理員必須由現任管理層在「用戶管理」直接開立
const APPLY_ROLES = ['member','exec_committee','branch_leader'];
// 活動履歷
const LOG_SHEET_NAME = '活動履歷';
const LOG_HEADERS = ['record_id','type','ymis','name','date','title','role','hours','cert_no','detail','recorder','recorded_at','updated_at'];
const LOG_TYPES = ['service','activity','training'];
// 待批履歷（團員自行申報 → 領袖審批）
const LOG_REQ_SHEET_NAME = '待批履歷';
const LOG_REQ_HEADERS = ['request_id','kind','target_record_id','type','ymis','name','date','title','role','hours','cert_no','detail','status','created_at','reviewed_by','reviewed_at','review_note'];
function isTrue(v){ return v===true || String(v).toUpperCase()==='TRUE' || String(v)==='1'; }
function safeSheetText(v,maxLen){
  let text=String(v||'').trim().substring(0,maxLen||200);
  if(/^[=+\-@]/.test(text)) text="'"+text;
  return text;
}
function getHeaderMap(sheet){
  const map={};
  if(!sheet || sheet.getLastColumn()<1) return map;
  sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].forEach(function(h,i){ map[String(h).trim()]=i; });
  return map;
}
function ensureUserColumns(sheet){
  const map=getHeaderMap(sheet);
  USER_HEADERS.forEach(function(h){
    if(map[h]===undefined){
      const col=sheet.getLastColumn()+1;
      sheet.getRange(1,col).setValue(h);
      map[h]=col-1;
    }
  });
  return map;
}
function ensureSeedAccount(sheet,map,dataRows,acc){
  // 只在完全找不到相同帳號（同 YMIS 或同 Email）時補回，避免覆蓋既有管理員資料。
  if(!sheet || !map || map.ymis===undefined) return false;
  const id=String(acc.ymis||'').toLowerCase();
  const email=String(acc.email||'').toLowerCase();
  for(let i=1;i<dataRows.length;i++){
    const rowId=String(dataRows[i][map.ymis]||'').toLowerCase();
    const rowEmail=map.email===undefined?'':String(dataRows[i][map.email]||'').toLowerCase();
    if(rowId===id || (email && rowEmail===email)) return false;
  }
  const row=new Array(sheet.getLastColumn()||USER_HEADERS.length).fill('');
  function set(name,val){ const idx=map[name]; if(idx!==undefined) row[idx]=val; }
  set('ymis',acc.ymis); set('name',acc.name); set('email',acc.email||'');
  set('role',acc.role||'member'); set('password_hash',hashPassword(acc.password||''));
  set('branch',acc.branch||''); set('can_tick',acc.can_tick!==false);
  set('auth_by',acc.auth_by||'system'); set('auth_date',now()); set('created_at',now());
  set('last_login',''); set('status','active');
  set('allowed_badges',acc.allowed_badges||defaultAllowedBadges(acc.role||'member'));
  set('force_change_password',acc.force_change_password!==false);
  sheet.appendRow(row);
  return true;
}
function accountIdKey(v){ return String(v||'').trim().toLowerCase(); }
function emailKey(v){ return String(v||'').trim().toLowerCase(); }
function isEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'').trim()); }
function userFromRow(row,map){
  function v(name){ const i=map[name]; return i===undefined ? '' : row[i]; }
  return {
    ymis:String(v('ymis')||'').trim(), name:String(v('name')||''), email:String(v('email')||'').trim(),
    role:String(v('role')||'member'), can_tick:isTrue(v('can_tick')), branch:String(v('branch')||''),
    allowed_badges:String(v('allowed_badges')||''), status:String(v('status')||'active')||'active',
    force_change_password:isTrue(v('force_change_password')), has_account:true
  };
}
function findUserRecord(ymis){
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const map=ensureUserColumns(sheet); const data=sheet.getDataRange().getValues(); const target=accountIdKey(ymis);
  for(let i=1;i<data.length;i++) if(accountIdKey(data[i][map.ymis])===target) return {sheet:sheet,row:i+1,map:map,data:data[i],user:userFromRow(data[i],map)};
  return null;
}
function findMemberRecord(ymis){
  const sheet=getSheet().getSheetByName('成員名單'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues(); const target=accountIdKey(ymis);
  for(let i=1;i<data.length;i++){
    if(accountIdKey(data[i][0])===target){
      return {sheet:sheet,row:i+1,data:data[i],member:{
        ymis:String(data[i][0]||'').trim(), name:String(data[i][1]||''),
        branch:String(data[i][3]||''), contact:String(data[i][4]||'')
      }};
    }
  }
  return null;
}
// 檢查所有帳戶（包括停用／已刪除）及成員名單，確保 YMIS / Email 不會屬於兩個不同身份。
function identifierConflict(ymis,email,excludeYmis){
  const targetId=accountIdKey(ymis); const targetEmail=emailKey(email); const excluded=accountIdKey(excludeYmis);
  const uSheet=getSheet().getSheetByName('Users');
  if(uSheet){
    const map=ensureUserColumns(uSheet); const data=uSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const rowId=accountIdKey(data[i][map.ymis]);
      if(excluded && rowId===excluded) continue;
      if(targetId && rowId===targetId) return 'YMIS 已存在（包括停用或已刪除帳號）';
      if(targetEmail && emailKey(data[i][map.email])===targetEmail) return 'Email 已存在（包括停用或已刪除帳號）';
    }
  }
  const mSheet=getSheet().getSheetByName('成員名單');
  if(mSheet){
    const data=mSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const rowId=accountIdKey(data[i][0]); const rowEmail=isEmail(data[i][4])?emailKey(data[i][4]):'';
      // 同一位成員由名單開立帳戶時可沿用自己的 YMIS / Email；只阻止另一位身份使用。
      if(targetEmail && rowEmail===targetEmail && rowId!==targetId && rowId!==excluded) return 'Email 已由另一位成員使用';
    }
  }
  return '';
}
function defaultAllowedBadges(role){
  if(role==='member') return '';
  if(role==='exec_committee') return 'L1,L3-ACT,OTHER';
  return '*';
}
function writeAudit(actor,action,target,detail){
  const sh=getSheet().getSheetByName('操作紀錄');
  if(sh) sh.appendRow([now(),actor||'',action||'',target||'',detail||'']);
}
function canManageUser(manager,targetRole){ return manager && (manager.role==='super_admin' || canManageRole(manager.role,targetRole)); }
function canCreateRole(manager,targetRole){ return manager && (manager.role==='super_admin' || (manager.role==='admin' && targetRole==='admin') || canManageRole(manager.role,targetRole)); }

function getActiveGroupLeader(){
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const map=ensureUserColumns(sheet); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    const user=userFromRow(data[i],map);
    if(user.role==='group_leader' && user.status==='active') return user;
  }
  return null;
}

function getNextLeaderId(){
  let maxNum=0;
  const uSheet=getSheet().getSheetByName('Users');
  if(uSheet){
    const data=uSheet.getDataRange().getValues();
    const map=ensureUserColumns(uSheet);
    const yCol=map.ymis!==undefined?map.ymis:0;
    for(let i=1;i<data.length;i++){
      const y=String(data[i][yCol]||'').trim();
      const m=y.match(/^L(\d+)$/i);
      if(m){ const n=parseInt(m[1],10); if(n>maxNum) maxNum=n; }
    }
  }
  const aSheet=getSheet().getSheetByName('Applications');
  if(aSheet){
    const data=aSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const y=String(data[i][1]||'').trim();
      const m=y.match(/^L(\d+)$/i);
      if(m){ const n=parseInt(m[1],10); if(n>maxNum) maxNum=n; }
    }
  }
  return 'L'+String(maxNum+1).padStart(4,'0');
}

function isSuperAdminId(id){
  const v=String(id||'').trim().toLowerCase();
  return v===String(SUPER_ADMIN_ID).trim().toLowerCase() || v===String(SUPER_ADMIN_EMAIL).trim().toLowerCase();
}
function isSuperAdminReserved(ymis,email){
  return accountIdKey(ymis)===accountIdKey(SUPER_ADMIN_ID) ||
         (emailKey(email)!=='' && emailKey(email)===emailKey(SUPER_ADMIN_EMAIL));
}
function getSuperAdminUser(){
  return {
    ymis:String(SUPER_ADMIN_ID), name:String(SUPER_ADMIN_NAME), email:String(SUPER_ADMIN_EMAIL),
    role:'super_admin', can_tick:true, branch:'b4', allowed_badges:'*',
    status:'active', force_change_password:false
  };
}
// 升級後在編輯器執行一次，只授權 UrlFetch，不讀寫 Sheet。
function authorizeConnection(){
  const response=UrlFetchApp.fetch(SUPER_VERIFY_URL,{muteHttpExceptions:true});
  if(response.getResponseCode()!==405) throw new Error('連線服務未就緒，請檢查部署設定');
  return '連線正常，請更新 Apps Script 既有部署至新版本';
}
function verifySuperTicket(ticket){
  if(typeof ticket!=='string' || ticket.length>4096) return false;
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return false;
  try{
    const cache=CacheService.getScriptCache();
    const cacheKey='super-ticket:'+hashPassword(ticket);
    if(cache.get(cacheKey)) return false;
    const response=UrlFetchApp.fetch(SUPER_VERIFY_URL, {
      method:'post', contentType:'application/json', muteHttpExceptions:true,
      payload:JSON.stringify({ticket:ticket, apikey:getApiKey(), backend:ScriptApp.getService().getUrl()})
    });
    if(response.getResponseCode()!==200 || JSON.parse(response.getContentText()).ok!==true) return false;
    cache.put(cacheKey,'used',120);
    return true;
  }catch(e){ return false; }
  finally{ lock.releaseLock(); }
}
function setSuperAdminLastLogin(){
  PropertiesService.getScriptProperties().setProperty('SUPER_ADMIN_LAST_LOGIN', now());
}
function removeSuperAdminFromSheet(sheet,map,dataRows){
  if(!sheet || !map || map.ymis===undefined) return;
  for(let i=dataRows.length-1;i>=1;i--){
    const id=String(dataRows[i][map.ymis]||'').trim();
    const email=(map.email===undefined)?'':String(dataRows[i][map.email]||'').trim();
    if(isSuperAdminReserved(id,email)) sheet.deleteRow(i+1);
  }
}

// ===== 初始化 =====
function initializeSheets() {
  const ss = getSheet();
  let pSheet = ss.getSheetByName('進度追蹤');
  if(!pSheet){
    pSheet = ss.insertSheet('進度追蹤');
    pSheet.appendRow(['YMIS','項目 ID','完成日期','更新時間','確認者','備註']);
    pSheet.getRange(1,1,1,6).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    pSheet.setFrozenRows(1);
  } else {
    // ensure 6 columns header
    if(pSheet.getLastColumn()<6){
      pSheet.getRange(1,5).setValue('確認者'); pSheet.getRange(1,6).setValue('備註');
    }
  }
  let mSheet = ss.getSheetByName('成員名單');
  if(!mSheet){
    mSheet = ss.insertSheet('成員名單');
    mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡']);
    mSheet.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    mSheet.setFrozenRows(1);
  }
  let uSheet = ss.getSheetByName('Users');
  if(!uSheet){
    uSheet = ss.insertSheet('Users');
    uSheet.appendRow(USER_HEADERS);
    uSheet.getRange(1,1,1,USER_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    uSheet.setFrozenRows(1);
  }
  // 確保 Users 欄位完整，並補回內置管理員帳號。
  const userMap=ensureUserColumns(uSheet);
  removeSuperAdminFromSheet(uSheet,userMap,uSheet.getDataRange().getValues());
  const userRows=uSheet.getDataRange().getValues();
  ensureSeedAccount(uSheet,userMap,userRows,{ymis:ADMIN_YMIS,name:ADMIN_NAME,email:ADMIN_EMAIL,role:'admin',password:ADMIN_PASS,branch:'b4',can_tick:true,force_change_password:true});
  // 舊版本會自動補上新欄，不需手動改 Sheet；仍使用預設密碼的舊管理員會被要求立即更改。
  for(let i=1;i<userRows.length;i++){
    if(String(userRows[i][userMap.password_hash]||'')===hashPassword(ADMIN_PASS)) uSheet.getRange(i+1,userMap.force_change_password+1).setValue(true);
  }
  let aSheet = ss.getSheetByName('Applications');
  if(!aSheet){
    aSheet = ss.insertSheet('Applications');
    aSheet.appendRow(['app_id','ymis','name','email','role','branch','status','applied_at','reviewed_by','reviewed_at','note']);
    aSheet.getRange(1,1,1,11).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    aSheet.setFrozenRows(1);
  }
  let tSheet = ss.getSheetByName('Tokens');
  if(!tSheet){
    tSheet = ss.insertSheet('Tokens');
    tSheet.appendRow(['token','ymis','created_at','expires_at']);
    tSheet.getRange(1,1,1,4).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    tSheet.setFrozenRows(1);
  }
  let cSheet = ss.getSheetByName('SystemConfig');
  if(!cSheet){
    cSheet = ss.insertSheet('SystemConfig');
    cSheet.appendRow(['key','value','updated_at','updated_by']);
    cSheet.getRange(1,1,1,4).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    cSheet.setFrozenRows(1);
    cSheet.appendRow(['login_mode','standalone',now(),'system']);
    cSheet.appendRow(['admin_email',ADMIN_EMAIL,now(),'system']);
  }
  // 新增：待批完成表
  let prSheet = ss.getSheetByName('待批完成');
  if(!prSheet){
    prSheet = ss.insertSheet('待批完成');
    prSheet.appendRow(['request_id','ymis','name','item_id','item_name','requested_date','evidence','status','created_at','reviewed_by','reviewed_at','review_note','confirmed_date']);
    prSheet.getRange(1,1,1,13).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    prSheet.setFrozenRows(1);
  }
  // 其他獎章紀錄表
  let oSheet = ss.getSheetByName('其他獎章');
  if(!oSheet){
    oSheet = ss.insertSheet('其他獎章');
    oSheet.appendRow(['YMIS','獎章 ID','獎章名稱','完成日期','證書編號','備註','更新時間']);
    oSheet.getRange(1,1,1,7).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    oSheet.setFrozenRows(1);
  }
  // 前端管理操作審計
  let auditSheet = ss.getSheetByName('操作紀錄');
  if(!auditSheet){
    auditSheet = ss.insertSheet('操作紀錄');
    auditSheet.appendRow(['時間','操作者','操作','對象','詳情']);
    auditSheet.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    auditSheet.setFrozenRows(1);
  }
  // 活動履歷（服務／活動／訓練班紀錄，統一用 type 欄位區分）
  let lSheet = ss.getSheetByName(LOG_SHEET_NAME);
  if(!lSheet){
    lSheet = ss.insertSheet(LOG_SHEET_NAME);
    lSheet.appendRow(LOG_HEADERS);
    lSheet.getRange(1,1,1,LOG_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    lSheet.setFrozenRows(1);
  }
  // 待批履歷（團員自行申報 → 領袖審批；批准後寫入／更新「活動履歷」）
  let lrSheet = ss.getSheetByName(LOG_REQ_SHEET_NAME);
  if(!lrSheet){
    lrSheet = ss.insertSheet(LOG_REQ_SHEET_NAME);
    lrSheet.appendRow(LOG_REQ_HEADERS);
    lrSheet.getRange(1,1,1,LOG_REQ_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    lrSheet.setFrozenRows(1);
  }
  // 確保系統設定有 allow_member_view_others
  let cfgSheet = ss.getSheetByName('SystemConfig');
  if(cfgSheet){
    const cfgData=cfgSheet.getDataRange().getValues();
    let hasAllow=false;
    for(let i=1;i<cfgData.length;i++){ if(cfgData[i][0]==='allow_member_view_others'){ hasAllow=true; break; } }
    if(!hasAllow){
      cfgSheet.appendRow(['allow_member_view_others','false',now(),'system']);
    }
  }

  const apiKey = getApiKey();
  let scriptUrl=''; try{ scriptUrl=ScriptApp.getService().getUrl(); }catch(e){ scriptUrl='請部署為網頁應用程式後查看';}
  try{
    const ui=SpreadsheetApp.getUi();
    if(ui){
      ui.alert('✅ 初始化完成！\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章、操作紀錄、活動履歷、待批履歷\n\n🔑 API Key:\n'+apiKey+'\n\n👤 管理員 YMIS: '+ADMIN_YMIS+' 臨時密碼: '+ADMIN_PASS+'（首次登入必須更改）\n🔢 密碼最短 4 位；批量／審批初始密碼預設 '+DEFAULT_TEMP_PASSWORD+'\n\n🌐 URL:\n'+scriptUrl+'\n\n🔗 旅系統：本節點 BACKEND／APIKEY 見選單「🔗 旅系統 → 顯示 BACKEND／APIKEY」；登記資料不寫入工作表');
    }
  }catch(e){}
  return {success:true,apiKey:apiKey,scriptUrl:scriptUrl};
}

// ===== 用戶查詢 =====
function getUser(ymis){
  if(isSuperAdminId(ymis)) return getSuperAdminUser();
  const rec=findUserRecord(ymis);
  return rec && rec.user.status==='active' ? rec.user : null;
}
function getUserByEmail(email){
  if(!email) return null;
  if(emailKey(email)===emailKey(SUPER_ADMIN_EMAIL)) return getSuperAdminUser();
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const map=ensureUserColumns(sheet); const data=sheet.getDataRange().getValues(); const target=emailKey(email);
  for(let i=1;i<data.length;i++){
    const user=userFromRow(data[i],map);
    if(emailKey(user.email)===target && user.status==='active') return user;
  }
  return null;
}
function getAllUsers(){
  const users=[]; const accountIds={};
  const sheet=getSheet().getSheetByName('Users');
  if(sheet){
    const map=ensureUserColumns(sheet); const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const user=userFromRow(data[i],map); const key=accountIdKey(user.ymis);
      if(key) accountIds[key]=true; // 已刪除帳號也要保留識別碼，不能由成員名單重新浮現
      if(user.ymis && user.status!=='deleted' && !isSuperAdminReserved(user.ymis,user.email)) users.push(user);
    }
  }
  // 舊有「成員名單」可能只有進度身份、未在 Users 開立登入。合併顯示，讓領袖可編輯、刪除或直接開戶。
  const mSheet=getSheet().getSheetByName('成員名單');
  if(mSheet){
    const data=mSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const ymis=String(data[i][0]||'').trim(); const key=accountIdKey(ymis);
      if(!key || accountIds[key] || isSuperAdminId(ymis)) continue;
      const contact=String(data[i][4]||'').trim();
      users.push({
        ymis:ymis, name:String(data[i][1]||''), email:isEmail(contact)?contact:'', contact:contact,
        role:'member', can_tick:false, branch:String(data[i][3]||''), allowed_badges:'',
        status:'active', force_change_password:false, has_account:false
      });
    }
  }
  return users;
}

// Token
function validateToken(token){
  if(!token) return null;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0]===token){
      if(isSuperAdminId(String(data[i][1])) && !String(token).startsWith('vs-super-v1-')) return null;
      if(new Date()>new Date(data[i][3])){ sheet.deleteRow(i+1); return null; }
      return data[i][1].toString();
    }
  }
  return null;
}
function createToken(ymis){
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const token=(isSuperAdminId(ymis)?'vs-super-v1-':'')+generateToken(); const exp=new Date(); exp.setHours(exp.getHours()+24*30);
  sheet.appendRow([token,ymis,now(),Utilities.formatDate(exp,'Asia/Hong_Kong','yyyy-MM-dd HH:mm:ss')]);
  return token;
}
function destroyToken(token){
  if(!token) return;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===token){ sheet.deleteRow(i+1); return; } }
}

// ===== 旅系統：上下游接駁（旅 > 團 > 進度）=====
// 同一份 Code.gs 部署在每一層，每層都是一個節點：
//   上游在自己 Script Properties 登記下游的 1) GAS /exec URL  2) 下游 SHEET KEY（下游的 API_KEY），
//   登記後上游可讀可寫下游（進了上游就等於進了下游）。
//   下游 Script Properties 的 ALLOW_LOCAL_LOGIN 係「直接入口」掣：未設定＝開啟（現有旅團零影響）；
//   設成 false＝閂口，之後下游只接受帶有效 sig 的上游請求。
// 同步安全：開咗上游之後，用戶可自行決定幾時閂下游入口（搬完舊數先閂）。
// 登記資料、sig、nonce 全部只存 Script Properties / Cache，一律不寫入任何工作表。
const LINK_FLAG='ALLOW_LOCAL_LOGIN';
const LINK_DOWNSTREAM_PREFIX='DOWNSTREAM_';
const LINK_SIG_PURPOSE='vsbadge-troop-sig-v1';
const LINK_SIG_WINDOW_MS=5*60*1000;
const LINK_SIG_NONCE_TTL=600;
const LINK_MAX_SIGNED_BYTES=900000;
const LINK_EXEC_URL_RE=/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;
const LINK_SIG_HEX_RE=/^[0-9a-f]{64}$/i;
const LINK_NONCE_RE=/^[0-9A-Za-z_-]{8,64}$/;
const LINK_HASH_RE=/^[0-9a-f]{64}$/i;
const LINK_RESERVED_BODY_KEYS=['sig','sig_ts','sig_nonce'];
// 上游以 sig 可以在下游執行的 action。login／apply／logout／changePassword 等本地憑證操作永不接受。
const LINK_SIG_READ_ACTIONS=['load','getLoginMode','getLinkState','getMembers','getConfig','getAllUsers','getOtherBadges','getPendingRequests','getApplications','getLogRecords','getLogRequests','getAuditLog'];
const LINK_SIG_WRITE_ACTIONS=['save','saveOtherBadge','requestComplete','reviewRequest','addMember','addUser','bulkAddUsers','upsertUser','importUsers','resetPassword','updateUserProfile','setUserStatus','deleteUser','updateUserRole','updatePermissions','saveLogRecord','deleteLogRecord','reviewLogRequest','setLocalLogin'];
const USER_EXPORT_FORMAT='vsbadge-users-export';

function linkProps(){ return PropertiesService.getScriptProperties(); }
function toHex(bytes){ let out=''; for(let i=0;i<bytes.length;i++) out+=('0'+(bytes[i]&0xFF).toString(16)).slice(-2); return out; }
function sha256Hex(text){ return hashPassword(String(text===undefined||text===null?'':text)); }
function hmacSha256Hex(message,key){ return toHex(Utilities.computeHmacSha256Signature(String(message),String(key))); }
// sig 密鑰以用途分隔方式由「該節點的 SHEET KEY」推導：
//   驗證入站 → 用本機 API_KEY（上游登記的就是這條）；簽署出站 → 用已登記的下游 SHEET KEY。
// 推導結果唔另外儲存、唔寫入工作表。
function linkSigKeyFor(key){ return hmacSha256Hex(LINK_SIG_PURPOSE,String(key||'')); }
function linkSigKey(){ return linkSigKeyFor(getApiKey()); }
function linkNonce(){ return Utilities.getUuid().replace(/-/g,''); }
// 常數時間比較：兩邊先各自 SHA-256 再比對，避免逐字元短路洩漏
function safeEqualText(a,b){ return sha256Hex(String(a||''))===sha256Hex(String(b||'')); }
function linkCanonical(action,ts,nonce,digest){ return [String(action||''),String(ts||''),String(nonce||''),String(digest||'')].join('\n'); }
function maskSecret(v){ v=String(v||''); return v.length<=12?'****':v.substring(0,8)+'…'+v.substring(v.length-4); }
// 上游傳來的操作者標籤：只留安全字元，避免經 auth_by／操作紀錄寫入工作表時變成算式
function linkActorLabel(v){
  const cleaned=String(v||'').trim().replace(/[^0-9A-Za-z_.@-]/g,'').substring(0,40);
  return cleaned||'upstream';
}
function getLinkNodeId(){ try{ return safeSheetText(getSheet().getName()||'node',80)||'node'; }catch(e){ return 'node'; } }

// ---- 直接入口掣（寫在下游 Script Properties）----
function localLoginAllowed(){
  const v=String(linkProps().getProperty(LINK_FLAG)||'').trim().toLowerCase();
  if(!v) return true;
  return ['1','true','yes','on','open'].indexOf(v)>=0;
}
function setLocalLoginAllowed(allow,actor){
  linkProps().setProperty(LINK_FLAG,allow?'true':'false');
  writeAudit(actor||'system',allow?'link_local_login_on':'link_local_login_off',getLinkNodeId(),allow?'直接入口開啟':'直接入口已閂，只收上游 sig');
  return allow?'true':'false';
}
function linkClosedResponse(action){
  return {
    success:false, local_login:false, upstream_only:true,
    error:'此後端的直接入口已閂（'+LINK_FLAG+'=false），只接受上游簽名（sig）請求；請由上游（旅／團）入口登入。'+(action?'（已拒絕：'+action+'）':'')
  };
}
function getLinkState(){
  return {
    success:true, node:getLinkNodeId(),
    allow_local_login:localLoginAllowed(),
    link_flag_set:String(linkProps().getProperty(LINK_FLAG)||'')==='false'?'false':(String(linkProps().getProperty(LINK_FLAG)||'')?'true':'（未設定＝開啟）'),
    downstreams:listDownstreams(),
    api_key_masked:maskSecret(getApiKey()),
    export_format:USER_EXPORT_FORMAT
  };
}

// ---- sig 產生／驗證 ----
function stripLinkSigFields(body){
  const out={};
  for(const k in (body||{})){ if(LINK_RESERVED_BODY_KEYS.indexOf(k)>=0) continue; out[k]=(body||{})[k]; }
  return out;
}
// 兩種傳送方式共用同一套驗證：
//   query：?sig=&sts=&snonce=     digest = SHA-256(原始 body 字串)
//   body ：{...,sig,sig_ts,sig_nonce}  digest = SHA-256(JSON.stringify(去掉三個 sig 欄位後的 body))
// 上游一次送齊兩種，GAS 302 轉址即使遺失其中一種仍可驗證。
function readLinkSig(e,body,rawBody){
  const params=(e&&e.parameter)||{};
  const qSig=String(params.sig||''),qTs=String(params.sts||''),qNonce=String(params.snonce||'');
  if(qSig&&qTs&&qNonce) return {sig:qSig,ts:qTs,nonce:qNonce,digest:sha256Hex(String(rawBody||'')),transport:'query'};
  const bSig=String((body&&body.sig)||''),bTs=String((body&&body.sig_ts)||''),bNonce=String((body&&body.sig_nonce)||'');
  if(bSig&&bTs&&bNonce){
    let canonicalPayload='';
    try{ canonicalPayload=JSON.stringify(stripLinkSigFields(body)); }catch(err){ return null; }
    return {sig:bSig,ts:bTs,nonce:bNonce,digest:sha256Hex(canonicalPayload),transport:'body'};
  }
  return null;
}
function makeLinkSig(action,rawPayload,key){
  const ts=String(Date.now()),nonce=linkNonce();
  return {sig:hmacSha256Hex(linkCanonical(action,ts,nonce,sha256Hex(String(rawPayload||''))),linkSigKeyFor(key)),ts:ts,nonce:nonce};
}
function verifyLinkSig(e,body,rawBody){
  try{
    const s=readLinkSig(e,body,rawBody);
    if(!s) return false;
    if(String(rawBody||'').length>LINK_MAX_SIGNED_BYTES) return false;
    if(!LINK_SIG_HEX_RE.test(String(s.sig))) return false;
    if(!LINK_NONCE_RE.test(String(s.nonce))) return false;
    const ts=parseInt(s.ts,10);
    if(!isFinite(ts)||Math.abs(Date.now()-ts)>LINK_SIG_WINDOW_MS) return false;
    const action=String((body&&body.action)||'');
    if(!safeEqualText(hmacSha256Hex(linkCanonical(action,s.ts,s.nonce,s.digest),linkSigKey()),s.sig)) return false;
    // 防重放：同一 nonce 只可用一次（CacheService，不入工作表）。
    // 一次請求可能同時帶 query 及 body 兩組 sig；兩組 nonce 都要消耗，
    // 否則「第一次只驗到其中一組」時，重放可用另一組 nonce 再入一次。
    const cache=CacheService.getScriptCache();
    const nonces=[String(s.nonce)];
    const queryNonce=String(((e&&e.parameter)||{}).snonce||'');
    const bodyNonce=String((body&&body.sig_nonce)||'');
    [queryNonce,bodyNonce].forEach(function(n){
      if(LINK_NONCE_RE.test(n)&&nonces.indexOf(n)<0) nonces.push(n);
    });
    const keys=nonces.map(function(n){ return 'link-nonce:'+sha256Hex(n).substring(0,40); });
    for(let i=0;i<keys.length;i++){ if(cache.get(keys[i])) return false; }
    for(let i=0;i<keys.length;i++){ cache.put(keys[i],'1',LINK_SIG_NONCE_TTL); }
    return true;
  }catch(err){ return false; }
}

// ---- 上游：登記下游（只存 Script Properties，不寫入 SHEET）----
function normalizeLinkId(id){ return String(id||'').trim().replace(/[^0-9A-Za-z_-]/g,'').substring(0,32); }
function isTrustedDownstreamUrl(url){ return LINK_EXEC_URL_RE.test(String(url||'').trim()); }
function registerDownstream(id,url,key,name){
  id=normalizeLinkId(id);
  if(!id) return {success:false,error:'下游編號不可留空（只可用英文、數字、底線、連字號）'};
  if(!isTrustedDownstreamUrl(url)) return {success:false,error:'下游 URL 必須是正式 GAS /exec（https://script.google.com/macros/s/.../exec）'};
  key=String(key||'').trim();
  if(key.length<8) return {success:false,error:'下游 SHEET KEY 太短；請抄下游 Script Properties 的 API_KEY'};
  const props=linkProps();
  props.setProperty(LINK_DOWNSTREAM_PREFIX+id+'_URL',String(url).trim().replace(/\/$/,''));
  props.setProperty(LINK_DOWNSTREAM_PREFIX+id+'_KEY',key);
  props.setProperty(LINK_DOWNSTREAM_PREFIX+id+'_NAME',String(name||'').trim().substring(0,80));
  props.setProperty(LINK_DOWNSTREAM_PREFIX+id+'_AT',now());
  writeAudit('system','link_register_downstream',id,'已登記下游 URL 及 SHEET KEY（只存 Script Properties）');
  return {success:true,id:id,message:'已登記下游 '+id};
}
function getDownstream(id){
  id=normalizeLinkId(id);
  if(!id) return null;
  const props=linkProps();
  const url=String(props.getProperty(LINK_DOWNSTREAM_PREFIX+id+'_URL')||'').trim();
  const key=String(props.getProperty(LINK_DOWNSTREAM_PREFIX+id+'_KEY')||'').trim();
  if(!url||!key) return null;
  return {id:id,url:url,key:key,name:String(props.getProperty(LINK_DOWNSTREAM_PREFIX+id+'_NAME')||''),registered_at:String(props.getProperty(LINK_DOWNSTREAM_PREFIX+id+'_AT')||'')};
}
function listDownstreams(){
  const props=linkProps(),ids={},all=props.getProperties();
  for(const k in all){
    const m=String(k).match(/^DOWNSTREAM_(.+)_URL$/);
    if(m) ids[m[1]]=true;
  }
  const out=[];
  for(const id in ids){
    const d=getDownstream(id);
    if(!d) continue;
    out.push({id:d.id,name:d.name,registered_at:d.registered_at,url_masked:maskSecret(d.url),has_key:true});
  }
  out.sort(function(a,b){ return String(a.id).localeCompare(String(b.id)); });
  return out;
}
function removeDownstream(id){
  id=normalizeLinkId(id);
  if(!id) return {success:false,error:'下游編號不正確'};
  const props=linkProps();
  ['_URL','_KEY','_NAME','_AT'].forEach(function(s){ props.deleteProperty(LINK_DOWNSTREAM_PREFIX+id+s); });
  writeAudit('system','link_remove_downstream',id,'已移除下游登記');
  return {success:true,message:'已移除下游 '+id};
}
// 上游打下游：body 內含 sig（digest 綁 action + 原始 body），query 再帶一組 sig（digest 綁完整 body）
function callDownstream(downstreamId,action,payload){
  const d=getDownstream(downstreamId);
  if(!d) return {success:false,error:'未登記下游 '+downstreamId+'：請先登記下游 URL 及 SHEET KEY'};
  if(String(action||'')==='') return {success:false,error:'缺少 action'};
  let rawOutgoing='';
  try{
    const body=stripLinkSigFields(payload||{});
    body.action=action;
    const rawPayload=JSON.stringify(body);
    const inner=makeLinkSig(action,rawPayload,d.key);
    body.sig=inner.sig; body.sig_ts=inner.ts; body.sig_nonce=inner.nonce;
    rawOutgoing=JSON.stringify(body);
    const outer=makeLinkSig(action,rawOutgoing,d.key);
    const url=d.url+'?sig='+encodeURIComponent(outer.sig)+'&sts='+encodeURIComponent(outer.ts)+'&snonce='+encodeURIComponent(outer.nonce);
    const response=UrlFetchApp.fetch(url,{
      method:'post', contentType:'application/json', payload:rawOutgoing,
      muteHttpExceptions:true, followRedirects:true, validateHttpsCertificates:true
    });
    const code=response.getResponseCode();
    const text=response.getContentText();
    let json=null; try{ json=JSON.parse(text); }catch(err){ json=null; }
    if(!json) return {success:false,error:'下游回應異常（HTTP '+code+'）：請檢查下游部署版本、存取權（任何人）及登記的 SHEET KEY'};
    return json;
  }catch(err){
    return {success:false,error:'無法連接下游：'+(err&&err.message?err.message:String(err))};
  }
}
function pingDownstream(downstreamId){ return callDownstream(downstreamId,'getLinkState',{}); }
// 掣在上游：由上游閂／開下游的直接入口
function setDownstreamLocalLogin(downstreamId,allow){
  const r=callDownstream(downstreamId,'setLocalLogin',{allow:allow?'true':'false'});
  if(r&&r.success) writeAudit('system','link_set_downstream_gate',normalizeLinkId(downstreamId),allow?'下游直接入口開啟':'下游直接入口已閂（只收 sig）');
  return r;
}

// ---- 開戶：上游揀團開戶，經 sig 落下游寫 ----
function linkManager(body){
  const onBehalf=linkActorLabel(body&&body.on_behalf);
  const role=VALID_ROLES.indexOf(String((body&&body.on_behalf_role)||''))>=0?String(body.on_behalf_role):'admin';
  return {ymis:onBehalf,name:'上游同步（'+onBehalf+'）',role:role,can_tick:true};
}
function createAccountForDownstream(downstreamId,rawUser,manager){
  const d=getDownstream(downstreamId);
  if(!d) return {success:false,error:'未登記下游 '+downstreamId+'：請先登記下游 URL 及 SHEET KEY'};
  const local=createUsersBatch([rawUser],manager);
  if(!local.success||local.created!==1){
    return {success:false,error:(local.results&&local.results[0]&&local.results[0].error)||local.error||'上游開戶失敗',results:local.results};
  }
  const created=(local.results&&local.results[0])||{};
  const rec=findUserRecord(created.ymis);
  if(!rec) return {success:false,error:'上游已開戶但讀不回帳戶，未能同步下游'};
  const map=rec.map;
  const mirror={
    ymis:rec.user.ymis,name:rec.user.name,email:rec.user.email,role:rec.user.role,branch:rec.user.branch,
    can_tick:rec.user.can_tick,allowed_badges:rec.user.allowed_badges,status:'active',force_change_password:true,
    password_hash:String(rec.data[map.password_hash]||'')
  };
  const pushed=callDownstream(downstreamId,'upsertUser',{user:mirror,on_behalf:linkActorLabel(manager&&manager.ymis)});
  if(!pushed||pushed.success!==true){
    return {success:false,error:'上游已開戶，但下游寫入失敗：'+((pushed&&pushed.error)||'下游無回應'),ymis:mirror.ymis,downstream:normalizeLinkId(downstreamId)};
  }
  writeAudit(linkActorLabel(manager&&manager.ymis),'link_push_user',safeSheetText(mirror.ymis,40),'帳戶已同步至下游 '+normalizeLinkId(downstreamId));
  return {success:true,ymis:mirror.ymis,name:mirror.name,downstream:normalizeLinkId(downstreamId),message:'上游已開戶並經 sig 同步下游'};
}

// ---- 吐 JSON（搬舊數）：匯出含 hash，只寫去 Drive，绝不寫入工作表 ----
function collectUsersForExport(){
  const sheet=getSheet().getSheetByName('Users');
  const out=[];
  if(!sheet) return out;
  const map=ensureUserColumns(sheet);
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    const ymis=String(data[i][map.ymis]||'').trim();
    if(!ymis) continue;
    out.push({
      ymis:ymis,
      name:String(data[i][map.name]||''),
      email:String(data[i][map.email]||''),
      role:String(data[i][map.role]||'member'),
      branch:String(data[i][map.branch]||''),
      can_tick:isTrue(data[i][map.can_tick]),
      allowed_badges:String(data[i][map.allowed_badges]||''),
      status:String(data[i][map.status]||'active')||'active',
      force_change_password:isTrue(data[i][map.force_change_password]),
      password_hash:String(data[i][map.password_hash]||''),
      auth_by:String(data[i][map.auth_by]||''),
      created_at:data[i][map.created_at]?String(data[i][map.created_at]):'',
      last_login:data[i][map.last_login]?String(data[i][map.last_login]):''
    });
  }
  return out;
}
function buildUsersExport(){
  const users=collectUsersForExport();
  return {format:USER_EXPORT_FORMAT,schema:1,exported_at:now(),node:getLinkNodeId(),count:users.length,users:users};
}
function exportUsersJsonText(){ return JSON.stringify(buildUsersExport(),null,2); }
function exportUsersJson(){
  const payload=buildUsersExport();
  const count=payload.count;
  const stamp=Utilities.formatDate(new Date(),'Asia/Hong_Kong','yyyyMMdd-HHmmss');
  let fileId='',fileUrl='',driveError='';
  try{
    const ssFile=DriveApp.getFileById(getSheet().getId());
    const folder=ssFile.getParents().hasNext()?ssFile.getParents().next():DriveApp.getRootFolder();
    const file=folder.createFile('vsbadge-users-'+stamp+'.json',JSON.stringify(payload,null,2),'application/json');
    try{ file.setSharingAccess(DriveApp.Access.PRIVATE); file.setSharingPermission(DriveApp.Permission.NONE); }catch(e){}
    fileId=file.getId(); fileUrl=file.getUrl();
  }catch(e){ driveError=(e&&e.message)?e.message:String(e); }
  writeAudit('system','export_users_json',count+' accounts',fileId?('Drive 檔 '+fileId+'（含 hash，匯入後請刪除）'):('Drive 寫入失敗：'+driveError+'；JSON 已輸出到執行紀錄'));
  try{ Logger.log(JSON.stringify(payload,null,2)); }catch(e){}
  return {success:true,count:count,file_id:fileId,file_url:fileUrl,drive_error:driveError,payload:payload};
}

// ---- 匯入：逐個 upsertUser 直插 hash（保留舊密碼）----
function syncMemberRow(ymis,name,branch,email,status){
  if(status==='deleted') return;
  let mSheet=getSheet().getSheetByName('成員名單');
  if(!mSheet){ mSheet=getSheet().insertSheet('成員名單'); mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡']); }
  const rec=findMemberRecord(ymis);
  if(rec){
    if(name) rec.sheet.getRange(rec.row,2).setValue(name);
    if(rec.sheet.getLastColumn()>=4&&branch) rec.sheet.getRange(rec.row,4).setValue(branch);
    if(rec.sheet.getLastColumn()>=5&&email) rec.sheet.getRange(rec.row,5).setValue(email);
    return;
  }
  mSheet.appendRow([ymis,name||'',new Date(),branch||'',email||'']);
}
// upsertUser：搬數專用寫入。只接受 64 位 SHA-256 password_hash，不接受明文密碼；
// 既有帳戶（同 YMIS，或同 Email 認回同一身份）→ 更新；冇提供 hash 就保留原密碼。
function upsertUser(raw,actor){
  raw=raw||{};
  actor=linkActorLabel(actor);
  const ymis=String(raw.ymis||'').trim();
  const email=String(raw.email||'').trim().substring(0,160);
  const hash=String(raw.password_hash||'').trim().toLowerCase();
  if(!ymis) return {success:false,ymis:'',error:'缺少 YMIS'};
  if(raw.password!==undefined&&raw.password!==null&&String(raw.password)!=='') return {success:false,ymis:ymis,error:'匯入不可帶明文 password；請只用 password_hash'};
  if(hash&&!LINK_HASH_RE.test(hash)) return {success:false,ymis:ymis,error:'password_hash 必須是 64 位 SHA-256 hex'};
  if(!/^\d{10}$/.test(ymis)&&!/^L\d+$/i.test(ymis)) return {success:false,ymis:ymis,error:'YMIS 須為 10 位數字或 L 編號'};
  if(email&&!isEmail(email)) return {success:false,ymis:ymis,error:'Email 格式不正確'};
  const role=VALID_ROLES.indexOf(String(raw.role||''))>=0?String(raw.role):'member';
  if(isSuperAdminReserved(ymis,email)) return {success:false,ymis:ymis,error:'此帳號已被保留'};
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(20000)) return {success:false,ymis:ymis,error:'系統正處理另一項寫入，請稍後重試'};
  try{
    let sheet=getSheet().getSheetByName('Users');
    if(!sheet){ sheet=getSheet().insertSheet('Users'); sheet.appendRow(USER_HEADERS); }
    const map=ensureUserColumns(sheet);
    const data=sheet.getDataRange().getValues();
    let row=-1;
    for(let i=1;i<data.length;i++){ if(accountIdKey(data[i][map.ymis])===accountIdKey(ymis)){ row=i+1; break; } }
    if(row<0&&email){ for(let i=1;i<data.length;i++){ if(emailKey(data[i][map.email])===emailKey(email)){ row=i+1; break; } } }
    if(row<0&&!hash) return {success:false,ymis:ymis,error:'新增帳戶必須帶 password_hash（匯入只接受 hash）'};
    if(row<0){
      const conflict=identifierConflict(ymis,email,'');
      if(conflict) return {success:false,ymis:ymis,error:conflict};
    }
    const existingName=row>0?String(data[row-1][map.name]||''):'';
    const name=safeSheetText(raw.name,100)||existingName;
    const branch=safeSheetText(raw.branch,100);
    const status=['active','inactive','deleted'].indexOf(String(raw.status||''))>=0?String(raw.status):'active';
    const canTick=canUserTick(role)&&(raw.can_tick===undefined?role!=='member':isTrue(raw.can_tick));
    const allowed=String(raw.allowed_badges===undefined||raw.allowed_badges===null?'':raw.allowed_badges);
    const force=raw.force_change_password===undefined?false:isTrue(raw.force_change_password);
    if(!name) return {success:false,ymis:ymis,error:'姓名不可留空'};
    if(row>0){
      function setCol(colName,val){ if(map[colName]!==undefined) sheet.getRange(row,map[colName]+1).setValue(val); }
      setCol('name',name);
      if(email) setCol('email',email);
      setCol('role',role);
      if(branch) setCol('branch',branch);   // 冇帶 branch 就唔洗走下游既有支部
      setCol('can_tick',canTick);
      setCol('status',status);
      setCol('force_change_password',force);
      if(hash) setCol('password_hash',hash);
      if(allowed!=='') setCol('allowed_badges',allowed);
      else if(!String(data[row-1][map.allowed_badges]||'')) setCol('allowed_badges',defaultAllowedBadges(role));
      setCol('auth_by',actor);
      setCol('auth_date',now());
      syncMemberRow(ymis,name,branch,email,status);
      writeAudit(actor,'link_upsert_update',ymis,'上游／匯入更新帳戶'+(hash?'（直插 hash）':'（保留原密碼）'));
      return {success:true,ymis:ymis,action:'updated',password_kept:!hash};
    }
    const width=Math.max(sheet.getLastColumn(),USER_HEADERS.length);
    const newRow=new Array(width).fill('');
    newRow[map.ymis]=ymis; newRow[map.name]=name; newRow[map.email]=email; newRow[map.role]=role;
    newRow[map.password_hash]=hash; newRow[map.branch]=branch; newRow[map.can_tick]=canTick;
    newRow[map.auth_by]=actor; newRow[map.auth_date]=now();
    newRow[map.created_at]=String(raw.created_at||'')||now();
    newRow[map.last_login]=String(raw.last_login||'');
    newRow[map.status]=status;
    newRow[map.allowed_badges]=allowed!==''?allowed:defaultAllowedBadges(role);
    newRow[map.force_change_password]=force;
    sheet.appendRow(newRow);
    syncMemberRow(ymis,name,branch,email,status);
    writeAudit(actor,'link_upsert_create',ymis,'上游／匯入新增帳戶（直插 hash，保留舊密碼）');
    return {success:true,ymis:ymis,action:'created',password_kept:false};
  } finally { lock.releaseLock(); }
}
function handleUpsertUser(raw,actor){ return jsonResponse(upsertUser(raw,actor)); }
function importUsersFromText(text,actor){
  actor=linkActorLabel(actor);
  let parsed=null;
  try{ parsed=JSON.parse(String(text||'')); }catch(e){ return {success:false,error:'JSON 格式不正確：'+((e&&e.message)||e)}; }
  const list=Array.isArray(parsed)?parsed:((parsed&&Array.isArray(parsed.users))?parsed.users:null);
  if(!list) return {success:false,error:'找不到 users 陣列；請使用「匯出 JSON（含 hash）」產生的檔案'};
  if(!list.length) return {success:true,count:0,created:0,updated:0,failed:0,results:[],message:'檔案內沒有帳戶'};
  if(list.length>2000) return {success:false,error:'一次最多匯入 2000 筆，請分批'};
  const results=[];
  let created=0,updated=0,failed=0;
  for(let i=0;i<list.length;i++){
    const r=upsertUser(list[i],actor);
    if(r&&r.success){ if(r.action==='created') created++; else updated++; }
    else failed++;
    results.push({ymis:String((list[i]&&list[i].ymis)||''),success:!!(r&&r.success),action:(r&&r.action)||'',error:(r&&r.error)||''});
  }
  writeAudit(actor,'link_import_users','新增 '+created+'／更新 '+updated,'失敗 '+failed+'（共 '+list.length+' 筆）');
  return {success:failed===0,count:list.length,created:created,updated:updated,failed:failed,results:results,message:'匯入完成：新增 '+created+'、更新 '+updated+'、失敗 '+failed};
}
function importUsersFromDrive(fileIdOrUrl,actor){
  const input=String(fileIdOrUrl||'').trim();
  if(!input) return {success:false,error:'請貼上 Drive 檔案 ID 或連結'};
  const matched=input.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  const fileId=matched?matched[1]:input.replace(/\?.*$/,'');
  let text='';
  try{ text=DriveApp.getFileById(fileId).getBlob().getDataAsString(); }
  catch(e){ return {success:false,error:'讀不到 Drive 檔案：'+((e&&e.message)||e)}; }
  return importUsersFromText(text,actor);
}
function handleSignedImport(body,actor){
  if(Array.isArray(body.users)) return jsonResponse(importUsersFromText(JSON.stringify({users:body.users}),actor));
  if(typeof body.json==='string') return jsonResponse(importUsersFromText(body.json,actor));
  if(typeof body.drive_file_id==='string') return jsonResponse(importUsersFromDrive(body.drive_file_id,actor));
  return jsonResponse({success:false,error:'importUsers 需要 users[]、json 字串或 drive_file_id'});
}

// ---- 下游：簽名請求路由 ----
function handleSignedRequest(action,body){
  if(LINK_SIG_READ_ACTIONS.indexOf(action)<0&&LINK_SIG_WRITE_ACTIONS.indexOf(action)<0){
    return jsonResponse({success:false,error:'上游簽名請求不接受此操作：'+action});
  }
  const manager=linkManager(body);
  const actor=manager.ymis;
  if(LINK_SIG_WRITE_ACTIONS.indexOf(action)>=0){
    writeAudit('upstream','link_signed_'+action,actor,safeSheetText(body.on_behalf_name,80)+'（sig 已驗證）');
  }
  if(action==='getLinkState') return jsonResponse(getLinkState());
  if(action==='setLocalLogin'){
    const allow=['1','true','yes','on','open'].indexOf(String(body.allow||'').trim().toLowerCase())>=0;
    setLocalLoginAllowed(allow,'upstream:'+actor);
    return jsonResponse({success:true,allow_local_login:allow,message:allow?'直接入口已開啟':'直接入口已閂，只收上游 sig'});
  }
  if(action==='load') return handleLoad();
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone',local_login:localLoginAllowed(),upstream_only:!localLoginAllowed()});
  if(action==='getMembers') return jsonResponse({success:true,members:getMembers()});
  if(action==='getConfig') return handleGetConfig();
  if(action==='getAllUsers') return jsonResponse({success:true,users:getAllUsers()});
  if(action==='getOtherBadges') return handleGetOtherBadges(String(body.target_ymis||''));
  if(action==='getPendingRequests') return handleGetPendingRequests();
  if(action==='getApplications') return handleGetApplications();
  if(action==='getLogRecords') return handleGetLogRecords();
  if(action==='getLogRequests') return jsonResponse({success:true,requests:getLogRequestsList(null)});
  if(action==='getAuditLog') return handleGetAuditLog();
  if(action==='save') return handleSave(body.changes||[],String(body.confirmer||actor));
  if(action==='saveOtherBadge') return handleSaveOtherBadge(body.records||[]);
  if(action==='requestComplete') return handleRequestComplete(body,actor);
  if(action==='reviewRequest') return handleReviewRequest(body.request_id,body.decision,body.review_note,actor,body.confirmed_date);
  if(action==='addMember') return handleAddMember(body.ymis,body.name,body.branch||'',actor);
  if(action==='addUser') return handleAddUser(body,manager);
  if(action==='bulkAddUsers') return handleBulkAddUsers(body.users||[],manager);
  if(action==='upsertUser') return handleUpsertUser(body.user||body,actor);
  if(action==='importUsers') return handleSignedImport(body,actor);
  if(action==='resetPassword') return handleResetPassword(body.target_ymis,body.new_password,manager);
  if(action==='updateUserProfile') return handleUpdateUserProfile(body,manager);
  if(action==='setUserStatus') return handleSetUserStatus(body.target_ymis,body.status,manager);
  if(action==='deleteUser') return handleDeleteUser(body.target_ymis,manager);
  if(action==='updateUserRole'||action==='updatePermissions') return handleUpdateUserRole(body.target_ymis,body.new_role,body.can_tick,actor,body.allowed_badges);
  if(action==='saveLogRecord') return handleSaveLogRecord(body.records||(body.record?[body.record]:[]),actor,String(body.recorder_name||''));
  if(action==='deleteLogRecord') return handleDeleteLogRecord(body.record_id,actor);
  if(action==='reviewLogRequest') return handleReviewLogRequest(body.request_id,body.decision,body.review_note,manager);
  return jsonResponse({success:false,error:'上游簽名請求不接受此操作：'+action});
}

// ===== API =====
function doGet(e){
  const action=String((e&&e.parameter&&e.parameter.action)||'');
  // 旅系統：閂口後直接入口一律拒絕（只收上游 sig；簽名請求一律走 doPost）
  if(!localLoginAllowed()) return jsonResponse(linkClosedResponse(action));
  if(action==='load'){
    // Legacy load compatibility: if an API key is provided, it must validate.
    const reqKey=e.parameter.apikey;
    if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
    return handleLoad();
  }
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone',local_login:true});
  return jsonResponse({success:false,error:'Unknown action'});
}
function doPost(e){
  try{
    const rawBody=String((e&&e.postData&&e.postData.contents)||'{}');
    const body=JSON.parse(rawBody||'{}');
    const action=String(body.action||'');
    // 旅系統：上游簽名（sig）請求優先路由；未簽名時才檢查直接入口掣
    if(verifyLinkSig(e,body,rawBody)) return handleSignedRequest(action,body);
    if(!localLoginAllowed()) return jsonResponse(linkClosedResponse(action));
    if(action==='login') return handleLogin(body.login_id,body.password,body.super_ticket);
    if(action==='logout'){ destroyToken(body.token); return jsonResponse({success:true}); }
    // 公開入口接受成員／執委／領袖申請（角色在 handleApply 內嚴格驗證）；
    // 支部／單位由前端自動帶入所屬旅團名稱，毋須申請人填寫。
    if(action==='apply') return handleApply(body.ymis,body.name,body.email,body.requested_role||'member',body.branch);

    // 兼容舊部署／Portal：進度寫入可用有效 token 或 API key；帳戶管理絕不接受 API key 代替登入。
    if(action==='save' || action==='saveOtherBadge'){
      const validKey=body.apikey && body.apikey===getApiKey();
      const tokenYmis=body.token ? validateToken(body.token) : null;
      if(!validKey && !tokenYmis) return jsonResponse({success:false,error:'未授權 - 請重新登入'});
      if(tokenYmis){ const writer=getUser(tokenYmis); if(!writer || !canUserTick(writer.role) || writer.can_tick!==true) return jsonResponse({success:false,error:'帳號沒有直接寫入進度權限'}); }
      if(action==='save') return handleSave(body.changes||[], body.confirmer||tokenYmis||'');
      return handleSaveOtherBadge(body.records||[]);
    }
    if(action==='requestComplete'){
      const requester=body.token ? validateToken(body.token) : null;
      if(!requester) return jsonResponse({success:false,error:'未授權，請重新登入'});
      return handleRequestComplete(body,requester);
    }

    const ymis=validateToken(body.token);
    if(!ymis) return jsonResponse({success:false,error:'Token 無效或過期'});
    const user=getUser(ymis);
    if(!user) return jsonResponse({success:false,error:'找不到用戶或帳號已停用'});

    if(action==='getConfig') return handleGetConfig();
    if(action==='getMembers') return jsonResponse({success:true,members:getMembers()});
    if(action==='getOtherBadges') return handleGetOtherBadges(body.target_ymis||ymis);
    if(action==='changePassword') return handleChangePassword(ymis,body.old_password,body.new_password);
    if(action==='getPendingRequests') return handleGetPendingRequests();
    if(action==='reviewRequest'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleReviewRequest(body.request_id,body.decision,body.review_note,ymis,body.confirmed_date);
    }
    // 活動履歷（服務／活動／訓練班紀錄）。讀取任何登入者可；寫入／刪除需已獲勾選權限的領袖（同進度寫入）。
    if(action==='getLogRecords') return handleGetLogRecords();
    if(action==='saveLogRecord'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleSaveLogRecord(body.records||(body.record?[body.record]:[]), ymis, body.recorder_name||'');
    }
    if(action==='deleteLogRecord'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleDeleteLogRecord(body.record_id, ymis);
    }
    // 活動履歷申報（團員自行申報 → 領袖審批）。
    //   - requestLogRecord：任何登入者可為「自己」申報新增／修改（修改只限自己的紀錄，批准後需領袖重批才更新）
    //   - reviewLogRequest：需已獲勾選權限的領袖（同進度審批）
    //   - 其他流程（待批完成／其他獎章）不變：批准後只有領袖可改
    if(action==='requestLogRecord') return handleRequestLogRecord(body, user);
    if(action==='getLogRequests') return handleGetLogRequests(user);
    if(action==='reviewLogRequest'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleReviewLogRequest(body.request_id, body.decision, body.review_note, user);
    }
    if(action==='cancelLogRequest') return handleCancelLogRequest(body.request_id, user);

    // 所有帳戶及用戶管理均由前端操作，但必須使用管理層登入 token。
    if(action==='getAllUsers'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足，只有管理層可查看用戶'});
      return jsonResponse({success:true,users:getAllUsers()});
    }
    if(action==='addMember'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'只有管理層可以新增成員'});
      return handleAddMember(body.ymis,body.name,body.branch||'',ymis);
    }
    if(action==='addUser'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'只有管理層可以新增帳號'});
      return handleAddUser(body,user);
    }
    if(action==='bulkAddUsers'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'只有管理層可以批量開戶'});
      return handleBulkAddUsers(body.users||[],user);
    }
    if(action==='resetPassword'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleResetPassword(body.target_ymis,body.new_password,user);
    }
    if(action==='updateUserProfile'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserProfile(body,user);
    }
    if(action==='setUserStatus'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleSetUserStatus(body.target_ymis,body.status,user);
    }
    if(action==='deleteUser'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleDeleteUser(body.target_ymis,user);
    }
    if(action==='getApplications'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足，需支部領袖或以上'});
      return handleGetApplications();
    }
    if(action==='reviewApplication'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleReviewApplication(body.app_id,body.decision,body.review_note,user,body.temp_password);
    }
    if(action==='updateUserRole' || action==='updatePermissions'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserRole(body.target_ymis,body.new_role,body.can_tick,ymis,body.allowed_badges);
    }
    if(action==='updateConfig'){
      const key=body.key;
      if(key==='allow_member_view_others'){
        if(getRoleLevel(user.role)<60) return jsonResponse({success:false,error:'需團長以上權限'});
      }else if(getRoleLevel(user.role)<80){
        return jsonResponse({success:false,error:'需管理員權限'});
      }
      return handleUpdateConfig(key,body.value,ymis);
    }
    if(action==='getAuditLog'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'需支部領袖以上權限'});
      return handleGetAuditLog();
    }
    return jsonResponse({success:false,error:'Unknown action'});
  }catch(err){ return jsonResponse({success:false,error:err && err.message ? err.message : String(err)}); }
}

// ===== 邏輯 =====
function handleLogin(loginId,password,superTicket){
  loginId=String(loginId||'').trim();
  if(!loginId||(!password&&!superTicket)) return jsonResponse({success:false,error:'請填寫帳號和密碼'});
  const user=getUser(loginId)||getUserByEmail(loginId);
  if(!user) return jsonResponse({success:false,error:'找不到此帳號或帳號已停用'});
  if(isSuperAdminId(user.ymis)){
    if(!verifySuperTicket(superTicket)) return jsonResponse({success:false,error:'帳號或密碼錯誤'});
    setSuperAdminLastLogin();
    const token=createToken(user.ymis);
    return jsonResponse({success:true,token:token,user:user,force_change_password:user.force_change_password});
  }
  const rec=findUserRecord(user.ymis);
  const map=rec.map;
  if(String(rec.data[map.password_hash]||'')!==hashPassword(String(password))) return jsonResponse({success:false,error:'密碼錯誤'});
  rec.sheet.getRange(rec.row,map.last_login+1).setValue(now());
  const token=createToken(user.ymis);
  return jsonResponse({success:true,token:token,user:user,force_change_password:user.force_change_password});
}
function handleChangePassword(ymis,oldP,newP){
  newP=String(newP||'');
  if(newP.length<MIN_PASSWORD_LEN) return jsonResponse({success:false,error:'新密碼至少 '+MIN_PASSWORD_LEN+' 位'});
  if(newP.length>MAX_PASSWORD_LEN) return jsonResponse({success:false,error:'新密碼不可超過 '+MAX_PASSWORD_LEN+' 位'});
  if(newP===String(oldP||'')) return jsonResponse({success:false,error:'新密碼不可與原密碼相同'});
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'此帳號不支援在此更改密碼，請聯絡管理員'});
  const rec=findUserRecord(ymis);
  if(!rec || rec.user.status!=='active') return jsonResponse({success:false,error:'找不到用戶'});
  if(String(rec.data[rec.map.password_hash]||'')!==hashPassword(String(oldP||''))) return jsonResponse({success:false,error:'原密碼錯誤'});
  rec.sheet.getRange(rec.row,rec.map.password_hash+1).setValue(hashPassword(newP));
  rec.sheet.getRange(rec.row,rec.map.force_change_password+1).setValue(false);
  rec.sheet.getRange(rec.row,rec.map.auth_date+1).setValue(now());
  writeAudit(ymis,'change_password',ymis,'用戶自行更改密碼');
  return jsonResponse({success:true,message:'密碼已更新'});
}
function handleApply(ymis,name,email,role,branch){
  ymis=String(ymis||'').trim(); name=safeSheetText(name,100); email=String(email||'').trim().substring(0,160); branch=safeSheetText(branch,100);
  role=String(role||'member');
  if(APPLY_ROLES.indexOf(role)<0) return jsonResponse({success:false,error:'無效的申請角色'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});

  if(role==='branch_leader'){
    if(!email) return jsonResponse({success:false,error:'領袖申請必須填寫聯絡電郵'});
    if(!isEmail(email)) return jsonResponse({success:false,error:'Email 格式不正確'});
  }else{
    if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'YMIS 須為 10 位數字'});
    if(email && !isEmail(email)) return jsonResponse({success:false,error:'Email 格式不正確'});
    if(role!=='member' && !email) return jsonResponse({success:false,error:'執委申請必須填寫聯絡電郵'});
  }

  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return jsonResponse({success:false,error:'系統正處理另一個申請，請稍後重試'});
  try{
    // 領袖角色免 YMIS；在鎖內編號，避免兩個同時申請取得相同 L 編號。
    if(role==='branch_leader' && (!ymis || !/^\d{10}$/.test(ymis))) ymis=getNextLeaderId();
    if(isSuperAdminReserved(ymis,email)) return jsonResponse({success:false,error:'此帳號已被保留，請使用其他帳號'});
    const conflict=identifierConflict(ymis,email,'');
    // 成員名單內相同 YMIS 是同一身份，可申請其登入帳戶；identifierConflict 只會阻止 Users 或別人的 Email。
    if(conflict) return jsonResponse({success:false,error:conflict});

    const sheet=getSheet().getSheetByName('Applications');
    if(!sheet) return jsonResponse({success:false,error:'Applications 工作表不存在，請先執行 initializeSheets()'});
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][6])==='pending'){
        if(accountIdKey(data[i][1])===accountIdKey(ymis)) return jsonResponse({success:false,error:'此 YMIS 已有待審批申請'});
        if(email && emailKey(data[i][3])===emailKey(email)) return jsonResponse({success:false,error:'此 Email 已有待審批申請'});
      }
    }
    sheet.appendRow(['APP_'+Date.now(),ymis,name,email,role,branch||'b4','pending',now(),'','','']);
    return jsonResponse({success:true,message:'申請已提交，請等待領袖在前端審批'});
  } finally { lock.releaseLock(); }
}
function handleGetApplications(){
  const sheet=getSheet().getSheetByName('Applications'); const apps=[];
  if(!sheet) return jsonResponse({success:true,applications:apps});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++) if(String(data[i][6])==='pending') apps.push({app_id:String(data[i][0]),ymis:String(data[i][1]),name:String(data[i][2]),email:String(data[i][3]||''),requested_role:String(data[i][4]||'member'),branch:String(data[i][5]||''),applied_at:data[i][7]?formatDate(data[i][7]):''});
  return jsonResponse({success:true,applications:apps});
}
function generateTemporaryPassword(){ return DEFAULT_TEMP_PASSWORD; }
function handleReviewApplication(appId,decision,note,manager,tempPassword){
  if(decision!=='approved' && decision!=='rejected') return jsonResponse({success:false,error:'無效決定'});
  const sheet=getSheet().getSheetByName('Applications'); if(!sheet) return jsonResponse({success:false,error:'找不到 Applications 工作表'});
  const data=sheet.getDataRange().getValues(); let rowIndex=-1,app=null;
  for(let i=1;i<data.length;i++) if(String(data[i][0])===String(appId)){ rowIndex=i+1; app=data[i]; break; }
  if(!app || String(app[6])!=='pending') return jsonResponse({success:false,error:'找不到待審批申請'});
  if(decision==='rejected'){
    sheet.getRange(rowIndex,7).setValue('rejected'); sheet.getRange(rowIndex,9).setValue(manager.ymis); sheet.getRange(rowIndex,10).setValue(now()); sheet.getRange(rowIndex,11).setValue(note||'');
    writeAudit(manager.ymis,'reject_application',String(app[1]),String(appId));
    return jsonResponse({success:true,message:'已拒絕申請'});
  }
  const password=String(tempPassword||generateTemporaryPassword());
  // 審批申請最多開出支部領袖，連手改 Sheet 造假都退回成員；不允許開出團長
  const requestedRole=String(app[4]||'member');
  const finalRole=(APPLY_ROLES.indexOf(requestedRole)>=0 && canManageUser(manager,requestedRole)) ? requestedRole : 'member';
  const appYmis=String(app[1]||'').trim();
  const appName=String(app[2]||'').trim();
  const appEmail=String(app[3]||'').trim();
  const result=createUsersBatch([{ymis:appYmis,name:appName,email:appEmail,branch:String(app[5]||''),role:finalRole,can_tick:finalRole!=='member',password:password}],manager);
  if(!result.success || result.created!==1) return jsonResponse({success:false,error:(result.results&&result.results[0]&&result.results[0].error)||'建立帳號失敗'});
  sheet.getRange(rowIndex,7).setValue('approved'); sheet.getRange(rowIndex,9).setValue(manager.ymis); sheet.getRange(rowIndex,10).setValue(now()); sheet.getRange(rowIndex,11).setValue(note||'');
  writeAudit(manager.ymis,'approve_application',appYmis,String(appId));
  const createdUser = result.results[0] || {};
  return jsonResponse({success:true,message:'已批准並建立帳號',temp_password:password,final_role:finalRole,ymis:createdUser.ymis||appYmis,name:appName,email:appEmail});
}
function handleUpdateUserRole(targetYmis,newRole,canTick,managerYmis,allowedBadges){
  const manager=getUser(managerYmis); const rec=findUserRecord(targetYmis);
  if(!manager || !rec || rec.user.status!=='active') return jsonResponse({success:false,error:'找不到管理員或目標用戶'});
  if(String(targetYmis)===String(managerYmis)) return jsonResponse({success:false,error:'不可更改自己的角色或權限'});
  const role=String(newRole||rec.user.role);
  if(VALID_ROLES.indexOf(role)<0) return jsonResponse({success:false,error:'無效角色'});
  if(!canManageUser(manager,rec.user.role) || !canManageUser(manager,role)) return jsonResponse({success:false,error:'你的角色不可管理此用戶或設定此層級'});

  // 團長鎖死一位：已有現任團長就拒絕，並顯示現任姓名
  if(role==='group_leader' && rec.user.role!=='group_leader'){
    const activeGsl=getActiveGroupLeader();
    if(activeGsl && String(activeGsl.ymis)!==String(targetYmis)){
      return jsonResponse({success:false,error:'團長只能有一位，全團已有現任團長（'+activeGsl.name+'）。如需更換，請先將現任團長轉為其他角色。'});
    }
  }

  const tick=canUserTick(role) && isTrue(canTick);
  rec.sheet.getRange(rec.row,rec.map.role+1).setValue(role);
  rec.sheet.getRange(rec.row,rec.map.can_tick+1).setValue(tick);
  rec.sheet.getRange(rec.row,rec.map.auth_by+1).setValue(managerYmis);
  rec.sheet.getRange(rec.row,rec.map.auth_date+1).setValue(now());
  if(allowedBadges!==undefined && allowedBadges!==null) rec.sheet.getRange(rec.row,rec.map.allowed_badges+1).setValue(String(allowedBadges));
  else if(role!==rec.user.role) rec.sheet.getRange(rec.row,rec.map.allowed_badges+1).setValue(defaultAllowedBadges(role));
  writeAudit(managerYmis,'update_role',targetYmis,rec.user.role+' → '+role+', can_tick='+tick);
  return jsonResponse({success:true});
}
function handleUpdateConfig(key,value,ymis){
  const sheet=getSheet().getSheetByName('SystemConfig'); const data=sheet.getDataRange().getValues(); let found=false;
  for(let i=1;i<data.length;i++) if(data[i][0]===key){ sheet.getRange(i+1,2).setValue(value); sheet.getRange(i+1,3).setValue(now()); sheet.getRange(i+1,4).setValue(ymis); found=true; break; }
  if(!found) sheet.appendRow([key,value,now(),ymis]);
  writeAudit(ymis,'update_config',key,String(value));
  return jsonResponse({success:true});
}
function handleGetConfig(){
  const sheet=getSheet().getSheetByName('SystemConfig');
  const cfg={};
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(data[i][0]) cfg[data[i][0].toString()]=data[i][1]?data[i][1].toString():'';
    }
  }
  // 默認值
  if(!cfg['allow_member_view_others']) cfg['allow_member_view_others']='false';
  return jsonResponse({success:true,config:cfg});
}
function getMembers(){
  const mSheet=getSheet().getSheetByName('成員名單'); const members=[]; const seen={};
  if(mSheet){
    const data=mSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(!data[i][0]) continue;
      const y=String(data[i][0]).trim(); const key=accountIdKey(y);
      if(!key || seen[key]) continue;
      members.push({ymis:y,name:data[i][1]?String(data[i][1]):''}); seen[key]=true;
    }
  }
  const uSheet=getSheet().getSheetByName('Users');
  if(uSheet){
    const map=ensureUserColumns(uSheet); const data=uSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const user=userFromRow(data[i],map); const key=accountIdKey(user.ymis);
      if(user.status==='active' && key && !isSuperAdminId(user.ymis) && !seen[key]){
        members.push({ymis:user.ymis,name:user.name}); seen[key]=true;
      }
    }
  }
  return members;
}
function handleLoad(){
  const ss=getSheet();
  const pSheet=ss.getSheetByName('進度追蹤'); const progress={};
  if(pSheet){ const data=pSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const ymis=data[i][0].toString(); if(!ymis) continue; if(!progress[ymis]) progress[ymis]={}; progress[ymis][data[i][1].toString()]={date:data[i][2]?formatDate(data[i][2]):'',confirmer:data[i][4]?data[i][4].toString():''}; } }
  // 簡化版：同時提供 flat
  const flat={}; for(const y in progress){ flat[y]={}; for(const k in progress[y]){ flat[y][k]=progress[y][k].date; } }
  const members=getMembers();
  // pending requests
  const prSheet=ss.getSheetByName('待批完成'); const pending=[];
  if(prSheet){ const data=prSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending'){ pending.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  // other badges
  const oSheet=ss.getSheetByName('其他獎章'); const other={};
  if(oSheet){ const data=oSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const y=data[i][0].toString(); if(!y) continue; if(!other[y]) other[y]={}; other[y][data[i][1].toString()]={name:data[i][2]?data[i][2].toString():'',date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}; } }
  // 活動履歷（logsSupported 讓前端分辨後端是否已升級）
  const lSheet=ss.getSheetByName(LOG_SHEET_NAME);
  // 待批履歷（團員自行申報，logRequestsSupported 讓前端分辨後端是否已升級）
  const lrSheet=ss.getSheetByName(LOG_REQ_SHEET_NAME);
  return jsonResponse({success:true,members:members,progress:progress,flatProgress:flat,pendingRequests:pending,otherBadges:other,logs:getLogRecordsList(),logsSupported:!!lSheet,logRequests:getLogRequestsList(),logRequestsSupported:!!lrSheet});
}
function handleSave(changes, confirmer){
  const sheet=getSheet().getSheetByName('進度追蹤'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  let processed=0;
  changes.forEach(function(c){
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){
      if(data[i][0].toString()===c.ymis && data[i][1].toString()===c.itemId){
        if(c.uncomplete){ sheet.deleteRow(i+1); } else { sheet.getRange(i+1,3).setValue(c.date); sheet.getRange(i+1,4).setValue(new Date()); sheet.getRange(i+1,5).setValue(confirmer||c.confirmer||''); sheet.getRange(i+1,6).setValue(c.note||''); }
        found=true; processed++; break;
      }
    }
    if(!found && !c.uncomplete){
      sheet.appendRow([c.ymis,c.itemId,c.date,new Date(),confirmer||c.confirmer||'',c.note||'']);
      processed++;
    }
  });
  return jsonResponse({success:true,processed:processed});
}
function handleAddMember(ymis,name,branch,actor){
  ymis=String(ymis||'').trim(); name=safeSheetText(name,100); branch=safeSheetText(branch,100);
  if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'YMIS 須為 10 位數字'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  let sheet=getSheet().getSheetByName('成員名單');
  if(!sheet){ sheet=getSheet().insertSheet('成員名單'); sheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡']); }
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++) if(String(data[i][0])===ymis) return jsonResponse({success:false,error:'成員名單已有此 YMIS'});
  sheet.appendRow([ymis,name,new Date(),branch,'']);
  writeAudit(actor,'add_member',ymis,name);
  return jsonResponse({success:true,message:'成員已新增（未建立登入密碼）'});
}
function normalizeNewUser(raw){
  raw=raw||{};
  return {
    ymis:String(raw.ymis||'').trim(), name:safeSheetText(raw.name,100), email:String(raw.email||'').trim().substring(0,160),
    branch:safeSheetText(raw.branch,100), role:String(raw.role||'member').trim(),
    can_tick:isTrue(raw.can_tick), password:String(raw.password||'')
  };
}
function createUsersBatch(rawUsers,manager){
  if(!Array.isArray(rawUsers) || !rawUsers.length) return {success:false,created:0,failed:0,results:[],error:'沒有開戶資料'};
  if(rawUsers.length>200) return {success:false,created:0,failed:rawUsers.length,results:[],error:'每批最多 200 個帳號'};
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return {success:false,created:0,failed:rawUsers.length,results:[],error:'系統正處理另一批資料，請稍後重試'};
  try{
    let uSheet=getSheet().getSheetByName('Users');
    if(!uSheet){ uSheet=getSheet().insertSheet('Users'); uSheet.appendRow(USER_HEADERS); }
    const map=ensureUserColumns(uSheet); const data=uSheet.getDataRange().getValues();
    const existingYmis={}; const existingEmail={};
    let activeGslName='';
    let maxLeaderNum=0;
    for(let i=1;i<data.length;i++){
      const y=String(data[i][map.ymis]||'').trim(); const e=emailKey(data[i][map.email]);
      const r=String(data[i][map.role]||'').trim(); const st=String(data[i][map.status]||'').trim();
      if(y) existingYmis[accountIdKey(y)]=true; if(e) existingEmail[e]=true;
      if(r==='group_leader' && st==='active' && !activeGslName){
        activeGslName=String(data[i][map.name]||'團長');
      }
      const lm=y.match(/^L(\d+)$/i);
      if(lm){ const n=parseInt(lm[1],10); if(n>maxLeaderNum) maxLeaderNum=n; }
    }
    const aSheet=getSheet().getSheetByName('Applications');
    if(aSheet){
      const aData=aSheet.getDataRange().getValues();
      for(let i=1;i<aData.length;i++){
        const ay=String(aData[i][1]||'').trim();
        const am=ay.match(/^L(\d+)$/i);
        if(am){ const n=parseInt(am[1],10); if(n>maxLeaderNum) maxLeaderNum=n; }
      }
    }
    let mSheet=getSheet().getSheetByName('成員名單');
    if(!mSheet){ mSheet=getSheet().insertSheet('成員名單'); mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡']); }
    const mData=mSheet.getDataRange().getValues(); const memberYmis={}; const memberRowsByYmis={}; const memberEmailOwner={};
    for(let i=1;i<mData.length;i++){
      if(!mData[i][0]) continue;
      const memberKey=accountIdKey(mData[i][0]);
      memberYmis[memberKey]=true; memberRowsByYmis[memberKey]=i+1;
      if(isEmail(mData[i][4])) memberEmailOwner[emailKey(mData[i][4])]=memberKey;
    }

    const results=[]; const userRows=[]; const memberRows=[]; const memberUpdates=[]; const batchYmis={}; const batchEmail={};
    let batchGslAssigned=false;
    rawUsers.forEach(function(raw){
      const u=normalizeNewUser(raw); let error='';
      const isLeaderRole=['branch_leader','group_leader','admin'].indexOf(u.role)>=0;

      // 領袖列可留空 YMIS，自動編配內部 L 編號
      if(!u.ymis && isLeaderRole){
        maxLeaderNum++;
        u.ymis='L'+String(maxLeaderNum).padStart(4,'0');
      }

      if(!u.name) error='姓名不可留空';
      else if(!u.ymis) error='YMIS 須為 10 位數字';
      else if(!/^\d{10}$/.test(u.ymis) && !/^L\d+$/i.test(u.ymis)) error='YMIS 須為 10 位數字';
      else if(VALID_ROLES.indexOf(u.role)<0) error='無效角色：'+u.role;
      else if(!canCreateRole(manager,u.role)) error='你的角色不可建立 '+u.role;
      else if(u.role==='group_leader' && (activeGslName || batchGslAssigned)){
        error='團長只能有一位，全團已有現任團長（'+(activeGslName||'本批中已設定')+'）。如需更換，請先將現任團長轉為其他角色。';
      }
      else if(u.role!=='member' && !u.email) error='領袖／執委帳號須填 Email';
      else if(u.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email)) error='Email 格式不正確';
      else if(isSuperAdminReserved(u.ymis,u.email)) error='此帳號已被保留';
      else if(u.password.length<MIN_PASSWORD_LEN) error='臨時密碼至少 '+MIN_PASSWORD_LEN+' 位';
      else if(u.password.length>MAX_PASSWORD_LEN) error='臨時密碼不可超過 '+MAX_PASSWORD_LEN+' 位';
      else if(existingYmis[accountIdKey(u.ymis)] || batchYmis[accountIdKey(u.ymis)]) error='YMIS 已存在（包括停用或已刪除帳號）';
      else if(u.email && (existingEmail[emailKey(u.email)] || batchEmail[emailKey(u.email)])) error='Email 已存在（包括停用或已刪除帳號）';
      else if(u.email && memberEmailOwner[emailKey(u.email)] && memberEmailOwner[emailKey(u.email)]!==accountIdKey(u.ymis)) error='Email 已由另一位成員使用';
      if(error){ results.push({ymis:u.ymis,name:u.name,email:u.email,role:u.role,success:false,error:error}); return; }

      if(u.role==='group_leader') batchGslAssigned=true;

      const row=new Array(uSheet.getLastColumn()).fill('');
      row[map.ymis]=u.ymis; row[map.name]=u.name; row[map.email]=u.email; row[map.role]=u.role;
      row[map.password_hash]=hashPassword(u.password); row[map.branch]=u.branch;
      row[map.can_tick]=canUserTick(u.role) && u.can_tick; row[map.auth_by]=manager.ymis;
      row[map.auth_date]=now(); row[map.created_at]=now(); row[map.status]='active';
      row[map.allowed_badges]=defaultAllowedBadges(u.role); row[map.force_change_password]=true;

      const userKey=accountIdKey(u.ymis);
      userRows.push(row); batchYmis[userKey]=true; if(u.email) batchEmail[emailKey(u.email)]=true;
      if(!memberYmis[userKey]){
        memberRows.push([u.ymis,u.name,new Date(),u.branch,u.email||'']); memberYmis[userKey]=true;
      }else{
        // 從既有成員名單開戶：同步名稱／支部／Email，不另建重複成員列。
        memberUpdates.push({row:memberRowsByYmis[userKey],name:u.name,branch:u.branch,email:u.email});
      }
      results.push({ymis:u.ymis,name:u.name,email:u.email,role:u.role,success:true});
    });
    if(userRows.length) uSheet.getRange(uSheet.getLastRow()+1,1,userRows.length,uSheet.getLastColumn()).setValues(userRows);
    if(memberRows.length) mSheet.getRange(mSheet.getLastRow()+1,1,memberRows.length,5).setValues(memberRows);
    memberUpdates.forEach(function(u){
      if(!u.row) return;
      mSheet.getRange(u.row,2).setValue(u.name);
      if(mSheet.getLastColumn()>=4) mSheet.getRange(u.row,4).setValue(u.branch);
      if(mSheet.getLastColumn()>=5 && u.email) mSheet.getRange(u.row,5).setValue(u.email);
    });
    writeAudit(manager.ymis,'bulk_add_users',userRows.length+' accounts','失敗 '+(rawUsers.length-userRows.length)+' 筆');
    return {success:true,created:userRows.length,failed:rawUsers.length-userRows.length,results:results};
  } finally { lock.releaseLock(); }
}
function handleAddUser(body,manager){
  const result=createUsersBatch([body],manager);
  if(!result.success || result.created!==1) return jsonResponse({success:false,error:(result.results[0]&&result.results[0].error)||result.error||'建立帳號失敗'});
  return jsonResponse({success:true,message:'帳號已建立，首次登入必須更改密碼'});
}
function handleBulkAddUsers(users,manager){ return jsonResponse(createUsersBatch(users,manager)); }
function handleResetPassword(targetYmis,newPassword,manager){
  const rec=findUserRecord(targetYmis); newPassword=String(newPassword||'');
  if(!rec || rec.user.status==='deleted') return jsonResponse({success:false,error:'找不到帳號'});
  if(accountIdKey(targetYmis)===accountIdKey(manager.ymis)) return jsonResponse({success:false,error:'請使用「更改密碼」修改自己的密碼'});
  if(!canManageUser(manager,rec.user.role)) return jsonResponse({success:false,error:'權限不足，不能重設此角色'});
  if(newPassword.length<MIN_PASSWORD_LEN) return jsonResponse({success:false,error:'臨時密碼至少 '+MIN_PASSWORD_LEN+' 位'});
  if(newPassword.length>MAX_PASSWORD_LEN) return jsonResponse({success:false,error:'臨時密碼不可超過 '+MAX_PASSWORD_LEN+' 位'});
  rec.sheet.getRange(rec.row,rec.map.password_hash+1).setValue(hashPassword(newPassword));
  rec.sheet.getRange(rec.row,rec.map.force_change_password+1).setValue(true);
  rec.sheet.getRange(rec.row,rec.map.auth_by+1).setValue(manager.ymis);
  rec.sheet.getRange(rec.row,rec.map.auth_date+1).setValue(now());
  destroyTokensForUser(targetYmis);
  writeAudit(manager.ymis,'reset_password',targetYmis,'已設定臨時密碼並撤銷舊登入');
  return jsonResponse({success:true,message:'密碼已重設，舊登入已撤銷'});
}
function destroyTokensForUser(ymis){
  const sh=getSheet().getSheetByName('Tokens'); if(!sh) return;
  const data=sh.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--) if(String(data[i][1])===String(ymis)) sh.deleteRow(i+1);
}
function handleUpdateUserProfile(body,manager){
  const targetYmis=String(body.target_ymis||'').trim();
  const rec=findUserRecord(targetYmis); const memberRec=findMemberRecord(targetYmis);
  const targetRole=rec?rec.user.role:'member';
  if(!rec && !memberRec) return jsonResponse({success:false,error:'找不到用戶或成員'});
  if(accountIdKey(targetYmis)===accountIdKey(manager.ymis) || !canManageUser(manager,targetRole)) return jsonResponse({success:false,error:'權限不足，不能編輯此用戶'});
  if(rec && rec.user.status==='deleted') return jsonResponse({success:false,error:'帳號已刪除，不能修改'});
  const name=safeSheetText(body.name,100); const email=String(body.email||'').trim().substring(0,160); const branch=safeSheetText(body.branch,100);
  if(!name) return jsonResponse({success:false,error:'姓名不可留空'});
  if(rec && rec.user.role!=='member' && !email) return jsonResponse({success:false,error:'領袖／執委帳號須保留 Email'});
  if(email && !isEmail(email)) return jsonResponse({success:false,error:'Email 格式不正確'});
  if(isSuperAdminReserved('',email)) return jsonResponse({success:false,error:'此 Email 已被保留'});

  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return jsonResponse({success:false,error:'系統正處理另一項修改，請稍後重試'});
  try{
    const conflict=identifierConflict('',email,targetYmis);
    if(conflict) return jsonResponse({success:false,error:conflict});
    if(rec){
      rec.sheet.getRange(rec.row,rec.map.name+1).setValue(name);
      rec.sheet.getRange(rec.row,rec.map.email+1).setValue(email);
      rec.sheet.getRange(rec.row,rec.map.branch+1).setValue(branch);
    }
    if(memberRec){
      memberRec.sheet.getRange(memberRec.row,2).setValue(name);
      if(memberRec.sheet.getLastColumn()>=4) memberRec.sheet.getRange(memberRec.row,4).setValue(branch);
      if(memberRec.sheet.getLastColumn()>=5) memberRec.sheet.getRange(memberRec.row,5).setValue(email);
    }
    writeAudit(manager.ymis,'update_profile',targetYmis,name+(rec?'':'（成員名單）'));
    return jsonResponse({success:true,message:'用戶資料已更新'});
  } finally { lock.releaseLock(); }
}
function handleSetUserStatus(targetYmis,status,manager){
  status=status==='active'?'active':'inactive'; const rec=findUserRecord(targetYmis);
  if(!rec || rec.user.status==='deleted') return jsonResponse({success:false,error:'找不到帳號'});
  if(accountIdKey(targetYmis)===accountIdKey(manager.ymis)) return jsonResponse({success:false,error:'不可停用自己的帳號'});
  if(!canManageUser(manager,rec.user.role)) return jsonResponse({success:false,error:'權限不足，不能管理此角色'});

  if(status==='active' && rec.user.role==='group_leader'){
    const activeGsl=getActiveGroupLeader();
    if(activeGsl && String(activeGsl.ymis)!==String(targetYmis)){
      return jsonResponse({success:false,error:'團長只能有一位，全團已有現任團長（'+activeGsl.name+'）。如需更換，請先將現任團長轉為其他角色。'});
    }
  }

  rec.sheet.getRange(rec.row,rec.map.status+1).setValue(status);
  if(status==='inactive') destroyTokensForUser(targetYmis);
  writeAudit(manager.ymis,status==='active'?'reactivate_user':'deactivate_user',targetYmis,'帳號狀態='+status);
  return jsonResponse({success:true,message:status==='active'?'帳號已重新啟用':'帳號已停用，進度紀錄獲保留'});
}
function handleDeleteUser(targetYmis,manager){
  targetYmis=String(targetYmis||'').trim();
  const rec=findUserRecord(targetYmis); const memberRec=findMemberRecord(targetYmis);
  const targetRole=rec?rec.user.role:'member';
  if(!rec && !memberRec) return jsonResponse({success:false,error:'找不到用戶或成員'});
  if(accountIdKey(targetYmis)===accountIdKey(manager.ymis)) return jsonResponse({success:false,error:'不可刪除自己的帳號'});
  if(!canManageUser(manager,targetRole)) return jsonResponse({success:false,error:'權限不足，不能刪除此角色'});
  if(rec && rec.user.status==='deleted') return jsonResponse({success:false,error:'帳號已刪除'});

  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return jsonResponse({success:false,error:'系統正處理另一項操作，請稍後重試'});
  try{
    // 帳戶採安全刪除：Users 列保留為 tombstone，確保相同 YMIS / Email 永遠不會被開成另一帳戶。
    // 進度／履歷亦保留作團隊紀錄；成員名單列會移除，因此日常畫面不再顯示此人。
    if(rec){
      rec.sheet.getRange(rec.row,rec.map.status+1).setValue('deleted');
      rec.sheet.getRange(rec.row,rec.map.can_tick+1).setValue(false);
      rec.sheet.getRange(rec.row,rec.map.auth_by+1).setValue(manager.ymis);
      rec.sheet.getRange(rec.row,rec.map.auth_date+1).setValue(now());
      destroyTokensForUser(rec.user.ymis);
    }
    const latestMemberRec=findMemberRecord(targetYmis);
    if(latestMemberRec) latestMemberRec.sheet.deleteRow(latestMemberRec.row);
    writeAudit(manager.ymis,'delete_user',targetYmis,rec?'帳戶及成員名單已移除；識別碼及歷史紀錄保留':'成員名單已移除（未有登入帳戶）');
    return jsonResponse({success:true,message:rec?'帳戶及成員已刪除；歷史進度獲保留':'成員已從名單刪除'});
  } finally { lock.releaseLock(); }
}
function handleGetAuditLog(){
  const sh=getSheet().getSheetByName('操作紀錄'); const out=[];
  if(sh){ const d=sh.getDataRange().getValues(); for(let i=Math.max(1,d.length-200);i<d.length;i++) out.push(d[i]); }
  return jsonResponse({success:true,records:out});
}
// 待批完成
function handleRequestComplete(body, requesterYmis){
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const reqId='REQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  const user=getUser(requesterYmis)||{name:body.name||requesterYmis};
  sheet.appendRow([reqId,requesterYmis,user.name||body.name,body.itemId,body.itemName||body.itemId,body.requested_date||formatDate(new Date()),body.evidence||'','pending',now(),'','','', '']);
  return jsonResponse({success:true,request_id:reqId});
}
function handleGetPendingRequests(){
  const sheet=getSheet().getSheetByName('待批完成'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending'){ list.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  return jsonResponse({success:true,requests:list});
}
function handleReviewRequest(reqId,decision,note,reviewer,confirmed_date){
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const data=sheet.getDataRange().getValues(); let row=null;
  for(let i=1;i<data.length;i++){ if(data[i][0].toString()===reqId){ row=data[i]; sheet.getRange(i+1,8).setValue(decision); sheet.getRange(i+1,10).setValue(reviewer); sheet.getRange(i+1,11).setValue(now()); sheet.getRange(i+1,12).setValue(note||''); sheet.getRange(i+1,13).setValue(confirmed_date||formatDate(new Date())); break; } }
  if(!row) return jsonResponse({success:false,error:'找不到申請'});
  if(decision==='approved'){
    const pSheet=getSheet().getSheetByName('進度追蹤');
    pSheet.appendRow([row[1],row[3],confirmed_date||row[5],new Date(),reviewer, '由申請轉入：'+(note||'')]);
    return jsonResponse({success:true,message:'已批准並寫入進度'});
  }
  return jsonResponse({success:true,message:'已拒絕'});
}
function handleGetOtherBadges(ymis){
  const sheet=getSheet().getSheetByName('其他獎章'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0].toString()===ymis){ list.push({id:data[i][1].toString(),name:data[i][2].toString(),date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}); } } }
  return jsonResponse({success:true,other:list});
}
function handleSaveOtherBadge(records){
  const sheet=getSheet().getSheetByName('其他獎章'); if(!sheet) return jsonResponse({success:false,error:'Sheet missing'});
  let c=0;
  records.forEach(function(r){
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){ if(data[i][0].toString()===r.ymis && data[i][1].toString()===r.badgeId){ sheet.getRange(i+1,3).setValue(r.date); sheet.getRange(i+1,4).setValue(r.cert||''); sheet.getRange(i+1,5).setValue(r.note||''); sheet.getRange(i+1,6).setValue(new Date()); found=true; c++; break; } }
    if(!found){ sheet.appendRow([r.ymis,r.badgeId,r.name||r.badgeId,r.date,r.cert||'',r.note||'',new Date()]); c++; }
  });
  return jsonResponse({success:true,processed:c});
}

// ===== 活動履歷（服務／活動／訓練班紀錄） =====
function getLogRecordsList(){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME); const logs=[];
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(!data[i][0]) continue;
      logs.push({
        record_id:String(data[i][0]), type:String(data[i][1]||'activity'),
        ymis:String(data[i][2]||''), name:String(data[i][3]||''),
        date:data[i][4]?formatDate(data[i][4]):'', title:String(data[i][5]||''),
        role:String(data[i][6]||''), hours:String(data[i][7]||''),
        cert_no:String(data[i][8]||''), detail:String(data[i][9]||''),
        recorder:String(data[i][10]||''),
        recorded_at:data[i][11]?String(data[i][11]):''
      });
    }
  }
  return logs;
}
function handleGetLogRecords(){
  // 未升級/未初始化時明確報錯，讓前端顯示升級提示
  if(!getSheet().getSheetByName(LOG_SHEET_NAME)) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  return jsonResponse({success:true,logs:getLogRecordsList()});
}
function sanitizeLogRecord(r){
  r=r||{};
  return {
    type: LOG_TYPES.indexOf(r.type)>=0 ? r.type : 'activity',
    ymis: String(r.ymis||'').trim().substring(0,20),
    name: safeSheetText(r.name,60),
    date: String(r.date||'').substring(0,20),
    title: safeSheetText(r.title,120),
    role: safeSheetText(r.role,60),
    hours: String(r.hours==null?'':r.hours).substring(0,20),
    cert_no: safeSheetText(r.cert_no,60),
    detail: safeSheetText(r.detail,500)
  };
}
function handleSaveLogRecord(records, recorderYmis, recorderName){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  if(!Array.isArray(records)||records.length===0) return jsonResponse({success:false,error:'沒有可儲存的紀錄'});
  if(records.length>200) return jsonResponse({success:false,error:'一次最多 200 筆，請分批'});
  const results=[]; let processed=0;
  records.forEach(function(r){
    const rec=sanitizeLogRecord(r);
    if(!rec.ymis||!rec.title||!rec.date){ results.push({success:false,ymis:rec.ymis,title:rec.title,error:'YMIS、名稱及日期必填'}); return; }
    const rid=String((r&&r.record_id)||'');
    if(rid){
      // 更新既有紀錄（record_id 不變）
      const data=sheet.getDataRange().getValues();
      for(let i=1;i<data.length;i++){
        if(String(data[i][0])===rid){
          sheet.getRange(i+1,2,1,12).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,sheet.getRange(i+1,11).getValue()||recorderName||recorderYmis,String(data[i][11]||''),now()]]);
          results.push({success:true,record_id:rid}); processed++;
          writeAudit(recorderYmis,'update_log',rec.ymis,rec.type+': '+rec.title+' '+rec.date);
          return;
        }
      }
      results.push({success:false,record_id:rid,error:'找不到紀錄'}); return;
    }
    const newId='LOG_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    sheet.appendRow([newId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,recorderName||recorderYmis,now(),'']);
    results.push({success:true,record_id:newId}); processed++;
    writeAudit(recorderYmis,'add_log',rec.ymis,rec.type+': '+rec.title+' '+rec.date);
  });
  const failed=results.filter(function(x){return !x.success;}).length;
  return jsonResponse({success:(results.length>0&&failed===0),processed:processed,results:results,message:processed+' 筆已儲存'+(failed?'，'+failed+' 筆失敗':'')});
}
function handleDeleteLogRecord(recordId, recorderYmis){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  recordId=String(recordId||'');
  if(!recordId) return jsonResponse({success:false,error:'缺少 record_id'});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0])===recordId){
      const label=String(data[i][1]||'')+': '+String(data[i][5]||'')+' '+String(data[i][4]||'');
      const target=String(data[i][2]||'');
      sheet.deleteRow(i+1);
      writeAudit(recorderYmis,'delete_log',target,label);
      return jsonResponse({success:true,message:'已刪除紀錄'});
    }
  }
  return jsonResponse({success:false,error:'找不到紀錄'});
}

// ===== 活動履歷申報（團員自行申報 → 領袖審批） =====
// 流程：requestLogRecord（kind=new/edit）→ 待批履歷 sheet → reviewLogRequest 批准後寫入／更新「活動履歷」。
// 修改申報（kind=edit）只限申報人自己的紀錄；批准後以同一 record_id 更新，即「批了要改 → 再申報 → 領袖重批」。
function getLogRequestsList(onlyYmis){
  const sheet=getSheet().getSheetByName(LOG_REQ_SHEET_NAME); const list=[];
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(!data[i][0] || String(data[i][12])!=='pending') continue;
      if(onlyYmis && String(data[i][4])!==String(onlyYmis)) continue;
      list.push({
        request_id:String(data[i][0]), kind:String(data[i][1]||'new'),
        target_record_id:String(data[i][2]||''), type:String(data[i][3]||'activity'),
        ymis:String(data[i][4]||''), name:String(data[i][5]||''),
        date:data[i][6]?formatDate(data[i][6]):'', title:String(data[i][7]||''),
        role:String(data[i][8]||''), hours:String(data[i][9]||''),
        cert_no:String(data[i][10]||''), detail:String(data[i][11]||''),
        status:'pending', created_at:data[i][13]?String(data[i][13]):''
      });
    }
  }
  return list;
}
function handleRequestLogRecord(body, user){
  const sheet=getSheet().getSheetByName(LOG_REQ_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_REQ_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const rec=sanitizeLogRecord(body.record||{});
  // 只能為自己申報：ymis／姓名一律以登入者為準，不接受偽冒他人
  rec.ymis=String(user.ymis); rec.name=safeSheetText(user.name||rec.name,60);
  if(!rec.title||!rec.date) return jsonResponse({success:false,error:'名稱及日期必填'});
  const kind=body.kind==='edit'?'edit':'new';
  let targetId='';
  if(kind==='edit'){
    targetId=String(body.target_record_id||'');
    if(!targetId) return jsonResponse({success:false,error:'缺少 target_record_id'});
    const lSheet=getSheet().getSheetByName(LOG_SHEET_NAME);
    if(!lSheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
    const ld=lSheet.getDataRange().getValues(); let found=null;
    for(let i=1;i<ld.length;i++){ if(String(ld[i][0])===targetId){ found=ld[i]; break; } }
    if(!found) return jsonResponse({success:false,error:'找不到原紀錄，可能已被刪除，請重新載入'});
    if(String(found[2])!==String(user.ymis)) return jsonResponse({success:false,error:'只可申請修改自己的紀錄'});
    // 類型跟隨原紀錄，不可經修改申報變更
    if(LOG_TYPES.indexOf(String(found[1]))>=0) rec.type=String(found[1]);
    // 同一紀錄同時只可有一個待批修改申報
    const rd=sheet.getDataRange().getValues();
    for(let i=1;i<rd.length;i++){ if(String(rd[i][2])===targetId && String(rd[i][12])==='pending') return jsonResponse({success:false,error:'此紀錄已有待批修改申報，請等待領袖審批或先取消'}); }
  }
  const reqId='LREQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  sheet.appendRow([reqId,kind,targetId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,'pending',now(),'','','']);
  writeAudit(user.ymis, kind==='edit'?'request_log_edit':'request_log_new', rec.ymis, rec.type+': '+rec.title+' '+rec.date+(targetId?'（原紀錄 '+targetId+'）':''));
  return jsonResponse({success:true,request_id:reqId,message:'申報已提交，待領袖審批'});
}
function handleGetLogRequests(user){
  if(!getSheet().getSheetByName(LOG_REQ_SHEET_NAME)) return jsonResponse({success:false,error:'「'+LOG_REQ_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  // 領袖（已獲勾選權限）看全部待批；其他人只看自己的申報
  const isReviewer=canUserTick(user.role) && user.can_tick===true;
  return jsonResponse({success:true,requests:getLogRequestsList(isReviewer?null:user.ymis)});
}
function handleReviewLogRequest(requestId, decision, note, reviewer){
  if(decision!=='approved' && decision!=='rejected') return jsonResponse({success:false,error:'無效決定'});
  const sheet=getSheet().getSheetByName(LOG_REQ_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_REQ_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const data=sheet.getDataRange().getValues(); let rowIndex=-1,row=null;
  for(let i=1;i<data.length;i++){ if(String(data[i][0])===String(requestId)){ rowIndex=i+1; row=data[i]; break; } }
  if(!row || String(row[12])!=='pending') return jsonResponse({success:false,error:'找不到待批申報'});
  const kind=String(row[1]||'new');
  const rec={
    type:String(row[3]||'activity'), ymis:String(row[4]||''), name:String(row[5]||''),
    date:row[6]?formatDate(row[6]):'', title:String(row[7]||''), role:String(row[8]||''),
    hours:String(row[9]||''), cert_no:String(row[10]||''), detail:String(row[11]||'')
  };
  if(decision==='rejected'){
    sheet.getRange(rowIndex,13).setValue('rejected'); sheet.getRange(rowIndex,15).setValue(reviewer.ymis); sheet.getRange(rowIndex,16).setValue(now()); sheet.getRange(rowIndex,17).setValue(note||'');
    writeAudit(reviewer.ymis, kind==='edit'?'reject_log_edit':'reject_log_new', rec.ymis, rec.type+': '+rec.title+' '+rec.date);
    return jsonResponse({success:true,message:'已拒絕申報'});
  }
  const lSheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!lSheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  let recordId=''; let recorder='';
  if(kind==='edit'){
    const targetId=String(row[2]||'');
    const ld=lSheet.getDataRange().getValues(); let li=-1;
    for(let i=1;i<ld.length;i++){ if(String(ld[i][0])===targetId){ li=i; break; } }
    if(li<0) return jsonResponse({success:false,error:'找不到原紀錄（可能已被刪除），無法批准修改'});
    recorder=String(ld[li][10]||'');
    lSheet.getRange(li+1,2,1,12).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,recorder,String(ld[li][11]||''),now()]]);
    recordId=targetId;
  }else{
    recordId='LOG_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    recorder=rec.name+'（自行申報）';
    lSheet.appendRow([recordId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,recorder,now(),'']);
  }
  sheet.getRange(rowIndex,13).setValue('approved'); sheet.getRange(rowIndex,15).setValue(reviewer.ymis); sheet.getRange(rowIndex,16).setValue(now()); sheet.getRange(rowIndex,17).setValue(note||'');
  writeAudit(reviewer.ymis, kind==='edit'?'approve_log_edit':'approve_log_new', rec.ymis, rec.type+': '+rec.title+' '+rec.date+'（'+recordId+'）');
  return jsonResponse({success:true,message:kind==='edit'?'已批准修改並更新紀錄':'已批准並寫入活動履歷',record_id:recordId,record:{record_id:recordId,type:rec.type,ymis:rec.ymis,name:rec.name,date:rec.date,title:rec.title,role:rec.role,hours:rec.hours,cert_no:rec.cert_no,detail:rec.detail,recorder:recorder}});
}
function handleCancelLogRequest(requestId, user){
  const sheet=getSheet().getSheetByName(LOG_REQ_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_REQ_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  requestId=String(requestId||'');
  if(!requestId) return jsonResponse({success:false,error:'缺少 request_id'});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0])===requestId){
      if(String(data[i][12])!=='pending') return jsonResponse({success:false,error:'此申報已被審批，不能取消'});
      const isReviewer=canUserTick(user.role) && user.can_tick===true;
      if(!isReviewer && String(data[i][4])!==String(user.ymis)) return jsonResponse({success:false,error:'只可取消自己的申報'});
      const label=String(data[i][3]||'')+': '+String(data[i][7]||'')+' '+String(data[i][6]||'');
      sheet.deleteRow(i+1);
      writeAudit(user.ymis,'cancel_log_request',String(data[i][4]||''),label);
      return jsonResponse({success:true,message:'已取消申報'});
    }
  }
  return jsonResponse({success:false,error:'找不到申報'});
}

// ===== 旅系統：Sheet 選單（匯出／匯入／登記下游／直接入口掣）=====
// 選單只在 Sheet 內給擁有者按；匯出的 JSON 含 password_hash，只寫去 Drive（私人），绝不寫入工作表。
function onOpen(){
  try{
    const ui=SpreadsheetApp.getUi();
    ui.createMenu('🔗 旅系統')
      .addItem('📤 匯出 JSON（含 hash）','menuExportUsersJson')
      .addItem('📥 匯入 JSON（upsertUser 直插 hash）','menuImportUsersJson')
      .addSeparator()
      .addItem('🧭 本機接駁狀態','menuShowLinkState')
      .addItem('🔑 顯示 BACKEND／APIKEY（交 ADMIN）','menuShowLinkCredentials')
      .addSeparator()
      .addItem('➕ 登記下游（URL + SHEET KEY）','menuRegisterDownstream')
      .addItem('📡 測試下游連線（sig）','menuPingDownstream')
      .addItem('👤 為下游開戶（揀團）','menuCreateDownstreamUser')
      .addSubMenu(ui.createMenu('🚪 下游直接入口')
        .addItem('🔒 閂口（只收 sig）','menuCloseDownstreamGate')
        .addItem('🔓 開啟（容許本地登入）','menuOpenDownstreamGate'))
      .addItem('🗑️ 移除下游登記','menuRemoveDownstream')
      .addSeparator()
      .addSubMenu(ui.createMenu('🚪 本機直接入口')
        .addItem('🔒 閂口（只收 sig）','menuLocalLoginOff')
        .addItem('🔓 開啟（容許本地登入）','menuLocalLoginOn'))
      .addToUi();
  }catch(e){}
}
function linkUi(){ return SpreadsheetApp.getUi(); }
function linkAlert(title,message){
  const text=String(message||'');
  try{ const ui=linkUi(); if(ui) ui.alert(String(title||'旅系統'),text,ui.ButtonSet.OK); }catch(e){}
  try{ Logger.log(String(title||'旅系統')+': '+text); }catch(e){}
  return text;
}
function linkPrompt(title,message){
  const ui=linkUi();
  if(!ui) return null;
  const res=ui.prompt(String(title||'旅系統'),String(message||''),ui.ButtonSet.OK_CANCEL);
  if(res.getSelectedButton()!==ui.Button.OK) return null;
  return String(res.getResponseText()||'').trim();
}
function linkConfirm(title,message){
  const ui=linkUi();
  if(!ui) return false;
  return ui.alert(String(title||'旅系統'),String(message||''),ui.ButtonSet.YES_NO)===ui.Button.YES;
}
function linkSummarizeResults(results,limit){
  const bad=(results||[]).filter(function(r){ return !r.success; });
  if(!bad.length) return '';
  return '\n\n首 '+Math.min(bad.length,limit||8)+' 筆失敗：\n'+bad.slice(0,limit||8).map(function(r){
    return '・'+String(r.ymis||'?')+'：'+String(r.error||'');
  }).join('\n');
}
function menuExportUsersJson(){
  const r=exportUsersJson();
  if(!r.success) return linkAlert('匯出 JSON','匯出失敗：'+String(r.error||''));
  const lines=['已匯出 '+r.count+' 個帳戶（含 password_hash）。'];
  if(r.file_url) lines.push('\nDrive 檔（已設為私人，匯入後請刪除）：\n'+r.file_url+'\n\n檔案 ID：'+r.file_id);
  else lines.push('\nDrive 寫入失敗（'+String(r.drive_error||'')+'）；完整 JSON 已寫入「檢視 → 執行紀錄（Logger）」，可在那裡複製。');
  lines.push('\n⚠️ 檔案含密碼 hash，只用於搬到上游／新支部，切勿公開分享或留在共用資料夾。');
  return linkAlert('匯出 JSON（含 hash）',lines.join(''));
}
function menuImportUsersJson(){
  const input=linkPrompt('匯入 JSON（upsertUser）','貼上「匯出 JSON（含 hash）」檔案的 Drive 連結或檔案 ID：\n\n（匯入會逐個 upsertUser 直插 hash，保留舊密碼；既有帳戶只更新，不會重複開戶）');
  if(input===null) return '';
  const r=importUsersFromDrive(input,'menu-import');
  if(!r.success) return linkAlert('匯入 JSON','匯入失敗：'+String(r.error||''));
  return linkAlert('匯入 JSON','匯入完成：共 '+r.count+' 筆\n新增 '+r.created+'、更新 '+r.updated+'、失敗 '+r.failed+linkSummarizeResults(r.results)+'\n\n確認無誤後，可閂下游直接入口（只收 sig）。');
}
function menuShowLinkState(){
  const s=getLinkState();
  const lines=[
    '節點：'+s.node,
    '本機直接入口（'+LINK_FLAG+'）：'+(s.allow_local_login?'開啟（未閂）':'已閂 — 只收上游 sig'),
    '設定值：'+s.link_flag_set,
    '本機 API KEY（遮罩）：'+s.api_key_masked,
    '已登記下游：'+s.downstreams.length+' 個'
  ];
  s.downstreams.forEach(function(d){ lines.push('・'+d.id+(d.name?'（'+d.name+'）':'')+' '+d.url_masked+' 登記於 '+d.registered_at); });
  lines.push('\n匯出格式：'+s.export_format);
  return linkAlert('本機接駁狀態',lines.join('\n'));
}
function menuShowLinkCredentials(){
  let url='';
  try{ url=ScriptApp.getService().getUrl()||''; }catch(e){ url=''; }
  const lines=[
    '以下兩項由本節點 GS 產生，經收件匣交 ADMIN 登記；四項一律不寫入工作表。',
    '',
    'B　BACKEND（部署後抄此 URL）：',
    url||'（尚未部署為網頁應用程式：部署 → 新增部署 → 網頁應用程式，再按一次本選單）',
    '',
    'D　APIKEY（SHEET KEY）：',
    getApiKey(),
    '',
    'C　NAME：由你自行填寫（交 ADMIN 時一併提供）',
    'A　隱藏管理鍵：與旅系統無關，不改動、不在此顯示'
  ];
  return linkAlert('BACKEND／APIKEY（交 ADMIN）',lines.join('\n'));
}
function menuRegisterDownstream(){
  const id=linkPrompt('登記下游 1/4','下游編號（例：團 / 進度節點識別，只可用英文、數字、底線、連字號）：');
  if(id===null) return '';
  const url=linkPrompt('登記下游 2/4','下游 GAS 正式 /exec URL（B）：');
  if(url===null) return '';
  const key=linkPrompt('登記下游 3/4','下游 SHEET KEY（下游 Script Properties 的 API_KEY，即 D）：');
  if(key===null) return '';
  const name=linkPrompt('登記下游 4/4','下游名稱（可留空；按「取消」亦視為留空）：');
  const r=registerDownstream(id,url,key,name||'');
  return linkAlert('登記下游',r.success?('已登記下游 '+r.id+'\n\n（URL 及 SHEET KEY 只存 Script Properties，不寫入工作表）\n下一步：按「📡 測試下游連線（sig）」確認可讀可寫。'):('登記失敗：'+String(r.error||'')));
}
function menuRemoveDownstream(){
  const id=linkPrompt('移除下游登記','要移除的下游編號：\n\n'+listDownstreams().map(function(d){ return '・'+d.id+(d.name?'（'+d.name+'）':''); }).join('\n'));
  if(id===null) return '';
  const r=removeDownstream(id);
  return linkAlert('移除下游登記',r.success?String(r.message):('移除失敗：'+String(r.error||'')));
}
function menuPingDownstream(){
  const id=linkPrompt('測試下游連線','下游編號：');
  if(id===null) return '';
  const r=pingDownstream(id);
  if(!r||!r.success) return linkAlert('測試下游連線','連線失敗：'+String((r&&r.error)||'下游無回應'));
  return linkAlert('測試下游連線','✅ sig 驗證通過，可讀可寫。\n\n下游節點：'+String(r.node||'')+'\n下游直接入口：'+(r.allow_local_login?'開啟（未閂）':'已閂 — 只收上游 sig')+'\n下游已登記的再下一層：'+((r.downstreams&&r.downstreams.length)||0)+' 個');
}
function menuCreateDownstreamUser(){
  const list=listDownstreams();
  if(!list.length) return linkAlert('為下游開戶','尚未登記任何下游；請先按「➕ 登記下游（URL + SHEET KEY）」。');
  const id=linkPrompt('為下游開戶 1/6','揀團（下游編號）：\n\n'+list.map(function(d){ return '・'+d.id+(d.name?'（'+d.name+'）':''); }).join('\n'));
  if(id===null) return '';
  const ymis=linkPrompt('為下游開戶 2/6','YMIS（10 位數字；領袖可留空自動編 L 號）：');
  if(ymis===null) return '';
  const name=linkPrompt('為下游開戶 3/6','姓名：');
  if(name===null) return '';
  const email=linkPrompt('為下游開戶 4/6','Email（領袖／執委必填，團員可留空）：');
  if(email===null) return '';
  const role=linkPrompt('為下游開戶 5/6','角色：member / exec_committee / branch_leader / group_leader / admin');
  if(role===null) return '';
  const password=linkPrompt('為下游開戶 6/6','臨時密碼（最少 '+MIN_PASSWORD_LEN+' 位；預設 '+DEFAULT_TEMP_PASSWORD+'）：');
  const r=createAccountForDownstream(id,{
    ymis:ymis,name:name,email:email,role:String(role||'member').trim(),
    password:(password===null||!password)?DEFAULT_TEMP_PASSWORD:password,
    can_tick:true,branch:''
  },{ymis:ADMIN_YMIS,name:ADMIN_NAME,role:'admin',can_tick:true});
  if(!r.success) return linkAlert('為下游開戶','開戶失敗：'+String(r.error||'')+linkSummarizeResults(r.results));
  return linkAlert('為下游開戶','✅ 已在上游開戶並經 sig 寫入下游 '+r.downstream+'\n\nYMIS：'+r.ymis+'\n姓名：'+r.name+'\n臨時密碼：'+((password===null||!password)?DEFAULT_TEMP_PASSWORD:password)+'\n（首次登入必須更改）');
}
function menuCloseDownstreamGate(){
  const id=linkPrompt('閂下游直接入口','下游編號：\n\n'+listDownstreams().map(function(d){ return '・'+d.id+(d.name?'（'+d.name+'）':''); }).join('\n'));
  if(id===null) return '';
  if(!linkConfirm('閂下游直接入口','確定閂口？\n\n下游 '+id+' 之後只接受本上游的 sig 請求：\n・下游直接登入／申請帳戶會被拒\n・進度、帳戶、履歷一律由上游讀寫\n\n請先確認已完成匯入（upsertUser）及測試連線。')) return '';
  const r=setDownstreamLocalLogin(id,false);
  return linkAlert('閂下游直接入口',(r&&r.success)?('✅ 下游 '+id+' 直接入口已閂，只收 sig。'):('閂口失敗：'+String((r&&r.error)||'下游無回應')));
}
function menuOpenDownstreamGate(){
  const id=linkPrompt('開下游直接入口','下游編號：');
  if(id===null) return '';
  const r=setDownstreamLocalLogin(id,true);
  return linkAlert('開下游直接入口',(r&&r.success)?('下游 '+id+' 直接入口已重開（本地登入恢復）。'):('開啟失敗：'+String((r&&r.error)||'下游無回應')));
}
function menuLocalLoginOff(){
  if(!linkConfirm('閂本機直接入口','確定閂口？\n\n本節點之後只接受上游 sig 請求：\n・前端直接登入／申請帳戶會被拒\n・資料只由上游讀寫\n\n請先確認上游已登記本節點的 URL 及 SHEET KEY，並已通過「測試下游連線」。')) return '';
  setLocalLoginAllowed(false,'menu');
  return linkAlert('閂本機直接入口','✅ '+LINK_FLAG+'=false：本節點只收上游 sig。如需重開，按「🔓 開啟（容許本地登入）」。');
}
function menuLocalLoginOn(){
  setLocalLoginAllowed(true,'menu');
  return linkAlert('開本機直接入口','✅ '+LINK_FLAG+'=true：本節點直接入口已重開。');
}
