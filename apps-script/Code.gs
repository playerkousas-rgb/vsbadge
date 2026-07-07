// 深資童軍進度追蹤系統 - Apps Script 後端
// 版本: 2.0

// 設定你的 Google Sheet ID（從 Sheet 網址複製）
const SHEET_ID = 'YOUR_SHEET_ID_HERE';

// 取得 Sheet 物件
function getSheet() {
  return SpreadsheetApp.openById(SHEET_ID);
}

// 取得或生成 API Key
function getApiKey() {
  const props = PropertiesService.getScriptProperties();
  let apiKey = props.getProperty('API_KEY');
  
  if (!apiKey) {
    apiKey = 'vs_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', apiKey);
  }
  
  return apiKey;
}

// 顯示 API Key（首次部署時執行）
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

// 初始化工作表
function initializeSheets() {
  const ss = getSheet();
  
  // 建立進度追蹤表
  let progressSheet = ss.getSheetByName('進度追蹤');
  if (!progressSheet) {
    progressSheet = ss.insertSheet('進度追蹤');
    progressSheet.appendRow(['YMIS', '項目ID', '完成日期', '更新時間']);
    progressSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    progressSheet.setFrozenRows(1);
    progressSheet.getRange('A1:D1').setBackground('#8B0000');
    progressSheet.getRange('A1:D1').setFontColor('#FFFFFF');
  }
  
  // 建立成員名單表
  let membersSheet = ss.getSheetByName('成員名單');
  if (!membersSheet) {
    membersSheet = ss.insertSheet('成員名單');
    membersSheet.appendRow(['YMIS', '姓名', '加入日期']);
    membersSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    membersSheet.setFrozenRows(1);
    membersSheet.getRange('A1:C1').setBackground('#8B0000');
    membersSheet.getRange('A1:C1').setFontColor('#FFFFFF');
  }
  
  // 生成並顯示 API Key
  const apiKey = getApiKey();
  Logger.log('=== 初始化完成 ===');
  Logger.log('API Key: ' + apiKey);
  Logger.log('Sheet ID: ' + SHEET_ID);
  
  // 如果在試算表內執行，顯示對話框
  try {
    const ui = SpreadsheetApp.getUi();
    if (ui) {
      ui.alert(
        '初始化完成！',
        '已建立：\n- 進度追蹤表\n- 成員名單表\n\n' +
        '你的 API Key：\n' + apiKey + '\n\n' +
        '請複製這個 Key 交給系統管理員。',
        ui.ButtonSet.OK
      );
    }
  } catch(e) {
    // 獨立 Apps Script 模式，用 Logger 顯示
  }
  
  return { success: true, apiKey: apiKey };
}

// GET 請求處理
function doGet(e) {
  const action = e.parameter.action;
  const apiKey = e.parameter.apikey;
  const validKey = getApiKey();
  
  if (apiKey !== validKey) {
    return jsonResponse({ success: false, error: 'Invalid API Key' });
  }
  
  if (action === 'load') {
    return handleLoad();
  }
  return jsonResponse({ success: false, error: 'Unknown action' });
}

// POST 請求處理
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const apiKey = body.apikey;
    const validKey = getApiKey();
    
    if (apiKey !== validKey) {
      return jsonResponse({ success: false, error: 'Invalid API Key' });
    }
    
    const action = body.action;
    
    if (action === 'save') {
      return handleSave(body.changes);
    } else if (action === 'addMember') {
      return handleAddMember(body.ymis, body.name);
    }
    
    return jsonResponse({ success: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

// 處理載入請求
function handleLoad() {
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

// 處理保存請求
function handleSave(changes) {
  const ss = getSheet();
  const progressSheet = ss.getSheetByName('進度追蹤');
  
  if (!progressSheet) {
    return jsonResponse({ success: false, error: 'Progress sheet not found. Please run initializeSheets first.' });
  }
  
  let processed = 0;
  
  changes.forEach(change => {
    const { ymis, itemId, date } = change;
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

// 處理新增成員請求
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

// 輔助函式
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
