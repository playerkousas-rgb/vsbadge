# 🗺️ 旅團部署指南 v5.0 - 有主系統 / 無主系統 兩條路

> 10分鐘完成。支援 **獨立使用** 及 **接入主系統 (scoutsystem-2.0)**，有主系統不等於一定要接上，可自由選擇

---

## 🌟 先了解一下：什麼是主系統平台？

你而家用緊嘅 **深資童軍進度追蹤 (vsbadge)** 係一個 **第3級元件 (Tier 3)**，可以獨立使用，但其實佢屬於一個更龐大嘅平台：

### **scoutsystem-2.0 主系統平台**

主系統係一個整合旅團日常運作嘅大型平台，包含：

- 📊 **Dashboard 儀表板**：全旅團人數、活動、財政一目了然
- 👥 **成員管理**：全旅團名單、YMIS、聯絡、家長資料
- ✅ **集會考勤**：QR Code 點名、自動統計出席率
- 💰 **財務管理**：團費、活動收費、報表
- 📅 **活動管理**：活動報名、名單、通告
- 🧩 **插件市場 (Router)**：本系統就係其中一個 Tier 3 插件，可一鍵加入 Dashboard 卡片
- 🔐 **單一登入**：登入主系統後，點任何插件卡片自動帶入身份，唔使再輸入 YMIS/密碼

> **重點：有主系統 ≠ 一定要接上本系統**
> 你旅團有主系統，都可以選擇繼續獨立用 vsbadge (bookmark `vsbadge.vercel.app`)，兩條路並存，唔衝突。
> 接上主系統嘅好處係：領袖/成員點卡片即入、身份自動帶入、介面嵌入 (`embed=1`) 更精簡。

---

## 🗺️ 部署地圖：兩條路共通 + 分叉

```
所有旅團共通 (必做)：
  下載 Code.gs → 建立 Google Sheet → 貼上 Code.gs → 執行 initializeSheets → 部署為網頁應用程式 → 複製 URL + API Key

分叉：

軌道 A：無主系統 / 有主系統但想獨立用 (推薦新手)
  → 將 URL + API Key 交給 vsbadge 管理員 → 加入 troops.json → 完成
  → 用法：打開 vsbadge.vercel.app → 選 0082 → 登入
  → 優點：簡單，唔使搞主系統

軌道 B：有主系統並想接上 (進階)
  → 同樣將 URL + API Key 交給 vsbadge 管理員 (加入 troops.json)
  → 額外：將 URL + API Key 交給主系統管理員，填入主系統「旅團設定 → 元件設定」vsbadge 卡片的 backend + apikey 欄位
  → 用法：主系統 Dashboard 點「深資童軍進度追蹤」卡片 → 自動帶入身份 (from=portal&embed=1) → 直接用
  → 優點：單一登入、自動帶身份、介面嵌入、成員唔使記多個密碼

兩條路可同時用：領袖從主系統卡片入(自動身份)，成員 bookmark 獨立連結
```

---

## 🔧 共通步驟 (所有旅團必做，10分鐘)

### 第 1 步：下載後端程式碼 (單一檔案版)

- 訪問 `https://vsbadge.vercel.app/` → 點擊 **「📋 新旅團部署」**
- 點擊 **「⬇️ 下載 Code.gs (最新唯一版本)」** → 得 `Code.gs` (約27KB, 含 SHEEP 修復+細緻權限+私隱開關)

### 第 2 步：建立 Google Sheet

1. 開 [Google Sheets](https://sheets.google.com) → 建立新試算表，命名如「82旅 深資進度 - 第11版」
2. 點擊 **「擴充功能」→「Apps Script」**

### 第 3 步：貼上並初始化

1. 刪除預設程式碼，貼上 `Code.gs` 全部 (約 600 行)
2. **不需改任何程式碼**
3. 點 💾 儲存
4. 函數選單選 `initializeSheets` → 點 ▶ 執行
5. 授權：選你的 Google 帳號 → 進階 → 前往 → 允許
6. 系統自動建立 7 張工作表：
   - `進度追蹤` (YMIS, 項目ID, 完成日期, 確認者, 備註)
   - `成員名單`
   - `Users` (ymis, name, email, role, password_hash, can_tick, allowed_badges 等)
   - `Applications` (新帳號申請)
   - `Tokens`
   - `SystemConfig` (allow_member_view_others 等)
   - `待批完成` (成員申請完成)
   - `其他獎章`
7. 彈窗顯示 **API Key** (`vs_...`) 及超管帳號 `SHEEP / 0728` → **複製保存**

### 第 4 步：部署為網頁應用程式

1. 點 **部署 → 新增部署** → 齒輪 → **網頁應用程式**
2. 設定：描述 `vsbadge 82旅`, 執行身分 `我`, 存取權 `任何人`
3. 點部署 → 複製 **網頁應用程式網址** (`https://script.google.com/macros/s/.../exec`)

### 第 5 步：提交給 vsbadge 管理員 (獨立用必要)

將以下交給 vsbadge 管理員 (GitHub `troops.json` 維護者)：

| 資訊 | 範例 |
|------|------|
| 旅團編號 | 0082 |
| 旅團名稱 | 第82旅 |
| Apps Script URL | https://script.google.com/.../exec |
| API Key | vs_xxxxxxxxxxxxxxxx |

管理員加入 `troops.json` 後 Vercel 自動部署，之後 `vsbadge.vercel.app` 就會有你旅團，你的成員可獨立使用。

**到此，軌道 A (無主系統/獨立用) 已完成！可跳到首次登入。**

---

## 🔀 分叉：軌道 B - 接入主系統 (可選)

> **有主系統 ≠ 一定要接上**，你可以有主系統但仍選擇獨立用。若想享受單一登入，請繼續。

### 第 6 步 (僅軌道 B)：提交給主系統管理員

將 **同一組** URL + API Key 交給你旅團的主系統管理員 (scoutsystem-2.0 管理員)：

- 旅團主系統後台 → 旅團設定 → 元件設定 → 找到 `vs_badge_tracker` 卡片
- 填入：
  - `backend`: 你的 Apps Script URL
  - `apikey`: 你的 API Key
- 保存

### 第 7 步 (僅軌道 B)：主系統自動帶入身份

之後成員/領袖在主系統 Dashboard 點「深資童軍進度追蹤」卡片，URL 會自動變成：

```
https://vsbadge.vercel.app/?u=0082&role=leader&ymis=1234567890&name=陳大文&from=portal&embed=1&backend=...&apikey=...
```

- `u` 旅團編號
- `role` / `ymis` / `name` 自動帶入，無需再登入
- `from=portal` 標記主系統信任模式，免密碼
- `embed=1` 精簡介面，隱藏大Header，適合 iframe 600-750px 高
- `backend` / `apikey` 若主系統有填，會直接使用，否則自動查 `troops.json`

**結果**：點卡片即入，身份已帶入，進度、批量、審批、表格功能完全一致。

---

## 👤 首次登入 (兩條軌道共通)

### 用 SHEEP 超管建立第一個管理員

SHEEP 是隱藏超管，僅開發測試用，不會顯示在用戶列表 (非超管看不到)：

- YMIS: `sheep` / 密碼: `0728` / 角色: super_admin

用 SHEEP 登入後：

1. 去 **👥用戶管理** 會見到角色說明 (USER=所有人，成員=純成員不包括領袖)
2. 你會見到 **🧪測試工具** (僅SHEEP可見) 可一鍵載入10個MOCK成員測試批量
3. 去 **📋審批申請** (已合併入 **✅審批中心** → 用戶審批) 批准第一個管理員申請

### 建立管理員帳號

1. 登出 SHEEP
2. 回首頁選旅團 → 點「還沒有帳號？申請加入」→ 填 YMIS 10位、姓名、申請角色「管理員」→ 提交
3. 再用 SHEEP 登入 → 審批中心 → 用戶審批 → 批准
4. 登出，用新管理員帳號登入 (預設密碼 `changeme`，立即更改)

---

## 🔒 權限及私隱 (v5.0 重點)

- **領袖默認全部(*)**
- **成員默認無**
- **執委默認**：會員章 + 活動段章(細項不用) + 其他獎章部分，可由團長在用戶管理按「⚙️權限」個別設定可考核什麼
- **私隱開關**：用戶管理頁 → 系統設定 → **允許成員互相查看進度** (鼓勵模式)
  - 關 (默認)：成員只能看自己，重私隱
  - 開：成員可看全團(唯讀)，互相鼓勵，執委可按進度策劃活動
  - 僅團長/管理員可開關

---

## 🆘 常見問題 - 兩條軌道對比

**Q: 我們旅團有主系統，一定要接上嗎？**
A: 不用。有主系統不等於一定要接。你可以繼續獨立用 vsbadge (bookmark連結)，簡單。想享受單一登入才接。

**Q: 接上後獨立用還能用嗎？**
A: 能，雙軌並存。領袖從主系統卡片入(自動身份)，成員直接開 vsbadge.vercel.app。

**Q: 顯示「無法連接後端」？**
A: 確認 Apps Script 部署存取權為「任何人」，且 `troops.json` 已包含你旅團或主系統卡片已填 backend/apikey。

**Q: 忘記 API Key？**
A: Apps Script 編輯器選 `showApiKey` 函數執行，會再次顯示。

**Q: SHEEP 帳號會被其他人看到嗎？**
A: 不會。只有超管登入才看到測試工具及超管角色說明，普通用戶在用戶管理看不到 `super_admin (SHEEP)` 那行，已過濾。

---

## 📦 版本更新

`welcome-changelog` 已精簡，保留框架 `#home-future-framework` 供未來新版本寫入：

- 新版本後端 `Code.gs` (記得保有舊資料 - `initializeSheets` 不會清舊資料)
- 新功能和改動說明

目前 v5.0 FINAL 已穩定，包含 PNG LOGO 256px、防卡死、批量、官方表格、細緻權限、MOCK、私隱開關、教學按角色分開。

---

## 📞 需要幫助？

- 前端：`vsbadge.vercel.app` → 📋新旅團部署
- 後端：`apps-script/Code.gs` 單一檔案版
- 主系統平台：scoutsystem-2.0 有 Dashboard、考勤、財務、活動報名等更多功能，本系統是其中一個 Tier 3 插件

---
COPYRIGHT 2026 Scout System
