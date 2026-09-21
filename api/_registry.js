// 伺服器端環境變數 Registry；不讀取或公開旅團 JSON。
// 已登記的 GAS /exec URL 白名單格式（只接受 HTTPS 正式部署 URL，不接受 /dev）
const EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;

// 正規化 origin：只接受 http/https，並用 URL.origin 統一（小寫 host、去掉 path / query / hash）
// 用於 portalOrigin（主系統網址）比對，容許管理員填 "https://hub.example/app/" 這類寫法。
export function normalizeOrigin(v){
  if(typeof v!=='string') return '';
  const s=v.trim();
  if(!s) return '';
  try{
    const u=new URL(s);
    if(u.protocol!=='http:' && u.protocol!=='https:') return '';
    return u.origin;
  }catch(e){ return ''; }
}

// TROOP_{ID}_PORTALDISABLED 開關判定：設咗呢個變數就當「停用」，
// 除非明確寫 0 / false / no / off（方便管理員臨時開返）。
function isDisabledFlag(v){
  if(v===true) return true;
  if(typeof v!=='string') return false;
  const s=v.trim().toLowerCase();
  if(!s) return false;
  return !['0','false','no','off'].includes(s);
}

// 把 "a, b ,c" / ["a","b"] 轉成乾淨的字串陣列
function parseRoleList(v){
  if(Array.isArray(v)) return v.map(x=>String(x||'').trim()).filter(Boolean);
  if(typeof v!=='string') return [];
  return v.split(',').map(x=>x.trim()).filter(Boolean);
}

// 本機測試專用：設 VSBADGE_PROXY_TEST=1 時允許 http://127.0.0.1|localhost 的 mock GAS。
// 絕對不會影響 Vercel 正式環境（正式環境不會設定此變數）。
const TEST_LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[A-Za-z0-9._~\-/?=&%]*)?$/;

export function isTrustedExecUrl(url) {
  if (typeof url !== 'string' || url.length > 300) return false;
  if (EXEC_URL_RE.test(url.trim())) return true;
  if (process.env.VSBADGE_PROXY_TEST === '1' && process.env.VERCEL !== '1' && TEST_LOCAL_RE.test(url.trim())) return true;
  return false;
}

function envVar(...names) {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
  }
  return '';
}

// 每旅團三個必填變數：NAME / BACKEND / APIKEY；ID 保留前導零。
export function getRegistry() {
  const ids = new Set();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^TROOP_([0-9A-Za-z_-]{1,32})_(NAME|EN|BACKEND|APIKEY|PORTALORIGIN|PORTALROLES|PORTALDISABLED)$/);
    if (m) ids.add(m[1]);
  }
  const defaultOrigin = normalizeOrigin(envVar('PORTAL_DEFAULT_ORIGIN', 'VSBADGE_PORTAL_ORIGIN'));
  const defaultRoles = parseRoleList(envVar('PORTAL_DEFAULT_ROLES', 'VSBADGE_PORTAL_ROLES'));
  const out = Object.create(null);
  for (const id of ids) {
    const get = suffix => envVar(`TROOP_${id}_${suffix}`).trim();
    const backend = get('BACKEND');
    const roles = parseRoleList(get('PORTALROLES'));
    out[id] = {
      id, name: get('NAME'), en: get('EN'), backend, apikey: get('APIKEY'),
      backendTrusted: isTrustedExecUrl(backend),
      portalOrigin: normalizeOrigin(get('PORTALORIGIN')) || defaultOrigin,
      portalRoles: roles.length ? roles : defaultRoles,
      portalEnabled: !isDisabledFlag(get('PORTALDISABLED'))
    };
  }
  return out;
}

// Proxy 專用：只回傳通過 URL 白名單驗證的旅團
export function getTrustedTroop(id) {
  if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,32}$/.test(id)) return null;
  const reg = getRegistry();
  const t = reg[id];
  if (!t || !t.name || !t.apikey || !t.backend || !t.backendTrusted) return null;
  return {
    id,
    name: t.name,
    en: t.en || '',
    backend: t.backend.trim().replace(/\/$/, ''),
    apikey: (t.apikey || '').trim(),
    portalOrigin: t.portalOrigin || '',
    portalRoles: t.portalRoles || [],
    portalEnabled: t.portalEnabled !== false
  };
}

// 前端旅團選擇器專用：只暴露 id + name，任何情況都不回傳 backend / apikey
export function listPublicTroops() {
  const reg = getRegistry();
  const out = Object.create(null);
  for (const [id, t] of Object.entries(reg)) {
    // 三項必填設定齊備，並通過後端 URL 白名單才列出
    // 白名單輸出：只給 id + 顯示名稱。backend / apikey / portalOrigin / portalRoles 一律不外洩。
    if (t.name && t.apikey && t.backendTrusted) out[id] = { name: t.name, en: t.en || '' };
  }
  return out;
}
