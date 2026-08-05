// Vercel Serverless Function - 旅團清單 API v3.0
// v3.0 變更（配合 /api/proxy 架構）：
//   - 只回傳 {id: {name}}，不再公開 backend URL / apikey
//   - GAS URL 統一由伺服器端 Registry（api/_registry.js）保管，前端不再需要
//   - 旅團資料來源不變：data/troops.json + TROOP_{ID}_BACKEND / TROOP_{ID}_APIKEY 環境變數
// 旅團註冊流程不變：旅團提交 URL+APIKEY 給管理員 → 管理員改 troops.json / 加 env → Redeploy

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
    _note: 'v3.0：backend/apikey 不再對前端公開，所有 GAS 存取請經同源 /api/proxy'
  });
}
