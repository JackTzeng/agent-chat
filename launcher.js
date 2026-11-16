// 啟動器（start.bat 執行的就是這個檔）：負責執行 server.js。
// - server.js 以代碼 75 結束 = 「請重新啟動」：網頁或 Telegram 按了「更新並重啟」或「重新啟動」
// - 更新後的新版本起不來（一分鐘內異常結束）：自動退回更新前的版本，再啟動一次
// 這個檔案刻意寫得很短、很少改，更新時就算它本身被換掉也不影響這次執行。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PENDING = path.join(DATA, 'update-pending.json');
const FAILED = path.join(DATA, 'update-failed.json');
const RESTART = 75;
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Ctrl+C 會同時送給這裡和 server.js：讓 server.js 自己收尾，這裡等它結束
process.on('SIGINT', () => {});
process.on('SIGTERM', () => { if (child) child.kill(); });

let child = null;
function run() {
  const t0 = Date.now();
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, AGENTCHAT_LAUNCHER: '1' },
  });
  child.on('exit', (code) => {
    child = null;
    if (code === RESTART) { console.log('\n🔄 重新啟動中…\n'); return setTimeout(run, 800); }
    const pending = read(PENDING);
    if (pending && pending.from && code !== 0 && Date.now() - t0 < 60000) {
      console.log('\n⚠️ 更新後的新版本無法啟動，退回更新前的版本（' + String(pending.from).slice(0, 7) + '）…\n');
      const r = spawnSync('git', ['reset', '--keep', pending.from], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
      try { fs.writeFileSync(FAILED, JSON.stringify({ ...pending, failedAt: Date.now(), exitCode: code, rollback: r.status === 0 ? 'ok' : String(r.stderr || r.error || '').slice(0, 500) }, null, 2)); } catch {}
      try { fs.unlinkSync(PENDING); } catch {}
      if (r.status === 0) return setTimeout(run, 800);
      console.log('退回失敗，請手動處理：' + (r.stderr || r.error));
    }
    process.exit(code == null ? 1 : code);
  });
}
run();
