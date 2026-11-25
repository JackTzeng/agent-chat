'use strict';
// 🧰 CLI 狀態：解析 CLI 的輸出（只取名稱與狀態、不外流指令參數）、成員用得到哪些 MCP，以及經過真的伺服器的 API。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const cs = require('../clistatus');
const source = path.resolve(__dirname, '..');
const { copyServer } = require('./_files');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parse claude mcp list: names + status only, never the command or URL', () => {
  const out = cs.parseClaudeMcpList([
    'Checking MCP server health...',
    '',
    'github: npx -y @modelcontextprotocol/server-github --token ghp_SECRET123 - ✓ Connected',
    'notion: https://mcp.notion.com/mcp?key=abc (HTTP) - ⚠ Needs authentication',
    'broken: node C:\\tools\\x.js - ✗ Failed to connect',
  ].join('\n'));
  assert.deepEqual(out.map((x) => [x.name, x.status]), [['github', 'ok'], ['notion', 'warn'], ['broken', 'fail']]);
  assert.ok(!JSON.stringify(out).includes('SECRET'), '指令參數不會留下來');
  assert.ok(!JSON.stringify(out).includes('key=abc'), '網址不會留下來');
  assert.deepEqual(cs.parseClaudeMcpList('No MCP servers configured. Use `claude mcp add` to add a server.'), []);
});

test('parse codex config.toml / json / login status', () => {
  const toml = '[model]\nx = 1\n[mcp_servers.github]\ncommand = "npx"\nenv = { GITHUB_TOKEN = "ghp_SECRET" }\n[mcp_servers."my-db"]\ncommand = "x"\nenabled = false\n';
  const t = cs.parseCodexToml(toml);
  assert.deepEqual(t.map((x) => [x.name, x.status]), [['github', 'configured'], ['my-db', 'off']]);
  assert.ok(!JSON.stringify(t).includes('SECRET'));
  assert.deepEqual(cs.parseCodexJson('[{"name":"a","enabled":true,"transport":{"command":"secret"}},{"name":"b","enabled":false}]').map((x) => [x.name, x.status]), [['a', 'configured'], ['b', 'off']]);
  assert.equal(cs.parseCodexJson('not json'), null);
  assert.equal(cs.parseCodexLogin('Logged in using ChatGPT').state, 'ok');
  assert.equal(cs.parseCodexLogin('Not logged in').state, 'no');
  assert.equal(cs.parseCodexLogin('error: unrecognized subcommand'), null);
  assert.equal(cs.maskEmail('jane.doe@example.com'), 'ja***@example.com');
});

test('member MCP: least-privilege allowlist, disallowed, plan mode, agy', () => {
  const servers = [{ name: 'github', status: 'ok' }, { name: 'notion', status: 'ok' }];
  assert.deepEqual(cs.memberMcp({ engine: 'claude', permissionMode: 'auto' }, servers).servers, ['github', 'notion']);
  const lp = cs.memberMcp({ engine: 'claude', permissionMode: 'default', allowedTools: ['Read', 'mcp__notion__search'] }, servers);
  assert.deepEqual(lp.servers, ['notion']); assert.match(lp.note, /允許清單/);
  assert.deepEqual(cs.memberMcp({ engine: 'claude', permissionMode: 'default', allowedTools: ['Read'] }, servers).servers, []);
  assert.deepEqual(cs.memberMcp({ engine: 'claude', permissionMode: 'auto', disallowedTools: ['mcp__github'] }, servers).servers, ['notion']);
  assert.match(cs.memberMcp({ engine: 'claude', permissionMode: 'plan' }, servers).note, /plan/);
  assert.deepEqual(cs.memberMcp({ engine: 'codex' }, [{ name: 'a', status: 'configured' }, { name: 'b', status: 'off' }]).servers, ['a']);
  assert.match(cs.memberMcp({ engine: 'agy', agyAccess: 'read' }, []).note, /還沒實測/);
});

const MOCK_CLAUDE = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
require('fs').appendFileSync(process.env.MOCKLOG, 'CLAUDE ' + a + '\\n');
if (a === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (a === 'mcp list') { console.log('Checking MCP server health...\\n\\ngithub: npx server-github --token ghp_SECRET - ✓ Connected\\nnotion: https://x/mcp - ✗ Failed to connect'); process.exit(0); }
process.exit(1);
`;
const MOCK_CODEX = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
require('fs').appendFileSync(process.env.MOCKLOG, 'CODEX ' + a + '\\n');
if (a === '--version') { console.log('codex-cli 9.1.0'); process.exit(0); }
if (a === 'login status') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (a === 'mcp list --json') { console.log('[{"name":"fs","enabled":true}]'); process.exit(0); }
process.exit(2);
`;
const MOCK_AGY = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
require('fs').appendFileSync(process.env.MOCKLOG, 'AGY ' + a + '\\n');
if (a === '--version') { console.log('1.5.10'); process.exit(0); }
process.exit(1);
`;
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('CLI status through the real server', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-cli-'));
  copyServer(dir, ['agents.example.json']);
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便' }],
    agents: [
      { id: 'pm', name: 'PM', role: 'PM', engine: 'claude', permissionMode: 'auto', cwd: './workspace', team: 'main' },
      { id: 'bk', name: '記帳員', role: '記帳', engine: 'claude', permissionMode: 'default', allowedTools: ['Read', 'mcp__notion'], cwd: './workspace', standalone: true },
      { id: 'cx', name: 'cx', role: 'dev', engine: 'codex', cwd: './workspace', team: 'main' },
      { id: 'gm', name: 'gm', role: 'rev', engine: 'agy', agyAccess: 'read', cwd: './workspace', team: 'main' },
    ],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const [n, c] of [['claude', MOCK_CLAUDE], ['codex', MOCK_CODEX], ['agy', MOCK_AGY]]) fs.writeFileSync(path.join(bin, n), c, { mode: 0o755 });
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com', organizationName: 'Demo Org' } }));
  const log = path.join(dir, 'calls.log');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'cli-test-password-long', TELEGRAM_BOT_TOKEN: '', CLAUDE_CONFIG_DIR: home,
      CODEX_HOME: path.join(home, '.codex'), CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: path.join(bin, 'codex'), AGY_BIN: path.join(bin, 'agy'),
      MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'cli-test-password-long' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET') => (await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })).json();

  let s = await api('/api/clistatus');
  assert.equal(s.running, true, '第一次開啟就自動開始檢查');
  for (let i = 0; i < 200 && !(s.at && !s.running); i++) { await sleep(50); s = await api('/api/clistatus'); }
  assert.ok(s.at, 'timeout\n' + stderr);
  const eng = Object.fromEntries(s.engines.map((e) => [e.engine, e]));
  assert.equal(eng.claude.version, '9.9.9 (Claude Code)');
  assert.equal(eng.claude.login.state, 'ok'); assert.equal(eng.claude.login.email, 'so***@example.com');
  assert.deepEqual(eng.claude.mcp[0].servers.map((x) => [x.name, x.status]), [['github', 'ok'], ['notion', 'fail']]);
  assert.equal(eng.codex.login.state, 'ok');
  assert.deepEqual(eng.codex.mcp[0].servers.map((x) => x.name), ['fs']);
  assert.equal(eng.agy.version, '1.5.10');
  assert.equal(eng.agy.login.state, 'unknown', 'agy 沒執行過：無法判斷');
  const mem = Object.fromEntries(s.members.map((m) => [m.id, m]));
  assert.deepEqual(mem.pm.servers, ['github', 'notion']);
  assert.deepEqual(mem.bk.servers, ['notion'], '最小權限成員只算允許清單裡的');
  assert.deepEqual(mem.cx.servers, ['fs']);
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes('SECRET') && !raw.includes('someone@'), '不外流指令參數與完整 email');
  const calls = fs.readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /CLAUDE (-p|auth)/, '不會叫 Claude 跑提示（不耗額度）');
  assert.doesNotMatch(calls, /AGY (?!--version)/, 'agy 只查版本');

  // 重新檢查
  const before = calls.split('\n').length;
  await api('/api/clistatus/refresh', 'POST');
  for (let i = 0; i < 200; i++) { await sleep(50); s = await api('/api/clistatus'); if (!s.running && fs.readFileSync(log, 'utf8').split('\n').length > before) break; }
  assert.ok(fs.readFileSync(log, 'utf8').split('\n').length > before, '重新檢查會再跑一次');
});
