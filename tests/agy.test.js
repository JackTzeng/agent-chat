'use strict';
// Google Antigravity（agy）引擎：stream-json 解析、參數、唯讀成員改了檔案就暫停；用假的 agy 跑真的伺服器。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const agy = require('../agy');
const source = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 120) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function run(events) {
  const out = [], parse = agy.makeParser(short);
  for (const e of events) parse(e, (x) => out.push(x));
  return out;
}

test('parser: init → session, text deltas merged, tool call + result, usage', () => {
  const out = run([
    { event: 'init', conversation_id: 'conv-1', init: { model: 'gemini-4-argon-high', permission_mode: 'request-review', cwd: '/x', tools: ['run_command'] } },
    { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 0, state: 'DONE', step_type: 'user_input' } },
    { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/x/a.txt' } } } },
    { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/x/a.txt' }, output: 'hello' } } },
    { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'rm -rf x' } } } },
    { event: 'step_update', step_update: { step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'rm -rf x' }, error: { type: 'PERMISSION_DENIED', message: 'not allowed' } } } },
    { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '第一段，' } },
    { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '第二段。' } },
    { event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response' } },
    { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: '第一段，第二段。', duration_seconds: 4.2, num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 50, total_tokens: 175 } } },
  ]);
  assert.deepEqual(out.filter((x) => x.kind === 'session').map((x) => x.id), ['conv-1', 'conv-1']);
  const tools = out.filter((x) => x.kind === 'tool');
  assert.equal(tools[0].text, '📖 讀取：/x/a.txt');
  assert.equal(tools[1].text, '⚙️ 執行：rm -rf x');
  const res = out.filter((x) => x.kind === 'toolres');
  assert.equal(res[0].isError, false); assert.equal(res[0].text, 'hello');
  assert.equal(res[1].isError, true); assert.equal(res[1].text, 'not allowed');
  const texts = out.filter((x) => x.kind === 'text');
  assert.equal(texts.length, 1, '最終回覆只出現一次（不會因為 result.response 重複）');
  assert.equal(texts[0].text, '第一段，第二段。');
  const done = out.find((x) => x.kind === 'done');
  assert.equal(done.stats.inTok, 150); assert.equal(done.stats.outTok, 25);
  assert.match(done.meta, /gemini-4-argon-high · 175 tokens · 4\.2s/);
  assert.equal(out.find((x) => x.kind === 'ctx').tokens, 175);
  assert.ok(!out.some((x) => x.kind === 'error'));
});

test('parser: DONE carrying the full text replaces, only result.response, denied actions, errors', () => {
  // 最後一筆帶「整段」
  assert.equal(run([
    { event: 'step_update', step_update: { step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'abc' } },
    { event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: 'abcdef' } },
  ]).find((x) => x.kind === 'text').text, 'abcdef');
  // 步驟沒文字：用 result.response
  const o2 = run([{ event: 'result', result: { status: 'SUCCESS', response: '只有結果', num_turns: 1 } }]);
  assert.equal(o2.find((x) => x.kind === 'text').text, '只有結果');
  // 被擋下的動作與錯誤狀態
  const o3 = run([{ event: 'result', result: { status: 'WAITING', response: '', denied_actions: [{ action: 'run_command', display_name: 'RunCommand' }] } }]);
  assert.match(o3.find((x) => x.kind === 'tool').text, /被擋下：RunCommand/);
  assert.match(o3.find((x) => x.kind === 'error').text, /等待核准/);
  assert.match(run([{ event: 'result', result: { status: 'ERROR', error: 'invalid model selection' } }]).find((x) => x.kind === 'error').text, /invalid model/);
  // 異常的權限模式要警告
  assert.match(run([{ event: 'init', conversation_id: 'c', init: { permission_mode: 'always-proceed' } }]).find((x) => x.kind === 'tool').text, /always-proceed/);
  // 不認得的東西不能讓解析器壞掉
  assert.deepEqual(run([null, 42, { foo: 1 }, { event: 'step_update' }]).filter((x) => x.kind === 'error'), []);
});

test('parser: real agy 1.5.10 transcript (text arrives in deltas, last DONE delta is just a newline)', () => {
  const T = 'agy-real';
  const out = run([
    { event: 'init', conversation_id: T, init: { model: 'gemini-3.8-flash-high', cwd: 'C:\\agy_test', tools: ['run_command', 'write_to_file'], permission_mode: 'request-review' } },
    { event: 'step_update', step_update: { conversation_id: T, step_index: 0, state: 'DONE', step_type: 'user_input' } },
    { event: 'step_update', step_update: { conversation_id: T, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '我是由 Google DeepMind 開發的 AI 助理 An' } },
    { event: 'step_update', step_update: { conversation_id: T, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'tigravity，' } },
    { event: 'step_update', step_update: { conversation_id: T, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '致力於協助您高效解決問題並完成各項任務。' } },
    { event: 'step_update', step_update: { conversation_id: T, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n', duration_seconds: 6.2, usage: { input_tokens: 9759, output_tokens: 336, thinking_tokens: 308, cache_read_tokens: 0, total_tokens: 10095 } } },
    { event: 'result', result: { conversation_id: T, status: 'SUCCESS', response: '我是由 Google DeepMind 開發的 AI 助理 Antigravity，致力於協助您高效解決問題並完成各項任務。\n', duration_seconds: 6.29, num_turns: 1, usage: { input_tokens: 9759, output_tokens: 336, thinking_tokens: 308, cache_read_tokens: 0, total_tokens: 10095 } } },
  ]);
  assert.deepEqual(out.filter((x) => x.kind === 'text').map((x) => x.text), ['我是由 Google DeepMind 開發的 AI 助理 Antigravity，致力於協助您高效解決問題並完成各項任務。']);
  assert.ok(!out.some((x) => x.kind === 'error'));
});

test('read-only args can be overridden but never skip permissions', () => {
  assert.deepEqual(agy.readOnlyArgs(), ['--mode', 'plan', '--sandbox']);
  process.env.AGY_READONLY_ARGS = '--mode ask';
  assert.deepEqual(agy.readOnlyArgs(), ['--mode', 'ask']);
  process.env.AGY_READONLY_ARGS = '--dangerously-skip-permissions';
  assert.throws(() => agy.readOnlyArgs(), /不能包含/);
  delete process.env.AGY_READONLY_ARGS;
  assert.deepEqual(agy.writeArgs(), [], '可寫成員預設不加參數');
  process.env.AGY_WRITE_ARGS = '--sandbox';
  assert.deepEqual(agy.writeArgs(), ['--sandbox']);
  process.env.AGY_WRITE_ARGS = '--always-proceed';
  assert.throws(() => agy.writeArgs(), /AGY_WRITE_ARGS 不能包含/);
  delete process.env.AGY_WRITE_ARGS;
  assert.equal(agy.access({}), 'read');
  assert.equal(agy.access({ agyAccess: 'write' }), 'write');
  assert.deepEqual(JSON.parse(agy.stdinMessage('你好\n世界')), { event: 'user', message: { content: '你好\n世界' } });
});

// ---------- 端對端：真的伺服器＋假的 agy ----------
const MOCK_AGY = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  let prompt = '';
  try { prompt = JSON.parse(inp.trim().split('\\n')[0]).message.content; } catch { prompt = inp; }
  fs.appendFileSync(process.env.MOCKLOG, '=====AGY ' + args.join(' ') + '\\n' + prompt + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  const ci = args.indexOf('--conversation');
  const conv = ci >= 0 ? args[ci + 1] : 'conv-' + process.pid;
  o({ event: 'init', conversation_id: conv, init: { model: 'gemini-4-argon-high', permission_mode: 'request-review', cwd: process.cwd(), tools: [] } });
  if (prompt.includes('QUOTA')) {
    o({ event: 'result', result: { conversation_id: conv, status: 'ERROR', error: 'RESOURCE_EXHAUSTED: You have exhausted your quota. Please retry in 2h30m.', num_turns: 0 } });
    process.exit(1);
  }
  if (prompt.includes('MENTION')) {
    o({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '@gw 請修正 R19' } });
    o({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: '', num_turns: 1, usage: { total_tokens: 15 } } });
    return;
  }
  if (prompt.includes('SNEAKY')) fs.writeFileSync(path.join(process.cwd(), 'oops.txt'), 'changed by a read-only member');
  o({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '審查意見：' } });
  o({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '沒有問題' } });
  o({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'DONE', step_type: 'agent_response' } });
  o({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: '', duration_seconds: 1.5, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
});
`;
test('quota: detect exhausted errors and parse the reset time', () => {
  const now = Date.UTC(2026, 10, 18, 10, 0, 0);
  assert.ok(agy.quotaHit('RESOURCE_EXHAUSTED: quota exceeded'));
  assert.ok(agy.quotaHit('HTTP 429 Too Many Requests'));
  assert.ok(agy.quotaHit('You have reached your usage limit'));
  assert.ok(!agy.quotaHit('invalid model selection'));
  assert.ok(!agy.quotaHit('Command exited with code 1'));
  assert.equal(agy.quotaReset('quota exhausted, retry in 2h30m', now), now + 2.5 * 3600000);
  assert.equal(agy.quotaReset('Usage limit reached. Resets in 3 hours.', now), now + 3 * 3600000);
  assert.equal(agy.quotaReset('{"retryDelay": "3600s"}', now), now + 3600000);
  assert.equal(agy.quotaReset('quota resets at 2026-11-19T00:00:00Z', now), Date.UTC(2026, 10, 19));
  assert.equal(agy.quotaReset('quota exceeded', now), null);
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('agy member through the real server: stdin prompt, resume, read-only args, violation pauses the member', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-agy-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'todo.js', 'xlsx.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    maxRelayHops: 12, teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便' }],
    agents: [
      { id: 'gem', name: 'gem', avatar: '🔍', role: 'Reviewer', engine: 'agy', model: 'gemini-4-argon-high', effort: 'high', agyAccess: 'read', cwd: './workspace', team: 'main' },
      { id: 'gw', name: 'gw', avatar: '✍️', role: 'Writer', engine: 'agy', agyAccess: 'write', cwd: './workspace', team: 'main' },
    ],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'agy'), MOCK_AGY, { mode: 0o755 });
  const log = path.join(dir, 'prompts.log');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'agy-test-password-long', TELEGRAM_BOT_TOKEN: '',
      CLAUDE_BIN: '', CODEX_BIN: '', AGY_BIN: path.join(bin, 'agy'), MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'agy-test-password-long' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw new Error(p + ' ' + res.status + ' ' + JSON.stringify(j)); return j;
  };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('=====AGY ').filter(Boolean) : [];
  const waitFor = async (fn, what) => { for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + calls().join('\n----\n') + '\n' + stderr); };
  const agentOf = async (id) => (await api('/api/agents')).find((a) => a.id === id);
  const lastReply = async (id) => { const h = (await api('/api/history/' + id)).history.filter((x) => x.role === 'assistant'); const l = h[h.length - 1]; return l ? l.segments.map((s) => s.text).join('\n') : ''; };

  assert.equal((await agentOf('gem')).agyAccess, 'read');
  assert.equal((await agentOf('gw')).agyAccess, 'write');

  // 1) 唯讀成員：參數、stdin 提示、文字合併、之後用 --conversation 接續
  await api('/api/chat/gem', 'POST', { text: '請審查這份計畫' });
  await waitFor(async () => (await lastReply('gem')).includes('審查意見：沒有問題'), 'reply');
  let c = calls();
  const meta1 = (await api('/api/history/gem')).history.filter((x) => x.role === 'assistant').at(-1).meta;
  assert.match(meta1, /對話累計 15 tokens/, 'tokens 標明是整段對話累計');
  assert.doesNotMatch(meta1, /1\.5s/, 'agy 回報的 1.5 秒是整段對話累計，改成這一輪實際花的時間');
  assert.match(c[0], /--input-format stream-json --output-format stream-json --model gemini-4-argon-high --effort high --mode plan --sandbox/);
  assert.doesNotMatch(c[0], /dangerously|-p /);
  assert.match(c[0], /請審查這份計畫/);
  assert.match(c[0], /【唯讀】/, '唯讀說明有告訴成員');
  await waitFor(async () => !(await agentOf('gem')).busy, 'gem idle');
  await api('/api/chat/gem', 'POST', { text: '再看一次' });
  await waitFor(() => calls().length === 2, 'second call');
  assert.match(calls()[1], /--conversation conv-\d+/, '接續同一段對話');

  // 2) 可寫成員：不加唯讀參數、說明可以執行指令但只在工作資料夾內
  await api('/api/chat/gw', 'POST', { text: '寫個檔案' });
  await waitFor(() => calls().length === 3, 'gw call');
  assert.doesNotMatch(calls()[2], /--mode plan|--sandbox/);
  assert.match((await agentOf('gw')).agyRisk || '', /Agent Chat 程式資料夾/, './workspace 在程式資料夾裡 → 警告');
  assert.equal((await agentOf('gem')).agyRisk, null, '唯讀成員不警告');
  assert.match(calls()[2], /也可以執行指令/);
  assert.doesNotMatch(calls()[2], /不能執行指令/);
  await waitFor(async () => !(await agentOf('gw')).busy, 'gw idle');

  // 3) 唯讀成員偷偷改了檔案 → 這一輪出現警告、成員被暫停；在設定按儲存才解除
  await waitFor(async () => !(await agentOf('gem')).busy, 'gem idle 2');
  await api('/api/chat/gem', 'POST', { text: 'SNEAKY 請審查' });
  await waitFor(async () => (await agentOf('gem')).blocked || (await lastReply('gem')).includes('唯讀成員'), 'violation noticed');
  assert.match(await lastReply('gem'), /oops\.txt/);
  await waitFor(async () => !(await agentOf('gem')).busy, 'gem idle 3');
  const n = calls().length;
  await api('/api/chat/gem', 'POST', { text: '還能工作嗎' });
  await waitFor(async () => /已暫停這位成員/.test(await lastReply('gem')), 'paused message');
  assert.equal(calls().length, n, '暫停後沒有再呼叫 agy');
  const cfg = (await api('/api/config')).agents.find((a) => a.id === 'gem');
  await api('/api/agents/gem', 'PUT', { name: cfg.name, role: cfg.role, engine: 'agy', model: cfg.model, effort: cfg.effort, agyAccess: 'read', cwd: cfg.cwd, team: 'main' });
  fs.rmSync(path.join(dir, 'workspace', 'oops.txt'), { force: true });
  await api('/api/chat/gem', 'POST', { text: '恢復了' });
  await waitFor(() => calls().length === n + 1, 'resumed after save');
  await waitFor(async () => !(await agentOf('gem')).busy, 'gem idle 4');

  // 4) 額度用完：成員卡片與用量面板顯示、恢復時間取自錯誤訊息
  await api('/api/chat/gw', 'POST', { text: 'QUOTA 測試' });
  await waitFor(async () => (await lastReply('gw')).includes('額度用完'), 'quota noticed');
  await waitFor(async () => !(await agentOf('gw')).busy, 'gw idle 2');
  const out = (await agentOf('gw')).agyOut;
  assert.ok(out > Date.now() + 2 * 3600000 && out < Date.now() + 3 * 3600000, '預計恢復時間 ≈ 2 小時 30 分後');
  let u = (await api('/api/usage')).agy.find((x) => x.id === 'gw');
  assert.equal(u.quotaHits, 1); assert.ok(u.runs >= 2); assert.ok(u.out && !u.out.estimated);
  assert.ok((await api('/api/usage')).agy.find((x) => x.id === 'gem').tokens > 0, '本週 tokens 有累計');

  // 5) 同事派工給額度用完的成員：不呼叫 agy、退回並通知派工的人（同一段期間只通知一次）
  const m = calls().length;
  await api('/api/chat/gem', 'POST', { text: 'MENTION 派工' });
  await waitFor(async () => /額度用完/.test(await lastReply('gw')), 'bounced');
  await waitFor(() => calls().length === m + 2, 'sender notified');
  assert.match(calls()[m + 1], /【系統通知】gw 的 agy 額度用完了/);
  assert.match(calls()[m + 1], /請改派給其他成員/);
  assert.ok(!calls().slice(m).some((c) => c.includes('@gw 請修正 R19\n') && !c.includes('系統通知')), 'gw 沒有被呼叫');
  await waitFor(async () => !(await agentOf('gem')).busy, 'gem idle 5');
  await api('/api/chat/gem', 'POST', { text: 'MENTION 再派一次' });
  await waitFor(() => calls().length === m + 3, 'second mention');
  await sleep(500);
  assert.equal(calls().length, m + 3, '第二次退回不再通知（避免來回）');

  // 6) 你直接傳訊息：照樣試，成功就自動解除
  await waitFor(async () => !(await agentOf('gw')).busy && !(await agentOf('gem')).busy, 'idle before retry');
  await api('/api/chat/gw', 'POST', { text: '額度好了嗎' });
  await waitFor(async () => (await lastReply('gw')).includes('額度恢復了'), 'quota cleared');
  assert.equal((await agentOf('gw')).agyOut, null);
  u = (await api('/api/usage')).agy.find((x) => x.id === 'gw');
  assert.equal(u.out, null); assert.equal(u.quotaHits, 1);
});
