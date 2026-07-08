// ============================================================
// 深資童軍進度追蹤系統 - Apps Script 後端
// 版本: 3.3（支援 Email 和 YMIS 雙重登入）
// ============================================================

// ===== 設定 =====

// 預設超管帳號（開發測試用，隱藏）
const DEFAULT_SUPER_YMIS = 'sheep';
const DEFAULT_SUPER_PASSWORD = '0728';

// 預設管理員帳號（旅團第 1 個帳號）
const DEFAULT_ADMIN_YMIS = '0000000000';
const DEFAULT_ADMIN_NAME = '管理員';
const DEFAULT_ADMIN_PASSWORD = 'changeme';
const DEFAULT_ADMIN_EMAIL = 'admin@example.com';

// ===== 工具函式 =====

function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}


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
  if (ui) {
    ui.alert('API Key', '你的 API Key 是：\n\n' + apiKey + '\n\n請把這個 Key 交給系統管理員。', ui.ButtonSet.OK);
  } else {
    Logger.log('API Key: ' + apiKey);
  }
  return apiKey;
}

// SHA256 密碼雜
function hashPassword(password) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8);
  return raw.map(function(b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

// 生成隨機 Token
function generateToken() {
  return Utilities.getUuid().replace(/-/g, '') + Date.now().toString(36);
}

// 取得當前時間
function now() {
  return Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss');
}

function formatDate(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return Utilities.formatDate(d, 'Asia/Hong_Kong', 'yyyy-MM-dd');
  }
  return d.toString();
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 角色權限 =====
const ROLE_HIERARCHY = {
  'super_admin': 100,
  'admin': 80,
  'group_leader': 60,
  'branch_leader': 40,
  'exec_committee': 20,
  'member': 0
};

const CAN_TICK_ROLES = ['super_admin', 'admin', 'group_leader', 'branch_leader', 'exec_committee'];

const CAN_MANAGE_ROLES = {
  'super_admin': ['admin', 'group_leader', 'branch_leader', 'exec_committee', 'member'],
  'admin': ['group_leader', 'branch_leader', 'exec_committee', 'member'],
  'group_leader': ['branch_leader', 'exec_committee', 'member'],
  'branch_leader': ['exec_committee', 'member']
};

function canUserTick(role) {
  return CAN_TICK_ROLES.indexOf(role) >= 0;
}

function getRoleLevel(role) {
  return ROLE_HIERARCHY[role] || 0;
}

function canManageRole(managerRole, targetRole) {
  const allowed = CAN_MANAGE_ROLES[managerRole] || [];
  return allowed.indexOf(targetRole) >= 0;
}

// ===== 初始化 =====

function initializeSheets() {
  const ss = getSheet();
  
  // 1. 進度追蹤表
  let progressSheet = ss.getSheetByName('進度追蹤');
  if (!progressSheet) {
    progressSheet = ss.insertSheet('進度追蹤');
    progressSheet.appendRow(['YMIS', '項目 ID', '完成日期', '更新時間']);
    progressSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    progressSheet.setFrozenRows(1);
    progressSheet.getRange('A1:D1').setBackground('#8B0000');
    progressSheet.getRange('A1:D1').setFontColor('#FFFFFF');
  }
  
  // 2. 成員名單表
  let membersSheet = ss.getSheetByName('成員名單');
  if (!membersSheet) {
    membersSheet = ss.insertSheet('成員名單');
    membersSheet.appendRow(['YMIS', '姓名', '加入日期']);
    membersSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    membersSheet.setFrozenRows(1);
    membersSheet.getRange('A1:C1').setBackground('#8B0000');
    membersSheet.getRange('A1:C1').setFontColor('#FFFFFF');
  }
  
  // 3. Users 表（用戶帳號）- 新增 email 欄位
  let usersSheet = ss.getSheetByName('Users');
  if (!usersSheet) {
    usersSheet = ss.insertSheet('Users');
    usersSheet.appendRow(['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'authorized_by', 'authorized_date', 'created_at', 'last_login', 'status']);
    usersSheet.getRange(1, 1, 1, 12).setFontWeight('bold');
    usersSheet.setFrozenRows(1);
    usersSheet.getRange('A1:L1').setBackground('#8B0000');
    usersSheet.getRange('A1:L1').setFontColor('#FFFFFF');
    
    // 插入預設超管帳號（開發測試用，隱藏）
    usersSheet.appendRow([
      DEFAULT_SUPER_YMIS,
      '系統管理員',
      '',
      'super_admin',
      hashPassword(DEFAULT_SUPER_PASSWORD),
      'all',
      true,
      '',
      '',
      now(),
      '',
      'active'
    ]);
    
    // 插入預設管理員帳號（旅團第 1 個帳號，可立即登入審批申請）
    usersSheet.appendRow([
      DEFAULT_ADMIN_YMIS,
      DEFAULT_ADMIN_NAME,
      DEFAULT_ADMIN_EMAIL,
      'admin',
      hashPassword(DEFAULT_ADMIN_PASSWORD),
      'b4',
      true,
      'system',
      now(),
      now(),
      '',
      'active'
    ]);
  }
  
  // 4. Applications 表（申請紀錄）
  let appsSheet = ss.getSheetByName('Applications');
  if (!appsSheet) {
    appsSheet = ss.insertSheet('Applications');
    appsSheet.appendRow(['app_id', 'ymis', 'name', 'email', 'requested_role', 'branch', 'status', 'applied_at', 'reviewed_by', 'reviewed_at', 'review_note']);
    appsSheet.getRange(1, 1, 1, 11).setFontWeight('bold');
    appsSheet.setFrozenRows(1);
    appsSheet.getRange('A1:K1').setBackground('#8B0000');
    appsSheet.getRange('A1:K1').setFontColor('#FFFFFF');
  }
  
  // 5. Tokens 表（登入 Token）
  let tokensSheet = ss.getSheetByName('Tokens');
  if (!tokensSheet) {
    tokensSheet = ss.insertSheet('Tokens');
    tokensSheet.appendRow(['token', 'ymis', 'created_at', 'expires_at']);
    tokensSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    tokensSheet.setFrozenRows(1);
    tokensSheet.getRange('A1:D1').setBackground('#8B0000');
    tokensSheet.getRange('A1:D1').setFontColor('#FFFFFF');
  }
  
  // 6. SystemConfig 表
  let configSheet = ss.getSheetByName('SystemConfig');
  if (!configSheet) {
    configSheet = ss.insertSheet('SystemConfig');
    configSheet.appendRow(['key', 'value', 'updated_at', 'updated_by']);
    configSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    configSheet.setFrozenRows(1);
    configSheet.getRange('A1:D1').setBackground('#8B0000');
    configSheet.getRange('A1:D1').setFontColor('#FFFFFF');
    
    // 預設為獨立系統模式
    configSheet.appendRow(['login_mode', 'standalone', now(), 'system']);
    configSheet.appendRow(['site_title', '深資童軍進度追蹤', now(), 'system']);
    configSheet.appendRow(['admin_email', DEFAULT_ADMIN_EMAIL, now(), 'system']);
  }
  
  // 生成並顯示 API Key
  const apiKey = getApiKey();
  
  Logger.log('=== 初始化完成 ===');
  Logger.log('API Key: ' + apiKey);
  Logger.log('超管帳號（測試用）: ' + DEFAULT_SUPER_YMIS);
  Logger.log('超管密碼：' + DEFAULT_SUPER_PASSWORD);
  Logger.log('管理員帳號：' + DEFAULT_ADMIN_YMIS);
  Logger.log('管理員 Email: ' + DEFAULT_ADMIN_EMAIL);
  Logger.log('管理員密碼：' + DEFAULT_ADMIN_PASSWORD);
  
  try {
    const ui = SpreadsheetApp.getUi();
    if (ui) {
      ui.alert(
        '初始化完成！\n\n' +
        '已建立工作表：\n' +
        '- 進度追蹤\n' +
        '- 成員名單\n' +
        '- Users（含超管和管理員帳號）\n' +
        '- Applications（申請紀錄）\n' +
        '- Tokens\n' +
        '- SystemConfig\n\n' +
        'API Key：\n' + apiKey + '\n\n' +
        '超管帳號（測試用）：' + DEFAULT_SUPER_YMIS + '\n' +
        '超管密碼：' + DEFAULT_SUPER_PASSWORD + '\n\n' +
        '管理員帳號：' + DEFAULT_ADMIN_YMIS + '\n' +
        '管理員 Email: ' + DEFAULT_ADMIN_EMAIL + '\n' +
        '管理員密碼：' + DEFAULT_ADMIN_PASSWORD + '\n\n' +
        '請複製以上資訊並妥善保管。\n\n' +
        '管理員可以立即登入系統審批新用戶申請。\n' +
        '領袖可以用 Email 登入，成員用 YMIS 登入。',
        ui.ButtonSet.OK
      );
    }
  } catch(e) {}
  
  return { success: true, apiKey: apiKey };
}

// ===== 驗證 =====

function validateApiKey(apiKey) {
  return apiKey === getApiKey();
}

function validateToken(token) {
  if (!token) return null;
  
  const ss = getSheet();
  const tokensSheet = ss.getSheetByName('Tokens');
  if (!tokensSheet) return null;
  
  const data = tokensSheet.getDataRange().getValues();
  const nowTime = new Date();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === token) {
      const expiresAt = new Date(data[i][3]);
      if (nowTime > expiresAt) {
        tokensSheet.deleteRow(i + 1);
        return null;
      }
      return data[i][1].toString();
    }
  }
  return null;
}

function createToken(ymis) {
  const ss = getSheet();
  let tokensSheet = ss.getSheetByName('Tokens');
  if (!tokensSheet) return null;
  
  const token = generateToken();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24 * 30); // 30 天有效期
  
  tokensSheet.appendRow([token, ymis, now(), Utilities.formatDate(expiresAt, 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss')]);
  
  return token;
}

function destroyToken(token) {
  if (!token) return;
  const ss = getSheet();
  const tokensSheet = ss.getSheetByName('Tokens');
  if (!tokensSheet) return;
  
  const data = tokensSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === token) {
      tokensSheet.deleteRow(i + 1);
      return;
    }
  }
}

function getUser(ymis) {
  const ss = getSheet();
  const usersSheet = ss.getSheetByName('Users');
  if (!usersSheet) return null;
  
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === ymis && data[i][11].toString() === 'active') {
      return {
        ymis: data[i][0].toString(),
        name: data[i][1] ? data[i][1].toString() : '',
        email: data[i][2] ? data[i][2].toString() : '',
        role: data[i][3] ? data[i][3].toString() : 'member',
        branch: data[i][5] ? data[i][5].toString() : '',
        can_tick: data[i][6] === true || data[i][6] === 'TRUE',
        created_at: data[i][9] ? formatDate(data[i][9]) : '',
        last_login: data[i][10] ? formatDate(data[i][10]) : '',
        status: data[i][11] ? data[i][11].toString() : 'active'
      };
    }
  }
  return null;
}

function getUserByEmail(email) {
  const ss = getSheet();
  const usersSheet = ss.getSheetByName('Users');
  if (!usersSheet) return null;
  
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][2].toString().toLowerCase() === email.toLowerCase() && data[i][11].toString() === 'active') {
      return {
        ymis: data[i][0].toString(),
        name: data[i][1] ? data[i][1].toString() : '',
        email: data[i][2] ? data[i][2].toString() : '',
        role: data[i][3] ? data[i][3].toString() : 'member',
        branch: data[i][5] ? data[i][5].toString() : '',
        can_tick: data[i][6] === true || data[i][6] === 'TRUE',
        created_at: data[i][9] ? formatDate(data[i][9]) : '',
        last_login: data[i][10] ? formatDate(data[i][10]) : '',
        status: data[i][11] ? data[i][11].toString() : 'active'
      };
    }
  }
  return null;
}

function getAllUsers() {
  const ss = getSheet();
  const usersSheet = ss.getSheetByName('Users');
  if (!usersSheet) return [];
  
  const users = [];
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][11].toString() === 'active' && data[i][0].toString() !== DEFAULT_SUPER_YMIS) {
      users.push({
        ymis: data[i][0].toString(),
        name: data[i][1] ? data[i][1].toString() : '',
        email: data[i][2] ? data[i][2].toString() : '',
        role: data[i][3] ? data[i][3].toString() : 'member',
        branch: data[i][5] ? data[i][5].toString() : '',
        can_tick: data[i][6] === true || data[i][6] === 'TRUE',
        created_at: data[i][9] ? formatDate(data[i][9]) : '',
        last_login: data[i][10] ? formatDate(data[i][10]) : ''
      });
    }
  }
  return users;
}

function getLoginMode() {
  const ss = getSheet();
  const configSheet = ss.getSheetByName('SystemConfig');
  if (!configSheet) return 'standalone';
  
  const data = configSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === 'login_mode') {
      return data[i][1] ? data[i][1].toString() : 'standalone';
    }
  }
  return 'standalone';
}

// ===== API 端點 =====

function doGet(e) {
  const action = e.parameter.action;
  
  if (action === 'load') {
    const apiKey = e.parameter.apikey;
    if (!validateApiKey(apiKey)) {
      return jsonResponse({ success: false, error: 'Invalid API Key' });
    }
    return handleLoad(e.parameter);
  }
  
  if (action === 'getLoginMode') {
    return jsonResponse({ success: true, login_mode: getLoginMode() });
  }
  
  return jsonResponse({ success: false, error: 'Unknown action' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    
    if (action === 'save') {
      const apiKey = body.apikey;
      if (!validateApiKey(apiKey)) {
        return jsonResponse({ success: false, error: 'Invalid API Key' });
      }
      return handleSave(body.changes);
    }
    
    if (action === 'addMember') {
      const apiKey = body.apikey;
      if (!validateApiKey(apiKey)) {
        return jsonResponse({ success: false, error: 'Invalid API Key' });
      }
      return handleAddMember(body.ymis, body.name);
    }
    
    if (action === 'login') {
      return handleLogin(body.login_id, body.password);
    }
    
    if (action === 'logout') {
      return handleLogout(body.token);
    }
    
    if (action === 'getLoginMode') {
      return jsonResponse({ success: true, login_mode: getLoginMode() });
    }
    
    if (action === 'resetPassword') {
      return handleResetPassword(body.login_id, body.email);
    }
    
    if (action === 'updateConfig') {
      const token = body.token;
      const ymis = validateToken(token);
      if (!ymis) return jsonResponse({ success: false, error: 'Invalid or expired token' });
      const user = getUser(ymis);
      if (!user || getRoleLevel(user.role) < getRoleLevel('admin')) {
        return jsonResponse({ success: false, error: 'Unauthorized' });
      }
      return handleUpdateConfig(body.key, body.value, ymis);
    }
    
    if (action === 'apply') {
      return handleApply(body.ymis, body.name, body.email, body.requested_role, body.branch);
    }
    
    if (action === 'getApplications') {
      const token = body.token;
      const ymis = validateToken(token);
      if (!ymis) return jsonResponse({ success: false, error: 'Invalid or expired token' });
      const user = getUser(ymis);
      if (!user || getRoleLevel(user.role) < getRoleLevel('admin')) {
        return jsonResponse({ success: false, error: 'Unauthorized' });
      }
      return handleGetApplications();
    }
    
    if (action === 'reviewApplication') {
      const token = body.token;
      const ymis = validateToken(token);
      if (!ymis) return jsonResponse({ success: false, error: 'Invalid or expired token' });
      const user = getUser(ymis);
      if (!user || getRoleLevel(user.role) < getRoleLevel('admin')) {
        return jsonResponse({ success: false, error: 'Unauthorized' });
      }
      return handleReviewApplication(body.app_id, body.decision, body.review_note, ymis);
    }
    
    if (action === 'updateUserRole') {
      const token = body.token;
      const ymis = validateToken(token);
      if (!ymis) return jsonResponse({ success: false, error: 'Invalid or expired token' });
      const user = getUser(ymis);
      if (!user || getRoleLevel(user.role) < getRoleLevel('admin')) {
        return jsonResponse({ success: false, error: 'Unauthorized' });
      }
      return handleUpdateUserRole(body.target_ymis, body.new_role, body.can_tick, ymis);
    }
    
    if (action === 'getAllUsers') {
      const token = body.token;
      const ymis = validateToken(token);
      if (!ymis) return jsonResponse({ success: false, error: 'Invalid or expired token' });
      const user = getUser(ymis);
      if (!user || getRoleLevel(user.role) < getRoleLevel('admin')) {
        return jsonResponse({ success: false, error: 'Unauthorized' });
      }
      return jsonResponse({ success: true, users: getAllUsers() });
    }
    
    if (action === 'changePassword') {
      const token = body.token;
      const ymis = validateToken(token);
      if (!ymis) return jsonResponse({ success: false, error: 'Invalid or expired token' });
      return handleChangePassword(ymis, body.old_password, body.new_password);
    }
    
    return jsonResponse({ success: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

// ===== 登入/登出 =====

function handleLogin(loginId, password) {
  if (!loginId || !password) {
    return jsonResponse({ success: false, error: '請填寫登入帳號和密碼' });
  }
  
  let user = null;
  
  // 嘗試用 YMIS 登入
  if (/^\d{10}$/.test(loginId)) {
    user = getUser(loginId);
  }
  
  // 嘗試用 Email 登入
  if (!user && loginId.includes('@')) {
    user = getUserByEmail(loginId);
  }
  
  if (!user) {
    return jsonResponse({ success: false, error: '找不到此帳號' });
  }
  
  const passwordHash = hashPassword(password);
  const ss = getSheet();
  const usersSheet = ss.getSheetByName('Users');
  const data = usersSheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const accountYmis = data[i][0].toString();
    const accountEmail = data[i][2].toString().toLowerCase();
    const accountPassword = data[i][4].toString();
    const accountStatus = data[i][11].toString();
    
    if (accountStatus === 'active' && accountPassword === passwordHash) {
      if (accountYmis === user.ymis || accountEmail === user.email.toLowerCase()) {
        const token = createToken(user.ymis);
        usersSheet.getRange(i + 1, 11).setValue(now());
        
        return jsonResponse({
          success: true,
          token: token,
          user: user
        });
      }
    }
  }
  
  return jsonResponse({ success: false, error: '密碼錯誤' });
}

function handleLogout(token) {
  destroyToken(token);
  return jsonResponse({ success: true });
}

function handleResetPassword(loginId, email) {
  if (!loginId) {
    return jsonResponse({ success: false, error: '請填寫 YMIS 或 Email' });
  }
  
  let user = null;
  
  if (/^\d{10}$/.test(loginId)) {
    user = getUser(loginId);
  } else if (loginId.includes('@')) {
    user = getUserByEmail(loginId);
  }
  
  if (!user) {
    return jsonResponse({ success: false, error: '找不到此帳號' });
  }
  
  const ss = getSheet();
  const configSheet = ss.getSheetByName('SystemConfig');
  let adminEmail = '';
  if (configSheet) {
    const configData = configSheet.getDataRange().getValues();
    for (let i = 1; i < configData.length; i++) {
      if (configData[i][0] === 'admin_email') {
        adminEmail = configData[i][1] ? configData[i][1].toString() : '';
        break;
      }
    }
  }
  
  const recipientEmail = email || user.email || adminEmail;
  if (!recipientEmail) {
    return jsonResponse({ success: false, error: '系統未設定管理員 Email，且用戶沒有 Email' });
  }
  
  const newPassword = Utilities.getUuid().substring(0, 8);
  const newHash = hashPassword(newPassword);
  
  const usersSheet = ss.getSheetByName('Users');
  const userData = usersSheet.getDataRange().getValues();
  for (let i = 1; i < userData.length; i++) {
    if (userData[i][0].toString() === user.ymis) {
      usersSheet.getRange(i + 1, 5).setValue(newHash);
      break;
    }
  }
  
  try {
    MailApp.sendEmail({
      to: recipientEmail,
      subject: '【深資童軍進度追蹤】密碼重置',
      htmlBody: '<p>您好，' + (user.name || user.ymis) + '：</p>' +
                '<p>您的密碼已重置為：<strong>' + newPassword + '</strong></p>' +
                '<p>請儘快登入並更改密碼。</p>' +
                '<p>如果您沒有要求重置密碼，請忽略此郵件。</p>'
    });
  } catch(e) {
    return jsonResponse({ success: false, error: 'Email 發送失敗：' + e.toString() });
  }
  
  return jsonResponse({ success: true, message: '新密碼已發送至 ' + recipientEmail });
}

function handleChangePassword(ymis, oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 6) {
    return jsonResponse({ success: false, error: '新密碼至少 6 位元' });
  }
  
  const user = getUser(ymis);
  if (!user) {
    return jsonResponse({ success: false, error: '找不到此帳號' });
  }
  
  const oldHash = hashPassword(oldPassword);
  const ss = getSheet();
  const usersSheet = ss.getSheetByName('Users');
  const data = usersSheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === ymis && data[i][4].toString() === oldHash && data[i][11].toString() === 'active') {
      usersSheet.getRange(i + 1, 5).setValue(hashPassword(newPassword));
      return jsonResponse({ success: true });
    }
  }
  
  return jsonResponse({ success: false, error: '原密碼錯誤' });
}

function handleUpdateConfig(key, value, ymis) {
  const ss = getSheet();
  const configSheet = ss.getSheetByName('SystemConfig');
  if (!configSheet) {
    return jsonResponse({ success: false, error: 'SystemConfig 表不存在' });
  }
  
  const data = configSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      configSheet.getRange(i + 1, 2).setValue(value);
      configSheet.getRange(i + 1, 3).setValue(now());
      configSheet.getRange(i + 1, 4).setValue(ymis);
      return jsonResponse({ success: true });
    }
  }
  
  configSheet.appendRow([key, value, now(), ymis]);
  return jsonResponse({ success: true });
}

// ===== 申請系統 =====

function handleApply(ymis, name, email, requested_role, branch) {
  if (!name) {
    return jsonResponse({ success: false, error: '請填寫姓名' });
  }
  
  // 如果是成員申請，需要 YMIS
  if (requested_role === 'member' || requested_role === 'exec_committee') {
    if (!ymis) {
      return jsonResponse({ success: false, error: '成員申請需要填寫 YMIS' });
    }
    if (ymis.length !== 10 || !/^\d+$/.test(ymis)) {
      return jsonResponse({ success: false, error: 'YMIS 必須是 10 位數字' });
    }
  }
  
  // 如果是領袖申請，需要 Email
  if (requested_role === 'group_leader' || requested_role === 'branch_leader') {
    if (!email) {
      return jsonResponse({ success: false, error: '領袖申請需要填寫 Email' });
    }
    if (!email.includes('@')) {
      return jsonResponse({ success: false, error: 'Email 格式不正確' });
    }
  }
  
  // 檢查是否已存在
  if (ymis) {
    const existingUser = getUser(ymis);
    if (existingUser) {
      return jsonResponse({ success: false, error: '此 YMIS 已註冊' });
    }
  }
  
  if (email) {
    const existingUser = getUserByEmail(email);
    if (existingUser) {
      return jsonResponse({ success: false, error: '此 Email 已註冊' });
    }
  }
  
  const ss = getSheet();
  const appsSheet = ss.getSheetByName('Applications');
  if (!appsSheet) {
    return jsonResponse({ success: false, error: 'Applications 表不存在' });
  }
  
  const appId = 'APP_' + Date.now();
  appsSheet.appendRow([
    appId,
    ymis || '',
    name,
    email || '',
    requested_role || 'member',
    branch || 'b4',
    'pending',
    now(),
    '',
    '',
    ''
  ]);
  
  return jsonResponse({ success: true, message: '申請已提交，請等待管理員審批' });
}

function handleGetApplications() {
  const ss = getSheet();
  const appsSheet = ss.getSheetByName('Applications');
  if (!appsSheet) {
    return jsonResponse({ success: false, error: 'Applications 表不存在' });
  }
  
  const applications = [];
  const data = appsSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][6].toString() === 'pending') {
      applications.push({
        app_id: data[i][0].toString(),
        ymis: data[i][1] ? data[i][1].toString() : '',
        name: data[i][2] ? data[i][2].toString() : '',
        email: data[i][3] ? data[i][3].toString() : '',
        requested_role: data[i][4] ? data[i][4].toString() : 'member',
        branch: data[i][5] ? data[i][5].toString() : '',
        applied_at: data[i][7] ? formatDate(data[i][7]) : ''
      });
    }
  }
  
  return jsonResponse({ success: true, applications: applications });
}

function handleReviewApplication(appId, decision, reviewNote, reviewerYmis) {
  const ss = getSheet();
  const appsSheet = ss.getSheetByName('Applications');
  if (!appsSheet) {
    return jsonResponse({ success: false, error: 'Applications 表不存在' });
  }
  
  const data = appsSheet.getDataRange().getValues();
  let found = false;
  let appData = null;
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === appId) {
      appData = data[i];
      appsSheet.getRange(i + 1, 7).setValue(decision);
      appsSheet.getRange(i + 1, 9).setValue(reviewerYmis);
      appsSheet.getRange(i + 1, 10).setValue(now());
      appsSheet.getRange(i + 1, 11).setValue(reviewNote || '');
      found = true;
      break;
    }
  }
  
  if (!found) {
    return jsonResponse({ success: false, error: '找不到申請紀錄' });
  }
  
  if (decision === 'approved') {
    // 建立用戶帳號
    const usersSheet = ss.getSheetByName('Users');
    if (!usersSheet) {
      return jsonResponse({ success: false, error: 'Users 表不存在' });
    }
    
    const newPassword = DEFAULT_ADMIN_PASSWORD;
    const passwordHash = hashPassword(newPassword);
    
    // 如果是領袖申請，生成自訂 YMIS
    let userYmis = appData[1] ? appData[1].toString() : '';
    if (!userYmis && (appData[4] === 'group_leader' || appData[4] === 'branch_leader')) {
      // 生成領袖專用的 YMIS（L 開頭 + 時間戳）
      userYmis = 'L' + Date.now().toString().substring(7);
    }
    
    usersSheet.appendRow([
      userYmis,
      appData[2], // name
      appData[3] ? appData[3].toString() : '', // email
      appData[4], // role
      passwordHash,
      appData[5], // branch
      true, // can_tick
      reviewerYmis,
      now(),
      now(),
      '',
      'active'
    ]);
    
    // 同時加入成員名單
    let membersSheet = ss.getSheetByName('成員名單');
    if (!membersSheet) {
      membersSheet = ss.insertSheet('成員名單');
      membersSheet.appendRow(['YMIS', '姓名', '加入日期']);
    }
    membersSheet.appendRow([userYmis, appData[2], new Date()]);
    
    return jsonResponse({ 
      success: true, 
      message: '申請已批准，用戶已建立。預設密碼：' + newPassword 
    });
  }
  
  return jsonResponse({ success: true, message: '申請已拒絕' });
}

function handleUpdateUserRole(targetYmis, newRole, canTick, managerYmis) {
  const manager = getUser(managerYmis);
  if (!manager) {
    return jsonResponse({ success: false, error: '管理員帳號不存在' });
  }
  
  if (!canManageRole(manager.role, newRole)) {
    return jsonResponse({ success: false, error: '權限不足，無法設定此角色' });
  }
  
  const ss = getSheet();
  const usersSheet = ss.getSheetByName('Users');
  const data = usersSheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === targetYmis && data[i][11].toString() === 'active') {
      usersSheet.getRange(i + 1, 4).setValue(newRole);
      usersSheet.getRange(i + 1, 7).setValue(canTick);
      usersSheet.getRange(i + 1, 8).setValue(managerYmis);
      usersSheet.getRange(i + 1, 9).setValue(now());
      return jsonResponse({ success: true });
    }
  }
  
  return jsonResponse({ success: false, error: '找不到目標用戶' });
}

// ===== 資料操作 =====

function handleLoad(params) {
  const ss = getSheet();
  
  const progressSheet = ss.getSheetByName('進度追蹤');
  const progress = {};
  if (progressSheet) {
    const data = progressSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const ymis = data[i][0].toString();
      const itemId = data[i][1].toString();
      const date = data[i][2] ? formatDate(data[i][2]) : '';
      if (!progress[ymis]) progress[ymis] = {};
      progress[ymis][itemId] = date;
    }
  }
  
  const membersSheet = ss.getSheetByName('成員名單');
  const members = [];
  if (membersSheet) {
    const data = membersSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      members.push({
        ymis: data[i][0].toString(),
        name: data[i][1] ? data[i][1].toString() : ''
      });
    }
  }
  
  return jsonResponse({ success: true, members: members, progress: progress });
}

function handleSave(changes) {
  const ss = getSheet();
  const progressSheet = ss.getSheetByName('進度追蹤');
  
  if (!progressSheet) {
    return jsonResponse({ success: false, error: 'Progress sheet not found' });
  }
  
  let processed = 0;
  
  changes.forEach(function(change) {
    const ymis = change.ymis;
    const itemId = change.itemId;
    const date = change.date;
    const uncomplete = change.uncomplete || false;
    
    const data = progressSheet.getDataRange().getValues();
    let found = false;
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString() === ymis && data[i][1].toString() === itemId) {
        if (uncomplete) {
          progressSheet.deleteRow(i + 1);
        } else {
          progressSheet.getRange(i + 1, 3).setValue(date);
        }
        found = true;
        processed++;
        break;
      }
    }
    
    if (!found && !uncomplete) {
      progressSheet.appendRow([ymis, itemId, date, new Date()]);
      processed++;
    }
  });
  
  return jsonResponse({ success: true, processed: processed });
}

function handleAddMember(ymis, name) {
  const ss = getSheet();
  let membersSheet = ss.getSheetByName('成員名單');
  
  if (!membersSheet) {
    membersSheet = ss.insertSheet('成員名單');
    membersSheet.appendRow(['YMIS', '姓名', '加入日期']);
    membersSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  
  membersSheet.appendRow([ymis, name, new Date()]);
  return jsonResponse({ success: true });
}
