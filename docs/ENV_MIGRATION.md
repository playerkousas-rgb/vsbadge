# v8.8：Vercel 環境變數登記與部署升級

## 1. 每個旅團只填三項（不用 JSON）

Vercel → Project → Settings → Environment Variables：

| Name（名稱） | Value（值） |
|---|---|
| `TROOP_0082_NAME` | `第 82 旅` |
| `TROOP_0082_BACKEND` | 該旅團**現有** GAS 正式 `/exec` URL |
| `TROOP_0082_APIKEY` | 該 GAS Script Properties 的**現有** `API_KEY` |

下一旅團例如 `1001`，便新增 `TROOP_1001_NAME`、`TROOP_1001_BACKEND`、`TROOP_1001_APIKEY`。

- 編號在變數名稱中，**不用第四個 ID 變數**，不需任何 JSON 字串／檔案。
- 使用大寫後綴；ID 完整保留（`0082` 不等於 `82`）。不可混用兩種編號。
- 三項未齊、URL 非 HTTPS GAS 正式 `/exec` → 不顯示／不可連線，不再憑空顯示 0082。
- 名稱會以純文字顯示；前端 API 只回傳 ID、name、en，不回傳後端 URL 或 API key。
- 英文名稱可選 `TROOP_0082_EN`，不填時沿用前端 `82nd Group` 自動顯示。
- Portal 原有 `PORTAL_DEFAULT_ORIGIN`、`PORTAL_DEFAULT_ROLES` 及旅團例外變數照常使用；原先寫在 JSON 的例外須搬到 env。
- 選擇正確環境（Production／Preview），儲存後**必須 Redeploy**。改環境變數不會自動更新已存在的部署。
- 不使用 `NEXT_PUBLIC_`／`VITE_` 前綴，不把敏感值放 Git、HTML、截圖或聊天。

## 2. 已在使用中的系統：不改 Sheet 升級順序

1. **先保留現有部署及設定的備份在專案外**，從各旅團「管理部署」取得現有 `/exec` URL，從 Script Properties 取得現有 API_KEY。不要產生新 Key，不要建立新 Sheet。
2. 先在 Vercel 設好所有旅團三項 env（包括現在使用的 0082）。新版本完全不讀取原 `data/troops.json`，漏填會使旅團不可見。
3. 部署本版 Vercel。設定 framework 為 Other、Node.js 22.x，清除舊 Output Directory／Build Command 的 Dashboard 覆寫。倉庫 `vercel.json` 使用 `npm run build`，由 `.vercel/output` Build Output API 自動接管，**不用填 dist 或根目錄**。
4. 檢查首頁旅團清單及普通用戶登入。
5. 各旅團以新版 `apps-script/Code.gs` 覆蓋原程式（保留自己的普通管理員等必要自訂設定）。
6. 在 GAS 編輯器執行一次 `authorizeConnection()`，核准新增的外部連線權限。此函式只連線測試，**不讀寫 Sheet**；測試回應 HTTP 405 代表服務可達。若看到 404／登入保護頁，先處理 Vercel 路由／Deployment Protection，不要跳過。
7. GAS → 部署 → 管理部署 → 編輯 → **新版本** → 部署，保留原 URL，執行身分為「我」、存取權「任何人」。
8. 完成新版 GAS 部署後，在試算表 Apps Script 編輯器**執行一次 `initializeSheets()`**。這是 v4.0.0 的定向清理：只移除舊版保留帳號的殘留列／操作痕跡，並將操作者欄匿名化為 `system`；不刪一般用戶、進度、審批或履歷資料，也不改欄位結構。不要手動清空 Tokens／Users。
9. 確認成員／領袖既有帳號可正常登入，進度、審批及管理功能正常；保留救援登入可用，且不在 Sheet 留下操作者身份紀錄。
10. 停用仍公開的舊 GAS 部署版本，確認沒有可用舊密碼進入的舊 `/exec` URL。檢查 Vercel 舊部署的公開存取／Deployment Protection，避免舊部署仍提供舊入口。

以上部署步驟須由有權限的擁有者執行，本地修改不會自動更新你正在使用的 Vercel／GAS。請同步更新前後端，再完成驗收。

### 不改 Sheet 結構的意思

不改工作表名稱或欄位，也不刪除一般成員的進度／用戶／履歷資料。v4.0.0 例外執行一次定向初始化，清理舊版保留帳號專屬殘留；一般用戶登入仍會像原版一樣在既有 Tokens 工作表新增登入紀錄，普通業務寫入維持不變。

## 3. 營運建議

- 不把正式密碼、API Key 或旅團資料放入 Preview 測試環境。
- 建議在 Vercel Firewall 設定登入路徑的速率限制。
- 檢查並停用不再使用的舊部署；刪除目前文件不會清除 Git 歷史或舊下載檔。

## 4. 驗收清單

- 旅團名稱、選團、中英切換、普通登入／登出、強制改密碼。
- 進度讀寫、完成申請及審批、其他獎章。
- 活動履歷新增／修改／刪除及團員申報／領袖審批。
- 成員清單、CSV／PDF 批量開戶、唯一身份、用戶管理、密碼重設。
- MOCK 示範、模板、Code.gs／教學下載、Portal 原有設定。

本地自動測試不能代替你現有 Sheet 與真實 GAS 的正式部署驗收；請先在測試旅團演練，再逐旅團更新。
