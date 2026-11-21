'use strict';
// ⏸ 暫停／▶ 重啟專案：暫停時正在做的停下（立刻停）、每位成員寫交班筆記、同事轉交與排程先排隊、使用者直接講話不受影響；
// 程式重新啟動後仍然暫停、排隊的訊息還在；重啟時被停下的工作接著做（全新對話＋交班筆記）、補充指示交給所有人、排隊的放行。
// 用假的 CLI 跑真的伺服器。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  fs.appendFileSync(process.env.MOCKLOG, '=====CLAUDE ' + process.argv.slice(2).join(' ') + '\\n' + inp + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  const ri = process.argv.indexOf('--resume');
  const sid = ri >= 0 ? process.argv[ri + 1] : 'sess-' + process.pid;
  const who = (/你是「([^」]+)」/.exec(inp) || [])[1] || '?';
  o({ type: 'system', subtype: 'init', session_id: sid });
  let text = '收到';
  if (inp.includes('【系統：專案暫停】')) text = '## 目標\\nNOTE-' + who;
  else if (inp.includes('PMRELAY')) text = '@dev 請做 X';
  const done = () => {
    o({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    o({ type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 0, duration_ms: 5, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  };
  if (inp.includes('SLOW') && !inp.includes('【系統：專案')) setTimeout(done, 15000); else done();
});
`;
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('pause and resume the project', { timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-pause-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'todo.js', 'outbox.js', 'maint.js', 'afterturn.js', 'xlsx.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  const mk = (id, role, team) => ({ id, name: id, avatar: '🤖', role, engine: 'claude', permissionMode: 'acceptEdits', cwd: './workspace', team });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    maxRelayHops: 12, harness: { pauseNoteTokens: 0, headerRefresh: 0 },
    teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便' }, { id: 'b', name: '另一組', icon: '🧪', workflow: '1. 隨便' }],
    agents: [mk('pm', 'PM · 派工', 'main'), mk('dev', 'Coder', 'main'), mk('other', 'QA', 'b')],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  const log = path.join(dir, 'prompts.log');
  const port = await freePort();
  let proc, stderr = '';
  const boot = async () => {
    proc = spawn(process.execPath, ['server.js'], {
      cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'pause-test-password-long', TELEGRAM_BOT_TOKEN: '', AGENTCHAT_TIMER_TICK_MS: '300',
        CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: '', MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1' },
    });
    proc.stderr.on('data', (s) => { stderr += s; });
    for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'pause-test-password-long' }) });
    assert.equal(r.status, 200, stderr);
    cookie = r.headers.get('set-cookie').split(';')[0];
  };
  const halt = async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5000)]); } };
  t.after(async () => { await halt(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); });
  const base = 'http://127.0.0.1:' + port;
  let cookie = '';
  await boot();
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw new Error(p + ' ' + res.status + ' ' + JSON.stringify(j)); return j;
  };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('=====CLAUDE ').filter(Boolean) : [];
  const who = (x) => (/你是「([^」]+)」/.exec(x) || [])[1];
  const agent = async (id) => (await api('/api/agents')).find((a) => a.id === id);
  const waitFor = async (fn, what) => { for (let i = 0; i < 400; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + calls().join('\n----\n') + '\n' + stderr); };
  const idle = async (id) => waitFor(async () => !(await agent(id)).busy, id + ' idle');
  const status = async () => (await api('/api/pause')).pauses;

  // 先讓 pm 有一段對話、dev 開始做很久的事
  await api('/api/chat/pm', 'POST', { text: '你好' }); await idle('pm');
  await api('/api/chat/dev', 'POST', { text: 'SLOW 長工作' });
  await waitFor(() => calls().some((x) => x.includes('SLOW 長工作')), 'dev started');

  // 1) 立刻暫停整個專案：dev 被停下，pm、dev 各寫一份交班筆記，之後狀態變成「已暫停」
  const st = await api('/api/pause', 'POST', { mode: 'now', reason: '午休' });
  assert.equal(st.pauses[0].scope, 'all');
  await waitFor(async () => (await status())[0].phase === 'paused', 'paused');
  const notes = calls().filter((x) => x.includes('【系統：專案暫停】'));
  assert.deepEqual(notes.map(who).sort(), ['dev', 'pm']);
  assert.match(notes[0], /午休/);
  const s1 = (await status())[0];
  assert.equal(s1.notes, 2); assert.equal(s1.restart, 1, 'dev 做到一半的工作記下來了');
  assert.equal((await agent('dev')).paused, true);
  assert.equal((await agent('other')).paused, true);
  await assert.rejects(api('/api/pause', 'POST', {}), /已經暫停/);

  // 2) 暫停中：使用者直接找 pm 照樣回覆；pm 轉交給 dev 的訊息排隊，不叫醒 dev
  const n0 = calls().length;
  await api('/api/chat/pm', 'POST', { text: 'PMRELAY' }); await idle('pm');
  await waitFor(async () => (await status())[0].held === 1, 'relay held');
  await sleep(600);
  assert.equal(calls().length, n0 + 1, '只有 pm 跑了一輪');
  assert.match(calls()[n0], /專案暫停後重新啟動，換成你接手/, 'pm 寫過筆記 → 全新的對話帶著筆記');
  assert.doesNotMatch(calls()[n0], /--resume/);

  // 3) 暫停中排程到點：略過，不叫醒成員
  await api('/api/timers', 'POST', { name: '檢查', agentId: 'dev', prompt: '看看', schedule: { kind: 'once', at: Date.now() + 300 } });
  await waitFor(async () => (await api('/api/timers')).runs.find((r) => /專案暫停中/.test(r.summary || '')), 'timer skipped');
  assert.ok(!calls().some((x) => x.includes('⏰ 排程：檢查')));

  // 4) 程式重新啟動：仍然暫停，排隊的訊息還在
  await halt(); await boot();
  const s2 = (await status())[0];
  assert.equal(s2.phase, 'paused'); assert.equal(s2.held, 1); assert.equal(s2.restart, 1);
  await sleep(2000);
  assert.equal(calls().length, n0 + 1, '重新啟動後也沒有偷跑');

  // 5) 重啟＋補充指示：dev 接著做被停下的工作（全新對話＋自己的筆記＋指示），pm 收到指示，排隊的轉交放行
  await api('/api/resume', 'POST', { text: '改做 B' });
  assert.equal((await status()).length, 0);
  await waitFor(() => calls().filter((x) => x.includes('【系統：專案重啟】')).length >= 2, 'restart messages');
  await waitFor(() => calls().some((x) => who(x) === 'dev' && x.includes('請做 X')), 'held relay released');
  await idle('dev'); await idle('pm');
  const devRestart = calls().find((x) => who(x) === 'dev' && x.includes('【系統：專案重啟】'));
  assert.match(devRestart, /SLOW 長工作/); assert.match(devRestart, /改做 B/);
  assert.match(devRestart, /NOTE-dev/, '帶著自己的交班筆記');
  assert.doesNotMatch(devRestart, /--resume/);
  const pmRestart = calls().find((x) => who(x) === 'pm' && x.includes('【系統：專案重啟】'));
  assert.match(pmRestart, /補充指示[\s\S]*改做 B/);
  assert.equal((await agent('dev')).paused, false);

  // 6) 只暫停一個小組：別的小組不受影響；「做完這一輪」模式下沒人在忙就直接停好
  await api('/api/pause', 'POST', { scope: 'b' });
  assert.equal((await agent('other')).paused, true);
  assert.equal((await agent('dev')).paused, false);
  await waitFor(async () => (await status())[0].phase === 'paused', 'team paused');
  await api('/api/resume', 'POST', { scope: 'b' });
  assert.equal((await agent('other')).paused, false);
});
