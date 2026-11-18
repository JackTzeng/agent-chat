#!/usr/bin/env node
'use strict';
// 🗜 rtk 的 Claude Code hook 外層（只給勾了「壓縮指令輸出」的 Claude 成員用）
//
// Claude Code 在每次執行 Bash 指令前呼叫這支程式（PreToolUse hook）。我們把同樣的輸入交給 `rtk hook claude`，
// 只採用它「改寫指令」的部分（例如 git status → rtk git status，輸出會被精簡），
// 但拿掉它的「允許／詢問」決定，改由 Claude 自己的權限規則與 Agent Chat 設定的權限模式判斷，
// 避免 rtk 自動核准原本不允許的指令（rtk 舊版有這個問題）。rtk 說要擋下（deny）的照樣擋下。
// 任何錯誤（找不到 rtk、逾時、輸出看不懂）都當作「不改寫」：原本的指令照常交給 Claude 判斷。
//
// 用法（由 Agent Chat 寫進 --settings 檔）："node" "rtkhook.js" "rtk 執行檔路徑"
const { spawnSync } = require('child_process');

const rtk = process.argv[2];
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  if (!rtk) process.exit(0);
  let r;
  try { r = spawnSync(rtk, ['hook', 'claude'], { input, timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); }
  catch { process.exit(0); }
  if (!r || r.error) process.exit(0);
  if (r.status === 2) { // rtk 依 Claude 的 deny 規則擋下：照樣擋
    process.stderr.write(r.stderr || 'rtk: blocked');
    process.exit(2);
  }
  if (r.status !== 0) process.exit(0);
  const out = String(r.stdout || '').trim();
  if (!out) process.exit(0);
  let j;
  try { j = JSON.parse(out); } catch { process.exit(0); }
  const h = j && j.hookSpecificOutput;
  if (!h || typeof h !== 'object') process.exit(0);
  if (h.permissionDecision === 'deny') { process.stdout.write(JSON.stringify(j)); process.exit(0); }
  const cmd = h.updatedInput && h.updatedInput.command;
  if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0); // 沒有改寫：什麼都不回，Claude 照常判斷原本的指令
  const safe = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: h.updatedInput } };
  process.stdout.write(JSON.stringify(safe));
  process.exit(0);
});
