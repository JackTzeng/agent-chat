'use strict';
// Harness 六要素的測試：標記解析、檢查指令清理，以及用假的 CLI 跑一整件任務
// （自動檢查失敗 → 退回修正 → 通過、守則建議、專案記憶、預算暫停、觀測紀錄）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { extractTags, cleanChecks } = require('../harness');
const source = path.resolve(__dirname, '..');

test('extractTags finds lesson and decision lines only at line start', () => {
  const t = extractTags('做完了\n【守則建議】交接前先跑測試\n【守則建議→許代書】先讀 PLAN.md\n【守則建議（給 開發組）】用 UTF-8\n- **【決策】** 用 SQLite\n文中提到【決策】不算');
  assert.deepEqual(t.lessons, ['交接前先跑測試', '先讀 PLAN.md', '用 UTF-8']);
  assert.deepEqual(t.lessonTo, ['', '許代書', '開發組']);
  assert.deepEqual(t.decisions, ['用 SQLite']);
});

test('cleanChecks parses names, keeps Windows paths and drops unsafe input', () => {
  const c = cleanChecks('單元測試: npm test\nC:\\tools\\lint.cmd\n\nbad\u0000cmd\n' + 'x'.repeat(600));
  assert.deepEqual(c, [{ name: '單元測試', command: 'npm test' }, { name: '', command: 'C:\\tools\\lint.cmd' }]);
  assert.equal(cleanChecks(Array(9).fill('echo hi')).length, 5);
});

// ---------- 端對端：假的 Claude / Codex ----------
const MOCK_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  if (process.env.MOCKLOG) fs.appendFileSync(process.env.MOCKLOG, '=====CLAUDE\\n' + inp + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'system', subtype: 'init', session_id: 'c' + Date.now() });
  let text = '你好';
  if (inp.includes('【你現在負責的階段：規劃】')) text = '計畫完成\\n【決策】資料庫用 SQLite\\n【交接】\\n給：許代書\\n內容：請建立 ok.txt';
  else if (inp.includes('【你現在負責的階段：測試】')) text = '測試通過\\n【守則建議→許代書】交接前先自己跑 node check.js\\n【交接】\\n給：克勞德先生（驗收）\\n內容：全部通過';
  else if (inp.includes('【你現在負責的階段：驗收】')) text = '全部完成，可以使用了。';
  o({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  o({ type: 'result', subtype: 'success', session_id: 'c1', total_cost_usd: 0.02, duration_ms: 50, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20 } });
});
`;
const MOCK_CODEX = `#!/usr/bin/env node
const fs = require('fs');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  if (process.env.MOCKLOG) fs.appendFileSync(process.env.MOCKLOG, '=====CODEX\\n' + inp + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'thread.started', thread_id: 't' + Date.now() });
  // 第一次交接不建檔（讓自動檢查失敗）；收到「自動檢查沒通過」才修正。任務目標有 NOFIX 就永遠不修。
  if (inp.includes('自動檢查沒通過') && !inp.includes('NOFIX')) fs.writeFileSync('ok.txt', 'ok');
  o({ type: 'item.completed', item: { type: 'agent_message', text: '實作完成\\n【交接】\\n給：小安\\n內容：請測試' } });
  o({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
});
`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('task flow with sensors, lessons, memory, budget and observability', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-harness-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'todo.js', 'outbox.js', 'maint.js', 'afterturn.js', 'xlsx.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  { // 假 CLI 只看這一輪的提示詞，所以每輪都要完整送開頭說明（開頭去重在 context.test.js 測）
    const cfg0 = JSON.parse(fs.readFileSync(path.join(dir, 'agents.example.json'), 'utf8'));
    cfg0.harness = { ...(cfg0.harness || {}), headerRefresh: 0 };
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(cfg0));
  }
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), MOCK_CODEX, { mode: 0o755 });
  const log = path.join(dir, 'prompts.log');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'harness-test-password-long', TELEGRAM_BOT_TOKEN: '',
      CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: path.join(bin, 'codex'), MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  let r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'harness-test-password-long' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw new Error(p + ' ' + res.status + ' ' + JSON.stringify(j)); return j;
  };
  const waitTask = async (pred, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const d = await api('/api/tasks'); const x = d.tasks[0]; if (x && pred(x)) return x; await sleep(100); }
    throw new Error('timeout: ' + JSON.stringify((await api('/api/tasks')).tasks[0]) + '\n' + stderr);
  };

  // 流程：規劃不需要核准；實作加上自動檢查
  const cfg = await api('/api/config');
  const wf = cfg.workflow;
  wf.stages.find((s) => s.id === 'plan').approval = false;
  wf.stages.find((s) => s.id === 'build').checks = ['檔案存在: node -e "require(\'fs\').accessSync(\'ok.txt\')"'];
  await api('/api/team', 'PUT', { workflow: wf, harness: { maxReworks: 2, checkTimeoutSec: 30 } });
  const cfg2 = await api('/api/config');
  assert.equal(cfg2.workflow.stages.find((s) => s.id === 'build').checks[0].name, '檔案存在');
  assert.equal(cfg2.harness.maxReworks, 2);

  // 任務 1：檢查先失敗、退回修正後通過，一路到完成
  await api('/api/tasks', 'POST', { goal: '做一個 ok 檔' });
  const done = await waitTask((x) => x.status === 'done');
  const detail = await api('/api/tasks/' + done.id);
  assert.match(detail.markdown, /🧪 自動檢查沒通過/);
  assert.match(detail.markdown, /🧪 自動檢查通過/);
  assert.match(detail.markdown, /\*\*自動檢查\*\*/);
  const prompts = fs.readFileSync(log, 'utf8');
  assert.match(prompts, /【自動檢查沒通過（第 1 次，上限 2 次）】/);
  assert.match(prompts, /【系統附註：交出前的自動檢查】\n✅ 檔案存在/);
  assert.match(prompts, /【專案記憶/, 'later turns see the decision memory');
  assert.match(prompts, /資料庫用 SQLite/);

  let h = await api('/api/harness');
  assert.equal(h.proposals.length, 1);
  assert.equal(h.proposals[0].text, '交接前先自己跑 node check.js');
  assert.equal(h.proposals[0].scope, 'kai', '預設只給被點名的許代書');
  assert.ok(h.memory.some((m) => m.kind === 'decision' && m.text === '資料庫用 SQLite'));
  assert.ok(h.memory.some((m) => m.kind === 'result' && /任務 #1/.test(m.text)));
  assert.ok(h.stats.agents.length >= 3);
  assert.equal(h.stats.sensorsRun, 2);
  assert.equal(h.stats.sensorsFailed, 1);
  const claudeStats = h.stats.agents.find((a) => a.agent === 'hikari');
  assert.ok(claudeStats.costUsd > 0 && claudeStats.inTok > 0);
  assert.ok(fs.existsSync(path.join(dir, 'workspace', 'MEMORY.md')));

  // 核准守則建議（沒改範圍 → 只給許代書）→ 許代書每一輪都會看到，其他人看不到
  await api('/api/harness/proposals/' + h.proposals[0].id + '/accept', 'POST', {});
  h = await api('/api/harness');
  assert.equal(h.proposals.length, 0);
  assert.equal(h.guides[0].text, '交接前先自己跑 node check.js');
  assert.equal(h.guides[0].scope, 'kai');
  assert.match(fs.readFileSync(path.join(dir, 'workspace', 'GUIDES.md'), 'utf8'), /## 成員：許代書\n\n- 交接前先自己跑/);
  fs.writeFileSync(log, '');
  await api('/api/chat/hikari', 'POST', { text: '嗨' });
  await api('/api/chat/kai', 'POST', { text: '嗨' });
  for (let i = 0; i < 100 && !(fs.readFileSync(log, 'utf8').includes('CLAUDE') && fs.readFileSync(log, 'utf8').includes('CODEX')); i++) await sleep(50);
  const sections = fs.readFileSync(log, 'utf8').split('=====').filter(Boolean);
  const claudePart = sections.filter((x) => x.startsWith('CLAUDE')).join(''), codexPart = sections.filter((x) => x.startsWith('CODEX')).join('');
  assert.match(codexPart, /【守則[^\n]*\n- 交接前先自己跑 node check\.js/);
  assert.doesNotMatch(claudePart, /交接前先自己跑/, '克勞德先生不會收到只給許代書的守則');

  // 任務 2：Coder 一直修不好 → 超過預算，暫停交給使用者
  fs.rmSync(path.join(dir, 'workspace', 'ok.txt'));
  await api('/api/tasks', 'POST', { goal: 'NOFIX 永遠修不好' });
  const held = await waitTask((x) => x.id === 2 && x.status === 'waiting_user');
  assert.match(held.note, /自動檢查已經連續失敗 3 次（上限 2 次）/);
  h = await api('/api/harness');
  assert.equal(h.stats.budgetStops, 1);
  await api('/api/tasks/2/stop', 'POST', {});

  // 守則與記憶的 CRUD
  const g = await api('/api/harness/guides', 'POST', { text: '文件用繁體中文', scope: 'kai' });
  await api('/api/harness/guides/' + g.id, 'PUT', { text: '所有文件用繁體中文' });
  await api('/api/harness/guides/' + g.id, 'DELETE');
  const m = await api('/api/harness/memory', 'POST', { text: '客戶要求報表用 A4' });
  await api('/api/harness/memory/' + m.id, 'DELETE');
  h = await api('/api/harness');
  assert.equal(h.guides.length, 1);
  assert.ok(!h.memory.some((x) => x.id === m.id));
});
