'use strict';
// ⏰ 排程：時間計算、同一次不重複觸發、錯過只補一次、上一次沒做完就略過、重啟標成中斷、
// 【無異常】保持安靜、【通知】才通知、相同內容不重複通知、成員的【排程建議】要核准；
// 最後用假的 CLI 跑過真的伺服器（獨立對話、結果記錄、建議收集）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const T = require('../timers');
const source = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const DAYMS = 86400000;

test('computeNext: every with work hours and weekdays, daily, once', () => {
  const t = { schedule: { kind: 'every', minutes: 60 }, days: [1, 2, 3, 4, 5], hours: { from: '08:00', to: '18:00' } };
  // 2026-11-16 是星期一
  assert.equal(T.computeNext(t, at(2026, 11, 16, 9, 0)), at(2026, 11, 16, 10, 0));
  assert.equal(T.computeNext(t, at(2026, 11, 16, 9, 37)), at(2026, 11, 16, 10, 0), '對齊整點');
  assert.equal(T.computeNext(t, at(2026, 11, 16, 17, 30)), at(2026, 11, 16, 18, 0), '18:00 還在工作時間內');
  assert.equal(T.computeNext(t, at(2026, 11, 16, 18, 0)), at(2026, 11, 17, 8, 0), '超過 18:00 → 隔天 08:00');
  assert.equal(T.computeNext(t, at(2026, 11, 20, 18, 5)), at(2026, 11, 23, 8, 0), '星期五傍晚 → 下週一 08:00');
  assert.equal(T.computeNext({ schedule: { kind: 'every', minutes: 30 }, days: [] }, at(2026, 11, 16, 9, 10)), at(2026, 11, 16, 9, 30));
  assert.equal(T.computeNext({ schedule: { kind: 'every', minutes: 45 }, days: [] }, at(2026, 11, 16, 9, 10)), at(2026, 11, 16, 9, 55), '不能整除一小時的照間隔算');
  assert.equal(T.computeNext(t, at(2026, 11, 16, 6, 0)), at(2026, 11, 16, 8, 0), '清晨 → 當天 08:00');
  const d = { schedule: { kind: 'daily', time: '08:30' }, days: [] };
  assert.equal(T.computeNext(d, at(2026, 11, 16, 8, 0)), at(2026, 11, 16, 8, 30));
  assert.equal(T.computeNext(d, at(2026, 11, 16, 8, 30)), at(2026, 11, 17, 8, 30));
  assert.equal(T.computeNext({ ...d, days: [1, 2, 3, 4, 5] }, at(2026, 11, 20, 9, 0)), at(2026, 11, 23, 8, 30), '平日 → 跳過週末');
  assert.equal(T.computeNext({ schedule: { kind: 'once', at: 123 } }, 0), 123);
  assert.equal(T.computeNext({ schedule: { kind: 'once', at: 123 }, done: true }, 0), null);
});

test('parsePhrase understands common Chinese schedule phrases', () => {
  assert.deepEqual(T.parsePhrase('每小時'), { schedule: { kind: 'every', minutes: 60 }, days: [] });
  assert.deepEqual(T.parsePhrase('每 30 分鐘'), { schedule: { kind: 'every', minutes: 30 }, days: [] });
  assert.deepEqual(T.parsePhrase('每2小時'), { schedule: { kind: 'every', minutes: 120 }, days: [] });
  assert.deepEqual(T.parsePhrase('每天 8:30'), { schedule: { kind: 'daily', time: '08:30' }, days: [] });
  assert.deepEqual(T.parsePhrase('平日 17:00'), { schedule: { kind: 'daily', time: '17:00' }, days: [1, 2, 3, 4, 5] });
  assert.equal(T.parsePhrase('有空的時候'), null);
});

test('scheduler: fire once per slot, catch up once, skip overlap, quiet on 無異常, dedupe alerts, restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-timers-'));
  const sent = [], notes = [], props = [];
  const agent = { id: 'em', name: '阿資' };
  const ctx = { DATA_DIR: dir, agentById: (id) => (id === 'em' ? agent : null),
    dispatch: (a, text, opts) => { sent.push({ text, opts }); return 'started'; }, notify: (e) => notes.push(e), onProposal: (p) => props.push(p) };
  let s = T.create(ctx);
  assert.throws(() => s.create({ name: 'x', prompt: 'y', agentId: 'em', schedule: { kind: 'every', minutes: 5 } }), /15 分鐘/);
  const t = s.create({ name: '檢查超標', prompt: '看看有沒有新的超標資料', agentId: 'em', schedule: { kind: 'every', minutes: 60 } });
  assert.ok(t.nextRun > Date.now() && t.nextRun <= Date.now() + 60 * 60000 && new Date(t.nextRun).getMinutes() === 0, '每小時對齊整點');

  // 到期 → 觸發一次；同一個 slot 再 tick 不會重複
  const slot = t.nextRun;
  s.tick(slot + 1000);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /【⏰ 排程：檢查超標】第 1 次/);
  assert.match(sent[0].text, /【無異常】/);
  assert.equal(sent[0].opts.timerId, t.id);
  assert.equal(sent[0].opts.sessionTag, 'x' + t.id);
  s.tick(slot + 2000);
  assert.equal(sent.length, 1, '同一次不重複觸發');

  // 上一次還沒做完 → 下一次略過
  const next = s.byId(t.id).nextRun;
  s.tick(next + 1000);
  assert.equal(sent.length, 1, '上一次還沒做完，這次略過');

  // 做完：【無異常】→ 不通知
  s.onDone({ timerId: t.id, agent, segments: [{ type: 'text', text: '【無異常】今天沒有新的超標' }] });
  assert.equal(notes.length, 0);
  assert.equal(s.byId(t.id).last.status, 'ok');
  assert.equal(s.byId(t.id).last.quietReason, '無異常');
  // 有異常 → 通知；同樣內容再一次 → 不重複
  s.runNow(t.id);
  s.onDone({ timerId: t.id, agent, segments: [{ type: 'text', text: '發現問題\n【通知】A 區落菌數超標 2 筆' }] });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].summary, 'A 區落菌數超標 2 筆');
  s.runNow(t.id);
  s.onDone({ timerId: t.id, agent, segments: [{ type: 'text', text: '【通知】A 區落菌數超標 2 筆' }] });
  assert.equal(notes.length, 1, '和上次一樣的通知不重複發');
  assert.match(s.byId(t.id).last.quietReason, /一樣/);
  // 沒照規則回（沒有標記）→ 保守起見通知；失敗一定通知
  s.runNow(t.id);
  s.onDone({ timerId: t.id, agent, segments: [{ type: 'error', text: 'CLI 結束碼 1' }] });
  assert.equal(notes.length, 2);
  assert.equal(notes[1].status, 'failed');

  // 錯過很多次（程式關了一整天）→ 只補做一次，並說明是補做
  const before = sent.length;
  const tt = s.byId(t.id);
  const missed = tt.nextRun;
  s.tick(missed + 26 * 3600000);
  assert.equal(sent.length, before + 1);
  assert.match(sent[sent.length - 1].text, /補做：原本/);
  assert.ok(s.byId(t.id).nextRun > missed + 26 * 3600000);

  // 重新啟動：進行中的標成中斷；已觸發的 slot 不會再觸發
  const firedSlot = s.byId(t.id).firedKey;
  s = T.create(ctx);
  assert.equal(s.byId(t.id).last.status, 'interrupted');
  assert.equal(s.byId(t.id).active, undefined);
  assert.equal(s.byId(t.id).firedKey, firedSlot);

  // 只做一次：做完就停用
  const once = s.create({ name: '提醒', prompt: '再檢查一次', agentId: 'em', schedule: { kind: 'once', at: Date.now() + 60000 } });
  s.tick(Date.now() + 61000);
  assert.equal(s.byId(once.id).enabled, false);
  assert.equal(s.byId(once.id).done, true);

  // 成員的【排程建議】→ 待核准；核准後變成排程
  s.collect(agent, '好的\n【排程建議】平日 08:30｜整理昨天的帳並寫進表單\n【排程建議】有空再說｜不會被收', null);
  assert.equal(props.length, 1);
  const snap = s.snapshot();
  assert.equal(snap.proposals.length, 1);
  assert.equal(snap.proposals[0].desc, '平日 08:30');
  const made = s.acceptProposal(snap.proposals[0].id, { name: '整理帳目' });
  assert.equal(made.name, '整理帳目');
  assert.equal(made.createdBy, 'em');
  assert.equal(s.snapshot().proposals.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('precheck skips the AI run when there is nothing to do; members can pause until a new task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-timers-pre-'));
  const sent = [], notes = [];
  let checkResult = { code: 0, out: '' };
  const agent = { id: 'em', name: '阿資' };
  const s = T.create({ DATA_DIR: dir, agentById: (id) => (id === 'em' ? agent : null),
    dispatch: (a, text, opts) => { sent.push({ text, opts }); return 'started'; }, notify: (e) => notes.push(e),
    runCheck: async () => checkResult });
  const t = s.create({ name: '派工', prompt: '檢查 dispatch.json', agentId: 'em', schedule: { kind: 'every', minutes: 60 }, precheck: 'node pm/check_dispatch.mjs' });
  assert.equal(t.precheck, 'node pm/check_dispatch.mjs');
  assert.equal(t.allowPause, true);
  assert.throws(() => s.create({ name: 'x', prompt: 'y', agentId: 'em', schedule: { kind: 'every', minutes: 60 }, precheck: 'a\nb' }), /一行指令/);
  // 沒有輸出 → 不叫醒成員
  s.tick(s.byId(t.id).nextRun + 1000);
  await sleep(20);
  assert.equal(sent.length, 0, '沒事就不叫醒');
  assert.equal(s.byId(t.id).checks, 1);
  assert.equal(s.byId(t.id).active, undefined);
  assert.equal(s.snapshot().runs[0].status, 'idle');
  // 有輸出 → 叫醒並附上輸出
  checkResult = { code: 0, out: 'WO-Q3a 逾時 2 小時\n' };
  s.tick(s.byId(t.id).nextRun + 1000);
  await sleep(20);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /【前置檢查 node pm\/check_dispatch\.mjs 的輸出】\nWO-Q3a 逾時 2 小時/);
  assert.match(sent[0].text, /【排程暫停】/, '提示成員可以暫停');
  // 成員回【排程暫停】→ 停用並通知一次
  s.onDone({ timerId: t.id, agent, segments: [{ type: 'text', text: '【無異常】已處理\n【排程暫停】所有工單都完成了' }] });
  let x = s.byId(t.id);
  assert.equal(x.enabled, false);
  assert.equal(x.nextRun, null);
  assert.equal(x.paused.reason, '所有工單都完成了');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].status, 'paused');
  s.tick(Date.now() + 10 * DAYMS);
  assert.equal(sent.length, 1, '暫停後不會再觸發');
  // 有新任務 → 自動恢復；你自己暫停的不會被恢復
  const mine = s.create({ name: '我暫停的', prompt: 'z', agentId: 'em', schedule: { kind: 'every', minutes: 60 } });
  s.setEnabled(mine.id, false);
  const back = s.resumePaused(['em'], '任務 #3 開始');
  assert.deepEqual(back.map((b) => b.id), [t.id]);
  x = s.byId(t.id);
  assert.equal(x.enabled, true);
  assert.ok(x.nextRun > Date.now());
  assert.equal(x.paused, undefined);
  assert.equal(s.byId(mine.id).enabled, false);
  // 手動執行不先檢查
  checkResult = { code: 0, out: '' };
  s.runNow(t.id);
  assert.equal(sent.length, 2);
  // 前置檢查失敗（結束碼不是 0）→ 叫醒成員並說明
  s.onDone({ timerId: t.id, agent, segments: [{ type: 'text', text: '【無異常】' }] });
  checkResult = { code: 2, out: '' };
  s.tick(s.byId(t.id).nextRun + 1000);
  await sleep(20);
  assert.equal(sent.length, 3);
  assert.match(sent[2].text, /前置檢查結束碼 2/);
  // 成員的建議可以附前置檢查
  s.collect(agent, '【排程建議】每小時｜檢查派工｜先檢查：node pm/check_dispatch.mjs', null);
  const pr = s.snapshot().proposals[0];
  assert.equal(pr.prompt, '檢查派工');
  assert.equal(pr.precheck, 'node pm/check_dispatch.mjs');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 端對端：真的伺服器＋假的 CLI ----------
const MOCK_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  if (process.env.MOCKLOG) fs.appendFileSync(process.env.MOCKLOG, '=====CLAUDE ' + process.argv.slice(2).join(' ') + '\\n' + inp + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  const sid = inp.includes('【⏰ 排程') ? 'timer-session' : 'main-session';
  o({ type: 'system', subtype: 'init', session_id: sid });
  let text = '好的';
  if (inp.includes('PAUSEME')) text = '【無異常】都做完了\\n【排程暫停】所有工單都完成';
  else if (inp.includes('ALERT')) text = '【通知】發現 1 筆超標';
  else if (inp.includes('【⏰ 排程')) text = '【無異常】都正常';
  else if (inp.includes('排程看看')) text = '可以，我建議：\\n【排程建議】每天 08:30｜整理昨天的帳';
  o({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  o({ type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } });
});
`;
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('timers through the real server: own session, quiet result, alert, proposals', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-timers-e2e-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'todo.js', 'maint.js', 'xlsx.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  const log = path.join(dir, 'prompts.log');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'timers-test-password-long', TELEGRAM_BOT_TOKEN: '',
      CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: '', MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1', AGENTCHAT_TIMER_TICK_MS: '300' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'timers-test-password-long' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw new Error(p + ' ' + res.status + ' ' + JSON.stringify(j)); return j;
  };
  const waitFor = async (fn, what) => { for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + JSON.stringify((await api('/api/timers')).timers.map((x) => [x.id, x.last, x.active, x.runs]).slice(0, 3)) + '\n' + JSON.stringify((await api('/api/timers')).runs.slice(0, 4)) + '\n' + stderr); };

  const tm = await api('/api/timers', 'POST', { name: '檢查超標', agentId: 'hikari', prompt: '看 EM 資料', keepSession: true, schedule: { kind: 'daily', time: '08:30' } });
  assert.equal(tm.desc, undefined);
  const list = await api('/api/timers');
  assert.equal(list.timers[0].desc, '每天 08:30');
  // 立即執行 → 獨立對話、【無異常】→ 安靜
  await api('/api/timers/' + tm.id + '/run', 'POST');
  const ok = await waitFor(async () => { const x = (await api('/api/timers')).timers[0]; return x.last && x.last.status === 'ok' && x; }, 'timer ok');
  assert.equal(ok.last.notified, false);
  assert.equal(ok.runs, 1);
  assert.match(fs.readFileSync(log, 'utf8'), /【⏰ 排程：檢查超標】第 1 次/);
  // 和主對話分開：一般訊息不會用到排程的 session
  await api('/api/chat/hikari', 'POST', { text: '一般問題' });
  await waitFor(() => fs.readFileSync(log, 'utf8').includes('一般問題'), 'main chat');
  const mainCall = fs.readFileSync(log, 'utf8').split('=====').find((x) => x.includes('一般問題'));
  assert.doesNotMatch(mainCall, /--resume timer-session/, '主對話不會接到排程的對話');
  await sleep(300);
  // 排程第二次：勾了「記得上次的對話」→ 接續排程自己的對話（沒勾的預設是每次新對話，見 context.test.js）
  await api('/api/timers/' + tm.id + '/run', 'POST');
  await waitFor(async () => (await api('/api/timers')).timers[0].runs === 2, 'second run');
  const timerCalls = fs.readFileSync(log, 'utf8').split('=====').filter((x) => x.includes('【⏰ 排程'));
  assert.match(timerCalls[1], /--resume timer-session/, '排程接續自己的對話');
  // 有異常 → 標成 alert、通知
  await api('/api/timers/' + tm.id, 'PUT', { prompt: 'ALERT 看 EM 資料' });
  await api('/api/timers/' + tm.id + '/run', 'POST');
  const al = await waitFor(async () => { const x = (await api('/api/timers')).timers[0]; return x.last && x.last.status === 'alert' && x; }, 'alert');
  assert.equal(al.last.summary, '發現 1 筆超標');
  assert.equal(al.last.notified, true);
  // 成員在一般對話提出【排程建議】→ 待核准
  await api('/api/chat/hikari', 'POST', { text: '排程看看' });
  const props = await waitFor(async () => { const x = (await api('/api/timers')).proposals; return x.length && x; }, 'proposal');
  assert.equal(props[0].desc, '每天 08:30');
  assert.equal(props[0].prompt, '整理昨天的帳');
  const made = await api('/api/timers/proposals/' + props[0].id + '/accept', 'POST', {});
  assert.equal(made.agentId, 'hikari');
  assert.equal((await api('/api/timers')).timers.length, 2);
  // 提示詞裡有排程說明：成員知道要用【排程建議】而不是自己建 Windows 排程
  assert.match(fs.readFileSync(log, 'utf8'), /不要自己建立 Windows 排程/);

  // 前置檢查（真的跑指令）：沒輸出 → 不叫醒；有輸出 → 叫醒並附上
  const calls = () => fs.readFileSync(log, 'utf8').split('=====').filter((x) => x.includes('【⏰ 排程')).length;
  const before = calls();
  const quiet = await api('/api/timers', 'POST', { name: '安靜', agentId: 'hikari', prompt: '看看', schedule: { kind: 'once', at: Date.now() + 500 }, precheck: 'node -e "process.exit(0)"' });
  await waitFor(async () => (await api('/api/timers')).runs.find((r) => r.timerId === quiet.id && r.status === 'idle'), 'precheck idle');
  assert.equal(calls(), before, '沒有叫醒成員');
  const busy = await api('/api/timers', 'POST', { name: '有事', agentId: 'hikari', prompt: '看看', schedule: { kind: 'once', at: Date.now() + 500 }, precheck: 'node -e "console.log(\'NEW-ORDER-7\')"' });
  await waitFor(async () => (await api('/api/timers')).timers.find((x) => x.id === busy.id).runs === 1, 'precheck wake');
  assert.match(fs.readFileSync(log, 'utf8'), /【前置檢查 [^\n]+ 的輸出】\nNEW-ORDER-7/);
  // 成員回【排程暫停】→ 暫停；開始新任務 → 自動恢復
  await api('/api/timers/' + tm.id, 'PUT', { prompt: 'PAUSEME 看 EM 資料' });
  await api('/api/timers/' + tm.id + '/run', 'POST');
  const paused = await waitFor(async () => { const x = (await api('/api/timers')).timers.find((y) => y.id === tm.id); return x.paused && x; }, 'paused');
  assert.equal(paused.enabled, false);
  assert.equal(paused.paused.reason, '所有工單都完成');
  await api('/api/tasks', 'POST', { goal: '新的工作' });
  const resumed = await waitFor(async () => { const x = (await api('/api/timers')).timers.find((y) => y.id === tm.id); return x.enabled && !x.paused && x; }, 'resumed');
  assert.ok(resumed.nextRun > Date.now());
});
