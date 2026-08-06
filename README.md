# 🔥 深資童軍進度及行政平台 v8.1

> 基於 2026 年第11版《深資童軍訓練綱要》 • 2025 保護兒童更新  
> COPYRIGHT 2026 Scout System  
> 支援全前端帳戶管理、批量開戶、手機版介面、離線暫存、批量進度寫入、成員申請→領袖審批、官方表格自動填寫、活動履歷（服務／活動／訓練班紀錄）

## 快速結構

```
index.html              — 前端所有邏輯（單一 HTML，統一 apiRequest() → /api/proxy）
data/items.json         — 考核項目定義（第11版修正版）
data/mock_members.json  — 10 MOCK 成員測試數據
data/mock_import.csv    — 進度測試 CSV
data/members_template.csv — 前端批量開戶範本
data/troops.json        — 旅團 Registry（id/name/backend/apikey）
assets/vs-logo-*.png    — LOGO 128px + 256px + SVG fallback
apps-script/Code.gs     — Google Sheet後端（單一檔案版 v8.1：進度/獎章/審批/帳戶/活動履歷）
api/proxy.js            — ⭐ 同源多旅團 GAS Proxy（SSRF 防護、逾時、錯誤標準化）
api/_registry.js        — 伺服器端可信旅團 Registry（troops.json + env 合併、URL 白名單）
api/troops.js           — Vercel API（只回傳旅團 id/name，不洩 backend/apikey）
tests/                  — e2e 測試（雙 mock GAS 旅團）+ 本機 dev server
vercel.json             — 部署設定
docs/                   — 成員/執委/領袖教學 MD + PROXY_ARCHITECTURE.md
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

## v8.1 活動履歷（服務／活動／訓練班紀錄）

- 新 tab「📅 活動履歷」記錄成員參加的各項活動：**🤝 服務紀錄**（含時數統計）、**🏕️ 活動紀錄**、**🎓 訓練班紀錄**（含證書編號）
- 領袖可新增／編輯／刪除，支援「同一活動批量套用到多個成員」（例如全團露營一次過補登）
- 成員唯讀查看自己的履歷；領袖可切換檢視任何成員
- GAS 後端新增「活動履歷」工作表及 3 個 action（getLogRecords／saveLogRecord／deleteLogRecord），寫入權限與進度寫入相同（已獲勾選權限的領袖）
- **需要旅團 Apps Script 升級至 v8.1**：覆蓋 Code.gs → 執行 `initializeSheets()` → 管理部署 → 新版本部署（URL 不變）。未升級旅團只會見到升級提示，現有功能及資料完全不受影響——見 [`DEPLOY_GUIDE_FOR_TROOPS.md`](DEPLOY_GUIDE_FOR_TROOPS.md)「v8.1 升級」
- 新 action 已加入 `/api/proxy` 白名單，繼續全線走同源 Proxy，瀏覽器不接觸 GAS URL

## v8.0 前端行政及手機版

- 「用戶管理」可新增、編輯、重設密碼、停用／重啟帳戶及查看操作紀錄
- CSV／JSON 前端預覽、驗證及批量開戶，支援自動產生臨時密碼
- 成員可在登入頁自行申請，領袖在審批中心批准並開戶
- 初始及重設密碼首次登入強制更改
- 手機底部彈窗、安全區、44px 觸控目標、響應式卡片及管理工具列
- 後端再次驗證角色層級，帳戶管理不能只靠 API Key

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
