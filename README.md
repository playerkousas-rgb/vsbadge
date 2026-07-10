# 🔥 深資童軍進度追蹤系統 v4.8 FINAL

> 基於 2026 年第 11 版《深資童軍訓練綱要》 + 2025 保護兒童更新  
> COPYRIGHT 2026 Scout System • 82旅測試版  
> 支援 PNG LOGO、防卡死、離線暫存、批量寫入、成員申請→領袖審批、官方表格自動填寫

---

## ✨ v4.8 更新重點（解決Vercel前端卡死）

**問題回報**：VERCEL 沒ERROR但前端卡死，沒有旅團列表0082，Welcome按鈕也不能點。

**原因**：`index.html` 內 `updateSegmentOptions()` 多一個 `{`，導致整個 `<script>` 解析失敗，`loadTroops()` 及 `showWelcomeTab()` 未定義。

**修復**：
- 已修復語法錯誤 `function updateSegmentOptions(){{` → `function updateSegmentOptions(){`
- `switchTab` 改為非同步 + `_switching` 鎖 + ESC緊急退出 + 雙擊Header返回，防止卡死
- `troops.json` 及 `data/troops.json` 保留0082，`api/troops.js` 合併環境變數
- 增加字體：body 16px→18px，item-name 14.5px→16px，手機可讀性提升

---

## 📚 登入後各功能教學

### 👤 成員 (member) 可以做什麼
- **只能看自己**的進度，不能看全團
- 不能直接剔，只能按「📝申請完成」提交日期+證據
- 在「📝待批」查看自己申請是否已批
- 查看「⭐其他獎章」中自己的其他獎章（急救/AYP等）
- 使用「🖨️表格列印」自動填PT/19/PT/20後列印（官方格式）
- 查看「📚資料庫」內綱要、保護兒童、安全指引

### 🎖️ 執委 (exec_committee) 可以做什麼
- 成員的所有功能
- 可勾選進度（需領袖授權可勾選範圍）
- 默認可考核：**會員章 + 活動段章(細項不用勾，勾段章即可) + 其他獎章逐個勾**
- 可在「我的進度」選其他成員查看其紀錄
- 可在「👥全團總覽」使用批量剔選（若被授權）
- 可在「📝待批」批准成員申請（若被授權）

### 👨‍💼 領袖 (branch_leader / group_leader / admin / SHEEP super_admin) 可以做什麼
- 所有成員及執委功能
- 在「我的進度」選任何成員看其所有紀錄
- 在「👥全團總覽」一眼睇邊個已完成會員章（卡片百分比+會員章✓標籤+表格✓）
- 使用「🚀考驗營批量完成」：選成員+選項目+日期，一鍵幫全團剔，不用逐個跳轉
- 直接勾選+輸入日期，離線暫存按確認批量寫入，過程有「正在寫入」提示
- 在「📝待批」批量批准/拒絕
- 在「👥用戶管理」將成員改為執委，並按個別成員設定可考核什麼（會員章/活動段章/其他獎章逐個勾）
- 領袖默認全部權限(*)，團長/管理員可更改低層級可勾選範圍
- 團長/管理員可在「👥用戶管理」授權/收回勾選權限，設定細緻權限
- 在「📋審批申請」審批新帳號

---

## 🗂️ 系統架構

```
前端 (Vercel) - PNG LOGO 256px + SVG fallback
├── index.html (146KB, 含防卡死、批量、官方表格)
├── data/items.json (52KB, 306項，第11版)
├── data/troops.json (0082 保留)
└── assets/vs-logo-256.png

後端 (各旅團獨立 Google Sheet)
├── 進度追蹤 (YMIS, 項目ID, 完成日期, 確認者, 備註)
├── 待批完成 (成員申請)
├── 其他獎章
├── Users (ymis, name, email, role, can_tick, allowed_badges)
└── Code.gs (28652 bytes, SHEEP權限修復版)
```

---

## 🚀 部署

**前端**：上傳 `vsbadge_v4.8_FINAL.zip` 解壓後17個文件到 GitHub，Vercel自動部署

**後端**：Google Sheet → 擴充功能 → Apps Script → 貼上 `apps-script/Code.gs` → 儲存 → 執行 `initializeSheets` → 部署為網頁應用程式

---

## 📄 表格

- **PT/19 深資童軍獎章**：4段章完成後申請，官方格式個人摘要+完成項目表+提名/推薦/批核
- **PT/20 榮譽童軍獎章**：4金帶完成，9月15日前交總會，安排當年大會操頒發
- 系統自動填入姓名、YMIS、旅團、段章完成日期，可編輯後列印，**最終樣式與總會官方一致**（雙面列印）

---

## 🔒 權限

- 領袖默認全部(*)，團長/管理員可更改
- 成員 → 執委：由領袖在用戶管理改角色，再按「⚙️權限」勾選可考核範圍
- 細項不用：執委勾段章層級即可，不用逐個子項
- 其他獎章：逐個勾（急救章、AYP等）

---

## 📱 手機優化

- 其他獎章已併入我的進度，不再獨立分頁（屏寬有限）
- 按項目已併入全團總覽，內有子切換「按成員總覽 / 按項目統計」
- 字體加大至18px base，電腦手機都清晰

---

## © COPYRIGHT

COPYRIGHT 2026 Scout System • 深資童軍進度追蹤系統 v4.8  
基於 2026年第11版《深資童軍訓練綱要》 | 香港童軍總會  
Developed for 82 Troop • All rights reserved

---

## 🧪 MOCK 測試

- `data/mock_members.json` 10名MOCK成員：陳大文等，YMIS 1234560001~0010，密碼123456
- 用 SHEEP / 0728 登入 → 用戶管理 → 🧪載入10個MOCK成員到全團 → 測試批量剔
- `data/mock_import.csv` 可匯入 Google Sheet

---

*基於 2026 年第 11 版《深資童軍訓練綱要》開發 | 支援 SHEEP超管 | PNG LOGO*
