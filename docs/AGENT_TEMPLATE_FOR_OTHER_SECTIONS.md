# 🧩 深資童軍進度系統 → 其他支部複製模版 (Agent 專用)

> 本文件是給下一個 AI Agent 看的，讓他不用混淆，直接用同一架構複製出其他 3 個支部的獨立 APP
> 原系統：深資童軍進度追蹤 (Venture Scout) v5.6 FINAL - 參考 repo https://github.com/playerkousas-rgb/vsbadge.git
> 目標：獨立 3 個 APP，例如 幼童軍 / 童軍 / 樂行童軍 (各一份 Vercel + 各自 Google Sheet 後端)

---

## 1. 系統架構（必須照抄，100% 重用）

```
前端 (單一 index.html, 150KB 左右, 含所有邏輯)
├── PNG LOGO 256px + 128px + SVG fallback (assets/)
├── data/items.json (考核項目定義，306項，第11版)
├── data/troops.json (旅團對照表 { "0082": {name, backend, apikey} })
├── troops.json (根，同 data/troops.json 備份)
├── assets/ (vs-logo-*.png, vs-torch.svg)
├── apps-script/Code.gs (單一檔案版，28600 bytes, 含 SHEEP超管、細緻權限、私隱開關)
├── api/troops.js (Vercel 讀環境變數)
├── vercel.json (開放 data/, assets/, docs/, apps-script/, api/)
├── docs/ (MEMBER_GUIDE.md, EXEC_GUIDE.md, LEADER_GUIDE.md, MAIN_SYSTEM_INTEGRATION.md)
├── data/mock_members.json + mock_import.csv (10 MOCK成員測試)
└── README.md / DEPLOY_GUIDE_FOR_TROOPS.md (雙軌部署指南)
```

**後端 Google Sheet 7 張表（initializeSheets 自動建立）：**
- 進度追蹤 (YMIS, 項目ID, 完成日期, 更新時間, 確認者, 備註)
- 成員名單
- Users (ymis, name, email, role, password_hash, branch, can_tick, auth_by, auth_date, created_at, last_login, status, allowed_badges)
- Applications (新帳號申請)
- Tokens
- SystemConfig (login_mode, allow_member_view_others 等)
- 待批完成 (request_id, ymis, name, item_id, item_name, requested_date, evidence, status, created_at, reviewed_by, reviewed_at, review_note, confirmed_date)
- 其他獎章

**不要改動後端邏輯**，只需改 `items.json` 及前端文案，後端已支援：
- 批量寫入、離線暫存、成員申請→領袖審批、其他獎章、細緻權限 (allowed_badges)、私隱開關 (allow_member_view_others)、SHEEP超管 (sheep/0728)

---

## 2. 必須保留的核心功能（v5.6 已驗證，照搬）

### 防卡死
- `switchTab` 非同步 + `_switching` 鎖 + 50ms setTimeout + try/catch + ESC緊急退出 + 雙擊Header返回
- `loadTroops()` 硬編碼後備 0082，即使 data/troops.json 404 都有列表
- 全團總覽限制 30欄/50人，卡片 + 表格 + 批量區

### LOGO
- 使用 PNG 256px (72KB) + 128px (22KB) + SVG fallback，`<img src="assets/vs-logo-256.png" onerror="fallback">`
- 不要用 1.3M 原圖，ZIP 會大

### 瀏覽器暫存→批量寫入
- `LS.pending(troopId)` 存 `pendingChanges`，底部 SaveBar 顯示數量
- 按確認才 POST `action:save`，全屏 `savingOverlay` + 進度條
- 成員申請亦先存 localStorage `LS.requests(troop, ymis)` 再 POST `requestComplete`

### 成員申請→領袖確認
- 成員不能直接剔，只能 `openRequestModal` → 日期+證據 → 暫存 → 後端 `待批完成` Sheet
- 領袖在「✅審批中心」見到，子切換：🏅獎章審批 + 👤用戶審批，支援批量批准，批准後加入待寫入清單

### 考驗介紹內建
- `items.json` 每項有 `detail`, `assessment`, `tip`, `links`，前端 ⓘ 按鈕彈出 Modal，不用翻綱要

### 保護兒童
- `items.json` `safeFromHarm` 含 sfh.scout.org.hk, elearning.scout.org.hk, 政策通告，教學套包，前端資料庫頁一鍵直達

### 表格自動填寫官方格式
- `generatePrintableForm()` 已重寫為官方 PT/19 / PT/20 格式，雙面列印，完全模仿總會 PDF（個人摘要+完成項目+提名/推薦/批核簽署欄）
- 自動填入姓名、YMIS、旅團、段章完成日期，可編輯後 `window.print()`，只列印 `.print-area`

### 其他獎章併入進度
- `items.json` `otherBadges` 17項，進度頁底部虛線卡片顯示，其他獎章 tab 已隱藏（手機省闊度），領袖可直接剔日期+證書編號

### 全團一眼睇 + 批量剔
- 全團總覽卡片顯示每人完成度% + 四獎章百分比，會員章✓標籤
- 表格矩陣按段章篩選，點✓單獨切換暫存
- 🚀考驗營批量完成：選日期 + 左選成員(可搜尋) + 右選項目(全選) → 一鍵標記 → 暫存 → 確認寫入，不用逐個跳轉

### 權限細分
- 後端 `Users.allowed_badges` 欄，第13欄，`*` = 全部
- 領袖默認全部，成員無，執委默認 L1,活動段章,OTHER部分
- 前端 `canCurrentUserTickItem(itemId)` 檢查前綴匹配，`OTHER` 匹配其他獎章
- 用戶管理頁 ⚙️權限 按鈕彈 Modal 勾選可考核範圍，團長/管理員可改低層級

### 私隱開關
- `SystemConfig` `allow_member_view_others` 默認 false
- `setupTabsByRole()`：成員預設只看自己，若開啟則可看全團總覽(唯讀)
- 用戶管理頁僅團長以上可見開關「允許成員互相查看進度」

### 成員只能看自己由團長開放
- 同上，`allow_member_view_others` 控制

### 教學按角色分開 + MD分開
- `docs/MEMBER_GUIDE.md`, `EXEC_GUIDE.md`, `LEADER_GUIDE.md` 獨立
- 前端 `❓教學` tab 內嵌 `EMBEDDED_GUIDES` 物件，不依賴 fetch，避免 404，子切換按鈕按角色顯示
- `📚資料庫` 頁頂亦有三欄角色教學 + 訓練計劃 + 保護兒童 + 佩戴指引

### 首頁精簡 + 版本框架
- Welcome 頁 `已修復問題` 及 `V4.0新增` 已刪除，保留空框架 `#home-future-framework` 註解，未來新版本資訊加在此，避免 Agent 亂加
- `welcome-changelog` 按鈕隱藏，內容改為版本更新框架，說明新後端GS保有舊資料

### Vercel NOT_FOUND 修復
- `vercel.json` 必須開放 `assets/**` + `docs/**` + `data/**` + `apps-script/**`
- `loadTroops()` 加時間戳 `?_=` 防快取 + 硬編碼後備

### COPYRIGHT
- Footer：`COPYRIGHT 2026 Scout System • 深資童軍進度追蹤系統 v4.8`

### MOCK 10成員
- `data/mock_members.json` + `mock_import.csv`，SHEEP登入用戶管理有測試工具一鍵載入

---

## 3. 各支部需替換的部分（Agent 重點改這裡）

### A. items.json
- 照抄深資的結構，但換成該支部的進度性獎章
  - 例如 幼童軍：會員章、幼童軍獎章、歷奇章、高級歷奇章、金紫荊獎章
  - 童軍：會員章、探索獎章、毅行獎章、挑戰獎章、總領袖獎章
  - 樂行童軍：會員章、樂行童軍獎章、貝登堡獎章
- 每個 badge：id, icon, name, purpose, segments: {code, name, desc, requirement, items: {id, name, detail, assessment, tip, links, subItems?}}
- 保持 id 規則：例如 `L1-ACT-01` 類似，方便批量邏輯
- otherBadges：該支部可考的其他獎章（興趣組、技能組等）
- trainingPlan：該支部的目的、方法、預期成果、流程
- safeFromHarm：共用，但連結相同
- forms：該支部的 PT 表格，例如幼童軍 PT/68 金紫荊，童軍 PT/18 總領袖章，樂行 PT/21/22

### B. Logo / 制服色
- 深資用棗紅色 #8B0000 + 金色 #FFD700 + 火炬
- 幼童軍用黃色為主、童軍綠色為主、樂行紅色為主，換 assets/vs-logo-*.png 為該支部標誌，但保持 256px + 128px 大小，不要用1.3M原圖
- 變更 :root --maroon 色碼為該支部主色

### C. 表格
- 深資是 PT/19 + PT/20，幼童軍是 PT/68，童軍是 PT/18，樂行是 PT/21/PT/22
- 參考 `generatePrintableForm()` 已模仿官方格式的寫法，照抄結構改表格欄位

### D. 保護兒童
- 共用，但幼童軍/小童軍可能有不同網上課程要求，更新 links

### E. 其他

- `troops.json` 旅團對照表結構不變
- `Code.gs` 完全不用改，已支援任意支部，只需改 items.json
- `README.md` / `DEPLOY_GUIDE_FOR_TROOPS.md` / `docs/MAIN_SYSTEM_INTEGRATION.md` 文案中的「深資」字眼換成該支部名稱

---

## 4. 部署（兩條軌道，必須寫清楚）

**共通**：下載 Code.gs (單一) → 建 Sheet → 貼上 → initializeSheets → 部署為網頁應用程式 → 複製 URL+API Key

**軌道A 無主系統/有但想獨立用**：
- URL+Key 交 vsbadge 管理員 → 加入 troops.json → 完成
- 用法：vsbadge.vercel.app 選旅團登入

**軌道B 有主系統並想接上**：
- 同樣交 vsbadge 管理員 + 額外交主系統管理員填旅團設定→元件設定 backend+apikey
- 用法：主系統 Dashboard 點卡片自動帶入 ?u=&role=&ymis=&from=portal&embed=1 → 免密碼
- 有主系統≠一定要接，可自由選擇獨立用，藉此宣傳主系統有 Dashboard、考勤、財務、活動報名等更多功能

**重要**：`vercel.json` 必須開放 `assets/**`, `docs/**`, `data/**`, `apps-script/**`

---

## 5. 檢查清單（Agent 完成後自檢）

- [ ] `index.html` JS 語法 `new Function(code)` OK，無 `{{` 多餘括號
- [ ] `loadTroops()` 有硬編碼後備 0082，即使 data 404 都有列表
- [ ] LOGO 用 PNG 256 + 128 + SVG fallback，不是1.3M
- [ ] 字體 body 18px，item-name 16px，手機可讀
- [ ] 其他獎章已併入進度，分頁隱藏
- [ ] 按項目已併入全團總覽，子切換按成員/按項目
- [ ] 表格官方格式，雙面列印
- [ ] 權限：高層可設低層可勾什麼，領袖默認全部，執委可按個別成員勾選會員章/活動段章(細項不用)/其他逐個勾
- [ ] 成員預設只看自己，能否看其他由團長在用戶管理→系統設定開關 `allow_member_view_others`
- [ ] 教學按角色分開：❓教學 tab 內嵌版，不依賴 fetch，成員不關心其他功能，登入後方便查閱
- [ ] SHEEP 超管僅超管可見，普通用戶在用戶管理看不到 super_admin 行
- [ ] 審批中心合併：獎章審批+用戶審批同一分頁，子切換
- [ ] V4.0更新及已修復問題已移除，保留 `#home-future-framework` 空框
- [ ] COPYRIGHT 2026 Scout System footer
- [ ] 單一 Code.gs，扁平ZIP，17-21文件，無舊文件
- [ ] MOCK 10成員 + CSV，SHEEP 測試工具
- [ ] `vercel.json` 開放 assets/docs/data/apps-script/api
- [ ] `troops.json` 保留 0082 後備

---

## 6. 原 Repo 供參考

https://github.com/playerkousas-rgb/vsbadge.git - v5.x FINAL 已包含上述所有

---

## 7. 你是否能做其他3個支部？

**答：能**，同一架構重用 80% 程式碼，只需替換 `items.json` + LOGO + 表格 + 文案，即可獨立出 3 個 APP：

- `cubbadge` 幼童軍
- `scoutbadge` 童軍  
- `roverbadge` 樂行童軍

每個獨立 Vercel + 獨立 Google Sheet 後端，互不干擾。

若用戶同意，我可立即開始製作其中一個支部（建議先做童軍支部，因為人數最多），或3個一起做。

---
COPYRIGHT 2026 Scout System - Template for Agent
