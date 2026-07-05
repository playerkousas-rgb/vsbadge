/**
 * 深資童軍進度性獎章追蹤系統 v2.0 — Google Apps Script 後端
 * 
 * 第3級元件 — 需要 API Key 鎖定
 * 
 * 部署方式：
 * 1. 開啟 Google Sheet
 * 2. extensions → Apps Script
 * 3. 貼上此程式碼
 * 4. 設定 API_KEY（在下方修改）
 * 5. 執行 initializeSheets() 初始化
 * 6. 部署 → 新增部署 → 網頁應用程式
 *    - 執行身分：我
 *    - 存取權：任何人
 * 7. 複製 Web App URL
 * 8. 在主系統元件卡片設定 URL：
 *    https://YOUR-VERCEL.vercel.app/?backend=YOUR_SCRIPT_URL&apikey=YOUR_KEY
 */

// ===== 設定 =====
const SHEET_ID = 'YOUR_GOOGLE_SHEET_ID'; // ← 替換為你的 Google Sheet ID
const API_KEY = 'YOUR_API_KEY_HERE';      // ← 設定你的 API Key（與前端 URL 中 apikey= 參數一致）

// ===== GET: 讀取資料 =====
function doGet(e) {
  // API Key 驗證（第3級元件安全鎖）
  const reqKey = e.parameter.apikey || '';
  if (API_KEY && reqKey !== API_KEY) {
    return jsonResponse({error: 'Unauthorized: Invalid API Key'});
  }
  
  const action = e.parameter.action || 'load';
  
  if (action === 'load') {
    return loadAllData(e.parameter.u);
  }
  
  return jsonResponse({error: 'Unknown action'});
}

// ===== POST: 寫入資料 =====
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    
    // API Key 驗證
    if (API_KEY && body.apikey !== API_KEY) {
      return jsonResponse({error: 'Unauthorized: Invalid API Key'});
    }
    
    const action = body.action;
    
    if (action === 'save') {
      return saveChanges(body);
    }
    if (action === 'addMember') {
      return addMember(body);
    }
    
    return jsonResponse({error: 'Unknown action'});
  } catch (err) {
    return jsonResponse({error: err.message});
  }
}

// ===== 讀取所有資料 =====
function loadAllData(unit) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  
  // Read members
  const rosterSheet = ss.getSheetByName('成員名單');
  if (!rosterSheet) return jsonResponse({members:[], progress:{}});
  
  const rosterData = rosterSheet.getDataRange().getValues();
  const members = [];
  for (let i = 1; i < rosterData.length; i++) {
    const row = rosterData[i];
    if (row[0] && row[0].toString().trim()) {
      members.push({
        ymis: row[0].toString(),
        name: row[1] ? row[1].toString() : ''
      });
    }
  }
  
  // Read progress
  const progressSheet = ss.getSheetByName('進度紀錄');
  if (!progressSheet) return jsonResponse({members, progress:{}});
  
  const progressData = progressSheet.getDataRange().getValues();
  const progress = {};
  for (let i = 1; i < progressData.length; i++) {
    const row = progressData[i];
    if (row[0] && row[1]) {
      const ymis = row[0].toString();
      const itemId = row[1].toString();
      const date = row[3] ? formatDate(row[3]) : '';
      if (!progress[ymis]) progress[ymis] = {};
      progress[ymis][itemId] = date;
    }
  }
  
  return jsonResponse({members, progress});
}

// ===== 批量保存變更 =====
function saveChanges(body) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const progressSheet = ss.getSheetByName('進度紀錄');
  if (!progressSheet) {
    return jsonResponse({error: '進度紀錄工作表不存在，請先執行 initializeSheets()'});
  }
  
  const changes = body.changes || [];
  let processed = 0;
  
  changes.forEach(change => {
    const {ymis, itemId, action, date} = change;
    
    // Find existing row
    const data = progressSheet.getDataRange().getValues();
    let foundRow = -1;
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString() === ymis && data[i][1].toString() === itemId) {
        foundRow = i + 1; // 1-indexed
        break;
      }
    }
    
    if (action === 'complete') {
      if (foundRow > 0) {
        progressSheet.getRange(foundRow, 4).setValue(date);
        progressSheet.getRange(foundRow, 5).setValue('Leader');
      } else {
        progressSheet.appendRow([ymis, itemId, findItemName(itemId), date, 'Leader']);
      }
      processed++;
    } else if (action === 'uncomplete') {
      if (foundRow > 0) {
        progressSheet.deleteRow(foundRow);
        processed++;
      }
    }
  });
  
  return jsonResponse({success: true, processed});
}

// ===== 新增成員 =====
function addMember(body) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const rosterSheet = ss.getSheetByName('成員名單');
  if (!rosterSheet) {
    return jsonResponse({error: '成員名單工作表不存在'});
  }
  
  const ymis = body.ymis || '';
  const name = body.name || '';
  
  if (!ymis || !name) {
    return jsonResponse({error: 'Missing ymis or name'});
  }
  
  rosterSheet.appendRow([ymis, name]);
  
  return jsonResponse({success: true, ymis, name});
}

// ===== 輔助函式 =====
function findItemName(itemId) {
  // Try to find in items definition sheet
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const itemsSheet = ss.getSheetByName('項目定義');
  if (!itemsSheet) return itemId;
  
  const data = itemsSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === itemId) {
      return data[i][1].toString();
    }
  }
  return itemId;
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

// ===== 初始化工作表（執行一次） =====
function initializeSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  
  // Sheet 1: 成員名單
  let sheet1 = ss.getSheetByName('成員名單');
  if (!sheet1) {
    sheet1 = ss.insertSheet('成員名單');
    sheet1.appendRow(['ymis', 'name']);
    sheet1.getRange(1, 1, 1, 2).setFontWeight('bold');
    sheet1.setFrozenRows(1);
  }
  
  // Sheet 2: 進度紀錄
  let sheet2 = ss.getSheetByName('進度紀錄');
  if (!sheet2) {
    sheet2 = ss.insertSheet('進度紀錄');
    sheet2.appendRow(['ymis', 'item_id', 'item_name', 'completed_date', 'updated_by']);
    sheet2.getRange(1, 1, 1, 5).setFontWeight('bold');
    sheet2.setFrozenRows(1);
  }
  
  // Sheet 3: 項目定義（靜態參考）
  let sheet3 = ss.getSheetByName('項目定義');
  if (!sheet3) {
    sheet3 = ss.insertSheet('項目定義');
    sheet3.appendRow(['item_id', 'display_name', 'badge', 'segment']);
    sheet3.getRange(1, 1, 1, 4).setFontWeight('bold');
    sheet3.setFrozenRows(1);
    
    populateItemDefinitions(sheet3);
  }
  
  return 'Sheets initialized successfully!';
}

function populateItemDefinitions(sheet) {
  // All items from the 4-level hierarchy
  const allItems = [
    // === 會員章 ===
    ['MB-ACT-01-1','出席團活動1','會員章','活動'],
    ['MB-ACT-01-2','出席團活動2','會員章','活動'],
    ['MB-ACT-01-3','出席團活動3','會員章','活動'],
    ['MB-ACT-01-4','出席團活動4','會員章','活動'],
    ['MB-ACT-01-5','出席團活動5','會員章','活動'],
    ['MB-ACT-01-6','出席團活動6（須含戶外）','會員章','活動'],
    ['MB-UND-01','明瞭童軍運動的目的及期望','會員章','理解'],
    ['MB-UND-02','認識香港及世界童軍運動','會員章','理解'],
    ['MB-UND-03','辨認國旗國徽並說明含意','會員章','理解'],
    ['MB-UND-04','辨認區旗區徽並說明含意','會員章','理解'],
    ['MB-UND-05','明瞭國歌用意並能背唱','會員章','理解'],
    ['MB-ETQ-01','認識童軍禮儀及基本步操','會員章','禮節'],
    ['MB-ETQ-02','國歌國旗區旗禮儀','會員章','禮節'],
    ['MB-ETQ-03','升掛國旗區旗注意事項','會員章','禮節'],
    ['MB-ETQ-04','示範國旗區旗升掛方法','會員章','禮節'],
    ['MB-PRM-01','接納童軍誓詞與規律','會員章','許諾'],
    ['MB-CP-01a','保護兒童基本認識','會員章','保護兒童'],
    ['MB-CP-01b','完成保護兒童網上自學課程','會員章','保護兒童'],
    
    // === 深資童軍肩章 — 認識 ===
    ['EP-UND-01','說出支部目的方法及預期成果','肩章','認識'],
    ['EP-UND-02','認識深資童軍制服','肩章','認識'],
    ['EP-UND-03','明瞭獎章四個考驗組別','肩章','認識'],
    ['EP-UND-04','明瞭獎章與其他機構關係','肩章','認識'],
    ['EP-UND-05','說出執行委員會基本功能','肩章','認識'],
    ['EP-UND-06','說出執委會組織及職責','肩章','認識'],
    ['EP-UND-07','明瞭執委會產生方法','肩章','認識'],
    ['EP-UND-08','明瞭執委會中領袖角色','肩章','認識'],
    ['EP-UND-09','認識多元化深資童軍活動','肩章','認識'],
    ['EP-UND-10','參加最少一次執委會會議','肩章','認識'],
    
    // === 肩章 — 童軍技能 ===
    ['EP-CAMP-01','完成兩日一夜露營','肩章','露營'],
    ['EP-CAMP-02','準備個人及小隊物資清單','肩章','露營'],
    ['EP-CAMP-03','收拾背囊及急救藥囊','肩章','露營'],
    ['EP-CAMP-04','正確架搭收拾存放營幕','肩章','露營'],
    ['EP-CAMP-05','使用氣爐摺刀安全措施','肩章','露營'],
    ['EP-CAMP-06','設計食譜及烹調菜式','肩章','露營'],
    ['EP-CAMP-07','以火柴及天然物生火','肩章','露營'],
    ['EP-KNOT-01','示範九種繩結並說用途','肩章','繩結'],
    ['EP-HIKE-01','認識地圖種類及圖例','肩章','遠足'],
    ['EP-HIKE-02','運用指南針地圖戶外活動','肩章','遠足'],
    ['EP-FA-01','急救目的及原則','肩章','急救'],
    ['EP-FA-02','出血處理傷口護理包紥','肩章','急救'],
    ['EP-FA-03','燒傷燙傷抽筋扭傷處理','肩章','急救'],
    
    // === 深資童軍獎章 — 活動策劃 ===
    ['VA-PRJ-01','完成執行委員會工作坊','獎章','活動策劃'],
    
    // === 獎章 — 社會服務 ===
    ['VA-SVC-I-01','急救課程證書','獎章','社會服務'],
    ['VA-SVC-I-02','拯溺銅章或以上','獎章','社會服務'],
    ['VA-SVC-II-01','消防訓練班','獎章','社會服務'],
    ['VA-SVC-II-02','泳池/沙灘救生章','獎章','社會服務'],
    ['VA-SVC-II-03','手語課程20小時','獎章','社會服務'],
    ['VA-SVC-II-04','精神健康急救證書','獎章','社會服務'],
    ['VA-SVC-II-05','SOUL Keeper Level 2','獎章','社會服務'],
    ['VA-SVC-II-06','共融大使訓練班','獎章','社會服務'],
    
    // === 獎章 — 多元技能（童軍技能） ===
    ['VA-SCOUT-01','原野生活知識','獎章','童軍技能'],
    ['VA-SCOUT-02','先鋒工程（知識及技巧）','獎章','童軍技能'],
    
    // === 獎章 — 多元技能（個人興趣） ===
    ['VA-INT-203','飛行','獎章','個人興趣'],
    ['VA-INT-204','跳傘','獎章','個人興趣'],
    ['VA-INT-205','獨木舟建造','獎章','個人興趣'],
    ['VA-INT-206','飛機及直升機飛行員理論','獎章','個人興趣'],
    ['VA-INT-207','天象','獎章','個人興趣'],
    ['VA-INT-208','護養','獎章','個人興趣'],
    ['VA-INT-209','釣魚','獎章','個人興趣'],
    ['VA-INT-210','林務','獎章','個人興趣'],
    ['VA-INT-211','園藝','獎章','個人興趣'],
    ['VA-INT-212','業餘無線電','獎章','個人興趣'],
    ['VA-INT-213','書法','獎章','個人興趣'],
    ['VA-INT-214','陶藝','獎章','個人興趣'],
    ['VA-INT-215','繪畫','獎章','個人興趣'],
    ['VA-INT-216','雕塑','獎章','個人興趣'],
    ['VA-INT-217','平面設計','獎章','個人興趣'],
    ['VA-INT-218','絲網印刷','獎章','個人興趣'],
    ['VA-INT-219','民政','獎章','個人興趣'],
    ['VA-INT-220','電腦','獎章','個人興趣'],
    ['VA-INT-221','攝影','獎章','個人興趣'],
    ['VA-INT-222','數碼攝影','獎章','個人興趣'],
    ['VA-INT-223','電影理論及拍攝技巧','獎章','個人興趣'],
    ['VA-INT-224','話劇','獎章','個人興趣'],
    ['VA-INT-225','語言','獎章','個人興趣'],
    ['VA-INT-226','氣象','獎章','個人興趣'],
    ['VA-INT-227','音樂','獎章','個人興趣'],
    ['VA-INT-228','集郵','獎章','個人興趣'],
    ['VA-INT-229','演辯','獎章','個人興趣'],
    ['VA-INT-230','溜冰','獎章','個人興趣'],
    ['VA-INT-231','魔術','獎章','個人興趣'],
    ['VA-INT-232','時裝裁剪','獎章','個人興趣'],
    ['VA-INT-233','自家烘焙','獎章','個人興趣'],
    ['VA-INT-234','收音機製造','獎章','個人興趣'],
    ['VA-INT-235','海上活動-水手長','獎章','個人興趣'],
    ['VA-INT-236','海上活動-副舵手','獎章','個人興趣'],
    ['VA-INT-237','海上活動-舵手','獎章','個人興趣'],
    ['VA-INT-238','航空活動-初級空勤員','獎章','個人興趣'],
    ['VA-INT-239','航空活動-中級空勤員','獎章','個人興趣'],
    ['VA-INT-240','航空活動-高級空勤員','獎章','個人興趣'],
    ['VA-INT-999D','A-999 步操','獎章','個人興趣'],
    ['VA-INT-999L','A-999 皮革','獎章','個人興趣'],
    ['VA-INT-999DB','A-999 龍舟','獎章','個人興趣'],
    ['VA-INT-999UAV','A-999 無人駕駛飛行器','獎章','個人興趣'],
    ['VA-INT-9993D','A-999 3D打印','獎章','個人興趣'],
    ['VA-INT-999TW','A-999 拔河','獎章','個人興趣'],
    
    // === 獎章 — 多元技能（康樂體育） ===
    ['VA-SP-301','運動I/球類活動','獎章','康樂體育'],
    ['VA-SP-302','運動II/水上活動','獎章','康樂體育'],
    ['VA-SP-303','運動III','獎章','康樂體育'],
    ['VA-SP-304','射擊','獎章','康樂體育'],
    ['VA-SP-305','氣手鎗射擊','獎章','康樂體育'],
    ['VA-SP-306','野外定向','獎章','康樂體育'],
    ['VA-SP-307','箭術','獎章','康樂體育'],
    ['VA-SP-308','獨木舟（非競賽性）','獎章','康樂體育'],
    ['VA-SP-309','單車（非競賽性）','獎章','康樂體育'],
    ['VA-SP-310','馬術','獎章','康樂體育'],
    ['VA-SP-311','風帆（非競賽性）','獎章','康樂體育'],
    ['VA-SP-312','體適能訓練','獎章','康樂體育'],
    
    // === 獎章 — 戶外探險 ===
    ['VA-EXP-001','地圖閱讀訓練','獎章','戶外探險'],
    ['VA-EXP-002','遠足訓練','獎章','戶外探險'],
    ['VA-EXP-003','陸上徒步遠足40km','獎章','戶外探險'],
    ['VA-EXP-004','單車探險160km','獎章','戶外探險'],
    ['VA-EXP-005','自行駕駛650km','獎章','戶外探險'],
    ['VA-EXP-006','機動化境外遠足800km','獎章','戶外探險'],
    ['VA-EXP-007','海上探險-標準艇50km','獎章','戶外探險'],
    ['VA-EXP-008','海上探險-獨木舟50km','獎章','戶外探險'],
    ['VA-EXP-009','海上探險-風帆50km','獎章','戶外探險'],
    
    // === 榮譽童軍獎章 — 活動策劃金帶 ===
    ['DS-PRJ-01','實踐活動策劃','榮譽童軍','活動策劃金帶'],
    ['DS-PRJ-02','實踐活動策劃（外宿五日四夜）','榮譽童軍','活動策劃金帶'],
    
    // === 榮譽童軍 — 社會服務金帶 ===
    ['DS-SVC-A-01','童軍運動基本原則訓練班','榮譽童軍','社會服務金帶'],
    ['DS-SVC-A-02','童軍單位內服務26小時','榮譽童軍','社會服務金帶'],
    ['DS-SVC-A-03','社區服務26小時','榮譽童軍','社會服務金帶'],
    ['DS-SVC-B-01','志願服務52小時','榮譽童軍','社會服務金帶'],
    ['DS-SVC-C-01','寰宇童軍計劃探索課程','榮譽童軍','社會服務金帶'],
    ['DS-SVC-C-02','組織行動小組自願服務','榮譽童軍','社會服務金帶'],
    
    // === 榮譽童軍 — 多元技能金帶 ===
    ['DS-SCOUT-01','露營技藝及營務工作','榮譽童軍','多元技能金帶'],
    ['DS-SCOUT-02','先鋒工程（實踐）','榮譽童軍','多元技能金帶'],
    ['DS-INT-01','進階個人興趣項目','榮譽童軍','多元技能金帶'],
    ['DS-SP-01','進階康樂體育項目','榮譽童軍','多元技能金帶'],
    
    // === 榮譽童軍 — 戶外探險金帶 ===
    ['DS-EXP-001','陸上徒步遠足60km','榮譽童軍','戶外探險金帶'],
    ['DS-EXP-002','單車探險240km','榮譽童軍','戶外探險金帶'],
    ['DS-EXP-003','自行駕駛1000km','榮譽童軍','戶外探險金帶'],
    ['DS-EXP-004','機動化境外遠足1200km','榮譽童軍','戶外探險金帶'],
    ['DS-EXP-005','海上探險-標準艇80km','榮譽童軍','戶外探險金帶'],
    ['DS-EXP-006','海上探險-獨木舟80km','榮譽童軍','戶外探險金帶'],
    ['DS-EXP-007','海上探險-風帆80km','榮譽童軍','戶外探險金帶']
  ];
  
  allItems.forEach(row => sheet.appendRow(row));
}
