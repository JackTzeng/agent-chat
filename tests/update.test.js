'use strict';
// ⬆️ 一鍵更新＋🐞 問題回報：用真的 git（本機的 bare repo 當 GitHub）跑一遍
// 檢查更新 → start.bat 的個人設定搬到 local-settings.txt → 更新並重新啟動 → 壞掉的新版本自動退回 → 只重新啟動 → 問題回報遮蔽秘密
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + '\n' + r.stderr);
  return r.stdout.trim();
};
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}
const FILES = ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'launcher.js',
  'agents.example.json', 'start.bat', 'local-settings.example.txt', '.gitignore'];

test('one-click update, start.bat migration, rollback, restart and problem report', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-update-'));
  const remote = path.join(tmp, 'remote.git'), dev = path.join(tmp, 'dev'), app = path.join(tmp, 'app');
  // 「GitHub」與開發用的 repo
  git(tmp, 'init', '--bare', '-b', 'main', remote);
  fs.mkdirSync(dev);
  for (const f of FILES) fs.copyFileSync(path.join(source, f), path.join(dev, f));
  fs.mkdirSync(path.join(dev, 'public')); fs.writeFileSync(path.join(dev, 'public', 'index.html'), '<h1>test</h1>');
  git(dev, 'init', '-b', 'main'); git(dev, 'add', '-A'); git(dev, 'commit', '-qm', 'v1'); git(dev, 'remote', 'add', 'origin', remote); git(dev, 'push', '-q', 'origin', 'main');
  const oldVersion = (fs.readFileSync(path.join(dev, 'server.js'), 'utf8').match(/const VERSION = '([^']+)'/) || [])[1];
  // 使用者的電腦：git clone，start.bat 自己填了設定
  git(tmp, 'clone', '-q', remote, app);
  fs.writeFileSync(path.join(app, 'start.bat'), fs.readFileSync(path.join(app, 'start.bat'), 'utf8').replace('cd /d "%~dp0"', 'cd /d "%~dp0"\r\nset AGENT_ALLOWED_ROOTS=C:\\EM_reports_copy'));

  const port = await freePort();
  const proc = spawn(process.execPath, ['launcher.js'], {
    cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'update-test-password-long', TELEGRAM_BOT_TOKEN: '',
      AGENTCHAT_NO_UPDATE_CHECK: '1', CLAUDE_BIN: process.execPath, CODEX_BIN: '' },
  });
  let out = ''; proc.stdout.on('data', (d) => (out += d)); proc.stderr.on('data', (d) => (out += d));
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill('SIGTERM'); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5000)]); }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  const info = async () => { try { const r = await fetch(base + '/api/info', { headers: { Cookie: cookie } }); return r.ok ? r.json() : { status: r.status }; } catch { return null; } };
  let cookie = '';
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(100); }
  // 勾「記住這台電腦」：重新啟動後還是登入狀態
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'update-test-password-long', remember: true }) });
  assert.equal(r.status, 200, out);
  cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw Object.assign(new Error(j.error || p), { status: res.status }); return j;
  };
  const waitStarted = async (prev, version) => {
    for (let i = 0; i < 200; i++) { const j = await info(); if (j && j.started && j.started !== prev && (!version || j.version === version)) return j; await sleep(100); }
    throw new Error('沒有重新啟動\n' + out);
  };

  let st = await api('/api/update');
  assert.equal(st.launcher, true);
  assert.equal(st.version, oldVersion);
  let ck = await api('/api/update/check', 'POST');
  assert.equal(ck.ok, true, JSON.stringify(ck));
  assert.equal(ck.behind, 0);
  assert.deepEqual(ck.dirty, ['start.bat']);

  // 發佈新版本
  fs.writeFileSync(path.join(dev, 'server.js'), fs.readFileSync(path.join(dev, 'server.js'), 'utf8').replace(/const VERSION = '[^']+'/, "const VERSION = '9.9.0'"));
  git(dev, 'commit', '-qam', 'v9.9.0：新功能'); git(dev, 'push', '-q', 'origin', 'main');
  ck = await api('/api/update/check', 'POST');
  assert.equal(ck.behind, 1);
  assert.equal(ck.remoteVersion, '9.9.0');
  assert.match(ck.commits[0], /v9\.9\.0：新功能/);

  // 一鍵更新：start.bat 的設定搬到 local-settings.txt，更新後自動重新啟動
  const before = (await info()).started;
  const up = await api('/api/update', 'POST');
  assert.equal(up.restarting, true, JSON.stringify(up));
  assert.deepEqual(up.moved, ['AGENT_ALLOWED_ROOTS=C:\\EM_reports_copy']);
  const after = await waitStarted(before, '9.9.0');
  assert.match(fs.readFileSync(path.join(app, 'local-settings.txt'), 'utf8'), /^AGENT_ALLOWED_ROOTS=C:\\EM_reports_copy$/m);
  assert.equal(git(app, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(git(app, 'rev-parse', 'HEAD'), git(dev, 'rev-parse', 'HEAD'));

  // 壞掉的新版本：起不來 → 啟動器自動退回 9.9.0
  fs.writeFileSync(path.join(dev, 'server.js'), fs.readFileSync(path.join(dev, 'server.js'), 'utf8').replace("const VERSION = '9.9.0'", "const VERSION = '9.9.1';\nthrow new Error('boom')"));
  git(dev, 'commit', '-qam', 'v9.9.1 壞掉'); git(dev, 'push', '-q', 'origin', 'main');
  const good = git(app, 'rev-parse', 'HEAD');
  const up2 = await api('/api/update', 'POST');
  assert.equal(up2.toVersion, '9.9.1');
  const back = await waitStarted(after.started, '9.9.0');
  assert.equal(git(app, 'rev-parse', 'HEAD'), good, '退回更新前的版本');
  st = await api('/api/update');
  assert.equal(st.failed.toVersion, '9.9.1');
  assert.equal(st.failed.rollback, 'ok');
  await api('/api/update/failed', 'DELETE');

  // local-settings.txt：中文路徑也能用；改完「只重新啟動」就生效；start.local.bat 的 set 會自動搬進來；不存在的資料夾略過不當機
  const extra = path.join(tmp, '共用資料');
  fs.mkdirSync(extra);
  fs.writeFileSync(path.join(app, 'local-settings.txt'), Buffer.from('\ufeff# 中文註解\r\nAGENT_ALLOWED_ROOTS=' + extra + ';' + path.join(tmp, '不存在') + '\r\n'));
  fs.writeFileSync(path.join(app, 'start.local.bat'), '@echo off\r\nrem 中文註解\r\nset AGENT_ENV_ALLOWLIST=FOO_BAR\r\n');
  await api('/api/restart', 'POST');
  await waitStarted(back.started, '9.9.0');
  const ls = fs.readFileSync(path.join(app, 'local-settings.txt'), 'utf8');
  assert.match(ls, /^AGENT_ENV_ALLOWLIST=FOO_BAR$/m);
  const { id: farId } = await api('/api/agents', 'POST', { name: '遠端', engine: 'claude', permissionMode: 'auto', cwd: extra });
  assert.ok(farId, '共用資料 在核准範圍內');

  // 問題回報：有環境、git、成員、伺服器紀錄；秘密被遮掉
  const rep = await api('/api/diag/report', 'POST', { description: '測試：我的金鑰 sk-ant-abcdefghijklmnopqrstuvwxyz0123 和密碼 update-test-password-long 不該出現', agentId: 'hikari', includeChat: true });
  assert.match(rep.name, /^agentchat-report-\d{8}-\d{6}\.md$/);
  const res = await fetch(base + '/api/diag/reports/' + rep.name, { headers: { Cookie: cookie } });
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const md = await res.text();
  for (const sec of ['## 1. 發生了什麼事', '## 2. 環境', '## 3. 成員', '## 9. 伺服器紀錄']) assert.ok(md.includes(sec), sec);
  assert.match(md, /Agent Chat：v9\.9\.0/);
  assert.match(md, /啟動方式：start\.bat → launcher\.js/);
  assert.match(md, /已更新/);
  assert.match(md, /local-settings\.txt：有（AGENT_ALLOWED_ROOTS、AGENT_ENV_ALLOWLIST）/);
  assert.match(md, /不存在而略過的資料夾：.*不存在/);
  assert.ok(md.includes(extra), '允許的資料夾列出中文路徑');
  assert.doesNotMatch(md, /sk-ant-abcdefghijklmnopqrstuvwxyz0123/);
  assert.doesNotMatch(md, /update-test-password-long/);
  assert.match(md, /\[API_KEY\]/);
  assert.equal((await api('/api/diag/reports')).reports[0].name, rep.name);
  await assert.rejects(api('/api/diag/reports/..%2Fagents.json'), /找不到|not found/);
  await assert.rejects(api('/api/diag/reports/agents.json'), /找不到/);
});
