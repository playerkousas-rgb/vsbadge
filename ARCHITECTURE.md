# 元件連通架構方案

## 核心原則

```
主系統 (scoutsystem-2.0)          第3級元件 (如本系統)
─────────────────────────          ─────────────────────
✅ 管登入及身份驗證                  ✅ 管特定資料（進度紀錄）
✅ 管角色權限（領袖/成員）            ✅ 管考核項目定義
✅ 控制哪些卡片顯示給誰               ✅ 自己的 Google Sheet（API Key 鎖）
✅ 自動帶入身份參數                   ✅ 不碰主系統其他資料
```

---

## 身份流向

```
用戶登入主系統
    │
    ├─ 驗證身份 → 取得 YMIS + role + unit(u)
    │
    └─ 進入 Dashboard
        │
        ├─ 主系統判斷：此人是深資童軍支部？
        │   ├─ 是 → 顯示「進度追蹤」卡片
        │   └─ 否 → 不顯示
        │
        └─ 點擊卡片 → iframe 載入元件
            │
            └─ URL 自動帶入：
                ?u=0082                    ← 單位碼（主系統知道）
                &role=leader               ← 角色（主系統知道）
                &ymis=1234567890           ← 身份（主系統知道）
                &from=portal               ← 來源標記
                &embed=1                   ← 嵌入模式
                &backend=https://script...  ← 卡片設定（單位部署時填入）
                &apikey=xxxxx              ← 卡片設定（單位部署時填入）
```

**結果：用戶不需要再登入，點卡片就直接進入，身份已帶入。**

---

## 兩種元件等級的差別

### 第 2 級（即插即用）
```
主系統卡片 → Router → 共用系統（一份部署，所有單位用）
                      ↑
                      不需要後端，不需要 API Key
                      靠 ?u= 隔離資料
```
用途：公共工具、活動報名、圖書館等不需要單位獨立資料的插件

### 第 3 級（單位自部署）
```
主系統卡片 → 元件前端（Vercel）→ 單位自己的 Apps Script → 單位自己的 Google Sheet
                                  ↑
                                  需要 API Key 鎖定
                                  每個單位有自己的 backend URL + apikey
```
用途：涉及單位專屬資料（如進度紀錄、財務）的插件

---

## 主系統卡片需要的支援

### 目前（推測）
```
卡片 = {
  id: "vs_badge",
  title: "深資童軍進度追蹤",
  icon: "🔥",
  url: "https://vs-badge-tracker.vercel.app",  // 或經 router
  type: "jump",                                 // 跳轉新頁面
  tier: 3,
  needsUnitBackend: true
}
```

### 理想：卡片支援 iframe 嵌入
```
卡片 = {
  id: "vs_badge",
  title: "深資童軍進度追蹤",
  icon: "🔥",
  url: "",                    // 第3級留空，網址跟著單位走
  tier: 3,
  embed: true,                // ← 關鍵：在卡片內嵌入，不是跳轉
  needsUnitBackend: true,
  
  // 單位設定（每個旅團自己填）
  backend: "https://script.google.com/...",  // 單位的 Apps Script URL
  apiKey: "unit-specific-key"                // 單位的 API Key
}
```

### 主系統渲染卡片時：
```jsx
// 如果是 embed: true 的第3級元件
<iframe
  src={`${componentUrl}?u=${unit}&role=${role}&ymis=${ymis}&embed=1&from=portal&backend=${backend}&apikey=${apiKey}`}
  style={{width:'100%', height:'600px', border:'none'}}
/>

// 如果是第2級元件（經 router）
<iframe
  src={`https://troop-router.vercel.app/api/jump?id=${componentId}&u=${unit}&role=${role}&embed=1&from=portal`}
  style={{width:'100%', height:'600px', border:'none'}}
/>
```

---

## 權限對應

| 角色 | 主系統看到的 | 元件內能做的 |
|------|-------------|-------------|
| 成員 (member) | 「我的進度」卡片 | 只看自己進度（只讀） |
| 領袖 (branch_leader+) | 「全團進度」卡片 | 勾選完成、查看全團、按項目查看 |
| 管理員 (admin) | 同上 | 同上 |

**主系統控制：**
- 非深資童軍支部成員 → 完全看不到此卡片
- 成員 → 看到「我的進度」卡片（ymis=自己, role=member）
- 領袖 → 看到「全團進度」卡片（role=leader）

**元件端控制：**
- role=member → 只顯示個人進度，無勾選權限
- role=leader → 顯示完整功能

---

## 安全性分析

```
外部爬虫：
  → 沒有 API Key → 被 Apps Script 拒絕 ✅
  → 沒有單位 Google Sheet 權限 → 看不到資料 ✅

主系統內部：
  → 主系統不碰元件的 Google Sheet ✅
  → 元件不碰主系統的資料庫 ✅
  → 身份由主系統驗證後帶入，元件信任 ?ymis= 參數 ✅
    （因為只有已登入用戶才能進入卡片，而 URL 是 iframe 內部生成）

資料隔離：
  → 每個單位有自己的 Apps Script + Google Sheet ✅
  → API Key 確保只有該單位的元件前端能存取 ✅
```

---

## 主系統可能需要配合的地方

### 1. 卡片支援 iframe 嵌入模式
- 目前可能只支援 `type: "jump"`（跳轉新頁面）
- 需要支援 `embed: true`（在卡片內 iframe 顯示）
- 卡片高度可能需要自適應（元件內容多寡不同）

### 2. 單位設定儲存
- 第3級元件需要每個單位設定 `backend URL` + `apiKey`
- 主系統需要有地方讓管理員填入這些設定
- 建議：在旅團設定頁面加入「元件設定」區

### 3. 身份參數自動帶入
- 主系統在渲染 iframe 時，自動帶入 `u`, `role`, `ymis`, `from`, `embed`
- 這些參數由主系統登入狀態取得，不需要用戶手動輸入

### 4. 卡片顯示控制
- 主系統已有：按支部控制卡片顯示 ✅
- 深資童軍支部才看到進度追蹤卡片 ✅
- 成員看「我的進度」，領袖看「全團進度」

---

## 對 Registry 的影響

目前 registry.json 的 `type: "jump"` 表示跳轉。
建議加入 `type: "embed"` 或保留 `embed: true` 表示在卡片內嵌入。

```json
{
  "id": "vs_badge_tracker",
  "title": "深資童軍進度性獎章追蹤",
  "icon": "🔥",
  "url": "",
  "description": "追蹤四級進度性獎章考核",
  "version": "2.0.0",
  "tier": 3,
  "embed": true,
  "type": "embed",
  "needsUnitBackend": true,
  "status": "active"
}
```

---

## 總結

| 問題 | 答案 |
|------|------|
| 身份如何帶入？ | 主系統 iframe URL 自動帶 `ymis` + `role`，不需要密碼 |
| 成員只看到自己？ | 是，`role=member` 時元件只顯示個人進度 |
| 資料安全？ | API Key 鎖 + 單位獨立 Sheet，爬虫無法存取 |
| 不跳轉？ | 用 `embed: true`，iframe 嵌入卡片內 |
| 主系統需要改什麼？ | 1) 卡片支援 iframe embed 2) 單位設定存 backend+apikey 3) 自動帶入身份參數 |
| 第2級怎麼辦？ | 經 router 在卡片 iframe 顯示，不需要後端 |
