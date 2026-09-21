# 超管登入部署排障（維運文件，不部署至公開網站）

`TROOP_{ID}_NAME`、`TROOP_{ID}_BACKEND`、`TROOP_{ID}_APIKEY` 三項只用於登記旅團。使用超管帳號時，還必須在**同一個 Vercel Project** 的 Environment Variables 設定：

| Name（名稱） | Value（值） |
|---|---|
| `SUPER_KEY` | 超管登入密碼，程式要求至少 **4 個字元**；建議使用密碼管理器產生並保存長隨機密碼 |

- 名稱必須是 `SUPER_KEY`（大寫），不是 `TROOP_0082_SUPER_KEY`，也不是旅團的 `API_KEY`。
- 這是 Vercel 伺服器端設定，**不用放到 GAS Script Properties、Sheet 或前端**。不要把實際值貼到聊天、截圖或 Git。
- 登入超管時，密碼填入此值；舊版 GAS 的超管密碼不會自動成為此設定。
- 選取你正在使用的環境：正式網域用 Production，分支預覽用 Preview（並檢查分支限定）。不要把正式密碼複製到測試環境。
- 儲存後，對相應環境 **Redeploy**，確認瀏覽的是新部署，而不是舊部署的固定網址。只更改環境變數不會更新舊部署。
- 4 個字元是相容既有密碼的最低門檻，不代表足夠安全。此值亦用於票據／session 加密，短密碼較容易被猜中或離線暴力破解；仍建議使用長密碼，並在 Vercel 設定登入速率限制（只保護線上嘗試）。
- 此值也用於加密超管票據／session；更改後既有超管 session 將失效，須重新登入。

#### 出現「登入服務暫時無法使用，請聯絡管理員」

在本版 `/api/proxy` 中，超管登入回傳 HTTP 503 及此訊息，表示**該部署執行時讀取不到 `SUPER_KEY`，或其長度少於 4 個字元**。這一步發生在密碼比對及 GAS 請求之前，不需重建 Sheet 或重設旅團 API Key。

1. 檢查 `SUPER_KEY` 的名稱、長度、Project、Production／Preview 及分支範圍。
2. 確認設定儲存後已重新部署，並使用新部署測試。
3. 本次修訂起，Vercel Runtime Logs 的 `/api/proxy` 會記錄 `result: "super_auth_misconfig"`，不會記錄密碼、密鑰或請求內容。舊部署不會有這項紀錄。

`/api/troops` 有列出 `0082`，只代表旅團登記項目齊備且 URL 格式可信；不代表超管設定、GAS 存取權或連線已驗證。回應不顯示 backend／apikey 是正常安全設計。

建置時若提示 Project Settings 的 Node.js 24.x 被 `package.json` 的 22.x 覆蓋，這是警告，不是上述登入錯誤。此版本的 `package.json` 及建置產生的 Functions runtime 均指定 22.x；將 Project Settings 同步設為 22.x 即可消除版本不一致，無需為此把程式改成 24.x。

