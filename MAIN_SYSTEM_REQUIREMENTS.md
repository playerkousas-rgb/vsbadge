# 元件嵌入配合需求 — 給主系統開發者

> 本文檔說明 scoutsystem-2.0 主系統需要配合什麼，才能讓第 2/3 級元件以 iframe 方式嵌入卡片顯示。

---

## 一、目前現況 vs 理想

| | 目前 | 理想 |
|--|------|------|
| 元件開啟方式 | `type: "jump"` → 跳轉新分頁 | `embed: true` → iframe 嵌入卡片內 |
| 用戶體驗 | 離開 Dashboard → 進入元件 → 按返回 | 留在 Dashboard → 卡片展開即看到內容 |
| 身份帶入 | `?u=&role=&from=` | 同上 + 自動帶入 `&ymis=&embed=1` |

---

## 二、需要主系統配合的改動

### 2.1 卡片渲染方式：支援 iframe 嵌入

目前卡片點擊後是跳轉（`window.open` 或 `<a href>`）。

**需要新增：當 `embed: true` 時，用 iframe 渲染卡片內容。**

```
點擊卡片前：
┌──────────────┐
│ 🔥 進度追蹤   │  ← 縮略卡片
│ 12/45 (27%)  │
└──────────────┘

點擊卡片後：
┌──────────────────────────────────────────┐
│ ← 返回                                   │
│ ┌──────────────────────────────────────┐ │
│ │                                      │ │
│ │     iframe (元件內容)                 │ │
│ │     ?u=0082&role=leader              │ │
│ │     &ymis=1234567890&embed=1         │ │
│ │     &backend=...&apikey=...          │ │
│ │                                      │ │
│ │                                      │ │
│ │                                      │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

**實作建議：**

```jsx
// 在 Dashboard 或卡片展開頁
function PluginCard({ plugin, unit, role, ymis }) {
  const [expanded, setExpanded] = useState(false);
  
  if (plugin.embed) {
    // iframe 嵌入模式
    const params = new URLSearchParams({
      u: unit,
      role: role,
      ymis: ymis,        // ← 自動帶入 YMIS
      from: 'portal',
      embed: '1',
      backend: plugin.backend,  // ← 單位設定
      apikey: plugin.apiKey     // ← 單位設定
    });
    
    return (
      <div>
        <div onClick={() => setExpanded(!expanded)} style={{cursor:'pointer'}}>
          {plugin.icon} {plugin.title}
          {expanded ? ' ▲' : ' ▼'}
        </div>
        {expanded && (
          <iframe
            src={`${plugin.url}?${params}`}
            style={{width:'100%', height:'80vh', border:'none', borderRadius:'8px'}}
            allow="clipboard-write"
          />
        )}
      </div>
    );
  }
  
  // 原本的跳轉模式
  return <a href={`${plugin.url}?u=${unit}&role=${role}&from=portal`}>...</a>;
}
```

### 2.2 單位設定：儲存第 3 級元件的後端資訊

每個旅團需要為第 3 級元件填入自己的後端設定。

**建議：在旅團設定頁新增「元件設定」區。**

```
設定 → 元件設定
─────────────────────────────────────
🔥 深資童軍進度追蹤 (Tier 3)

  前端 URL：  [https://vs-badge-tracker.vercel.app    ]
  後端 URL：  [https://script.google.com/macros/s/... ]  ← Apps Script
  API Key：   [xxxxxxxxxxxxxxxx                        ]  ← 安全鎖
─────────────────────────────────────
```

**Google Sheet 新增工作表（或加入現有 Plugins Sheet）：**

| 欄位 | 說明 |
|------|------|
| pluginId | 元件 ID（如 `vs_badge_tracker`） |
| frontendUrl | 前端 URL |
| backendUrl | Apps Script Web App URL |
| apiKey | API Key |

### 2.3 自動帶入身份參數

渲染 iframe 時，主系統需要自動帶入以下參數：

| 參數 | 值 | 來源 |
|------|----|------|
| `u` | 旅團代碼 | 目前登入的單位 |
| `role` | 用戶角色 | 目前登入用戶的 role |
| `ymis` | 成員 YMIS | 目前登入用戶的 YMIS |
| `from` | `portal` | 固定值 |
| `embed` | `1` | 固定值（嵌入模式） |
| `backend` | 單位設定的 Apps Script URL | Plugins Sheet |
| `apikey` | 單位設定的 API Key | Plugins Sheet |

### 2.4 iframe 安全設定

```html
<iframe
  src="..."
  allow="clipboard-write"
  referrerpolicy="no-referrer"
/>
```

- **不需要** `allow-same-origin`（元件是獨立域名）
- **需要** `clipboard-write`（某些元件可能需要複製功能）
- CSP 不需要特別修改（元件端已處理 `frame-ancestors`）

### 2.5 iframe 高度適應

元件內容高度不固定（展開/收合），建議：

**方案 A（簡單）：固定高度**
```css
iframe { height: 80vh; }
```

**方案 B（進階）：postMessage 自動調整**
```js
// 主系統端
window.addEventListener('message', (e) => {
  if (e.data?.type === 'resize' && e.data?.height) {
    iframe.style.height = e.data.height + 'px';
  }
});

// 元件端
function notifyResize() {
  parent.postMessage({type: 'resize', height: document.body.scrollHeight}, '*');
}
```

---

## 三、Registry 欄位擴充

建議在 `registry.json` 中每個元件加入：

```json
{
  "id": "vs_badge_tracker",
  "title": "深資童軍進度性獎章追蹤",
  "icon": "🔥",
  "url": "https://vs-badge-tracker.vercel.app",
  "description": "追蹤四級進度性獎章考核",
  "version": "2.0.0",
  "tier": 3,
  "embed": true,
  "type": "embed",
  "needsUnitBackend": true,
  "unitSettings": ["backendUrl", "apiKey"],
  "status": "active"
}
```

| 欄位 | 說明 |
|------|------|
| `embed` | `true` = iframe 嵌入卡片；`false` = 跳轉新分頁 |
| `type` | `"embed"` 或 `"jump"` |
| `needsUnitBackend` | `true` = 需要單位設定後端 URL |
| `unitSettings` | 需要單位填的設定欄位列表 |

---

## 四、第 2 級 vs 第 3 級的差異

| | 第 2 級 | 第 3 級 |
|--|--------|--------|
| 部署 | 一份共用 | 各單位自部署 |
| `url` | 共用 URL（必填） | 留空（跟著單位走） |
| `needsUnitBackend` | `false` | `true` |
| 單位設定 | 不需要 | 需要 backendUrl + apiKey |
| iframe 帶入 | `?u=&role=&ymis=&embed=1` | 同上 + `&backend=&apikey=` |
| 資料隔離 | 靠 `?u=` | 靠獨立 Sheet + API Key |
| 渲染方式 | iframe 卡片（一樣） | iframe 卡片（一樣） |

**渲染邏輯統一：**
```js
function getPluginSrc(plugin, unit, role, ymis) {
  const params = new URLSearchParams({
    u: unit,
    role: role,
    ymis: ymis,
    from: 'portal',
    embed: '1'
  });
  
  let url = plugin.url;  // 第2級有，第3級空
  
  // 第3級：從單位設定取 URL
  if (plugin.tier === 3) {
    const settings = getUnitPluginSettings(unit, plugin.id);
    url = settings.frontendUrl || plugin.defaultFrontendUrl;
    if (settings.backendUrl) params.set('backend', settings.backendUrl);
    if (settings.apiKey) params.set('apikey', settings.apiKey);
  }
  
  return `${url}?${params}`;
}
```

---

## 五、卡片顯示控制（已有，確認）

| 條件 | 結果 |
|------|------|
| 非深資童軍支部成員 | 不顯示進度追蹤卡片 |
| 深資童軍成員 (role=member) | 顯示卡片，帶入 `ymis=自己` |
| 深資童軍領袖 (role=branch_leader+) | 顯示卡片，帶入 `role=leader` |

主系統已有此控制（按支部過濾卡片），不需要額外改動。

---

## 六、總結：主系統需要改的地方

| # | 改動 | 難度 | 說明 |
|---|------|------|------|
| 1 | 卡片支援 iframe 嵌入 | ★★☆ | `embed: true` 時用 iframe 而不是跳轉 |
| 2 | 單位設定儲存 | ★★☆ | 新增一個設定區讓管理員填 backend + apiKey |
| 3 | 自動帶入 YMIS | ★☆☆ | iframe src 組合時加入 `ymis` 參數 |
| 4 | iframe 高度 | ★☆☆ | 固定 80vh 或 postMessage 動態調整 |

**不需要改的：**
- 登入/身份驗證 → 現有系統已有
- 卡片顯示控制 → 已有（按支部過濾）
- role 帶入 → 已有
- Registry 讀取 → 已有

---

## 七、測試方式

改完後，可以用以下 URL 測試（模擬主系統帶入的參數）：

```
https://vs-badge-tracker.vercel.app/?u=0082&role=leader&ymis=1234567890&from=portal&embed=1&backend=YOUR_SCRIPT_URL&apikey=YOUR_KEY
```

- 領袖視角：能看到全團總覽、按項目查看、可勾選
- 成員視角（`role=member`）：只能看到自己進度，不可勾選
- `embed=1`：隱藏頂部標題列，更緊湊
