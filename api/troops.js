// 只公開已完成三項環境變數設定的旅團名稱；不讀 JSON。
import { listPublicTroops } from './_registry.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(405).json({ success: false, error: '此 API 只接受 GET 請求' });
  }
  const troops = listPublicTroops();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({
    troops,
    _note: 'v4.0.0：backend/apikey 不再對前端公開，所有 GAS 存取請經同源 /api/proxy'
  });
}
