# Agent Chat：程式碼與架構 Review 指南

寫給負責 review 的視窗（人或 Claude）。目的：用最短時間看懂系統、知道哪裡值得細看。
專案地圖與開發慣例以 `CLAUDE.md` 為準，這份不重複，只補「怎麼讀、讀什麼、要問什麼」。

- 版本：**v3.40.0**（`server.js` 的 `VERSION`＝`public/index.html` 的 `UI_VERSION`），`main` 乾淨
- 規模：後端約 8,300 行 JS（`server.js` 2,723 行），前端單檔 `public/index.html` 2,880 行，測試 25 檔約 4,500 行
- 零 npm 相依、Node 18+、主要跑在使用者的 Windows 電腦（PowerShell），使用者介面與訊息全是繁體中文

## 1. 這是什麼

Agent Chat 是包在 Claude Code、Codex、Google Antigravity（agy）三種 CLI 外面的**多代理協作編排層（harness）**，不是 CLI 本身。
它在本機開一個網頁介面，讓使用者建立多位「成員」（每位綁一個 CLI、權限、工作資料夾、人設），成員之間可以互相 @、走工作流程、排程執行，並能透過 Telegram／LINE 遙控。

**平台與 bot 的分界（review 時很重要）**：Agent Chat 是通用平台，個別 bot 的行為（人設、職責、資料表判讀規則、群組呼叫詞）放在 `.md` 設定檔（`data/agents/<名稱>.md`、`templates/roles/*.md`、人設裡的「## 資料表：」段落）。平台程式碼不該為單一 bot 寫特例；需要改平台時要使用者確認。

## 2. 執行時的樣子

```
瀏覽器 ── HTTP + SSE ──▶ server.js（127.0.0.1:預設埠）
                           │  dispatch → pump → startRun → buildCommand → spawn CLI
                           │  parseClaude / parseCodex / agy.parse → emit → broadcast(SSE)
                           ├─ tasks.js     工作流程（多步驟、交棒）
                           ├─ timers.js    排程（前置檢查、單次／週期）
                           ├─ harness.js   守則、檢查指令、預算、記憶
                           ├─ telegram.js  long polling 遙控
                           ├─ line.js      另一個埠的 webhook（127.0.0.1:3941）＋ cloudflared 通道
                           ├─ todo.js      部門待辦 ⇄ Google Apps Script（templates/todo/Code.gs）
                           ├─ outbox.js    LINE／Telegram 暫時失敗的重送
                           ├─ maint.js / afterturn.js / skills.js   維運提案、每輪後執行、Skill 安裝（都要核准）
                           └─ security.js / proctree.js / diag.js / updater.js
```

- **一輪對話的路徑**：`/api/chat`（或 Telegram／LINE／排程）→ `dispatch()`（server.js:877）排隊 → `pump()`（:900）→ `startRun()`（:1086）組提示詞（開頭說明去重 `dedupHeader`、記憶、待辦清單、資料表）→ `buildCommand()`（:920）→ `spawn` CLI（:1185）→ 逐行解析 stream-json → SSE 推給前端 → 結束時跑 `done` hook（afterturn、LINE／Telegram 回送、維運提案、待辦動作行寫入）。
- **狀態**：`data/state.json`（`state.sessions`、`pause`、`shifts`、`queue`、`outbox`、`agyQuota`…）、`data/agents.json`＋`data/agents/*.md`（每 3 秒比對修改時間雙向同步）、`data/history/`、`data/feedback.jsonl`（只增不改）、tasks／timers 各自的 JSON。
- **模型輸出 → 系統動作**：多個功能靠模型在回覆裡寫固定格式的「動作行」，再由系統解析執行：`【待辦】`、`【選項】`、`【修改設定檔】`、`【安裝 Skill】`、`【緊急】`、排程提案。凡是會改東西的都經過使用者核准或權限檢查。

## 3. 建議閱讀順序（約 1～2 小時）

1. `CLAUDE.md`（地圖、慣例、安全底線）→ `CHANGELOG.md` 最上面 5 節（最近在做什麼）
2. `security.js`（246 行）：登入、路徑允許清單、環境變數過濾。先建立「信任邊界」的概念
3. `server.js`：`buildCommand` → `startRun` → `parseClaude`／`parseCodex` → HTTP 路由（約 :1990 之後的大 if 串）
4. `agy.js`（139 行）：權限等級怎麼對應到 CLI 參數
5. `line.js` 與 `telegram.js`：外部輸入怎麼進來、怎麼配對、怎麼驗證
6. `todo.js`＋`templates/todo/Code.gs`：模型唯讀、系統代寫的模式
7. `maint.js`、`afterturn.js`、`skills.js`：三個「提案 → 核准 → 執行」流程，比較它們是否一致
8. 任一測試檔（如 `tests/pause.test.js`）：看假 CLI＋真伺服器的測法

## 4. 值得 review 的重點

### 4a. 架構
- **`server.js` 2,700 行、`index.html` 2,900 行**：路由是一長串 `if (p === '/api/...')`，約 60 條 API。值得討論是否拆成路由表或按功能分檔（不加相依的前提下）。
- **動作行協定**：散在 `todo.js`、`maint.js`、`skills.js`、`timers.js`、server.js 各自用 regex 解析。是否該有共用的解析與「待核准」收件匣（路線圖已排「✅ 統一待核准收件匣＋風險分級」）。
- **平台 vs 設定檔的邊界**：檢查有沒有程式碼對特定成員名稱或特定 bot 寫死的行為（CLAUDE.md 寫明待辦流程只看 `todoKeeper` 旗標、不認名字）。
- **持久化不一致**：`tasks.js`、`timers.js`、`harness.js`、agents.json 都用「寫 .tmp 再 rename」，但 `saveState()`（server.js:303）直接 `writeFileSync` 覆寫 `state.json`；寫到一半斷電或當機可能留下壞檔，而啟動時 `JSON.parse` 失敗會靜默變成空狀態（:302）。
- **三種 CLI 的抽象**：`parseClaude`／`parseCodex` 在 server.js，agy 的解析在 `agy.js`，結構不對稱。

### 4b. 安全（使用者的底線：絕不略過權限）
- 預設只聽 `127.0.0.1`；對外要設 `ALLOWED_HOSTS` 否則拒絕啟動（:138）。登入用 token（`/api/auth/login`）。
- `shell: true` 的地方：`runPrecheck`（server.js:1536，排程前置檢查）、`harness.js:312`（檢查指令）。指令來自使用者設定，確認沒有任何路徑能讓模型輸出或外部訊息（LINE／Telegram）變成這些指令。
- `afterturn.js` 在**沙箱外**執行，靠檔案指紋（`approvedHash`／`approvedFiles`）鎖定；確認指紋涵蓋了所有會被執行的東西。
- `skills.js` 下載 GitHub tarball 後複製到 `.claude/skills`：檢查解壓路徑穿越、符號連結、檔案大小上限。
- LINE webhook 用 `timingSafeEqual` 驗簽章（line.js:27、:398）；Telegram 與 LINE 的配對流程與群組權限（成員／主管）。
- 機密遮蔽：`secretList()`（:136）與 `diag.js` 是否涵蓋所有 token（含專屬 Telegram bot 的 token）。
- `rtkhook.js` 拿掉 rtk 的自動核准，只保留指令改寫。

### 4c. 正確性與已知缺口
- **結束碼判斷**：server.js:1209 的 regex 只認 `exit code N`，agy 輸出是 `Command exited with code N`（CLAUDE.md 待辦 2，尚未修）。
- **agy 額度偵測規則**：`agy.quotaHit`／`quotaReset` 是依常見寫法猜的，還沒拿到真實錯誤訊息校正。
- **agy 可寫等級**：預設模式可寫檔也能 `run_command`；`--sandbox` 能否限制在工作資料夾內尚未實測（HANDOVER 的 E／F 測試），`WRITE_DEFAULT` 是否改 `['--sandbox']` 待定。
- **並行**：同一成員單一執行、`pending` 佇列、`queueFrozen` 關機流程；`outbox` 重送與待辦 `opId` 冪等。值得看競態。

### 4d. 測試
- 25 檔全過（Linux、假 CLI）。逐檔跑：`for f in tests/*.test.js; do node --test $f; done`。
- 每個測試檔都維護一份要複製的檔案清單，新增模組要改 25 處，容易漏。可考慮共用 helper。
- 前端沒有自動測試，只靠抽出 `<script>` 跑 `node --check`。
- 大部分功能**沒有在真實 Windows＋真實 CLI 驗證過**（清單在 HANDOVER.md）。

## 5. 文件本身的落差（review 時順手確認）
- `HANDOVER.md` 停在 v3.11（2026-11-18，「14 個測試檔」），之後 v3.12～v3.40 的交接資訊只在 CHANGELOG 與 CLAUDE.md。
- `recall.js`／`recall_mem0.py`（記憶語意搜尋，選用 Python＋mem0）在 README 有寫，但不在 CLAUDE.md 的檔案地圖。

## 6. 最近的變更（v3.36～v3.40）
| 版本 | 內容 |
|---|---|
| v3.40.0 | 待辦清單的 email 提醒改成選用開關，預設關 |
| v3.39.0 | 資料表每格內容 60 → 300 字、分隔線換成「／」，Apps Script 1.0.10 |
| v3.38.0 | 資料表拆兩層：表單只管怎麼讀，判讀規則寫在成員人設的「## 資料表」段落 |
| v3.37.0 | 📡 通訊管道統一頁面（Telegram 與 LINE 同一套規則） |
| v3.36.0 | 📊 資料表管理頁與新增表單 |

## 7. 請 reviewer 回答的問題
1. `server.js` 要不要拆？如果拆，切在哪幾條線（路由／執行引擎／CLI 介接／通知）？
2. 「模型寫動作行 → 系統執行」這個模式，有沒有讓外部輸入（LINE 群組成員的訊息）間接觸發高權限動作的路徑？
3. 核准流程（維運提案、每輪後執行、Skill、排程、待辦）要不要統一？
4. `state.json` 的寫法與損壞時的復原。
5. 哪些地方最需要補測試，或最可能在 Windows 上出問題？
