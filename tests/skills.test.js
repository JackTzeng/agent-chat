'use strict';
// 🧩 Skill：來源解析、tar.gz 解開與安全檢查、成員提出 → 使用者核准 → 系統安裝／取代／移除（用本機假的 GitHub 下載站）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const sk = require('../skills');
const source = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 做一個 GitHub 風格的 tar（最上層是 owner-repo-sha/），支援長檔名（pax）與符號連結
function makeTar(files) {
  const blocks = [];
  const header = (name, size, type, link = '') => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148);
    h.write(type, 156); h.write(link, 157); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  blocks.push(header('pax_global_header', 0, 'g'));
  for (const f of files) {
    if (f.link) { blocks.push(header(f.path, 0, '2', f.link)); continue; }
    const data = Buffer.from(f.data);
    if (f.path.length > 100) {
      const rec = ' path=' + f.path + '\n'; let len = rec.length + 3; len = String(len).length + rec.length;
      const pax = Buffer.from(len + rec);
      blocks.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    blocks.push(header(f.path, data.length, '0'), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('parse sources and 【安裝 Skill】 lines', () => {
  assert.deepEqual(sk.parseSpec('nutlope/hallmark'), { owner: 'nutlope', repo: 'hallmark', ref: null, sub: '' });
  assert.deepEqual(sk.parseSpec('anthropics/skills/document-skills/pdf@main'), { owner: 'anthropics', repo: 'skills', ref: 'main', sub: 'document-skills/pdf' });
  assert.deepEqual(sk.parseSpec('https://github.com/acme/tools/tree/v2/skills/notes'), { owner: 'acme', repo: 'tools', ref: 'v2', sub: 'skills/notes' });
  assert.equal(sk.parseSpec('acme'), null);
  assert.equal(sk.parseSpec('acme/tools/../../etc'), null, '不接受 ..');
  assert.equal(sk.parseSpec('ac me/tools'), null);
  const c = sk.collect('好的，建議裝這個：\n【安裝 Skill】nutlope/hallmark → Coder\n- 【安裝Skill】：acme/tools/skills/notes\n【安裝 Skill】???');
  assert.equal(c.length, 3);
  assert.equal(c[0].target, 'Coder'); assert.equal(c[0].spec.repo, 'hallmark');
  assert.equal(c[1].target, ''); assert.equal(c[1].spec.sub, 'skills/notes');
  assert.ok(c[2].error);
  assert.deepEqual(sk.frontmatter('---\nname: my-skill\ndescription: >\n  first line\n  second line\n---\n# body'), { name: 'my-skill', description: 'first line second line' });
});

test('untar: strips top folder, follows pax long names, skips symlinks and ..', () => {
  const long = 'skills/' + 'x'.repeat(120) + '/SKILL.md';
  const tar = makeTar([
    { path: 'acme-tools-abc/README.md', data: 'hi' },
    { path: 'acme-tools-abc/' + long, data: '---\nname: longone\n---' },
    { path: 'acme-tools-abc/evil', link: '/etc/passwd' },
    { path: 'acme-tools-abc/../escape.txt', data: 'no' },
  ]);
  const files = sk.normalizeEntries(sk.untar(tar));
  assert.deepEqual(files.map((f) => f.path), ['README.md', long]);
  const skills = sk.findSkills(files);
  assert.equal(skills[0].name, 'longone');
  const rv = sk.review({ dir: 'a', files: [{ path: 'a/SKILL.md', data: Buffer.from('x') }, { path: 'a/run.ps1', data: Buffer.from('x') }, { path: 'a/tool', data: Buffer.from('#!/bin/sh') }] });
  assert.deepEqual(rv.scripts, ['run.ps1', 'tool']);
});

const MOCK_CLAUDE = `#!/usr/bin/env node
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => {
  require('fs').appendFileSync(process.env.MOCKLOG, '=====CLAUDE\\n' + inp + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid });
  const text = inp.includes('NEEDSKILL') ? '找到了，請核准：\\n【安裝 Skill】acme/single → 全域' : '收到';
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

test('request → review → approve → install / replace / remove through the real server', { timeout: 90000 }, async (t) => {
  // 假的 GitHub 下載站
  const repos = {
    '/acme/single/tar.gz/HEAD': makeTar([
      { path: 'acme-single-1/README.md', data: '# readme' },
      { path: 'acme-single-1/SKILL.md', data: '---\nname: single-skill\ndescription: 一個簡單的 Skill\n---\n說明' },
      { path: 'acme-single-1/reference/notes.md', data: 'notes' },
    ]),
    '/acme/tools/tar.gz/HEAD': makeTar([
      { path: 'acme-tools-2/skills/hallmark/SKILL.md', data: '---\nname: hallmark\ndescription: 設計審美\n---' },
      { path: 'acme-tools-2/skills/hallmark/sloplint.mjs', data: 'console.log(1)' },
      { path: 'acme-tools-2/skills/notes/SKILL.md', data: '---\nname: notes\n---' },
    ]),
  };
  const gh = http.createServer((req, res) => {
    const tar = repos[req.url];
    if (!tar) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/x-gzip' }); res.end(zlib.gzipSync(tar));
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const ghBase = 'http://127.0.0.1:' + gh.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-skills-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({
    teams: [{ id: 'main', name: '開發組', icon: '🛠', workflow: '1. 隨便', cwd: './workspace' }],
    agents: [
      { id: 'pm', name: 'PM', role: 'PM', engine: 'claude', permissionMode: 'auto', cwd: './workspace', team: 'main' },
      { id: 'bk', name: '記帳員', role: '記帳', engine: 'claude', permissionMode: 'default', allowedTools: ['Read'], cwd: './workspace/books', standalone: true },
    ],
  }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK_CLAUDE, { mode: 0o755 });
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const log = path.join(dir, 'calls.log');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'skill-test-password-long', TELEGRAM_BOT_TOKEN: '', CLAUDE_CONFIG_DIR: home,
      SKILL_TARBALL_BASE: ghBase, CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: '', AGY_BIN: '', MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG', AGENTCHAT_NO_UPDATE_CHECK: '1' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    gh.close();
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r0 = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'skill-test-password-long' }) });
  assert.equal(r0.status, 200, stderr);
  const cookie = r0.headers.get('set-cookie').split(';')[0];
  const call = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    return { status: res.status, j: await res.json() };
  };
  const api = async (p, method, body) => { const r = await call(p, method, body); if (r.status >= 400) throw new Error(p + ' ' + r.status + ' ' + JSON.stringify(r.j)); return r.j; };
  const waitFor = async (fn, what) => { for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timeout: ' + what + '\n' + stderr); };
  const reqOf = async (id) => (await api('/api/skills')).requests.find((r) => r.id === id);
  const lastReply = async (id) => { const h = (await api('/api/history/' + id)).history.filter((x) => x.role === 'assistant'); const l = h[h.length - 1]; return l ? l.segments.map((s) => s.text).join('\n') : ''; };

  // 1) 成員在回覆裡提出 → 申請（不會自動安裝），提示詞有教它怎麼提出
  await api('/api/chat/pm', 'POST', { text: 'NEEDSKILL 幫我找個 Skill' });
  await waitFor(async () => /已送出 Skill 安裝申請 #1/.test(await lastReply('pm')), 'request noted');
  assert.match(fs.readFileSync(log, 'utf8'), /【安裝 Skill】GitHub擁有者\/repo/, '提示詞說明了怎麼提出');
  let r = await waitFor(async () => { const x = await reqOf(1); return x && x.status === 'ready' && x; }, 'ready');
  assert.equal(r.name, 'single-skill'); assert.equal(r.fromName, 'PM'); assert.equal(r.targetKey, 'global');
  assert.equal(r.review.fileCount, 3); assert.deepEqual(r.review.scripts, []);
  assert.ok(!fs.existsSync(path.join(home, 'skills', 'single-skill')), '核准前沒有安裝');
  assert.equal((await api('/api/skills')).pending, 1);

  // 2) 核准 → 裝到全域；成員看得到；最小權限成員用不到
  await api('/api/skills/requests/1/approve', 'POST', { target: 'global' });
  assert.ok(fs.existsSync(path.join(home, 'skills', 'single-skill', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, 'skills', 'single-skill', 'reference', 'notes.md')));
  let snap = await api('/api/skills');
  assert.equal(snap.requests.find((x) => x.id === 1).status, 'installed');
  assert.deepEqual(snap.roots.find((x) => x.key === 'global').skills.map((x) => x.title), ['single-skill']);
  const mem = Object.fromEntries(snap.members.map((m) => [m.id, m]));
  assert.deepEqual(mem.pm.skills, ['single-skill']);
  assert.deepEqual(mem.bk.skills, []); assert.match(mem.bk.note, /最小權限/);

  // 3) 網頁新增、repo 有好幾個 → 選一個 → 標出腳本 → 裝到小組資料夾
  const teamKey = snap.targets.find((x) => x.key !== 'global' && /開發組/.test(x.label)).key;
  await api('/api/skills/requests', 'POST', { source: 'https://github.com/acme/tools', target: teamKey });
  r = await waitFor(async () => { const x = (await api('/api/skills')).requests.find((y) => y.source === 'acme/tools'); return x && x.status === 'choose' && x; }, 'choose');
  assert.deepEqual(r.choices.map((c) => c.name).sort(), ['hallmark', 'notes']);
  await api('/api/skills/requests/' + r.id + '/choose', 'POST', { skill: 'hallmark' });
  r = await waitFor(async () => { const x = await reqOf(r.id); return x.status === 'ready' && x; }, 'ready 2');
  assert.deepEqual(r.review.scripts, ['sloplint.mjs'], '腳本被標出來');
  await api('/api/skills/requests/' + r.id + '/approve', 'POST', { target: teamKey });
  assert.ok(fs.existsSync(path.join(dir, 'workspace', '.claude', 'skills', 'hallmark', 'sloplint.mjs')));
  snap = await api('/api/skills');
  assert.deepEqual(snap.members.find((m) => m.id === 'pm').skills.sort(), ['hallmark', 'single-skill']);

  // 4) 已經有同名的：不勾取代 → 拒絕；勾了 → 舊的搬到回收區
  await api('/api/skills/requests', 'POST', { source: 'acme/single', target: 'global' });
  r = await waitFor(async () => { const x = (await api('/api/skills')).requests.find((y) => y.source === 'acme/single' && y.status === 'ready'); return x; }, 'ready 3');
  assert.equal(r.exists, true);
  assert.equal((await call('/api/skills/requests/' + r.id + '/approve', 'POST', { target: 'global' })).status, 400);
  await api('/api/skills/requests/' + r.id + '/approve', 'POST', { target: 'global', replace: true });
  assert.equal(fs.readdirSync(path.join(dir, 'data', 'skills-trash')).length, 1);

  // 5) 拒絕、找不到的 repo、移除（只能移除管理範圍內的）
  await api('/api/skills/requests', 'POST', { source: 'acme/nope' });
  r = await waitFor(async () => { const x = (await api('/api/skills')).requests.find((y) => y.source === 'acme/nope' && y.status === 'failed'); return x; }, 'failed');
  assert.match(r.error, /找不到這個 repo/);
  await api('/api/skills/requests/' + r.id + '/reject', 'POST');
  assert.equal((await call('/api/skills/remove', 'POST', { root: home, name: 'single-skill' })).status, 400, '不在管理範圍的資料夾不能刪');
  assert.equal((await call('/api/skills/remove', 'POST', { root: path.join(home, 'skills'), name: '../x' })).status, 400);
  await api('/api/skills/remove', 'POST', { root: path.join(home, 'skills'), name: 'single-skill' });
  assert.ok(!fs.existsSync(path.join(home, 'skills', 'single-skill')));
  assert.equal(fs.readdirSync(path.join(dir, 'data', 'skills-trash')).length, 2, '移除是搬到回收區');
});
