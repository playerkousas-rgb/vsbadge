# 🔗 Portal 對接協議（主系統 ↔ vsbadge）

> 對象：主系統（hub，例如 82venture）的開發者。
> vsbadge 自己係**進度資料嘅擁有者**，主系統只做入口同管理；呢份文件講主系統要送出什麼、
> vsbadge 點樣驗證、失敗時會收到什麼。
>
> 版本：**v3.1**（安全修補：免登入身份由伺服器驗證，唔再淨係信 URL 參數）

---

## 1. 主系統要送出的 URL

```
https://vsbadge.vercel.app/?u=0082&role=exec_committee&ymis=PORTAL-0082-EXCO&name=執行委員會&from=portal&src=https://82venture.vercel.app&ts=1789449435427&embed=1
```

| 參數 | 必填 | 說明 |
|---|---|---|
| `u` | ✅ | 旅團編號（vsbadge Registry 的 key，例如 `0082`） |
| `role` | ✅ | 帶入嘅角色，**必須在旅團 `portalRoles` 白名單內**，見 §3 |
| `from=portal` | ✅ | 觸發免登入流程（冇呢個參數 = 軌道 A，照常揀旅團登入） |
| `src` | 強烈建議 | 主系統自己的 origin（例如 `https://82venture.vercel.app`）。非瀏覽器 client 可偽造，所以 vsbadge 仲會核對瀏覽器嘅 `Referer`；兩者只要有就一定對得上 `portalOrigin` |
| `ymis` | ❌ 可省略 | v3.1 起**唔需要人手填**：冇帶會自動用 `PORTAL-<u>-<role>`。舊連結照常相容 |
| `name` / `displayName` | 可選 | 顯示名稱 |
| `email` | 可選 | 紀錄用 |
| `ts` | 可選 | 毫秒時間戳。現時只作紀錄／除錯，**未設有效期**（來源已由 Referer/Origin 把守） |
| `embed=1` | 可選 | 精簡介面（隱藏大 Header／footer），適合 iframe 600–750px 高 |
| `lang=zh` / `en` | 可選 | 鎖定介面語言 |
| `backend` / `apikey` | ❌ | v3.0 起**一律被忽略**（防 SSRF／Open Proxy），唔好再送 |

---

## 2. vsbadge 點樣驗證（`GET /api/portal`，同源）

前端喺顯示免登入介面之前，一定會先問 `GET /api/portal?u=…&role=…&src=…`，
由伺服器按以下次序把關，**任何一關唔過就拒絕**：

| # | 檢查 | 拒絕 reason | HTTP |
|---|---|---|---|
| 1 | 旅團已喺 Registry 登記，且 `backend` 通過 `isTrustedExecUrl()` | `unknown_troop` | 404 |
| 2 | 旅團有設 `portalOrigin`（冇設 = 唔開放 portal，fail closed） | `troop_not_portal_enabled` | 403 |
| 3 | `Referer`/`Origin` 或 `src` 對得上 `portalOrigin` | `referer_mismatch` / `origin_not_allowed` / `no_origin` | 403 |
| 4 | `role` 喺旅團 `portalRoles` 白名單內 | `role_not_allowed` | 403 |

回應（成功）：

```json
{ "ok": true, "role": "exec_committee", "troop": "0082", "name": "第 82 旅" }
```

回應（拒絕）：

```json
{ "ok": false, "reason": "referer_mismatch", "expected": "https://82venture.vercel.app" }
```

- **無 CORS header**：只畀同源前端用，跨站讀唔到結果
- `Cache-Control: no-store`；log 只記 troopId / role / result，唔記 token／apikey／payload
- 只接受 GET（其他 method → 405）

---

## 3. 設定（得一份：全域 env）

對接**只有一個共用嘅主系統前端**，所以 portal 設定亦只有一份 —— 喺 Vercel
Project Settings → Environment Variables 設兩條，**所有旅團一齊生效**：

```
PORTAL_DEFAULT_ORIGIN = https://82venture.vercel.app
PORTAL_DEFAULT_ROLES  = exec_committee,branch_leader,group_leader
```

- **新旅團零設定**：旅團只要照常登記 `u` + `backend`（+ `apikey`）就自動可以經主系統入，
  唔使再為 portal 加任何嘢
- **改主系統地址**：改 `PORTAL_DEFAULT_ORIGIN` 一條 → redeploy 即生效，唔使改 code、唔使逐個旅團改
- **冇設 `PORTAL_DEFAULT_ORIGIN`（出廠狀態）= 全部旅團都唔開放 portal**（fail closed）
- ⚠️ 一設咗，所有已登記旅團都會即時開放 portal（角色仍然受白名單限制）
- ⚠️ `portalOrigin` 係 **origin**（protocol + host + port），唔包 path：
  production、preview（`*.vercel.app` branch URL）、本機 `http://localhost:3000`
  全部都係唔同 origin，要分開設定

呢啲設定同 `backend` / `apikey` 一樣**只放伺服器端**，`/api/troops` 唔會公開。

### 3.1 逃生門（個別旅團例外）

正常唔需要用。只有當某個旅團要「同其他旅團唔同」時，先至喺嗰個旅團身上加設定：

| 用途 | env |
|---|---|
| 用第二個 hub／另一組角色（覆寫全域預設） | `TROOP_{ID}_PORTALORIGIN` / `TROOP_{ID}_PORTALROLES` |
| 個別旅團停用 portal | `TROOP_{ID}_PORTALDISABLED=1` |

優先次序：**個別旅團 env → 全域 `PORTAL_DEFAULT_*` env**，不再讀取 JSON。
ID 必須完全一致：`0082` 與 `82` 是不同旅團，保留前導零。角色預設 `exec_committee`。
共用主系統只設全域 env，避免重複設定。

---

## 4. 接受嘅角色

一般接入角色：
`admin`、`group_leader`、`branch_leader`、`exec_committee`

角色必須同時在旅團 `portalRoles` 白名單內才會放行。

---

## 5. 失敗時用戶會見到什麼

v3.1 起唔會再無聲跌落登入頁，畫面會明確顯示原因 + 錯誤代碼 + 「重試」／「返回首頁」：

| reason | 用戶訊息重點 |
|---|---|
| `unknown_troop` | 旅團未登記，請聯絡 vsbadge 管理員 |
| `troop_not_portal_enabled` | 旅團未開放主系統接入（未登記 `portalOrigin`） |
| `referer_mismatch` | 只接受由 `<portalOrigin>` 進入，請由主系統卡片／連結開啟 |
| `origin_not_allowed` | 來源網址未獲授權，只接受 `<portalOrigin>` |
| `role_not_allowed` | 旅團未開放 `<role>` 身份，已開放身份：`<portalRoles>` |
| `no_origin` | 未能確認來源（缺 Referer 及 `src`），請由主系統卡片開啟 |
| `no_response` | 連唔上 vsbadge 驗證服務（`/api/portal`） |

---

## 6. 冇 `from=portal` 嘅訪客（軌道 A）

照舊：打開 vsbadge.vercel.app → 揀旅團 → 輸入 YMIS／Email + 密碼登入。
**軌道 A 唔受今次改動影響**，亦唔需要 `portalOrigin`。

---

## 7. 本機／預覽測試

```bash
VSBADGE_PROXY_TEST=1 TROOP_0082_PORTALORIGIN=http://127.0.0.1:3000 \
  node tests/dev-with-mock.mjs 3000
```

想略過來源檢查（例如喺唔知 origin 嘅 preview 環境試），可加 `VSBADGE_PORTAL_TEST=1`；
呢個開關只要跑喺 Vercel（`VERCEL=1`）就必定失效，生產環境唔會生效。

回歸測試：`npm test`（第【15】節係 Portal 驗證 case）。
