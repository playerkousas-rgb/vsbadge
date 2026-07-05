// 深資童軍進度性獎章追蹤系統 - Apps Script 後端
// 版本: 2.0

// 取得或生成 API Key
function getApiKey() {
  const props = PropertiesService.getScriptProperties();
  let apiKey = props.getProperty('API_KEY');
  
  if (!apiKey) {
    // 首次執行，生成並儲存
    apiKey = 'vs_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', apiKey);
  }
  
  return apiKey;
}

// 顯示 API Key（首次部署時執行）
function showApiKey() {
  const apiKey = getApiKey();
  const ui = SpreadsheetApp.getUi();
  ui.alert('API Key', '你的 API Key 是：\n\n' + apiKey + '\n\n請把這個 Key 交給系統管理員。', ui.ButtonSet.OK);
  return apiKey;
}

// 初始化工作表
function initializeSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 建立進度追蹤表
  let progressSheet = ss.getSheetByName('進度追蹤');
  if (!progressSheet) {
    progressSheet = ss.insertSheet('進度追蹤');
    progressSheet.appendRow(['YMIS', '項目ID', '完成日期', '更新時間']);
    progressSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  }
  
  // 建立成員名單表
  let membersSheet = ss.getSheetByName('成員名單');
  if (!membersSheet) {
    membersSheet = ss.insertSheet('成員名單');
    membersSheet.appendRow(['YMIS', '姓名', '加入日期']);
    membersSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  
  // 顯示 API Key
  showApiKey();
  
  SpreadsheetApp.getUi().alert('初始化完成！\n\n已建立：\n- 進度追蹤表\n- 成員名單表\n\nAPI Key 已顯示，請複製給系統管理員。');
}

// GET 請求處理
function doGet(e) {
  const action = e.parameter.action;
  const apiKey = e.parameter.apikey;
  const validKey = getApiKey();
  
  // 驗證 API Key
  if (apiKey !== validKey) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: 'Invalid API Key'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  try {
    if (action === 'load') {
      return handleLoad();
    }
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: 'Unknown action'
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// POST 請求處理
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const apiKey = body.apikey;
    const validKey = getApiKey();
    
    // 驗證 API Key
    if (apiKey !== validKey) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: 'Invalid API Key'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    const action = body.action;
    
    if (action === 'save') {
      return handleSave(body.changes);
    } else if (action === 'addMember') {
      return handleAddMember(body.ymis, body.name);
    }
    
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: 'Unknown action'
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// 處理載入請求
function handleLoad() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 載入進度
  const progressSheet = ss.getSheetByName('進度追蹤');
  const progress = {};
  if (progressSheet) {
    const data = progressSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const ymis = data[i][0];
      const itemId = data[i][1];
      const date = data[i][2];
      if (!progress[ymis]) progress[ymis] = {};
      progress[ymis][itemId] = date;
    }
  }
  
  // 載入成員
  const membersSheet = ss.getSheetByName('成員名單');
  const members = [];
  if (membersSheet) {
    const data = membersSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      members.push({
        ymis: data[i][0],
        name: data[i][1]
      });
    }
  }
  
  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    members: members,
    progress: progress
  })).setMimeType(ContentService.MimeType.JSON);
}

// 處理保存請求
function handleSave(changes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const progressSheet = ss.getSheetByName('進度追蹤');
  
  if (!progressSheet) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: 'Progress sheet not found'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  changes.forEach(change => {
    const { ymis, itemId, action, date } = change;
    
    // 查找現有記錄
    const data = progressSheet.getDataRange().getValues();
    let found = false;
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === ymis && data[i][1] === itemId) {
        if (action === 'uncomplete') {
          progressSheet.deleteRow(i + 1);
        } else {
          progressSheet.getRange(i + 1, 3).setValue(date);
        }
        found = true;
        break;
      }
    }
    
    if (!found && action === 'complete') {
      progressSheet.appendRow([ymis, itemId, date, new Date()]);
    }
  });
  
  return ContentService.createTextOutput(JSON.stringify({
    success: true
  })).setMimeType(ContentService.MimeType.JSON);
}

// 處理新增成員請求
function handleAddMember(ymis, name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let membersSheet = ss.getSheetByName('成員名單');
  
  if (!membersSheet) {
    membersSheet = ss.insertSheet('成員名單');
    membersSheet.appendRow(['YMIS', '姓名', '加入日期']);
    membersSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  
  membersSheet.appendRow([ymis, name, new Date()]);
  
  return ContentService.createTextOutput(JSON.stringify({
    success: true
  })).setMimeType(ContentService.MimeType.JSON);
}
