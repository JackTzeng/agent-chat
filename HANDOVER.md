# 交接：Agent Chat 近版升級（v3.8 → v3.11）

寫給接手的 Claude Code。先讀 `CLAUDE.md`（專案地圖、慣例、agy 實測事實、待辦），再讀這份。
這份記的是：做到哪、哪些還沒在真實環境驗證、設計上的決定與地雷、使用者的偏好。

## 目前狀態（2026-11-18）
- `main` 在 v3.11.0。14 個測試檔在 Linux 上用假 CLI 全過（逐檔跑，見 CLAUDE.md）。
- **v3.9～v3.11 都還沒在使用者的 Windows 電腦上用真實的 Claude／Codex／agy 跑過**；使用者是在網頁按「⬆️ 更新」取得新版。
- 使用者：Jack，繁體中文，Windows（PowerShell），GMP 製藥品保／環境監控，常用手機看回覆 → 回覆要短、先講結論。工作資料不用特別擔心（他說過 GMP 資料沒關係，成員也會實際動手做事）。

## 這段做了什麼
| 版本 | 內容 | 主要位置 |
|---|---|---|
| v3.8.0 | ⚡ 緊急派工：被授權成員（預設角色含 PM）派工訊息寫【緊急】→ 中斷同組同事，先做緊急的、再自動回頭做原本的；冷卻 `urgentCooldownMin`（預設 5，0＝關）、不能反向插話、不打斷換班 | server.js `tryUrgent`、close handler 的 `run.interrupt.urgent` |
| v3.8.0～3.8.2 | 🌐 Google Antigravity（agy）引擎：`read`（`--mode plan --sandbox`，加上每輪結束比對資料夾，被改就暫停成員 `state.agyHold`）／`write`；stdin 傳 stream-json；預設模型 `gemini-3.8-flash-high` | agy.js、server.js `buildCommand`／`agyAfter` |
| v3.9.0 | 上下文瘦身：開頭說明（身分、團隊、守則、記憶）同一段對話沒變就只送一行 `HEADER_SAME`，第一輪／有變／每 N 輪（`harness.headerRefresh`，預設 10，0＝每輪送）才完整送；📏 上下文用量面板；排程預設每次新對話（`keepSession` 才接續）；換班門檻預設 60→40% | server.js `dedupHeader`／`contextLoad`、timers.js `fresh` |
| v3.10.0 | ⏸ 暫停／▶ 重啟專案（整個或單一小組）＋ Telegram `/pause` `/pausenow` `/resume`；排隊訊息存檔 `state.queue` | server.js `pauseProject`／`resumeProject`／`isHeld`／`checkPaused` |
| v3.11.0 | 🗜 rtk 壓縮指令輸出（只限 Claude 團隊成員，成員設定勾選） | server.js `rtkBin`／`rtkWanted`／`rtkSettingsFile`、rtkhook.js |

## 需要使用者在 Windows 實測的（請主動提醒他、並依結果修正）
1. **agy 可寫等級（E／F 測試）**：已知預設模式可以寫檔也能執行 `run_command`。要確認：
   - E：預設模式＋`--sandbox`，請它在工作資料夾外寫檔、執行指令，看會不會被擋。
   - F：`--mode plan`（不加 `--sandbox`）能不能擋住 `run_command`。
   - 手動測試要用 `cmd /c "type x.json | agy ..."`（PowerShell 管線會加 BOM）。
   - 定案後：修 `agy.js` 的 `WRITE_NOTE`、`public/index.html` 的 `AGY_LABEL`、README／CHANGELOG 裡「可寫等級不能執行指令」的錯誤說法；必要時 write 等級加 `--sandbox`，比照 `AGY_READONLY_ARGS` 提供 `AGY_WRITE_ARGS` 覆寫。在那之前建議使用者不要建 write 等級的 agy 成員。
2. **rtk**：`winget install rtk-ai.rtk` 後勾一位 Claude 成員，請它跑 `git status`，用 🔍 診斷確認指令變成 `rtk git status` 且沒被擋。Windows 上 Claude 可能用 PowerShell 工具而不是 Bash → 目前 matcher 只有 `Bash`，若沒生效再評估加 `PowerShell`（rtk 有 issue #1319 在處理 PowerShell）。也要確認 `--settings` 的 hook 在他的 Claude Code 版本有載入。
3. **開頭說明去重**：真實 CLI 下，成員在只收到「說明沒有變動」那一行時是否仍照守則與交接規則做事；看 📏 面板的數字。
4. **暫停／重啟**：真實成員寫交班筆記、重啟接手是否順利；程式重新啟動（⬆️ 更新）後暫停狀態與排隊訊息是否保留。
5. CLAUDE.md 待辦 3 列的其他項目（一鍵更新、排程配真實 CLI、Codex rollout token、`--allowedTools` 比對）。

## 待辦（依優先順序建議）
1. 上面的實測回報與修正（尤其 agy write 等級的說法是錯的，要改）。
2. 工具結果結束碼：agy 輸出是 `Command exited with code N`，server.js 的 regex（`/exit code[:\s]+(\d+)/i`）要也認得 `exited with code N`。
3. 守則／記憶精簡建議：依 📏 面板數字，產生合併建議給使用者核准（**只有使用者核准才改**；可考慮用免費的 Gemini 成員做摘要）。舊工具輸出遮蔽（OpenHands 的 observation masking 概念）等量測後再決定。
4. 路線圖：唯讀「🧰 能力一覽」（各成員實際用得到的 MCP／Skill，不做編輯介面）；Telegram 連續訊息合併成一個提示；通知去重／outbox；不可改寫的執行紀錄（雜湊串接）與機密保管遮蔽。

## 設計決定與地雷
- **開頭去重**：`state.hdr[sessionKey]` 存 hash／省略輪數；`fresh`（排程新對話）時要一起清。只看單輪提示詞的假 CLI 測試要在 agents.json 設 `harness.headerRefresh: 0`（harness／standalone 測試已經這樣做），否則會抓不到開頭內容。
- **暫停**：`isHeld(agent, opts)` 決定擋不擋——`from`（同事轉交）、`system`（任務系統訊息）、`resume`、`urgent`、`via:'timer'`（非手動）都擋；使用者直接傳的（網頁 `/api/chat` 沒有 `via`、Telegram `via:'telegram'`、任務回覆）不擋；`shift`（含暫停筆記 `pauseNote`）與 `restart` 永遠放行。獨立成員不受暫停影響。交班筆記門檻 `harness.pauseNoteTokens`（預設 20000，0＝都寫）。暫停中排程到點直接略過並推進 `nextRun`（不補做）；暫停時間記進任務的 `pausedMs`，不算時間預算。
- **排隊存檔**：`saveState()` 每次把 `pending` 寫進 `state.queue`；`pending` 必須宣告在 `saveState` 之前（之前踩過 TDZ）。關閉程式時先存、再設 `queueFrozen`，避免 `stopRun` 把排隊清掉。啟動 1.5 秒後 `pump()`。
- **rtk**：只在 `rtkWanted`（Claude、勾選、非獨立、沒有 `tools`／`allowedTools`）時加 `--settings data/rtk-claude-settings.json`。hook 指令是 `"node" "rtkhook.js" "rtk路徑"`（正斜線、加引號）。rtkhook.js 只保留 `updatedInput`、拿掉 `permissionDecision` 的 allow／ask（rtk 舊版會自動核准，見 rtk issue #886／#1155），deny 照擋，任何錯誤都當不改寫。注意 `--settings` 的 hooks 會和使用者的 `~/.claude/settings.json` 合併；偵測到全域 rtk hook 會在面板提醒。`RTK_BIN` 可指定位置。
- **安全底線不變**：不加 `--dangerously-skip-permissions`／`bypassPermissions`；任何新 hook 都不能放寬權限。
- **測試**：新增被 `require` 的模組要加進每個測試檔的檔案清單；rtkhook.js 沒被 require，只有 rtk.test.js 複製它。

## 使用者問過、已經給過結論的（不用重查）
- **swamp-club/swamp**：參考價值有限，沒有接。
- **MCP／Skill 管理介面**：不做編輯介面，只做唯讀「🧰 能力一覽」（待辦）。
- **其他專案怎麼管上下文**（Anthropic compaction／筆記／sub-agent、Codex AGENTS.md 32 KiB 上限與分層、OpenHands condenser、Letta 核心記憶上限、Gemini CLI 50% 就壓縮）：結論是「固定內容要有上限並看得到、早點壓縮、沒變就不重送、排程用新對話」，已落實在 v3.9。
- **Hallmark（Nutlope/hallmark，設計審美 skill，MIT）**：不放進 repo；建議使用者在電腦上 `npx skills add nutlope/hallmark -g`，給負責畫面的成員加一條守則，並可把 `sloplint.mjs` 設成該階段的自動檢查。agy 成員用不到。
- **「20 個省成本 repo」**：只有 rtk（已做成 v3.11）和 markitdown（Python，建議用守則讓成員自己轉檔）值得用；其他是 API 層快取／路由，Agent Chat 用的是 CLI 訂閱額度，插不進去，或是已有同等功能（排程前置檢查、重做上限、觀測紀錄、記憶）。
- **Agent Chat 怎麼稱呼**：不是 CLI，是包在 Claude Code／Codex／agy 外面的「多代理協作 harness／編排層」。
