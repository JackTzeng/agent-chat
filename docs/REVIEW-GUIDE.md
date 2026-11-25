# Agent Chat 程式碼與架構審查指南（v3.40.0，2026-11-25）

寫給接手做 **code review／架構審查** 的 Claude Code 視窗。先讀這份，再讀 `CLAUDE.md`（檔案地圖、慣例）、`HANDOVER.md`（v3.8～v3.11 的設計地雷，部分已舊）、`CHANGELOG.md`（每版做了什麼）。

> **這次的工作只做審查、提出建議，不要直接改 `main`。** 要改的東西整理成清單（嚴重度、位置、理由、建議做法），交給使用者決定；使用者同意後再改，或在分支上提出。

---

## 1. 這是什麼

Agent Chat 是在使用者 **Windows** 電腦本機執行的 Node.js 網頁介面。它不是 CLI 本身，而是包在 Claude Code、Codex、Google Antigravity（agy）三種 CLI 外面的「多代理協作 harness／編排層」，提供：

- 多位成員（agent）分小組、互相 @ 交接、走工作流程（任務、階段、自動檢查、時間預算）
- 守則、記憶、上下文管理（開頭說明去重、換班、交班筆記）
- 排程、暫停／重啟、緊急派工
- 遙控與通知：Telegram（主 bot＋成員專屬 bot）、LINE（官方帳號 webhook＋cloudflared 通道）、失敗重送（outbox）
- 子專案用的通用能力：📋 待辦清單（Google Sheet＋Apps Script）、📊 唯讀資料表（Google 試算表／雲端 Excel）、📄 成員設定檔 .md、🔧 維運成員（提案需核准）、⚙️ 每輪結束後指令（afterturn）、🧩 Skill 安裝、🐞 錯誤回報

**平台原則（使用者反覆強調）**：Agent Chat 是通用的 CLI 環境，不能為單一子專案（例如 LINE 群組待辦 bot、記帳員）客製；專案專屬的行為放在成員設定 .md、人設段落裡。審查時若看到「只為某個子專案服務」的程式，請標出來。

## 2. 硬限制（審查時當成需求，不要建議違反）

1. **零 npm 相依套件**，Node 18+，沒有建置步驟。前端是一個大檔 `public/index.html`（內嵌 script）＋ `public/office.js`，`public/vendor/` 只有 marked 與 DOMPurify。
2. **永不加入略過權限的選項**（`--dangerously-skip-permissions`、`bypassPermissions`、`danger-full-access`）。`security.js` 的 `DANGEROUS_MODES` 會擋。
3. repo 是**公開的**：不能提交密鑰、公司資料、真實人名、試算表 ID。
4. 主要使用環境是 Windows（PowerShell／cmd）；`start.bat` 只能有 ASCII。
5. 使用者用繁體中文，UI 文字與回覆都用繁體中文。

## 3. 規模與檔案地圖

總共約 87 萬位元組。很多行很長，所以**看位元組比看行數準**。

| 檔案 | 大小 | 角色 |
|---|---|---|
| `server.js` | 189 KB／2723 行 | 核心：HTTP 路由（一長串 `if (p === ...)`）、SSE、啟動 CLI、解析串流、狀態、成員 CRUD、上下文、暫停、排隊、用量 |
| `public/index.html` | 270 KB／2880 行 | 整個前端（modal、SSE 重畫、所有設定畫面） |
| `telegram.js` | 61 KB | 主 bot＋成員專屬 bot（long polling `getUpdates`）、指令 `/to /pause /fb /md /skill…` |
| `todo.js` | 53 KB | 待辦動作行解析、權限、呼叫 Apps Script、唯讀資料表（連線設定／判讀規則兩層）、表格摘要 |
| `line.js` | 47 KB | LINE webhook（獨立連接埠、HMAC 驗簽）、配對、群組規則、cloudflared 通道 |
| `tasks.js` | 37 KB | 工作流程：任務、階段、交接、時間預算 |
| `office.js`（public） | 29 KB | 辦公室動畫畫面 |
| `timers.js` | 459 行 | 排程（cron 式、單次、自然語言片語、前置檢查） |
| `templates/todo/Code.gs` | 415 行 | 貼進使用者 Google Sheet 的 Apps Script 1.0.10（寫表、讀唯讀來源、Excel 原檔 base64、冪等 opId） |
| `harness.js` | 378 行 | 守則（分範圍）、自動檢查指令、預算、記憶、提案 |
| `skills.js` | 328 行 | 下載 GitHub tarball → 檢查 → 核准 → 複製到 `.claude/skills` |
| `diag.js` | 275 行 | 問題回報（遮蔽機密） |
| `security.js` | 246 行 | 登入（密碼雜湊、記住裝置、失敗鎖定）、Host／Origin 檢查、資料夾允許清單、子程序環境變數白名單、遮蔽 |
| `clistatus.js` | 193 行 | CLI 狀態頁（只跑不耗額度的查詢） |
| `afterturn.js` | 155 行 | 每輪結束後在沙箱外跑一個指令（指紋釘選、核准） |
| `maint.js` | 141 行 | 維運成員：附上被照顧成員的設定檔／錯誤回報／稽核，【修改設定檔】→ 提案 → 核准 |
| `agy.js` | 139 行 | agy 參數、存取等級、stream-json 解析、額度偵測 |
| `xlsx.js` | 127 行 | 零相依 .xlsx 解析（內建 zlib 解 zip、正規表示式讀 XML） |
| `outbox.js` | 127 行 | 通知失敗重送（退避） |
| `updater.js`／`launcher.js` | | 一鍵更新（git）、啟動器（結束碼 75＝重啟） |
| `localsettings.js`／`proctree.js`／`rtkhook.js`／`recall.js` | | 個人設定、子程序樹關閉、rtk hook 外層、外部記憶查詢（選用） |
| `templates/roles/*.md` | | 成員範本（front-matter＋人設） |
| `templates/rules/*.md` | | 資料表判讀規則範例 |
| `tests/*.test.js` | 25 檔 | 每檔獨立：複製原始碼到暫存資料夾、用假 CLI 跑真的伺服器 |

## 4. 主要流程

### 4.1 一則訊息到回覆（核心路徑）
```
網頁 /api/chat、Telegram、LINE、排程、同事交接
  → dispatch(agent, text, opts)          server.js ~877
      ├─ isHeld()（暫停）／tryUrgent()（緊急插話）
      └─ 忙碌就進 pending（存進 state.queue）→ pump()
  → startRun(agent, text, opts)          server.js ~1086（約 270 行，最該看的函式）
      ├─ buildPrompt：開頭說明（身分、團隊、守則、記憶、資料表、待辦清單…）＋ dedupHeader 去重
      ├─ 各模組注入：maint.contextFor、todo.sourcesContext、afterturn.before
      ├─ buildCommand（server.js ~920）組 CLI 參數（權限模式、--settings、agy 參數）
      └─ spawn（shell 視平台決定）→ 逐行解析 parseClaude／parseCodex／agy.parse → broadcast（SSE）
  → close handler：找 @mention 交接、任務推進、換班、agy 檢查（agyAfter／額度）、
      done hook（LINE／Telegram 回覆、afterturn.after、todo 動作行寫入、維運提案）
```

### 4.2 「AI 只提案，系統驗證後執行」模式
平台多處用同一個安全模式：模型只能在回覆裡寫**動作行**，由系統解析、檢查權限，有時還要使用者核准才執行。

| 動作行 | 解析位置 | 執行 |
|---|---|---|
| `【待辦】新增｜事項=…` | todo.js | 系統呼叫 Apps Script（opId 冪等） |
| `【修改設定檔】` | maint.js | `state.mdProposals` → 使用者核准 → 寫檔前備份、檔案 hash 不同就拒絕 |
| `【安裝 Skill】` | skills.js | 下載、檢查 → 核准 → 複製 |
| 排程建議 | timers.js | 提案 → 核准 |
| `【緊急】` | server.js tryUrgent | 授權成員＋冷卻 |
| 守則／記憶提案 | harness.js | 核准 |

**審查重點**：每個解析器能不能被「使用者輸入被模型照抄」或「資料表內容」注入（prompt injection 讓模型寫出動作行）？權限判斷是看**誰觸發這一輪**，還是看模型寫了什麼？

### 4.3 外部入口與信任邊界
| 入口 | 驗證 |
|---|---|
| 網頁 HTTP（預設只綁 `127.0.0.1:3939`） | `verifyHost`（Host 白名單）、`checkOrigin`（擋 CSRF）、密碼登入 cookie、`jsonRequest`；綁其他位址時必須設定 `ALLOWED_HOSTS` 才能啟動 |
| LINE webhook（獨立連接埠，經 cloudflared 對外） | HMAC-SHA256 簽章（`timingSafeEqual`）、配對碼、未知群組自動離開、群組速率限制、群組只能交給唯讀成員（`groupRisk`） |
| Telegram（long polling，沒有對外連接埠） | 配對過的 user ID 白名單、成員專屬 bot 可再限制帳號 |
| Apps Script（Google） | 共用密鑰；唯讀來源只讀 |
| GitHub tarball（Skill） | 下載後檢查內容，需要核准 |
| 子程序 | `security.safeEnvironment()` 環境變數白名單（`NEVER_CHILD` 擋 token）、`allowedRoots` 資料夾允許清單 |

### 4.4 持久化
- `agents.json`：成員與設定（含密鑰，不進 git）。`saveConfig()` 寫回。
- `data/state.json`：所有執行狀態，**單一 JSON 檔、`fs.writeFileSync` 直接覆寫**（`saveState`，server.js:303），不是先寫暫存再改名。狀態包括：sessions、pause、queue、shifts、ctx、hdr、agyQuota、agyUsage、feedbackStatus、mdProposals、outbox、telegram offset 等。
- `data/history/<id>.jsonl`、`data/feedback.jsonl`（只增不改）、稽核紀錄、`data/agents/*.md`（成員設定檔，每 3 秒比對修改時間雙向同步，改前備份到 `.backup/`）、`data/sources/*.md`（資料表連線設定）。

## 5. 建議的審查範圍（依優先順序）

1. **安全（最優先）**
   - `security.js` 全檔；server.js 路由前段（2000 行附近）的驗證順序；有沒有 API 漏了 `jsonRequest`、方法檢查，或 auth 檢查之前就做了事。
   - **shell 注入**：`spawn(..., { shell: true })` 出現在 server.js:1536（排程前置檢查）、harness.js:312（自動檢查指令），Windows 上 CLI 本身也用 `needShell`（server.js:1185）。參數從哪裡來？模型或外部訊息能不能影響？
   - afterturn.js 的指紋與 cmd.exe 參數處理（`.cmd`／`.bat` 經 cmd 的引號問題）。
   - LINE／Telegram 的配對、群組、速率限制；**prompt injection** 經資料表內容或群組訊息觸發動作行（見 4.2）。
   - 路徑：`/api/file`、`/api/upload`、`/api/avatar`、`/api/sources/:name`、skills 解壓縮（路徑穿越、symlink）、xlsx.js（zip bomb、超大檔）。
   - 機密：`maskAgent`、diag 遮蔽、錯誤訊息會不會洩漏 token。
2. **正確性與可靠性**
   - `state.json` 非原子寫入（當機或斷電可能寫壞）；高頻 `saveState` 的效能。
   - `startRun`／close handler 的競態：同一成員同時兩輪、停止時排隊被清、暫停與交接交錯、子程序樹關閉（proctree）。
   - 成員設定 .md 每 3 秒雙向同步的衝突處理（網頁儲存與手動編輯同時發生）。
   - outbox 重送與冪等（LINE reply token 只能用一次、Telegram 429）。
   - timers 的時區與日光節約（使用者在台灣，沒有 DST，但程式是通用的）。
3. **架構與可維護性**
   - `server.js` 189 KB 的單一檔：路由是一長串 if、全域可變狀態（`state`、`CONFIG`、`AGENTS`、`runs`、`pending`）。值得拆出什麼模組？拆的順序？要考慮「每個測試檔有 FILES 複製清單」的成本。
   - `public/index.html` 270 KB 單檔前端：重複的 modal 建構程式、HTML 字串拼接的跳脫（`esc`）是否一致、`innerHTML` 的 XSS 風險（尤其是模型回覆、LINE 名稱、試算表內容）。
   - 模組之間用 `ctx` 物件注入依賴（todo／line／maint／afterturn），介面是否一致。
   - 子專案滲進平台的程度（todo.js、line.js 裡有沒有只為某個 bot 寫死的東西）。
4. **測試**
   - 25 檔、假 CLI 端對端為主；哪些重要路徑沒有被測到（例如 Windows 專屬分支、shell 參數跳脫、state 寫壞後的復原）。
   - `node --test tests/` 整個資料夾跑會失敗（各檔共用連接埠或暫存資料夾？），可評估原因。

## 6. 已知的弱點與待辦（不用重新發現，但可以評估優先順序）

- 很多功能**還沒在真實 Windows＋真實 CLI 驗證**，只在 Linux 用假 CLI 測過，詳見 `HANDOVER.md` 的「需要使用者在 Windows 實測」和 `CLAUDE.md` 待辦 3。
- agy 工具結果的結束碼格式是 `Command exited with code N`，server.js 的 regex 只認 `exit code N`（CLAUDE.md 待辦 2）。
- agy 可寫等級的沙箱行為（E／F 測試）還沒定案，`WRITE_DEFAULT` 還沒決定。
- 路線圖：🧵 任務執行追蹤 → 🧪 小型評測集 → ✅ 統一「待核准」收件匣＋風險分級；不可改寫的執行紀錄（雜湊串接）。現在各種「待核准」散在不同畫面（排程、守則、Skill、設定檔提案、afterturn），審查時可以順便評估統一的做法。
- 分支 `wip/date-mode`、`wip/xlsx-reader` 是不會合併的舊工作，可忽略。

## 7. 怎麼跑

```bash
git clone https://github.com/JackTzeng/agent-chat && cd agent-chat
for f in tests/*.test.js; do node --test $f || echo "FAIL $f"; done   # 25 檔應全過
node server.js   # 第一次啟動會印出管理密碼；需要 agents.json（可從 agents.example.json 複製）
```
前端語法檢查：把 `public/index.html` 的 `<script>` 抽出來，跑 `node --check`。

## 8. 希望得到的產出

請輸出一份審查報告（可以寫成 `docs/REVIEW-<日期>.md` 放在**另一個分支**，或直接在對話裡給），內容：

1. **摘要**：整體評價、最重要的三到五件事。
2. **發現清單**：每項寫嚴重度（高／中／低）、類別（安全、正確性、架構、測試、效能）、`檔案:行號`、問題、可能的後果、建議做法、改動大小（小、中、大）。
3. **架構建議**：server.js／index.html 拆分的路線圖（分幾步、每步怎麼確保測試仍過）、模組邊界。
4. **不建議做的事**：例如違反零相依、需要大改但效益低的項目。

使用者是品保背景、不是工程師，常用手機看回覆：給使用者看的結論要短、先講結論，技術細節放報告裡。
