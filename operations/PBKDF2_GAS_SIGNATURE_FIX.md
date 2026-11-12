# Apps Script PBKDF2 簽章修正

`computeHmacSha256Signature` 的訊息和金鑰必須同為字串或同為 byte 陣列。舊 GS 將 PBKDF2 的 byte 訊息和字串金鑰混用，可能令初始化建立管理員、登入驗證及設定密碼時出錯。修正後將密碼按 UTF-8 編碼成 bytes，並在每輪以 byte 陣列呼叫；salt 轉成 GAS signed bytes，算法和標準 PBKDF2-HMAC-SHA256 一致。

## 更新及注意事項

1. 先備份試算表和目前的 Apps Script 程式碼。不要刪除 Users、重建試算表或公開密碼、雜湊及 API Key。
2. 以更新後的 `apps-script/Code.gs` 覆蓋 Apps Script，儲存並執行 `initializeSheets()`。若已有網頁應用部署，再到「管理部署」編輯原部署、選「新版本」並部署。
3. 確認初始化成功及管理員可以登入，按提示更改預設密碼。重跑初始化不會覆寫既有管理員密碼。
4. 標準 PBKDF2 雜湊和舊版單次 SHA-256 雜湊維持支援。但如果曾使用自行修改、將 PBKDF2 bytes 轉成字串的版本建立或更改密碼，其雜湊可能不相容；初始化成功不能證明相容。先保留備份及修改版程式碼，檢查實際改法，安排受影響帳號透過現有授權重設流程重設密碼；若管理員亦無法登入，須先評估安全的復原方法。不要直接刪帳號或假設重跑初始化會修好密碼。

Node 測試模擬 GAS 的 HMAC 簽章並與 Node 標準 PBKDF2 對照；實際 Apps Script 執行及部署仍需由有權限的人在 Google 環境驗證。
