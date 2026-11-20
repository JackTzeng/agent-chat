# 🎭 角色範本

成員設定畫面的「快速套用職務範本」和「套用○○設定」按鈕，都是從這個資料夾的 `.md` 自動產生的。

- **內建範本**：`templates/roles/*.md`（跟著程式更新，請不要直接改）
- **你自己的範本**：放在 `data/roles/*.md`（不進 git，更新程式不會蓋掉）。檔名和內建的一樣時，會取代內建的；不一樣就多一個按鈕。

## 格式

```
---
button: 📋 套用待辦管家設定      ← 按鈕上的字（沒寫就用檔名）
kind: team                      ← 寫 team 的只填「職責＋人設」（工作流程成員）；沒寫＝完整成員設定
name: 待辦管家                   ← 名稱欄是空的才會填
avatar: 📋
role: 部門待辦登記與追蹤
standalone: true                ← 獨立成員
engine: agy                     ← claude／codex／agy
model: gemini-3.8-flash-high
perm: read                      ← Claude：default/auto/…；Codex：sandbox；agy：read/write
cwd: ./workspace/todo
personaFile: ledger/agent/記帳員.md
tgPrefix: /記帳
tools: Bash,Read
allow: Bash(ledger/ledger.cmd *)   ← 可以寫很多行，每行一條
env: LEDGER_SHEET_ID=
brief: true                     ← 📋 每輪附上現況摘要
todoKeeper: true                ← 📋 待辦清單能力（Google Sheet）
toast: 套用後顯示的提示
---
這裡以下是人設，{name} 會換成成員名稱。
```

人設只管「怎麼說話、怎麼判斷」。系統和成員之間的協定（例如 `【待辦】新增｜…` 動作行格式、權限檢查、寫入 Google Sheet）寫在程式裡，改人設不會改到它們。
