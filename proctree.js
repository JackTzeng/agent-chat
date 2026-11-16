// 關掉「整串」子程式，不留下殘留的 CLI。
// Windows：透過 cmd.exe（.cmd 檔）啟動的 claude／codex，proc.kill() 只會關掉外層的 cmd，
// 裡面真正的 node／codex.exe 會繼續跑、繼續佔記憶體 → 一律用 taskkill /T /F 連子程式一起關。
// Linux／Mac：shell 啟動的指令放進自己的程序群組（detached），關的時候整組一起關。
'use strict';
const { spawn } = require('child_process');

const live = new Set();

// spawn 的額外選項：讓 killTree 在 Linux／Mac 也能整組關掉
const groupOpts = (platform = process.platform) => (platform === 'win32' ? {} : { detached: true });

// 記下來：伺服器關閉或重新啟動時一起清掉
function track(proc) {
  if (!proc || !proc.pid) return proc;
  live.add(proc);
  proc.once('exit', () => live.delete(proc));
  proc.once('error', () => live.delete(proc));
  return proc;
}

function killTree(proc, opts = {}) {
  if (!proc || !proc.pid || proc.exitCode !== null && proc.exitCode !== undefined) return false;
  const platform = opts.platform || process.platform;
  const run = opts.spawn || spawn;
  try {
    if (platform === 'win32') {
      const tk = run('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (tk && tk.on) tk.on('error', () => { try { proc.kill(); } catch {} });
    } else {
      try { process.kill(-proc.pid, opts.signal || 'SIGTERM'); } catch { proc.kill(opts.signal || 'SIGTERM'); }
    }
    return true;
  } catch { try { proc.kill(); } catch {} return false; }
}

// 伺服器結束前：所有還在跑的子程式（成員、用量查詢、自動檢查、版本查詢）
function killAll(opts) {
  let n = 0;
  for (const p of [...live]) if (killTree(p, opts)) n++;
  return n;
}

module.exports = { track, killTree, killAll, groupOpts, live };
