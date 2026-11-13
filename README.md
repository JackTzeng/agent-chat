# Agent Chat

把 **Claude Code** 和 **Codex** 兩個 CLI 包成一個聊天介面，可以組成 PM / Coder / QA 團隊互相派工，也能用 Telegram 遙控。每個 agent 有自己的名字、頭像和人設，回覆以 Markdown 顯示，agent 做出來的圖片和影片也能直接在聊天室裡看。

不用 `npm install`，只要有 Node.js 就能跑。

---

## 1. 事前準備（只做一次）

1. 安裝 **Node.js 18 以上**：https://nodejs.org （選 LTS 版本）
2. 開終端機（Windows 用 PowerShell），安裝兩個 CLI：
   ```
   npm i -g @anthropic-ai/claude-code @openai/codex
   ```
3. 分別登入一次：
   ```
   claude      ← 照畫面登入 Claude 帳號，登入完輸入 /exit 離開
   codex       ← 照畫面登入 ChatGPT 帳號，完成後 Ctrl+C 離開
   ```
   **一定要先在終端機確認這兩個指令能正常用**，聊天介面只是在背後呼叫它們。

## 2. 啟動

- Windows：雙擊 `start.bat`
- 或在這個資料夾開終端機，輸入 `node server.js`

接著用瀏覽器打開 **http://localhost:3939**。

## 3. 自訂團隊：編輯 `agents.json`

第一次啟動後，資料夾裡會出現 `agents.json`（從 `agents.example.json` 複製來的）。之後都改 `agents.json`，它不會被 git 更新蓋掉。

**最簡單的方式是直接在網頁上設定**，不用手動改檔案：
- 左邊最下面的「**＋ 新增成員**」：填名稱、職責、引擎、模型、強度、權限、可交接對象和人設，也可以一鍵套用 PM / Coder / QA / 文件 / 研究範本
- 成員卡片右下角的 ⚙️，或聊天室上方的「⚙️ 設定」：編輯或刪除成員
- 在「👥 全員」頁按「⚙️ 團隊設定」：修改工作流程和自動轉交上限

網頁上的修改會直接寫回 `agents.json`，馬上生效，不用重開伺服器。模型、強度和權限從下一句就開始套用；名稱、職責、人設和工作流程則要「開新對話」才會生效（表單裡有勾選項可以順便開新對話）。

以下是 `agents.json` 的格式，想直接改檔案時可以參考：

範本預設是三人團隊：🎩 克勞德先生（PM）、📜 許代書（Coder）、🔍 小安（QA）。

### 整份檔案的結構

```
{
  "maxRelayHops": 12,        ← 成員之間自動轉交的上限，避免無限來回
  "workflow": "1. ……",       ← 工作流程說明，每位成員都會收到
  "telegram": { … },         ← Telegram 遙控，見第 5 節
  "agents": [ … ]            ← 成員清單
}
```

### 每位成員的設定

```
{
  "id": "kai",                 ← 英數代號，不要重複（對話記錄用它存）
  "name": "許代書",             ← 顯示名稱，也是 @ 的名字
  "avatar": "📜",              ← 頭像（emoji）
  "role": "Coder · 實作",       ← 職稱，會告訴其他成員
  "engine": "codex",           ← "claude" 或 "codex"
  "model": "gpt-6-luna",       ← 模型，留空 = 該 CLI 的預設
  "effort": "max",             ← 推理強度，留空 = 預設
  "sandbox": "workspace-write",← 權限，見下方表格
  "cwd": "./workspace",        ← 工作資料夾
  "canHandoffTo": ["qa", "hikari"],  ← 可以把工作交給誰（填 id），不寫 = 所有人
  "persona": "你叫許代書……"     ← 人設與職責
}
```

### 模型與推理強度

| engine | model 範例 | effort 可用值 |
|---|---|---|
| claude | `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`，或簡寫 `opus`、`sonnet` | `low`、`medium`、`high`、`xhigh`、`max` |
| codex | `gpt-6-luna`、`gpt-6-sol`、`gpt-6.1-sol`、`gpt-6-astra` | `low`、`medium`、`high`、`xhigh`、`max` |

- 強度越高，想得越久，也越耗用量額度
- 能用哪些模型取決於你的訂閱方案；填了方案不支援的模型，聊天室會顯示錯誤訊息
- Codex 在終端機輸入 `codex.cmd` 後打 `/model`，可以看到你帳號目前能用的模型

### 分工與工作流程

- `workflow` 寫整個團隊的流程，每位成員都看得到
- `persona` 寫個人的職責，例如「你不親自寫程式碼」
- `canHandoffTo` 限制交接對象；回覆裡 @ 了不允許的人，系統不會轉交
- 改完 `agents.json` 要重開 `start.bat`，**每位成員也都要按一次「新對話」**，新的分工才會生效（流程說明只在每段對話的第一句送出）

想加更多成員，照格式複製一段即可。Windows 路徑要寫成 `"C:/Users/Jack/project"`（斜線方向改成 `/`）。

### 權限設定（重要）

聊天介面沒辦法跳出「要不要允許這個操作？」的確認視窗，所以權限要事先決定：

| 引擎 | 設定值 | 意思 |
|---|---|---|
| claude | `"plan"` | 只看不改，只會提出計畫 |
| claude | `"acceptEdits"` | 可以讀寫檔案；需要執行指令時會被擋下，並在聊天室回報 |
| claude | `"auto"`（預設） | Claude 自己判斷風險，低風險直接執行、有風險的擋下 |
| claude | `"bypassPermissions"` | 全部自動允許，**只在你信任的資料夾使用** |
| codex | `"read-only"` | 只能讀 |
| codex | `"workspace-write"`（預設） | 只能在工作資料夾內寫檔與執行指令 |
| codex | `"danger-full-access"` | 不受限制，**小心使用** |

如果成員一直說「沒有權限執行指令」，可以把 permissionMode 改成 `auto`。

## 4. 用手機瀏覽器連（選用）

**建議用 Tailscale**（免費）：電腦和手機都裝 Tailscale、登入同一個帳號，兩台裝置就像在同一個私人網路裡。

1. 用遠端模式啟動，**一定要設密碼**：
   ```
   # PowerShell
   $env:HOST="0.0.0.0"; $env:ACCESS_TOKEN="自己想一組長密碼"; node server.js
   ```
2. 手機瀏覽器打開 `http://電腦的Tailscale IP:3939/?token=你的密碼`
   （第一次帶 token 就好，之後這支手機會記住）

⚠️ 這個介面等於可以遙控你電腦上的 AI 執行指令。**不要**把 3939 port 直接開到公開網路上。

## 5. Telegram 遙控（選用）

設定好之後，在手機的 Telegram 傳訊息就能派工，每位成員做完一輪也會把結果（含圖片）推送到 Telegram。不需要 Tailscale，也不用開任何 port。

**設定步驟：**

1. 在 Telegram 搜尋 **@BotFather**，傳 `/newbot`，照指示取名字，最後會拿到一串 **bot token**（像 `123456:ABC-xxxx`）
2. 打開 `agents.json`，填進 `telegram.botToken`
3. 重開 `start.bat`，黑色視窗出現「📱 Telegram 已連線」就成功了
4. 在 Telegram 找到你的 bot，傳任意訊息，它會回覆「你的 user id 是：xxxxx」
5. 把這個數字填進 `allowedUserIds`，再重開 `start.bat`

```
"telegram": {
  "botToken": "123456:ABC-xxxx",
  "allowedUserIds": [987654321],
  "defaultAgent": "hikari"     ← 預設交給誰（填 id）
}
```

**Telegram 裡的用法：**

| 輸入 | 作用 |
|---|---|
| 直接打字 | 交給目前的對象（預設是 PM） |
| `@小安 幫我再測一次` | 交給指定成員，不切換對象 |
| `/list` | 成員、模型與工作狀態 |
| `/to 許代書` | 切換對象 |
| `/stop` | 全部停止 |
| `/new` | 目前對象開新對話 |
| `/mute`、`/unmute` | 暫停 / 恢復推送 |

⚠️ **bot token 等於鑰匙**：拿到的人可以冒用你的 bot，不要貼到任何地方。只有 `allowedUserIds` 裡的人能下指令，其他人傳訊息只會被拒絕。`agents.json` 不會上傳到 GitHub。

公司網路如果擋了 `api.telegram.org`，黑色視窗會顯示「Telegram 連線失敗」。這種情況只能在可以連外的網路下使用。

## 6. 讓成員互相合作

成員的回覆裡只要出現 `@另一位的名字`，伺服器就會把那則回覆自動轉給對方；對方回覆時再 @ 回來，也會自動轉回去。

- 用法：跟克勞德先生說「寫好後請 @許代書 審查」，接下來就會自動來回
- 左邊的 **👥 全員** 可以照時間順序看所有人的對話，轉交過程會顯示成「📨 A → B」
- 對方忙碌中的話，訊息會排隊，等它做完再處理
- 為了避免無限來回，自動轉交有上限，預設 12 次，可以在 `agents.json` 最上面的 `maxRelayHops` 修改
- 想中斷就按「停止」，或在全員頁按「全部停止」
- 團隊名單只在每段對話的第一句告訴 agent，所以**新增或改名成員後，要按「新對話」**它們才知道同事是誰
- 兩位預設共用 `workspace` 資料夾，所以看得到彼此的檔案；如果改成不同資料夾，交接時要寫完整路徑

## 7. 使用小技巧

- **Enter** 送出，**Shift+Enter** 換行；打中文選字時按 Enter 不會誤送
- 執行中按 **停止** 可以中斷
- **新對話**：清空記錄，從頭開始（人設會重新送出）
- 對話會自動接續；重開伺服器後也會延續（記錄在 `data/` 資料夾）
- 電腦和手機同時開著時，畫面會即時同步
- 想看 agent 產生的圖，請它「把圖存在資料夾裡並在回覆中顯示」；只能顯示該 agent 工作資料夾裡的檔案

## 疑難排解

**回覆下方的「≈API價 US$…」是什麼？** 這是 Claude Code 估算「如果改用 API 計費大約要多少錢」，只是讓你參考這一輪用量大不大。用 Claude 帳號（Pro / Max）登入時，用的是訂閱額度，**不會另外收費**。除非電腦上設定了 `ANTHROPIC_API_KEY` 環境變數，Claude Code 才會改走 API 計費。


| 狀況 | 處理方式 |
|---|---|
| 「無法啟動 claude / codex」 | 先在終端機輸入 `claude --version`、`codex --version`，確認裝好了 |
| 回覆是登入或驗證錯誤 | 在終端機直接執行 `claude` 或 `codex` 重新登入 |
| 想換 port | `$env:PORT="4000"; node server.js` |
| 指令不在 PATH 裡 | 用 `CLAUDE_BIN`、`CODEX_BIN` 環境變數指定完整路徑 |

## 檔案說明

```
server.js        後端：呼叫 CLI、解析輸出、推送給網頁
telegram.js      Telegram 遙控
public/          前端聊天介面（vendor/ 裡是 Markdown 套件 marked、DOMPurify）
agents.example.json  agent 設定範本（第一次啟動會複製成 agents.json）
agents.json      你自己的 agent 設定（不會上傳到 git，git pull 也不會蓋掉）
data/            對話記錄與 session（自動產生）
workspace/       預設工作資料夾（自動產生）
```
