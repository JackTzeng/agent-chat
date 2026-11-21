'use strict';
// 💚 LINE：簽章驗證、配對、你傳→成員回（reply）、提醒核准、排程提醒推播（push）、一鍵公開通道、檢查連線；用假的 LINE API 與假的 cloudflared。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const line = require('../line');
const source = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('helpers: signature, plain text, chunking, reply text, public url', () => {
  const secret = 'a'.repeat(32), raw = Buffer.from('{"events":[]}');
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(line.verifySignature(raw, secret, sig), true);
  assert.equal(line.verifySignature(raw, secret, sig.replace(/.$/, sig.endsWith('A') ? 'B' : 'A')), false);
  assert.equal(line.verifySignature(Buffer.from('{"events":[1]}'), secret, sig), false, '內容被改過');
  assert.equal(line.verifySignature(raw, secret, ''), false);
  assert.equal(line.verifySignature(raw, '', sig), false);
  assert.equal(line.plain('## 標題\n**重點**：\n- 一\n* 二\n```js\ncode\n```'), '■ 標題\n重點：\n・一\n・二\ncode');
  assert.deepEqual(line.chunk('短短的'), ['短短的']);
  const long = line.chunk(('一二三四五\n').repeat(2000), 100, 5);
  assert.equal(long.length, 5); assert.ok(long.every((s) => s.length <= 100)); assert.match(long[4], /太長，後面省略了/);
  assert.equal(line.replyText([{ type: 'text', text: '好的\n【排程建議】明天 15:00｜提醒我\n已記下' }, { type: 'tool', text: '⏰ 排程建議沒有送出：看不懂時間' }, { type: 'error', text: '壞了' }]), '好的\n已記下\n\n⏰ 排程建議沒有送出：看不懂時間\n\n⚠️ 壞了');
  assert.match(line.replyText([{ type: 'tool', text: '⚙️ 執行：dir' }, { type: 'toolres', text: 'denied', isError: true }, { type: 'tool', text: '⛔ 被擋下：Bash（這位成員沒有這個權限）' }]), /想做的事.*被系統擋下.*沒有產生回覆/, '想執行指令被擋下 → 說清楚，不是「沒有內容」');
  assert.equal(line.replyText([{ type: 'tool', text: '📖 讀取：a.txt' }]), '（沒有回覆內容）');
  assert.equal(line.cleanPublicUrl('https://abc.trycloudflare.com/line/webhook/'), 'https://abc.trycloudflare.com');
  assert.equal(line.cleanPublicUrl(''), '');
  for (const bad of ['http://abc.com', 'https://abc.com/x/y', 'https://u:p@abc.com', 'abc']) assert.throws(() => line.cleanPublicUrl(bad), undefined, bad);
});

const MOCK_CLAUDE = `#!/usr/bin/env node
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  require('fs').appendFileSync(process.env.MOCKLOG, '=====CLAUDE\\n' + inp + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid });
  let text = '收到：' + (inp.match(/【使用者訊息】\\n([^\\n]*)/) || [])[1];
  if (inp.includes('GOODREMIND')) text = '好的，已記下行程。\\n【排程建議】明天 15:00｜提醒使用者：下午三點開會\\n請核准。';
  if (inp.includes('TIMERFIRE')) text = '提醒：開會時間到了！';
  o({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  o({ type: 'result', subtype: 'success', session_id: 'sess-' + process.pid, total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
});
`;
const MOCK_CLOUDFLARED = `#!/usr/bin/env node
require('fs').appendFileSync(process.env.MOCKLOG, '=====CLOUDFLARED ' + process.argv.slice(2).join(' ') + '\\n');
console.error('2026-11-19T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...');
console.error('2026-11-19T10:00:02Z INF |  https://fake-test-1.trycloudflare.com  |');
setInterval(() => {}, 1000);
`;
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('LINE bot through the real server', { timeout: 120000 }, async (t) => {
  const TOKEN = 'T'.repeat(30) + 'abc123+/='.repeat(10), SECRET = 'ab12cd34'.repeat(4);
  // 假的 LINE API
  const calls = []; let hook = '', putCalls = 0, pushFail = 0;
  const api = http.createServer((req, res) => {
    const bufs = []; req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      let body = null; try { body = JSON.parse(Buffer.concat(bufs).toString('utf8') || 'null'); } catch {}
      calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { message: 'Authentication failed' });
      const k = req.method + ' ' + req.url;
      if (k === 'GET /v2/bot/info') return send(200, { displayName: '測試助理', basicId: '@abc123' });
      if (k === 'GET /v2/bot/channel/webhook/endpoint') return send(200, { endpoint: hook, active: true });
      if (k === 'PUT /v2/bot/channel/webhook/endpoint') { putCalls++; if (putCalls <= 5) return send(400, { message: 'Invalid webhook endpoint URL' }); hook = body.endpoint; return send(200, {}); }
      if (k === 'POST /v2/bot/channel/webhook/test') return send(200, { success: true, statusCode: 200, reason: 'OK' });
      if (k === 'GET /v2/bot/message/quota') return send(200, { type: 'limited', value: 200 });
      if (k === 'GET /v2/bot/message/quota/consumption') return send(200, { totalUsage: 7 });
      if (k === 'POST /v2/bot/chat/loading/start') return send(202, {});
      if (k === 'POST /v2/bot/message/push' && pushFail > 0) { pushFail--; return send(500, { message: 'temporary error' }); }
      if (k === 'POST /v2/bot/message/reply' || k === 'POST /v2/bot/message/push') return send(200, {});
      send(404, { message: 'not found' });
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = 'http://127.0.0.1:' + api.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-line-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'todo.js', 'outbox.js', 'maint.js', 'xlsx.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便', cwd: './workspace' }],
    line: { channelSecret: SECRET, channelAccessToken: TOKEN, agentId: 'asst' },
    agents: [
      { id: 'pm', name: 'PM', role: 'PM', engine: 'claude', permissionMode: 'auto', cwd: './workspace', team: 'main' },
      { id: 'asst', name: '助理', role: '個人秘書', engine: 'claude', permissionMode: 'acceptEdits', cwd: './workspace/assistant', standalone: true, brief: true },
    ],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'cloudflared'), MOCK_CLOUDFLARED, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  const port = await freePort(), linePort = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'line-test-password-long', TELEGRAM_BOT_TOKEN: '', CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: '', AGY_BIN: '',
      LINE_API_BASE: apiBase, LINE_PORT: String(linePort), CLOUDFLARED_BIN: path.join(bin, 'cloudflared'), AGENTCHAT_TIMER_TICK_MS: '300', LINE_REACH_CHECK: '0', LINE_RETRY_MS: '100', LINE_REACH_MS: '1500', LINE_ALLOW_HTTP: '1',
      MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    api.close();
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port, hookBase = 'http://127.0.0.1:' + linePort;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r0 = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'line-test-password-long' }) });
  assert.equal(r0.status, 200, stderr);
  const cookie = r0.headers.get('set-cookie').split(';')[0];
  const call = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    return { status: res.status, j: await res.json() };
  };
  const J = async (p, method, body) => { const r = await call(p, method, body); if (r.status >= 400) throw new Error(p + ' ' + r.status + ' ' + JSON.stringify(r.j)); return r.j; };
  const waitFor = async (fn, what) => { for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + JSON.stringify(calls.slice(-6)) + '\n' + stderr); };
  const claudeCalls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('=====CLAUDE\n').length - 1 : 0);
  let evSeq = 0;
  const hookPost = async (events, sig) => {
    const raw = JSON.stringify({ destination: 'U0', events });
    const s = sig === undefined ? crypto.createHmac('sha256', SECRET).update(raw).digest('base64') : sig;
    const res = await fetch(hookBase + '/line/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(s ? { 'X-Line-Signature': s } : {}) }, body: raw });
    return res.status;
  };
  const msg = (uid, text, rt, id) => ({ type: 'message', webhookEventId: id || 'ev' + (++evSeq), replyToken: rt, source: { type: 'user', userId: uid }, message: { type: 'text', id: String(evSeq), text } });
  const sent = (kind) => calls.filter((c) => c.url === '/v2/bot/message/' + kind);
  const textsOf = (c) => c.body.messages.map((m) => m.text).join('\n');

  // 1) 狀態：已設定、webhook 伺服器有開；機密不會出現在任何 API 回應
  let st = await J('/api/line');
  assert.equal(st.configured, true); assert.equal(st.agentName, '助理'); assert.equal(st.allowedCount, 0); assert.equal(st.port, linePort);
  await waitFor(async () => (await J('/api/line')).listening, 'webhook listening');
  const rawStatus = JSON.stringify(st) + JSON.stringify(await J('/api/config'));
  assert.ok(!rawStatus.includes(SECRET) && !rawStatus.includes(TOKEN), '設定與狀態不會回傳 secret／token');

  // 2) 簽章：沒簽、簽錯 → 401；路徑不對 → 404；健康檢查 → 200
  assert.equal(await hookPost([], ''), 401);
  assert.equal(await hookPost([], 'bm90LWEtc2lnbmF0dXJl'), 401);
  assert.equal((await fetch(hookBase + '/')).status, 404);
  assert.equal((await fetch(hookBase + '/line/health')).status, 200);
  assert.equal(await hookPost([]), 200);

  // 3) 沒配對的人：只收到「還沒配對」，成員完全不會被叫到
  assert.equal(await hookPost([msg('U_stranger', '你好', 'rt-stranger')]), 200);
  await waitFor(() => sent('reply').length === 1, 'stranger reply');
  assert.equal(sent('reply')[0].body.replyToken, 'rt-stranger'); assert.match(textsOf(sent('reply')[0]), /還沒配對/);
  assert.equal(claudeCalls(), 0);

  // 4) 配對：錯的碼不行；對的碼一次有效
  const pair = await J('/api/line/pair', 'POST'); assert.match(pair.pairing.code, /^\d{6}$/);
  const wrong = String((+pair.pairing.code + 1) % 1000000).padStart(6, '0');
  await hookPost([msg('U_stranger', wrong, 'rt-w')]);
  await waitFor(() => sent('reply').length === 2, 'wrong code reply'); assert.match(textsOf(sent('reply')[1]), /還沒配對/);
  await hookPost([msg('U_owner', pair.pairing.code, 'rt-pair')]);
  await waitFor(() => sent('reply').length === 3, 'pair reply'); assert.match(textsOf(sent('reply')[2]), /配對成功/);
  assert.equal((await J('/api/line')).allowedCount, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')).line.allowedUserIds, ['U_owner'], '配對存進設定檔');
  await hookPost([msg('U_other', pair.pairing.code, 'rt-again')]);
  await waitFor(() => sent('reply').length === 4, 'code reuse reply'); assert.match(textsOf(sent('reply')[3]), /還沒配對/, '配對碼只能用一次');

  // 5) 配對過的人：訊息交給成員，回覆用 reply（免費）送回同一個人；有顯示「輸入中」
  await hookPost([msg('U_owner', '今天天氣如何', 'rt-chat1')]);
  await waitFor(() => sent('reply').length === 5, 'chat reply');
  const r5 = sent('reply')[4]; assert.equal(r5.body.replyToken, 'rt-chat1'); assert.match(textsOf(r5), /收到：今天天氣如何/);
  assert.ok(calls.some((c) => c.url === '/v2/bot/chat/loading/start' && c.body.chatId === 'U_owner'), '有顯示輸入中');
  assert.equal(sent('push').length, 0, '一般對話不用 push');
  assert.match(fs.readFileSync(log, 'utf8'), /【現況（系統提供/, '助理有帶現況摘要');

  // 6) 同一個事件重送（LINE 重試）只處理一次
  const dup = msg('U_owner', '重複的訊息', 'rt-dup', 'same-event-id');
  await hookPost([dup]); await hookPost([dup]);
  await waitFor(() => sent('reply').length === 6, 'dup reply'); await sleep(600);
  assert.equal(sent('reply').length, 6); assert.equal(claudeCalls(), 2);

  // 7) 助理提出提醒 → 直接在 LINE 問你同不同意；回「同意 N」就排進去
  await hookPost([msg('U_owner', 'GOODREMIND 明天下午三點提醒我開會', 'rt-remind')]);
  await waitFor(() => sent('reply').length === 7, 'remind reply');
  const r7 = textsOf(sent('reply')[6]);
  assert.match(r7, /好的，已記下行程。/); assert.doesNotMatch(r7, /【排程建議】/, '給系統看的那行不會出現在 LINE');
  assert.match(r7, /⏰ 等你核准：\n#\d+ 只做一次：.*提醒使用者：下午三點開會/); assert.match(r7, /回「同意 編號」/);
  const pid = Number(/#(\d+) 只做一次/.exec(r7)[1]);
  assert.equal((await J('/api/timers')).proposals.length, 1);
  await hookPost([msg('U_owner', '同意 ' + pid, 'rt-ok')]);
  await waitFor(() => sent('reply').length === 8, 'accept reply'); assert.match(textsOf(sent('reply')[7]), /✅ 已排程/);
  const tm = await J('/api/timers'); assert.equal(tm.proposals.length, 0); assert.equal(tm.timers.length, 1); assert.equal(tm.timers[0].schedule.kind, 'once');
  await hookPost([msg('U_owner', '不要 999', 'rt-no')]);
  await waitFor(() => sent('reply').length === 9, 'dismiss reply'); assert.match(textsOf(sent('reply')[8]), /找不到/);

  // 8) 指令
  await hookPost([msg('U_owner', '/new', 'rt-new')]);
  await waitFor(() => sent('reply').length === 10, 'new reply'); assert.match(textsOf(sent('reply')[9]), /已開新對話/);

  // 8b) 取消排程：LINE 上直接取消已經排好的提醒（只有配對過的人做得到）
  const tid = (await J('/api/timers')).timers[0].id;
  await hookPost([msg('U_owner', '取消排程 999', 'rt-c0')]);
  await waitFor(() => sent('reply').length === 11, 'cancel missing'); assert.match(textsOf(sent('reply')[10]), /找不到排程 #999/);
  await hookPost([msg('U_owner', '取消排程 ' + tid, 'rt-c1')]);
  await waitFor(() => sent('reply').length === 12, 'cancel reply'); assert.match(textsOf(sent('reply')[11]), /🗑 已取消 #\d+：/);
  assert.equal((await J('/api/timers')).timers.length, 0);

  // 9) 排程時間到、成員的提醒 → 用 push 推給配對過的帳號
  const when = Date.now() + 1500;
  await J('/api/timers', 'POST', { name: '開會提醒', prompt: 'TIMERFIRE 提醒使用者開會', agentId: 'asst', schedule: { kind: 'once', at: when }, notify: 'always' });
  await waitFor(() => sent('push').length >= 1, 'push reminder');
  const ps = sent('push')[0]; assert.equal(ps.body.to, 'U_owner'); assert.match(textsOf(ps), /開會提醒/); assert.match(textsOf(ps), /提醒：開會時間到了/);
  assert.equal(sent('push').every((c) => c.body.to === 'U_owner'), true, '只推給配對過的人');

  // 9b) 📮 推播暫時失敗（LINE 回 500）→ 放進 outbox，之後補送；處理過的事件編號存進 state（重新啟動後 LINE 重送也不會再做一次）
  pushFail = 1; const pushBefore = sent('push').length;
  await J('/api/timers', 'POST', { name: '補送測試', prompt: 'TIMERFIRE 再提醒一次', agentId: 'asst', schedule: { kind: 'once', at: Date.now() + 800 }, notify: 'always' });
  const ob = await waitFor(async () => { const o = await J('/api/outbox'); return o.pending.length === 1 && o; }, 'queued in outbox');
  assert.equal(ob.pending[0].channel, 'line'); assert.match(ob.pending[0].lastError, /500/); assert.equal(ob.pending[0].tries, 1);
  await J('/api/outbox/' + ob.pending[0].id + '/retry', 'POST');
  await waitFor(async () => (await J('/api/outbox')).history.some((h) => h.status === 'sent'), 'resent');
  assert.equal(sent('push').length, pushBefore + 2, '失敗一次＋補送一次');
  assert.match(textsOf(sent('push').at(-1)), /補送測試/);
  assert.equal((await J('/api/outbox')).pending.length, 0);
  assert.equal((await call('/api/outbox/999/retry', 'POST')).status, 404);
  const savedState = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'));
  assert.ok(savedState.line.seenEvents.includes('ev1'), '處理過的事件編號有存檔');
  assert.ok(savedState.outbox.history.length >= 1, 'outbox 也存檔');

  // 10) 檢查連線
  let chk = await J('/api/line/check', 'POST');
  assert.equal(chk.steps[0].ok, true); assert.match(chk.steps[0].msg, /測試助理/);
  assert.equal(chk.steps[1].ok, false); assert.match(chk.steps[1].msg, /還沒設定網址/, 'Webhook 還沒設，要提醒');
  assert.equal(chk.ok, false);
  assert.ok(chk.steps.some((s) => /已用 7 \/ 200/.test(s.msg)), '顯示本月推播用量');
  assert.equal((await J('/api/line')).bot.name, '測試助理');

  // 11) 一鍵公開通道：自動抓網址、設到 LINE、請 LINE 測試
  await J('/api/line/tunnel', 'POST', { on: true });
  st = await waitFor(async () => { const s = await J('/api/line'); return s.tunnel.state === 'on' && s.webhook && s.webhook.tested && s; }, 'tunnel on');
  assert.equal(st.tunnel.url, 'https://fake-test-1.trycloudflare.com'); assert.equal(st.publicUrl, 'https://fake-test-1.trycloudflare.com');
  assert.equal(hook, 'https://fake-test-1.trycloudflare.com/line/webhook');
  assert.ok(putCalls >= 6, '前 5 次 LINE 都回 400（網址還沒生效）：先在一次設定裡重試 4 次、失敗後稍後再整個重來，第 6 次成功');
  assert.equal((await J('/api/line')).lastError, '', '成功之後，舊的「最近的問題」會清掉');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/v2/bot/channel/webhook/test'));
  assert.match(fs.readFileSync(log, 'utf8'), new RegExp('CLOUDFLARED tunnel --no-autoupdate --url http://127.0.0.1:' + linePort));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')).line.tunnel, true, '記住要自動開');
  chk = await J('/api/line/check', 'POST');
  assert.equal(chk.ok, true, JSON.stringify(chk.steps)); assert.match(chk.steps[1].msg, /fake-test-1\.trycloudflare\.com\/line\/webhook（已啟用）/);
  await J('/api/line/tunnel', 'POST', { on: false });
  await waitFor(async () => (await J('/api/line')).tunnel.state === 'off', 'tunnel off');

  // 11b) 手動填網址：先確認從這台電腦連得到才告訴 LINE；連不到會說清楚（這裡用本機網址模擬連得到／連不到）
  const okWh = await J('/api/line/webhook', 'POST', { publicUrl: 'http://127.0.0.1:' + linePort });
  assert.equal(okWh.url, 'http://127.0.0.1:' + linePort + '/line/webhook'); assert.equal(hook, okWh.url);
  const bad = await call('/api/line/webhook', 'POST', { publicUrl: 'http://127.0.0.1:9' });
  assert.equal(bad.status, 400); assert.match(bad.j.error, /還連不上/); assert.equal(hook, okWh.url, '連不上時不會動 LINE 的設定');

  // 12) 設定的驗證與清除
  assert.equal((await call('/api/line', 'PUT', { channelSecret: 'too-short' })).status, 400);
  assert.equal((await call('/api/line', 'PUT', { channelAccessToken: 'short' })).status, 400);
  assert.equal((await call('/api/line', 'PUT', { publicUrl: 'https://abc.example.com/some/path' })).status, 400);
  assert.equal((await call('/api/line', 'PUT', { agentId: 'nobody' })).status, 400);
  const changedSecret = await J('/api/line', 'PUT', { channelSecret: 'f'.repeat(32) });
  assert.equal(changedSecret.allowedCount, 0, '換了 channel secret，原本的配對作廢');
  const cleared = await J('/api/line', 'PUT', { clear: true });
  assert.equal(cleared.configured, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')).line.channelAccessToken, undefined);
});
