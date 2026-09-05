# 🔥 深資童軍進度及行政平台 v8.7

> 基於 2026 年第11版《深資童軍訓練綱要》 • 2025 保護兒童更新  
> COPYRIGHT 2026 Scout System  
> 支援全前端帳戶管理、批量開戶、手機版介面、離線暫存、批量進度寫入、帳戶自助申請→團長前端審批、官方表格自動填寫、活動履歷（服務／活動／訓練班紀錄）、履歷自行申報→領袖審批

## 中／英一鍵切換（英語旅團）

**🌐 English** 單鍵藥丸按鈕（與 ROVERBADGE 一致）切換全介面：

| 位置 | 顯示 |
|---|---|
| 未登入首頁／登入頁標題右上角 | `🌐 English`（英文模式變 `🌐 中文`） |
| 登入後用戶列（登出旁） | 同上 |

按一下即時全站切換，毋須重新載入；語言記在瀏覽器（`localStorage: vsbadge_lang`）。

- **未登入首頁全部有英文版**：選旅團畫面、四級架構、MOCK 試用、「📋 新旅團部署」、「📖 使用教學」、「📦 版本更新紀錄」— 中文模式下右上角仍有清晰可見的 `🌐 English` 按鈕，英語旅團不會誤以為「只有中文」。
- **分享連結可鎖定語言**：`?lang=en` / `?lang=zh`（例：`https://vsbadge.vercel.app/?lang=en`，主系統卡片亦可帶 `&lang=en`）。

訓練綱要採用香港童軍總會第11版官方英文譯名（Membership Badge、Venture Scout Epaulettes、Venture Scout Award、Dragon Scout Award、Project / Service / Multiple Skills / Outdoor Exploration Achievement Badge 及 Bar）。**項目 ID 不變**，雲端進度、審批、履歷紀錄中英共用同一套資料，只換顯示語言。

## 快速結構

```
index.html              — 前端所有邏輯（單一 HTML，統一 apiRequest() → /api/proxy）
data/items.json         — 考核項目定義（第11版修正版）
data/mock_members.json  — 10 MOCK 成員測試數據
data/mock_import.csv    — 進度測試 CSV
data/members_template.csv — 前端批量開戶範本
data/troops.json        — 旅團 Registry（id/name/backend/apikey）
assets/vs-logo-*.png    — LOGO 128px + 256px + SVG fallback
apps-script/Code.gs     — Google Sheet後端（單一檔案版 v8.7：進度/獎章/審批/帳戶/活動履歷/履歷申報/自助申請，含唯一身份、成員管理、領袖重設密碼）
api/proxy.js            — ⭐ 同源多旅團 GAS Proxy（SSRF 防護、逾時、錯誤標準化）
api/_registry.js        — 伺服器端可信旅團 Registry（troops.json + env 合併、URL 白名單）
api/troops.js           — Vercel API（只回傳旅團 id/name，不洩 backend/apikey）
tests/                  — e2e 測試（雙 mock GAS 旅團）+ YMIS 解析單元測試 + 本機 dev server
vercel.json             — 部署設定
docs/                   — 成員/執委/領袖教學 MD（含 .en.md）+ PROXY_ARCHITECTURE.md
```

## 🔐 v3.0 同源 Proxy 架構（重要）

瀏覽器**不再直接 fetch 各旅團 GAS URL**（解決 Failed to fetch / CORS / GAS 302 redirect /
寫入成功但前端收不到回應等問題）。全部請求改經：

```
瀏覽器 → 同源 /api/proxy → 伺服器端 Registry 查找旅團 GAS → Google Sheet
```

多旅團完整保留；前端只提交 troopId，GAS URL 永不離開伺服器（防 SSRF / Open Proxy）。
詳見 [`docs/PROXY_ARCHITECTURE.md`](docs/PROXY_ARCHITECTURE.md)。

## 部署

見 [DEPLOY_GUIDE_FOR_TROOPS.md](DEPLOY_GUIDE_FOR_TROOPS.md)

## v8.7 用戶管理、唯一身份及密碼重設

- **YMIS 及 Email 均為唯一身份欄位**：單筆開戶、批量開戶、自助申請、審批及編輯資料都會在後端再次檢查；Email 不分大小寫，停用或已刪除帳戶的識別碼亦不可開成另一帳戶
- 「用戶管理」會合併顯示 `Users` 帳戶及「成員名單」內尚未開戶的成員；領袖可直接編輯、開立登入帳戶或刪除名單成員
- 有登入帳戶的成員會顯示「🔑 修改／重設密碼」，支部領袖或以上可設定臨時密碼；舊登入會撤銷，下次登入必須立即改密碼
- 刪除帳戶會停止登入並從成員名單移除，但保留歷史進度／履歷及 YMIS／Email tombstone，避免身份被另一帳戶冒用
- 修正前端重複程式碼造成的 JavaScript 語法錯誤，並加入完整主程式語法測試
- **旅團後端必須升級**：用最新 `apps-script/Code.gs` 覆蓋並重新部署「新版本」；本版沒有新增工作表，毋須執行 `initializeSheets()`

## v8.4 履歷申報（團員自行申報 → 領袖審批）

- 團員在「📅 活動履歷」可按「📝 申報紀錄」**自行申報**服務／活動／訓練班紀錄；提交後進入「待批履歷」，**領袖批准後才寫入**「活動履歷」工作表
- **已批准的履歷紀錄，團員可再按 ✏️ 提交「修改申報」**：以同一 `record_id` 更新，但必須經領袖**重批**才生效（同一紀錄同時只可有一個待批修改申報；批准前可自行取消）
- **只有履歷申請有此「批後可再申報修改」機制**：進度待批（待批完成）及其他獎章維持原狀——批准／寫入後只有領袖可以更改
- 團員只可為**自己**申報（後端以登入 token 強制 ymis，不接受偽冒）；領袖照舊可直接新增／編輯／刪除
- 領袖在「審批中心」→「📅 履歷申報」逐項批准／拒絕；批准「新增申報」即寫入活動履歷、批准「修改申報」即更新原紀錄
- GAS 後端新增「待批履歷」工作表及 4 個 action（requestLogRecord／getLogRequests／reviewLogRequest／cancelLogRequest），審批權限與進度審批相同（已獲勾選權限的領袖）
- **需要旅團 Apps Script 升級至 v8.4**：覆蓋 Code.gs → 執行 `initializeSheets()` 補建「待批履歷」→ 管理部署 → 新版本部署（URL 不變）。未升級旅團一切照舊，只是不顯示申報按鈕——見 [`DEPLOY_GUIDE_FOR_TROOPS.md`](DEPLOY_GUIDE_FOR_TROOPS.md)「v8.4 升級」
- 新 action 已加入 `/api/proxy` 白名單，繼續全線走同源 Proxy

## v8.2 帳戶自助申請（成員／執委／領袖）

- 登入頁「🆕 申請帳戶」可選擇申請身份：**團員／執委／領袖（支部領袖）**；團長／管理員仍須由現任團長在「用戶管理」直接開立
- **毋須填寫支部／單位**：支部＝深資童軍（本系統），單位自動帶入所選旅團名稱，申請人只填 YMIS、姓名、電郵（執委／領袖必填）
- **團長／支部領袖**在「審批中心」→「👤 用戶審批」一鍵批准；批准時**按申請身份直接開戶**（審批者權限不足時退回團員並提示），並顯示一次性臨時密碼
- 後端 v8.2（可選升級）：`apply` 接受並驗證 `requested_role`、`getApplications` 回傳申請角色、`reviewApplication` 按角色開戶並回傳 `final_role`——**無新工作表／新欄位，毋須 `initializeSheets()`**，覆蓋 Code.gs 重新部署即可；未升級旅團一切照舊（申請以團員開戶，領袖批准後可在用戶管理調整角色）

## v8.1 活動履歷（服務／活動／訓練班紀錄）

- 新 tab「📅 活動履歷」記錄成員參加的各項活動：**🤝 服務紀錄**（含時數統計）、**🏕️ 活動紀錄**、**🎓 訓練班紀錄**（含證書編號）
- 領袖可新增／編輯／刪除，支援「同一活動批量套用到多個成員」（例如全團露營一次過補登）
- 成員唯讀查看自己的履歷；領袖可切換檢視任何成員
- GAS 後端新增「活動履歷」工作表及 3 個 action（getLogRecords／saveLogRecord／deleteLogRecord），寫入權限與進度寫入相同（已獲勾選權限的領袖）
- **需要旅團 Apps Script 升級至 v8.1**：覆蓋 Code.gs → 執行 `initializeSheets()` → 管理部署 → 新版本部署（URL 不變）。未升級旅團只會見到升級提示，現有功能及資料完全不受影響——見 [`DEPLOY_GUIDE_FOR_TROOPS.md`](DEPLOY_GUIDE_FOR_TROOPS.md)「v8.1 升級」
- 新 action 已加入 `/api/proxy` 白名單，繼續全線走同源 Proxy，瀏覽器不接觸 GAS URL

## v8.0 前端行政及手機版

- 「用戶管理」可新增、編輯、重設密碼、停用／重啟帳戶及查看操作紀錄
- CSV／JSON 前端預覽、驗證及批量開戶，空白密碼預設為 `1234`
- **YMIS 自訂報表 PDF 批量開戶**（瀏覽器內 pdf.js 解密，PDF 不上傳伺服器；見 [`docs/YMIS_EXPORT.md`](docs/YMIS_EXPORT.md)）
- 成員可在登入頁自行申請，領袖在審批中心批准並開戶
- 初始及重設密碼首次登入強制更改
- 手機底部彈窗、安全區、44px 觸控目標、響應式卡片及管理工具列
- 後端再次驗證角色層級，帳戶管理不能只靠 API Key

## v8.3 密碼及超管帳號

- 密碼最短 **4 位**（不再強制 8 位），適用於更改密碼、開立帳戶、重設密碼及批量開戶。
- 批量開戶／審批的初始密碼統一預設為 **1234**；首次登入仍會要求更改。
- 內置超管 `sheep`／密碼 `0728` 為**只在後端（GS/Apps Script）存在的虛擬帳號**：不會寫入 Users 工作表，亦不會在「用戶管理」（USER 表單）出現；可直接以 `sheep` 或 `sheep@vsbadge.local` 登入，密碼可於登入後經「改密碼」自訂（存於後端，不會寫入 Sheet）。舊部署已把 sheep 寫入 Users 的，`initializeSheets()` 會自動移除該列（只匹配 `sheep`／`sheep@vsbadge.local`，不會誤刪其他帳號）。

批量開戶說明見 [`docs/BULK_ONBOARD.md`](docs/BULK_ONBOARD.md)。部署新後端或升級既有後端後，請再次執行 `initializeSheets()` 以補上新欄位及「操作紀錄」工作表。

## v7.0 修正（對照總會第11版綱要）

1. 會員章禮節新增「示範國旗和區旗的升掛方法」
2. 社會服務段章分為選修部分(I) + 選修部分(II)，新增消防選項
3. 康樂體育新增「兩項不同類型體育技能章」選項
4. 新體驗改為6範疇6選2結構
5. 戶外探險段章：地圖閱讀/遠足訓練改為條件性必修；新增海上旅程訓練前設
6. 活動策劃金帶改為2選1
7. 社會服務金帶移除專門技能服務，改為3選項
8. 多元技能金帶童軍技能修正為4項；新體驗不再標為進階
9. 戶外探險金帶：機動化停留點≥3；海上旅程60km
10. 修復JSON parse error及勾選後百分比同步更新
