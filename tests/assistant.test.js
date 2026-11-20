'use strict';
// 助理（個人秘書）：單次提醒的時間寫法、提出排程後的回饋、每輪附上的「現況摘要」（只給勾選的成員）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const timersLib = require('../timers');
const source = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parsePhrase: single-time reminders, recurring ones unchanged, bad input rejected', () => {
  const now = new Date(2026, 10, 19, 8, 52).getTime(); // 2026/11/19 週四 08:52
  const at = (t) => { const r = timersLib.parsePhrase(t, now); return r && r.schedule.kind === 'once' ? new Date(r.schedule.at) : null; };
  const eq = (t, y, mo, d, h, mi) => { const x = at(t); assert.ok(x, t + ' 應該看得懂'); assert.deepEqual([x.getFullYear(), x.getMonth() + 1, x.getDate(), x.getHours(), x.getMinutes()], [y, mo, d, h, mi], t); };
  eq('明天 15:00', 2026, 11, 20, 15, 0);
  eq('後天下午3點', 2026, 11, 21, 15, 0);
  eq('大後天 早上9點30分', 2026, 11, 22, 9, 30);
  eq('今天 18:30', 2026, 11, 19, 18, 30);
  eq('11/20 15:00', 2026, 11, 20, 15, 0);
  eq('1/5 09:00', 2027, 1, 5, 9, 0);          // 已過的月日 → 明年；數字間的空白不能被吃掉
  eq('11月20日 晚上8點半', 2026, 11, 20, 20, 30);
  eq('2026-12-01 09:30', 2026, 12, 1, 9, 30);
  eq('週五 10:00', 2026, 11, 20, 10, 0);
  eq('週四 10:00', 2026, 11, 19, 10, 0);       // 今天還沒到
  eq('週四 08:00', 2026, 11, 26, 8, 0);        // 今天這個時間過了 → 下週
  eq('下週一 09:00', 2026, 11, 23, 9, 0);
  eq('下週五 10:00', 2026, 11, 27, 10, 0);
  eq('星期日 20:00', 2026, 11, 22, 20, 0);
  eq('明天凌晨12點30分', 2026, 11, 20, 0, 30);
  assert.equal(at('30 分鐘後').getTime(), now + 30 * 60000);
  assert.equal(at('半小時後').getTime(), now + 30 * 60000);
  assert.equal(at('2 小時後').getTime(), now + 120 * 60000);
  assert.equal(at('1小時30分鐘後').getTime(), now + 90 * 60000);
  for (const bad of ['今天 08:00', '明天', '開會', '下午3點', '2026-01-05 08:00', '每週五 09:00以外的東西', '']) assert.equal(at(bad), null, '「' + bad + '」不該被當成單次時間');
  // 重複的寫法照舊
  assert.deepEqual(timersLib.parsePhrase('每天 08:30', now).schedule, { kind: 'daily', time: '08:30' });
  assert.deepEqual(timersLib.parsePhrase('平日 09:00', now).days, [1, 2, 3, 4, 5]);
  assert.deepEqual(timersLib.parsePhrase('每 15 分鐘', now).schedule, { kind: 'every', minutes: 15 });
  assert.deepEqual(timersLib.parsePhrase('每小時', now).schedule, { kind: 'every', minutes: 60 });
});

const MOCK_CLAUDE = `#!/usr/bin/env node
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  require('fs').appendFileSync(process.env.MOCKLOG, '=====CLAUDE ' + process.argv.slice(2).join(' ') + '\\n' + inp + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid });
  let text = '收到';
  if (inp.includes('GOODREMIND')) text = '好的，已經幫你記下：\\n【排程建議】明天 15:00｜提醒使用者：下午三點開會\\n請核准。';
  else if (inp.includes('BADREMIND')) text = '【排程建議】某天某時｜提醒使用者開會';
  o({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  o({ type: 'result', subtype: 'success', session_id: 'sess-' + process.pid, total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
});
`;
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('assistant member through the real server: briefing only for flagged members, reminders proposed with feedback', { timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-asst-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'todo.js', 'maint.js', 'xlsx.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便', cwd: './workspace' }],
    agents: [
      { id: 'pm', name: 'PM', role: 'PM', engine: 'claude', permissionMode: 'auto', cwd: './workspace', team: 'main' },
      { id: 'asst', name: '助理', role: '個人秘書', engine: 'claude', permissionMode: 'acceptEdits', cwd: './workspace/assistant', standalone: true, brief: true, telegram: { prefix: '/助理' } },
    ],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'asst-test-password-long', TELEGRAM_BOT_TOKEN: '', CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: '', AGY_BIN: '',
      MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r0 = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'asst-test-password-long' }) });
  assert.equal(r0.status, 200, stderr);
  const cookie = r0.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const j = await res.json(); if (res.status >= 400) throw new Error(p + ' ' + res.status + ' ' + JSON.stringify(j)); return j;
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('=====CLAUDE ').filter(Boolean) : []);
  const waitFor = async (fn, what) => { for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + calls().join('\n----\n') + '\n' + stderr); };
  const lastReply = async (id) => { const h = (await api('/api/history/' + id)).history.filter((x) => x.role === 'assistant'); const l = h[h.length - 1]; return l ? l.segments.map((s) => s.text).join('\n') : ''; };
  const idle = async (id) => !(await api('/api/agents')).find((a) => a.id === id).busy;

  assert.equal((await api('/api/config')).agents.find((a) => a.id === 'asst').brief, true, '設定有存下 brief');

  // 先建一個排程，讓摘要裡有東西
  await api('/api/timers', 'POST', { name: '檢查派工狀態', prompt: '看一下派工', agentId: 'pm', schedule: { kind: 'every', minutes: 15 }, enabled: false });
  for (let i = 1; i <= 12; i++) await api('/api/timers', 'POST', { name: '固定' + i, prompt: '固定' + i, agentId: 'pm', schedule: { kind: 'every', minutes: 30 }, enabled: false });
  await api('/api/timers', 'POST', { name: '銀行', prompt: '提醒使用者：去銀行辦事', agentId: 'asst', schedule: { kind: 'once', at: Date.now() + 2 * 86400000 }, notify: 'always' });

  // 1) 勾了「現況摘要」的助理：每輪都有時間與排程；沒勾的成員沒有
  await api('/api/chat/asst', 'POST', { text: '現在有哪些排程？' });
  await waitFor(() => calls().length === 1, 'asst call');
  const c1 = calls()[0];
  assert.match(c1, /【現況（系統提供的唯讀資料/);
  assert.match(c1, /現在：2026|現在：20\d\d\//, '有現在的日期時間');
  assert.match(c1, /時區 \S+/);
  assert.match(c1, /#1 檢查派工狀態｜PM｜每 15 分鐘｜已停用/);
  assert.match(c1, /行程與提醒（只做一次的，依時間排序，共 1 個）：\n- #14 \d+\/\d+（週.）\d\d:\d\d｜提醒使用者：去銀行辦事/, '行程獨立列出，不會被 13 個固定排程擠掉');
  assert.match(c1, /固定排程（13 個）：/); assert.match(c1, /- …還有 5 個/);
  await waitFor(() => idle('asst'), 'asst idle');
  await api('/api/chat/pm', 'POST', { text: '你好' });
  await waitFor(() => calls().length === 2, 'pm call');
  assert.doesNotMatch(calls()[1], /【現況（系統提供/, '沒勾的成員不會多帶');
  await waitFor(() => idle('pm'), 'pm idle');

  // 2) 助理提出單次提醒 → 排程建議（一定通知）；成員在對話裡看到回饋
  await api('/api/chat/asst', 'POST', { text: 'GOODREMIND 明天下午三點提醒我開會' });
  await waitFor(async () => /已送出排程建議（只做一次：/.test(await lastReply('asst')), 'feedback ok');
  const snap = await api('/api/timers');
  assert.equal(snap.proposals.length, 1);
  const p = snap.proposals[0];
  assert.equal(p.schedule.kind, 'once'); assert.equal(p.notify, 'always'); assert.equal(p.agentName, '助理');
  const want = new Date(); want.setDate(want.getDate() + 1); want.setHours(15, 0, 0, 0);
  assert.equal(p.schedule.at, want.getTime(), '明天 15:00');
  const accepted = await api('/api/timers/proposals/' + p.id + '/accept', 'POST', {});
  assert.equal(accepted.schedule.kind, 'once'); assert.equal(accepted.nextRun, want.getTime());
  await waitFor(() => idle('asst'), 'asst idle 2');

  // 3) 時間看不懂：不再悄悄丟掉，會告訴成員怎麼改寫
  await api('/api/chat/asst', 'POST', { text: 'BADREMIND 某天提醒我' });
  await waitFor(async () => /排程建議沒有送出：看不懂時間「某天某時」/.test(await lastReply('asst')), 'feedback bad');
  assert.equal((await api('/api/timers')).proposals.length, 0);
  assert.match(c1, /【排程建議】明天 15:00｜要做的事/, '開頭說明（第一輪完整送）有教單次的寫法');
});
