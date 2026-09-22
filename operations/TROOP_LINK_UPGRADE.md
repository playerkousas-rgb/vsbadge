# 旅系統升級（旅 > 團 > 進度）— v9.0

> **維運文件，只放 Git 給你自己看**：`operations/` 已在 `.vercelignore`，`scripts/build.mjs` 的 static 白名單亦不包含，所以唔會部署到公開網站，團員／領袖睇唔到。
>
> **版號只留本 MD**：`apps-script/Code.gs` 及 `assets/batch-onboard/Code.gs` 內所有 `// vX.X` 註解（連 `initializeSheets()` 彈窗的版號字樣）已全部拆走；`tests/troop_link.test.mjs` 有守護測試，GS 再出現版號字樣就會 fail。
>
> 是次改動範圍：**只改 `apps-script/Code.gs`、`assets/batch-onboard/Code.gs`（拆註解）、`package.json`（加測試）、新增本 MD 及 `tests/troop_link.test.mjs`**。前端 `index.html` 一字未改，`api/` 一字未改。

---

## 0. 一句話

同一份 `Code.gs` 部署喺每一層（旅／團（支部）／進度）。**上游登記下游嘅 URL + SHEET KEY 就可以讀寫下游**，所以進咗上游就等於進咗下游；為咗同步安全，開咗上游之後，**用戶可自行決定幾時閂下游直接入口**（`ALLOW_LOCAL_LOGIN`），閂口後下游只收 `sig`。
>
> **接入完全自願**：唔登記下游、或者登記咗但唔閂口，現有旅團一切照舊（`ALLOW_LOCAL_LOGIN` 未設定＝開啟，行為零變化，測試 1 守呢條）。

---

## 1. 變數 ABCD（四個都唔寫入 SHEET）

| 代號 | 名稱 | 邊個產生 | 放喺邊 | 用途 |
|---|---|---|---|---|
| **A** | `SUPER_KEY` | 現有（隱藏） | Vercel env | 超管登入／票據加密。**與旅系統無關，是次不改動、不在任何選單顯示** |
| **B** | `TROOP_(id)_BACKEND` | GS 部署後抄（`ScriptApp.getService().getUrl()`） | Vercel env；上游則存 `DOWNSTREAM_<id>_URL` | 主系統 proxy／上游打去邊個 GAS |
| **C** | `TROOP_(id)_NAME` | 你自填 | Vercel env | 前端旅團顯示名（純文字） |
| **D** | `TROOP_(id)_APIKEY` | GS 生成（`initializeSheets()` 或 `showApiKey()`，存 Script Properties `API_KEY`） | Vercel env；上游則存 `DOWNSTREAM_<id>_KEY` | API key，同時係 `sig` 嘅根密鑰（見第 3 節） |

- **一次過抄 B + D**：Sheet 選單「**🔗 旅系統 → 🔑 顯示 BACKEND／APIKEY（交 ADMIN）**」。未部署做網頁應用程式時 B 會提示先部署。
- **交 ADMIN**：經收件匣——首頁「📋 新旅團部署」表單（旅團編號 / 名稱 / Apps Script URL / API Key）→ `submitRegistration` → `/api/proxy` 轉發去伺服器端固定的中央管理員收件匣。把 **B、C、D** 一齊交；ADMIN 登記後 Redeploy。
- **四個都唔寫入任何工作表**：B/D 只存 Script Properties（同 Vercel env），C 由你填，A 隱藏。`tests/troop_link.test.mjs` 會掃晒所有工作表，確保冇後端 URL、冇 API KEY、冇 `ALLOW_LOCAL_LOGIN` 字樣。
- 換 D（撤銷舊 key）：下游 Script Properties 刪除 `API_KEY` → 執行 `showApiKey()` 生成新 key → 重新交 ADMIN 改 env，並喺上游重新登記下游。

---

## 2. 上下游接入

```
        旅 GAS ──── sig ────▶ 團（支部）GAS ──── sig ────▶ 進度 GAS
          │                        │                          │
   登記下游 B + D            登記下游 B + D            ALLOW_LOCAL_LOGIN
   DOWNSTREAM_<id>_URL      DOWNSTREAM_<id>_URL        （直接入口掣）
   DOWNSTREAM_<id>_KEY      DOWNSTREAM_<id>_KEY
```

- **每層都係同一份 `Code.gs`**：一個節點可以同時係上游（對住自己嘅下游）同下游（對住自己嘅上游）。
- **上游 Script Properties**：`DOWNSTREAM_<id>_URL`、`DOWNSTREAM_<id>_KEY`、`DOWNSTREAM_<id>_NAME`、`DOWNSTREAM_<id>_AT`。`<id>` 由你改（例：`progress`、`vs0082`、`branch-a`），只可用英文／數字／底線／連字號，最長 32 字元。旅對住幾個團就登記幾條。
- **下游 Script Properties**：`ALLOW_LOCAL_LOGIN`（未設定＝開啟，現有旅團零影響）。
- **掣在上游**：上游選單「🚪 下游直接入口 → 🔒 閂口（只收 sig）／🔓 開啟」，經 `sig` 打下游 `setLocalLogin`。下游自己都有同一個掣（「🚪 本機直接入口」），方便未接上游時獨立運作。
- **接入步驟**：

| 步驟 | 做乜 | 邊度做 |
|---|---|---|
| 1 | 部署 GS，抄 B 的 URL，生成 D | 每層 Sheet → Apps Script → 部署（執行身分「我」、存取權「任何人」）→ 選單「🔗 旅系統 → 🔑 顯示 BACKEND／APIKEY」 |
| 2 | 填 C，連 B/D 經收件匣交 ADMIN | 首頁「📋 新旅團部署」表單（前端冇改過，照舊用） |
| 3 | 每團補一張支部 SHEET，與現有進度 SHEET 成對 | 新 Sheet → 貼同一份 `Code.gs` → `initializeSheets()` → 部署 → 抄 B/D |
| 4 | 上游登記下游，再測連線 | 上游選單「➕ 登記下游（URL + SHEET KEY）」→「📡 測試下游連線（sig）」 |
| 5 | 搬舊數（第 6 節） | 舊進度「📤 匯出 JSON（含 hash）」→ 新支部「📥 匯入 JSON」 |
| 6 | 核對無誤後閂下游直接入口 | 上游選單「🚪 下游直接入口 → 🔒 閂口」 |
| 7 | 之後開戶一律在上游 | 上游選單「👤 為下游開戶（揀團）」 |

- 每層升級都要： Apps Script → 用新 `Code.gs` 全檔覆蓋 → 部署 → **管理部署 → ✏️ 編輯 → 版本選「新版本」**（`/exec` URL 唔變，Registry 唔使改）。
- **只有全新嘅支部 SHEET 先執行 `initializeSheets()`**；現有進度 SHEET 唔好重跑（唔改 schema、唔清資料）。

---

## 3. `sig` 點計（GAS → GAS，唔經 Vercel、不設回調）

```
根密鑰    = 該節點的 SHEET KEY（D）
sigKey    = hex( HMAC-SHA256( message = "vsbadge-troop-sig-v1", key = D ) )
canonical = action + "\n" + ts(毫秒) + "\n" + nonce + "\n" + hex(SHA-256(rawBody))
sig       = hex( HMAC-SHA256( canonical, sigKey ) )
```

- **上游簽出站用「下游的 D」**（登記咗嗰條）；**下游驗入站用「自己的 D」**。密鑰以用途字串分隔推導，推導結果唔落地、唔儲存。
- **兩組 sig 一齊送**（GAS 302 轉址有機會遺失 query）：
  - query：`?sig=…&sts=…&snonce=…`，digest 綁完整原始 body；
  - body：`{ …, sig, sig_ts, sig_nonce }`，digest 綁「去掉三個 sig 欄位後的 body」。
  - 下游先驗 query，驗唔到再驗 body。**兩組 nonce 一次過消耗**，堵死「第一次只驗到其中一組、重放時用另一組」嘅缺口。
- **時窗** ±5 分鐘（未來時間戳都拒）；**nonce 一次過**（`CacheService` 存 10 分鐘）；**body 上限** 900 KB；`sig` 必須 64 位 hex；比较用「兩邊先各自 SHA-256 再比對」避免逐字元短路。
- 登記下游時 **URL 必須係正式 GAS `/exec`**（`https://script.google.com/macros/s/…/exec`），其他一律拒。
- **不設回調**：只有上游主動打下游；下游永遠唔會回打上游，亦冇任何 callback endpoint。

### 閂口後嘅行為對照

| 請求 | `ALLOW_LOCAL_LOGIN` 未設定／`true` | `=false`（閂口） |
|---|---|---|
| 前端直接 `login`／`apply` | 照舊 | **拒**，回 `{success:false, upstream_only:true, error:"…只接受上游簽名（sig）請求…"}` |
| `GET ?action=load`／`getLoginMode` | 照舊 | **拒**（同一訊息） |
| 舊 Portal／apikey 直接 `save` | 照舊（兼容） | **拒**（apikey 唔再等於授權） |
| 用戶 token 操作 | 照舊 | **拒** |
| 上游 `sig` 請求 | **接受** | **接受** |

掣值：`1/true/yes/on/open`＝開啟；寫咗其他任何值（包括 `false/0/no/off` 或者串錯字）＝閂口（fail closed）。

### `sig` 可以做乜（action 白名單）

- **讀**：`load`、`getLoginMode`、`getLinkState`、`getMembers`、`getConfig`、`getAllUsers`、`getOtherBadges`、`getPendingRequests`、`getApplications`、`getLogRecords`、`getLogRequests`、`getAuditLog`
- **寫**：`save`、`saveOtherBadge`、`requestComplete`、`reviewRequest`、`addMember`、`addUser`、`bulkAddUsers`、`upsertUser`、`importUsers`、`resetPassword`、`updateUserProfile`、`setUserStatus`、`deleteUser`、`updateUserRole`、`updatePermissions`、`saveLogRecord`、`deleteLogRecord`、`reviewLogRequest`、`setLocalLogin`
- **永不接受（即使有 sig）**：`login`、`apply`、`logout`、`changePassword`、`updateConfig`、`requestLogRecord`、`cancelLogRequest`，以及白名單以外任何 action。
- 每筆簽名寫入都會喺下游「操作紀錄」留一行（操作者 `upstream`，詳情含 `on_behalf`），讀取唔留。

---

## 4. 開戶（閂口後）

**閂口後新戶在上游揀團開戶，經 `sig` 落下游寫。**

- 選單：上游「**👤 為下游開戶（揀團）**」→ 揀下游編號（即揀團）→ YMIS／姓名／Email／角色／臨時密碼 → 上游開戶 → 讀回 `password_hash` → `sig` 打下游 `upsertUser`。
- 上下游**同一個 hash**，所以同一個臨時密碼兩邊都啱用；首次登入仍強制改密碼。
- 程式介面（編輯器可直接跑）：`createAccountForDownstream(downstreamId, rawUser, manager)`。
- 上游開戶成功但下游寫入失敗時，會明確回「上游已開戶，但下游寫入失敗：…」，唔會靜靜地兩邊唔一致；重推用 `upsertUser`（冪等）。

---

## 5. 吐 JSON（搬舊數）

**場景**：舊進度有數，新支部空。

1. **舊進度 Sheet**：選單「**📤 匯出 JSON（含 hash）**」
   - 寫成 Drive 檔 `vsbadge-users-<yyyyMMdd-HHmmss>.json`（建立後即設為**私人**：`Access.PRIVATE` + `Permission.NONE`），彈窗給連結及檔案 ID；
   - Drive 寫入失敗時，完整 JSON 會寫入「檢視 → 執行紀錄（Logger）」作後備；
   - **只寫 Drive／Logger，绝不寫入任何工作表**（hash 唔會出現在 Sheet）；「操作紀錄」只記筆數同檔案 ID。
   - 格式：

     ```json
     { "format": "vsbadge-users-export", "schema": 1, "exported_at": "…", "node": "…", "count": 3,
       "users": [ { "ymis": "…", "name": "…", "email": "…", "role": "…", "branch": "…", "can_tick": false,
                    "allowed_badges": "…", "status": "active", "force_change_password": false,
                    "password_hash": "<64 位 SHA-256 hex>", "auth_by": "…", "created_at": "…", "last_login": "…" } ] }
     ```

2. **新支部 Sheet**：選單「**📥 匯入 JSON（upsertUser 直插 hash）**」→ 貼 Drive 連結或檔案 ID → **逐個 `upsertUser` 直插 hash**
   - 只收 64 位 hex `password_hash`；**帶明文 `password` 一律拒**（唔會喺搬數途中重設密碼）；
   - 同 YMIS（或同 Email 認回同一身份）→ **更新**；冇帶 hash → **保留原密碼**；
   - 新帳戶**必須**帶 hash；`force_change_password` 跟隨匯出值（搬舊數唔會逼人即時改密碼）；
   - YMIS 仍限 10 位數字或 `L` 編號，Email 格式、唯一身份（`identifierConflict`）、保留帳號照舊檢查；
   - **冪等**：重匯唔會開重複列（測試有覆蓋）；一次最多 2000 筆；
   - 完成後彈窗顯示「新增 X、更新 Y、失敗 Z」及首 8 筆失敗原因。
   - 上游亦可用 sig 推：`callDownstream(id, 'importUsers', { users: [...] })`（或 `{ json: "…" }`／`{ drive_file_id: "…" }`）。

3. **匯完可閂下游直接入口**：核對筆數 → 上游「🚪 下游直接入口 → 🔒 閂口（只收 sig）」。閂口前會有確認彈窗，提醒先完成匯入及連線測試。

4. **匯入後刪除 Drive 匯出檔**（含 hash）。

---

## 6. 唔做（照 spec）

- ❌ 不在 SHEET 寫 ABCD（有測試守）
- ❌ 不改 A（`SUPER_KEY` 相關邏輯、`api/_super.js`、`api/super.js`、`api/proxy.js` 的超管路径全部原封不動）
- ❌ 不設回調（冇 callback endpoint、下游唔會回打上游）
- ❌ 不改前端 `index.html`、不改 `api/`（`sig` 係 GAS→GAS，唔經 Vercel proxy，所以 proxy 白名單唔使加）
- ❌ 不改現有工作表 schema、不清資料、現有部署唔使重跑 `initializeSheets()`

---

## 7. 清理（版號）

- `apps-script/Code.gs`：檔案頭版本 changelog 註解全拆，改成功能說明；`// v8.1：…`／`// v8.2：…`／`// v8.4：…` 等前綴全部拆走（保留說明文字）；`initializeSheets()` 彈窗由「✅ v8.8 初始化完成！」改為「✅ 初始化完成！」並加一行旅系統提示。
- `assets/batch-onboard/Code.gs`：兩處 `// v8.3：…` 前綴拆走。
- 全檔再冇 `vX.X` 字樣（`grep -n "v[0-9]\+\.[0-9]" apps-script/Code.gs assets/batch-onboard/Code.gs` 應冇結果）；版號只留本 MD。

---

## 8. 驗收

**本次量測（如實報告，同 HEAD 對比）**

| 項目 | HEAD（改前） | 本版（改後） | 差 |
|---|---|---|---|
| `apps-script/Code.gs` | 79,509 bytes / 1,305 行 | 118,805 bytes / 1,931 行 | +39,296 bytes（旅系統新程式＋註解） |
| `assets/batch-onboard/Code.gs` | 10,734 bytes | 10,720 bytes | −14 bytes（只拆版號註解） |
| `npm run build` 輸出 | 768,392 bytes | 807,674 bytes | +39,282 bytes |
| `package.json` 依賴 | 0 dependencies / 0 devDependencies | 一樣 | 冇新增 |

- 增量全部來自公開下載嘅 `Code.gs`（`static/apps-script/Code.gs`）；**冇新增工作表、冇新增 runtime 依賴、冇新增圖片**。
- `operations/`（本 MD）同 `tests/`（新測試）都唔會入 build output：`.vercelignore` 已排除，`scripts/build.mjs` 白名單亦冇包含（已 `ls .vercel/output/static/` 核對）。
- 前端 `index.html` 及 `api/` 四個 function 一字未改，所以 function bundle 大細不變。

```bash
npm run check     # 語法／資源／公開文件／部署守護（零依賴）
npm run lint      # 同上
npm test          # ymis 解析 + security + troop_link（新）+ e2e（153 項）
npm run test:link # 只跑旅系統測試
npm run build     # Vercel Build Output API（輸出 byte 數會印出來）
npm run test:build
```

`tests/troop_link.test.mjs`（10 項，用 in-memory GAS stub 載入**真實** `Code.gs`，起上下游兩個節點經假網路對打）：

1. 直接入口掣未設定時，現有旅團行為完全不變（登入／load／getAllUsers 照舊，掣唔會被自動寫入）
2. 閂口後：直接 `login`／`apply`／`GET load`／apikey `save` 全部被拒
3. 上游登記下游 SHEET KEY 後，`sig` 可讀可寫下游（`save`／`load`），並可由上游閂下游掣；非 GAS URL、太短 KEY 被拒
4. `sig` 防護：錯 key、竄改 body、過期／未來時間戳、重放 nonce、混合傳送重放、白名單外 `login` — 全部被拒；query 及 body 兩種傳送都通過
5. ABCD 只存 Script Properties，上下游所有工作表都掃唔到 URL／KEY／掣名
6. 上游揀團開戶 → 下游同一 `password_hash`；重複推送係更新唔係開新列；冇帶 hash 時保留原密碼
7. 匯出含 hash（Drive 私人檔）→ 匯入 `upsertUser` 後舊密碼直接可登入；重匯冪等；明文密碼／假 hash／壞 JSON／缺 YMIS 全部被拒
8. 上游以 `sig` 批量 `importUsers` + `getAllUsers`（回應唔會洩漏 hash）
9. 上游傳來的標籤不可變成工作表算式（`auth_by`／操作紀錄消毒）
10. GS 內冇版號註解

> 本地測試唔能代替正式 GAS 部署驗收：`sig` 經真實 302 轉址、Drive 權限、Script Properties 配額、`onOpen` 選單授權，都要喺測試旅團真機跑一次先算數。

---

## 9. 安全備註

- **交唔交 D、閂唔閂口，全部係旅團自己嘅決定，冇任何強制**：旅 > 團 > 進度 三層都係同一個旅團自己嘅節點，所以「上游拿到下游完整控制權」本質上係佢自己旅團內部嘅事——**佢唔想就可以唔交**。唔交／唔登記下游，或者登記咗但唔閂口，現有運作完全唔受影響。
- **決定交嘅話就要當 D 係完整控制權**：D 一經登記到上游，上游對該節點嘅權限比舊 apikey（只可寫進度）更闊，連帳戶管理都可以。所以 D 只放 Vercel env 同上游 Script Properties，唔入 Sheet、唔入 Git、唔入截圖、唔入聊天。
- 閂口後，**舊嘅 apikey 直寫路徑一併失效**，只剩 `sig`；要撤銷上游存取，就換 D（第 1 節）或移除上游登記。
- 閂口係可逆：下游選單「🔓 開啟（容許本地登入）」，或上游以 `sig` 打 `setLocalLogin(allow=true)`。
- 匯出檔含密碼 hash：Drive 檔已設私人，匯入後即刪；唔好用共享資料夾或電郵明文傳送。
- 上游登記嘅下游 URL 只接受正式 `/exec`；`sig` 請求一律 POST，唔接受 GET 帶 sig。
- `sig` 唔係加密，只係完整性＋來源驗證；payload 內容仍係明文 JSON（GAS HTTPS 傳輸）。所以**唔好用 `sig` 送明文密碼**——搬數只送 hash，開戶下游鏡像只送 hash。
- 上游傳來的操作者標籤（`on_behalf`／`on_behalf_name`）會先消毒：`auth_by` 只留 `0-9A-Za-z_.@-`，寫入工作表的文字一律經 `safeSheetText`，防止 `=`／`+` 開頭嘅儲存格算式注入（測試有覆蓋）。

---

## 10. 檔案對照

| 檔案 | 是次改動 |
|---|---|
| `apps-script/Code.gs` | 新增「旅系統：上下游接駁」及「旅系統：Sheet 選單」兩節（`sig`、掣、下游登記、`callDownstream`、`createAccountForDownstream`、`exportUsersJson`、`upsertUser`、`importUsersFromText/Drive`、`handleSignedRequest`、`onOpen` 選單）；`doGet`／`doPost` 加掣及 `sig` 路由；拆走全部版號註解 |
| `assets/batch-onboard/Code.gs` | 只拆兩處版號註解 |
| `tests/troop_link.test.mjs` | 新增（10 項守護測試） |
| `package.json` | `test` 加入旅系統測試；新增 `test:link` |
| `operations/TROOP_LINK_UPGRADE.md` | 本檔（新增，只留 Git，不部署） |
| `index.html`、`api/*`、`docs/*`、`README.md`、`DEPLOY_GUIDE_FOR_TROOPS.md` | **未改動** |
