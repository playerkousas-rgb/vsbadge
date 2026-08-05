// 伺服器端可信旅團 Registry（只供 /api 內部使用，不會作為 endpoint 公開）
// 資料來源（全部在伺服器端解析，前端永遠看不到 GAS URL）：
//   1. data/troops.json ／ troops.json（存放在 Git 的公開 Registry）
//   2. Vercel 環境變數 TROOP_{ID}_BACKEND / TROOP_{ID}_APIKEY（優先於檔案）
// safety: backend 必須通過 isTrustedExecUrl() 驗證，否則視為未登記。

import fs from 'fs';
import path from 'path';

// 已登記的 GAS /exec URL 白名單格式（只接受 HTTPS 正式部署 URL，不接受 /dev）
const EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;

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
    const m = k.match(/^TROOP_([0-9A-Za-z]+)_(BACKEND|APIKEY)$/i);
    if (m) idsFromEnv.add(m[1]);
  }

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
    out[id] = {
      name,
      backend,
      apikey,
      backendTrusted: isTrustedExecUrl(backend)
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
  return { id, name: t.name, backend: t.backend.trim(), apikey: (t.apikey || '').trim() };
}

// 前端旅團選擇器專用：只暴露 id + name，任何情況都不回傳 backend / apikey
export function listPublicTroops() {
  const reg = getRegistry();
  const out = {};
  for (const [id, t] of Object.entries(reg)) {
    // 只有後端設定有效才列出（與舊版 /api/troops「有 backend 才算有效旅團」一致）
    if (t.backend) out[id] = { name: t.name };
  }
  return out;
}
