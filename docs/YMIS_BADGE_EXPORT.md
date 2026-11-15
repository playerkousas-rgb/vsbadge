# YMIS 獎章匯出（試行）

> 深資童軍支部版，由 SCOUTBADGE（童軍支部）的同名功能移植。**試行版：尚無真實資料在 YMIS 驗證，匯出不等於匯入成功。**
> 相關文件：[LEADER_GUIDE.md](LEADER_GUIDE.md)（領袖教學）、[YMIS_EXPORT.md](YMIS_EXPORT.md)（由 YMIS 匯出成員名單作批量開戶，方向相反）。

領袖登入後，在「👥 全團總覽」按「⬇️ 匯出 YMIS 獎章（試行）」。成員帳號看不到這個入口。
不需更新 Apps Script，亦不需重新執行 `initializeSheets()`；整個流程只在瀏覽器內進行，不會呼叫旅團後端。

## 步驟

1. 選擇一款**已正式頒發**的獎章。
2. 勾選獲頒的成員，逐人填寫**實際獲獎日期**（沒有預設日期）。
3. 核對成員 SCOUT ID、獎章、日期及 YMIS 現有紀錄，勾選確認。
4. 按「⬇️ 下載 XLSX」，得到 `YMIS-badges-YYYY-MM-DD.xlsx`。
5. 登入 YMIS → **成員註冊 → 資料檔案上傳 → 新增支部獎章紀錄**，上傳並按系統指示確認。不要選完整青少年成員登記。

每次匯出一款獎章、多位成員；其他獎章另行匯出。未勾選的成員不會輸出。

## 這個功能不會做的事

- **不會把考核完成視作已頒章。** 獎章與日期全部由領袖明確指定，不讀取、亦不參考本系統的考核進度。
- **不會更改 VSBADGE 的任何進度或紀錄**，也不會記低匯出過什麼。
- 選取狀態只在這次視窗內保留；關閉視窗或重新整理後需重新輸入。
- 沒有跨次匯出／YMIS 重複偵測：同一檔案上傳兩次、或 YMIS 已有該紀錄，本系統都不會知道。

## 檔案格式

四欄（依使用者提供的 YMIS 範本，欄名及次序逐字一致），工作表名 `Sheet1`：

`Scout ID`, `Badge-Section`, `Badge-Badge`, `Badge-award date (YYYYMMDD)`

| 欄 | 內容 |
|---|---|
| `Scout ID` | 成員的 SCOUT ID（平台內的 YMIS 編號）：10 位數字，以文字儲存以保留前導零。不是 10 位數字的成員不能勾選。 |
| `Badge-Section` | 固定 `Venture Scout`。 |
| `Badge-Badge` | 下表四款其中之一。 |
| `Badge-award date (YYYYMMDD)` | 領袖填寫的實際獲獎日期，例如 `20261114`，以文字儲存。 |

| 本系統獎章 | `Badge-Badge` 值 |
|---|---|
| 會員章 | `Membership Badge` |
| 深資童軍獎章 | `The Venture Scout Award` |
| 榮譽童軍獎章 | `The Dragon Scout Award` |
| 英皇童軍獎章 | `King's Scout Award` |

不包含：專科徽章（興趣／技能／服務／教導組）、海上及航空活動徽章、其他獎章、考核細項、2017 制過渡等同紀錄（`LEGACY-2017-*`），亦沒有範本示例行。

## 驗證界線

本地測試（`tests/ymis_export.test.cjs`）涵蓋欄名、獎章對應、日期、編號、重複行及工作表資料。
**尚無真實資料在 YMIS 驗證**，不保證其伺服器接受這個檔案；這不是官方 API 串接，也不會自動得知上傳結果。**匯出不等於匯入成功。**

- `Badge-Section` 的 `Venture Scout` 及四個 `Badge-Badge` 值，均按使用者提供並確認的深資童軍支部字串逐字寫入；字串本身已確認，但整個檔案仍未經 YMIS 上傳實測。

首次使用建議先上傳**一筆**真實而未登記的紀錄，在 YMIS 確認結果後才批量使用。若出錯，請經 APP 的「回報 · 意見」提供錯誤文字或遮蓋個人資料的截圖；不要提交含真實成員編號的完整檔案。

下載的檔案含個人識別資料（成員編號），請妥善保管，用完即刪。

## 技術備註

- 對應表與驗證邏輯：[`assets/ymis-export.js`](../assets/ymis-export.js)（瀏覽器 `window.YmisExport`／Node `require`）。移植時只改支部值、獎章對應表及相關文字，其餘邏輯與 SCOUTBADGE 一致，方便日後三個支部一齊對照 YMIS 實測結果。
- 成員編號沿用 VSBADGE 的 `ymis` 欄位。
- Excel 由 SheetJS `xlsx@0.18.5` 產生。VSBADGE 本身沒有載入 SheetJS，只在領袖開啟匯出視窗時才從 CDN 載入（cdnjs → jsDelivr → unpkg），並以 SRI 雜湊固定檔案內容；載入失敗時視窗會提示，可檢查網絡後再按下載。
- 要修改獎章字串，只改 `assets/ymis-export.js` 的 `badges`／`section`，並同步更新本文件及測試。
