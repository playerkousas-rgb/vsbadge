# PBKDF2 登入逾時事故修復（GS v9.5）— 自檢報告、實測方法、部署步驟

> **維運文件，只放 Git 俾管理員睇**：`operations/` 已在 `.vercelignore`，唔會部署到公開網站。
> 對應事故：scoutbadge 2026-11-04「登入回『後端服務連線逾時』」。vsbadge 審計結論：**踩線級別——未爆，但隨時爆**。

---

## 1. 根因

Apps Script 冇原生 PBKDF2。`pbkdf2HmacSha256_` 每一輪迭代都係一次獨立
`Utilities.computeHmacSha256Signature()` 服務呼叫（實測約 0.1ms／次）：

- `PBKDF2_ITERATIONS = 120000` → 每次登入 **12–20 秒**（視乎 GAS 負載／冷啟動）。
- 同源 Proxy 上游 timeout 45,000ms（`api/proxy.js`，`VSBADGE_PROXY_TIMEOUT_MS` 可調）。
  12–20s 「通常」過得，但 GAS 冷啟動／負載高／Google 慢嗰日就會 504 →
  用戶見到「有時入得、有時逾時」。
- 舊驗證下限 `iter < 100000` 拒絕 → **唔可以單純調低迭代**，否則舊帳號全部登入唔到。
- dummy 雜湊只 cache 喺單次執行變數（GAS 每次請求都係新執行）→ 每個「帳號不存在」
  請求都重算一次完整 KDF，燒配額。
- 鎖定期間直接 return、唔做 dummy KDF → 時序上分得出「帳號存在但被鎖」同
  「帳號不存在」，係輕微反枚舉漏洞。

## 2. 修法（與 scoutbadge GS 6.4.0 一致）

| 項目 | 修前 | 修後 |
|---|---|---|
| 新雜湊迭代 | `pbkdf2$120000$…` | `pbkdf2$10000$…`（`PBKDF2_ITERATIONS = 10000`） |
| 驗證接受範圍 | 100,000–1,000,000 | **1,000–2,000,000**；一律用雜湊自帶 iter |
| 舊雜湊 | 只升級 64-hex | 64-hex **同** `pbkdf2$120000$` 登入成功一次後透明改寫做 10,000（密碼不變、毋須重設） |
| dummy 雜湊 | 單次執行變數 | `CacheService` 重用 **6 小時**（key 帶迭代次數）；命中→驗證 1 次，未命中→生成 1 次（唔會雙倍） |
| 鎖定路徑 | 提早 return（0 次 KDF） | 照做 1 次 dummy KDF 先回中性訊息 |
| Proxy 日誌 | 冇 | `slow_password_kdf`（慢過 `VSBADGE_SLOW_KDF_MS`，預設 8000ms；逾時都記，只含 metadata） |
| 前端 | 45s timeout（同 proxy 打架） | 58s timeout＋未更新 GS 旅團顯示「**此版本登入會逾時**」提示＋ecStatus 版本核對 |
| 登入回應 | 冇版本欄 | 成功時增補 `gsVersion`（失敗回應維持完全一致） |

**冇改任何工作表欄名／結構、冇刪列、冇要求用戶重設密碼或清資料、冇回退單次 SHA-256。**

## 3. 各路徑成本（連 Proxy timeout 一齊睇）

Timeout 鏈（修後）：**前端 58s ＞ Proxy 上游 45s（預設；上限 55s）＜ Vercel maxDuration 60s**。
GAS 慢到爆時，瀏覽器會先收到 Proxy 嘅 504 JSON（「旅團後端回應逾時…」），唔會兩邊同時 abort。
修前前端同 Proxy 都係 45s，係互相打架嘅來源之一。

| # | 路徑 | 修前成本 | 修後成本 | KDF 次數（修後） |
|---|---|---|---|---|
| ① | `pbkdf2$120000$` 帳號登入（**首次**） | 1×120k ≈ 12–20s | 1×120k 驗證＋1×10k 透明改寫 ≈ 13–22s（**一次性**） | 2（1 驗證＋1 升級） |
| ① | 升級後／新帳號登入 | — | 1×10k ≈ **1–2s** | **1** |
| ② | 舊 64-hex 帳號首次登入 | 1×SHA-256＋1×120k 升級 ≈ 12–20s | 1×SHA-256＋1×10k 升級 ≈ **1–2s** | **1**（升級） |
| ③ | 帳號不存在 | 每次 1×120k dummy ≈ 12–20s | 1×10k ≈ **1–2s**；每 6 小時一次生成 | **1** |
| ④ | 鎖定中 | **0 次 KDF**（即时回，時序洩漏） | 1×10k dummy ≈ **1–2s** | **1** |
| ⑤ | `changePassword` | 1×120k 驗證＋1×120k 新雜湊 ≈ 24–40s | 1×10k＋1×10k ≈ **2–4s**（舊 hash 帳號：1×舊 iter＋1×10k） | 2（改密必然） |

> 「每次登入只做 1 次 KDF」嘅精確含義：**每條路徑恰好 1 次「驗證」KDF**（唔會雙重驗證、
> 唔會 0 次提早 return）。舊雜湊首次成功登入嘅透明改寫係一次性額外 KDF（用較低嘅新次數），
> 之後登入就只剩驗證嗰一次。`tests/login-kdf.test.mjs` 用 KDF 呼叫計數逐條路徑斷言。
>
> 過渡期注意：未升級嘅 120k 帳號「錯密碼」仍然要 12–20s，同「帳號不存在」（1–2s）之間
> 仍有殘留時序差——呢個係「驗證用雜湊自帶 iter」嘅必然代價，會隨帳號逐次登入升級而消失。
> 訊息層面所有失敗路徑維持完全一致；鎖定路徑嘅 0-KDF 洩漏已封。

## 4. 實測方法（Apps Script 原路徑，唔係 Node 估算）

**點解要喺旅團自己嘅 GAS 量**：GAS 每呼叫成本隨部署／負載浮動，中央估算冇意義。
今次更新已內置 `benchmarkPasswordKdf()`，用真正嘅 `Utilities.computeHmacSha256Signature`
路徑量度 120,000 vs 10,000（及目前常數）嘅真實毫秒數。

**步驟（每個旅團後端，約 30 秒）**：

1. Apps Script 編輯器 → 函式揀 `benchmarkPasswordKdf` → 執行（首次要授權）。
   或 Sheet 選單「🔗 旅系統 → ⏱️ 密碼 KDF 速度測試（實測毫秒）」。
2. 「檢視 → 執行紀錄（Logger）」會有一行 `benchmarkPasswordKdf {...}` JSON，
   包含每個迭代次數嘅 `avgMs`／`bestMs`／`avgSeconds`。
3. 預設每個次數跑 1 次（避免燒配額）；想要穩定啲可以 `benchmarkPasswordKdf(3)`（上限 3）。
4. 將結果貼入下面表格同 PR。

**修前／修後實測紀錄**（⚠️ 本 sandbox 無法連線 Google／冇 GAS 部署憑證，
以下「修後」數字必須由管理員喺旅團 GAS 執行 benchmark 後填寫；唔好用 Node 數字冒充）：

| 旅團 | 量度日期 | 120,000 迭代（修前每次登入） | 10,000 迭代（修後每次登入） | 備註 |
|---|---|---|---|---|
| （示例格式） | 2026-11-__ | ____ ms（≈ __ s） | ____ ms（≈ __ s） | 冷啟動／暖機 |
|  |  |  |  |  |

參考基準：scoutbadge 事故同本次審計觀察到嘅 120k 路徑係 **12–20s**；
10k 路徑預期約 **1–2s**（以 benchmark 實測為準）。

**事後追查**：Vercel Runtime Logs 搜 `slow_password_kdf` —
`{result:'slow_password_kdf', troopId, action, ms, gsVersion}` 即係該旅團仲未更新 GS
（或 GAS 異常慢）；逾時個案會多記 `timeout:true`。日誌永不記錄密碼／token／apikey。

## 5. 部署步驟（每個旅團）

1. **備份**（可選但建議）：Sheet「檔案 → 建立副本」。
2. 下載最新 `apps-script/Code.gs`（首頁部署頁或公告嘅下載掣，`?gs=v9.5`），
   取代旅團 Apps Script 現有內容並儲存。
3. 執行一次 `initializeSheets()`（選單「🔧 初始化／更新」）——只做增補：
   補建缺失工作表／表頭、記錄初始化版本；**唔會刪改任何既有資料、唔會換 API Key**。
4. （建議）執行 `benchmarkPasswordKdf()` 記低實測毫秒。
5. 「部署 → 管理部署 → 編輯 → 新版本 → 部署」，**沿用現有網頁應用程式網址及 API Key**。
6. 返前端揀該旅團 → 公告按「重新檢查」，直到綠色「✅ 已核對」。
7. 驗證：用一個舊帳號登入（應該 1–2s 內完成；首次可能 13–22s 因為透明升級），
   再登入一次確認快咗；用錯密碼／唔存在帳號確認訊息一致。
8. Vercel 侧：`api/proxy.js` 嘅改動跟正常 Vercel 部署生效，毋須改 env。
   可選：`VSBADGE_SLOW_KDF_MS`（預設 8000；設 0 記錄每次密碼操作）。

**回退警告**：唔好回退去舊 Code.gs——舊版驗證下限 100,000 會拒絕已升級做 10,000 迭代
嘅雜湊，屆時已升級帳號要由領袖重設密碼先入得。只向前升級。

## 6. 跨系統（VSBOOK）一併修正

- `handleReviewRequest` 批准 `OT-*` → 寫「其他獎章」（`handleSaveOtherBadge` Upsert），
  `handleLoad.otherBadges` / 前端 `resolveOtherBadgeRecord` 即時可見；
  其餘項目經 `handleSave` 做 `(ymis,itemId)` Upsert，唔再重覆列。
- `handleRequestComplete` 冪等去重：同一 `(requesterYmis,itemId)` 已有 `pending` 列 →
  更新第 6 欄（申請日期）／第 7 欄（證明），回傳既有 `request_id`；
  支援批次 `body.items[]`（向下相容單筆 `body.itemId`），全部寫入 `pending`；鎖內讀改寫防併發。
- `GET /api/troops` 維持 `{ troops: { [id]: { name, en } } }`。
- `POST /api/proxy` **冇** Origin／Sec-Fetch-Site 檢查（刻意）：VSBOOK 後端 Node fetch
  轉發 `login`／`logout`／`load`／`requestComplete` 照常受理。
  `tests/request-review.test.mjs` 有守護測試。

## 7. 回歸測試

- `tests/login-kdf.test.mjs`（7 項）：四條路徑 KDF 計數、dummy cache 6h 重用、
  透明升級、changePassword 成本、benchmark 結構。**迭代次數全部由 GS 常數推導，唔硬編碼。**
- `tests/request-review.test.mjs`（8 項）：去重／批次／OT-* 路由／Upsert／欄名不變／
  VSBOOK 伺服器請求相容／troops 契约／slow_password_kdf 日誌。
- 既有 `tests/auth-hardening.test.mjs`、`tests/password_reset.test.mjs` 等已改為由常數推導迭代次數。
- 全套：`npm run lint && npm run check && npm test && npm run build && npm run test:build`。
