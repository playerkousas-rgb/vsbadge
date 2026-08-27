// 本機開發/預覽伺服器：模擬 Vercel 行為（靜態檔 + /api/* serverless handlers）
// 用法：node tests/dev-server.mjs [port]
// 本機測試多旅團可設：
//   VSBADGE_PROXY_TEST=1 TROOP_1001_BACKEND=http://127.0.0.1:3902/exec node tests/dev-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);

const { default: proxyHandler } = await import('../api/proxy.js');
const { default: troopsHandler } = await import('../api/troops.js');

function vercelize(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  if (u.pathname === '/api/proxy' || u.pathname === '/api/proxy.js') return proxyHandler(req, vercelize(res));
  if (u.pathname === '/api/troops' || u.pathname === '/api/troops.js') return troopsHandler(req, vercelize(res));
  let p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(res);
});
server.listen(PORT, '0.0.0.0', () => console.log(`vsbadge dev server on http://0.0.0.0:${PORT}`));
