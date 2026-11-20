#!/usr/bin/env node
/*
 * Build the isolated unified Apps Script test artifact.
 *
 * Source order is intentional:
 *   - exact vsbadge v9.6 is the executable global baseline;
 *   - the old Portal backend is enclosed in an IIFE, so none of its 89 global
 *     names can shadow the baseline;
 *   - unified-extension.gs owns only the public entry points.
 *
 * The composed artifact is the complete branch capability superset. vs_portal is
 * the full-featured frontend and vsbadge is the lightweight frontend; the baseline
 * source order does not create a separate or reduced BADGE backend. Both clients
 * remain constrained by action allowlists and server-side session/role/scope checks.
 *
 * This script never writes apps-script/Code.gs. It writes the isolated GS artifact
 * plus a generated module used by the local contract test; existing Apps Script
 * deployments remain untouched until somebody deploys it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = path.resolve(ROOT, '..');
const SRC = path.join(ROOT, 'apps-script', 'unified-src');
const OUT = path.join(ROOT, 'apps-script', 'UnifiedCode.gs');
const BROWSER_OUT = path.join(ROOT, 'assets', 'js', 'lib', 'unifiedtemplate.generated.js');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

function read(name) { return fs.readFileSync(path.join(SRC, name), 'utf8').replace(/\r\n/g, '\n'); }
function readBaseline() { return fs.readFileSync(path.join(PROJECT_ROOT, manifest.baseline.path), 'utf8').replace(/\r\n/g, '\n'); }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function replaceOne(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one occurrence, found ${count}`);
  return source.replace(needle, replacement);
}

let baseline = readBaseline();
let portal = read('portal-admin-v2.8.8.gs');
const extension = read('unified-extension.gs');

if (sha256(baseline) !== manifest.baseline.sha256) {
  throw new Error('vsbadge baseline hash mismatch; refresh manifest deliberately instead of silently drifting');
}
if (sha256(portal) !== manifest.portalCompatibility.sha256) {
  throw new Error('Portal compatibility hash mismatch; it must stay a known generated artifact');
}
if (!baseline.includes(`const VS_GS_VERSION = '${manifest.baseline.version}';`)) {
  throw new Error('manifest baseline version does not match the vendored source');
}
/* The vendored checkpoint remains byte-exact; only normalize historical EOL spaces
 * in the generated artifact so repository whitespace checks stay actionable. */
baseline = baseline.replace(/[ \t]+$/gm, '');

/* This vendored compatibility input is the exact v2.8.8 Portal apps-script/Code.gs
 * checkpoint pinned in the manifest. The source hash prevents accidental drift
 * before it is wrapped by the Unified router. */

// Keep all baseline helpers global, but hand the four public entry points to the
// unified router.  Internal menu callbacks that call initializeSheets() now
// deliberately call the unified additive initializer.
baseline = replaceOne(baseline, 'function initializeSheets() {', 'function badgeInitializeSheets_() {', 'initializeSheets');
baseline = replaceOne(baseline, 'function doGet(e){', 'function badgeDoGet_(e){', 'doGet');
baseline = replaceOne(baseline, 'function doPost(e){', 'function badgeDoPost_(e){', 'doPost');
baseline = replaceOne(baseline, 'function onOpen(){', 'function badgeOnOpen_(){', 'onOpen');
/* Branch local accounts remain the normal login source. Keep the pinned implementation
 * intact on disk, but make the generated Sheet menu describe the guarded callback
 * truthfully: menuLocalLoginOff is overridden and cannot close it. */
baseline = replaceOne(baseline,
  ".addItem('🔒 閂口（只收 sig）','menuLocalLoginOff')",
  ".addItem('ℹ️ 支部本地登入必須保持開啟','menuLocalLoginOff')",
  'local-login menu label');
baseline = replaceOne(baseline,
  '// 旅系統（旅 > 團 > 進度）：上游登記下游 URL 及 SHEET KEY，經 sig 讀寫下游；下游 ALLOW_LOCAL_LOGIN 閂口後只收 sig；\n//   選單「🔗 旅系統」提供匯出 JSON（含 hash）／匯入（upsertUser）／登記下游／直接入口掣',
  '// 支部獨立後端：正常身份來自支部 Users，本地登入保持開啟。\n// Progress 只執行同一 Unified Sheet 的業務 action；簽名 helper 只作同一 /exec 的 server authentication transport。',
  'architecture header');
baseline = replaceOne(baseline,
  '// 接入資料：initializeSheets／showApiKey 及旅系統選單只顯示 API Key；部署 URL 由 Google 部署視窗提供，旅團編號在 ADMIN FORM 填寫。',
  '// 接入資料：initializeSheets／showApiKey 及支部系統選單只顯示 API Key；部署 URL 由 Google 部署視窗提供，旅團編號在 ADMIN FORM 填寫。',
  'registration menu header');
baseline = replaceOne(baseline,
  '// ===== 旅系統：上下游接駁（旅 > 團 > 進度）=====',
  '// ===== Pinned baseline signature compatibility helpers（not a Progress integration contract）=====',
  'legacy signature section heading');
baseline = replaceOne(baseline,
  '// ===== 旅系統：Sheet 選單（匯出／匯入／登記下游／直接入口掣）=====',
  '// ===== Pinned baseline legacy menu implementation（Unified onOpen is overridden below）=====',
  'legacy menu section heading');

const wrappedPortal = [
  '// ===== Namespaced legacy administrative compatibility module =====',
  'var PortalAdminCompat_ = (function () {',
  portal,
  'return {',
  '  initializeSheets: initializeSheets,',
  '  dispatchBody: dispatchBody,',
  '  doGet: doGet,',
  '  doPost: doPost,',
  '  loadDb: loadDb,',
  '  loadTables: loadTables,',
  '  canAccountAdmin: staffCanAccountAdmin_,',
  '  canonicalRole: branchCanonicalRole_,',
  '  roleLevel: branchRoleLevel_,',
  '  visibleRoles: BRANCH_VISIBLE_ROLES_.slice(),',
  '};',
  '})();',
  ''
].join('\n');

const banner = [
  '// AUTO-GENERATED. DO NOT EDIT THIS FILE DIRECTLY.',
  '// Build: node test-artifacts/scripts/build-unified-gas.mjs',
  `// Baseline: playerkousas-rgb/vsbadge@${manifest.baseline.commit} (${manifest.baseline.version})`,
  `// Portal source: playerkousas-rgb/vs_portal@${manifest.portalCompatibility.sourceCommit} (${manifest.portalCompatibility.version})`,
  '// Architecture: complete Unified branch backend; vs_portal is the full-featured frontend',
  '// and vsbadge is the lightweight frontend. Client surface never replaces server authorization.',
  '// Release channel: isolated test only; copied here for integration review; not deployed.',
  ''
].join('\n');

const output = `${banner}${baseline.trimEnd()}\n\n${wrappedPortal}${extension.trimEnd()}\n`;
fs.writeFileSync(OUT, output, 'utf8');
const browserModule = [
  '// AUTO-GENERATED by scripts/build-unified-gas.mjs. DO NOT EDIT.',
  `export const UNIFIED_GAS_SHA256 = ${JSON.stringify(sha256(output))};`,
  `export function unifiedGasTemplate() { return ${JSON.stringify(output)}; }`,
  ''
].join('\n');
fs.writeFileSync(BROWSER_OUT, browserModule, 'utf8');
console.log(`apps-script/UnifiedCode.gs built (${Buffer.byteLength(output)} bytes, sha256 ${sha256(output)})`);
console.log('test-artifacts/assets/js/lib/unifiedtemplate.generated.js updated for contract test');
