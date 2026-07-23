# 🔥 深資童軍進度追蹤系統 v7.0

> 基於 2026 年第11版《深資童軍訓練綱要》 • 2025 保護兒童更新  
> COPYRIGHT 2026 Scout System  
> 支援 PNG LOGO、防卡死、離線暫存、批量寫入、成員申請→領袖審批、官方表格自動填寫

## 快速結構

```
index.html              — 前端所有邏輯（單一 HTML）
data/items.json         — 考核項目定義（第11版修正版）
data/mock_members.json  — 10 MOCK 成員測試數據
data/mock_import.csv    — CSV 匯入用
data/troops.json        — 旅團對照表
assets/vs-logo-*.png    — LOGO 128px + 256px + SVG fallback
apps-script/Code.gs     — Google Sheet後端（單一檔案版）
api/troops.js           — Vercel API
vercel.json             — 部署設定
docs/                   — 成員/執委/領袖教學 MD
```

## 部署

見 [DEPLOY_GUIDE_FOR_TROOPS.md](DEPLOY_GUIDE_FOR_TROOPS.md)

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
