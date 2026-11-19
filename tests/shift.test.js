'use strict';
// 換班：對話用到設定的比例時，先請成員寫交班筆記，再換成全新的對話（不帶 --resume）接手
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const source = path.resolve(__dirname, '..');

const MOCK_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  const resume = process.argv.includes('--resume');
  fs.appendFileSync(process.env.MOCKLOG, '=====CLAUDE resume=' + resume + '\\n' + inp + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'system', subtype: 'init', session_id: 'c' + Date.now() + Math.floor(Math.random() * 1e6) });
  let text = '好的';
  if (inp.includes('【系統：換班】')) text = '## 目標\\nNOTE-XYZ 做報表\\n## 下一步\\n畫圖';
  const big = inp.includes('BIGCTX') && !inp.includes('【系統：換班】');
  o({ type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: big ? 149000 : 500, output_tokens: 50 }, content: [{ type: 'text', text }] } });
  o({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 100, output_tokens: 50 } });
});
`;
const MOCK_CODEX = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  const resume = process.argv.includes('resume');
  fs.appendFileSync(process.env.MOCKLOG, '=====CODEX resume=' + resume + '\\n' + inp + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  const tid = resume ? process.argv[process.argv.length - 2] : 'th' + Date.now();
  if (!resume) o({ type: 'thread.started', thread_id: tid });
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '15'); fs.mkdirSync(dir, { recursive: true });
  const big = inp.includes('BIGCTX') && !inp.includes('【系統：換班】');
  fs.appendFileSync(path.join(dir, 'rollout-2026-11-15T10-00-00-' + tid + '.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: big ? 220000 : 3000 }, model_context_window: 272000 } } }) + '\\n');
  o({ type: 'item.completed', item: { type: 'agent_message', text: inp.includes('【系統：換班】') ? '## 目標\\nCODEX-NOTE' : '收到' } });
  o({ type: 'turn.completed', usage: { input_tokens: 999999, output_tokens: 5 } });
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('auto shift writes a handover note and starts a fresh session', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-shift-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), MOCK_CODEX, { mode: 0o755 });
  const log = path.join(dir, 'prompts.log'); fs.writeFileSync(log, '');
  const codexHome = path.join(dir, 'codexhome'); fs.mkdirSync(codexHome);
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'shift-test-password-long', TELEGRAM_BOT_TOKEN: '',
      CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: path.join(bin, 'codex'), MOCKLOG: log, CODEX_HOME: codexHome,
      AGENT_ENV_ALLOWLIST: 'MOCKLOG' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'shift-test-password-long' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw Object.assign(new Error(p + ' ' + res.status + ' ' + JSON.stringify(j)), { status: res.status }); return j;
  };
  const agent = async (id) => (await api('/api/agents')).find((a) => a.id === id);
  const idle = async (id) => { for (let i = 0; i < 200; i++) { const a = await agent(id); if (!a.busy && !a.queued) return a; await sleep(50); } throw new Error('busy ' + stderr); };
  const runs = (eng) => fs.readFileSync(log, 'utf8').split('=====' + eng).slice(1);

  // ---- Claude：第一句把 context 撐到 75%（> 預設 60%）----
  await api('/api/chat/hikari', 'POST', { text: 'BIGCTX 第一句' });
  let a = await idle('hikari');
  assert.equal(a.ctx.pct, 75);
  assert.equal(a.shiftNo, 1);
  await api('/api/chat/hikari', 'POST', { text: '第二句' });
  a = await idle('hikari');
  let c = runs('CLAUDE');
  assert.equal(c.length, 3, 'first, shift, second');
  assert.match(c[1], /^ resume=true[\s\S]*【系統：換班】/);
  assert.match(c[2], /^ resume=false/);
  assert.match(c[2], /【換班：你是接手的第 2 班】[\s\S]*NOTE-XYZ 做報表[\s\S]*【使用者訊息】\n第二句/);
  assert.equal(a.shiftNo, 2);
  assert.ok(a.ctx.pct < 10);
  // 第三句：繼續用新的一班，不再附交班筆記
  await api('/api/chat/hikari', 'POST', { text: '第三句' });
  await idle('hikari');
  c = runs('CLAUDE');
  assert.equal(c.length, 4);
  assert.match(c[3], /^ resume=true/);
  assert.doesNotMatch(c[3], /交班筆記/);
  const hist = (await api('/api/history/hikari')).history;
  assert.ok(hist.some((m) => m.role === 'user' && /^🔄 換班/.test(m.text)));
  assert.ok(fs.readdirSync(path.join(dir, 'data', 'harness', 'shifts')).length >= 1);

  // ---- 手動換班 ----
  await api('/api/shift/hikari', 'POST');
  a = await idle('hikari');
  assert.equal(a.shiftNo, 3);
  assert.equal(runs('CLAUDE').length, 5);

  // ---- Codex：從 rollout 讀 context（turn.completed 的累計數字不拿來判斷）----
  await api('/api/chat/kai', 'POST', { text: '一般的一句' });
  let k = await idle('kai');
  assert.ok(k.ctx && k.ctx.pct <= 2, JSON.stringify(k.ctx));
  await api('/api/chat/kai', 'POST', { text: 'BIGCTX 很長的一句' });
  k = await idle('kai');
  assert.equal(k.ctx.pct, 81);
  await api('/api/chat/kai', 'POST', { text: '接著做' });
  k = await idle('kai');
  const x = runs('CODEX');
  assert.equal(x.length, 4);
  assert.match(x[2], /【系統：換班】/);
  assert.match(x[3], /^ resume=false[\s\S]*CODEX-NOTE/);
  assert.equal(k.shiftNo, 2);

  // 關閉自動換班
  await api('/api/team', 'PUT', { harness: { shiftPercent: 0 } });
  await api('/api/chat/hikari', 'POST', { text: 'BIGCTX 再撐大' });
  await idle('hikari');
  await api('/api/chat/hikari', 'POST', { text: '不換班' });
  await idle('hikari');
  assert.equal(runs('CLAUDE').length, 7);
  let h = await api('/api/harness');
  assert.equal(h.stats.shifts, 3);

  // ---- 任務模式：同一件任務的對話太長，也會換班，換班那一輪不算任務的交接 ----
  await api('/api/team', 'PUT', { harness: { shiftPercent: 60 } });
  await api('/api/tasks', 'POST', { goal: 'BIGCTX 任務' });
  const waitTask = async (pred) => { for (let i = 0; i < 200; i++) { const d = await api('/api/tasks'); if (d.tasks[0] && pred(d.tasks[0])) return d.tasks[0]; await sleep(50); } throw new Error('task timeout ' + stderr); };
  let tk = await waitTask((x) => x.status === 'waiting_user');
  const turns = tk.turns;
  await api('/api/tasks/' + tk.id + '/reply', 'POST', { text: '繼續規劃' });
  tk = await waitTask((x) => x.status === 'waiting_user' && x.turns > turns);
  assert.equal(tk.turns, turns + 1, 'shift turn is not counted as a task turn');
  c = runs('CLAUDE');
  assert.match(c[c.length - 2], /【系統：換班】/);
  assert.match(c[c.length - 1], /^ resume=false[\s\S]*【換班：你是接手的第 2 班】[\s\S]*TASK\.md[\s\S]*繼續規劃/);
  h = await api('/api/harness');
  assert.equal(h.stats.shifts, 4);
});
