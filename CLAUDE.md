# Agent Chat：給 Claude Code 的專案說明

本機執行的 Node.js 網頁介面（零相依套件），在背後呼叫 Claude Code、Codex、Google Antigravity（agy）三種 CLI，讓多位成員分工、互相 @、走工作流程，並可用 Telegram 遙控。使用者用**繁體中文**溝通，主要環境是 **Windows**（PowerShell）。回覆與 UI 文字請用繁體中文。

**接手時先讀 `HANDOVER.md`**：最近一段升級（v3.8～v3.11）的狀態、哪些還沒在 Windows 實測、設計地雷與使用者偏好。

## 檔案地圖
- `server.js` 後端：啟動 CLI、解析輸出、SSE 推送、API；`tasks.js` 工作流程；`harness.js` 守則／檢查／預算／記憶；`timers.js` 排程；`telegram.js` 遙控
- `rtkhook.js` rtk 的 Claude hook 外層（只採用改寫、拿掉自動核准；由 `--settings` 檔呼叫，server.js 不 require 它）
- `agy.js` Google agy 的參數、權限對應、stream-json 解析；`security.js` 路徑與權限檢查
- `todo.js` 📋 部門待辦：解析模型的動作行（`【待辦】新增｜事項=…`、`【選項】`）、權限（成員／主管）、呼叫 Apps Script、組給模型看的「目前待辦清單」；`templates/todo/Code.gs` 是貼進使用者 Google Sheet 的 Apps Script（寫表＋每日寄信）。模型是 agy 唯讀、**不執行任何指令、也不讀寫檔**（`agy.NO_FILES_NOTE`），寫入一律由系統做；`isTodoKeeper(agent)`＝成員有 `todoKeeper` 旗標或是 LINE 群組對象，網頁對話（`opts.todoWeb`）與 LINE 群組都會附清單並由系統代寫（網頁＝管理員／主管）
- `line.js` 💚 LINE bot：獨立連接埠的 webhook（驗簽章）、配對、reply／push、cloudflared 一鍵通道；設定畫面「💚 LINE」。`LINE_API_BASE`、`LINE_PORT`、`CLOUDFLARED_BIN` 可換（測試用）
- `templates/roles/*.md` 🎭 成員範本（front-matter＋人設；`data/roles/` 可覆蓋），由 server.js `loadRoleTemplates()`／`/api/roles` 提供，前端 `ROLES` 產生按鈕。LINE 群組通用：`groupAgentId`＋`groupWords`；待辦流程只看成員的 `todoKeeper`（`isTodoKeeper`），不認名字
- `xlsx.js` 📊 零相依讀 .xlsx（zip＋XML、刪除線、日期、`pickSheet` 分頁關鍵字）：唯讀資料表是 Excel 檔時，Apps Script（`Code.gs` 的 `opReadSource_`）`openByUrl` 失敗就用 DriveApp 原檔下載 base64，`todo.js` 的 `readSource` 解析；設定檔 `data/sources/*.md`（`parseSourceProfile`：到期模式 `profileSummary`、未結案模式 `openCasesSummary`）
- 📄 成員設定檔 `data/agents/<名稱>.md`（`agent.configMd`；server.js 的 `renderAgentMd`／`parseAgentMd`／`syncAgentMds` 每 3 秒比對修改時間，`AGENT_MD_POLL_MS` 可調）：人設、職責、唯讀資料表、勾選項目、群組呼叫詞；網頁儲存寫回、改前備份到 `.backup/`。安全設定（引擎、權限、資料夾、密鑰）不放進去
- `maint.js` 🔧 維運：`agent.maintains`（照顧哪些成員）；`contextFor` 附設定檔／錯誤回報／稽核紀錄（server.js `startRun` 注入、hash 去重）；回覆裡的「【修改設定檔】」→ `state.mdProposals` 提案 → 核准才寫入（`/api/md-proposals`、Telegram `/md`、hook `md-proposal`），寫前備份、檔案 hash 不同就拒絕
- 🐞 錯誤回報：`data/feedback.jsonl`（只增不改，`addFeedback`，bot 回覆存 3000 字）＋處理狀態 `state.feedbackStatus`（`setFeedbackStatus`）；`/api/feedback`、側邊欄「🐞 錯誤回報」、Telegram `/fb`
- `skills.js` 🧩 Skill：成員回覆【安裝 Skill】→ 下載 GitHub tar.gz（`SKILL_TARBALL_BASE` 可換，測試用）→ 檢查（檔案、腳本）→ 使用者核准 → 複製到 `.claude/skills`；移除＝搬到 `data/skills-trash`
- `outbox.js` 📮 通知補送：LINE／Telegram 第一次直接送，暫時性失敗（連不上、5xx、Telegram 429）才 `outbox.add()` 存進 `state.outbox`，背景退避重送；頻道由各模組 `register('line'|'tg:main'|'tg:<成員id>', fn)`。待辦寫入用 `opId` 冪等（`todo.js` 的 `write()`＋`Code.gs` 的 CacheService）
- `clistatus.js` 🧰 CLI 狀態頁（登入、MCP、成員用得到哪些；只看不改，只跑不耗額度的查詢指令，不回傳指令參數／網址／金鑰）
- `diag.js`／`updater.js`／`launcher.js`／`localsettings.js`／`proctree.js` 問題回報、一鍵更新、啟動器（結束碼 75＝重新啟動）、個人設定、子程式樹關閉
- `public/index.html` 單檔前端（內嵌 script）、`public/office.js` 辦公室畫面
- `tests/*.test.js` 每個檔案獨立執行；詳細說明在 README.md、CHANGELOG.md

## 開發慣例
- 不加任何 npm 相依套件；Node 18+。
- **跑測試**：逐檔跑 `node --test tests/xxx.test.js`（`node --test tests/` 會失敗）。全部：`for f in tests/*.test.js; do node --test $f; done`。目前 24 檔全過。
- 新增 `.js` 模組時，要把檔名加進**每個測試檔的 FILES／檔案清單**（它們會把原始碼複製到暫存資料夾跑真的伺服器），否則 `require` 找不到。
- 測試用「假 CLI」（`tests/*.test.js` 裡的 MOCK_*）加真的伺服器，環境變數：`CLAUDE_BIN`／`CODEX_BIN`／`AGY_BIN`、`AGENTCHAT_NO_UPDATE_CHECK=1`、`AGENT_ENV_ALLOWLIST`。
- 發版：同步改 `server.js` 的 `VERSION`、`public/index.html` 的 `UI_VERSION`、`CHANGELOG.md`（最上面加一節）、必要時 `README.md`；commit 訊息用「v3.x.y：做了什麼」；推到 `main`。使用者在網頁按「⬆️ 更新／重新啟動」取得新版（updater 遇到已追蹤檔案被改動會拒絕更新，所以**開發請用另一個 clone，不要直接改正在跑的那個資料夾**）。
- `start.bat` 只能有 ASCII（cmd 讀 UTF-8 中文會出錯）；個人設定放 `local-settings.txt`（不進 git）。
- 前端的視窗（modal）關閉只是隱藏，內容還在 DOM：收到 SSE 要重畫某個視窗時，用 `modalShowing(id)` 判斷，不要只看元素在不在（否則視窗會自己跳出來）。
- 前端沒有建置步驟；改完 `public/index.html` 用抽出 `<script>` 後 `node --check` 檢查語法。
- 安全底線：永不加入會略過權限的選項（`--dangerously-skip-permissions`、`bypassPermissions`）；使用者資料夾存取由 `security.js` 的允許清單管；機密不寫進回報（diag.js 會遮蔽）。

## 已完成（近期）
v3.4 小組＋多房間辦公室、v3.5 守則分範圍、v3.6 問題回報與一鍵更新、v3.7 排程（前置檢查、成員暫停）、v3.8 緊急派工（【緊急】插話，授權＋冷卻）＋ Google agy 引擎（`read`／`write` 存取等級）、v3.9 上下文瘦身（開頭說明去重、📏 上下文用量、排程每次新對話、換班門檻 40%）、v3.10 暫停／重啟專案（`state.pause`、`isHeld` 擋自動派工、交班筆記、重啟接續）＋排隊訊息存檔（`state.queue`）、v3.11 rtk 壓縮指令輸出（只限 Claude 團隊成員，`--settings` ＋ `rtkhook.js`）、v3.11.1 更正 agy write 說明、v3.11.2 常用守則範本（markitdown）、v3.12 agy 額度用完偵測（`state.agyQuota`、`agyQuotaCheck`、退回並通知派工者）＋本週用量（`state.agyUsage`）、v3.12.1 agy write 資料夾警告＋`AGY_WRITE_ARGS`、v3.13 🧰 CLI 狀態頁（`clistatus.js`、`/api/clistatus`、`state.cliSeen`）、v3.14 🧩 Skill 安裝（`skills.js`、`state.skillReqs`、`/api/skills`、Telegram `/skill`）＋修正排程視窗自己跳出（`modalShowing`）、v3.15 🗓 助理（個人秘書：預設範本按鈕、`agent.brief` 現況摘要 `briefText()`、`timers.parsePhrase` 支援單次時間、提出排程後有回饋）、v3.17 💚 LINE（`line.js`、`/api/line`、done 事件帶 `line`）＋token 欄改 `SECRET_ATTR`（避免密碼管理員誤填）、v3.18 📋 部門待辦（LINE 群組＋Google Sheet：`todo.js`、`templates/todo/Code.gs`、`/api/todo`、群組 @ 觸發與配對、`opts.shown`）、v3.32 📮 通知補送 outbox（`outbox.js`、`/api/outbox`）＋ LINE 事件編號存檔＋待辦寫入冪等（`opId`，Apps Script 1.0.8）、v3.33 👥 專屬 Telegram bot 收群組＋【傳訊者：名稱】（`agent.telegram.names`／`groups`，`telegram.js` 的 `senderName`）。偵測規則 `agy.quotaHit`／`quotaReset` 是依常見寫法，待拿到真實 agy 額度錯誤訊息校正。

## agy 實測事實（Windows，agy 1.5.10，免費 Starter Quota）
- 安裝位置 `%LOCALAPPDATA%\agy\bin\agy.exe`；免費帳號可用模型：`gemini-3.8-flash-{high,medium,low}`、`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`（**沒有** gemini-4-argon）。
- 用 stdin 傳 `{"event":"user","message":{"content":"..."}}\n` 搭配 `--input-format stream-json --output-format stream-json` 可行；**PowerShell 的管線會加 BOM（`﻿`）導致解碼失敗**，手動測試要用 `cmd /c "type x.json | agy ..."`（Node 直接寫 stdin 沒有 BOM）。
- 事件：`init`（含 model）→ `step_update`（agent_response 的 `text_delta` 是片段，最後一筆 DONE 只有 `"\n"`；tool 步驟名稱 `read_file`／`write_file`／`run_command`，參數 `Path`／`CommandLine`）→ `result`（status、response、usage）。
- `--mode plan --sandbox`：請它審查檔案時，意見完整出現在回覆裡、不建檔（唯讀可用）；請它建檔時不會寫到工作資料夾，只會把 `plan.md` 寫到 `~\.gemini\antigravity-cli\brain\...`。
- **預設模式（不加 --mode）可以寫檔，也真的能執行 `run_command`**（結束碼 0）——之前依文件寫的「可寫等級不能執行指令」是錯的。

## 待辦
1. **agy 可寫等級**：「不能執行指令」的錯誤說法已在 v3.11.1 更正（`WRITE_NOTE`、`AGY_LABEL`、README、CHANGELOG）。尚待實測「預設模式＋`--sandbox`」能否把寫檔／指令限制在工作資料夾內，以及 plan 模式能否擋住 `run_command`（要在 cmd 跑 E／F 兩組測試）；`AGY_WRITE_ARGS`（預設空）與「資料夾在 Agent Chat 裡」警告（`agyWriteRisk`）已在 v3.12.1 加入；定案後決定 `WRITE_DEFAULT` 是否改成 `--sandbox`，並更新說明。測試腳本見 HANDOVER。
2. 工具結果的結束碼判斷：agy 的輸出是 `Command exited with code N`，目前 server.js 的 regex 只認 `exit code N`，要補。
3. 還沒在真實 Windows 環境完整驗證：🧰 CLI 狀態頁（`claude mcp list`／`codex mcp list --json`／`codex login status` 在使用者版本的實際輸出、`.claude.json` 的 oauthAccount、agy MCP 設定位置）、rtk hook 經 `--settings` 在 Windows 上是否生效（Claude 用 Git Bash 或 PowerShell 工具時 matcher 是否要加 PowerShell）、一鍵更新、排程配真實 CLI、Codex rollout token 解析、`--allowedTools` 比對。
4. 路線圖（依「Agent Demo → Platform」文章排的順序）：🧵 任務執行追蹤（每輪工具呼叫／結果／結束碼用 taskId 串起來）→ 🧪 小型評測集（固定題目＋檢查腳本，改人設／換模型前後比較）→ ✅ 統一「待核准」收件匣＋風險分級；另有 Telegram 連續訊息合併成一個提示；唯讀的「🧰 能力一覽」（各成員實際用得到的 MCP／Skill，不做編輯介面）；不可改寫的執行紀錄（雜湊串接）與機密保管遮蔽。
