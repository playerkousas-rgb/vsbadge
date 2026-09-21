// 零依賴語法 / 部署守護檢查。lint 亦使用這組檢查，不引入龐大 lint runtime。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accountId } from './runtime-config.mjs';
for (const dir of ['api', 'scripts', 'tests', 'assets']) {
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, entry);
    if (/\.(m?js|cjs)$/.test(file)) execFileSync(process.execPath, ['--check', file]);
    if (/\.gs$/.test(file)) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  }
}
new vm.Script(fs.readFileSync('apps-script/Code.gs', 'utf8'), { filename: 'Code.gs' });
const html = fs.readFileSync('index.html', 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/type=["']application\/json/.test(match[1])) new vm.Script(match[2]);
}
assert(!html.includes('troops.json'), '前端不可再讀取旅團 JSON');
assert(!fs.existsSync('data/troops.json'), '不可重新加入公開旅團 Registry');
assert(!/SUPER_ADMIN_PASS|0728/.test(fs.readFileSync('apps-script/Code.gs', 'utf8')), 'GAS 不可包含預設憑證');
assert(!Object.keys(JSON.parse(fs.readFileSync('package.json')).dependencies || {}).length, '新增 runtime 套件須先更新瘦身審核');
for (const match of html.matchAll(/(?:src|href)=["']((?:assets|data|docs|apps-script)\/[^"'?#]+)["']/g)) assert(fs.existsSync(match[1]), '遺失資源：' + match[1]);
const restricted = new RegExp(`${accountId}|\\u8d85\\u7ba1|super[ _-]?admin|SUPER_KEY|SUPER_VERIFY|/api/super`, 'i');
const documents = ['README.md', 'DEPLOY_GUIDE_FOR_TROOPS.md', ...fs.readdirSync('docs', { recursive: true }).filter(f => f.endsWith('.md')).map(f => path.join('docs', f))];
for (const file of documents) assert(!restricted.test(fs.readFileSync(file, 'utf8')), '公開文件包含保留識別資訊：' + file);
const gas = fs.readFileSync('apps-script/Code.gs', 'utf8');
assert.equal(gas.toLowerCase().split(accountId).length - 1, 1, '帳號宣告只可有一處');
for (const dir of ['api', 'scripts', 'tests']) {
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    if (!/\.(m?js|cjs)$/.test(entry)) continue;
    assert(!fs.readFileSync(path.join(dir, entry), 'utf8').toLowerCase().includes(accountId), '其他來源不可重複硬編碼帳號');
  }
}
assert(!html.toLowerCase().includes(accountId), '前端不可包含帳號文字');
console.log('Syntax, inline JS, local resources, public documentation and deployment guards passed.');
