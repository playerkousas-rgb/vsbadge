# 🔗 接入主系統 (scoutsystem-2.0) 說明

> 獨立用完全沒問題，接入主系統時會怎樣？

## 兩條軌道並存

本系統支援 **雙軌制**（見 ROUTER_TIER3_DUALTRACK.md）：

1. **軌道 A - 獨立使用**：打開 `https://vsbadge.vercel.app/` → 選旅團 → 登入
2. **軌道 B - 接入主系統**：由主系統 Dashboard 卡片點擊進入，身份自動帶入，免再登入

兩條軌道可以同時用：領袖從主系統進入，成員 bookmark 獨立連結。

---

## 接入主系統時的流程

### 主系統會做什麼？

主系統在渲染卡片時，會用 **iframe** 嵌入本系統，並自動帶入 URL 參數：

```
https://vsbadge.vercel.app/?u=0082
  &role=leader          ← 主系統知道你是領袖/成員
  &ymis=1234567890      ← 主系統知道你的 YMIS
  &name=陳大文
  &from=portal          ← 標記來源是主系統
  &embed=1              ← 嵌入模式，隱藏大標題，精簡介面
  &backend=https://script.google.com/macros/s/.../exec  ← (可選) 旅團後端，直接傳入
  &apikey=vs_xxx        ← (可選) API Key
```

**結果**：用戶點卡片就直接進入「我的進度」或「全團總覽」，不需要再選旅團及輸入密碼。

### 本系統會做什麼？

`index.html` 內的 `handlePortalParams()` 會：

1. **檢查** `from=portal` + `ymis` + `role`
2. **若都有**：直接創建 `currentUser` 免登入，顯示主App，跳過 loginPage
3. **若只有 `u`** (例如 `?u=0082`)：自動預選 0082 旅團，顯示登入框並填入 YMIS
4. **若有 `backend`+`apikey` 參數**：直接使用，不再查 `troops.json`，適合第3級元件「單位自部署」模式
5. **若無 `backend`**：嘗試從 `data/troops.json` 或 `/api/troops` 查找該旅團的後端設定（與獨立使用同一套對照表）
6. **embed=1**：加上 `embed-mode` class，隱藏首頁大Header及Welcome導航，精簡為嵌入式，適合 iframe 高度 600px

### 權限對應

| 主系統 role | 元件內看到的 | 能做的 |
|-------------|--------------|--------|
| member | 我的進度(只看自己) + 表格 + 教學 + 資料庫 | 申請完成，不能直接剔 |
| exec_committee | 同上 + 可選成員查看 + 全團批量(若授權) | 勾選 (範圍由團長設定) |
| branch_leader / group_leader / admin | 全團總覽 + 審批中心 + 用戶管理 | 勾選全部、批量、審批、改角色、設權限 |
| super_admin (SHEEP) | 全部 + 測試工具 | 最高權限 |

主系統負責：**是否顯示卡片**（例如非深資童軍支部不顯示）
本系統負責：**卡片內顯示什麼**（例如 member 只看自己）

---

## 主系統卡片設定範例

### 理想的第3級嵌入卡片

```jsx
// 主系統 Dashboard 渲染
<iframe
  src={`https://vsbadge.vercel.app/?u=${troopId}&role=${user.role}&ymis=${user.ymis}&name=${user.name}&from=portal&embed=1&backend=${troop.backend}&apikey=${troop.apikey}`}
  style={{width:'100%', height:'750px', border:'none', borderRadius:'12px'}}
  title="深資童軍進度追蹤"
/>
```

- `troop.backend` / `troop.apikey` 由旅團在主系統的「旅團設定 → 元件設定」填入
- 每個旅團獨立 Google Sheet，資料隔離，API Key 鎖定

### 若主系統不想存 backend/apikey

也可只傳 `u`，讓前端自動查 `troops.json`：

```
https://vsbadge.vercel.app/?u=0082&role=leader&ymis=1234567890&from=portal&embed=1
```

前端會自動：

1. `u=0082` → 查 `data/troops.json` → 取得 backend + apikey
2. `from=portal` + `ymis` + `role` → 免登入

---

## 獨立用 vs 接入主系統對比

|  | 獨立用 | 接入主系統 |
|---|---|---|
| 入口 | vsbadge.vercel.app → 選旅團 | 主系統 Dashboard 卡片 |
| 旅團選擇 | 手動選 | 自動帶入 `u` |
| 登入 | 選 member/leader 輸入 YMIS/Email+密碼 | 自動帶入，無需密碼 (Portal 信任模式) |
| 後端 | 查 troops.json 取得 backend | 查 troops.json 或直接用 URL 參數 backend/apikey |
| 介面 | 完整 Header + Welcome導航 | `embed=1` 精簡，隱藏大標題，適合 iframe |
| 權限 | 同樣按 role 控制 | 同樣按 role 控制 |
| 資料 | 同一 Google Sheet | 同一 Google Sheet |

---

## 常見問題

**Q: 成員從主系統進入後能否看到其他成員？**
A: 預設不能，只看自己。若團長在「用戶管理 → 系統設定」開啟「允許成員互相查看進度」，則成員也可看全團（唯讀），用於互相鼓勵。

**Q: 審批中心在主系統內會怎樣顯示？**
A: 成員看到自己申請狀態，領袖看到兩類：🏅獎章審批 + 👤用戶審批，均在同一「✅審批中心」分頁，內有子切換。

**Q: 表格列印在 iframe 內能否正常列印？**
A: 可以，`window.print()` 會只列印 `.print-area`，隱藏按鈕，官方 PT/19/PT/20 格式，雙面列印符合總會要求。

**Q: 若主系統未傳 backend/apikey，會怎樣？**
A: 前端會嘗試從 `data/troops.json` 查找該 `u` 的後端，若找不到會顯示警告「未找到旅團後端設定」，請檢查 troops.json 是否已包含該旅團或主系統卡片是否已設定 backend。

---

## 一句話總結

- **獨立用**：選旅團 → 登入 → 用
- **接入主系統**：點卡片 → 身份自動帶入 → 直接用，`embed=1` 精簡介面，`backend/apikey` 可直接傳或自動查表，權限、進度、表格、批量功能完全一致。

---
COPYRIGHT 2026 Scout System
