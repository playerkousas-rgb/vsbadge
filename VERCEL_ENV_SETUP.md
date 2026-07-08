# Vercel 環境變數設定指南

> 只有 API Key 需要放在環境變數，BACKEND URL 可以放 troops.json。

---

##  問題解答

### Q1: BACKEND URL 需要保密嗎？會影響速度嗎？

**BACKEND URL 不需要保密**，因為：
- 它是 Google Apps Script 的公開執行網址
- 沒有 API Key 的話，拿到 URL 也無法存取資料
- Code.gs 有 API Key 驗證，保護資料安全

**放在 troops.json 的好處：**
- ✅ 前端直接讀 troops.json，**速度最快**
- ✅ 不需要透過 Serverless Function 多一次 API 呼叫
- ✅ 簡化架構

**結論：**
- `troops.json`：放旅團編號、名稱、BACKEND URL（可公開）
- **環境變數**：只放 API Key（真正要保密的）

---

### Q2: 如果後來想接入主系統，要怎麼做？

**很簡單！不需要改 troops.json 或環境變數。**

步驟：
1. 旅團已經有自己的 Google Sheet + Apps Script + API Key ✅
2. 把這 3 個資訊交給主系統管理員
3. 管理員在主系統「元件設定」加入旅團資訊
4. 完成

**兩種模式可以並存：**
- 獨立使用：靠 troops.json + 環境變數
- 接入主系統：靠主系統的元件設定

---

##  優化後的方案

### troops.json（可以放 Git）

```json
{
  "troops": {
    "0082": {
      "name": "第 82 旅",
      "backend": "https://script.google.com/macros/s/XXXX/exec"
    },
    "0123": {
      "name": "第 123 旅",
      "backend": "https://script.google.com/macros/s/YYYY/exec"
    }
  }
}
```

**包含：**
- 旅團編號（公開）
- 旅團名稱（公開）
- BACKEND URL（公開，但需要 API Key 才能存取）

---

### Vercel 環境變數（保密）

只需要設定 API Key：

| 名稱 | 值 | 環境 |
|------|------|------|
| `TROOP_0082_APIKEY` | `vs_181790d954f24213abe53834` | Production, Preview, Development |
| `TROOP_0123_APIKEY` | `vs_yyyyyyyyyyyyyyyy` | Production, Preview, Development |

**命名規則：**
```
TROOP_{旅團編號}_APIKEY
```

---

##  設定步驟

### 步驟 1：更新 troops.json

```json
{
  "troops": {
    "0082": {
      "name": "第 82 旅",
      "backend": "https://script.google.com/macros/s/AKfycbxqQ3JnEdSRnxlhoSEasa6-wX5F58p3dMqBiQRj1zg-SDn7YtFLBKykN5LiWcadgRdCBg/exec"
    }
  }
}
```

### 步驟 2：在 Vercel 設定環境變數

1. 打開 Vercel Dashboard → Settings → Environment Variables
2. 新增：
   - Name: `TROOP_0082_APIKEY`
   - Value: `vs_181790d954f24213abe53834`
   - Environment: 勾選 Production, Preview, Development
3. 點擊 **Save**

### 步驟 3：簡化 Serverless Function

因為只需要讀取 API Key，`api/troops.js` 可以簡化為：

```javascript
export default function handler(req, res) {
  const troops = {};
  
  const envKeys = Object.keys(process.env);
  const troopIds = new Set();
  
  envKeys.forEach(key => {
    const match = key.match(/^TROOP_(\d+)_APIKEY$/);
    if (match) {
      troopIds.add(match[1]);
    }
  });
  
  troopIds.forEach(id => {
    troops[id] = {
      apikey: process.env[`TROOP_${id}_APIKEY`]
    };
  });
  
  res.status(200).json({ troops });
}
```

### 步驟 4：前端邏輯

```javascript
async function loadTroops() {
  // 1. 從 troops.json 讀取旅團名稱和 backend URL
  const troopsResponse = await fetch('troops.json');
  const troopsData = await troopsResponse.json();
  
  // 2. 從 /api/troops 讀取 API Key
  const apiResponse = await fetch('/api/troops');
  const apiData = await apiResponse.json();
  
  // 3. 合併資料
  const troops = troopsData.troops || {};
  const apiTroops = apiData.troops || {};
  
  Object.keys(troops).forEach(id => {
    if (apiTroops[id]) {
      troops[id].apikey = apiTroops[id].apikey;
    }
  });
  
  troopsData.troops = troops;
  displayTroops(troopsData);
}
```

---

##  新增旅團流程

### 獨立使用

1. 更新 `troops.json`：
   ```json
   {
     "troops": {
       "0082": {
         "name": "第 82 旅",
         "backend": "https://script.google.com/macros/s/XXXX/exec"
       },
       "0123": {
         "name": "第 123 旅",
         "backend": "https://script.google.com/macros/s/YYYY/exec"
       }
     }
   }
   ```

2. 在 Vercel 新增環境變數：
   - `TROOP_0123_APIKEY` = `vs_yyyyyyyyyyyyyyyy`

3. 提交到 Git：
   ```bash
   git add troops.json
   git commit -m "新增第 123 旅"
   git push
   ```

4. Vercel 自動部署，完成！

---

### 接入主系統

1. 把以下資訊交給主系統管理員：
   - 旅團編號：`0123`
   - Apps Script URL：`https://script.google.com/macros/s/YYYY/exec`
   - API Key：`vs_yyyyyyyyyyyyyyyy`

2. 管理員在主系統「元件設定」加入旅團

3. 完成！不需要改 troops.json 或環境變數

---

##  安全檢查清單

- [ ] `troops.json` 不包含 API Key
- [ ] API Key 只在 Vercel 環境變數設定
- [ ] `.gitignore` 包含 `.env` 檔案
- [ ] Serverless Function 正確讀取環境變數
- [ ] 前端合併 troops.json 和 /api/troops 的資料

---

*本文件適用於 scoutsystem-2.0 主系統的旅團管理員。*
