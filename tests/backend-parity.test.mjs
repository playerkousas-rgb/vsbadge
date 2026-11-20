// 後端對齊守護：vsbadge 同 vs_portal 係同一份後端、兩個前端。
// 呢個測試保證「邊份較新」可以機械化判斷（revision → 版本 → 人手），唔靠記憶或口頭協調。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareBackends, compareVersions, formatReport, readPortalBaseline, readVsbadgeBackend
} from '../scripts/compare-backends.mjs';

test('vsbadge 後端有可比嘅識別：版本、revision、channel 支援、SHA-256', () => {
  const local = readVsbadgeBackend();
  assert.equal(local.version, 'v9.6');
  assert.match(local.revision, /^\d{4}-\d{2}-\d{2}$/, '後端要有 ISO 日期 revision');
  assert.equal(local.channelDefault, 'release');
  assert.equal(local.channelSupported, true);
  assert.match(local.sha256, /^[0-9a-f]{64}$/);
});

test('版本比較：v9.5 < v9.6；v9.6-u1-test 同 v9.6 當同一版（改由 revision 區分）', () => {
  assert.equal(compareVersions('v9.5', 'v9.6'), -1);
  assert.equal(compareVersions('v9.6', 'v9.6'), 0);
  assert.equal(compareVersions('v10.0', 'v9.6'), 1);
  assert.equal(compareVersions('v9.6-u1-test', 'v9.6'), 0);
  assert.equal(compareVersions('', 'v9.6'), null, '認唔到的版本要回 null，唔好亂判');
});

test('同一份 source 的 hash → 已對齊', () => {
  const v = { sha256: 'a'.repeat(64), version: 'v9.6', revision: '2026-11-20' };
  const p = { sha256: 'a'.repeat(64), version: 'v9.6', revision: '2026-11-01' };
  assert.equal(compareBackends(v, p).status, 'aligned');
});

test('hash 唔同 → 用 revision 判斷邊份較新（唔用記憶）', () => {
  const base = { version: 'v9.6' };
  const newer = compareBackends(
    { ...base, sha256: 'b'.repeat(64), revision: '2026-11-20' },
    { ...base, sha256: 'c'.repeat(64), revision: '2026-11-12' }
  );
  assert.equal(newer.status, 'drift');
  assert.equal(newer.newer, 'vsbadge');
  assert.equal(newer.by, 'revision');

  const older = compareBackends(
    { ...base, sha256: 'b'.repeat(64), revision: '2026-11-01' },
    { ...base, sha256: 'c'.repeat(64), revision: '2026-11-12' }
  );
  assert.equal(older.newer, 'vsportal');
});

test('冇 revision 時退回版本比較；兩樣都比唔到就要求人手判斷', () => {
  const byVersion = compareBackends(
    { sha256: 'b'.repeat(64), version: 'v9.6', revision: '' },
    { sha256: 'c'.repeat(64), version: 'v9.5', revision: '' }
  );
  assert.equal(byVersion.newer, 'vsbadge');
  assert.equal(byVersion.by, 'version');

  const unknown = compareBackends(
    { sha256: 'b'.repeat(64), version: 'v9.6', revision: '' },
    { sha256: 'c'.repeat(64), version: 'v9.6', revision: '' }
  );
  assert.equal(unknown.newer, 'unknown');
  const report = formatReport(
    { version: 'v9.6', revision: '', sha256: 'b'.repeat(64), channelDefault: 'release', channelSupported: true },
    { version: 'v9.6', revision: '', sha256: 'c'.repeat(64), commit: '', releaseChannel: '', portalVersion: '' },
    unknown
  );
  assert.match(report, /人手比對/, '唔確定時要講明要人手判斷');
});

test('portal manifest 讀到 baseline revision 就會自動用嚟比較', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-manifest-'));
  try {
    fs.mkdirSync(path.join(dir, 'apps-script', 'unified-src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps-script', 'unified-src', 'manifest.json'), JSON.stringify({
      schema: 1,
      baseline: { repository: 'playerkousas-rgb/vsbadge', commit: 'abc', version: 'v9.6', revision: '2026-11-01', path: 'apps-script/Code.gs', sha256: 'd'.repeat(64) },
      portalCompatibility: { version: 'v2.8.8' },
      releaseChannel: 'isolated-test-only'
    }), 'utf8');
    const parsed = readPortalBaseline(dir);
    assert.equal(parsed.revision, '2026-11-01');
    assert.equal(parsed.releaseChannel, 'isolated-test-only');
    const local = readVsbadgeBackend();
    const verdict = compareBackends(local, parsed);
    assert.equal(verdict.status, 'drift');
    assert.equal(verdict.newer, 'vsbadge', 'manifest revision 較舊 → vsbadge 較新，portal 要重新 vendor');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
