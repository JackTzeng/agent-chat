'use strict';
// 小組：舊設定自動轉成第一個小組、新增小組與成員、不同小組的任務同時進行、輪流工作只限同組、刪除小組的限制
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const source = path.resolve(__dirname, '..');

// 假的 Claude：依目前階段回覆；每輪睡 600ms，方便檢查是否同時進行
const MOCK = `#!/usr/bin/env node
const fs = require('fs');
let inp = ''; process.stdin.on('data', (d) => (inp += d)).on('end', () => setTimeout(() => {
  fs.appendFileSync(process.env.MOCKLOG, JSON.stringify({ t: Date.now(), prompt: inp }) + '\\n');
  const o = (x) => console.log(JSON.stringify(x));
  o({ type: 'system', subtype: 'init', session_id: 's' + Date.now() + Math.floor(Math.random() * 1e6) });
  const st = (inp.match(/【你現在負責的階段：(.+?)】/) || [])[1];
  let text = '好的';
  if (st === '規劃') text = '計畫好了\\n【交接】\\n給：許代書\\n內容：做吧';
  else if (st === '實作') text = '做好了\\n【交接】\\n給：小安\\n內容：測吧';
  else if (st === '測試') text = '通過\\n【交接】\\n給：克勞德先生（驗收）\\n內容：ok';
  else if (st === '驗收') text = '開發組完成。';
  else if (st === '整理') text = '整理好了\\n【交接】\\n給：審核員\\n內容：請審';
  else if (st === '審核') text = '報表組完成。';
  o({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  o({ type: 'result', subtype: 'success', duration_ms: 600, usage: { input_tokens: 1, output_tokens: 1 } });
}, 600));
`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('teams: migration, parallel tasks across teams, per-team turn taking', { timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-teams-'));
  for (const f of ['server.js', 'security.js', 'tasks.js', 'telegram.js', 'harness.js', 'diag.js', 'updater.js', 'localsettings.js', 'proctree.js', 'timers.js', 'agy.js', 'clistatus.js', 'skills.js', 'line.js', 'todo.js', 'outbox.js', 'maint.js', 'afterturn.js', 'xlsx.js', 'agents.example.json'])
    fs.copyFileSync(path.join(source, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'public')); fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>test</h1>');
  // 舊版設定：只有 workflow、沒有 teams；所有人都勾輪流工作；規劃不需要核准
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'agents.example.json'), 'utf8'));
  delete cfg.teams;
  cfg.workflow = { name: '舊流程', stages: [
    { id: 'plan', name: '規劃', owner: 'hikari', next: ['build'] }, { id: 'build', name: '實作', owner: 'kai', next: ['test'] },
    { id: 'test', name: '測試', owner: 'qa', next: ['accept', 'build'] }, { id: 'accept', name: '驗收', owner: 'hikari', next: [] }] };
  for (const a of cfg.agents) { a.takeTurns = true; if (a.engine === 'codex') { a.engine = 'claude'; delete a.sandbox; a.permissionMode = 'auto'; } }
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(cfg));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), MOCK, { mode: 0o755 });
  const log = path.join(dir, 'runs.log'); fs.writeFileSync(log, '');
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ACCESS_TOKEN: 'teams-test-password-long', TELEGRAM_BOT_TOKEN: '',
      CLAUDE_BIN: path.join(bin, 'claude'), CODEX_BIN: path.join(bin, 'claude'), MOCKLOG: log, AGENT_ENV_ALLOWLIST: 'MOCKLOG' },
  });
  let stderr = ''; proc.stderr.on('data', (s) => { stderr += s; });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/')).status === 200) break; } catch {} await sleep(50); }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'teams-test-password-long' }) });
  assert.equal(r.status, 200, stderr);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json(); if (res.status >= 400) throw Object.assign(new Error(j.error || p), { status: res.status }); return j;
  };

  // 舊設定 → 第一個小組
  let conf = await api('/api/config');
  assert.equal(conf.teams.length, 1);
  assert.equal(conf.teams[0].name, '開發組');
  assert.equal(conf.teams[0].workflow.name, '舊流程');
  assert.ok(conf.agents.every((a) => a.team === conf.teams[0].id));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')).workflow, undefined);
  const dev = conf.teams[0].id;

  // 新增第二個小組、兩位成員、流程
  const { id: em } = await api('/api/teams', 'POST', { name: '報表組', icon: '📊' });
  await assert.rejects(api('/api/teams', 'POST', { name: '報表組' }), /已經有/);
  fs.mkdirSync(path.join(dir, 'workspace', 'em'), { recursive: true });
  const mk = (name) => api('/api/agents', 'POST', { name, engine: 'claude', permissionMode: 'auto', cwd: './workspace/em', team: em, takeTurns: true });
  const { id: dataId } = await mk('阿資');
  const { id: revId } = await mk('審核員');
  await api('/api/team', 'PUT', { teamId: em, workflow: { name: '報表流程', stages: [
    { id: 'collect', name: '整理', owner: dataId, next: ['review'] }, { id: 'review', name: '審核', owner: revId, next: [] }] },
  takeTurns: [dataId, revId] });
  conf = await api('/api/config');
  const emTeam = conf.teams.find((x) => x.id === em);
  assert.equal(emTeam.workflow.stages[0].owner, dataId);
  // 別組的成員不能當這組的負責人
  await api('/api/team', 'PUT', { teamId: em, workflow: { name: 'x', stages: [{ id: 'a', name: '整理', owner: 'hikari', next: [] }] } });
  assert.equal((await api('/api/config')).teams.find((x) => x.id === em).workflow.stages[0].owner, '');
  await api('/api/team', 'PUT', { teamId: em, workflow: emTeam.workflow });

  // 兩個小組同時開始任務；同一個小組不能同時兩件
  const t1 = await api('/api/tasks', 'POST', { goal: '開發組的任務', teamId: dev });
  const t2 = await api('/api/tasks', 'POST', { goal: '報表組的任務', teamId: em });
  await assert.rejects(api('/api/tasks', 'POST', { goal: '再一件', teamId: em }), /已經有進行中的任務/);
  // 兩組的成員同時在工作（輪流工作只限同組）
  let both = false;
  for (let i = 0; i < 40 && !both; i++) {
    const ag = await api('/api/agents');
    both = ag.some((a) => a.team === dev && a.busy) && ag.some((a) => a.team === em && a.busy);
    await sleep(50);
  }
  assert.ok(both, 'both teams work at the same time');
  const tasksNow = await api('/api/tasks');
  assert.equal(tasksNow.actives.length, 2);
  // 等兩件都完成
  for (let i = 0; i < 300; i++) {
    const ts = (await api('/api/tasks')).tasks;
    if (ts.find((x) => x.id === t1.id).status === 'done' && ts.find((x) => x.id === t2.id).status === 'done') break;
    await sleep(100);
  }
  const ts = (await api('/api/tasks')).tasks;
  assert.equal(ts.find((x) => x.id === t1.id).status, 'done', stderr);
  assert.equal(ts.find((x) => x.id === t2.id).status, 'done');
  assert.equal(ts.find((x) => x.id === t2.id).teamName, '報表組');

  // 提示詞：只列自己小組的成員
  const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const emRun = runs.find((x) => /負責的階段：整理/.test(x.prompt));
  assert.match(emRun.prompt, /【團隊成員（報表組）】/);
  assert.doesNotMatch(emRun.prompt, /克勞德先生/);
  // 同一組（開發組）沒有任何兩輪重疊（輪流工作）
  assert.match(fs.readFileSync(path.join(dir, 'workspace', 'em', 'WORKFLOW.md'), 'utf8'), /報表流程（報表組）/);
  assert.match(fs.readFileSync(path.join(dir, 'workspace', 'WORKFLOW.md'), 'utf8'), /舊流程（開發組）/);

  // 刪除小組：有成員不能刪
  await assert.rejects(api('/api/teams/' + em, 'DELETE'), /還有成員/);
  // 負責人不能直接換小組
  await assert.rejects(api('/api/agents/' + dataId, 'PUT', { name: '阿資', engine: 'claude', permissionMode: 'auto', cwd: './workspace/em', team: dev }), /負責人/);
  await api('/api/agents/' + dataId, 'DELETE');
  await api('/api/agents/' + revId, 'DELETE');
  await api('/api/teams/' + em, 'DELETE');
  await assert.rejects(api('/api/teams/' + dev, 'DELETE'), /至少要留一個/);

  // 小組工作資料夾：新小組自動建立資料夾，新成員沒填資料夾就用小組的
  const { id: qc } = await api('/api/teams', 'POST', { name: '品管組', icon: '🧪', cwd: './workspace/qc' });
  assert.ok(fs.statSync(path.join(dir, 'workspace', 'qc')).isDirectory());
  const { id: q1 } = await api('/api/agents', 'POST', { name: '品管一', engine: 'claude', permissionMode: 'auto', team: qc });
  const { id: q2 } = await api('/api/agents', 'POST', { name: '品管二', engine: 'claude', permissionMode: 'auto', team: qc, cwd: './workspace' });
  conf = await api('/api/config');
  assert.equal(conf.agents.find((a) => a.id === q1).cwd, path.join(dir, 'workspace', 'qc'));
  assert.deepEqual(conf.teams.find((x) => x.id === qc).sharedWith, ['開發組'], 'q2 shares ./workspace with 開發組');
  // 不填資料夾的小組，預設是 ./workspace/<id>
  const { id: tmp } = await api('/api/teams', 'POST', { name: '暫時組' });
  assert.equal((await api('/api/config')).teams.find((x) => x.id === tmp).cwd, path.join(dir, 'workspace', tmp));
  await api('/api/teams/' + tmp, 'DELETE');

  // 共用資料夾時：開發組（排第一）照用 TASK.md，品管組改用 TASK-品管組.md、WORKFLOW-品管組.md
  await api('/api/team', 'PUT', { teamId: qc, workflow: { name: '品管流程', stages: [{ id: 'c', name: '整理', owner: q2, next: ['r'] }, { id: 'r', name: '審核', owner: q1, next: [] }] } });
  const devTask = JSON.stringify(fs.readFileSync(path.join(dir, 'workspace', 'TASK.md'), 'utf8'));
  assert.match(fs.readFileSync(path.join(dir, 'workspace', 'WORKFLOW-品管組.md'), 'utf8'), /品管流程（品管組）/);
  assert.match(fs.readFileSync(path.join(dir, 'workspace', 'WORKFLOW.md'), 'utf8'), /舊流程（開發組）/);
  const t3 = await api('/api/tasks', 'POST', { goal: '品管組的任務', teamId: qc });
  for (let i = 0; i < 200; i++) { if ((await api('/api/tasks')).tasks.find((x) => x.id === t3.id).status === 'done') break; await sleep(100); }
  assert.match(fs.readFileSync(path.join(dir, 'workspace', 'TASK-品管組.md'), 'utf8'), /品管組的任務/);
  assert.equal(JSON.stringify(fs.readFileSync(path.join(dir, 'workspace', 'TASK.md'), 'utf8')), devTask, '開發組的 TASK.md 沒被蓋掉');
  const qcRun = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => /品管組的任務/.test(x.prompt) && /負責的階段：整理/.test(x.prompt));
  assert.match(qcRun.prompt, /TASK-品管組\.md/);
  // 把組員搬到小組資料夾：之後不再共用
  await api('/api/team', 'PUT', { teamId: qc, cwd: './workspace/qc', moveMembers: true });
  conf = await api('/api/config');
  assert.equal(conf.agents.find((a) => a.id === q2).cwd, path.join(dir, 'workspace', 'qc'));
  assert.deepEqual(conf.teams.find((x) => x.id === qc).sharedWith, []);

  // 守則依小組：只給品管組的守則只寫進品管組的 GUIDES.md，開發組的資料夾讀不到
  await api('/api/harness/guides', 'POST', { text: '品管報告用 A4 直式', scope: 'team:' + qc });
  await api('/api/harness/guides', 'POST', { text: '開發組改程式前先讀 PLAN.md', scope: 'team:' + dev });
  await api('/api/harness/guides', 'POST', { text: '審核階段要附簽核欄', scope: 'stage:' + qc + ':r' });
  const qcGuides = fs.readFileSync(path.join(dir, 'workspace', 'qc', 'GUIDES.md'), 'utf8');
  const devGuides = fs.readFileSync(path.join(dir, 'workspace', 'GUIDES.md'), 'utf8');
  assert.match(qcGuides, /品管報告用 A4/); assert.match(qcGuides, /審核階段要附簽核欄/);
  assert.doesNotMatch(qcGuides, /PLAN\.md/);
  assert.match(devGuides, /PLAN\.md/); assert.doesNotMatch(devGuides, /品管|簽核/);
  // 一般對話只看到小組守則；階段守則只在那個階段
  let h = await api('/api/harness');
  const loadQ1 = h.load.find((x) => x.id === q1);
  assert.equal(loadQ1.total, 1, '一般對話：品管一只會收到小組守則（階段守則只在審核階段）');
  // 字數上限：放不下的不放進提示詞
  for (let i = 0; i < 6; i++) await api('/api/harness/guides', 'POST', { text: '品管規則 ' + i + ' ' + '很長的說明'.repeat(12), scope: 'team:' + qc });
  await api('/api/team', 'PUT', { teamId: qc, harness: { guideChars: 300 } });
  h = await api('/api/harness');
  const l2 = h.load.find((x) => x.id === q1);
  assert.equal(l2.total, 7);
  assert.ok(l2.shown < l2.total && l2.chars < 450, JSON.stringify(l2));
  // 📌 必讀優先、⏸ 停用就不算
  const first = h.guides.find((g) => g.text === '品管報告用 A4 直式');
  await api('/api/harness/guides/' + first.id, 'PUT', { pinned: true });
  await api('/api/harness/guides/' + h.guides.find((g) => /品管規則 0/.test(g.text)).id, 'PUT', { off: true });
  h = await api('/api/harness');
  assert.equal(h.load.find((x) => x.id === q1).total, 6);
  assert.ok(h.guides.find((g) => g.id === first.id).pinned);
});
