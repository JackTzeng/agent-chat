// 工作流程與任務：依照「流程定義」推動 PM → Coder → QA 等階段的交接
'use strict';
const fs = require('fs');
const path = require('path');
const { cleanChecks } = require('./harness');

const DEFAULT_STAGES = [
  { id: 'plan', name: '規劃', owner: 'hikari', approval: true, next: ['build'],
    goal: '釐清使用者的目標（不清楚就先問使用者）、訂出可驗證的驗收標準，把計畫寫進 PLAN.md。你不寫程式碼。',
    deliverable: 'PLAN.md：目標、任務清單、驗收標準' },
  { id: 'build', name: '實作', owner: 'kai', approval: false, next: ['test'],
    goal: '依照 PLAN.md 實作。完成後說明做了什麼、怎麼執行、要測什麼。',
    deliverable: '可以執行的成果與執行方式' },
  { id: 'test', name: '測試', owner: 'qa', approval: false, next: ['accept', 'build'],
    goal: '依照 PLAN.md 的驗收標準實際執行與測試，不要只讀程式碼。不通過就退回「實作」並列出重現步驟、預期與實際結果；通過就交給「驗收」。你不修改程式碼。',
    deliverable: '測試報告：測了哪些項目、結果、證據' },
  { id: 'accept', name: '驗收', owner: 'hikari', approval: false, next: [],
    goal: '對照 PLAN.md 的驗收標準確認成果，向使用者總結：完成了什麼、怎麼使用、還有什麼限制。',
    deliverable: '給使用者的總結' },
];
const ACTIVE = ['running', 'awaiting_approval', 'waiting_user'];
const STATUS_TEXT = {
  running: '進行中', awaiting_approval: '等你核准', waiting_user: '等你回覆',
  done: '已完成', stopped: '已停止', error: '出錯暫停',
};
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache', '.agentchat']);
const SKIP_FILES = new Set(['TASK.md', 'WORKFLOW.md', 'GUIDES.md', 'MEMORY.md']);
const SKIP_DOC = /^(TASK|WORKFLOW)-.+\.md$/; // 共用資料夾時各小組自己的 TASK-小組.md、WORKFLOW-小組.md

const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const pad = (n) => String(n).padStart(2, '0');
const fmt = (ts) => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };

// 舊版的 workflow 是一段文字；轉成有結構的流程
function normalizeWorkflow(raw, agents) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.stages)) return cleanWorkflow(raw, agents);
  const ids = new Set(agents.map((a) => a.id));
  const notes = typeof raw === 'string' && !raw.startsWith('1. 使用者把目標交給 PM') ? raw : '';
  return cleanWorkflow({
    name: 'PM → Coder → QA 標準流程', notes,
    stages: DEFAULT_STAGES.map((s) => ({ ...s, owner: ids.has(s.owner) ? s.owner : '' })),
  }, agents);
}

function cleanWorkflow(input, agents) {
  agents = (agents || []).filter((a) => !a.standalone); // 獨立成員不進工作流程
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const ids = new Set(agents.map((a) => a.id));
  const used = new Set();
  const stages = (Array.isArray(input.stages) ? input.stages : []).slice(0, 20).map((s, i) => {
    let id = str(s.id, 30).replace(/[^\w-]/g, '') || 's' + (i + 1);
    while (used.has(id)) id += 'x';
    used.add(id);
    return {
      id, name: str(s.name, 20) || '階段' + (i + 1),
      owner: ids.has(s.owner) ? s.owner : '',
      goal: str(s.goal, 2000), deliverable: str(s.deliverable, 300),
      approval: !!s.approval, next: Array.isArray(s.next) ? s.next.map(String) : [],
      checks: cleanChecks(s.checks),
    };
  });
  for (const s of stages) s.next = [...new Set(s.next)].filter((n) => n !== s.id && used.has(n));
  return { name: str(input.name, 40) || '團隊流程', notes: str(input.notes, 4000), stages };
}

// ---------- 工作資料夾快照：比對一輪前後實際改了哪些檔案 ----------
// roots：[{ dir, prefix }]，工作資料夾的 prefix 是空字串，額外資料夾用資料夾名稱當前綴
function snapshot(roots) {
  if (typeof roots === 'string') roots = [{ dir: roots, prefix: '' }];
  const files = new Map();
  let budget = 30 * 1024 * 1024, count = 0;
  for (const { dir, prefix } of roots) walkRoot(dir, prefix);
  return files;
  function walkRoot(dir, prefix) {
  (function walk(d, rel) {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (count > 3000) return;
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, r); continue; }
      if (!e.isFile() || (rel === '' && (SKIP_FILES.has(e.name) || SKIP_DOC.test(e.name)))) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      count++;
      const entry = { size: st.size, mtime: st.mtimeMs };
      if (st.size <= 1024 * 1024 && budget > st.size) {
        try {
          const buf = fs.readFileSync(p);
          if (!buf.subarray(0, 8000).includes(0)) { entry.text = buf.toString('utf8'); budget -= st.size; }
        } catch {}
      }
      files.set(r, entry);
    }
  })(dir, prefix);
  }
}
function rootsFor(agent) {
  const roots = [{ dir: agent.cwd, prefix: '' }];
  for (const d of agent.extraDirs || []) if (d.mode !== 'ro') roots.push({ dir: d.path, prefix: '[' + path.basename(d.path) + ']' });
  return roots;
}

function lineDelta(a, b) {
  const count = new Map();
  for (const l of a.split('\n')) count.set(l, (count.get(l) || 0) + 1);
  let plus = 0;
  for (const l of b.split('\n')) { const c = count.get(l); if (c) count.set(l, c - 1); else plus++; }
  let minus = 0; for (const c of count.values()) minus += c;
  return { plus, minus };
}

function diffSnapshots(before, after) {
  const out = [];
  for (const [p, n] of after) {
    const o = before.get(p);
    if (!o) { out.push({ path: p, kind: 'add', plus: n.text != null ? n.text.split('\n').length : null }); continue; }
    if (o.size === n.size && o.mtime === n.mtime) continue;
    if (o.text != null && n.text != null) {
      if (o.text === n.text) continue;
      out.push({ path: p, kind: 'mod', ...lineDelta(o.text, n.text) });
    } else out.push({ path: p, kind: 'mod' });
  }
  for (const p of before.keys()) if (!after.has(p)) out.push({ path: p, kind: 'del' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// 同一個階段可能跑好幾輪（例如先問使用者），把每輪的變更合併成「這個階段的變更」
function mergeChanges(prev, cur) {
  const m = new Map((prev || []).map((c) => [c.path, { ...c }]));
  for (const c of cur) {
    const o = m.get(c.path);
    if (!o) { m.set(c.path, { ...c }); continue; }
    if (o.kind === 'add' && c.kind === 'del') m.delete(c.path);
    else if (o.kind === 'add') m.set(c.path, { path: c.path, kind: 'add', plus: null });
    else if (c.kind === 'del') m.set(c.path, { path: c.path, kind: 'del' });
    else if (o.kind === 'del') m.set(c.path, { path: c.path, kind: 'mod' });
    else m.set(c.path, { path: c.path, kind: 'mod', plus: o.plus != null && c.plus != null ? o.plus + c.plus : null, minus: o.minus != null && c.minus != null ? o.minus + c.minus : null });
  }
  return [...m.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function changesText(changes) {
  if (!changes || !changes.length) return '（沒有檔案變更）';
  const lines = changes.slice(0, 40).map((c) =>
    c.kind === 'add' ? '- 新增 ' + c.path + (c.plus != null ? '（' + c.plus + ' 行）' : '')
      : c.kind === 'del' ? '- 刪除 ' + c.path
        : '- 修改 ' + c.path + (c.plus != null ? '（+' + c.plus + ' / −' + c.minus + ' 行）' : ''));
  if (changes.length > 40) lines.push('- ……另外 ' + (changes.length - 40) + ' 個檔案');
  return lines.join('\n');
}

// 回覆最後的【交接】區塊
function parseHandoff(text) {
  const i = text.lastIndexOf('【交接】');
  if (i < 0) return null;
  const block = text.slice(i + 4).trim();
  const toLine = block.match(/^\s*(?:給|交給|to)\s*[:：]\s*(.+)$/im);
  const content = block.replace(/^\s*(?:給|交給|to)\s*[:：].*$/im, '').replace(/^\s*內容\s*[:：]\s*/m, '').trim();
  return { to: toLine ? toLine[1].trim().replace(/^@/, '') : '', content };
}

exports.create = function create(ctx) {
  const FILE = path.join(ctx.DATA_DIR, 'tasks.json');
  const HIST = path.join(ctx.DATA_DIR, 'workflow-history');
  let store = { seq: 0, tasks: [] };
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const save = () => {
    store.tasks = store.tasks.slice(-100);
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(store, null, 2)); fs.renameSync(FILE + '.tmp', FILE);
  };
  // 伺服器重開時，還在跑的任務已經沒有對應的程式了
  for (const t of store.tasks) if (t.status === 'running') { t.checking = null; t.status = 'waiting_user'; t.note = '伺服器重新啟動，任務暫停，請回覆讓它繼續或停止任務'; }

  // 小組：每個小組有自己的工作流程；任務屬於某個小組（舊任務沒有 teamId → 第一個小組）
  const teams = () => ctx.teams();
  const teamOf = (t) => (t && ctx.teamById(t.teamId)) || teams()[0];
  const wf = (t) => teamOf(t).workflow;
  const stageIn = (t, id) => wf(t).stages.find((s) => s.id === id);
  const name = (id) => (ctx.agentById(id) || {}).name || '（未指定）';
  const get = (id) => store.tasks.find((t) => t.id === Number(id));
  const activeOf = (teamId) => store.tasks.find((t) => ACTIVE.includes(t.status) && teamOf(t).id === teamId);
  const actives = () => store.tasks.filter((t) => ACTIVE.includes(t.status));
  const maxTurns = (t) => Number(teamOf(t).maxRelayHops) || Number(ctx.CONFIG.maxRelayHops) || 12;
  const teamMembers = (teamId) => ctx.AGENTS.filter((a) => !a.standalone && a.team === teamId);
  // 同一個資料夾有好幾個小組在用時：排第一的小組用 TASK.md／WORKFLOW.md，其他小組用 TASK-小組名.md，不會互相覆蓋
  const sameDir = (a, b) => path.resolve(a || '').toLowerCase() === path.resolve(b || '').toLowerCase();
  const teamsInDir = (dir) => teams().filter((t) => teamMembers(t.id).some((a) => sameDir(a.cwd, dir)) || (t.cwd && sameDir(t.cwd, dir)));
  function docName(dir, team, base) {
    const users = teamsInDir(dir);
    if (!team || users.length < 2 || users[0].id === team.id) return base;
    const tag = String(team.name || team.id).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20) || team.id;
    return base.replace(/\.md$/, '-' + tag + '.md');
  }
  const taskDocName = (task) => docName(task.workspace, teamOf(task), 'TASK.md');

  function changed(task, event, message) {
    task.updatedAt = Date.now();
    save(); writeTaskFile(task);
    ctx.broadcast({ agentId: '*', kind: 'task', taskId: task.id });
    if (event) ctx.hooks.emit('task', { task, event, message, statusText: STATUS_TEXT[task.status] });
  }
  function log(task, entry) { task.log.push({ ts: Date.now(), ...entry }); }

  // ---------- 每一輪送給成員的說明（身分、流程、目前階段、交接方式）----------
  function promptHeader(agent, opts) {
    const task = get(opts.taskId), w = wf(task), st = stageIn(task, opts.stageId), stage = (id) => stageIn(task, id), team = teamOf(task);
    const lines = [];
    lines.push('【你的身分】你是「' + agent.name + '」' + (agent.role ? '，職責：' + agent.role : ''));
    if (agent.persona) lines.push(agent.persona);
    if (ctx.accessText) lines.push('', ctx.accessText(agent));
    lines.push('', '【團隊成員（' + team.name + '）】');
    for (const a of teamMembers(team.id)) lines.push('- ' + a.name + '：' + (a.role || a.engine) + (a.id === agent.id ? '（就是你）' : ''));
    if (task) lines.push('', '【目前任務 #' + task.id + '】', task.goal);
    if (task && task.notes && task.notes.length) {
      lines.push('', '【使用者在任務進行中的補充指示（一定要遵守；和前面的內容衝突時，以越新的為準）】');
      for (const n of task.notes) lines.push('- ' + fmt(n.ts) + '：' + n.text);
    }
    lines.push('', '【工作流程：' + w.name + '】');
    w.stages.forEach((s, i) => {
      const nx = s.next.map((n) => (stage(n) || {}).name).filter(Boolean);
      lines.push((i + 1) + '. ' + s.name + '（負責：' + name(s.owner) + '）：' + (s.goal || '') +
        (s.deliverable ? '｜交付物：' + s.deliverable : '') + '｜完成後交給：' + (nx.length ? nx.join(' 或 ') : '（最後階段）') +
        (s.approval ? '｜交出前需要使用者核准' : ''));
    });
    if (w.notes) lines.push('其他規則：' + w.notes);
    if (ctx.harness) { const hb = ctx.harness.promptBlock(agent, { stageId: st ? st.id : null }); if (hb) lines.push('', hb); }
    if (ctx.urgentHint) { const uh = ctx.urgentHint(agent); if (uh) lines.push('', uh); }
    if (st) {
      lines.push('', '【你現在負責的階段：' + st.name + '】');
      if (st.goal) lines.push('要做什麼：' + st.goal);
      if (st.deliverable) lines.push('交付物：' + st.deliverable);
      if (st.checks && st.checks.length) lines.push('自動檢查：你寫好交接（或總結）後，系統會在你的工作資料夾執行 ' +
        st.checks.map((c) => '「' + c.command + '」').join('、') + '，全部通過才會交出；交出前請自己先跑過。');
      const nx = st.next.map(stage).filter(Boolean);
      if (nx.length) {
        lines.push('', '【交接方式】完成這個階段後，在回覆的最後加上交接區塊，格式要完全一樣：', '【交接】', '給：<下一位成員的名字>',
          '內容：<你完成了什麼、相關檔案、對方要做什麼、驗收標準>',
          '這個階段可以交給：' + nx.map((s) => name(s.owner) + '（' + s.name + '）').join('、'));
        if (st.approval) lines.push('這個階段交出前需要使用者核准：寫好交接區塊即可，系統會請使用者核准，不需要另外詢問。');
        lines.push('- 需要問使用者時：直接提問，不要寫交接區塊，系統會等使用者回覆後再交給你。');
      } else {
        lines.push('', '這是最後一個階段：完成後寫給使用者的總結，不要寫交接區塊。需要問使用者時直接提問。');
      }
      lines.push('- 改了哪些檔案，系統會自動附給下一位，不用逐一列出。',
        '- 任務狀態與交接紀錄在 ' + taskDocName(task) + '（系統維護，可以讀，不要修改）。');
    }
    return lines.join('\n');
  }

  function snapshotFor(agent) { return snapshot(rootsFor(agent)); }

  // ---------- 一輪結束：判斷要交接、等使用者、還是完成 ----------
  function onTurnDone(agent, run, opts, before) {
    const task = get(opts.taskId);
    if (!task || !ACTIVE.includes(task.status)) return;
    const changes = before ? diffSnapshots(before, snapshot(rootsFor(agent))) : [];
    const text = run.segments.filter((s) => s.type === 'text').map((s) => s.text).join('\n\n');
    const errors = run.segments.filter((s) => s.type === 'error');
    const stage = (id) => stageIn(task, id);
    const st = stage(opts.stageId);
    task.turns = (task.turns || 0) + 1;
    task.stageChanges = mergeChanges(task.stageChanges, changes);
    log(task, { type: 'turn', agent: agent.id, stage: opts.stageId, changes, text: short(text, 300) });

    if (run.stopped) { task.status = 'stopped'; log(task, { type: 'stopped' }); return changed(task, 'stopped', '任務已停止'); }
    if (!text && errors.length) {
      task.status = 'error'; task.waitingFor = agent.id;
      const msg = agent.name + ' 執行出錯：' + short(errors[0].text, 300);
      log(task, { type: 'error', agent: agent.id, text: msg });
      return changed(task, 'error', msg + '\n回覆內容會交給 ' + agent.name + ' 重試，或停止任務。');
    }
    if (ctx.harness && text) ctx.harness.collect(agent, text, task.id);
    const ho = parseHandoff(text);
    if (st && !st.next.length && text && !/[?？]\s*$/.test(text.trim())) { // 最後階段：寫完總結就完成（結尾是問句則視為在問使用者）
      return withChecks(task, agent, st, () => {
        task.status = 'done'; task.summary = text;
        log(task, { type: 'done', agent: agent.id });
        if (ctx.harness) { try { ctx.harness.addMemory('result', '任務 #' + task.id + '「' + task.title + '」完成：' + short(text, 400), agent.id, task.id, teamOf(task).id); } catch {} }
        changed(task, 'done', text);
      });
    }
    // 預算：任務總時間
    const minutes = Number(hcfg().maxTaskMinutes) || 0;
    if (minutes > 0 && Date.now() - task.createdAt - (task.pausedMs || 0) > minutes * 60000 * (1 + (task.extraBudget || 0))) {
      return overBudget(task, agent, '任務已經進行超過 ' + minutes + ' 分鐘的時間預算');
    }
    if (!ho || !st || /使用者|^你$/.test(ho.to)) {
      task.status = 'waiting_user'; task.waitingFor = agent.id;
      log(task, { type: 'wait', agent: agent.id, text: short(text, 300) });
      return changed(task, 'waiting_user', agent.name + '：' + short(text, 600));
    }
    const nexts = st.next.map(stage).filter(Boolean);
    const target = nexts.find((s) => ho.to.includes(s.name)) ||
      nexts.find((s) => s.owner && ho.to.includes(name(s.owner))) || (nexts.length === 1 && !ho.to ? nexts[0] : null);
    if (task.turns >= maxTurns(task)) {
      task.status = 'waiting_user'; task.waitingFor = agent.id;
      log(task, { type: 'limit' });
      return changed(task, 'waiting_user', '已達每件任務的交接上限（' + maxTurns(task) + ' 次），請你決定下一步。');
    }
    if (!target || !target.owner || !ctx.agentById(target.owner)) {
      const allowed = nexts.map((s) => name(s.owner) + '（' + s.name + '）').join('、') || '（無）';
      log(task, { type: 'reject_target', agent: agent.id, text: ho.to });
      changed(task);
      return ctx.dispatch(agent, '交接對象不符合流程：「' + st.name + '」階段只能交給 ' + allowed + '。請重新寫交接區塊。',
        { taskId: task.id, stageId: st.id, system: true });
    }
    withChecks(task, agent, st, (checks) => {
      const pend = { from: agent.id, fromStage: st.id, toStage: target.id, content: ho.content || text, changes: task.stageChanges, ts: Date.now(),
        checks: checks && checks.length ? ctx.harness.checksText(checks) : '' };
      const nextAgent = ctx.agentById(target.owner);
      const writableNext = nextAgent && (nextAgent.sandbox === 'workspace-write' ||
        nextAgent.permissionMode === 'acceptEdits' || nextAgent.permissionMode === 'auto');
      // 團隊設定「交給可寫入的成員一律要核准」打開時，才對每次寫入型交接要求核准（預設只在 🔒 階段核准）
      const strict = typeof teamOf(task).approveWritableHandoffs === 'boolean' ? teamOf(task).approveWritableHandoffs : ctx.CONFIG.approveWritableHandoffs === true;
      if (st.approval || (strict && writableNext)) {
        task.status = 'awaiting_approval'; task.pending = pend;
        log(task, { type: 'awaiting', from: agent.id, to: target.owner, stage: target.id });
        return changed(task, 'awaiting_approval', agent.name + ' 完成「' + st.name + '」，要交給 ' + name(target.owner) +
          '（' + target.name + '）。\n\n' + short(pend.content, 1200));
      }
      transition(task, pend);
    });
  }

  const hcfg = () => (ctx.harness ? ctx.harness.cfg() : { maxReworks: 3, maxTaskMinutes: 0 });
  // 超出預算：暫停，交給使用者決定（Agentic Loop 的「轉交人類」）
  function overBudget(task, agent, why) {
    task.status = 'waiting_user'; task.waitingFor = agent ? agent.id : task.waitingFor;
    task.note = why + '，已暫停。回覆會讓它繼續（並多給一次預算），或停止任務。'; task.budgetHold = true;
    log(task, { type: 'budget', agent: agent && agent.id, text: why });
    if (ctx.harness) ctx.harness.record({ type: 'budget', agent: agent && agent.id, taskId: task.id, stage: task.stageId, text: why });
    return changed(task, 'budget', '⏸ ' + why + '，任務暫停，請你決定下一步。');
  }

  // 自動檢查（Sensors）：階段要交出時執行，全部通過才繼續；沒通過就退回同一位成員修正
  function withChecks(task, agent, st, proceed) {
    const checks = (st && st.checks) || [];
    if (!checks.length || !ctx.harness) return proceed(null);
    task.checking = { stageId: st.id, agent: agent.id, startedAt: Date.now() };
    log(task, { type: 'checking', agent: agent.id, stage: st.id });
    changed(task, 'checking', '🧪 ' + agent.name + ' 完成「' + st.name + '」，正在執行自動檢查（' + checks.length + ' 項）');
    ctx.harness.runChecks(agent, checks, task.id, (results) => {
      task.checking = null;
      if (!ACTIVE.includes(task.status) || task.stageId !== st.id) return changed(task);
      const failed = results.filter((r) => !r.ok);
      for (const r of results) ctx.harness.record({ type: 'sensor', agent: agent.id, taskId: task.id, stage: st.id, name: r.name || r.command, ok: r.ok, ms: r.ms, code: r.code });
      log(task, { type: 'checks', agent: agent.id, stage: st.id, ok: !failed.length, text: ctx.harness.checksText(results) });
      if (!failed.length) return proceed(results);
      task.checkFails = task.checkFails || {};
      const n = task.checkFails[st.id] = (task.checkFails[st.id] || 0) + 1;
      const max = (Number(hcfg().maxReworks) || 3) + (task.extraBudget || 0);
      if (n > max) return overBudget(task, agent, '「' + st.name + '」的自動檢查已經連續失敗 ' + n + ' 次（上限 ' + max + ' 次）');
      changed(task, 'checks_failed', '❌ 自動檢查沒通過（第 ' + n + ' 次），退回給 ' + agent.name + ' 修正：\n' + ctx.harness.checksText(results));
      const detail = failed.map((r) => '### ' + (r.name || r.command) + '\n指令：' + r.command + '\n' +
        (r.timedOut ? '結果：超過時間上限，被強制停止' : '結束碼：' + r.code) + '\n輸出（最後一段）：\n```\n' + (r.output || '（沒有輸出）') + '\n```').join('\n\n');
      ctx.dispatch(agent, '【自動檢查沒通過（第 ' + n + ' 次，上限 ' + max + ' 次）】你的交接還沒有送出。\n\n' + detail +
        '\n\n請找出原因並修正，自己重新執行確認通過後，再寫一次交接區塊（最後階段則重新寫總結）。如果這是以後應該避免的錯誤，加一行【守則建議】。',
      { taskId: task.id, stageId: st.id, system: true });
    });
  }

  function transition(task, pend, note) {
    const stage = (id) => stageIn(task, id);
    const to = stage(pend.toStage), from = ctx.agentById(pend.from), owner = ctx.agentById(to.owner);
    // 預算：同一個階段被退回重做的次數
    task.visits = task.visits || {};
    const visits = task.visits[to.id] = (task.visits[to.id] || 0) + 1;
    const max = (Number(hcfg().maxReworks) || 3) + (task.extraBudget || 0);
    if (visits > max + 1) {
      task.visits[to.id]--;
      task.pending = null;
      return overBudget(task, from, '「' + to.name + '」已經重做 ' + (visits - 1) + ' 次（上限 ' + max + ' 次），可能卡在同一個問題');
    }
    task.stageId = to.id; task.status = 'running'; task.pending = null; task.waitingFor = null; task.stageChanges = [];
    if (task.checkFails) delete task.checkFails[pend.fromStage];
    log(task, { type: 'handoff', from: pend.from, fromStage: pend.fromStage, to: to.owner, toStage: to.id, text: pend.content, changes: pend.changes, checks: pend.checks || '' });
    changed(task, 'handoff', (from ? from.name : '') + ' → ' + owner.name + '（' + to.name + '）' + (visits > 1 ? '｜第 ' + visits + ' 次' : ''));
    const msg = '【交接：' + (from ? from.name : '使用者') + '（' + ((stage(pend.fromStage) || {}).name || '') + '）→ 你（' + to.name + '）】\n' +
      pend.content + (note ? '\n\n【使用者核准時的補充】\n' + note : '') +
      (pend.checks ? '\n\n【系統附註：交出前的自動檢查】\n' + pend.checks : '') +
      '\n\n【系統附註：上一個階段實際變更的檔案】\n' + changesText(pend.changes) +
      (visits > 1 ? '\n\n【系統附註】這個階段第 ' + visits + ' 次被交回給你（上限 ' + (max + 1) + ' 次）。' : '');
    ctx.dispatch(owner, msg, { taskId: task.id, stageId: to.id, from: pend.from });
  }

  // 使用者插話中斷了某一輪：把那一輪的檔案變更記進這個階段，並記下插話內容
  function noteInterrupt(agent, opts, before, text) {
    const task = get(opts.taskId);
    if (!task || !ACTIVE.includes(task.status)) return;
    const changes = before ? diffSnapshots(before, snapshot(rootsFor(agent))) : [];
    task.stageChanges = mergeChanges(task.stageChanges, changes);
    log(task, { type: 'interject', to: agent.id, text: short(text, 300) });
    changed(task);
  }
  // 不中斷：加入任務指示，之後每位成員的每一輪都會看到
  function addNote(id, text, via) {
    const t = need(id, ACTIVE);
    t.notes = t.notes || [];
    t.notes.push({ ts: Date.now(), text: String(text).trim().slice(0, 2000), via });
    log(t, { type: 'note', text: short(text, 300) });
    changed(t, 'note', '📌 已加入任務指示：' + short(text, 200));
    return t;
  }

  // ---------- 使用者操作 ----------
  function start(goal, via, teamId) {
    goal = String(goal || '').trim();
    if (!goal) throw new Error('請輸入任務目標');
    const team = (teamId && ctx.teamById(teamId)) || teams()[0];
    if (teamId && team.id !== teamId) throw new Error('找不到這個小組');
    const cur = activeOf(team.id);
    if (cur) throw new Error(team.name + ' 已經有進行中的任務 #' + cur.id + '，請先完成或停止（不同小組可以同時進行）');
    const first = team.workflow.stages[0];
    if (!first) throw new Error('「' + team.name + '」還沒有定義工作流程，請到「⚙️ 工作流程」新增階段');
    const owner = ctx.agentById(first.owner);
    if (!owner) throw new Error('「' + first.name + '」階段還沒有指定負責成員');
    const task = {
      id: ++store.seq, title: short(goal.split('\n')[0], 40), goal, status: 'running', stageId: first.id, teamId: team.id,
      workspace: owner.cwd, createdAt: Date.now(), turns: 0, log: [{ ts: Date.now(), type: 'start', via }],
      visits: { [first.id]: 1 },
    };
    store.tasks.push(task);
    writeWorkflowDocs();
    changed(task, 'started', '任務 #' + task.id + '（' + team.name + '）開始：' + task.title + '\n交給 ' + owner.name + '（' + first.name + '）');
    ctx.dispatch(owner, goal, { taskId: task.id, stageId: first.id, via });
    return task;
  }
  function need(id, statuses) {
    const t = get(id);
    if (!t) throw new Error('找不到任務 #' + id);
    if (statuses && !statuses.includes(t.status)) throw new Error('任務 #' + t.id + ' 目前是「' + STATUS_TEXT[t.status] + '」');
    return t;
  }
  function approve(id, note) {
    const t = need(id, ['awaiting_approval']);
    log(t, { type: 'approved', text: note || '' });
    transition(t, t.pending, note);
    return t;
  }
  function reject(id, feedback) {
    const t = need(id, ['awaiting_approval']);
    feedback = String(feedback || '').trim() || '請修改後重新交接。';
    const p = t.pending, back = ctx.agentById(p.from);
    t.status = 'running'; t.pending = null; t.stageId = p.fromStage;
    log(t, { type: 'rejected', text: feedback });
    // 使用者的退回意見是「失敗經驗」：放進守則建議，由使用者決定要不要變成永久守則
    if (ctx.harness && feedback !== '請修改後重新交接。') ctx.harness.propose(feedback, null, t.id, '使用者退回 ' + back.name + ' 的交接', back.id); // 預設只給被退回的成員
    changed(t, 'rejected', '已退回給 ' + back.name);
    ctx.dispatch(back, '【使用者退回你的交接】\n' + feedback + '\n\n請依照意見修改，完成後重新寫交接區塊。', { taskId: t.id, stageId: p.fromStage });
    return t;
  }
  function reply(id, text, via) {
    const t = need(id, ['waiting_user', 'error']);
    const who = ctx.agentById(t.waitingFor) || ctx.agentById((stageIn(t, t.stageId) || {}).owner);
    if (!who) throw new Error('找不到要回覆的成員');
    if (t.budgetHold) { t.budgetHold = false; t.extraBudget = (t.extraBudget || 0) + 1; }
    t.status = 'running'; t.waitingFor = null; t.note = null;
    log(t, { type: 'reply', to: who.id, text: short(text, 300) });
    changed(t);
    ctx.dispatch(who, String(text), { taskId: t.id, stageId: t.stageId, via });
    return t;
  }
  function stop(id) {
    const t = need(id, ACTIVE);
    t.status = 'stopped'; t.pending = null; t.checking = null;
    log(t, { type: 'stopped' });
    ctx.cancelTask(t.id);
    if (ctx.harness) ctx.harness.cancelChecks(t.id);
    changed(t, 'stopped', '任務 #' + t.id + ' 已停止');
    return t;
  }

  // ---------- 文件：TASK.md（任務狀態）與 WORKFLOW.md（流程定義）----------
  function taskMarkdown(t) {
    const w = wf(t), stage = (id) => stageIn(t, id), cur = stage(t.stageId);
    const doneStages = new Set(t.log.filter((e) => e.type === 'handoff').map((e) => e.fromStage));
    const L = ['# 任務 #' + t.id + '：' + t.title, '',
      '- 狀態：' + STATUS_TEXT[t.status] + (cur && ACTIVE.includes(t.status) ? '｜目前階段：' + cur.name + '（' + name(cur.owner) + '）' : ''),
      '- 小組：' + teamOf(t).name + '｜建立：' + fmt(t.createdAt) + '｜交接次數：' + (t.turns || 0), '', '## 目標', '', t.goal, '', '## 流程進度（' + w.name + '）', ''];
    for (const s of w.stages) {
      const mark = t.status === 'done' ? '✅' : s.id === t.stageId ? '▶' : doneStages.has(s.id) ? '✅' : '○';
      L.push('- ' + mark + ' ' + s.name + '（' + name(s.owner) + '）');
    }
    L.push('', '## 交接紀錄', '');
    for (const e of t.log) {
      if (e.type === 'handoff') {
        L.push('### ' + fmt(e.ts) + '　' + ((stage(e.fromStage) || {}).name || '') + ' → ' + ((stage(e.toStage) || {}).name || '') +
          '（' + name(e.from) + ' → ' + name(e.to) + '）', '', e.text || '', '', '**實際變更的檔案**', '', changesText(e.changes), '');
        if (e.checks) L.push('**自動檢查**', '', e.checks, '');
      } else if (e.type === 'approved') L.push('- ' + fmt(e.ts) + ' ✅ 使用者核准' + (e.text ? '：' + e.text : ''));
      else if (e.type === 'rejected') L.push('- ' + fmt(e.ts) + ' ↩️ 使用者退回：' + e.text);
      else if (e.type === 'reply') L.push('- ' + fmt(e.ts) + ' 💬 使用者回覆 ' + name(e.to) + '：' + e.text);
      else if (e.type === 'interject') L.push('- ' + fmt(e.ts) + ' ⚡ 使用者插話給 ' + name(e.to) + '：' + e.text);
      else if (e.type === 'note') L.push('- ' + fmt(e.ts) + ' 📌 使用者加入任務指示：' + e.text);
      else if (e.type === 'wait') L.push('- ' + fmt(e.ts) + ' ⏳ ' + name(e.agent) + ' 在等使用者：' + e.text);
      else if (e.type === 'error') L.push('- ' + fmt(e.ts) + ' ⚠️ ' + e.text);
      else if (e.type === 'checks') L.push('- ' + fmt(e.ts) + ' 🧪 自動檢查' + (e.ok ? '通過' : '沒通過') + '（' + name(e.agent) + '）：' + String(e.text || '').replace(/\n/g, '；'));
      else if (e.type === 'budget') L.push('- ' + fmt(e.ts) + ' ⏸ 超出預算：' + e.text);
      else if (e.type === 'done') L.push('- ' + fmt(e.ts) + ' 🎉 任務完成');
      else if (e.type === 'stopped') L.push('- ' + fmt(e.ts) + ' ⏹ 任務停止');
    }
    if (t.summary) L.push('', '## 最終總結', '', t.summary);
    return L.join('\n') + '\n';
  }
  function writeTaskFile(t) {
    try { fs.writeFileSync(path.join(t.workspace, taskDocName(t)), taskMarkdown(t)); } catch {}
    try { fs.mkdirSync(path.join(ctx.DATA_DIR, 'tasks'), { recursive: true }); fs.writeFileSync(path.join(ctx.DATA_DIR, 'tasks', 'task-' + t.id + '.md'), taskMarkdown(t)); } catch {}
  }
  function workflowMarkdown(team) {
    const w = team.workflow, stage = (id) => w.stages.find((s) => s.id === id);
    const L = ['# 工作流程：' + w.name + '（' + team.name + '）', '', '> 由 Agent Chat 的「⚙️ 工作流程」產生，請在網頁上修改。', '', '## 成員', ''];
    for (const a of teamMembers(team.id)) L.push('- ' + a.name + '：' + (a.role || '') + '（' + [a.engine, a.model || '預設模型', a.effort].filter(Boolean).join(' · ') + '）');
    L.push('', '## 階段', '');
    w.stages.forEach((s, i) => {
      L.push('### ' + (i + 1) + '. ' + s.name + '（負責：' + name(s.owner) + '）', '');
      if (s.goal) L.push('- 要做什麼：' + s.goal);
      if (s.deliverable) L.push('- 交付物：' + s.deliverable);
      L.push('- 完成後交給：' + (s.next.length ? s.next.map((n) => (stage(n) || {}).name).join('、') : '（最後階段，向使用者總結）'));
      if (s.approval) L.push('- 交出前需要使用者核准');
      if (s.checks && s.checks.length) L.push('- 自動檢查（全部通過才交出）：' + s.checks.map((c) => '`' + c.command + '`').join('、'));
      L.push('');
    });
    if (w.notes) L.push('## 其他規則', '', w.notes, '');
    L.push('## 交接格式', '', '```', '【交接】', '給：<下一位成員的名字>', '內容：<完成了什麼、相關檔案、對方要做什麼、驗收標準>', '```', '');
    return L.join('\n');
  }
  function writeWorkflowDocs() {
    // 每個小組寫進自己成員的工作資料夾；共用資料夾時第二個以後的小組寫 WORKFLOW-小組名.md
    for (const team of teams()) {
      const md = workflowMarkdown(team);
      for (const dir of new Set(teamMembers(team.id).map((a) => a.cwd))) {
        try { fs.writeFileSync(path.join(dir, docName(dir, team, 'WORKFLOW.md')), md); } catch {}
      }
    }
  }
  function workflowSaved(teamId) {
    try {
      fs.mkdirSync(HIST, { recursive: true });
      const d = new Date();
      const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
      const team = ctx.teamById(teamId) || teams()[0];
      fs.writeFileSync(path.join(HIST, 'workflow-' + team.id + '-' + stamp + '.json'), JSON.stringify(team.workflow, null, 2));
    } catch {}
    writeWorkflowDocs();
  }

  const summary = (t) => t && ({
    id: t.id, title: t.title, goal: t.goal, status: t.status, statusText: STATUS_TEXT[t.status], stageId: t.stageId,
    teamId: teamOf(t).id, teamName: teamOf(t).name,
    waitingFor: t.waitingFor || null, pending: t.pending || null, turns: t.turns || 0, note: t.note || null,
    createdAt: t.createdAt, updatedAt: t.updatedAt, notes: t.notes || [], checking: t.checking || null,
    visits: t.visits || {}, checkFails: t.checkFails || {}, extraBudget: t.extraBudget || 0,
    done: [...new Set(t.log.filter((e) => e.type === 'handoff').map((e) => e.fromStage))],
  });

  return {
    promptHeader, snapshotFor, onTurnDone, docName,
    // 唯讀成員的檢查：工作資料夾與所有額外資料夾一輪前後有沒有檔案被改
    snapshotAll: (agent) => snapshot([{ dir: agent.cwd, prefix: '' }, ...(agent.extraDirs || []).map((d) => ({ dir: d.path, prefix: '[' + path.basename(d.path) + ']' }))]),
    diffSnapshots,
    taskDocName: (id) => { const t = get(id); return t ? taskDocName(t) : 'TASK.md'; }, noteInterrupt, addNote, start, approve, reject, reply, stop, workflowSaved, writeWorkflowDocs,
    // 相容舊介面：active() 是最近更新的一件；actives() 是所有小組進行中的任務
    active: () => summary(actives().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]),
    actives: () => actives().map(summary),
    // 專案暫停的時間不算進任務的時間預算（teamId 空白 = 所有小組）
    addPausedTime: (ms, teamId) => { for (const t of actives()) if (!teamId || t.teamId === teamId) { t.pausedMs = (t.pausedMs || 0) + ms; } save(); },
    activeOf: (teamId) => summary(activeOf(teamId)),
    list: () => store.tasks.slice(-20).reverse().map(summary),
    detail: (id) => { const t = get(id); return t ? { task: summary(t), markdown: taskMarkdown(t) } : null; },
    STATUS_TEXT,
  };
};

exports.normalizeWorkflow = normalizeWorkflow;
exports.cleanWorkflow = cleanWorkflow;
exports.DEFAULT_STAGES = DEFAULT_STAGES;
