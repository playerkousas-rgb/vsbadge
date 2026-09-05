// ============================================================
// 深資童軍進度及行政平台 - Apps Script 後端 v8.7
// 全前端帳戶管理、批量開戶、首次登入改密碼、角色驗證及操作紀錄
// v8.1 新增：活動履歷（服務紀錄／活動紀錄／訓練班紀錄）
//   - 新工作表「活動履歷」（執行 initializeSheets() 自動補建，不影響既有資料）
//   - 新 action：getLogRecords / saveLogRecord（支援批量 records[]）/ deleteLogRecord
//   - handleLoad 回應新增 logs + logsSupported
// v8.2 新增：帳戶自助申請（成員／執委／領袖）
//   - apply 接受 requested_role（只限 member/exec_committee/branch_leader），存入 Applications 工作表
//   - getApplications 回傳申請人要求的角色；branch 由前端自動帶入所屬旅團（毋須申請人填寫）
//   - reviewApplication 按申請角色開戶（審批者無權限設定該角色時退回團員），回應加 final_role
//   - 無新工作表、無新欄位：覆蓋 Code.gs 並重新部署即可，毋須 initializeSheets()
// v8.3 新增：
//   - 密碼最短 4 位（原 8 位）；批量／審批初始密碼統一為 1234
//   - 重新覆蓋 Code.gs 並部署後，執行 initializeSheets() 一次即可套用新原則
// v8.5 起：內置超管改制為「只在後端（GS）存在」的虛擬帳號，不再寫入 Users 工作表、不會在用戶管理出現。
// v8.4 新增：活動履歷「團員自行申報 → 領袖審批」
//   - 新工作表「待批履歷」（執行 initializeSheets() 自動補建，不影響既有資料）
//   - 新 action：requestLogRecord（團員申報新增／修改）/ getLogRequests / reviewLogRequest / cancelLogRequest
//   - 團員只可為自己申報；「修改申報」只限自己的紀錄，批准後以同一 record_id 更新（需領袖重批）
//   - 進度待批（待批完成）及其他獎章流程不變：批准後只有領袖可改
//   - handleLoad 回應新增 logRequests + logRequestsSupported
// v8.5 新增：內置超管（sheep）改為「只在 GS 後端存在」的虛擬帳號
//   - 不再寫入 Users 工作表，亦不會在「用戶管理」（USER 表單）出現
//   - 登入／權限驗證／自助改密碼由後端直接處理（密碼存於 Script Properties）
//   - initializeSheets() 會自動移除舊部署已寫入 Users 的超管列（只匹配 sheep / sheep@vsbadge.local）
// v8.7 新增：用戶管理完整顯示及唯一身份保障
//   - YMIS / Email 在單筆、批量、申請及編輯流程均由後端鎖內檢查，不可重複
//   - getAllUsers 合併「Users」及「成員名單」，未開戶成員亦可在前端編輯、開戶或刪除
//   - 領袖可在用戶管理修改／重設成員密碼；刪除後保留識別碼 tombstone 及歷史進度
// ============================================================

const ADMIN_YMIS = '1111111111';
const ADMIN_NAME = '管理員';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASS = 'changeme';
// v8.5：後端（GS）內置超管帳號 —— 只存在於程式碼／Script Properties，不寫入 Users 工作表。
// 可直接以登入帳號 sheep 或 sheep@vsbadge.local 登入；密碼可經「改密碼」自訂（存於 Script Properties）。
const SUPER_ADMIN_ID = 'sheep';
const SUPER_ADMIN_NAME = 'Sheep 超管';
const SUPER_ADMIN_EMAIL = 'sheep@vsbadge.local';
const SUPER_ADMIN_PASS = '0728';
const MIN_PASSWORD_LEN = 4;
const MAX_PASSWORD_LEN = 128;
const DEFAULT_TEMP_PASSWORD = '1234';

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
// v8.2：公開申請入口只接受這三個角色；團長／管理員必須由現任管理層在「用戶管理」直接開立
const APPLY_ROLES = ['member','exec_committee','branch_leader'];
// v8.1：活動履歷
const LOG_SHEET_NAME = '活動履歷';
const LOG_HEADERS = ['record_id','type','ymis','name','date','title','role','hours','cert_no','detail','recorder','recorded_at','updated_at'];
const LOG_TYPES = ['service','activity','training'];
// v8.4：待批履歷（團員自行申報 → 領袖審批）
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

// ===== 超管（v8.5：只存在於後端／GS 的虛擬帳號）=====
// 超管不再寫入 Users 工作表，故所有查詢都在「程式碼層」處理：
// getUser()/getUserByEmail() 會回傳虛擬超管；getAllUsers()/getMembers() 會排除它。
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
// 超管密碼：預設 SUPER_ADMIN_PASS；若曾自行更改，存於 Script Properties（不會寫進 Users 工作表）。
const SUPER_PASS_HASH_PROP='SUPER_ADMIN_PASSWORD_HASH';
function getSuperAdminPasswordHash(){
  const h=PropertiesService.getScriptProperties().getProperty(SUPER_PASS_HASH_PROP);
  return h || hashPassword(SUPER_ADMIN_PASS);
}
function setSuperAdminPasswordHash(plain){
  PropertiesService.getScriptProperties().setProperty(SUPER_PASS_HASH_PROP, hashPassword(plain));
}
function setSuperAdminLastLogin(){
  PropertiesService.getScriptProperties().setProperty('SUPER_ADMIN_LAST_LOGIN', now());
}
// 移除舊部署已寫入 Users 工作表的超管列（只匹配 sheep / sheep@vsbadge.local，不會誤刪其他帳號）
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
  // v8.5：內置超管改為「只在 GS 後端存在」的虛擬帳號，不再寫入 Users 工作表，
  // 也不會在「用戶管理」（USER 表單）出現。若舊部署已把超管寫入 Users，
  // 此處會自動移除該列（只匹配 SUPER_ADMIN_ID / SUPER_ADMIN_EMAIL，不會誤刪其他帳號）。
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
  // v8.1：活動履歷（服務／活動／訓練班紀錄，統一用 type 欄位區分）
  let lSheet = ss.getSheetByName(LOG_SHEET_NAME);
  if(!lSheet){
    lSheet = ss.insertSheet(LOG_SHEET_NAME);
    lSheet.appendRow(LOG_HEADERS);
    lSheet.getRange(1,1,1,LOG_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    lSheet.setFrozenRows(1);
  }
  // v8.4：待批履歷（團員自行申報 → 領袖審批；批准後寫入／更新「活動履歷」）
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
      ui.alert('✅ v8.7 初始化完成！\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章、操作紀錄、活動履歷、待批履歷\n\n🔑 API Key:\n'+apiKey+'\n\n👤 管理員 YMIS: '+ADMIN_YMIS+' 臨時密碼: '+ADMIN_PASS+'（首次登入必須更改）\n👑 超管帳號: '+SUPER_ADMIN_ID+' / 密碼 '+SUPER_ADMIN_PASS+'（只存在於後端，不會在「用戶管理」看到；密碼可用「改密碼」自訂）\n🔢 密碼最短 4 位；批量／審批初始密碼預設 '+DEFAULT_TEMP_PASSWORD+'\n\n🌐 URL:\n'+scriptUrl);
    }
  }catch(e){}
  return {success:true,apiKey:apiKey,scriptUrl:scriptUrl};
}

// ===== 用戶查詢 =====
function getUser(ymis){
  // v8.5：超管為後端虛擬帳號，任何登入／權限驗證都當作有效的 active 用戶。
  if(isSuperAdminId(ymis)) return getSuperAdminUser();
  const rec=findUserRecord(ymis);
  return rec && rec.user.status==='active' ? rec.user : null;
}
function getUserByEmail(email){
  if(!email) return null;
  // v8.5：超管電郵由後端直接處理，不依靠 Users 工作表。
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
      // v8.5：超管不會出現在用戶列表；v8.7：已刪除帳號只留作唯一識別碼 tombstone。
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
      if(new Date()>new Date(data[i][3])){ sheet.deleteRow(i+1); return null; }
      return data[i][1].toString();
    }
  }
  return null;
}
function createToken(ymis){
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const token=generateToken(); const exp=new Date(); exp.setHours(exp.getHours()+24*30);
  sheet.appendRow([token,ymis,now(),Utilities.formatDate(exp,'Asia/Hong_Kong','yyyy-MM-dd HH:mm:ss')]);
  return token;
}
function destroyToken(token){
  if(!token) return;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===token){ sheet.deleteRow(i+1); return; } }
}

// ===== API =====
function doGet(e){
  const action=e.parameter.action;
  if(action==='load'){
    // v4: allow load without apikey for backwards compatibility (troops.json may not have apikey), but if apikey provided, must validate
    const reqKey=e.parameter.apikey;
    if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
    return handleLoad();
  }
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone'});
  return jsonResponse({success:false,error:'Unknown action'});
}
function doPost(e){
  try{
    const body=JSON.parse(e.postData.contents||'{}');
    const action=String(body.action||'');
    if(action==='login') return handleLogin(body.login_id,body.password);
    if(action==='logout'){ destroyToken(body.token); return jsonResponse({success:true}); }
    // v8.2：公開入口接受成員／執委／領袖申請（角色在 handleApply 內嚴格驗證）；
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
    // v8.1：活動履歷（服務／活動／訓練班紀錄）。讀取任何登入者可；寫入／刪除需已獲勾選權限的領袖（同進度寫入）。
    if(action==='getLogRecords') return handleGetLogRecords();
    if(action==='saveLogRecord'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleSaveLogRecord(body.records||(body.record?[body.record]:[]), ymis, body.recorder_name||'');
    }
    if(action==='deleteLogRecord'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleDeleteLogRecord(body.record_id, ymis);
    }
    // v8.4：活動履歷申報（團員自行申報 → 領袖審批）。
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
function handleLogin(loginId,password){
  loginId=String(loginId||'').trim();
  if(!loginId||!password) return jsonResponse({success:false,error:'請填寫帳號和密碼'});
  const user=getUser(loginId)||getUserByEmail(loginId);
  if(!user) return jsonResponse({success:false,error:'找不到此帳號或帳號已停用'});
  // v8.5：超管為只存在於後端（GS）的虛擬帳號，不存放在 Users 工作表。
  if(isSuperAdminId(user.ymis)){
    if(hashPassword(String(password))!==getSuperAdminPasswordHash()) return jsonResponse({success:false,error:'密碼錯誤'});
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
  // v8.5：超管為後端虛擬帳號，密碼存於 Script Properties（不會寫入 Users 工作表）。
  if(isSuperAdminId(ymis)){
    if(hashPassword(String(oldP||''))!==getSuperAdminPasswordHash()) return jsonResponse({success:false,error:'原密碼錯誤'});
    setSuperAdminPasswordHash(newP);
    setSuperAdminLastLogin();
    writeAudit(ymis,'change_password',ymis,'用戶自行更改密碼（超管虛擬帳號）');
    return jsonResponse({success:true,message:'密碼已更新'});
  }
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
  // v8.1：活動履歷（logsSupported 讓前端分辨後端是否已升級）
  const lSheet=ss.getSheetByName(LOG_SHEET_NAME);
  // v8.4：待批履歷（團員自行申報，logRequestsSupported 讓前端分辨後端是否已升級）
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

// ===== v8.1：活動履歷（服務／活動／訓練班紀錄） =====
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

// ===== v8.4：活動履歷申報（團員自行申報 → 領袖審批） =====
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
