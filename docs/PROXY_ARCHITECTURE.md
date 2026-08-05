# 🔐 v3.0 同源 Proxy 連線架構

> 由 v3.0 起，**瀏覽器永不直接連接 Google Apps Script**。所有 GAS 通訊經同源 Vercel Proxy 轉發，解決 Failed to fetch / CORS / GAS 302 redirect / 寫入成功但前端收不到回應等問題。

## 架構

```
瀏覽器（留在 vsbadge.vercel.app，不轉址）
  │  同源 POST /api/proxy   { troopId, action, data }   ← 只有識別碼，沒有 URL
  ▼
Vercel /api/proxy（api/proxy.js）
  │  1. 驗證 method=POST、action 白名單、payload 大小、token 存在
  │  2. 用 troopId 查伺服器端可信 Registry（api/_registry.js）
  │     - data/troops.json（Git 公開 Registry）
  │     - Vercel env：TROOP_{ID}_BACKEND / TROOP_{ID}_APIKEY（優先）
  │  3. 拒絕：未知旅團 / 非 HTTPS GAS /exec URL（防 SSRF、Open Proxy）
  │  4. 伺服器端注入 apikey（如有），redirect:'follow' 轉發到旅團 GAS
  ▼
旅團自己的 Google Apps Script /exec  →  Google Sheet
```

## 多旅團支援

- Proxy **不寫死任何單一 GAS URL**：完全按 troopId 從 Registry 動態解析
- 加新旅團流程不變：管理員把旅團 GAS URL 加入 `data/troops.json`，或設
  `TROOP_{ID}_BACKEND` / `TROOP_{ID}_APIKEY` 環境變數 → Redeploy 即生效
- `api/troops.js` 只向前端回傳 `{id: {name}}`，GAS URL 與 API Key 不再離開伺服器

## 安全規則（Proxy 強制執行）

| 規則 | 行為 |
|---|---|
| HTTP method | 只接受 POST，其他一律 405 |
| action | 白名單（對照 Code.gs doGet/doPost），其他 400 |
| token | 受保護 action 必須附 token 字串（真偽仍由 GAS 驗證）；無 → 401 |
| troopId | 格式 `^[0-9A-Za-z_-]{1,32}$`；未登記 → 404 |
| 上游 URL | 只接受 `https://script.google.com/macros/s/.../exec`（拒絕 /dev 及其他 host） |
| 前端 URL 注入 | `data` 內任何 backend/url 欄位一律忽略，目的地只由 Registry 決定 |
| 逾時 | 預設 45s（`VSBADGE_PROXY_TIMEOUT_MS` 可調，上限 55s），逾時 → 504 |
| 上游錯誤 | 非 JSON / HTTP 錯誤 → 502 友善訊息；業務錯誤（success:false）照原樣回傳 |
| Cache | 所有回應 `Cache-Control: no-store` |
| Log | 只記 troopId/action/status/耗時；**永不記** token、密碼、apikey、payload |

## 前端約定

- 統一使用 `apiRequest(action, data)`（index.html 內），**禁止**各自 `fetch(GAS_URL)`
- 寫入操作必須 `await` 真實回應：成功才顯示「已儲存」；失敗顯示錯誤並保留待寫入清單
- 禁止 `.catch(() => {})` 靜默錯誤；optimistic UI 失敗必須 rollback
- session（localStorage）只存 `{troopId, troopName, token, user, savedAt}`

## Portal / 主系統整合變更

- **v3.0 起 URL 參數 `backend` / `apikey` 一律被忽略**（防止任意後端注入）
- 主系統卡片只需帶 `u=<troopId>`（及選用的 `from=portal&role&ymis&embed=1` 等身份參數）
- 旅團必須先在 vsbadge Registry 登記（提交 URL+Key 給 vsbadge 管理員的流程不變）
- 領袖經 Portal 進入後若要**寫入**，旅團的 API Key 須登記在 Registry
  （`troops.json` 的 `apikey` 欄位或 `TROOP_{ID}_APIKEY` env），由 Proxy 伺服器端注入。
  帳號密碼登入軌道（軌道 A）不需要 API Key。

## 不需改動 GAS

- `Code.gs` doGet/doPost、request schema、Sheet 結構、現有部署 URL、API Key、帳號及 token 全部不變
- **不需要重新部署任何旅團的 Apps Script**

## 環境變數總覽

| 變數 | 必填 | 用途 |
|---|---|---|
| `TROOP_{ID}_BACKEND` | 如旅團不在 troops.json | 旅團 GAS /exec URL（env 優先於 troops.json） |
| `TROOP_{ID}_APIKEY` | 可選 | 旅團 API Key；Proxy 伺服器端注入（防爬蟲第一層 + apikey 模式寫入） |
| `SCOUT_ADMIN_API` | 可選 | 新旅團接入申請的中央收件匣 GAS URL（預設內建值） |
| `VSBADGE_PROXY_TIMEOUT_MS` | 可選 | 上游逾時（預設 45000，範圍 1000–55000） |

> ⚠️ `VSBADGE_PROXY_TEST=1` 只供本機測試使用（允許 mock http://127.0.0.1 上游），**切勿設在 Vercel**。

## 測試

```bash
npm test     # 或 node tests/run-e2e.mjs
```

e2e 測試會啟動兩個 mock GAS 旅團（含 GAS 式 302 redirect），掛載真實
`api/proxy.js` + `api/troops.js`，驗證：登入/錯密碼、讀寫、重讀落盤、
未知旅團 404、SSRF 防護、上游 HTML/500/逾時失敗、多旅團隔離、token 不串用、
HTTP 規格、以及從 index.html 抽出的真實 `apiRequest()` 錯誤路徑。
