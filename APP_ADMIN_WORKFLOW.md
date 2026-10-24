# vsbadge APP ADMIN 工作流程

> 對象：管理 vsbadge 多旅團部署（Vercel 環境變數 Registry、中央超管、旅團 GS 後端）嘅 APP ADMIN。
> 旅團日常操作見 [DEPLOY_GUIDE_FOR_TROOPS.md](DEPLOY_GUIDE_FOR_TROOPS.md) 及 [docs/LEADER_GUIDE.md](docs/LEADER_GUIDE.md)。

## 一圖睇晒

```
[旅團 Google Sheet + Apps Script（Code.gs）] ── 旅團交出：編號＋/exec URL＋API Key
                │                                     （initializeSheets() 生成，存 Script Properties）
                ▼
[APP ADMIN] ── 寫入 Vercel env：TROOP_<id>_NAME / _BACKEND / _APIKEY → Redeploy
                │
                ▼
[vsbadge.vercel.app] ── /api/troops 列旅團 → /api/proxy 伺服器端注入 API Key 轉發 → 旅團 GAS
```

- 旅團**唔會**接觸 Vercel env；API Key 只存喺 GS Script Properties 同 Vercel env，**永不經瀏覽器**。
- 中央超管（保留帳號）經 `/api/super` 短效票據救援，密碼只存 Vercel env（`SUPER_KEY`），唔寫入任何 Sheet。
- 旅系統（旅 > 團 > 進度）上下游 sig 接入係自願性質，見 [operations/TROOP_LINK_UPGRADE.md](operations/TROOP_LINK_UPGRADE.md)。

## 最新版本公告及初始化核對（2026-10-24｜GS v9.2）

- 前端公告（首頁、登入頁、登入後主頁）**只列最新更新日期＋最新 GS 版本**，不設逐級補丁清單；附上最新 `Code.gs` 下載、更新步驟及「🔄 重新檢查」按鈕。
- GS 以 `VS_GS_VERSION` 常數標記發佈識別（**唯一例外**；其餘版號只記錄喺 `operations/TROOP_LINK_UPGRADE.md`，`tests/troop_link.test.mjs` 有守護測試）。
- `ecStatus`（Proxy 白名單公開 action，API Key 由伺服器端注入）及登入後 `load` 回報：
  - `gsVersion`：旅團實際部署嘅 GS 程式版本
  - `initializedGsVersion`：`initializeSheets()` 成功完成後寫入 Script Properties（`VS_GS_INITIALIZED_VERSION`）嘅版本
  - `gsInitializationCurrent`：兩者一致先為 `true`
- 前端三態：**GS 未更新**（警告）／**已更新但未初始化**（警告）／**全部完成**（綠色「✅ 已核對」）。只有最後一態先算完成。
- 今次發佈 `initializeRequired: true`：每個旅團都**必須執行一次 `initializeSheets()`**，然後新版本部署（沿用現有 `/exec` URL），再喺 App 按「重新檢查」。
- **接入資料只提供 API Key（v9.2 起）**：GS 初始化彈窗、`showApiKey()`／`showVercelEnv()` 及 Sheet 選單「🔑 顯示 API KEY（交 ADMIN）」一律只顯示 `API Key = ...`，唔再顯示 `ScriptApp.getService().getUrl()`、舊 `WEBAPP_URL` 快取或請求自報嘅網址，初始化回傳值亦冇 `scriptUrl`。旅團毋須預先設定旅團編號，亦冇貼 URL 入 GS 嘅步驟：正式 URL 由領袖喺 Google「部署 → 管理部署」視窗抄，再喺原有接入申請（ADMIN FORM）填編號、名稱、URL、API Key。既有 Script Properties（包括舊 URL 快取）原樣保留，唔會因今次修正刪改。背景調查見 [docs/BACKEND_URL_DIAGNOSIS.md](docs/BACKEND_URL_DIAGNOSIS.md)。
- **Workspace URL 格式相容**：Registry 及接入申請轉發會把 `https://script.google.com/a/<網域>/macros/s/<部署 ID>/exec` 轉成相同部署 ID 嘅公開路徑再驗白名單；唔代表修正錯 ID 或改變 Google 權限，亦唔接受 HTTP、query、fragment、帳密或自訂連接埠。非 JSON 回應唔可以直接當作錯誤／舊部署證據。
- 首頁新增「🌿 系統介紹」分頁（通用「支部進度追蹤系統」圖＋中英說明），公開內容唔包含任何保留帳號資訊，並保留「部分資料讀取入口驗證仍待補強」嘅安全邊界聲明；今次冇改登入／簽名協定，亦冇修復該已知事項。

## 所有補丁的資料保全硬性規則

**所有前端、API 及 Apps Script 補丁都不得修改用戶現有資料。** 這是每次更新及驗收的硬性功能要求，不是只適用於某一次 GS 版本。

- 不得刪除、覆寫、重置、重新編號或擅自遷移帳號、成員、YMIS、現行及舊 ID 進度、其他獎章、活動履歷、備註和旅團設定。
- 不得因綱要或系統更新而把舊 ID 靜默轉成新 ID，亦不得要求用戶重新輸入已有資料；舊紀錄必須按原值保留。
- 只可作出向後兼容的新增：補建缺失工作表、補齊缺失欄位，以及在設定不存在時加入預設值；**已有值一律不可改寫**。
- 版本及初始化標記只寫入 Apps Script Script Properties，不得借更新標記改寫用戶業務資料；**現有 API Key 不得因補丁或重新初始化而更換**。
- 例外（系統自用、唔係用戶資料）：清理保留身份（中央超管 `sheep`）喺各 Sheet 嘅殘留列／標記，以及把仍使用預設密碼嘅帳號重標 `force_change_password` —— 兩者都係既有保安行為，唔會觸碰正常用戶資料。
- 補丁驗收必須比較更新前後的用戶資料，證明原有值保持不變；`tests/release-version.test.mjs` 已內建呢個檢查（初始化前後逐 Sheet 快照對比＋重複初始化＋API Key 不變）。

## 更新現有旅團嘅標準流程

1. 旅團喺 App 公告或「📋 新旅團部署」頁下載最新 `Code.gs`，取代 Apps Script 內容並儲存。
2. **必須執行一次 `initializeSheets()`**（保留所有現有資料及 API Key）。
3. 部署 → 管理部署 → 編輯現有部署 → 新版本 → 部署（**沿用原 `/exec` URL**，Vercel env 毋須改動）。
4. 旅團喺 App 揀返自己旅團，公告按「🔄 重新檢查」；見到綠色「✅ 已核對」先算完成。
5. 如公告顯示「已更新但未初始化」，即第 2 步未做；顯示「尚未完成 GS 更新」，即第 1／3 步未完成。
