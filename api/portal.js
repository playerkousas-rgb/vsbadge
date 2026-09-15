// Vercel Serverless Function — Portal 免登入身份驗證（v3.1）
//
// 背景：v3.0 及之前，index.html 的 handlePortalParams() 只信 URL 參數
//   ?u=0082&from=portal&role=super_admin&ymis=x
// 任何人砌這條網址即可取得超管身份（can_tick:true、allowed_badges:'*'、用戶管理／審批中心）。
// v3.1 起：前端必須先問這個 endpoint，由伺服器決定「這個旅團允不允許、從哪個網站、用哪個角色」。
//
// 安全原則（與 /api/proxy 一致）：
//   1. 只接受 GET；不加任何 CORS header（只給同源前端用，跨站讀不到結果）
//   2. 旅團必須在伺服器端 Registry 登記，且 backend 通過 isTrustedExecUrl()
//   3. 來源驗證：瀏覽器強制帶的 Referer/Origin + 主系統自行送的 src 參數，兩者都要對得上
//      （src 是可偽造的，所以只要有 Referer/Origin 就一定驗；兩者都沒有就當 no_origin）
//   4. 沒設 portalOrigin 的旅團 = 不開放 portal（fail closed）
//   5. 角色必須同時在「旅團 portalRoles 白名單」與「系統可勾選角色」內
//   6. log 只記 troopId / role / result，永不記 token / apikey / payload
//
// 注意：此 endpoint 只決定「前端顯不顯示免登入介面」；任何寫入仍然經 /api/proxy
// 由旅團 GAS 驗證 token／權限，所以即使這裡放行了也不會拿到旅團資料以外的權力。

import { getTrustedTroop, normalizeOrigin } from './_registry.js';

// 系統中具有勾選／管理能力的角色（portal 只可能帶這些身份進來）
const TICK_ROLES = ['admin', 'group_leader', 'branch_leader', 'exec_committee', 'super_admin'];
// 旅團沒設 portalRoles 時的預設白名單（最小權限）
const DEFAULT_PORTAL_ROLES = ['exec_committee'];

// 本機／預覽環境測試專用：設 VSBADGE_PORTAL_TEST=1 時放寬來源檢查（讓任何 origin 都能試 portal 流程）。
// 雙重保護：只要跑在 Vercel（VERCEL=1，正式與 Preview 部署皆然）就必定失效，
// 因此即使誤把這個 env 加到 Vercel 專案，也不會在生產環境開洞。
const PORTAL_TEST = process.env.VSBADGE_PORTAL_TEST === '1' && process.env.VERCEL !== '1';

function sendJson(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(obj);
}

function safeLog(fields) {
  // 只記錄 metadata，絕不記錄 token／密碼／apikey／payload
  try { console.log(JSON.stringify({ svc: 'vsbadge-portal', ...fields })); } catch (e) { /* ignore */ }
}

// Vercel 會提供 req.query；本機 dev server（純 node http）沒有，從 URL 自行解析
function queryOf(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    return Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams.entries());
  } catch (e) { return {}; }
}

function firstStr(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}

export default function handler(req, res) {
  const t0 = Date.now();

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    safeLog({ result: 'method_not_allowed', method: String(req.method || '').slice(0, 10), ms: Date.now() - t0 });
    return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
  }

  const q = queryOf(req);
  const u = firstStr(q.u).trim();
  const role = firstStr(q.role).trim();
  const src = normalizeOrigin(firstStr(q.src));

  // ---- 1. 旅團必須在 Registry 登記（含可信 backend）----
  const troop = getTrustedTroop(u);
  if (!troop) {
    safeLog({ result: 'unknown_troop', troopId: u.slice(0, 32), ms: Date.now() - t0 });
    return sendJson(res, 404, { ok: false, reason: 'unknown_troop' });
  }

  // ---- 2. 旅團必須已登記 portalOrigin（沒登記 = 不開放 portal）----
  if (!troop.portalOrigin) {
    safeLog({ result: 'troop_not_portal_enabled', troopId: troop.id, ms: Date.now() - t0 });
    return sendJson(res, 403, { ok: false, reason: 'troop_not_portal_enabled' });
  }

  // ---- 3. 來源驗證 ----
  // 瀏覽器一定會為導航／iframe 帶上 Referer（strict-origin-when-cross-origin 只送 origin），
  // 這個 header 由瀏覽器強制、前端 JS 改不到；src 是主系統自己送的參數，非瀏覽器 client 可偽造，
  // 所以兩個都要對得上 portalOrigin，缺一不可時至少要有一個。
  const headers = req.headers || {};
  const refOrigin = normalizeOrigin(firstStr(headers.referer || headers.referrer));
  const hdrOrigin = normalizeOrigin(firstStr(headers.origin));
  const origin = refOrigin || hdrOrigin;

  if (!PORTAL_TEST) {
    if (origin && origin !== troop.portalOrigin) {
      safeLog({ result: 'referer_mismatch', troopId: troop.id, ms: Date.now() - t0 });
      return sendJson(res, 403, { ok: false, reason: 'referer_mismatch', expected: troop.portalOrigin });
    }
    if (src && src !== troop.portalOrigin) {
      safeLog({ result: 'origin_not_allowed', troopId: troop.id, ms: Date.now() - t0 });
      return sendJson(res, 403, { ok: false, reason: 'origin_not_allowed', expected: troop.portalOrigin });
    }
    // curl / 直接打 URL：沒有 Referer 又沒有 src → 無法確認來源
    if (!origin && !src) {
      safeLog({ result: 'no_origin', troopId: troop.id, ms: Date.now() - t0 });
      return sendJson(res, 403, { ok: false, reason: 'no_origin', expected: troop.portalOrigin });
    }
  }

  // ---- 4. 角色白名單 ----
  const allowed = (troop.portalRoles && troop.portalRoles.length) ? troop.portalRoles : DEFAULT_PORTAL_ROLES;
  if (!allowed.includes(role) || !TICK_ROLES.includes(role)) {
    safeLog({ result: 'role_not_allowed', troopId: troop.id, role: role.slice(0, 40), ms: Date.now() - t0 });
    return sendJson(res, 403, { ok: false, reason: 'role_not_allowed', allowed });
  }

  safeLog({ result: 'ok', troopId: troop.id, role, ms: Date.now() - t0 });
  return sendJson(res, 200, {
    ok: true,
    role,
    troop: troop.id,
    name: troop.name
  });
}
