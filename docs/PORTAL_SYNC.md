# 🔄 Portal 同步紀錄（vsbadge ↔ vs_portal）

> **規則（由 2026-11-20 起生效）：** Portal（`playerkousas-rgb/vs_portal`）已進入**試作／接入測試**階段，
> 所以 vsbadge **每次改動之前**要先同 portal 同步一次（見 §1），改完再更新本文件。
>
> **本次（2026-11-20）只做同步：冇改 `/api/portal`、冇改 action／env／role 名、冇改 Sheet 結構、
> 冇部署。** 下面嘅行為描述係按現行程式碼＋本機實測寫出嚟，唔係新改動。

---

## 1. 每次 vsbadge 更新前嘅同步步驟

1. 拉 `vs_portal` 最新 `main`，記低 commit 同 `assets/js/lib/version.js` 嘅 `APP_VERSION`。
2. 對 backend hash：`sha256sum apps-script/Code.gs`，同 portal `docs/BACKEND_SYNC.md` 記錄嘅
   BADGE baseline hash 比對；唔同就即係「後端已漂移」，要逐項對 §4 合約。
   改過 `apps-script/Code.gs` 就要通知 portal 更新 vendored baseline（hash＋commit），
   否則兩個前端會用唔同版本嘅後端 source。
3. 逐項核對 §4（已一致）同 §5（未一致）兩張表；有新 action／新欄位／新 role 就兩邊一齊更新。
4. 更新本文件（§2 版本表、§4／§5、日期），喺 PR 描述寫明「已同 portal 同步／邊幾項未同步」。
5. 把 §9 摘要交去 portal 側，由 portal 更新自己 `docs/BACKEND_SYNC.md`。
6. **未完成以上步驟，唔准改**：`/api/portal` 驗證次序、`/api/proxy` action 白名單、
   `PORTAL_DEFAULT_*`／`TROOP_*` env 名、GAS action 名、role 名、Sheet 分頁／欄位。

### 1.1 雙向對齊次序（同一個後端，唔係兩邊各做一份）

因為兩個前端共用同一個後端 source，所以規則係**對稱**嘅：

- 每次開工（兩邊都一樣）先睇對方最新 pin：vsbadge 睇 portal `docs/BACKEND_SYNC.md` 嘅 baseline hash，
  portal 睇本文件 §2 嘅 `Code.gs` hash。兩份文件嘅 hash 一唔一样，就係「未對齊」，先做同步再改嘢。
- 邊一方改咗 `apps-script/Code.gs`，就由**改嘅一方先**更新自己文件並出 PR；另一方其後 vendor／核對，
  然後更新自己文件。次序係「改 source 嘅先行，跟嘅一方後行」，唔會兩個同時盲改。
- 前端／文件嘅改動（唔掂後端 source、唔掂 action／env／role／Sheet）可以先行，但要喺 PR 寫明「無合約改動」。

> 只係改前端文字／樣式、或者加測試，唔影響以上合約，可以唔使等 portal 回覆，但 PR 仍要寫「無合約改動」。

---

## 2. 本次釘選版本（2026-11-20）

| | vsbadge（本 repo） | vs_portal |
|---|---|---|
| 分支／commit | `main` @ `1085b03`（PR #41 merge） | `main` @ `3203b52`（PR #15 merge） |
| 版本 | `package.json` 4.0.0／GS `VS_GS_VERSION = v9.6` | `APP_VERSION = v2.8.8` |
| 後端 | `apps-script/Code.gs` SHA-256 **`3a8f12ebef…0e057`**（2026-11-20 加入 `channel`，見 §10.6） | vendored 版本仍係舊 hash `63148a3209…c34a10`，**下次同步要重新 vendor** |
| 對接狀態 | 軌道 A（自己登入）＝已上線；軌道 B（`from=portal`）＝可測 | 完整版前端；接裸 v9.6 仍 fail closed |
| **0082 實際部署** | **`vs_portal` 的 `UnifiedCode.gs`（`v9.6-u1-test`，isolated test）**（2026-11-20 起，見 §10） | 同左 |

✅ **無漂移**：現時 `Code.gs` 嘅 SHA-256 同 portal `docs/BACKEND_SYNC.md` §3 記錄嘅
`63148a32095694a92a45d9fa14fc190b7fd8e35336080d2c48ad9adf61c34a10` 完全一樣。
（portal 嗰邊釘嘅 commit 係 PR #40 嘅 `87c76a9`；PR #41 只加 `test-artifacts/` 測試 bundle，
冇改 `apps-script/Code.gs`、`api/`、`index.html`，所以 hash 相同。）

⚠️ **repo 無漂移 ≠ 部署無漂移**：0082 嘅 live 後端由 2026-11-20 起已經換成 `UnifiedCode.gs`
（試作 channel），檔案 hash 同上面釘住嘅 v9.6 唔同。前端公告**分辨唔到**呢個分別，見 §10。

📌 **2026-11-20 後端已加 `channel`**（`getVsGsReleaseStatus()` 多回一個 `channel`，預設 `release`）。
所以 portal 嘅 vendored baseline hash 已經過期；下次同步（或任何一方重建 Unified）都要重新 vendor，
否則試作 build 仍然唔會回報頻道。喺重新 vendor 之前，用 §10.6a 嘅 Registry 宣告做過渡。

---

## 3. 架構共識（2026-11-20 兩邊文件一致）

```
Portal 前端 ──▶ portal 同源 /api/progress、/api/proxy ──┐
                                                       ├──▶ 同一旅團既有 BADGE GAS／Sheet／Users
BADGE 前端  ──▶ vsbadge 同源 /api/proxy ───────────────┘
```

- 一個旅團＝一個後端、一份 Sheet、一套 `Users`；**唔准**為 Portal 另建 Sheet／GAS／帳戶，亦唔准複製帳戶。
- Portal 係完整版前端；vsbadge 係輕量前端。兩個前端各自經自己嘅同源 proxy，互不依賴對方網站開機。
- 舊有「Portal 卡片深連結入 vsbadge」路線（§6）仍然存在，屬**可選**，並非兩個前端共用資料嘅唯一方法。

---

## 4. 已核實一致嘅合約（兩邊實作相同）

| 項目 | 內容 | 核實方式 |
|---|---|---|
| 後端原始碼 | `apps-script/Code.gs` hash 同上 | `sha256sum` |
| Registry env | `TROOP_<ID>_NAME／BACKEND／APIKEY`，API Key 只留伺服器端 | 兩邊 `_registry.js` |
| API Key 用途 | 只作 routing＋簽名根，唔等於用戶身份 | 兩邊文件／程式 |
| Sheet 分頁 | `Users`、`成員名單`、`進度追蹤`、`其他獎章`、`待批完成`、`活動履歷`、`待批履歷` | 兩邊 GAS 常數 |
| 簽名傳輸 | `linkSigKey = HMAC-SHA256(key=API_KEY, msg="vsbadge-troop-sig-v1")`；canonical = `action\nts\nnonce\nsha256(rawBody)`；nonce 32 hex；±5 分鐘；body ≤ 900,000 字元 | vsbadge `verifyLinkSig()`／portal `makeLinkSig()` |
| Progress 讀寫 action | `load`、`save`、`saveOtherBadge`、`reviewRequest`、`reviewLogRequest`（簽名 routes 兩邊都認） | vsbadge `handleSignedRequest()` |
| 角色名 | BADGE：`member`／`exec_committee`／`branch_leader`／`group_leader`／`admin`；Portal 內部：`member`／`exco`／`leader`／`chief`／`super` | portal CHANGELOG「身份階級對齊 BADGE」 |

⚠️ **角色名唔可以照抄過橋**：portal 嘅 `exco`／`leader`／`chief` 只屬 portal schema，
帶入 vsbadge 時必須用 BADGE 名（`exec_committee`／`branch_leader`／`group_leader`）。

---

## 5. 未一致：Portal 前端直接接裸 v9.6 會撞到嘅位（接入測試要知）

| Portal 會呼叫 | 裸 v9.6 實際回應 | 影響 |
|---|---|---|
| `authLogin` | 冇此 action → 落到 `Token 無效或過期` | Portal 登入失敗（只有錯誤訊息，冇帳戶資訊） |
| `authWhoAmI` | 同上 | `/api/progress` 每次請求都先驗 session → **fail closed**（`401 session_invalid`） |
| `authOpenAccounts`／`authChangePassword`／`authResetPassword`／`authDeleteAccount`／`authRestoreAccount` | 冇 handler | Portal 帳戶管理整組不可用 |
| `loadDb`／`saveDb`／`loadTables`／`saveTables`／`sync`… | 冇 handler | Portal 行政模組（會議／財務／物資／通告…）不可用 |
| `bulkReviewRequests`／`myProgress`／`myRequests`／`addRequest`／`hub*` | 冇 handler（簽名白名單亦冇） | 批次審批、團員入口 hub 不可用 |
| `getMembers`／`getAllUsers` 等 | 有，但要求有效 BADGE `token` | Portal 未換到 BADGE token 前用唔到 |

結論：**Portal ＞ 裸 v9.6 現時只可以 fail closed。** 要真正共用，就要一份正式、版本化嘅
BADGE 共用後端 adapter（`apps-script/UnifiedCode.gs` 只係 `isolated-test-only` 候選產物，
唔可以當已驗收或直接部署）。呢項係 portal 側主要待辦，vsbadge 側暫無需改動。

---

## 6. 由 Portal 卡片入 vsbadge（`?from=portal`）—— 裸 v9.6 實測行為

> ⚠️ 以下數字係**裸 v9.6**（即 `apps-script/Code.gs`）嘅行為。0082 換咗 `UnifiedCode.gs` 之後，
> `load` 會被 Unified router 攔截要求真 session，結果會變成 §10.3 嗰行「❌」——量度前先確認跑緊邊份 GS。

本機用 `tests/dev-with-mock.mjs`（mock GAS 行為同 `Code.gs` 對應分支一致）實測，
`PORTAL_DEFAULT_ORIGIN=http://127.0.0.1:3900`、`PORTAL_DEFAULT_ROLES=exec_committee,branch_leader,group_leader`：

| 測試 | 結果 |
|---|---|
| `GET /api/portal?u=0082&role=exec_committee&src=<hub>`（帶 hub Referer） | `200 {"ok":true,"role":"exec_committee","troop":"0082"}` |
| 同上但 Referer 係第二個網域 | `403 {"ok":false,"reason":"referer_mismatch","expected":"<hub>"}` |
| `role=admin`（唔在白名單） | `403 {"ok":false,"reason":"role_not_allowed","allowed":[…]}` |
| `POST /api/proxy` `action=load`，token = `portal-<ts>`（虛擬 token） | **成功**：回全團 `members`／`progress`，但**冇 `me`** |
| `action=save`，token = `portal-<ts>` | **成功**：`{"success":true,"processed":1}`，讀回見到已寫入 |
| `action=reviewRequest`／`requestComplete`／`getConfig`／用戶管理 | 失敗：`Token 無效或過期`／`未授權，請重新登入` |

即係經 portal 卡片入嚟嘅人：

- ✅ 睇得到全團進度、其他獎章、待批清單（`load` 本身唔驗 token，只係 `me` 需要 token）
- ✅ 可以**直接勾選／取消**（`save`、`saveOtherBadge` 走 API Key 分支）
- ❌ 唔可以審批、唔可以申報、唔可以用戶管理、唔可以改密碼（全部要真 token）

**安全含意（現行設計，非本次改動）：**

1. 真正授權＝「已登記 `portalOrigin`」＋「`role` 在 `portalRoles` 白名單」＋「proxy 伺服器端注入 API Key」。
   虛擬 token `portal-…` 只係前端 UI 標記，後端**唔會**當佢係身份。
2. 所以 `PORTAL_DEFAULT_ORIGIN` 一定要係你自己控制嘅 hub；`role` 由 hub 決定，vsbadge 唔會再核對「係邊個」。
3. **唔好**把平台保留嘅最高權限角色放入 `PORTAL_DEFAULT_ROLES`（`TICK_ROLES` 內有呢個角色，
   一經白名單放行，卡片就可以帶住呢個角色入嚟）；角色名唔喺公開文件列出。
4. 呢啲行為一旦要收緊（例如要求真 session 才可 `save`），屬**合約改動**，要先同步 portal 並講清楚測試影響。

> 上述對 `Code.gs` 嘅判斷已按原始碼核對：`doGet` 將 `?action=load` 交 `handleLoad(token)`，
> token 只用於 `me`；`doPost` 嘅 `save`／`saveOtherBadge` 明寫「進度寫入可用有效 token 或 API key」，
> 其餘 action 一律 `validateToken()`。**未在真 Apps Script／真 Sheet 上跑過**，接入測試時請以真環境結果為準。

---

## 7. 接入測試清單（可以照住做）

### 7.1 前置設定

| 位置 | 變數 | 值 |
|---|---|---|
| vsbadge（Vercel） | `PORTAL_DEFAULT_ORIGIN` | portal 正式 origin（例如 `https://82venture.vercel.app`；preview 係另一個 origin，要另外設） |
| vsbadge（Vercel） | `PORTAL_DEFAULT_ROLES` | `exec_committee,branch_leader,group_leader`（唔好加平台保留角色） |
| portal（Vercel） | `TROOP_0082_NAME／BACKEND／APIKEY` | 同 vsbadge Registry 完全相同嗰份 |

兩邊改完都要 Redeploy；`PORTAL_DEFAULT_ORIGIN` 未設＝全部旅團唔開放 portal（fail closed）。

### 7.2 測試步驟

| # | 動作 | 期望 |
|---|---|---|
| 1 | 直開 `https://vsbadge.vercel.app/?u=0082` 登入（軌道 A） | 正常登入，`load` 回 `me`，審批／履歷／用戶管理全部可用 |
| 2 | 由 portal 開 `?u=0082&from=portal&role=exec_committee&src=<portal origin>&embed=1` | 免登入入到，標題顯示「… - Portal」，右上見 `Portal` 標記 |
| 3 | F12 → Network 睇 `/api/portal?…` | `200 {"ok":true,…}` |
| 4 | 勾一項再「儲存」 | 成功；重新載入仍見到 |
| 5 | 開「審批中心」處理一宗 | 預期**失敗**（`Token 無效或過期`）—— 屬現行已知限制，唔算 bug |
| 6 | 手動改成 `role=admin`（假設唔在白名單） | `role_not_allowed`，畫面顯示原因＋錯誤碼 |
| 7 | 由第二個網域（例如 preview URL）開同一條 link | `referer_mismatch`，而且唔會靜靜跌返登入頁 |

### 7.3 本機重現（同本次實測一樣）

```bash
PORTAL_DEFAULT_ORIGIN=http://127.0.0.1:3900 \
PORTAL_DEFAULT_ROLES=exec_committee,branch_leader,group_leader \
  node tests/dev-with-mock.mjs 3900

curl -s -H 'Referer: http://127.0.0.1:3900/dashboard' \
  'http://127.0.0.1:3900/api/portal?u=0082&role=exec_committee'

curl -s -X POST http://127.0.0.1:3900/api/proxy -H 'Content-Type: application/json' \
  -d '{"action":"load","troopId":"0082","data":{"token":"portal-1750000000000"}}'
```

（`/api/proxy` 要 `troopId`；payload 要放喺 `data` 入面。想略過來源檢查做 preview 測試，
可加 `VSBADGE_PORTAL_TEST=1`；喺 Vercel 一定失效。）


---

## 10. 試作後端已上 0082（`UnifiedCode.gs`）：vsbadge 會見到什麼、點核實、點回滾

**現況：** 0082 嘅 Apps Script 已由 `UnifiedCode.gs`（`UNIFIED_GS_VERSION = 'v9.6-u1-test'`，
`releaseChannel: isolated-test-only`）取代原本 v9.6 `Code.gs`，並以「新版本」重新部署（同一 `/exec`／API Key）。

### 10.1 為何 vsbadge 仍會顯示「✅ 已核對 v9.6」

`UnifiedCode.gs` 內嘅 baseline 仍然係 `VS_GS_VERSION = 'v9.6'`，而它嘅 `initializeSheets()` 會呼叫
`badgeInitializeSheets_()`，照樣寫入 `VS_GS_INITIALIZED_VERSION = 'v9.6'`；它亦**冇**改寫 `ecStatus`。
所以 vsbadge 嘅版本公告會見到「GS v9.6 ＋ 初始化完成」→ 綠色「已核對」。

> 即係：**綠色「已核對」只代表 baseline 版本對得上，唔代表跑緊正式發佈版。**
> 綠燈唔可以當「已驗收」用；呢個係現時最快會令人誤判嘅位。

### 10.2 30 秒核實「而家跑緊邊份 GS」

1. Apps Script 編輯器最頂幾行註解：`UnifiedCode.gs` 會有
   `Baseline: …/vsbadge@87c76a9… (v9.6)`、`Portal source: …/vs_portal@…`、
   `Release channel: isolated test only`；正式版 `Code.gs` 冇呢三行。
2. 或者喺 GAS 編輯器搜 `UNIFIED_GS_VERSION`：試作版有，正式版冇。
3. 前端／API **分辨唔到**：`ecStatus`、staff `load` 都唔會回 `unifiedGsVersion`
   （只有非管理員嘅 `load` 投影才帶）——所以唔可以用畫面判斷。

### 10.3 接入測試時預期會見到嘅差異（屬試作版特性，唔算 bug）

| 情況 | v9.6 正式版 | 試作版 `v9.6-u1-test` |
|---|---|---|
| 團員登入後 `load` | 回全團名冊／進度 | 只回**本人**投影（設計如此） |
| 領袖／執事登入後 `load` | 全團 | 全團（走返 baseline 路徑） |
| `save`／`saveOtherBadge`（經 proxy 注入 API Key） | 得 | 得 |
| `reviewRequest`／`reviewRequest` 等審批（無 sig） | 走 baseline 分支 | 同樣走返 baseline 分支（結果應一致） |
| 帶 `sig` 嘅請求 | 走 `handleSignedRequest()` | 先經 Unified router，白名單較窄（`bulkReviewRequests` 等要 sig） |
| **Portal 卡（`from=portal`）讀資料** | ✅ 讀到全團（見 §6） | ❌ `load` 被攔截 → `SESSION_REQUIRED`；但**畫面可能仍然見到全團**，因為前端會跌返 localStorage 舊 cache（會彈「⚠️ 離線模式：顯示快取資料」）。寫入仍經 API Key 分支成功，變成「寫得、讀嘅係舊 cache」 |
| Portal 前端（`authLogin`／`authWhoAmI`／`loadDb`…） | 不支援 | 支援（試作） |

### 10.3a 見到「全團」點分辨真讀定假讀（cache）

1. 開**無痕視窗**（唔帶 localStorage），由 Portal 卡同一條 link 入。
2. F12 → Network → 揀 `/api/proxy` 嗰個 `action=load` 請求 → 睇 Response：
   - `{"ok":false,"success":false,"code":"SESSION_REQUIRED"}` = Unified 拒絕，畫面唔應該有名冊／進度；
   - `{"success":true,"members":[…]}` = 真讀到（即 Unified 行為同本節描述唔同，要即刻更新本節）。
3. 有 cache 嘅正常視窗會彈「⚠️ 離線模式：顯示快取資料」；見到呢句就代表畫面數字係舊嘅，唔可以當測試結果。
4. 正常登入（軌道 A）睇到全團係**預期**行為，同 Unified 無關。

### 10.4 安全與範圍

- `isolated-test-only`：**只可以 0082 試**，唔好套用到其他旅團、亦唔好當成已驗收成果。
- 試之前先由 Google Sheet「檔案 → 版本記錄」或複製一份 Sheet 做備份；API Key 唔使換。
- 任何寫入結果都要 readback 核對；唔確定就重讀，唔好盲目重送。

### 10.5 回滾（唔需要改 Sheet）

1. Apps Script 貼返 vsbadge 正式 `Code.gs`（`apps-script/Code.gs`，v9.6，hash `63148a32…c34a10`），儲存。
2. 「部署 → 管理部署 → 編輯 → 選上一個版本」或者「新版本 → 部署」，**沿用同一 `/exec` 及 API Key**。
3. 因為試作版同正式版用同一批工作表／欄位，回滾**唔需要**改資料；如曾跑試作版 `initializeSheets()`，
   它只做增補，原有帳號／進度／API Key 不受影響。
4. 回滾後開 vsbadge 按「重新檢查」，應仍為 ✅（v9.6 baseline 一樣）。

### 10.6 顯示「🧪 試作後端」：vsbadge 已就緒，等 portal 回報

**已做（2026-11-20，前端、無合約改動）：** vsbadge 公告會讀兩個**可選**欄位
`channel`、`unifiedGsVersion`（來源：`ecStatus` 或 `load` 回應，位置同 `gsVersion` 一樣）。

| 來源（優先次序由上至下） | 公告顯示 |
|---|---|
| GAS `ecStatus`／`load` 回報 `channel`（非 `release`）或有 `unifiedGsVersion` | 紫色「🧪 試作後端」＋試作版說明，**唔會**顯示已核對 |
| Registry env `TROOP_<ID>_CHANNEL`（過渡用，見 §10.6a） | 紫色「🧪 試作後端」 |
| GAS 回報 `channel: 'release'` | 照舊綠燈 |
| 之後嘅 `load` 冇再帶（管理員走 baseline 路徑） | 同一旅團保持「🧪」，唔會跌返綠燈 |
| 完全冇 `channel`（舊 build／未更新 GS），Registry 亦冇宣告 | 照舊：版本＋初始化都對 → 綠色「✅ 已核對」 |

#### 10.6a 過渡：Registry 宣告（喺重新 vendor 之前用）

Vercel → vsbadge 專案 → Environment Variables 加一條（只限正在跑試作後端嘅旅團）：

```
TROOP_0082_CHANNEL = isolated-test-only
```

- `/api/troops` 會多一個 additive `channel` 欄位；**未填嘅旅團回應維持 `{ name, en }` 不變**（VSBOOK 等既有消費者不受影響）。
- 前端一揀該旅團（或者經 portal 卡入）就會顯示紫色「🧪 試作後端」，登入後亦保持。
- 只作顯示／提示，不影響授權、routing 或任何 API 行為；`channel` 唔會連帶公開 backend／apikey。
- 試作完、回滾正式 `Code.gs` 之後，記得**刪走**呢條 env 並 Redeploy，否則會一直顯示 🧪。
- 將來 GAS 直接回報 `channel` 時，兩者可以並存；**GAS 回報優先**，屆時可以刪走呢條 env。
- 目標：試作與否由後端（Script Property）講，Registry env 只做臨時開關。

**我哋係同一個後端，所以改動放喺後端 source（呢個 repo）：**

- `apps-script/Code.gs` 嘅 `getVsGsReleaseStatus()` 已經回報 `channel`，值由 Script Property
  `RELEASE_CHANNEL` 決定（預設 `release`）；選單「🧪 標記／取消試作頻道」可以直接切換。
  因為係 runtime 讀 property，**同一個 Sheet 上兩個前端都會即刻見到**，唔需要改 build。
- 正式發佈版（`Code.gs`）預設 `release`；試作 build（`UnifiedCode.gs`）喺同一個 Sheet
  設 `RELEASE_CHANNEL=isolated-test-only` 之後，兩個前端都會標示 🧪。

**portal 側要跟嘅（同一個後端嘅維護工作，唔算「另一邊嘅改動」）：**

1. 重新 vendor 呢個 baseline（新 hash `3a8f12ebef…0e057`），令 Unified build 都識回報 `channel`；
2. `initializeSheets()`／選單**唔好**清除或覆寫 `RELEASE_CHANNEL`（現時 vsbadge 已保證保留）。

完成後喺 portal `docs/BACKEND_SYNC.md` 記錄新 hash，等我更新 §2 版本表。

---

## 8. 待決定（需 portal 回覆或你拍板）

1. Portal 卡片係唔係應該**只讀**？如果要寫（勾選），現時係靠 API Key；要唔要改為要求真 session。
2. Portal 完整版要行 `authLogin`／`authWhoAmI`／行政 action，需要一份正式 shared-adapter；
   `UnifiedCode.gs` 只供隔離測試，幾時做正式版、由邊個 repo 做 source of truth。
3. 兩邊 Sheet 新增欄位時，邊邊負責寫 migration（現時只有 vsbadge `initializeSheets()` 有 idempotent 保證）。
4. 平台保留角色（唔喺白名單列出嘅最高階身份）唔會、亦唔應該經 portal 卡入；避免將來有人手多加落白名單。
5. `UnifiedCode.gs` 要唔要喺 `ecStatus`／`status` 回報 `channel`／`unifiedGsVersion`（見 §10.6）？
6. 0082 試作期幾時結束、回滾定繼續升級做正式 shared adapter。

---

## 9. 給 portal 嘅同步摘要（可直接貼去 portal 文件／issue）

- **同一個後端**：`playerkousas-rgb/vsbadge` 嘅 `apps-script/Code.gs` 係 source of truth，Unified 係 vendor 佢再加 adapter。
- 現時 baseline：GS `v9.6`，`Code.gs` SHA-256 **`3a8f12ebef…0e057`**（2026-11-20 加入 `channel`）。你哋 vendored 嘅仍然係舊 hash `63148a32…c34a10`，**下次同步要重新 vendor**。
- 頻道資訊已經喺後端：`getVsGsReleaseStatus()` 回 `channel`（預設 `release`，由 Script Property `RELEASE_CHANNEL` 決定）；`ecStatus` 同 `load` 都會帶。試作 Sheet 設 `RELEASE_CHANNEL=isolated-test-only` 即可，兩個前端都顯示「🧪 試作後端」。
- 你哋 `main@3203b52`（PR #15，v2.8.8）嘅 `/api/progress` 要求 `authWhoAmI`，裸 v9.6 冇 → 仍然 fail closed，屬預期。
- 你哋針對裸 v9.6 嘅缺失清單（`authLogin`／`authWhoAmI`／`authOpenAccounts`／`loadDb` 系列／`bulkReviewRequests`／`hub*`）同 vsbadge 現況**完全對得上**，冇新增差異。
- 簽名 transport（`vsbadge-troop-sig-v1`、canonical `action\nts\nnonce\nsha256(rawBody)`、±5 分鐘、900,000 字元）兩邊一致；你哋 `/api/progress` 嘅 `makeLinkSig()` 可以直接用。
- 由 portal 卡片深連結入 vsbadge 仍然可用：只放行「檢視＋直接勾選」；審批／申報／帳戶管理要有真 BADGE token。
- 你哋要做嘅只有：①重新 vendor 新 baseline；②`initializeSheets()`／選單唔好清除 `RELEASE_CHANNEL`；③喺 `docs/BACKEND_SYNC.md` 記錄新 hash。
- 下次 vsbadge 更新前，我會再更新 `docs/PORTAL_SYNC.md` 並通知你哋；你哋改 action contract 亦請同步知會，兩邊同時更新文件才算同步完成。
