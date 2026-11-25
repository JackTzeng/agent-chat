'use strict';
// ⚙️ 每輪結束後執行（沙箱外）：只在監看檔案有變動時跑、同時只跑一個（合併）、鎖定檔案被改就不跑、失敗有提示、路徑與參數驗證、逾時。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const { copyServer } = require('./_files');

// 假的 Claude（工作資料夾＝成員的資料夾）：ADD＝在沙箱裡記帳（改帳本檔）；TAMPER＝偷改同步程式；其他＝只回話
const MOCK_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  const msg = inp.slice(inp.lastIndexOf('【使用者訊息】'));
  if (msg.includes('ADD')) fs.appendFileSync('app/data/db.txt', 'row\\n');
  if (msg.includes('TAMPER')) fs.appendFileSync('app/sync.sh', '\\necho pwned >> pwned.txt\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'system', subtype: 'init', session_id: 's' + Date.now() + Math.floor(Math.random() * 1e6) });
  o({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } });
  o({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 5 } });
});
`;
const SYNC = `#!/bin/sh
# 同步程式（測試用）：記錄開始／結束、參數、成員環境變數；MODE 檔決定行為
echo "start $1 $LEDGER_SHEET_ID" >> sync.log
mode=$(cat mode.txt 2>/dev/null)
[ "$mode" = "slow" ] && sleep 1
[ "$mode" = "hang" ] && sleep 30
echo "end" >> sync.log
[ "$mode" = "fail" ] && { echo "Sheets 403 forbidden" >&2; exit 3; }
exit 0
`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); }); }

test('每輪結束後執行（沙箱外）', { skip: process.platform === 'win32' ? '測試用 sh 腳本' : false, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-afterturn-'));
  copyServer(dir);
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  const ws = path.join(dir, 'workspace', 'lb');
  fs.mkdirSync(path.join(ws, 'app', 'data'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'app', 'sync.sh'), SYNC, { mode: 0o755 });
  fs.writeFileSync(path.join(ws, 'app', 'helper.py'), 'print(1)\n');
  fs.writeFileSync(path.join(ws, 'app', 'data', 'db.txt'), '');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便', cwd: './workspace' }], harness: { headerRefresh: 0 },
    agents: [{ id: 'pm', name: 'PM', role: 'PM', engine: 'claude', permissionMode: 'auto', cwd: './workspace', team: 'main' }],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'afterturn-test-password', TELEGRAM_BOT_TOKEN: '', CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: '', AGY_BIN: '', AGENTCHAT_NO_UPDATE_CHECK: '1' } });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => { if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'afterturn-test-password' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (p, method = 'GET', body) => { const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, j: await res.json() }; };
  const J = async (p, m, b) => { const x = await call(p, m, b); if (x.status >= 400) throw new Error(p + ' ' + x.status + ' ' + JSON.stringify(x.j)); return x.j; };
  const waitFor = async (fn, what, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + stderr.slice(-800)); };
  const syncLog = () => { try { return fs.readFileSync(path.join(ws, 'sync.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const base0 = { name: '記帳員', role: '記帳', engine: 'claude', model: 'claude-sonnet-5-5', permissionMode: 'default', cwd: './workspace/lb', standalone: true, env: 'LEDGER_SHEET_ID=sheet-xyz' };

  // 驗證：只限獨立成員；指令要在工作資料夾裡；參數只能是安全字元
  const bad = async (afterTurn, extra = {}) => (await call('/api/agents', 'POST', { ...base0, ...extra, afterTurn })).j.error || '';
  assert.match(await bad({ command: 'app/sync.sh' }, { standalone: false, team: 'main' }), /只限獨立成員/);
  assert.match(await bad({ command: '/bin/sh' }), /相對路徑/);
  assert.match(await bad({ command: '../../server.js' }), /相對路徑/);
  assert.match(await bad({ command: 'app/nope.sh' }), /找不到/);
  assert.match(await bad({ command: 'app/sync.sh', args: 'a&b' }), /不允許的字元/);
  assert.match(await bad({ command: 'app/sync.sh', args: '"x"' }), /不允許的字元/);
  assert.match(await bad({ command: 'app/s&ync.sh' }), /不允許的字元/);
  assert.match(await bad({ command: 'app/sync.sh', ifChanged: '../x' }), /相對路徑/);

  // 建立：儲存＝核准（記下指紋，鎖定 sync.sh 與 helper.py）
  const { id } = await J('/api/agents', 'POST', { ...base0, afterTurn: { command: 'app/sync.sh', args: 'sync', ifChanged: 'app/data/db.txt', timeoutSec: 60 } });
  const AT = '/api/agents/' + id + '/afterturn';
  const status = () => J(AT);
  const idle = async () => !(await J('/api/agents')).find((a) => a.id === id).busy;
  const chat = async (text) => { await J('/api/chat/' + id, 'POST', { text }); await sleep(100); await waitFor(idle, 'idle ' + text); };
  const hist = async () => (await J('/api/history/' + id)).history.map((m) => (m.segments || []).map((s) => s.text).join('') || m.text || '').join('\n');
  const cfg = (await J('/api/config')).agents.find((a) => a.id === id);
  assert.equal(cfg.afterTurn.command, 'app/sync.sh'); assert.deepEqual(cfg.afterTurn.args, ['sync']); assert.equal(cfg.afterTurn.pinnedCount, 2, '鎖定 sync.sh 與 helper.py');
  assert.ok(!('approvedFiles' in cfg.afterTurn), '網頁不需要完整指紋清單');

  // 1) 沒改帳本（閒聊）→ 不跑
  await chat('Hi'); await sleep(300);
  assert.equal(syncLog().length, 0); assert.equal((await status()).lastAt, null);
  // 2) 記帳（帳本檔變了）→ 回覆照常、背景跑一次；參數與成員環境變數都有帶到
  await chat('ADD 午餐 120');
  await waitFor(() => syncLog().includes('end'), 'sync ran');
  assert.deepEqual(syncLog(), ['start sync sheet-xyz', 'end']);
  await waitFor(async () => (await status()).lastExit === 0, 'status ok');
  // 3) 同時只跑一個：執行中又觸發 → 合併成「再跑一次」，不會重疊
  fs.writeFileSync(path.join(ws, 'mode.txt'), 'slow');
  const r1 = await J(AT + '/run', 'POST'), r2 = await J(AT + '/run', 'POST'), r3 = await J(AT + '/run', 'POST');
  assert.deepEqual([r1.result, r2.result, r3.result], ['started', 'queued', 'queued']);
  await waitFor(() => syncLog().length === 6, 'two more runs', 400);
  assert.deepEqual(syncLog().slice(2), ['start sync sheet-xyz', 'end', 'start sync sheet-xyz', 'end'], '不重疊，排隊的合併成一次');
  fs.writeFileSync(path.join(ws, 'mode.txt'), '');
  // 4) 失敗：網頁對話框有一行提示，稽核紀錄有輸出；不影響成員
  fs.writeFileSync(path.join(ws, 'mode.txt'), 'fail');
  await chat('ADD 晚餐 200');
  await waitFor(async () => (await status()).lastExit === 3, 'fail status');
  assert.match(await hist(), /⚠️ 每輪後執行（app\/sync\.sh sync）失敗（結束碼 3）：\nSheets 403 forbidden/);
  const audit = (await J('/api/audit/' + id + '?limit=50')).records;
  assert.ok(audit.some((x) => x.type === 'afterTurn' && x.exitCode === 3 && /403/.test(x.out)));
  fs.writeFileSync(path.join(ws, 'mode.txt'), '');
  await chat('ADD 早餐 60');
  await waitFor(async () => /✅ 每輪後執行（app\/sync\.sh）恢復正常/.test(await hist()), 'recovered');
  // 5) 🔒 成員偷改同步程式 → 下次不執行，等你重新核准
  const before = syncLog().length;
  await chat('TAMPER ADD 改程式');
  await waitFor(async () => (await status()).needsApproval, 'needs approval');
  assert.equal(syncLog().length, before, '被改過的程式沒有在沙箱外執行'); assert.ok(!fs.existsSync(path.join(ws, 'pwned.txt')));
  assert.deepEqual((await status()).changed, ['app/sync.sh']);
  assert.match(await hist(), /🔒 每輪後執行（app\/sync\.sh）先暫停：鎖定的程式檔跟你核准時不一樣（app\/sync\.sh）/);
  await chat('ADD 再一筆'); await sleep(300);
  assert.equal(syncLog().length, before, '沒核准前一直不跑');
  assert.ok((await J('/api/audit/' + id + '?limit=50')).records.some((x) => x.type === 'afterTurn' && x.skipped === 'pinMismatch'));
  // 在網頁按儲存（設定沒變）不會偷偷重新核准
  const cfgNow = (await J('/api/config')).agents.find((a) => a.id === id);
  await J('/api/agents/' + id, 'PUT', { ...cfgNow, env: 'LEDGER_SHEET_ID=sheet-xyz', afterTurn: { command: 'app/sync.sh', args: 'sync', ifChanged: 'app/data/db.txt', timeoutSec: 60 } });
  await J(AT + '/run', 'POST'); await sleep(300);
  assert.equal(syncLog().length, before, '設定沒變就沿用原本的核准');
  // 你看過後重新核准 → 恢復（這次會跑被改過的版本，這是你確認過的）
  await J(AT + '/approve', 'POST');
  assert.equal((await status()).needsApproval, false);
  await chat('ADD 核准後');
  await waitFor(() => syncLog().length > before, 'runs after approval');
  // 6) 逾時：停掉整個程序樹
  fs.writeFileSync(path.join(ws, 'mode.txt'), 'hang');
  const cfg6 = (await J('/api/config')).agents.find((a) => a.id === id);
  await J('/api/agents/' + id, 'PUT', { ...cfg6, env: 'LEDGER_SHEET_ID=sheet-xyz', afterTurn: { command: 'app/sync.sh', args: 'sync', ifChanged: 'app/data/db.txt', timeoutSec: 5 } });
  await J(AT + '/run', 'POST');
  await waitFor(async () => /超過 5 秒被停止/.test(await hist()), 'timeout', 300);
  // 7) 移除設定
  const cfg7 = (await J('/api/config')).agents.find((a) => a.id === id);
  await J('/api/agents/' + id, 'PUT', { ...cfg7, env: 'LEDGER_SHEET_ID=sheet-xyz', afterTurn: { command: '' } });
  assert.equal((await J('/api/config')).agents.find((a) => a.id === id).afterTurn, undefined);
});
