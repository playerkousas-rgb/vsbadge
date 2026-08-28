// Vercel 同源 Proxy — 多旅團 GAS 安全轉發層
//
// 架構：
//   瀏覽器 ──同源 POST──▶ /api/proxy ──伺服器端──▶ 已登記旅團的 GAS /exec ──▶ Google Sheet
//
// 安全原則：
//   1. 前端只提交 troopId，永不提交後端 URL（杜絕 SSRF / Open Proxy）
//   2. GAS URL 全部由伺服器端可信 Registry（data/troops.json + TROOP_* env）解析
//   3. 只接受白名單 HTTPS GAS /exec URL（見 api/_registry.js isTrustedExecUrl）
//   4. 只接受 action 白名單；寫入／讀取類 action 必須附帶 token 字串（真偽由 GAS 驗證）
//   5. 永不在 log 記錄 token／密碼／apikey／payload 內容
//
// GAS request schema 完全保留（action + 原欄位），不需要修改任何 Code.gs。

import { getTrustedTroop, isTrustedExecUrl } from './_registry.js';

export const config = { maxDuration: 60 };

// ---- 可調參數（皆可由 Vercel env 覆寫）----
const UPSTREAM_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.VSBADGE_PROXY_TIMEOUT_MS || '45000', 10);
  if (Number.isNaN(v)) return 45000;
  return Math.max(1000, Math.min(55000, v));
})();
const MAX_DATA_BYTES = 2 * 1024 * 1024; // 單次請求 data 上限（bulkAddUsers 一批 100 人 << 1MB）

// 中央管理員收件匣（新旅團接入申請）。目的地是伺服器端固定常數，不由用戶輸入決定。
const SCOUT_ADMIN_API = process.env.SCOUT_ADMIN_API ||
  'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';

// ---- action 白名單（對照 Code.gs doGet/doPost）----
// 公開（無需 token）
const PUBLIC_ACTIONS = new Set(['login', 'apply', 'getLoginMode']);
// 需要登入 token 的旅團內操作
const TOKEN_ACTIONS = new Set([
  'logout', 'load', 'getConfig', 'getMembers', 'getOtherBadges',
  'save', 'saveOtherBadge', 'requestComplete',
  'getPendingRequests', 'reviewRequest',
  'getLogRecords', 'saveLogRecord', 'deleteLogRecord',
  'requestLogRecord', 'getLogRequests', 'reviewLogRequest', 'cancelLogRequest',
  'getAllUsers', 'addMember', 'addUser', 'bulkAddUsers',
  'resetPassword', 'updateUserProfile', 'setUserStatus',
  'getApplications', 'reviewApplication',
  'updateUserRole', 'updatePermissions', 'updateConfig',
  'changePassword', 'getAuditLog'
]);
// Proxy 內部特殊 action（不轉發去旅團 GAS）
const LOCAL_ACTIONS = new Set(['submitRegistration']);
// GAS 端以 doGet 處理的 action（其餘一律 POST 去 doPost）
const GET_ACTIONS = new Set(['load', 'getLoginMode']);

function sendJson(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(obj);
}

function safeLog(fields) {
  // 只記錄 metadata，絕不記錄 token／密碼／apikey／payload
  try { console.log(JSON.stringify({ svc: 'vsbadge-proxy', ...fields })); } catch (e) { /* ignore */ }
}

async function readRawBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel 已解析 JSON
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_DATA_BYTES + 1024) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

// 轉發到指定 GAS URL；redirect: 'follow' 讓 Node fetch 在伺服器端跟隨 GAS 的 302
async function callUpstream(url, { method, params, payload }) {
  const init = { method, redirect: 'follow', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) };
  let target = url;
  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') continue; // query 只放簡單值
      qs.set(k, String(v));
    }
    target = url + (url.includes('?') ? '&' : '?') + qs.toString();
  } else {
    init.headers = { 'Content-Type': 'text/plain;charset=utf-8' }; // 與前端舊寫法一致，GAS postData.contents 原樣收到
    init.body = JSON.stringify(payload || {});
  }
  const up = await fetch(target, init);
  const text = await up.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: up.status, json, raw: text };
}

export default async function handler(req, res) {
  const t0 = Date.now();

  // 只接受所需 HTTP method
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    safeLog({ result: 'method_not_allowed', method: req.method, ms: Date.now() - t0 });
    return sendJson(res, 405, { success: false, error: '此 API 只接受 POST 請求' });
  }

  const body = await readRawBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { success: false, error: '請求格式錯誤' });
  }

  const action = String(body.action || '');
  const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {};
  const troopId = String(body.troopId || '').trim();

  // 輸入驗證：action 白名單
  if (!PUBLIC_ACTIONS.has(action) && !TOKEN_ACTIONS.has(action) && !LOCAL_ACTIONS.has(action)) {
    safeLog({ result: 'bad_action', action: action.slice(0, 40), ms: Date.now() - t0 });
    return sendJson(res, 400, { success: false, error: '不支援的操作' });
  }
  // 輸入驗證：payload 大小
  let dataBytes = 0;
  try { dataBytes = Buffer.byteLength(JSON.stringify(data), 'utf8'); } catch (e) { dataBytes = MAX_DATA_BYTES + 1; }
  if (dataBytes > MAX_DATA_BYTES) {
    return sendJson(res, 413, { success: false, error: '提交內容過大，請分批處理' });
  }

  // ===== 特殊：新旅團接入申請（轉發去中央管理員收件匣，目的地固定於伺服器端）=====
  if (action === 'submitRegistration') {
    if (!isTrustedExecUrl(SCOUT_ADMIN_API)) {
      safeLog({ result: 'admin_api_misconfig', ms: Date.now() - t0 });
      return sendJson(res, 500, { success: false, error: '伺服器設定錯誤，請聯絡管理員' });
    }
    const regPayload = {
      troopId: String(data.troopId || '').substring(0, 32),
      troopName: String(data.troopName || '').substring(0, 100),
      scriptUrl: String(data.scriptUrl || '').substring(0, 300),
      apiKey: String(data.apiKey || '').substring(0, 120),
      appType: 'vsbadge',
      note: String(data.note || '').substring(0, 500)
    };
    try {
      const up = await callUpstream(SCOUT_ADMIN_API, { method: 'POST', payload: regPayload });
      if (!up.json) {
        safeLog({ result: 'admin_upstream_bad', status: up.status, ms: Date.now() - t0 });
        return sendJson(res, 502, { success: false, error: '申請未能送達管理員，請稍後重試' });
      }
      safeLog({ result: 'registration_ok', status: up.status, ms: Date.now() - t0 });
      return sendJson(res, 200, { success: true, message: '申請已提交' });
    } catch (e) {
      const timeout = e && e.name === 'TimeoutError';
      safeLog({ result: timeout ? 'admin_timeout' : 'admin_fetch_error', ms: Date.now() - t0 });
      return sendJson(res, timeout ? 504 : 502, { success: false, error: timeout ? '提交逾時，請稍後重試' : '申請未能送達管理員，請稍後重試' });
    }
  }

  // ===== 一般旅團 action：必須給 troopId，由伺服器端 Registry 解析 GAS URL =====
  if (!/^[0-9A-Za-z_-]{1,32}$/.test(troopId)) {
    return sendJson(res, 400, { success: false, error: '旅團編號格式不正確' });
  }
  const troop = getTrustedTroop(troopId);
  if (!troop) {
    safeLog({ result: 'unknown_troop', troopId, ms: Date.now() - t0 });
    return sendJson(res, 404, { success: false, error: '找不到此旅團，或旅團後端設定無效，請聯絡管理員' });
  }

  // 需要 token 的 action：字串必須存在（真偽仍由 GAS 驗證）
  if (TOKEN_ACTIONS.has(action)) {
    if (typeof data.token !== 'string' || data.token.length < 4 || data.token.length > 200) {
      return sendJson(res, 401, { success: false, error: '未登入或登入已過期，請重新登入' });
    }
  }

  // apikey 注入：伺服器端 Registry 有就用伺服器的（覆寫前端值）；
  // 沒有就讓前端舊值通過（向後兼容 apikey 模式的舊部署）；兩者皆無則不帶。
  const effectiveApikey = troop.apikey || (typeof data.apikey === 'string' ? data.apikey : '');

  try {
    let up;
    if (GET_ACTIONS.has(action)) {
      up = await callUpstream(troop.backend, {
        method: 'GET',
        params: { action, apikey: effectiveApikey || undefined, token: data.token }
      });
    } else {
      const payload = { action, ...data };
      if (effectiveApikey) payload.apikey = effectiveApikey;
      up = await callUpstream(troop.backend, { method: 'POST', payload });
    }

    if (!up.json) {
      // 上游 HTTP 失敗或回應非 JSON（GAS HTML error page）
      safeLog({ result: 'upstream_bad_response', troopId, action, status: up.status, ms: Date.now() - t0 });
      const msg = up.status >= 400
        ? `旅團後端暫時無法使用（HTTP ${up.status}），請稍後重試`
        : '旅團後端回應格式異常，請稍後重試或通知管理員檢查 Apps Script 部署';
      return sendJson(res, 502, { success: false, error: msg });
    }

    safeLog({ result: 'ok', troopId, action, status: up.status, ms: Date.now() - t0 });
    // GAS 業務錯誤（success:false）照原樣回傳，前端按語意顯示
    return sendJson(res, 200, up.json);
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    safeLog({ result: timeout ? 'upstream_timeout' : 'upstream_fetch_error', troopId, action, ms: Date.now() - t0 });
    return sendJson(res, timeout ? 504 : 502, {
      success: false,
      error: timeout ? '旅團後端回應逾時，操作可能未完成，請先重新載入確認狀態才重試' : '無法連接旅團後端，請稍後重試'
    });
  }
}
