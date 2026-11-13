# Agent Chat

把 **Claude Code** 和 **Codex** 兩個 CLI 包成一個聊天介面。每個 agent 有自己的名字、頭像和人設，回覆以 Markdown 顯示，agent 做出來的圖片和影片也能直接在聊天室裡看。

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

## 3. 自訂 agent：編輯 `agents.json`

第一次啟動後，資料夾裡會出現 `agents.json`（從 `agents.example.json` 複製來的）。之後都改 `agents.json` 就好，它不會被 git 更新蓋掉。

```json
{
  "id": "hikari",            ← 英數代號，不要重複
  "name": "小光",             ← 顯示名稱
  "avatar": "🌟",            ← 頭像（emoji）
  "role": "Claude Code · 主力工程師",
  "engine": "claude",        ← "claude" 或 "codex"
  "model": "",               ← 留空 = 用預設模型
  "permissionMode": "acceptEdits",   ← 僅 claude 使用，說明見下方
  "sandbox": "workspace-write",      ← 僅 codex 使用，說明見下方
  "cwd": "./workspace",      ← agent 工作的資料夾，可以改成你的專案路徑
  "persona": "你叫小光，……"   ← 人設，新對話的第一句會一起送出
}
```

想加第三、第四個 agent，就照格式複製一段。同一個引擎可以有多個不同人設的 agent。改完要重新啟動伺服器。

Windows 路徑要寫成 `"C:/Users/Jack/project"`（斜線方向改成 `/`），或是 `"C:\\Users\\Jack\\project"`。

### 權限設定（重要）

聊天介面沒辦法跳出「要不要允許這個操作？」的確認視窗，所以權限要事先決定：

| 引擎 | 設定值 | 意思 |
|---|---|---|
| claude | `"plan"` | 只看不改，只會提出計畫 |
| claude | `"acceptEdits"`（預設） | 可以讀寫檔案；需要執行指令時會被擋下，並在聊天室回報 |
| claude | `"bypassPermissions"` | 全部自動允許，**只在你信任的資料夾使用** |
| codex | `"read-only"` | 只能讀 |
| codex | `"workspace-write"`（預設） | 只能在工作資料夾內寫檔與執行指令 |
| codex | `"danger-full-access"` | 不受限制，**小心使用** |

如果小光一直說「沒有權限執行指令」，可以在該專案的 `.claude/settings.json` 加上允許清單，或把 permissionMode 改成 `bypassPermissions`。

## 4. 用手機連（選用）

**建議用 Tailscale**（免費）：電腦和手機都裝 Tailscale、登入同一個帳號，兩台裝置就像在同一個私人網路裡。

1. 用遠端模式啟動，**一定要設密碼**：
   ```
   # PowerShell
   $env:HOST="0.0.0.0"; $env:ACCESS_TOKEN="自己想一組長密碼"; node server.js
   ```
2. 手機瀏覽器打開 `http://電腦的Tailscale IP:3939/?token=你的密碼`
   （第一次帶 token 就好，之後這支手機會記住）

⚠️ 這個介面等於可以遙控你電腦上的 AI 執行指令。**不要**把 3939 port 直接開到公開網路上。

## 5. 讓成員互相合作

成員的回覆裡只要出現 `@另一位的名字`，伺服器就會把那則回覆自動轉給對方；對方回覆時再 @ 回來，也會自動轉回去。

- 用法：跟克勞德先生說「寫好後請 @許代書 審查」，接下來就會自動來回
- 左邊的 **👥 全員** 可以照時間順序看所有人的對話，轉交過程會顯示成「📨 A → B」
- 對方忙碌中的話，訊息會排隊，等它做完再處理
- 為了避免兩位無限來回，自動轉交有上限，預設 6 次，可以在 `agents.json` 最上面的 `maxRelayHops` 修改
- 想中斷就按「停止」，或在全員頁按「全部停止」
- 團隊名單只在每段對話的第一句告訴 agent，所以**新增或改名成員後，要按「新對話」**它們才知道同事是誰
- 兩位預設共用 `workspace` 資料夾，所以看得到彼此的檔案；如果改成不同資料夾，交接時要寫完整路徑

## 6. 使用小技巧

- **Enter** 送出，**Shift+Enter** 換行；打中文選字時按 Enter 不會誤送
- 執行中按 **停止** 可以中斷
- **新對話**：清空記錄，從頭開始（人設會重新送出）
- 對話會自動接續；重開伺服器後也會延續（記錄在 `data/` 資料夾）
- 電腦和手機同時開著時，畫面會即時同步
- 想看 agent 產生的圖，請它「把圖存在資料夾裡並在回覆中顯示」；只能顯示該 agent 工作資料夾裡的檔案

## 疑難排解

| 狀況 | 處理方式 |
|---|---|
| 「無法啟動 claude / codex」 | 先在終端機輸入 `claude --version`、`codex --version`，確認裝好了 |
| 回覆是登入或驗證錯誤 | 在終端機直接執行 `claude` 或 `codex` 重新登入 |
| 想換 port | `$env:PORT="4000"; node server.js` |
| 指令不在 PATH 裡 | 用 `CLAUDE_BIN`、`CODEX_BIN` 環境變數指定完整路徑 |

## 檔案說明

```
server.js        後端：呼叫 CLI、解析輸出、推送給網頁
public/          前端聊天介面（vendor/ 裡是 Markdown 套件 marked、DOMPurify）
agents.example.json  agent 設定範本（第一次啟動會複製成 agents.json）
agents.json      你自己的 agent 設定（不會上傳到 git，git pull 也不會蓋掉）
data/            對話記錄與 session（自動產生）
workspace/       預設工作資料夾（自動產生）
```
