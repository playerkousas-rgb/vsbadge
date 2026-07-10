# v4.1 緊急修復 + 更新指南（for GitHub網頁更新）

## 你提到的2點已修復

### 1️⃣ 到百分比那頁後不能退出 - 已徹底修復
**原因**：舊版 `switchTab` 直接同步渲染巨型表格，若資料多或出錯，主線程卡死，點擊其他tab無反應。

**本次 v4.1 修復**：
- `switchTab` 改為**非同步**：先立即切換tab顯示載入中，50ms後才渲染，不會阻塞UI
- 加入 `_switching` 鎖防止連點重疊
- 所有渲染用 `try/catch` 包住，出錯時顯示錯誤卡 + 「🏠 返回我的進度」按鈕，不會卡死
- 支援 **ESC鍵 緊急退出**：按 ESC 關閉所有彈窗並返回「我的進度」
- 雙擊頂部棗紅 Header 也可立即返回進度頁
- 按項目頁及全團頁限制 30欄/50人，避免巨型DOM

你現在就算到百分比頁按錯，也可按 ESC 或點其他tab立即退出。

### 2️⃣ 82旅資料保留
已確認 `data/troops.json` 及 `troops.json` 均保留：
```json
{
  "0082": {
    "name": "第 82 旅",
    "backend": "https://script.google.com/macros/s/AKfycbxqQ3JnEdSRnxlhoSEasa6-wX5F58p3dMqBiQRj1zg-SDn7YtFLBKykN5LiWcadgRdCBg/exec"
  }
}
```
沒有覆蓋，正在用的測試數據不受影響。

---

## 📦 壓縮檔內容

### `vsbadge_v4.1_fixed.zip` (61KB) - 前端完整包
解壓後包含：
- `index.html` - v4.1 防卡死版
- `data/items.json` - 306項完整綱要
- `data/troops.json` - 含82旅（保留）
- `troops.json` - 含82旅（保留）
- `apps-script/Code.gs` - v4 後端
- `apps-script/Code.gs.v4` - 同上備份
- `vercel.json`
- `FIXES_REPORT_V4.md`

**GitHub網頁更新方法：**
1. 到 https://github.com/playerkousas-rgb/vsbadge
2. 點 `Add file` → `Upload files`
3. 將 zip 解壓後的文件拖曳上去（可分批：先拖 index.html，再拖 data/ 內文件）
4. Commit 推送，Vercel 會自動部署（約1分鐘）

### `VS_Script_v4_Update.zip` (6.3KB) - 僅後端
內含 `Code.gs` v4

**Google Apps Script 更新方法：**
1. 開啟你的 Google Sheet（82旅那個）
2. 擴充功能 → Apps Script
3. 刪除舊 Code.gs 內容，貼上新的 `Code.gs` 全部（428行）
4. 儲存 → 執行 `initializeSheets` → 授權
5. 它會自動新增兩張工作表：`待批完成`、`其他獎章`，舊資料完全保留
6. 無需重新部署（若之前已部署為網頁應用程式），但建議重新部署一次以獲最新權限

---

## ✅ 更新後測試
1. 登入82旅 → 到「🔍 按項目」頁 → 應可自由切走，ESC也可退出
2. 全團頁預設只顯示30欄，不會卡
3. 成員申請 → 待批頁應有紅點 → 領袖批准 → 底部 SaveBar 出現 → 確認寫入

有問題再貼圖給我！
