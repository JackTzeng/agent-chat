// ⬆️ 一鍵更新：git fetch 檢查有沒有新版本 → 只做 fast-forward 合併 → 請啟動器重新啟動
// - 只在用新版 start.bat（launcher.js）啟動時才能自動重啟
// - 有自己改過的檔案就不更新（避免蓋掉）；start.bat 裡的個人設定會先搬到 local-settings.txt
// - 新版本起不來時，launcher.js 會自動退回（data/update-pending.json 記著更新前的版本）
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

exports.RESTART_CODE = 75;

exports.create = function create(ctx) {
  const ROOT = ctx.ROOT;
  const PENDING = path.join(ctx.DATA_DIR, 'update-pending.json');
  const FAILED = path.join(ctx.DATA_DIR, 'update-failed.json');
  const NOTICE = path.join(ctx.DATA_DIR, 'restart-notice.json');
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
  const viaLauncher = () => process.env.AGENTCHAT_LAUNCHER === '1';
  let busy = false, last = null;

  function git(args, timeoutMs = 60000) {
    return new Promise((resolve) => {
      let out = '', err = '', done = false;
      const finish = (code) => { if (!done) { done = true; resolve({ code, out: out.trim(), err: err.trim() }); } };
      let p;
      try {
        p = spawn('git', args, { cwd: ROOT, windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' } });
      } catch (e) { return finish(-1, (err = e.message)); }
      const t = setTimeout(() => { err += '（逾時）'; try { p.kill(); } catch {} finish(-1); }, timeoutMs);
      p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => { clearTimeout(t); err += e.message; finish(-1); });
      p.on('close', (code) => { clearTimeout(t); finish(code); });
    });
  }
  // 自己改過、會擋住更新的檔案（不含沒追蹤的檔案，例如 agents.json、data/）
  async function dirtyFiles() {
    const r = await git(['diff', '--name-only', 'HEAD']);
    return r.code === 0 ? r.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  }

  async function check() {
    if (!fs.existsSync(path.join(ROOT, '.git'))) return (last = { ok: false, error: '這個資料夾不是用 git 下載的，沒辦法自動更新。請用 git clone 重新安裝。', at: Date.now() });
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out;
    const head = (await git(['rev-parse', 'HEAD'])).out;
    const f = await git(['fetch', '--quiet', 'origin'], 90000);
    if (f.code !== 0) return (last = { ok: false, error: '連不上 GitHub：' + (f.err || '（沒有訊息）').slice(0, 300), branch, head, at: Date.now() });
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (up.code !== 0) return (last = { ok: false, error: '目前的分支（' + branch + '）沒有對應的遠端分支', branch, head, at: Date.now() });
    const counts = (await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).out.split(/\s+/).map(Number);
    const commits = (await git(['log', '--format=%h %s', '-n', '20', 'HEAD..@{u}'])).out.split('\n').filter(Boolean);
    const remoteServer = (await git(['show', '@{u}:server.js'])).out;
    const remoteVersion = (remoteServer.match(/const VERSION = '([^']+)'/) || [])[1] || '';
    return (last = { ok: true, branch, upstream: up.out, head: head.slice(0, 7), ahead: counts[0] || 0, behind: counts[1] || 0,
      commits, remoteVersion, version: ctx.VERSION, dirty: await dirtyFiles(), launcher: viaLauncher(), at: Date.now() });
  }

  // start.bat 被改過（填了 CLAUDE_BIN、AGENT_ALLOWED_ROOTS 之類）：把 set 那幾行搬到 local-settings.txt，再把 start.bat 還原
  async function moveStartBatSettings() {
    const moved = require('./localsettings').migrateFromBat(ROOT, 'start.bat');
    const r = await git(['checkout', '--', 'start.bat']);
    return r.code === 0 ? moved : false;
  }

  // 更新：成功時回傳 { from, to, commits }，之後呼叫 restart()
  async function update(by) {
    if (busy) throw new Error('正在更新中');
    busy = true;
    try {
      const c = await check();
      if (!c.ok) throw new Error(c.error);
      if (!c.behind) return { upToDate: true, version: ctx.VERSION };
      let moved = null;
      if (c.dirty.length === 1 && c.dirty[0] === 'start.bat') moved = await moveStartBatSettings();
      const dirty = await dirtyFiles();
      if (dirty.length) throw new Error('這些檔案被改過，為了不蓋掉你的修改，沒有更新：' + dirty.join('、') + '。請先還原（git checkout -- 檔名）或告訴 Claude。');
      const from = (await git(['rev-parse', 'HEAD'])).out;
      const m = await git(['merge', '--ff-only', '@{u}']);
      if (m.code !== 0) throw new Error('沒辦法直接更新（' + (m.err || m.out).slice(0, 300) + '）。可能是本機有自己的 commit，請告訴 Claude。');
      const to = (await git(['rev-parse', 'HEAD'])).out;
      write(PENDING, { from, to, fromVersion: ctx.VERSION, toVersion: c.remoteVersion, at: Date.now(), by: by || null });
      try { fs.unlinkSync(FAILED); } catch {}
      console.log('⬆️ 已更新：' + ctx.VERSION + ' → ' + (c.remoteVersion || to.slice(0, 7)) + (moved && moved.length ? '（start.bat 的設定已搬到 local-settings.txt）' : ''));
      return { from: from.slice(0, 7), to: to.slice(0, 7), commits: c.commits, toVersion: c.remoteVersion, moved: moved || [] };
    } finally { busy = false; }
  }

  // 請啟動器重新啟動；notify：重啟後要通知的地方（例如 Telegram 聊天室）
  function restart(notify) {
    if (!viaLauncher()) throw new Error('這次不是用新版 start.bat 啟動的，沒辦法自動重啟：請關掉黑色視窗、重新執行 start.bat（之後就能一鍵重啟）');
    if (notify) write(NOTICE, { ...notify, at: Date.now() });
    setTimeout(() => ctx.shutdown(exports.RESTART_CODE), 400);
  }

  // 啟動後：新版本撐過 30 秒就算更新成功；回傳要通知的訊息（給 Telegram）
  function afterStart(onNotice) {
    setTimeout(() => {
      const p = read(PENDING);
      if (p) { try { fs.unlinkSync(PENDING); } catch {} console.log('✅ 更新完成：v' + ctx.VERSION); }
    }, 30000);
    const n = read(NOTICE);
    if (n) { try { fs.unlinkSync(NOTICE); } catch {} if (onNotice) setTimeout(() => onNotice(n, read(FAILED)), 3000); }
  }

  const status = () => ({ version: ctx.VERSION, launcher: viaLauncher(), last, failed: read(FAILED), pending: !!read(PENDING) });
  const clearFailed = () => { try { fs.unlinkSync(FAILED); } catch {} };
  return { check, update, restart, afterStart, status, clearFailed, viaLauncher };
};
