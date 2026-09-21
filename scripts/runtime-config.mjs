import fs from 'node:fs';
// 共用既有宣告；建置時只輸出所需常數，不把整份來源複製進 function。
const source = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const match = source.match(/^const SUPER_ADMIN_ID = '([a-z0-9_-]+)';$/m);
if (!match) throw new Error('Missing runtime configuration');
export const accountId = match[1];
