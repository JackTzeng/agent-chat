'use strict';
// 獨立成員（例如記帳員）：不建立任務、Telegram 前綴與專屬 bot、照片附件、對話延續、
// 成員專屬環境變數、Claude 工具限制、只接受指定帳號、稽核紀錄。用假的 Telegram API 與假的 CLI 測。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const source = path.resolve(__dirname, '..');

const MOCK_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  fs.appendFileSync(process.env.MOCKLOG, JSON.stringify({ argv: process.argv.slice(2), sheet: process.env.LEDGER_SHEET_ID || null, apiKey: !!process.env.ANTHROPIC_API_KEY, prompt: inp }) + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'system', subtype: 'init', session_id: 's' + Date.now() + Math.floor(Math.random() * 1e6) });
  const msg = inp.slice(inp.lastIndexOf('【使用者訊息】'));
  let text;
  if (!inp.includes('記帳員')) text = 'PM 收到';
  else if (msg.includes('撤銷')) text = '已撤銷上一筆';
  else if (msg.includes('attachments/')) text = '解析結果：收據 120 元，回「對」寫入';
  else text = '已記帳：' + msg.replace('【使用者訊息】', '').trim();
  if (inp.includes('記帳員')) {
    o({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ledger/ledger.cmd add 350' } }] } });
    o({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'OK id=7' }] } });
  }
  o({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  o({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 5 } });
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

// 假的 Telegram Bot API：每個 token 一個訊息佇列，記下所有 sendMessage
function fakeTelegram() {
  const queues = {}, sent = [], seq = { n: 1 };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d)).on('end', async () => {
      const fm = req.url.match(/^\/file\/bot([^/]+)\/(.+)$/);
      if (fm) { res.writeHead(200); return res.end(Buffer.from('FAKEJPEG')); }
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m) { res.writeHead(404); return res.end('{}'); }
      const [, token, method] = m;
      let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
      const ok = (result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'getMe') return ok({ id: 1, username: 'bot_' + token.split(':')[0] });
      if (method === 'getUpdates') {
        const q = (queues[token] = queues[token] || []);
        for (let i = 0; i < 20 && !q.some((u) => u.update_id >= (j.offset || 0)); i++) await sleep(25);
        return ok(q.filter((u) => u.update_id >= (j.offset || 0)));
      }
      if (method === 'sendMessage') { sent.push({ token, chat: j.chat_id, text: j.text }); return ok({}); }
      if (method === 'sendChatAction') return ok(true);
      if (method === 'sendDocument') { sent.push({ token, method, text: (body.match(/filename="([^"]+)"/) || [])[1] || '', body }); return ok({}); }
      if (method === 'getFile') return ok({ file_id: j.file_id, file_size: 8, file_path: 'photos/file_1.jpg' });
      return ok({});
    });
  });
  const push = (token, from, msg) => {
    (queues[token] = queues[token] || []).push({ update_id: seq.n++, message: { message_id: seq.n, chat: { id: from, type: 'private' }, from: { id: from }, ...msg } });
  };
  return { srv, sent, push };
}

test('standalone ledger member: no tasks, telegram routing, photos, continuity, env, tools, audit', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-standalone-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'agents.example.json'), 'utf8'));
  cfg.telegram = { ...(cfg.telegram || {}), allowedUserIds: [111, 333], defaultAgent: 'hikari' };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(cfg));
  fs.mkdirSync(path.join(dir, 'workspace', 'ledger', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace', 'ledger', 'agent', '記帳員.md'), '你是家庭記帳員，只用 ledger.cmd 記帳。PERSONA-MARK');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  const log = path.join(dir, 'runs.log'); fs.writeFileSync(log, '');
  const tg = fakeTelegram(); const tgPort = await freePort();
  await new Promise((r) => tg.srv.listen(tgPort, '127.0.0.1', r));
  const MAIN = '100:mainbottokenmainbottoken123', LEDGER = '200:ledgerbottokenledgerbot456';
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'standalone-test-password', TELEGRAM_BOT_TOKEN: MAIN,
      TELEGRAM_API: 'http://127.0.0.1:' + tgPort, CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: path.join(bin, 'claude'),
      MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', ANTHROPIC_API_KEY: 'sk-should-not-pass' },
  });
  let stderr = '', stdout = ''; proc.stderr.on('data', (s) => { stderr += s; }); proc.stdout.on('data', (s) => { stdout += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    tg.srv.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'standalone-test-password' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw Object.assign(new Error(j.error || p), { status: res.status }); return j;
  };
  const runs = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitFor = async (fn, what) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + JSON.stringify(tg.sent.slice(-5).map((x) => [x.method, String(x.text).slice(0, 200)])) + '\n' + stdout + stderr); };

  const ledger = {
    name: '記帳員', avatar: '📒', role: '家庭記帳', engine: 'claude', model: 'claude-sonnet-5-5', permissionMode: 'default',
    cwd: './workspace', standalone: true, personaFile: 'ledger/agent/記帳員.md', env: 'LEDGER_SHEET_ID=sheet-abc',
    tools: 'Bash,Read', allowedTools: 'Bash(ledger/ledger.cmd *)\nBash(ledger\\ledger.cmd *)',
    telegram: { prefix: '/記帳', botToken: LEDGER, userIds: '111' },
  };
  // 驗證：不能覆蓋系統變數、不能和主 bot 共用 token、規則不能有命令列特殊字元
  await assert.rejects(api('/api/agents', 'POST', { ...ledger, env: 'PATH=C:\\evil' }), /系統或敏感變數/);
  await assert.rejects(api('/api/agents', 'POST', { ...ledger, env: 'ANTHROPIC_API_KEY=x' }), /系統或敏感變數/);
  await assert.rejects(api('/api/agents', 'POST', { ...ledger, telegram: { botToken: MAIN } }), /主 bot/);
  await assert.rejects(api('/api/agents', 'POST', { ...ledger, allowedTools: 'Bash(echo %PATH%)' }), /權限規則/);
  await assert.rejects(api('/api/agents', 'POST', { ...ledger, personaFile: '../../etc/passwd' }), /核准|找不到/);
  const { id } = await api('/api/agents', 'POST', ledger);

  const conf = await api('/api/config');
  const la = conf.agents.find((a) => a.id === id);
  assert.equal(la.telegram.botToken, undefined, 'token is not sent to the browser');
  assert.equal(la.telegram.hasBotToken, true);
  // 獨立成員不能當工作流程的負責人
  const wf = conf.workflow; wf.stages[0].owner = id;
  await api('/api/team', 'PUT', { workflow: wf }).catch(() => {});
  assert.notEqual((await api('/api/config')).workflow.stages[0].owner, id);

  // U1：專屬 bot 傳記帳訊息 → 直接回覆，沒有建立任務
  await waitFor(() => (/專屬 bot 已連線/.test(stdout)), 'ledger bot connected');
  tg.push(LEDGER, 111, { text: '昨天晚餐 350 刷玉山卡' });
  const m1 = await waitFor(() => tg.sent.find((s) => s.token === LEDGER && /已記帳/.test(s.text)), 'U1 reply');
  assert.match(m1.text, /昨天晚餐 350 刷玉山卡/);
  assert.equal((await api('/api/tasks')).tasks.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'workspace', 'TASK.md')));
  let rr = runs();
  const first = rr[0];
  assert.equal(first.sheet, 'sheet-abc', 'A7 member env');
  assert.equal(first.apiKey, false, 'A10 no API key');
  assert.deepEqual(first.argv.slice(first.argv.indexOf('--tools'), first.argv.indexOf('--tools') + 2), ['--tools', 'Bash,Read']);
  assert.ok(first.argv.includes('Bash(ledger/ledger.cmd *)'));
  assert.ok(first.argv.includes('claude-sonnet-5-5'));
  assert.equal(first.argv[first.argv.indexOf('--permission-mode') + 1], 'default');
  assert.match(first.prompt, /PERSONA-MARK/);
  assert.doesNotMatch(first.prompt, /【團隊成員】|【交接規則】|【專案記憶/);

  // U2：接著傳「撤銷」→ 沿用同一段對話
  tg.push(LEDGER, 111, { text: '撤銷' });
  await waitFor(() => tg.sent.find((s) => s.token === LEDGER && /已撤銷/.test(s.text)), 'U2 reply');
  assert.ok(runs()[1].argv.includes('--resume'));

  // U3 / A3：照片 → 存到 workspace/attachments/，路徑交給記帳員
  tg.push(LEDGER, 111, { photo: [{ file_id: 'small', file_size: 3 }, { file_id: 'big', file_size: 8 }], caption: '這張收據' });
  await waitFor(() => tg.sent.find((s) => s.token === LEDGER && /解析結果/.test(s.text)), 'U3 reply');
  const att = fs.readdirSync(path.join(dir, 'workspace', 'attachments'));
  assert.equal(att.length, 1); assert.match(att[0], /^tg-\d{8}-\d{6}\.jpg$/);
  assert.match(runs()[2].prompt, new RegExp('這張收據[\\s\\S]*attachments/' + att[0]));

  // U6 / A8：已配對但不在名單的帳號（333）、未配對的帳號（222）→ 不處理
  const before = runs().length, sentBefore = tg.sent.length;
  tg.push(LEDGER, 333, { text: '晚餐 999' });
  tg.push(LEDGER, 222, { text: '晚餐 888' });
  await sleep(800);
  assert.equal(runs().length, before);
  assert.equal(tg.sent.filter((s) => s.token === LEDGER).length, tg.sent.slice(0, sentBefore).filter((s) => s.token === LEDGER).length);

  // A2：主 bot 用前綴 → 交給記帳員，回覆回到主 bot 的聊天
  tg.push(MAIN, 111, { text: '/記帳 午餐 120' });
  await waitFor(() => tg.sent.find((s) => s.token === MAIN && /記帳員[\s\S]*已記帳：午餐 120/.test(s.text)), 'prefix reply');
  // U7：一般訊息照舊交給 PM，不會給記帳員
  const n = runs().length;
  tg.push(MAIN, 111, { text: '幫我規劃下週的工作' });
  await waitFor(() => tg.sent.find((s) => s.token === MAIN && /PM 收到/.test(s.text)), 'PM reply');
  assert.equal(runs().length, n + 1);
  assert.doesNotMatch(runs()[n].prompt, /PERSONA-MARK/);
  // 記帳員的結果不會推到主 bot（只回專屬 bot）
  assert.ok(!tg.sent.some((s) => s.token === MAIN && /已撤銷/.test(s.text)));

  // A9：稽核紀錄
  const audit = (await api('/api/audit/' + id)).records;
  assert.ok(audit.length >= 4);
  const last = audit.find((x) => /撤銷/.test(x.input));
  assert.equal(last.via, 'telegram'); assert.equal(last.tgUser, '111');
  assert.deepEqual(last.calls[0], { tool: 'Bash', command: 'ledger/ledger.cmd add 350', exitCode: 0, isError: false, output: 'OK id=7' });
  assert.equal(last.reply, '已撤銷上一筆');
  assert.equal(last.cliExit, 0);

  const ag = (await api('/api/agents')).find((a) => a.id === id);
  assert.equal(ag.standalone, true);
  assert.deepEqual(ag.canHandoffTo, []);
  const tgs = await api('/api/telegram');
  assert.equal(tgs.agentBots[0].state, 'connected');

  // 小組＋Telegram：/task 小組名、兩件任務都在等回覆時要用 #編號
  const { id: emTeam } = await api('/api/teams', 'POST', { name: '報表組', icon: '📊' });
  const { id: rep } = await api('/api/agents', 'POST', { name: '阿資', engine: 'claude', permissionMode: 'auto', cwd: './workspace', team: emTeam });
  await api('/api/team', 'PUT', { teamId: emTeam, workflow: { name: '報表', stages: [{ id: 'c', name: '整理', owner: rep, next: ['d'] }, { id: 'd', name: '覆核', owner: rep, next: [] }] } });
  const cfg2 = await api('/api/config'); const plan = cfg2.teams[0].workflow;
  plan.stages[0].owner = cfg2.agents.find((a) => !a.standalone && a.team === cfg2.teams[0].id).id; plan.stages[0].approval = true;
  await api('/api/team', 'PUT', { workflow: plan });
  tg.push(MAIN, 111, { text: '/task 報表組 整理十月報表' });
  tg.push(MAIN, 111, { text: '/task 做一個小工具' });
  let acts = [];
  for (let i = 0; i < 200; i++) { acts = (await api('/api/tasks')).actives; if (acts.length === 2 && acts.every((x) => x.status === 'waiting_user')) break; await sleep(50); }
  assert.deepEqual(acts.map((x) => x.teamName).sort(), ['報表組', '開發組'].sort(), stdout + stderr);
  tg.push(MAIN, 111, { text: '好的繼續' });
  await waitFor(() => tg.sent.find((s) => s.token === MAIN && /有 2 件任務在等你回覆/.test(s.text)), 'ask for #id');
  const emTask = acts.find((x) => x.teamName === '報表組');
  tg.push(MAIN, 111, { text: '#' + emTask.id + ' 用 A4 格式' });
  await waitFor(() => tg.sent.find((s) => s.token === MAIN && new RegExp('已回覆任務 #' + emTask.id).test(s.text)), 'reply by id');
  tg.push(MAIN, 111, { text: '/status' });
  await waitFor(() => tg.sent.find((s) => s.token === MAIN && /報表組｜任務/.test(s.text) && /開發組｜任務/.test(s.text)), 'status lists both');

  // 🐞 /report：產生回報檔並用 sendDocument 傳回來；/restart 不是用 launcher 啟動時會說明
  tg.push(MAIN, 111, { text: '/report 測試 Telegram 回報' });
  const doc = await waitFor(() => tg.sent.find((s) => s.token === MAIN && s.method === 'sendDocument'), 'report document');
  assert.match(doc.text, /^agentchat-report-\d{8}-\d{6}\.md$/);
  assert.match(doc.body, /測試 Telegram 回報/);
  assert.match(doc.body, /來源：Telegram/);
  assert.ok(!doc.body.includes(MAIN), 'bot token 不會出現在回報裡');
  tg.push(MAIN, 111, { text: '/restart yes' });
  await waitFor(() => tg.sent.find((s) => s.token === MAIN && /沒辦法自動重啟/.test(s.text)), 'restart needs launcher');
});
