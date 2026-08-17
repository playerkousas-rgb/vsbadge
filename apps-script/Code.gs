// ============================================================
// 深資童軍進度及行政平台 - Apps Script 後端 v8.2
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
// ============================================================

const ADMIN_YMIS = '1111111111';
const ADMIN_NAME = '管理員';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASS = 'changeme';

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
function userFromRow(row,map){
  function v(name){ const i=map[name]; return i===undefined ? '' : row[i]; }
  return {
    ymis:String(v('ymis')||''), name:String(v('name')||''), email:String(v('email')||''),
    role:String(v('role')||'member'), can_tick:isTrue(v('can_tick')), branch:String(v('branch')||''),
    allowed_badges:String(v('allowed_badges')||''), status:String(v('status')||'active'),
    force_change_password:isTrue(v('force_change_password'))
  };
}
function findUserRecord(ymis){
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const map=ensureUserColumns(sheet); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++) if(String(data[i][map.ymis])===String(ymis)) return {sheet:sheet,row:i+1,map:map,data:data[i],user:userFromRow(data[i],map)};
  return null;
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
    uSheet.appendRow([ADMIN_YMIS,ADMIN_NAME,ADMIN_EMAIL,'admin',hashPassword(ADMIN_PASS),'b4',true,'system',now(),now(),'','active','*',true]);
  } else {
    // 舊版本會自動補上新欄，不需手動改 Sheet；仍使用預設密碼的舊管理員會被要求立即更改。
    const userMap=ensureUserColumns(uSheet);
    const oldUsers=uSheet.getDataRange().getValues();
    for(let i=1;i<oldUsers.length;i++){
      if(String(oldUsers[i][userMap.password_hash]||'')===hashPassword(ADMIN_PASS)) uSheet.getRange(i+1,userMap.force_change_password+1).setValue(true);
    }
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
      ui.alert('✅ v8.1 初始化完成！\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章、操作紀錄、活動履歷\n\n🔑 API Key:\n'+apiKey+'\n\n👤 初始管理員 YMIS: '+ADMIN_YMIS+' 臨時密碼: '+ADMIN_PASS+'（首次登入必須更改）\n\n🌐 URL:\n'+scriptUrl);
    }
  }catch(e){}
  return {success:true,apiKey:apiKey,scriptUrl:scriptUrl};
}

// ===== 用戶查詢 =====
function getUser(ymis){
  const rec=findUserRecord(ymis);
  return rec && rec.user.status==='active' ? rec.user : null;
}
function getUserByEmail(email){
  if(!email) return null;
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const map=ensureUserColumns(sheet); const data=sheet.getDataRange().getValues(); const target=String(email).trim().toLowerCase();
  for(let i=1;i<data.length;i++){
    const user=userFromRow(data[i],map);
    if(user.email.toLowerCase()===target && user.status==='active') return user;
  }
  return null;
}
function getAllUsers(){
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return [];
  const map=ensureUserColumns(sheet); const data=sheet.getDataRange().getValues(); const users=[];
  for(let i=1;i<data.length;i++){
    const user=userFromRow(data[i],map);
    if(user.ymis) users.push(user);
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
  const rec=findUserRecord(user.ymis);
  const map=rec.map;
  if(String(rec.data[map.password_hash]||'')!==hashPassword(String(password))) return jsonResponse({success:false,error:'密碼錯誤'});
  rec.sheet.getRange(rec.row,map.last_login+1).setValue(now());
  const token=createToken(user.ymis);
  return jsonResponse({success:true,token:token,user:user,force_change_password:user.force_change_password});
}
function handleChangePassword(ymis,oldP,newP){
  newP=String(newP||'');
  if(newP.length<8) return jsonResponse({success:false,error:'新密碼至少 8 位'});
  if(newP.length>128) return jsonResponse({success:false,error:'新密碼不可超過 128 位'});
  if(newP===String(oldP||'')) return jsonResponse({success:false,error:'新密碼不可與原密碼相同'});
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
  if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'YMIS 須為 10 位數字'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({success:false,error:'Email 格式不正確'});
  if(role!=='member' && !email) return jsonResponse({success:false,error:'執委／領袖申請必須填寫聯絡電郵'});
  if(findUserRecord(ymis)) return jsonResponse({success:false,error:'YMIS 已註冊或曾建立帳號，請聯絡領袖'});
  if(email){
    const users=getAllUsers();
    if(users.some(function(u){ return u.email && u.email.toLowerCase()===email.toLowerCase(); })) return jsonResponse({success:false,error:'Email 已註冊'});
  }
  const sheet=getSheet().getSheetByName('Applications');
  if(!sheet) return jsonResponse({success:false,error:'Applications 工作表不存在，請先執行 initializeSheets()'});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++) if(String(data[i][1])===ymis && String(data[i][6])==='pending') return jsonResponse({success:false,error:'此 YMIS 已有待審批申請'});
  sheet.appendRow(['APP_'+Date.now(),ymis,name,email,role,branch||'b4','pending',now(),'','','']);
  return jsonResponse({success:true,message:'申請已提交，請等待領袖在前端審批'});
}
function handleGetApplications(){
  const sheet=getSheet().getSheetByName('Applications'); const apps=[];
  if(!sheet) return jsonResponse({success:true,applications:apps});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++) if(String(data[i][6])==='pending') apps.push({app_id:String(data[i][0]),ymis:String(data[i][1]),name:String(data[i][2]),email:String(data[i][3]||''),requested_role:String(data[i][4]||'member'),branch:String(data[i][5]||''),applied_at:data[i][7]?formatDate(data[i][7]):''});
  return jsonResponse({success:true,applications:apps});
}
function generateTemporaryPassword(){ return 'Vs!'+Utilities.getUuid().replace(/-/g,'').substring(0,9); }
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
  // v8.2：按申請人要求的角色開戶；若審批者權限層級不能設定該角色則退回團員（批准後仍可在用戶管理調整）。
  const requestedRole=String(app[4]||'member');
  const finalRole=(VALID_ROLES.indexOf(requestedRole)>=0 && canManageUser(manager,requestedRole)) ? requestedRole : 'member';
  const result=createUsersBatch([{ymis:String(app[1]),name:String(app[2]),email:String(app[3]||''),branch:String(app[5]||''),role:finalRole,can_tick:finalRole!=='member',password:password}],manager);
  if(!result.success || result.created!==1) return jsonResponse({success:false,error:(result.results&&result.results[0]&&result.results[0].error)||'建立帳號失敗'});
  sheet.getRange(rowIndex,7).setValue('approved'); sheet.getRange(rowIndex,9).setValue(manager.ymis); sheet.getRange(rowIndex,10).setValue(now()); sheet.getRange(rowIndex,11).setValue(note||'');
  writeAudit(manager.ymis,'approve_application',String(app[1]),String(appId));
  return jsonResponse({success:true,message:'已批准並建立帳號',temp_password:password,final_role:finalRole});
}
function handleUpdateUserRole(targetYmis,newRole,canTick,managerYmis,allowedBadges){
  const manager=getUser(managerYmis); const rec=findUserRecord(targetYmis);
  if(!manager || !rec || rec.user.status!=='active') return jsonResponse({success:false,error:'找不到管理員或目標用戶'});
  if(String(targetYmis)===String(managerYmis)) return jsonResponse({success:false,error:'不可更改自己的角色或權限'});
  const role=String(newRole||rec.user.role);
  if(VALID_ROLES.indexOf(role)<0) return jsonResponse({success:false,error:'無效角色'});
  if(!canManageUser(manager,rec.user.role) || !canManageUser(manager,role)) return jsonResponse({success:false,error:'你的角色不可管理此用戶或設定此層級'});
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
  const mSheet=getSheet().getSheetByName('成員名單'); const members=[];
  if(mSheet){ const data=mSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0]) members.push({ymis:data[i][0].toString(),name:data[i][1]?data[i][1].toString():''}); } }
  const uSheet=getSheet().getSheetByName('Users'); if(uSheet){ const data=uSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][11].toString()==='active' && data[i][0]){ const y=data[i][0].toString(); if(!members.some(m=>m.ymis===y)){ members.push({ymis:y,name:data[i][1].toString()}); } } } }
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
  return jsonResponse({success:true,members:members,progress:progress,flatProgress:flat,pendingRequests:pending,otherBadges:other,logs:getLogRecordsList(),logsSupported:!!lSheet});
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
    for(let i=1;i<data.length;i++){
      const y=String(data[i][map.ymis]||'').trim(); const e=String(data[i][map.email]||'').trim().toLowerCase();
      if(y) existingYmis[y]=true; if(e) existingEmail[e]=true;
    }
    let mSheet=getSheet().getSheetByName('成員名單');
    if(!mSheet){ mSheet=getSheet().insertSheet('成員名單'); mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡']); }
    const mData=mSheet.getDataRange().getValues(); const memberYmis={};
    for(let i=1;i<mData.length;i++) if(mData[i][0]) memberYmis[String(mData[i][0])]=true;

    const results=[]; const userRows=[]; const memberRows=[]; const batchYmis={}; const batchEmail={};
    rawUsers.forEach(function(raw){
      const u=normalizeNewUser(raw); let error='';
      if(!/^\d{10}$/.test(u.ymis)) error='YMIS 須為 10 位數字';
      else if(!u.name) error='姓名不可留空';
      else if(VALID_ROLES.indexOf(u.role)<0) error='無效角色：'+u.role;
      else if(!canCreateRole(manager,u.role)) error='你的角色不可建立 '+u.role;
      else if(u.role!=='member' && !u.email) error='領袖／執委帳號須填 Email';
      else if(u.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email)) error='Email 格式不正確';
      else if(u.password.length<8) error='臨時密碼至少 8 位';
      else if(u.password.length>128) error='臨時密碼不可超過 128 位';
      else if(existingYmis[u.ymis] || batchYmis[u.ymis]) error='YMIS 已存在（包括停用帳號）';
      else if(u.email && (existingEmail[u.email.toLowerCase()] || batchEmail[u.email.toLowerCase()])) error='Email 已存在';
      if(error){ results.push({ymis:u.ymis,name:u.name,success:false,error:error}); return; }

      const row=new Array(uSheet.getLastColumn()).fill('');
      row[map.ymis]=u.ymis; row[map.name]=u.name; row[map.email]=u.email; row[map.role]=u.role;
      row[map.password_hash]=hashPassword(u.password); row[map.branch]=u.branch;
      row[map.can_tick]=canUserTick(u.role) && u.can_tick; row[map.auth_by]=manager.ymis;
      row[map.auth_date]=now(); row[map.created_at]=now(); row[map.status]='active';
      row[map.allowed_badges]=defaultAllowedBadges(u.role); row[map.force_change_password]=true;
      userRows.push(row); batchYmis[u.ymis]=true; if(u.email) batchEmail[u.email.toLowerCase()]=true;
      if(!memberYmis[u.ymis]){ memberRows.push([u.ymis,u.name,new Date(),u.branch,'']); memberYmis[u.ymis]=true; }
      results.push({ymis:u.ymis,name:u.name,success:true});
    });
    if(userRows.length) uSheet.getRange(uSheet.getLastRow()+1,1,userRows.length,uSheet.getLastColumn()).setValues(userRows);
    if(memberRows.length) mSheet.getRange(mSheet.getLastRow()+1,1,memberRows.length,5).setValues(memberRows);
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
  if(!rec) return jsonResponse({success:false,error:'找不到帳號'});
  if(String(targetYmis)===String(manager.ymis)) return jsonResponse({success:false,error:'請使用「更改密碼」修改自己的密碼'});
  if(!canManageUser(manager,rec.user.role)) return jsonResponse({success:false,error:'權限不足，不能重設此角色'});
  if(newPassword.length<8) return jsonResponse({success:false,error:'臨時密碼至少 8 位'});
  if(newPassword.length>128) return jsonResponse({success:false,error:'臨時密碼不可超過 128 位'});
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
  const rec=findUserRecord(body.target_ymis); if(!rec) return jsonResponse({success:false,error:'找不到帳號'});
  if(String(body.target_ymis)===String(manager.ymis) || !canManageUser(manager,rec.user.role)) return jsonResponse({success:false,error:'權限不足，不能編輯此用戶'});
  const name=safeSheetText(body.name,100); const email=String(body.email||'').trim().substring(0,160); const branch=safeSheetText(body.branch,100);
  if(!name) return jsonResponse({success:false,error:'姓名不可留空'});
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({success:false,error:'Email 格式不正確'});
  const users=getAllUsers();
  if(email && users.some(function(u){ return u.ymis!==rec.user.ymis && u.email.toLowerCase()===email.toLowerCase(); })) return jsonResponse({success:false,error:'Email 已被使用'});
  rec.sheet.getRange(rec.row,rec.map.name+1).setValue(name); rec.sheet.getRange(rec.row,rec.map.email+1).setValue(email); rec.sheet.getRange(rec.row,rec.map.branch+1).setValue(branch);
  const mSheet=getSheet().getSheetByName('成員名單');
  if(mSheet){ const md=mSheet.getDataRange().getValues(); for(let i=1;i<md.length;i++) if(String(md[i][0])===rec.user.ymis){ mSheet.getRange(i+1,2).setValue(name); if(mSheet.getLastColumn()>=4) mSheet.getRange(i+1,4).setValue(branch); break; } }
  writeAudit(manager.ymis,'update_profile',rec.user.ymis,name);
  return jsonResponse({success:true,message:'用戶資料已更新'});
}
function handleSetUserStatus(targetYmis,status,manager){
  status=status==='active'?'active':'inactive'; const rec=findUserRecord(targetYmis);
  if(!rec) return jsonResponse({success:false,error:'找不到帳號'});
  if(String(targetYmis)===String(manager.ymis)) return jsonResponse({success:false,error:'不可停用自己的帳號'});
  if(!canManageUser(manager,rec.user.role)) return jsonResponse({success:false,error:'權限不足，不能管理此角色'});
  rec.sheet.getRange(rec.row,rec.map.status+1).setValue(status);
  if(status==='inactive') destroyTokensForUser(targetYmis);
  writeAudit(manager.ymis,status==='active'?'reactivate_user':'deactivate_user',targetYmis,'帳號狀態='+status);
  return jsonResponse({success:true,message:status==='active'?'帳號已重新啟用':'帳號已停用，進度紀錄獲保留'});
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
          sheet.getRange(i+1,2,1,13).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,sheet.getRange(i+1,11).getValue()||recorderName||recorderYmis,String(data[i][11]||''),now()]]);
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
