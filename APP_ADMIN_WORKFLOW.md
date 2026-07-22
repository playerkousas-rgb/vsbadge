# APP ADMIN 工作流程 - 同一個 APP 管晒所有旅團

## 你問：管理員是指向同1個APP ADMIN的對吧？

**答：係！**

- 每個支部是**獨立APP**：
  - `vsbadge.vercel.app` → 深資童軍 #8B0000
  - `roverbadge.vercel.app` → 樂行童軍 #0D47A1
  - `scoutbadge.vercel.app` → 童軍 #2E7D32
  - `cubbadge.vercel.app` → 幼童軍 #FFC107

- 每個 APP **各自**有一個 APP ADMIN (維護該 Vercel Project 的人，擁有 `SHEEP/0728` super_admin)
  - 例如 vsbadge 的 APP ADMIN 管晒所有用 vsbadge 的旅團 (0082, 0015, 0233...)
  - 唔係每個旅團開一個 Vercel，係共用同一個

## 旅團加入流程 (你講的正確)

```
[旅團 A] --\
            +--> 提交 URL + APIKEY --> [vsbadge APP ADMIN] --> 改 troops.json + 加 TROOP_XXX_APIKEY --> Redeploy
[旅團 B] --/
```

**旅團需提交：**
- 旅團編號 (如 0082)
- 名稱 (第 82 旅)
- Backend URL (/exec)
- API KEY (vs_xxxx)

**管理員做：**
1. 編輯 `data/troops.json` + `troops.json` (公開)
2. Vercel 加1個環境變數 `TROOP_0082_APIKEY=vs_xxxx` (防爬虫，不進 GitHub)
3. Redeploy

## 為何咁設計？

- **URL 不用功能變數**：backend 公開無妨，靠 `token` + `role` 防人類
- **API KEY 防爬虫**：放環境變數，避免 GitHub 被掃到，`api/troops.js` 合併後前端先拿到
- **人類靠登入防**：即使拿到 backend+apikey，無 token 都讀唔到進度
- **同一個 APP ADMIN**：方便集中維護，一個 Vercel Project 管幾十個旅團

## GS 自動生成 API KEY 已加入

`apps-script/Code.gs`:

- `getApiKey()`：若無就 `vs_` + uuid
- `showApiKey()`：隨時查看
- `initializeSheets()`：初始化完彈出 KEY + URL

## 檢查

- 超管隱藏：已實作，非 super_admin 睇唔到 sheep 帳號
- 0082R 已移除：scoutbadge 之前有殘留，已清
- vsbadge 文字殘留：roverbadge/cubbadge/scoutbadge 之前寫 vsbadge 管理員，已改為各自 app 管理員
- fallback URL 已更新為最新 https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/exec

COPYRIGHT 2026 Scout System
