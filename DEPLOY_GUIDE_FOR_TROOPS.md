# 📋 旅團部署指南

> 10 分鐘完成。只需建立 Google Sheet 和部署 Apps Script。

---

## 你需要準備

- ✅ 一個 Google 帳號
- ✅ 10 分鐘時間
- ✅ 本指南
- ✅ `Code.gs` 檔案（向系統管理者索取）

---

## 第 1 步：建立 Google Sheet

1. 打開 [Google Sheets](https://sheets.google.com)
2. 建立新試算表
3. 取名為「深資童軍進度追蹤 - 你的旅團名稱」
4. 複製網址中的 Sheet ID：

```
https://docs.google.com/spreadsheets/d/【這段就是 Sheet ID】/edit
```

---

## 第 2 步：貼上後端程式碼

1. 在 Sheet 中，點擊上方選單 **擴充功能** → **Apps Script**
2. 會打開一個新的 Apps Script 編輯器
3. **刪除**編輯器裡所有現有內容
4. 複製 `Code.gs` 程式碼（向系統管理者索取）
5. **全部貼上**到 Apps Script 編輯器
6. 修改最上面的：

```javascript
const SHEET_ID = '你的Sheet ID';    // ← 填入第1步複製的 ID
```

7. 點擊上方 💾 **儲存** 按鈕
8. 在上方的函式選單中選擇 `initializeSheets`
9. 點擊 ▶ **執行**
10. 第一次會要求授權：
    - 選擇你的 Google 帳號
    - 點擊「進階」
    - 點擊「前往（不安全的應用程式）」
    - 點擊「允許」

11. 會彈出視窗顯示 **API Key**，**複製這個 Key**

```
API Key: vs_xxxxxxxxxxxxxxxxxxxx
```

**⚠️ 重要：記住這組 API Key，等一下要交給系統管理員。**

完成後會看到 Sheet 裡自動新增了兩張工作表：
- ✅ 進度追蹤表
- ✅ 成員名單表

---

## 第 3 步：部署

1. 在 Apps Script 編輯器中，點擊左上角 **部署** → **新增部署**
2. 點擊 ⚙ 齒輪 → 選擇 **網頁應用程式**
3. 填寫設定：
   - **描述：** 深資童軍進度追蹤
   - **執行身分：** 我
   - **存取權：** 任何人
4. 點擊 **部署**
5. 複製產生的 **網頁應用程式網址**

```
https://script.google.com/macros/s/XXXXXXXXX/exec
```

---

## ✅ 完成！接下來要做什麼？

把你得到的兩個資訊交給**系統管理員**：

| 資訊 | 說明 |
|------|------|
| Apps Script URL | 第 3 步複製的網址 |
| API Key | 第 2 步顯示的 Key |

管理員會幫你設定好，之後給你一個連結就能用。

---

## 🎉 如何使用？

管理員設定好後，會給你一個連結，例如：

```
https://vsbadge.vercel.app/?u=0082
```

直接打開這個連結就能用了！建議加入書籤。

### 獨立使用（不接入主系統）

直接打開：
```
https://vsbadge.vercel.app/
```

會顯示旅團選擇列表，選擇你的旅團後就能使用。

### 接入主系統

如果管理員幫你接入了主系統，從 Dashboard 的元件卡片進入，身份會自動帶入，更方便。

---

## 🆘 常見問題

**Q: 授權失敗？**
A: 確保你用建立 Sheet 的同一個 Google 帳號。

**Q: 顯示「無法連接後端」？**
A: 確認 Apps Script 已部署為「網頁應用程式」且存取權設為「任何人」。

**Q: 忘記 API Key？**
A: 在 Apps Script 編輯器中，選擇 `showApiKey` 函式，點擊 ▶ **執行**，會再次顯示 API Key。

**Q: 其他裝置要用怎麼辦？**
A: 使用管理員給你的連結就能在任何裝置上使用，不需要額外設定。

**Q: 資料安全嗎？**
A: 資料存在你自己建立的 Google Sheet 裡，只有你能存取。API Key 是自動生成的隨機字串，防止別人隨便存取你的 Sheet。

---

## 📞 需要幫助？

- 取得 `Code.gs`：聯絡系統管理者
- 設定問題：參考本指南或聯絡系統管理者

---

## 📝 你需要交給管理員的資訊

完成部署後，請把以下資訊交給系統管理員：

| 資訊 | 說明 | 哪裡找 |
|------|------|--------|
| Sheet ID | 你的 Google Sheet ID | Sheet 網址 |
| API Key | 自動生成的密鑰 | 執行 initializeSheets 時顯示 |
| Apps Script URL | 部署後的網址 | Apps Script 部署設定 |

**建議：** 把這三個資訊記在安全的地方，忘記時可以找回。
