// Agent Chat — 把 Claude Code 與 Codex CLI 包成聊天介面
// 不需要 npm install，只要 Node.js 18 以上。啟動：node server.js
'use strict';
const VERSION = '1.5.0';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const EventEmitter = require('events');
const hooks = new EventEmitter(); // 給 Telegram 等外掛監聽：user / done

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.ACCESS_TOKEN || '';
const IS_WIN = process.platform === 'win32';
// 找出 CLI 的實際位置。Windows 上常見的問題是：剛裝好的指令還沒進到檔案總管的 PATH，
// 所以除了 PATH 之外，也直接去常見安裝位置找。
function resolveBin(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  if (!IS_WIN) return name;
  try {
    const found = execFileSync('where', [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const pick = found.find((f) => /\.(exe|cmd)$/i.test(f));
    if (pick) return pick;
  } catch {}
  const home = process.env.USERPROFILE || '';
  const appdata = process.env.APPDATA || '';
  const candidates = [
    path.join(home, '.local', 'bin', name + '.exe'), // Claude Code 官方安裝程式
    path.join(appdata, 'npm', name + '.cmd'),        // npm i -g 安裝（預設位置）
    path.join(path.dirname(process.execPath), name + '.cmd'), // npm 全域裝在 Node.js 資料夾
    path.join(process.env.LOCALAPPDATA || '', 'Programs', name, name + '.exe'),
  ];
  // 直接問 npm 全域套件裝在哪
  try {
    const prefix = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm prefix -g'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
    if (prefix) candidates.push(path.join(prefix, name + '.cmd'));
  } catch {}
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}
const BIN = {
  claude: resolveBin('claude', 'CLAUDE_BIN'),
  codex: resolveBin('codex', 'CODEX_BIN'),
};
// 之前沒找到的話，每次送訊息時再找一次（裝好後不必重啟伺服器）
function getBin(engine) {
  if (!BIN[engine]) BIN[engine] = resolveBin(engine, engine.toUpperCase() + '_BIN');
  return BIN[engine];
}

// Windows 的錯誤訊息常是 Big5（cp950），不是 UTF-8，要正確解碼才不會變亂碼
function decodeOutput(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('big5').decode(buf); } catch {}
  return buf.toString('latin1');
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];
if (!LOCAL_HOSTS.includes(HOST) && !TOKEN) {
  console.error('⚠️  對外開放（HOST=' + HOST + '）時必須設定 ACCESS_TOKEN，否則任何連得到的人都能操作你的電腦。');
  process.exit(1);
}

// ---------- 設定與資料 ----------
const DATA_DIR = path.join(ROOT, 'data');
const HIST_DIR = path.join(DATA_DIR, 'history');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars'); // 自訂頭像圖片
fs.mkdirSync(HIST_DIR, { recursive: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });

// agents.json 是你自己的設定（不進 git）；第一次啟動時從範本複製一份
const AGENTS_FILE = path.join(ROOT, 'agents.json');
if (!fs.existsSync(AGENTS_FILE)) fs.copyFileSync(path.join(ROOT, 'agents.example.json'), AGENTS_FILE);
const CONFIG = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
const maxHops = () => Number(CONFIG.maxRelayHops) || 12; // agent 之間自動轉交的上限
const prepAgent = (a) => {
  const cwd = path.resolve(ROOT, a.cwd || './workspace');
  fs.mkdirSync(cwd, { recursive: true });
  return { ...a, cwd };
};
// AGENTS 是執行中使用的清單（cwd 已轉成完整路徑）；CONFIG.agents 是原始設定。
// 修改時就地更新陣列，其他模組（Telegram）拿到的參照才會跟著變。
const AGENTS = CONFIG.agents.map(prepAgent);
function reloadAgents() {
  AGENTS.splice(0, AGENTS.length, ...CONFIG.agents.map(prepAgent));
}
function saveConfig() {
  const tmp = AGENTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(CONFIG, null, 2));
  fs.renameSync(tmp, AGENTS_FILE);
}
const agentById = (id) => AGENTS.find((a) => a.id === id);

let state = { sessions: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const histFile = (id) => path.join(HIST_DIR, id + '.json');
function loadHistory(id) {
  try { return JSON.parse(fs.readFileSync(histFile(id), 'utf8')); } catch { return []; }
}
function appendHistory(id, msg) {
  const h = loadHistory(id);
  h.push(msg);
  fs.writeFileSync(histFile(id), JSON.stringify(h, null, 2));
}

// ---------- SSE：把事件推給所有開著的頁面（電腦、手機同步）----------
const clients = new Set();
function broadcast(ev) {
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const res of clients) res.write(line);
}

// ---------- 執行 CLI ----------
const runs = new Map(); // agentId -> { proc, segments }

const queues = new Map(); // agentId -> 等待中的轉交訊息

// 這位成員可以 @ 誰：有設定 canHandoffTo 就照設定，沒設定就是全部同事
function allowedTargets(agent) {
  const others = AGENTS.filter((a) => a.id !== agent.id);
  return Array.isArray(agent.canHandoffTo) ? others.filter((a) => agent.canHandoffTo.includes(a.id)) : others;
}

function teamHint(agent) {
  let s = '（介面說明：使用者透過聊天介面或 Telegram 跟你對話，回覆會以 Markdown 顯示。' +
    '若你產生了圖片或影片檔，請在回覆中用 ![說明](相對路徑) 顯示它。）';
  const others = AGENTS.filter((a) => a.id !== agent.id);
  if (!others.length) return s;
  s += '\n\n【團隊成員】\n' + AGENTS.map((m) => '- ' + m.name + '：' + (m.role || m.engine) + (m.id === agent.id ? '（就是你）' : '')).join('\n');
  if (CONFIG.workflow) s += '\n\n【工作流程】\n' + CONFIG.workflow;
  const can = allowedTargets(agent);
  if (can.length) {
    s += '\n\n【交接規則】你可以交接給：' + can.map((m) => m.name).join('、') + '。' +
      '\n交接方式：在回覆中寫「@名字」加上要交代的事，系統會自動把你這則回覆轉給對方，對方的回覆也會自動轉給被 @ 的人。' +
      '\n你們在同一台電腦上工作，交接時寫清楚檔案路徑與要做的事。只有真的要交接時才 @；你的部分完成且不需要再交接時，直接向使用者總結，不要 @ 任何人。';
  } else s += '\n\n【交接規則】你不能把工作交給其他成員，完成後直接向使用者回報。';
  return s;
}

function buildPrompt(agent, text, isNew, fromAgent, opts = {}) {
  let body;
  if (fromAgent) {
    body = '【來自同事 ' + fromAgent.name + ' 的訊息】\n' + text +
      '\n\n（要回覆對方請在回覆中寫 @' + fromAgent.name + '；事情處理完就直接向使用者總結，不要再 @ 對方。）';
  } else {
    let note = '';
    const ccOf = opts.cc && agentById(opts.cc);
    const ccTo = (opts.ccTo || []).map(agentById).filter(Boolean);
    if (ccOf) note = '（這則訊息使用者是交給 ' + ccOf.name + ' 的，並在訊息中 @ 了你，請依你的職責協助，需要時用 @' + ccOf.name + ' 跟對方協調。）\n';
    else if (ccTo.length) note = '（使用者同時把這則訊息交給了 ' + ccTo.map((a) => a.name).join('、') + '，需要時用 @名字 協調分工。）\n';
    body = (isNew ? '【使用者訊息】\n' : '') + note + text;
  }
  if (!isNew) return body;
  const persona = agent.persona ? '【你的角色設定】\n' + agent.persona + '\n\n' : '';
  return persona + teamHint(agent) + '\n\n' + body;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function findMentions(agent, text) {
  return allowedTargets(agent).filter((a) =>
    new RegExp('@\\s?(' + escRe(a.name) + '|' + escRe(a.id) + ')', 'i').test(text));
}

// 使用者的訊息裡 @ 了誰（不受 canHandoffTo 限制），就同時交給那位
function userMentions(agent, text) {
  return AGENTS.filter((a) => a.id !== agent.id &&
    new RegExp('@\\s?(' + escRe(a.name) + '|' + escRe(a.id) + ')', 'i').test(text));
}
function userSend(agent, text, via) {
  const cc = userMentions(agent, text);
  dispatch(agent, text, { via, ccTo: cc.map((a) => a.id) });
  for (const t of cc) dispatch(t, text, { via, cc: agent.id });
  return cc;
}

// 有空就馬上執行，忙碌中就排隊
function dispatch(agent, text, opts) {
  if (runs.has(agent.id)) {
    if (!queues.has(agent.id)) queues.set(agent.id, []);
    queues.get(agent.id).push({ text, opts });
    broadcast({ agentId: agent.id, kind: 'queued', count: queues.get(agent.id).length });
  } else startRun(agent, text, opts);
}

function buildCommand(agent, sid) {
  if (agent.engine === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (agent.permissionMode) args.push('--permission-mode', agent.permissionMode);
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('--effort', agent.effort);
    if (sid) args.push('--resume', sid);
    return { cmd: getBin('claude'), args };
  }
  if (agent.engine === 'codex') {
    const opts = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="' + (agent.sandbox || 'workspace-write') + '"'];
    if (agent.model) opts.push('-m', agent.model);
    if (agent.effort) opts.push('-c', 'model_reasoning_effort="' + agent.effort + '"');
    // 提示詞一律用 stdin 傳（"-"），避免 Windows 命令列的引號/換行問題
    const args = sid ? ['exec', 'resume', ...opts, sid, '-'] : ['exec', ...opts, '-'];
    return { cmd: getBin('codex'), args };
  }
  throw new Error('未知的 engine：' + agent.engine);
}

function short(s, n = 120) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Claude Code 工具呼叫 → 一行人看得懂的描述
function describeClaudeTool(b) {
  const i = b.input || {};
  switch (b.name) {
    case 'Bash': return '⚙️ 執行：' + short(i.command);
    case 'Read': return '📖 讀取：' + short(i.file_path);
    case 'Write': return '📝 建立：' + short(i.file_path);
    case 'Edit': case 'MultiEdit': return '📝 修改：' + short(i.file_path);
    case 'Glob': case 'Grep': return '🔎 搜尋：' + short(i.pattern);
    case 'WebSearch': return '🌐 搜尋網路：' + short(i.query);
    case 'WebFetch': return '🌐 讀取網頁：' + short(i.url);
    case 'TodoWrite': return '🗒️ 更新待辦清單';
    case 'Task': case 'Agent': return '🤖 派出子代理：' + short(i.description);
    default: return '🔧 ' + b.name;
  }
}

// 把各家 CLI 的 JSON 事件轉成統一格式：{kind:'text'|'tool'|'error'|'session'|'done', ...}
function parseClaude(ev, emit) {
  if (ev.type === 'rate_limit_event' && ev.rate_limit_info) { updateClaudeUsage(ev.rate_limit_info); return; }
  if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) emit({ kind: 'session', id: ev.session_id });
  else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'text' && b.text.trim()) emit({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use') emit({ kind: 'tool', text: describeClaudeTool(b) });
    }
  } else if (ev.type === 'result') {
    if (ev.session_id) emit({ kind: 'session', id: ev.session_id });
    if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) emit({ kind: 'error', text: ev.result || ev.subtype });
    // total_cost_usd 是「換算成 API 價格」的估計值；用訂閱帳號登入時不會真的收費
    const cost = typeof ev.total_cost_usd === 'number' ? '≈API價 US$' + ev.total_cost_usd.toFixed(2) : '';
    emit({ kind: 'done', meta: [cost, ev.duration_ms ? (ev.duration_ms / 1000).toFixed(1) + 's' : ''].filter(Boolean).join(' · ') });
  }
}

function parseCodex(ev, emit) {
  const it = ev.item || {};
  if (ev.type === 'thread.started' && ev.thread_id) emit({ kind: 'session', id: ev.thread_id });
  else if (ev.type === 'item.started' && it.type === 'command_execution') emit({ kind: 'tool', text: '⚙️ 執行：' + short(it.command) });
  else if (ev.type === 'item.completed') {
    if (it.type === 'agent_message' && it.text) emit({ kind: 'text', text: it.text });
    else if (it.type === 'file_change') emit({ kind: 'tool', text: '📝 修改：' + short((it.changes || []).map((c) => c.path).join(', ')) });
    else if (it.type === 'mcp_tool_call') emit({ kind: 'tool', text: '🔌 ' + it.server + '.' + it.tool });
    else if (it.type === 'web_search') emit({ kind: 'tool', text: '🌐 搜尋網路：' + short(it.query) });
    else if (it.type === 'command_execution' && it.exit_code) emit({ kind: 'tool', text: '⚠️ 指令結束碼 ' + it.exit_code });
    else if (it.type === 'error') emit({ kind: 'error', text: it.message });
  } else if (ev.type === 'turn.completed') {
    const u = ev.usage || {};
    emit({ kind: 'done', meta: u.input_tokens != null ? '輸入 ' + u.input_tokens + ' / 輸出 ' + u.output_tokens + ' tokens' : '' });
  } else if (ev.type === 'turn.failed') emit({ kind: 'error', text: (ev.error && ev.error.message) || '執行失敗' });
  else if (ev.type === 'error') {
    const msg = ev.message || '錯誤';
    emit({ kind: /^Reconnecting/i.test(msg) ? 'tool' : 'error', text: /^Reconnecting/i.test(msg) ? '🔄 ' + short(msg) : msg });
  }
}

function startRun(agent, userText, opts = {}) {
  const sid = state.sessions[agent.id];
  const { cmd, args } = buildCommand(agent, sid);
  const fromAgent = opts.from ? agentById(opts.from) : null;
  const hops = opts.hops || 0;
  const prompt = buildPrompt(agent, userText, !sid, fromAgent, opts);

  appendHistory(agent.id, { role: 'user', text: userText, from: opts.from, via: opts.via, cc: opts.cc, ts: Date.now() });
  broadcast({ agentId: agent.id, kind: 'user', text: userText, from: opts.from, via: opts.via, cc: opts.cc });
  hooks.emit('user', { agent, text: userText, from: opts.from, via: opts.via });

  const run = { segments: [], meta: '', finished: false, stderr: Buffer.alloc(0) };
  runs.set(agent.id, run);
  broadcast({ agentId: agent.id, kind: 'busy', busy: true });

  if (!cmd) {
    const how = agent.engine === 'claude'
      ? 'npm.cmd i -g @anthropic-ai/claude-code'
      : 'npm.cmd i -g @openai/codex';
    run.segments.push({ type: 'error', text: '找不到 ' + agent.engine + ' 指令。\n' +
      '還沒安裝的話，在 PowerShell 輸入：' + how + '\n' +
      '已經安裝了，請在 PowerShell 輸入「where.exe ' + agent.engine + '」，把顯示的路徑填進 start.bat 的 ' +
      agent.engine.toUpperCase() + '_BIN。' });
    broadcast({ agentId: agent.id, kind: 'segment', segment: run.segments[0] });
    appendHistory(agent.id, { role: 'assistant', segments: run.segments, meta: '', ts: Date.now() });
    runs.delete(agent.id);
    broadcast({ agentId: agent.id, kind: 'done', meta: '' });
    hooks.emit('done', { agent, segments: run.segments, meta: '', relayTo: [] });
    broadcast({ agentId: agent.id, kind: 'busy', busy: false });
    return;
  }

  // .exe 直接執行；.cmd（npm 安裝的）要透過 cmd.exe，路徑有空白時要加引號
  const needShell = IS_WIN && !/\.exe$/i.test(cmd);
  const spawnCmd = needShell && /\s/.test(cmd) ? '"' + cmd + '"' : cmd;
  const proc = spawn(spawnCmd, args, { cwd: agent.cwd, shell: needShell, env: process.env, windowsHide: true });
  run.proc = proc;

  const emit = (e) => {
    if (e.kind === 'session') {
      if (state.sessions[agent.id] !== e.id) { state.sessions[agent.id] = e.id; saveState(); }
      return;
    }
    if (e.kind === 'done') { run.meta = e.meta || ''; run.finished = true; return; }
    run.segments.push({ type: e.kind, text: e.text });
    broadcast({ agentId: agent.id, kind: 'segment', segment: { type: e.kind, text: e.text } });
  };
  const parse = agent.engine === 'claude' ? parseClaude : parseCodex;

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try { parse(JSON.parse(line), emit); } catch {}
    }
  });
  proc.stderr.on('data', (c) => { run.stderr = Buffer.concat([run.stderr, c]).subarray(-8000); });

  proc.on('error', (err) => {
    emit({ kind: 'error', text: '無法啟動「' + cmd + '」：' + err.message + '。請確認已安裝並在終端機能執行。' });
  });
  proc.on('close', (code) => {
    if (run.stopped) emit({ kind: 'error', text: '⏹ 已手動停止' });
    else if (code && !run.finished && !run.segments.some((s) => s.type === 'error')) {
      const tail = decodeOutput(run.stderr).trim().split(/\r?\n/).slice(-6).join('\n');
      emit({ kind: 'error', text: 'CLI 結束碼 ' + code + (tail ? '\n' + tail : '') });
    }
    if (agent.engine === 'codex') setTimeout(readCodexUsage, 500);
    // 回覆裡 @ 了同事 → 自動轉交
    const replyText = run.segments.filter((s) => s.type === 'text').map((s) => s.text).join('\n\n');
    const targets = run.stopped || !replyText ? [] : findMentions(agent, replyText);
    if (targets.length && hops >= maxHops()) {
      emit({ kind: 'tool', text: '⛔ 已達自動轉交上限（' + maxHops() + ' 次），沒有再轉給 ' +
        targets.map((t) => t.name).join('、') + '。需要的話請你手動接手。' });
    }

    appendHistory(agent.id, { role: 'assistant', segments: run.segments, meta: run.meta, ts: Date.now() });
    runs.delete(agent.id);
    broadcast({ agentId: agent.id, kind: 'done', meta: run.meta });
    broadcast({ agentId: agent.id, kind: 'busy', busy: false });
    hooks.emit('done', { agent, segments: run.segments, meta: run.meta, relayTo: hops < maxHops() ? targets : [] });

    if (hops < maxHops()) for (const t of targets) dispatch(t, replyText, { from: agent.id, hops: hops + 1 });

    // 處理排隊中的轉交訊息
    const q = queues.get(agent.id);
    if (q && q.length) { const next = q.shift(); startRun(agent, next.text, next.opts); }
  });

  proc.stdin.on('error', () => {});
  proc.stdin.end(prompt);
}

function stopRun(id) {
  queues.delete(id); // 停止時也取消排隊中的轉交
  const run = runs.get(id);
  if (!run || !run.proc) return false;
  run.stopped = true;
  if (IS_WIN) spawn('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], { windowsHide: true });
  else run.proc.kill('SIGTERM');
  return true;
}

function resetAgent(id) {
  if (runs.has(id)) return false;
  delete state.sessions[id]; saveState();
  try { fs.unlinkSync(histFile(id)); } catch {}
  broadcast({ agentId: id, kind: 'reset' });
  return true;
}


// ---------- 訂閱用量額度（5 小時 / 每週）----------
// Claude Code：執行時輸出的 rate_limit_event（utilization 是 0~1 的比例）
// Codex：每次執行寫進 ~/.codex/sessions/**/rollout-*.jsonl 的 rate_limits 快照
state.usage = state.usage || { claude: { windows: {} }, codex: { windows: {} } };
const USAGE = state.usage;

function claudeWindowKey(type) {
  return { five_hour: '5h', seven_day: 'week', seven_day_opus: 'week_opus', seven_day_sonnet: 'week_sonnet' }[type];
}
function updateClaudeUsage(info) {
  const w = USAGE.claude.windows;
  const put = (key, util, resetsAt, status) => {
    if (!key || !Number.isFinite(util)) return;
    w[key] = { pct: Math.round(util * 1000) / 10, resetsAt: resetsAt || null, status: status || null };
  };
  if (info.unifiedWindows) {
    for (const [type, v] of Object.entries(info.unifiedWindows)) if (v) put(claudeWindowKey(type), v.utilization, v.resetsAt, v.status);
  }
  if (info.rateLimitType) put(claudeWindowKey(info.rateLimitType), info.utilization, info.resetsAt, info.status);
  USAGE.claude.updatedAt = Date.now();
  if (info.status) USAGE.claude.status = info.status;
  saveState();
  broadcast({ agentId: '*', kind: 'usage' });
}

const CODEX_SESSIONS = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
function recentRolloutFiles(limit = 8) {
  const files = [];
  const listDesc = (dir) => { try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; } };
  outer: for (const y of listDesc(CODEX_SESSIONS)) for (const m of listDesc(path.join(CODEX_SESSIONS, y))) {
    for (const d of listDesc(path.join(CODEX_SESSIONS, y, m))) {
      const dir = path.join(CODEX_SESSIONS, y, m, d);
      for (const f of listDesc(dir)) if (/^rollout-.*\.jsonl$/.test(f)) {
        try { files.push({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }); } catch {}
      }
      if (files.length >= limit) break outer;
    }
  }
  return files.sort((a, b) => b.t - a.t).map((x) => x.f);
}
function findRateLimits(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.rate_limits && (o.rate_limits.primary || o.rate_limits.secondary)) return o.rate_limits;
  for (const v of Object.values(o)) { const r = findRateLimits(v); if (r) return r; }
  return null;
}
function readCodexUsage() {
  for (const file of recentRolloutFiles()) {
    let text;
    try {
      const st = fs.statSync(file), size = Math.min(st.size, 512 * 1024);
      const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, st.size - size); fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      let obj; try { obj = JSON.parse(lines[i]); } catch { continue; }
      const rl = findRateLimits(obj); if (!rl) continue;
      const ts = Date.parse(obj.timestamp) || fs.statSync(file).mtimeMs;
      const windows = {};
      for (const slot of ['primary', 'secondary']) {
        const v = rl[slot]; if (!v || !Number.isFinite(v.used_percent)) continue;
        const mins = v.window_minutes || (slot === 'primary' ? 300 : 10080);
        const resetsAt = v.resets_at || (v.resets_in_seconds != null ? Math.round(ts / 1000) + v.resets_in_seconds : null);
        windows[mins <= 360 ? '5h' : mins >= 10000 ? 'week' : slot] = { pct: Math.round(v.used_percent * 10) / 10, resetsAt, minutes: mins };
      }
      if (!Object.keys(windows).length) continue;
      if (USAGE.codex.updatedAt === ts) return false; // 沒有新資料
      USAGE.codex = { windows, updatedAt: ts, plan: rl.plan_type || null };
      saveState();
      broadcast({ agentId: '*', kind: 'usage' });
      return true;
    }
  }
  return false;
}

// 「🔄 查詢」：送一個極小的請求，讓 CLI 回報最新額度
function runQuiet(cmd, args, input, timeoutMs, onLine) {
  return new Promise((resolve) => {
    const cwd = path.join(DATA_DIR, 'probe'); fs.mkdirSync(cwd, { recursive: true });
    const needShell = IS_WIN && !/\.exe$/i.test(cmd);
    const proc = spawn(needShell && /\s/.test(cmd) ? '"' + cmd + '"' : cmd, args, { cwd, shell: needShell, windowsHide: true });
    let buf = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => {
      buf += c; let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (onLine) onLine(line); }
    });
    proc.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: e.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, err }); });
    proc.stdin.on('error', () => {}); proc.stdin.end(input);
  });
}
let probing = false;
async function probeUsage() {
  if (probing) return; probing = true;
  try {
    const tasks = [];
    if (getBin('claude')) tasks.push(runQuiet(getBin('claude'), ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'],
      'Reply with OK only.', 90000, (line) => {
        if (!line.includes('rate_limit_event')) return;
        try { const ev = JSON.parse(line); if (ev.rate_limit_info) updateClaudeUsage(ev.rate_limit_info); } catch {}
      }));
    if (getBin('codex')) tasks.push(runQuiet(getBin('codex'), ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"',
      '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', '-'], 'Reply with OK only.', 90000).then(() => readCodexUsage()));
    await Promise.all(tasks);
  } finally { probing = false; broadcast({ agentId: '*', kind: 'usage' }); }
}

function usageSnapshot() {
  readCodexUsage(); // Codex 在別處（例如終端機）用過也會更新
  return { claude: USAGE.claude, codex: USAGE.codex, probing, now: Date.now() };
}

// ---------- 成員設定（網頁上新增 / 編輯 / 刪除）----------
const ENGINES = ['claude', 'codex'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['plan', 'acceptEdits', 'auto', 'bypassPermissions'];
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

function cleanAgent(input, existingId) {
  const str = (v, max = 4000) => String(v ?? '').trim().slice(0, max);
  const a = {
    id: existingId,
    name: str(input.name, 30),
    avatar: str(input.avatar, 40) || '🤖',
    role: str(input.role, 60),
    engine: str(input.engine),
    model: str(input.model, 80),
    effort: str(input.effort),
    cwd: str(input.cwd, 300) || './workspace',
    persona: str(input.persona, 8000),
  };
  if (!a.name) throw new Error('請填名稱');
  if (a.avatar.startsWith('img:')) {
    if (!/^img:[\w-]+\.png$/.test(a.avatar) || !fs.existsSync(path.join(AVATAR_DIR, a.avatar.slice(4)))) throw new Error('頭像圖片不存在，請重新上傳');
  } else if ([...a.avatar].length > 8) throw new Error('頭像請用一個 emoji，或上傳圖片');
  if (/\s|@/.test(a.name)) throw new Error('名稱不能有空白或 @（同事要用 @名稱 呼叫）');
  const dup = AGENTS.find((x) => x.id !== existingId && x.name.toLowerCase() === a.name.toLowerCase());
  if (dup) throw new Error('已經有叫「' + a.name + '」的成員了');
  if (!ENGINES.includes(a.engine)) throw new Error('引擎只能是 claude 或 codex');
  if (!EFFORTS.includes(a.effort)) throw new Error('強度不正確');
  if (/[\s"'`$&|;<>]/.test(a.model)) throw new Error('模型名稱不能有空白或特殊符號');
  if (a.engine === 'claude') {
    a.permissionMode = PERMISSION_MODES.includes(input.permissionMode) ? input.permissionMode : 'auto';
  } else {
    a.sandbox = SANDBOXES.includes(input.sandbox) ? input.sandbox : 'workspace-write';
  }
  if (Array.isArray(input.canHandoffTo)) {
    a.canHandoffTo = input.canHandoffTo.filter((id) => id !== existingId && AGENTS.some((x) => x.id === id));
  }
  if (!a.model) delete a.model;
  if (!a.effort) delete a.effort;
  return a;
}

function newAgentId() {
  let id;
  do { id = 'a' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4); } while (agentById(id));
  return id;
}

const agentsChanged = () => broadcast({ agentId: '*', kind: 'agents-changed' });

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

const publicAgent = (a) => ({
  id: a.id, name: a.name, avatar: a.avatar, engine: a.engine, model: a.model || '', effort: a.effort || '', role: a.role || '',
  canHandoffTo: allowedTargets(a).map((t) => t.id),
  busy: runs.has(a.id), hasSession: !!state.sessions[a.id],
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // 靜態頁面不需要 token（頁面本身沒有資料），所有 /api 都要
  if (p.startsWith('/api/') && TOKEN) {
    const t = url.searchParams.get('token') || req.headers['x-token'];
    if (t !== TOKEN) return send(res, 401, { error: 'token 錯誤' });
  }

  let m0;
  try {
    if (p === '/api/info') return send(res, 200, { version: VERSION });
    if (p === '/api/agents' && req.method === 'GET') return send(res, 200, AGENTS.map(publicAgent));

    if (p === '/api/usage' && req.method === 'GET') return send(res, 200, usageSnapshot());
    if (p === '/api/usage/refresh' && req.method === 'POST') { probeUsage(); return send(res, 200, { ok: true }); }
    if (p === '/api/config' && req.method === 'GET') {
      return send(res, 200, {
        agents: CONFIG.agents, workflow: CONFIG.workflow || '', maxRelayHops: maxHops(),
        options: { engines: ENGINES, efforts: EFFORTS, permissionModes: PERMISSION_MODES, sandboxes: SANDBOXES },
      });
    }
    if (p === '/api/agents' && req.method === 'POST') {
      const body = await readBody(req);
      let a;
      try { a = cleanAgent(body, newAgentId()); } catch (e) { return send(res, 400, { error: e.message }); }
      CONFIG.agents.push(a);
      saveConfig(); reloadAgents(); agentsChanged();
      return send(res, 200, { ok: true, id: a.id });
    }
    if ((m0 = p.match(/^\/api\/agents\/([\w-]+)$/)) && (req.method === 'PUT' || req.method === 'DELETE')) {
      const idx = CONFIG.agents.findIndex((x) => x.id === m0[1]);
      if (idx < 0) return send(res, 404, { error: '找不到這位成員' });
      if (req.method === 'DELETE') {
        if (runs.has(m0[1])) return send(res, 409, { error: '這位成員還在工作，先停止再刪除' });
        if (CONFIG.agents.length <= 1) return send(res, 400, { error: '至少要留一位成員' });
        CONFIG.agents.splice(idx, 1);
        for (const x of CONFIG.agents) if (Array.isArray(x.canHandoffTo)) x.canHandoffTo = x.canHandoffTo.filter((id) => id !== m0[1]);
        if (CONFIG.telegram && CONFIG.telegram.defaultAgent === m0[1]) CONFIG.telegram.defaultAgent = CONFIG.agents[0].id;
        queues.delete(m0[1]);
      } else {
        const body = await readBody(req);
        let a;
        try { a = cleanAgent(body, m0[1]); } catch (e) { return send(res, 400, { error: e.message }); }
        CONFIG.agents[idx] = a;
      }
      saveConfig(); reloadAgents(); agentsChanged();
      return send(res, 200, { ok: true });
    }
    // 自訂頭像：網頁先裁成 128×128 PNG 再上傳
    if (p === '/api/avatar' && req.method === 'POST') {
      const { dataUrl } = await readBody(req);
      const mm = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
      if (!mm) return send(res, 400, { error: '圖片格式不正確' });
      const buf = Buffer.from(mm[1], 'base64');
      if (buf.length > 512 * 1024) return send(res, 400, { error: '圖片太大' });
      if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return send(res, 400, { error: '不是 PNG 圖片' });
      const name = 'av-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.png';
      fs.writeFileSync(path.join(AVATAR_DIR, name), buf);
      return send(res, 200, { avatar: 'img:' + name });
    }
    if ((m0 = p.match(/^\/api\/avatar\/([\w-]+\.png)$/)) && req.method === 'GET') {
      res.setHeader('Cache-Control', 'max-age=31536000, immutable');
      return sendFile(res, path.join(AVATAR_DIR, m0[1]));
    }
    if (p === '/api/team' && req.method === 'PUT') {
      const body = await readBody(req);
      CONFIG.workflow = String(body.workflow ?? '').slice(0, 8000);
      const h = Math.round(Number(body.maxRelayHops));
      if (h >= 1 && h <= 50) CONFIG.maxRelayHops = h;
      saveConfig(); agentsChanged();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/resetall' && req.method === 'POST') {
      const busy = AGENTS.filter((a) => runs.has(a.id)).map((a) => a.name);
      if (busy.length) return send(res, 409, { error: busy.join('、') + ' 還在工作，先停止再重置' });
      for (const a of AGENTS) resetAgent(a.id);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    let m;
    if ((m = p.match(/^\/api\/history\/([\w-]+)$/))) {
      const run = runs.get(m[1]);
      return send(res, 200, { history: loadHistory(m[1]), live: run ? run.segments : null });
    }
    if ((m = p.match(/^\/api\/chat\/([\w-]+)$/)) && req.method === 'POST') {
      const agent = agentById(m[1]);
      if (!agent) return send(res, 404, { error: '找不到這個 agent' });
      if (runs.has(agent.id)) return send(res, 409, { error: agent.name + ' 還在忙，等它做完或按停止' });
      const { text } = await readBody(req);
      if (!text || !String(text).trim()) return send(res, 400, { error: '訊息是空的' });
      const cc = userSend(agent, String(text));
      return send(res, 200, { ok: true, cc: cc.map((a) => a.name) });
    }
    if (p === '/api/stopall' && req.method === 'POST') {
      for (const a of AGENTS) stopRun(a.id);
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/stop\/([\w-]+)$/)) && req.method === 'POST') return send(res, 200, { ok: stopRun(m[1]) });
    if ((m = p.match(/^\/api\/reset\/([\w-]+)$/)) && req.method === 'POST') {
      if (!resetAgent(m[1])) return send(res, 409, { error: '執行中不能重置' });
      return send(res, 200, { ok: true });
    }
    // 讓聊天室能顯示 agent 產生的圖片/影片（限制在該 agent 的工作資料夾內）
    if (p === '/api/file') {
      const agent = agentById(url.searchParams.get('agent'));
      if (!agent) return send(res, 404, { error: 'agent?' });
      const target = path.resolve(agent.cwd, url.searchParams.get('p') || '');
      const rel = path.relative(agent.cwd, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return send(res, 403, { error: '只能讀取工作資料夾內的檔案' });
      return sendFile(res, target);
    }

    // 靜態檔
    const file = path.resolve(ROOT, 'public', '.' + (p === '/' ? '/index.html' : p));
    if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'forbidden', 'text/plain');
    return sendFile(res, file);
  } catch (e) {
    return send(res, 500, { error: String(e && e.message || e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('⚠️  ' + PORT + ' port 已被佔用，可能舊的伺服器還開著。請先關掉舊的黑色視窗再啟動。');
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log('✅ Agent Chat v' + VERSION + ' 已啟動： http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + (TOKEN ? '/?token=' + TOKEN : ''));
  for (const a of AGENTS) console.log('   ' + (a.avatar && !a.avatar.startsWith('img:') ? a.avatar : '•') + ' ' + a.name + '（' + [a.engine, a.model || '預設模型', a.effort].filter(Boolean).join(' · ') + '） → ' + a.cwd);
  for (const [k, v] of Object.entries(BIN)) console.log('   ' + (v ? '✔ ' + k + '：' + v : '✘ 找不到 ' + k + '（這個引擎的 agent 會無法回覆）'));
});

// Telegram 遙控（agents.json 有設定 telegram.botToken 才會啟動）
require('./telegram').start({
  config: CONFIG, agents: AGENTS, agentById, hooks, runs, state, saveState,
  dispatch, userSend, stopRun, resetAgent, maxHops, usageSnapshot,
});

const shutdown = () => { for (const id of runs.keys()) stopRun(id); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
