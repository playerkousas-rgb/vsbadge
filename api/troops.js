// Vercel Serverless Function - 旅團配置 API v2.0 FINAL
// 按用戶最終要求：
// - URL 不用功能變數：backend 公開放 troops.json (data/troops.json 或 troops.json)
// - API KEY 是防爬虫：放 Vercel 環境變數 TROOP_0082_APIKEY，不進 GitHub
// - 人類靠登入防：即使有 backend+apikey，無 token 仍不可讀資料
// - 管理員：同一個 APP ADMIN (vsbadge/roverbadge/scoutbadge/cubbadge 各自獨立APP，各自有一套 troops.json + env vars)
// - 流程：旅團提交 URL+APIKEY 給管理員 -> 管理員改 troops.json 加1個環境變數 -> Redeploy 完成
// GS 自動生成：Code.gs getApiKey() 若無則 vs_+uuid, showApiKey() 可查看, initializeSheets 回傳

export default function handler(req, res) {
  const troops = {};
  let fileTroops = {};

  // 1. 讀 data/troops.json (靜態) - 若存在
  try {
    const fs = require('fs');
    const path = require('path');
    const candidates = [
      path.join(process.cwd(), 'data', 'troops.json'),
      path.join(process.cwd(), 'troops.json'),
      path.join(__dirname, '..', 'data', 'troops.json'),
      path.join(__dirname, '..', 'troops.json')
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          const json = JSON.parse(raw);
          if (json.troops) {
            fileTroops = { ...fileTroops, ...json.troops };
          }
        }
      } catch(e) {}
    }
  } catch(e) {
    console.warn('read troops.json failed', e);
  }

  // 2. 從環境變數收集 ID
  // 支援兩種：TROOP_0082_BACKEND (向後兼容) 和 TROOP_0082_APIKEY (當前推薦)
  const envKeys = Object.keys(process.env);
  const idsFromBackend = new Set();
  const idsFromApikey = new Set();

  envKeys.forEach(k => {
    let m = k.match(/^TROOP_(\d+[A-Z]?)_BACKEND$/i);
    if (m) idsFromBackend.add(m[1]);
    let m2 = k.match(/^TROOP_(\d+[A-Z]?)_APIKEY$/i);
    if (m2) idsFromApikey.add(m2[1]);
  });

  const allIds = new Set([
    ...Object.keys(fileTroops),
    ...idsFromBackend,
    ...idsFromApikey
  ]);

  // 3. 合併：backend 來自  env BACKEND > file > 空； apikey 來自 env APIKEY > file apikey > 空
  allIds.forEach(id => {
    const fileEntry = fileTroops[id] || {};
    const backendEnv = process.env[`TROOP_${id}_BACKEND`] || process.env[`TROOP_${id.toUpperCase()}_BACKEND`] || process.env[`TROOP_${id.toLowerCase()}_BACKEND`];
    const apikeyEnv = process.env[`TROOP_${id}_APIKEY`] || process.env[`TROOP_${id.toUpperCase()}_APIKEY`] || process.env[`TROOP_${id.toLowerCase()}_APIKEY`] || process.env[`TROOP_${id}_APIKEY`.toUpperCase()];

    // 為了支援 0082 用戶可能設 TROOP_82_APIKEY 也試試
    let apikeyFallback = apikeyEnv;
    if (!apikeyFallback) {
      // 去掉前導0再試
      const idNoZero = id.replace(/^0+/, '') || id;
      apikeyFallback = process.env[`TROOP_${idNoZero}_APIKEY`] || process.env[`TROOP_${idNoZero.toUpperCase()}_APIKEY`];
    }
    let backendFallback = backendEnv;
    if (!backendFallback) {
      const idNoZero = id.replace(/^0+/, '') || id;
      backendFallback = process.env[`TROOP_${idNoZero}_BACKEND`];
    }

    const backend = backendFallback || fileEntry.backend || '';
    const apikey = apikeyFallback || fileEntry.apikey || '';
    const name = fileEntry.name || `第 ${id} 旅`;

    // 只有有 backend 才算一個有效旅團 (apikey 可選，靠登入防)
    if (backend) {
      troops[id] = {
        name: name,
        backend: backend,
        apikey: apikey // 前端若拿到會一併送 backend 做防爬虫第一層，空亦可，靠 token
      };
    }
  });

  // 4. 回應
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({ troops, _note: 'backend from troops.json public, apikey from TROOP_{ID}_APIKEY env var anti-crawler, human protected by login token' });
}
