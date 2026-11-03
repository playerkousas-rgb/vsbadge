// GAS → Vercel 短效登入票據驗證。僅回傳判定，不回傳密碼或 GAS session。
import { openSuper, equalSecret } from './_super.js';
import { getTrustedTroop } from './_registry.js';

// 正規化 GAS /exec 網址：Workspace 帳戶可能回報 /a/<網域>/macros/s/<部署 ID>/exec，
// 與公開 /exec 格式正規化後相同，否則字串形式不同會導致驗票靜默失敗。
function canonicalBackendUrl(u){
  const s=String(u||'');
  const m=s.match(/^https:\/\/script\.google\.com\/a\/[^\/]+\/macros\/s\/([A-Za-z0-9_-]+)\/exec\/?$/);
  return m ? 'https://script.google.com/macros/s/'+m[1]+'/exec' : s;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }
  try {
    let body = req.body;
    if (!body) {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) return res.status(413).json({ ok: false });
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString();
    }
    if (typeof body === 'string') body = JSON.parse(body);
    const ticket = openSuper('login', body?.ticket);
    const troop = ticket && getTrustedTroop(ticket.troopId);
    const ok = !!(troop && equalSecret(body.apikey, troop.apikey) &&
      equalSecret(ticket.apikey, troop.apikey) &&
      canonicalBackendUrl(body.backend) === troop.backend &&
      canonicalBackendUrl(ticket.backend) === troop.backend);
    return res.status(ok ? 200 : 401).json({ ok });
  } catch { return res.status(400).json({ ok: false }); }
}
