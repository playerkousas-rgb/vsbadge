# 🗺️ 部署雙軌指南 - 有主系統 vs 無主系統

> 有主系統 ≠ 一定要接上，可自由選擇

## 主系統平台是什麼？

**scoutsystem-2.0** 是深資童軍進度追蹤以外的更龐大平台：

- Dashboard 儀表板
- 成員管理 (全旅團名單、YMIS、家長)
- 集會考勤 QR Code
- 財務管理
- 活動報名
- 插件市場 (本系統是 Tier 3 插件之一)

本系統可獨立用，也可作為插件一鍵接入主系統，享受單一登入。

## 兩條軌道

**共通**：下載 Code.gs → 建 Sheet → 執行 initializeSheets → 部署 → 複製 URL+API Key

**軌道A 無主系統/有但想獨立用**：
- 將 URL+API Key 交 vsbadge 管理員 → 加入 troops.json → 完成
- 用法：vsbadge.vercel.app → 選旅團 → 登入
- 優點：簡單

**軌道B 有主系統並想接上**：
- 同樣交 vsbadge 管理員
- 額外：交主系統管理員填入旅團設定→元件設定 backend+apikey
- 用法：主系統 Dashboard 點卡片 → 自動帶入身份 from=portal&embed=1 → 直接用
- 優點：單一登入

兩條路可同時用。

## 為何要告訴用家有主系統？

讓只用 vsbadge 的旅團知道，原來有更大平台可同時使用，Dashboard、考勤、財務等更多功能。

## 詳細步驟見 DEPLOY_GUIDE_FOR_TROOPS.md
