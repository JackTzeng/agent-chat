// 工作流程與任務：依照「流程定義」推動 PM → Coder → QA 等階段的交接
'use strict';
const fs = require('fs');
const path = require('path');

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
const SKIP_FILES = new Set(['TASK.md', 'WORKFLOW.md']);

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
    };
  });
  for (const s of stages) s.next = [...new Set(s.next)].filter((n) => n !== s.id && used.has(n));
  return { name: str(input.name, 40) || '團隊流程', notes: str(input.notes, 4000), stages };
}

// ---------- 工作資料夾快照：比對一輪前後實際改了哪些檔案 ----------
function snapshot(dir) {
  const files = new Map();
  let budget = 30 * 1024 * 1024, count = 0;
  (function walk(d, rel) {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (count > 3000) return;
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, r); continue; }
      if (!e.isFile() || (!rel && SKIP_FILES.has(e.name))) continue;
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
  })(dir, '');
  return files;
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
  for (const t of store.tasks) if (t.status === 'running') { t.status = 'waiting_user'; t.note = '伺服器重新啟動，任務暫停，請回覆讓它繼續或停止任務'; }

  const wf = () => ctx.CONFIG.workflow;
  const stage = (id) => wf().stages.find((s) => s.id === id);
  const name = (id) => (ctx.agentById(id) || {}).name || '（未指定）';
  const get = (id) => store.tasks.find((t) => t.id === Number(id));
  const active = () => store.tasks.find((t) => ACTIVE.includes(t.status));
  const maxTurns = () => Number(ctx.CONFIG.maxRelayHops) || 12;

  function changed(task, event, message) {
    task.updatedAt = Date.now();
    save(); writeTaskFile(task);
    ctx.broadcast({ agentId: '*', kind: 'task', taskId: task.id });
    if (event) ctx.hooks.emit('task', { task, event, message, statusText: STATUS_TEXT[task.status] });
  }
  function log(task, entry) { task.log.push({ ts: Date.now(), ...entry }); }

  // ---------- 每一輪送給成員的說明（身分、流程、目前階段、交接方式）----------
  function promptHeader(agent, opts) {
    const task = get(opts.taskId), w = wf(), st = stage(opts.stageId);
    const lines = [];
    lines.push('【你的身分】你是「' + agent.name + '」' + (agent.role ? '，職責：' + agent.role : ''));
    if (agent.persona) lines.push(agent.persona);
    lines.push('', '【團隊成員】');
    for (const a of ctx.AGENTS) lines.push('- ' + a.name + '：' + (a.role || a.engine) + (a.id === agent.id ? '（就是你）' : ''));
    if (task) lines.push('', '【目前任務 #' + task.id + '】', task.goal);
    lines.push('', '【工作流程：' + w.name + '】');
    w.stages.forEach((s, i) => {
      const nx = s.next.map((n) => (stage(n) || {}).name).filter(Boolean);
      lines.push((i + 1) + '. ' + s.name + '（負責：' + name(s.owner) + '）：' + (s.goal || '') +
        (s.deliverable ? '｜交付物：' + s.deliverable : '') + '｜完成後交給：' + (nx.length ? nx.join(' 或 ') : '（最後階段）') +
        (s.approval ? '｜交出前需要使用者核准' : ''));
    });
    if (w.notes) lines.push('其他規則：' + w.notes);
    if (st) {
      lines.push('', '【你現在負責的階段：' + st.name + '】');
      if (st.goal) lines.push('要做什麼：' + st.goal);
      if (st.deliverable) lines.push('交付物：' + st.deliverable);
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
        '- 任務狀態與交接紀錄在 TASK.md（系統維護，可以讀，不要修改）。');
    }
    return lines.join('\n');
  }

  function snapshotFor(agent) { return snapshot(agent.cwd); }

  // ---------- 一輪結束：判斷要交接、等使用者、還是完成 ----------
  function onTurnDone(agent, run, opts, before) {
    const task = get(opts.taskId);
    if (!task || !ACTIVE.includes(task.status)) return;
    const changes = before ? diffSnapshots(before, snapshot(agent.cwd)) : [];
    const text = run.segments.filter((s) => s.type === 'text').map((s) => s.text).join('\n\n');
    const errors = run.segments.filter((s) => s.type === 'error');
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
    const ho = parseHandoff(text);
    if (st && !st.next.length && text && !/[?？]\s*$/.test(text.trim())) { // 最後階段：寫完總結就完成（結尾是問句則視為在問使用者）
      task.status = 'done'; task.summary = text;
      log(task, { type: 'done', agent: agent.id });
      return changed(task, 'done', text);
    }
    if (!ho || !st || /使用者|^你$/.test(ho.to)) {
      task.status = 'waiting_user'; task.waitingFor = agent.id;
      log(task, { type: 'wait', agent: agent.id, text: short(text, 300) });
      return changed(task, 'waiting_user', agent.name + '：' + short(text, 600));
    }
    const nexts = st.next.map(stage).filter(Boolean);
    const target = nexts.find((s) => ho.to.includes(s.name)) ||
      nexts.find((s) => s.owner && ho.to.includes(name(s.owner))) || (nexts.length === 1 && !ho.to ? nexts[0] : null);
    if (task.turns >= maxTurns()) {
      task.status = 'waiting_user'; task.waitingFor = agent.id;
      log(task, { type: 'limit' });
      return changed(task, 'waiting_user', '已達每件任務的交接上限（' + maxTurns() + ' 次），請你決定下一步。');
    }
    if (!target || !target.owner || !ctx.agentById(target.owner)) {
      const allowed = nexts.map((s) => name(s.owner) + '（' + s.name + '）').join('、') || '（無）';
      log(task, { type: 'reject_target', agent: agent.id, text: ho.to });
      changed(task);
      return ctx.dispatch(agent, '交接對象不符合流程：「' + st.name + '」階段只能交給 ' + allowed + '。請重新寫交接區塊。',
        { taskId: task.id, stageId: st.id, system: true });
    }
    const pend = { from: agent.id, fromStage: st.id, toStage: target.id, content: ho.content || text, changes: task.stageChanges, ts: Date.now() };
    if (st.approval) {
      task.status = 'awaiting_approval'; task.pending = pend;
      log(task, { type: 'awaiting', from: agent.id, to: target.owner, stage: target.id });
      return changed(task, 'awaiting_approval', agent.name + ' 完成「' + st.name + '」，要交給 ' + name(target.owner) +
        '（' + target.name + '）。\n\n' + short(pend.content, 1200));
    }
    transition(task, pend);
  }

  function transition(task, pend, note) {
    const to = stage(pend.toStage), from = ctx.agentById(pend.from), owner = ctx.agentById(to.owner);
    task.stageId = to.id; task.status = 'running'; task.pending = null; task.waitingFor = null; task.stageChanges = [];
    log(task, { type: 'handoff', from: pend.from, fromStage: pend.fromStage, to: to.owner, toStage: to.id, text: pend.content, changes: pend.changes });
    changed(task, 'handoff', (from ? from.name : '') + ' → ' + owner.name + '（' + to.name + '）');
    const msg = '【交接：' + (from ? from.name : '使用者') + '（' + ((stage(pend.fromStage) || {}).name || '') + '）→ 你（' + to.name + '）】\n' +
      pend.content + (note ? '\n\n【使用者核准時的補充】\n' + note : '') +
      '\n\n【系統附註：上一個階段實際變更的檔案】\n' + changesText(pend.changes);
    ctx.dispatch(owner, msg, { taskId: task.id, stageId: to.id, from: pend.from });
  }

  // ---------- 使用者操作 ----------
  function start(goal, via) {
    goal = String(goal || '').trim();
    if (!goal) throw new Error('請輸入任務目標');
    const cur = active();
    if (cur) throw new Error('已經有進行中的任務 #' + cur.id + '，請先完成或停止');
    const first = wf().stages[0];
    if (!first) throw new Error('還沒有定義工作流程，請到「全員 → 團隊設定」新增階段');
    const owner = ctx.agentById(first.owner);
    if (!owner) throw new Error('「' + first.name + '」階段還沒有指定負責成員');
    const task = {
      id: ++store.seq, title: short(goal.split('\n')[0], 40), goal, status: 'running', stageId: first.id,
      workspace: owner.cwd, createdAt: Date.now(), turns: 0, log: [{ ts: Date.now(), type: 'start', via }],
    };
    store.tasks.push(task);
    writeWorkflowDocs();
    changed(task, 'started', '任務 #' + task.id + ' 開始：' + task.title + '\n交給 ' + owner.name + '（' + first.name + '）');
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
    changed(t, 'rejected', '已退回給 ' + back.name);
    ctx.dispatch(back, '【使用者退回你的交接】\n' + feedback + '\n\n請依照意見修改，完成後重新寫交接區塊。', { taskId: t.id, stageId: p.fromStage });
    return t;
  }
  function reply(id, text, via) {
    const t = need(id, ['waiting_user', 'error']);
    const who = ctx.agentById(t.waitingFor) || ctx.agentById((stage(t.stageId) || {}).owner);
    if (!who) throw new Error('找不到要回覆的成員');
    t.status = 'running'; t.waitingFor = null; t.note = null;
    log(t, { type: 'reply', to: who.id, text: short(text, 300) });
    changed(t);
    ctx.dispatch(who, String(text), { taskId: t.id, stageId: t.stageId, via });
    return t;
  }
  function stop(id) {
    const t = need(id, ACTIVE);
    t.status = 'stopped'; t.pending = null;
    log(t, { type: 'stopped' });
    ctx.cancelTask(t.id);
    changed(t, 'stopped', '任務 #' + t.id + ' 已停止');
    return t;
  }

  // ---------- 文件：TASK.md（任務狀態）與 WORKFLOW.md（流程定義）----------
  function taskMarkdown(t) {
    const w = wf(), cur = stage(t.stageId);
    const doneStages = new Set(t.log.filter((e) => e.type === 'handoff').map((e) => e.fromStage));
    const L = ['# 任務 #' + t.id + '：' + t.title, '',
      '- 狀態：' + STATUS_TEXT[t.status] + (cur && ACTIVE.includes(t.status) ? '｜目前階段：' + cur.name + '（' + name(cur.owner) + '）' : ''),
      '- 建立：' + fmt(t.createdAt) + '｜交接次數：' + (t.turns || 0), '', '## 目標', '', t.goal, '', '## 流程進度（' + w.name + '）', ''];
    for (const s of w.stages) {
      const mark = t.status === 'done' ? '✅' : s.id === t.stageId ? '▶' : doneStages.has(s.id) ? '✅' : '○';
      L.push('- ' + mark + ' ' + s.name + '（' + name(s.owner) + '）');
    }
    L.push('', '## 交接紀錄', '');
    for (const e of t.log) {
      if (e.type === 'handoff') {
        L.push('### ' + fmt(e.ts) + '　' + ((stage(e.fromStage) || {}).name || '') + ' → ' + ((stage(e.toStage) || {}).name || '') +
          '（' + name(e.from) + ' → ' + name(e.to) + '）', '', e.text || '', '', '**實際變更的檔案**', '', changesText(e.changes), '');
      } else if (e.type === 'approved') L.push('- ' + fmt(e.ts) + ' ✅ 使用者核准' + (e.text ? '：' + e.text : ''));
      else if (e.type === 'rejected') L.push('- ' + fmt(e.ts) + ' ↩️ 使用者退回：' + e.text);
      else if (e.type === 'reply') L.push('- ' + fmt(e.ts) + ' 💬 使用者回覆 ' + name(e.to) + '：' + e.text);
      else if (e.type === 'wait') L.push('- ' + fmt(e.ts) + ' ⏳ ' + name(e.agent) + ' 在等使用者：' + e.text);
      else if (e.type === 'error') L.push('- ' + fmt(e.ts) + ' ⚠️ ' + e.text);
      else if (e.type === 'done') L.push('- ' + fmt(e.ts) + ' 🎉 任務完成');
      else if (e.type === 'stopped') L.push('- ' + fmt(e.ts) + ' ⏹ 任務停止');
    }
    if (t.summary) L.push('', '## 最終總結', '', t.summary);
    return L.join('\n') + '\n';
  }
  function writeTaskFile(t) {
    try { fs.writeFileSync(path.join(t.workspace, 'TASK.md'), taskMarkdown(t)); } catch {}
    try { fs.mkdirSync(path.join(ctx.DATA_DIR, 'tasks'), { recursive: true }); fs.writeFileSync(path.join(ctx.DATA_DIR, 'tasks', 'task-' + t.id + '.md'), taskMarkdown(t)); } catch {}
  }
  function workflowMarkdown() {
    const w = wf();
    const L = ['# 工作流程：' + w.name, '', '> 由 Agent Chat 的「團隊設定」產生，請在網頁上修改。', '', '## 成員', ''];
    for (const a of ctx.AGENTS) L.push('- ' + a.name + '：' + (a.role || '') + '（' + [a.engine, a.model || '預設模型', a.effort].filter(Boolean).join(' · ') + '）');
    L.push('', '## 階段', '');
    w.stages.forEach((s, i) => {
      L.push('### ' + (i + 1) + '. ' + s.name + '（負責：' + name(s.owner) + '）', '');
      if (s.goal) L.push('- 要做什麼：' + s.goal);
      if (s.deliverable) L.push('- 交付物：' + s.deliverable);
      L.push('- 完成後交給：' + (s.next.length ? s.next.map((n) => (stage(n) || {}).name).join('、') : '（最後階段，向使用者總結）'));
      if (s.approval) L.push('- 交出前需要使用者核准');
      L.push('');
    });
    if (w.notes) L.push('## 其他規則', '', w.notes, '');
    L.push('## 交接格式', '', '```', '【交接】', '給：<下一位成員的名字>', '內容：<完成了什麼、相關檔案、對方要做什麼、驗收標準>', '```', '');
    return L.join('\n');
  }
  function writeWorkflowDocs() {
    const md = workflowMarkdown();
    for (const dir of new Set(ctx.AGENTS.map((a) => a.cwd))) { try { fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), md); } catch {} }
  }
  function workflowSaved() {
    try {
      fs.mkdirSync(HIST, { recursive: true });
      const d = new Date();
      const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
      fs.writeFileSync(path.join(HIST, 'workflow-' + stamp + '.json'), JSON.stringify(wf(), null, 2));
    } catch {}
    writeWorkflowDocs();
  }

  const summary = (t) => t && ({
    id: t.id, title: t.title, goal: t.goal, status: t.status, statusText: STATUS_TEXT[t.status], stageId: t.stageId,
    waitingFor: t.waitingFor || null, pending: t.pending || null, turns: t.turns || 0, note: t.note || null,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    done: [...new Set(t.log.filter((e) => e.type === 'handoff').map((e) => e.fromStage))],
  });

  return {
    promptHeader, snapshotFor, onTurnDone, start, approve, reject, reply, stop, workflowSaved, writeWorkflowDocs,
    active: () => summary(active()),
    list: () => store.tasks.slice(-20).reverse().map(summary),
    detail: (id) => { const t = get(id); return t ? { task: summary(t), markdown: taskMarkdown(t) } : null; },
    STATUS_TEXT,
  };
};

exports.normalizeWorkflow = normalizeWorkflow;
exports.cleanWorkflow = cleanWorkflow;
exports.DEFAULT_STAGES = DEFAULT_STAGES;
