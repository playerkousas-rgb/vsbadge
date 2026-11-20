// Unified v9.7 — single full-featured GS shared by the Portal and VSBADGE frontends on one Sheet.
// Starting source: playerkousas-rgb/vs_portal main commit 3203b52 (UnifiedCode.gs, v9.6 baseline).
// v9.7 adds a session-protected full BADGE roster projection; both clients retain the same backend.
// ============================================================
// 深資童軍進度及行政平台 - Apps Script 後端
// 全前端帳戶管理、批量開戶、首次登入改密碼、角色驗證及操作紀錄
// 活動履歷（服務紀錄／活動紀錄／訓練班紀錄）：工作表「活動履歷」；
//   action：getLogRecords / saveLogRecord（支援批量 records[]）/ deleteLogRecord；handleLoad 回傳 logs + logsSupported
// 活動履歷申報（團員自行申報 → 領袖審批）：工作表「待批履歷」；
//   action：requestLogRecord / getLogRequests / reviewLogRequest / cancelLogRequest；handleLoad 回傳 logRequests + logRequestsSupported
// 帳戶自助申請（成員／執委／領袖）：apply 接受 requested_role（只限 member/exec_committee/branch_leader），
//   getApplications 回傳申請角色，reviewApplication 按角色開戶並回傳 final_role
// 忘記密碼（工作表「密碼重設」）：requestPasswordReset / completePasswordReset 為免登入復原入口；
//   只有已登記電郵的帳號提供自助重設（8 位重設碼、只存加鹽雜湊、15 分鐘有效、最多 5 次嘗試、單次使用）；
//   公開入口一律回覆中性訊息（帳號不存在／未登記電郵／寄件失敗／成功寄出完全一致），不建立待批請求；
//   未登記電郵的成員由領袖登入後在「用戶管理」以 resetPassword 重設臨時密碼
// 登入安全（A3／A5／A17）：密碼以 PBKDF2-HMAC-SHA256（10,000 迭代＋每用戶隨機鹽）儲存，
//   驗證一律用雜湊自帶嘅迭代次數（接受 1,000–2,000,000）；舊單次 SHA-256 或舊高迭代雜湊
//   仍可登入並於成功登入時透明升級（密碼不變）；同一帳號連續 5 次登入失敗鎖定 15 分鐘；
//   公開登入失敗一律回覆「帳號或密碼錯誤」；改密碼／重設密碼一律踢走舊登入並清除失敗鎖定
// 用戶管理及唯一身份：YMIS / Email 在單筆、批量、申請及編輯流程均由後端鎖內檢查，不可重複；
//   getAllUsers 合併「Users」及「成員名單」；領袖可重設成員密碼；刪除後保留識別碼 tombstone 及歷史進度
// 密碼原則：最短 4 位；批量開戶／審批初始密碼統一 1234
// 支部獨立後端：正常身份來自支部 Users，本地登入保持開啟。
// Progress 只執行同一 Unified Sheet 的業務 action；簽名 helper 只作同一 /exec 的 server authentication transport。
// 初始化：全新後端執行；之後每次更新 Code.gs 後建議都執行一次 initializeSheets()（只做增補：建表、補表頭、補缺失列，
//   可安全重跑，不刪除或改寫既有用戶資料）；跨多個版本升級時必須執行，否則會缺新版所需的工作表／欄位。
// 接入資料：initializeSheets／showApiKey 及支部系統選單只顯示 API Key；部署 URL 由 Google 部署視窗提供，旅團編號在 ADMIN FORM 填寫。
// 版號只記錄在 operations/TROOP_LINK_UPGRADE.md，程式內不留版本註解；唯一例外係 VS_GS_VERSION 發佈識別常數，供前端公告及初始化核對（不設逐級升級表）
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

// 最新發佈識別：只列目前版本，唔記逐級補丁清單。initializeSheets() 成功跑完先會喺 Script Properties 記低初始化版本。
const VS_GS_VERSION = 'v9.7';
const VS_GS_REVISION = '2026-11-20';
const VS_GS_INITIALIZED_PROP = 'VS_GS_INITIALIZED_VERSION';
const RELEASE_CHANNEL_PROP = 'RELEASE_CHANNEL';
const RELEASE_CHANNEL_DEFAULT = 'portal-acceptance';
function releaseChannel_(){
  var channel='';
  try{ channel=String(PropertiesService.getScriptProperties().getProperty(RELEASE_CHANNEL_PROP)||''); }catch(e){}
  channel=channel.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(channel)?channel:RELEASE_CHANNEL_DEFAULT;
}
function setReleaseChannel_(channel){
  channel=String(channel||'').trim().toLowerCase();
  if(channel!=='release' && channel!=='portal-acceptance' && channel!=='isolated-test-only') return {success:false,error:'頻道只可為 release、portal-acceptance 或 isolated-test-only'};
  PropertiesService.getScriptProperties().setProperty(RELEASE_CHANNEL_PROP,channel);
  return {success:true,channel:channel};
}
// 此版本是否強制要求旅團執行 initializeSheets()；與前端 LATEST_RELEASE.initializeRequired 保持一致。
const GS_INIT_REQUIRED = true;
function getVsGsReleaseStatus(){
  let initialized='';
  try{ initialized=String(PropertiesService.getScriptProperties().getProperty(VS_GS_INITIALIZED_PROP)||''); }catch(e){}
  return { gsVersion:VS_GS_VERSION, revision:VS_GS_REVISION, initializedGsVersion:initialized, gsInitializationCurrent:initialized===VS_GS_VERSION, initRequired:GS_INIT_REQUIRED, channel:releaseChannel_() };
}
// 回報 GS 發佈／初始化狀態，供 showApiKey／showVercelEnv 等介面在未初始化時提醒領袖先執行 initializeSheets()。
function gsVersionInfo_(){
  const st=getVsGsReleaseStatus();
  return { gsVersion:st.gsVersion, initializedGsVersion:st.initializedGsVersion, gsInitializationCurrent:st.gsInitializationCurrent, initRequired:st.initRequired };
}
// 當此版本要求初始化而 Script Properties 仍未記錄對應版本時，回傳警告行；否則回傳空陣列。API Key 本身仍照常顯示。
function initStatusWarningLines_(){
  const info=gsVersionInfo_();
  if(info.initRequired && info.initializedGsVersion!==info.gsVersion){
    return [
      '⚠️ 尚未完成初始化／更新（此 API Key 暫時未可用）',
      '請先執行選單「🔧 初始化／更新」一次（等同 initializeSheets()）；',
      '只會補建缺少的工作表及預設管理員，不會刪改任何既有資料。',
      ''
    ];
  }
  return [];
}

// 本次升級：更新 Code.gs 後執行一次 initializeSheets() 清理舊版保留帳號痕跡，再部署新版本；其他資料／結構保留。
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
// ===== 領袖登記資料：只提供 API Key，不要求預先設定旅團編號或 BACKEND URL =====
// Google 自動回報的網址可能不是部署視窗選定的入口。寧願不顯示 URL，
// 也不把推算值／舊 WEBAPP_URL 快取當作部署網址；不新增人手貼網址的設定流程。
const DEPLOYMENT_URL_NOTICE = '部署網址由 Google「部署 → 管理部署」視窗提供；本功能不顯示自動取得或推算的網址。';
const REGISTRATION_FORM_NOTICE = '請在 ADMIN FORM 填寫旅團編號、名稱、部署 URL 及 API Key；旅團編號毋須在 Sheet／Apps Script 預先設定。';

/** 只回傳現有 API Key；不依賴旅團編號。保留舊函式名稱供既有選單／腳本使用。 */
function vercelEnvLines() {
  return ['API Key = ' + getApiKey()];
}
function showVercelEnv() {
  const lines = vercelEnvLines();
  const warning = initStatusWarningLines_();
  const msg = (warning.length ? warning.join('\n') + '\n' : '') +
    '旅團 API Key 資料（交 APP ADMIN）：\n\n' + lines.join('\n') +
    '\n\n' + DEPLOYMENT_URL_NOTICE + '\n\n' + REGISTRATION_FORM_NOTICE +
    '\n\n功能變數全部由 APP ADMIN 設定，旅團毋須設定任何功能變數。';
  let ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }
  if (ui) ui.alert('旅團 API Key（交 APP ADMIN）', msg, ui.ButtonSet.OK);
  Logger.log(msg);
  return lines;
}
function showApiKey() {
  const apiKey = getApiKey();
  const warning = initStatusWarningLines_();
  let ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }
  if (ui) ui.alert('旅團 API Key（交 APP ADMIN）',
    (warning.length ? warning.join('\n') + '\n' : '') +
    vercelEnvLines().join('\n') + '\n\n' + DEPLOYMENT_URL_NOTICE + '\n\n' + REGISTRATION_FORM_NOTICE +
    '\n\nVercel 功能變數全部由 APP ADMIN 設定，旅團毋須設定任何功能變數。',
    ui.ButtonSet.OK);
  Logger.log('API Key: ' + apiKey);
  return apiKey;
}
function hashPassword(p) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
  return raw.map(function(b){return ('0' + (b & 0xFF).toString(16)).slice(-2);}).join('');
}
// ===== A3 密碼雜湊：PBKDF2-HMAC-SHA256（每用戶 16-byte 隨機鹽 + 時序安全比對）=====
// 新格式寫入 Users.password_hash 同一欄：pbkdf2$<iter>$<saltHex>$<dkHex>
// 舊格式（64 hex 單次 SHA-256）仍可驗證；登入成功時自動升級為新格式（密碼本身不變，屬增補式升級）。
// hashPassword() 本身保留作 SHA-256 工具（sig／重設碼雜湊／舊格式驗證），新設密碼一律用 hashPasswordV2。
//
// 迭代次數點解由 120,000 降到 10,000：Apps Script 冇原生 PBKDF2，每一輪迭代都係一次獨立
// Utilities.computeHmacSha256Signature() 服務呼叫（實測約 0.1ms／次）。120,000 迭代每次登入
// 要 12–20 秒，撞正同源 Proxy 45 秒上游逾時只係時間問題（GAS 冷啟動／負載高／Google 慢嗰日
// 就 504，用戶見到「有時入得、有時逾時」）。10,000 迭代約 1–2 秒，先至留到足夠緩衝。
// 驗證一律用雜湊自帶嘅 iter（下限 1,000、上限 2,000,000），所以舊 120,000 迭代帳號照入得；
// 舊雜湊（64-hex 或唔等於目前 iter 嘅 pbkdf2$）成功登入一次後透明改寫做目前 iter，毋須重設密碼。
const PBKDF2_ITERATIONS = 10000;
const PBKDF2_MIN_ITERATIONS = 1000;
const PBKDF2_MAX_ITERATIONS = 2000000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15*60*1000;
function hexToBytes_(hex){ const out=[]; hex=String(hex||'').replace(/[^0-9a-f]/gi,''); for(let i=0;i+1<hex.length;i+=2) out.push(parseInt(hex.substr(i,2),16)); return out; }
function xorBytes_(a,b){ const out=[]; for(let i=0;i<a.length;i++) out.push((a[i]^b[i])&0xFF); return out; }
function pbkdf2HmacSha256_(password, saltBytes, iterations){
  // dkLen=32（一個 block）：T = U1 ^ U2 ^ ... ^ Uc；U1 = PRF(P, S||INT(1))；Ui = PRF(P, U_{i-1})
  // GAS 只接受 (Byte[], Byte[]) 或 (String, String)；PBKDF2 必須保留原始 bytes。
  // salt 由 hex 解碼成 0..255，轉成 GAS 的 signed bytes。密碼使用 UTF-8。
  const keyBytes = Utilities.newBlob(String(password||''), 'text/plain').getBytes();
  const firstBlock = saltBytes.concat([0,0,0,1]).map(function(b){ return (b & 255) > 127 ? (b & 255) - 256 : (b & 255); });
  let u = Utilities.computeHmacSha256Signature(firstBlock, keyBytes);
  let t = u.slice();
  for(let i=1;i<iterations;i++){
    u = Utilities.computeHmacSha256Signature(u, keyBytes);
    t = xorBytes_(t, u);
  }
  return t;
}
function hashPasswordV2(p){
  const saltHex = (Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'').slice(0,32); // 16 bytes 鹽
  const dk = pbkdf2HmacSha256_(String(p||''), hexToBytes_(saltHex), PBKDF2_ITERATIONS);
  return 'pbkdf2$'+PBKDF2_ITERATIONS+'$'+saltHex+'$'+toHex(dk);
}
function isLegacyPasswordHash_(h){ return /^[0-9a-f]{64}$/i.test(String(h||'')); }
// 驗證密碼：自動接受舊格式（單次 SHA-256）與新格式（pbkdf2$...）；比對用 safeEqualText（防時序洩漏）。
// 迭代次數以雜湊自帶嘅為準（唔係用目前常數），舊高迭代雜湊先至驗證得到。
function verifyPassword(p, stored){
  stored = String(stored||'');
  if(stored.indexOf('pbkdf2$')===0){
    const parts = stored.split('$');
    if(parts.length!==4) return false;
    const iter = parseInt(parts[1],10)||0; if(iter<PBKDF2_MIN_ITERATIONS||iter>PBKDF2_MAX_ITERATIONS) return false;
    const salt = hexToBytes_(parts[2]); if(!salt.length) return false;
    const dk = pbkdf2HmacSha256_(String(p||''), salt, iter);
    return safeEqualText(toHex(dk), parts[3]);
  }
  return safeEqualText(sha256Hex(String(p||'')), stored);
}
// 使唔使透明升級：舊 64-hex，或者 pbkdf2$ 但迭代次數唔等於目前常數（例如舊 120,000）。
// 只喺「驗證成功」之後先改寫；壞格式／超出接受範圍嘅雜湊唔會行到呢度（verifyPassword 已拒）。
function passwordHashNeedsUpgrade_(stored){
  stored=String(stored||'');
  if(isLegacyPasswordHash_(stored)) return true;
  if(stored.indexOf('pbkdf2$')===0){
    const parts=stored.split('$');
    if(parts.length!==4) return false;
    const iter=parseInt(parts[1],10)||0;
    return iter>=PBKDF2_MIN_ITERATIONS && iter<=PBKDF2_MAX_ITERATIONS && iter!==PBKDF2_ITERATIONS;
  }
  return false;
}
// A17 假 KDF 用嘅 dummy 雜湊：帳號不存在／鎖定中都要做一次同成本嘅 KDF 先回統一中性訊息。
// GAS 每次請求都係新執行，單次執行變數等於冇 cache——舊寫法每個「帳號不存在」請求都燒一次
// 完整 KDF 配額。改用 CacheService 重用 6 小時（GAS script cache 上限），key 帶迭代次數，
// 改常數後唔會重用舊成本嘅 dummy。Cache 唔可用／未命中時退回單次執行記憶，行為不變。
let __dummyPasswordHash_ = null;
const DUMMY_HASH_CACHE_SECONDS = 6*60*60;
function dummyCacheKey_(){ return 'PWD_DUMMY_HASH:'+PBKDF2_ITERATIONS; }
function cachedDummyPasswordHash_(){
  if(__dummyPasswordHash_) return __dummyPasswordHash_;
  try{
    const cached=CacheService.getScriptCache().get(dummyCacheKey_());
    if(cached && String(cached).indexOf('pbkdf2$'+PBKDF2_ITERATIONS+'$')===0){ __dummyPasswordHash_=String(cached); return __dummyPasswordHash_; }
  }catch(e){}
  return null;
}
function dummyPasswordHash_(){
  const cached=cachedDummyPasswordHash_();
  if(cached) return cached;
  const fresh=hashPasswordV2('timing-equalizer');
  try{ CacheService.getScriptCache().put(dummyCacheKey_(),fresh,DUMMY_HASH_CACHE_SECONDS); }catch(e){}
  __dummyPasswordHash_=fresh;
  return fresh;
}
// A17 時序對齊：帳號不存在／鎖定中／搵唔到用戶紀錄，都要做「恰好一次」KDF 先回中性訊息。
// Cache 命中→用 dummy 雜湊驗證一次（1 次 KDF）；未命中→即場生成 dummy（都係 1 次 KDF，
// 成本同驗證一致）並寫入 CacheService 重用 6 小時——唔好生成完又驗證一次燒雙倍配額。
function equalizeLoginTiming_(password){
  try{
    const cached=cachedDummyPasswordHash_();
    if(cached){ verifyPassword(password, cached); return; }
    dummyPasswordHash_();
  }catch(e){}
}
// ===== 密碼 KDF 即場基準（Apps Script 原路徑實測，唔係 Node 估算）=====
// 喺 Apps Script 編輯器揀 benchmarkPasswordKdf 執行（或選單「⏱️ 密碼 KDF 速度測試」），
// 用真正嘅 Utilities.computeHmacSha256Signature 路徑量度 120,000 次 vs 10,000 次（及目前常數）
// 嘅真實毫秒數。結果寫入 Logger（檢視 → 執行紀錄）並回傳 JSON，用嚟填寫修前／修後實測秒數。
// 預設每個次數只跑 1 次（避免燒配額）；runs 參數最多 3。固定鹽令各次數可直接比較。
function benchmarkPasswordKdf(runs){
  const n=Math.max(1,Math.min(3,parseInt(runs,10)||1));
  const salt=hexToBytes_('00112233445566778899aabbccddeeff');
  const counts=[];
  [120000,10000,PBKDF2_ITERATIONS].forEach(function(c){ if(counts.indexOf(c)<0) counts.push(c); });
  const results=counts.map(function(iter){
    let best=null,total=0;
    for(let r=0;r<n;r++){
      const t0=new Date().getTime();
      pbkdf2HmacSha256_('benchmark-password',salt,iter);
      const ms=new Date().getTime()-t0;
      total+=ms; if(best===null||ms<best) best=ms;
    }
    const avg=Math.round(total/n);
    return {iterations:iter,runs:n,bestMs:best,avgMs:avg,avgSeconds:Math.round(avg/100)/10};
  });
  const report={success:true,gsVersion:VS_GS_VERSION,defaultIterations:PBKDF2_ITERATIONS,measuredAt:now(),results:results,
    note:'Apps Script 原路徑實測。每次登入＝1 次驗證 KDF；舊雜湊首次成功登入另加 1 次目前迭代嘅升級 KDF（一次性）。'};
  Logger.log('benchmarkPasswordKdf '+JSON.stringify(report));
  results.forEach(function(r){ Logger.log(r.iterations+' 迭代：平均 '+r.avgMs+' ms（最佳 '+r.bestMs+' ms，'+r.runs+' 次）'); });
  return report;
}
// ===== A5 登入失敗鎖定（ScriptProperties，key = LOGIN_FAIL:<ymis>；不寫入工作表）=====
function loginFailKey_(ymis){ return 'LOGIN_FAIL:'+String(ymis||''); }
function readLoginFail_(ymis){
  try{ return JSON.parse(PropertiesService.getScriptProperties().getProperty(loginFailKey_(ymis))||'null'); }catch(e){ return null; }
}
function clearLoginFail_(ymis){
  try{ PropertiesService.getScriptProperties().deleteProperty(loginFailKey_(ymis)); }catch(e){}
}
function recordLoginFail_(ymis){
  const prev=readLoginFail_(ymis);
  const f=((prev&&Number(prev.f))||0)+1;
  try{
    PropertiesService.getScriptProperties().setProperty(loginFailKey_(ymis),
      JSON.stringify({f:f, until: f>=LOGIN_MAX_FAILS ? Date.now()+LOGIN_LOCK_MS : 0}));
    if(f>=LOGIN_MAX_FAILS) writeAudit('system','login_locked', String(ymis||''), '連續 '+LOGIN_MAX_FAILS+' 次登入失敗，鎖定 15 分鐘');
  }catch(e){}
}
// 密碼被重設（領袖重設／電郵自助重設）後的善後：清走登入失敗鎖定（否則鎖定期內改完密碼仍然入唔到），
// 並踢走該帳號所有舊登入；不動其他人（包括執行重設的管理員）的登入。
function afterPasswordReset_(targetYmis){
  clearLoginFail_(targetYmis);
  try{ destroyTokensForUser(targetYmis); }catch(e){}
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
const SUPER_TOKEN_PREFIX = 'vs-super-v1-';
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
// 忘記密碼（自助重設）
//   電郵驗證碼只以「API Key 加鹽」雜湊儲存，永不寫入明文；過期、用畢或重複申請即失效。
const PWD_RESET_SHEET_NAME = '密碼重設';
const PWD_RESET_HEADERS = ['request_id','ymis','name','login_id','channel','email','code_hash','expires_at','status','attempts','created_at','updated_at','handled_by','handled_at','note'];
const PWD_RESET_TTL_MINUTES = 15;
const PWD_RESET_MAX_ATTEMPTS = 5;
const PWD_RESET_COOLDOWN_SECONDS = 60;      // 同一帳號最短重試間隔
const PWD_RESET_MAX_PER_WINDOW = 5;         // 同一帳號 6 小時內最多申請次數
const PWD_RESET_WINDOW_SECONDS = 6 * 60 * 60;
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
  set('role',acc.role||'member'); set('password_hash',hashPasswordV2(acc.password||''));
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
function persistedActorId(actor){ return isSuperAdminId(actor)?'system':String(actor||''); }
function writeAudit(actor,action,target,detail){
  // 中央管理帳號是臨時救援身份：不建立可回溯其身份的操作紀錄。
  if(isSuperAdminId(actor)) return;
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
    ymis:String(SUPER_ADMIN_ID), name:String(SUPER_ADMIN_NAME), email:'',
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
// 正規化 GAS 部署網址：Workspace 帳戶常回報 /a/<網域>/macros/s/<部署 ID>/exec，
// 正規化後與「部署 → 管理部署」視窗顯示的公開 /exec 格式一致，避免字串形式不同導致驗票失敗。
function canonicalServiceUrl_(u){
  const s=String(u||'');
  const m=s.match(/^https:\/\/script\.google\.com\/a\/[^\/]+\/macros\/s\/([A-Za-z0-9_-]+)\/exec\/?$/);
  return m ? 'https://script.google.com/macros/s/'+m[1]+'/exec' : s;
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
      payload:JSON.stringify({ticket:ticket, apikey:getApiKey(), backend:canonicalServiceUrl_(ScriptApp.getService().getUrl())})
    });
    if(response.getResponseCode()!==200 || JSON.parse(response.getContentText()).ok!==true) return false;
    cache.put(cacheKey,'used',120);
    return true;
  }catch(e){ return false; }
  finally{ lock.releaseLock(); }
}
function removeSuperAdminTokenRows(sheet){
  if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--){
    const token=String(data[i][0]||'');
    const ymis=String(data[i][1]||'');
    if(isSuperAdminId(ymis)||token.indexOf(SUPER_TOKEN_PREFIX)===0) sheet.deleteRow(i+1);
  }
}
function removeSuperAdminAuditRows(sheet){
  if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--){
    const row=data[i].map(function(value){ return String(value||'').trim(); });
    const hasReservedId=row.some(function(value){ return isSuperAdminId(value); });
    const hasSuperToken=row.some(function(value){ return value.indexOf(SUPER_TOKEN_PREFIX)===0; });
    if(hasReservedId||hasSuperToken) sheet.deleteRow(i+1);
  }
}
function removeSuperAdminFromSheet(sheet,map,dataRows){
  if(!sheet || !map || map.ymis===undefined) return;
  for(let i=dataRows.length-1;i>=1;i--){
    const id=String(dataRows[i][map.ymis]||'').trim();
    const email=(map.email===undefined)?'':String(dataRows[i][map.email]||'').trim();
    if(isSuperAdminReserved(id,email)){ sheet.deleteRow(i+1); continue; }
    if(map.auth_by!==undefined && isSuperAdminId(dataRows[i][map.auth_by])) sheet.getRange(i+1,map.auth_by+1).setValue('system');
  }
}
function removeSuperAdminIdentityRows(sheet,identityColumns,actorColumns){
  if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--){
    const row=data[i];
    const isIdentity=(identityColumns||[]).some(function(col){ return isSuperAdminId(row[col]); });
    if(isIdentity){ sheet.deleteRow(i+1); continue; }
    (actorColumns||[]).forEach(function(col){
      if(isSuperAdminId(row[col])) sheet.getRange(i+1,col+1).setValue('system');
    });
  }
}

// ===== 初始化 =====
function badgeInitializeSheets_() {
  const ss = getSheet();
  let pSheet = ss.getSheetByName('進度追蹤');
  if(!pSheet){
    pSheet = ss.insertSheet('進度追蹤');
    pSheet.appendRow(['YMIS','項目 ID','完成日期','更新時間','確認者','備註']);
    pSheet.getRange(1,1,1,6).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    pSheet.setFrozenRows(1);
  } else {
    // ensure 6 columns header
    if(pSheet.getLastRow()===0) {
      pSheet.appendRow(['YMIS','項目 ID','完成日期','更新時間','確認者','備註']);
    } else {
      if(pSheet.getLastColumn()<5) pSheet.getRange(1,5).setValue('確認者');
      if(pSheet.getLastColumn()<6) pSheet.getRange(1,6).setValue('備註');
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
  const hadUsersSheet = !!uSheet;
  if(!uSheet){
    uSheet = ss.insertSheet('Users');
    uSheet.appendRow(USER_HEADERS);
    uSheet.getRange(1,1,1,USER_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    uSheet.setFrozenRows(1);
  }
  // 確保 Users 欄位完整，並補回內置管理員帳號。
  const userMap=ensureUserColumns(uSheet);
  // Preserve the pinned BADGE v9.7 security migration: remove legacy reserved accounts and normalize actor labels.
  removeSuperAdminFromSheet(uSheet,userMap,uSheet.getDataRange().getValues());
  const userRows=uSheet.getDataRange().getValues();
  if(!hadUsersSheet) ensureSeedAccount(uSheet,userMap,userRows,{ymis:ADMIN_YMIS,name:ADMIN_NAME,email:ADMIN_EMAIL,role:'admin',password:ADMIN_PASS,branch:'b4',can_tick:true,force_change_password:true});
  // Existing flags are not rewritten; handleLogin still requires default passwords to be changed.
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
  // 清走舊版曾寫入 Tokens 工作表的中央管理 session；新 session 是 API_KEY 衍生 HMAC，不寫 Sheet／Cache。
  removeSuperAdminTokenRows(tSheet);
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
  removeSuperAdminAuditRows(auditSheet);
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
  // 忘記密碼（自助重設請求及驗證碼雜湊）。只新增結構，不改動任何現有用戶資料。
  passwordResetSheet(true);
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
  // Keep the pinned BADGE v9.7 cleanup behavior for reserved identity rows and actor labels.
  removeSuperAdminIdentityRows(pSheet,[0],[4]);
  removeSuperAdminIdentityRows(mSheet,[0],[]);
  removeSuperAdminIdentityRows(aSheet,[1,3],[8]);
  removeSuperAdminIdentityRows(prSheet,[1],[9]);
  removeSuperAdminIdentityRows(oSheet,[0],[]);
  removeSuperAdminIdentityRows(lSheet,[2],[10]);
  removeSuperAdminIdentityRows(lrSheet,[4],[14]);
  const pwResetSheetForCleanup=ss.getSheetByName(PWD_RESET_SHEET_NAME);
  if(pwResetSheetForCleanup) removeSuperAdminIdentityRows(pwResetSheetForCleanup,[1],[12]);
  removeSuperAdminIdentityRows(cfgSheet,[],[3]);

  const apiKey = getApiKey();
  // 只有所有補表、補預設值及清理步驟完成後，才記錄最新初始化版本；只貼新 Code.gs 唔會被誤當完成。API Key 沿用，唔會更換。
  PropertiesService.getScriptProperties().setProperty(VS_GS_INITIALIZED_PROP,VS_GS_VERSION);
  try{
    const ui=SpreadsheetApp.getUi();
    if(false && ui){
      // Unified initializer reports only after all stages complete.
      ui.alert('✅ 初始化完成！\n\n🔧 唯一更新步驟：重跑只會補建缺失的工作表、表頭欄、預設管理員及初始化版本標記，不會刪除、覆寫或重設任何既有帳號、進度、獎章、履歷或設定，亦不會更換現有 API Key。\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章、操作紀錄、活動履歷、待批履歷、密碼重設\n\n🔑 旅團 API Key 資料（交 APP ADMIN，請妥善保管）：\n'+vercelEnvLines().join('\n')+'\n\n👤 管理員 YMIS: '+ADMIN_YMIS+' 臨時密碼: '+ADMIN_PASS+'（首次登入必須更改）\n🔢 密碼最短 4 位；批量／審批初始密碼預設 '+DEFAULT_TEMP_PASSWORD+'\n\n📧 忘記密碼電郵提示：只有已登記電郵嘅用戶可自助重設（寄件人係本旅團部署帳戶，需授權寄件權限）；登入頁一律顯示中性訊息唔透露帳號是否存在，未登記電郵嘅成員請由領袖登入後喺「用戶管理」重設臨時密碼。\n\n'+DEPLOYMENT_URL_NOTICE+'\n\n'+REGISTRATION_FORM_NOTICE+'\n\nAPI Key 隨時再睇：showApiKey()／選單「🔗 旅系統 → 🔑 顯示 API KEY（交 ADMIN）」；登記資料不寫入工作表');
    }
  }catch(e){}
  return {success:true,apiKey:apiKey,gsVersion:VS_GS_VERSION,initializedGsVersion:VS_GS_VERSION,gsInitializationCurrent:true};
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
      if(user.ymis && user.status!=='deleted' && user.role!=='super_admin' && !isSuperAdminReserved(user.ymis,user.email)) users.push(user);
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
// 保留帳號 session 無狀態：由本節點 API_KEY 以用途分隔 HMAC 產生；不設 Sheet／Cache 記錄。
function superAdminSessionToken(){
  return SUPER_TOKEN_PREFIX+hmacSha256Hex('vsbadge-super-session-v1',getApiKey());
}
function validateToken(token){
  if(!token) return null;
  token=String(token);
  if(token.indexOf(SUPER_TOKEN_PREFIX)===0){
    return safeEqualText(token,superAdminSessionToken())?String(SUPER_ADMIN_ID):null;
  }
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0]===token){
      if(isSuperAdminId(String(data[i][1]))) return null; // 舊版殘留不再驗證；需由初始化清理。
      if(new Date()>new Date(data[i][3])){ sheet.deleteRow(i+1); return null; }
      return data[i][1].toString();
    }
  }
  return null;
}
function createToken(ymis){
  if(isSuperAdminId(ymis)) return superAdminSessionToken();
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const token=generateToken(); const exp=new Date(); exp.setHours(exp.getHours()+24*30);
  sheet.appendRow([token,ymis,now(),Utilities.formatDate(exp,'Asia/Hong_Kong','yyyy-MM-dd HH:mm:ss')]);
  return token;
}
function destroyToken(token){
  if(!token) return;
  token=String(token);
  if(token.indexOf(SUPER_TOKEN_PREFIX)===0) return; // 無狀態保留帳號 token 不在任何表格／Cache 建立撤銷記錄
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===token){ sheet.deleteRow(i+1); return; } }
}

// ===== Pinned baseline signature compatibility helpers（not a Progress integration contract）=====
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
// 跨節點搬數同時接受舊格式（64 hex 單次 SHA-256）與新格式（pbkdf2$<iter>$<salt>$<dk>），避免同步中斷
const LINK_HASH_RE=/^([0-9a-f]{64}|pbkdf2\$\d+\$[0-9a-f]{16,64}\$[0-9a-f]{64})$/i;
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
function isSuperAdminToken(token){
  if(!token || String(token).indexOf(SUPER_TOKEN_PREFIX)!==0) return false;
  return validateToken(token)===SUPER_ADMIN_ID;
}
function setLocalLoginAllowed(allow,actor){
  linkProps().setProperty(LINK_FLAG,allow?'true':'false');
  writeAudit(actor||'system',allow?'link_local_login_on':'link_local_login_off',getLinkNodeId(),allow?'直接入口開啟':'直接入口已閂，只收上游 sig');
  return allow?'true':'false';
}
function linkClosedResponse(){
  return {success:false,error:'登入服務暫時無法使用，請從所屬旅團入口登入或聯絡管理員。'};
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
    if(!ymis || String(data[i][map.role]||'')==='super_admin' || isSuperAdminReserved(ymis,data[i][map.email])) continue;
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
// upsertUser：搬數專用寫入。只接受 password_hash（64 位 SHA-256 hex 或 pbkdf2$ 格式兩種都得），不接受明文密碼；
// 既有帳戶（同 YMIS，或同 Email 認回同一身份）→ 更新；冇提供 hash 就保留原密碼。
function upsertUser(raw,actor){
  raw=raw||{};
  actor=linkActorLabel(actor);
  const ymis=String(raw.ymis||'').trim();
  const email=String(raw.email||'').trim().substring(0,160);
  const hash=String(raw.password_hash||'').trim().toLowerCase();
  if(!ymis) return {success:false,ymis:'',error:'缺少 YMIS'};
  if(raw.password!==undefined&&raw.password!==null&&String(raw.password)!=='') return {success:false,ymis:ymis,error:'匯入不可帶明文 password；請只用 password_hash'};
  if(hash&&!LINK_HASH_RE.test(hash)) return {success:false,ymis:ymis,error:'password_hash 必須是 64 位 SHA-256 hex 或 pbkdf2$<iter>$<salt>$<hash> 格式'};
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
      setCol('auth_by',persistedActorId(actor));
      setCol('auth_date',now());
      syncMemberRow(ymis,name,branch,email,status);
      writeAudit(actor,'link_upsert_update',ymis,'上游／匯入更新帳戶'+(hash?'（直插 hash）':'（保留原密碼）'));
      return {success:true,ymis:ymis,action:'updated',password_kept:!hash};
    }
    const width=Math.max(sheet.getLastColumn(),USER_HEADERS.length);
    const newRow=new Array(width).fill('');
    newRow[map.ymis]=ymis; newRow[map.name]=name; newRow[map.email]=email; newRow[map.role]=role;
    newRow[map.password_hash]=hash; newRow[map.branch]=branch; newRow[map.can_tick]=canTick;
    newRow[map.auth_by]=persistedActorId(actor); newRow[map.auth_date]=now();
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
  if(action==='load') return handleLoad(body.token);
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone'});
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
function badgeDoGet_(e){
  const params=(e&&e.parameter)||{};
  const action=String(params.action||'');
  // 直接入口關閉後，一般請求拒絕；已驗證保留帳號可繼續救援。
  if(!localLoginAllowed() && !isSuperAdminToken(params.token)) return jsonResponse(linkClosedResponse(action));
  if(action==='load'){
    // Legacy load compatibility: if an API key is provided, it must validate.
    const reqKey=params.apikey;
    if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
    return handleLoad(params.token);
  }
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone'});
  return jsonResponse({success:false,error:'Unknown action'});
}
function badgeDoPost_(e){
  try{
    const rawBody=String((e&&e.postData&&e.postData.contents)||'{}');
    const body=JSON.parse(rawBody||'{}');
    const action=String(body.action||'');
    // 旅系統：上游簽名（sig）請求優先路由；未簽名時才檢查直接入口掣
    if(verifyLinkSig(e,body,rawBody)) return handleSignedRequest(action,body);
    // 中央救援登入獨立於本地入口閘門；只放行保留身份並由 Proxy 驗證的短效票據。
    if(action==='login' && body.super_ticket && isSuperAdminId(body.login_id)) return handleLogin(body.login_id,body.password,body.super_ticket);
    // 最新版本核對：只回報 GS 程式版本及初始化版本（無敏感資料），供前端公告分辨「未更新／未初始化／已核對」；
    // API Key 由同源 Proxy 伺服器端注入驗證，瀏覽器永遠睇唔到。閂口（ALLOW_LOCAL_LOGIN 關閉）時管理員仍可核對。
    if(action==='ecStatus'){
      if(!body.apikey || body.apikey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
      return jsonResponse(Object.assign({success:true,timestamp:now()},getVsGsReleaseStatus()));
    }
    // 閂口狀態不向一般使用者公開；有效保留帳號 session 可進入處理。
    if(!localLoginAllowed() && !isSuperAdminToken(body.token)) return jsonResponse(linkClosedResponse());
    if(action==='login') return handleLogin(body.login_id,body.password);
    if(action==='logout'){ destroyToken(body.token); return jsonResponse({success:true}); }
    // 公開入口接受成員／執委／領袖申請（角色在 handleApply 內嚴格驗證）；
    // 支部／單位由前端自動帶入所屬旅團名稱，毋須申請人填寫。
    if(action==='apply') return handleApply(body.ymis,body.name,body.email,body.requested_role||'member',body.branch);
    // 忘記密碼：免登入的帳戶復原入口。回應不透露帳號是否存在；驗證碼只存雜湊。
    if(action==='requestPasswordReset') return handleRequestPasswordReset(body.login_id);
    if(action==='completePasswordReset') return handleCompletePasswordReset(body.login_id,body.code,body.new_password);

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
    if(action==='changePassword') return handleChangePassword(ymis,body.old_password,body.new_password,body.token);
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
  if(user && isSuperAdminId(user.ymis)){
    if(!verifySuperTicket(superTicket)) return jsonResponse({success:false,error:'帳號或密碼錯誤'});
    // 保留帳號已由 getUser() 直接建立，不讀寫 Users／Tokens／操作紀錄工作表。
    const token=createToken(user.ymis);
    return jsonResponse({success:true,token:token,user:user,force_change_password:user.force_change_password,gsVersion:VS_GS_VERSION});
  }
  // A17 防枚舉（只限未登入公開入口）：找不到帳號（包括已停用）與密碼錯誤回完全相同訊息；
  // 找不到帳號時照做一次假 KDF，令回應時序一致。後台管理查詢不受影響，領袖仍可正常搵人。
  if(!user){ equalizeLoginTiming_(password); return jsonResponse({success:false,error:'帳號或密碼錯誤'}); }
  // A5 登入鎖定：同一帳號連續失敗達上限後鎖 15 分鐘，鎖定期間連正確密碼都拒（回同一訊息）。
  // A17：鎖定中唔可以提早 return——都要照做一次 dummy KDF，否則時序上分得出
  // 「帳號存在但被鎖」（即时回）同「帳號不存在」（等 KDF），係反枚舉漏洞。
  const failRec=readLoginFail_(user.ymis);
  if(failRec && Number(failRec.until||0)>Date.now()){
    equalizeLoginTiming_(password);
    return jsonResponse({success:false,error:'帳號或密碼錯誤'});
  }
  const rec=findUserRecord(user.ymis);
  if(!rec){ equalizeLoginTiming_(password); return jsonResponse({success:false,error:'帳號或密碼錯誤'}); }
  const map=rec.map;
  const storedHash=String(rec.data[map.password_hash]||'');
  if(!verifyPassword(String(password||''),storedHash)){
    recordLoginFail_(user.ymis);
    return jsonResponse({success:false,error:'帳號或密碼錯誤'});
  }
  clearLoginFail_(user.ymis);
  // A3 透明升級：舊單次 SHA-256，或舊迭代次數（例如 120,000）嘅 PBKDF2 雜湊，
  // 成功登入後改寫做目前迭代次數（密碼不變，毋須重設）。每次登入只做 1 次「驗證」KDF；
  // 升級改寫係一次性額外 KDF（用目前較低次數，成本低），之後登入就只剩驗證嗰一次。
  if(passwordHashNeedsUpgrade_(storedHash)){ try{ rec.sheet.getRange(rec.row,map.password_hash+1).setValue(hashPasswordV2(String(password))); }catch(e){} }
  rec.sheet.getRange(rec.row,map.last_login+1).setValue(now());
  const token=createToken(user.ymis);
  // 仍用緊預設密碼（已成功驗證，輸入密碼即預設值）一律當要強制改密，新舊雜湊格式都一樣。
  const forceChange=!!user.force_change_password || String(password)===ADMIN_PASS;
  // gsVersion 屬增補欄位：供 Proxy slow_password_kdf 日誌及前端分辨未更新 GS（失敗回應維持完全一致，不加任何欄位）。
  return jsonResponse({success:true,token:token,user:user,force_change_password:forceChange,gsVersion:VS_GS_VERSION});
}
function handleChangePassword(ymis,oldP,newP,keepToken){
  newP=String(newP||'');
  if(newP.length<MIN_PASSWORD_LEN) return jsonResponse({success:false,error:'新密碼至少 '+MIN_PASSWORD_LEN+' 位'});
  if(newP.length>MAX_PASSWORD_LEN) return jsonResponse({success:false,error:'新密碼不可超過 '+MAX_PASSWORD_LEN+' 位'});
  if(newP===String(oldP||'')) return jsonResponse({success:false,error:'新密碼不可與原密碼相同'});
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'此帳號不支援在此更改密碼，請聯絡管理員'});
  const rec=findUserRecord(ymis);
  if(!rec || rec.user.status!=='active') return jsonResponse({success:false,error:'找不到用戶'});
  if(!verifyPassword(String(oldP||''),String(rec.data[rec.map.password_hash]||''))) return jsonResponse({success:false,error:'原密碼錯誤'});
  rec.sheet.getRange(rec.row,rec.map.password_hash+1).setValue(hashPasswordV2(newP));
  rec.sheet.getRange(rec.row,rec.map.force_change_password+1).setValue(false);
  rec.sheet.getRange(rec.row,rec.map.auth_date+1).setValue(now());
  // A5：改密碼成功後踢走該用戶其他所有登入（保留當前 token），並清走登入失敗鎖定。
  try{ destroyTokensForUserExcept(ymis,keepToken); }catch(e){}
  clearLoginFail_(ymis);
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
  for(let i=1;i<data.length;i++) if(String(data[i][6])==='pending' && !isSuperAdminReserved(data[i][1],data[i][3])) apps.push({app_id:String(data[i][0]),ymis:String(data[i][1]),name:String(data[i][2]),email:String(data[i][3]||''),requested_role:String(data[i][4]||'member'),branch:String(data[i][5]||''),applied_at:data[i][7]?formatDate(data[i][7]):''});
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
    sheet.getRange(rowIndex,7).setValue('rejected'); sheet.getRange(rowIndex,9).setValue(persistedActorId(manager.ymis)); sheet.getRange(rowIndex,10).setValue(now()); sheet.getRange(rowIndex,11).setValue(note||'');
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
  sheet.getRange(rowIndex,7).setValue('approved'); sheet.getRange(rowIndex,9).setValue(persistedActorId(manager.ymis)); sheet.getRange(rowIndex,10).setValue(now()); sheet.getRange(rowIndex,11).setValue(note||'');
  writeAudit(manager.ymis,'approve_application',appYmis,String(appId));
  const createdUser = result.results[0] || {};
  return jsonResponse({success:true,message:'已批准並建立帳號',temp_password:password,final_role:finalRole,ymis:createdUser.ymis||appYmis,name:appName,email:appEmail});
}
function handleUpdateUserRoleUnlocked_(targetYmis,newRole,canTick,managerYmis,allowedBadges){
  const manager=getUser(managerYmis); const rec=findUserRecord(targetYmis);
  if(!manager || !rec || rec.user.status!=='active') return jsonResponse({success:false,error:'找不到管理員或目標用戶'});
  if(String(targetYmis)===String(managerYmis)) return jsonResponse({success:false,error:'不可更改自己的角色或權限'});
  const hasRole=newRole!==undefined && newRole!==null;
  const role=hasRole?String(newRole).trim():rec.user.role;
  if(VALID_ROLES.indexOf(role)<0) return jsonResponse({success:false,error:'無效角色'});
  if(!canManageUser(manager,rec.user.role) || !canManageUser(manager,role)) return jsonResponse({success:false,error:'你的角色不可管理此用戶或設定此層級'});

  // 團長鎖死一位：已有現任團長就拒絕，並顯示現任姓名
  if(role==='group_leader' && rec.user.role!=='group_leader'){
    const activeGsl=getActiveGroupLeader();
    if(activeGsl && String(activeGsl.ymis)!==String(targetYmis)){
      return jsonResponse({success:false,error:'團長只能有一位，全團已有現任團長（'+activeGsl.name+'）。如需更換，請先將現任團長轉為其他角色。'});
    }
  }

  // 權限更新係局部更新：舊客戶端／updatePermissions 只送 allowed_badges 時，
  // 唔可以因為 can_tick 缺席而撤權，亦唔應重寫角色。
  const hasCanTick=canTick!==undefined;
  const tick=hasCanTick?(canUserTick(role) && isTrue(canTick)):(rec.user.can_tick===true);
  if(hasRole) rec.sheet.getRange(rec.row,rec.map.role+1).setValue(role);
  if(hasCanTick) rec.sheet.getRange(rec.row,rec.map.can_tick+1).setValue(tick);
  rec.sheet.getRange(rec.row,rec.map.auth_by+1).setValue(persistedActorId(managerYmis));
  rec.sheet.getRange(rec.row,rec.map.auth_date+1).setValue(now());
  if(allowedBadges!==undefined && allowedBadges!==null) rec.sheet.getRange(rec.row,rec.map.allowed_badges+1).setValue(String(allowedBadges));
  else if(hasRole && role!==rec.user.role) rec.sheet.getRange(rec.row,rec.map.allowed_badges+1).setValue(defaultAllowedBadges(role));
  writeAudit(managerYmis,'update_role',targetYmis,rec.user.role+' → '+role+', can_tick='+tick);
  return jsonResponse({success:true,role:role,can_tick:tick});
}
function handleUpdateConfig(key,value,ymis){
  const sheet=getSheet().getSheetByName('SystemConfig'); const data=sheet.getDataRange().getValues(); let found=false;
  for(let i=1;i<data.length;i++) if(data[i][0]===key){ sheet.getRange(i+1,2).setValue(value); sheet.getRange(i+1,3).setValue(now()); sheet.getRange(i+1,4).setValue(persistedActorId(ymis)); found=true; break; }
  if(!found) sheet.appendRow([key,value,now(),persistedActorId(ymis)]);
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
      if(!key || isSuperAdminId(y) || seen[key]) continue;
      members.push({ymis:y,name:data[i][1]?String(data[i][1]):''}); seen[key]=true;
    }
  }
  const uSheet=getSheet().getSheetByName('Users');
  if(uSheet){
    const map=ensureUserColumns(uSheet); const data=uSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const user=userFromRow(data[i],map); const key=accountIdKey(user.ymis);
      if(user.status==='active' && user.role!=='super_admin' && key && !isSuperAdminReserved(user.ymis,user.email) && !seen[key]){
        members.push({ymis:user.ymis,name:user.name}); seen[key]=true;
      }
    }
  }
  return members;
}
function handleLoad(authToken){
  const ss=getSheet();
  const pSheet=ss.getSheetByName('進度追蹤'); const progress={};
  if(pSheet){
    const data=pSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const ymis=String(data[i][0]||'').trim();
      const itemId=String(data[i][1]||'').trim();
      if(!ymis || !itemId || isSuperAdminId(ymis)) continue;
      if(!progress[ymis]) progress[ymis]={};
      progress[ymis][itemId]={
        date:data[i][2]?formatDate(data[i][2]):'',
        confirmer:isSuperAdminId(data[i][4])?'system':(data[i][4]?data[i][4].toString():''),
        // 「備註」是既有第六欄；回傳作活動細項／過渡紀錄備註，不新增或改動工作表結構。
        note:data[i].length>5?String(data[i][5]||''):''
      };
    }
  }
  // 簡化版：同時提供 flat，舊版前端仍可照常讀取。
  const flat={}; for(const y in progress){ flat[y]={}; for(const k in progress[y]){ flat[y][k]=progress[y][k].date; } }
  const members=getMembers();
  // pending requests
  const prSheet=ss.getSheetByName('待批完成'); const pending=[];
  if(prSheet){ const data=prSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending' && !isSuperAdminId(data[i][1])){ pending.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  // other badges
  const oSheet=ss.getSheetByName('其他獎章'); const other={};
  if(oSheet){ const data=oSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const y=data[i][0].toString(); if(!y || isSuperAdminId(y)) continue; if(!other[y]) other[y]={}; other[y][data[i][1].toString()]={name:data[i][2]?data[i][2].toString():'',date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}; } }
  // 活動履歷（logsSupported 讓前端分辨後端是否已升級）
  const lSheet=ss.getSheetByName(LOG_SHEET_NAME);
  // 待批履歷（團員自行申報，logRequestsSupported 讓前端分辨後端是否已升級）
  const lrSheet=ss.getSheetByName(LOG_REQ_SHEET_NAME);
  // 帶有效 session 時回傳最新自身權限，讓前端恢復 session 後不用重新登入同步角色／勾選範圍。
  // 不帶 token 的舊版 load 仍維持原有回應契約，亦不回傳任何用戶身份資料。
  const tokenYmis=authToken?validateToken(authToken):null;
  const current=tokenYmis?getUser(tokenYmis):null;
  const me=current?{
    name:current.name,role:current.role,can_tick:current.can_tick,
    allowed_badges:current.allowed_badges,force_change_password:current.force_change_password
  }:null;
  const payload={success:true,members:members,progress:progress,flatProgress:flat,pendingRequests:pending,otherBadges:other,logs:getLogRecordsList(),logsSupported:!!lSheet,logRequests:getLogRequestsList(),logRequestsSupported:!!lrSheet};
  if(me) payload.me=me;
  return jsonResponse(Object.assign(payload,getVsGsReleaseStatus()));
}
function handleSave(changes, confirmer){
  confirmer=persistedActorId(confirmer);
  const sheet=getSheet().getSheetByName('進度追蹤'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  let processed=0;
  changes.forEach(function(c){
    if(isSuperAdminId(c.ymis)) return;
    const data=sheet.getDataRange().getValues(); let found=false;
    const hasNote=Object.prototype.hasOwnProperty.call(c,'note');
    const noteValue=hasNote?safeSheetText(c.note,500):'';
    for(let i=1;i<data.length;i++){
      if(String(data[i][0]||'')===String(c.ymis) && String(data[i][1]||'')===String(c.itemId)){
        if(c.uncomplete){ sheet.deleteRow(i+1); }
        else {
          sheet.getRange(i+1,3).setValue(c.date||'');
          sheet.getRange(i+1,4).setValue(new Date());
          sheet.getRange(i+1,5).setValue(confirmer||persistedActorId(c.confirmer)||'');
          // 舊版前端未送 note 時保留既有備註，避免單純更改日期覆寫已填的細項。
          if(hasNote) sheet.getRange(i+1,6).setValue(noteValue);
        }
        found=true; processed++; break;
      }
    }
    if(!found && !c.uncomplete){
      sheet.appendRow([c.ymis,c.itemId,c.date||'',new Date(),confirmer||persistedActorId(c.confirmer)||'',hasNote?noteValue:'']);
      processed++;
    }
  });
  return jsonResponse({success:true,processed:processed});
}
function handleAddMemberUnlocked_(ymis,name,branch,actor){
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
      row[map.password_hash]=hashPasswordV2(u.password); row[map.branch]=u.branch;
      row[map.can_tick]=canUserTick(u.role) && u.can_tick; row[map.auth_by]=persistedActorId(manager.ymis);
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
  targetYmis=String(targetYmis||'').trim(); newPassword=String(newPassword||'');
  // 授權檢查必須喺 handler 內部做（上游 sig 入口唔經 doPost 角色閘）：manager 必須是已驗證的管理員物件（含 role），
  // 唔靠 ymis 字串反查（sig 入口的 on_behalf 只係標籤，角色以 linkManager 傳入的物件為準）。
  if(!manager || !manager.ymis || !manager.role) return jsonResponse({success:false,error:'未授權'});
  if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能重設此帳號密碼'});
  const rec=findUserRecord(targetYmis);
  if(!rec || rec.user.status==='deleted') return jsonResponse({success:false,error:'找不到帳號'});
  if(accountIdKey(targetYmis)===accountIdKey(manager.ymis)) return jsonResponse({success:false,error:'請使用「更改密碼」修改自己的密碼'});
  const targetRole=String(rec.user.role||'member');
  if(targetRole==='super_admin' || isSuperAdminReserved(rec.user.ymis,rec.user.email)) return jsonResponse({success:false,error:'不能重設此帳號密碼'});
  // 只有可管理該角色者可重設：admin 不可改 admin（只有最高管理層可以）、同級不可互改、成員不可改任何人。
  // 被拒時在任何寫入之前回傳，目標帳號的雜湊完全不變。
  if(!canManageUser(manager,targetRole)) return jsonResponse({success:false,error:'權限不足，不能重設該角色密碼'});
  if(newPassword.length<MIN_PASSWORD_LEN) return jsonResponse({success:false,error:'臨時密碼至少 '+MIN_PASSWORD_LEN+' 位'});
  if(newPassword.length>MAX_PASSWORD_LEN) return jsonResponse({success:false,error:'臨時密碼不可超過 '+MAX_PASSWORD_LEN+' 位'});
  rec.sheet.getRange(rec.row,rec.map.password_hash+1).setValue(hashPasswordV2(newPassword));
  rec.sheet.getRange(rec.row,rec.map.force_change_password+1).setValue(true);
  rec.sheet.getRange(rec.row,rec.map.auth_by+1).setValue(persistedActorId(manager.ymis));
  rec.sheet.getRange(rec.row,rec.map.auth_date+1).setValue(now());
  // 善後：清走登入失敗鎖定 + 踢走目標帳號所有舊登入（管理員自己的登入不動）；force_change_password 已在上面設 true。
  afterPasswordReset_(targetYmis);
  // 領袖為該用戶重設臨時密碼後，一併結案其在「忘記密碼」留下的待處理請求。
  const closedResets=completePendingPasswordResets(targetYmis,manager.ymis,'領袖已重設臨時密碼，未用驗證碼作廢');
  writeAudit(manager.ymis,'reset_password',targetYmis,'已設定臨時密碼並撤銷舊登入'+(closedResets?'（已作廢 '+closedResets+' 組未用驗證碼）':''));
  return jsonResponse({success:true,message:'密碼已重設，舊登入已撤銷'+(closedResets?'；未使用的驗證碼已作廢':'')});
}
function destroyTokensForUser(ymis){
  const sh=getSheet().getSheetByName('Tokens'); if(!sh) return;
  const data=sh.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--) if(String(data[i][1])===String(ymis)) sh.deleteRow(i+1);
}
// 踢走某用戶全部登入但保留指定 token（自行改密碼時保留當前登入；A5）
function destroyTokensForUserExcept(ymis, keepToken){
  if(!ymis) return;
  const sh=getSheet().getSheetByName('Tokens'); if(!sh) return;
  const data=sh.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--){
    if(String(data[i][1])===String(ymis) && String(data[i][0])!==String(keepToken||'')) sh.deleteRow(i+1);
  }
}

// ===== 忘記密碼（自助重設 → 只限已登記電郵） =====
// 私隱及安全原則：
//   1. 免登入入口（requestPasswordReset／completePasswordReset）不會透露帳號是否存在：
//      帳號不存在／未登記電郵／寄件失敗／成功寄出四種情況回覆完全相同的中性訊息（A17）；
//   2. 重設碼 8 位數字、15 分鐘有效、最多 5 次嘗試、單次使用；只以 API Key 加鹽雜湊儲存，成功／過期後即清空；
//      輸入時自動去空格／連字號，升級前已寄出的舊 6 位碼在有效期內仍可完成（雜湊算法不變）；
//   3. 每次新申請會令同一帳號較舊的待處理請求失效（superseded），避免舊碼仍然可用；申請有冷卻及次數上限；
//   4. 重設完成後撤銷該用戶所有既有登入 token、清走登入失敗鎖定，並寫入操作紀錄（紀錄不含密碼／重設碼）；
//   5. 只有已登記電郵的帳號才提供自助重設；沒有電郵的帳號不建立任何請求，由領袖登入後重設臨時密碼
//      （公開回覆不會講明「未登記電郵」，以免被用作探測帳號；後台查詢則不受影響）。
const PWD_RESET_NEUTRAL_MESSAGE='如該帳號已登記電郵，重設碼會寄到登記電郵，請於 15 分鐘內輸入。如收唔到信，請先檢查垃圾郵件，再聯絡領袖協助。';
function neutralPasswordResetResponse_(){ return jsonResponse({success:true,message:PWD_RESET_NEUTRAL_MESSAGE}); }
function passwordResetSheet(createIfMissing){
  const ss=getSheet();
  let sheet=ss.getSheetByName(PWD_RESET_SHEET_NAME);
  if(!sheet){
    if(!createIfMissing) return null;
    try{ sheet=ss.insertSheet(PWD_RESET_SHEET_NAME); }catch(e){ return null; }
  }
  let map=getHeaderMap(sheet);
  let added=false;
  PWD_RESET_HEADERS.forEach(function(h){
    if(map[h]===undefined){
      const last=sheet.getLastColumn();
      sheet.getRange(1,last<1?1:last+1).setValue(h);
      added=true;
      map=getHeaderMap(sheet);
    }
  });
  if(added){
    try{
      sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),1)).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    }catch(e){}
  }
  return {sheet:sheet,map:getHeaderMap(sheet)};
}
function readPasswordResetRows(target){
  const out=[];
  if(!target) return out;
  const data=target.sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(!data[i][target.map.request_id]) continue;
    const row={};
    PWD_RESET_HEADERS.forEach(function(h){
      const col=target.map[h];
      row[h]=(col===undefined||data[i][col]===undefined)?'':data[i][col];
    });
    row._row=i+1;
    out.push(row);
  }
  return out;
}
function appendPasswordResetRow(target,record){
  const width=Math.max(target.sheet.getLastColumn(),PWD_RESET_HEADERS.length);
  const row=new Array(width).fill('');
  PWD_RESET_HEADERS.forEach(function(h){ if(target.map[h]!==undefined) row[target.map[h]]=record[h]===undefined?'':record[h]; });
  target.sheet.appendRow(row);
}
function updatePasswordResetRow(target,rowIndex,fields){
  Object.keys(fields||{}).forEach(function(key){
    const col=target.map[key];
    if(col!==undefined) target.sheet.getRange(rowIndex,col+1).setValue(fields[key]);
  });
  const updatedCol=target.map.updated_at;
  if(updatedCol!==undefined && !Object.prototype.hasOwnProperty.call(fields||{},'updated_at')) target.sheet.getRange(rowIndex,updatedCol+1).setValue(now());
}
function passwordResetCode(){
  // 以 UUID 的十六進位位元產生 8 位數字重設碼，毋須額外隨機源。
  const hex=(String(Utilities.getUuid()||'')+String(Utilities.getUuid()||'')).replace(/[^0-9a-f]/gi,'');
  let n=parseInt(hex.substring(0,8),16);
  if(!isFinite(n)) n=Math.floor(Math.random()*100000000);
  return ('00000000'+String(n%100000000)).slice(-8);
}
function passwordResetCodeHash(code){
  // 綁定本旅團 API Key：單純取得試算表內容亦不能離線暴力破解重設碼。
  return sha256Hex('vsbadge-password-reset-v1|'+getApiKey()+'|'+String(code||''));
}
function passwordResetExpired(rec){
  const raw=String(rec&&rec.expires_at||'');
  if(!raw) return true;
  const ms=Date.parse(raw);
  if(isNaN(ms)) return true;
  return Date.now()>ms;
}
function passwordResetCache(){
  try{ if(typeof CacheService==='undefined' || !CacheService) return null; return CacheService.getScriptCache(); }catch(e){ return null; }
}
function passwordResetRateAllowed(loginId){
  const cache=passwordResetCache();
  if(!cache) return true;
  const base='vsbadge_pwreset_'+sha256Hex('id|'+String(loginId||'').trim().toLowerCase()).substring(0,24);
  let used=0;
  try{ used=parseInt(cache.get(base+'_count')||'0',10)||0; }catch(e){ used=0; }
  if(used>=PWD_RESET_MAX_PER_WINDOW) return false;
  try{
    if(cache.get(base+'_cool')) return false;
    cache.put(base+'_cool','1',PWD_RESET_COOLDOWN_SECONDS);
    cache.put(base+'_count',String(used+1),PWD_RESET_WINDOW_SECONDS);
  }catch(e){}
  return true;
}
function sendPasswordResetEmail(email,user,code){
  try{
    if(typeof MailApp==='undefined' || !MailApp || typeof MailApp.sendEmail!=='function') return false;
    const name=String((user&&user.name)||'').trim();
    const body=[
      (name?name+' 你好：':'你好：'),
      '',
      '你（或有人）要求重設「深資童軍進度及行政平台」帳戶密碼。',
      '請返到登入頁，在「忘記密碼」畫面輸入以下 8 位重設碼，再設定新密碼（至少 4 位）。',
      '重設碼：'+code,
      '有效時間：'+PWD_RESET_TTL_MINUTES+' 分鐘（過期請重新申請；重新申請會令呢個碼失效）。',
      '輸入時可以直接貼上，空格唔使理會。',
      '',
      '如非本人操作，請忽略此電郵；你的密碼不會被更改，亦無需通知任何人。請勿將重設碼轉發畀任何人。',
      'Your 8-digit password reset code is above. It is valid for '+PWD_RESET_TTL_MINUTES+' minutes. If you did not request it, ignore this email and never share the code.'
    ].join('\n');
    MailApp.sendEmail({
      to:email,
      subject:'【深資童軍平台】密碼重設碼 / Password reset code',
      body:body,
      name:'深資童軍進度及行政平台'
    });
    return true;
  }catch(e){ return false; }
}
function handleRequestPasswordReset(loginId){
  loginId=String(loginId||'').trim();
  if(!loginId) return jsonResponse({success:false,error:'請填寫 YMIS 或 Email'});
  if(loginId.length>160) return jsonResponse({success:false,error:'帳號格式不正確'});
  if(!passwordResetRateAllowed(loginId)) return jsonResponse({success:false,error:'重設請求過於頻密，請稍後再試'});
  const user=getUser(loginId)||getUserByEmail(loginId);
  // A17：保留帳號／不存在的帳號一律回覆中性訊息，避免被用作探測帳號（限速在上面按輸入字串先行處理，對所有輸入一致）。
  if(!user || isSuperAdminId(user.ymis)) return neutralPasswordResetResponse_();

  // 只有已登記電郵的帳號才提供自助重設；沒有電郵的帳號不建立任何請求、不寄電郵，
  // 但公開回覆與其他情況完全一致（畫面另有「收唔到信請聯絡領袖」的通用指引，領袖可在「用戶管理」重設臨時密碼）。
  const email=String(user.email||'').trim();
  if(!isEmail(email)) return neutralPasswordResetResponse_();

  const target=passwordResetSheet(true);
  if(!target){
    writeAudit(user.ymis,'request_password_reset',String(user.ymis),'未能建立重設紀錄，已回覆中性訊息');
    return neutralPasswordResetResponse_();
  }

  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return jsonResponse({success:false,error:'系統正處理另一項請求，請稍後重試'});
  try{
    // 同一帳號只保留最新的待處理驗證碼，舊碼立即失效。
    readPasswordResetRows(target).forEach(function(rec){
      if(String(rec.status)==='pending' && String(rec.ymis)===String(user.ymis)){
        updatePasswordResetRow(target,rec._row,{status:'superseded',code_hash:''});
      }
    });

    const code=passwordResetCode();
    const requestId='PWR_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    appendPasswordResetRow(target,{
      request_id:requestId,
      ymis:String(user.ymis),
      name:String(user.name||''),
      login_id:safeSheetText(loginId,160), // 防止以 = + - @ 開頭的輸入被試算表當作公式
      channel:'email',
      email:email,
      code_hash:passwordResetCodeHash(code),
      expires_at:new Date(Date.now()+PWD_RESET_TTL_MINUTES*60000).toISOString(),
      status:'pending',
      attempts:0,
      created_at:now(),
      handled_by:'',
      handled_at:'',
      note:''
    });

    if(!sendPasswordResetEmail(email,user,code)){
      // 寄件失敗（未授權寄件／超出配額）：即刻作廢此次重設碼；公開回覆與成功寄出完全一致，
      // 訊息用條件句（「如已登記電郵，重設碼會寄到…」）唔會聲稱已寄出，實際情況只記喺後台審計。
      const latest=readPasswordResetRows(target).filter(function(rec){ return String(rec.request_id)===requestId; })[0];
      if(latest) updatePasswordResetRow(target,latest._row,{status:'failed',code_hash:'',expires_at:'',note:'電郵發送失敗，請用戶聯絡領袖'});
      writeAudit(user.ymis,'request_password_reset',String(user.ymis),'電郵發送失敗，已回覆中性訊息');
      return neutralPasswordResetResponse_();
    }

    writeAudit(user.ymis,'request_password_reset',String(user.ymis),'已發送電郵重設碼');
    return neutralPasswordResetResponse_();
  } finally { lock.releaseLock(); }
}
function handleCompletePasswordReset(loginId,code,newPassword){
  // 重設碼輸入容錯：自動去空格／連字號（可直接貼上電郵內的碼）；升級前的舊 6 位碼在有效期內照常比對雜湊。
  loginId=String(loginId||'').trim(); code=String(code||'').replace(/[\s-]+/g,''); newPassword=String(newPassword||'');
  if(!loginId||!code) return jsonResponse({success:false,error:'請填寫帳號及重設碼'});
  if(newPassword.length<MIN_PASSWORD_LEN) return jsonResponse({success:false,error:'新密碼至少 '+MIN_PASSWORD_LEN+' 位'});
  if(newPassword.length>MAX_PASSWORD_LEN) return jsonResponse({success:false,error:'新密碼不可超過 '+MAX_PASSWORD_LEN+' 位'});
  // 公開入口的所有失敗（帳號不存在／無待處理碼／碼不正確／已過期／次數用盡）一律回同一句，避免枚舉（A17）。
  const failed={success:false,error:'重設碼不正確或已過期，請重新申請'};
  const user=getUser(loginId)||getUserByEmail(loginId);
  if(!user || isSuperAdminId(user.ymis)) return jsonResponse(failed);
  const target=passwordResetSheet(true);
  if(!target) return jsonResponse({success:false,error:'系統暫時無法處理重設，請聯絡領袖'});

  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return jsonResponse({success:false,error:'系統正處理另一項請求，請稍後重試'});
  try{
    const pending=readPasswordResetRows(target).filter(function(rec){
      return String(rec.ymis)===String(user.ymis) && String(rec.status)==='pending';
    });
    const rec=pending.length?pending[pending.length-1]:null;
    if(!rec) return jsonResponse(failed);
    if(String(rec.channel)!=='email') return jsonResponse(failed);
    if(passwordResetExpired(rec)){
      updatePasswordResetRow(target,rec._row,{status:'expired',code_hash:''});
      return jsonResponse(failed);
    }
    const attempts=parseInt(rec.attempts||0,10)||0;
    if(attempts>=PWD_RESET_MAX_ATTEMPTS){
      updatePasswordResetRow(target,rec._row,{status:'locked',code_hash:''});
      return jsonResponse(failed);
    }
    if(!safeEqualText(String(rec.code_hash||''),passwordResetCodeHash(code))){
      const nextAttempts=attempts+1;
      updatePasswordResetRow(target,rec._row,{attempts:nextAttempts,status:nextAttempts>=PWD_RESET_MAX_ATTEMPTS?'locked':'pending',code_hash:nextAttempts>=PWD_RESET_MAX_ATTEMPTS?'':rec.code_hash});
      return jsonResponse(failed);
    }

    const userRec=findUserRecord(user.ymis);
    if(!userRec || userRec.user.status!=='active') return jsonResponse(failed);
    userRec.sheet.getRange(userRec.row,userRec.map.password_hash+1).setValue(hashPasswordV2(newPassword));
    userRec.sheet.getRange(userRec.row,userRec.map.force_change_password+1).setValue(false);
    userRec.sheet.getRange(userRec.row,userRec.map.auth_date+1).setValue(now());
    // 善後：踢走該帳號所有舊登入 + 清走登入失敗鎖定（即刻可用新密碼登入）。
    afterPasswordReset_(user.ymis);
    updatePasswordResetRow(target,rec._row,{status:'completed',code_hash:'',handled_by:'self',handled_at:now(),note:'電郵重設碼自助重設'});
    writeAudit(user.ymis,'self_reset_password',String(user.ymis),'已用電郵重設碼重設密碼');
    return jsonResponse({success:true,message:'密碼已重設，請用新密碼登入'});
  } finally { lock.releaseLock(); }
}
function completePendingPasswordResets(ymis,actor,note){
  // 領袖已在「用戶管理」為該用戶重設臨時密碼：一併作廢其未使用的電郵驗證碼。
  const target=passwordResetSheet(true);
  if(!target) return 0;
  let count=0;
  readPasswordResetRows(target).forEach(function(rec){
    if(String(rec.status)!=='pending' || String(rec.ymis)!==String(ymis)) return;
    updatePasswordResetRow(target,rec._row,{status:'completed',code_hash:'',handled_by:persistedActorId(actor),handled_at:now(),note:safeSheetText(note||'領袖重設臨時密碼',200)});
    count++;
  });
  return count;
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
function handleSetUserStatusUnlocked_(targetYmis,status,manager){
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
    unifiedRememberRosterRemoval_(targetYmis);
    // 帳戶採安全刪除：Users 列保留為 tombstone，確保相同 YMIS / Email 永遠不會被開成另一帳戶。
    // 進度／履歷亦保留作團隊紀錄；成員名單列會移除，因此日常畫面不再顯示此人。
    if(rec){
      rec.sheet.getRange(rec.row,rec.map.status+1).setValue('deleted');
      rec.sheet.getRange(rec.row,rec.map.can_tick+1).setValue(false);
      rec.sheet.getRange(rec.row,rec.map.auth_by+1).setValue(persistedActorId(manager.ymis));
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
// 待批完成（冪等去重：同一 (requesterYmis, itemId) 已有 pending 列就更新該列，唔重覆新增，
// 回傳既有 request_id；支援單筆 body.itemId（向下相容）或批次 body.items[]，全部一律寫入 pending。
// VSBOOK 個人電子紀錄冊經伺服器端轉發同一 action，重按送出／批次送出都唔會洗版。）
function handleRequestComplete(body, requesterYmis){
  if(isSuperAdminId(requesterYmis)) return jsonResponse({success:false,error:'找不到申請人'});
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const raw=(Array.isArray(body.items)&&body.items.length)?body.items:[{itemId:body.itemId,itemName:body.itemName,requested_date:body.requested_date,evidence:body.evidence}];
  if(raw.length>50) return jsonResponse({success:false,error:'每次最多提交 50 個項目，請分批'});
  const items=[];
  for(let i=0;i<raw.length;i++){
    const it=raw[i]||{};
    const itemId=String(it.itemId||'').trim();
    if(!itemId) return jsonResponse({success:false,error:'第 '+(i+1)+' 個項目缺少 itemId'});
    items.push({itemId:itemId,itemName:safeSheetText(it.itemName||itemId,120),date:String(it.requested_date||formatDate(new Date())).substring(0,20),evidence:safeSheetText(it.evidence||'',500)});
  }
  const user=getUser(requesterYmis)||{name:body.name||requesterYmis};
  // 鎖內做「讀→改→寫」，避免兩個同時送出嘅請求各自睇唔到對方而重覆開列。
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return jsonResponse({success:false,error:'系統正處理另一項申請，請稍後重試'});
  try{
    const data=sheet.getDataRange().getValues();
    const results=[];
    items.forEach(function(it){
      let rowIndex=-1;
      for(let i=1;i<data.length;i++){
        if(String(data[i][1]||'')===String(requesterYmis) && String(data[i][3]||'')===it.itemId && String(data[i][7]||'')==='pending'){ rowIndex=i+1; break; }
      }
      if(rowIndex>0){
        // 已有同一項目嘅 pending 申請：只更新申請日期（第 6 欄）及證明／備註（第 7 欄），
        // 保留原有 request_id、created_at 及其餘欄位，唔新增列。
        sheet.getRange(rowIndex,6).setValue(it.date);
        sheet.getRange(rowIndex,7).setValue(it.evidence);
        results.push({request_id:String(data[rowIndex-1][0]),item_id:it.itemId,deduplicated:true});
      }else{
        const reqId='REQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
        const newRow=[reqId,requesterYmis,user.name||body.name,it.itemId,it.itemName,it.date,it.evidence,'pending',now(),'','','',''];
        sheet.appendRow(newRow);
        data.push(newRow); // 批次內重覆項目同樣去重
        results.push({request_id:reqId,item_id:it.itemId,deduplicated:false});
      }
    });
    const first=results[0];
    return jsonResponse({success:true,request_id:first.request_id,request_ids:results.map(function(r){return r.request_id;}),requests:results,processed:results.length,deduplicated:first.deduplicated});
  } finally { lock.releaseLock(); }
}
function handleGetPendingRequests(){
  const sheet=getSheet().getSheetByName('待批完成'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending' && !isSuperAdminId(data[i][1])){ list.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  return jsonResponse({success:true,requests:list});
}
function handleReviewRequest(reqId,decision,note,reviewer,confirmed_date){
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const data=sheet.getDataRange().getValues(); let row=null;
  for(let i=1;i<data.length;i++){ if(data[i][0].toString()===reqId){ row=data[i]; sheet.getRange(i+1,8).setValue(decision); sheet.getRange(i+1,10).setValue(persistedActorId(reviewer)); sheet.getRange(i+1,11).setValue(now()); sheet.getRange(i+1,12).setValue(note||''); sheet.getRange(i+1,13).setValue(confirmed_date||formatDate(new Date())); break; } }
  if(!row) return jsonResponse({success:false,error:'找不到申請'});
  if(decision==='approved'){
    const itemId=String(row[3]||'');
    const date=confirmed_date||row[5];
    const transferNote='由申請轉入：'+(note||'');
    // OT-* 其他獎章必須寫「其他獎章」工作表：handleLoad.otherBadges 同前端 resolveOtherBadgeRecord
    // 只讀嗰張表，舊寫法硬寫「進度追蹤」會令批准後畫面仍然顯示未完成。
    // 其餘項目（L1–L4 等）經 handleSave 做 (ymis,itemId) Upsert，唔再 appendRow 製造重覆列。
    if(itemId.indexOf('OT-')===0){
      if(!getSheet().getSheetByName('其他獎章')) return jsonResponse({success:false,error:'「其他獎章」工作表不存在，請先執行 initializeSheets()'});
      handleSaveOtherBadge([{ymis:row[1],badgeId:itemId,name:row[4]||itemId,date:date,note:transferNote}]);
      return jsonResponse({success:true,message:'已批准並寫入其他獎章'});
    }
    if(!getSheet().getSheetByName('進度追蹤')) return jsonResponse({success:false,error:'「進度追蹤」工作表不存在，請先執行 initializeSheets()'});
    handleSave([{ymis:row[1],itemId:itemId,date:date,note:transferNote}],reviewer);
    return jsonResponse({success:true,message:'已批准並寫入進度'});
  }
  return jsonResponse({success:true,message:'已拒絕'});
}
function handleGetOtherBadges(ymis){
  if(isSuperAdminId(ymis)) return jsonResponse({success:true,other:[]});
  const sheet=getSheet().getSheetByName('其他獎章'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0].toString()===ymis){ list.push({id:data[i][1].toString(),name:data[i][2].toString(),date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}); } } }
  return jsonResponse({success:true,other:list});
}
function handleSaveOtherBadge(records){
  const sheet=getSheet().getSheetByName('其他獎章'); if(!sheet) return jsonResponse({success:false,error:'Sheet missing'});
  let c=0;
  records.forEach(function(r){
    if(isSuperAdminId(r.ymis)) return;
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){
      if(String(data[i][0]||'')===String(r.ymis) && String(data[i][1]||'')===String(r.badgeId)){
        if(r.uncomplete===true || r.remove===true){ sheet.deleteRow(i+1); found=true; c++; break; }
        // 既有表格欄位：YMIS / 獎章 ID / 獎章名稱 / 完成日期 / 證書編號 / 備註 / 更新時間。
        // 逐欄更新，避免覆寫名稱或錯置日期、證書編號；不需重建或初始化工作表。
        sheet.getRange(i+1,3).setValue(safeSheetText(r.name||r.badgeId,120));
        sheet.getRange(i+1,4).setValue(r.date||'');
        sheet.getRange(i+1,5).setValue(safeSheetText(r.cert||'',120));
        if(Object.prototype.hasOwnProperty.call(r,'note')) sheet.getRange(i+1,6).setValue(safeSheetText(r.note||'',500));
        sheet.getRange(i+1,7).setValue(new Date());
        found=true; c++; break;
      }
    }
    if(!found && r.uncomplete!==true && r.remove!==true){ sheet.appendRow([r.ymis,r.badgeId,safeSheetText(r.name||r.badgeId,120),r.date||'',safeSheetText(r.cert||'',120),safeSheetText(r.note||'',500),new Date()]); c++; }
  });
  return jsonResponse({success:true,processed:c});
}

// ===== 活動履歷（服務／活動／訓練班紀錄） =====
function getLogRecordsList(){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME); const logs=[];
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(!data[i][0] || isSuperAdminId(data[i][2]) || isSuperAdminId(data[i][10])) continue;
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
  const superRecorder=isSuperAdminId(recorderYmis);
  const storedRecorder=superRecorder?'system':(recorderName||recorderYmis||'');
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  if(!Array.isArray(records)||records.length===0) return jsonResponse({success:false,error:'沒有可儲存的紀錄'});
  if(records.length>200) return jsonResponse({success:false,error:'一次最多 200 筆，請分批'});
  const results=[]; let processed=0;
  records.forEach(function(r){
    const rec=sanitizeLogRecord(r);
    if(isSuperAdminId(rec.ymis)){ results.push({success:false,ymis:rec.ymis,error:'找不到成員'}); return; }
    if(!rec.ymis||!rec.title||!rec.date){ results.push({success:false,ymis:rec.ymis,title:rec.title,error:'YMIS、名稱及日期必填'}); return; }
    const rid=String((r&&r.record_id)||'');
    if(rid){
      // 更新既有紀錄（record_id 不變）
      const data=sheet.getDataRange().getValues();
      for(let i=1;i<data.length;i++){
        if(String(data[i][0])===rid){
          sheet.getRange(i+1,2,1,12).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,sheet.getRange(i+1,11).getValue()||storedRecorder,String(data[i][11]||''),now()]]);
          results.push({success:true,record_id:rid}); processed++;
          writeAudit(recorderYmis,'update_log',rec.ymis,rec.type+': '+rec.title+' '+rec.date);
          return;
        }
      }
      results.push({success:false,record_id:rid,error:'找不到紀錄'}); return;
    }
    const newId='LOG_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    sheet.appendRow([newId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,storedRecorder,now(),'']);
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
      if(!data[i][0] || String(data[i][12])!=='pending' || isSuperAdminId(data[i][4])) continue;
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
  if(isSuperAdminId(user&&user.ymis)) return jsonResponse({success:false,error:'找不到申報人'});
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
    sheet.getRange(rowIndex,13).setValue('rejected'); sheet.getRange(rowIndex,15).setValue(persistedActorId(reviewer.ymis)); sheet.getRange(rowIndex,16).setValue(now()); sheet.getRange(rowIndex,17).setValue(note||'');
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
  sheet.getRange(rowIndex,13).setValue('approved'); sheet.getRange(rowIndex,15).setValue(persistedActorId(reviewer.ymis)); sheet.getRange(rowIndex,16).setValue(now()); sheet.getRange(rowIndex,17).setValue(note||'');
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

// ===== Pinned baseline legacy menu implementation（Unified onOpen is overridden below）=====
// 選單只在 Sheet 內給擁有者按；匯出的 JSON 含 password_hash，只寫去 Drive（私人），绝不寫入工作表。
function badgeOnOpen_(){
  try{
    const ui=SpreadsheetApp.getUi();
    ui.createMenu('🔗 旅系統')
      .addItem('🔧 初始化／更新（執行 initializeSheets）','menuInitializeSheets')
      .addItem('⏱️ 密碼 KDF 速度測試（實測毫秒）','menuBenchmarkPasswordKdf')
      .addSeparator()
      .addItem('📤 匯出 JSON（含 hash）','menuExportUsersJson')
      .addItem('📥 匯入 JSON（upsertUser 直插 hash）','menuImportUsersJson')
      .addSeparator()
      .addItem('🧭 本機接駁狀態','menuShowLinkState')
      .addItem('🔑 顯示 API KEY（交 ADMIN）','menuShowLinkCredentials')
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
  const lines = initStatusWarningLines_().concat(vercelEnvLines(), [
    '',
    'API Key 由本節點產生，只交 APP ADMIN，請勿公開分享。',
    DEPLOYMENT_URL_NOTICE,
    REGISTRATION_FORM_NOTICE
  ]);
  return linkAlert('API KEY（交 ADMIN）', lines.join('\n'));
}
// 單一更新入口：執行 initializeSheets() 並顯示完成訊息（只呼叫 initializeSheets，不執行其他函式）。
function menuInitializeSheets(){
  initializeSheets();
}
// 密碼 KDF 速度測試選單入口：即場量度 Apps Script 原路徑毫秒數，供填寫修前／修後實測秒數。
function menuBenchmarkPasswordKdf(){
  const r=benchmarkPasswordKdf(1);
  const lines=r.results.map(function(x){ return '・'+x.iterations+' 迭代：平均 '+x.avgMs+' ms（最佳 '+x.bestMs+' ms，約 '+x.avgSeconds+' 秒）'; });
  return linkAlert('密碼 KDF 速度測試（Apps Script 實測）',
    '目前新雜湊迭代次數：'+r.defaultIterations+'\n\n'+lines.join('\n')+
    '\n\n每次登入只做 1 次驗證 KDF；舊雜湊首次成功登入會另加 1 次目前迭代嘅升級 KDF（一次性）。'+
    '\n詳細 JSON 已寫入「檢視 → 執行紀錄（Logger）」。');
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

// ===== Namespaced legacy administrative compatibility module =====
var PortalAdminCompat_ = (function () {
/**
 * ============================================================
 *  深資童軍管理系統 · 總表同步與多旅團後端 Apps Script（Code.gs）
 *  版本：v2.8.8
 *
 *  ★ v2.8.1（2026-09-25，團長回報 4 項：「登入畫面睇唔到版號」／
 *    「後端分頁明明有資料但 app 話冇」／「有幾頁不停在儲存，會唔會爆量」／
 *    「收據話寫入成功但核對對唔上」）：
 *    ① saveTables **自證**：寫完即刻讀返，呢次寫嘅行留唔喺分頁就直接回失敗
 *       （以前 setValues 冇拋例外就當成功，假成功要到收據核對先現形）。
 *    ② saveTables 包埋報表刷新（同 saveDb 睇齊）：每次儲存＝**一個**請求搞掂
 *       正本＋報表，前端唔使再發第二次 pushToMaster（慳一半 GAS 執行＋審計行）。
 *    ③ dbInfo／diag 如實報**分頁原行數**（simpleRows／blobRows）＋壞表
 *       （broken，就算搵唔到都報）——「分頁真係空」同「有行但砌唔返」分得開。
 *    ④ 止血：審計紀錄唔再記純讀取（status／dbInfo／load…）；「同步紀錄」封頂
 *       500 行；repairDb 加埋清「資料表」舊套（pruneOldSimpleVersions）。
 *
 *  ★ v2.6.3 修正（2026-09-21，團長回報「佢話已寫入但張 Sheet 完全冇嘢；
 *    唔好搞咁多掣要人按，存入後端就資料庫同分頁都 SAVE 曬」）：
 * ★ 2026-09-24（v2.7.0）：「加一項多一行，最後永遠只讀到以前儲嗰份，
 *    新儲嘅完全讀唔到」—— 死因係讀取時把同一旅團**所有**段一齊拼，
 *    兩套以上（舊版漏刪／手動加行／兩個部署同時寫）就會拼壞或者永遠讀舊。
 *    而家 dbRawText 按**版本分組**，只讀最新嗰一套完整段；
 *    舊段唔會再混入（dbInfo 會報 staleRows），另附 pruneOldDbVersions() 執靚分頁。
 *    一次儲存＝兩處都寫。以前「儲存到後端」（saveDb）淨係寫「資料庫」分頁
 *    （分段 JSON，人喺 Sheet 度睇唔明），團員／帳目／物資…嗰啲**睇得明嘅報表分頁**
 *    要另外撳「更新報表分頁」（action:sync）先會填 —— 團長撳完儲存再開 Google Sheet，
 *    見到 16 張分頁全空，自然以為「佢呃我，根本冇寫入」。
 *    而家 saveDb／saveDbCommit 寫完「資料庫」之後，會即用同一份資料刷新晒報表分頁
 *    （重用 syncAll／writeTab，冇第二套攤平邏輯）；body.refreshReports === false 先至略過。
 *    ⚠ 呢個係**後端**行為：貼咗新版 Code.gs，就算前端係舊 cache 都一樣一粒掣搞掂。
 *
 *  ★ v2.6.2 修正（2026-09-20，團長回報「儲存唔到去後端／後端讀取唔到，
 *    只能用 JSON 備份」）：分件儲存嘅暫存行**清唔乾淨** —— 舊 cleanStaging
 *    把「一梳連續行」嘅起點向上移但冇把梳長 +1，所以一梳 N 行最後只刪到 1 行。
 *    分件儲存（資料庫大過 2.8MB）每存一次就留低 N-1 行垃圾（每行 45000 字，
 *    即係成份資料庫嘅複製品）喺「資料庫」分頁。Sheet 越嚟越大 →
 *    每次 getValues() 越來越慢 → 最後 saveDb／loadDb 撞 GAS 執行時間／記憶體
 *    上限 → 讀寫一齊死，而 status／ping 照樣話「正常」（所以「測試連線」會呃人）。
 *    順手把「先刪暫存、再用舊行號刪舊段」呢個行號走位隱患一次過修好
 *    （saveDbCommit 而家一次過由底往上刪晒）；全後端統一用 deleteRowRuns()。
 *    ⚠ 已經中招嘅 Sheet：貼新版 → 執行一次 cleanStaleStaging() 清走積存垃圾行。
 *
 *  ★ v2.6.1 修正（2026-09-20，團長回報 3 項問題）：
 *    ① 「成員進度不知為何重複了」——死因：報表同步（writeTab）用**前端 schema key 次序**
 *       寫「團員」分頁（旅團,id,name,eng,identity,…,ymis,…），
 *       但進度讀取（progressMembers）寫死「第 2 欄=ymis、第 4 欄=姓名」
 *       （嗰個係 initializeSheets 嘅次序：旅團,id,ymis,systemId,姓名,…）。
 *       兩套次序唔同 → 讀錯欄，每人都多咗一行「YMIS=姓名、名=身份」。
 *       修正：progressMembers 改為照標題列搵返 ymis／姓名 喺邊一欄，唔再寫死欄號。
 *    ② 「同步會為這旅團再創建分頁（物資82）」——死因：sheetName() 喺
 *       per-unit-sheet 模式會回「分頁名·旅團編號」（物資·0082），
 *       同 initializeSheets() 建嘅無後綴分頁（物資）係兩張唔同嘅表。
 *       一張總表＝一個旅團，根本唔需要後綴。修正：報表一律寫返無後綴分頁，
 *       並順手清走舊版留低嘅後綴分身，等資料歸返一張表。
 *    ③ 「由後端重新載入仍不成功」——其中一個可修嘅死因係 BACKEND_VERSION
 *       一直係 'v2.5.0'（寫住 v2.6.0 功能、但版本號冇跟上），
 *       令同步診斷／提示誤判後端版本。已升做 'v2.6.1'。
 *       （真正載入仲要：Apps Script 貼新 Code.gs → 部署 → 版本揀「新版本」。）
 *
 *  ★ v2.6.0 新增（2026-09-20，團長回報「無痕同普通視窗對唔到料、又話我冇後端」）：
 *    ① loadDbPart —— **分段讀取**成份資料庫。
 *       死因：Vercel 代理單一回應有 4.5MB 硬上限。資料庫一大過呢個數，
 *       loadDb 一次過回成份 JSON 就會令 Vercel 回 500
 *       FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE（純文字，唔係 JSON），
 *       前端見到「唔係 JSON」就以為「呢個部署冇 /api」，跌落自助路線，
 *       最後對用家講「未設定後端網址」—— 明明後端登記得好哋。
 *       每段淨係回 1,000,000 字純文字，前端逐段拼返；每段都帶 version，
 *       讀緊嗰陣有人儲存咗（version 變咗）前端會由頭再讀，唔會拼出半新半舊。
 *    ② 前端 pullDb 而家會先問 dbInfo 攞體積：經代理而大過 3MB 就直接分段讀，
 *       細嘅單一讀失敗都會自動退去分段 —— 所以**唔會再靜靜地讀唔到**。
 *    ③ 順帶修正（呢個先係資料庫變大嘅真正源頭）：單據相片直上 Drive 嘅
 *       uploadPhotos action 一直漏咗喺 Vercel 代理白名單，代理一律回 400，
 *       前端於是跌返落「本地存做後備」，每張單據相都以 base64 dataURL
 *       寫入 db.claims[].photos[].dataUrl，base64 仲會脹大約 33% ——
 *       所以「明明單據係直上 Drive」都照樣把「資料庫」分頁撐爆。
 *       （修正喺 api/proxy.js 白名單；scripts/lint.mjs 而家會擋住再漏。）
 *
 *  ★ v2.5.0 新增（2026-09-18 深夜，團長回報 6 項問題）：
 *    ① constitution —— 公開團章免登入讀取（APP「發布」＋同步之後，
 *       constitution.html 公開頁即刻見到最新版，唔使再人手上載
 *       data/units/<編號>/constitution.json）。
 *    ② loadPublicNotices 改為由「資料庫」分頁（正本）讀 —— 以前淨係讀
 *       「通告全文」分頁，而嗰分頁要手動撳「總表同步」先會更新，
 *       新發布嘅通告喺公開頁會一直見唔到。
 *    ③ 公開頁送出嘅嘢（通告報名／收支申報／物資借用）而家會**寫入資料庫**，
 *       執委部機開住 APP 就會自動拉到（以前只寫報表分頁，APP 入面永遠見唔到）。
 *       通告報名會按「同一通告＋同名」防重複。
 *    ④ status 回 backendVersion，APP 可以檢查後端係咪舊版。
 *  ★ v2.4.0 新增（2026-09-18 同一晚，長壽命架構）：
 *    分件儲存 saveDbPart / saveDbCommit —— 資料庫大過單一請求上限都照存得：
 *    前端把 db 拆成 N 件（每件 < 3MB）逐件送，暫存喺「資料庫」分頁
 *    （unit='__staging__'），全部到齊一次過原子式拼合寫入。
 *    所以：旅團用十幾二十年，資料庫十幾 MB 都照常用得（配額按件數計，冇天花板）。
 *  ★ v2.3.0 新增（2026-09-18 同一晚，體積治理）：
 *    ① uploadPhotos —— 相片直接上 Drive（回連結），唔使再入 app 資料庫 JSON
 *       （以前 APP 內申報嘅相 dataURL 會將「資料庫」分頁撐到爆 9MB）
 *    ② dbInfo 附帶逐分頁體積（sizes）—— app 可以畫「體積檢查」
 *    ③ saveDb 刪舊段改為一次過 deleteRows（以前逐行刪，大資料會燒晒 GAS 配額）
 *  ★ v2.2.0 新增（2026-09-18 團長事故修正）：
 *    ① saveDb 樂觀鎖（baseVersion）—— 舊瀏覽器／離線耐咗嘅裝置，唔可以再
 *       用過時資料「盲蓋」後端（之前試過一登入就把另一部機同步嘅資料清空）。
 *       版本對唔上 → 回 conflict:true，等 app 自動「拉後端＋合併＋重存」。
 *    ② addRequest / myRequests —— 團員喺團員入口申報進度完成（寫入「待批完成」，
 *       執委喺審批中心批），同埋查返自己嘅申報狀態。
 *
 *  ★ v2.1.0 新增：「資料庫」分頁 —— app 嘅資料真正存喺後端，
 *    換手機／換瀏覽器／清 cache 都唔會冇咗（action: saveDb / loadDb / dbInfo）。
 *    舊版只係把資料攤平寫入報表分頁（讀唔返），所以一定要更新部署先生效。
 *
 *  功能：
 *   0. 整份資料庫讀／寫（「資料庫」分頁，app 真正嘅儲存）
 *   1. 帳目／財務雙年度資料同步
 *   2. 成員名單與 YMIS 跨系統身份管理
 *   3. 物資清單與公開借用申請（borrow.html）
 *   4. 通告發布與即時報名／出席回覆（notice.html）
 *   5. 成員手機影相記帳／收支申報（entry.html）
 *   6. 會議紀錄與操作審計
 *
 *  快速部署步驟：
 *   1. 建立新的 Google Sheet（例如命名為「82旅 執委會總表」）
 *   2. 點擊「擴充功能」→「Apps Script」
 *   3. 清空預設代碼，貼上本程式碼（Code.gs 全部）
 *   4. 點擊「儲存」，函數選單選「initializeSheets」，點「▶ 執行」完成授權與初始化
 *   5. 執行完成後會顯示 API Key，請複製保存
 *   6. 點擊「部署」→「新增部署作業」→ 齒輪「網頁應用程式」
 *      - 執行身分：我
 *      - 具有存取權的使用者：任何人
 *   7. 複製 Web App URL（/exec 結尾）
 *   8. 將 URL 與 API Key 提交給 Git 負責人／管理員登記於 data/units.json 或 Vercel 環境變數
 * ============================================================
 */

/** 呢份 Script 會用到嘅分頁名稱（同步／查詢時用） */
var SHEET_TABS = ['資料庫', '帳目', '物資', '團員', '收支申報', '通告', '通告全文', '報名', '物資借用', '會議', '設定', '同步紀錄', '審計紀錄',
  '進度追蹤', '其他獎章', '待批完成', '活動履歷', '待批履歷', '成員名單'];

/** 每個旅團分開一個 Sheet（工作表）定用同一個 Sheet 加「旅團」欄？ */
var MODE = 'per-unit-sheet';   // 'per-unit-sheet' = 每個旅團獨立工作表；'one-sheet' = 全部用同一張

/** 相片上載（可選）：填咗資料夾 ID 就會將成員影嘅單據存去 Drive
 *  Drive 資料夾 → 共用 → 複製資料夾 ID（/folders/ 之後嗰串） */
var DRIVE_FOLDER_ID = '';

/** 後端版本（status 會回報；APP 用嚟檢查「你張 Sheet 係咪仲行舊 code」） */
var BACKEND_VERSION = 'v2.8.8';

/* ============================================================
   初始化與 API KEY 管理
   ============================================================ */

/** 取得或自動產生 API Key */
function getApiKey() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_KEY');
  if (!key) {
    key = 'v82_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', key);
  }
  return key;
}

/** 顯示目前 API Key（在 Apps Script 編輯器執行此函數） */
function showApiKey() {
  var apiKey = getApiKey();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* headless */ }
  if (ui) {
    ui.alert('深資童軍管理系統 API Key', '你嘅旅團 API Key 為：\n\n' + apiKey + '\n\n請複製並交由 Git/Vercel 管理員作登記。', ui.ButtonSet.OK);
  }
  Logger.log('==============================');
  Logger.log('深資童軍管理系統 API Key: ' + apiKey);
  Logger.log('==============================');
  return apiKey;
}

/* 支部本地帳戶／session 係正常登入來源；Sheet 選單只提供支部安全操作。 */
function onOpen() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('🔗 支部系統')
      .addItem('ℹ️ 支部本地登入必須保持開啟', 'menuLocalLoginOff')
      .addItem('🔓 開啟／復原本地登入', 'menuLocalLoginOn')
      .addToUi();
  } catch (e) { /* headless（執行緊 script）冇 UI，靜靜略過 */ }
}
function menuLocalLoginOff() {
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* headless */ }
  var message = '支部本地帳戶／session 係正常登入來源，必須保持開啟。';
  PropertiesService.getScriptProperties().setProperty(LINK_FLAG, 'true');
  if (ui) ui.alert('不可關閉支部本地入口', message, ui.ButtonSet.OK);
  try { Logger.log(message); } catch (e2) { /* ignore */ }
  return { success: false, code: 'BRANCH_LOCAL_LOGIN_REQUIRED', error: message,
    allow_local_login: localLoginAllowed() };
}
function menuLocalLoginOn() {
  var ui = SpreadsheetApp.getUi();
  PropertiesService.getScriptProperties().setProperty(LINK_FLAG, 'true');
  ui.alert('已開啟', 'ALLOW_LOCAL_LOGIN=true：本地 apikey／登入恢復。', ui.ButtonSet.OK);
}

/** SHA-256 hex（開團 KEY 只存雜湊） */
function sha256HexGs(s) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s || ''), Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* ============================================================
   Legacy server-signature compatibility（非 Progress／旅系統 reader 契約）
   ------------------------------------------------------------
   保留同 VSBADGE 相同的 LINK_SIG_PURPOSE／sig 公式，讓既有 server proxy 可向
   本支部同一 /exec 重送業務 action。正式支部登入仍由本地帳戶／session 提供，
   initializeSheets() 及 Sheet 選單會維持 ALLOW_LOCAL_LOGIN=true。
   未來旅系統只由旅系統端單向讀支部最小投影；不可把下面的 legacy action
   allowlist、入口旗標或 auth fixture 當作旅系統施工契約。
   sig、nonce 只存 Script Properties / Cache，一律唔寫入工作表。
   ============================================================ */
var LINK_FLAG = 'ALLOW_LOCAL_LOGIN';
var LINK_SIG_PURPOSE = 'vsbadge-troop-sig-v1';     // 與既有 VSBADGE transport 兼容
var LINK_SIG_WINDOW_MS = 5 * 60 * 1000;
var LINK_SIG_NONCE_TTL = 600;
/* Admin saveTables payload can legitimately approach the 4 MiB proxy ceiling. HMAC hashes
   the body, so accepting the same bounded size does not weaken signature verification. */
var LINK_MAX_SIGNED_BYTES = 4 * 1024 * 1024;
var LINK_SIG_HEX_RE = /^[0-9a-f]{64}$/i;
var LINK_NONCE_RE = /^[0-9A-Za-z_-]{8,64}$/;
var LINK_RESERVED_BODY_KEYS = ['sig', 'sig_ts', 'sig_nonce'];
/* Legacy server proxy 可經簽名執行以下 action。authWhoAmI 仍然必須另帶有效
   支部 sessionToken；transport signature 永遠唔會代替用戶登入。 */
var LINK_SIG_READ_ACTIONS = ['load', 'loadMine', 'myRequests', 'getLinkState', 'getLoginMode', 'dbInfo', 'loadDb', 'loadDbPart', 'loadTables', 'loadTablesPart', 'syncCheck', 'authWhoAmI'];
var LINK_SIG_WRITE_ACTIONS = ['save', 'saveOtherBadge', 'reviewRequest', 'reviewLogRequest', 'addRequest', 'saveDb', 'saveDbPart', 'saveDbCommit', 'saveTables', 'sync', 'uploadPhotos', 'repairDb', 'saveDbForce', 'setLocalLogin', 'authResetPassword', 'authDeleteAccount', 'authRestoreAccount', 'authCreateAccount'];

function toHexGs(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + (bytes[i] & 255).toString(16)).slice(-2);
  return out;
}
function hmacSha256HexGs(message, key) {
  return toHexGs(Utilities.computeHmacSha256Signature(String(message), String(key)));
}
/* sig 密鑰以用途分隔方式由「本節點嘅 SHEET KEY＝API_KEY」推導（驗證入站用本機 API_KEY）。 */
function linkSigKeyForGs(key) { return hmacSha256HexGs(LINK_SIG_PURPOSE, String(key || '')); }
function linkSigKeyGs() { return linkSigKeyForGs(getApiKey()); }
function linkCanonicalGs(action, ts, nonce, digest) {
  return [String(action || ''), String(ts || ''), String(nonce || ''), String(digest || '')].join('\n');
}

/* ---- Legacy 入口旗標（正式初始化固定復原為 true）---- */
function localLoginAllowed() {
  var v = String(PropertiesService.getScriptProperties().getProperty(LINK_FLAG) || '').trim().toLowerCase();
  if (!v) return true;   // 未設定＝開啟（fail-open，同 VSBADGE 現有旅團零影響）
  return ['1', 'true', 'yes', 'on', 'open'].indexOf(v) >= 0;   // 其他任何值＝閂（fail-closed）
}
function linkClosedResponse(action) {
  return {
    success: false, ok: false, local_login: false, upstream_only: true,
    error: '支部本地登入旗標異常（' + LINK_FLAG + '=false）；請重新執行 initializeSheets() 復原正常支部入口。' + (action ? '（已拒絕：' + action + '）' : '')
  };
}
function getLinkState() {
  var props = PropertiesService.getScriptProperties();
  var flagVal = String(props.getProperty(LINK_FLAG) || '');
  return {
    success: true, ok: true,
    allow_local_login: localLoginAllowed(),
    link_flag_set: flagVal === 'false' ? 'false' : (flagVal ? 'true' : '（未設定＝開啟）'),
    backend_version: BACKEND_VERSION
  };
}

/* ---- sig 產生／驗證（同 VSBADGE callDownstream / verifyLinkSig 一式一樣）---- */
function stripLinkSigFields(body) {
  var out = {};
  for (var k in (body || {})) {
    if (LINK_RESERVED_BODY_KEYS.indexOf(k) >= 0) continue;
    out[k] = (body || {})[k];
  }
  return out;
}
function readLinkSig(e, body, rawBody) {
  var params = (e && e.parameter) || {};
  var qSig = String(params.sig || ''), qTs = String(params.sts || ''), qNonce = String(params.snonce || '');
  if (qSig && qTs && qNonce) return { sig: qSig, ts: qTs, nonce: qNonce, digest: sha256HexGs(String(rawBody || '')), transport: 'query' };
  var bSig = String((body && body.sig) || ''), bTs = String((body && body.sig_ts) || ''), bNonce = String((body && body.sig_nonce) || '');
  if (bSig && bTs && bNonce) {
    var canonicalPayload = '';
    try { canonicalPayload = JSON.stringify(stripLinkSigFields(body)); } catch (err) { return null; }
    return { sig: bSig, ts: bTs, nonce: bNonce, digest: sha256HexGs(canonicalPayload), transport: 'body' };
  }
  return null;
}
function verifyLinkSig(e, body, rawBody) {
  var lock = null;
  var locked = false;
  try {
    var s = readLinkSig(e, body, rawBody);
    if (!s) return false;
    if (String(rawBody || '').length > LINK_MAX_SIGNED_BYTES) return false;
    if (!LINK_SIG_HEX_RE.test(String(s.sig))) return false;
    if (!LINK_NONCE_RE.test(String(s.nonce))) return false;
    var ts = parseInt(s.ts, 10);
    if (!isFinite(ts) || Math.abs(Date.now() - ts) > LINK_SIG_WINDOW_MS) return false;
    var bodyAction = String((body && body.action) || '');
    var expected = linkSigKeyGs();
    var got = hmacSha256HexGs(linkCanonicalGs(bodyAction, s.ts, s.nonce, s.digest), expected);
    var supplied = String(s.sig);
    if (got.length !== supplied.length) return false;
    var different = 0;
    for (var ci = 0; ci < got.length; ci++) different |= got.charCodeAt(ci) ^ supplied.charCodeAt(ci);
    if (different !== 0) return false;

    /* query 外層簽名同 body 內層簽名都要一次過消耗；否則攔截者可拆走
       已用過的 query，再單獨重放未標記的 body nonce。Cache get＋put 必須
       放喺同一把 ScriptLock 內，兩個並發請求只可有一個成功。服務異常 fail closed。 */
    var nonces = [String(s.nonce)];
    var params = (e && e.parameter) || {};
    var queryNonce = String(params.snonce || '');
    var bodyNonce = String((body && body.sig_nonce) || '');
    [queryNonce, bodyNonce].forEach(function (nonce) {
      if (LINK_NONCE_RE.test(nonce) && nonces.indexOf(nonce) < 0) nonces.push(nonce);
    });
    if (typeof CacheService === 'undefined' || typeof LockService === 'undefined') return false;
    lock = LockService.getScriptLock();
    lock.waitLock(5000);
    locked = true;
    var cache = CacheService.getScriptCache();
    if (!cache) return false;
    var nonceKeys = nonces.map(function (nonce) {
      return 'v82-link-nonce:' + sha256HexGs(nonce).substring(0, 40);
    });
    for (var ni = 0; ni < nonceKeys.length; ni++) if (cache.get(nonceKeys[ni])) return false;
    for (var nj = 0; nj < nonceKeys.length; nj++) cache.put(nonceKeys[nj], '1', LINK_SIG_NONCE_TTL);
    return true;
  } catch (err) {
    return false;
  } finally {
    if (locked && lock) {
      try { lock.releaseLock(); } catch (ignore) { /* fail closed above */ }
    }
  }
}

/* ---- Legacy server-signature transport（只行 body.action 白名單）---- */
function handleSignedRequest(e, body, rawBody) {
  var a = String((body && body.action) || '');
  if (LINK_SIG_READ_ACTIONS.indexOf(a) < 0 && LINK_SIG_WRITE_ACTIONS.indexOf(a) < 0) {
    return json({ success: false, ok: false, error: 'server-signature transport 不接受此操作：' + a });
  }
  /* 簽名已由共享 nonce＋HMAC 驗證；用只在 server 內加入的 marker 交給 dispatcher。
     API Key 仍只作路由，絕不因為「有 key」就自動變成用戶身份。 */
  var signedBody = stripLinkSigFields(body);
  signedBody.apikey = getApiKey();
  signedBody.__serverSigned = true;
  return dispatchBody(e, signedBody);
}

/* PBKDF2-HMAC-SHA256：支部帳戶密碼用；hash／salt 只會留喺後端資料。
   GAS 沒有原生 PBKDF2，所以按 RFC 8018 實作，最低 100,000 iterations。 */
function pbkdf2Sha256Hex(password, salt, iterations) {
  var count = Number(iterations || 120000);
  if (!isFinite(count) || count < 100000) count = 120000;
  if (count > 1000000) count = 1000000;
  var pass = Utilities.newBlob(String(password || '')).getBytes();
  var saltBytes = Utilities.newBlob(String(salt || '')).getBytes();
  var block = saltBytes.concat([0, 0, 0, 1]);
  var u = Utilities.computeHmacSha256Signature(block, pass);
  var out = u.slice();
  for (var i = 1; i < count; i++) {
    u = Utilities.computeHmacSha256Signature(u, pass);
    for (var j = 0; j < out.length; j++) out[j] = (out[j] ^ u[j]);
  }
  return out.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/** 支部帳戶密碼政策：最短 4 位；1234 只可作首次／重設後密碼。 */
function passwordPolicy(password) {
  var value = String(password == null ? '' : password);
  if (value.length < 4) return { ok: false, error: '密碼最少要 4 位' };
  return { ok: true, temporary: value === '1234' };
}

function makePasswordRecord(password, forceChange) {
  var policy = passwordPolicy(password);
  if (!policy.ok) return { ok: false, error: policy.error };
  var salt = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var iterations = 120000;
  return { ok: true, pw: { algo: 'pbkdf2-sha256', salt: salt, iterations: iterations,
    hash: pbkdf2Sha256Hex(password, salt, iterations) },
    mustChangePw: forceChange === undefined ? policy.temporary : !!forceChange };
}

function verifyPasswordRecord(record, password) {
  if (!record || record.algo !== 'pbkdf2-sha256' || !record.salt || !record.hash) return false;
  var policy = passwordPolicy(password);
  if (!policy.ok) return false;
  var got = pbkdf2Sha256Hex(password, record.salt, record.iterations);
  if (got.length !== String(record.hash).length) return false;
  var same = 0;
  for (var i = 0; i < got.length; i++) same |= got.charCodeAt(i) ^ String(record.hash).charCodeAt(i);
  return same === 0;
}

/**
 * 開團登入 KEY：喺 Apps Script 編輯器執行呢個函數。
 * 每次產生新 KEY，有效 72 小時；過期再執行一次。唔會寫入工作表、唔會喺 App 顯示超管。
 */
function issueSetupKey() {
  var raw = Utilities.getUuid().replace(/-/g, '').substring(0, 20).toUpperCase();
  var key = 'EC72-' + raw;
  var exp = Date.now() + 72 * 3600 * 1000;
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SETUP_KEY_HASH', sha256HexGs(key));
  props.setProperty('SETUP_KEY_EXP', String(exp));
  var until = Utilities.formatDate(new Date(exp), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm');
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* */ }
  if (ui) {
    ui.alert('開團登入 KEY（72 小時）', key + '\n\n有效至：' + until + '\n過期請再執行 issueSetupKey()。\n喺執委系統「領袖登入」貼上呢條 KEY。', ui.ButtonSet.OK);
  }
  Logger.log('SETUP KEY: ' + key + ' until ' + until);
  return key;
}

function setPasswordResetUrl(url) {
  var value = String(url || '').trim();
  if (value.slice(-1) === '/') value = value.slice(0, -1);
  var lower = value.toLowerCase();
  var validPath = lower.endsWith('/reset-password.html') || lower.endsWith('/reset-password');
  if (lower.indexOf('https://') !== 0 || value.indexOf('?') >= 0 || value.indexOf('#') >= 0
      || value.indexOf(' ') >= 0 || !validPath || value.length > 500) {
    throw new Error('只接受 https://.../reset-password.html 固定網址（不可帶 query／fragment）');
  }
  PropertiesService.getScriptProperties().setProperty('PASSWORD_RESET_URL', value);
  Logger.log('PASSWORD_RESET_URL configured: ' + value);
  return value;
}

function verifySetupKey(key) {
  var props = PropertiesService.getScriptProperties();
  var hash = props.getProperty('SETUP_KEY_HASH') || '';
  var exp = Number(props.getProperty('SETUP_KEY_EXP') || 0);
  if (!hash || !exp) return { ok: false, success: false, error: '未產生 KEY。請喺 Apps Script 執行 issueSetupKey()' };
  if (Date.now() > exp) return { ok: false, success: false, error: 'KEY 已過期（72 小時）。請再執行 issueSetupKey()' };
  if (sha256HexGs(String(key || '').trim()) !== hash) return { ok: false, success: false, error: 'KEY 不正確' };
  return { ok: true, success: true, hoursLeft: Math.round((exp - Date.now()) / 3600000) };
}

/* ============================================================
   初始化資料保全（★ 學 VSBADGE ensureUserColumns / v9.1 定案）
   ------------------------------------------------------------
   鐵律：**每次更新 Code.gs 之後都可以安心行一次 initializeSheets()**。
     · 只補：缺失分頁、缺失欄位（加喺最右）、缺失設定預設值
     · 絕不：改寫／刪除／重排／重新編號任何現有用戶資料
     · 絕不：更換現有 API_KEY
     · idempotent：連跑兩次，第二次零改動
   點解要補欄：舊寫法只在 getLastRow() === 0 先寫 header，
   即係一張已有資料嘅舊 Sheet **永遠加唔到新欄位** —— 升級後新欄靜靜缺失。
   而家逐欄比對 header 名，只把缺少嘅補喺最右邊（唔郁現有欄位位置，
   因為 Progress／BADGE action 係按欄位位置讀共用分頁，重排會即刻讀錯）。
   守護測試：tests/init-preserve.mjs（前後逐表快照對比）。
   ============================================================ */
var INITIALIZED_VERSION_PROP = 'INITIALIZED_VERSION';

/** 補齊一個分頁嘅結構；只加唔改。回傳做咗乜（畀報告用）。 */
function ensureSheetStructure_(ss, cfg, brandColor, headerColor) {
  var name = cfg.name, headers = cfg.headers;
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold').setBackground(brandColor).setFontColor(headerColor);
    sh.setFrozenRows(1);
    return { tab: name, created: true, addedColumns: [] };
  }
  /* 分頁已存在但完全空 → 只寫標題列，唔會掂到任何資料（本來就冇）。 */
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold').setBackground(brandColor).setFontColor(headerColor);
    sh.setFrozenRows(1);
    return { tab: name, created: false, headerWritten: true, addedColumns: [] };
  }
  /* 已有資料：只喺最右補缺失欄位，現有每一格一律唔郁。 */
  var lastCol = sh.getLastColumn();
  var existing = sh.getRange(1, 1, 1, Math.max(lastCol, 1)).getValues()[0] || [];
  var seen = {}, hasKnown = false, nonEmpty = 0;
  for (var i = 0; i < existing.length; i++) {
    var h = String(existing[i] === undefined || existing[i] === null ? '' : existing[i]).trim();
    if (h) { nonEmpty++; seen[h] = true; }
  }
  for (var k = 0; k < headers.length; k++) { if (seen[headers[k]]) { hasKnown = true; break; } }
  /* 防呆：第一行唔似標題列（全空，或者一個預期欄名都認唔到）→ 唔敢喺嗰行加嘢，
     寧願如實報 skipped，都唔好可能污染用戶嘅資料行。 */
  if (!nonEmpty || !hasKnown) {
    return { tab: name, created: false, addedColumns: [], skipped: 'first-row-not-header' };
  }
  var missing = [];
  for (var j = 0; j < headers.length; j++) { if (!seen[headers[j]]) missing.push(headers[j]); }
  if (missing.length) {
    sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing])
      .setFontWeight('bold').setBackground(brandColor).setFontColor(headerColor);
  }
  return { tab: name, created: false, addedColumns: missing };
}

/** 初始化狀態（status 會回報）：分清楚「GS 已更新」同「已行初始化」。 */
function initializationStatus() {
  var done = '';
  try { done = String(PropertiesService.getScriptProperties().getProperty(INITIALIZED_VERSION_PROP) || ''); }
  catch (e) { done = ''; }
  return {
    backendVersion: BACKEND_VERSION,
    initializedVersion: done,
    initializationCurrent: done === BACKEND_VERSION,
    initializeRequired: done !== BACKEND_VERSION
  };
}

/** 初始化試算表：建立所有必要分頁、設定棗紅標題列及凍結頂列。
 *  ★ 可以重跑：只補缺失結構，絕不改寫現有用戶資料／API Key（見上面鐵律）。 */
function initializeSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var brandColor = '#7B2233'; // 82venture 棗紅主色
  var headerColor = '#FFFFFF';

  var sheetConfigs = [
    /* 「資料表」＝ 逐表寫入（saveTables）嘅正本目標。
       以前只靠 simpleSheet() 懶建立，初始化清單漏咗佢 —— 而家補齊。 */
    { name: '資料表', headers: ['旅團', '表名', '段號', '內容(JSON)', '更新時間', '版本'] },
    /* 「資料庫」＝ 真正嘅資料主體（app 嘅完整資料庫，分段存 JSON）。
       其他分頁係由佢攤平出嚟畀人睇／畀你自己用公式嘅「報表」。
       唔好人手改呢個分頁 —— 改咗會令 app 讀唔返。 */
    { name: '資料庫', headers: ['旅團', '段號', '內容(JSON)', '更新時間', '版本'] },
    { name: '帳目', headers: ['旅團', 'id', '日期', '類型', '項目', '金額', '分類', '方式', '負責人', '單據編號', '期別', '備註', '同步時間'] },
    { name: '收支申報', headers: ['旅團', '時間', '日期', '類型', '欄目', '項目', '金額', '付款人', '備註', '相片張數', '相片連結', '紀錄編號'] },
    { name: '物資', headers: ['旅團', 'id', '物資編號', '物資名稱', '分類', '總數量', '單位', '存放位置', '狀態', '備註', '同步時間'] },
    { name: '物資借用', headers: ['旅團', '時間', '申請人', '聯絡電話', '物資編號', '物資名稱', '數量', '借用日', '歸還日', '用途', '狀態', '紀錄編號'] },
    { name: '團員', headers: ['旅團', 'id', 'ymis', 'systemId', '姓名', '英文名', '身份', '生日', '職位', '狀態', '電話', '電郵', '加入日期', '備註', '同步時間'] },
    { name: '通告', headers: ['旅團', 'id', '標題(中)', '標題(英)', '類型', '狀態', '活動日期', '截止日期', '活動地點', '集合時間及地點', '解散時間及地點', '內容／程序', '服裝', '費用', '名額', '查詢', '發布日期', '同步時間'] },
    /* 通告全文（JSON）：公開頁直接讀呢個分頁 —— 新通告唔使改 Git 都公開得到 */
    { name: '通告全文', headers: ['旅團', 'id', '狀態', '標題', 'JSON', '更新時間'] },
    { name: '報名', headers: ['旅團', '通告編號', '通告標題', '報名時間', '姓名', '聯絡', '出席與否', '全部欄位(JSON)'] },
    { name: '會議', headers: ['旅團', 'id', '日期', '標題', '地點', '狀態', '備註', '同步時間'] },
    { name: '同步紀錄', headers: ['時間', '旅團', '旅團名稱', '統計內容'] },
    { name: '審計紀錄', headers: ['時間', '旅團', 'action', '結果', '途徑', '操作者'] },
    /* ↓↓↓ 行政、Progress 與 BADGE 共用嘅分頁（一個 Unified 後端、多個 client）：欄位順序唔可以改 ↓↓↓ */
    { name: '進度追蹤', headers: ['YMIS', '項目 ID', '完成日期', '更新時間', '確認者', '備註'] },
    { name: '其他獎章', headers: ['YMIS', '獎章 ID', '獎章名稱', '完成日期', '證書編號', '備註', '更新時間'] },
    { name: '待批完成', headers: ['request_id', 'ymis', 'name', 'item_id', 'item_name', 'requested_date', 'evidence', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'review_note', 'confirmed_date'] },
    { name: '活動履歷', headers: ['record_id', 'type', 'ymis', 'name', 'date', 'title', 'role', 'hours', 'cert_no', 'detail', 'recorder', 'recorded_at', 'updated_at'] },
    { name: '待批履歷', headers: ['request_id', 'kind', 'target_record_id', 'type', 'ymis', 'name', 'date', 'title', 'role', 'hours', 'cert_no', 'detail', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'review_note'] },
    { name: '成員名單', headers: ['YMIS', '姓名', '加入日期', '支部', '聯絡'] }
  ];

  /* 逐個分頁補結構（只加唔改；每一格現有資料都唔會掂）。 */
  var report = [];
  sheetConfigs.forEach(function(cfg) {
    var structure = ensureSheetStructure_(ss, cfg, brandColor, headerColor);
    report.push(structure);
    if (structure.created && unifiedReportNames_().indexOf(cfg.name) >= 0) {
      unifiedRememberReport_(ss.getSheetByName(cfg.name));
    }
  });

  /* 確保取得 API Key —— getApiKey() 只會喺冇 key 時生成，
     已有 key 一律原樣保留（初始化唔准換 key，否則全部裝置即刻斷線）。 */
  var apiKey = getApiKey();

  /* 成功完成後寫初始化標記（學 VSBADGE VS_GS_INITIALIZED_VERSION）：
     咁先分得清「淨係貼咗新 Code.gs」同「真係行咗初始化」。 */
  try {
    var initProps = PropertiesService.getScriptProperties();
    // Preserve the existing BADGE local-login setting.
    initProps.setProperty(INITIALIZED_VERSION_PROP, BACKEND_VERSION);
  } catch (e) { /* ScriptProperties 配額／權限問題唔應該令初始化本身失敗 */ }

  var created = report.filter(function(r) { return r.created; }).map(function(r) { return r.tab; });
  var widened = report.filter(function(r) { return (r.addedColumns || []).length; });
  var skipped = report.filter(function(r) { return r.skipped; });
  var summary = '已檢查 ' + report.length + ' 個分頁：新建 ' + created.length +
    '、補欄 ' + widened.length + '。現有資料一行都冇改，API Key 不變。';

  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* headless */ }
  if (false && ui) {
    var detail = widened.length
      ? '\n\n補咗新欄位（加喺最右，舊欄位置不變）：\n' +
        widened.map(function(r) { return '· ' + r.tab + '：' + r.addedColumns.join('、'); }).join('\n')
      : '';
    var warn = skipped.length
      ? '\n\n⚠ 有分頁第一行唔似標題列，為安全起見冇自動加欄（請人手核對）：\n' +
        skipped.map(function(r) { return '· ' + r.tab; }).join('\n')
      : '';
    ui.alert(
      '初始化完成（' + BACKEND_VERSION + '）',
      summary + detail + warn + '\n\n' +
      '你嘅 API Key 為：\n' + apiKey + '\n\n' +
      '下一步：\n' +
      '1. 點擊「部署」→「管理部署作業」→ 編輯 → 版本揀「新版本」\n' +
      '2. 選擇「網頁應用程式」（執行身分：我；存取權：任何人）\n' +
      '3. /exec 網址不變；首次部署先需要將網址＋API Key 交予 Git 管理員登記。',
      ui.ButtonSet.OK
    );
  }
  Logger.log('深資童軍管理系統 ' + BACKEND_VERSION + ' initialization stage complete.');
  return {
    ok: true, success: true, apiKey: apiKey,
    backendVersion: BACKEND_VERSION,
    initializedVersion: BACKEND_VERSION,
    initializationCurrent: true,
    initializeRequired: false,
    preservedExistingData: true,
    created: created,
    addedColumns: widened,
    skipped: skipped,
    report: report,
    msg: summary
  };
}

/* ============================================================
   團員入口安全投影／本人寫入
   ------------------------------------------------------------
   團員 session 絕不可以下載整份行政資料庫（密碼 hash、全團請假、答卷、
   RSVP 等）。以下 helper 由 server session 對回名冊本人，再按身份過濾內容；
   寫入亦只接受本人 RSVP／答卷／請假，完全不採用 client 傳來的 memberId／role。
   ============================================================ */
function hubClone_(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return null; }
}
function hubRoleRank_(role) {
  var level = branchRoleLevel_(role);
  return level ? level + 1 : 0;
}
function hubVisRank_(vis, fallback) {
  var value = textOf(vis || fallback || 'member').toLowerCase();
  /* 'other' 只係舊資料 adapter；匿名層已退役並安全收窄到 member。 */
  if (value === 'other') value = 'member';
  var level = branchRoleLevel_(value);
  if (level) return level + 1;
  var fallbackLevel = branchRoleLevel_(fallback || 'member') || branchRoleLevel_('member');
  return fallbackLevel + 1;
}
function hubVisible_(record, kind, role) {
  var fallback = 'member';
  if (kind === 'event' && record && record.visibility === 'exco') fallback = 'exco';
  return hubVisRank_(record && record.vis, fallback) <= hubRoleRank_(role);
}
function hubSafeMember_(member, role) {
  return {
    id: textOf(member && member.id), ymis: textOf(member && member.ymis),
    name: textOf(member && member.name), email: textOf(member && member.email),
    identity: textOf(role || (member && member.identity) || 'member').toLowerCase(),
    status: textOf(member && member.status || 'active')
  };
}
/* Hub output uses positive field lists. Never clone a whole admin record and delete today's
   sensitive fields: a future schema column must stay private until explicitly admitted here. */
function hubSafeRsvp_(row) {
  if (!row || typeof row !== 'object') return null;
  return { status: textOf(row.status || row), at: textOf(row.at), name: textOf(row.name),
    time: textOf(row.time), reason: textOf(row.reason) };
}
function hubSafeQuestion_(row) {
  row = row || {};
  return { id: textOf(row.id), prompt: textOf(row.prompt), type: textOf(row.type || 'short'),
    options: (Array.isArray(row.options) ? row.options : []).map(textOf), required: !!row.required };
}
function hubSafeAnswers_(raw, questions) {
  var out = {}; raw = raw && typeof raw === 'object' ? raw : {};
  (questions || []).forEach(function (question) {
    var id = textOf(question && question.id); if (!id) return;
    var value = raw[id];
    out[id] = question.type === 'multi'
      ? (Array.isArray(value) ? value : []).map(textOf)
      : textOf(value);
  });
  return out;
}
function hubSafeEvent_(row, memberId) {
  row = row || {};
  var out = { id: textOf(row.id), title: textOf(row.title), date: textOf(row.date),
    dateEnd: textOf(row.dateEnd), time: textOf(row.time), venue: textOf(row.venue),
    detail: textOf(row.detail), status: textOf(row.status), vis: textOf(row.vis),
    visibility: textOf(row.visibility), rsvp: {} };
  var mine = row.rsvp && row.rsvp[memberId];
  if (mine !== undefined) out.rsvp[memberId] = hubSafeRsvp_(mine);
  return out;
}
function hubSafeQuiz_(row, memberId) {
  row = row || {};
  var questions = (Array.isArray(row.questions) ? row.questions : []).map(hubSafeQuestion_);
  var out = { id: textOf(row.id), title: textOf(row.title), note: textOf(row.note),
    status: textOf(row.status), vis: textOf(row.vis), questions: questions, responses: {} };
  var mine = row.responses && row.responses[memberId];
  if (mine !== undefined) out.responses[memberId] = { name: textOf(mine && mine.name),
    at: textOf(mine && mine.at), answers: hubSafeAnswers_(mine && mine.answers, questions) };
  return out;
}
function hubSafeNotice_(row, memberId, ymis) {
  row = row || {};
  var title = row.title && typeof row.title === 'object'
    ? { zh: textOf(row.title.zh), en: textOf(row.title.en) }
    : { zh: textOf(row.title), en: '' };
  var body = row.body && typeof row.body === 'object'
    ? { zh: textOf(row.body.zh), en: textOf(row.body.en) }
    : { zh: textOf(row.body), en: '' };
  var fields = (Array.isArray(row.fields) ? row.fields : []).map(function (field) {
    return { key: textOf(field && field.key), label: textOf(field && field.label), type: textOf(field && field.type || 'text'),
      required: !!(field && field.required), options: (Array.isArray(field && field.options) ? field.options : []).map(textOf) };
  });
  var mySignup = null;
  (Array.isArray(row.signups) ? row.signups : []).some(function (signup) {
    if (signup && ((memberId && textOf(signup.memberId) === textOf(memberId))
        || (ymis && textOf(signup.ymis) === textOf(ymis)))) { mySignup = signup; return true; }
    return false;
  });
  return { id: textOf(row.id), title: title, body: body, status: textOf(row.status), vis: textOf(row.vis),
    type: textOf(row.type), eventDate: textOf(row.eventDate), deadline: textOf(row.deadline), venue: textOf(row.venue),
    assemblyTime: textOf(row.assemblyTime), dismissTime: textOf(row.dismissTime), assemblyPlace: textOf(row.assemblyPlace),
    dismissPlace: textOf(row.dismissPlace), fee: textOf(row.fee), uniform: textOf(row.uniform), bring: textOf(row.bring),
    contact: textOf(row.contact), needSignup: !!row.needSignup, fields: fields, publishAt: textOf(row.publishAt),
    mySignup: mySignup ? { id: textOf(mySignup.id), at: textOf(mySignup.at), answers: hubClone_(mySignup.answers || {}) } : null };
}
function hubSafeAbsence_(row) {
  row = row || {};
  return { id: textOf(row.id), at: textOf(row.at), unit: textOf(row.unit),
    memberId: textOf(row.memberId), ymis: textOf(row.ymis), date: textOf(row.date),
    slot: textOf(row.slot), reason: textOf(row.reason), plan: textOf(row.plan),
    status: textOf(row.status), reviewedBy: textOf(row.reviewedBy),
    reviewedAt: textOf(row.reviewedAt), reviewNote: textOf(row.reviewNote) };
}
function hubFindActor_(db, session) {
  db = db || {};
  var members = Array.isArray(db.members) ? db.members : [];
  var accounts = Array.isArray(db.accounts) ? db.accounts : [];
  var account = null;
  var member = null;
  var subject = textOf(session && session.subject).toLowerCase();
  if (session && session.portal) {
    members.some(function (m) {
      if (m && m.status !== 'alumni' && (textOf(m.ymis).toLowerCase() === subject ||
          textOf(m.email).toLowerCase() === subject || textOf(m.loginId).toLowerCase() === subject)) {
        member = m; return true;
      }
      return false;
    });
  } else if (session && session.kind === 'account') {
    accounts.some(function (a) {
      if (a && a.active !== false && textOf(a.id) === textOf(session.id)) { account = a; return true; }
      return false;
    });
    if (account && account.memberId) members.some(function (m) {
      if (m && m.status !== 'alumni' && textOf(m.id) === textOf(account.memberId)) { member = m; return true; }
      return false;
    });
    if (!member && account) members.some(function (m) {
      if (!m || m.status === 'alumni') return false;
      if ((account.email && textOf(m.email).toLowerCase() === textOf(account.email).toLowerCase()) ||
          (account.username && (textOf(m.ymis).toLowerCase() === textOf(account.username).toLowerCase() ||
            textOf(m.loginId).toLowerCase() === textOf(account.username).toLowerCase()))) {
        member = m; return true;
      }
      return false;
    });
  } else if (session) {
    members.some(function (m) {
      if (m && m.status !== 'alumni' && !m.accountDeletedAt && textOf(m.id) === textOf(session.id)) {
        member = m; return true;
      }
      return false;
    });
  }
  if (!member) return { ok: false, error: '登入帳戶未綁定有效名冊成員', code: 'SESSION_ACCOUNT_MISSING' };
  var role = textOf(session && session.portal ? session.role : (member.identity || (account && account.role) || 'member')).toLowerCase();
  return { ok: true, member: member, account: account, record: account || member,
    kind: account ? 'account' : 'member', role: role };
}

/* 行政 actor 同 hub actor 有一個刻意差異：歷史個人 accounts 可能尚未綁 memberId，
   但仍要容許其有效 session 管理／搬遷資料。優先用 hubFindActor_ 取得名冊最新身份；
   只有本地 account session 且確實對到 active account id 時，才 fallback 到 account role。
   隔離 auth fixture 身份永遠必須對到支部名冊，不設此 fallback。 */
function adminFindActor_(db, session) {
  var linked = hubFindActor_(db, session);
  if (linked.ok || !session || session.portal || session.kind !== 'account') return linked;
  var account = null;
  (db && db.accounts || []).some(function (a) {
    if (a && a.active !== false && textOf(a.id) === textOf(session.id)) { account = a; return true; }
    return false;
  });
  if (!account) return linked;
  return { ok: true, member: null, account: account, record: account, kind: 'account',
    role: textOf(account.role || 'member').toLowerCase(), legacyUnbound: true };
}

/* ============================================================
   支部 schema／伺服器權限
   ------------------------------------------------------------
   瀏覽器開關只係介面。所有行政讀寫都會在這裏重新由 opaque session 對回
   server DB 的身份，再套 module show/read/edit、細項權限、內容可見層級。
   ============================================================ */
var BRANCH_SCHEMA_ID_ = "venture-scout";
var BRANCH_SCHEMA_VERSION_ = 1;
var BRANCH_ROLE_LEVELS_ = {"member":1,"exco":2,"leader":3,"chief":4,"super":5};
var BRANCH_ROLE_ORDER_ = ["member","exco","leader","chief","super"];
var BRANCH_VISIBLE_ROLES_ = ["member","exco","leader","chief"];
var BRANCH_ACCOUNT_ROLES_ = ["member","exco","leader"];
var BRANCH_ROLE_ALIASES_ = {"exec_committee":"exco","branch_leader":"leader","group_leader":"chief","admin":"chief","super_admin":"super"};
var BRANCH_MODULE_DEFAULTS_ = {"dashboard":[2,2,99],"calendar":[2,2,2],"quizzes":[2,2,2],"meetings":[2,2,2],"finance":[2,2,2],"members":[2,2,2],"inventory":[2,2,2],"progress":[2,2,2],"notices":[2,2,2],"links":[2,2,3],"constitution":[2,2,3],"tables":[3,3,3],"admin":[3,3,3]};
var BRANCH_MODULE_KEYS_ = {
  calendar: ['events', 'absences'], quizzes: ['quizzes'], meetings: ['meetings'],
  finance: ['transactions', 'claims', 'fees', 'budgets', 'reference', 'categories', 'methods'],
  members: ['members', 'accounts', 'accountApps', 'deletedAccounts', 'accessControl', 'permOverrides'],
  inventory: ['invItems', 'invLoans', 'invAudits', 'invNextCode'], notices: ['notices'],
  constitution: ['constitution'], tables: ['tableSchema', 'tableSources'],
  admin: ['auditLog', 'issueReports']
};
var BRANCH_KEY_MODULE_ = (function () {
  var out = {};
  Object.keys(BRANCH_MODULE_KEYS_).forEach(function (moduleId) {
    BRANCH_MODULE_KEYS_[moduleId].forEach(function (key) { out[key] = moduleId; });
  });
  return out;
})();
var BRANCH_VIEW_PERMISSION_ = {
  calendar: 'calendar.view', quizzes: 'quiz.view', meetings: 'meeting.view',
  finance: 'finance.view', members: 'member.view', inventory: 'inv.view',
  progress: 'progress.view', notices: 'notice.view', constitution: 'constitution.view',
  tables: 'table.view'
};
var BRANCH_PERMISSION_DEFAULTS_ = {
  'meeting.view':[0,1,1], 'meeting.create':[0,1,1], 'meeting.edit':[0,'own',1], 'meeting.delete':[0,0,1],
  'meeting.minutes':[0,1,1], 'meeting.approve':[0,1,1],
  'finance.view':[0,1,1], 'finance.create':[0,1,1], 'finance.edit':[0,'own',1], 'finance.delete':[0,0,1],
  'finance.report':[0,1,1], 'finance.export':[0,1,1], 'claim.submit':[0,1,1], 'claim.review':[0,1,1],
  'fee.view':[0,1,1], 'fee.mark':[0,1,1], 'fee.edit':[0,0,1],
  'member.view':[0,1,1], 'member.create':[0,1,1], 'member.edit':[0,1,1], 'member.note':[0,1,1],
  'member.delete':[0,0,1], 'member.export':[0,1,1], 'member.identity':[0,0,1],
  'inv.view':[0,1,1], 'inv.manage':[0,1,1], 'inv.borrow':[0,1,1], 'inv.approve':[0,1,1], 'inv.audit':[0,1,1],
  'calendar.view':[0,1,1], 'calendar.edit':[0,1,1], 'quiz.view':[0,1,1], 'quiz.edit':[0,1,1],
  'progress.view':[0,1,1], 'progress.tick':[0,1,1], 'progress.config':[0,0,1],
  'notice.view':[0,1,1], 'notice.create':[0,1,1], 'notice.edit':[0,1,1], 'notice.publish':[0,1,1], 'notice.signup':[0,1,1],
  'table.view':[0,1,1], 'table.design':[0,0,1], 'table.sync':[0,0,1],
  'constitution.view':[0,1,1], 'constitution.edit':[0,0,1], 'constitution.publish':[0,0,1],
  'admin.view':[0,1,1], 'admin.accounts':[0,0,1], 'admin.data':[0,0,1], 'admin.units':[0,0,1]
};
function branchCanonicalRole_(role) {
  var value = textOf(role).toLowerCase();
  var canonical = BRANCH_ROLE_ALIASES_[value] || value;
  return Object.prototype.hasOwnProperty.call(BRANCH_ROLE_LEVELS_, canonical) ? canonical : '';
}
function branchRoleLevel_(role) { return Number(BRANCH_ROLE_LEVELS_[branchCanonicalRole_(role)] || 0); }
function staffDefaultGrant_(moduleId, role) {
  var thresholds = BRANCH_MODULE_DEFAULTS_[moduleId];
  var level = branchRoleLevel_(role);
  return { show: !!(thresholds && level >= thresholds[0]), read: !!(thresholds && level >= thresholds[1]),
    edit: !!(thresholds && level >= thresholds[2]) };
}
function staffAccessMatrix_(db) {
  var source = db && db.accessControl && db.accessControl.modules || {};
  var modules = {};
  Object.keys(BRANCH_MODULE_DEFAULTS_).forEach(function (moduleId) {
    var row = {}, inherited = { show: false, read: false, edit: false };
    BRANCH_ROLE_ORDER_.forEach(function (role) {
      var fallback = staffDefaultGrant_(moduleId, role);
      var saved = source[moduleId] && source[moduleId][role] && typeof source[moduleId][role] === 'object'
        ? source[moduleId][role] : {};
      var grant = {
        show: saved.show === undefined ? fallback.show : saved.show === true,
        read: saved.read === undefined ? fallback.read : saved.read === true,
        edit: saved.edit === undefined ? fallback.edit : saved.edit === true
      };
      if (grant.edit) grant.read = true;
      ['show', 'read', 'edit'].forEach(function (dimension) {
        inherited[dimension] = inherited[dimension] || grant[dimension];
        grant[dimension] = inherited[dimension];
      });
      if (grant.edit) grant.read = true;
      row[role] = grant;
    });
    modules[moduleId] = row;
  });
  return { schema: 1, branchSchema: BRANCH_SCHEMA_ID_, branchSchemaVersion: BRANCH_SCHEMA_VERSION_, modules: modules };
}
function staffModuleGrant_(db, moduleId, role) {
  var canonical = branchCanonicalRole_(role);
  var matrix = staffAccessMatrix_(db);
  return matrix.modules[moduleId] && matrix.modules[moduleId][canonical]
    ? matrix.modules[moduleId][canonical] : { show: false, read: false, edit: false };
}
function staffPermStrength_(value) { return value === 1 ? 2 : (value === 'own' || value === 'self' ? 1 : 0); }
function staffStrongerPerm_(a, b) { return staffPermStrength_(a) >= staffPermStrength_(b) ? a : b; }
function staffPermDefault_(permission, role) {
  var canonical = branchCanonicalRole_(role);
  if (canonical === 'super') return permission === 'admin.pw.super' ? 0 : 1;
  var defaults = BRANCH_PERMISSION_DEFAULTS_[permission] || [0, 0, 0];
  if (canonical === 'member') return defaults[0] === undefined ? 0 : defaults[0];
  if (canonical === 'exco') return defaults[1] === undefined ? 0 : defaults[1];
  /* chief inherits leader defaults unless a dedicated identity rule below narrows it. */
  if (canonical === 'leader' || canonical === 'chief') return defaults[2] === undefined ? 0 : defaults[2];
  return 0;
}
function staffPermValue_(db, permission, role) {
  var wanted = branchCanonicalRole_(role), inherited = 0, answer = 0;
  var custom = db && db.permOverrides && db.permOverrides[permission] || {};
  BRANCH_ROLE_ORDER_.forEach(function (candidate) {
    var proposed = Object.prototype.hasOwnProperty.call(custom, candidate)
      ? custom[candidate] : staffPermDefault_(permission, candidate);
    if ([0, 1, 'own', 'self'].indexOf(proposed) < 0) proposed = staffPermDefault_(permission, candidate);
    proposed = staffStrongerPerm_(proposed, inherited);
    inherited = proposed;
    if (candidate === wanted) answer = proposed;
  });
  return answer;
}
function staffOwnRecord_(actor, record) {
  var member = actor && actor.member || {};
  var account = actor && actor.account || {};
  var ids = [textOf(member.id), textOf(account.id), textOf(member.ymis), textOf(member.email).toLowerCase(),
    textOf(account.username).toLowerCase(), textOf(account.email).toLowerCase()].filter(function (x) { return !!x; });
  var owners = [record && record.memberId, record && record.createdBy, record && record.requestedBy,
    record && record.chair, record && record.ymis, record && record.email, record && record.by].map(function (x) { return textOf(x).toLowerCase(); });
  return owners.some(function (owner) { return !!owner && ids.indexOf(owner) >= 0; });
}
function staffCanPermission_(db, permission, actor, record) {
  var value = staffPermValue_(db, permission, actor && actor.role);
  if (value === 1) return true;
  if (value === 'own' || value === 'self') return staffOwnRecord_(actor, record || {});
  return false;
}
function staffCanModule_(db, moduleId, dimension, actor) {
  var grant = staffModuleGrant_(db, moduleId, actor && actor.role);
  if (grant[dimension] !== true) return false;
  if (dimension === 'read' && BRANCH_VIEW_PERMISSION_[moduleId]) {
    return staffCanPermission_(db, BRANCH_VIEW_PERMISSION_[moduleId], actor, actor && actor.record);
  }
  return true;
}
function staffCanAccountAdmin_(db, actor) {
  if (!actor || actor.ok === false) return false;
  if (actor.serverSigned || branchCanonicalRole_(actor.role) === 'super') return true;
  return staffCanModule_(db, 'members', 'edit', actor)
    && staffCanPermission_(db, 'admin.accounts', actor, actor.record || {});
}
function staffActorFromAuth_(db, writeAuth) {
  if (!writeAuth) return { ok: false, error: '未能核對操作者身份' };
  if (writeAuth.setup) return { ok: true, role: 'leader', setup: true, record: null };
  if (writeAuth.serverSigned && !writeAuth.delegated) return { ok: true, role: 'super', serverSigned: true, record: null };
  if (writeAuth.actor && writeAuth.actor.ok) return writeAuth.actor;
  if (writeAuth.session) {
    var found = adminFindActor_(db || {}, writeAuth.session);
    if (found.ok) return found;
  }
  var delegatedRole = branchCanonicalRole_(writeAuth.role);
  return delegatedRole ? { ok: true, role: delegatedRole, delegated: true, record: null } : { ok: false, error: '未能核對操作者身份' };
}
function staffSafeIdentityRow_(row) {
  var copy = hubClone_(row || {}) || {};
  ['pw', 'password', 'hubPw', 'hubPassword', 'passwordHash', 'salt', 'pv'].forEach(function (key) { delete copy[key]; });
  return copy;
}
function staffProjectAccess_(db, actor) {
  var level = branchRoleLevel_(actor && actor.role);
  var full = staffAccessMatrix_(db);
  var out = { schema: full.schema, branchSchema: full.branchSchema, branchSchemaVersion: full.branchSchemaVersion,
    projectedFor: branchCanonicalRole_(actor && actor.role), modules: {} };
  Object.keys(full.modules).forEach(function (moduleId) {
    out.modules[moduleId] = {};
    BRANCH_ROLE_ORDER_.forEach(function (role) {
      if (branchRoleLevel_(role) <= level) out.modules[moduleId][role] = hubClone_(full.modules[moduleId][role]);
    });
  });
  return out;
}
function staffProjectPermOverrides_(db, actor) {
  var level = branchRoleLevel_(actor && actor.role), out = {};
  Object.keys(db && db.permOverrides || {}).forEach(function (permission) {
    var row = {};
    Object.keys(db.permOverrides[permission] || {}).forEach(function (role) {
      if (branchRoleLevel_(role) <= level) row[role] = db.permOverrides[permission][role];
    });
    if (Object.keys(row).length) out[permission] = row;
  });
  return out;
}
function staffSafeDb_(db, actor) {
  db = db || {};
  actor = actor && actor.ok === false ? actor : actor || {};
  if (!actor || actor.ok === false) return null;
  if (actor.setup || actor.serverSigned || branchCanonicalRole_(actor.role) === 'super') return hubClone_(db);
  var out = hubClone_(db) || {};
  var denied = [], actorLevel = branchRoleLevel_(actor.role);
  Object.keys(BRANCH_MODULE_DEFAULTS_).forEach(function (moduleId) {
    if (staffCanModule_(db, moduleId, 'read', actor)) return;
    (BRANCH_MODULE_KEYS_[moduleId] || []).forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(out, key)) { delete out[key]; denied.push(key); }
    });
  });
  if (out.settings && typeof out.settings === 'object') {
    Object.keys(out.settings).forEach(function (key) {
      if (!staffCanModule_(db, staffSettingsModule_(key), 'read', actor)) delete out.settings[key];
    });
  }
  if (staffCanModule_(db, 'members', 'read', actor)) {
    var selfMemberId = textOf(actor.member && actor.member.id);
    var selfAccountId = textOf(actor.account && actor.account.id);
    /* Identity collections expose the actor's own row plus strictly lower roles;
       peers remain confidential even though they share the same role label. */
    out.members = (db.members || []).filter(function (row) {
      return (selfMemberId && textOf(row && row.id) === selfMemberId)
        || branchRoleLevel_(row && row.identity || 'member') < actorLevel;
    }).map(staffSafeIdentityRow_);
    out.accounts = (db.accounts || []).filter(function (row) {
      return (selfAccountId && textOf(row && row.id) === selfAccountId)
        || branchRoleLevel_(row && row.role || 'member') < actorLevel;
    }).map(staffSafeIdentityRow_);
    if (Array.isArray(db.deletedAccounts)) out.deletedAccounts = db.deletedAccounts.filter(function (row) {
      return branchRoleLevel_(row && row.role || 'member') < actorLevel;
    }).map(staffSafeIdentityRow_);
    out.accessControl = staffProjectAccess_(db, actor);
    out.permOverrides = staffProjectPermOverrides_(db, actor);
  }
  if (staffCanModule_(db, 'calendar', 'read', actor) && Array.isArray(out.events)) {
    out.events = out.events.filter(function (row) { return hubVisible_(row, 'event', actor.role); });
  }
  if (staffCanModule_(db, 'quizzes', 'read', actor) && Array.isArray(out.quizzes)) {
    out.quizzes = out.quizzes.filter(function (row) { return hubVisible_(row, 'quiz', actor.role); });
  }
  if (staffCanModule_(db, 'notices', 'read', actor) && Array.isArray(out.notices)) {
    out.notices = out.notices.filter(function (row) { return hubVisible_(row, 'notice', actor.role); });
  }
  delete out.publicProfile;
  out.meta = out.meta && typeof out.meta === 'object' ? out.meta : {};
  out.meta.serverProjection = { role: branchCanonicalRole_(actor.role), deniedTopLevel: denied,
    branchSchema: BRANCH_SCHEMA_ID_, branchSchemaVersion: BRANCH_SCHEMA_VERSION_, authenticated: true };
  return out;
}
function staffSettingsModule_(key) {
  if (key === 'troopLinks' || key === 'publicLinks') return 'links';
  if (key === 'notice' || key === 'publicBaseUrl') return 'notices';
  if (key === 'publicEntry') return 'finance';
  if (key === 'publicBorrow') return 'inventory';
  if (/^(currency|fee|subsidy|openingBalance|scoutFY|agm|receipt|fiscal|budget)/.test(key)) return 'finance';
  if (/^(progress|badge)/.test(key)) return 'progress';
  return 'admin';
}
function staffWriteDenied_(message, code) {
  return { success: false, code: code || 'ACTION_SCOPE_DENIED', error: message || '你的身份不可以修改這項資料' };
}
function staffRowsById_(rows) {
  var out = {};
  (Array.isArray(rows) ? rows : []).forEach(function (row, index) {
    var id = textOf(row && (row.id || row.key));
    out[id || ('@' + index)] = row;
  });
  return out;
}
function staffValidateRows_(beforeRows, afterRows, permissionSet, db, actor) {
  var before = staffRowsById_(beforeRows), after = staffRowsById_(afterRows), ids = {};
  Object.keys(before).concat(Object.keys(after)).forEach(function (id) { ids[id] = true; });
  var denied = '';
  Object.keys(ids).some(function (id) {
    var oldRow = before[id], newRow = after[id];
    if (oldRow && newRow && protectedSame_(oldRow, newRow)) return false;
    var permission = !oldRow ? permissionSet.create : (!newRow ? permissionSet.remove : permissionSet.edit);
    var context = newRow || oldRow || {};
    if (!permission || !staffCanPermission_(db, permission, actor, context)) {
      denied = permission || 'unknown'; return true;
    }
    return false;
  });
  return denied ? staffWriteDenied_('細項權限不允許修改：' + denied, permissionSet && permissionSet.__deniedCode) : { success: true };
}
function staffValidateContentRows_(beforeRows, afterRows, kind, actor) {
  var before = staffRowsById_(beforeRows), after = staffRowsById_(afterRows), denied = false;
  Object.keys(before).some(function (id) {
    if (hubVisible_(before[id], kind, actor.role)) return false;
    if (!after[id] || !protectedSame_(before[id], after[id])) { denied = true; return true; }
    return false;
  });
  if (!denied) Object.keys(after).some(function (id) {
    if (!before[id] || !protectedSame_(before[id], after[id])) {
      if (!hubVisible_(after[id], kind, actor.role)) { denied = true; return true; }
    }
    return false;
  });
  return denied ? staffWriteDenied_('不能讀取的內容亦不能修改或刪除', 'CONTENT_SCOPE_DENIED') : { success: true };
}
function staffMergeIdentityProjection_(current, incoming, actor) {
  var actorLevel = branchRoleLevel_(actor.role);
  /* A write may be based on an earlier lower-role projection and later submitted by
     a freshly promoted actor.  Restore everything hidden from the projection that
     actually produced this payload, not merely everything hidden from today's actor. */
  var projectedRole = incoming && incoming.meta && incoming.meta.serverProjection
    ? branchCanonicalRole_(incoming.meta.serverProjection.role) : '';
  var projectedLevel = projectedRole ? Math.min(actorLevel, branchRoleLevel_(projectedRole)) : actorLevel;
  ['members', 'accounts', 'deletedAccounts'].forEach(function (key) {
    if (!Array.isArray(incoming[key]) || !Array.isArray(current[key])) return;
    var oldMap = staffRowsById_(current[key]), next = incoming[key].slice(), seen = staffRowsById_(next);
    current[key].forEach(function (row, index) {
      var id = textOf(row && (row.id || row.key)) || ('@' + index);
      var role = key === 'members' ? textOf(row && row.identity || 'member') : textOf(row && row.role || 'member');
      /* deletedAccounts 只投影嚴格較低身份；同級刪除紀錄亦屬不可見 server 資料。 */
      var hidden = branchRoleLevel_(role) >= projectedLevel;
      if (hidden && !seen[id]) next.push(hubClone_(row));
    });
    var protectedFields = key === 'members'
      ? ['hubPw', 'hubPassword', 'hubMustChangePw', 'pv', 'accountDeletedAt']
      : ['pw', 'password', 'mustChangePw', 'defaultPw', 'pv', 'memberId', 'role'];
    next.forEach(function (row, index) {
      var id = textOf(row && (row.id || row.key)) || ('@' + index), old = oldMap[id];
      if (!old || !row) return;
      protectedFields.forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(old, field)) row[field] = hubClone_(old[field]);
        else delete row[field];
      });
    });
    incoming[key] = next;
  });
}
/* events／quizzes／notices 會按 actor 內容級別裁剪。完整 DB 儲存時，瀏覽器
   冇收到的高級內容必須由 server 補回；如果 client 主動提交同 id 的改動，
   後面的 content guard 仍會明確拒絕，不能靠猜 id 覆寫。 */
function staffMergeContentProjection_(current, incoming, actor) {
  var kinds = { events: 'event', quizzes: 'quiz', notices: 'notice' };
  Object.keys(kinds).forEach(function (key) {
    if (!Array.isArray(incoming[key]) || !Array.isArray(current[key])) return;
    var seen = staffRowsById_(incoming[key]);
    current[key].forEach(function (row, index) {
      var id = textOf(row && (row.id || row.key)) || ('@' + index);
      if (!hubVisible_(row, kinds[key], actor.role) && !seen[id]) incoming[key].push(hubClone_(row));
    });
  });
}
function staffValidateAccessWrite_(current, incoming, actor) {
  if (!Object.prototype.hasOwnProperty.call(incoming, 'accessControl')) return { success: true };
  var before = staffAccessMatrix_(current), actorLevel = branchRoleLevel_(actor.role);
  var submittedRaw = hubClone_(incoming.accessControl || {}) || {};
  submittedRaw.modules = submittedRaw.modules && typeof submittedRaw.modules === 'object' ? submittedRaw.modules : {};
  /* 投影會完全省略較高身份；任何省略的 role／dimension 都代表「保持 server 值」，
     唔可以跌返出廠預設。同時保留 client 明確提交的 protected 值供下面驗證。 */
  Object.keys(before.modules).forEach(function (moduleId) {
    submittedRaw.modules[moduleId] = submittedRaw.modules[moduleId] && typeof submittedRaw.modules[moduleId] === 'object'
      ? submittedRaw.modules[moduleId] : {};
    BRANCH_ROLE_ORDER_.forEach(function (role) {
      var saved = submittedRaw.modules[moduleId][role];
      if (!saved || typeof saved !== 'object') {
        submittedRaw.modules[moduleId][role] = hubClone_(before.modules[moduleId][role]);
        return;
      }
      ['show', 'read', 'edit'].forEach(function (dimension) {
        if (saved[dimension] === undefined) saved[dimension] = before.modules[moduleId][role][dimension];
      });
    });
  });
  var submitted = staffAccessMatrix_({ accessControl: submittedRaw });
  var expectedRaw = hubClone_(submittedRaw);
  Object.keys(before.modules).forEach(function (moduleId) {
    BRANCH_ROLE_ORDER_.forEach(function (role) {
      if (branchRoleLevel_(role) >= actorLevel) {
        expectedRaw.modules[moduleId][role] = hubClone_(before.modules[moduleId][role]);
      }
    });
  });
  /* 正規化 expectedRaw 會把新開給低身份的 true 合法向上繼承；除此之外，
     actor 自己及更高身份不可被直接改動。 */
  var expected = staffAccessMatrix_({ accessControl: expectedRaw });
  var illegal = false;
  Object.keys(before.modules).some(function (moduleId) {
    return BRANCH_ROLE_ORDER_.some(function (role) {
      if (branchRoleLevel_(role) < actorLevel) return false;
      if (!protectedSame_(submitted.modules[moduleId][role], expected.modules[moduleId][role])) { illegal = true; return true; }
      return false;
    });
  });
  if (illegal) return staffWriteDenied_('只可以更改比自己低級的身份權限');
  incoming.accessControl = expected;
  return { success: true };
}
function staffValidatePermWrite_(current, incoming, actor) {
  if (!Object.prototype.hasOwnProperty.call(incoming, 'permOverrides')) return { success: true };
  var actorLevel = branchRoleLevel_(actor.role), before = current.permOverrides || {}, next = incoming.permOverrides || {};
  var permissions = {}, merged = {}, illegal = false;
  Object.keys(before).concat(Object.keys(next)).forEach(function (permission) { permissions[permission] = true; });
  Object.keys(permissions).some(function (permission) {
    var oldRow = before[permission] || {}, newRow = next[permission] || {}, outRow = {};
    var stopped = BRANCH_ROLE_ORDER_.some(function (role) {
      var level = branchRoleLevel_(role);
      var oldHas = Object.prototype.hasOwnProperty.call(oldRow, role);
      var newHas = Object.prototype.hasOwnProperty.call(newRow, role);
      if (level < actorLevel) {
        if (newHas && [0, 1, 'own', 'self'].indexOf(newRow[role]) < 0) { illegal = true; return true; }
        if (newHas) outRow[role] = newRow[role];
        return false;
      }
      /* 高身份欄在 actor 投影中正常會缺席：缺席就補回 server 值；若 client
         主動夾帶，必須與 server 完全相同，否則係 forged write。 */
      if (newHas && (!oldHas || oldRow[role] !== newRow[role])) { illegal = true; return true; }
      if (oldHas) outRow[role] = oldRow[role];
      return false;
    });
    if (Object.keys(outRow).length) merged[permission] = outRow;
    return stopped;
  });
  if (illegal) return staffWriteDenied_('只可以更改比自己低級的身份細項權限');
  incoming.permOverrides = merged;
  return { success: true };
}
function prepareAuthorizedAdminWrite_(unit, incoming, writeAuth, partial) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return staffWriteDenied_('寫入內容格式不正確');
  var loaded = loadDb(textOf(unit));
  if (!loaded.success) return staffWriteDenied_('未能讀取目前資料，已拒絕寫入');
  if (!loaded.db && writeAuth && (writeAuth.setup || (writeAuth.serverSigned && !writeAuth.delegated))) {
    return { success: true, db: incoming };
  }
  var current = loaded.db || {};
  if (writeAuth && writeAuth.delegated) {
    current.members = unifiedCanonicalMembers_(current.members || [], true);
    current.accounts = unifiedAccountProjection_(current.members);
  }
  var actor = staffActorFromAuth_(current, writeAuth);
  if (!actor.ok) return staffWriteDenied_(actor.error || '未能核對操作者身份');
  if (actor.setup || actor.serverSigned || branchCanonicalRole_(actor.role) === 'super') {
    if (incoming.meta && incoming.meta.serverProjection) delete incoming.meta.serverProjection;
    return { success: true, db: incoming, actor: actor };
  }
  var next = hubClone_(incoming) || {};
  /* Read the projection provenance before stripping server metadata.  A payload may
     have been produced while this same account had a lower role; rows hidden from
     that earlier projection must remain server-side after a later promotion. */
  staffMergeIdentityProjection_(current, next, actor);
  staffMergeContentProjection_(current, next, actor);
  if (next.meta && next.meta.serverProjection) delete next.meta.serverProjection;
  var accessGuard = staffValidateAccessWrite_(current, next, actor); if (!accessGuard.success) return accessGuard;
  var permGuard = staffValidatePermWrite_(current, next, actor); if (!permGuard.success) return permGuard;

  /* 資料庫 envelope 不是一般模組資料：支部編號／schema／kind 由 server 現行
     紀錄固定，client 不可藉整庫寫入改掉。meta 只接受 updatedAt，其他 server
     metadata 一律保留。 */
  ['schema', 'kind', 'unitCode'].forEach(function (fixedKey) {
    var suppliedFixed = Object.prototype.hasOwnProperty.call(next, fixedKey);
    var currentFixed = Object.prototype.hasOwnProperty.call(current, fixedKey);
    var expectedFixed = currentFixed ? current[fixedKey]
      : (fixedKey === 'schema' ? 2 : (fixedKey === 'kind' ? 'real' : textOf(unit)));
    if (suppliedFixed && !protectedSame_(expectedFixed, next[fixedKey])) next.__forgedEnvelope = fixedKey;
    if (!partial || suppliedFixed) next[fixedKey] = hubClone_(expectedFixed);
  });
  if (next.__forgedEnvelope) return staffWriteDenied_('不可更改資料庫識別欄位：' + next.__forgedEnvelope, 'PROTECTED_AUTH_FIELD');
  if (!partial || Object.prototype.hasOwnProperty.call(next, 'meta')) {
    var clientUpdatedAt = next.meta && next.meta.updatedAt;
    next.meta = hubClone_(current.meta || {}) || {};
    if (clientUpdatedAt) next.meta.updatedAt = textOf(clientUpdatedAt);
  }

  var keys = Object.keys(next);
  for (var ki = 0; ki < keys.length; ki++) {
    var key = keys[ki];
    if (['schema', 'kind', 'unitCode', 'meta'].indexOf(key) >= 0) continue;
    if (key === 'settings') {
      var oldSettings = current.settings || {}, newSettings = next.settings || {};
      Object.keys(oldSettings).forEach(function (name) {
        if (!Object.prototype.hasOwnProperty.call(newSettings, name)
            && !staffCanModule_(current, staffSettingsModule_(name), 'read', actor)) {
          newSettings[name] = hubClone_(oldSettings[name]);
        }
      });
      next.settings = newSettings;
      var settingKeys = {};
      Object.keys(oldSettings).concat(Object.keys(newSettings)).forEach(function (name) { settingKeys[name] = true; });
      var settingDenied = false;
      Object.keys(settingKeys).some(function (name) {
        if (protectedSame_(oldSettings[name], newSettings[name])) return false;
        var moduleId = staffSettingsModule_(name);
        if (!staffCanModule_(current, moduleId, 'edit', actor)) { settingDenied = true; return true; }
        return false;
      });
      if (settingDenied) return staffWriteDenied_('側欄編輯權限不允許修改這項設定');
      continue;
    }
    /* 未登記 top-level 欄位 fail closed 落「系統」模組，唔可以因為新／拼錯
       key 未入 mapping 就變成任何執委都可寫。 */
    var moduleId = BRANCH_KEY_MODULE_[key] || 'admin';
    if (!staffCanModule_(current, moduleId, 'edit', actor)
        && !protectedSame_(current[key], next[key])) return staffWriteDenied_('沒有「' + moduleId + '」編輯權限');
  }
  /* Full projected writes omit denied keys; preserve them server-side. Partial writes never delete an omitted table. */
  if (!partial) Object.keys(current).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) next[key] = hubClone_(current[key]);
  });

  var rowRules = {
    meetings:{create:'meeting.create',edit:'meeting.edit',remove:'meeting.delete'},
    transactions:{create:'finance.create',edit:'finance.edit',remove:'finance.delete'},
    claims:{create:'claim.submit',edit:'claim.review',remove:'finance.delete'},
    fees:{create:'fee.edit',edit:'fee.mark',remove:'fee.edit'}, budgets:{create:'finance.edit',edit:'finance.edit',remove:'finance.edit'},
    members:{create:'member.create',edit:'member.edit',remove:'member.delete'},
    accounts:{create:'admin.accounts',edit:'admin.accounts',remove:'admin.accounts',__deniedCode:'PROTECTED_AUTH_FIELD'},
    invItems:{create:'inv.manage',edit:'inv.manage',remove:'inv.manage'},
    invLoans:{create:'inv.borrow',edit:'inv.approve',remove:'inv.manage'}, invAudits:{create:'inv.audit',edit:'inv.audit',remove:'inv.audit'},
    events:{create:'calendar.edit',edit:'calendar.edit',remove:'calendar.edit'}, quizzes:{create:'quiz.edit',edit:'quiz.edit',remove:'quiz.edit'},
    notices:{create:'notice.create',edit:'notice.edit',remove:'notice.edit'}
  };
  var ruleKeys = Object.keys(rowRules);
  for (var ri = 0; ri < ruleKeys.length; ri++) {
    var rowKey = ruleKeys[ri];
    if (!Object.prototype.hasOwnProperty.call(next, rowKey) || protectedSame_(current[rowKey] || [], next[rowKey] || [])) continue;
    var rowGuard = staffValidateRows_(current[rowKey] || [], next[rowKey] || [], rowRules[rowKey], current, actor);
    if (!rowGuard.success) return rowGuard;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'members') && !protectedSame_(current.members || [], next.members || [])) {
    var oldMemberMap = staffRowsById_(current.members || []), newMemberMap = staffRowsById_(next.members || []), identityDenied = false;
    Object.keys(newMemberMap).some(function (id) {
      if (!oldMemberMap[id]) return false;
      if (protectedMemberRole_(oldMemberMap[id]) !== protectedMemberRole_(newMemberMap[id])
          && !staffCanPermission_(current, 'member.identity', actor, newMemberMap[id])) { identityDenied = true; return true; }
      return false;
    });
    if (identityDenied) return staffWriteDenied_('沒有更改身份的細項權限', 'PROTECTED_AUTH_FIELD');
  }
  if (Object.prototype.hasOwnProperty.call(next, 'notices') && !protectedSame_(current.notices || [], next.notices || [])) {
    var oldNoticeMap = staffRowsById_(current.notices || []), newNoticeMap = staffRowsById_(next.notices || []), publishDenied = false;
    Object.keys(newNoticeMap).some(function (id) {
      var beforeNotice = oldNoticeMap[id], afterNotice = newNoticeMap[id];
      if (afterNotice && afterNotice.status === 'published' && (!beforeNotice || beforeNotice.status !== 'published')
          && !staffCanPermission_(current, 'notice.publish', actor, afterNotice)) { publishDenied = true; return true; }
      return false;
    });
    if (publishDenied) return staffWriteDenied_('沒有發布通告的細項權限');
  }
  var contentKinds = { events: 'event', quizzes: 'quiz', notices: 'notice' };
  var contentKeys = Object.keys(contentKinds);
  for (var ci = 0; ci < contentKeys.length; ci++) {
    var contentKey = contentKeys[ci];
    if (!Object.prototype.hasOwnProperty.call(next, contentKey)) continue;
    var contentGuard = staffValidateContentRows_(current[contentKey] || [], next[contentKey] || [], contentKinds[contentKey], actor);
    if (!contentGuard.success) return contentGuard;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'constitution') && !protectedSame_(current.constitution, next.constitution)) {
    if (!staffCanPermission_(current, 'constitution.edit', actor, next.constitution || {})) return staffWriteDenied_('沒有團章編輯權限');
    if (next.constitution && next.constitution.status === 'published' && (!current.constitution || current.constitution.status !== 'published')
        && !staffCanPermission_(current, 'constitution.publish', actor, next.constitution)) return staffWriteDenied_('沒有團章發布權限');
  }
  if (Object.prototype.hasOwnProperty.call(next, 'tableSchema') && !protectedSame_(current.tableSchema, next.tableSchema)
      && !staffCanPermission_(current, 'table.design', actor, next.tableSchema || {})) return staffWriteDenied_('沒有表格設計權限');
  if (Object.prototype.hasOwnProperty.call(next, 'tableSources') && !protectedSame_(current.tableSources, next.tableSources)
      && !staffCanPermission_(current, 'table.sync', actor, {})) return staffWriteDenied_('沒有資料同步權限');
  return { success: true, db: next, actor: actor };
}
function staffLoadDbPart_(unit, partIdx, actor) {
  var loaded = loadDb(unit);
  if (!loaded.success || !loaded.found || !loaded.db) return { success: loaded.success, found: false, error: loaded.error || '' };
  var projected = staffSafeDb_(loaded.db, actor);
  var text = JSON.stringify(projected || {}), size = 1000000, parts = Math.max(1, Math.ceil(text.length / size));
  var idx = Math.max(0, parseInt(partIdx, 10) || 0);
  if (idx >= parts) return { success: false, found: true, error: '分段編號超出範圍' };
  return { success: true, found: true, part: text.substring(idx * size, (idx + 1) * size), partIdx: idx,
    parts: parts, bytes: text.length, at: loaded.at, version: loaded.version };
}
function staffLoadTablesPart_(unit, idx, actor) {
  var all = loadTables(unit), i = Math.max(0, parseInt(idx, 10) || 0);
  if (!all.success || (all.broken || []).length) return { success: false, found: all.found, broken: all.broken || [], error: all.error || '資料表有損壞' };
  if (!all.found || !all.db) return { success: true, found: false, idx: i, count: 0, name: '', at: all.at, version: all.version };
  var projected = staffSafeDb_(all.db, actor) || {}, names = Object.keys(projected).sort();
  if (i >= names.length) return { success: false, found: true, idx: i, count: names.length, name: '', error: '表編號超出範圍', at: all.at, version: all.version };
  var name = names[i];
  return { success: true, found: true, idx: i, count: names.length, name: name, value: projected[name],
    broken: [], at: all.at, version: all.version };
}

/* 整庫／逐表同步係資料傳輸通道，唔係授權通道。尤其 members[].identity 同
   account role/memberId/password 會直接改下一次 session 的權限，必須用 server
   目前版本逐欄比對；client UI 有冇收埋欄位並不構成保護。 */
function protectedWriteDenied_(message) {
  return { success: false, code: 'PROTECTED_AUTH_FIELD', error: message };
}
function protectedSame_(a, b) {
  try { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
  catch (e) { return false; }
}
function protectedRowsById_(rows) {
  var out = {}, bad = '';
  if (!Array.isArray(rows)) return { ok: false, error: '受保護資料表格式不正確', rows: out };
  for (var i = 0; i < rows.length; i++) {
    var id = textOf(rows[i] && rows[i].id);
    if (!id || Object.prototype.hasOwnProperty.call(out, id)) { bad = '受保護資料列缺少唯一 id'; break; }
    out[id] = rows[i];
  }
  return { ok: !bad, error: bad, rows: out };
}
function protectedMemberRole_(row) {
  return textOf(row && row.identity || 'member').toLowerCase() || 'member';
}
function validateDelegatedIdentityMap_(members, identityMap) {
  if (!identityMap || typeof identityMap !== 'object') {
    return protectedWriteDenied_('統一身份對照缺失，已拒絕受保護寫入');
  }
  if (!Array.isArray(members)) return protectedWriteDenied_('受保護資料表格式不正確');
  for (var i = 0; i < members.length; i++) {
    var member = members[i] || {};
    var key = textOf(member.ymis).trim().toLowerCase();
    var expected = key && Object.prototype.hasOwnProperty.call(identityMap, key)
      ? textOf(identityMap[key]).toLowerCase() : 'member';
    if (protectedMemberRole_(member) !== (expected || 'member')) {
      return protectedWriteDenied_('成員身份必須跟已核實的支部身份對照一致');
    }
    if (member.hubPw || member.hubPassword) {
      return protectedWriteDenied_('統一模式不可透過行政資料寫入本地密碼');
    }
  }
  return { success: true };
}
function validateProtectedAdminWrite_(unit, incoming, writeAuth) {
  if (!incoming || typeof incoming !== 'object') return protectedWriteDenied_('寫入內容格式不正確');
  /* 已驗 server HMAC 代表平台 super；setup session 係首次建庫憑證。
     兩者都唔係由 browser 自報（網絡入口會先刪除 marker）。 */
  if (writeAuth && ((writeAuth.serverSigned && !writeAuth.delegated) || writeAuth.setup)) return { success: true };
  var touchesMembers = Object.prototype.hasOwnProperty.call(incoming, 'members');
  var touchesAccounts = Object.prototype.hasOwnProperty.call(incoming, 'accounts');
  var touchesDeletedAccounts = Object.prototype.hasOwnProperty.call(incoming, 'deletedAccounts');
  if (!touchesMembers && !touchesAccounts && !touchesDeletedAccounts) return { success: true };
  if (writeAuth && writeAuth.delegated && touchesMembers) {
    var delegatedGuard = validateDelegatedIdentityMap_(incoming.members, writeAuth.identityMap);
    if (delegatedGuard.success !== true) return delegatedGuard;
  }

  var current = loadDb(textOf(unit));
  /* Unified 首次寫入時 compatibility DB 尚未存在；delegated actor 已由 pinned
     baseline／隔離 auth fixture 核實，identity map 亦已在上面逐項核對。一旦有現行版本，
     下面仍以 server 狀態逐欄比較。 */
  if ((!current.success || !current.db) && writeAuth && writeAuth.delegated) return { success: true };
  if (!current.success || !current.db) return protectedWriteDenied_('未能讀取目前身份資料，已拒絕寫入');
  var actor = adminFindActor_(current.db, writeAuth && writeAuth.session);
  if (!actor.ok) return protectedWriteDenied_(actor.error || '未能核對操作者身份');
  var actorRank = hubRoleRank_(actor.role);
  var actorMemberId = textOf(actor.member && actor.member.id);

  if (touchesMembers) {
    var oldMembers = protectedRowsById_(current.db.members || []);
    var nextMembers = protectedRowsById_(incoming.members);
    if (!oldMembers.ok || !nextMembers.ok) return protectedWriteDenied_(oldMembers.error || nextMembers.error);
    var oldMap = oldMembers.rows, nextMap = nextMembers.rows;
    /* Unified router 已由 pinned Users 重建整張 canonical identity 投影；呢類
       server-delegated refresh 唔係 browser 角色編輯，後面的欄位／identity map
       檢查仍會逐項 fail closed。 */
    var delegatedIdentity = !!(writeAuth && writeAuth.delegated);
    var oldChiefs = [], nextChiefs = [], identityChanges = [];
    Object.keys(oldMap).forEach(function (id) { if (protectedMemberRole_(oldMap[id]) === 'chief') oldChiefs.push(id); });
    Object.keys(nextMap).forEach(function (id) { if (protectedMemberRole_(nextMap[id]) === 'chief') nextChiefs.push(id); });
    oldChiefs.sort(); nextChiefs.sort();
    var chiefSetChanged = oldChiefs.join('|') !== nextChiefs.join('|');
    var claimingChief = oldChiefs.length === 0 && actorRank === 4 && !!actorMemberId
      && nextChiefs.length === 1 && nextChiefs[0] === actorMemberId;
    var transferringChief = oldChiefs.length === 1 && actorRank >= 5 && !!actorMemberId
      && oldChiefs[0] === actorMemberId && nextChiefs.length === 1 && nextChiefs[0] !== actorMemberId
      && nextMap[actorMemberId] && protectedMemberRole_(nextMap[actorMemberId]) === 'leader';
    if (!delegatedIdentity && chiefSetChanged && !claimingChief && !transferringChief) {
      return protectedWriteDenied_('團長身份只可由未有團長時本人認領，或由現任團長交棒');
    }

    var memberAuthFields = ['hubPw', 'hubPassword', 'hubMustChangePw', 'pv', 'accountDeletedAt'];
    var ids = Object.keys(oldMap);
    for (var mi = 0; mi < ids.length; mi++) {
      var mid = ids[mi], before = oldMap[mid], after = nextMap[mid];
      if (!after) {
        if (actorRank < 4 || mid === actorMemberId || hubRoleRank_(protectedMemberRole_(before)) >= actorRank) {
          return protectedWriteDenied_('不能透過整庫同步刪除自己、同級或更高權限成員');
        }
        continue;
      }
      var beforeRole = protectedMemberRole_(before), afterRole = protectedMemberRole_(after);
      if (!delegatedIdentity && beforeRole !== afterRole) identityChanges.push({ id: mid, before: beforeRole, after: afterRole });
      for (var mf = 0; mf < memberAuthFields.length; mf++) {
        var memberField = memberAuthFields[mf];
        /* 無團長時，已登入領袖認領本人可同一次設定本人密碼；其他密碼／撤銷欄
           一律只可走 authChangePassword／authResetPassword／authDeleteAccount。 */
        var claimOwnPassword = claimingChief && mid === actorMemberId
          && (memberField === 'hubPw' || memberField === 'hubPassword' || memberField === 'hubMustChangePw');
        if (!claimOwnPassword && !protectedSame_(before[memberField], after[memberField])) {
          return protectedWriteDenied_('登入密碼或帳戶撤銷欄位只可經專用帳戶操作修改');
        }
      }
    }
    var nextIds = Object.keys(nextMap);
    for (var ni = 0; ni < nextIds.length; ni++) {
      var newId = nextIds[ni];
      if (oldMap[newId]) continue;
      var newRole = protectedMemberRole_(nextMap[newId]);
      if (!delegatedIdentity && newRole !== 'member') identityChanges.push({ id: newId, before: '', after: newRole });
      if (nextMap[newId].hubPw || nextMap[newId].hubPassword || nextMap[newId].accountDeletedAt) {
        var claimNewPassword = claimingChief && newId === actorMemberId;
        if (!claimNewPassword) return protectedWriteDenied_('新增成員不可夾帶密碼或帳戶撤銷欄位');
      }
    }
    for (var ic = 0; ic < identityChanges.length; ic++) {
      var change = identityChanges[ic];
      if (BRANCH_VISIBLE_ROLES_.indexOf(branchCanonicalRole_(change.after)) < 0) {
        return protectedWriteDenied_('身份值不正確');
      }
      if (actorRank < 4) return protectedWriteDenied_('執委不可更改成員身份');
      if (actorRank === 4) {
        var allowedClaim = claimingChief && change.id === actorMemberId && change.after === 'chief';
        if (!allowedClaim && (change.id === actorMemberId || change.before === 'chief' || change.after === 'chief')) {
          return protectedWriteDenied_('領袖不可更改自己或團長身份');
        }
      }
      if (actorRank >= 5 && change.id === actorMemberId && change.after !== 'chief' && !transferringChief) {
        return protectedWriteDenied_('團長不可直接降低自己身份；請先交棒');
      }
    }
  }

  /* Unified 的 accounts 只係中央 Users 無密碼投影，不係 compatibility 登入來源；
     delegated router 已重建整張投影，所以本地 account 欄位規則只套普通 Portal。 */
  if (touchesAccounts && !(writeAuth && writeAuth.delegated)) {
    var oldAccounts = protectedRowsById_(current.db.accounts || []);
    var nextAccounts = protectedRowsById_(incoming.accounts);
    if (!oldAccounts.ok || !nextAccounts.ok) return protectedWriteDenied_(oldAccounts.error || nextAccounts.error);
    var oldAccountIds = Object.keys(oldAccounts.rows), nextAccountIds = Object.keys(nextAccounts.rows);
    if (oldAccountIds.length !== nextAccountIds.length) {
      return protectedWriteDenied_('新增或刪除帳戶只可經專用帳戶操作');
    }
    var accountAuthFields = ['role', 'memberId', 'pw', 'password', 'mustChangePw', 'defaultPw', 'pv'];
    for (var ai = 0; ai < oldAccountIds.length; ai++) {
      var aid = oldAccountIds[ai], oldAccount = oldAccounts.rows[aid], nextAccount = nextAccounts.rows[aid];
      if (!nextAccount) return protectedWriteDenied_('新增或刪除帳戶只可經專用帳戶操作');
      for (var af = 0; af < accountAuthFields.length; af++) {
        var accountField = accountAuthFields[af];
        if (!protectedSame_(oldAccount[accountField], nextAccount[accountField])) {
          return protectedWriteDenied_('帳戶角色、綁定或密碼只可經專用帳戶操作');
        }
      }
    }
  }
  if (touchesDeletedAccounts && !(writeAuth && writeAuth.delegated)
      && !protectedSame_(current.db.deletedAccounts || [], incoming.deletedAccounts || [])) {
    return protectedWriteDenied_('帳戶刪除紀錄只可經專用帳戶操作');
  }
  return { success: true };
}
function hubSafeDb_(db, actor) {
  db = db || {};
  var member = actor.member;
  var role = actor.role;
  var memberId = textOf(member.id);
  var ymis = textOf(member.ymis);
  var unit = db.unit || {};
  var profile = db.profile || unit;
  var events = (Array.isArray(db.events) ? db.events : []).filter(function (event) {
    return event && event.status !== 'cancelled' && hubVisible_(event, 'event', role);
  }).map(function (event) { return hubSafeEvent_(event, memberId); });
  var quizzes = (Array.isArray(db.quizzes) ? db.quizzes : []).filter(function (quiz) {
    return quiz && quiz.status !== 'closed' && hubVisible_(quiz, 'quiz', role);
  }).map(function (quiz) { return hubSafeQuiz_(quiz, memberId); });
  var notices = (Array.isArray(db.notices) ? db.notices : []).filter(function (notice) {
    return notice && notice.status === 'published' && hubVisible_(notice, 'notice', role);
  }).map(function (notice) { return hubSafeNotice_(notice, memberId, ymis); });
  var absences = (Array.isArray(db.absences) ? db.absences : []).filter(function (absence) {
    return absence && ((memberId && textOf(absence.memberId) === memberId) || (ymis && textOf(absence.ymis) === ymis));
  }).map(hubSafeAbsence_);
  return {
    schema: db.schema || 2, kind: 'real', unitCode: textOf(db.unitCode),
    unit: { code: textOf(unit.code || db.unitCode), name: textOf(unit.name), nameEn: textOf(unit.nameEn), short: textOf(unit.short), theme: hubClone_(unit.theme || {}) },
    profile: { code: textOf(profile.code || db.unitCode), name: textOf(profile.name || unit.name), nameEn: textOf(profile.nameEn || unit.nameEn), short: textOf(profile.short || unit.short), theme: hubClone_(profile.theme || unit.theme || {}) },
    settings: { troopLinks: hubClone_(db.settings && db.settings.troopLinks || {}) },
    constitution: db.constitution && db.constitution.status === 'published' ? hubClone_(db.constitution) : null,
    members: [hubSafeMember_(member, role)], accounts: [], events: events, quizzes: quizzes,
    notices: notices, absences: absences,
    meta: { updatedAt: textOf(db.meta && db.meta.updatedAt), hubView: true }
  };
}
function hubAnswerEmpty_(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}
function hubApplyMutation_(db, actor, body) {
  var action = textOf(body && body.action);
  var member = actor.member;
  var memberId = textOf(member.id);
  var role = actor.role;
  if (action === 'hubRsvp') {
    var event = (db.events || []).filter(function (row) { return row && textOf(row.id) === textOf(body.eventId); })[0];
    if (!event || event.status === 'cancelled' || !hubVisible_(event, 'event', role)) return { ok: false, error: '搵唔到可回覆嘅活動' };
    var end = textOf(event.dateEnd || event.date).substring(0, 10);
    if (end && end < new Date().toISOString().substring(0, 10)) return { ok: false, error: '活動已經完結' };
    var status = textOf(body.status).toLowerCase();
    if (['present', 'absent', 'late', 'early'].indexOf(status) < 0) return { ok: false, error: '出席狀態唔正確' };
    var reason = textOf(body.reason).trim().substring(0, 500);
    if (status === 'absent' && !reason) return { ok: false, error: '不出席要填原因' };
    var time = textOf(body.time).trim();
    if ((status === 'late' || status === 'early') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, error: '時間格式唔正確' };
    event.rsvp = event.rsvp && typeof event.rsvp === 'object' ? event.rsvp : {};
    event.rsvp[memberId] = { status: status, at: new Date().toISOString().substring(0, 10),
      name: textOf(member.name), time: (status === 'late' || status === 'early') ? time : '', reason: reason };
    return { ok: true };
  }
  if (action === 'hubQuiz') {
    var quiz = (db.quizzes || []).filter(function (row) { return row && textOf(row.id) === textOf(body.quizId); })[0];
    if (!quiz || quiz.status === 'closed' || !hubVisible_(quiz, 'quiz', role)) return { ok: false, error: '搵唔到可提交嘅試卷' };
    var supplied = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
    if (JSON.stringify(supplied).length > 50000) return { ok: false, error: '答卷太大' };
    var answers = {};
    var questions = Array.isArray(quiz.questions) ? quiz.questions : [];
    for (var qi = 0; qi < questions.length; qi++) {
      var question = questions[qi] || {};
      var qid = textOf(question.id);
      if (!qid) continue;
      var value = supplied[qid];
      if (question.type === 'multi') {
        var options = Array.isArray(question.options) ? question.options.map(textOf) : [];
        value = (Array.isArray(value) ? value : []).map(textOf).filter(function (answer) { return options.indexOf(answer) >= 0; }).slice(0, 50);
      } else if (question.type === 'single') {
        var choices = Array.isArray(question.options) ? question.options.map(textOf) : [];
        value = textOf(value); if (choices.indexOf(value) < 0) value = '';
      } else {
        value = textOf(value).substring(0, question.type === 'para' ? 5000 : 1000);
      }
      if (question.required && hubAnswerEmpty_(value)) return { ok: false, error: '請填：' + textOf(question.prompt) };
      answers[qid] = value;
    }
    quiz.responses = quiz.responses && typeof quiz.responses === 'object' ? quiz.responses : {};
    quiz.responses[memberId] = { name: textOf(member.name), at: new Date().toISOString().substring(0, 10), answers: answers };
    return { ok: true };
  }
  if (action === 'hubNoticeSignup') {
    var notice = (db.notices || []).filter(function (row) { return row && textOf(row.id) === textOf(body.noticeId); })[0];
    if (!notice || notice.status !== 'published' || !notice.needSignup || !hubVisible_(notice, 'notice', role)) {
      return { ok: false, error: '搵唔到可回覆嘅通告' };
    }
    var today = new Date().toISOString().substring(0, 10);
    if (textOf(notice.deadline).substring(0, 10) && textOf(notice.deadline).substring(0, 10) < today) {
      return { ok: false, error: '通告報名已截止' };
    }
    var supplied = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
    var answers = {}, invalid = '';
    (Array.isArray(notice.fields) ? notice.fields : []).some(function (field) {
      var key = textOf(field && field.key).substring(0, 80); if (!key) return false;
      var value = supplied[key];
      if (Array.isArray(value)) value = value.slice(0, 30).map(function (item) { return textOf(item).substring(0, 500); });
      else value = textOf(value).substring(0, 2000);
      if (field.required && hubAnswerEmpty_(value)) { invalid = textOf(field.label || key); return true; }
      answers[key] = value; return false;
    });
    if (invalid) return { ok: false, error: '請填：' + invalid };
    notice.signups = Array.isArray(notice.signups) ? notice.signups : [];
    var existing = -1;
    for (var si = 0; si < notice.signups.length; si++) {
      var signup = notice.signups[si];
      if (signup && ((memberId && textOf(signup.memberId) === memberId)
          || (textOf(member.ymis) && textOf(signup.ymis) === textOf(member.ymis)))) { existing = si; break; }
    }
    var signupId = existing >= 0 ? textOf(notice.signups[existing].id)
      : 'hsg_' + Utilities.getUuid().replace(/-/g, '').substring(0, 16);
    var row = { id: signupId, memberId: memberId, ymis: textOf(member.ymis), name: textOf(member.name),
      at: new Date().toISOString(), answers: answers, source: 'authenticated-hub' };
    if (existing >= 0) notice.signups[existing] = row; else notice.signups.push(row);
    return { ok: true, id: signupId };
  }
  if (action === 'hubAbsence') {
    db.absences = Array.isArray(db.absences) ? db.absences : [];
    if (body.op === 'withdraw') {
      var idx = -1;
      for (var ai = 0; ai < db.absences.length; ai++) if (textOf(db.absences[ai] && db.absences[ai].id) === textOf(body.id)) { idx = ai; break; }
      var existing = idx >= 0 ? db.absences[idx] : null;
      /* 第一次撤回可能已成功、但 response 途中斷線；同一 id 重試要係冪等成功。 */
      if (!existing) return { ok: true, idempotent: true };
      if (textOf(existing.memberId) !== memberId && textOf(existing.ymis) !== textOf(member.ymis)) return { ok: false, error: '呢張唔係你嘅請假單' };
      if (existing.status !== 'pending') return { ok: false, error: '已經處理咗，唔可以撤回' };
      db.absences.splice(idx, 1);
      return { ok: true };
    }
    if (body.op !== 'create') return { ok: false, error: '請假操作唔正確' };
    var date = textOf(body.date).trim();
    var reasonA = textOf(body.reason).trim();
    var slot = textOf(body.slot || 'full');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < new Date().toISOString().substring(0, 10)) return { ok: false, error: '請揀今日或之後嘅日子' };
    if (!reasonA || reasonA.length > 2000) return { ok: false, error: '請寫 1 至 2000 字原因' };
    if (['full', 'am', 'pm', 'evening'].indexOf(slot) < 0) slot = 'full';
    var id = textOf(body.id);
    var planA = textOf(body.plan).trim().substring(0, 500);
    if (!/^ab_[A-Za-z0-9_-]{1,80}$/.test(id)) id = 'ab_' + Utilities.getUuid().replace(/-/g, '');
    var duplicate = null;
    db.absences.some(function (row) { if (textOf(row && row.id) === id) { duplicate = row; return true; } return false; });
    if (duplicate) {
      var sameOwner = textOf(duplicate.memberId) === memberId || textOf(duplicate.ymis) === textOf(member.ymis);
      var sameBody = textOf(duplicate.date) === date && textOf(duplicate.slot) === slot &&
        textOf(duplicate.reason) === reasonA && textOf(duplicate.plan) === planA;
      return sameOwner && sameBody ? { ok: true, id: id, idempotent: true } : { ok: false, error: '請假單編號重複' };
    }
    db.absences.push({ id: id, at: new Date().toISOString(), unit: textOf(db.unitCode),
      memberId: memberId, ymis: textOf(member.ymis), date: date, slot: slot,
      reason: reasonA, plan: planA, status: 'pending',
      reviewedBy: '', reviewedAt: '', reviewNote: '' });
    return { ok: true, id: id };
  }
  return { ok: false, error: '未知團員入口操作' };
}

/* ============================================================
   HTTP 請求處理
   ============================================================ */

/* 呢個後端識做嘅 action（用嚟回提示，等用家睇到「未知 action」嗰陣知道有乜）。
   ★ 呢個陣列一定要同下面 doPost 入面真正處理緊嘅 action 一模一樣 ——
     scripts/lint.mjs 會逐個比對，漏咗／多咗都會紅燈。
     （2026-09-20 之前呢句係手寫死嘅字串，一直漏咗 constitution，
       加咗 loadDbPart 之後更加唔可以再靠人手記得改。） */
var SUPPORTED_ACTIONS = ['ping', 'test', 'status', 'sync',
  'authLogin', 'authWhoAmI', 'authChangePassword', 'authResetPassword', 'authDeleteAccount', 'authRestoreAccount', 'authCreateAccount', 'authForgotPassword', 'authResetByToken',
  /* 團員入口：session 限定本人；只回安全投影／只改本人入站資料。 */
  'hubLoad', 'hubRsvp', 'hubQuiz', 'hubAbsence', 'hubNoticeSignup',
  'saveDb', 'loadDb', 'loadDbPart', 'dbInfo', 'saveDbPart', 'saveDbCommit', 'verifySetupKey',
  'uploadPhotos',
  'load', 'loadMine',
  'save', 'saveOtherBadge', 'reviewRequest', 'reviewLogRequest', 'addRequest', 'myRequests',
  /* ★ v2.7.2：一鍵修復（清垃圾／舊版本段）＋ 強制覆蓋（人手搶救） */
  'repairDb', 'saveDbForce',
  /* ★ v2.8.0：簡單寫入（逐表寫／逐表讀）—— 見下面 saveTables／loadTables／loadTablesPart */
  'saveTables', 'loadTables', 'loadTablesPart', 'syncCheck',
  /* Legacy 非 Unified 簽名兼容；Progress client／API 不路由，亦非未來 reader 契約。 */
  'getLinkState', 'setLocalLogin'];

/**
 * BUILD §1／§2：敏感 action 必須由 server-side API_KEY 明確授權。
 * 未初始化 API_KEY 時 fail closed；公開讀取／匿名申請另行處理。
 */
function requireAuth(expectedKey, suppliedKey) {
  if (!expectedKey) return { ok: false, success: false, error: '未授權：後端尚未設定 API Key', code: 'AUTH_NOT_CONFIGURED' };
  if (!suppliedKey || suppliedKey !== expectedKey) {
    return { ok: false, success: false, error: '未授權：API Key 唔正確', code: 'AUTH_REQUIRED' };
  }
  return { ok: true };
}

/**
 * Server-side access audit：只記 metadata，絕不記 API Key、密碼或整份 payload。
 * Sheet 未初始化時靜默略過，唔可以因為審計本身令登入／同步失敗。
 */
/* ★ v2.8.1：純讀取唔記審計。開機載入＋每分鐘 poll＋每次儲存前後嘅 dbInfo 核對
   全部都係讀 —— 逐次記只會令「審計紀錄」日日洗版（5000 行上限轉個圈就冇晒），
   仲要每個請求多 3 下 Sheet API（appendRow＋getLastRow＋間中 deleteRows），
   又慢又燒配額。寫入／登入／批核／重設密碼等會改嘢嘅 action 照樣逐次記。 */
var AUDIT_SKIP_ACTIONS = { ping: 1, test: 1, status: 1, load: 1, loadMine: 1,
  loadDb: 1, loadDbPart: 1, loadTables: 1, loadTablesPart: 1, dbInfo: 1, diag: 1,
  myRequests: 1, authWhoAmI: 1, hubLoad: 1, getLinkState: 1 };
function auditAccess(body, result) {
  try {
    if (AUDIT_SKIP_ACTIONS[textOf(body && body.action)]) return;
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('審計紀錄');
    if (!sh) return;
    var row = [new Date(), textOf(body && (body.unit || body.troopId)),
      textOf(body && body.action).substring(0, 40), textOf(result).substring(0, 40),
      textOf(body && (body.via || 'api')).substring(0, 30),
      textOf(body && (body.actor || body.username || body.ymis)).substring(0, 120)];
    sh.appendRow(row);
    /* 封頂 5000 行：儲到 5500 先一次過刪返落 5000（唔係每次超標就刪，慳配額） */
    var last = sh.getLastRow();
    if (last > 5500) sh.deleteRows(2, last - 5000);
  } catch (ignore) { /* audit fail 不可阻斷主流程 */ }
}

/** 收到 POST 時處理 */
function doPost(e) {
  try {
    var rawBody = String((e && e.postData && e.postData.contents) || '{}');
    var body = JSON.parse(rawBody || '{}');
    /* __serverSigned 只可由 handleSignedRequest 驗簽後在記憶體加入；網絡 body
       自報同名欄位必須先清走，否則會變成授權繞過。 */
    if (body && Object.prototype.hasOwnProperty.call(body, '__serverSigned')) delete body.__serverSigned;
    if (body && Object.prototype.hasOwnProperty.call(body, '__serverActorRole')) delete body.__serverActorRole;
    if (body && Object.prototype.hasOwnProperty.call(body, '__serverActorSubject')) delete body.__serverActorSubject;
    if (body && Object.prototype.hasOwnProperty.call(body, '__serverIdentityMap')) delete body.__serverIdentityMap;
    auditAccess(body, 'received');
    /* Legacy server-signature transport 先驗 HMAC，再交同一個 dispatcher；簽名只係
       server authentication，唔係用戶登入、Progress 整合狀態或未來旅系統契約。 */
    if (verifyLinkSig(e, body, rawBody)) return handleSignedRequest(e, body, rawBody);
    if (!localLoginAllowed()) return json(linkClosedResponse(textOf(body && body.action)));
    return dispatchBody(e, body);
  } catch (err) {
    if (err && err.code === 'LOCK_BUSY') {
      return json({ ok: false, success: false, error: '系統繁忙，請稍後重試', code: 'LOCK_BUSY' });
    }
    return json({ ok: false, error: String(err) });
  }
}

/** doPost 實質派發（legacy 旗標／transport 檢查已喺 doPost 做咗） */
function dispatchBody(e, body) {
  try {
    var expectedKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
    // 多個 client 共用同一 Unified key（大寫 apiKey / 細寫 apikey 都收）
    var key = body.apiKey || body.apikey || '';
    body.apiKey = key;

    // 若伺服器端有設定 API_KEY，且請求有傳入 key，進行核對
    if (expectedKey && key && key !== expectedKey) {
      return json({ ok: false, success: false, error: 'API key 唔正確' });
    }

    /* server-side session：登入成功後由 GAS 發出短期 token；hash 留喺 ScriptProperties。 */
    function issueAuthSession(unit, record, kind) {
      /* 重設／改密碼會先寫 AUTH_REVOKE。新票 iat 必須嚴格大過 revoke 時間；
         同一毫秒內完成時都唔可以誤殺啱啱換出嚟嗰張新票。 */
      var now = Date.now();
      var revokedAt = Number(PropertiesService.getScriptProperties().getProperty('AUTH_REVOKE_' + textOf(unit) + '_' + textOf(record && record.id)) || 0);
      if (now <= revokedAt) now = revokedAt + 1;
      var expiresAt = now + 8 * 3600 * 1000;
      var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '') + String(now) + String(Math.random()).replace('.', '');
      var tokenHash = sha256HexGs(token);
      var key = 'AUTH_SESSION_' + textOf(unit) + '_' + tokenHash;
      PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({ id: textOf(record.id), kind: kind, iat: now, exp: expiresAt, pv: Number(record.pv || 1) }));
      return { token: token, expiresAt: expiresAt };
    }

    function verifyPortalToken(unit, token, wantedRole) {
      var parts = textOf(token).split('.');
      /* 同 BADGE／proxy 共用 API_KEY，但用固定 purpose 派生獨立 exchange key；
         不需要另一條 Portal session secret，API Key 本身亦不會直接成為身份。 */
      var secret = hmacSha256HexGs('vs-portal-branch-exchange-v1', getApiKey());
      if (!secret || parts.length !== 2) return { ok: false, error: '隔離 auth fixture 未設定' };
      var expected = Utilities.computeHmacSha256Signature(parts[0], Utilities.newBlob(secret).getBytes())
        .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
      var supplied = '';
      try { supplied = Utilities.base64EncodeWebSafe(Utilities.base64DecodeWebSafe(parts[1])); } catch (e) { supplied = ''; }
      /* GAS web-safe base64 比對轉 hex 較麻煩；用重新簽名的 base64 字串核對。 */
      var expectedB64 = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], Utilities.newBlob(secret).getBytes())).replace(/=+$/, '');
      if (supplied.replace(/=+$/, '') !== expectedB64) return { ok: false, error: '隔離 auth fixture 票據無效' };
      var payload = null;
      try { payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); } catch (e2) { payload = null; }
      var nowMs = Date.now();
      var iat = Number(payload && payload.iat || 0);
      var exp = Number(payload && payload.exp || 0);
      if (!payload || textOf(payload.typ) !== 'central-sso-exchange'
          || textOf(payload.u) !== textOf(unit)
          || textOf(payload.iss) !== 'vs-portal'
          || textOf(payload.aud) !== 'unified-gas:branch:' + textOf(unit)
          || textOf(payload.src) !== 'central-travel-system'
          || !iat || !exp || iat > nowMs + 15000 || exp <= nowMs - 15000 || exp <= iat || exp - iat > 120000) {
        return { ok: false, error: '隔離 auth fixture 票據已過期或用途不正確' };
      }
      if (wantedRole && textOf(payload.role) !== textOf(wantedRole)) return { ok: false, error: '隔離 auth fixture 身份不符合' };
      return { ok: true, portal: true, role: textOf(payload.role), subject: textOf(payload.sub) };
    }

    function verifyAuthSession(unit, token) {
      var raw = textOf(token);
      if (!raw) return { ok: false, error: '登入狀態已失效，請重新登入' };
      var key = 'AUTH_SESSION_' + textOf(unit) + '_' + sha256HexGs(raw);
      var saved = PropertiesService.getScriptProperties().getProperty(key);
      var info = null;
      try { info = saved ? JSON.parse(saved) : null; } catch (sessionErr) { info = null; }
      var revokedAt = Number(PropertiesService.getScriptProperties().getProperty('AUTH_REVOKE_' + textOf(unit) + '_' + textOf(info && info.id)) || 0);
      if (!info || Number(info.exp || 0) <= Date.now() || (revokedAt && revokedAt >= Number(info.iat || 0))) {
        if (saved) PropertiesService.getScriptProperties().deleteProperty(key);
        return { ok: false, error: '登入狀態已失效，請重新登入' };
      }
      return { ok: true, id: textOf(info.id), kind: textOf(info.kind), pv: Number(info.pv || 1) };
    }

    function requireAuthSession(body) {
      if (body.portalToken) return verifyPortalToken(body.unit, body.portalToken, body.portalRole || '');
      return verifyAuthSession(body.unit, body.sessionToken);
    }

    /* 行政資料的 API Key 只係 routing secret。直連 /exec 同樣要一張 server-issued
       session；經已驗 HMAC＋nonce 的 server-to-server request 才可用內部 marker。
       role 由 session 對回後端名冊，client 自報 role/memberId 一律唔採用。 */
    function requireStaffSession(body, minimumRank, allowSetup) {
      if (body && body.__serverSigned === true) {
        var delegatedRole = textOf(body.__serverActorRole).toLowerCase();
        var delegatedSubject = textOf(body.__serverActorSubject).toLowerCase();
        if (delegatedRole && delegatedSubject) {
          if (hubRoleRank_(delegatedRole) < Number(minimumRank || 3)) {
            return { ok: false, success: false, error: '你的身份不可以執行此操作', code: 'ACTION_SCOPE_DENIED' };
          }
          return { ok: true, serverSigned: true, delegated: true, role: delegatedRole,
            identityMap: body.__serverIdentityMap && typeof body.__serverIdentityMap === 'object'
              ? body.__serverIdentityMap : null,
            session: { ok: true, portal: true, role: delegatedRole, subject: delegatedSubject } };
        }
        return { ok: true, serverSigned: true, role: 'server' };
      }
      var session = requireAuthSession(body || {});
      if (!session.ok) return { ok: false, success: false, error: session.error, code: 'SESSION_REQUIRED' };
      if (session.kind === 'setup' && session.id === 'setup') {
        if (allowSetup !== true) return { ok: false, success: false, error: '開團身份不可以執行修復或強制覆寫', code: 'ACTION_SCOPE_DENIED' };
        return { ok: true, role: 'leader', setup: true };
      }
      var loaded = loadDb(textOf(body && body.unit));
      var actor = adminFindActor_(loaded.db || {}, session);
      if (!actor.ok) return { ok: false, success: false, error: actor.error, code: actor.code || 'SESSION_ACCOUNT_MISSING' };
      if (hubRoleRank_(actor.role) < Number(minimumRank || 3)) {
        return { ok: false, success: false, error: '你的身份不可以執行此操作', code: 'ACTION_SCOPE_DENIED' };
      }
      return { ok: true, role: actor.role, actor: actor, session: session };
    }

    function revokeAuthSessions(unit, id) {
      if (id) PropertiesService.getScriptProperties().setProperty('AUTH_REVOKE_' + textOf(unit) + '_' + textOf(id), String(Date.now()));
    }

    /* authLogin 必須可以由未登記旅團的 ?be= 公開連結直達 /exec，因此 API Key
       不能當登入憑證。密碼仍由 GAS 核對；ScriptCache＋ScriptLock 對同一登入代號
       每 5 分鐘最多保留 20 次嘗試，成功即清零。 */
    function reserveLoginAttempt(unit, loginName) {
      var cache = (typeof CacheService !== 'undefined' && CacheService.getScriptCache)
        ? CacheService.getScriptCache() : null;
      var cacheKey = 'v82-auth-attempt:' + sha256HexGs(textOf(unit) + ':' + textOf(loginName)).substring(0, 40);
      if (!cache) return { ok: true, key: cacheKey, cache: null };
      var allowed = withLock(function () {
        var count = Number(cache.get(cacheKey) || 0);
        if (count >= 20) return false;
        cache.put(cacheKey, String(count + 1), 300);
        return true;
      });
      return { ok: allowed, key: cacheKey, cache: cache };
    }
    function clearLoginAttempts(reservation) {
      try { if (reservation && reservation.cache) reservation.cache.remove(reservation.key); } catch (ignore) { /* 下次自動過期 */ }
    }

    /* ---- 支部帳戶登入：公開 credential endpoint；前端只收安全身份資料 ---- */
    if (body.action === 'authLogin') {
      var loginDb = loadDb(textOf(body.unit));
      var loginName = textOf(body.username || body.email || body.ymis).toLowerCase();
      var loginReservation = reserveLoginAttempt(body.unit, loginName);
      if (!loginReservation.ok) return json({ ok: false, success: false,
        error: '登入嘗試次數過多，請五分鐘後再試', code: 'AUTH_RATE_LIMITED' });
      var loginPw = textOf(body.password);
      var loginRec = null;
      var loginKind = '';
      (loginDb.db && loginDb.db.accounts || []).some(function (a) {
        if (a && a.active !== false && (textOf(a.username).toLowerCase() === loginName || textOf(a.email).toLowerCase() === loginName)) {
          loginRec = a; loginKind = 'account'; return true;
        }
        return false;
      });
      if (!loginRec) (loginDb.db && loginDb.db.members || []).some(function (m) {
        if (m && m.status !== 'alumni' && !m.accountDeletedAt && (
            textOf(m.ymis).toLowerCase() === loginName ||
            textOf(m.email).toLowerCase() === loginName ||
            textOf(m.loginId).toLowerCase() === loginName)) {
          loginRec = m; loginKind = 'member'; return true;
        }
        return false;
      });
      var loginPassword = loginRec && (loginRec.pw || loginRec.hubPw);
      var loginRole = textOf(loginRec && (loginRec.role || loginRec.identity) || 'member').toLowerCase();
      var loginOk = false;
      if (loginRec && loginPassword && loginPassword.algo === 'pbkdf2-sha256') {
        loginOk = verifyPasswordRecord(loginPassword, loginPw);
      } else if (loginRec && loginPassword && loginPassword.algo === 'sha256') {
        loginOk = sha256HexGs(loginPassword.salt + '::' + loginPw) === textOf(loginPassword.hash);
      } else if (loginRec && !loginPassword && loginPw === '1234'
          && (loginRole === 'member' || loginRole === 'exco')) {
        /* 預設密碼只供團員／執委首次開戶。成人高權身份冇密碼紀錄時 fail closed。 */
        loginOk = true;
      }
      if (!loginRec) return json({ ok: false, success: false, code: 'AUTH_INVALID', error: '帳號或密碼不正確' });
      if (!loginOk) return json({ ok: false, success: false, code: 'AUTH_INVALID', error: '帳號或密碼不正確' });
      clearLoginAttempts(loginReservation);
      var loginMember = loginKind === 'member' ? loginRec : null;
      if (!loginMember && loginRec.memberId) {
        (loginDb.db && loginDb.db.members || []).some(function (m) {
          if (m && textOf(m.id) === textOf(loginRec.memberId)) { loginMember = m; return true; }
          return false;
        });
      }
      if (!loginMember) {
        (loginDb.db && loginDb.db.members || []).some(function (m) {
          if (!m || m.status === 'alumni') return false;
          if ((loginRec.email && textOf(m.email).toLowerCase() === textOf(loginRec.email).toLowerCase())
              || (loginRec.username && (
                textOf(m.ymis).toLowerCase() === textOf(loginRec.username).toLowerCase()
                || textOf(m.loginId).toLowerCase() === textOf(loginRec.username).toLowerCase()))) {
            loginMember = m; return true;
          }
          return false;
        });
      }
      var session = issueAuthSession(textOf(body.unit), loginRec, loginKind);
      return json({ ok: true, success: true, sessionToken: session.token, sessionExpiresAt: session.expiresAt, account: {
        id: textOf(loginRec.id), username: textOf(loginRec.username || loginRec.email || loginRec.loginId || loginRec.ymis),
        email: textOf(loginRec.email), name: textOf(loginRec.name), role: loginRole, kind: loginKind,
        memberId: textOf(loginMember && loginMember.id), ymis: textOf(loginMember && loginMember.ymis || loginRec.ymis)
      }, mustChangePw: !!(loginRec.mustChangePw || loginRec.hubMustChangePw || !loginPassword || loginPw === '1234') });
    }

    /* ---- 核對短期 session，只回登入者本人嘅安全身份欄位 ---- */
    if (body.action === 'authWhoAmI') {
      var whoAuth = requireAuth(expectedKey, key);
      if (!whoAuth.ok) return json(whoAuth);
      var whoSession = requireAuthSession(body);
      if (!whoSession.ok) return json({ ok: false, success: false, error: whoSession.error, code: 'SESSION_REQUIRED' });
      /* 新旅團未有名冊時，已由 server 驗過 72 小時開團 KEY 的短期 setup session
         要可以完成第一次載入／儲存；client 單靠 kind 字串造唔到呢張票。 */
      if (whoSession.kind === 'setup' && whoSession.id === 'setup') {
        return json({ ok: true, success: true, setup: true, account: {
          id: 'setup', memberId: '', ymis: '', email: '', name: '開團設定', role: 'leader'
        } });
      }
      var whoDb = loadDb(textOf(body.unit));
      var whoRec = null;
      var whoMember = null;
      if (whoSession.portal) {
        var whoSubject = textOf(whoSession.subject).toLowerCase();
        (whoDb.db && whoDb.db.members || []).some(function (m) {
          if (m && m.status !== 'alumni' && (
              textOf(m.ymis).toLowerCase() === whoSubject ||
              textOf(m.email).toLowerCase() === whoSubject ||
              textOf(m.loginId).toLowerCase() === whoSubject)) {
            whoMember = m; return true;
          }
          return false;
        });
      } else if (whoSession.kind === 'account') {
        (whoDb.db && whoDb.db.accounts || []).some(function (a) {
          if (a && a.active !== false && textOf(a.id) === textOf(whoSession.id)) { whoRec = a; return true; }
          return false;
        });
        if (whoRec && whoRec.memberId) (whoDb.db && whoDb.db.members || []).some(function (m) {
          if (m && m.status !== 'alumni' && textOf(m.id) === textOf(whoRec.memberId)) { whoMember = m; return true; }
          return false;
        });
      } else {
        (whoDb.db && whoDb.db.members || []).some(function (m) {
          if (m && m.status !== 'alumni' && !m.accountDeletedAt && textOf(m.id) === textOf(whoSession.id)) { whoMember = m; return true; }
          return false;
        });
      }
      if (!whoMember && whoRec) (whoDb.db && whoDb.db.members || []).some(function (m) {
        if (!m || m.status === 'alumni') return false;
        if ((whoRec.email && textOf(m.email).toLowerCase() === textOf(whoRec.email).toLowerCase())
            || (whoRec.username && (
              textOf(m.ymis).toLowerCase() === textOf(whoRec.username).toLowerCase()
              || textOf(m.loginId).toLowerCase() === textOf(whoRec.username).toLowerCase()))) {
          whoMember = m; return true;
        }
        return false;
      });
      if (!whoMember && !whoRec) return json({ ok: false, success: false, error: '登入帳戶已不存在', code: 'SESSION_ACCOUNT_MISSING' });
      var whoRole = textOf(whoSession.portal ? whoSession.role : ((whoMember && whoMember.identity) || (whoRec && whoRec.role) || 'member')).toLowerCase();
      return json({ ok: true, success: true, account: {
        id: textOf((whoMember && whoMember.id) || (whoRec && whoRec.id)),
        memberId: textOf(whoMember && whoMember.id),
        ymis: textOf(whoMember && whoMember.ymis),
        email: textOf((whoMember && whoMember.email) || (whoRec && whoRec.email)),
        name: textOf((whoMember && whoMember.name) || (whoRec && whoRec.name)),
        role: whoRole
      } });
    }

    /* ---- 支部帳戶自己改密碼：身份固定由 opaque session 對回；成功撤銷舊票並換新票 ---- */
    if (body.action === 'authChangePassword') {
      var changeSession = requireAuthSession(body);
      if (!changeSession.ok) return json({ ok: false, success: false, error: changeSession.error, code: 'SESSION_REQUIRED' });
      if (changeSession.portal) return json({ ok: false, success: false, error: '隔離 auth fixture 身份不設支部本地密碼', code: 'CENTRAL_IDENTITY_MANAGED' });
      if (textOf(body.newPassword) === '1234') return json({ ok: false, success: false, error: '新密碼唔可以繼續用預設 1234' });
      var changedPassword = withLock(function () {
        var changedDb = loadDb(textOf(body.unit));
        if (!changedDb.success || !changedDb.db) return { success: false, error: changedDb.error || '後端未有資料庫' };
        var changedActor = hubFindActor_(changedDb.db, changeSession);
        if (!changedActor.ok) return { success: false, error: changedActor.error, code: changedActor.code };
        var record = changedActor.record;
        var oldRecord = record && (record.pw || record.hubPw);
        var temporary = !!(record && (record.mustChangePw || record.hubMustChangePw || !oldRecord));
        var oldOk = temporary;
        if (!oldOk && oldRecord && oldRecord.algo === 'pbkdf2-sha256') oldOk = verifyPasswordRecord(oldRecord, textOf(body.oldPassword));
        else if (!oldOk && oldRecord && oldRecord.algo === 'sha256') oldOk = sha256HexGs(oldRecord.salt + '::' + textOf(body.oldPassword)) === textOf(oldRecord.hash);
        if (!oldOk) return { success: false, error: '舊密碼不正確' };
        var nextPassword = makePasswordRecord(textOf(body.newPassword), false);
        if (!nextPassword.ok) return { success: false, error: nextPassword.error };
        if (changedActor.kind === 'account') {
          record.pw = nextPassword.pw; record.mustChangePw = false; record.defaultPw = false; delete record.password;
        } else {
          record.hubPw = nextPassword.pw; record.hubMustChangePw = false; record.hubOpened = true; delete record.hubPassword;
        }
        record.pv = Number(record.pv || 1) + 1;
        var changedSaved = saveDb({ unit: textOf(body.unit), db: changedDb.db, baseVersion: changedDb.version, refreshReports: false });
        if (changedSaved.success !== true) return changedSaved;
        revokeAuthSessions(body.unit, record.id);
        var nextSession = issueAuthSession(textOf(body.unit), record, changedActor.kind);
        return { success: true, version: changedSaved.version || '', sessionToken: nextSession.token, sessionExpiresAt: nextSession.expiresAt };
      });
      return json({ ok: changedPassword.success === true, success: changedPassword.success === true,
        version: changedPassword.version || '', sessionToken: changedPassword.sessionToken || '',
        sessionExpiresAt: changedPassword.sessionExpiresAt || 0, mustChangePw: false,
        code: changedPassword.code || '', error: changedPassword.error || '' });
    }

    /* ---- 團員入口：安全投影＋本人入站資料；API Key 永遠唔代替 session 身份 ---- */
    if (body.action === 'hubLoad' || body.action === 'hubRsvp' || body.action === 'hubQuiz' || body.action === 'hubAbsence' || body.action === 'hubNoticeSignup') {
      var hubSession = requireAuthSession(body);
      if (!hubSession.ok) return json({ ok: false, success: false, error: hubSession.error, code: 'SESSION_REQUIRED' });
      if (body.action === 'hubLoad') {
        var hubLoaded = loadDb(textOf(body.unit));
        if (!hubLoaded.success || !hubLoaded.db) return json({ ok: false, success: false, found: false, error: hubLoaded.error || '後端未有資料庫' });
        var hubActor = hubFindActor_(hubLoaded.db, hubSession);
        if (!hubActor.ok) return json({ ok: false, success: false, code: hubActor.code || 'SESSION_ACCOUNT_MISSING', error: hubActor.error });
        return json({ ok: true, success: true, found: true, db: hubSafeDb_(hubLoaded.db, hubActor),
          version: hubLoaded.version || '', at: hubLoaded.at || '', role: hubActor.role });
      }
      var hubChanged = withLock(function () {
        var loaded = loadDb(textOf(body.unit));
        if (!loaded.success || !loaded.db) return { success: false, error: loaded.error || '後端未有資料庫' };
        var actor = hubFindActor_(loaded.db, hubSession);
        if (!actor.ok) return { success: false, code: actor.code, error: actor.error };
        var applied = hubApplyMutation_(loaded.db, actor, body);
        if (!applied.ok) return { success: false, error: applied.error };
        var saved = saveDb({ unit: textOf(body.unit), db: loaded.db, baseVersion: loaded.version, refreshReports: false });
        if (saved.success !== true) return saved;
        return { success: true, version: saved.version || '', db: hubSafeDb_(loaded.db, actor), id: applied.id || '' };
      });
      return json({ ok: hubChanged.success === true, success: hubChanged.success === true,
        version: hubChanged.version || '', db: hubChanged.db || null, id: hubChanged.id || '',
        code: hubChanged.code || '', error: hubChanged.error || '' });
    }

    /* ---- 領袖替成員重設密碼：由 server-side 重新核對領袖身份 ---- */
    if (body.action === 'authResetPassword') {
      var resetAuth = requireAuth(expectedKey, key);
      if (!resetAuth.ok) return json(resetAuth);
      var resetSession = body.__serverSigned === true
        ? { ok: true, serverSigned: true, role: 'super' }
        : requireAuthSession(body);
      if (!resetSession.ok) return json({ ok: false, success: false, error: resetSession.error, code: 'SESSION_REQUIRED' });
      var reset = withLock(function () {
        var resetDb = loadDb(textOf(body.unit));
        if (!resetDb.success || !resetDb.db) return { success: false, error: resetDb.error || '後端未有資料庫' };
        var targetName = textOf(body.targetUsername || body.targetEmail || body.targetYmis).toLowerCase();
        var target = null;
        /* 操作者只由已驗證 session 對回後端紀錄；actorUsername／actorRole 等 client
           欄位全部不參與授權，隔離 auth fixture 的 opaque session 亦走同一路徑。 */
        var resetActor = resetSession.serverSigned
          ? { ok: true, role: 'super', record: null, serverSigned: true }
          : adminFindActor_(resetDb.db, resetSession);
        if (!resetActor.ok) return { success: false, error: resetActor.error, code: resetActor.code };
        if (hubRoleRank_(resetActor.role) < hubRoleRank_('leader') || !staffCanAccountAdmin_(resetDb.db, resetActor)) {
          return { success: false, error: '你沒有權限重設其他帳戶密碼', code: 'ACTION_SCOPE_DENIED' };
        }
        (resetDb.db && resetDb.db.accounts || []).some(function (a) {
          if (a && a.active !== false && (textOf(a.username).toLowerCase() === targetName || textOf(a.email).toLowerCase() === targetName)) { target = a; return true; }
          return false;
        });
        if (!target) (resetDb.db && resetDb.db.members || []).some(function (m) {
          if (m && m.status !== 'alumni' && (textOf(m.ymis).toLowerCase() === targetName || textOf(m.email).toLowerCase() === targetName)) { target = m; return true; }
          return false;
        });
        if (!target) return { success: false, error: '搵唔到要重設嘅帳戶' };
        var targetRole = textOf(target.role || target.identity).toLowerCase();
        if (hubRoleRank_(targetRole) >= hubRoleRank_(resetActor.role)) {
          return { success: false, error: '不能重設同級或更高權限帳戶' };
        }
        var nextReset = makePasswordRecord(textOf(body.newPassword), true);
        if (!nextReset.ok) return { success: false, error: nextReset.error };
        if (target.hubPw !== undefined || target.ymis !== undefined) {
          target.hubPw = nextReset.pw; target.hubMustChangePw = true; delete target.hubPassword;
        } else {
          target.pw = nextReset.pw; target.mustChangePw = true; target.defaultPw = textOf(body.newPassword) === '1234'; delete target.password;
        }
        var savedReset = saveDb({ unit: textOf(body.unit), db: resetDb.db, baseVersion: resetDb.version, refreshReports: false });
        if (savedReset.success === true) revokeAuthSessions(body.unit, target.id);
        return savedReset.success === true ? { success: true, version: savedReset.version || '' } : savedReset;
      });
      return json({ ok: reset.success === true, success: reset.success === true, version: reset.version || '',
        code: reset.code || '', error: reset.error || '' });
    }

    /* ---- 管理員／團長刪除帳戶：只刪 accounts row，不刪成員資料 ---- */
    if (body.action === 'authDeleteAccount') {
      var deleteAuth = requireAuth(expectedKey, key);
      if (!deleteAuth.ok) return json(deleteAuth);
      var deleteSession = body.__serverSigned === true
        ? { ok: true, serverSigned: true, role: 'super' }
        : requireAuthSession(body);
      if (!deleteSession.ok) return json({ ok: false, success: false, error: deleteSession.error, code: 'SESSION_REQUIRED' });
      var deleted = withLock(function () {
        var deleteDb = loadDb(textOf(body.unit));
        if (!deleteDb.success || !deleteDb.db) return { success: false, error: deleteDb.error || '後端未有資料庫' };
        var targetName3 = textOf(body.targetUsername || body.targetEmail).toLowerCase();
        var target3 = null, targetIndex = -1;
        var deleteActor = deleteSession.serverSigned
          ? { ok: true, role: 'super', record: null, serverSigned: true }
          : adminFindActor_(deleteDb.db, deleteSession);
        if (!deleteActor.ok) return { success: false, error: deleteActor.error, code: deleteActor.code };
        if (hubRoleRank_(deleteActor.role) < hubRoleRank_('leader') || !staffCanAccountAdmin_(deleteDb.db, deleteActor)) {
          return { success: false, error: '你沒有權限刪除帳戶', code: 'ACTION_SCOPE_DENIED' };
        }
        (deleteDb.db && deleteDb.db.accounts || []).some(function (a, i) {
          if (a && (textOf(a.username).toLowerCase() === targetName3 || textOf(a.email).toLowerCase() === targetName3)) { target3 = a; targetIndex = i; return true; }
          return false;
        });
        if (!target3) return { success: false, error: '搵唔到要刪除嘅帳戶' };
        if (deleteActor.record && textOf(target3.id) === textOf(deleteActor.record.id)) return { success: false, error: '不能刪除自己目前登入嘅帳戶' };
        var targetRole3 = textOf(target3.role || target3.identity).toLowerCase();
        if (hubRoleRank_(targetRole3) >= hubRoleRank_(deleteActor.role)) {
          return { success: false, error: '不能刪除同級或更高權限帳戶' };
        }
        if (hubRoleRank_(targetRole3) >= hubRoleRank_('leader')) {
          var managerCount3 = (deleteDb.db.accounts || []).filter(function (a) {
            return a && a.active !== false && hubRoleRank_(a.role || a.identity) >= hubRoleRank_('leader');
          }).length;
          if (managerCount3 <= 1) return { success: false, error: '不能刪除最後一個管理員／團長帳戶，請先開通另一個管理員' };
        }
        var linkedMember = textOf(target3.memberId);
        deleteDb.db.accounts.splice(targetIndex, 1);
        deleteDb.db.deletedAccounts = deleteDb.db.deletedAccounts || [];
        deleteDb.db.deletedAccounts.push({ id: textOf(target3.id), username: textOf(target3.username), email: textOf(target3.email),
          name: textOf(target3.name), role: textOf(target3.role), memberId: linkedMember, deletedAt: new Date().toISOString() });
        /* 成員 row 保留；只標記其管理登入已撤銷，避免資料與歷史被刪掉。 */
        (deleteDb.db.members || []).forEach(function (m) {
          if (linkedMember && textOf(m.id) === linkedMember) m.accountDeletedAt = new Date().toISOString();
        });
        var savedDelete = saveDb({ unit: textOf(body.unit), db: deleteDb.db, baseVersion: deleteDb.version, refreshReports: false });
        if (savedDelete.success === true) revokeAuthSessions(body.unit, target3.id);
        return savedDelete.success === true ? { success: true, version: savedDelete.version || '' } : savedDelete;
      });
      return json({ ok: deleted.success === true, success: deleted.success === true, version: deleted.version || '',
        code: deleted.code || '', error: deleted.error || '' });
    }

    /* ---- 復原已刪除登入：保留成員資料，重新建立帳戶 row ---- */
    if (body.action === 'authRestoreAccount') {
      var restoreAuth = requireAuth(expectedKey, key);
      if (!restoreAuth.ok) return json(restoreAuth);
      var restoreSession = body.__serverSigned === true
        ? { ok: true, serverSigned: true, role: 'super' }
        : requireAuthSession(body);
      if (!restoreSession.ok) return json({ ok: false, success: false, error: restoreSession.error, code: 'SESSION_REQUIRED' });
      var restored = withLock(function () {
        var restoreDb = loadDb(textOf(body.unit));
        if (!restoreDb.success || !restoreDb.db) return { success: false, error: restoreDb.error || '後端未有資料庫' };
        var member4 = null;
        var restoreActor = restoreSession.serverSigned
          ? { ok: true, role: 'super', record: null, serverSigned: true }
          : adminFindActor_(restoreDb.db, restoreSession);
        if (!restoreActor.ok) return { success: false, error: restoreActor.error, code: restoreActor.code };
        if (hubRoleRank_(restoreActor.role) < hubRoleRank_('leader') || !staffCanAccountAdmin_(restoreDb.db, restoreActor)) {
          return { success: false, error: '你沒有權限復原帳戶', code: 'ACTION_SCOPE_DENIED' };
        }
        var restoreTarget = textOf(body.targetEmail || body.targetYmis).toLowerCase();
        var tombstone = null;
        (restoreDb.db && restoreDb.db.deletedAccounts || []).some(function (d) {
          if (d && (textOf(d.email).toLowerCase() === restoreTarget || textOf(d.username).toLowerCase() === restoreTarget)) { tombstone = d; return true; }
          return false;
        });
        (restoreDb.db && restoreDb.db.members || []).some(function (m) {
          if (m && m.accountDeletedAt && (textOf(m.email).toLowerCase() === restoreTarget || textOf(m.ymis).toLowerCase() === restoreTarget)) { member4 = m; return true; }
          return false;
        });
        if (!member4 && !tombstone) return { success: false, error: '搵唔到可復原嘅已刪除帳戶' };
        var restorePw = makePasswordRecord(textOf(body.newPassword || '1234'), true);
        if (!restorePw.ok) return { success: false, error: restorePw.error };
        var role4 = textOf((member4 && member4.identity) || (tombstone && tombstone.role) || 'member');
        if (hubRoleRank_(role4) >= hubRoleRank_(restoreActor.role)) {
          return { success: false, error: '不能復原同級或更高權限帳戶' };
        }
        restoreDb.db.accounts = restoreDb.db.accounts || [];
        restoreDb.db.accounts.push({ id: 'acc_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12),
          role: role4, username: textOf((member4 && (member4.email || member4.ymis)) || (tombstone && tombstone.username)),
          email: textOf((member4 && member4.email) || (tombstone && tombstone.email)),
          name: textOf((member4 && member4.name) || (tombstone && tombstone.name)),
          memberId: textOf((member4 && member4.id) || (tombstone && tombstone.memberId)), active: true,
          pw: restorePw.pw, mustChangePw: true, defaultPw: textOf(body.newPassword || '1234') === '1234' });
        if (member4) delete member4.accountDeletedAt;
        if (tombstone) restoreDb.db.deletedAccounts = restoreDb.db.deletedAccounts.filter(function (d) { return d !== tombstone; });
        var savedRestore = saveDb({ unit: textOf(body.unit), db: restoreDb.db, baseVersion: restoreDb.version, refreshReports: false });
        return savedRestore.success === true ? { success: true, version: savedRestore.version || '' } : savedRestore;
      });
      return json({ ok: restored.success === true, success: restored.success === true, version: restored.version || '',
        code: restored.code || '', error: restored.error || '' });
    }

    /* ---- EMAIL 忘記密碼：公開、非枚舉 endpoint；同一 email 五分鐘最多寄一次 ---- */
    if (body.action === 'authForgotPassword') {
      var forgotDb = loadDb(textOf(body.unit));
      var forgotEmail = textOf(body.email).trim().toLowerCase();
      var forgotTarget = null;
      var forgotCache = (typeof CacheService !== 'undefined' && CacheService.getScriptCache)
        ? CacheService.getScriptCache() : null;
      var forgotKey = 'v82-forgot:' + sha256HexGs(textOf(body.unit) + ':' + forgotEmail).substring(0, 40);
      var forgotMaySend = true;
      if (forgotCache) forgotMaySend = withLock(function () {
        if (forgotCache.get(forgotKey)) return false;
        forgotCache.put(forgotKey, '1', 300);
        return true;
      });
      (forgotDb.db && forgotDb.db.accounts || []).some(function (a) {
        if (a && a.active !== false && textOf(a.email).toLowerCase() === forgotEmail) { forgotTarget = { id: textOf(a.id), kind: 'account', email: textOf(a.email) }; return true; }
        return false;
      });
      if (!forgotTarget) (forgotDb.db && forgotDb.db.members || []).some(function (m) {
        if (m && m.status !== 'alumni' && textOf(m.email).toLowerCase() === forgotEmail) { forgotTarget = { id: textOf(m.id), kind: 'member', email: textOf(m.email) }; return true; }
        return false;
      });
      /* callback URL 絕不採用 client body，否則攻擊者可令正式電郵把 token 送去釣魚網域。
         Sheet owner 必須先在 Apps Script editor 執行 setPasswordResetUrl(...)。 */
      var configuredResetUrl = textOf(PropertiesService.getScriptProperties().getProperty('PASSWORD_RESET_URL'));
      if (forgotTarget && forgotMaySend && configuredResetUrl.toLowerCase().indexOf('https://') === 0) {
        var rawToken = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
        var tokenHash = sha256HexGs(rawToken);
        var tokenKey = 'PWD_RESET_' + textOf(body.unit) + '_' + tokenHash;
        PropertiesService.getScriptProperties().setProperty(tokenKey, JSON.stringify({ id: forgotTarget.id, kind: forgotTarget.kind, exp: Date.now() + 30 * 60 * 1000 }));
        var link = configuredResetUrl + '?unit=' + encodeURIComponent(textOf(body.unit)) + '&token=' + encodeURIComponent(rawToken);
        /* 未登記旅團要把自己公開 /exec 路由帶到 reset page；API Key 永不入網址。 */
        try {
          var ownExec = textOf(ScriptApp.getService().getUrl());
          if (ownExec) link += '&be=' + encodeURIComponent(ownExec);
        } catch (resetUrlErr) { /* 經平台 proxy 的旅團不需要 be */ }
        var lineBreak = String.fromCharCode(10);
        try { MailApp.sendEmail(forgotTarget.email, 'Scout System 重設密碼', '請在 30 分鐘內開啟以下連結重設密碼：' + lineBreak + lineBreak + link); } catch (mailErr) { /* 不向外洩漏寄信錯誤 */ }
      }
      return json({ ok: true, success: true, resetMode: 'link',
        message: '如果電郵已登記，重設連結會寄出。' });
    }

    /* ---- 電郵一次性 token 完成重設：免登入、免 API Key；token 本身係高熵單次憑證 ---- */
    if (body.action === 'authResetByToken') {
      var publicResetError = { ok: false, success: false, code: 'RESET_TOKEN_INVALID', error: '重設連結無效或已過期，請重新申請' };
      var resetToken = textOf(body.token).trim();
      if (resetToken.length < 32 || resetToken.length > 256) return json(publicResetError);
      var resetTokenKey = 'PWD_RESET_' + textOf(body.unit) + '_' + sha256HexGs(resetToken);
      var completedReset = withLock(function () {
        var resetProps = PropertiesService.getScriptProperties();
        var savedToken = resetProps.getProperty(resetTokenKey);
        var tokenInfo = null;
        try { tokenInfo = savedToken ? JSON.parse(savedToken) : null; } catch (tokenErr) { tokenInfo = null; }
        if (!tokenInfo || Number(tokenInfo.exp || 0) <= Date.now()) {
          if (savedToken) resetProps.deleteProperty(resetTokenKey);
          return { success: false, invalid: true };
        }
        var publicResetDb = loadDb(textOf(body.unit));
        if (!publicResetDb.success || !publicResetDb.db) return { success: false, retryable: true };
        var resetRecord = null;
        var rows = tokenInfo.kind === 'account' ? (publicResetDb.db.accounts || []) : (publicResetDb.db.members || []);
        rows.some(function (row) {
          if (row && textOf(row.id) === textOf(tokenInfo.id)
              && (tokenInfo.kind !== 'account' || row.active !== false)
              && (tokenInfo.kind !== 'member' || row.status !== 'alumni')) {
            resetRecord = row; return true;
          }
          return false;
        });
        if (!resetRecord) { resetProps.deleteProperty(resetTokenKey); return { success: false, invalid: true }; }
        var publicResetPw = makePasswordRecord(textOf(body.newPassword), false);
        if (!publicResetPw.ok) return { success: false, policy: publicResetPw.error };
        if (tokenInfo.kind === 'account') {
          resetRecord.pw = publicResetPw.pw; resetRecord.mustChangePw = false; resetRecord.defaultPw = false;
          delete resetRecord.password;
        } else {
          resetRecord.hubPw = publicResetPw.pw; resetRecord.hubMustChangePw = false; resetRecord.hubOpened = true;
          delete resetRecord.hubPassword;
        }
        resetRecord.pv = Number(resetRecord.pv || 1) + 1;
        var publicResetSaved = saveDb({ unit: textOf(body.unit), db: publicResetDb.db,
          baseVersion: publicResetDb.version, refreshReports: false });
        if (publicResetSaved.success !== true) return { success: false, retryable: true };
        revokeAuthSessions(body.unit, resetRecord.id);
        resetProps.deleteProperty(resetTokenKey);
        return { success: true };
      });
      if (completedReset.policy) return json({ ok: false, success: false, code: 'PASSWORD_POLICY', error: completedReset.policy });
      if (!completedReset.success) return json(publicResetError);
      return json({ ok: true, success: true, message: '密碼已重設，請用新密碼登入' });
    }


    /* ---- 管理員／團長新增支部帳戶 ---- */
    if (body.action === 'authCreateAccount') {
      var createAuth = requireAuth(expectedKey, key); if (!createAuth.ok) return json(createAuth);
      var createSession = body.__serverSigned === true
        ? { ok:true, serverSigned:true, role:'super' }
        : requireAuthSession(body);
      if (!createSession.ok) return json({ ok:false, success:false, error:createSession.error, code:'SESSION_REQUIRED' });
      var createdAccount = withLock(function () {
        var createDb = loadDb(textOf(body.unit));
        if (!createDb.success || !createDb.db) return { success:false, error:createDb.error || '後端未有資料庫' };
        var createActor = createSession.serverSigned
          ? { ok:true, role:'super', record:null, serverSigned:true }
          : adminFindActor_(createDb.db, createSession);
        if (!createActor.ok) return { success:false, error:createActor.error, code:createActor.code };
        var actorRoleC = branchCanonicalRole_(createActor.role);
        var wantedRole = branchCanonicalRole_(body.role || 'exco');
        if (hubRoleRank_(actorRoleC) < hubRoleRank_('leader') || !staffCanAccountAdmin_(createDb.db, createActor)) {
          return { success:false, error:'你沒有權限新增帳戶', code:'ACTION_SCOPE_DENIED' };
        }
        if (BRANCH_ACCOUNT_ROLES_.indexOf(wantedRole) < 0 || hubRoleRank_(wantedRole) >= hubRoleRank_(actorRoleC)) {
          return { success:false, error:'不能建立同級或更高權限帳戶' };
        }
        /* ★ 2026-09-24：唔再開「共用帳戶」。團長／領袖只可以幫人開**個人**帳戶
           （要綁名冊 memberId）—— 純「執委帳戶」呢回事已經取消，改身份就得。 */
        if (!textOf(body.memberId)) return { success:false, error:'由 2026-09-24 起唔再開共用帳戶 —— 請喺「用戶與身份」加人、改身份（系統會自動開個人帳號）' };
        var memberC = null;
        (createDb.db.members || []).some(function (m) {
          if (m && m.status !== 'alumni' && textOf(m.id) === textOf(body.memberId)) { memberC = m; return true; }
          return false;
        });
        if (!memberC) return { success:false, error:'帳戶必須綁定有效名冊成員' };
        var memberRoleC = branchCanonicalRole_(memberC.identity || 'member');
        if (wantedRole !== memberRoleC) return { success:false, error:'帳戶權限必須跟名冊身份一致；請先在用戶頁更改身份' };
        var usernameC = textOf(body.username || body.email).trim();
        if (!usernameC) return { success:false, error:'請填帳號或 EMAIL' };
        if ((createDb.db.accounts || []).some(function(a){ return a && (textOf(a.username).toLowerCase() === usernameC.toLowerCase() || (textOf(a.email) && textOf(a.email).toLowerCase() === usernameC.toLowerCase())); })) return { success:false, error:'帳戶已存在' };
        var pwC = makePasswordRecord(textOf(body.password || '1234'), true); if (!pwC.ok) return { success:false, error:pwC.error };
        createDb.db.accounts = createDb.db.accounts || [];
        createDb.db.accounts.push({ id:'acc_' + Utilities.getUuid().replace(/-/g,'').slice(0,12), role:wantedRole, username:usernameC, email:textOf(body.email || usernameC), name:textOf(body.name || usernameC), title:textOf(body.title), memberId:textOf(body.memberId), active:true, pw:pwC.pw, mustChangePw:true, defaultPw:textOf(body.password || '1234') === '1234' });
        var savedC = saveDb({ unit:textOf(body.unit), db:createDb.db, baseVersion:createDb.version, refreshReports:false });
        return savedC.success === true ? { success:true, version:savedC.version || '' } : savedC;
      });
      return json({ ok:createdAccount.success === true, success:createdAccount.success === true, version:createdAccount.version || '',
        code:createdAccount.code || '', error:createdAccount.error || '' });
    }

    /* ---- 整份資料庫讀／寫（app 嘅真正儲存；一定要 API Key）---- */
    if (body.action === 'saveDb' || body.action === 'loadDb' || body.action === 'loadDbPart'
      || body.action === 'dbInfo' || body.action === 'saveDbPart' || body.action === 'saveDbCommit'
      || body.action === 'saveTables' || body.action === 'loadTables' || body.action === 'loadTablesPart') {
      var dbAuth = requireAuth(expectedKey, key);
      if (!dbAuth.ok) return json(dbAuth);
      var dbSession = requireStaffSession(body, 3, true);
      if (!dbSession.ok) return json(dbSession);
      /* ★ v2.8.0 簡單寫入（逐表）：一個請求淨係寫「有改過」嗰幾個表。
         冇樂觀鎖、冇分段暫存、冇報表重寫 —— 一個表寫唔到，其餘表照讀得到。 */
      if (body.action === 'saveTables') {
        var stx = withLock(function () {
          var revisionGuard = unifiedGuardAdminVersion_(body);
          if (!revisionGuard.success) return revisionGuard;
          var preparedTables = prepareAuthorizedAdminWrite_(body.unit, body.tables, dbSession, true);
          if (preparedTables.success !== true) return preparedTables;
          body.tables = preparedTables.db;
          var tableGuard = validateProtectedAdminWrite_(body.unit, body.tables, dbSession);
          return tableGuard.success === true ? unifiedFinishRosterWrite_(saveTables(body), body.tables.members, body.unit) : tableGuard;
        });
        return json({ ok: stx.success === true, success: stx.success === true,
          tables: stx.tables || null, bytes: stx.bytes || 0, at: stx.at || '',
          version: stx.version || '', conflict: stx.conflict === true, code: stx.code || '', error: stx.error || '',
          /* ★ v2.8.1 自證：confirmed=false ＝ 後端話收到、但分頁留唔到呢次寫嘅行。
             前端要當寫入失敗（保留 pending 再試），唔可以假成功。 */
          confirmed: stx.confirmed === true, simpleRows: stx.simpleRows || 0,
          missingTables: stx.missingTables || [], rosterSyncPending: stx.rosterSyncPending === true, revisionPending: stx.revisionPending === true, writePending: stx.writePending === true, warning: stx.warning || '',
          /* 報表分頁喺同一次請求入面一齊刷咗（前端就唔使再發第二次） */
          reports: stx.reports || null });
      }
      if (body.action === 'loadTables') {
        var ltx = loadTables(textOf(body.unit));
        var ltxActor = ltx.db ? staffActorFromAuth_(ltx.db, dbSession) : { ok: true, role: dbSession.role, setup: dbSession.setup };
        var ltxDb = ltx.db && ltxActor.ok ? staffSafeDb_(ltx.db, ltxActor) : null;
        return json({ ok: ltx.success === true && ltxActor.ok !== false, success: ltx.success === true && ltxActor.ok !== false, found: !!ltx.found,
          db: ltxDb, tables: ltxDb ? dbStats(ltxDb).counts : null, broken: ltx.broken || [],
          at: ltx.at || '', version: ltx.version || '', error: ltxActor.error || ltx.error || '' });
      }
      /* 逐表讀：成份資料庫大過代理回應上限嗰陣，前端一個表一個表攞 */
      if (body.action === 'loadTablesPart') {
        var ltpBase = loadDb(textOf(body.unit));
        var ltpActor = ltpBase.db ? staffActorFromAuth_(ltpBase.db, dbSession) : { ok: true, role: dbSession.role, setup: dbSession.setup };
        var ltp = ltpActor.ok ? staffLoadTablesPart_(textOf(body.unit), body.idx, ltpActor) : { success: false, error: ltpActor.error };
        return json({ ok: ltp.success === true, success: ltp.success === true, found: !!ltp.found,
          idx: ltp.idx || 0, count: ltp.count || 0, name: ltp.name || '', value: ltp.value,
          broken: ltp.broken || [],
          at: ltp.at || '', version: ltp.version || '', error: ltp.error || '' });
      }
      if (body.action === 'saveDb') {
        var sv = withLock(function () {
          var revisionGuard = unifiedGuardAdminVersion_(body);
          if (!revisionGuard.success) return revisionGuard;
          var preparedDb = prepareAuthorizedAdminWrite_(body.unit, body.db, dbSession, false);
          if (preparedDb.success !== true) return preparedDb;
          body.db = preparedDb.db;
          var dbGuard = validateProtectedAdminWrite_(body.unit, body.db, dbSession);
          return dbGuard.success === true ? unifiedFinishRosterWrite_(saveDb(body), body.db.members, body.unit) : dbGuard;
        });
        return json({ ok: sv.success === true, success: sv.success === true, conflict: sv.conflict === true,
          chunks: sv.chunks || 0, bytes: sv.bytes || 0, at: sv.at || '', version: sv.version || '', code: sv.code || '', error: sv.error || '',
          /* 自 v2.6.3 起：報表分頁係咪喺同一次請求入面一齊刷新咗（前端就唔使再發第二次）。
             呢個欄位一定要**明確列出**—— 呢度係逐個欄位砌回應，漏咗就會靜靜地冇咗。 */
          reports: sv.reports || null, rosterSyncPending: sv.rosterSyncPending === true, revisionPending: sv.revisionPending === true, writePending: sv.writePending === true, warning: sv.warning || '' });
      }
      if (body.action === 'saveDbPart') {
        var sp = withLock(function () { var guard = unifiedGuardAdminVersion_(body); return guard.success ? saveDbPart(body) : guard; });
        return json({ ok: sp.success === true, success: sp.success === true, conflict: sp.conflict === true,
          partIdx: sp.partIdx || 0, chunks: sp.chunks || 0, version: sp.version || '', error: sp.error || '' });
      }
      if (body.action === 'saveDbCommit') {
        var sc = withLock(function () { var guard = unifiedGuardAdminVersion_(body); return guard.success ? saveDbCommit(body, dbSession) : guard; });
        return json({ ok: sc.success === true, success: sc.success === true, conflict: sc.conflict === true,
          chunks: sc.chunks || 0, bytes: sc.bytes || 0, at: sc.at || '', version: sc.version || '', code: sc.code || '', error: sc.error || '',
          reports: sc.reports || null, rosterSyncPending: sc.rosterSyncPending === true, revisionPending: sc.revisionPending === true, writePending: sc.writePending === true, warning: sc.warning || '' });
      }
      if (body.action === 'dbInfo') {
        var nfo = dbInfo(textOf(body.unit));
        var nfoLoaded = loadDb(textOf(body.unit));
        var nfoActor = nfoLoaded.db ? staffActorFromAuth_(nfoLoaded.db, dbSession) : { ok: true, role: dbSession.role, setup: dbSession.setup };
        if (nfoLoaded.db && nfoActor.ok) {
          var nfoStats = dbStats(staffSafeDb_(nfoLoaded.db, nfoActor) || {});
          nfo.bytes = nfoStats.bytes; nfo.sizes = nfoStats.sizes; nfo.photoBytes = nfoStats.photoBytes; nfo.counts = nfoStats.counts;
        }
        return json({ ok: nfo.success === true && nfoActor.ok !== false, success: nfo.success === true && nfoActor.ok !== false, found: !!nfo.found,
          at: nfo.at || '', version: nfo.version || '', bytes: nfo.bytes || 0,
          sizes: nfo.sizes || null, photoBytes: nfo.photoBytes || 0, counts: nfo.counts || null,
          stagingRows: nfo.stagingRows || 0, stagingBytes: nfo.stagingBytes || 0,
          staleRows: nfo.staleRows || 0, versions: nfo.versions || 0, error: nfo.error || '',
          /* ★ v2.8.1：分頁原行數＋後端版本 —— 收據要嚟分「真係空」定「有行但讀唔到」。 */
          simpleRows: nfo.simpleRows || 0, blobRows: nfo.blobRows || 0,
          backendVersion: nfo.backendVersion || BACKEND_VERSION,
          /* ★ v2.8.0：話畀前端知呢個後端識「簡單寫入」（逐表寫）——
             前端見到 true 就會改行 saveTables／loadTables；舊後端冇呢個欄位
             → 前端照行舊嘅整份 saveDb，唔使改設定、唔會斷。 */
          simpleWrite: true, mode: nfo.mode || 'blob', broken: nfo.broken || [] });
      }
      /* 自 v2.6.0 起：分段讀取 —— 每次淨係回一段純文字，唔會撞代理 4.5MB 回應上限 */
      if (body.action === 'loadDbPart') {
        var lpBase = loadDb(textOf(body.unit));
        var lpActor = lpBase.db ? staffActorFromAuth_(lpBase.db, dbSession) : { ok: true, role: dbSession.role, setup: dbSession.setup };
        var lp = lpActor.ok ? staffLoadDbPart_(textOf(body.unit), body.partIdx, lpActor) : { success: false, error: lpActor.error };
        return json({ ok: lp.success === true, success: lp.success === true, found: !!lp.found,
          part: lp.part || '', partIdx: lp.partIdx || 0, parts: lp.parts || 0, bytes: lp.bytes || 0,
          at: lp.at || '', version: lp.version || '', error: lp.error || '' });
      }
      var ld = loadDb(textOf(body.unit));
      var ldActor = ld.db ? staffActorFromAuth_(ld.db, dbSession) : { ok: true, role: dbSession.role, setup: dbSession.setup };
      var ldDb = ld.db && ldActor.ok ? staffSafeDb_(ld.db, ldActor) : null;
      return json({ ok: ld.success === true && ldActor.ok !== false, success: ld.success === true && ldActor.ok !== false, found: !!ld.found,
        db: ldDb, at: ld.at || '', version: ld.version || '', bytes: ldDb ? JSON.stringify(ldDb).length : 0,
        stagingRows: ld.stagingRows || 0, stagingBytes: ld.stagingBytes || 0,
        staleRows: ld.staleRows || 0, versions: ld.versions || 0, brokenNewer: ld.brokenNewer || 0,
        error: ld.error || '' });
    }

    /* ---- 個人進度 bridge：只回指定 YMIS；公開 caller 冇 API Key／link signature 入唔到。 */
    if (body.action === 'loadMine') {
      var mineAuth = requireAuth(expectedKey, key);
      if (!mineAuth.ok) return json(mineAuth);
      var mineData = loadMineProgress(textOf(body.ymis));
      return json({ ok: mineData.success === true, success: mineData.success === true,
        member: mineData.member || null, members: mineData.members || [],
        progress: mineData.progress || {}, flatProgress: mineData.flatProgress || {},
        otherBadges: mineData.otherBadges || {}, logs: mineData.logs || [],
        logRequests: mineData.logRequests || [], requests: mineData.requests || [],
        at: mineData.at || '', error: mineData.error || '' });
    }

    /* ---- 進度追蹤：POST 讀（doGet ?action=load 之外，供同源 server proxy
       以用途分隔 HMAC 驗證同一個 load 業務 action）---- */
    if (body.action === 'load') {
      var loadAuth = requireAuth(expectedKey, key);
      if (!loadAuth.ok) return json(loadAuth);
      var lpData = loadProgressData();
      lpData.success = true; lpData.ok = true;
      return json(lpData);
    }

    /* ---- 進度追蹤（同 BADGE 共用同一個後端；API Key 只作 server HMAC／routing）---- */
    if (body.action === 'save' || body.action === 'saveOtherBadge') {
      var progressAuth = requireAuth(expectedKey, key);
      if (!progressAuth.ok) return json(progressAuth);
      if (body.action === 'save') {
        var pr = withLock(function () { return saveProgress(body.changes || [], body.confirmer || ''); });
        return json({ ok: pr.success === true, success: pr.success === true, processed: pr.processed || 0, error: pr.error || '' });
      }
      var pbo = withLock(function () { return saveOtherBadges(body.records || []); });
      return json({ ok: pbo.success === true, success: pbo.success === true, processed: pbo.processed || 0, error: pbo.error || '' });
    }

    /* ---- 審批中心（執委系統內直接批；使用者身份由 session 固定）---- */
    if (body.action === 'reviewRequest' || body.action === 'reviewLogRequest') {
      var reviewAuth = requireAuth(expectedKey, key);
      if (!reviewAuth.ok) return json(reviewAuth);
      if (body.action === 'reviewRequest') {
        var rq = withLock(function () {
          return reviewProgressRequest(body.request_id, body.decision, body.review_note,
            body.reviewer || '深資童軍管理系統', body.confirmed_date);
        });
        return json({ ok: rq.success === true, success: rq.success === true,
          message: rq.message || '', error: rq.error || '' });
      }
      var lq = withLock(function () {
        return reviewLogRequest(body.request_id, body.decision, body.review_note, body.reviewer || '深資童軍管理系統');
      });
      return json({ ok: lq.success === true, success: lq.success === true,
        message: lq.message || '', record_id: lq.record_id || '', error: lq.error || '' });
    }

    /* 匿名通告／團章 API 已刪除；內容只經已核實 hubLoad 投影提供。 */

    if (body.action === 'verifySetupKey') {
      if (expectedKey && key !== expectedKey) {
        return json({ ok: false, success: false, error: '未授權：API Key 唔正確' });
      }
      var setupVerified = verifySetupKey(body.key || body.setupKey || '');
      if (setupVerified.success !== true && setupVerified.ok !== true) return json(setupVerified);
      var setupSession = issueAuthSession(textOf(body.unit), { id: 'setup', pv: 1 }, 'setup');
      setupVerified.ok = true; setupVerified.success = true;
      setupVerified.sessionToken = setupSession.token;
      setupVerified.sessionExpiresAt = setupSession.expiresAt;
      return json(setupVerified);
    }
    if (body.action === 'ping') return json({ ok: true, msg: 'pong', unit: body.unit, at: body.at });
    /* ---- 個人化通告訂閱：只保存帳戶自己的訂閱偏好，不接受前端 memberId 冒認 ---- */

    /* 舊匿名 noticeSignup／claim 入口已刪除；個人提交必須使用 opaque member session。 */
    /* ---- 已登入 staff 相片上 Drive（v2.3.0）----
       同時要求 server API Key 與 staff session；只存檔回連結，唔會寫任何報表行
       （報表行由 syncAll 負責）。 */
    if (body.action === 'uploadPhotos') {
      var uploadAuth = requireAuth(expectedKey, key); if (!uploadAuth.ok) return json(uploadAuth);
      var uploadSession = requireStaffSession(body, 3, true); if (!uploadSession.ok) return json(uploadSession);
      var upPhotos = (body.payload && body.payload.photos) || [];
      var links = savePhotos(upPhotos, textOf(body.unit), textOf(body.payload && body.payload.id) || 'x', textOf(body.folderId));
      return json({ ok: true, links: links, saved: links.length, asked: upPhotos.length });
    }

    /* 舊匿名 loan 入口已刪除。 */
    if (body.action === 'sync') {
      if (body.db && typeof body.db === 'object') return json({ ok:false, success:false, error:'請先使用 saveDb 或 saveTables 儲存資料，再同步報表' });
      var syncAuth = requireAuth(expectedKey, key);
      if (!syncAuth.ok) return json(syncAuth);
      var syncSession = requireStaffSession(body, 3, true);
      if (!syncSession.ok) return json(syncSession);
      var counts = withLock(function () {
        if (body.db && typeof body.db === 'object') {
          var syncPrepared = prepareAuthorizedAdminWrite_(body.unit, body.db, syncSession, false);
          if (syncPrepared.success !== true) return { __protectedWrite: syncPrepared };
          body.db = syncPrepared.db;
          var syncGuard = validateProtectedAdminWrite_(body.unit, body.db, syncSession);
          if (syncGuard.success !== true) return { __protectedWrite: syncGuard };
        }
        return syncAll(body);
      });
      if (counts && counts.__protectedWrite) return json(counts.__protectedWrite);
      /* 有帶整份資料庫就順便存埋（一次過搞掂「睇得到嘅報表」＋「讀得返嘅資料庫」） */
      var dbSaved = null;
      if (body.db && typeof body.db === 'object') {
        var syncDbAuth = requireAuth(expectedKey, key);
        if (!syncDbAuth.ok) return json(syncDbAuth);
        dbSaved = withLock(function () {
          var syncDbGuard = validateProtectedAdminWrite_(body.unit, body.db, syncSession);
          return syncDbGuard.success === true ? saveDb(body) : syncDbGuard;
        });
      }
      return json({ ok: true, msg: '已寫入總表', counts: counts, unit: body.unit, at: body.at,
        db: dbSaved ? { saved: dbSaved.success === true, conflict: dbSaved.conflict === true, chunks: dbSaved.chunks || 0, bytes: dbSaved.bytes || 0, error: dbSaved.error || '' } : null });
    }
    /* ---- 團員個人 bridge：唔再接受公開 caller 任填 YMIS。
       同源 /api/progress 先用 session 對出本人，再以 server-side API Key／link signature 到達呢度。 */
    if (body.action === 'addRequest') {
      var addReqAuth = requireAuth(expectedKey, key);
      if (!addReqAuth.ok) return json(addReqAuth);
      var ar = withLock(function () { return addProgressRequest(body); });
      return json({ ok: ar.success === true, success: ar.success === true, request_id: ar.request_id || '', error: ar.error || '' });
    }
    if (body.action === 'myRequests') {
      var myReqAuth = requireAuth(expectedKey, key);
      if (!myReqAuth.ok) return json(myReqAuth);
      return json(loadMyRequests(textOf(body.ymis)));
    }
    /* 獨立讀寫自測：唔使有帳戶或舊資料；只寫臨時記號，立即讀回再清走。
       API Key 仍只由同源代理注入，與 VSBADGE 相同的配置方式。 */
    if (body.action === 'syncCheck') {
      var checkAuth = requireAuth(expectedKey, key);
      if (!checkAuth.ok) return json(checkAuth);
      var checkSession = requireStaffSession(body, 3, true);
      if (!checkSession.ok) return json(checkSession);
      var checked = withLock(function () { return checkSheetWriteRead(textOf(body.unit)); });
      return json(checked);
    }
    if (body.action === 'status' || body.action === 'test') {
      /* ★ 初始化狀態（學 VSBADGE）：分清楚「貼咗新 Code.gs」同「真係行咗 initializeSheets()」。
         淨貼新 code 唔會自動寫 INITIALIZED_VERSION，所以 initializeRequired 會係 true。 */
      var initSt = initializationStatus();
      return json({
        ok: true, msg: '深資童軍管理系統 後端正常',
        spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName(),
        tabs: SHEET_TABS, backendVersion: BACKEND_VERSION, simpleWrite: true,
        initializedVersion: initSt.initializedVersion,
        initializationCurrent: initSt.initializationCurrent,
        initializeRequired: initSt.initializeRequired,
        at: new Date()
      });
    }
    /* ★ v2.7.2：一鍵修復（清暫存垃圾行 ＋ 舊版本段）—— 見上面 repairDb。
       要 API Key（會刪行，雖然只刪垃圾）。 */
    if (body.action === 'repairDb') {
      var repairAuth = requireAuth(expectedKey, key);
      if (!repairAuth.ok) return json(repairAuth);
      var repairSession = requireStaffSession(body, 4, false);
      if (!repairSession.ok) return json(repairSession);
      var repaired = withLock(function () { return repairDb(textOf(body.unit)); });
      return json({ ok: true, success: true, repaired: repaired });
    }
    /* ★ v2.7.2：強制用呢部機嘅資料覆蓋後端（人手搶救；見 saveDb 嘅 force 註解） */
    if (body.action === 'saveDbForce') {
      var forceAuth = requireAuth(expectedKey, key);
      if (!forceAuth.ok) return json(forceAuth);
      var forceSession = requireStaffSession(body, 4, false);
      if (!forceSession.ok) return json(forceSession);
      var forcedSaved = withLock(function () {
        var forcePrepared = prepareAuthorizedAdminWrite_(body.unit, body.db, forceSession, false);
        if (forcePrepared.success !== true) return forcePrepared;
        body.db = forcePrepared.db;
        var forceGuard = validateProtectedAdminWrite_(body.unit, body.db, forceSession);
        return forceGuard.success === true
          ? unifiedFinishRosterWrite_(saveDb({ unit: textOf(body.unit), db: body.db, baseVersion: '', force: true }), body.db.members, body.unit)
          : forceGuard;
      });
      return json(forcedSaved);
    }
    /* Legacy 非 Unified 入口旗標兼容：只供舊安全回歸，Progress client／API 不路由；
       Unified 公開 router 會拒絕兩個 action。未來旅系統 reader 不使用此契約。 */
    if (body.action === 'getLinkState') {
      var lsAuth = requireAuth(expectedKey, key);
      if (!lsAuth.ok) return json(lsAuth);
      var lsSession = requireStaffSession(body, 3, true);
      if (!lsSession.ok) return json(lsSession);
      return json(getLinkState());
    }
    if (body.action === 'setLocalLogin') {
      var slAuth = requireAuth(expectedKey, key);
      if (!slAuth.ok) return json(slAuth);
      var slSession = requireStaffSession(body, 4, false);
      if (!slSession.ok) return json(slSession);
      var rawAllow = String(body.allow || '').trim().toLowerCase();
      var allow = ['1', 'true', 'yes', 'on', 'open'].indexOf(rawAllow) >= 0;
      if (!allow && ['0', 'false', 'no', 'off', 'close', 'closed'].indexOf(rawAllow) < 0) {
        return json({ success: false, ok: false, error: '開關值唔正確（allow: true 開、false 閂）' });
      }
      PropertiesService.getScriptProperties().setProperty(LINK_FLAG, allow ? 'true' : 'false');
      return json({ success: true, ok: true, allow_local_login: allow,
        message: allow ? '支部本地登入已開啟' : 'legacy 入口旗標已關閉' });
    }
    // 兼容：冇 action 但係 82venture 嘅資料（當 sync）
    if (!body.action && body.tables) {
      var c2 = syncAll(body);
      return json({ ok: true, msg: '已寫入總表（無 action，當 sync）', counts: c2, unit: body.unit });
    }
    return json({ ok: false, error: '未知 action：' + body.action, got: Object.keys(body || {}), hint: '支援 action: ' + SUPPORTED_ACTIONS.join(' / ') });
  } catch (err) {
    if (err && err.code === 'LOCK_BUSY') {
      return json({ ok: false, success: false, error: '系統繁忙，請稍後重試', code: 'LOCK_BUSY' });
    }
    return json({ ok: false, error: String(err) });
  }
}

/** 收到 GET 時處理：?action=load 讀進度（多個 client 用同一份資料） */
function doGet(e) {
  var action = '';
  var supplied = '';
  try {
    action = String((e && e.parameter && e.parameter.action) || '');
    supplied = String((e.parameter && (e.parameter.apikey || e.parameter.apiKey)) || '');
  } catch (err0) { action = ''; }
  /* GET 不設匿名內容例外。 */
  if (!localLoginAllowed()) {
    return json(linkClosedResponse(action));
  }
  if (action === 'load') {
    var expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
    var getLoadAuth = requireAuth(expected, supplied);
    if (!getLoadAuth.ok) return json(getLoadAuth);
    var data = loadProgressData();
    data.success = true; data.ok = true;
    return json(data);
  }
  /* 行政資料讀取必須經 POST opaque staff session；API Key 單獨唔係用戶身份。 */
  if (action === 'loadDb' || action === 'dbInfo') {
    return json({ ok: false, success: false, code: 'SESSION_REQUIRED', error: '請由已登入系統讀取行政資料' });
  }
  return json({
    ok: true,
    msg: '深資童軍管理系統 後端已啟動',
    spreadsheet: (function () { try { return SpreadsheetApp.getActiveSpreadsheet().getName(); } catch (err) { return '(未綁定試算表)'; } })(),
    tabs: SHEET_TABS,
    api: ['ping', 'status', 'sync', 'saveDb', 'loadDb', 'dbInfo', 'hubLoad', 'load', 'save', 'saveOtherBadge'],
    usage: 'APP 內「資料管理 → 總表同步」填呢個 /exec 網址即可'
  });
}

/* ============================================================
   資料庫（整份資料）讀／寫 —— 真正嘅「後端儲存」
   ------------------------------------------------------------
   點解要呢個：其他分頁（帳目／團員…）係「攤平咗畀人睇」嘅報表，
   相片變咗數量、巢狀欄位變咗文字，讀返上去砌唔返原本嘅資料庫。
   所以整份 app 資料庫會原原本本序列化成 JSON，分段寫入「資料庫」分頁
   （每格上限 50000 字元，所以要分段）。
     寫：POST { action:'saveDb', unit, apiKey, db:{…} }
     讀：POST { action:'loadDb', unit, apiKey }   或 GET ?action=loadDb&unit=…&apikey=…
     睇：POST { action:'dbInfo', unit, apiKey }   → 只回 meta（幾時更新、幾大）
   ============================================================ */

var DB_CHUNK = 45000;          // 每格字元數（Sheet 單格上限 50000）
var DB_TAB = '資料庫';

function dbSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(DB_TAB);
  if (!sh) {
    sh = ss.insertSheet(DB_TAB);
    sh.appendRow(['旅團', '段號', '內容(JSON)', '更新時間', '版本']);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#7B2233').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 寫入整份資料庫（原子：先驗版本，再刪舊段，再寫新段）
 *  自 v2.2.0 起 樂觀鎖：body.baseVersion = 呢部機「上一次見過嘅後端版本」。
 *  後端已有版本而 baseVersion 對唔上（包括舊 app 冇送 baseVersion）
 *  → 拒絕寫入回 conflict:true，等 app 拉後端合併完再嚟。
 *  咁樣過時裝置（例如離線咗幾日嘅瀏覽器）就永遠唔會把另一部機
 *  啱啱同步嘅資料一鋪清空。baseVersion 同現版一致、或者後端本身
 *  仲係空（第一次存）→ 照樣接受。 */
function saveDb(body) {
  var unit = textOf(body.unit) || 'UNKNOWN';
  var db = body.db;
  if (!db || typeof db !== 'object') return { success: false, error: '冇收到資料庫內容（db）' };

  var text = JSON.stringify(db);
  if (text.length > 9000000) return { success: false, error: '資料太大（超過 9MB），請先喺 app 內清理相片' };

  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();

  /* 先睇而家後端有咩版本。
     ★ v2.7.0：要同讀取路（loadDb）用**同一套判斷** —— 如果最後一套段係
     寫到一半死咗（parse 唔到），以前會攞佢做「現行版本」，於是 app 拉返
     嘅係上一個完整版本，baseVersion 永遠對唔上 → 每次儲存都話「後端有較新版本」
     → 用家永遠儲存唔到（同「新儲嘅完全讀唔到」係同一個死法）。
     而家：攞「讀得到」嗰套嘅版本。 */
  /* ★ v2.8.0：版本鎖要對住**正本**。讀取一律以「資料表」为先，所以佢有嘢嗰陣
     版本就以佢為準 —— 否則一部淨係用新路線寫過嘅機，會令舊路線嘅 saveDb
     讀到「舊『資料庫』分頁冇版本」而以為冇衝突，盲蓋走新資料。 */
  var simpleNow = loadTables(unit);
  var curVersion = simpleNow.found ? (simpleNow.version || '') : (dbRawText(unit, true).version || '');
  var baseVersion = textOf(body.baseVersion);
  /* ★ v2.7.2：force（＝「用呢部機嘅資料修復後端」）。
     情況：後端資料讀唔到（幾套版本段／寫壞咗），只有一部機留住成份資料，
     但樂觀鎖會令佢永遠存唔入（baseVersion 對唔上讀唔到嘅版本）。
     呢個係**人手、明確**嘅搶救動作（app 要打字確認），所以准佢跳過版本核對；
     但仍然係「先刪舊段、再寫新段」嘅原子寫入，寫完之後所有人讀得到。 */
  var forced = body.force === true;
  if (curVersion && baseVersion !== curVersion && !forced) {
    return { success: false, conflict: true, version: curVersion,
      error: '後端已有較新版本（另一部機剛剛同步過）。唔敢用舊資料蓋上去 —— app 會自動拉後端合併後重存。' };
  }
  var overwroteVersion = forced ? curVersion : '';

  /* 自 v2.3.0 起：舊段成梳一次過刪（deleteRows）—— 以前逐行 deleteRow，
     200 段資料 = 200 次調用（每次成頁 shift），GAS 配額同時間都燒好快。
     v2.6.2：改用全後端唯一嘅 deleteRowRuns（同 cleanStaging 同一套邏輯）。 */
  var oldRows = [];
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== unit) continue;
    oldRows.push(i + 1);
  }
  /* 舊 blob 留到新版本寫好並驗收先刪，避免寫到一半時整份資料變空。 */

  var now = new Date();
  /* 自 v2.2.0 起：版本由**伺服器**派（ISO 時間＋隨機尾數）。
     唔好用 db.meta.updatedAt 做版本 —— 佢只有分鐘精度，兩部機同一分鐘內
     先後存，版本字串會撞到一樣，樂觀鎖就會誤判「無衝突」，過時資料
     又可以盲蓋上去（2026-09-18 事故嘅隱藏版）。 */
  var version = now.toISOString() + '-' + Math.floor(Math.random() * 100000);
  var chunks = [];
  for (var p = 0; p < text.length; p += DB_CHUNK) chunks.push(text.substring(p, p + DB_CHUNK));
  if (!chunks.length) chunks = ['{}'];

  var out = chunks.map(function (c, idx) { return [unit, idx + 1, c, now, version]; });
  writeUnitRowsAsText(sh, sh.getLastRow() + 1, out);
  var blobCheck = dbRawText(unit, true);
  if (blobCheck.version !== version || blobCheck.text !== text) {
    var rollback = sh.getDataRange().getValues(), undo = [];
    for (var bi = 1; bi < rollback.length; bi++) if (textOf(rollback[bi][0]) === unit && textOf(rollback[bi][4]) === version) undo.push(bi + 1);
    deleteRowRuns(sh, undo);
    return { success: false, error: '新資料庫未能完整讀回，原版本已保留' };
  }
  deleteRowRuns(sh, oldRows);

  /* ★ v2.8.0：舊路線寫完「資料庫」之後，**鏡像**去「資料表」分頁。
     因為讀取一律以「資料表」为先，唔鏡像嘅話舊路線（舊版前端／saveDbForce
     搶救上載）寫嘅嘢會讀唔到 —— 兩邊就會各睇各嘅。 */
  var mirrored = null;
  try { mirrored = saveTables({ unit: unit, tables: db, full: true, refreshReports: false }); } catch (mirrorErr) { /* 鏡像失敗唔阻斷主寫入 */ }

  if (!mirrored || !mirrored.success) return { success: false, writePending: true, error: '資料庫已寫入，但資料表鏡像失敗；請勿清除本機資料：' + (mirrored && mirrored.error || '後端異常') };

  /* ★ v2.6.3：一次儲存，兩處都寫 —— 順手刷新晒報表分頁（團員／帳目／物資…），
     團長開 Google Sheet 即刻睇到嘢，唔使再撳第二粒掣。 */
  var reports = body.refreshReports === false ? null : refreshReportsFromDb(db, unit);

  /* ★ v2.8.0：回俾前端嘅 version 一定要係**讀取路認嗰個**（＝「資料表」嘅版本）。
     因為 dbInfo／loadDb 一律以「資料表」为先，如果呢度回舊「資料庫」分頁嘅版本，
     前端下次攞佢做 baseVersion 就會永遠對唔上 → 每次儲存都話「後端有較新版本」
     → 用家永遠儲存唔到（同「新儲嘅完全讀唔到」係同一個死法）。 */
  var outVersion = (mirrored && mirrored.success && mirrored.version) ? mirrored.version : version;

  return { success: true, chunks: chunks.length, bytes: text.length, at: now, version: outVersion,
    blobVersion: version, reports: reports, forced: forced, overwroteVersion: overwroteVersion };
}

/** 由「資料庫」分頁把某旅團嘅所有段讀出嚟、拼返成份 JSON 純文字。
 *  自 v2.6.0 起 抽出嚟做共用：loadDb（一次過回成份）同 loadDbPart（分段回）
 *  一定要用**同一套**讀法，否則分段讀返嘅同整份讀返嘅會唔同 —— 咁樣
 *  「大資料庫分段讀」就會靜靜地讀到另一份資料，比讀唔到更危險。 */
function dbRawText(unit, strict) {
  unit = textOf(unit);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DB_TAB);
  if (!sh) return { found: false, text: '', at: '', version: '', stagingRows: 0, stagingBytes: 0, staleRows: 0, versions: 0, brokenNewer: 0, unitRows: 0 };
  var rows = sh.getDataRange().getValues();
  /* 自 v2.6.2 起：順手數一數「暫存垃圾行」—— 舊版 cleanStaging 漏刪留低嘅行
     （每行 45000 字）會令分頁越嚟越大，最後 saveDb／loadDb 撞 GAS
     執行時間／記憶體上限（症狀：儲存同讀取一齊死，但 status 話正常）。
     呢度本來就要讀成份分頁，所以順手数數係零成本；dbInfo 會報上去，
     app 嘅「同步診斷」見到就會叫人更新 Code.gs ＋ 執行 cleanStaleStaging()。 */
  var stagingRows = 0, stagingBytes = 0, unitRows = 0;

  /* ★ v2.7.0（2026-09-24 團長回報「加一項多一行…永遠只讀到之前儲嘅，
     新儲嘅完全讀唔到」）：**一定要按版本分組讀**。
     死因：同一個旅團嘅段（seq 1..N）如果因為任何原因出現兩套以上
     （舊版漏刪、手動貼上、同時寫入），以前就會將兩套**一齊**拼落去 ——
     拼出嚟嘅 JSON 一係 parse 唔到（= 讀唔到），一係「舊版本嘅行」先出現
     令用家見到永遠係以前嗰份。而家：每行都帶住寫入時嘅 version，
     同一版本 ＝ 同一套完整段，所以**只讀最新嗰一套**，
     舊嘅一套完全唔會混入。新儲嘅嘢因此一定讀得到。 */
  var groups = {};        // version → { parts:[], at:'' }
  var order = [];         // 版本出現次序（保存格仔由上而下：最新版本喺最底）
  var legacy = [];        // 冇版本欄嘅舊資料（v2.2.0 之前寫落嘅）
  var staleRows = 0;
  for (var i = 1; i < rows.length; i++) {
    var u = textOf(rows[i][0]);
    if (u === '__staging__') {           // 自 v2.4.0 起：分件暫存唔係正式資料
      stagingRows++;
      stagingBytes += String(rows[i][2] == null ? '' : rows[i][2]).length;
      continue;
    }
    /* ★ v2.8.1：unitRows＝呢個旅團喺「資料庫」分頁嘅原行數（唔計暫存行）。
       嚴格比對（唔理 strict 參數）—— dbInfo 要嚟答「後端分頁有冇呢個旅團嘅行」。 */
    if (u === unit) unitRows++;
    /* strict：只認同一個旅團（寫入路嘅版本檢查用）；否則舊行為（空旅團欄都算）。 */
    if (strict) { if (u !== unit) continue; }
    else { if (unit && u && u !== unit) continue; if (!unit && !u) continue; }
    var ver = textOf(rows[i][4]);
    var part = { seq: Number(rows[i][1]) || 0, text: String(rows[i][2] == null ? '' : rows[i][2]) };
    if (!ver) { legacy.push(part); continue; }
    if (!groups[ver]) { groups[ver] = { parts: [], at: '', atMs: 0 }; order.push(ver); }
    groups[ver].parts.push(part);
    if (rows[i][3]) {
      groups[ver].at = rows[i][3];
      var t = new Date(rows[i][3]).getTime();
      if (!isNaN(t)) groups[ver].atMs = t;
    }
  }

  /* 逐套版本砌返條文字（每套嘅段按 seq 排） */
  function textOfGroup(g) {
    var ps = g.parts.slice().sort(function (a, b) { return a.seq - b.seq; });
    return ps.map(function (p) { return p.text; }).join('');
  }
  var candidates = order.map(function (v) {
    return { version: v, at: groups[v].at, atMs: groups[v].atMs, rowsN: groups[v].parts.length, text: textOfGroup(groups[v]) };
  });
  /* 新→舊：先按寫入時間（有嘅話），再按分頁先後次序（新版本永遠喺最底） */
  candidates.sort(function (a, b) {
    if (a.atMs && b.atMs && a.atMs !== b.atMs) return b.atMs - a.atMs;
    return order.indexOf(b.version) - order.indexOf(a.version);
  });

  var at = '', version = '', text = '', brokenNewer = 0, picked = -1;
  for (var c = 0; c < candidates.length; c++) {
    try { JSON.parse(candidates[c].text); picked = c; break; }
    catch (e) { brokenNewer++; }         // 呢套讀唔到（寫入中斷／手動改壞）→ 試舊一套
  }
  if (picked >= 0) {
    version = candidates[picked].version;
    at = candidates[picked].at;
    text = candidates[picked].text;
    brokenNewer = picked;                // 放棄咗幾多套「較新但壞咗」嘅
    for (var c2 = 0; c2 < candidates.length; c2++) if (c2 !== picked) staleRows += candidates[c2].rowsN;
  } else if (candidates.length) {
    /* 每一套都 parse 唔到：照回最新嗰套（loadDb 會照樣報「內容壞咗），
       唔會靜靜哋當冇資料 —— 用家要用 JSON 備份還原。 */
    version = candidates[0].version;
    at = candidates[0].at;
    text = candidates[0].text;
  } else if (legacy.length) {
    text = legacy.slice().sort(function (a, b) { return a.seq - b.seq; })
      .map(function (p) { return p.text; }).join('');   // 未升級嘅舊資料：照舊讀
  }

  return {
    found: !!text, text: text, at: at, version: version,
    stagingRows: stagingRows, stagingBytes: stagingBytes,
    staleRows: staleRows, versions: candidates.length, brokenNewer: brokenNewer,
    unitRows: unitRows
  };
}

/* ★ v2.8.0：讀取一律以「資料表」分頁（逐表寫）为先，冇先至跌返去舊嘅
   「資料庫」整份 blob。呢個係**全後端唯一**嘅讀取入口 —— authLogin／claim／
   loan／notices／constitution／diag… 全部都經呢度，所以唔會出現
   「app 讀到新資料、公開頁讀到舊資料」呢種兩邊唔同步。 */
function dbReadRaw(unit) {
  var simple = loadTables(unit);
  if (simple.found || simple.rowCount) {
    if (simple.broken.length || !simple.found) return { found: true, broken: simple.broken, corrupt: true, text: '', version: simple.version, mode: 'simple' };
    return { found: true, text: JSON.stringify(simple.db), at: simple.at, version: simple.version,
      stagingRows: 0, stagingBytes: 0, staleRows: 0, versions: 1, brokenNewer: 0,
      broken: simple.broken || [], mode: 'simple' };
  }
  var blob = dbRawText(unit);
  blob.mode = blob.found ? 'blob' : 'empty';
  return blob;
}

/** 讀返整份資料庫（把所有段拼返） */
function loadDb(unit) {
  var raw = dbReadRaw(unit);
  if (!raw.found) {
    return { success: true, found: false, db: null, at: raw.at, version: raw.version, bytes: 0,
      stagingRows: raw.stagingRows, stagingBytes: raw.stagingBytes, staleRows: raw.staleRows,
      versions: raw.versions || 0, brokenNewer: raw.brokenNewer || 0, error: '' };
  }
  try {
    if (raw.corrupt) throw new Error('BROKEN_TABLES');
    return { success: true, found: true, db: JSON.parse(raw.text), at: raw.at, version: raw.version,
      bytes: raw.text.length, stagingRows: raw.stagingRows, stagingBytes: raw.stagingBytes,
      staleRows: raw.staleRows, versions: raw.versions || 0, brokenNewer: raw.brokenNewer || 0 };
  } catch (e) {
    return { success: false, found: true, db: null, error: '資料庫內容壞咗（JSON 解析失敗），請用 app 嘅 JSON 備份還原',
      stagingRows: raw.stagingRows, stagingBytes: raw.stagingBytes, staleRows: raw.staleRows,
      versions: raw.versions || 0, brokenNewer: raw.brokenNewer || 0 };
  }
}

/* 自 v2.6.0 起 分段讀取：Vercel 代理單一回應有 4.5MB 硬上限，
   loadDb 一次過回成份 JSON，資料庫一大就會 500 FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE
   （純文字，前端當「唔係 JSON」→ 誤判「呢個部署冇 /api」→ 對用家講「未設定後端網址」）。
   每段淨係回 LOAD_PART_CHARS 字純文字（約 1MB，留足水位），前端逐段拼返。
   每段都帶 version —— 前端逐段核對，讀緊嗰陣有人儲存咗就由頭再讀，
   唔會拼出半新半舊嘅 JSON（半新半舊會 JSON.parse 失敗，或者更差：parse 到但資料錯亂）。 */
var LOAD_PART_CHARS = 1000000;

/** 讀成份資料庫嘅其中一段（partIdx 由 0 起） */
function loadDbPart(unit, partIdx) {
  var idx = parseInt(partIdx, 10);
  if (isNaN(idx) || idx < 0) idx = 0;
  var raw = dbReadRaw(unit);      /* ★ v2.8.0：同 loadDb 用同一個入口（資料表優先） */
  if (!raw.found) {
    return { success: true, found: false, part: '', partIdx: idx, parts: 0, bytes: 0, at: raw.at, version: raw.version, error: '' };
  }
  if (raw.corrupt) return { success: false, found: true, error: '資料表有損壞的表（' + (raw.broken || []).join('、') + '），請修復或完整上載', version: raw.version };
  var total = raw.text.length;
  var n = Math.max(1, Math.ceil(total / LOAD_PART_CHARS));
  /* 段號超範圍：通常係讀緊嗰陣另一部機儲存咗、資料庫縮細咗。
     唔好靜靜地回空字串（前端會以為讀完）—— 明確報錯，等前端由頭再讀。 */
  if (idx >= n) {
    return { success: false, found: true, part: '', partIdx: idx, parts: n, bytes: total, at: raw.at, version: raw.version,
      error: '段號超出範圍（讀緊嗰陣資料庫變咗）—— 請由頭再讀' };
  }
  return {
    success: true, found: true,
    part: raw.text.substring(idx * LOAD_PART_CHARS, (idx + 1) * LOAD_PART_CHARS),
    partIdx: idx, parts: n, bytes: total, at: raw.at, version: raw.version, error: ''
  };
}

/* 自 v2.4.0 起 分件儲存：前端把 db 拆成 N 件逐件送（每件 < 3MB），
   件寫入「資料庫」分頁嘅暫存行（unit='__staging__'，version=saveId，
   seq = partIdx*100000 + chunkIdx），全部到齊後 saveDbCommit 原子式拼合。
   好處：旅團用幾十年、db 幾十 MB 都照存得到（行現有所有路徑，包括 proxy）。 */
function stagingRows(unit, saveId) {
  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== '__staging__') continue;
    var ver = textOf(rows[i][4]);
    if (saveId) { if (ver === saveId) out.push({ row: i + 1, seq: Number(rows[i][1]) || 0, text: String(rows[i][2] == null ? '' : rows[i][2]) }); }
    else if (!unit || ver.indexOf(unit + '-stg-') === 0) out.push({ row: i + 1, at: rows[i][3] });
  }
  return out;
}

function saveDbPart(body) {
  var unit = textOf(body.unit) || 'UNKNOWN';
  var data = body.data;
  var idx = Number(body.partIdx);
  var parts = Number(body.parts);
  if (!data || typeof data !== 'object') return { success: false, error: '冇收到分件內容（data）' };
  if (!Number.isFinite(idx) || idx < 0 || !parts || idx >= parts) return { success: false, error: '分件編號唔啱（partIdx/parts）' };
  var saveId = textOf(body.saveId);
  if (saveId.indexOf(unit + '-stg-') !== 0) return { success: false, error: 'saveId 唔啱格式' };

  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();

  /* 版本檢查：同 saveDb 一樣 —— 第一件就擋，唔會寫咗一半先知撞版 */
  var currentSimple = loadTables(unit);
  var curVersion = currentSimple.found ? currentSimple.version : (dbRawText(unit, true).version || '');
  var baseVersion = textOf(body.baseVersion);
  if (curVersion && baseVersion !== curVersion) {
    return { success: false, conflict: true, version: curVersion, error: '後端已有較新版本（另一部機剛剛同步過）' };
  }

  /* 過期暫存清走（90 分鐘前嘅）—— 唔會越積越多
     v2.6.2：改用 deleteRowRuns（同 cleanStaging 同一套邏輯，唔會漏刪） */
  var cutoff = Date.now() - 90 * 60 * 1000;
  var stale = stagingRows('');   // 全部暫存行（連 at）
  var dead = stale.filter(function (r) {
    var at = new Date(r.at || 0).getTime() || 0;
    return at && at < cutoff;
  }).map(function (r) { return r.row; });
  deleteRowRuns(sh, dead);

  var text = JSON.stringify(data);
  var chunks = [];
  for (var p2 = 0; p2 < text.length; p2 += DB_CHUNK) chunks.push(text.substring(p2, p2 + DB_CHUNK));
  if (!chunks.length) chunks = ['{}'];
  var now = new Date();
  var out = [];
  for (var c2 = 0; c2 < chunks.length; c2++) out.push(['__staging__', idx * 100000 + (c2 + 1), chunks[c2], now, saveId]);
  sh.getRange(sh.getLastRow() + 1, 1, out.length, 5).setValues(out);
  return { success: true, partIdx: idx, chunks: chunks.length };
}

function saveDbCommit(body, writeAuth) {
  var unit = textOf(body.unit) || 'UNKNOWN';
  var saveId = textOf(body.saveId);
  var parts = Number(body.parts);
  if (saveId.indexOf(unit + '-stg-') !== 0) return { success: false, error: 'saveId 唔啱格式' };

  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();

  /* commit 前最後一次版本檢查（v2.7.0：同讀取路一致 —— 用讀得到嗰套嘅版本） */
  var currentSimple = loadTables(unit);
  var curVersion = currentSimple.found ? currentSimple.version : (dbRawText(unit, true).version || '');
  var baseVersion = textOf(body.baseVersion);
  if (curVersion && baseVersion !== curVersion) {
    return { success: false, conflict: true, version: curVersion, error: '後端已有較新版本（另一部機剛剛同步過）' };
  }

  var got = stagingRows(unit, saveId);
  if (!got.length) return { success: false, error: '搵唔到暫存分件（可能已過期，請重新儲存）' };
  var byPart = {};
  got.forEach(function (r) {
    var idx = Math.floor(r.seq / 100000);
    (byPart[idx] = byPart[idx] || []).push(r);
  });
  var missing = [];
  for (var pi = 0; pi < parts; pi++) { if (!byPart[pi]) missing.push(pi); }
  if (missing.length) return { success: false, error: '缺少分件：' + missing.join(', ') + '（請重新儲存）' };

  /* 拼合：同一 key 所有件都係陣列 → 接駁（前端把大陣列拆件）；否則後件覆蓋 */
  var merged = {};
  var order = Object.keys(byPart).map(Number).sort(function (a, b) { return a - b; });
  order.forEach(function (pi2) {
    byPart[pi2].sort(function (a, b) { return a.seq - b.seq; });
    var partDb = JSON.parse(byPart[pi2].map(function (r) { return r.text; }).join(''));
    Object.keys(partDb).forEach(function (k) {
      var incoming = partDb[k];
      if (Array.isArray(incoming) && Array.isArray(merged[k])) merged[k] = merged[k].concat(incoming);
      else merged[k] = incoming;
    });
  });
  var preparedCommit = prepareAuthorizedAdminWrite_(unit, merged, writeAuth, false);
  if (preparedCommit.success !== true) return preparedCommit;
  merged = preparedCommit.db;
  var protectedCommit = validateProtectedAdminWrite_(unit, merged, writeAuth);
  if (protectedCommit.success !== true) return protectedCommit;
  merged = unifiedPrepareAdminDb_(merged);
  var text = JSON.stringify(merged);
  if (text.length > 40000000) { cleanStaging(sh, got); return { success: false, error: '拼合後太大（>40MB）' }; }

  /* 刪暫存＋舊段：**一次過**由底往上刪（v2.6.2）。
     以前係「先 cleanStaging(暫存)，再用上面讀返嘅行號刪舊段」——
     行號係**刪之前**計嘅：暫存行一旦喺舊段之上（上一次分件儲存中途死咗、
     之後又有普通儲存喺下面加咗行），刪完暫存所有行號就會向上移，
     第二輪 deleteRows 就指錯行 —— 輕則拋例外（儲存失敗），
     重則刪錯行 → 「資料庫」分頁剩返半新半舊嘅段 → loadDb 砌唔成 JSON
     → 後端讀唔到，之後每次儲存都話「未讀到後端版本，唔會盲寫」。 */
  var kill = [];
  got.forEach(function (r) { kill.push(r.row); });
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== unit) continue;
    kill.push(i + 1);
  }
  /* 先寫並驗新版本，再清舊 blob＋暫存；唔好先刪唯一一份完整資料。 */

  var now = new Date();
  var version = now.toISOString() + '-' + Math.floor(Math.random() * 100000);
  var chunks = [];
  for (var p3 = 0; p3 < text.length; p3 += DB_CHUNK) chunks.push(text.substring(p3, p3 + DB_CHUNK));
  if (!chunks.length) chunks = ['{}'];
  var out2 = [];
  for (var c3 = 0; c3 < chunks.length; c3++) out2.push([unit, c3 + 1, chunks[c3], now, version]);
  writeUnitRowsAsText(sh, sh.getLastRow() + 1, out2);
  var committedCheck = dbRawText(unit, true);
  if (committedCheck.version !== version || committedCheck.text !== text) {
    var rollback2 = sh.getDataRange().getValues(), undo2 = [];
    for (var ci = 1; ci < rollback2.length; ci++) if (textOf(rollback2[ci][0]) === unit && textOf(rollback2[ci][4]) === version) undo2.push(ci + 1);
    deleteRowRuns(sh, undo2);
    return { success: false, error: '分件新版本未能完整讀回，原版本已保留' };
  }
  deleteRowRuns(sh, kill);

  var mirrored2 = null;
  try { mirrored2 = saveTables({ unit: unit, tables: merged, full: true, refreshReports: false }); } catch (mirrorErr2) { /* 鏡像失敗唔阻斷 */ }
  if (!mirrored2 || !mirrored2.success) return { success: false, writePending: true, error: '資料庫已寫入，但資料表鏡像失敗；請勿清除本機資料：' + (mirrored2 && mirrored2.error || '後端異常') };
  /* ★ v2.6.3：分件儲存都要一次過做齊兩處（呢度先至有成份拼合好嘅資料庫） */
  var reports2 = body.refreshReports === false ? null : refreshReportsFromDb(merged, unit);
  /* 同 saveDb 一樣：回讀取路認嗰個版本 */
  var outVersion2 = (mirrored2 && mirrored2.success && mirrored2.version) ? mirrored2.version : version;

  return unifiedFinishRosterWrite_({ success: true, chunks: chunks.length, bytes: text.length, at: now, version: outVersion2,
    blobVersion: version, parts: parts, reports: reports2 }, merged.members, unit);
}

/* 自 v2.6.2 起：把一批行號計成一梳一梳、由最底嗰梳刪起（全後端唯一嘅刪行方法）。
   一次過 deleteRows 而唔係逐行 deleteRow：200 段資料逐行刪 ＝ 200 次調用
   （每次成頁 shift），GAS 配額同執行時間都燒好快（v2.3.0 起）。

   ★ 點解一定要**一個**方法、**一次過**刪晒（v2.6.2，團長回報「儲存唔到去
     後端／後端讀取唔到」查到）：
     ① 舊 cleanStaging 係「把梳嘅起點向上移」但**冇**把梳長 +1 ——
        一梳連續暫存行最後淨係刪到**一行**，其餘 N-1 行全部留喺
        「資料庫」分頁。分件儲存一次就留低成份資料庫嘅垃圾行
        （每行 45000 字），每次儲存又留多一份 —— Sheet 越嚟越大，
        每次 getValues() 越來越慢，最後 saveDb／loadDb 撞 GAS
        執行時間／記憶體上限：讀寫一齊死。
     ② 「先刪暫存、再用之前讀返嘅行號刪舊段」係錯嘅：刪咗暫存之後
        所有行號會向上移，第二輪就用錯行號（見 saveDbCommit）。 */
function deleteRowRuns(sh, rowNos) {
  var list = [];
  (rowNos || []).forEach(function (n) {
    var v = Number(n);
    if (Number.isFinite(v) && v >= 1) list.push(v);
  });
  if (!list.length) return 0;
  list.sort(function (a, b) { return a - b; });
  var runs = [];
  list.forEach(function (rowNo) {
    if (runs.length && runs[runs.length - 1][0] + runs[runs.length - 1][1] === rowNo) runs[runs.length - 1][1]++;
    else runs.push([rowNo, 1]);
  });
  for (var i = runs.length - 1; i >= 0; i--) sh.deleteRows(runs[i][0], runs[i][1]);
  return list.length;
}

function cleanStaging(sh, rowsArr) {
  return deleteRowRuns(sh, (rowsArr || []).map(function (r) { return r.row; }));
}

/** 自 v2.6.2 起 逃生門：一次過清走「資料庫」分頁入面所有 __staging__ 暫存行。
 *  舊版（v2.6.1 之前）cleanStaging 漏刪留低嘅垃圾行，每行 45000 字 ——
 *  分件儲存存過幾次，「資料庫」分頁就會塞滿成份資料庫嘅複製品，
 *  每次 getValues() 越嚟越慢，最後 saveDb／loadDb 撞 GAS 執行時間／記憶體上限
 *  （症狀：「儲存唔到去後端／後端讀取唔到」，但 status 話正常）。
 *  貼咗新版 Code.gs 之後，喺 Apps Script 編輯器執行一次
 *  cleanStaleStaging() 即刻清乾淨；正常儲存唔會再產生垃圾行。
 *  正式資料（unit ＝ 旅團編號嘅行）一行都唔會掂。 */
function cleanStaleStaging() {
  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();
  var dead = [];
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== '__staging__') continue;
    dead.push(i + 1);
  }
  var n = deleteRowRuns(sh, dead);
  var left = Math.max(0, sh.getLastRow() - 1);
  Logger.log('cleanStaleStaging：清走 ' + n + ' 行暫存垃圾，「資料庫」分頁剩返 ' + left + ' 行');
  return { ok: true, removed: n, rowsLeft: left };
}

/**
 * ★ v2.7.0 逃生門（2026-09-24 團長回報「加一項多一行…新儲嘅完全讀唔到」）：
 * 清走「資料庫」分頁入面**同一旅團嘅舊版本段**，只留最新版本嗰一套。
 *
 * 點解會有舊版本段：
 *   正常保存（saveDb／saveDbCommit）會先刪走該旅團所有舊段再寫新段，
 *   所以永遠只有一套。但如果曾經用過舊版 Code.gs（v2.6.1 之前有刪行 bug）、
 *   又或者有人手動喺分頁加過行、或者兩個部署同時寫入，就會出現兩套以上。
 *   以前嘅讀法係「同一個旅團所有段一齊拼」→ 拼出嚟一係壞咗（讀唔到），
 *   一係永遠讀到舊嗰套（新儲嘅嘢好似冇咗）。而家讀法已經按版本分組
 *   （只讀最新一套），呢個函數係**額外**幫你執靚個分頁。
 *
 * 喺 Apps Script 編輯器執行一次就得；正式資料（最新版本嗰套）一行都唔會掂。
 */
function pruneOldDbVersions() {
  var sh = dbSheet();
  var rows = sh.getDataRange().getValues();
  /* 逐個旅團分組：version → { parts: [{seq,text}], atMs, first } */
  var byUnit = {};
  for (var i = 1; i < rows.length; i++) {
    var u = textOf(rows[i][0]);
    if (!u || u === '__staging__') continue;
    var ver = textOf(rows[i][4]);
    if (!ver) continue;                       // 冇版本欄嘅遠古資料：唔敢判斷新舊，唔刪
    var when = rows[i][3] ? new Date(rows[i][3]).getTime() : 0;
    if (isNaN(when)) when = 0;
    var bu = byUnit[u] || (byUnit[u] = { order: [], groups: {} });
    if (!bu.groups[ver]) { bu.groups[ver] = { parts: [], atMs: when }; bu.order.push(ver); }
    if (when >= bu.groups[ver].atMs) bu.groups[ver].atMs = when;
    bu.groups[ver].parts.push({ seq: Number(rows[i][1]) || 0, text: String(rows[i][2] == null ? '' : rows[i][2]) });
  }
  /* ★ v2.7.2：要留嘅係「最新一套**讀得到**嘅段」——
     以前淨係按時間留最新，如果最新嗰套寫到一半（parse 唔到），就會
     把**唯一一套好嘅資料刪走**（＝修復反而變成資料損失）。
     而家：先按時間排序，揀最新一套砌得返 JSON 嘅；如果全部都砌唔返，
     一套都唔刪（留低俾人用 JSON 備份／版本記錄救）。 */
  var keeper = {};        // unit → version（要留）
  var skipped = [];       // 全部壞 → 唔敢刪
  Object.keys(byUnit).forEach(function (unit) {
    var bu = byUnit[unit];
    var cands = bu.order.map(function (v) {
      var ps = bu.groups[v].parts.slice().sort(function (a, b) { return a.seq - b.seq; });
      return { v: v, atMs: bu.groups[v].atMs, idx: bu.order.indexOf(v), text: ps.map(function (x) { return x.text; }).join('') };
    });
    cands.sort(function (a, b) {
      if (a.atMs && b.atMs && a.atMs !== b.atMs) return b.atMs - a.atMs;
      return b.idx - a.idx;
    });
    for (var k = 0; k < cands.length; k++) {
      var goodSet = false;
      try { JSON.parse(cands[k].text); goodSet = true; } catch (e0) { goodSet = false; }
      if (goodSet) { keeper[unit] = cands[k].v; return; }
    }
    skipped.push(unit);
  });

  var dead = [];
  for (var j = 1; j < rows.length; j++) {
    var u2 = textOf(rows[j][0]);
    if (!u2 || u2 === '__staging__') continue;
    var ver2 = textOf(rows[j][4]);
    if (!ver2 || !keeper[u2]) continue;       // 冇 keeper（全部壞／冇版本）→ 一律唔刪
    if (ver2 !== keeper[u2]) dead.push(j + 1);
  }
  var n = deleteRowRuns(sh, dead);
  Logger.log('pruneOldDbVersions：清走 ' + n + ' 行舊版本段，「資料庫」分頁剩返 ' + Math.max(0, sh.getLastRow() - 1) + ' 行'
    + (skipped.length ? '（有 ' + skipped.length + ' 個旅團全部都讀唔到，冇刪）' : ''));
  return { ok: true, removed: n, rowsLeft: Math.max(0, sh.getLastRow() - 1), kept: keeper, skipped: skipped };
}

/* ★ v2.8.1：清「資料表」分頁嘅舊套。正常 saveTables 每次寫完會刪舊，
   所以每個表應該得一套；但如果寫到一半斷過（GAS 逾時／撞鎖／兩個部署同時寫），
   就會留低兩套 —— 讀取雖然識揀新嗰套，但分頁會越嚟越大。
   呢度逐個表只留「最新一套砌得返 JSON」嘅段；全部砌唔返就唔刪（留低救）。 */
function pruneOldSimpleVersions() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SIMPLE_TAB);
  if (!sh) return { ok: true, removed: 0 };
  var rows = sh.getDataRange().getValues();
  var byUnit = {};    // unit → table → ver → { parts, lastRow }
  for (var i = 1; i < rows.length; i++) {
    var u = textOf(rows[i][0]);
    if (!u) continue;
    var t = textOf(rows[i][1]);
    if (!t) continue;
    var v = textOf(rows[i][5]) || '_';
    var bu = byUnit[u] || (byUnit[u] = {});
    var bt = bu[t] || (bu[t] = {});
    var g = bt[v] || (bt[v] = { parts: [], lastRow: 0 });
    g.parts.push({ seq: Number(rows[i][2]) || 0, text: String(rows[i][3] == null ? '' : rows[i][3]) });
    if (i > g.lastRow) g.lastRow = i;
  }
  var killKeys = {};
  Object.keys(byUnit).forEach(function (u) {
    Object.keys(byUnit[u]).forEach(function (t) {
      var vers = Object.keys(byUnit[u][t]);
      if (vers.length <= 1) return;
      /* 跟讀取入口一致：新版本可以比舊版本短，唔好用段數判斷新舊。 */
      vers.sort(function (a, b) {
        var ma = /^S([0-9a-z]+)-/.exec(a), mb = /^S([0-9a-z]+)-/.exec(b);
        if (ma && mb && ma[1] !== mb[1]) return parseInt(mb[1], 36) - parseInt(ma[1], 36);
        return byUnit[u][t][b].lastRow - byUnit[u][t][a].lastRow;
      });
      var keeper = '';
      for (var k = 0; k < vers.length; k++) {
        var ps = byUnit[u][t][vers[k]].parts.slice().sort(function (a, b) { return a.seq - b.seq; });
        if (!ps.every(function (p, i) { return p.seq === i + 1; })) continue;
        try { JSON.parse(ps.map(function (p) { return p.text; }).join('')); keeper = vers[k]; break; }
        catch (e0) { /* 壞嘅唔留 */ }
      }
      if (!keeper) return;   // 全部壞 → 唔敢刪
      vers.forEach(function (v) { if (v !== keeper) killKeys[u + '~|~' + t + '~|~' + v] = 1; });
    });
  });
  var dead = [];
  for (var j = 1; j < rows.length; j++) {
    var key = textOf(rows[j][0]) + '~|~' + textOf(rows[j][1]) + '~|~' + (textOf(rows[j][5]) || '_');
    if (killKeys[key]) dead.push(j + 1);
  }
  var n = deleteRowRuns(sh, dead);
  Logger.log('pruneOldSimpleVersions：清走 ' + n + ' 行舊套，「資料表」分頁剩返 ' + Math.max(0, sh.getLastRow() - 1) + ' 行');
  return { ok: true, removed: n };
}

/** ★ v2.7.2（2026-09-24 第三輪）：「無痕／其他人讀唔到後端」嘅**一鍵修復**。
 *
 *  症狀：團長自己部機睇得到（本機 localStorage 有份），但新裝置／無痕登入閘話
 *  「未能連線旅團後端」＝所有人一齊入唔到。
 *  兩個最常見嘅後端死因，都係**垃圾／舊段**留喺「資料庫」分頁：
 *    ① 舊版留低嘅 __staging__ 暫存行（分頁越嚟越大，最後 getValues 撞執行上限）；
 *    ② 同一旅團有兩套以上版本段（讀取會拼壞／永遠讀舊嗰套）。
 *  呢兩個都係「刪得安全」嘅：只刪暫存行同舊版本段，
 *  而且要留嘅係**最新一套砌得返 JSON** 嘅段（見 pruneOldDbVersions）——
 *  連「最新嗰套寫壞咗」都唔會誤刪唯一一套好嘅資料。
 */
function repairDb(unit) {
  var before = dbRawText(unit, false);
  var beforeSimple = loadTables(textOf(unit));
  var out = {
    ok: true,
    unit: textOf(unit),
    before: {
      found: !!before.found, version: before.version || '', bytes: (before.text || '').length,
      versions: before.versions || 0, staleRows: before.staleRows || 0,
      stagingRows: before.stagingRows || 0, brokenNewer: before.brokenNewer || 0,
      simpleRows: beforeSimple.rowCount || 0
    },
    removedStaging: 0, removedOldVersions: 0, removedOldSimple: 0,
    after: null, loadOk: false, loadError: ''
  };
  try {
    var st = cleanStaleStaging();
    out.removedStaging = Number(st.removed) || 0;
  } catch (e1) { out.stagingError = String((e1 && e1.message) || e1).slice(0, 160); }
  try {
    var pv = pruneOldDbVersions();
    out.removedOldVersions = Number(pv.removed) || 0;
    out.keptVersions = pv.kept || {};
    out.skippedUnits = pv.skipped || [];
  } catch (e2) { out.versionsError = String((e2 && e2.message) || e2).slice(0, 160); }
  /* ★ v2.8.1：順手清埋「資料表」分頁嘅舊套（寫到一半斷咗留低嗰啲） */
  try {
    var ps = pruneOldSimpleVersions();
    out.removedOldSimple = Number(ps.removed) || 0;
  } catch (e3) { out.simpleVersionsError = String((e3 && e3.message) || e3).slice(0, 160); }
  var after = dbRawText(unit, false);
  var afterSimple = loadTables(textOf(unit));
  out.after = {
    found: !!after.found, version: after.version || '', bytes: (after.text || '').length,
    versions: after.versions || 0, staleRows: after.staleRows || 0,
    stagingRows: after.stagingRows || 0, brokenNewer: after.brokenNewer || 0,
    simpleRows: afterSimple.rowCount || 0
  };
  var ld = loadDb(unit);
  out.loadOk = ld.success === true && ld.found === true;
  out.loadError = ld.error || '';
  out.members = ld.success && ld.found && ld.db ? (ld.db.members || []).length : 0;
  return out;
}

/** 只睇 meta：後端有冇資料、幾時更新（唔會傳成份資料庫落嚟）。
 *  自 v2.3.0 起：附帶逐分頁體積（sizes，只計 JSON 字元長度）同相片 bytes ——
 *  app 用嚟畫「體積檢查」，等成團人用嗰陣知道邊個分頁食緊嘢。 */
/* ============================================================
   ★ v2.8.0「簡單寫入」—— 逐表寫、逐表讀
   ------------------------------------------------------------
   點解要呢條路（團長 2026-09-24 回報：「我完全唔知佢寫唔寫得入後端，
   寫得入又點解讀唔到」）：

   舊路線 saveDb 係「成份資料庫 → 一條大 JSON → 每段 45000 字 → 寫入
   『資料庫』分頁」，一次儲存要做晒呢幾件事：
     ① 讀成份分頁（幾 MB 文字）→ ② 對版本（樂觀鎖）→ ③ 刪晒舊段
     → ④ 寫晒新段 → ⑤ 再重刷全部報表分頁。
   任何一格出事（GAS 執行時間／代理 4MB 上限／版本對唔上／寫到一半斷），
   結果都係同一個：**成份資料庫讀唔到**，用家見到就係「後端仲未有資料庫」。

   VSBADGE（同一個團用緊、一路冇事）嘅做法係：
     **一個請求淨係寫一個表嗰幾行**，冇鎖、冇分段暫存、冇重刷報表、
     冇「成份 serialize」。一個表寫唔到，其餘表照樣讀得到 ——
     所以永遠唔會出現「一次失敗＝全部冇晒」。

   呢度照抄同一個思路，但**保留 app 原有嘅資料形狀**
   （成份資料庫嘅每一個 top-level key ＝ 一個「表」）：
     寫：POST { action:'saveTables', unit, tables:{ members:[…], transactions:[…] } }
         —— 前端淨係送「有改過」嗰幾個表
     讀：POST { action:'loadTables', unit }
         —— 逐表砌返，某個表壞咗淨係 skip 嗰個表（其餘照讀）

   兩個關鍵次序（同舊路線相反，呢兩點先係「唔會洗紀錄」嘅原因）：
     ① **先寫新、後刪舊** —— 舊 saveDb 係「先刪後寫」，中途斷就乜都冇；
        而家任何一刻都至少有一份完整嘢喺分頁度。
     ② **唔用樂觀鎖** —— 最後寫嗰個贏（同 VSBADGE 一樣）。
        樂觀鎖本意係「過時裝置唔好蓋走人哋嘅嘢」，但實戰入面佢嘅副作用係
        「後端一讀唔到版本，所有裝置都永遠存唔入」——呢個正正係團長撞到嘅嘢。
        防撞靠嘅係：寫入前後都由前端做三方比對（app 本身已經做緊）。

   舊嘅「資料庫」分頁**一行都唔會掂**（繼續留底做備份），
   所以就算新路線有乜事，舊資料都仲喺度。
   ============================================================ */
var SIMPLE_TAB = '資料表';
var SIMPLE_CHUNK = 45000;        // 同 DB_CHUNK：Sheet 單格上限 50000

function simpleSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SIMPLE_TAB);
  if (!sh) {
    sh = ss.insertSheet(SIMPLE_TAB);
    sh.appendRow(['旅團', '表名', '段號', '內容(JSON)', '更新時間', '版本']);
    sh.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#7B2233').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 旅團編號係識別字串（0082 != 82），必須在寫入之前把第一欄設為純文字。
 *  Google Sheet「自動」格式會將只含數字的字串轉成數字，令寫入後
 *  loadTables/dbRawText 用原編號讀唔返；只有 setValues 成功絕不等於同步成功。 */
function writeUnitRowsAsText(sh, firstRow, values) {
  if (!values.length) return;
  sh.getRange(firstRow, 1, values.length, 1).setNumberFormat('@');
  sh.getRange(firstRow, 1, values.length, values[0].length).setValues(values);
}

/** 一個細小、獨立的 Sheet 寫入／讀回測試，不碰正式資料或帳戶。
 *  攞 script lock 避免兩個人測試時互相刪除；即使測試失敗也清走臨時行。 */
function checkSheetWriteRead(unit) {
  if (!unit) return { ok: false, success: false, error: '欠缺旅團編號' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('連線測試');
  if (!sh) {
    sh = ss.insertSheet('連線測試');
    sh.appendRow(['旅團', '測試記號', '時間']);
  }
  var marker = Utilities.getUuid() + '-' + Date.now();
  var row = sh.getLastRow() + 1;
  var wrote = false;
  try {
    sh.getRange(row, 1, 1, 2).setNumberFormat('@');
    sh.getRange(row, 1, 1, 3).setValues([[unit, marker, new Date()]]);
    wrote = true;
    SpreadsheetApp.flush();
    var back = sh.getRange(row, 1, 1, 2).getValues()[0];
    var unitMatches = textOf(back[0]) === unit;
    var markerMatches = textOf(back[1]) === marker;
    var matched = unitMatches && markerMatches;
    return { ok: matched, success: matched, wrote: true, readBack: matched,
      spreadsheet: ss.getName(), backendVersion: BACKEND_VERSION,
      error: matched ? '' : '測試行已寫入，但讀回內容不一致（' +
        (!unitMatches ? '旅團編號欄' : '測試記號欄') + '）；請確認該欄位已設為純文字' };
  } catch (err) {
    return { ok: false, success: false, wrote: wrote, readBack: false,
      spreadsheet: ss.getName(), backendVersion: BACKEND_VERSION,
      error: '試算表讀寫失敗：' + String(err && err.message || err) };
  } finally {
    if (wrote) { try { sh.deleteRow(row); } catch (ignore) { /* 留住測試行供排查 */ } }
  }
}

/** 寫入幾個表（正常淨係寫「有改過」嗰啲） */
function saveTables(body) {
  var unit = textOf(body.unit) || 'UNKNOWN';
  var tables = body.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) return { success: false, error: '冇收到表內容（tables）' };

  /* 同一個 script lock 入面核對版本。前端三方合併後到實際寫入之前仍有競態；
     唔可以學舊版逐表寫直接 last-write-wins，否則另一部機的改動會消失。 */
  var before = loadTables(unit);
  var currentVersion = before.found ? before.version : (dbRawText(unit, true).version || '');
  if (Object.prototype.hasOwnProperty.call(body, 'baseVersion') &&
      textOf(body.baseVersion) !== currentVersion) {
    return { success: false, conflict: true, version: currentVersion,
      error: '後端已有較新版本，請重新讀取並合併後再儲存' };
  }
  if (before.broken.length && body.full !== true) {
    return { success: false, error: '後端有損壞的表（' + before.broken.join('、') + '），拒絕部分寫入；請先修復或完整上載' };
  }
  var sh = simpleSheet();
  var now = new Date();
  /* 呢次寫入嘅版本：時間（36 進位）＋隨機尾數 —— 字串可以直接排序比大小 */
  var previousMs = /^S([0-9a-z]+)-/.test(currentVersion) ? parseInt(currentVersion.split('-')[0].slice(1), 36) : 0;
  var saveId = 'S' + Math.max(now.getTime(), previousMs + 1).toString(36) + '-' + Math.floor(Math.random() * 100000);
  var out = [], saved = {}, bytes = 0, invalid = [];

  Object.keys(tables).forEach(function (name) {
    /* 表名白名單：只收英數底線，唔畀寫啲奇怪嘢入分頁 */
    if (!/^[A-Za-z0-9_]{1,40}$/.test(String(name))) { invalid.push(name); return; }
    var text;
    try { text = JSON.stringify(tables[name] === undefined ? null : tables[name]); }
    catch (e) { invalid.push(name); return; }
    if (text.length > 9000000) { invalid.push(name); return; }      // 單表大過 9MB 唔寫（要先做體積治理）
    bytes += text.length;
    var segs = [];
    for (var p = 0; p < text.length; p += SIMPLE_CHUNK) segs.push(text.substring(p, p + SIMPLE_CHUNK));
    if (!segs.length) segs = [text];
    segs.forEach(function (c, i) { out.push([unit, String(name), i + 1, c, now, saveId]); });
    saved[name] = { segs: segs.length, bytes: text.length };
  });
  if (invalid.length) return { success: false, error: '以下表未能寫入（名稱、格式或超過 9MB）：' + invalid.join('、'), missingTables: invalid };
  if (!out.length) return { success: false, error: '冇一個表寫得入（表名或者內容唔合規格）' };

  /* ① 先寫新 —— 寫完呢一步，分頁入面已經有完整嘅新資料 */
  writeUnitRowsAsText(sh, sh.getLastRow() + 1, out);
  /* 新表即使比舊表短（例如刪除大量團員，由兩段縮成一段），也要先驗收，
     不能用 loadTables 的「較長版本優先」來驗：那會錯誤讀回舊表。 */
  var stagedRows = sh.getDataRange().getValues();
  var stagedParts = {};
  stagedRows.slice(1).forEach(function (r) {
    if (textOf(r[0]) !== unit || textOf(r[5]) !== saveId) return;
    (stagedParts[textOf(r[1])] = stagedParts[textOf(r[1])] || []).push({ seq: Number(r[2]), text: String(r[3]) });
  });
  var namesToCheck = Object.keys(saved);
  var stagedOk = namesToCheck.every(function (name) {
    var parts = (stagedParts[name] || []).sort(function (a, b) { return a.seq - b.seq; });
    return parts.length === saved[name].segs && parts.every(function (p, i) { return p.seq === i + 1; }) &&
      parts.map(function (p) { return p.text; }).join('') === JSON.stringify(tables[name]);
  });
  if (!stagedOk) {
    var undo = [];
    for (var si = 1; si < stagedRows.length; si++)
      if (textOf(stagedRows[si][0]) === unit && textOf(stagedRows[si][5]) === saveId) undo.push(si + 1);
    deleteRowRuns(sh, undo);
    return { success: false, confirmed: false, error: '新表未完整寫入，舊版本已保留', missingTables: namesToCheck };
  }
  /* ② 後刪舊 —— 同一旅團＋同一個表、但唔係呢次 saveId 嘅行（即上一套） */
  var rows = sh.getDataRange().getValues();
  var kill = [];
  var names = Object.keys(saved);
  /* ★ body.full ＝ 呢次送嘅係**成份**資料庫嘅所有表（第一次寫入／整份鏡像）。
     咁樣先可以順手清走「已經冇咗嘅表」—— 否則頂層某個 key 消失咗，
     佢嘅行會永遠留喺分頁做幽靈，讀返嚟就多出啲早應該冇咗嘅資料。
     部份寫入（淨係改過嗰幾個表）唔可以咁做，否則會刪走今次冇送嘅表。 */
  var full = body.full === true;
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== unit) continue;
    var tname = textOf(rows[i][1]);
    if (textOf(rows[i][5]) === saveId) continue;
    if (!full && names.indexOf(tname) < 0) continue;
    kill.push(i + 1);
  }
  deleteRowRuns(sh, kill);

  /* ★ v2.8.1 自證：寫完即刻讀返 —— 證明呢次寫嘅行真係留喺分頁。
     （2026-09-25 團長：收據寫「寫入回傳成功，但核對嗰陣對唔上」，後端讀返係空。
       以前 saveTables 只要 setValues 冇拋例外就當成功，前端要到收據核對先知唔對路。
       而家後端自己驗一次：唔對路就直接回失敗，等前端保留 pending 再試，唔會假成功。） */
  var confirmRows = sh.getDataRange().getValues();
  var seenNew = {}, newRows = 0, unitRows = 0;
  for (var ci = 1; ci < confirmRows.length; ci++) {
    if (textOf(confirmRows[ci][0]) !== unit) continue;
    unitRows++;
    if (textOf(confirmRows[ci][5]) !== saveId) continue;
    newRows++;
    seenNew[textOf(confirmRows[ci][1])] = true;
  }
  var missing = names.filter(function (t) { return !seenNew[t]; });
  var verified = loadTables(unit);
  var confirmed = missing.length === 0 && newRows === out.length &&
    verified.broken.length === 0 &&
    names.every(function (name) { return JSON.stringify(verified.db && verified.db[name]) === JSON.stringify(tables[name]); });
  if (!confirmed) {
    return { success: false, confirmed: false, simpleRows: unitRows,
      tables: saved, bytes: bytes, at: now, version: '', missingTables: missing,
      writePending: true, error: '後端已嘗試寫入但未能核對，請重新讀取核實，勿盲目重送' };
  }

  /* ★ v2.8.1：一次儲存＝兩處都寫 —— 報表分頁喺同一次請求入面順手刷新。
     （以前逐表寫唔包報表，前端每次都要再發多一次 pushToMaster sync ——
       即係每次儲存＝兩次 GAS 執行＋兩行審計＋一行同步紀錄，「有幾頁不停在儲存」就係咁嚟。
       而家同 saveDb 睇齊：一次過做齊，前端見到 reports 就唔使再發第二次。）
     注意：呢次送嚟嘅 tables 可能淨係「改過嗰幾個」（partial），所以報表一定要用
     loadTables 讀返嚟嘅**成份**砌 —— 直接用 tables 砌會洗走冇送嚟嗰啲表嘅報表行！ */
  var reports = null;
  if (body.refreshReports !== false) {
    try {
      var fullNow = loadTables(unit);
      if (fullNow.found && fullNow.db) reports = refreshReportsFromDb(fullNow.db, unit);
      else reports = { ok: false, error: '寫入成功，但讀返成份資料庫失敗，報表未刷新' };
    } catch (repErr) {
      reports = { ok: false, error: String((repErr && repErr.message) || repErr).slice(0, 200) };
    }
  }

  return { success: true, tables: saved, bytes: bytes, at: now, version: saveId,
    confirmed: true, simpleRows: unitRows, reports: reports };
}

/** 讀返呢個旅團喺「資料表」分頁嘅所有表 */
function loadTables(unit) {
  unit = textOf(unit);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SIMPLE_TAB);
  if (!sh) return { success: true, found: false, db: null, tables: {}, broken: [], at: '', version: '', rowCount: 0 };

  var rows = sh.getDataRange().getValues();
  var byTable = {};
  var at = '', version = '';
  /* ★ v2.8.1：rowCount＝呢個旅團喺「資料表」分頁嘅原行數（砌得返砌唔返都計）。
     dbInfo 就算 found:false 都要報 ——「0 行」同「有行但讀唔到」係兩回事。 */
  var rowCount = 0;
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== unit) continue;
    rowCount++;
    var name = textOf(rows[i][1]);
    if (!name) continue;
    (byTable[name] = byTable[name] || []).push({
      seq: Number(rows[i][2]) || 0,
      text: String(rows[i][3] == null ? '' : rows[i][3]),
      at: rows[i][4] || '',
      row: i,                       /* 分頁上嘅位置：用嚟分「邊套先係最新寫入」 */
      ver: textOf(rows[i][5])
    });
    if (rows[i][4] && String(rows[i][4]) > String(at)) at = String(rows[i][4]);
    if (textOf(rows[i][5]) > version) version = textOf(rows[i][5]);
  }

  var db = {}, tables = {}, broken = [];
  Object.keys(byTable).forEach(function (name) {
    /* 正常同一個表只會有一套（舊嗰套寫入嗰陣已經刪咗）。
       萬一有兩套（例如上次寫到一半斷咗），淨係要**砌得返 JSON** 嗰套 ——
       另一套一定係半段，砌出嚟 parse 唔到，自然會被跳過。
       ★ 呢度就係同舊路線最大分別：壞一個表淨係唔要嗰個表，
         唔會連累成份資料庫讀唔到。 */
    var groups = {};
    byTable[name].forEach(function (p) {
      var g = groups[p.ver || '_'] = groups[p.ver || '_'] || [];
      g.push(p);
      g.lastRow = Math.max(g.lastRow || 0, p.row || 0);
    });
    var keys = Object.keys(groups);
    /* 以分頁中最後出現的版本為準；新資料縮短時段數會變少，不能以段數排序。
       若最新版本損壞，保留舊版供診斷，但標明 broken，前端不可把它當完整正本。 */
    keys.sort(function (a, b) {
      var ma = /^S([0-9a-z]+)-/.exec(a), mb = /^S([0-9a-z]+)-/.exec(b);
      if (ma && mb && ma[1] !== mb[1]) return parseInt(mb[1], 36) - parseInt(ma[1], 36);
      return groups[b].lastRow - groups[a].lastRow;
    });
    var newerBroken = false;
    for (var k = 0; k < keys.length; k++) {
      var ps = groups[keys[k]].slice().sort(function (a, b) { return a.seq - b.seq; });
      var text = ps.map(function (p) { return p.text; }).join('');
      if (!ps.every(function (p, i) { return p.seq === i + 1; })) { newerBroken = true; continue; }
      try {
        var val = JSON.parse(text);
        db[name] = val;
        tables[name] = Array.isArray(val) ? val.length : 1;
        if (newerBroken) broken.push(name);
        return;
      } catch (e) { newerBroken = true; /* 呢套砌唔成 → 試下一套 */ }
    }
    broken.push(name);
  });

  var found = Object.keys(db).length > 0;
  return { success: true, found: found, db: found ? db : null, tables: tables, broken: broken,
    at: at, version: version, rowCount: rowCount };
}

/** ★ v2.8.0 逐表讀：一個請求淨係攞**一個表**。
 *  成份資料庫大過代理回應上限（或者 loadTables 砌唔返）嗰陣，前端就一個表一個表攞。
 *  idx ＝ 第幾個表（表名排序）；回 { name, value, count }，idx 超出範圍就 success:false。
 *  broken 照樣如實報 —— 逐表讀唔可以因為「一個表一個表攞」就扮冇事。 */
function loadTablesPart(unit, idx) {
  var i = Math.max(0, parseInt(idx, 10) || 0);
  var all = loadTables(unit);
  if (all.broken.length) return { success: false, found: all.found, broken: all.broken, error: '資料表有損壞的表：' + all.broken.join('、') };
  if (!all.found) {
    return { success: true, found: false, idx: i, count: 0, name: '',
      broken: all.broken || [], at: all.at, version: all.version };
  }
  var names = Object.keys(all.db || {}).sort();
  if (i >= names.length) {
    return { success: false, found: true, idx: i, count: names.length, name: '',
      broken: all.broken || [], error: '表編號超出範圍', at: all.at, version: all.version };
  }
  var name = names[i];
  return { success: true, found: true, idx: i, count: names.length, name: name,
    value: all.db[name], broken: all.broken || [], at: all.at, version: all.version };
}

/** dbInfo／loadTables 共用：由成份資料庫計體積、相片體積、筆數 */
function dbStats(db) {
  db = db || {};
  var sizes = {}, photoBytes = 0;
  var keys = Object.keys(db).sort(function (a, b) {
    return JSON.stringify(db[b] || null).length - JSON.stringify(db[a] || null).length;
  });
  keys.slice(0, 14).forEach(function (k) { sizes[k] = JSON.stringify(db[k] || null).length; });
  (db.claims || []).forEach(function (c) {
    (c.photos || []).forEach(function (ph) {
      if (ph && ph.dataUrl) photoBytes += String(ph.dataUrl).length;
    });
  });
  return {
    bytes: JSON.stringify(db).length,
    sizes: sizes,
    photoBytes: photoBytes,
    counts: {
      members: (db.members || []).length,
      transactions: (db.transactions || []).length,
      meetings: (db.meetings || []).length,
      notices: (db.notices || []).length,
      invItems: (db.invItems || []).length,
      accounts: (db.accounts || []).length
    }
  };
}

/** ★ v2.8.1：先睇「資料表」分頁（簡單寫入），冇先至跌返去舊嘅「資料庫」整份 blob。
 *  mode：'simple'（行緊逐表寫）／'blob'（行緊整份 blob）／'empty'（兩邊都冇）。
 *  ★ 無論 found 定唔 found，都如實報 simpleRows（「資料表」原行數）／
 *  blobRows（「資料庫」原行數）／broken（砌唔返嘅表）—— 以前 found:false 嗰陣
 *  呢啲一律冇，前端見到「空」完全分唔開「分頁真係空」定「有行但讀唔到」。 */
function dbInfo(unit) {
  var simple = loadTables(unit);
  var simpleRows = simple.rowCount || 0;
  var broken = simple.broken || [];
  if (simple.found) {
    var a = dbStats(simple.db || {});
    /* ★ 逐表寫每個表得一套（寫完即刻刪舊），所以正本永遠係「1 套版本、0 舊段」。
       但舊「資料庫」分頁仍然留底 —— 佢入面嘅暫存垃圾行／舊版本段照樣如實報，
       因為 cleanStaleStaging()／pruneOldDbVersions() 清嘅就係嗰度，
       而萬一要跌返舊路線讀，嗰啲垃圾就即刻變成問題。唔報＝呃人。 */
    var legacy = dbRawText(unit);
    return { success: true, found: true, mode: 'simple', at: simple.at, version: simple.version,
      bytes: a.bytes, sizes: a.sizes, photoBytes: a.photoBytes, counts: a.counts,
      broken: broken, simpleRows: simpleRows, blobRows: legacy.unitRows || 0,
      backendVersion: BACKEND_VERSION,
      stagingRows: legacy.stagingRows || 0, stagingBytes: legacy.stagingBytes || 0,
      staleRows: legacy.staleRows || 0, versions: legacy.versions || 0 };
  }
  /* simple 冇嘢：直接讀舊 blob（上面已經讀過一次「資料表」，唔好經 loadDb 再讀多次） */
  var blob = dbRawText(unit);
  var blobRows = blob.unitRows || 0;
  if (!blob.found) {
    var e = dbStats({});
    return { success: true, found: false, mode: 'empty', at: '', version: '', bytes: e.bytes,
      sizes: e.sizes, photoBytes: e.photoBytes, counts: null,
      broken: broken, simpleRows: simpleRows, blobRows: blobRows,
      backendVersion: BACKEND_VERSION,
      stagingRows: blob.stagingRows || 0, stagingBytes: blob.stagingBytes || 0,
      staleRows: blob.staleRows || 0, versions: blob.versions || 0 };
  }
  var parsed;
  try { parsed = JSON.parse(blob.text); }
  catch (parseErr) {
    return { success: false, found: true, mode: 'blob',
      error: '資料庫內容壞咗（JSON 解析失敗），請用 app 嘅 JSON 備份還原',
      broken: broken, simpleRows: simpleRows, blobRows: blobRows,
      backendVersion: BACKEND_VERSION,
      stagingRows: blob.stagingRows || 0, stagingBytes: blob.stagingBytes || 0,
      staleRows: blob.staleRows || 0, versions: blob.versions || 0 };
  }
  var db = parsed || {};
  var b = dbStats(db);
  return {
    success: true, found: true, mode: 'blob', at: blob.at || '', version: blob.version || '', bytes: b.bytes,
    sizes: b.sizes, photoBytes: b.photoBytes, counts: b.counts,
    broken: broken, simpleRows: simpleRows, blobRows: blobRows,
    backendVersion: BACKEND_VERSION,
    /* 自 v2.6.2 起：舊版留低嘅暫存垃圾行（正常應該係 0）—— app 嘅「同步診斷」
       見到就會話你知要更新 Code.gs ＋ 執行 cleanStaleStaging() 清走。 */
    stagingRows: blob.stagingRows || 0, stagingBytes: blob.stagingBytes || 0,
    /* ★ v2.7.0：舊版本段（正常應該係 0）。讀取已經只讀最新一套，所以
       有舊段都唔會讀錯，但清走佢可以令分頁細啲、快啲。
       app 嘅「同步診斷」見到 > 0 會提你執行 pruneOldDbVersions()。 */
    staleRows: blob.staleRows || 0, versions: blob.versions || 0
  };
}

/* ============================================================
   主同步核心
   ============================================================ */

/** ★ v2.6.3：由成份資料庫攤平出報表分頁要嘅 tables（同前端 buildPayload 同一個意思）。
 *  注意：通告要保留 signups 原裝 —— writeSignups／writeNoticesFull 要用；
 *  相片／附件就只記數量（dataURL 唔應該寫落報表分頁）。 */
function tablesFromDb(db) {
  db = db || {};
  function rows(list) {
    return (list || []).map(function (r) {
      var o = {};
      for (var k in r) { if (r.hasOwnProperty(k)) o[k] = r[k]; }
      if (Object.prototype.toString.call(o.photos) === '[object Array]') o.photos = o.photos.length;
      if (Object.prototype.toString.call(o.attachments) === '[object Array]') o.attachments = o.attachments.length;
      return o;
    });
  }
  return {
    members: rows(db.members),
    transactions: rows(db.transactions),
    claims: rows(db.claims),
    invItems: rows(db.invItems),
    invLoans: rows(db.invLoans),
    meetings: rows(db.meetings),
    notices: db.notices || []
  };
}

/** ★ v2.6.3：一次儲存＝兩處都寫 —— 「資料庫」分頁（app 正本）＋報表分頁（人睇嗰啲）。
 *  報表刷新失敗唔應該令成次儲存變失敗（資料已經安全寫入「資料庫」分頁），
 *  所以呢度一律 try/catch，把結果如實報返上去。 */
function refreshReportsFromDb(db, unit) {
  if (!unit || unit === 'UNKNOWN') return null;
  try {
    var counts = syncAll({
      unit: unit,
      unitName: textOf(db && db.profile && db.profile.name) || textOf(db && db.unit && db.unit.name),
      tables: tablesFromDb(db)
    });
    return { ok: true, counts: counts };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

function unifiedReportNames_() {
  return ['帳目', '收支申報', '物資', '團員', '通告', '通告全文', '報名', '物資借用', '會議'];
}
function unifiedRememberReport_(sheet) {
  PropertiesService.getScriptProperties().setProperty('UNIFIED_REPORT_SHEET_' + sheet.getName(), String(sheet.getSheetId()));
}
function unifiedCheckReportOwnership_(ss) {
  var props = PropertiesService.getScriptProperties();
  var names = unifiedReportNames_();
  // Check every existing tab before touching any report, avoiding partial clears.
  names.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh && props.getProperty('UNIFIED_REPORT_SHEET_' + name) !== String(sh.getSheetId())) {
      throw new Error('已有報表分頁「' + name + '」未獲確認，已停止刷新以保留原有資料');
    }
  });
  names.forEach(function (name) {
    if (!ss.getSheetByName(name)) unifiedRememberReport_(ss.insertSheet(name));
  });
}
function syncAll(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  unifiedCheckReportOwnership_(ss);
  var unit = body.unit || 'UNKNOWN';
  var tables = body.tables || {};
  var schema = body.schema || {};
  var counts = {};

  // 帳目（合併「財務」）
  counts['transactions'] = writeTab(ss, body, '帳目', tables.transactions, schema.transactions, ['date', 'type', 'item', 'amount', 'category', 'method', 'byName', 'ref', 'period', 'note']);
  counts['claims'] = writeTab(ss, body, '收支申報', tables.claims, schema.claims, ['date', 'type', 'item', 'amount', 'category', 'byName', 'status', 'note']);
  counts['invItems'] = writeTab(ss, body, '物資', tables.invItems, schema.invItems, ['code', 'name', 'category', 'total', 'unit', 'location', 'condition', 'note']);
  counts['members'] = writeTab(ss, body, '團員', tables.members, schema.members, ['ymis', 'systemId', 'name', 'eng', 'identity', 'birthday', 'role', 'status', 'phone', 'email', 'join', 'note']);

  // 成員名單（行政、Progress 與 BADGE action 共用同一批人）
  counts['memberList'] = 0; // reports do not update the authoritative BADGE roster

  // 通告：一張通告一行
  counts['notices'] = writeTab(ss, body, '通告', tables.notices, schema.notices,
    ['title.zh', 'title.en', 'type', 'status', 'eventDate', 'deadline', 'venue', 'assembly', 'dismissal',
     'programme', 'dress', 'fee', 'quota', 'enquiry', 'publishAt']);

  // 通告全文（公開頁讀呢個分頁；只公開 status=published）
  counts['noticesFull'] = writeNoticesFull(ss, unit, tables.notices || []);

  // 報名：每一份報名一行（由通告內嘅 signups 攤開）
  counts['signups'] = writeSignups(ss, body, tables.notices || []);

  // 物資借用（借出／歸還紀錄）
  counts['invLoans'] = writeTab(ss, body, '物資借用', tables.invLoans, schema.invLoans, ['borrowerName', 'itemName', 'qty', 'outDate', 'dueDate', 'status', 'note']);

  // 會議
  counts['meetings'] = writeTab(ss, body, '會議', tables.meetings, schema.meetings, ['date', 'title', 'venue', 'status', 'note']);

  // 設定（每次更新，方便你睇邊個旅團幾時同步）
  var log = ss.getSheetByName('同步紀錄') || ss.insertSheet('同步紀錄');
  log.appendRow([new Date(), unit, body.unitName || '', JSON.stringify(counts)]);
  log.getRange(1, 1, 1, 4).setFontWeight('bold');
  /* ★ v2.8.1 封頂：以前每 sync 一次就多一行，永遠唔會刪 —— 用幾年就幾千行。
     留最近 500 次（夠查），儲到 550 先一次過刪返落 500（唔係逐次刪，慳配額）。 */
  try {
    var logRows = log.getLastRow();
    // Preserve all pre-existing and future sync log rows.
  } catch (capErr) { /* 封頂失敗唔阻斷同步 */ }

  // 自 v2.6.1 起：順手清走舊版留低嘅後綴分身（物資·0082、帳目·0082、團員·0082、
  // 收支申報·0082、通告·0082、報名·0082、物資借用·0082、會議·0082）。
  // 查實啲資料頭先已經寫返落無後綴分頁，呢啲只係舊 code 遺物；唔刪佢，
  // 團長下次同步仲會見到「物資82」嗰啲分頁。
  // Never delete existing suffixed tabs as an implicit side effect of report refresh.

  return counts;
}

/** 刪走上次同步留低嘅「分頁名·旅團編號」分身（同一個旅團先刪） */
function removeSuffixedTabs(ss, unit) {
  try {
    var suffix = '·' + textOf(unit);
    if (!unit || suffix === '·') return;
    ss.getSheets().forEach(function (sh) {
      var nm = sh.getName();
      /* ★ v2.6.3 修正一個潛伏咗兩版嘅炸彈：
         舊寫法 nm.indexOf(suffix) === nm.length - suffix.length，
         喺「個名根本冇嗰個後綴」嗰陣 indexOf 回 -1，
         於是條件變成 nm.length === suffix.length - 1 ——
         即係**任何名字長度啱撞正 4 個字**嘅分頁都會被刪！
         「進度追蹤」「待批完成」「活動履歷」「待批履歷」「成員名單」「同步紀錄」「通告全文」
         全部係 4 個字 —— 一撳報表同步就成批分頁連資料一齊冇咗
         （團員進度、批核紀錄）。而家嚴格比對結尾，而且要長過個後綴先算。 */
      if (nm.length > suffix.length && nm.slice(nm.length - suffix.length) === suffix) {
        try { ss.deleteSheet(sh); } catch (e) { /* 刪唔到就留低，唔好成全個同步失敗 */ }
      }
    });
  } catch (e) { /* ignore */ }
}

/** 寫入一個工作表（每次同步會重寫該旅團嘅資料，避免重複） */
function writeTab(ss, body, baseName, rows, schema, fallbackKeys) {
  rows = rows || [];
  var keys = (schema && schema.length ? schema.map(function (f) { return f.key; }) : fallbackKeys) || [];
  // 加上未定義但有值嘅欄位
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) {
      if (keys.indexOf(k) < 0 && k !== 'id' && k !== 'photos' && k !== 'attachments' && k !== 'signups') keys.push(k);
    });
  });
  var header = ['旅團'].concat(['id']).concat(keys).concat(['同步時間']);
  var data = rows.map(function (r) {
    return [body.unit].concat([r.id || '']).concat(keys.map(function (k) { return cell(getPath(r, k)); }))
      .concat([new Date()]);
  });

  var name = sheetName(baseName, body.unit);
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (data.length) writeUnitRowsAsText(sh, 2, data);
  sh.setFrozenRows(1);
  return rows.length;
}

/** 通告全文：一行一張通告（JSON 原樣存起，公開頁免登入讀） */
function writeNoticesFull(ss, unit, notices) {
  var sh = ss.getSheetByName('通告全文') || ss.insertSheet('通告全文');
  sh.clear();
  sh.getRange(1, 1, 1, 6).setValues([['旅團', 'id', '狀態', '標題', 'JSON', '更新時間']]).setFontWeight('bold');
  var data = (notices || []).map(function (n) {
    var slim = {
      id: n.id, type: n.type, status: n.status,
      title: n.title || {}, body: n.body || {},
      eventDate: n.eventDate || '', deadline: n.deadline || '',
      venue: n.venue || '', assembly: n.assembly || '', dismissal: n.dismissal || '',
      programme: n.programme || '', dress: n.dress || '', fee: n.fee || '',
      quota: Number(n.quota) || 0, enquiry: n.enquiry || '',
      needSignup: n.needSignup !== false,
      fields: n.fields || [], publishAt: n.publishAt || '',
      signupCount: (n.signups && n.signups.length) || 0,
      unit: unit, unitName: n.unitName || ''
    };
    return [unit, textOf(n.id), textOf(n.status), textOf(n.title && n.title.zh), JSON.stringify(slim), new Date()];
  });
  if (data.length) writeUnitRowsAsText(sh, 2, data);
  sh.setFrozenRows(1);
  return data.length;
}

/* 舊匿名通告／團章 reader 已移除。已發布內容只會由 hubLoad 按
   opaque member session 及可見級別建立安全投影。 */

/** 通告報名（攤開） */
function writeSignups(ss, body, notices) {
  var rows = [];
  notices.forEach(function (n) {
    (n.signups || []).forEach(function (s) {
      var v = s.values || {};
      rows.push([body.unit, n.id, n.title && n.title.zh || '', s.at || '', v.name || '', v.contact || '', attendOf(v), JSON.stringify(v)]);
    });
  });
  var name = sheetName('報名', body.unit);
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var header = ['旅團', '通告編號', '通告標題', '報名時間', '姓名', '聯絡', '出席與否', '全部欄位(JSON)'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) writeUnitRowsAsText(sh, 2, rows);
  sh.setFrozenRows(1);
  return rows.length;
}

/* ============================================================
   一個 Unified 後端、多個 client：Progress
   ------------------------------------------------------------
   行政介面、Progress 與 BADGE 都係同一 Unified 後端的 client，以業務 action
   直接讀寫指定分頁；唔存在另一個 Progress backend 或前端之間的接駁。
   共用分頁：進度追蹤 / 其他獎章 / 待批完成 / 活動履歷 / 待批履歷 / 成員名單
   讀：GET  ?action=load[&apikey=…]
   寫：POST { action:'save' | 'saveOtherBadge', apikey, changes / records }
   ============================================================ */

function textOf(v) { return String(v === null || v === undefined ? '' : v).trim(); }

function dateOf(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    try { return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); } catch (err) { /* 用下面嘅 fallback */ }
    try { return v.toISOString().slice(0, 10); } catch (err2) { return String(v); }
  }
  return textOf(v);
}

/** 成員名單：以「成員名單」為主，補上「團員」分頁（執委系統同步過嚟嘅） */
/* ============================================================
   ★ v2.7.1（2026-09-24 團長回報：「人係讀到，但係個個都冇進度」）
   ------------------------------------------------------------
   正式路徑只准指向本支部同一個 Unified /exec／Sheet。若人讀到但進度全空，
   要核對 Registry 是否誤指舊 deployment，以及 active Sheet 的「進度追蹤」／
   「成員名單」分頁是否有資料。因此保留管理員診斷：顯示 active Sheet、分頁、
   行數及進度／名冊對應結果。要 API Key（會報分頁名同行數，唔應該公開）。
   ============================================================ */

function progressMembers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = [];
  var seen = {};
  var mSheet = ss.getSheetByName('成員名單');
  if (mSheet) {
    var m = mSheet.getDataRange().getValues();
    for (var i = 1; i < m.length; i++) {
      var ymis = textOf(m[i][0]);
      if (!ymis || seen[ymis]) continue;
      out.push({ ymis: ymis, name: textOf(m[i][1]) });
      seen[ymis] = true;
    }
  }
  var tSheet = null;
  var all = ss.getSheets();
  for (var k = 0; k < all.length; k++) {
    var nm = all[k].getName();
    if (nm === '團員' || nm.indexOf('團員·') === 0) { tSheet = all[k]; break; }
  }
  if (tSheet) {
    /* 自 v2.6.1 起（2026-09-20 團長回報「成員進度重複」）：
       以前寫死「第 2 欄＝ymis、第 4 欄＝姓名」（嗰個係 initializeSheets 嘅次序），
       但報表同步（writeTab）係用前端 schema 次序寫（…,name,…,identity,…,ymis,…），
       兩套唔同結果讀錯欄——每人多咗一行「ymis=姓名、name=身份」。
       而家照標題列搵返 ymis／姓名 喺邊一欄，兩個次序都啱。 */
    var t = tSheet.getDataRange().getValues();
    var head = (t.length ? t[0] : []).map(function (c) { return textOf(c); });
    var ciYmis = -1, ciName = -1;
    for (var c = 0; c < head.length; c++) {
      if (ciYmis < 0 && (head[c] === 'ymis' || head[c].toLowerCase() === 'ymis')) ciYmis = c;
      if (ciName < 0 && /^姓名$|^名$|^name$/i.test(head[c])) ciName = c;
    }
    /* 搵唔到欄就退返 initializeSheets 嘅舊次序（旅團,id,ymis,systemId,姓名,…） */
    if (ciYmis < 0) ciYmis = 2;
    if (ciName < 0) ciName = 4;
    for (var j = 1; j < t.length; j++) {
      var y2 = textOf(t[j][ciYmis]);
      if (!y2 || seen[y2]) continue;
      out.push({ ymis: y2, name: textOf(t[j][ciName]) });
      seen[y2] = true;
    }
  }
  return out;
}

/** 讀全部進度資料（Unified /exec?action=load 的 Progress 業務格式） */
function loadProgressData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var progress = {};
  var flat = {};
  var i, rows;

  var pSheet = ss.getSheetByName('進度追蹤');
  if (pSheet) {
    rows = pSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      var ymis = textOf(rows[i][0]);
      var itemId = textOf(rows[i][1]);
      if (!ymis || !itemId) continue;
      if (!progress[ymis]) { progress[ymis] = {}; flat[ymis] = {}; }
      progress[ymis][itemId] = { date: dateOf(rows[i][2]), confirmer: textOf(rows[i][4]) };
      flat[ymis][itemId] = dateOf(rows[i][2]);
    }
  }

  var other = {};
  var oSheet = ss.getSheetByName('其他獎章');
  if (oSheet) {
    rows = oSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      var oy = textOf(rows[i][0]);
      var ob = textOf(rows[i][1]);
      if (!oy || !ob) continue;
      if (!other[oy]) other[oy] = {};
      other[oy][ob] = { name: textOf(rows[i][2]), date: dateOf(rows[i][3]), cert: textOf(rows[i][4]) };
    }
  }

  var pending = [];
  var prSheet = ss.getSheetByName('待批完成');
  if (prSheet) {
    rows = prSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      if (textOf(rows[i][7]) !== 'pending') continue;
      pending.push({
        request_id: textOf(rows[i][0]), ymis: textOf(rows[i][1]), name: textOf(rows[i][2]),
        item_id: textOf(rows[i][3]), item_name: textOf(rows[i][4]),
        requested_date: dateOf(rows[i][5]), evidence: textOf(rows[i][6]),
        status: 'pending', created_at: dateOf(rows[i][8])
      });
    }
  }

  var logs = [];
  var lSheet = ss.getSheetByName('活動履歷');
  if (lSheet) {
    rows = lSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      if (!textOf(rows[i][0])) continue;
      logs.push({
        record_id: textOf(rows[i][0]), type: textOf(rows[i][1]) || 'activity',
        ymis: textOf(rows[i][2]), name: textOf(rows[i][3]), date: dateOf(rows[i][4]),
        title: textOf(rows[i][5]), role: textOf(rows[i][6]), hours: textOf(rows[i][7]),
        cert_no: textOf(rows[i][8]), detail: textOf(rows[i][9]), recorder: textOf(rows[i][10]),
        recorded_at: textOf(rows[i][11])
      });
    }
  }

  var logRequests = [];
  var lrSheet = ss.getSheetByName('待批履歷');
  if (lrSheet) {
    rows = lrSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      if (!textOf(rows[i][0]) || textOf(rows[i][12]) !== 'pending') continue;
      logRequests.push({
        request_id: textOf(rows[i][0]), kind: textOf(rows[i][1]) || 'new',
        target_record_id: textOf(rows[i][2]), type: textOf(rows[i][3]) || 'activity',
        ymis: textOf(rows[i][4]), name: textOf(rows[i][5]), date: dateOf(rows[i][6]),
        title: textOf(rows[i][7]), role: textOf(rows[i][8]), hours: textOf(rows[i][9]),
        cert_no: textOf(rows[i][10]), detail: textOf(rows[i][11]),
        status: 'pending', created_at: textOf(rows[i][13])
      });
    }
  }

  return {
    members: progressMembers(),
    progress: progress,
    flatProgress: flat,
    pendingRequests: pending,
    otherBadges: other,
    logs: logs,
    logsSupported: !!ss.getSheetByName('活動履歷'),
    logRequests: logRequests,
    logRequestsSupported: !!ss.getSheetByName('待批履歷'),
    at: new Date()
  };
}

/** 只回一位團員自己的 BADGE 資料；永遠唔會把完整 load payload 交畀個人入口。 */
function loadMineProgress(ymis) {
  ymis = textOf(ymis);
  if (!ymis) return { success: false, error: '登入帳戶未綁定 YMIS' };
  var all = loadProgressData();
  var member = null;
  (all.members || []).some(function (m) {
    if (textOf(m && m.ymis) === ymis) { member = m; return true; }
    return false;
  });
  var progress = {}; progress[ymis] = (all.progress && all.progress[ymis]) || {};
  var flat = {}; flat[ymis] = (all.flatProgress && all.flatProgress[ymis]) || {};
  var other = {}; other[ymis] = (all.otherBadges && all.otherBadges[ymis]) || {};
  return {
    success: true,
    member: member || { ymis: ymis, name: '' },
    members: [member || { ymis: ymis, name: '' }],
    progress: progress,
    flatProgress: flat,
    otherBadges: other,
    logs: (all.logs || []).filter(function (r) { return textOf(r && r.ymis) === ymis; }),
    logRequests: (all.logRequests || []).filter(function (r) { return textOf(r && r.ymis) === ymis; }),
    requests: loadMyRequests(ymis).requests || [],
    at: new Date()
  };
}

/**
 * 同時多人寫入就排隊（LockService）。
 * BUILD 要求「等唔到鎖就拒絕」，唔可以未攞到鎖仍然讀→改→寫，否則
 * 兩個請求會同時覆蓋資料。等候失敗會拋出可識別錯誤，由 doPost 統一回傳
 * 429；所有呼叫者都必須先攞到鎖，並由 finally 釋放。
 */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    var busy = new Error('LOCK_BUSY');
    busy.code = 'LOCK_BUSY';
    throw busy;
  }
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/** 勾／取消勾（Progress action 寫入同一個「進度追蹤」分頁） */
function saveProgress(changes, confirmer) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('進度追蹤');
  if (!sheet) return { success: false, error: '搵唔到「進度追蹤」分頁（請先執行 initializeSheets）' };
  var processed = 0;
  (changes || []).forEach(function (c) {
    var ymis = textOf(c.ymis);
    var itemId = textOf(c.itemId);
    if (!ymis || !itemId) return;
    var rows = sheet.getDataRange().getValues();
    var found = false;
    for (var i = 1; i < rows.length; i++) {
      if (textOf(rows[i][0]) === ymis && textOf(rows[i][1]) === itemId) {
        if (c.uncomplete) {
          sheet.deleteRow(i + 1);
        } else {
          sheet.getRange(i + 1, 3).setValue(c.date || '');
          sheet.getRange(i + 1, 4).setValue(new Date());
          sheet.getRange(i + 1, 5).setValue(confirmer || c.confirmer || '');
          sheet.getRange(i + 1, 6).setValue(c.note || '');
        }
        found = true; processed++; break;
      }
    }
    if (!found && !c.uncomplete) {
      sheet.appendRow([ymis, itemId, c.date || '', new Date(), confirmer || c.confirmer || '', c.note || '']);
      processed++;
    }
  });
  return { success: true, processed: processed };
}

/** 其他獎章（服務／活動／訓練班以外嘅證書紀錄） */
function saveOtherBadges(records) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('其他獎章');
  if (!sheet) return { success: false, error: '搵唔到「其他獎章」分頁（請先執行 initializeSheets）' };
  var processed = 0;
  (records || []).forEach(function (r) {
    var ymis = textOf(r.ymis);
    var badgeId = textOf(r.badgeId || r.id);
    if (!ymis || !badgeId) return;
    var rows = sheet.getDataRange().getValues();
    var found = false;
    for (var i = 1; i < rows.length; i++) {
      if (textOf(rows[i][0]) === ymis && textOf(rows[i][1]) === badgeId) {
        if (r.uncomplete) { sheet.deleteRow(i + 1); }
        else {
          sheet.getRange(i + 1, 3).setValue(textOf(r.name));
          sheet.getRange(i + 1, 4).setValue(r.date || '');
          sheet.getRange(i + 1, 5).setValue(textOf(r.cert));
          sheet.getRange(i + 1, 6).setValue(textOf(r.note));
          sheet.getRange(i + 1, 7).setValue(new Date());
        }
        found = true; processed++; break;
      }
    }
    if (!found && !r.uncomplete) {
      sheet.appendRow([ymis, badgeId, textOf(r.name), r.date || '', textOf(r.cert), textOf(r.note), new Date()]);
      processed++;
    }
  });
  return { success: true, processed: processed };
}

/* ============================================================
   團員申報進度完成（v2.2.0，畀團員入口用）
   只可由同源 server bridge 在核實 member session、固定本人 YMIS 後呼叫；
   寫入「待批完成」分頁，狀態 pending。執委喺審批中心批准後先會真正
   寫入「進度追蹤」，唔會直接改任何進度資料。
   ============================================================ */
function addProgressRequest(body) {
  var ymis = textOf(body.ymis);
  var itemId = textOf(body.item_id);
  if (!ymis || !itemId) return { success: false, error: '缺少 ymis 或 item_id' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('待批完成');
  if (!sheet) return { success: false, error: '搵唔到「待批完成」分頁（請先執行 initializeSheets）' };
  var reqId = 'req_' + textOf(body.unit) + '_' + new Date().getTime() + '_'
    + Utilities.getUuid().replace(/-/g, '');
  var reqDate = textOf(body.requested_date) || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  sheet.appendRow([reqId, ymis, textOf(body.name), itemId, textOf(body.item_name),
    reqDate, textOf(body.evidence), 'pending', new Date(), '', '', '', '']);
  return { success: true, request_id: reqId };
}

/** 團員查自己嘅申報（只回該 YMIS 嘅紀錄；pending 嘅排先） */
function loadMyRequests(ymis) {
  ymis = textOf(ymis);
  if (!ymis) return { ok: true, success: true, requests: [] };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('待批完成');
  if (!sheet) return { ok: true, success: true, requests: [] };
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][1]) !== ymis) continue;
    out.push({
      request_id: textOf(rows[i][0]), item_id: textOf(rows[i][3]), item_name: textOf(rows[i][4]),
      requested_date: dateOf(rows[i][5]), status: textOf(rows[i][7]) || 'pending',
      review_note: textOf(rows[i][11]), confirmed_date: dateOf(rows[i][12]),
      created_at: rows[i][8] ? new Date(rows[i][8]).toISOString() : ''
    });
  }
  out.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  return { ok: true, success: true, requests: out.slice(0, 60) };
}

/* ============================================================
   審批中心：待批完成（團員申報 → 執委／領袖喺深資童軍管理系統批）
   批准＝寫入「進度追蹤」（同一個後端的 client 都即刻見到）
   ============================================================ */
function reviewProgressRequest(reqId, decision, note, reviewer, confirmedDate) {
  reqId = textOf(reqId);
  if (!reqId) return { success: false, error: '缺少 request_id' };
  if (decision !== 'approved' && decision !== 'rejected') return { success: false, error: '無效決定' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('待批完成');
  if (!sheet) return { success: false, error: '搵唔到「待批完成」分頁（請先執行 initializeSheets）' };
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) !== reqId) continue;
    if (textOf(rows[i][7]) !== 'pending') return { success: false, error: '呢個申請已經處理過' };
    var reqDate = dateOf(rows[i][5]);
    var finalDate = textOf(confirmedDate) || reqDate || dateOf(new Date());
    sheet.getRange(i + 1, 8).setValue(decision);
    sheet.getRange(i + 1, 10).setValue(textOf(reviewer));
    sheet.getRange(i + 1, 11).setValue(new Date());
    sheet.getRange(i + 1, 12).setValue(textOf(note));
    sheet.getRange(i + 1, 13).setValue(finalDate);
    if (decision !== 'approved') return { success: true, message: '已拒絕' };
    var ymis = textOf(rows[i][1]);
    var itemId = textOf(rows[i][3]);
    var pSheet = ss.getSheetByName('進度追蹤');
    if (!pSheet) return { success: false, error: '搵唔到「進度追蹤」分頁' };
    var prow = pSheet.getDataRange().getValues();
    var hit = -1;
    for (var k = 1; k < prow.length; k++) {
      if (textOf(prow[k][0]) === ymis && textOf(prow[k][1]) === itemId) { hit = k; break; }
    }
    var memo = '由申請轉入：' + textOf(note);
    if (hit >= 0) {
      pSheet.getRange(hit + 1, 3).setValue(finalDate);
      pSheet.getRange(hit + 1, 4).setValue(new Date());
      pSheet.getRange(hit + 1, 5).setValue(textOf(reviewer));
      pSheet.getRange(hit + 1, 6).setValue(memo);
    } else {
      pSheet.appendRow([ymis, itemId, finalDate, new Date(), textOf(reviewer), memo]);
    }
    return { success: true, message: '已批准並寫入進度' };
  }
  return { success: false, error: '搵唔到申請（可能已經處理）' };
}

/* 待批履歷：團員自行申報活動履歷 → 執委／領袖批准 */
function reviewLogRequest(reqId, decision, note, reviewer) {
  reqId = textOf(reqId);
  if (!reqId) return { success: false, error: '缺少 request_id' };
  if (decision !== 'approved' && decision !== 'rejected') return { success: false, error: '無效決定' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('待批履歷');
  if (!sheet) return { success: false, error: '搵唔到「待批履歷」分頁（請先執行 initializeSheets）' };
  var rows = sheet.getDataRange().getValues();
  var rowIndex = -1, row = null;
  for (var i = 1; i < rows.length; i++) {
    if (textOf(rows[i][0]) === reqId) { rowIndex = i + 1; row = rows[i]; break; }
  }
  if (!row) return { success: false, error: '搵唔到申報' };
  if (textOf(row[12]) !== 'pending') return { success: false, error: '呢個申報已經處理過' };
  var kind = textOf(row[1]) || 'new';
  var rec = {
    type: textOf(row[3]) || 'activity', ymis: textOf(row[4]), name: textOf(row[5]),
    date: dateOf(row[6]), title: textOf(row[7]), role: textOf(row[8]), hours: textOf(row[9]),
    cert_no: textOf(row[10]), detail: textOf(row[11])
  };
  if (decision !== 'approved') {
    sheet.getRange(rowIndex, 13).setValue('rejected');
    sheet.getRange(rowIndex, 15).setValue(textOf(reviewer));
    sheet.getRange(rowIndex, 16).setValue(new Date());
    sheet.getRange(rowIndex, 17).setValue(textOf(note));
    return { success: true, message: '已拒絕申報' };
  }
  var lSheet = ss.getSheetByName('活動履歷');
  if (!lSheet) return { success: false, error: '搵唔到「活動履歷」分頁' };
  var recordId = '';
  var recorder = '';
  if (kind === 'edit') {
    var targetId = textOf(row[2]);
    var ld = lSheet.getDataRange().getValues();
    var li = -1;
    for (var j = 1; j < ld.length; j++) { if (textOf(ld[j][0]) === targetId) { li = j; break; } }
    if (li < 0) return { success: false, error: '搵唔到原紀錄（可能已被刪除）' };
    recorder = textOf(ld[li][10]);
    lSheet.getRange(li + 1, 2, 1, 12).setValues([[
      rec.type, rec.ymis, rec.name, rec.date, rec.title, rec.role,
      rec.hours, rec.cert_no, rec.detail, recorder, textOf(ld[li][11]), new Date()
    ]]);
    recordId = targetId;
  } else {
    recordId = 'LOG_' + new Date().getTime() + '_' + Math.random().toString(36).substr(2, 5);
    recorder = rec.name + '（自行申報）';
    lSheet.appendRow([recordId, rec.type, rec.ymis, rec.name, rec.date, rec.title, rec.role,
      rec.hours, rec.cert_no, rec.detail, recorder, new Date(), '']);
  }
  sheet.getRange(rowIndex, 13).setValue('approved');
  sheet.getRange(rowIndex, 15).setValue(textOf(reviewer));
  sheet.getRange(rowIndex, 16).setValue(new Date());
  sheet.getRange(rowIndex, 17).setValue(textOf(note));
  return { success: true, message: kind === 'edit' ? '已批准修改並更新紀錄' : '已批准並寫入活動履歷', record_id: recordId };
}

/** 成員名單：由執委系統嘅名冊更新（唔會刪人，進度紀錄照樣對得返） */
function writeMemberList(ss, rows) {
  var sh = ss.getSheetByName('成員名單');
  if (!sh) {
    sh = ss.insertSheet('成員名單');
    sh.appendRow(['YMIS', '姓名', '加入日期', '支部', '聯絡']);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  var existing = {};
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) existing[textOf(data[i][0])] = i + 1;
  var n = 0;
  (rows || []).forEach(function (m) {
    var ymis = textOf(m.ymis);
    if (!ymis) return;
    var row = [ymis, textOf(m.name), textOf(m.join || m.joinDate), textOf(m.role || m.branch), textOf(m.phone || m.email)];
    if (existing[ymis]) sh.getRange(existing[ymis], 1, 1, 5).setValues([row]);
    else { sh.appendRow(row); existing[ymis] = sh.getLastRow(); }
    n++;
  });
  return n;
}

/* ============================================================
   已驗證 staff 相片上載
   ------------------------------------------------------------
   舊匿名 claim／loan／noticeSignup helper 已移除；個人內容及 mutation
   只可經 opaque member session 綁定的 hub action。以下 helper 只供
   已通過 API Key + staff session 的 uploadPhotos 使用。
   ============================================================ */

/** 將已驗證 staff 提交的 base64 相片存去 Drive（未設定資料夾就只記數量）。
 * 自 v2.3.0 起單據 Drive 資料夾優先次序：
 *  ① 已登入行政介面明確指定的 settings.receiptDrive；
 *  ② 該旅團資料庫的 settings.receiptDrive；
 *  ③ Apps Script Script Property DRIVE_FOLDER_ID（部署時設定嘅預設）。
 * 接受連結或 ID（自動抽出 folders/… ID）；此 helper 本身不是匿名入口。 */
function receiptFolderId(explicit, unit) {
  var v = textOf(explicit);
  if (!v && unit) {
    try {
      var r = loadDb(unit);
      if (r.found && r.db && r.db.settings) v = textOf(r.db.settings.receiptDrive);
    } catch (e2) { /* 讀唔到就用預設 */ }
  }
  if (!v) return '';
  var m = String(v).match(/folders\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(v)) return v;
  return '';
}

function savePhotos(photos, unit, id, explicitFolder) {
  var out = [];
  var fid = receiptFolderId(explicitFolder, unit) || DRIVE_FOLDER_ID;
  if (!fid) return out;
  var folder;
  try { folder = DriveApp.getFolderById(fid); } catch (e) { return out; }
  for (var i = 0; i < photos.length; i++) {
    try {
      var ph = photos[i];
      var b64 = String(ph.dataUrl || '').split(',')[1] || '';
      if (!b64) continue;
      var blob = Utilities.newBlob(Utilities.base64Decode(b64), ph.type || 'image/jpeg', unit + '_' + id + '_' + (i + 1) + '.jpg');
      var f = folder.createFile(blob);
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      out.push(f.getUrl());
    } catch (e2) { /* 單張失敗唔好中斷 */ }
  }
  return out;
}

/* ============================================================
   工具函數
   ============================================================ */

function sheetName(base, unit) {
  /* 自 v2.6.1 起（2026-09-20 團長回報）：總表本身**就係**一個旅團嘅 Sheet。
     initializeSheets() 建嘅係無後綴分頁（物資／帳目／團員…），
     以前呢度喺 per-unit-sheet 模式照樣回「分頁名·旅團編號」（物資·0082），
     同 initializeSheets 兩套名對唔上，結果每次同步都**多生一張**「物資·0082」。
     而家報表一律寫返無後綴分頁，同 initializeSheets 一致，
     即等於填落原本嗰張「物資」度，唔會再生分身。 */
  return base;
}

function getPath(obj, path) {
  if (!path) return '';
  return path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, obj);
}

/** 由報名欄位抽出「出席與否」（欄位 key 通常係 attend / rsvp） */
function attendOf(v) {
  if (!v) return '';
  var keys = ['attend', 'rsvp', 'attendance', '出席', '出席與否'];
  for (var i = 0; i < keys.length; i++) {
    if (v[keys[i]] !== undefined && v[keys[i]] !== null && String(v[keys[i]]) !== '') return String(v[keys[i]]);
  }
  return '';
}

function cell(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.length + ' 項';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

return {
  initializeSheets: initializeSheets,
  dispatchBody: dispatchBody,
  doGet: doGet,
  doPost: doPost,
  loadDb: loadDb,
  loadTables: loadTables,
  staffActorFromAuth: staffActorFromAuth_,
  staffSafeDb: staffSafeDb_,
  dbStats: dbStats,
  dbInfo: dbInfo,
  canAccountAdmin: staffCanAccountAdmin_,
  canonicalRole: branchCanonicalRole_,
  roleLevel: branchRoleLevel_,
  visibleRoles: BRANCH_VISIBLE_ROLES_.slice(),
};
})();
// ============================================================
// VS unified branch backend — isolated test extension
//
// Composition:
//   1. complete shared VSBADGE GS source (identity, progress, badges, logs)
//   2. namespaced VS Portal v2.8.8 administrative storage compatibility
//   3. this router (isolated auth fixture, action scopes, canonical identity projection)
//
// The generated GS is the complete branch capability superset: identity, branch
// administration, progress, badges, logs, and submissions. vs_portal is the
// full-featured frontend; vsbadge is a lightweight frontend over the same backend,
// not a second reduced GS. Each client still needs an allowed action and the router
// still enforces server-side session, role, and scope authorization.
//
// This file is test-only in vs_portal.  Its assertion/exchange route is a security
// fixture, not a Progress or future travel-system contract.  The formal future
// direction is travel-system server → branch backend reader.  It is not published
// to vsbadge and does not deploy itself.  Build with: npm run build:gas:unified
// ============================================================

var UNIFIED_GS_VERSION = 'v9.7';
var UNIFIED_INITIALIZED_PROP = 'UNIFIED_GS_INITIALIZED_VERSION';
var UNIFIED_PORTAL_TOKEN_MAX_MS = 2 * 60 * 1000;
var UNIFIED_SSO_SESSION_MS = 8 * 60 * 60 * 1000;
/* API_KEY is only a server-side root. Purpose separation prevents a routing
   signature, central assertion, and branch exchange token being interchangeable. */
var UNIFIED_PORTAL_EXCHANGE_PURPOSE = 'vs-portal-branch-exchange-v1';
var UNIFIED_PORTAL_EXCHANGE_ISSUER = 'vs-portal';
var UNIFIED_PORTAL_EXCHANGE_AUDIENCE = 'unified-gas:branch:';
var UNIFIED_PORTAL_CENTRAL_SOURCE = 'central-travel-system';
/* Pinned baseline keeps its 900 KB limit; unified administrative signatures need the
   same bounded 4 MiB envelope as /api/proxy for legitimate saveTables payloads. */
var UNIFIED_ADMIN_SIGNED_MAX_BYTES = 4 * 1024 * 1024;

var UNIFIED_PUBLIC_PORTAL_ACTIONS = {
  ping: 1, test: 1, status: 1
};
var UNIFIED_ADMIN_READ_ACTIONS = {
  dbInfo: 1, loadDb: 1, loadDbPart: 1, loadTables: 1, loadTablesPart: 1,
  syncCheck: 1, operationStatus: 1
};
var UNIFIED_ADMIN_WRITE_ACTIONS = {
  saveDb: 1, saveDbPart: 1, saveDbCommit: 1, saveTables: 1, sync: 1,
  uploadPhotos: 1
};
var UNIFIED_ADMIN_DANGEROUS_ACTIONS = {
  repairDb: 1, saveDbForce: 1, verifySetupKey: 1
};
var UNIFIED_PORTAL_AUTH_ACTIONS = {
  authLogin: 1, authWhoAmI: 1, authPortalExchange: 1, authChangePassword: 1,
  authResetPassword: 1, authDeleteAccount: 1, authRestoreAccount: 1,
  authCreateAccount: 1, authOpenAccounts: 1, authForgotPassword: 1, authCompletePasswordReset: 1
};
var UNIFIED_ACCOUNT_ADMIN_ACTIONS = {
  authResetPassword: 1, authDeleteAccount: 1, authRestoreAccount: 1,
  authCreateAccount: 1, authOpenAccounts: 1
};
var UNIFIED_PERSONAL_PROGRESS_ACTIONS = {
  loadMine: 1, myRequests: 1, addRequest: 1
};
/* The full branch frontend reviews the same pinned BADGE request rows.  These
   actions require both the same-origin HMAC transport and a real branch session;
   neither API_KEY nor the browser's claimed role is accepted as the reviewer. */
var UNIFIED_STAFF_PROGRESS_ACTIONS = {
  reviewRequest: 1, reviewLogRequest: 1, bulkReviewRequests: 1
};
var UNIFIED_MEMBER_HUB_ACTIONS = {
  hubLoad: 1, hubRsvp: 1, hubQuiz: 1, hubAbsence: 1, hubNoticeSignup: 1
};

/* Durable operation journal. A transport timeout is never proof of failure: every
   important write is registered before dispatch and finalized after its own handler
   returns. Duplicate IDs are never executed twice. A hard GAS termination can leave
   an entry processing/unknown; operationStatus reports that honestly instead of
   inviting an automatic retry. */
var UNIFIED_OPERATION_WRITE_ACTIONS = {
  saveDb: 1, saveDbPart: 1, saveDbCommit: 1, saveTables: 1, sync: 1, uploadPhotos: 1,
  repairDb: 1, saveDbForce: 1,
  authChangePassword: 1, authResetPassword: 1, authDeleteAccount: 1, authRestoreAccount: 1,
  authCreateAccount: 1, authOpenAccounts: 1, authForgotPassword: 1, authCompletePasswordReset: 1,
  hubRsvp: 1, hubQuiz: 1, hubAbsence: 1, hubNoticeSignup: 1,
  addRequest: 1, reviewRequest: 1, reviewLogRequest: 1, bulkReviewRequests: 1,
  save: 1, saveOtherBadge: 1
};
var UNIFIED_OPERATION_SHEET = '_Operations';
var UNIFIED_OPERATION_HEADERS = ['operation_id', 'action', 'unit', 'state', 'outcome', 'started_at', 'updated_at', 'result_json', 'error'];
var UNIFIED_OPERATION_ID_RE = /^[A-Za-z0-9_.:-]{12,120}$/;

function unifiedJson_(obj) { return jsonResponse(obj); }

function unifiedBody_(e) {
  var raw = String((e && e.postData && e.postData.contents) || '{}');
  var body = null;
  try { body = JSON.parse(raw || '{}'); } catch (err) { body = null; }
  return { raw: raw, body: body };
}

function unifiedOutputObject_(out) {
  if (!out) return null;
  if (typeof out === 'object' && typeof out.getContent !== 'function') return out;
  try { return JSON.parse(out.getContent()); } catch (err) { return null; }
}

function unifiedOutput_(obj) {
  return unifiedJson_(obj || { success: false, ok: false, error: '後端回應格式異常' });
}

function unifiedOperationSheet_() {
  var book = getSheet();
  var sheet = book.getSheetByName(UNIFIED_OPERATION_SHEET);
  if (!sheet) {
    sheet = book.insertSheet(UNIFIED_OPERATION_SHEET);
    sheet.getRange(1, 1, 1, UNIFIED_OPERATION_HEADERS.length).setValues([UNIFIED_OPERATION_HEADERS]);
    sheet.setFrozenRows(1);
    try { sheet.hideSheet(); } catch (ignore) {}
  }
  return sheet;
}

function unifiedOperationId_(body, action) {
  var id = String(body.operationId || body.operation_id || '').trim();
  if (!id) id = String(action || 'write') + ':' + Date.now().toString(36) + ':' + Utilities.getUuid().replace(/-/g, '').slice(0, 24);
  return UNIFIED_OPERATION_ID_RE.test(id) ? id : '';
}

function unifiedFindOperation_(id) {
  if (!UNIFIED_OPERATION_ID_RE.test(String(id || ''))) return null;
  var sheet = unifiedOperationSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  var rowNumber = 0;
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0] || '') === String(id)) { rowNumber = i + 2; break; }
  }
  if (!rowNumber) return null;
  var row = sheet.getRange(rowNumber, 1, 1, UNIFIED_OPERATION_HEADERS.length).getValues()[0];
  return {
    row: rowNumber, id: String(row[0] || ''), action: String(row[1] || ''), unit: String(row[2] || ''),
    state: String(row[3] || 'unknown'), outcome: String(row[4] || 'unknown'),
    startedAt: row[5] instanceof Date ? row[5].toISOString() : String(row[5] || ''),
    updatedAt: row[6] instanceof Date ? row[6].toISOString() : String(row[6] || ''),
    resultJson: String(row[7] || ''), error: String(row[8] || '')
  };
}

function unifiedOperationPublic_(rec) {
  if (!rec) return null;
  var state = rec.state;
  var outcome = rec.outcome;
  /* A processing row older than the normal Apps Script execution window is no
     longer evidence that work is still running. It stays durable but is reported
     as unknown — never as failed. */
  var age = Date.now() - Date.parse(rec.updatedAt || rec.startedAt || '');
  if (state === 'processing' && isFinite(age) && age > 10 * 60 * 1000) state = 'unknown';
  if (state === 'unknown' || state === 'processing') outcome = 'unknown';
  return { id: rec.id, action: rec.action, unit: rec.unit, state: state, outcome: outcome,
    startedAt: rec.startedAt, updatedAt: rec.updatedAt,
    error: rec.error ? '操作未完成；請登入後核對' : '' };
}

function unifiedBeginOperation_(body, action) {
  if (!UNIFIED_OPERATION_WRITE_ACTIONS[action]) return { enabled: false };
  var supplied = String(body.operationId || body.operation_id || '').trim();
  var id = unifiedOperationId_(body, action);
  if (!id) return { enabled: true, invalid: true };
  body.operationId = id;
  body.operation_id = id;
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(10000)) return { enabled: true, busy: true, id: id };
    var found = unifiedFindOperation_(id);
    /* Legacy clients do not supply an ID. In that compatibility case a deterministic
       test UUID / same-millisecond request must still get a fresh journal row; only a
       caller-supplied ID has idempotency semantics. */
    if (found && !supplied) {
      var base = id;
      var suffix = 1;
      while (found && suffix < 1000) {
        id = (base + ':' + suffix).slice(0, 120);
        found = unifiedFindOperation_(id);
        suffix++;
      }
      body.operationId = id;
      body.operation_id = id;
    }
    if (found && (String(found.action || '') !== String(action || '')
        || String(found.unit || '') !== String(body.unit || ''))) {
      return { enabled: true, mismatch: true, id: id, record: found };
    }
    if (found) return { enabled: true, duplicate: true, id: id, record: found };
    var sheet = unifiedOperationSheet_();
    var now = new Date();
    sheet.appendRow([id, action, String(body.unit || ''), 'processing', 'unknown', now, now, '', '']);
    if (sheet.getLastRow() > 1001) sheet.deleteRows(2, Math.min(200, sheet.getLastRow() - 801));
    return { enabled: true, id: id, record: unifiedFindOperation_(id) };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function unifiedFinishOperation_(started, outcome, result, error) {
  if (!started || !started.enabled || !started.id) return null;
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(20000)) return started.record || null;
    var rec = unifiedFindOperation_(started.id);
    if (!rec) return null;
    var state = outcome === 'applied' ? 'applied' : outcome === 'not_applied' ? 'not_applied' : 'unknown';
    // The operation ID is a status capability, not a login credential. Never
    // persist account details or full administrative/member projections here.
    var resultText = JSON.stringify({ success: !!(result && result.success === true),
      ok: !!(result && result.ok === true) });
    var sheet = unifiedOperationSheet_();
    sheet.getRange(rec.row, 4, 1, 6).setValues([[
      state, outcome, rec.startedAt ? new Date(rec.startedAt) : new Date(), new Date(), resultText,
      String(error || result && result.error || '').slice(0, 500)
    ]]);
    return unifiedFindOperation_(started.id);
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function unifiedOperationStatus_(id) {
  var rec = unifiedFindOperation_(String(id || ''));
  if (!rec) return unifiedJson_({ success: true, ok: true, found: false,
    operationId: String(id || ''), outcome: 'unknown', operation: null });
  var op = unifiedOperationPublic_(rec);
  return unifiedJson_({ success: true, ok: true, found: true, operationId: rec.id,
    outcome: op.outcome, mayHaveApplied: op.outcome === 'unknown' || op.outcome === 'applied', operation: op });
}

function unifiedOperationWrap_(body, action, run) {
  var started = unifiedBeginOperation_(body, action);
  if (!started.enabled) return run();
  if (started.invalid) return unifiedJson_({ success: false, ok: false, reason: 'invalid_operation_id',
    outcome: 'not_applied', error: '操作編號格式錯誤' });
  if (started.busy) return unifiedJson_({ success: false, ok: false, reason: 'operation_journal_busy',
    operationId: started.id, outcome: 'not_applied', mayHaveApplied: false,
    operation: { id: started.id, state: 'not_applied', outcome: 'not_applied' }, error: '操作日誌繁忙，請稍後再試' });
  if (started.mismatch) return unifiedJson_({ success: false, ok: false, reason: 'operation_id_reused',
    operationId: started.id, outcome: 'not_applied', mayHaveApplied: false,
    operation: unifiedOperationPublic_(started.record), error: '操作編號已用於另一個操作或旅團；後端冇執行今次請求' });
  if (started.duplicate) {
    var old = started.record;
    var oldPublic = unifiedOperationPublic_(old);
    // This branch runs before action authentication. An operation ID must never
    // replay a previous response (which may contain another user's private db).
    // Return only the status receipt and require a fresh authenticated read.
    return unifiedJson_({ success: false, ok: false,
      reason: oldPublic.outcome === 'unknown' ? 'operation_in_progress' : 'operation_already_recorded',
      operationId: old.id, operation_id: old.id, outcome: oldPublic.outcome,
      mayHaveApplied: oldPublic.outcome !== 'not_applied', operation: oldPublic, deduplicated: true,
      error: '同一操作編號已處理或仍在處理；後端沒有再次執行，請查看狀態並重新登入讀取資料' });
  }
  try {
    var out = run();
    var parsed = unifiedOutputObject_(out);
    if (!parsed) {
      var unknownRec = unifiedFinishOperation_(started, 'unknown', {}, '後端回應格式異常');
      return unifiedJson_({ success: false, ok: false, operationId: started.id, outcome: 'unknown',
        mayHaveApplied: true, operation: unifiedOperationPublic_(unknownRec), error: '後端回應格式異常；結果未知' });
    }
    var applied = parsed.success === true || parsed.ok === true;
    var partial = parsed.rosterSyncPending === true || parsed.revisionPending === true || parsed.writePending === true;
    var outcome = partial ? 'unknown' : (applied ? 'applied' : 'not_applied');
    var finished = unifiedFinishOperation_(started, outcome, parsed, parsed.error || parsed.warning || '');
    parsed.operationId = started.id;
    parsed.operation_id = started.id;
    parsed.outcome = outcome;
    parsed.mayHaveApplied = applied || partial;
    parsed.operation = unifiedOperationPublic_(finished || started.record) || { id: started.id, state: outcome, outcome: outcome };
    return unifiedJson_(parsed);
  } catch (err) {
    var failed = unifiedFinishOperation_(started, 'unknown', {}, String(err && err.message || err));
    return unifiedJson_({ success: false, ok: false, operationId: started.id, outcome: 'unknown',
      mayHaveApplied: true, operation: unifiedOperationPublic_(failed),
      error: '操作中斷；可能未寫，亦可能已經寫入：' + String(err && err.message || err) });
  }
}

/* Unified adapters consume the exact Portal compatibility branch schema. Legacy
   BADGE spellings are adapters only; an unknown backend/platform role fails closed
   instead of silently becoming member. */
function unifiedRoleFromBackend_(role) {
  return String(PortalAdminCompat_.canonicalRole(role) || '');
}

function unifiedRoleToBackend_(role) {
  var canonical = unifiedRoleFromBackend_(role);
  if (canonical === 'super') return 'admin';
  if (canonical === 'chief') return 'group_leader';
  if (canonical === 'leader') return 'branch_leader';
  if (canonical === 'exco') return 'exec_committee';
  if (canonical === 'member') return 'member';
  return '';
}

function unifiedRoleRank_(role) {
  return Number(PortalAdminCompat_.roleLevel(role) || 0);
}

function unifiedRoleAllowedAssertion_(role) {
  var canonical = unifiedRoleFromBackend_(role);
  return !!canonical && PortalAdminCompat_.visibleRoles.indexOf(canonical) >= 0;
}

function unifiedScopesForRole_(role) {
  if (!unifiedRoleFromBackend_(role)) return [];
  var scopes = ['identity:read', 'branch:read', 'progress:self'];
  if (unifiedRoleRank_(role) >= unifiedRoleRank_('exco')) scopes.push('branch:write', 'progress:manage');
  if (unifiedRoleRank_(role) >= unifiedRoleRank_('leader')) scopes.push('identity:manage', 'branch:repair');
  return scopes;
}

function unifiedEffectiveScopes_(role, assertedScopes) {
  var ceiling = unifiedScopesForRole_(role);
  var claimed = Array.isArray(assertedScopes) ? assertedScopes.map(String) : [];
  return ceiling.filter(function (scope) { return claimed.indexOf(scope) >= 0; });
}

function unifiedEffectiveRole_(localBackendRole, assertedPortalRole) {
  var localPortal = unifiedRoleFromBackend_(localBackendRole);
  var asserted = unifiedRoleFromBackend_(assertedPortalRole);
  if (!localPortal || !unifiedRoleAllowedAssertion_(asserted)) return '';
  // The isolated auth fixture proves identity and membership, while the branch Users
  // row remains the action-scope ceiling. A stale/forged high role can never elevate.
  return unifiedRoleRank_(localPortal) <= unifiedRoleRank_(asserted) ? localPortal : asserted;
}

function unifiedB64UrlEncode_(bytes) {
  return String(Utilities.base64EncodeWebSafe(bytes) || '').replace(/=+$/, '');
}

function unifiedDecodePortalPayload_(part) {
  try {
    var bytes = Utilities.base64DecodeWebSafe(String(part || ''));
    return JSON.parse(Utilities.newBlob(bytes).getDataAsString());
  } catch (err) { return null; }
}

function unifiedVerifyPortalToken_(token, unit) {
  /* No separate Portal secret is configured. The exact same API_KEY already used
     by BADGE is the root, while this fixed purpose derives a non-interchangeable
     exchange key. API_KEY by itself is never accepted as user identity. */
  var apiKey = String(getApiKey() || '');
  if (!apiKey) return { ok: false, code: 'SSO_NOT_CONFIGURED', error: '隔離 auth fixture 尚未設定' };
  var secret = hmacSha256Hex(UNIFIED_PORTAL_EXCHANGE_PURPOSE, apiKey);
  var parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據無效' };
  }
  var expected = unifiedB64UrlEncode_(Utilities.computeHmacSha256Signature(parts[0], secret));
  if (!safeEqualText(expected, String(parts[1]).replace(/=+$/, ''))) {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據無效' };
  }
  var payload = unifiedDecodePortalPayload_(parts[0]);
  if (!payload || String(payload.typ || '') !== 'central-sso-exchange') {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據格式不正確' };
  }
  var nowMs = Date.now();
  var iat = Number(payload.iat || 0);
  var exp = Number(payload.exp || 0);
  if (!iat || !exp || iat > nowMs + 15000 || exp <= nowMs - 15000 || exp <= iat || exp - iat > UNIFIED_PORTAL_TOKEN_MAX_MS) {
    return { ok: false, code: 'SSO_TOKEN_EXPIRED', error: '隔離 auth fixture 票據已過期，請重新產生測試票據' };
  }
  if (String(payload.u || '') !== String(unit || '')) {
    return { ok: false, code: 'SSO_UNIT_MISMATCH', error: '隔離 auth fixture 票據不屬於此支部' };
  }
  if (String(payload.iss || '') !== UNIFIED_PORTAL_EXCHANGE_ISSUER
      || String(payload.aud || '') !== UNIFIED_PORTAL_EXCHANGE_AUDIENCE + String(unit || '')
      || String(payload.src || '') !== UNIFIED_PORTAL_CENTRAL_SOURCE) {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據用途不正確' };
  }
  var subject = String(payload.sub || '').trim();
  var role = unifiedRoleFromBackend_(payload.role);
  if (!subject || subject.length > 160 || !unifiedRoleAllowedAssertion_(role)) {
    return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 身份資料不完整' };
  }
  var jti = String(payload.jti || '').trim();
  if (!jti || jti.length > 160) return { ok: false, code: 'SSO_TOKEN_INVALID', error: '隔離 auth fixture 票據缺少識別碼' };
  var scopes = Array.isArray(payload.scope) ? payload.scope.map(String) : [];
  return { ok: true, subject: subject, role: role, name: safeSheetText(payload.name, 100), scopes: scopes,
    issuer: String(payload.iss || ''), jti: jti };
}

function unifiedConsumePortalJti_(verified) {
  // CacheService provides the shared replay marker; ScriptLock makes the
  // get-then-put atomic when two tabs try to redeem the same jti together.
  // Fail closed if either service is unavailable.
  var lock = null;
  var locked = false;
  try {
    lock = LockService.getScriptLock();
    lock.waitLock(5000);
    locked = true;
    var cache = CacheService.getScriptCache();
    var key = 'unified-sso-jti:' + sha256Hex(String(verified && verified.jti || '')).substring(0, 40);
    if (cache.get(key)) return false;
    cache.put(key, '1', 180);
    return true;
  } catch (err) {
    return false;
  } finally {
    if (locked && lock) {
      try { lock.releaseLock(); } catch (ignore) { /* fail closed above */ }
    }
  }
}

// The pinned vsbadge allow-list deliberately knows nothing about Portal-only
// actions (loadMine/saveTables/repairDb).  Verify the exact same HMAC contract
// here, but only for the explicit unified action map supplied by the caller.
function unifiedVerifyLinkSig_(e, body, rawBody, allowedActions) {
  var lock = null;
  var locked = false;
  try {
    var action = String(body && body.action || '');
    if (!allowedActions || !allowedActions[action]) return false;
    var signed = readLinkSig(e, body, rawBody);
    if (!signed || String(rawBody || '').length > UNIFIED_ADMIN_SIGNED_MAX_BYTES) return false;
    if (!LINK_SIG_HEX_RE.test(String(signed.sig)) || !LINK_NONCE_RE.test(String(signed.nonce))) return false;
    var ts = parseInt(signed.ts, 10);
    if (!isFinite(ts) || Math.abs(Date.now() - ts) > LINK_SIG_WINDOW_MS) return false;
    var expected = hmacSha256Hex(linkCanonical(action, signed.ts, signed.nonce, signed.digest), linkSigKey());
    if (!safeEqualText(expected, signed.sig)) return false;

    var nonces = [String(signed.nonce)];
    var queryNonce = String(((e && e.parameter) || {}).snonce || '');
    var bodyNonce = String((body && body.sig_nonce) || '');
    [queryNonce, bodyNonce].forEach(function (nonce) {
      if (LINK_NONCE_RE.test(nonce) && nonces.indexOf(nonce) < 0) nonces.push(nonce);
    });
    var keys = nonces.map(function (nonce) {
      return 'link-nonce:' + sha256Hex(nonce).substring(0, 40);
    });
    lock = LockService.getScriptLock();
    lock.waitLock(5000);
    locked = true;
    var cache = CacheService.getScriptCache();
    for (var i = 0; i < keys.length; i++) if (cache.get(keys[i])) return false;
    for (var j = 0; j < keys.length; j++) cache.put(keys[j], '1', LINK_SIG_NONCE_TTL);
    return true;
  } catch (err) {
    return false;
  } finally {
    if (locked && lock) {
      try { lock.releaseLock(); } catch (ignore) { /* fail closed above */ }
    }
  }
}

function unifiedFindMemberBySubject_(subject) {
  var wanted = String(subject || '').trim().toLowerCase();
  if (!wanted) return null;
  var sheet = getSheet().getSheetByName('成員名單');
  if (!sheet) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var ymis = String(rows[i][0] || '').trim();
    var contact = String(rows[i][4] || '').trim();
    if (ymis.toLowerCase() === wanted || contact.toLowerCase() === wanted) {
      return { row: i + 1, sheet: sheet, ymis: ymis, name: String(rows[i][1] || ''),
        branch: String(rows[i][3] || ''), contact: contact };
    }
  }
  return null;
}

function unifiedEnsureCentralUser_(member, assertedRole) {
  if (!member || !member.ymis) return null;
  var existing = getUser(member.ymis) || (member.contact ? getUserByEmail(member.contact) : null);
  if (existing) return existing;
  var sheet = getSheet().getSheetByName('Users');
  if (!sheet) {
    sheet = getSheet().insertSheet('Users');
    sheet.appendRow(USER_HEADERS);
  }
  var map = ensureUserColumns(sheet);
  var width = Math.max(sheet.getLastColumn(), USER_HEADERS.length);
  var row = new Array(width).fill('');
  row[map.ymis] = safeSheetText(member.ymis, 40);
  row[map.name] = safeSheetText(member.name || member.ymis, 100);
  row[map.email] = isEmail(member.contact) ? String(member.contact).trim() : '';
  row[map.role] = unifiedRoleToBackend_(assertedRole);
  row[map.password_hash] = ''; // Deliberately passwordless: the isolated fixture is the credential source.
  row[map.branch] = safeSheetText(member.branch, 100);
  row[map.can_tick] = unifiedRoleRank_(assertedRole) >= unifiedRoleRank_('exco');
  row[map.auth_by] = 'central-sso';
  row[map.auth_date] = now();
  row[map.created_at] = now();
  row[map.status] = 'active';
  row[map.allowed_badges] = defaultAllowedBadges(row[map.role]);
  row[map.force_change_password] = false;
  sheet.appendRow(row);
  writeAudit('central-sso', 'sso_user_mirror', member.ymis, '由隔離 auth fixture 建立無密碼授權鏡像');
  return getUser(member.ymis);
}

function unifiedRefreshCentralMirror_(user, assertedRole) {
  var rec = user && findUserRecord(user.ymis);
  if (!rec) return user;
  var hash = rec.map.password_hash === undefined ? '' : String(rec.data[rec.map.password_hash] || '');
  var source = rec.map.auth_by === undefined ? '' : String(rec.data[rec.map.auth_by] || '');
  // Only passwordless rows created by the isolated fixture follow fixture membership
  // role changes automatically. Existing local accounts keep their branch
  // authorization ceiling and can never be elevated by an assertion alone.
  if (!hash && source === 'central-sso') {
    var wanted = unifiedRoleToBackend_(assertedRole);
    if (rec.map.role !== undefined && String(rec.data[rec.map.role] || '') !== wanted) {
      rec.sheet.getRange(rec.row, rec.map.role + 1).setValue(wanted);
      if (rec.map.can_tick !== undefined) rec.sheet.getRange(rec.row, rec.map.can_tick + 1).setValue(unifiedRoleRank_(assertedRole) >= unifiedRoleRank_('exco'));
      if (rec.map.auth_date !== undefined) rec.sheet.getRange(rec.row, rec.map.auth_date + 1).setValue(now());
      writeAudit('central-sso', 'sso_role_sync', user.ymis, '隔離 fixture 角色同步為 ' + wanted);
      return getUser(user.ymis) || user;
    }
  }
  return user;
}

function unifiedResolvePortalIdentity_(verified) {
  var user = getUser(verified.subject) || getUserByEmail(verified.subject);
  var member = unifiedFindMemberBySubject_(verified.subject);
  if (!user && member) user = unifiedEnsureCentralUser_(member, verified.role);
  if (user) user = unifiedRefreshCentralMirror_(user, verified.role);
  if (!user) {
    return { ok: false, code: 'SSO_MEMBERSHIP_NOT_FOUND',
      error: '隔離 auth fixture 身份未對應此支部名冊' };
  }
  var effectiveRole = unifiedEffectiveRole_(user.role, verified.role);
  if (!effectiveRole) {
    return { ok: false, code: 'ROLE_NOT_ALLOWED', error: '支部帳戶身份不屬於目前 branch schema' };
  }
  return { ok: true, ymis: String(user.ymis || ''), user: user, member: member,
    role: effectiveRole, assertedRole: verified.role,
    scopes: unifiedEffectiveScopes_(effectiveRole, verified.scopes) };
}

function unifiedIssueSsoToken_(ymis, role, scopes) {
  var sheet = getSheet().getSheetByName('Tokens');
  if (!sheet) {
    sheet = getSheet().insertSheet('Tokens');
    sheet.appendRow(['token', 'ymis', 'created_at', 'expires_at', 'source', 'role_scope', 'action_scopes']);
  } else {
    if (sheet.getLastColumn() < 5 || !sheet.getRange(1, 5).getValue()) sheet.getRange(1, 5).setValue('source');
    if (sheet.getLastColumn() < 6 || !sheet.getRange(1, 6).getValue()) sheet.getRange(1, 6).setValue('role_scope');
    if (sheet.getLastColumn() < 7 || !sheet.getRange(1, 7).getValue()) sheet.getRange(1, 7).setValue('action_scopes');
  }
  var token = 'sso_' + generateToken() + generateToken();
  var expiry = new Date(Date.now() + UNIFIED_SSO_SESSION_MS);
  sheet.appendRow([token, ymis, now(), Utilities.formatDate(expiry, 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss'),
    'central-sso', role, (scopes || []).join(' ')]);
  return { token: token, expiresAt: expiry.getTime() };
}

function unifiedTokenMeta_(token) {
  var sheet = getSheet().getSheetByName('Tokens');
  if (!sheet || !token) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '') === String(token)) {
      return { ymis: String(rows[i][1] || ''), expires: rows[i][3], source: String(rows[i][4] || 'local'),
        role: String(rows[i][5] || ''), scopes: String(rows[i][6] || '').split(/\s+/).filter(function (x) { return !!x; }) };
    }
  }
  return null;
}

function unifiedAccountPayload_(identity) {
  var user = identity.user || {};
  var member = identity.member || unifiedFindMemberBySubject_(identity.ymis || user.ymis);
  return {
    id: String(user.ymis || identity.ymis || ''),
    username: String(user.email || user.ymis || identity.ymis || ''),
    email: String(user.email || ''),
    name: String(user.name || (member && member.name) || ''),
    role: String(identity.role || unifiedRoleFromBackend_(user.role)),
    backendRole: String(user.role || ''),
    kind: 'central-user',
    memberId: String((member && member.ymis) || user.ymis || ''),
    ymis: String(user.ymis || identity.ymis || ''),
    scopes: Array.isArray(identity.scopes) ? identity.scopes.slice() : unifiedScopesForRole_(identity.role)
  };
}

function unifiedPortalExchange_(body) {
  var verified = unifiedVerifyPortalToken_(body.portalToken, body.unit);
  if (!verified.ok) return unifiedJson_({ ok: false, success: false, code: verified.code, error: verified.error });
  if (!unifiedConsumePortalJti_(verified)) {
    return unifiedJson_({ ok: false, success: false, code: 'SSO_TOKEN_REPLAYED', error: '隔離 auth fixture 兌換票據已使用' });
  }
  var identity = unifiedResolvePortalIdentity_(verified);
  if (!identity.ok) return unifiedJson_({ ok: false, success: false, code: identity.code, error: identity.error });
  var session = unifiedIssueSsoToken_(identity.ymis, identity.role, identity.scopes);
  writeAudit(identity.ymis, 'central_sso_login', identity.ymis, '隔離 auth fixture 登入；有效角色 ' + identity.role);
  return unifiedJson_({ ok: true, success: true, sessionToken: session.token,
    sessionExpiresAt: session.expiresAt, account: unifiedAccountPayload_(identity),
    mustChangePw: false, centralSso: true, unifiedGsVersion: UNIFIED_GS_VERSION });
}

function unifiedResolveActor_(body, allowPortalExchangeToken) {
  body = body || {};
  if (body.portalToken && allowPortalExchangeToken) {
    var verified = unifiedVerifyPortalToken_(body.portalToken, body.unit);
    if (!verified.ok) return verified;
    if (!unifiedConsumePortalJti_(verified)) return { ok: false, code: 'SSO_TOKEN_REPLAYED', error: '隔離 auth fixture 兌換票據已使用' };
    return unifiedResolvePortalIdentity_(verified);
  }
  var token = String(body.sessionToken || body.token || '');
  var ymis = validateToken(token);
  if (!ymis) return { ok: false, code: 'SESSION_REQUIRED', error: '登入狀態已失效，請重新登入' };
  var user = getUser(ymis);
  if (!user) return { ok: false, code: 'SESSION_ACCOUNT_MISSING', error: '登入帳戶已停用或不存在' };
  var meta = unifiedTokenMeta_(token);
  if (!localLoginAllowed() && (!meta || meta.source !== 'central-sso')) {
    return { ok: false, code: 'CENTRAL_SSO_REQUIRED',
      error: '支部本地入口目前關閉，請聯絡 Sheet 管理員核對並明確開啟' };
  }
  var role = unifiedRoleFromBackend_(meta && meta.role ? meta.role : user.role);
  if (!role) return { ok: false, code: 'ROLE_NOT_ALLOWED', error: '支部帳戶身份不屬於目前 branch schema' };
  return { ok: true, ymis: String(user.ymis || ymis), user: user,
    member: unifiedFindMemberBySubject_(user.ymis), role: role,
    scopes: meta && meta.scopes && meta.scopes.length ? meta.scopes : unifiedScopesForRole_(role),
    source: meta ? meta.source : 'local' };
}

function unifiedWhoAmI_(body) {
  var actor = unifiedResolveActor_(body, true);
  if (!actor.ok) return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  return unifiedJson_({ ok: true, success: true, account: unifiedAccountPayload_(actor),
    centralSso: actor.source === 'central-sso' || !!body.portalToken, unifiedGsVersion: UNIFIED_GS_VERSION });
}

function unifiedLocalLogin_(body) {
  if (!localLoginAllowed()) return unifiedJson_(linkClosedResponse());
  var out = unifiedOutputObject_(handleLogin(body.username || body.email || body.ymis || body.login_id, body.password));
  if (!out || !out.success) return unifiedJson_({ ok: false, success: false, code: 'AUTH_INVALID',
    error: (out && out.error) || '帳號或密碼不正確' });
  var user = out.user || {};
  var role = unifiedRoleFromBackend_(user.role);
  if (!role) return unifiedJson_({ ok: false, success: false, code: 'ROLE_NOT_ALLOWED',
    error: '支部帳戶身份不屬於目前 branch schema' });
  return unifiedJson_({ ok: true, success: true, sessionToken: out.token,
    sessionExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    account: unifiedAccountPayload_({ user: user, ymis: user.ymis, role: role }),
    mustChangePw: !!out.force_change_password, localLogin: true, unifiedGsVersion: UNIFIED_GS_VERSION });
}

function unifiedAccountManager_(actor) {
  if (actor && actor.source === 'server-super') {
    return { ymis: 'sheep', name: '系統管理員', role: 'super_admin' };
  }
  var user = actor && actor.user || {};
  return {
    ymis: String(actor && actor.ymis || user.ymis || ''),
    name: String(user.name || actor && actor.member && actor.member.name || ''),
    role: String(user.role || unifiedRoleToBackend_(actor && actor.role || 'member'))
  };
}

function unifiedCanManageAccounts_(actor, unit) {
  if (!actor || !actor.ok) return false;
  if (actor.source === 'server-super') return true;
  var scopes = Array.isArray(actor.scopes) ? actor.scopes : unifiedScopesForRole_(actor.role);
  if (unifiedRoleRank_(actor.role) < unifiedRoleRank_('leader') || scopes.indexOf('identity:manage') < 0) return false;
  /* 帳戶 action 唔經行政 saveDb dispatcher，所以要在這裏獨立套用同一份
     members.edit module gate ＋ admin.accounts 細項權限。 */
  var loaded = PortalAdminCompat_.loadDb(String(unit || ''));
  /* A brand-new Unified Sheet has no Portal DB yet.  Keep the pinned baseline's
     leader bootstrap path; once a branch DB exists its local ACL is authoritative. */
  if (loaded && loaded.success === true && loaded.found === false) return true;
  if (!loaded || loaded.success !== true || !loaded.db) return false;
  return PortalAdminCompat_.canAccountAdmin(loaded.db, {
    ok: true, role: actor.role, member: actor.member || null,
    record: actor.user || actor.member || null
  });
}

function unifiedAccountTargetYmis_(body) {
  body = body || {};
  var direct = String(body.targetYmis || body.target_ymis || body.ymis || '').trim();
  if (direct && findUserRecord(direct)) return direct;
  var wanted = String(body.targetEmail || body.targetUsername || body.email || body.username || direct || '')
    .trim().toLowerCase();
  if (!wanted) return direct;
  var users = getAllUsers();
  for (var i = 0; i < users.length; i++) {
    var user = users[i] || {};
    if (user.has_account === false) continue;
    if (String(user.ymis || '').trim().toLowerCase() === wanted
        || String(user.email || '').trim().toLowerCase() === wanted) {
      return String(user.ymis || '');
    }
  }
  return direct;
}

function unifiedOpenAccountRows_(body, actor, single) {
  var raw = Array.isArray(body.users) ? body.users : [body];
  if (!raw.length) return unifiedJson_({ ok: false, success: false, code: 'NO_ACCOUNTS', error: '沒有開戶資料' });
  if (raw.length > 200) return unifiedJson_({ ok: false, success: false, code: 'TOO_MANY_ACCOUNTS', error: '每批最多 200 個帳戶' });
  var users = raw.map(function (item) {
    item = item || {};
    return {
      ymis: String(item.targetYmis || item.ymis || '').trim(),
      name: safeSheetText(item.name, 100),
      email: String(item.email || item.username || '').trim().substring(0, 160),
      branch: safeSheetText(item.branch, 100),
      role: unifiedRoleToBackend_(item.role || 'member'),
      can_tick: item.can_tick === undefined
        ? unifiedRoleRank_(item.role || 'member') >= unifiedRoleRank_('exco')
        : item.can_tick === true,
      password: String(item.password || DEFAULT_TEMP_PASSWORD)
    };
  });
  var result = unifiedOutputObject_(handleBulkAddUsers(users, unifiedAccountManager_(actor)))
    || { success: false, created: 0, failed: users.length, error: '開戶失敗' };
  result.created = Number(result.created || 0);
  result.failed = Number(result.failed || 0);
  if (single && result.created !== 1) {
    return unifiedJson_({ ok: false, success: false, code: 'ACCOUNT_CREATE_FAILED',
      error: result.error || result.results && result.results[0] && result.results[0].error || '建立帳戶失敗',
      created: result.created, failed: result.failed, results: result.results || [] });
  }
  result.success = result.success === true && (result.created > 0 || result.failed === 0);
  result.ok = result.success;
  result.message = result.message || ('已開立 ' + result.created + ' 個帳戶'
    + (result.failed ? '；' + result.failed + ' 個未能開立' : ''));
  result.unifiedGsVersion = UNIFIED_GS_VERSION;
  return unifiedJson_(result);
}

function unifiedAccountAdmin_(action, body, actor) {
  if (!unifiedCanManageAccounts_(actor, body && body.unit)) {
    return unifiedJson_({ ok: false, success: false, code: 'ACTION_SCOPE_DENIED',
      error: '只有團長／領袖可以管理支部帳戶' });
  }
  if (action === 'authOpenAccounts') return unifiedOpenAccountRows_(body, actor, false);
  if (action === 'authCreateAccount') return unifiedOpenAccountRows_(body, actor, true);

  var targetYmis = unifiedAccountTargetYmis_(body);
  var rec = targetYmis ? findUserRecord(targetYmis) : null;
  if (!rec) return unifiedJson_({ ok: false, success: false, code: 'ACCOUNT_NOT_FOUND', error: '搵唔到支部帳戶' });
  var manager = unifiedAccountManager_(actor);
  if (action === 'authResetPassword') {
    return handleResetPassword(targetYmis, String(body.newPassword || body.password || ''), manager);
  }
  if (action === 'authDeleteAccount') {
    /* The full frontend's “delete account” means revoke login, not erase the roster
       or Progress history.  Pinned Users remains authoritative and keeps the row. */
    return handleSetUserStatus(targetYmis, 'inactive', manager);
  }
  if (action === 'authRestoreAccount') {
    if (!canManageUser(manager, rec.user.role)) {
      return unifiedJson_({ ok: false, success: false, code: 'ACTION_SCOPE_DENIED', error: '權限不足，不能復原此帳戶' });
    }
    var restored = unifiedOutputObject_(handleSetUserStatus(targetYmis, 'active', manager)) || {};
    if (restored.success !== true) return unifiedJson_(restored);
    var reset = unifiedOutputObject_(handleResetPassword(targetYmis,
      String(body.newPassword || DEFAULT_TEMP_PASSWORD), manager)) || {};
    if (reset.success !== true) {
      reset.accountRestored = true;
      reset.warning = '帳戶已復原，但臨時密碼未能重設';
      return unifiedJson_(reset);
    }
    return unifiedJson_({ ok: true, success: true, message: '帳戶已復原，首次登入必須更改密碼',
      unifiedGsVersion: UNIFIED_GS_VERSION });
  }
  return unifiedJson_({ ok: false, success: false, error: 'Unknown account action' });
}

function unifiedAuthAlias_(action, body, signedActor) {
  if (action === 'authPortalExchange') return unifiedPortalExchange_(body);
  if (action === 'authWhoAmI') return unifiedWhoAmI_(body);
  if (action === 'authLogin') return unifiedLocalLogin_(body);
  if (action === 'authForgotPassword') {
    if (!localLoginAllowed()) return unifiedJson_(linkClosedResponse());
    var requested = unifiedOutputObject_(handleRequestPasswordReset(body.email || body.username || body.login_id || body.ymis))
      || { success: false, error: '暫時未能提交' };
    requested.ok = requested.success === true;
    requested.resetMode = 'code';
    return unifiedJson_(requested);
  }
  if (action === 'authCompletePasswordReset') {
    if (!localLoginAllowed()) return unifiedJson_(linkClosedResponse());
    var completed = unifiedOutputObject_(handleCompletePasswordReset(
      body.email || body.username || body.login_id || body.ymis, body.code, body.newPassword))
      || { success: false, error: '暫時未能重設密碼' };
    completed.ok = completed.success === true;
    return unifiedJson_(completed);
  }
  var actor = signedActor || unifiedResolveActor_(body, false);
  if (!actor.ok) return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  if (actor.source === 'central-sso') {
    return unifiedJson_({ ok: false, success: false, code: 'CENTRAL_IDENTITY_MANAGED',
      error: '隔離 auth fixture 身份不設支部本地密碼或帳戶 mutation' });
  }
  if (action === 'authChangePassword') {
    var changed = unifiedOutputObject_(handleChangePassword(actor.ymis, body.oldPassword, body.newPassword, body.sessionToken));
    if (!changed) changed = { success: false, error: '改密碼失敗' };
    changed.ok = changed.success === true;
    if (changed.success) {
      changed.sessionToken = body.sessionToken;
      var meta = unifiedTokenMeta_(body.sessionToken);
      changed.sessionExpiresAt = meta && meta.expires ? new Date(meta.expires).getTime() : 0;
      changed.mustChangePw = false;
    }
    return unifiedJson_(changed);
  }
  /* These frontend aliases do not create a Portal identity table.  They are a thin
     adapter onto the pinned BADGE Users handlers in this same Unified Sheet. */
  if (UNIFIED_ACCOUNT_ADMIN_ACTIONS[action]) return unifiedAccountAdmin_(action, body, actor);
  return unifiedJson_({ ok: false, success: false, error: 'Unknown auth action' });
}

function unifiedActorCan_(actor, action) {
  if (!actor || !actor.ok) return false;
  var scopes = Array.isArray(actor.scopes) ? actor.scopes : unifiedScopesForRole_(actor.role);
  if (UNIFIED_ADMIN_READ_ACTIONS[action]) return scopes.indexOf('branch:read') >= 0 && unifiedRoleRank_(actor.role) >= unifiedRoleRank_('exco');
  if (UNIFIED_ADMIN_WRITE_ACTIONS[action]) return scopes.indexOf('branch:write') >= 0 && unifiedRoleRank_(actor.role) >= unifiedRoleRank_('exco');
  if (UNIFIED_ADMIN_DANGEROUS_ACTIONS[action]) return scopes.indexOf('branch:repair') >= 0 && unifiedRoleRank_(actor.role) >= unifiedRoleRank_('leader');
  return false;
}

/* Mark removals of roster-only members as well as account tombstones; otherwise
   an old Portal administrative record could recreate a person deleted in BADGE. */
function unifiedRosterTombstoneKey_(ymis) {
  return 'UNIFIED_ROSTER_REMOVED_' + sha256Hex(String(ymis || '').trim().toLowerCase());
}
function unifiedRememberRosterRemoval_(ymis) {
  PropertiesService.getScriptProperties().setProperty(unifiedRosterTombstoneKey_(ymis), '1');
}
function unifiedClearRosterRemoval_(ymis) {
  PropertiesService.getScriptProperties().deleteProperty(unifiedRosterTombstoneKey_(ymis));
}
function unifiedWasRosterRemoved_(ymis) {
  return PropertiesService.getScriptProperties().getProperty(unifiedRosterTombstoneKey_(ymis)) === '1';
}

function unifiedBadgeRosterLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ success: false, error: '系統正處理另一項修改，請稍後重試' });
  try { return fn(); } finally { lock.releaseLock(); }
}
function handleAddMember(ymis, name, branch, actor) {
  return unifiedBadgeRosterLock_(function () {
    var result = handleAddMemberUnlocked_(ymis, name, branch, actor);
    var parsed = unifiedOutputObject_(result);
    if (parsed && parsed.success === true) unifiedClearRosterRemoval_(ymis);
    return result;
  });
}
function handleUpdateUserRole(targetYmis, newRole, canTick, managerYmis, allowedBadges) {
  return unifiedBadgeRosterLock_(function () { return handleUpdateUserRoleUnlocked_(targetYmis, newRole, canTick, managerYmis, allowedBadges); });
}
function handleSetUserStatus(targetYmis, status, manager) {
  return unifiedBadgeRosterLock_(function () { return handleSetUserStatusUnlocked_(targetYmis, status, manager); });
}

function unifiedCanonicalMembers_(existing, preferAuthoritative) {
  var old = Array.isArray(existing) ? existing : [];
  var byYmis = {};
  old.forEach(function (m) {
    var key = String(m && m.ymis || '').trim().toLowerCase();
    if (key && !byYmis[key]) byYmis[key] = m;
  });
  var users = {};
  getAllUsers().forEach(function (u) { users[String(u.ymis || '').trim().toLowerCase()] = u; });
  var out = [];
  var seen = {};
  var sheet = getSheet().getSheetByName('成員名單');
  var rows = sheet ? sheet.getDataRange().getValues() : [];
  for (var i = 1; i < rows.length; i++) {
    var ymis = String(rows[i][0] || '').trim();
    if (!ymis || isSuperAdminId(ymis)) continue;
    var key = ymis.toLowerCase();
    var prior = byYmis[key] || {};
    var user = users[key] || {};
    var merged = {};
    for (var p in prior) if (Object.prototype.hasOwnProperty.call(prior, p)) merged[p] = prior[p];
    merged.id = String(prior.id || ('member_' + sha256Hex(ymis).substring(0, 12)));
    merged.ymis = ymis;
    /* Build the prospective canonical row in memory. Incoming ordinary roster
       fields may change, but identity always comes from Users; no Sheet is
       mutated until the compatibility save has actually succeeded. */
    var rosterName = String(rows[i][1] || user.name || '');
    var rosterBranch = String(rows[i][3] || user.branch || '');
    var rosterContact = String(rows[i][4] || '');
    var rosterEmail = String(user.email || (isEmail(rosterContact) ? rosterContact : ''));
    merged.name = preferAuthoritative ? rosterName : (safeSheetText(prior.name, 100) || rosterName);
    merged.branch = preferAuthoritative ? rosterBranch : (safeSheetText(prior.branch, 100) || rosterBranch);
    merged.email = preferAuthoritative ? rosterEmail : (isEmail(prior.email) ? String(prior.email).trim() : rosterEmail);
    merged.phone = preferAuthoritative ? (isEmail(rosterContact) ? '' : rosterContact)
      : (safeSheetText(prior.phone, 80) || (isEmail(rosterContact) ? '' : rosterContact));
    if (!prior.join && rows[i][2]) merged.join = formatDate(rows[i][2]);
    merged.identity = unifiedRoleFromBackend_(user.role || 'member');
    merged.hasAccount = user.has_account === true;
    merged.accountStatus = merged.hasAccount ? String(user.status || 'active') : 'not_open';
    merged.status = user.status === 'inactive' ? 'inactive' : (prior.status || 'active');
    delete merged.pw; delete merged.hubPw; delete merged.password; delete merged.hubPassword;
    out.push(merged); seen[key] = true;
  }
  // Never silently delete legacy Portal records merely because an older Sheet
  // has not yet mirrored them.  They remain visible and will be additively
  // inserted into 成員名單 on the next authorised save.
  old.forEach(function (m) {
    var key = String(m && m.ymis || '').trim().toLowerCase();
    if (!key || seen[key]) return;
    if (preferAuthoritative && unifiedWasRosterRemoved_(key)) return;
    // BADGE keeps a deleted account as a tombstone and removes it from the roster.
    // An older administrative copy must not silently revive that identity.
    var existingRecord = findUserRecord(key);
    if (existingRecord && existingRecord.user && existingRecord.user.status === 'deleted') return;
    var kept = {};
    for (var p in m) if (Object.prototype.hasOwnProperty.call(m, p)) kept[p] = m[p];
    kept.name = safeSheetText(kept.name, 100);
    kept.branch = safeSheetText(kept.branch, 100);
    kept.email = isEmail(kept.email) ? String(kept.email).trim() : '';
    kept.phone = safeSheetText(kept.phone, 80);
    /* A newly submitted roster row has no Users authority yet and therefore
       starts as member. Role changes only arrive through authoritative branch Users data. */
    kept.identity = users[key] ? unifiedRoleFromBackend_(users[key].role || 'member') : 'member';
    kept.hasAccount = !!(users[key] && users[key].has_account === true);
    kept.accountStatus = kept.hasAccount ? String(users[key].status || 'active') : 'not_open';
    delete kept.pw; delete kept.hubPw; delete kept.password; delete kept.hubPassword;
    out.push(kept); seen[key] = true;
  });
  return out;
}

function unifiedAuthoritativeIdentityMap_() {
  var out = {};
  getAllUsers().forEach(function (user) {
    var key = String(user && user.ymis || '').trim().toLowerCase();
    if (key && !isSuperAdminId(key)) out[key] = unifiedRoleFromBackend_(user.role || 'member');
  });
  return out;
}

function unifiedAccountProjection_(members) {
  var memberByYmis = {};
  (members || []).forEach(function (m) { memberByYmis[String(m.ymis || '').trim().toLowerCase()] = m; });
  return getAllUsers().filter(function (u) {
    return u && u.has_account !== false && u.status !== 'deleted' && !isSuperAdminId(u.ymis);
  }).map(function (u) {
    var member = memberByYmis[String(u.ymis || '').trim().toLowerCase()] || {};
    return {
      id: 'unified:' + String(u.ymis || ''), memberId: String(member.id || u.ymis || ''),
      ymis: String(u.ymis || ''), username: String(u.email || u.ymis || ''),
      email: String(u.email || ''), name: String(u.name || member.name || ''),
      role: unifiedRoleFromBackend_(u.role), active: u.status === 'active',
      status: String(u.status || 'active'), source: 'unified-users'
    };
  });
}

function unifiedUpsertRoster_(members) {
  if (!Array.isArray(members)) return;
  var sheet = getSheet().getSheetByName('成員名單');
  if (!sheet) {
    sheet = getSheet().insertSheet('成員名單');
    sheet.appendRow(['YMIS', '姓名', '加入日期', '支部', '聯絡']);
  }
  var rows = sheet.getDataRange().getValues();
  var rowByYmis = {};
  for (var i = 1; i < rows.length; i++) rowByYmis[String(rows[i][0] || '').trim().toLowerCase()] = i + 1;
  members.forEach(function (m) {
    var ymis = safeSheetText(m && m.ymis, 40);
    var name = safeSheetText(m && m.name, 100);
    if (!ymis || !name || isSuperAdminId(ymis)) return;
    var branch = safeSheetText(m.branch, 100);
    var contact = safeSheetText(m.email || m.phone, 160);
    var row = rowByYmis[ymis.toLowerCase()];
    if (row) {
      sheet.getRange(row, 2).setValue(name);
      if (branch) sheet.getRange(row, 4).setValue(branch);
      if (contact) sheet.getRange(row, 5).setValue(contact);
    } else {
      sheet.appendRow([ymis, name, new Date(), branch, contact]);
      unifiedClearRosterRemoval_(ymis);
      rowByYmis[ymis.toLowerCase()] = sheet.getLastRow();
    }
    var rec = findUserRecord(ymis);
    if (rec) {
      if (rec.map.name !== undefined) rec.sheet.getRange(rec.row, rec.map.name + 1).setValue(name);
      if (contact && isEmail(contact) && rec.map.email !== undefined) rec.sheet.getRange(rec.row, rec.map.email + 1).setValue(contact);
      if (branch && rec.map.branch !== undefined) rec.sheet.getRange(rec.row, rec.map.branch + 1).setValue(branch);
      /* Users.role is the central authorization mirror. Administrative roster
         saves may update contact fields, never role; SSO refresh owns role sync. */
    }
  });
}

/* Called while the compatibility write lock is still held. Only a successfully
   authorized/confirmed write may update the shared roster. */
function unifiedFinishRosterWrite_(result, members, unit) {
  if (!result || result.success !== true) return result;
  if (Array.isArray(members)) {
    try { unifiedUpsertRoster_(members); }
    catch (err) {
      result.rosterSyncPending = true;
      result.warning = '行政資料已儲存，但共用名冊更新未完成；請重新讀取核對';
    }
  }
  // Capture the returned revision while the same write lock is held. Reading it
  // after release could accidentally label an unseen concurrent write as our base.
  try {
    var snapshot = unifiedAdminSnapshot_(unit, { source: 'server-super', role: 'super' }, true);
    if (!snapshot.success) throw new Error(snapshot.error || '無法核對');
    result.version = snapshot.version;
  } catch (err2) {
    result.revisionPending = true;
    result.warning = (result.warning ? result.warning + '；' : '') + '已寫入，但共用版本未能核對；請重新讀取';
  }
  return result;
}

function unifiedPrepareAdminDb_(db) {
  db = db && typeof db === 'object' && !Array.isArray(db) ? db : {};
  db.members = unifiedCanonicalMembers_(db.members || []);
  db.accounts = unifiedAccountProjection_(db.members);
  return db;
}

/* Read administrative data and current BADGE identity from the SAME Sheet.
   The compatibility storage may legitimately be empty; that is not evidence
   that Users or 成員名單 are empty. Project only after resolving the actor. */
function unifiedAdminSnapshot_(unit, actor, branchOwner) {
  var loaded = PortalAdminCompat_.loadDb(String(unit || ''));
  if (!loaded || loaded.success !== true) return { success: false, error: (loaded && loaded.error) || '讀取後端失敗' };
  var db = loaded.db && typeof loaded.db === 'object' ? loaded.db : {};
  db.members = unifiedCanonicalMembers_(db.members || [], true);
  db.accounts = unifiedAccountProjection_(db.members);
  var auth = branchOwner || actor.source === 'server-super'
    ? { serverSigned: true, role: 'server' }
    : { serverSigned: true, delegated: true, role: actor.role,
        session: { ok: true, portal: true, role: actor.role, subject: actor.ymis } };
  var projectedActor = PortalAdminCompat_.staffActorFromAuth(db, auth);
  if (!projectedActor || !projectedActor.ok) return { success: false, error: (projectedActor && projectedActor.error) || '未能核對操作者身份' };
  var projected = PortalAdminCompat_.staffSafeDb(db, projectedActor);
  var version = 'U-' + sha256Hex(JSON.stringify([String(loaded.version || ''), db.members, db.accounts]));
  return { success: true, found: !!loaded.found || db.members.length > 0 || db.accounts.length > 0,
    db: projected, version: version, rawVersion: String(loaded.version || ''), at: loaded.at || '' };
}

/* Called inside the compatibility module's script lock, before mutation. The
   client-visible revision covers both administrative storage and BADGE roster.
   Every ordinary Portal write must use a freshly read shared revision. */
function unifiedGuardAdminVersion_(body) {
  var supplied = String(body.baseVersion || '');
  if (!/^U-[0-9a-f]{64}$/.test(supplied)) return { success: false, conflict: true,
    code: 'SHARED_REVISION_REQUIRED', error: '請先從共用後端重新讀取資料，然後再儲存' };
  var snapshot = unifiedAdminSnapshot_(body.unit, { source: 'server-super', role: 'super' }, true);
  if (!snapshot.success) return { success: false, error: snapshot.error };
  if (supplied !== snapshot.version) return { success: false, conflict: true, version: snapshot.version,
    error: '後端名冊或行政資料已更新，請重新讀取及合併' };
  body.baseVersion = snapshot.rawVersion;
  return { success: true };
}

function unifiedAdminRead_(action, body, actor, branchOwner) {
  var snapshot = unifiedAdminSnapshot_(body.unit, actor, branchOwner);
  if (!snapshot.success) return unifiedJson_({ ok: false, success: false, error: snapshot.error });
  var common = { ok: true, success: true, found: snapshot.found, version: snapshot.version,
    at: snapshot.at, unifiedGsVersion: UNIFIED_GS_VERSION };
  if (action === 'dbInfo') {
    var info = PortalAdminCompat_.dbInfo(String(body.unit || '')) || {};
    if (info.success !== true) return unifiedJson_(info);
    var stats = PortalAdminCompat_.dbStats(snapshot.db || {});
    return unifiedJson_(Object.assign(info, common, { bytes: stats.bytes, sizes: stats.sizes,
      counts: stats.counts, photoBytes: stats.photoBytes, simpleWrite: true }));
  }
  if (action === 'loadDb' || action === 'loadTables') {
    return unifiedJson_(Object.assign(common, { db: snapshot.found ? snapshot.db : null,
      broken: [], bytes: JSON.stringify(snapshot.db || {}).length }));
  }
  if (action === 'loadDbPart') {
    var text = JSON.stringify(snapshot.db || {}), size = 1000000;
    var idx = Math.max(0, parseInt(body.partIdx, 10) || 0);
    var parts = Math.max(1, Math.ceil(text.length / size));
    if (!snapshot.found) return unifiedJson_(Object.assign(common, { part: '', partIdx: idx, parts: 0 }));
    if (idx >= parts) return unifiedJson_({ ok: false, success: false, found: true, error: '分段編號超出範圍' });
    return unifiedJson_(Object.assign(common, { part: text.substring(idx * size, (idx + 1) * size),
      partIdx: idx, parts: parts, bytes: text.length }));
  }
  var names = Object.keys(snapshot.db || {}).sort(), i = Math.max(0, parseInt(body.idx, 10) || 0);
  if (!snapshot.found) return unifiedJson_(Object.assign(common, { idx: i, count: 0, name: '', broken: [] }));
  if (i >= names.length) return unifiedJson_({ ok: false, success: false, found: true, error: '表編號超出範圍' });
  return unifiedJson_(Object.assign(common, { idx: i, count: names.length, name: names[i], value: snapshot.db[names[i]], broken: [] }));
}

function unifiedPortalEvent_(e, body) {
  var clone = {};
  for (var k in (e || {})) if (Object.prototype.hasOwnProperty.call(e, k)) clone[k] = e[k];
  clone.postData = { contents: JSON.stringify(body) };
  return clone;
}

function unifiedPortalAdmin_(e, body, signedActor) {
  var action = String(body.action || '');
  if (UNIFIED_PUBLIC_PORTAL_ACTIONS[action]) {
    return PortalAdminCompat_.dispatchBody(e, body);
  }
  /* Operation IDs contain at least 96 unpredictable bits and act as read-only
     capability receipts. Status exposes metadata only (never result_json/data), so
     the originating public/member client can resolve a timeout without a staff
     session and, crucially, without resending the mutation. */
  if (action === 'operationStatus') return unifiedOperationStatus_(body.operationId || body.operation_id);
  var actor = signedActor || unifiedResolveActor_(body, false);
  if (!actor.ok) return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  if (!unifiedActorCan_(actor, action)) {
    return unifiedJson_({ ok: false, success: false, code: 'ACTION_SCOPE_DENIED', error: '你的身份不可以執行此操作' });
  }
  // The compatibility module still checks API_KEY and its own session gate internally.
  // This router has already resolved the baseline/central actor and enforced scope, so
  // inject a server-only marker here. Incoming clients cannot set it (doPost strips it).
  body.apiKey = getApiKey();
  delete body.apikey;
  body.__serverSigned = true;
  /* Pinned baseline admin is an authenticated branch owner but is deliberately not
     projected into the ordinary roster. Treat that one server-resolved account like
     the platform owner at the compatibility boundary; otherwise an existing DB can
     never bind it as an actor and direct account opening deadlocks. Ordinary
     exco/leader writes remain delegated and go through per-field identity checks. */
  var branchOwnerRole = String(actor.user && actor.user.role || '').toLowerCase();
  var branchOwner = actor.source !== 'server-super' && actor.user
    && (branchOwnerRole === 'admin' || branchOwnerRole === 'super_admin')
    && String(actor.ymis || actor.user.ymis || '').trim() === String(ADMIN_YMIS).trim();
  if (actor.source !== 'server-super' && !branchOwner) {
    body.__serverActorRole = String(actor.role || 'member');
    body.__serverActorSubject = String(actor.ymis || '');
  }
  /* Save and privileged force-repair update the roster only after validation,
     under the same compatibility write lock. */
  if (action === 'saveDb' || action === 'saveDbForce') {
    body.db = unifiedPrepareAdminDb_(body.db);
  } else if (action === 'saveTables') {
    body.tables = body.tables && typeof body.tables === 'object' ? body.tables : {};
    if (Object.prototype.hasOwnProperty.call(body.tables, 'members')) {
      body.tables.members = unifiedCanonicalMembers_(body.tables.members);
    }
    if (Object.prototype.hasOwnProperty.call(body.tables, 'accounts')) {
      body.tables.accounts = unifiedAccountProjection_(unifiedCanonicalMembers_(body.tables.members || []));
    }
  }
  if (actor.source !== 'server-super' && !branchOwner) body.__serverIdentityMap = unifiedAuthoritativeIdentityMap_();
  if (action === 'dbInfo' || action === 'loadDb' || action === 'loadTables'
      || action === 'loadDbPart' || action === 'loadTablesPart') {
    return unifiedAdminRead_(action, body, actor, branchOwner);
  }
  var out = PortalAdminCompat_.dispatchBody(unifiedPortalEvent_(e, body), body);
  var parsed = unifiedOutputObject_(out);
  if (!parsed) return out;
  /* Portal compatibility layer has already applied the actor-specific projection.
     Never re-expand members/accounts here: doing so would put higher identities back
     into a lower actor's response after authorization. */
  parsed.unifiedGsVersion = UNIFIED_GS_VERSION;
  return unifiedOutput_(parsed);
}

function unifiedMemberProgressRequests_(ymis) {
  var wanted = String(ymis || '').trim();
  var sheet = getSheet().getSheetByName('待批完成');
  var out = [];
  if (!wanted || !sheet) return out;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1] || '').trim() !== wanted) continue;
    var status = String(data[i][7] || 'pending').trim().toLowerCase();
    if (status !== 'pending' && status !== 'approved' && status !== 'rejected') continue;
    out.push({
      request_id: String(data[i][0] || ''), ymis: wanted,
      name: String(data[i][2] || ''), item_id: String(data[i][3] || ''), item_name: String(data[i][4] || ''),
      requested_date: data[i][5] ? formatDate(data[i][5]) : '', evidence: String(data[i][6] || ''),
      status: status, created_at: data[i][8] ? formatDate(data[i][8]) : '',
      reviewed_at: data[i][10] ? formatDate(data[i][10]) : '', review_note: String(data[i][11] || ''),
      confirmed_date: data[i][12] ? formatDate(data[i][12]) : ''
    });
  }
  return out;
}

function unifiedLoadMine_(ymis) {
  var all = unifiedOutputObject_(handleLoad()) || {};
  var member = null;
  (all.members || []).some(function (m) {
    if (String(m.ymis || '') === String(ymis || '')) { member = m; return true; }
    return false;
  });
  var progress = {}; progress[ymis] = (all.progress && all.progress[ymis]) || {};
  var flat = {}; flat[ymis] = (all.flatProgress && all.flatProgress[ymis]) || {};
  var other = {}; other[ymis] = (all.otherBadges && all.otherBadges[ymis]) || {};
  var requests = unifiedMemberProgressRequests_(ymis);
  return { success: true, ok: true, member: member, members: member ? [member] : [],
    progress: progress, flatProgress: flat, otherBadges: other,
    logs: (all.logs || []).filter(function (r) { return String(r.ymis || '') === String(ymis || ''); }),
    logsSupported: all.logsSupported === true,
    logRequests: (all.logRequests || []).filter(function (r) { return String(r.ymis || '') === String(ymis || ''); }),
    logRequestsSupported: all.logRequestsSupported === true,
    /* Baseline handleLoad only exposes pending rows.  A member's own safe history must
       keep approved/rejected rows too, otherwise the UI says the application vanished. */
    pendingRequests: requests.filter(function (r) { return r.status === 'pending'; }),
    requests: requests,
    unifiedGsVersion: UNIFIED_GS_VERSION };
}

function unifiedProgressActorCanManage_(actor) {
  if (!actor || !actor.ok) return false;
  var scopes = Array.isArray(actor.scopes) ? actor.scopes : unifiedScopesForRole_(actor.role);
  return unifiedRoleRank_(actor.role) >= unifiedRoleRank_('exco')
    && scopes.indexOf('progress:manage') >= 0;
}

function unifiedCanViewTroop_(actor, cfg) {
  return !!(actor && actor.ok) && (unifiedProgressActorCanManage_(actor) || String((cfg || {}).allow_member_view_others || 'false') === 'true');
}

function unifiedProgressAll_(actor) {
  var cfg = {};
  var sheet = getSheet().getSheetByName('SystemConfig');
  if (sheet) {
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) if (rows[i][0]) cfg[String(rows[i][0])] = String(rows[i][1] || '');
  }
  var canSeeAll = unifiedCanViewTroop_(actor, cfg);
  if (!canSeeAll) return unifiedJson_({ ok: false, success: false, code: 'TROOP_VIEW_DENIED', viewScope: 'denied', error: '權限不足：全團檢視只限領袖，或已由團長開放成員查看其他成員' });
  // loadProgressData belongs to the namespaced Portal module; the pinned BADGE projection is handleLoad().
  var data = unifiedOutputObject_(handleLoad()) || {};
  var cells = 0;
  Object.keys(data.flatProgress || {}).forEach(function (ymis) { cells += Object.keys(data.flatProgress[ymis] || {}).length; });
  data.ok = true;
  data.viewScope = 'troop';
  data.counts = { members: (data.members || []).length, progressCells: cells,
    pendingRequests: (data.pendingRequests || []).length, logs: (data.logs || []).length,
    logRequests: (data.logRequests || []).length };
  data.config = { allow_member_view_others: cfg.allow_member_view_others || 'false' };
  data.gsVersion = VS_GS_VERSION;
  data.revision = VS_GS_REVISION;
  data.unifiedGsVersion = UNIFIED_GS_VERSION;
  return unifiedJson_(data);
}

function unifiedBulkReviewRequests_(body, actor) {
  var input = Array.isArray(body.requests) ? body.requests : [];
  if (!input.length) return unifiedJson_({ ok: false, success: false, code: 'NO_SELECTION', error: '請先選擇要批准的申請' });
  if (input.length > 100) return unifiedJson_({ ok: false, success: false, code: 'TOO_MANY_REQUESTS', error: '每次最多批准 100 項' });
  if (String(body.decision || 'approved') !== 'approved') {
    return unifiedJson_({ ok: false, success: false, code: 'BULK_APPROVE_ONLY', error: '批量操作只支援批准' });
  }
  var confirmedDate = String(body.confirmed_date || '').trim();
  if (confirmedDate && !/^\d{4}-\d{2}-\d{2}$/.test(confirmedDate)) {
    return unifiedJson_({ ok: false, success: false, code: 'INVALID_DATE', error: '確認日期格式不正確' });
  }
  var selected = [];
  var seen = {};
  for (var i = 0; i < input.length; i++) {
    var item = input[i] || {};
    var kind = String(item.kind || '');
    var requestId = String(item.request_id || item.id || '').trim();
    if ((kind !== 'req' && kind !== 'log') || !requestId || requestId.length > 160) {
      return unifiedJson_({ ok: false, success: false, code: 'INVALID_SELECTION', error: '第 ' + (i + 1) + ' 項選擇格式不正確' });
    }
    var key = kind + ':' + requestId;
    if (seen[key]) return unifiedJson_({ ok: false, success: false, code: 'DUPLICATE_SELECTION', error: '選擇中有重複申請' });
    seen[key] = true;
    selected.push({ kind: kind, request_id: requestId });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return unifiedJson_({ ok: false, success: false, code: 'REVIEW_BUSY', error: '系統正處理另一批審批，請稍後重試' });
  }
  try {
    var reqSheet = getSheet().getSheetByName('待批完成');
    var logReqSheet = getSheet().getSheetByName(LOG_REQ_SHEET_NAME);
    var reqRows = reqSheet ? reqSheet.getDataRange().getValues() : [];
    var logReqRows = logReqSheet ? logReqSheet.getDataRange().getValues() : [];
    var logSheet = getSheet().getSheetByName(LOG_SHEET_NAME);
    var logRows = logSheet ? logSheet.getDataRange().getValues() : [];

    /* Validate the whole selection before the first mutation.  Google Sheets has no
       transaction primitive, so this fail-before-write pass is what prevents an
       invalid last row from leaving a surprising half-approved batch. */
    for (var s = 0; s < selected.length; s++) {
      var chosen = selected[s];
      var rows = chosen.kind === 'req' ? reqRows : logReqRows;
      var statusColumn = chosen.kind === 'req' ? 7 : 12;
      var found = null;
      for (var r = 1; r < rows.length; r++) {
        if (String(rows[r][0] || '') === chosen.request_id) { found = rows[r]; break; }
      }
      if (!found || String(found[statusColumn] || '') !== 'pending') {
        return unifiedJson_({ ok: false, success: false, code: 'REQUEST_NOT_PENDING',
          error: '申請 ' + chosen.request_id + ' 已被處理或不存在；請重新讀取' });
      }
      if (chosen.kind === 'req') {
        var itemId = String(found[3] || '');
        var destination = itemId.indexOf('OT-') === 0 ? '其他獎章' : '進度追蹤';
        if (!getSheet().getSheetByName(destination)) {
          return unifiedJson_({ ok: false, success: false, code: 'DESTINATION_MISSING',
            error: '「' + destination + '」工作表不存在，請先執行 initializeSheets()' });
        }
      } else {
        if (!logSheet) return unifiedJson_({ ok: false, success: false, code: 'DESTINATION_MISSING',
          error: '「' + LOG_SHEET_NAME + '」工作表不存在，請先執行 initializeSheets()' });
        if (String(found[1] || 'new') === 'edit') {
          var targetId = String(found[2] || '');
          var targetFound = false;
          for (var l = 1; l < logRows.length; l++) {
            if (String(logRows[l][0] || '') === targetId) { targetFound = true; break; }
          }
          if (!targetFound) return unifiedJson_({ ok: false, success: false, code: 'LOG_TARGET_MISSING',
            error: '履歷申請 ' + chosen.request_id + ' 的原紀錄已不存在；請先處理該項' });
        }
      }
    }

    var reviewer = actor.source === 'server-super'
      ? { ymis: 'sheep', name: '系統管理員', role: 'super_admin' }
      : actor.user;
    var results = [];
    var reqCount = 0;
    var logCount = 0;
    for (var a = 0; a < selected.length; a++) {
      var selectedItem = selected[a];
      var output = selectedItem.kind === 'log'
        ? handleReviewLogRequest(selectedItem.request_id, 'approved', safeSheetText(body.review_note, 500), reviewer)
        : handleReviewRequest(selectedItem.request_id, 'approved', safeSheetText(body.review_note, 500),
          actor.ymis, confirmedDate);
      var parsed = unifiedOutputObject_(output) || { success: false, error: '後端回應格式異常' };
      results.push({ kind: selectedItem.kind, request_id: selectedItem.request_id,
        success: parsed.success === true, error: parsed.error || '' });
      if (parsed.success !== true) {
        return unifiedJson_({ ok: false, success: false, code: 'BULK_REVIEW_PARTIAL',
          error: parsed.error || '批量審批未能完成', processed: a, results: results });
      }
      if (selectedItem.kind === 'log') logCount++; else reqCount++;
    }
    return unifiedJson_({ ok: true, success: true, processed: selected.length,
      progressRequests: reqCount, logRequests: logCount, results: results,
      message: '已批量批准 ' + selected.length + ' 項（進度 ' + reqCount + '、履歷 ' + logCount + '）',
      unifiedGsVersion: UNIFIED_GS_VERSION });
  } finally {
    lock.releaseLock();
  }
}

function unifiedStaffProgress_(e, body, raw) {
  var action = String(body.action || '');
  if (!unifiedVerifyLinkSig_(e, body, raw, UNIFIED_STAFF_PROGRESS_ACTIONS)) {
    return unifiedJson_({ ok: false, success: false, code: 'SIGNATURE_REQUIRED', error: '審批請求簽名無效' });
  }
  var actor = null;
  if (body.unified_super === true && String(body.on_behalf || '') === 'sheep') {
    actor = { ok: true, ymis: 'sheep', role: 'super', source: 'server-super',
      scopes: unifiedScopesForRole_('super'), user: { ymis: 'sheep', name: '系統管理員', role: 'super_admin' } };
  } else {
    actor = unifiedResolveActor_(body, false);
  }
  if (!actor.ok) return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  if (!unifiedProgressActorCanManage_(actor)) {
    return unifiedJson_({ ok: false, success: false, code: 'ACTION_SCOPE_DENIED', error: '你的身份不可以審批進度' });
  }
  if (action === 'bulkReviewRequests') return unifiedBulkReviewRequests_(body, actor);

  var requestId = String(body.request_id || '').trim();
  var decision = String(body.decision || '');
  if (!requestId || (decision !== 'approved' && decision !== 'rejected')) {
    return unifiedJson_({ ok: false, success: false, code: 'INVALID_REVIEW', error: '審批資料不完整' });
  }
  if (action === 'reviewLogRequest') {
    return handleReviewLogRequest(requestId, decision, safeSheetText(body.review_note, 500), actor.user);
  }
  return handleReviewRequest(requestId, decision, safeSheetText(body.review_note, 500),
    actor.ymis, String(body.confirmed_date || ''));
}

function unifiedPersonalProgress_(e, body, raw) {
  var action = String(body.action || '');
  var signed = unifiedVerifyLinkSig_(e, body, raw, UNIFIED_PERSONAL_PROGRESS_ACTIONS);
  var actor = null;
  if (!signed) {
    actor = unifiedResolveActor_(body, false);
    if (!actor.ok) return unifiedJson_({ success: false, ok: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  }
  var ymis = String((signed ? body.ymis : actor.ymis) || '').trim();
  if (!ymis) return unifiedJson_({ success: false, ok: false, error: '登入帳戶未綁定 YMIS' });
  if (action === 'loadMine') return unifiedJson_(unifiedLoadMine_(ymis));
  if (action === 'myRequests') {
    return unifiedJson_({ success: true, ok: true,
      requests: unifiedMemberProgressRequests_(ymis), unifiedGsVersion: UNIFIED_GS_VERSION });
  }
  if (action === 'addRequest') {
    var result = handleRequestComplete({
      itemId: body.item_id || body.itemId, itemName: body.item_name || body.itemName,
      requested_date: body.requested_date, evidence: body.evidence,
      items: body.items
    }, ymis);
    return result;
  }
  return unifiedJson_({ success: false, ok: false, error: 'Unknown personal progress action' });
}

// Member hub uses a deliberately separate contract from administrative loadDb:
// one opaque session, one roster identity, one visibility-filtered projection.
// Client memberId/role fields are never authoritative.
function unifiedHubClone_(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (err) { return null; }
}
// Positive output schemas: future admin columns remain private until explicitly listed.
function unifiedHubRsvp_(row) {
  if (!row || typeof row !== 'object') return null;
  return { status: String(row.status || row || ''), at: String(row.at || ''), name: String(row.name || ''),
    time: String(row.time || ''), reason: String(row.reason || '') };
}
function unifiedHubQuestion_(row) {
  row = row || {};
  return { id: String(row.id || ''), prompt: String(row.prompt || ''), type: String(row.type || 'short'),
    options: (Array.isArray(row.options) ? row.options : []).map(String), required: !!row.required };
}
function unifiedHubAnswers_(raw, questions) {
  var out = {}; raw = raw && typeof raw === 'object' ? raw : {};
  (questions || []).forEach(function (question) {
    var id = String(question && question.id || ''); if (!id) return;
    var value = raw[id];
    out[id] = question.type === 'multi'
      ? (Array.isArray(value) ? value : []).map(String)
      : String(value === undefined || value === null ? '' : value);
  });
  return out;
}
function unifiedHubEvent_(row, memberId) {
  row = row || {};
  var out = { id: String(row.id || ''), title: String(row.title || ''), date: String(row.date || ''),
    dateEnd: String(row.dateEnd || ''), time: String(row.time || ''), venue: String(row.venue || ''),
    detail: String(row.detail || ''), status: String(row.status || ''), vis: String(row.vis || ''),
    visibility: String(row.visibility || ''), rsvp: {} };
  var mine = row.rsvp && row.rsvp[memberId];
  if (mine !== undefined) out.rsvp[memberId] = unifiedHubRsvp_(mine);
  return out;
}
function unifiedHubQuiz_(row, memberId) {
  row = row || {};
  var questions = (Array.isArray(row.questions) ? row.questions : []).map(unifiedHubQuestion_);
  var out = { id: String(row.id || ''), title: String(row.title || ''), note: String(row.note || ''),
    status: String(row.status || ''), vis: String(row.vis || ''), questions: questions, responses: {} };
  var mine = row.responses && row.responses[memberId];
  if (mine !== undefined) out.responses[memberId] = { name: String(mine && mine.name || ''),
    at: String(mine && mine.at || ''), answers: unifiedHubAnswers_(mine && mine.answers, questions) };
  return out;
}
function unifiedHubNotice_(row, memberId, ymis) {
  row = row || {};
  var title = row.title && typeof row.title === 'object'
    ? { zh: String(row.title.zh || ''), en: String(row.title.en || '') }
    : { zh: String(row.title || ''), en: '' };
  var body = row.body && typeof row.body === 'object'
    ? { zh: String(row.body.zh || ''), en: String(row.body.en || '') }
    : { zh: String(row.body || ''), en: '' };
  var fields = (Array.isArray(row.fields) ? row.fields : []).map(function (field) {
    return { key: String(field && field.key || ''), label: String(field && field.label || ''),
      type: String(field && field.type || 'text'), required: !!(field && field.required),
      options: (Array.isArray(field && field.options) ? field.options : []).map(String) };
  });
  var mySignup = null;
  (Array.isArray(row.signups) ? row.signups : []).some(function (signup) {
    if (signup && ((memberId && String(signup.memberId || '') === String(memberId))
        || (ymis && String(signup.ymis || '') === String(ymis)))) { mySignup = signup; return true; }
    return false;
  });
  return { id: String(row.id || ''), title: title, body: body, status: String(row.status || ''), vis: String(row.vis || ''),
    type: String(row.type || ''), eventDate: String(row.eventDate || ''), deadline: String(row.deadline || ''), venue: String(row.venue || ''),
    assemblyTime: String(row.assemblyTime || ''), dismissTime: String(row.dismissTime || ''), assemblyPlace: String(row.assemblyPlace || ''),
    dismissPlace: String(row.dismissPlace || ''), fee: String(row.fee || ''), uniform: String(row.uniform || ''),
    bring: String(row.bring || ''), contact: String(row.contact || ''), needSignup: !!row.needSignup,
    fields: fields, publishAt: String(row.publishAt || ''),
    mySignup: mySignup ? { id: String(mySignup.id || ''), at: String(mySignup.at || ''), answers: unifiedHubClone_(mySignup.answers || {}) } : null };
}
function unifiedHubAbsence_(row) {
  row = row || {};
  return { id: String(row.id || ''), at: String(row.at || ''), unit: String(row.unit || ''),
    memberId: String(row.memberId || ''), ymis: String(row.ymis || ''), date: String(row.date || ''),
    slot: String(row.slot || ''), reason: String(row.reason || ''), plan: String(row.plan || ''),
    status: String(row.status || ''), reviewedBy: String(row.reviewedBy || ''),
    reviewedAt: String(row.reviewedAt || ''), reviewNote: String(row.reviewNote || '') };
}
function unifiedHubRank_(role) {
  var r = String(role || '').toLowerCase();
  if (r === 'super' || r === 'super_admin') return 6;
  if (r === 'chief' || r === 'admin' || r === 'group_leader') return 5;
  if (r === 'leader' || r === 'branch_leader') return 4;
  if (r === 'exco' || r === 'exec_committee') return 3;
  return r === 'member' ? 2 : 0;
}
function unifiedHubVisRank_(vis, fallback) {
  var v = String(vis || fallback || 'member').toLowerCase();
  return v === 'other' ? 2 : v === 'member' ? 2 : v === 'exco' ? 3 : v === 'leader' ? 4 : v === 'chief' ? 5 : 2;
}
function unifiedHubVisible_(record, kind, role) {
  var fallback = 'member';
  if (kind === 'event' && record && record.visibility === 'exco') fallback = 'exco';
  return unifiedHubVisRank_(record && record.vis, fallback) <= unifiedHubRank_(role);
}
function unifiedHubContext_(loaded, actor) {
  if (!loaded || loaded.success !== true || !loaded.db) return { ok: false, error: loaded && loaded.error || '後端未有資料庫' };
  var db = loaded.db;
  db.members = unifiedCanonicalMembers_(db.members || [], true);
  var wanted = String(actor.ymis || '').trim().toLowerCase();
  var member = null;
  db.members.some(function (row) {
    if (row && row.status !== 'alumni' && String(row.ymis || '').trim().toLowerCase() === wanted) { member = row; return true; }
    return false;
  });
  if (!member) return { ok: false, code: 'SESSION_ACCOUNT_MISSING', error: '登入帳戶未綁定有效名冊成員' };
  return { ok: true, db: db, member: member, role: actor.role, version: loaded.version || '', at: loaded.at || '' };
}
function unifiedHubProjection_(ctx) {
  var db = ctx.db;
  var member = ctx.member;
  var memberId = String(member.id || '');
  var ymis = String(member.ymis || '');
  var role = ctx.role;
  var unit = db.unit || {};
  var profile = db.profile || unit;
  var events = (db.events || []).filter(function (row) {
    return row && row.status !== 'cancelled' && unifiedHubVisible_(row, 'event', role);
  }).map(function (row) { return unifiedHubEvent_(row, memberId); });
  var quizzes = (db.quizzes || []).filter(function (row) {
    return row && row.status !== 'closed' && unifiedHubVisible_(row, 'quiz', role);
  }).map(function (row) { return unifiedHubQuiz_(row, memberId); });
  var notices = (db.notices || []).filter(function (row) {
    return row && row.status === 'published' && unifiedHubVisible_(row, 'notice', role);
  }).map(function (notice) { return unifiedHubNotice_(notice, memberId, ymis); });
  return { schema: db.schema || 2, kind: 'real', unitCode: String(db.unitCode || ''),
    unit: { code: String(unit.code || db.unitCode || ''), name: String(unit.name || ''), nameEn: String(unit.nameEn || ''), short: String(unit.short || ''), theme: unifiedHubClone_(unit.theme || {}) },
    profile: { code: String(profile.code || db.unitCode || ''), name: String(profile.name || unit.name || ''), nameEn: String(profile.nameEn || unit.nameEn || ''), short: String(profile.short || unit.short || ''), theme: unifiedHubClone_(profile.theme || unit.theme || {}) },
    settings: { troopLinks: unifiedHubClone_(db.settings && db.settings.troopLinks || {}) },
    constitution: db.constitution && db.constitution.status === 'published' ? unifiedHubClone_(db.constitution) : null,
    members: [{ id: memberId, ymis: ymis, name: String(member.name || ''), email: String(member.email || ''),
      identity: String(role || 'member'), status: String(member.status || 'active') }], accounts: [],
    events: events, quizzes: quizzes, notices: notices,
    absences: (db.absences || []).filter(function (row) {
      return row && ((memberId && String(row.memberId || '') === memberId) || (ymis && String(row.ymis || '') === ymis));
    }).map(unifiedHubAbsence_),
    meta: { updatedAt: String(db.meta && db.meta.updatedAt || ''), hubView: true } };
}
function unifiedHubEmpty_(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
}
function unifiedHubMutate_(ctx, body) {
  var db = ctx.db;
  var member = ctx.member;
  var memberId = String(member.id || '');
  var action = String(body.action || '');
  if (action === 'hubRsvp') {
    var event = (db.events || []).filter(function (row) { return row && String(row.id || '') === String(body.eventId || ''); })[0];
    if (!event || event.status === 'cancelled' || !unifiedHubVisible_(event, 'event', ctx.role)) return { ok: false, error: '搵唔到可回覆嘅活動' };
    var end = String(event.dateEnd || event.date || '').slice(0, 10);
    if (end && end < new Date().toISOString().slice(0, 10)) return { ok: false, error: '活動已經完結' };
    var status = String(body.status || '').toLowerCase();
    if (['present', 'absent', 'late', 'early'].indexOf(status) < 0) return { ok: false, error: '出席狀態唔正確' };
    var reason = String(body.reason || '').trim().slice(0, 500);
    var time = String(body.time || '').trim();
    if (status === 'absent' && !reason) return { ok: false, error: '不出席要填原因' };
    if ((status === 'late' || status === 'early') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, error: '時間格式唔正確' };
    event.rsvp = event.rsvp && typeof event.rsvp === 'object' ? event.rsvp : {};
    event.rsvp[memberId] = { status: status, at: new Date().toISOString().slice(0, 10), name: String(member.name || ''),
      time: status === 'late' || status === 'early' ? time : '', reason: reason };
    return { ok: true };
  }
  if (action === 'hubQuiz') {
    var quiz = (db.quizzes || []).filter(function (row) { return row && String(row.id || '') === String(body.quizId || ''); })[0];
    if (!quiz || quiz.status === 'closed' || !unifiedHubVisible_(quiz, 'quiz', ctx.role)) return { ok: false, error: '搵唔到可提交嘅試卷' };
    var supplied = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
    if (JSON.stringify(supplied).length > 50000) return { ok: false, error: '答卷太大' };
    var answers = {};
    (quiz.questions || []).forEach(function (question) {
      var qid = String(question && question.id || '');
      if (!qid) return;
      var value = supplied[qid];
      if (question.type === 'multi') {
        var options = (question.options || []).map(String);
        value = (Array.isArray(value) ? value : []).map(String).filter(function (answer) { return options.indexOf(answer) >= 0; }).slice(0, 50);
      } else if (question.type === 'single') {
        var choices = (question.options || []).map(String);
        value = String(value || ''); if (choices.indexOf(value) < 0) value = '';
      } else value = String(value || '').slice(0, question.type === 'para' ? 5000 : 1000);
      if (question.required && unifiedHubEmpty_(value)) throw new Error('請填：' + String(question.prompt || ''));
      answers[qid] = value;
    });
    quiz.responses = quiz.responses && typeof quiz.responses === 'object' ? quiz.responses : {};
    quiz.responses[memberId] = { name: String(member.name || ''), at: new Date().toISOString().slice(0, 10), answers: answers };
    return { ok: true };
  }
  if (action === 'hubNoticeSignup') {
    var notice = (db.notices || []).filter(function (row) { return row && String(row.id || '') === String(body.noticeId || ''); })[0];
    if (!notice || notice.status !== 'published' || !notice.needSignup || !unifiedHubVisible_(notice, 'notice', ctx.role)) {
      return { ok: false, error: '搵唔到可回覆嘅通告' };
    }
    var today = new Date().toISOString().slice(0, 10);
    if (String(notice.deadline || '').slice(0, 10) && String(notice.deadline || '').slice(0, 10) < today) return { ok: false, error: '通告報名已截止' };
    var supplied = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
    var answers = {}, invalid = '';
    (Array.isArray(notice.fields) ? notice.fields : []).some(function (field) {
      var key = String(field && field.key || '').slice(0, 80); if (!key) return false;
      var value = supplied[key];
      if (Array.isArray(value)) value = value.slice(0, 30).map(function (item) { return String(item == null ? '' : item).slice(0, 500); });
      else value = String(value == null ? '' : value).slice(0, 2000);
      if (field.required && unifiedHubEmpty_(value)) { invalid = String(field.label || key); return true; }
      answers[key] = value; return false;
    });
    if (invalid) return { ok: false, error: '請填：' + invalid };
    notice.signups = Array.isArray(notice.signups) ? notice.signups : [];
    var existing = -1;
    for (var si = 0; si < notice.signups.length; si++) {
      var signup = notice.signups[si];
      if (signup && ((memberId && String(signup.memberId || '') === memberId)
          || (String(member.ymis || '') && String(signup.ymis || '') === String(member.ymis || '')))) { existing = si; break; }
    }
    var signupId = existing >= 0 ? String(notice.signups[existing].id || '')
      : 'hsg_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    var savedSignup = { id: signupId, memberId: memberId, ymis: String(member.ymis || ''), name: String(member.name || ''),
      at: new Date().toISOString(), answers: answers, source: 'authenticated-hub' };
    if (existing >= 0) notice.signups[existing] = savedSignup; else notice.signups.push(savedSignup);
    return { ok: true, id: signupId };
  }
  if (action === 'hubAbsence') {
    db.absences = Array.isArray(db.absences) ? db.absences : [];
    if (body.op === 'withdraw') {
      var index = -1;
      for (var i = 0; i < db.absences.length; i++) if (String(db.absences[i] && db.absences[i].id || '') === String(body.id || '')) { index = i; break; }
      var existing = index >= 0 ? db.absences[index] : null;
      if (!existing) return { ok: true, idempotent: true };
      if (String(existing.memberId || '') !== memberId && String(existing.ymis || '') !== String(member.ymis || '')) return { ok: false, error: '呢張唔係你嘅請假單' };
      if (existing.status !== 'pending') return { ok: false, error: '已經處理咗，唔可以撤回' };
      db.absences.splice(index, 1); return { ok: true };
    }
    if (body.op !== 'create') return { ok: false, error: '請假操作唔正確' };
    var date = String(body.date || '').trim();
    var reasonA = String(body.reason || '').trim();
    var slot = String(body.slot || 'full');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < new Date().toISOString().slice(0, 10)) return { ok: false, error: '請揀今日或之後嘅日子' };
    if (!reasonA || reasonA.length > 2000) return { ok: false, error: '請寫 1 至 2000 字原因' };
    if (['full', 'am', 'pm', 'evening'].indexOf(slot) < 0) slot = 'full';
    var id = String(body.id || '');
    var planA = String(body.plan || '').trim().slice(0, 500);
    if (!/^ab_[A-Za-z0-9_-]{1,80}$/.test(id)) id = 'ab_' + Utilities.getUuid().replace(/-/g, '');
    var duplicate = null;
    db.absences.some(function (row) { if (String(row && row.id || '') === id) { duplicate = row; return true; } return false; });
    if (duplicate) {
      var sameOwner = String(duplicate.memberId || '') === memberId || String(duplicate.ymis || '') === String(member.ymis || '');
      var sameBody = String(duplicate.date || '') === date && String(duplicate.slot || '') === slot &&
        String(duplicate.reason || '') === reasonA && String(duplicate.plan || '') === planA;
      return sameOwner && sameBody ? { ok: true, id: id, idempotent: true } : { ok: false, error: '請假單編號重複' };
    }
    db.absences.push({ id: id, at: new Date().toISOString(), unit: String(db.unitCode || ''), memberId: memberId,
      ymis: String(member.ymis || ''), date: date, slot: slot, reason: reasonA, plan: planA,
      status: 'pending', reviewedBy: '', reviewedAt: '', reviewNote: '' });
    return { ok: true, id: id };
  }
  return { ok: false, error: '未知團員入口操作' };
}
function unifiedHubSave_(unit, ctx) {
  /* unifiedMemberHub_ has already fixed the actor and mutation to one member. The
     compatibility save gate therefore receives only this in-memory trusted marker. */
  var body = { action: 'saveDb', unit: unit, apiKey: getApiKey(), __serverSigned: true, db: ctx.db,
    baseVersion: ctx.version || '', refreshReports: false };
  return unifiedOutputObject_(PortalAdminCompat_.dispatchBody(unifiedPortalEvent_(null, body), body)) || { success: false, error: '儲存失敗' };
}
function unifiedMemberHub_(body) {
  var actor = unifiedResolveActor_(body, false);
  if (!actor.ok) return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
  var unit = String(body.unit || '');
  if (body.action === 'hubLoad') {
    var read = unifiedHubContext_(unifiedAdminSnapshot_(unit, { source: 'server-super', role: 'super' }, true), actor);
    if (!read.ok) return unifiedJson_({ ok: false, success: false, code: read.code || '', error: read.error });
    return unifiedJson_({ ok: true, success: true, found: true, db: unifiedHubProjection_(read),
      version: read.version, at: read.at, role: read.role, unifiedGsVersion: UNIFIED_GS_VERSION });
  }
  for (var attempt = 0; attempt < 2; attempt++) {
    var ctx = unifiedHubContext_(unifiedAdminSnapshot_(unit, { source: 'server-super', role: 'super' }, true), actor);
    if (!ctx.ok) return unifiedJson_({ ok: false, success: false, code: ctx.code || '', error: ctx.error });
    var applied;
    try { applied = unifiedHubMutate_(ctx, body); }
    catch (err) { applied = { ok: false, error: String(err && err.message || err) }; }
    if (!applied.ok) return unifiedJson_({ ok: false, success: false, error: applied.error });
    var saved = unifiedHubSave_(unit, ctx);
    if (saved.writePending === true) return unifiedJson_({ ok: false, success: false, writePending: true,
      error: saved.error || '寫入未能核對，請重新讀取' });
    if (saved.success === true) {
      if (saved.rosterSyncPending || saved.revisionPending) return unifiedJson_({ ok: false, success: false,
        rosterSyncPending: saved.rosterSyncPending === true, revisionPending: saved.revisionPending === true,
        warning: saved.warning || '已寫入，但核對未完成，請重新讀取', error: saved.warning || '已寫入，但核對未完成，請重新讀取' });
      return unifiedJson_({ ok: true, success: true, id: applied.id || '', version: saved.version || '',
        db: unifiedHubProjection_(ctx), unifiedGsVersion: UNIFIED_GS_VERSION });
    }
    if (!saved.conflict) return unifiedJson_({ ok: false, success: false, error: saved.error || '儲存失敗' });
  }
  return unifiedJson_({ ok: false, success: false, code: 'WRITE_CONFLICT', error: '資料已更新，請再試一次' });
}

function unifiedUpgradePreflight_() {
  var ss = getSheet();
  var progress = ss.getSheetByName('進度追蹤');
  if (progress && progress.getLastRow() > 0) {
    var expected = ['YMIS', '項目 ID', '完成日期', '更新時間', '確認者', '備註'];
    var width = Math.min(Math.max(progress.getLastColumn(), 4), expected.length);
    var actual = progress.getRange(1, 1, 1, width).getValues()[0];
    for (var i = 0; i < width; i++) {
      if (String(actual[i] || '').trim() !== expected[i]) {
        return '進度追蹤表頭與 BADGE 格式不符；未進行升級，請先備份並核對';
      }
    }
  }
  var users = ss.getSheetByName('Users');
  if (users && users.getLastRow() > 0) {
    var headers = users.getRange(1, 1, 1, Math.max(users.getLastColumn(), 1)).getValues()[0];
    if (!headers.some(function (h) { return String(h || '').trim() === 'ymis'; })) {
      return 'Users 表頭缺少 ymis；未進行升級，請先備份並核對';
    }
  }
  return '';
}

function unifiedInitializationResult_(result) {
  var message = result.success
    ? '初始化完成。共用後端結構已檢查；既有帳戶、歷史資料及 API Key 沿用。\n\nAPI Key = ' + getApiKey() + '\n\n管理員 YMIS: ' + ADMIN_YMIS + '；首次登入必須更改密碼。密碼最短 4 位。\n\n部署接入請使用 ADMIN FORM 提交旅團資料；此彈窗不會顯示或推算部署 URL。'
    : String(result.error || '升級未完成；請核對資料及執行紀錄。');
  try {
    var ui = SpreadsheetApp.getUi();
    if (ui) ui.alert(result.success ? '候選後端初始化完成' : '候選後端初始化未完成', message, ui.ButtonSet.OK);
  } catch (ignore) { /* headless */ }
  try { Logger.log(message); } catch (ignoreLog) {}
  result.apiKey = getApiKey();
  result.gsVersion = VS_GS_VERSION;
  result.initializedGsVersion = String(PropertiesService.getScriptProperties().getProperty(VS_GS_INITIALIZED_PROP) || '');
  result.gsInitializationCurrent = result.initializedGsVersion === VS_GS_VERSION;
  result.revision = VS_GS_REVISION;
  result.channel = releaseChannel_();
  return result;
}

function initializeSheets() {
  var props = PropertiesService.getScriptProperties();
  // A failed retry, including preflight failure, cannot retain a success marker.
  props.deleteProperty(UNIFIED_INITIALIZED_PROP);
  var preflight = unifiedUpgradePreflight_();
  if (preflight) return unifiedInitializationResult_({ success: false, error: preflight, unifiedGsVersion: UNIFIED_GS_VERSION });
  var badge = null, admin = null;
  try {
    badge = badgeInitializeSheets_();
    if (!badge || badge.success !== true) throw new Error('BADGE 初始化未完成');
    admin = PortalAdminCompat_.initializeSheets();
    if (!admin || admin.success !== true) throw new Error('行政初始化未完成');
    if (admin.skipped && admin.skipped.length) {
      throw new Error('以下分頁表頭未能識別：' + admin.skipped.map(function (r) { return r.tab; }).join('、'));
    }
  } catch (err) {
    return unifiedInitializationResult_({ success: false, badge: badge, admin: admin, partial: true,
      error: '升級未完成，可能已有結構增補；請核對後重試：' + String(err && err.message || err),
      unifiedGsVersion: UNIFIED_GS_VERSION });
  }
  // Retain the existing BADGE entrance policy, including an unset or closed flag.
  props.setProperty(UNIFIED_INITIALIZED_PROP, UNIFIED_GS_VERSION);
  return unifiedInitializationResult_({ success: true, badge: badge, admin: admin, preservedExistingData: true,
    unifiedGsVersion: UNIFIED_GS_VERSION });
}

/* Normal branch operation needs local login. Never change a retained flag merely
   because an old endpoint was called; the Sheet owner may explicitly reopen it. */
function menuLocalLoginOff() {
  var message = '支部本地帳戶／session 係正常登入來源，不能由此選單關閉。';
  try { SpreadsheetApp.getUi().alert('不可關閉支部本地入口', message, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return { success: false, code: 'BRANCH_LOCAL_LOGIN_REQUIRED', error: message,
    allow_local_login: localLoginAllowed() };
}

function onOpen() {
  /* Progress itself does not depend on entrance controls. */
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('🔗 支部系統')
      .addItem('🔧 初始化／更新（執行 initializeSheets）', 'menuInitializeSheets')
      .addItem('⏱️ 密碼 KDF 速度測試', 'menuBenchmarkPasswordKdf')
      .addSeparator()
      .addItem('📤 匯出支部帳戶 JSON（含 hash）', 'menuExportUsersJson')
      .addItem('📥 匯入支部帳戶 JSON', 'menuImportUsersJson')
      .addSeparator()
      .addItem('🔑 顯示 API KEY（交 ADMIN）', 'menuShowLinkCredentials')
      .addItem('🔓 開啟／復原本地登入', 'menuLocalLoginOn')
      .addToUi();
  } catch (e) { /* headless */ }
}

function unifiedLoadForActor_(actor, e) {
  if (unifiedProgressActorCanManage_(actor)) return badgeDoGet_(e);

  // A normal member may read only their own progress projection, never the full roster.
  var mine = unifiedLoadMine_(actor.ymis);
  var user = actor.user || {};
  var me = {
    name: String(user.name || ''), role: String(user.role || actor.role || 'member'),
    can_tick: user.can_tick === true, allowed_badges: String(user.allowed_badges || ''),
    force_change_password: user.force_change_password === true
  };
  return unifiedJson_(Object.assign({
    ok: true, success: true,
    members: mine.members || [], progress: mine.progress || {}, flatProgress: mine.flatProgress || {},
    pendingRequests: mine.pendingRequests || [], requests: mine.requests || [],
    otherBadges: mine.otherBadges || {}, logs: mine.logs || [], logsSupported: mine.logsSupported === true,
    logRequests: mine.logRequests || [], logRequestsSupported: mine.logRequestsSupported === true,
    me: me, unifiedGsVersion: UNIFIED_GS_VERSION
  }, getVsGsReleaseStatus()));
}

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || '');
  if (action === 'status' || action === 'ping' || action === 'test') {
    return PortalAdminCompat_.doGet(e);
  }
  if (action === 'notices' || action === 'constitution') {
    return unifiedJson_({ ok: false, success: false, code: 'SESSION_REQUIRED', error: '內容只限已登入支部成員' });
  }
  if (action === 'load') {
    var params = (e && e.parameter) || {};
    var token = String(params.token || '');
    if (!token) {
      return unifiedJson_({ ok: false, success: false, upstream_only: true,
        code: 'SIGNATURE_REQUIRED', error: 'load 必須經已驗證的支部 session 或同源伺服器簽名呼叫' });
    }
    // The pinned BADGE rescue session is stateless and remains valid even when
    // the ordinary local-login gate is closed. Validate it before delegating.
    if (isSuperAdminToken(token)) return badgeDoGet_(e);
    var actor = unifiedResolveActor_({ token: token }, false);
    if (!actor.ok) {
      return unifiedJson_({ ok: false, success: false, code: actor.code || 'SESSION_REQUIRED', error: actor.error });
    }
    return unifiedLoadForActor_(actor, e);
  }
  return badgeDoGet_(e);
}

function doPost(e) {
  var parsed = unifiedBody_(e);
  var body = parsed.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return unifiedJson_({ success: false, ok: false, error: '請求格式錯誤' });
  }
  if (Object.prototype.hasOwnProperty.call(body, '__serverSigned')) delete body.__serverSigned;
  if (Object.prototype.hasOwnProperty.call(body, '__serverActorRole')) delete body.__serverActorRole;
  if (Object.prototype.hasOwnProperty.call(body, '__serverActorSubject')) delete body.__serverActorSubject;
  if (Object.prototype.hasOwnProperty.call(body, '__serverIdentityMap')) delete body.__serverIdentityMap;
  var action = String(body.action || '');
  /* Release verification stays compatible with both frontends; API key is server-side only. */
  if (action === 'ecStatus') {
    var statusKey = PropertiesService.getScriptProperties().getProperty('API_KEY') || '';
    if (String(body.apikey || body.apiKey || '') !== String(statusKey)) {
      return unifiedJson_({ success: false, ok: false, error: 'Invalid API Key' });
    }
    return unifiedJson_(Object.assign({ success: true, timestamp: now() }, getVsGsReleaseStatus()));
  }
  /* Preserve BADGE's existing link controls. The pinned router validates the
     signed transport and replay nonce before it allows either action. */
  if (action === 'getLinkState' || action === 'setLocalLogin') return badgeDoPost_(e);
  try {
    if (UNIFIED_PORTAL_AUTH_ACTIONS[action]) {
      // authWhoAmI may be wrapped in the pinned baseline's server signature
      // transport. Verify/consume it, but identity still comes from the opaque
      // user session — a transport signature never becomes a user login.
      if (body.sig || (e && e.parameter && e.parameter.sig)) {
        var signedAuthActions = action === 'authWhoAmI' ? { authWhoAmI: 1 } : UNIFIED_ACCOUNT_ADMIN_ACTIONS;
        if (!unifiedVerifyLinkSig_(e, body, parsed.raw, signedAuthActions)) {
          return unifiedJson_({ success: false, ok: false, error: '簽名無效' });
        }
        /* Platform super 已由同源 API 驗證，但 Unified 帳戶權威係 pinned
           BADGE Users；不可藉舊 Portal alias 另建第二套身份。 */
        if (UNIFIED_ACCOUNT_ADMIN_ACTIONS[action] && body.unified_super === true
            && String(body.on_behalf || '') === 'sheep') {
          return unifiedJson_({ success: false, ok: false, code: 'BRANCH_IDENTITY_MANAGED',
            error: '支部帳戶由 BADGE Users 管理；請使用支部帳戶管理功能' });
        }
      }
      return unifiedOperationWrap_(body, action, function () { return unifiedAuthAlias_(action, body); });
    }
    if (UNIFIED_STAFF_PROGRESS_ACTIONS[action]
        && (action === 'bulkReviewRequests' || body.sig || (e && e.parameter && e.parameter.sig))) {
      return unifiedOperationWrap_(body, action, function () { return unifiedStaffProgress_(e, body, parsed.raw); });
    }
    if (action === 'progressAll') {
      var troopActor = unifiedResolveActor_(body, false);
      if (!troopActor.ok) return unifiedJson_({ ok: false, success: false, code: troopActor.code || 'SESSION_REQUIRED', error: troopActor.error });
      return unifiedProgressAll_(troopActor);
    }
    if (UNIFIED_PERSONAL_PROGRESS_ACTIONS[action]) {
      return unifiedOperationWrap_(body, action, function () { return unifiedPersonalProgress_(e, body, parsed.raw); });
    }
    if (UNIFIED_MEMBER_HUB_ACTIONS[action]) {
      return unifiedOperationWrap_(body, action, function () { return unifiedMemberHub_(body); });
    }
    if (UNIFIED_PUBLIC_PORTAL_ACTIONS[action] || UNIFIED_ADMIN_READ_ACTIONS[action] ||
        UNIFIED_ADMIN_WRITE_ACTIONS[action] || UNIFIED_ADMIN_DANGEROUS_ACTIONS[action]) {
      var signedActor = null;
      var unifiedAdminActions = {};
      var actionSet;
      [UNIFIED_ADMIN_READ_ACTIONS, UNIFIED_ADMIN_WRITE_ACTIONS, UNIFIED_ADMIN_DANGEROUS_ACTIONS].forEach(function (set) {
        for (actionSet in set) if (Object.prototype.hasOwnProperty.call(set, actionSet)) unifiedAdminActions[actionSet] = 1;
      });
      // Only the same-origin server sets these HMAC-covered flags after
      // verifying its own 8-hour platform super session.
      if (body.unified_super === true && String(body.on_behalf || '') === 'sheep' &&
          (body.sig || (e && e.parameter && e.parameter.sig)) &&
          unifiedVerifyLinkSig_(e, body, parsed.raw, unifiedAdminActions)) {
        signedActor = { ok: true, ymis: 'sheep', role: 'super', source: 'server-super',
          scopes: unifiedScopesForRole_('super'),
          user: { ymis: 'sheep', name: '系統管理員', role: 'super_admin' } };
      }
      return unifiedOperationWrap_(body, action, function () { return unifiedPortalAdmin_(e, body, signedActor); });
    }
    return unifiedOperationWrap_(body, action, function () { return badgeDoPost_(e); });
  } catch (err) {
    return unifiedJson_({ success: false, ok: false, error: String(err && err.message || err),
      unifiedGsVersion: UNIFIED_GS_VERSION });
  }
}
