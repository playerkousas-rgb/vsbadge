# CHANGE_LOG — vsbadge（深資童軍進度及行政平台）

記錄每次發佈的日期與影響範圍。詳細技術文件見 `operations/`；部署步驟見 `DEPLOY_GUIDE_FOR_TROOPS.md`。

## 2026-11-05 — GS v9.5 修正 PBKDF2 登入逾時＋審批／申請寫入（VSBOOK 對接）

**影響範圍**：`apps-script/Code.gs`（`VS_GS_VERSION` 升至 v9.5）、`api/proxy.js`（slow_password_kdf 日誌）、`index.html`（timeout 鏈、未更新 GS「此版本登入會逾時」提示、公告）、測試與文件。工作表欄名／結構、旅系統接入協定（sig／ALLOW_LOCAL_LOGIN）、Proxy action 白名單不變。

**行為改變**

- 登入逾時根因修復：Apps Script 每輪 PBKDF2 迭代都係一次 `Utilities.computeHmacSha256Signature()` 呼叫，120,000 迭代實測 12–20 秒，撞正 Proxy 45s 上游逾時只係時間問題。新雜湊改用 **10,000 迭代**（約 1–2 秒）；驗證接受範圍放寬做 **1,000–2,000,000** 並一律用雜湊自帶 iter。舊 64-hex 同 `pbkdf2$120000$` 帳號照用原密碼登入，成功一次後**透明改寫**做新次數（一次性額外 KDF），毋須重設密碼或清資料。
- 防枚舉／配額：dummy 雜湊改用 `CacheService` 重用 6 小時（key 帶迭代次數）；帳號不存在／鎖定中一律做**恰好一次** KDF 先回中性訊息（鎖定路徑唔再 0-KDF 提早 return）。每條登入路徑恰好 1 次驗證 KDF，由 `tests/login-kdf.test.mjs` 逐條斷言。
- 可觀測性：新增 `benchmarkPasswordKdf()`（Apps Script 原路徑實測 120,000 vs 10,000 毫秒，選單「⏱️ 密碼 KDF 速度測試」）；Proxy 密碼操作慢過 8s／逾時記 `slow_password_kdf`（只含 metadata）；登入成功回應增補 `gsVersion`。前端 `apiRequest` 預設 timeout 45s→**58s**（大過 Proxy 上限 55s、細過 Vercel 60s，唔再互相打架）；未更新 GS 旅團喺公告同登入錯誤訊息顯示「此版本登入會逾時」。
- VSBOOK 對接修正：`handleReviewRequest` 批准 `OT-*` 改寫「其他獎章」（Upsert，`handleLoad.otherBadges` 即時可見），其餘項目經 `handleSave` Upsert 唔再重覆列；`handleRequestComplete` 同一 `(ymis,itemId)` pending 冪等去重（更新申請日期／證明、回傳既有 request_id），支援批次 `body.items[]`（向下相容單筆）。`GET /api/troops` 契约不變；Proxy 繼續受理冇 Origin／Sec-Fetch-Site 嘅伺服器對伺服器請求。

**資料與部署**：冇新增工作表／欄位／action。更新 Code.gs 後照慣例執行一次 `initializeSheets()`（只做增補、記錄版本、保留所有資料及 API Key）再「新版本」部署；前端公告「重新檢查」至綠色已核對。**唔好回退舊 Code.gs**（舊驗證下限會拒絕已升級嘅 10,000 迭代雜湊）。實測方法、各路徑成本表、部署步驟詳見 `operations/PBKDF2_LOGIN_TIMEOUT.md`。

**驗證**：`npm run lint && npm run check && npm test`（新增 `tests/login-kdf.test.mjs` 7 項、`tests/request-review.test.mjs` 8 項；既有測試嘅迭代次數全部改為由 GS 常數推導，唔硬編碼）＋ `npm run build && npm run test:build`；e2e 172 項通過。

## 2026-11-02 — GS v9.4 登入安全強化（A3／A5／A17）

**影響範圍**：`apps-script/Code.gs`（`VS_GS_VERSION` 升至 v9.4）、`index.html`（前端公告、忘記密碼流程與中英字串）、測試與文件、新增 `.github/workflows/ci.yml`。`api/` Proxy 白名單、旅系統接入協定（sig／ALLOW_LOCAL_LOGIN）、深資綱要與後台查詢顯示不變。

**行為改變**

- 密碼儲存：新設密碼（開戶、批量開戶、審批初始密碼、自行改密、領袖重設、電郵重設）一律以 PBKDF2-HMAC-SHA256（120,000 迭代＋每用戶 16-byte 隨機鹽，格式 `pbkdf2$<iter>$<salt>$<dk>`）儲存；舊 64-hex 雜湊成功登入時自動升級，密碼不變。跨節點匯出／匯入（`upsertUser`／`importUsers`）同時接受雙格式，與仍使用舊格式的節點互通。
- 登入鎖定：同一帳號連續 5 次失敗鎖定 15 分鐘（Script Properties `LOGIN_FAIL:<ymis>`；正確密碼於鎖定期間同樣拒絕），成功登入清零；鎖定寫審計 `login_locked`。自行改密後撤銷其他裝置登入（保留當前登入）；領袖重設／電郵重設成功清鎖、撤銷全部登入且可即時用新密碼登入，領袖重設同時要求下次登入改密碼。
- 防探測（只限未登入公開入口）：登入失敗一律「帳號或密碼錯誤」（帳號不存在時執行假 KDF 對齊時序）；申請重設碼在帳號不存在／未登記電郵／寄件失敗／成功寄出四種情況一律回同一句中性訊息「如該帳號已登記電郵，重設碼會寄到登記電郵，請於 15 分鐘內輸入。如收唔到信，請先檢查垃圾郵件，再聯絡領袖協助。」領袖登入後的後台成員名單／電郵查詢顯示不變。
- 領袖重設授權：重設密碼的權限檢查收緊到處理函數本身（以經核實的管理員角色核查）——不可跨級或同級重設（例如副團長不可重設團長、管理員不可重設管理員），成員不可重設任何人，保留帳號不可被重設；被拒時目標帳號雜湊完全不改。
- 忘記密碼 UX：登入頁入口更顯眼；只需輸入 YMIS 或登記電郵其中一項；重設碼改為 8 位數字（可貼上、自動去空格；只存與 API Key 加鹽雜湊、15 分鐘、最多 5 次、單次使用、既有限速不變）；新增「收唔到信？」逐步指引（垃圾郵件 → 登記電郵 → 領袖／部署者）；失敗一律提示「重設碼不正確或已過期，請重新申請」，並按介面語言顯示；成功後回到登入頁以新密碼登入（新密碼至少 4 位）。
- 忘記密碼維持只有三條路：① 未登記電郵成員由領袖在「👥 用戶管理」重設；② 已登記電郵帳號自助電郵重設；③ 預設管理員帳戶按既定上報流程處理。沒有新增後門或 GAS 重設函數。

**資料與部署**

- 沒有新增工作表、欄位或 Proxy action。密碼雜湊仍存於「使用者」表既有 `password_hash` 欄（內容格式改為雙格式兼容）；登入失敗計數只存 Script Properties。
- 部署慣例更新：「毋須初始化」今後只代表該版本沒有新增必要表／欄；建議每次覆蓋 `Code.gs` 後都執行一次 `initializeSheets()`（只做增補：建表、補空白表頭、補缺失列；可安全重跑，不刪除或改寫既有資料），再以「新版本」重新部署。由 v9.3 以前跨版本升級時必須初始化一次，以補建 v9.3 的「密碼重設」工作表。本版保持前端 `initializeRequired: true`，旅團需初始化並在公告重新檢查至綠色「✅ 已核對」。
- 兼容：升級前已寄出、未過期的舊 6 位重設碼（15 分鐘窗內）仍可完成重設；前端保留舊 GS 回應的兼容分支。注意舊版 GS 無法驗證新版雜湊，如回退 Code.gs 至 v9.3，已自動升級雜湊的帳號需由領袖以舊版重設密碼一次才能登入，故建議只向前升級。

**驗證**：`npm run lint && npm run check && npm test`（含新增 `tests/auth-hardening.test.mjs` 10 項安全回歸）＋ `npm run build && npm run test:build`；CI `.github/workflows/ci.yml`（SHA-pin actions、Node 22）跑同一套檢查。

## 2026-11-02 — GS v9.3 忘記密碼（自助重設）

**影響範圍**：`apps-script/Code.gs`（新增「密碼重設」工作表、`requestPasswordReset`／`completePasswordReset` 公開 action、MailApp 寄件）、`index.html`（登入頁「🔑 忘記密碼？」三步流程）、`api/proxy.js` 公開白名單新增上述兩個 action。

**行為改變**：已登記電郵帳號可在登入頁自助重設密碼（電郵驗證碼 15 分鐘有效、最多 5 次、只存加鹽雜湊）；未登記電郵帳號由領袖在「👥 用戶管理」重設（不建立待批請求）；重設成功撤銷所有既有登入。

**資料與部署**：更新 `Code.gs` 後執行一次 `initializeSheets()` 補建「密碼重設」工作表及欄位（可安全重跑，其餘資料保留）；首次寄件需授權「以你名義傳送電郵」。

## 2026-10-24 以前

v9.2 及更早版本的詳細紀錄保留於 `README.md`、 `DEPLOY_GUIDE_FOR_TROOPS.md` 及 `operations/TROOP_LINK_UPGRADE.md`，本檔不重覆改寫歷史。
