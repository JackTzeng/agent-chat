'use strict';
// ⚡ 緊急派工：被授權的成員（PM）在派工訊息寫【緊急】→ 中斷正在工作的同事、先處理緊急的事、再回頭做原本的工作；
// 沒授權、冷卻中、反過來打斷、功能關閉 → 一律改成排隊。用假的 CLI 跑真的伺服器。
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
  o({ type: 'system', subtype: 'init', session_id: sid });
  let text = '收到';
  if (inp.includes('PMRELAY')) text = '@dev 【緊急】請改做 B';
  else if (inp.includes('DEVRELAY')) text = '@pm 【緊急】我需要你先確認';
  const done = () => {
    o({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    o({ type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 0, duration_ms: 5, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  };
  // 內容有 SLOW 而且不是緊急／繼續的訊息：假裝工作很久
  if (inp.includes('SLOW') && !inp.includes('⚡【緊急派工：') && !inp.includes('緊急的事已經處理完')) setTimeout(done, 12000); else done();
});
`;
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('urgent dispatch through the real server', { timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-urgent-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  const mk = (id, role, extra = {}) => ({ id, name: id, avatar: '🤖', role, engine: 'claude', permissionMode: 'acceptEdits', cwd: './workspace', team: 'main', ...extra });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    maxRelayHops: 12, teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便' }],
    agents: [mk('pm', 'PM · 派工'), mk('dev', 'Coder · 實作'), mk('qa', 'QA', { canInterrupt: false })],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  const log = path.join(dir, 'prompts.log');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'urgent-test-password-long', TELEGRAM_BOT_TOKEN: '',
      CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: '', MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'urgent-test-password-long' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw new Error(p + ' ' + res.status + ' ' + JSON.stringify(j)); return j;
  };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('=====CLAUDE ').filter(Boolean) : [];
  const agentState = async (id) => (await api('/api/agents')).find((a) => a.id === id);
  const waitFor = async (fn, what) => { for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + calls().join('\n----\n') + '\n' + stderr); };
  const idle = async (id) => waitFor(async () => !(await agentState(id)).busy, id + ' idle');

  // 預設：角色寫 PM 的成員有授權，其他沒有
  assert.equal((await agentState('pm')).canInterrupt, true);
  assert.equal((await agentState('dev')).canInterrupt, false);

  // 1) dev 正在做很久的事 → PM 派【緊急】→ dev 被中斷，先做緊急的，再回頭繼續
  await api('/api/chat/dev', 'POST', { text: 'SLOW 慢慢做的工作' });
  await waitFor(() => calls().some((x) => x.includes('SLOW 慢慢做的工作')), 'dev started');
  await api('/api/chat/pm', 'POST', { text: 'PMRELAY' });
  await waitFor(() => calls().length >= 4, 'urgent + resume ran');
  await idle('dev'); await idle('pm');
  const c = calls();
  const devCalls = c.filter((x) => !x.includes('PMRELAY'));
  assert.match(devCalls[0], /SLOW 慢慢做的工作/, '先是原本的工作');
  assert.match(devCalls[1], /⚡【緊急派工：pm】/, '被緊急插話');
  assert.match(devCalls[1], /請改做 B/);
  assert.match(devCalls[2], /緊急的事已經處理完/, '之後回頭繼續');
  const sidOf = (x) => (/--resume (sess-\d+)/.exec(x) || [])[1];
  assert.ok(sidOf(devCalls[1]) && sidOf(devCalls[1]) === sidOf(devCalls[2]), '緊急的事和原本的工作用同一段對話');
  assert.equal(devCalls.length, 3);
  const hist = (await api('/api/history/dev')).history.map((h) => h.segments ? h.segments.map((s) => s.text).join(' ') : h.text).join('\n');
  assert.match(hist, /收到 pm 的緊急派工|收到.*緊急派工/);

  // 2) 冷卻中：再來一次 → 不中斷，改排隊（等它做完這一輪才處理）
  await api('/api/chat/dev', 'POST', { text: 'SLOW 第二件' });
  await waitFor(() => calls().some((x) => x.includes('SLOW 第二件')), 'dev started 2');
  const n0 = calls().length;
  await api('/api/chat/pm', 'POST', { text: 'PMRELAY' });
  await waitFor(async () => (await agentState('dev')).queued === 1, 'queued instead of interrupt');
  assert.equal(calls().length, n0 + 1, '只有 PM 自己跑了一輪，dev 沒被中斷');
  await api('/api/stop/dev', 'POST', {}).catch(() => {});
  await idle('dev');

  // 3) 沒有授權的成員（dev）想緊急插話 PM → 排隊，不中斷
  await api('/api/chat/pm', 'POST', { text: 'SLOW pm 很忙' });
  await waitFor(() => calls().some((x) => x.includes('SLOW pm 很忙')), 'pm started');
  await api('/api/chat/dev', 'POST', { text: 'DEVRELAY' });
  await waitFor(async () => (await agentState('pm')).queued === 1, 'dev cannot interrupt pm');
  assert.ok(!calls().some((x) => x.includes('⚡【緊急派工：dev】')));
  await api('/api/stop/pm', 'POST', {}).catch(() => {});

  // 4) 設成 0 分鐘 → 整個功能關閉
  const team = (await api('/api/config')).teams[0];
  await api('/api/team', 'PUT', { teamId: team.id, urgentCooldownMin: 0 });
  assert.equal((await api('/api/config')).urgentCooldownMin, 0);
});
