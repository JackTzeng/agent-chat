'use strict';
// 💾 狀態檔與對話紀錄的可靠性（v3.42.0）：
// - state.json 壞掉 → 壞檔保留、用 .bak 還原、整個專案暫停（不會靜靜變成全新狀態）
// - 沒有可用的備份 → 全新狀態，但一樣暫停並提示
// - 對話紀錄 .json → .jsonl 自動轉檔；最後一行寫到一半（當機）會被跳過
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { copyServer } = require('./_files');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}
// prepare(dir)：啟動前先放好 data/ 裡的檔案
async function boot(t, prepare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-state-'));
  copyServer(dir, ['agents.example.json']);
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  fs.mkdirSync(path.join(dir, 'data', 'history'), { recursive: true });
  prepare(dir);
  const port = await freePort(), password = 'state-test-password-long';
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: password, TELEGRAM_BOT_TOKEN: '', AGENTCHAT_NO_UPDATE_CHECK: '1',
      CLAUDE_BIN: path.join(dir, 'none'), CODEX_BIN: path.join(dir, 'none'), AGY_BIN: path.join(dir, 'none') },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: password }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p) => (await fetch(base + p, { headers: { Cookie: cookie } })).json();
  return { dir, api, stderr: () => stderr };
}

test('壞掉的 state.json：保留壞檔、用備份還原、整個專案先暫停', async (t) => {
  const { dir, api, stderr } = await boot(t, (d) => {
    fs.writeFileSync(path.join(d, 'data', 'state.json'), '{"sessions": {"hikari": "abc"'); // 寫到一半
    fs.writeFileSync(path.join(d, 'data', 'state.json.bak'), JSON.stringify({ sessions: { hikari: 'sess-from-bak' },
      queue: [{ agentId: 'hikari', text: '備份裡排隊的工作', opts: { from: 'kai' } }] }));
  });
  const ps = await api('/api/pause');
  assert.equal(ps.pauses.length, 1); assert.equal(ps.pauses[0].scope, 'all');
  assert.match(ps.pauses[0].reason, /狀態檔損毀，已用上次啟動時的備份還原/);
  const files = fs.readdirSync(path.join(dir, 'data'));
  assert.ok(files.some((f) => /^state\.json\.corrupt-/.test(f)), '壞檔保留下來：' + files.join(','));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8')).sessions.hikari, 'sess-from-bak', '用備份還原，並存回完整的檔');
  const q = await api('/api/history/hikari');
  assert.equal(q.queue && q.queue.count, 1, '備份裡的排隊訊息還在（暫停中不會自己跑）');
  assert.match(stderr(), /整個專案先暫停/);
});

test('壞掉而且沒有備份：全新狀態，但一樣暫停並提示', async (t) => {
  const { api } = await boot(t, (d) => { fs.writeFileSync(path.join(d, 'data', 'state.json'), 'not json'); });
  const ps = await api('/api/pause');
  assert.equal(ps.pauses[0].scope, 'all');
  assert.match(ps.pauses[0].reason, /沒有可用的備份/);
});

test('正常啟動：留一份 .bak；沒有 state.json 就是全新狀態（不暫停）', async (t) => {
  const { dir, api } = await boot(t, (d) => { fs.writeFileSync(path.join(d, 'data', 'state.json.bak'), JSON.stringify({ sessions: { hikari: 'old' } })); });
  assert.equal((await api('/api/pause')).pauses.length, 0, '你自己刪掉 state.json 想重來：不會被備份蓋回去');
  assert.ok(!fs.existsSync(path.join(dir, 'data', 'state.json.tmp')), '換名後不留暫存檔');
});

test('對話紀錄：舊的 .json 自動轉成 .jsonl；寫到一半的最後一行跳過', async (t) => {
  const { dir, api } = await boot(t, (d) => {
    fs.writeFileSync(path.join(d, 'data', 'history', 'hikari.json'), JSON.stringify([{ role: 'user', text: '舊的一則', ts: 1 }, { role: 'assistant', segments: [{ type: 'text', text: '舊的回覆' }], ts: 2 }], null, 2));
    fs.writeFileSync(path.join(d, 'data', 'history', 'kai.jsonl'), JSON.stringify({ role: 'user', text: '完整的一行', ts: 1 }) + '\n{"role":"assistant","segm');
  });
  const h = (await api('/api/history/hikari')).history;
  assert.deepEqual(h.map((m) => m.text || m.segments[0].text), ['舊的一則', '舊的回覆']);
  assert.ok(fs.existsSync(path.join(dir, 'data', 'history', 'hikari.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'data', 'history', 'hikari.json.migrated')), '舊檔改名保留');
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'history', 'hikari.jsonl'), 'utf8').trim().split('\n').length, 2, '一則一行');
  assert.deepEqual((await api('/api/history/kai')).history.map((m) => m.text), ['完整的一行'], '壞掉的最後一行跳過，不會整份不見');
});
