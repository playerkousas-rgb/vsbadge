// vsbadge 同源 Proxy 架構 e2e 測試
// 流程：node tests/run-e2e.mjs
//   1. 起兩個 mock GAS（旅團 0082=A、1001=B），含 302 redirect hop
//   2. 起本機 app server：靜態檔 + 掛真實 api/proxy.js、api/troops.js（模擬 Vercel 行為）
//   3. 從 index.html 抽出真正的 apiRequest() 在 Node 執行，模擬瀏覽器請求
//   4. 斷言多旅團隔離、錯誤處理、SSRF 防護、靜態安全檢查
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startMockGas } from './mock-gas.mjs';

// ---- 必須在 import api 模組前設定 env（proxy 於 import 時讀 timeout） ----
process.env.VSBADGE_PROXY_TEST = '1';            // 允許 localhost mock（只限測試）
process.env.VSBADGE_PROXY_TIMEOUT_MS = '3000';   // 測試用短 timeout
process.env.TROOP_0082_BACKEND = 'http://127.0.0.1:3901/exec';
process.env.TROOP_0082_APIKEY = 'KEY_A';
process.env.TROOP_1001_BACKEND = 'http://127.0.0.1:3902/exec';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_PORT = 8899;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

async function postProxy(body, rawHeaders = {}) {
  const r = await fetch(`${APP_BASE}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...rawHeaders },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch (e) { /* non-json */ }
  return { status: r.status, json, headers: r.headers };
}

// ================== 1. 起 mock GAS ==================
console.log('\n【1】起兩個 mock GAS 旅團後端（含 GAS 式 302 redirect）');
const mockA = await startMockGas({
  port: 3901, name: '旅團A(0082)', apikey: 'KEY_A',
  users: [
    { ymis: '1234567890', name: '陳大文', role: 'group_leader', pass: 'PassA!234567', can_tick: true, email: 'a@example.org' },
    { ymis: '1234560001', name: '成員甲', role: 'member', pass: 'MemberA!234', can_tick: false }
  ]
});
const mockB = await startMockGas({
  port: 3902, name: '旅團B(1001)',
  users: [
    { ymis: '9876543210', name: '李小明', role: 'group_leader', pass: 'PassB!234567', can_tick: true, email: 'b@example.org' }
  ]
});
console.log(`  mock A: ${mockA.url}  mock B: ${mockB.url}`);

const stateOf = async (m) => (await fetch(m.url.replace('/exec', '/__state'))).json();
const control = async (m, c) => (await fetch(m.url.replace('/exec', '/__control'), { method: 'POST', body: JSON.stringify(c) })).json();

// ================== 2. 起 app server（靜態 + 真實 API handlers） ==================
console.log('\n【2】起本機 app server，掛載真實 api/proxy.js + api/troops.js');
const { default: proxyHandler } = await import('../api/proxy.js');
const { default: troopsHandler } = await import('../api/troops.js');
const { isTrustedExecUrl } = await import('../api/_registry.js');

function vercelize(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.md': 'text/markdown; charset=utf-8' };
const appServer = http.createServer((req, res) => {
  const u = new URL(req.url, APP_BASE);
  if (u.pathname === '/api/proxy') return proxyHandler(req, vercelize(res));
  if (u.pathname === '/api/troops') return troopsHandler(req, vercelize(res));
  if (u.pathname === '/__hang') return; // 永不回應（前端逾時測試）
  let p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise(r => appServer.listen(APP_PORT, '127.0.0.1', r));

// ================== 3. 抽出 index.html 的 apiRequest() 直接測試 ==================
console.log('\n【3】從 index.html 抽出真實 apiRequest() 測試（模擬瀏覽器呼叫）');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const mStart = html.indexOf('async function apiRequest(');
const mEnd = html.indexOf('\n}', mStart);
const apiSrc = html.slice(mStart, mEnd + 2);
const makeApi = (troopId, endpoint) =>
  new Function('API_ENDPOINT', 'currentTroopId', apiSrc + '\nreturn apiRequest;')(endpoint, troopId);
const apiA = makeApi('0082', `${APP_BASE}/api/proxy`);
const apiB = makeApi('1001', `${APP_BASE}/api/proxy`);
const apiBadTroop = makeApi('9999', `${APP_BASE}/api/proxy`);

// ---- 首頁及旅團選擇 ----
console.log('\n【4】首頁 + 旅團選擇 + 正確旅團配置載入');
{
  const r = await fetch(`${APP_BASE}/`);
  const t = await r.text();
  check('首頁可載入', r.status === 200 && t.includes('troopGrid'));
  check('首頁不含任何具體 GAS /exec URL', !/script\.google\.com\/macros\/s\/AKfyc/.test(t));
  check('首頁業務 API 指向同源 /api/proxy', t.includes("API_ENDPOINT='/api/proxy'"));

  const tr = await fetch(`${APP_BASE}/api/troops`);
  const tj = await tr.json();
  check('/api/troops 列出兩個旅團', !!tj.troops['0082'] && !!tj.troops['1001']);
  check('/api/troops 不洩漏 backend/apikey',
    !JSON.stringify(tj).includes('127.0.0.1:39') && !JSON.stringify(tj).includes('KEY_A') &&
    !('backend' in (tj.troops['0082']||{})) && !('apikey' in (tj.troops['0082']||{})));
}

// ---- 登入 / 錯誤密碼 ----
console.log('\n【5】登入 + 錯誤密碼');
let tokenA = '';
{
  const bad = await apiA('login', { login_id: '1234567890', password: 'wrong-pass' });
  check('錯誤密碼 → success:false + 錯誤訊息', bad.success === false && /密碼錯誤/.test(bad.error || ''));
  const ok = await apiA('login', { login_id: '1234567890', password: 'PassA!234567' });
  check('正確密碼 → success:true + token', ok.success === true && typeof ok.token === 'string');
  tokenA = ok.token;
}

// ---- 讀取資料（GET load 經 proxy，含 apikey 注入） ----
console.log('\n【6】讀取資料（GET load → proxy → mock A，驗證 302 follow + apikey 注入）');
{
  const d = await apiA('load', { token: tokenA });
  check('load 成功（伺服器端 apikey 注入有效，前端不用帶）', d.success === true);
  check('load 回傳成員列表', Array.isArray(d.members) && d.members.length === 2);
}

// ---- 新增/修改/儲存 + 重新讀取 ----
console.log('\n【7】新增/修改/儲存 → 重新讀取驗證落盤（旅團 A）');
{
  const s1 = await apiA('save', { token: tokenA, changes: [{ ymis: '1234560001', itemId: 'L1-01', date: '2026-08-05', uncomplete: false }], confirmer: '陳大文' });
  check('save 成功 processed=1', s1.success === true && s1.processed === 1);
  const stA = await stateOf(mockA);
  check('mock A 已有進度', !!stA.progress['1234560001']?.['L1-01']);
  const stB = await stateOf(mockB);
  check('mock B 無任何進度（隔離）', Object.keys(stB.progress).length === 0);
  const reload = await apiA('load', { token: tokenA });
  check('重新 load 讀回剛儲存的進度', reload.flatProgress?.['1234560001']?.['L1-01'] === '2026-08-05');
}

// ---- 錯誤旅團 ID 被拒絕 ----
console.log('\n【8】錯誤旅團 ID 被拒絕');
{
  const d = await apiBadTroop('load', { token: 'x'.repeat(10) });
  check('未知旅團 → success:false', d.success === false);
  const raw = await postProxy({ troopId: '9999', action: 'load', data: { token: 'x'.repeat(10) } });
  check('未知旅團 → HTTP 404', raw.status === 404);
  const badFmt = await postProxy({ troopId: '../../etc', action: 'load', data: { token: 'x'.repeat(10) } });
  check('惡意 troopId 格式 → HTTP 400', badFmt.status === 400);
}

// ---- SSRF / Open Proxy 防護 ----
console.log('\n【9】SSRF / Open Proxy 防護');
{
  check('拒絕任意外部 URL（unit）', !isTrustedExecUrl('http://evil.example.com/exec') && !isTrustedExecUrl('https://evil.example.com/macros/s/x/exec'));
  check('拒絕 GAS /dev URL', !isTrustedExecUrl('https://script.google.com/macros/s/AKfycbx1234567890abcdef/dev'));
  check('接受正常 GAS /exec URL', isTrustedExecUrl('https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/exec'));
  const before = (await stateOf(mockA)).execCount;
  const d = await apiA('save', { token: tokenA, backend: 'http://127.0.0.1:3999/evil', url: 'http://127.0.0.1:3999/evil', gasUrl: 'http://127.0.0.1:3999/evil', changes: [{ ymis: '1234560001', itemId: 'L1-02', date: '2026-08-05', uncomplete: false }] });
  const after = await stateOf(mockA);
  check('data 內夾帶 backend/url/gasUrl 被忽略，仍寫入 Registry 指定的 mock A', d.success === true && after.execCount === before + 1);
  const badAction = await postProxy({ troopId: '0082', action: 'adminDeleteAll', data: { token: 'x'.repeat(10) } });
  check('非白名單 action → HTTP 400', badAction.status === 400);
  const noToken = await postProxy({ troopId: '0082', action: 'save', data: { changes: [] } });
  check('受保護 action 無 token → HTTP 401', noToken.status === 401);
}

// ---- 後端失敗時不回傳假成功 ----
console.log('\n【10】後端各種失敗模式：proxy 一律 success:false（前端絕對不會顯示假成功）');
{
  await control(mockA, { mode: 'html-error' });
  const d1 = await apiA('save', { token: tokenA, changes: [{ ymis: '1', itemId: 'X', date: '', uncomplete: true }] });
  const r1 = await postProxy({ troopId: '0082', action: 'save', data: { token: tokenA, changes: [] } });
  check('上游回應 HTML 錯誤頁 → success:false', d1.success === false && r1.status === 502);
  check('回應含友善錯誤訊息', /回應格式異常|暫時無法使用/.test(d1.error || ''));

  await control(mockA, { mode: 'http500' });
  const d2 = await apiA('load', { token: tokenA });
  const r2 = await postProxy({ troopId: '0082', action: 'load', data: { token: tokenA } });
  check('上游 HTTP 500 → success:false + HTTP 502', d2.success === false && r2.status === 502);

  await control(mockA, { mode: 'slow', slowMs: 8000 });
  const t0 = Date.now();
  const d3 = await apiA('save', { token: tokenA, changes: [{ ymis: '1', itemId: 'X', date: '', uncomplete: true }] });
  const r3 = await postProxy({ troopId: '0082', action: 'load', data: { token: tokenA } });
  check('上游逾時 → success:false + HTTP 504', d3.success === false && r3.status === 504, `(got ${r3.status})`);
  check('逾時偵測在 timeout 內觸發 (<7s)', Date.now() - t0 < 7000, `took ${Date.now() - t0}ms`);

  await control(mockA, { mode: 'normal' });
  const d4 = await apiA('load', { token: tokenA });
  check('故障復原後可正常使用', d4.success === true);
}

// ---- 多旅團隔離 ----
console.log('\n【11】多旅團隔離：旅團 B 獨立寫入、token 不串用');
{
  const cross = await apiB('getPendingRequests', { token: tokenA });
  check('旅團 A 的 token 用於旅團 B → 被拒（不串用）', cross.success === false);
  const loginB = await apiB('login', { login_id: '9876543210', password: 'PassB!234567' });
  check('旅團 B 登入成功', loginB.success === true && !!loginB.token);
  const sB = await apiB('save', { token: loginB.token, changes: [{ ymis: '9876543210', itemId: 'L2-01', date: '2026-08-04', uncomplete: false }], confirmer: '李小明' });
  check('旅團 B 寫入成功', sB.success === true);
  const stB = await stateOf(mockB);
  check('寫入只落在 mock B', stB.progress['9876543210']?.['L2-01']?.date === '2026-08-04');
  const stA = await stateOf(mockA);
  check('mock A 無旅團 B 的資料', !stA.progress['9876543210']);
  // 登出
  const lo = await apiB('logout', { token: loginB.token });
  check('旅團 B 登出成功', lo.success === true);
  const after = await apiB('getPendingRequests', { token: loginB.token });
  check('登出後舊 token 已失效', after.success === false);
}

// ---- Proxy 回應規格 ----
console.log('\n【12】Proxy HTTP 規格');
{
  const g = await fetch(`${APP_BASE}/api/proxy`, { method: 'GET' });
  check('GET /api/proxy → 405', g.status === 405);
  const o = await fetch(`${APP_BASE}/api/proxy`, { method: 'OPTIONS' });
  check('OPTIONS → 405', o.status === 405);
  const r = await postProxy({ troopId: '0082', action: 'getLoginMode', data: {} });
  check('所有回應帶 Cache-Control: no-store', /no-store/.test(r.headers.get('cache-control') || ''));
  check('公開 action（getLoginMode）無 token 亦可', r.status === 200 && r.json.success === true);
  const badJson = await fetch(`${APP_BASE}/api/proxy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json{{' });
  check('壞 JSON body → 400', badJson.status === 400);
}

// ---- 真實 apiRequest 錯誤路徑 ----
console.log('\n【13】真實 apiRequest() 前端封裝錯誤路徑');
{
  const apiHtml = makeApi('0082', `${APP_BASE}/`); // 指向會回 HTML 的位址
  let msg = '';
  try { await apiHtml('login', { login_id: 'x', password: 'y' }); } catch (e) { msg = e.message; }
  check('非 JSON 回應 → throw 友善錯誤', /回應格式異常/.test(msg), msg);

  const apiHang = makeApi('0082', `${APP_BASE}/__hang`);
  msg = '';
  try { await apiHang('login', { login_id: 'x', password: 'y' }, { timeout: 800 }); } catch (e) { msg = e.message; }
  check('逾時 → throw 「連線逾時」', /連線逾時/.test(msg), msg);

  const apiDead = makeApi('0082', 'http://127.0.0.1:9/none');
  msg = '';
  try { await apiDead('login', { login_id: 'x', password: 'y' }); } catch (e) { msg = e.message; }
  check('網絡失敗 → throw「無法連接伺服器」', /無法連接伺服器/.test(msg), msg);
}

// ---- 前端靜態安全檢查 ----
console.log('\n【14】index.html 靜態安全檢查（代替 Browser Network 檢查）');
{
  const jsOnly = html.split('<script>')[1] || '';
  check('無 fetch(currentBackend / gasUrl / scriptUrl', !/fetch\(\s*(currentBackend|gasUrl|scriptUrl)/.test(jsOnly));
  check('無具體 GAS 部署 URL 硬編碼', !/script\.google\.com\/macros\/s\/AKfyc/.test(jsOnly));
  check('無 .catch(()=>{}) 靜默錯誤', !/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(jsOnly));
  const fetches = [...jsOnly.matchAll(/fetch\(([^,)]*)/g)].map(m => m[1].trim());
  const badFetch = fetches.filter(f => !/^['"]?(API_ENDPOINT|'\/api\/troops|'data\/)/.test(f) && !/^'data\//.test(f));
  check(`所有 fetch() 只去同源（發現 ${fetches.length} 個）`, badFetch.length === 0, badFetch.join(' | '));
  const apiCalls = [...jsOnly.matchAll(/apiRequest\('(\w+)'/g)].map(m => m[1]);
  const need = ['login','logout','apply','changePassword','getConfig','load','save','requestComplete','getPendingRequests','getApplications','reviewRequest','saveOtherBadge','getAllUsers','addUser','updateUserProfile','resetPassword','setUserStatus','getAuditLog','bulkAddUsers','updateConfig','updateUserRole','reviewApplication','submitRegistration'];
  const missing = need.filter(a => !apiCalls.includes(a));
  check('23 個 GAS action 全部經 apiRequest', missing.length === 0, 'missing: ' + missing.join(','));
}

// ---- 清理 ----
console.log(`\n========================================`);
console.log(`結果：${passed} 通過, ${failed} 失敗`);
appServer.close();
mockA.server.close();
mockB.server.close();
process.exit(failed ? 1 : 0);
