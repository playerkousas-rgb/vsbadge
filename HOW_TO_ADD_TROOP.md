#  如何新增旅團到系統

> 管理員專用：當新旅團完成部署後，使用本指南將旅團加入系統。

---

## 需要準備的資訊

從新旅團取得以下 3 項資訊：

| 資訊 | 說明 | 範例 |
|------|------|------|
| 旅團編號 | 旅團的唯一識別碼 | `0082` |
| 旅團名稱 | 顯示在系統中的名稱 | `第 82 旅` |
| Apps Script URL | 旅團部署的 Apps Script 網址 | `https://script.google.com/macros/s/XXXX/exec` |
| API Key | 旅團執行 initializeSheets 時生成的 Key | `vs_xxxxxxxxxxxxxxxx` |

---

## 步驟 1：編輯 troops.json

打開 `troops.json` 檔案，在 `troops` 物件內新增旅團資料：

```json
{
  "troops": {
    "0082": {
      "name": "第 82 旅",
      "backend": "https://script.google.com/macros/s/XXXX/exec",
      "apikey": "vs_xxxxxxxxxxxxxxxx"
    },
    "0123": {
      "name": "第 123 旅",
      "backend": "https://script.google.com/macros/s/YYYY/exec",
      "apikey": "vs_yyyyyyyyyyyyyyyy"
    }
  }
}
```

### JSON 格式說明

```json
{
  "troops": {
    "旅團編號": {
      "name": "旅團名稱",
      "backend": "Apps Script URL",
      "apikey": "API Key"
    }
  }
}
```

### 注意事項

1. **旅團編號**：使用字串格式（加引號），例如 `"0082"` 而非 `0082`
2. **逗號**：每個旅團物件之間用逗號分隔，**最後一個旅團後面不要加逗號**
3. **引號**：所有欄位值都要用雙引號包起來
4. **格式驗證**：可以用 [JSONLint](https://jsonlint.com/) 驗證格式是否正確

---

## 步驟 2：提交到 GitHub

```bash
git add troops.json
git commit -m "新增旅團：第 XXX 旅"
git push
```

Vercel 會自動重新部署，新旅團就能使用了。

---

## 步驟 3：通知旅團

告訴旅團：「設定完成，可以打開以下連結使用：」

```
https://vsbadge.vercel.app/?u=旅團編號
```

例如：
```
https://vsbadge.vercel.app/?u=0082
```

---

##  完整範例

### 範例 1：新增單一旅團

**原檔案：**
```json
{
  "troops": {}
}
```

**新增後：**
```json
{
  "troops": {
    "0082": {
      "name": "第 82 旅",
      "backend": "https://script.google.com/macros/s/AKfycbxXXX/exec",
      "apikey": "vs_181790d954f24213abe53834"
    }
  }
}
```

---

### 範例 2：新增第二個旅團

**原檔案：**
```json
{
  "troops": {
    "0082": {
      "name": "第 82 旅",
      "backend": "https://script.google.com/macros/s/AKfycbxXXX/exec",
      "apikey": "vs_181790d954f24213abe53834"
    }
  }
}
```

**新增後：**
```json
{
  "troops": {
    "0082": {
      "name": "第 82 旅",
      "backend": "https://script.google.com/macros/s/AKfycbxXXX/exec",
      "apikey": "vs_181790d954f24213abe53834"
    },
    "0123": {
      "name": "第 123 旅",
      "backend": "https://script.google.com/macros/s/AKfycbxYYY/exec",
      "apikey": "vs_abcdefghijklmnop12345678"
    }
  }
}
```

**注意：** 第 82 旅後面加了逗號，因為後面還有第 123 旅。

---

##  常見問題

**Q: JSON 格式錯誤怎麼辦？**
A: 使用 [JSONLint](https://jsonlint.com/) 檢查，常見錯誤：
- 缺少逗號
- 多餘逗號（最後一個物件後面不能有逗號）
- 引號使用錯誤（要用雙引號 `"` 不是單引號 `'`）

**Q: 旅團編號可以重複嗎？**
A: 不可以，每個旅團編號必須唯一。

**Q: 可以刪除旅團嗎？**
A: 可以，從 JSON 中移除該旅團的資料即可。

**Q: 修改後多久生效？**
A: 提交到 GitHub 後，Vercel 會在 1-2 分鐘內自動重新部署。

---

## 📋 旅團部署檢查清單

在加入旅團前，確認旅團已完成：

- [ ] 建立 Google Sheet
- [ ] 下載並貼上 Code.gs
- [ ] 設定 SHEET_ID
- [ ] 執行 initializeSheets（會生成 API Key）
- [ ] 部署為網頁應用程式（存取權設為「任何人」）
- [ ] 複製 Apps Script URL 和 API Key
- [ ] 提交給管理員

---

*本文件適用於 scoutsystem-2.0 主系統的旅團管理員。*
