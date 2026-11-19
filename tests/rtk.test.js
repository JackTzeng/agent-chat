'use strict';
// 🗜 rtk（只限 Claude 成員）：rtkhook.js 只採用 rtk 的指令改寫、拿掉自動核准；勾選的 Claude 團隊成員才會帶 --settings 接上 hook。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假的 rtk：依環境變數決定 hook 的回應
const MOCK_RTK = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a === '--version') { console.log('rtk 9.9.9'); process.exit(0); }
if (a === 'gain') { console.log('Total saved: 12345 tokens'); process.exit(0); }
if (a !== 'hook claude') process.exit(1);
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  const cmd = JSON.parse(inp).tool_input.command;
  const mode = process.env.MOCK_RTK_MODE || 'allow';
  if (mode === 'deny') { process.stderr.write('denied by rule'); process.exit(2); }
  if (mode === 'crash') process.exit(1);
  if (mode === 'none') process.exit(0);
  if (mode === 'denyjson') { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } })); return; }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: mode === 'ask' ? 'ask' : 'allow', permissionDecisionReason: 'RTK auto-rewrite', updatedInput: { command: 'rtk ' + cmd } } }));
});
`;

test('rtkhook keeps the rewrite but drops auto-approval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-rtkhook-'));
  try {
    const rtk = path.join(dir, 'rtk'); fs.writeFileSync(rtk, MOCK_RTK, { mode: 0o755 });
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } });
    const run = (mode, bin = rtk) => spawnSync(process.execPath, [path.join(source, 'rtkhook.js'), bin], { input, env: { ...process.env, MOCK_RTK_MODE: mode }, encoding: 'utf8' });
    for (const mode of ['allow', 'ask']) {
      const r = run(mode);
      assert.equal(r.status, 0);
      const j = JSON.parse(r.stdout);
      assert.equal(j.hookSpecificOutput.updatedInput.command, 'rtk git status');
      assert.equal(j.hookSpecificOutput.permissionDecision, undefined, mode + '：不能替成員核准');
    }
    const d = run('deny'); assert.equal(d.status, 2, 'rtk 擋下的照樣擋'); assert.match(d.stderr, /denied/);
    const dj = run('denyjson'); assert.equal(dj.status, 0); assert.equal(JSON.parse(dj.stdout).hookSpecificOutput.permissionDecision, 'deny');
    for (const mode of ['crash', 'none']) { const r = run(mode); assert.equal(r.status, 0); assert.equal(r.stdout, '', mode + '：不改寫'); }
    const missing = run('allow', path.join(dir, 'no-such-rtk')); assert.equal(missing.status, 0); assert.equal(missing.stdout, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}
const MOCK_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  fs.appendFileSync(process.env.MOCKLOG, JSON.stringify({ argv: process.argv.slice(2), prompt: inp }) + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid });
  o({ type: 'assistant', message: { content: [{ type: 'text', text: '收到' }] } });
  o({ type: 'result', subtype: 'success', session_id: 'sess-' + process.pid, total_cost_usd: 0, duration_ms: 5, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

test('only checked Claude team members get the rtk hook', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-rtk-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'todo.js', 'rtkhook.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  const mk = (id, extra = {}) => ({ id, name: id, avatar: '🤖', role: 'x', engine: 'claude', permissionMode: 'acceptEdits', cwd: './workspace', team: 'main', ...extra });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便' }],
    agents: [mk('on', { rtk: true }), mk('off'), mk('tooled', { rtk: true, allowedTools: ['Bash(npm test)'] }), mk('ledger', { rtk: true, standalone: true })],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'rtk'), MOCK_RTK, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'rtk-test-password-long', TELEGRAM_BOT_TOKEN: '',
      CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: '', RTK_BIN: path.join(bin, 'rtk'), MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'rtk-test-password-long' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw new Error(p + ' ' + res.status + ' ' + JSON.stringify(j)); return j;
  };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const ask = async (id) => {
    const n = calls().length;
    await api('/api/chat/' + id, 'POST', { text: '你好' });
    for (let i = 0; i < 200 && calls().length <= n; i++) await sleep(50);
    for (let i = 0; i < 200 && (await api('/api/agents')).find((a) => a.id === id).busy; i++) await sleep(50);
    return calls()[n];
  };

  const on = await ask('on');
  const k = on.argv.indexOf('--settings');
  assert.ok(k > 0, '勾選的 Claude 團隊成員要帶 --settings');
  const settings = JSON.parse(fs.readFileSync(on.argv[k + 1], 'utf8'));
  const hook = settings.hooks.PreToolUse[0];
  assert.equal(hook.matcher, 'Bash');
  assert.match(hook.hooks[0].command, /rtkhook\.js" ".*bin\/rtk"$/);
  assert.match(on.prompt, /【指令輸出精簡】/);
  for (const id of ['off', 'tooled', 'ledger']) {
    const c = await ask(id);
    assert.ok(!c.argv.includes('--settings'), id + ' 不使用 rtk');
    assert.doesNotMatch(c.prompt, /【指令輸出精簡】/);
  }
  const ags = await api('/api/agents');
  assert.equal(ags.find((a) => a.id === 'on').rtkOn, true);
  assert.equal(ags.find((a) => a.id === 'tooled').rtkOn, false);

  // 📏 面板與 /api/rtk
  const h = await api('/api/harness');
  assert.equal(h.rtk.version, 'rtk 9.9.9');
  assert.deepEqual(h.rtk.members.filter((m) => m.active).map((m) => m.id), ['on']);
  assert.match((await api('/api/rtk?gain=1')).gain, /12345/);
});
