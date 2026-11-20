'use strict';
// 📏 上下文：開頭說明沒變就不重送（一行提示）、有變／每 N 輪才完整送；排程預設每次開新對話。用假的 CLI 跑真的伺服器。
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

test('header dedupe + context load + fresh timer sessions', { timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-ctx-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'todo.js', 'maint.js', 'xlsx.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  const mk = (id, role, extra = {}) => ({ id, name: id, avatar: '🤖', role, engine: 'claude', permissionMode: 'acceptEdits', cwd: './workspace', team: 'main', ...extra });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    maxRelayHops: 12, teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便' }],
    agents: [mk('dev', 'Coder · 實作', { persona: '你很會寫程式。'.repeat(30) }), mk('qa', 'QA')],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  const log = path.join(dir, 'prompts.log');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'ctx-test-password-long', TELEGRAM_BOT_TOKEN: '',
      CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: '', MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'ctx-test-password-long' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw new Error(p + ' ' + res.status + ' ' + JSON.stringify(j)); return j;
  };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('=====CLAUDE ').filter(Boolean) : [];
  const waitFor = async (fn, what) => { for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + calls().join('\n----\n') + '\n' + stderr); };
  const idle = async (id) => waitFor(async () => !(await api('/api/agents')).find((a) => a.id === id).busy, id + ' idle');
  const say = async (id, text) => { const n = calls().length; await api('/api/chat/' + id, 'POST', { text }); await waitFor(() => calls().length > n, text); await idle(id); return calls()[n]; };

  // 1) 第一輪完整送；之後內容沒變 → 只送一行提示（而且比完整的短很多）
  const c1 = await say('dev', '第一句');
  assert.match(c1, /【你的身分】/);
  const c2 = await say('dev', '第二句');
  assert.match(c2, /【說明沒有變動】/);
  assert.doesNotMatch(c2, /【你的身分】/);
  assert.match(c2, /第二句/);
  assert.ok(c2.length < c1.length / 2, '第二輪明顯比第一輪短');
  const c3 = await say('dev', '第三句');
  assert.match(c3, /【說明沒有變動】/);

  // 2) 📏 統計
  const h = await api('/api/harness');
  const row = h.contextLoad.find((x) => x.id === 'dev');
  assert.ok(row.header > 300 && row.persona >= 90, JSON.stringify(row));
  assert.ok(row.skipped === 2 && row.saved > 0, '省下兩輪：' + JSON.stringify(row));
  assert.equal(h.headerRefresh, 10);

  // 3) 守則有變 → 這一輪完整重送（新守則出現），之後又省略
  await api('/api/harness/guides', 'POST', { text: '一律用 UTF-8 存檔', scope: 'all' });
  const c4 = await say('dev', '第四句');
  assert.match(c4, /【你的身分】/);
  assert.match(c4, /一律用 UTF-8 存檔/);
  const c5 = await say('dev', '第五句');
  assert.match(c5, /【說明沒有變動】/);

  // 4) 每 N 輪完整送一次（N=3：第 3 輪起重送）
  await api('/api/team', 'PUT', { harness: { headerRefresh: 3 } });
  const seq = [];
  for (const w of ['甲', '乙', '丙', '丁']) seq.push(/【你的身分】/.test(await say('dev', w)) ? 'full' : 'same');
  assert.ok(seq.includes('full'), '至少有一次重新完整送：' + seq);
  assert.ok(!/same,same,same/.test(seq.join(',')), 'N=3：連續省略不超過 2 輪：' + seq);

  // 5) 0 ＝ 關閉：每一輪都完整送
  await api('/api/team', 'PUT', { harness: { headerRefresh: 0 } });
  assert.match(await say('dev', 'A'), /【你的身分】/);
  assert.match(await say('dev', 'B'), /【你的身分】/);

  // 6) 排程預設每次開全新的對話（不帶 --resume）；勾「記得上次的對話」才接著上次
  await api('/api/team', 'PUT', { harness: { headerRefresh: 10 } });
  const tm = await api('/api/timers', 'POST', { name: '檢查', agentId: 'qa', prompt: '看看狀況', schedule: { kind: 'daily', time: '08:30' } });
  for (let i = 0; i < 2; i++) {
    const n = calls().length;
    await api('/api/timers/' + tm.id + '/run', 'POST');
    await waitFor(() => calls().length > n, 'timer run ' + i); await idle('qa');
    await waitFor(async () => (await api('/api/timers')).timers[0].runs === i + 1, 'timer done ' + i);
  }
  const tcalls = calls().filter((x) => x.includes('⏰ 排程：檢查'));
  assert.equal(tcalls.length, 2);
  assert.doesNotMatch(tcalls[0], /--resume/);
  assert.doesNotMatch(tcalls[1], /--resume/, '第二次也是新對話');
  assert.match(tcalls[1], /【你的身分】/, '新對話要有完整說明');
  const keep = await api('/api/timers', 'POST', { name: '記得', agentId: 'qa', prompt: '接著看', keepSession: true, schedule: { kind: 'daily', time: '09:30' } });
  for (let i = 0; i < 2; i++) {
    const n = calls().length;
    await api('/api/timers/' + keep.id + '/run', 'POST');
    await waitFor(() => calls().length > n, 'keep run ' + i); await idle('qa');
    await waitFor(async () => (await api('/api/timers')).timers.find((x) => x.id === keep.id).runs === i + 1, 'keep done ' + i);
  }
  const kcalls = calls().filter((x) => x.includes('⏰ 排程：記得'));
  assert.doesNotMatch(kcalls[0], /--resume/);
  assert.match(kcalls[1], /--resume/, '勾了記得上次的對話 → 接著上次');
  assert.match(kcalls[1], /【說明沒有變動】/);
});
