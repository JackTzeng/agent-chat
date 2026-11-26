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

test('🔒 idle lock: no user activity for IDLE_LOCK_MIN → session expires; touch keeps it alive; 0 disables', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { auth } = fixture({ IDLE_LOCK_MIN: String(300 / 60000) }); // 300 毫秒
  assert.equal(auth.idleLockMin, 300 / 60000);
  const r = req({ host: 'localhost:3939' });
  r.headers.cookie = auth.login(r, 'testing-password-at-least-16', true).cookie.split(';')[0];
  assert.equal(auth.authenticated(r), true);
  for (let i = 0; i < 4; i++) { await sleep(150); auth.touch(r); }
  assert.equal(auth.authenticated(r), true, '有在操作（touch）就不會上鎖');
  await sleep(150); assert.equal(auth.authenticated(r), true); // 背景查詢（只檢查登入）本身不算操作，不會延長
  await sleep(300);
  assert.equal(auth.authenticated(r), false, '超過閒置時間 → 要重新輸入密碼（記住這台電腦也一樣）');
  // 預設 10 分鐘；0＝關閉
  assert.equal(fixture().auth.idleLockMin, 10);
  const off = fixture({ IDLE_LOCK_MIN: '0' }).auth;
  assert.equal(off.idleLockMin, 0);
  const r2 = req({ host: 'localhost:3939' });
  r2.headers.cookie = off.login(r2, 'testing-password-at-least-16').cookie.split(';')[0];
  await sleep(50); assert.equal(off.authenticated(r2), true);
});

test('🔒 idle lock survives a restart: remembered login keeps its last-activity time', () => {
  const { root, auth, env } = fixture();
  const r = req({ host: 'localhost:3939' });
  r.headers.cookie = auth.login(r, 'testing-password-at-least-16', true).cookie.split(';')[0];
  const file = path.join(root, 'data', 'remembered-logins.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.sessions[0].la > 0, '存下最後操作時間');
  const restart = () => createSecurity({ root, dataDir: path.join(root, 'data'), host: '0.0.0.0', port: 3939, env, log: () => {} });
  assert.equal(restart().authenticated(r), true, '剛操作過：重開（例如一鍵更新）後不用重新輸入');
  saved.sessions[0].la = Date.now() - 11 * 60000; fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(restart().authenticated(r), false, '重開前已經閒置超過 10 分鐘：要重新輸入');
  delete saved.sessions[0].la; fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(restart().authenticated(r), false, '舊版存的記住登入（沒有操作時間）：要重新輸入一次');
});

test('🔑 change password from the web: needs current password, saved as salted scrypt, other devices logged out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-pw-'));
  fs.mkdirSync(path.join(root, 'workspace'));
  const dataDir = path.join(root, 'data'), hashFile = path.join(dataDir, 'admin-password-hash.json');
  let shown = '';
  const make = (env = { PATH: process.env.PATH }) => createSecurity({ root, dataDir, host: '127.0.0.1', port: 3939, env, log: (m) => { const x = /只顯示這一次）：(\S+)/.exec(m); if (x) shown = x[1]; } });
  // 新安裝：隨機密碼，存成 scrypt 加鹽（v2）
  let auth = make();
  assert.ok(shown.length > 20);
  const v2 = JSON.parse(fs.readFileSync(hashFile, 'utf8'));
  assert.equal(v2.version, 2); assert.match(v2.scrypt.salt, /^[0-9a-f]{32}$/); assert.ok(!JSON.stringify(v2).includes(shown));
  const me = req({ host: 'localhost:3939' }), phone = req({ host: 'localhost:3939' }, '100.1.1.1');
  me.headers.cookie = auth.login(me, shown, true).cookie.split(';')[0];
  phone.headers.cookie = auth.login(phone, shown, true).cookie.split(';')[0];
  // 錯的目前密碼、太短、跟原本一樣
  assert.throws(() => auth.changePassword(me, 'wrong', 'new-password-123'), /目前的密碼不正確/);
  assert.throws(() => auth.changePassword(me, shown, 'short'), /至少 10 個字元/);
  assert.throws(() => auth.changePassword(me, shown, shown), /跟目前的一樣/);
  // 成功：這個瀏覽器換成新的登入，其他裝置（包含記住的）都失效
  const r = auth.changePassword(me, shown, '我的新密碼 2026 年');
  me.headers.cookie = r.cookie.split(';')[0];
  assert.match(r.cookie, /Max-Age=/, '原本勾記住，新的登入也記住');
  assert.equal(auth.authenticated(me), true);
  assert.equal(auth.authenticated(phone), false, '其他裝置要重新登入');
  assert.equal(auth.login(req(), shown).ok, false, '舊密碼不能用');
  assert.equal(auth.login(req(), '我的新密碼 2026 年').ok, true);
  // 重新啟動：讀得到新格式；這個瀏覽器的記住登入還在
  auth = make();
  assert.equal(auth.login(req(), '我的新密碼 2026 年').ok, true);
  assert.equal(auth.authenticated(me), true);
  // 錯太多次會鎖
  for (let i = 0; i < 5; i++) { try { auth.changePassword(me, 'bad', 'whatever-long-1'); } catch {} }
  assert.throws(() => auth.changePassword(me, '我的新密碼 2026 年', 'whatever-long-1'), /錯太多次/);
});

test('🔑 old SHA-256 hash file still works; ACCESS_TOKEN passwords cannot be changed from the web', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-pw1-'));
  fs.mkdirSync(path.join(root, 'workspace')); fs.mkdirSync(path.join(root, 'data'));
  const crypto = require('node:crypto');
  fs.writeFileSync(path.join(root, 'data', 'admin-password-hash.json'), JSON.stringify({ version: 1, sha256: crypto.createHash('sha256').update('old-style-password').digest('hex') }));
  const auth = createSecurity({ root, dataDir: path.join(root, 'data'), host: '127.0.0.1', port: 3939, env: { PATH: process.env.PATH }, log: () => {} });
  const me = req({ host: 'localhost:3939' });
  me.headers.cookie = auth.login(me, 'old-style-password').cookie.split(';')[0];
  auth.changePassword(me, 'old-style-password', 'brand-new-password');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'admin-password-hash.json'), 'utf8')).version, 2, '改過後升級成 scrypt');
  const { auth: envAuth } = fixture();
  const r = req({ host: 'localhost:3939' });
  r.headers.cookie = envAuth.login(r, 'testing-password-at-least-16').cookie.split(';')[0];
  assert.equal(envAuth.passwordFromEnv, true);
  assert.throws(() => envAuth.changePassword(r, 'testing-password-at-least-16', 'another-password-x'), /ACCESS_TOKEN/);
});
