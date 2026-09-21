# 長期維護：防增肥、圖片格式與 Vercel 部署規範

> 原則：先確保既有功能、邏輯、UI、使用者體驗零倒退，再做可量測的瘦身。不得為追求檔案小而刪掉實際用到的功能／資源。

## 必須遵守的守護規範

1. **`.vercelignore` 必備**：排除 `.git/`、`node_modules/`、`.env*`、`.vercel/`、`*.bak*`、`*.log`、`*.tmp`、`*.old`、`uploads/`、`coverage/`、`.cache/` 及多餘 `dist/`／`build/`／`.next/`。測試不需上傳 Vercel，保留於 Git 以便本地／CI 驗收。
2. **只能安全移除確認未用的資源**：全文搜尋 HTML／CSS／JS／GAS／MD；同時檢查動態路徑、fallback、MOCK、教學及下載連結。不能因檔名有 mock／test 就刪掉真正在 UI 使用的內容。
3. **備份不入庫**：`*.bak*`／`*.tmp`／`*.old` 移出專案或刪除；正式資料、上傳檔、原稿、大型截圖、影片、資料集放專案外或外部儲存，禁止複製進部署目錄。
4. **package.json 極簡**：目前零 dependencies、零 devDependencies。不任意增加大型套件。只在建置使用的工具必須放 devDependencies；新增 runtime 依賴必須說明必要性、替代方案、部署體積影響並調整守護測試。不因 CDN 較小就取消安全性／離線／版本固定要求。
5. **只產生必要輸出**：`scripts/build.mjs` 產生 `.vercel/output/static` 與四個 API functions。static 白名單：首頁、assets、data（非旅團登記）、docs、Code.gs 與兩份公開指南。API helper 只在 function bundle，不作公開 endpoint。測試、開發伺服器、Git、env、node_modules 不可在 output。
6. **不重複上傳 build cache**：`.vercel/output` 由建置即時產生、Git 忽略、Vercel upload 忽略；不用 outputDirectory 指向專案根目錄，也不用 legacy `builds` 把 `api/**` helper 全部署成 function。改路徑必須同步 build smoke test。
7. **每次改版必跑**：`npm run check`、`npm run lint`、`npm test`、`npm run build`、`npm run test:build`。現有 check／lint 為零依賴語法、資源及安全守護檢查，不冒稱完整 ESLint 規則集。
8. **如實報告**：列出刪除檔案、原始 byte 數、輸出體積及未做的真實環境驗收。不把 Git 歷史、API 壓縮傳輸大小、本地 checkout、上傳來源和最終 function bundle 混為同一容量。
9. **機密只留伺服器**：旅團只用三個 env 登記；不可新增公開 Registry JSON、把密碼插值進 HTML、打包 env、或寫入 log。
10. **已在使用的 Sheet 禁止順手遷移**：除非另有明確需求，不改 schema、不清空資料、不執行 initializeSheets。安全驗證不得只用 mock 宣稱正式環境 100% 驗收完成。

## 圖片格式原則

- **可以使用 AVIF**：新照片、大型點陣圖片先測 AVIF，按實際顯示尺寸輸出，對比畫質／透明度／顏色／解碼成本與 WebP／原檔。
- 圖示／線條圖適合 SVG；要求像素一致或需廣泛相容的標誌可保留已優化 PNG，禁止為統一副檔名而降畫質。
- 轉檔不是把 `.png` 改名為 `.avif`；更新 HTML／CSS／JS／下載連結與 MIME，保留尺寸、alt、版面、透明度及合理 fallback。
- 有相容性要求時以 `<picture><source type="image/avif">…<img ...></picture>` 保留必要 fallback；**同時計算 AVIF + fallback 總體積**，不能只宣傳單檔節省卻令部署增肥。
- 確認所有引用已更新及視覺驗收後才刪除原圖；不用把高解析度母檔、轉檔暫存及工具加入 runtime dependencies。
- 本次兩張現有 PNG 合計 95,635 bytes，有實際 UI／fallback 用途；嘗試無損重新編碼未減少體積，因此不作有損轉換、不增加 AVIF 重複版本。

## 本次檢查／量測

- 刪除 `data/troops.json`：230 bytes（登記改為 env，不再公開 URL／設定）。
- 刪除 `assets/vs-torch.svg`：815 bytes（全文搜尋未發現引用，首頁內嵌 SVG fallback 仍保留）。
- **直接刪除共 1,045 bytes（約 1.02 KiB）**。沒有發現需要刪除的備份檔或大型原稿。
- 保留 `data/mock_members.json`（MOCK 模式確實 fetch）、`data/mock_import.csv`（README 公開測試範本）、兩張 logo、`assets/batch-onboard/Code.gs`（批量開戶後備工具）、所有教學。
- 原始 Git tracked 工作樹檔案總和 844,851 bytes（不含 `.git`）；新版新增必要的安全程式／測試／維護文件，不宣稱總倉庫一定比原版小。
- 測試與開發工具保留在 Git，但 `.vercelignore` 排除上傳；build 白名單也確保它們不會變成生產靜態檔。
- 首次完整驗證輸出為 775,764 bytes（約 758 KiB，含四個 function bundle）；後續文件／安全修正可能略有變化。原有 tests/ 共 98,186 bytes，現在明確排除部署上傳。
- 最終輸出 byte 數由每次 `npm run build` 即時列印；Vercel 平台自己的快取／舊部署仍需在 Dashboard 按保留政策管理，本機不能保證清除雲端歷史配額。

## 附：上次緊急任務內容（整理保存）

**緊急任務：專案極致瘦身與 Vercel 部署優化（嚴格要求功能 100% 不變）**

在確保所有既有功能、邏輯、UI 與使用者體驗 100% 正常運作、零倒退（Zero Regressions）的前提下，徹底進行儲存空間瘦身與 Vercel 部署優化，防止儲存空間配額爆滿：

- 最重要：根目錄備有 `.vercelignore`，排除 `.git`、`node_modules`、`*.bak`、`*.log`、測試上傳目錄（如 uploads/）、未使用暫存及重複建置快取。
- Grep 靜態資源：移除從未被 HTML／CSS／JS／代碼引用的高解析度截圖、設計原稿、展示圖、孤立測試檔；安全刪除所有 `*.bak`／`*.tmp`／`*.old`。
- package.json 極簡：嚴禁隨意安裝龐大、非必要或可輕量引入的依賴；建置工具（如 Vite／Tailwind CLI）歸 devDependencies，不作生產 runtime 套件。
- 檢查 vercel.json、outputDirectory 與建置設定，只上傳最終必要網頁產物，不上傳整包開發環境。
- 完成後執行 npm run check／npm run lint／npm run build，列出刪除檔案及容量，確認核心功能清單。
- 將防增肥規範寫進 MD，避免之後改版忘記；圖片可以轉為 AVIF，但仍須符合零倒退與總容量原則。
