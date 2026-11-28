# Agent Chat：給 Claude Code 的專案說明

本機執行的 Node.js 網頁介面（零相依套件），在背後呼叫 Claude Code、Codex、Google Antigravity（agy）三種 CLI，讓多位成員分工、互相 @、走工作流程，並可用 Telegram 遙控。使用者用**繁體中文**溝通，主要環境是 **Windows**（PowerShell）。回覆與 UI 文字請用繁體中文。

**接手時先讀 `HANDOVER.md`**：最近一段升級（v3.8～v3.11）的狀態、哪些還沒在 Windows 實測、設計地雷與使用者偏好。

## 檔案地圖
- `server.js` 後端：啟動 CLI、解析輸出、SSE 推送、API；`tasks.js` 工作流程；`harness.js` 守則／檢查／預算／記憶；`timers.js` 排程；`telegram.js` 遙控
- `rtkhook.js` rtk 的 Claude hook 外層（只採用改寫、拿掉自動核准；由 `--settings` 檔呼叫，server.js 不 require 它）
- `caps.js` 🔐 成員的實際能力（`caps.of(agent)` → write／exec／acts／label）：任務交接核准、LINE 群組檢查（`groupRisk`）、權限畫面共用，照 CLI 實際會怎麼跑（含預設值）判斷；新增「可不可以動手」的判斷一律用它
- `agy.js` Google agy 的參數、權限對應、stream-json 解析；`security.js` 路徑與權限檢查
- `todo.js` 📋 部門待辦：解析模型的動作行（`【待辦】新增｜事項=…`、`【選項】`）、權限（成員／主管）、呼叫 Apps Script、組給模型看的「目前待辦清單」；`templates/todo/Code.gs` 是貼進使用者 Google Sheet 的 Apps Script（寫表＋每日寄信）。模型是 agy 唯讀、**不執行任何指令、也不讀寫檔**（`agy.NO_FILES_NOTE`），寫入一律由系統做；`isTodoKeeper(agent)`＝成員有 `todoKeeper` 旗標或是 LINE 群組對象，網頁對話（`opts.todoWeb`）與 LINE 群組都會附清單並由系統代寫（網頁＝管理員／主管）
- `line.js` 💚 LINE bot：獨立連接埠的 webhook（驗簽章）、配對、reply／push、cloudflared 一鍵通道；設定畫面「💚 LINE」。👥 群組人員核准（核心）：`line.people`（agents.json，`isKnown`／`requestPerson`／`decidePerson`），陌生人不交給 AI、通知管理者（hook `line-person`、Telegram `/line`、LINE 私聊「核准成員 N」、`/api/line/people/:uid`）；群組 dispatch 帶 `trust: 'group'`，server.js close handler 依信任等級（不是管道名稱）擋轉交／【決策】／提案。👤 **使用者權限是唯一依據**（v3.43.0）：`line.people[uid]`＝{ name、named、role（成員／主管）、status（ok／wait／no＝停用）、dm、lineName }，管理者＝`allowedUserIds`（一律主管，名字在 `ownerNames`）；`identity(uid)`／`setPersonRole`（同步 `todo.setRole` 寫回 Sheet）；待辦的 `todoWho` 以這裡的姓名與角色為準，Sheet 只補 email；同事一對一 `handleColleagueDm`（`canDm`，群組成員回應、`trust: 'group'`、`scope: 'ld:<uid>'`、`line.colleague`）。`LINE_API_BASE`、`LINE_PORT`、`CLOUDFLARED_BIN` 可換（測試用）
- `templates/roles/*.md` 🎭 成員範本（front-matter＋人設；`data/roles/` 可覆蓋），由 server.js `loadRoleTemplates()`／`/api/roles` 提供，前端 `ROLES` 產生按鈕。LINE 群組通用：`groupAgentId`＋`groupWords`；待辦流程只看成員的 `todoKeeper`（`isTodoKeeper`），不認名字
- `docs.js` 📚 文件資料夾：主程式唯讀讀資料夾（本機／內網 UNC）裡的 html → 切段、文字快取 `data/docs/.index/`（照 mtime 增量、`tick()` 每 10 分鐘）→ 依問題線性比對（英文字、數字〔整個相符〕、中文 2-gram；路徑／檔名對到加分；`章節號: USP_{n}_` 先篩路徑；`排除:` 路徑片段跳過）→ `context(agent, text)` 附段落（【】換〔〕）。設定 `data/docs/<名稱>.md`＝`路徑:`＋使用規則（v3.45；`parseDocMd` → `rule`，副檔名 `SUPPORTED`：html／htm／txt／md、更新間隔、排除、附上時機…）；成員人設 `## 文件資料夾：名稱` 是覆蓋（`ruleFor(agent, n)`＝人設段落優先、否則 `tableRule(n)`；`parseDocSections`；`todo.stripSourceSections` 一併從開頭說明拿掉）；`create({ rulesFor })` 取各成員規則：副檔名聯集、間隔取最短，搜尋再依成員自己的副檔名過濾。根目錄要在 `DOC_ALLOWED_ROOTS`／`AGENT_ALLOWED_ROOTS`、不能是程式資料夾；只收 .html／.htm、跳過符號連結。server.js `refCtx(agent, text, meta)`＝資料表＋文件資料夾＋稽核（`type: 'docs'`），網頁對話與 line.js `srcCtx` 共用；`agent.docFolders`、`/api/docs*`
- `xlsx.js` 📊 零相依讀 .xlsx（zip＋XML、刪除線、日期、`pickSheet` 分頁關鍵字）：唯讀資料表是 Excel 檔時，Apps Script（`Code.gs` 的 `opReadSource_`）`openByUrl` 失敗就用 DriveApp 原檔下載 base64，`todo.js` 的 `readSource` 解析；資料表 `data/sources/*.md`＝front matter 怎麼讀（網址、分頁、標題列）＋ body 判讀規則（v3.45；`parseSourceProfile` 用 `parseRuleLines` 解析 body、`renderSourceMd({ rules })`、`formFromProfile`／`rulesBodyFromProfile`）；成員人設 `## 資料表：名稱` 是覆蓋（`sourcesContext`：`own.get(n) || conn`；`parseSourceSections`、`stripSourceSections`、`mergeProfile` → `profileSummary`／`openCasesSummary`；範例 `templates/rules/`）。升級遷移 `rulesToTableMigrated`（server.js `takeSection`：人設段落搬到表的設定檔，一樣的從人設拿掉、不一樣的留著）
- 📄 成員設定檔 `data/agents/<名稱>.md`（`agent.configMd`；server.js 的 `renderAgentMd`／`parseAgentMd`／`syncAgentMds` 每 3 秒比對修改時間，`AGENT_MD_POLL_MS` 可調）：人設、職責、唯讀資料表、勾選項目、群組呼叫詞；網頁儲存寫回、改前備份到 `.backup/`。安全設定（引擎、權限、資料夾、密鑰）不放進去
- `maint.js` 🔧 維運：`agent.maintains`（照顧哪些成員）；`contextFor` 附設定檔／錯誤回報／稽核紀錄（server.js `startRun` 注入、hash 去重）；回覆裡的「【修改設定檔】」→ `state.mdProposals` 提案 → 核准才寫入（`/api/md-proposals`、Telegram `/md`、hook `md-proposal`），寫前備份、檔案 hash 不同就拒絕
- 🐞 錯誤回報：`data/feedback.jsonl`（只增不改，`addFeedback`，bot 回覆存 3000 字）＋處理狀態 `state.feedbackStatus`（`setFeedbackStatus`）；`/api/feedback`、側邊欄「🐞 錯誤回報」、Telegram `/fb`
- `afterturn.js` ⚙️ 每輪結束後執行（沙箱外，獨立成員）：`agent.afterTurn`（command／args／ifChanged／timeoutSec／pin＋`approvedHash`／`approvedFiles`）；`startRun` 呼叫 `before()` 記下監看檔，`done` hook 呼叫 `after()`；同成員單一執行＋合併；🔒 指紋不符就不執行（`/api/agents/:id/afterturn/approve` 重新核准）；結果 `appendAudit` 寫稽核紀錄，失敗用 `logExchange` 提示
- `skills.js` 🧩 Skill：成員回覆【安裝 Skill】→ 下載 GitHub tar.gz（`SKILL_TARBALL_BASE` 可換，測試用）→ 檢查（檔案、腳本）→ 使用者核准 → 複製到 `.claude/skills`；移除＝搬到 `data/skills-trash`
- `outbox.js` 📮 通知補送：LINE／Telegram 第一次直接送，暫時性失敗（連不上、5xx、Telegram 429）才 `outbox.add()` 存進 `state.outbox`，背景退避重送；頻道由各模組 `register('line'|'tg:main'|'tg:<成員id>', fn)`。待辦寫入用 `opId` 冪等（`todo.js` 的 `write()`＋`Code.gs` 的 CacheService）
- `clistatus.js` 🧰 CLI 狀態頁（登入、MCP、成員用得到哪些；只看不改，只跑不耗額度的查詢指令，不回傳指令參數／網址／金鑰）
- `diag.js`／`updater.js`／`launcher.js`／`localsettings.js`／`proctree.js` 問題回報、一鍵更新、啟動器（結束碼 75＝重新啟動）、個人設定、子程式樹關閉
- `public/index.html` 單檔前端（內嵌 script）、`public/office.js` 辦公室畫面
- `tests/*.test.js` 每個檔案獨立執行；詳細說明在 README.md、CHANGELOG.md

## 開發慣例
- 不加任何 npm 相依套件；Node 18+。
- **跑測試**：逐檔跑 `node --test tests/xxx.test.js`（`node --test tests/` 會失敗）。全部：`for f in tests/*.test.js; do node --test $f; done`。目前 28 檔全過。
- 測試會把原始碼複製到暫存資料夾跑真的伺服器：清單由 `tests/_files.js` 自動列出 repo 根目錄所有 `.js`（`copyServer(dir, [其他檔案])`），新增模組**不用**再改測試檔；非 .js 的檔案（例如 `agents.example.json`、`templates/…`）才要在呼叫時列出。
- 測試用「假 CLI」（`tests/*.test.js` 裡的 MOCK_*）加真的伺服器，環境變數：`CLAUDE_BIN`／`CODEX_BIN`／`AGY_BIN`、`AGENTCHAT_NO_UPDATE_CHECK=1`、`AGENT_ENV_ALLOWLIST`。
- 發版：同步改 `server.js` 的 `VERSION`、`public/index.html` 的 `UI_VERSION`、`CHANGELOG.md`（最上面加一節）、必要時 `README.md`；commit 訊息用「v3.x.y：做了什麼」；推到 `main`。使用者在網頁按「⬆️ 更新／重新啟動」取得新版（updater 遇到已追蹤檔案被改動會拒絕更新，所以**開發請用另一個 clone，不要直接改正在跑的那個資料夾**）。
- `start.bat` 只能有 ASCII（cmd 讀 UTF-8 中文會出錯）；個人設定放 `local-settings.txt`（不進 git）。
- 前端的視窗（modal）關閉只是隱藏，內容還在 DOM：收到 SSE 要重畫某個視窗時，用 `modalShowing(id)` 判斷，不要只看元素在不在（否則視窗會自己跳出來）。
- 前端沒有建置步驟；改完 `public/index.html` 用抽出 `<script>` 後 `node --check` 檢查語法。
- 安全底線：永不加入會略過權限的選項（`--dangerously-skip-permissions`、`bypassPermissions`）；使用者資料夾存取由 `security.js` 的允許清單管；機密不寫進回報（diag.js 會遮蔽）。

## 已完成（近期）
v3.4 小組＋多房間辦公室、v3.5 守則分範圍、v3.6 問題回報與一鍵更新、v3.7 排程（前置檢查、成員暫停）、v3.8 緊急派工（【緊急】插話，授權＋冷卻）＋ Google agy 引擎（`read`／`write` 存取等級）、v3.9 上下文瘦身（開頭說明去重、📏 上下文用量、排程每次新對話、換班門檻 40%）、v3.10 暫停／重啟專案（`state.pause`、`isHeld` 擋自動派工、交班筆記、重啟接續）＋排隊訊息存檔（`state.queue`）、v3.11 rtk 壓縮指令輸出（只限 Claude 團隊成員，`--settings` ＋ `rtkhook.js`）、v3.11.1 更正 agy write 說明、v3.11.2 常用守則範本（markitdown）、v3.12 agy 額度用完偵測（`state.agyQuota`、`agyQuotaCheck`、退回並通知派工者）＋本週用量（`state.agyUsage`）、v3.12.1 agy write 資料夾警告＋`AGY_WRITE_ARGS`、v3.13 🧰 CLI 狀態頁（`clistatus.js`、`/api/clistatus`、`state.cliSeen`）、v3.14 🧩 Skill 安裝（`skills.js`、`state.skillReqs`、`/api/skills`、Telegram `/skill`）＋修正排程視窗自己跳出（`modalShowing`）、v3.15 🗓 助理（個人秘書：預設範本按鈕、`agent.brief` 現況摘要 `briefText()`、`timers.parsePhrase` 支援單次時間、提出排程後有回饋）、v3.17 💚 LINE（`line.js`、`/api/line`、done 事件帶 `line`）＋token 欄改 `SECRET_ATTR`（避免密碼管理員誤填）、v3.18 📋 部門待辦（LINE 群組＋Google Sheet：`todo.js`、`templates/todo/Code.gs`、`/api/todo`、群組 @ 觸發與配對、`opts.shown`）、v3.32 📮 通知補送 outbox（`outbox.js`、`/api/outbox`）＋ LINE 事件編號存檔＋待辦寫入冪等（`opId`，Apps Script 1.0.8）、v3.33 👥 專屬 Telegram bot 收群組＋【傳訊者：名稱】（`agent.telegram.names`／`groups`，`telegram.js` 的 `senderName`）、v3.41 審查修正第一批（`caps.js`；LINE 群組那一輪不轉交、不收【決策】與提案）、v3.41.1 👥 LINE 群組人員核准＋信任等級 `opts.trust`、v3.41.2 每輪結果 `run.outcome`（只有 ok 才推進任務／寫待辦／afterturn／轉交；close handler 包 `onClose().catch` 一定收尾）＋最後階段核准（`pending.final`）＋排程前置檢查指紋（`afterturn.commandPin`、`t.precheckPin`、`/api/timers/:id/repin`、`timers.approvalText` 三個管道共用）、v3.42.0 狀態檔原子寫入＋壞檔保留／`.bak` 還原並全部暫停（`writeFileAtomic`、`stateRecovered`、hook `state-recovered`）＋對話紀錄 `.jsonl`（`migrateHistory`）＋對話範圍 `opts.scope`（`lg:<群組>`／`tg:<群組>`，`sessionKey`、`recentTurnsText(agent, scope)`；複製 opts 重新派工時要帶 `scope`、`trust`）、v3.42.1 🔒 網頁閒置上鎖（`security.touch`／session `la`、`IDLE_LOCK_MIN` 預設 10；只有 `/api/auth/touch` 與 POST/PUT/DELETE 算操作，GET 輪詢不算；前端 `startIdleLock`／`lockScreen`、`body.locked`）、v3.42.2 🔑 網頁修改密碼（`security.changePassword`、`/api/auth/password`；雜湊檔 v2＝scrypt 加鹽，v1 SHA-256 仍可讀；改後 `sessions.clear()` 只留這個瀏覽器；`ACCESS_TOKEN` 設定的回 409）、v3.43.0 👤 LINE 使用者權限頁（唯一依據）＋同事一對一、v3.44.0 📚 文件資料夾（`docs.js`）、v3.44.2 副檔名與更新間隔改寫在人設段落（表單只剩路徑）、v3.44.3 路徑加分＋數字整個相符＋`排除:`、v3.45.0 判讀規則回到表格／資料夾自己的設定檔（人設段落＝覆蓋）、v3.46.0「我的待辦」系統先篩（`todo.mineSection`，`context()` 放在完整清單前）＋網頁發言者＝管理者在 LINE 權限頁登記的姓名（`todo.webOwner(CONFIG.line)`，server.js `webOwner()`）、v3.46.1 💻 網頁上的我是（`line.webPerson`、`setWebPerson`、`/api/line/web-person`；webOwner 優先順序：webPerson → 有姓名的管理者 → 管理員）＋使用者權限表一人一列、「身分」成員／主管／管理者（`setPersonRole(uid, role, by, { web: true })` 才能設定／取消管理者＝`allowedUserIds`）＋啟動時 `syncOwnerRoles` 把管理者在 Sheet 同步成主管、v3.46.2 管理者 LINE 一對一（`isKeeper`）也附清單＋`onDone` 非 shared 也執行動作行、網頁讀清單失敗直接 `logExchange` 顯示、稽核輸入可展開（16000 字）、v3.46.3 docs 掃描最短間隔 1 分鐘（`MIN_GAP_MS`，`DOC_MIN_SCAN_GAP_MS` 測試用；force 例外）＋沒變動不印日誌、日誌帶觸發原因 `reason`。偵測規則 `agy.quotaHit`／`quotaReset` 是依常見寫法，待拿到真實 agy 額度錯誤訊息校正。

## agy 實測事實（Windows，agy 1.5.10，免費 Starter Quota）
- 安裝位置 `%LOCALAPPDATA%\agy\bin\agy.exe`；免費帳號可用模型：`gemini-3.8-flash-{high,medium,low}`、`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`（**沒有** gemini-4-argon）。
- 用 stdin 傳 `{"event":"user","message":{"content":"..."}}\n` 搭配 `--input-format stream-json --output-format stream-json` 可行；**PowerShell 的管線會加 BOM（`﻿`）導致解碼失敗**，手動測試要用 `cmd /c "type x.json | agy ..."`（Node 直接寫 stdin 沒有 BOM）。
- 事件：`init`（含 model）→ `step_update`（agent_response 的 `text_delta` 是片段，最後一筆 DONE 只有 `"\n"`；tool 步驟名稱 `read_file`／`write_file`／`run_command`，參數 `Path`／`CommandLine`）→ `result`（status、response、usage）。
- `--mode plan --sandbox`：請它審查檔案時，意見完整出現在回覆裡、不建檔（唯讀可用）；請它建檔時不會寫到工作資料夾，只會把 `plan.md` 寫到 `~\.gemini\antigravity-cli\brain\...`。
- **預設模式（不加 --mode）可以寫檔，也真的能執行 `run_command`**（結束碼 0）——之前依文件寫的「可寫等級不能執行指令」是錯的。

## 待辦
1. **agy 可寫等級**：「不能執行指令」的錯誤說法已在 v3.11.1 更正（`WRITE_NOTE`、`AGY_LABEL`、README、CHANGELOG）。尚待實測「預設模式＋`--sandbox`」能否把寫檔／指令限制在工作資料夾內，以及 plan 模式能否擋住 `run_command`（要在 cmd 跑 E／F 兩組測試）；`AGY_WRITE_ARGS`（預設空）與「資料夾在 Agent Chat 裡」警告（`agyWriteRisk`）已在 v3.12.1 加入；定案後決定 `WRITE_DEFAULT` 是否改成 `--sandbox`，並更新說明。測試腳本見 HANDOVER。
2. ~~工具結果的結束碼判斷~~（v3.41.2 已修：regex 也認 `exited with code N`）。
3. 還沒在真實 Windows 環境完整驗證：🧰 CLI 狀態頁（`claude mcp list`／`codex mcp list --json`／`codex login status` 在使用者版本的實際輸出、`.claude.json` 的 oauthAccount、agy MCP 設定位置）、rtk hook 經 `--settings` 在 Windows 上是否生效（Claude 用 Git Bash 或 PowerShell 工具時 matcher 是否要加 PowerShell）、一鍵更新、排程配真實 CLI、Codex rollout token 解析、`--allowedTools` 比對。
4. 路線圖（依「Agent Demo → Platform」文章排的順序）：🧵 任務執行追蹤（每輪工具呼叫／結果／結束碼用 taskId 串起來）→ 🧪 小型評測集（固定題目＋檢查腳本，改人設／換模型前後比較）→ ✅ 統一「待核准」收件匣＋風險分級；另有 Telegram 連續訊息合併成一個提示；唯讀的「🧰 能力一覽」（各成員實際用得到的 MCP／Skill，不做編輯介面）；不可改寫的執行紀錄（雜湊串接）與機密保管遮蔽。
