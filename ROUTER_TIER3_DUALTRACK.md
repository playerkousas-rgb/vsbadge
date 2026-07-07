# Router 第 3 級元件雙軌制規範

> 所有第 3 級元件均支援「獨立使用」或「接入主系統」兩種模式  
> Router 只需登記一次，之後新旅團自行配置後端即可使用

---

## 核心概念

```
Router（登記一次）
  │
  │  "有這個插件可用"
  │
  ├─ 旅團 A ──→ 自己建 Sheet → 交給管理員 → 加入 troops.json → 完
  ├─ 旅團 B ──→ 自己建 Sheet → 交給管理員 → 加入 troops.json → 完
  └─ 旅團 C ──→ 兩種模式都可用
```

**Router 不需要知道任何旅團的 backend URL 或 API Key。**

---

## 雙軌制說明

每個第 3 級元件支援兩種使用模式：

### 軌道 A：獨立使用

```
旅團打開前端 URL（例如：vsbadge.vercel.app）
    ↓
顯示旅團選擇列表（從 troops.json 讀取）
    ↓
選擇旅團 → 自動帶入 u 參數
    ↓
前端根據 u 參數查找 troops.json，取得 backend + apikey
    ↓
連接旅團自己的 Google Sheet 後端
    ↓
完成。不需要主系統。
```

- 適合：不想用主系統的小型旅團
- 身份：選擇「領袖」或「成員」

### 軌道 B：接入主系統

```
主系統卡片 → iframe 帶入 ?u=0082&role=leader&ymis=1234567890
    ↓
前端根據 u 參數查找 troops.json，取得 backend + apikey
    ↓
連接旅團自己的 Google Sheet 後端
    ↓
身份自動帶入，零設定
    ↓
完成。
```

- 適合：使用完整主系統的旅團
- 身份：主系統自動帶入，不需要再設定

### 雙軌並存

兩種模式不衝突。同一個旅團可以：
- 領袖從主系統卡片進入（自動帶身份）
- 成員直接打開 `vsbadge.vercel.app/?u=0082`（設定頁填一次就好）

---

## 架構：共用前端 + troops.json 對照表

```
┌─────────────────────────────────────────┐
│   共用前端 (vsbadge.vercel.app)          │
│   - 所有旅團共用同一份前端               │
│   - 根據 ?u= 參數查找旅團設定           │
└─────────────┬───────────────────────────┘
              │
              │ 從 troops.json 查找
              │
              ▼
┌─────────────────────────────────────────┐
│   troops.json（旅團對照表）              │
│   {                                     │
│     "0082": {                           │
│       "name": "第 82 旅",               │
│       "backend": "https://script...",   │
│       "apikey": "vs_xxxxxxxx"           │
│     }                                   │
│   }                                     │
└─────────────┬───────────────────────────┘
              │
              │ 連接對應的後端
              │
              ▼
┌─────────────────────────────────────────┐
│   各旅團獨立的 Google Sheet 後端        │
│   - 旅團自己建立和維護                  │
│   - API Key 自動生成                    │
└─────────────────────────────────────────┘
```

---

## 旅團部署流程

### 旅團要做的事（10 分鐘）

1. **建立 Google Sheet**
2. **貼上 Code.gs**（系統管理者提供）
3. **執行 initializeSheets**
   - 系統會自動生成 **API Key**
   - 顯示在螢幕上，旅團複製
4. **部署 Apps Script** → 複製 URL
5. **交給系統管理員**：
   - Apps Script URL
   - API Key（自動生成的）

### 系統管理員要做的事

收到旅團的資訊後，編輯 `troops.json`：

```json
{
  "troops": {
    "0082": {
      "name": "第 82 旅",
      "backend": "https://script.google.com/macros/s/XXXXXX/exec",
      "apikey": "vs_xxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

提交到 Git → Vercel 自動部署 → 旅團就能使用。

---

## Router 登記時只需做的事

### 1. 在 registry.json 加入插件（做一次就好）

```json
{
  "id": "vs_badge_tracker",
  "title": "深資童軍進度追蹤 (Tier 3)",
  "icon": "🔥",
  "tier": 3,
  "path": "https://vsbadge.vercel.app/",
  "roles": ["member", "leader"],
  "needsTroopBackend": true,
  "description": "基於第11版訓練綱要的四級進度追蹤系統。支援獨立使用或接入主系統。"
}
```

**欄位說明：**

| 欄位 | 說明 | 範例 |
|------|------|------|
| `id` | 全域唯一識別碼 | `"vs_badge_tracker"` |
| `title` | 顯示名稱 | `"深資童軍進度追蹤 (Tier 3)"` |
| `icon` | Emoji 圖示 | `"🔥"` |
| `tier` | 元件等級（2 或 3） | `3` |
| `path` | 元件 URL（第3級填完整 URL） | `"https://vsbadge.vercel.app/"` |
| `roles` | 可使用的角色列表 | `["member", "leader"]` |
| `needsTroopBackend` | 是否需要單位後端 | `true` |
| `description` | 簡短描述 | `"基於第11版訓練綱要..."` |

### 2. 就這麼簡單。完了。

之後有 100 個旅團要用這個插件，Router 也不需要改任何東西。

---

## 新旅團加入流程

### 第 1 步：部署後端（Google Sheet）

1. 建立 Google Sheet
2. 貼上插件提供的 `Code.gs`
3. 設定 `SHEET_ID`
4. 執行 `initializeSheets()`（會自動生成 API Key）
5. 複製顯示的 **API Key**
6. 部署為網頁應用程式
7. 複製 **Apps Script URL**

### 第 2 步：交給系統管理員

把以下資訊交給系統管理員：
- 旅團編號
- Apps Script URL
- API Key（自動生成的）

### 第 3 步：管理員加入 troops.json

管理員會把你的資訊加入 `troops.json`，提交後自動部署。

### 第 4 步：開始使用

- **獨立使用**：打開 `https://vsbadge.vercel.app/` → 選擇旅團
- **接入主系統**：從 Dashboard 元件卡片進入

---

## 主系統需要配合的

### iframe 渲染時帶入的參數

```
前端 URL（從 Router 取得）
  ?u={旅團編號}           ← 主系統帶入
  &role={用戶角色}         ← 主系統帶入
  &ymis={成員YMIS}        ← 主系統帶入
  &from=portal            ← 固定
  &embed=1                ← 嵌入模式
```

**注意：主系統不需要帶入 backend 和 apikey，前端會自動從 troops.json 查找。**

---

## 各級元件的比較

| | 第 2 級 | 第 3 級 |
|--|--------|--------|
| 前端 | 插件開發者管理（一份共用） | 插件開發者管理（一份共用） |
| 後端 | 不需要 | 各旅團獨立部署 |
| 旅團設定 | 什麼都不做 | 建 Sheet + 部署 GS + 交給管理員 |
| Router 登記 | 一次 | 一次 |
| 新旅團要做 | 什麼都不做 | 建 Sheet + 部署 + 交給管理員 |
| 獨立使用 | ✅ 直接打開 | ✅ 選擇旅團 |
| 接入主系統 | ✅ Router 轉駁 | ✅ 主系統卡片 |
| 雙軌制 | 天然支援 | 需插件支援（`dualTrack: true`） |

---

## 資料流向

### 獨立使用
```
用戶 → 前端 → 選擇旅團 → 查找 troops.json → 取得 backend+apikey
                                                      ↓
                              連接旅團的 Google Sheet 後端
```

### 接入主系統
```
用戶 → 主系統登入 → 主系統帶入身份 → 前端（iframe）
                                         ↓
                              查找 troops.json → 取得 backend+apikey
                                                      ↓
                              連接旅團的 Google Sheet 後端
```

---

## 安全性

### 三層保護

| 層級 | 保護對象 | 機制 |
|------|---------|------|
| Google Sheet 密碼 | 擋人 | 只有 Sheet 擁有者能登入修改 |
| API Key | 擋 AI/爬虫 | 沒有 Key 就不能用 Apps Script API |
| troops.json | 系統管理員管理 | 旅團無法修改，只有管理員能更新 |

### API Key 特性

- **自動生成**：旅團執行 `initializeSheets()` 時自動產生
- **隨機字串**：格式為 `vs_` + 24 位隨機字元
- **儲存方式**：存在 Google Apps Script 的 PropertiesService
- **旅團責任**：複製 API Key 交給系統管理員
- **管理員責任**：加入 troops.json

---

## 元件開發者檢查清單

開發第 3 級元件時，確認：

- [ ] 前端有旅團選擇功能（沒有 `u` 參數時顯示）
- [ ] 從 `troops.json` 讀取旅團列表
- [ ] 根據 `u` 參數自動查找 backend + apikey
- [ ] 支援從 URL 參數讀取 `u`、`role`、`ymis`（主系統帶入時）
- [ ] `embed=1` 時隱藏頂部標題列
- [ ] README 清楚說明兩種使用方式
- [ ] Code.gs 自動生成 API Key
- [ ] 提供 `showApiKey()` 函數讓旅團查看

---

## 一句話總結

> Router 登記一次 = 全平台可用  
> 旅團自己建 Sheet = 就能用  
> API Key 自動生成 = 旅團只需要複製交給管理員  
> 管理員加入 troops.json = 旅團立即能用  
> 獨立用或接入主系統 = 旅團自己選  
> Router 什麼都不用再做了

---

*此規範適用於所有第 3 級元件。*
