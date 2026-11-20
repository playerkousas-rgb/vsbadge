// ============================================================
// VS unified branch backend — isolated test extension
//
// Composition:
//   1. exact vsbadge GS v9.6 baseline (identity, progress, badges, logs)
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

var UNIFIED_GS_VERSION = 'v9.6-u1-test';
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
    startedAt: rec.startedAt, updatedAt: rec.updatedAt, error: rec.error || '' };
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
    var resultText = '';
    try { resultText = JSON.stringify(result || {}); } catch (ignoreJson) {}
    if (resultText.length > 40000) resultText = JSON.stringify({ success: result && result.success === true,
      ok: result && result.ok === true, version: String(result && result.version || '') });
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
    if ((oldPublic.outcome === 'applied' || oldPublic.outcome === 'not_applied') && old.resultJson) {
      try {
        var replay = JSON.parse(old.resultJson);
        replay.operationId = old.id; replay.operation_id = old.id; replay.outcome = oldPublic.outcome;
        replay.operation = oldPublic; replay.deduplicated = true;
        return unifiedJson_(replay);
      } catch (ignoreReplay) {}
    }
    return unifiedJson_({ success: false, ok: false, reason: 'operation_in_progress',
      operationId: old.id, outcome: 'unknown', mayHaveApplied: true, operation: oldPublic,
      error: '同一操作編號已經處理過或仍在處理；為免重複，後端冇再次執行' });
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
    var outcome = applied ? 'applied' : 'not_applied';
    var finished = unifiedFinishOperation_(started, outcome, parsed, parsed.error || '');
    parsed.operationId = started.id;
    parsed.operation_id = started.id;
    parsed.outcome = outcome;
    parsed.mayHaveApplied = applied;
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
      error: '隔離 fixture 的 legacy 入口旗標已關閉；正式支部請重新執行 initializeSheets()' };
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

function unifiedCanonicalMembers_(existing) {
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
    merged.name = safeSheetText(prior.name, 100) || String(rows[i][1] || user.name || '');
    merged.branch = safeSheetText(prior.branch, 100) || String(rows[i][3] || user.branch || '');
    merged.email = isEmail(prior.email) ? String(prior.email).trim()
      : String(user.email || (isEmail(rows[i][4]) ? rows[i][4] : ''));
    merged.phone = safeSheetText(prior.phone, 80)
      || (isEmail(rows[i][4]) ? '' : String(rows[i][4] || ''));
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

function unifiedPrepareAdminDb_(db) {
  db = db && typeof db === 'object' && !Array.isArray(db) ? db : {};
  db.members = unifiedCanonicalMembers_(db.members || []);
  db.accounts = unifiedAccountProjection_(db.members);
  return db;
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
  /* Keep the requested roster for a post-confirmation mirror update. Calling
     unifiedUpsertRoster_ before compatibility validation used to mutate 成員名單
     and Users even when a stale version or protected-field request was rejected. */
  var rosterAfterSuccess = null;
  if (action === 'saveDb' || action === 'saveDbForce') {
    rosterAfterSuccess = body.db && Array.isArray(body.db.members) ? body.db.members : null;
    body.db = unifiedPrepareAdminDb_(body.db);
  } else if (action === 'saveTables') {
    body.tables = body.tables && typeof body.tables === 'object' ? body.tables : {};
    if (Object.prototype.hasOwnProperty.call(body.tables, 'members')) {
      rosterAfterSuccess = Array.isArray(body.tables.members) ? body.tables.members : null;
      body.tables.members = unifiedCanonicalMembers_(body.tables.members);
    }
    if (Object.prototype.hasOwnProperty.call(body.tables, 'accounts')) {
      body.tables.accounts = unifiedAccountProjection_(unifiedCanonicalMembers_(body.tables.members || []));
    }
  }
  if (actor.source !== 'server-super' && !branchOwner) body.__serverIdentityMap = unifiedAuthoritativeIdentityMap_();
  var out = PortalAdminCompat_.dispatchBody(unifiedPortalEvent_(e, body), body);
  var parsed = unifiedOutputObject_(out);
  if (!parsed) return out;
  if (parsed.success === true) {
    if (action === 'saveDbCommit') {
      var committed = PortalAdminCompat_.loadDb(String(body.unit || ''));
      rosterAfterSuccess = committed && committed.success && committed.db && Array.isArray(committed.db.members)
        ? committed.db.members : null;
    }
    if (rosterAfterSuccess) {
      try { unifiedUpsertRoster_(rosterAfterSuccess); }
      catch (rosterErr) {
        /* The compatibility DB is already confirmed. Report a recoverable mirror
           warning instead of claiming the rejected request changed nothing or
           falsely changing success into a total failure. A retry is idempotent. */
        parsed.rosterSyncPending = true;
        parsed.warning = '行政資料已儲存，但中央名冊鏡像未完成；請重試同步';
      }
    }
  }
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
  return { success: true, ok: true, member: member, members: member ? [member] : [],
    progress: progress, flatProgress: flat, otherBadges: other,
    logs: (all.logs || []).filter(function (r) { return String(r.ymis || '') === String(ymis || ''); }),
    logRequests: (all.logRequests || []).filter(function (r) { return String(r.ymis || '') === String(ymis || ''); }),
    /* Baseline handleLoad only exposes pending rows.  A member's own safe history must
       keep approved/rejected rows too, otherwise the UI says the application vanished. */
    requests: unifiedMemberProgressRequests_(ymis),
    unifiedGsVersion: UNIFIED_GS_VERSION };
}

function unifiedProgressActorCanManage_(actor) {
  if (!actor || !actor.ok) return false;
  var scopes = Array.isArray(actor.scopes) ? actor.scopes : unifiedScopesForRole_(actor.role);
  return unifiedRoleRank_(actor.role) >= unifiedRoleRank_('exco')
    && scopes.indexOf('progress:manage') >= 0;
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
  db.members = unifiedCanonicalMembers_(db.members || []);
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
    var read = unifiedHubContext_(PortalAdminCompat_.loadDb(unit), actor);
    if (!read.ok) return unifiedJson_({ ok: false, success: false, code: read.code || '', error: read.error });
    return unifiedJson_({ ok: true, success: true, found: true, db: unifiedHubProjection_(read),
      version: read.version, at: read.at, role: read.role, unifiedGsVersion: UNIFIED_GS_VERSION });
  }
  for (var attempt = 0; attempt < 2; attempt++) {
    var ctx = unifiedHubContext_(PortalAdminCompat_.loadDb(unit), actor);
    if (!ctx.ok) return unifiedJson_({ ok: false, success: false, code: ctx.code || '', error: ctx.error });
    var applied;
    try { applied = unifiedHubMutate_(ctx, body); }
    catch (err) { applied = { ok: false, error: String(err && err.message || err) }; }
    if (!applied.ok) return unifiedJson_({ ok: false, success: false, error: applied.error });
    var saved = unifiedHubSave_(unit, ctx);
    if (saved.success === true) {
      return unifiedJson_({ ok: true, success: true, id: applied.id || '', version: saved.version || '',
        db: unifiedHubProjection_(ctx), unifiedGsVersion: UNIFIED_GS_VERSION });
    }
    if (!saved.conflict) return unifiedJson_({ ok: false, success: false, error: saved.error || '儲存失敗' });
  }
  return unifiedJson_({ ok: false, success: false, code: 'WRITE_CONFLICT', error: '資料已更新，請再試一次' });
}

function initializeSheets() {
  var badge = badgeInitializeSheets_();
  var admin = null;
  try { admin = PortalAdminCompat_.initializeSheets(); }
  catch (err) {
    return { success: false, badge: badge, admin: null,
      error: '進度基線已初始化，但行政分頁增補失敗：' + String(err && err.message || err),
      unifiedGsVersion: UNIFIED_GS_VERSION };
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ALLOW_LOCAL_LOGIN', 'true');
  props.setProperty(UNIFIED_INITIALIZED_PROP, UNIFIED_GS_VERSION);
  return { success: true, badge: badge, admin: admin, preservedExistingData: true,
    unifiedGsVersion: UNIFIED_GS_VERSION };
}

/* 支部本地帳戶／session 是正常登入，Sheet 選單不可關閉。Pinned BADGE
   baseline 的 legacy helpers 只為來源兼容保留；Progress client 與 API 不路由入口控制。 */
function menuLocalLoginOff() {
  var message = '支部本地帳戶／session 係正常登入來源，必須保持開啟。';
  try { SpreadsheetApp.getUi().alert('不可關閉支部本地入口', message, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  try { setLocalLoginAllowed(true, 'unified-branch-login-guard'); } catch (e2) {}
  try { Logger.log(message); } catch (e3) {}
  return { success: false, code: 'BRANCH_LOCAL_LOGIN_REQUIRED', error: message,
    allow_local_login: localLoginAllowed() };
}

function onOpen() {
  /* Branch deployment exposes only branch-safe owner operations. Pinned baseline
     legacy controls are not a Progress contract and never appear in this Sheet menu. */
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('🔗 支部系統')
      .addItem('🔧 初始化／更新（執行 initializeSheets）', 'menuInitializeSheets')
      .addItem('⏱️ 密碼 KDF 速度測試', 'menuBenchmarkPasswordKdf')
      .addSeparator()
      .addItem('📤 匯出支部帳戶 JSON（含 hash）', 'menuExportUsersJson')
      .addItem('📥 匯入支部帳戶 JSON', 'menuImportUsersJson')
      .addSeparator()
      .addItem('🔑 顯示 API KEY（交 APP ADMIN）', 'menuShowLinkCredentials')
      .addItem('🔓 開啟／復原本地登入', 'menuLocalLoginOn')
      .addToUi();
  } catch (e) { /* headless */ }
}

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || '');
  if (action === 'status' || action === 'ping' || action === 'test') {
    return PortalAdminCompat_.doGet(e);
  }
  if (action === 'notices' || action === 'constitution') {
    return unifiedJson_({ ok: false, success: false, code: 'SESSION_REQUIRED', error: '內容只限已登入支部成員' });
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
  /* Pinned BADGE keeps these historical handlers internally, but the Unified public
     router never exposes an entrance-state or entrance-control contract. Invoking an
     old action restores the required local-login flag and fails closed. */
  if (action === 'getLinkState' || action === 'setLocalLogin') {
    PropertiesService.getScriptProperties().setProperty('ALLOW_LOCAL_LOGIN', 'true');
    return unifiedJson_({ ok: false, success: false, code: 'BRANCH_LOCAL_LOGIN_REQUIRED',
      error: '支部本地登入必須保持開啟；Unified 不提供入口狀態或控制 action' });
  }
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
