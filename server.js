// Agent Chat — 把 Claude Code 與 Codex CLI 包成聊天介面
// 不需要 npm install，只要 Node.js 18 以上。啟動：node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

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
fs.mkdirSync(HIST_DIR, { recursive: true });

// agents.json 是你自己的設定（不進 git）；第一次啟動時從範本複製一份
const AGENTS_FILE = path.join(ROOT, 'agents.json');
if (!fs.existsSync(AGENTS_FILE)) fs.copyFileSync(path.join(ROOT, 'agents.example.json'), AGENTS_FILE);
const CONFIG = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
const MAX_HOPS = Number(CONFIG.maxRelayHops) || 6; // agent 之間自動轉交的上限
function loadAgents() {
  return CONFIG.agents.map((a) => {
    const cwd = path.resolve(ROOT, a.cwd || './workspace');
    fs.mkdirSync(cwd, { recursive: true });
    return { ...a, cwd };
  });
}
const AGENTS = loadAgents();
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

function teamHint(agent) {
  const mates = AGENTS.filter((a) => a.id !== agent.id);
  let s = '（介面說明：使用者透過聊天介面跟你對話，回覆會以 Markdown 顯示。' +
    '若你產生了圖片或影片檔，請在回覆中用 ![說明](相對路徑) 顯示它。）';
  if (mates.length) {
    s += '\n\n【團隊】你有這些同事：' + mates.map((m) => m.name + '（' + (m.role || m.engine) + '）').join('、') + '。' +
      '\n需要同事幫忙時，在回覆中寫「@名字」加上要交代的事，系統會自動把你的回覆轉給對方，對方的回覆也會自動轉回給你。' +
      '\n你們在同一台電腦上工作，交接時寫清楚檔案路徑。只有真的需要對方時才 @，事情做完就直接向使用者總結，不要再 @ 任何人。';
  }
  return s;
}

function buildPrompt(agent, text, isNew, fromAgent) {
  let body;
  if (fromAgent) {
    body = '【來自同事 ' + fromAgent.name + ' 的訊息】\n' + text +
      '\n\n（要回覆對方請在回覆中寫 @' + fromAgent.name + '；事情處理完就直接向使用者總結，不要再 @ 對方。）';
  } else body = isNew ? '【使用者訊息】\n' + text : text;
  if (!isNew) return body;
  const persona = agent.persona ? '【你的角色設定】\n' + agent.persona + '\n\n' : '';
  return persona + teamHint(agent) + '\n\n' + body;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function findMentions(agent, text) {
  return AGENTS.filter((a) => a.id !== agent.id &&
    new RegExp('@\\s?(' + escRe(a.name) + '|' + escRe(a.id) + ')', 'i').test(text));
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
    if (sid) args.push('--resume', sid);
    return { cmd: getBin('claude'), args };
  }
  if (agent.engine === 'codex') {
    const opts = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="' + (agent.sandbox || 'workspace-write') + '"'];
    if (agent.model) opts.push('-m', agent.model);
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
  if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) emit({ kind: 'session', id: ev.session_id });
  else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'text' && b.text.trim()) emit({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use') emit({ kind: 'tool', text: describeClaudeTool(b) });
    }
  } else if (ev.type === 'result') {
    if (ev.session_id) emit({ kind: 'session', id: ev.session_id });
    if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) emit({ kind: 'error', text: ev.result || ev.subtype });
    const cost = typeof ev.total_cost_usd === 'number' ? 'US$' + ev.total_cost_usd.toFixed(4) : '';
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
  const prompt = buildPrompt(agent, userText, !sid, fromAgent);

  appendHistory(agent.id, { role: 'user', text: userText, from: opts.from, ts: Date.now() });
  broadcast({ agentId: agent.id, kind: 'user', text: userText, from: opts.from });

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
    // 回覆裡 @ 了同事 → 自動轉交
    const replyText = run.segments.filter((s) => s.type === 'text').map((s) => s.text).join('\n\n');
    const targets = run.stopped || !replyText ? [] : findMentions(agent, replyText);
    if (targets.length && hops >= MAX_HOPS) {
      emit({ kind: 'tool', text: '⛔ 已達自動轉交上限（' + MAX_HOPS + ' 次），沒有再轉給 ' +
        targets.map((t) => t.name).join('、') + '。需要的話請你手動接手。' });
    }

    appendHistory(agent.id, { role: 'assistant', segments: run.segments, meta: run.meta, ts: Date.now() });
    runs.delete(agent.id);
    broadcast({ agentId: agent.id, kind: 'done', meta: run.meta });
    broadcast({ agentId: agent.id, kind: 'busy', busy: false });

    if (hops < MAX_HOPS) for (const t of targets) dispatch(t, replyText, { from: agent.id, hops: hops + 1 });

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
  id: a.id, name: a.name, avatar: a.avatar, engine: a.engine, model: a.model || '', role: a.role || '',
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

  try {
    if (p === '/api/agents') return send(res, 200, AGENTS.map(publicAgent));

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
      startRun(agent, String(text));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/stopall' && req.method === 'POST') {
      for (const a of AGENTS) stopRun(a.id);
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/stop\/([\w-]+)$/)) && req.method === 'POST') return send(res, 200, { ok: stopRun(m[1]) });
    if ((m = p.match(/^\/api\/reset\/([\w-]+)$/)) && req.method === 'POST') {
      if (runs.has(m[1])) return send(res, 409, { error: '執行中不能重置' });
      delete state.sessions[m[1]]; saveState();
      try { fs.unlinkSync(histFile(m[1])); } catch {}
      broadcast({ agentId: m[1], kind: 'reset' });
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
  console.log('✅ Agent Chat 已啟動： http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + (TOKEN ? '/?token=' + TOKEN : ''));
  for (const a of AGENTS) console.log('   ' + (a.avatar || '•') + ' ' + a.name + '（' + a.engine + '） → ' + a.cwd);
  for (const [k, v] of Object.entries(BIN)) console.log('   ' + (v ? '✔ ' + k + '：' + v : '✘ 找不到 ' + k + '（這個引擎的 agent 會無法回覆）'));
});

const shutdown = () => { for (const id of runs.keys()) stopRun(id); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
