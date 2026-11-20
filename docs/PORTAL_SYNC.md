# Portal ↔ VSBADGE 共用 GS 同步規則

> 一個旅團只有一份完整 Apps Script、一張 Google Sheet、一套 Users。Portal 是完整版前端，VSBADGE 是輕量前端；不可為了修一邊退回功能較少的 GS，也不可讓兩邊各自維護互不相容的後端。
>
> **每次修改 GS 前先讀 Portal 公開 repo 的實際完整後端；修改後由另一邊拿這份完整檔案作底，再檢查相容性。** 版本採 copy-then-bump：只看 `VS_GS_VERSION` / revision，不要求 re-vendor、manifest 或產生第二份 bundle。

## 目前狀態（2026-11-20）

- Portal 最新 `main`：commit `3203b52`；`apps-script/UnifiedCode.gs` 約 9,178 行，GS baseline `v9.6`。
- 本分支 `apps-script/Code.gs`：以該完整 Unified GS 為底，約 9,200 行，版本 `v9.7`，revision `2026-11-20`。它保留 Portal 行政功能及 VSBADGE BADGE 功能；不是 2,700 行的輕量版。
- 新增 `progressAll`，Portal 以有效 session 呼叫後，可直接讀 BADGE 分頁的全團投影，不必從 Portal 的 `資料表` envelope 找 BADGE 資料。Portal 仍須在它的 BADGE 全團畫面實際改用並驗收這個 action。
- v9.7 預設回報 `channel: portal-acceptance`，驗收前不顯示正式綠燈。0082 尚未由本次工作部署；本地測試通過不等於線上驗收。

## 每次 GS 更新前後的同步步驟

1. 讀取 Portal 最新公開 `main` 的 `apps-script/UnifiedCode.gs`，記錄 commit、`VS_GS_VERSION`，並閱讀完整 action/auth/初始化路徑。
2. 檢查它在 BADGE 現有 `Users`、進度、名冊、申請、審批、設定及特殊保留身份流程上有沒有回歸；以 mock-GAS 測試，不可只比較行數或只測 Portal。
3. 以較新的**完整 GS**作為唯一基底，作必要的跨前端相容修正。每個可發佈修改 bump `VS_GS_VERSION`（例如 `v9.7` → `v9.8`），更新 `VS_GS_REVISION`、公告、測試及本文件。
4. `npm run sync:check -- --portal ../vs_portal` 會直接比較本 repo `apps-script/Code.gs` 與 Portal 實際 `apps-script/UnifiedCode.gs` 的版本識別；它不讀 vendored manifest/hash，也不執行 re-vendor。
5. 本側測試、完整 lint 通過後，才把新的完整 `Code.gs` 和 action 契約交另一側；另一側直接 copy 這份檔案作底，再測它自己的前端，不刪 Portal 功能。
6. 只有 0082 真正部署並由兩個前端讀寫驗收後，才把頻道切為 `release`。若 Portal 用 v9.7 後仍不能讀全團，從 v9.7 修正並 bump 至 v9.8，不能退回舊短版或另開分叉 GS。

## v9.7 BADGE 全團讀取契約

- Request：`POST { action: 'progressAll', token: '<有效 BADGE/Unified session>' }`（既有同源 proxy 可按部署方式轉送；瀏覽器不可持有 API Key）。
- Auth：後端從 token 查真實 Users/角色 scope；忽略 caller 自報角色。無效 session 先拒絕，不讀取 roster。
- Visibility：有 Unified `progress:manage` scope 的領袖讀全團；一般 member 只有 `SystemConfig.allow_member_view_others === 'true'` 才可讀全團；否則回 `code: 'TROOP_VIEW_DENIED'`，不帶成員資料。
- Success：`viewScope: 'troop'`、`members`、`progress`、`flatProgress`、`otherBadges`、`pendingRequests`、`logs`、`logRequests`、`counts`、`config`、`gsVersion`、`revision`。資料直接來自同一張 Sheet 的 BADGE 分頁。
- `load` 與 `loadMine` 的既有角色投影保持不變；Portal 行政 `loadDb` 仍是 Portal 自己行政資料 envelope，不能拿它當 BADGE 分頁資料來源。

## 發佈／驗收

1. Apps Script 編輯器只貼本 repo 的完整 `apps-script/Code.gs`（v9.7），執行 `initializeSheets()`，再建立新 deployment；不改 Sheet ID、API Key 或既有部署資料。
2. Portal 用有效登入 session 請求 `progressAll`；用 0082 的真實 roster 核對 `viewScope`, `members.length`, 進度格數及第二位團員資料；也確認 member 未授權時被拒絕。
3. 分別確認 Portal 行政管理、VSBADGE 登入／個人進度／寫入／審批仍可用；不可只憑 action 回 200 就稱全團修好。
4. 未完成上述 readback 前保持 `portal-acceptance`。驗收後可在 Apps Script 呼叫 `setReleaseChannel_('release')`；初始化不會改寫此標記。
5. 不要把 0082 已更新、Portal 已驗收或已部署寫成事實，除非實際完成並 readback。
