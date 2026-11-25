'use strict';
// 🔐 成員的「實際能力」：同一份判斷給啟動、任務交接、LINE 群組檢查、權限畫面用，避免各處各寫一套而說法不一致。
// write：能不能改檔；exec：能不能執行會改東西的指令。acts＝兩者其一（「可動手」）。
// 判斷照 CLI 實際會怎麼跑（包含沒填時的預設值），不是照設定畫面上的字面。
const agy = require('./agy');

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)\b/;
const EXEC_TOOLS = /^(Bash|PowerShell)\b/;
const has = (list, re) => (list || []).some((t) => re.test(String(t).trim()));

function claudeCaps(a) {
  const mode = a.permissionMode || 'auto'; // 沒填：CLI 會用使用者自己 settings.json 的預設（可能是可動手的），保守當成 auto
  const allow = a.allowedTools || [];
  let write, exec;
  if (mode === 'plan') { write = false; exec = false; }
  // -p（非互動）時，default 模式下需要確認的工具會直接被拒，只有 allowedTools 列出的才會用
  else if (mode === 'default') { write = has(allow, WRITE_TOOLS); exec = has(allow, EXEC_TOOLS); }
  else if (mode === 'acceptEdits') { write = true; exec = has(allow, EXEC_TOOLS); }
  else { write = true; exec = true; } // auto 與其他未知模式：保守當成可動手
  // --tools 只留這些內建工具：沒列的工具根本不存在
  if (a.tools) {
    const tools = String(a.tools).split(',');
    if (!has(tools, WRITE_TOOLS)) write = false;
    if (!has(tools, EXEC_TOOLS)) exec = false;
  }
  return { write, exec };
}

function of(a) {
  if (!a) return { write: false, exec: false, acts: false, label: '' };
  let c;
  if (a.engine === 'agy') { const w = agy.access(a) === 'write'; c = { write: w, exec: w }; }
  else if (a.engine === 'codex') { const w = (a.sandbox || 'workspace-write') !== 'read-only'; c = { write: w, exec: w }; }
  else c = claudeCaps(a);
  c.acts = c.write || c.exec;
  c.label = c.write && c.exec ? '可改檔、可執行指令' : c.write ? '可改檔' : c.exec ? '可執行指令' : '唯讀';
  return c;
}

module.exports = { of };
