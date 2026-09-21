// Vercel Build Output API：只部署明確列出的 runtime 產物，零打包依賴。
import fs from 'node:fs';
import path from 'node:path';
import { accountId } from './runtime-config.mjs';
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.vercel/output');
fs.rmSync(output, { recursive: true, force: true });
const staticDir = path.join(output, 'static');
fs.mkdirSync(staticDir, { recursive: true });
for (const file of ['index.html', 'assets', 'data', 'docs', 'apps-script', 'README.md', 'DEPLOY_GUIDE_FOR_TROOPS.md']) {
  fs.cpSync(path.join(root, file), path.join(staticDir, file), { recursive: true });
}
const dependencies = {
  proxy: ['_registry', '_super'], troops: ['_registry'], portal: ['_registry'], super: ['_registry', '_super']
};
for (const [name, deps] of Object.entries(dependencies)) {
  const dir = path.join(output, 'functions/api', name + '.func');
  fs.mkdirSync(dir, { recursive: true });
  for (const module of [name, ...deps]) {
    const source = fs.readFileSync(path.join(root, 'api', module + '.js'), 'utf8');
    fs.writeFileSync(path.join(dir, module + '.js'), source.replace("from '../scripts/runtime-config.mjs'", "from './runtime-config.mjs'"));
  }
  if (deps.includes('_super')) fs.writeFileSync(path.join(dir, 'runtime-config.mjs'), `export const accountId = ${JSON.stringify(accountId)};\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 60 }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), `import handler from './${name}.js';
export default function(req, res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); return res; };
  return handler(req, res);
}
`);
}
fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({ version: 3, routes: [
  { src: '^/api/(proxy|troops|portal|super)(?:\\.js)?/?$', dest: '/api/$1' },
  { src: '^/$', dest: '/index.html' },
  { handle: 'filesystem' }
] }, null, 2));
function size(dir) { return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0); }
console.log(`Vercel output: ${size(output)} bytes (static files + 4 functions; no dependencies).`);
