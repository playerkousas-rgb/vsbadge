# 🔥 深資童軍進度及行政平台 v8.0

> 基於 2026 年第11版《深資童軍訓練綱要》 • 2025 保護兒童更新  
> COPYRIGHT 2026 Scout System  
> 支援全前端帳戶管理、批量開戶、手機版介面、離線暫存、批量進度寫入、成員申請→領袖審批、官方表格自動填寫

## 快速結構

```
index.html              — 前端所有邏輯（單一 HTML）
data/items.json         — 考核項目定義（第11版修正版）
data/mock_members.json  — 10 MOCK 成員測試數據
data/mock_import.csv    — 進度測試 CSV
data/members_template.csv — 前端批量開戶範本
data/troops.json        — 旅團對照表
assets/vs-logo-*.png    — LOGO 128px + 256px + SVG fallback
apps-script/Code.gs     — Google Sheet後端（單一檔案版）
api/troops.js           — Vercel API
vercel.json             — 部署設定
docs/                   — 成員/執委/領袖教學 MD
```

## 部署

見 [DEPLOY_GUIDE_FOR_TROOPS.md](DEPLOY_GUIDE_FOR_TROOPS.md)

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
