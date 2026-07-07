// Vercel Serverless Function - 旅團配置 API
// 從環境變數讀取旅團的 Backend URL 和 API Key

export default function handler(req, res) {
  const troops = {};
  
  // 從環境變數讀取所有旅團配置
  // 命名規則：TROOP_{編號}_BACKEND / TROOP_{編號}_APIKEY
  
  const envKeys = Object.keys(process.env);
  const troopIds = new Set();
  
  envKeys.forEach(key => {
    const match = key.match(/^TROOP_(\d+)_BACKEND$/);
    if (match) {
      troopIds.add(match[1]);
    }
  });
  
  troopIds.forEach(id => {
    const backend = process.env[`TROOP_${id}_BACKEND`];
    const apikey = process.env[`TROOP_${id}_APIKEY`];
    
    if (backend && apikey) {
      troops[id] = {
        backend: backend,
        apikey: apikey
      };
    }
  });
  
  res.status(200).json({ troops });
}
