// 伺服器端可信旅團 Registry（只供 /api 內部使用，不會作為 endpoint 公開）
// 資料來源（全部在伺服器端解析，前端永遠看不到 GAS URL）：
//   1. data/troops.json ／ troops.json（存放在 Git 的公開 Registry）
//   2. Vercel 環境變數 TROOP_{ID}_BACKEND / TROOP_{ID}_APIKEY（優先於檔案）
// safety: backend 必須通過 isTrustedExecUrl() 驗證，否則視為未登記。

import fs from 'fs';
import path from 'path';

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
  if (process.env.VSBADGE_PROXY_TEST === '1' && TEST_LOCAL_RE.test(url.trim())) return true;
  return false;
}

function readFileTroops() {
  const candidates = [
    path.join(process.cwd(), 'data', 'troops.json'),
    path.join(process.cwd(), 'troops.json')
  ];
  const merged = {};
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const json = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (json && json.troops && typeof json.troops === 'object') {
          Object.assign(merged, json.troops);
        }
      }
    } catch (e) {
      // 檔案壞了不影響 env 來源；只在伺服器 log 提示
      console.warn('[registry] read troops file failed:', p);
    }
  }
  return merged;
}

function envVar(...names) {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
  }
  return '';
}

// 合併檔案 + 環境變數，回傳 { [id]: {name, backend, apikey, backendTrusted} }
export function getRegistry() {
  const fileTroops = readFileTroops();
  const idsFromEnv = new Set();
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^TROOP_([0-9A-Za-z]+)_(BACKEND|APIKEY|PORTALORIGIN|PORTALROLES|PORTALDISABLED)$/i);
    if (m) idsFromEnv.add(m[1]);
  }

  // 全域預設（可選）：所有旅團共用同一個主系統（hub）時，管理員只需設一個 env，
  // 唔使逐個旅團填 portalOrigin / portalRoles，改主系統地址亦只改一處。
  // 未設（預設）= 唔開放 portal，維持 fail closed；個別旅團自己的設定永遠優先，可覆寫。
  const defaultPortalOrigin = normalizeOrigin(
    envVar('PORTAL_DEFAULT_ORIGIN', 'VSBADGE_PORTAL_ORIGIN') || ''
  );
  const defaultPortalRoles = parseRoleList(
    envVar('PORTAL_DEFAULT_ROLES', 'VSBADGE_PORTAL_ROLES') || ''
  );

  const allIds = new Set([...Object.keys(fileTroops), ...idsFromEnv]);
  const out = {};
  for (const id of allIds) {
    const fileEntry = fileTroops[id] || {};
    const idUpper = String(id).toUpperCase();
    const idNoZero = String(id).replace(/^0+/, '') || String(id);
    const backend =
      envVar(`TROOP_${id}_BACKEND`, `TROOP_${idUpper}_BACKEND`, `TROOP_${idNoZero}_BACKEND`) ||
      fileEntry.backend || '';
    const apikey =
      envVar(`TROOP_${id}_APIKEY`, `TROOP_${idUpper}_APIKEY`, `TROOP_${idNoZero}_APIKEY`) ||
      fileEntry.apikey || '';
    const name = fileEntry.name || `第 ${id} 旅`;
    // v3.1 Portal 主系統接入設定（只供伺服器端 /api/portal 使用，永不對前端公開）
    //   portalOrigin：允許帶身份進入的主系統網址（origin，例如 https://82venture.vercel.app）
    //   portalRoles ：該旅團接受由主系統帶入的角色白名單
    // 優先次序：TROOP_{ID}_* env → troops.json 欄位 → 全域 PORTAL_DEFAULT_* env
    const portalOrigin =
      normalizeOrigin(
        envVar(`TROOP_${id}_PORTALORIGIN`, `TROOP_${idUpper}_PORTALORIGIN`, `TROOP_${idNoZero}_PORTALORIGIN`) ||
        fileEntry.portalOrigin || ''
      ) || defaultPortalOrigin;
    const ownRoles = parseRoleList(
      envVar(`TROOP_${id}_PORTALROLES`, `TROOP_${idUpper}_PORTALROLES`, `TROOP_${idNoZero}_PORTALROLES`) ||
      fileEntry.portalRoles || ''
    );
    const portalRoles = ownRoles.length ? ownRoles : defaultPortalRoles;
    // 個別旅團可以明確閂門（即使設咗全域預設都唔開放 portal）
    const portalDisabled =
      isDisabledFlag(envVar(`TROOP_${id}_PORTALDISABLED`, `TROOP_${idUpper}_PORTALDISABLED`, `TROOP_${idNoZero}_PORTALDISABLED`)) ||
      fileEntry.portalEnabled === false;
    out[id] = {
      id,
      name,
      en: fileEntry.en || '',
      backend,
      apikey,
      backendTrusted: isTrustedExecUrl(backend),
      portalOrigin,
      portalRoles,
      portalEnabled: !portalDisabled
    };
  }
  return out;
}

// Proxy 專用：只回傳通過 URL 白名單驗證的旅團
export function getTrustedTroop(id) {
  if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,32}$/.test(id)) return null;
  const reg = getRegistry();
  const t = reg[id];
  if (!t || !t.backend || !t.backendTrusted) return null;
  return {
    id,
    name: t.name,
    en: t.en || '',
    backend: t.backend.trim(),
    apikey: (t.apikey || '').trim(),
    portalOrigin: t.portalOrigin || '',
    portalRoles: t.portalRoles || [],
    portalEnabled: t.portalEnabled !== false
  };
}

// 前端旅團選擇器專用：只暴露 id + name，任何情況都不回傳 backend / apikey
export function listPublicTroops() {
  const reg = getRegistry();
  const out = {};
  for (const [id, t] of Object.entries(reg)) {
    // 只有後端設定有效才列出（與舊版 /api/troops「有 backend 才算有效旅團」一致）
    // 白名單輸出：只給 id + 顯示名稱。backend / apikey / portalOrigin / portalRoles 一律不外洩。
    if (t.backend) out[id] = { name: t.name, en: t.en || '' };
  }
  return out;
}
