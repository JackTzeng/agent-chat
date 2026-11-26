'use strict';
// Agent Chat security boundary. No third-party dependencies.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const hours = (n) => n * 60 * 60 * 1000;
const SESSION_TTL = hours(24);
const REMEMBER_TTL = hours(24 * 30); // 「記住這台電腦」：30 天，伺服器重開也不用重新登入
const MAX_REMEMBERED = 20;
const LOGIN_WINDOW = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
// 🔒 閒置自動上鎖：網頁超過 N 分鐘沒有人操作（打字、點選、移動滑鼠）就要重新輸入密碼。背景自動更新畫面的請求不算操作。
// local-settings.txt 的 IDLE_LOCK_MIN 可改（預設 10；0＝關閉）
const idleMs = (env) => { const v = env.IDLE_LOCK_MIN; const n = v === undefined || v === '' ? 10 : Number(v); return Number.isFinite(n) && n > 0 ? n * 60000 : 0; };
const DANGEROUS_MODES = new Set(['danger-full-access', 'bypassPermissions']);
const SAFE_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'USERNAME', 'USER',
  'SHELL', 'LANG', 'LC_ALL', 'TERM', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'XDG_DATA_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  // Windows 系統變數：少了這些，部分 CLI 與 Node.js 子程序會出錯
  'SYSTEMDRIVE', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'COMPUTERNAME', 'PUBLIC', 'ALLUSERSPROFILE',
  // 公司網路的 proxy 與憑證設定：少了會連不上 Anthropic / OpenAI
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  // Claude Code 在 Windows 上需要的 Git Bash 路徑
  'CLAUDE_CODE_GIT_BASH_PATH',
]);
const NEVER_CHILD = new Set(['ACCESS_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_API', 'AGENT_ALLOWED_ROOTS', 'AGENT_SAFE_ROOT',
  'AGENT_ENV_ALLOWLIST', 'ALLOWED_HOSTS', 'COOKIE_SECURE']);

// 成員專屬環境變數不能覆蓋這些：系統路徑、密碼與金鑰（避免改走付費 API）、會改變程式行為的變數
function isProtectedEnvKey(k) {
  const u = String(k).toUpperCase();
  return SAFE_ENV.has(u) || NEVER_CHILD.has(u) || /^(ANTHROPIC|OPENAI|CLAUDE|CODEX|AWS|AZURE|GOOGLE_APPLICATION|NODE|NPM|PYTHON|LD_|DYLD_|GIT_|SSH_|GH_|GITHUB)/.test(u) ||
    /(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)$/.test(u) || ['PATHEXT', 'COMSPEC', 'PROMPT', 'PSMODULEPATH', 'BASH_ENV', 'ENV'].includes(u);
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function canonicalExisting(p) { return fs.realpathSync.native(p); }
function canonicalOrParent(p) {
  if (fs.existsSync(p)) return canonicalExisting(p);
  let found = p;
  while (!fs.existsSync(found)) {
    const parent = path.dirname(found);
    if (parent === found) throw new Error('無法解析資料夾：' + p);
    found = parent;
  }
  return path.resolve(canonicalExisting(found), path.relative(found, p));
}
// 多個資料夾用分號分隔（Windows 的習慣）；Linux／Mac 也接受冒號
function splitDirs(value) { return String(value || '').split(path.delimiter === ';' ? ';' : /[:;]/).map((s) => s.trim()).filter(Boolean); }

function createSecurity({ root, dataDir, host, port, env = process.env, log = console.log }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tokenFile = path.join(dataDir, 'admin-password-hash.json');
  let password = String(env.ACCESS_TOKEN || '');
  const fromEnv = !!password;
  // passwordHash：用來比對的雜湊；scryptSalt 有值＝新格式（v2，scrypt 加鹽，網頁改的密碼與新安裝用這個）；沒有＝舊格式 SHA-256（v1、ACCESS_TOKEN）
  let passwordHash, scryptSalt = null;
  const SCRYPT = { N: 16384, r: 8, p: 1 };
  const scryptOf = (pw, salt) => crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  const hashOf = (pw) => (scryptSalt ? scryptOf(pw, scryptSalt) : crypto.createHash('sha256').update(String(pw)).digest());
  function writeHashFile(flag) {
    const body = JSON.stringify({ version: 2, scrypt: { salt: scryptSalt.toString('hex'), hash: passwordHash.toString('hex'), ...SCRYPT } }) + '\n';
    if (flag === 'wx') return fs.writeFileSync(tokenFile, body, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(tokenFile + '.tmp', body, { mode: 0o600 }); fs.renameSync(tokenFile + '.tmp', tokenFile);
  }
  if (password) {
    if (password.length < 16) throw new Error('ACCESS_TOKEN 長度至少 16 個字元，建議使用隨機產生的長密碼');
    passwordHash = crypto.createHash('sha256').update(password).digest();
  } else {
    try {
      const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (saved.version === 1 && /^[0-9a-f]{64}$/.test(saved.sha256)) passwordHash = Buffer.from(saved.sha256, 'hex');
      else if (saved.version === 2 && saved.scrypt && /^[0-9a-f]{32,}$/.test(saved.scrypt.salt) && /^[0-9a-f]{64}$/.test(saved.scrypt.hash)) {
        scryptSalt = Buffer.from(saved.scrypt.salt, 'hex'); passwordHash = Buffer.from(saved.scrypt.hash, 'hex');
      }
    } catch (e) { if (e.code !== 'ENOENT') throw new Error('管理密碼雜湊檔損毀或無法讀取，拒絕重新產生密碼'); }
    if (!passwordHash) {
      if (fs.existsSync(tokenFile)) throw new Error('管理密碼雜湊檔損毀，請先人工檢查');
      password = crypto.randomBytes(32).toString('base64url');
      scryptSalt = crypto.randomBytes(16); passwordHash = scryptOf(password, scryptSalt);
      writeHashFile('wx');
      log('首次安全啟動。Web 登入密碼（只顯示這一次）：' + password);
      log('請安全保存；伺服器僅儲存雜湊，不會保存明文密碼。也可以用 ACCESS_TOKEN 設定新密碼。');
    }
  }
  // sessions：key 是 session id 的 SHA-256（記住的登入會寫進檔案，檔案外流也不能直接拿來登入）
  const sessions = new Map();
  const failures = new Map();
  const rememberFile = path.join(dataDir, 'remembered-logins.json');
  const sidHash = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex');
  // 換了密碼（重新產生或改 ACCESS_TOKEN），之前「記住」的登入全部失效
  const tagOf = () => crypto.createHash('sha256').update(Buffer.concat([Buffer.from('agentchat-remember:'), passwordHash])).digest('hex').slice(0, 32);
  let pwTag = tagOf();
  const IDLE = idleMs(env);
  let lastRememberSave = 0;
  function saveRemembered() {
    lastRememberSave = Date.now();
    const list = [...sessions.entries()].filter(([, v]) => v.remember && v.exp > Date.now())
      .sort((a, b) => b[1].exp - a[1].exp).slice(0, MAX_REMEMBERED).map(([h, v]) => ({ h, exp: v.exp, la: v.la || 0 }));
    try {
      fs.writeFileSync(rememberFile + '.tmp', JSON.stringify({ version: 1, pw: pwTag, sessions: list }) + '\n', { mode: 0o600 });
      fs.renameSync(rememberFile + '.tmp', rememberFile);
    } catch {}
  }
  try {
    const saved = JSON.parse(fs.readFileSync(rememberFile, 'utf8'));
    if (saved.version === 1 && saved.pw === pwTag && Array.isArray(saved.sessions)) {
      for (const x of saved.sessions.slice(0, MAX_REMEMBERED))
        if (/^[0-9a-f]{64}$/.test(x.h) && Number(x.exp) > Date.now() && Number(x.exp) <= Date.now() + REMEMBER_TTL) sessions.set(x.h, { exp: Number(x.exp), remember: true, la: Number(x.la) || 0 }); // la：最後一次有人操作（重開後沿用；舊檔沒有＝要重新輸入密碼）
    } else if (fs.existsSync(rememberFile)) saveRemembered();
  } catch {}
  const allowed = new Set(['localhost', '127.0.0.1', '::1']);
  if (host !== '0.0.0.0' && host !== '::') allowed.add(String(host).replace(/^\[|\]$/g, '').toLowerCase());
  for (const h of String(env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (/[\/:]/.test(h) && !/^\[[0-9a-f:]+\]$/i.test(h) && !/^[0-9a-f:]+$/i.test(h)) throw new Error('ALLOWED_HOSTS 應填主機名稱或 IP，不含連接埠');
    allowed.add(h.replace(/^\[|\]$/g, '').toLowerCase());
  }

  function verifyHost(req) {
    let u;
    try { u = new URL('http://' + (req.headers.host || '')); } catch { return false; }
    const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return allowed.has(hostname) && (!u.port || Number(u.port) === Number(port));
  }
  function checkOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = req.headers.origin;
    if (!origin) return true; // Non-browser API clients still need a session; no anonymous writes.
    try {
      const u = new URL(origin), host = new URL('http://' + req.headers.host);
      return u.host === host.host && u.protocol === (req.socket.encrypted ? 'https:' : 'http:');
    } catch { return false; }
  }
  function sessionId(req) {
    const cookie = String(req.headers.cookie || '').split(';').map((x) => x.trim())
      .find((x) => x.startsWith('agentchat_session='));
    return cookie ? cookie.slice('agentchat_session='.length) : '';
  }
  function authenticated(req) {
    const sid = sessionId(req);
    if (!sid) return false;
    const h = sidHash(sid), s = sessions.get(h);
    if (!s) return false;
    if (s.exp < Date.now() || (IDLE && Date.now() - (s.la || 0) > IDLE)) { sessions.delete(h); if (s.remember) saveRemembered(); return false; }
    return true;
  }
  // 有人在操作：網頁偵測到打字／點選時呼叫（/api/auth/touch），以及所有會改東西的請求（POST/PUT/DELETE）
  function touch(req) {
    const s = sessions.get(sidHash(sessionId(req)));
    if (!s) return;
    s.la = Date.now();
    if (s.remember && Date.now() - lastRememberSave > 60000) saveRemembered(); // 記住的登入：最多每分鐘存一次（重開後還算數）
  }
  function cookie(req, sid, maxAge) {
    const secure = !!req.socket.encrypted || env.COOKIE_SECURE === '1';
    return 'agentchat_session=' + sid + '; HttpOnly; SameSite=Strict; Path=/api' + (maxAge == null ? '' : '; Max-Age=' + maxAge) + (secure ? '; Secure' : '');
  }
  function login(req, supplied, remember) {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = failures.get(key);
    if (entry && entry.until > now && entry.count >= LOGIN_MAX_FAILURES) return { ok: false, blocked: true };
    const h = hashOf(supplied || '');
    if (!crypto.timingSafeEqual(passwordHash, h)) {
      const old = entry && entry.until > now ? entry.count : 0;
      failures.set(key, { count: old + 1, until: now + LOGIN_WINDOW });
      return { ok: false, blocked: old + 1 >= LOGIN_MAX_FAILURES };
    }
    failures.delete(key);
    const sid = crypto.randomBytes(32).toString('base64url');
    const ttl = remember ? REMEMBER_TTL : SESSION_TTL;
    sessions.set(sidHash(sid), { exp: now + ttl, remember: !!remember, la: now });
    for (const [h, v] of sessions) if (v.exp < now) sessions.delete(h);
    while (sessions.size > 64) sessions.delete(sessions.keys().next().value);
    if (remember) saveRemembered();
    // 沒勾「記住」：瀏覽器關掉就失效（不設 Max-Age），伺服器重開也要重新登入
    return { ok: true, cookie: cookie(req, sid, remember ? Math.floor(ttl / 1000) : null) };
  }
  function logout(req) {
    const h = sidHash(sessionId(req)), s = sessions.get(h);
    sessions.delete(h);
    if (s && s.remember) saveRemembered();
    return cookie(req, '', 0);
  }
  // 登出所有裝置（包含記住的登入）
  function logoutAll(req) {
    sessions.clear(); saveRemembered();
    return cookie(req, '', 0);
  }
  // 🔑 修改登入密碼（網頁）：要先輸入目前的密碼；成功後所有裝置（包含記住的）都要用新密碼重新登入，只有這個瀏覽器直接換成新的登入
  function changePassword(req, current, next) {
    if (fromEnv) throw Object.assign(new Error('目前的密碼是用 ACCESS_TOKEN 設定的（local-settings.txt 或 start.bat），請到那裡修改，或刪掉那一行後再從網頁改'), { status: 409 });
    const key = req.socket.remoteAddress || 'unknown', now = Date.now(), entry = failures.get(key);
    if (entry && entry.until > now && entry.count >= LOGIN_MAX_FAILURES) throw Object.assign(new Error('錯太多次，請過 10 分鐘再試'), { status: 429 });
    if (!crypto.timingSafeEqual(passwordHash, hashOf(current || ''))) {
      const old = entry && entry.until > now ? entry.count : 0;
      failures.set(key, { count: old + 1, until: now + LOGIN_WINDOW });
      throw Object.assign(new Error('目前的密碼不正確'), { status: 403 });
    }
    next = String(next || '');
    if (next.length < 10) throw Object.assign(new Error('新密碼至少 10 個字元'), { status: 400 });
    if (next.length > 200) throw Object.assign(new Error('新密碼太長（200 字以內）'), { status: 400 });
    if (/^\s|\s$/.test(next)) throw Object.assign(new Error('新密碼前後不能有空白'), { status: 400 });
    if (next === String(current)) throw Object.assign(new Error('新密碼跟目前的一樣'), { status: 400 });
    const keep = sessions.get(sidHash(sessionId(req))) || {};
    scryptSalt = crypto.randomBytes(16); passwordHash = scryptOf(next, scryptSalt); password = next;
    writeHashFile();
    pwTag = tagOf();
    sessions.clear();
    const sid = crypto.randomBytes(32).toString('base64url'), ttl = keep.remember ? REMEMBER_TTL : SESSION_TTL;
    sessions.set(sidHash(sid), { exp: now + ttl, remember: !!keep.remember, la: now });
    saveRemembered();
    log('🔑 管理密碼已從網頁修改，其他裝置都要用新密碼重新登入');
    return { cookie: cookie(req, sid, keep.remember ? Math.floor(ttl / 1000) : null) };
  }
  function jsonRequest(req) {
    return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
  }

  const defaultRoot = path.join(root, 'workspace');
  fs.mkdirSync(defaultRoot, { recursive: true });
  // 不存在的資料夾直接略過（只會讓範圍變小）；不要因為一個打錯的路徑讓整個伺服器起不來
  const missingRoots = [];
  const allowedRoots = [defaultRoot, ...splitDirs(env.AGENT_ALLOWED_ROOTS)].filter((p) => {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return true;
    missingRoots.push(p); console.warn('⚠️ AGENT_ALLOWED_ROOTS 裡的資料夾不存在，先略過：' + p);
    return false;
  }).map((p) => {
    const real = canonicalExisting(p);
    const repo = canonicalExisting(root);
    if (inside(real, repo)) throw new Error('不可將 repo 或 repo 上層設為工作目錄白名單：' + real);
    if (real === path.parse(real).root) throw new Error('不可將整個磁碟設為工作目錄白名單：' + real);
    return real;
  });
  // 🔒 安全工作區：程式資料夾外面的固定位置（Windows：程式所在磁碟的 \AgentChatData；其他：~/AgentChatData），永遠允許。
  // 要對外（LINE 群組）的成員放這裡，就不會跟存密鑰的 agents.json 在同一棵資料夾樹下。不存在也先列入，用到時才建立
  let safeRoot = path.resolve(env.AGENT_SAFE_ROOT || (process.platform === 'win32' ? path.join(path.parse(path.resolve(root)).root, 'AgentChatData') : path.join(require('os').homedir(), 'AgentChatData')));
  try {
    const real = fs.existsSync(safeRoot) ? canonicalExisting(safeRoot) : safeRoot;
    if (inside(real, canonicalExisting(root)) || inside(canonicalExisting(root), real) || real === path.parse(real).root) safeRoot = '';
    else { safeRoot = real; if (!allowedRoots.includes(real)) allowedRoots.push(real); }
  } catch { safeRoot = ''; }
  function assertAllowedDir(raw, { mustExist = false } = {}) {
    const absolute = path.resolve(root, String(raw || ''));
    const canonical = canonicalOrParent(absolute);
    if (!allowedRoots.some((r) => inside(r, canonical)))
      throw new Error('路徑不在核准的工作根目錄內：' + absolute + '（在 local-settings.txt 的 AGENT_ALLOWED_ROOTS 加上這個資料夾或它的上層）');
    if (mustExist && (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()))
      throw new Error('資料夾不存在：' + absolute);
    return absolute;
  }
  function fileWithin(rootDir, raw) {
    const base = canonicalExisting(rootDir);
    const full = path.resolve(rootDir, String(raw || ''));
    const target = canonicalExisting(full);
    if (!inside(base, target)) throw new Error('檔案路徑超出工作目錄');
    if (!fs.statSync(target).isFile()) throw new Error('不是一般檔案');
    return target;
  }
  function safeEnvironment() {
    const extras = new Set(String(env.AGENT_ENV_ALLOWLIST || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
    const child = {};
    for (const [k, v] of Object.entries(env)) {
      const upper = k.toUpperCase();
      if (NEVER_CHILD.has(upper)) continue;
      if (SAFE_ENV.has(upper) || extras.has(upper)) child[k] = v;
    }
    return child;
  }
  function checkAgent(agent) {
    if (DANGEROUS_MODES.has(agent.permissionMode) || DANGEROUS_MODES.has(agent.sandbox))
      throw new Error('禁止從 Web/Telegram 使用完整權限模式：' + agent.id);
    assertAllowedDir(agent.cwd);
    for (const d of agent.extraDirs || []) {
      assertAllowedDir(d.path, { mustExist: true });
      if (agent.engine === 'claude' && d.mode === 'ro')
        throw new Error('Claude 的 --add-dir 不會強制唯讀；請改用 OS 權限控制或唯讀副本：' + d.path);
      if (agent.engine === 'agy' && agent.agyAccess === 'write' && d.mode === 'ro')
        throw new Error('agy 的可寫成員無法強制資料夾唯讀；請改用 OS 權限控制或唯讀副本：' + d.path);
    }
  }
  function redact(input, secrets = []) {
    let s = String(input ?? '');
    for (const v of [password, ...secrets]) if (typeof v === 'string' && v.length >= 8) s = s.split(v).join('[REDACTED]');
    return s;
  }
  return { verifyHost, checkOrigin, authenticated, touch, changePassword, passwordFromEnv: fromEnv, idleLockMin: IDLE / 60000, jsonRequest, login, logout, logoutAll, checkAgent,
    assertAllowedDir, fileWithin, safeEnvironment, redact, allowedRoots: [...allowedRoots], missingRoots, safeRoot };
}
module.exports = { createSecurity, inside, isProtectedEnvKey };
