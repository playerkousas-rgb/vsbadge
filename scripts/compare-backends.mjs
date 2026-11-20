// 後端版本核對：兩個前端共用同一份完整 GS；不再比較 vendored manifest/hash。
//
// 用法：
//   node scripts/compare-backends.mjs --portal ../vs_portal
//   VS_PORTAL_DIR=/path/to/vs_portal npm run sync:check
//
// 判斷依據：
//   vsbadge  → apps-script/Code.gs 的 SHA-256 ＋ VS_GS_VERSION
//   vs_portal→ apps-script/UnifiedCode.gs 的 VS_GS_VERSION（實際使用的完整後端）
//
// 離開碼：0 = 已對齊；2 = 有漂移（會印出行動）；3 = 未能檢查（未提供 portal checkout）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function readVsbadgeBackend(root = ROOT) {
  const file = path.join(root, 'apps-script', 'Code.gs');
  const source = fs.readFileSync(file, 'utf8');
  const version = (source.match(/const VS_GS_VERSION\s*=\s*'([^']+)'/) || [])[1] || '';
  const channelDefault = (source.match(/const RELEASE_CHANNEL_DEFAULT\s*=\s*'([^']*)'/) || [])[1] || '';
  const channelSupported = /const RELEASE_CHANNEL_PROP\s*=/.test(source);
  const revision = (source.match(/const VS_GS_REVISION\s*=\s*'([^']+)'/) || [])[1] || '';
  return { file, sha256: sha256(source), version, revision, channelDefault, channelSupported };
}

export function readPortalBaseline(portalDir) {
  const file = path.join(portalDir, 'apps-script', 'UnifiedCode.gs');
  const source = fs.readFileSync(file, 'utf8');
  const version = (source.match(/const VS_GS_VERSION\s*=\s*'([^']+)'/) || [])[1] || '';
  const revision = (source.match(/const VS_GS_REVISION\s*=\s*'([^']+)'/) || [])[1] || '';
  const releaseChannel = (source.match(/const RELEASE_CHANNEL_DEFAULT\s*=\s*'([^']+)'/) || [])[1] || '';
  return { file, sha256: sha256(source), version, revision, releaseChannel, portalVersion: '' };
}

// 版本比較：只處理本專案用到的 v<major>.<minor>。
// 試作 build 嘅後綴（例如 v9.6-u1-test）唔當另一個版本；試作與否由 channel／revision 區分。
export function compareVersions(a, b) {
  const parse = value => {
    const m = String(value || '').match(/^v?(\d+)\.(\d+)/i);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 2; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export function compareBackends(vsbadge, portal) {
  if (!vsbadge || !vsbadge.sha256) throw new Error('缺少 vsbadge 後端資料');
  if (!portal || !portal.sha256) throw new Error('缺少 portal vendored baseline 資料');
  if (vsbadge.sha256 === portal.sha256) {
    return { status: 'aligned', newer: '', versionDrift: compareVersions(vsbadge.version, portal.version) };
  }
  // 1) 先比 revision（ISO 日期，兩邊都要寫；同一日改動就靠 commit／人手判斷）
  const ra = vsbadge.revision;
  const rb = portal.revision;
  if (ra && rb && ra !== rb && /^\d{4}-\d{2}-\d{2}$/.test(ra) && /^\d{4}-\d{2}-\d{2}$/.test(rb)) {
    return { status: 'drift', newer: ra > rb ? 'vsbadge' : 'vsportal', by: 'revision' };
  }
  // 2) 再比版本號
  const cmp = compareVersions(vsbadge.version, portal.version);
  if (cmp === 1) return { status: 'drift', newer: 'vsbadge', by: 'version' };
  if (cmp === -1) return { status: 'drift', newer: 'vsportal', by: 'version' };
  return { status: 'drift', newer: 'unknown' };
}

export function formatReport(vsbadge, portal, verdict) {
  const lines = [];
  lines.push('共用 GS 版本核對（同一份後端、兩個前端）');
  lines.push('');
  lines.push(`vsbadge  ${vsbadge.file || 'apps-script/Code.gs'}`);
  lines.push(`  GS version       ${vsbadge.version || '(未找到)'}`);
  lines.push(`  revision         ${vsbadge.revision || '(未找到)'}`);
  lines.push(`  channel default  ${vsbadge.channelDefault || '(未記錄)'}`);
  lines.push(`  SHA-256          ${vsbadge.sha256}`);
  lines.push('');
  lines.push(`vs_portal  ${portal.file || 'apps-script/UnifiedCode.gs'}`);
  lines.push(`  GS version       ${portal.version || '(未找到)'}`);
  lines.push(`  revision         ${portal.revision || '(未記錄)'}`);
  lines.push(`  channel default  ${portal.releaseChannel || '(未記錄)'}`);
  lines.push(`  SHA-256          ${portal.sha256 || '(未讀取)'}`);
  lines.push('');
  if (verdict.status === 'aligned') {
    lines.push('結論：✅ 兩邊 GS 版本相同。');
    return lines.join('\n');
  }
  const basis = verdict.by === 'revision' ? 'revision' : (verdict.by === 'version' ? '版本' : '');
  if (verdict.newer === 'vsbadge') {
    lines.push(`結論：⚠️ vsbadge 的 GS 較新${basis ? `（依 ${basis} 判斷）` : ''}。`);
    lines.push('行動：Portal 先讀取 vsbadge/apps-script/Code.gs 的完整檔案，確認功能後 copy 作底；不可把 Portal 功能刪掉。');
    return lines.join('\n');
  }
  if (verdict.newer === 'vsportal') {
    lines.push(`結論：⚠️ Portal 的 GS 較新${basis ? `（依 ${basis} 判斷）` : ''}。`);
    lines.push('行動：vsbadge 直接以 Portal/apps-script/UnifiedCode.gs 完整檔案 copy 作底，驗證 BADGE 相容，再 bump 單一 GS 版本；不可退回輕量舊檔。');
    return lines.join('\n');
  }
  lines.push('結論：⚠️ 未能判斷哪份較新，請比較 GS version／revision 後再同步；不能把兩份 GS 分叉維護。');
  return lines.join('\n');
}

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

function main() {
  const vsbadge = readVsbadgeBackend();
  const portalDir = getArg('--portal') || process.env.VS_PORTAL_DIR || '';
  if (!portalDir) {
    console.log(formatReport(vsbadge, { version: '', revision: '', sha256: '', commit: '', releaseChannel: '', portalVersion: '' },
      { status: 'unknown', newer: '' }).replace('vs_portal  apps-script', 'vs_portal  (未提供 checkout) apps-script'));
    console.log('');
    console.log('未能檢查：請提供 portal checkout，例如：');
    console.log('  node scripts/compare-backends.mjs --portal ../vs_portal');
    console.log('  VS_PORTAL_DIR=../vs_portal npm run sync:check');
    process.exitCode = 3;
    return;
  }
  let portal;
  try {
    portal = readPortalBaseline(portalDir);
  } catch (e) {
    console.log(`未能讀取 Portal Unified GS：${String((e && e.message) || e)}`);
    console.log('請確認路徑指向 vs_portal checkout（需要 apps-script/UnifiedCode.gs）。');
    process.exitCode = 3;
    return;
  }
  const verdict = compareBackends(vsbadge, portal);
  console.log(formatReport(vsbadge, portal, verdict));
  process.exitCode = verdict.status === 'aligned' ? 0 : 2;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
