'use strict';
// End-to-end tests against a throwaway clone of app files. No real CLI or credentials required.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const source = path.resolve(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject); s.listen(0, '127.0.0.1', () => {
      const port = s.address().port; s.close(() => resolve(port));
    });
  });
}
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-http-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  const port = await freePort();
  const password = 'unit-test-password-very-long';
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
      ACCESS_TOKEN: password, TELEGRAM_BOT_TOKEN: '', ALLOWED_HOSTS: '',
      CLAUDE_BIN: path.join(dir, 'not-executed-claude'), CODEX_BIN: path.join(dir, 'not-executed-codex') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) break;
    try { const r = await fetch(base + '/'); if (r.status === 200) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) { proc.kill(); throw new Error('test server failed to start: ' + stderr); }
  return { dir, proc, base, password };
}

test('HTTP control-plane authentication, CSRF and downloadable HTML', { timeout: 20000 }, async (t) => {
  const app = await boot();
  t.after(async () => {
    if (app.proc.exitCode === null) {
      app.proc.kill();
      await Promise.race([new Promise((resolve) => app.proc.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(app.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const { base, password, dir } = app;
  let r = await fetch(base + '/api/config');
  assert.equal(r.status, 401, 'localhost is not implicitly privileged');
  r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'token=' + password });
  assert.equal(r.status, 415);
  r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://malicious.test' },
    body: JSON.stringify({ token: password }),
  });
  assert.equal(r.status, 403);
  r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: password }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  r = await fetch(base + '/api/config', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const parsed = await r.json();
  assert.ok(Array.isArray(parsed.agents));
  r = await fetch(base + '/api/telegram/clear', {
    method: 'POST', headers: { Cookie: cookie, Origin: 'https://malicious.test', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 403);
  const file = path.join(dir, 'workspace', 'attack.html');
  fs.writeFileSync(file, '<script>document.title="unsafe"</script>');
  r = await fetch(base + '/api/file?agent=hikari&p=attack.html', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), 'attachment');
  assert.equal(r.headers.get('content-security-policy'), 'sandbox');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'protected');
  r = await fetch(base + '/api/file?agent=hikari&p=../outside.txt', { headers: { Cookie: cookie } });
  assert.equal(r.status, 403);
  r = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  r = await fetch(base + '/api/config', { headers: { Cookie: cookie } });
  assert.equal(r.status, 401);
});
