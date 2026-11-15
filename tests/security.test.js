'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSecurity } = require('../security');
function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-security-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const env = { ACCESS_TOKEN: 'testing-password-at-least-16', ALLOWED_HOSTS: '100.66.77.88',
    TELEGRAM_BOT_TOKEN: '1234:secret-for-remote-controller', ANTHROPIC_API_KEY: 'forbidden', PATH: process.env.PATH,
    ...extra };
  const auth = createSecurity({ root, dataDir: path.join(root, 'data'), host: '0.0.0.0', port: 3939, env, log: () => {} });
  return { root, workspace, auth, env };
}
function req(headers = {}, address = '127.0.0.1') { return { headers, socket: { remoteAddress: address, encrypted: false } }; }

test('explicit login is required; cookie is HttpOnly and SameSite Strict', () => {
  const { auth } = fixture();
  const request = req({ host: 'localhost:3939', 'content-type': 'application/json' });
  assert.equal(auth.authenticated(request), false);
  const logged = auth.login(request, 'testing-password-at-least-16');
  assert.equal(logged.ok, true);
  assert.match(logged.cookie, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(logged.cookie, /testing-password/);
  const session = logged.cookie.split(';')[0];
  request.headers.cookie = session;
  assert.equal(auth.authenticated(request), true);
  auth.logout(request);
  assert.equal(auth.authenticated(request), false);
});

test('wrong login is rate-limited and does not authenticate', () => {
  const { auth } = fixture();
  const request = req({ host: 'localhost:3939' });
  for (let i = 0; i < 4; i++) assert.equal(auth.login(request, 'wrong').ok, false);
  assert.equal(auth.login(request, 'wrong').blocked, true);
  assert.equal(auth.login(request, 'testing-password-at-least-16').blocked, true);
});

test('origin, Host allowlist and JSON content-type validation', () => {
  const { auth } = fixture();
  assert.equal(auth.verifyHost(req({ host: 'attacker.example:3939' })), false);
  assert.equal(auth.verifyHost(req({ host: 'localhost:3939' })), true);
  assert.equal(auth.verifyHost(req({ host: '100.66.77.88:3939' })), true);
  assert.equal(auth.checkOrigin(req({ host: 'localhost:3939', origin: 'https://evil.example' })), false);
  assert.equal(auth.checkOrigin(req({ host: 'localhost:3939', origin: 'http://localhost:3939' })), true);
  assert.equal(auth.checkOrigin(req({ host: 'localhost:3939', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(auth.jsonRequest(req({ 'content-type': 'text/plain' })), false);
  assert.equal(auth.jsonRequest(req({ 'content-type': 'application/json;charset=utf-8' })), true);
});

test('agent environment does not inherit controller secrets', () => {
  const { auth } = fixture();
  const e = auth.safeEnvironment();
  assert.equal(e.ACCESS_TOKEN, undefined);
  assert.equal(e.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(e.ANTHROPIC_API_KEY, undefined);
  assert.equal(e.PATH, process.env.PATH);
});

test('explicit environment opt-in never allows controller secrets', () => {
  const { auth } = fixture({ AGENT_ENV_ALLOWLIST: 'ANTHROPIC_API_KEY,ACCESS_TOKEN,TELEGRAM_BOT_TOKEN' });
  const e = auth.safeEnvironment();
  assert.equal(e.ANTHROPIC_API_KEY, 'forbidden');
  assert.equal(e.ACCESS_TOKEN, undefined);
  assert.equal(e.TELEGRAM_BOT_TOKEN, undefined);
});

test('workspace root is enforced for main and additional directories', () => {
  const { auth, workspace, root } = fixture();
  assert.equal(auth.assertAllowedDir(path.join(workspace, 'sub')), path.join(workspace, 'sub'));
  assert.throws(() => auth.assertAllowedDir(root), /工作根目錄/);
  assert.throws(() => auth.assertAllowedDir(os.homedir()), /工作根目錄/);
  auth.checkAgent({ id: 'coder', engine: 'codex', cwd: workspace, sandbox: 'workspace-write' });
  assert.throws(() => auth.checkAgent({ id: 'agent', engine: 'claude', cwd: workspace,
    extraDirs: [{ path: workspace, mode: 'ro' }] }), /唯讀/);
  assert.throws(() => auth.checkAgent({ id: 'coder', engine: 'codex', cwd: workspace,
    sandbox: 'danger-full-access' }), /完整權限/);
});

test('symlinks escaping workspace are not readable', () => {
  const { auth, workspace, root } = fixture();
  fs.writeFileSync(path.join(workspace, 'good.txt'), 'safe');
  assert.equal(auth.fileWithin(workspace, 'good.txt'), fs.realpathSync(path.join(workspace, 'good.txt')));
  const secret = path.join(root, 'outside.txt');
  fs.writeFileSync(secret, 'hidden');
  assert.throws(() => auth.fileWithin(workspace, '../outside.txt'), /超出工作目錄/);
  try {
    fs.symlinkSync(secret, path.join(workspace, 'link.txt'));
    assert.throws(() => auth.fileWithin(workspace, 'link.txt'), /超出工作目錄/);
  } catch (e) {
    // Some Windows installations do not permit creating symbolic links without Developer Mode.
    if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
  }
});

test('bootstrap only persists a password hash, never plaintext', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-bootstrap-'));
  let message = '';
  const cfg = { root, dataDir: path.join(root, 'data'), host: '127.0.0.1', port: 3939, env: {},
    log: (s) => { message += s + '\n'; } };
  const one = createSecurity(cfg);
  const secret = message.match(/Web 登入密碼（只顯示這一次）：(\S+)/)?.[1];
  assert.ok(secret && secret.length > 32);
  const file = fs.readFileSync(path.join(root, 'data', 'admin-password-hash.json'), 'utf8');
  assert.doesNotMatch(file, new RegExp(secret));
  assert.equal(one.login(req(), secret).ok, true);
  message = '';
  const two = createSecurity(cfg);
  assert.equal(message, '');
  assert.equal(two.login(req(), secret).ok, true);
});

test('remembered login survives a restart; normal login and password change do not', () => {
  const { root, auth, env } = fixture();
  const restart = (e = env) => createSecurity({ root, dataDir: path.join(root, 'data'), host: '0.0.0.0', port: 3939, env: e, log: () => {} });
  const r1 = req({ host: 'localhost:3939' }), r2 = req({ host: 'localhost:3939' });
  const remembered = auth.login(r1, 'testing-password-at-least-16', true);
  const normal = auth.login(r2, 'testing-password-at-least-16', false);
  assert.match(remembered.cookie, /Max-Age=2592000/);
  assert.doesNotMatch(normal.cookie, /Max-Age/);
  r1.headers.cookie = remembered.cookie.split(';')[0];
  r2.headers.cookie = normal.cookie.split(';')[0];
  const file = fs.readFileSync(path.join(root, 'data', 'remembered-logins.json'), 'utf8');
  assert.doesNotMatch(file, new RegExp(r1.headers.cookie.split('=')[1]), 'raw session id is not stored');

  let again = restart();
  assert.equal(again.authenticated(r1), true);
  assert.equal(again.authenticated(r2), false);

  again.logout(r1);
  assert.equal(restart().authenticated(r1), false, 'logout is persisted');

  const r3 = req({ host: 'localhost:3939' });
  r3.headers.cookie = again.login(r3, 'testing-password-at-least-16', true).cookie.split(';')[0];
  assert.equal(restart({ ...env, ACCESS_TOKEN: 'another-password-at-least-16' }).authenticated(r3), false, 'password change invalidates');

  const r4 = req({ host: 'localhost:3939' });
  again = restart();
  r4.headers.cookie = again.login(r4, 'testing-password-at-least-16', true).cookie.split(';')[0];
  again.logoutAll(r4);
  assert.equal(restart().authenticated(r4), false);
});
