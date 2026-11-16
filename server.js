// Agent Chat — 把 Claude Code 與 Codex CLI 包成聊天介面
// 不需要 npm install，只要 Node.js 18 以上。啟動：node server.js
'use strict';
const VERSION = '3.6.0';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const EventEmitter = require('events');
const hooks = new EventEmitter(); // 給 Telegram 等外掛監聽：user / done / task
const taskLib = require('./tasks');
const harnessLib = require('./harness');
const { createSecurity, inside, isProtectedEnvKey } = require('./security');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || '127.0.0.1';
// ACCESS_TOKEN is handled exclusively by security.js. Never put it in URLs or logs.
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
if (!LOCAL_HOSTS.includes(HOST) && !process.env.ALLOWED_HOSTS) {
  console.error('對外開放時必須設定 ALLOWED_HOSTS（例如 Tailscale IP），否則拒絕啟動。');
  process.exit(1);
}

// ---------- 設定與資料 ----------
const DATA_DIR = path.join(ROOT, 'data');
const HIST_DIR = path.join(DATA_DIR, 'history');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars'); // 自訂頭像圖片
fs.mkdirSync(HIST_DIR, { recursive: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const security = createSecurity({ root: ROOT, dataDir: DATA_DIR, host: HOST, port: PORT });
// 🐞 問題回報：越早建立越好，才能記下啟動過程的訊息（其餘資料在產生回報時才讀）
const late = (fn) => { try { return fn(); } catch { return undefined; } };
const reporter = require('./diag').create({
  VERSION, ROOT, DATA_DIR, HOST, PORT, allowedRoots: security.allowedRoots, redact: security.redact,
  get CONFIG() { return late(() => CONFIG); }, get AGENTS() { return late(() => AGENTS) || []; },
  agentById: (id) => agentById(id), publicAgent: (a) => publicAgent(a), loadHistory: (id) => loadHistory(id),
  tasks: { actives: () => tasks.actives(), list: () => tasks.list(), detail: (id) => tasks.detail(id) },
  harnessCfg: () => harness.cfg(), harnessRuns: (n) => harness.recentRuns(n), telegramStatus: () => telegram.status(),
  getBin: (e) => getBin(e), safeEnv: () => security.safeEnvironment(),
  updateStatus: () => late(() => updater.status()),
});
// ⬆️ 一鍵更新與重新啟動（要用 start.bat → launcher.js 啟動）
const updater = require('./updater').create({ ROOT, DATA_DIR, VERSION, shutdown: (c) => shutdown(c) });
const STARTED_AT = Date.now();

// agents.json 是你自己的設定（不進 git）；第一次啟動時從範本複製一份
const AGENTS_FILE = path.join(ROOT, 'agents.json');
if (!fs.existsSync(AGENTS_FILE)) fs.copyFileSync(path.join(ROOT, 'agents.example.json'), AGENTS_FILE);
const CONFIG = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
const maxHops = () => Number(CONFIG.maxRelayHops) || 12; // agent 之間自動轉交的上限
// 舊設定不符合安全規則時，不讓整個伺服器無法啟動：這位成員標示為停用並說明原因，其他成員照常運作
const prepAgent = (a) => {
  try {
    const cwd = security.assertAllowedDir(a.cwd || './workspace');
    security.checkAgent({ ...a, cwd });
    fs.mkdirSync(cwd, { recursive: true });
    return { ...a, cwd };
  } catch (e) {
    console.error('⛔ 成員「' + a.name + '」的設定不符合安全規則，已暫停使用：' + e.message);
    return { ...a, cwd: path.resolve(ROOT, 'workspace'), blocked: e.message };
  }
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

// ---------- 小組：每個小組有自己的成員與工作流程，不同小組的任務可以同時進行 ----------
// 舊設定（只有一個 workflow）會自動變成第一個小組「開發組」，原本的成員都放進去
const teamById = (id) => CONFIG.teams.find((t) => t.id === id);
const teamMembers = (teamId) => CONFIG.agents.filter((a) => !a.standalone && a.team === teamId);
// 小組的工作資料夾：新成員預設放這裡；不同小組最好分開，共用時任務檔會自動分開命名
const sameDir = (a, b) => path.resolve(ROOT, a || '').toLowerCase() === path.resolve(ROOT, b || '').toLowerCase();
function cleanTeamCwd(raw) {
  const v = String(raw || '').trim().replace(/^"|"$/g, '').slice(0, 300);
  if (!v) return '';
  const dir = security.assertAllowedDir(v);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function teamDirs(t) {
  const dirs = teamMembers(t.id).map((a) => a.cwd || './workspace');
  if (t.cwd) dirs.push(t.cwd);
  return dirs;
}
const sharedWith = (t) => CONFIG.teams.filter((o) => o !== t && teamDirs(o).some((d) => teamDirs(t).some((e) => sameDir(d, e)))).map((o) => o.name);
// 換了工作資料夾：舊的 CLI 對話是在原本的資料夾開的，接不上，下一輪改開新對話
function dropSessions(id) {
  for (const k of Object.keys(state.sessions)) if (k === id || k.endsWith(':' + id)) { delete state.sessions[k]; delete state.ctx[k]; }
  saveState();
}
function normalizeTeams() {
  let changed = false;
  if (!Array.isArray(CONFIG.teams) || !CONFIG.teams.length) {
    CONFIG.teams = [{ id: 'main', name: '開發組', icon: '🛠', workflow: CONFIG.workflow }];
    if (typeof CONFIG.approveWritableHandoffs === 'boolean') CONFIG.teams[0].approveWritableHandoffs = CONFIG.approveWritableHandoffs;
    changed = true;
  }
  if ('workflow' in CONFIG) { delete CONFIG.workflow; changed = true; }
  const first = CONFIG.teams[0].id;
  for (const a of CONFIG.agents) {
    if (a.standalone) { if (a.team) { delete a.team; changed = true; } continue; }
    if (!a.team || !teamById(a.team)) { a.team = first; changed = true; }
  }
  for (const t of CONFIG.teams) {
    const was = JSON.stringify(t.workflow);
    t.workflow = taskLib.normalizeWorkflow(t.workflow, teamMembers(t.id));
    if (JSON.stringify(t.workflow) !== was) changed = true;
  }
  return changed;
}
if (normalizeTeams()) saveConfig();
reloadAgents();

let state = { sessions: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
state.ctx = state.ctx || {};       // 每段對話（session）目前大約用了多少 context：{ tokens, window, at }
state.shifts = state.shifts || {}; // 換班：{ n: 第幾班, due: 下一輪前要換班, note: 交班筆記, pendingNote: 新的一班還沒讀到筆記 }
state.lastKey = state.lastKey || {}; // 每位成員最近一次用的是哪一段對話

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
  for (const c of clients) {
    if (security.authenticated(c.req)) c.res.write(line);
    else { clients.delete(c); c.res.end(); }
  }
}

// ---------- 執行 CLI ----------
const runs = new Map(); // agentId -> { proc, segments, cwd, opts }
const pending = [];     // 排隊中的訊息：{ agentId, text, opts }

// 這位成員可以 @ 誰（自由聊天模式）：有設定 canHandoffTo 就照設定，沒設定就是全部同事
function allowedTargets(agent) {
  if (agent.standalone) return [];
  const others = AGENTS.filter((a) => a.id !== agent.id && !a.standalone && a.team === agent.team); // 只在同一個小組內轉交；獨立成員不參與
  return Array.isArray(agent.canHandoffTo) ? others.filter((a) => agent.canHandoffTo.includes(a.id)) : others;
}

// 成員可以存取的資料夾（每一輪都告訴它）
function accessText(agent) {
  const dirs = agent.extraDirs || [];
  if (!dirs.length) return '【可以存取的資料夾】只有你的工作資料夾：' + agent.cwd + '（可讀寫）。其他位置的檔案請使用者用附件傳給你。';
  return ['【可以存取的資料夾】', '- 工作資料夾：' + agent.cwd + '（可讀寫）']
    .concat(dirs.map((d) => '- ' + d.path + (d.mode === 'ro' ? '（唯讀：只能讀取，絕對不可以修改、刪除、移動或新增任何檔案）' : '（可讀寫）'))).join('\n');
}

// 自由聊天模式每一輪附上的說明（身分、團隊、@ 規則）
// 角色設定檔（獨立成員常用）：每一輪重新讀取，改了檔案下一句就生效
function personaFileText(agent) {
  if (!agent.personaFile) return '';
  try {
    const full = path.resolve(agent.cwd, agent.personaFile);
    security.assertAllowedDir(path.dirname(full));
    const t = fs.readFileSync(full, 'utf8');
    return '【角色設定（' + agent.personaFile + '）】\n' + (t.length > 20000 ? t.slice(0, 20000) + '\n……（後面省略）' : t);
  } catch (e) { return '【角色設定】讀不到 ' + agent.personaFile + '（' + e.message + '），請先告訴使用者這個問題。'; }
}
function freeHeader(agent) {
  const L = ['【你的身分】你是「' + agent.name + '」' + (agent.role ? '，職責：' + agent.role : '')];
  if (agent.persona) L.push(agent.persona);
  if (agent.personaFile) L.push(personaFileText(agent));
  if (agent.standalone) {
    // 獨立成員：不屬於團隊工作流程，沒有交接規則，直接回覆使用者
    L.push('（介面說明：使用者透過聊天介面或 Telegram 跟你對話，你的回覆會直接傳回給使用者。照片等附件會存在你的工作資料夾，訊息裡會寫出相對路徑。）');
    L.push(accessText(agent));
    if (agent.engine === 'claude' && (agent.tools || (agent.allowedTools || []).length))
      L.push('【權限】你只能使用系統允許的工具與指令；被擋下時直接告訴使用者，不要嘗試繞過。');
    const g = harness.guidesText(agent, {});
    if (g) L.push('', g);
    return L.join('\n');
  }
  L.push('（介面說明：使用者透過聊天介面或 Telegram 跟你對話，回覆會以 Markdown 顯示。若你產生了圖片或影片檔，請在回覆中用 ![說明](相對路徑) 顯示它。）');
  L.push(accessText(agent));
  const team = AGENTS.filter((a) => !a.standalone && a.team === agent.team);
  const others = team.filter((a) => a.id !== agent.id);
  if (others.length) {
    L.push('', '【團隊成員（' + ((teamById(agent.team) || {}).name || '') + '）】');
    for (const m of team) L.push('- ' + m.name + '：' + (m.role || m.engine) + (m.id === agent.id ? '（就是你）' : ''));
    const can = allowedTargets(agent);
    L.push('', can.length
      ? '【交接規則】你可以找：' + can.map((m) => m.name).join('、') + '。需要時在回覆中寫「@名字」加上要交代的事，系統會把你的回覆轉給對方；不需要時不要 @ 任何人。'
      : '【交接規則】你不能把工作交給其他成員，完成後直接向使用者回報。');
  }
  const hb = harness.promptBlock(agent);
  if (hb) L.push('', hb);
  return L.join('\n');
}

function buildPrompt(agent, text, opts = {}) {
  const header = opts.taskId ? tasks.promptHeader(agent, opts) : freeHeader(agent);
  let body;
  const fromAgent = opts.from && agentById(opts.from);
  if (opts.shift) return header + '\n\n' + shiftPrompt(agent, opts);
  const key = sessionKey(agent, opts), sh = state.shifts[key];
  const handover = sh && sh.pendingNote && !state.sessions[key]
    ? '\n\n【換班：你是接手的第 ' + sh.n + ' 班】前一班的對話太長，換成你接手；你看不到前一班的對話。以下是前一班留下的交班筆記，先讀完，再處理下面的訊息' +
      (opts.taskId ? '（也可以看工作資料夾的 ' + tasks.taskDocName(opts.taskId) + '）' : '') + '：\n' + (sh.note || '（前一班沒有留下筆記，請從工作資料夾的檔案判斷進度）') + '\n【交班筆記結束】'
    : '';
  if (opts.interject) {
    body = '【使用者插話：你剛才的工作被暫停了】\n' + text +
      '\n\n請依照這個指示調整，然後繼續完成你原本的工作（之前做到哪裡，可以從對話紀錄與工作資料夾的檔案判斷）。';
  } else if (opts.taskId) {
    body = opts.from ? text : opts.system ? '【系統訊息】\n' + text : '【使用者訊息】\n' + text;
  } else if (fromAgent) {
    body = '【來自同事 ' + fromAgent.name + ' 的訊息】\n' + text +
      '\n\n（要回覆對方請在回覆中寫 @' + fromAgent.name + '；事情處理完就直接向使用者總結，不要再 @ 對方。）';
  } else {
    let note = '';
    const ccOf = opts.cc && agentById(opts.cc);
    const ccTo = (opts.ccTo || []).map(agentById).filter(Boolean);
    if (ccOf) note = '（這則訊息使用者是交給 ' + ccOf.name + ' 的，並在訊息中 @ 了你，請依你的職責協助，需要時用 @' + ccOf.name + ' 跟對方協調。）\n';
    else if (ccTo.length) note = '（使用者同時把這則訊息交給了 ' + ccTo.map((a) => a.name).join('、') + '，需要時用 @名字 協調分工。）\n';
    body = '【使用者訊息】\n' + note + text;
  }
  return header + handover + '\n\n' + body;
}

// ---------- 換班：對話太長時，請成員寫交班筆記，再換成全新的一段對話接手 ----------
const CTX_DEFAULT = { claude: 200000, codex: 272000 };
function ctxInfo(key, engine) {
  const c = state.ctx[key]; if (!c || !c.tokens) return null;
  const window = c.window || CTX_DEFAULT[engine] || 200000;
  return { tokens: c.tokens, window, pct: Math.min(100, Math.round((c.tokens / window) * 100)), at: c.at };
}
function shiftPrompt(agent, opts) {
  const c = ctxInfo(sessionKey(agent, opts), agent.engine);
  return '【系統：換班】' + (opts.manualShift ? '使用者要求換班。' : '這段對話已經很長' + (c ? '（約 ' + Math.round(c.tokens / 1000) + 'k tokens，上限的 ' + c.pct + '%）' : '') + '，再長下去會被自動壓縮、遺失細節。') +
    '接下來會由一個全新的你接手，新的你看不到這段對話。\n請現在只寫一份交班筆記：不要繼續原本的工作、不要修改檔案、不要寫【交接】區塊。用下面的格式，寫得具體到可以直接照著接手，1500 字以內：\n' +
    '## 目標\n## 已完成\n## 進行中（做到哪、卡在哪）\n## 下一步\n## 重要決定與注意事項（使用者的要求、規格、不能動的東西）\n## 相關檔案';
}
function shiftDue(agent, key) {
  const pct = Number(harness.cfg().shiftPercent);
  const c = ctxInfo(key, agent.engine);
  return !!(state.sessions[key] && ((state.shifts[key] && state.shifts[key].due) || (pct > 0 && c && c.pct >= pct)));
}
function finishShift(agent, key, run, note) {
  const prev = state.shifts[key] || { n: 1 };
  const c = ctxInfo(key, agent.engine);
  state.shifts[key] = { n: (prev.n || 1) + 1, note: note ? note.slice(0, 8000) : '', at: Date.now(), pendingNote: true, due: false };
  delete state.sessions[key]; delete state.ctx[key];
  saveState();
  try {
    const dir = path.join(DATA_DIR, 'harness', 'shifts'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.md'),
      '\n\n# 第 ' + (prev.n || 1) + ' 班 → 第 ' + state.shifts[key].n + ' 班（' + new Date().toLocaleString('zh-TW', { hour12: false }) + '）\n\n' + (note || '（沒有交班筆記）') + '\n');
  } catch {}
  harness.record({ type: 'shift', agent: agent.id, taskId: run.opts.taskId || null, n: state.shifts[key].n, tokens: c ? c.tokens : null, pct: c ? c.pct : null, manual: !!run.opts.manualShift });
  const t = '🔄 換班完成：下一輪起由第 ' + state.shifts[key].n + ' 班（全新的對話）接手，會先讀這份交班筆記';
  run.segments.push({ type: 'tool', text: t });
  broadcast({ agentId: agent.id, kind: 'segment', segment: { type: 'tool', text: t } });
}
// 手動換班：成員沒在工作時，馬上寫交班筆記
function manualShift(agent) {
  if (runs.has(agent.id)) return '工作中，等這一輪做完再換班（或先按 ⏹ 停止）';
  const key = state.lastKey[agent.id] || agent.id;
  const m = /^t(\d+):/.exec(key);
  const d = m ? tasks.detail(Number(m[1])) : null, t = d && d.task;
  const opts = t && ['running', 'waiting_user', 'awaiting_approval'].includes(t.status) ? { taskId: t.id, stageId: t.stageId } : {};
  const k = sessionKey(agent, opts);
  if (!state.sessions[k]) return '這段對話還沒開始，不需要換班';
  startRun(agent, '（換班）', { ...opts, shift: true, manualShift: true, system: true });
  return null;
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

// 排程規則：同一位成員一次只跑一輪；勾了「輪流工作」的成員之間，同一時間只有一位在動手。
// 沒勾的成員不受限制，隨時都能和任何人同時工作。
const turnBlocker = (agent) => (agent.takeTurns ? [...runs.entries()].find(([id, r]) => id !== agent.id && r.takeTurns && r.team === agent.team) : null);
const mustWait = (agent) => runs.has(agent.id) || !!turnBlocker(agent);
function dispatch(agent, text, opts = {}) {
  if (mustWait(agent)) {
    pending.push({ agentId: agent.id, text, opts });
    broadcast({ agentId: '*', kind: 'queue' });
    return 'queued';
  }
  startRun(agent, text, opts);
  return 'started';
}
// 排隊狀態：排了幾則、在等誰（給網頁顯示）
function queueInfo(agentId) {
  const items = pending.filter((p) => p.agentId === agentId);
  if (!items.length) return null;
  const a = agentById(agentId);
  const blocker = a && (runs.has(agentId) ? [agentId] : turnBlocker(a));
  return { count: items.length, waitingOn: blocker ? blocker[0] : null,
    items: items.map((p) => ({ text: p.text, from: p.opts.from || null, via: p.opts.via || null, taskId: p.opts.taskId || null })) };
}
function pump() {
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i], agent = agentById(item.agentId);
    if (!agent) { pending.splice(i--, 1); continue; }
    if (mustWait(agent)) continue;
    pending.splice(i--, 1);
    startRun(agent, item.text, item.opts);
  }
  broadcast({ agentId: '*', kind: 'queue' });
}
function cancelTask(taskId) {
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].opts.taskId === taskId) pending.splice(i, 1);
  for (const [id, r] of runs) if (r.opts && r.opts.taskId === taskId) stopRun(id, true);
}

const sessionKey = (agent, opts) => (opts.taskId ? 't' + opts.taskId + ':' + agent.id : agent.id);

function buildCommand(agent, sid) {
  security.checkAgent(agent);
  if (sid && !/^[a-zA-Z0-9_-]{1,128}$/.test(sid)) throw new Error('不合法的 CLI Session ID');
  if (agent.engine === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (agent.permissionMode) args.push('--permission-mode', agent.permissionMode);
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('--effort', agent.effort);
    for (const d of agent.extraDirs || []) if (d.mode !== 'ro') args.push('--add-dir', d.path);
    // 工具限制（獨立成員的最小權限）：--tools 只留這些內建工具；allowed/disallowed 是 Claude Code 的權限規則
    if (agent.tools) args.push('--tools', agent.tools);
    if ((agent.allowedTools || []).length) args.push('--allowedTools', ...agent.allowedTools);
    if ((agent.disallowedTools || []).length) args.push('--disallowedTools', ...agent.disallowedTools);
    if (sid) args.push('--resume', sid);
    return { cmd: getBin('claude'), args };
  }
  if (agent.engine === 'codex') {
    const opts = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="' + (agent.sandbox || 'workspace-write') + '"'];
    if (agent.model) opts.push('-m', agent.model);
    if (agent.effort) opts.push('-c', 'model_reasoning_effort="' + agent.effort + '"');
    // 可讀寫的額外資料夾加進沙箱的可寫入清單（唯讀的不加：沙箱本來就允許讀取）
    const rw = (agent.extraDirs || []).filter((d) => d.mode !== 'ro').map((d) => "'" + d.path + "'");
    if (rw.length) opts.push('-c', 'sandbox_workspace_write.writable_roots=[' + rw.join(',') + ']');
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
    const u = ev.message.usage;
    if (u && u.input_tokens != null) emit({ kind: 'ctx', tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) });
    for (const b of ev.message.content) {
      if (b.type === 'text' && b.text.trim()) emit({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use') emit({ kind: 'tool', text: describeClaudeTool(b), call: { id: b.id, name: b.name, input: b.input } });
    }
  } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '';
      emit({ kind: 'toolres', id: b.tool_use_id, isError: !!b.is_error, text });
    }
  } else if (ev.type === 'result') {
    if (ev.session_id) emit({ kind: 'session', id: ev.session_id });
    if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) emit({ kind: 'error', text: ev.result || ev.subtype });
    // total_cost_usd 是「換算成 API 價格」的估計值；用訂閱帳號登入時不會真的收費
    const cost = typeof ev.total_cost_usd === 'number' ? '≈API價 US$' + ev.total_cost_usd.toFixed(2) : '';
    const u = ev.usage || {};
    const mu = ev.modelUsage && Object.values(ev.modelUsage).find((x) => x && x.contextWindow);
    if (mu) emit({ kind: 'ctx', window: mu.contextWindow });
    emit({ kind: 'done', meta: [cost, ev.duration_ms ? (ev.duration_ms / 1000).toFixed(1) + 's' : ''].filter(Boolean).join(' · '),
      stats: { costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0, inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outTok: u.output_tokens || 0, steps: ev.num_turns || 0 } });
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
    else if (it.type === 'command_execution') {
      emit({ kind: 'toolres', call: { name: 'command', input: { command: it.command } }, exitCode: it.exit_code, isError: !!it.exit_code, text: it.aggregated_output || '' });
      if (it.exit_code) emit({ kind: 'tool', text: '⚠️ 指令結束碼 ' + it.exit_code });
    }
    else if (it.type === 'error') emit({ kind: 'error', text: it.message });
  } else if (ev.type === 'turn.completed') {
    const u = ev.usage || {};
    emit({ kind: 'done', meta: u.input_tokens != null ? '輸入 ' + u.input_tokens + ' / 輸出 ' + u.output_tokens + ' tokens' : '',
      stats: { inTok: u.input_tokens || 0, outTok: u.output_tokens || 0 } });
  } else if (ev.type === 'turn.failed') emit({ kind: 'error', text: (ev.error && ev.error.message) || '執行失敗' });
  else if (ev.type === 'error') {
    const msg = ev.message || '錯誤';
    emit({ kind: /^Reconnecting/i.test(msg) ? 'tool' : 'error', text: /^Reconnecting/i.test(msg) ? '🔄 ' + short(msg) : msg });
  }
}

// 稽核紀錄（獨立成員）：每一輪的輸入、呼叫的指令與結果、回覆、錯誤，寫在 data/audit/<成員>.jsonl
function writeAudit(agent, run, input) {
  try {
    const dir = path.join(DATA_DIR, 'audit'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, agent.id + '.jsonl');
    const o = run.opts || {};
    const rec = { ts: Date.now(), agent: agent.id, via: o.via || 'web', tgUser: o.tgUser || null, input: security.redact(String(input || '').slice(0, 4000)),
      calls: run.calls.map((c) => ({ tool: c.name, command: c.input && (c.input.command || c.input.file_path || c.input.pattern) || '', exitCode: c.exitCode, isError: !!c.isError, output: c.output || '' })),
      reply: security.redact(run.segments.filter((x) => x.type === 'text').map((x) => x.text).join('\n\n').slice(0, 8000)),
      errors: run.segments.filter((x) => x.type === 'error').map((x) => x.text), cliExit: run.exitCode != null ? run.exitCode : null,
      ms: Date.now() - run.startedAt, stopped: !!run.stopped, shift: !!o.shift };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    if (fs.statSync(file).size > 10 * 1024 * 1024) { const lines = fs.readFileSync(file, 'utf8').trim().split('\n'); fs.writeFileSync(file, lines.slice(-5000).join('\n') + '\n'); }
  } catch (e) { console.error('稽核紀錄寫入失敗：' + e.message); }
}
function readAudit(agentId, limit = 50) {
  try { return fs.readFileSync(path.join(DATA_DIR, 'audit', agentId + '.jsonl'), 'utf8').trim().split('\n').slice(-limit).reverse().map((l) => JSON.parse(l)); }
  catch { return []; }
}

function startRun(agent, userText, opts = {}) {
  const key = sessionKey(agent, opts);
  // 對話太長：先換班（寫交班筆記），原本的訊息排在換班之後
  if (!opts.shift && !opts.interject && !agent.blocked && shiftDue(agent, key)) {
    pending.unshift({ agentId: agent.id, text: userText, opts });
    return startRun(agent, '（換班）', { taskId: opts.taskId, stageId: opts.stageId, shift: true, system: true });
  }
  state.lastKey[agent.id] = key;
  const sid = state.sessions[key];
  let cmd = null, args = [], blocked = agent.blocked || null;
  if (!blocked) {
    try { ({ cmd, args } = buildCommand(agent, sid)); } catch (e) { blocked = e.message; }
  }
  const hops = opts.hops || 0;
  const prompt = buildPrompt(agent, userText, opts);
  const meta = { from: opts.from, via: opts.via, cc: opts.cc, taskId: opts.taskId, stageId: opts.stageId, system: opts.system, interject: opts.interject, shift: opts.shift };

  const shownText = opts.shift ? '🔄 換班：' + (opts.manualShift ? '你要求換班' : '對話已經很長') + '，請成員寫交班筆記，之後換成全新的對話接手' : userText;
  appendHistory(agent.id, { role: 'user', text: shownText, ...meta, ts: Date.now() });
  broadcast({ agentId: agent.id, kind: 'user', text: shownText, ...meta });
  hooks.emit('user', { agent, text: userText, from: opts.from, via: opts.via });

  const run = { segments: [], calls: [], meta: '', finished: false, stderr: Buffer.alloc(0), cwd: agent.cwd, opts, takeTurns: !!agent.takeTurns && !agent.standalone, team: agent.team || null,
    startedAt: Date.now(), lastActivity: Date.now(), stdoutTail: [], cmdline: '' };
  runs.set(agent.id, run);
  broadcast({ agentId: agent.id, kind: 'busy', busy: true });

  const finish = () => {
    appendHistory(agent.id, { role: 'assistant', segments: run.segments, meta: run.meta, taskId: opts.taskId, ts: Date.now() });
    if (agent.standalone) writeAudit(agent, run, userText);
    const errSeg = run.segments.find((x) => x.type === 'error');
    harness.record({ type: 'run', agent: agent.id, engine: agent.engine, model: agent.model || '', taskId: opts.taskId || null, stage: opts.stageId || null,
      ms: Date.now() - run.startedAt, tools: run.segments.filter((x) => x.type === 'tool').length, ...(run.stats || {}),
      error: errSeg && !run.interrupt ? short(errSeg.text, 160) : null, interrupted: !!run.interrupt, stopped: !!run.stopped, shift: !!opts.shift });
    runs.delete(agent.id);
    broadcast({ agentId: agent.id, kind: 'done', meta: run.meta });
    broadcast({ agentId: agent.id, kind: 'busy', busy: false });
  };

  if (blocked) {
    run.segments.push({ type: 'error', text: '⛔ 這位成員的設定不符合安全規則，暫停使用：\n' + blocked +
      '\n請到成員的「⚙️ 設定」修改（例如把資料夾移到核准範圍、改用 Codex 唯讀或可讀寫），或在 start.bat 設定 AGENT_ALLOWED_ROOTS。' });
    broadcast({ agentId: agent.id, kind: 'segment', segment: run.segments[0] });
    finish();
    hooks.emit('done', { agent, tg: opts.tg, via: opts.via, segments: run.segments, meta: '', relayTo: [] });
    if (opts.taskId) tasks.onTurnDone(agent, run, opts, null);
    setImmediate(pump);
    return;
  }
  if (!cmd) {
    const how = agent.engine === 'claude' ? 'npm.cmd i -g @anthropic-ai/claude-code' : 'npm.cmd i -g @openai/codex';
    run.segments.push({ type: 'error', text: '找不到 ' + agent.engine + ' 指令。\n' +
      '還沒安裝的話，在 PowerShell 輸入：' + how + '\n' +
      '已經安裝了，請在 PowerShell 輸入「where.exe ' + agent.engine + '」，把顯示的路徑填進 start.bat 的 ' +
      agent.engine.toUpperCase() + '_BIN。' });
    broadcast({ agentId: agent.id, kind: 'segment', segment: run.segments[0] });
    finish();
    hooks.emit('done', { agent, tg: opts.tg, via: opts.via, segments: run.segments, meta: '', relayTo: [] });
    if (opts.taskId) tasks.onTurnDone(agent, run, opts, null);
    setImmediate(pump);
    return;
  }

  // 任務模式：記下工作資料夾目前的樣子，結束後比對出實際變更的檔案
  const before = opts.taskId && !opts.shift ? tasks.snapshotFor(agent) : null;

  // .exe 直接執行；.cmd（npm 安裝的）要透過 cmd.exe，路徑有空白時要加引號
  const needShell = IS_WIN && !/\.exe$/i.test(cmd);
  const spawnCmd = needShell && /\s/.test(cmd) ? '"' + cmd + '"' : cmd;
  // 透過 cmd.exe 執行時，含空白或特殊符號的參數（例如資料夾路徑）要加引號
  const spawnArgs = needShell ? args.map((x) => (/[\s&|<>^()]/.test(x) && !x.includes('"') ? '"' + x + '"' : x)) : args;
  const proc = spawn(spawnCmd, spawnArgs, { cwd: agent.cwd, shell: needShell, env: { ...security.safeEnvironment(), ...(agent.env || {}) }, windowsHide: true });
  run.proc = proc;
  run.pid = proc.pid;
  run.cmdline = [cmd, ...args].map((x) => (/[\s"']/.test(x) ? JSON.stringify(x) : x)).join(' ');

  const emit = (e) => {
    if (e.kind === 'session') {
      const sh = state.shifts[key];
      if (sh && sh.pendingNote && !opts.shift) sh.pendingNote = false; // 新的一班已經拿到交班筆記
      if (state.sessions[key] !== e.id) { state.sessions[key] = e.id; saveState(); }
      return;
    }
    if (e.kind === 'ctx') {
      const c = state.ctx[key] = state.ctx[key] || {};
      if (e.tokens != null) c.tokens = e.tokens;
      if (e.window) c.window = e.window;
      c.at = Date.now();
      return;
    }
    if (e.kind === 'done') { run.meta = e.meta || ''; run.finished = true; if (e.stats) run.stats = e.stats; return; }
    if (e.kind === 'toolres') {
      // 工具結果：記進稽核紀錄；被擋下或失敗的顯示一行
      let c = e.id && run.calls.find((x) => x.id === e.id);
      if (!c) { c = { ...(e.call || {}), at: Date.now() }; run.calls.push(c); }
      const m = /exit code[:\s]+(\d+)/i.exec(e.text || '');
      c.isError = e.isError; c.exitCode = e.exitCode != null ? e.exitCode : m ? Number(m[1]) : e.isError ? null : 0;
      c.output = security.redact(String(e.text || '').slice(0, 2000));
      if (e.isError && agent.engine === 'claude') {
        const seg = { type: 'tool', text: '⛔ ' + short(e.text || '工具執行失敗', 160) };
        run.segments.push(seg); broadcast({ agentId: agent.id, kind: 'segment', segment: seg });
      }
      return;
    }
    if (e.call) run.calls.push({ ...e.call, at: Date.now() });
    run.segments.push({ type: e.kind, text: e.text });
    broadcast({ agentId: agent.id, kind: 'segment', segment: { type: e.kind, text: e.text } });
  };
  const parse = agent.engine === 'claude' ? parseClaude : parseCodex;

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    run.lastActivity = Date.now();
    if (run.stalled) { run.stalled = false; broadcast({ agentId: agent.id, kind: 'busy', busy: true }); }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { run.stdoutTail.push(line.length > 600 ? line.slice(0, 600) + '…' : line); if (run.stdoutTail.length > 25) run.stdoutTail.shift(); }
      if (!line.startsWith('{')) continue;
      try { parse(JSON.parse(line), emit); } catch {}
    }
  });
  proc.stderr.on('data', (c) => { run.stderr = Buffer.concat([run.stderr, c]).subarray(-16000); run.lastStderr = Date.now(); });

  proc.on('error', (err) => {
    emit({ kind: 'error', text: '無法啟動「' + cmd + '」：' + err.message + '。請確認已安裝並在終端機能執行。' });
  });
  proc.on('close', (code) => {
    if (run.interrupt) {
      // 使用者插話：結束這一輪（不轉交、不判斷任務交接），馬上帶著指示接著做同一段對話
      emit({ kind: 'tool', text: '⚡ 使用者插話，這一輪先暫停' });
      finish();
      hooks.emit('done', { agent, tg: opts.tg, via: opts.via, segments: run.segments, meta: run.meta, relayTo: [], taskId: opts.taskId });
      if (opts.taskId) tasks.noteInterrupt(agent, opts, before, run.interrupt.text);
      if (agent.engine === 'codex') setTimeout(readCodexUsage, 500);
      startRun(agentById(agent.id) || agent, run.interrupt.text,
        { taskId: opts.taskId, stageId: opts.stageId, hops: opts.hops, via: run.interrupt.via, interject: true });
      pump();
      return;
    }
    run.exitCode = code;
    if (run.stopped) emit({ kind: 'error', text: '⏹ 已手動停止' });
    else if (code && !run.finished && !run.segments.some((s) => s.type === 'error')) {
      const tail = decodeOutput(run.stderr).trim().split(/\r?\n/).slice(-6).join('\n');
      emit({ kind: 'error', text: 'CLI 結束碼 ' + code + (tail ? '\n' + tail : '') });
    }
    if (agent.engine === 'codex') { setTimeout(readCodexUsage, 500); codexContext(key); }
    saveState();
    if (opts.shift) {
      const note = run.segments.filter((s) => s.type === 'text').map((s) => s.text).join('\n\n').trim();
      if (!run.stopped) finishShift(agent, key, run, note);
      finish();
      hooks.emit('done', { agent, tg: opts.tg, via: opts.via, segments: run.segments, meta: run.meta, relayTo: [], taskId: opts.taskId, shift: true });
      pump();
      return;
    }

    // 自由聊天模式：回覆裡 @ 了同事 → 自動轉交（任務模式改由流程決定）
    const replyText = run.segments.filter((s) => s.type === 'text').map((s) => s.text).join('\n\n');
    if (!opts.taskId && replyText && !run.stopped && !agent.standalone) harness.collect(agent, replyText, null);
    const targets = opts.taskId || run.stopped || !replyText ? [] : findMentions(agent, replyText);
    if (targets.length && hops >= maxHops()) {
      emit({ kind: 'tool', text: '⛔ 已達自動轉交上限（' + maxHops() + ' 次），沒有再轉給 ' +
        targets.map((t) => t.name).join('、') + '。需要的話請你手動接手。' });
    }
    finish();
    hooks.emit('done', { agent, tg: opts.tg, via: opts.via, segments: run.segments, meta: run.meta, relayTo: hops < maxHops() ? targets : [], taskId: opts.taskId });

    if (opts.taskId && !run.silentStop) tasks.onTurnDone(agent, run, opts, before);
    if (hops < maxHops()) for (const t of targets) dispatch(t, replyText, { from: agent.id, hops: hops + 1 });
    pump();
  });

  proc.stdin.on('error', () => {});
  proc.stdin.end(prompt);
}

// silent：任務被整個停止時，不再觸發任務的後續判斷
function stopRun(id, silent) {
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].agentId === id) pending.splice(i, 1);
  broadcast({ agentId: '*', kind: 'queue' });
  const run = runs.get(id);
  if (!run || !run.proc) return false;
  run.stopped = true;
  if (silent) run.silentStop = true;
  if (IS_WIN) spawn('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], { windowsHide: true });
  else run.proc.kill('SIGTERM');
  return true;
}

// 插話：中斷正在工作的成員，結束後馬上用同一段對話帶著使用者的指示繼續
function interruptRun(id, text, via) {
  const run = runs.get(id);
  if (!run || !run.proc) return false;
  if (run.interrupt) { run.interrupt.text += '\n' + text; return true; }
  run.interrupt = { text, via };
  if (IS_WIN) spawn('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], { windowsHide: true });
  else run.proc.kill('SIGTERM');
  return true;
}
// 送給某位成員：正在工作就插話，否則照常送出
function interject(agent, text, via) {
  if (interruptRun(agent.id, text, via)) return 'interrupted';
  dispatch(agent, text, { via });
  return runs.has(agent.id) ? 'started' : 'queued';
}

// ---------- 診斷與卡住偵測 ----------
function diag(id) {
  const a = agentById(id), run = runs.get(id);
  return {
    agent: a ? { id: a.id, name: a.name, engine: a.engine, model: a.model || '', effort: a.effort || '', cwd: a.cwd } : null,
    bin: a ? getBin(a.engine) : null,
    running: !!run,
    run: run ? {
      pid: run.pid, startedAt: run.startedAt, lastActivity: run.lastActivity, lastStderr: run.lastStderr || null, stalled: !!run.stalled,
      cmdline: security.redact(run.cmdline, [CONFIG.telegram && CONFIG.telegram.botToken]),
      stderrTail: security.redact(decodeOutput(run.stderr).split(/\r?\n/).slice(-40).join('\n'), [CONFIG.telegram && CONFIG.telegram.botToken]),
      stdoutTail: run.stdoutTail.map((s) => security.redact(s, [CONFIG.telegram && CONFIG.telegram.botToken])), segments: run.segments.length, taskId: run.opts.taskId || null,
    } : null,
    queue: queueInfo(id),
    stallMinutes: stallMinutes(),
  };
}
const stallMinutes = () => Number(CONFIG.stallMinutes) || 10;
setInterval(() => {
  const limit = stallMinutes() * 60000, now = Date.now();
  for (const [id, run] of runs) {
    if (run.stalled || now - run.lastActivity < limit) continue;
    run.stalled = true;
    const a = agentById(id);
    const tail = decodeOutput(run.stderr).trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
    const text = '⚠️ 已經 ' + Math.round((now - run.lastActivity) / 60000) + ' 分鐘沒有任何輸出，可能卡住了。可以按 ⏹ 停止，或按「🔍 診斷」看原因。' +
      (tail ? '\nCLI 最後的訊息：' + tail : '');
    run.segments.push({ type: 'error', text });
    broadcast({ agentId: id, kind: 'segment', segment: { type: 'error', text } });
    broadcast({ agentId: id, kind: 'busy', busy: true });
    hooks.emit('stalled', { agent: a, minutes: Math.round((now - run.lastActivity) / 60000), text });
  }
}, 30000);

function resetAgent(id) {
  if (runs.has(id)) return false;
  delete state.sessions[id]; delete state.ctx[id]; delete state.shifts[id]; delete state.lastKey[id]; saveState();
  try { fs.unlinkSync(histFile(id)); } catch {}
  broadcast({ agentId: id, kind: 'reset' });
  return true;
}

// ---------- Harness（守則、自動檢查、預算、記憶、觀測）----------
const harness = harnessLib.create({
  CONFIG, AGENTS, agentById, teamById, DATA_DIR, hooks, broadcast, IS_WIN, decode: decodeOutput,
  safeEnv: () => security.safeEnvironment(),
  redact: (s) => security.redact(s, [CONFIG.telegram && CONFIG.telegram.botToken]),
});

// ---------- 任務與工作流程（tasks.js）----------
const tasks = taskLib.create({
  CONFIG, AGENTS, agentById, DATA_DIR, hooks, broadcast, dispatch, cancelTask, accessText, harness,
  teams: () => CONFIG.teams, teamById,
});
tasks.writeWorkflowDocs();

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

// Codex 這段對話目前的 context 大小：從它自己的 rollout 紀錄（檔名含 thread id）讀最後一次 token_count
function findTokenInfo(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.last_token_usage && typeof o.last_token_usage === 'object') return o;
  for (const v of Object.values(o)) { const r = findTokenInfo(v); if (r) return r; }
  return null;
}
function codexContext(key) {
  const sid = state.sessions[key]; if (!sid) return;
  const file = recentRolloutFiles(60).find((f) => path.basename(f).includes(sid));
  if (!file) return;
  try {
    const st = fs.statSync(file), size = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('last_token_usage')) continue;
      let info; try { info = findTokenInfo(JSON.parse(lines[i])); } catch { continue; }
      if (!info) continue;
      const u = info.last_token_usage;
      const tokens = u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0));
      if (!tokens) return;
      state.ctx[key] = { tokens, window: info.model_context_window || CTX_DEFAULT.codex, at: Date.now() };
      saveState();
      broadcast({ agentId: '*', kind: 'agents' });
      return;
    }
  } catch {}
}

// 「🔄 查詢」：送一個極小的請求，讓 CLI 回報最新額度
function runQuiet(cmd, args, input, timeoutMs, onLine) {
  return new Promise((resolve) => {
    const cwd = path.join(DATA_DIR, 'probe'); fs.mkdirSync(cwd, { recursive: true });
    const needShell = IS_WIN && !/\.exe$/i.test(cmd);
    const proc = spawn(needShell && /\s/.test(cmd) ? '"' + cmd + '"' : cmd, args, { cwd, shell: needShell, env: security.safeEnvironment(), windowsHide: true });
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
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'auto'];
const SANDBOXES = ['read-only', 'workspace-write'];

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
    // 沒填工作資料夾：用所屬小組的資料夾，沒有就用 ./workspace
    cwd: security.assertAllowedDir(str(input.cwd, 300) || (!input.standalone && (teamById(String(input.team || '')) ||
      teamById((CONFIG.agents.find((x) => x.id === existingId) || {}).team) || CONFIG.teams[0] || {}).cwd) || './workspace'),
    persona: str(input.persona, 8000),
  };
  if (!a.name) throw new Error('請填名稱');
  if (a.avatar.startsWith('img:')) {
    if (!/^img:[\w-]+\.png$/.test(a.avatar) || !fs.existsSync(path.join(AVATAR_DIR, a.avatar.slice(4)))) throw new Error('頭像圖片不存在，請重新上傳');
  } else if ([...a.avatar].length > 8) throw new Error('頭像請用一個 emoji，或上傳圖片');
  if (/\s|@/.test(a.name)) throw new Error('名稱不能有空白或 @（同事要用 @名稱 呼叫）');
  if (['bypassPermissions', 'danger-full-access'].includes(input.permissionMode) ||
      ['bypassPermissions', 'danger-full-access'].includes(input.sandbox)) throw new Error('Web/Telegram 禁止完整權限模式');
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
  if (input.takeTurns) a.takeTurns = true;
  if (Array.isArray(input.extraDirs)) {
    const seen = new Set();
    a.extraDirs = [];
    for (const d of input.extraDirs.slice(0, 10)) {
      const raw = String((d && d.path) || '').trim().replace(/^"|"$/g, '');
      if (!raw) continue;
      if (!path.isAbsolute(raw)) throw new Error('資料夾要填完整路徑，例如 C:\\EM_reports_copy\\EM_DATA：' + raw);
      if (/["%'!^&|<>\r\n]/.test(raw)) throw new Error('資料夾路徑含有不允許的命令列特殊字元：' + raw);
      const full = path.resolve(raw);
      let st; try { st = fs.statSync(full); } catch { throw new Error('找不到這個資料夾：' + full); }
      if (!st.isDirectory()) throw new Error('這不是資料夾：' + full);
      security.assertAllowedDir(full, { mustExist: true });
      if (a.engine === 'claude' && d.mode === 'ro') throw new Error('Claude --add-dir 無法強制唯讀；請使用 OS ACL 或唯讀副本');
      if (seen.has(full.toLowerCase())) continue;
      seen.add(full.toLowerCase());
      a.extraDirs.push({ path: full, mode: d.mode === 'ro' ? 'ro' : 'rw' });
    }
    if (!a.extraDirs.length) delete a.extraDirs;
  }
  if (Array.isArray(input.canHandoffTo)) {
    a.canHandoffTo = input.canHandoffTo.filter((id) => id !== existingId && AGENTS.some((x) => x.id === id));
  }
  if (!a.model) delete a.model;
  if (!a.effort) delete a.effort;
  cleanStandalone(a, input, existingId);
  if (!a.standalone) {
    const tid = String(input.team || '').trim();
    a.team = teamById(tid) ? tid : (CONFIG.agents.find((x) => x.id === existingId) || {}).team || CONFIG.teams[0].id;
    if (!teamById(a.team)) a.team = CONFIG.teams[0].id;
  }
  security.checkAgent(a);
  return a;
}

// 獨立成員與最小權限設定：角色設定檔、成員專屬環境變數、Claude 工具限制、Telegram 路由
const TG_TOKEN_RE = /^\d+:[\w-]{20,}$/;
function parseLines(v) { return (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean); }
function cleanStandalone(a, input, existingId) {
  const old = CONFIG.agents.find((x) => x.id === existingId) || {};
  if (input.standalone) { a.standalone = true; delete a.takeTurns; delete a.canHandoffTo; }
  // 角色設定檔：相對於工作資料夾，例如 ledger/agent/記帳員.md
  const pf = String(input.personaFile || '').trim().replace(/^"|"$/g, '');
  if (pf) {
    if (/["%!^\r\n\0]/.test(pf) || pf.length > 300) throw new Error('角色設定檔路徑不合法');
    const full = path.resolve(a.cwd, pf);
    security.assertAllowedDir(path.dirname(full));
    let st; try { st = fs.statSync(full); } catch { throw new Error('找不到角色設定檔：' + full); }
    if (!st.isFile()) throw new Error('角色設定檔不是檔案：' + full);
    a.personaFile = pf;
  }
  // 成員專屬環境變數（KEY=VALUE，一行一個）
  const env = {};
  const pairs = input.env && typeof input.env === 'object' && !Array.isArray(input.env) ? Object.entries(input.env) : parseLines(input.env).map((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i), l.slice(i + 1)] : [l, null]; });
  for (const [k0, v] of pairs.slice(0, 20)) {
    const k = String(k0).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error('環境變數名稱不合法：' + k + '（格式：名稱=值，一行一個）');
    if (v == null) throw new Error('環境變數「' + k + '」少了 =值');
    if (isProtectedEnvKey(k)) throw new Error('環境變數「' + k + '」是系統或敏感變數，不能在這裡設定');
    if (String(v).length > 1000 || /[\r\n\0]/.test(v)) throw new Error('環境變數「' + k + '」的值太長或含換行');
    env[k] = String(v).trim();
  }
  if (Object.keys(env).length) a.env = env;
  // Claude 工具限制
  if (a.engine === 'claude') {
    const tools = String(input.tools || '').replace(/\s+/g, '');
    if (tools) {
      if (!/^[A-Za-z]+(,[A-Za-z]+){0,30}$/.test(tools)) throw new Error('可用工具請用逗號分隔，例如 Bash,Read');
      a.tools = tools;
    }
    for (const key of ['allowedTools', 'disallowedTools']) {
      const rules = parseLines(input[key]).slice(0, 20);
      for (const r of rules)
        if (r.length > 300 || !/^[A-Za-z_]+(\(.+\))?$/.test(r) || /["%!^`\r\n\0]/.test(r)) throw new Error('權限規則格式不對：' + r + '（例如 Bash(ledger/ledger.cmd *)）');
      if (rules.length) a[key] = rules;
    }
  }
  // Telegram 路由（只給獨立成員）：訊息前綴、專屬 bot、只接受哪些帳號
  if (a.standalone && input.telegram && typeof input.telegram === 'object') {
    const t = {}, ti = input.telegram, ot = old.telegram || {};
    const prefix = String(ti.prefix || '').trim();
    if (prefix) {
      if (prefix.length > 12 || /\s/.test(prefix)) throw new Error('Telegram 前綴最多 12 個字、不能有空白，例如 /記帳');
      const dupP = AGENTS.find((x) => x.id !== existingId && x.telegram && x.telegram.prefix === prefix);
      if (dupP) throw new Error('前綴「' + prefix + '」已經給 ' + dupP.name + ' 用了');
      t.prefix = prefix;
    }
    const tok = ti.clearBotToken ? '' : String(ti.botToken || '').trim() || ot.botToken || '';
    if (tok) {
      if (!TG_TOKEN_RE.test(tok)) throw new Error('專屬 bot token 格式不對，應該像 123456789:ABC…');
      const mainTok = process.env.TELEGRAM_BOT_TOKEN || (CONFIG.telegram || {}).botToken;
      if (tok === mainTok) throw new Error('專屬 bot 不能和主 bot 用同一個 token（同一個 bot 只能有一個程式接收訊息），請在 BotFather 另外開一個');
      if (CONFIG.agents.some((x) => x.id !== existingId && x.telegram && x.telegram.botToken === tok)) throw new Error('這個 bot token 已經給其他成員用了');
      t.botToken = tok;
    }
    const ids = parseLines(String(ti.userIds || '').replace(/[,，、\s]+/g, '\n')).slice(0, 10);
    for (const id of ids) if (!/^\d{3,15}$/.test(id)) throw new Error('Telegram 帳號 ID 只能是數字：' + id);
    if (ids.length) t.userIds = ids.map(Number);
    if (Object.keys(t).length) a.telegram = t;
  }
}

function newAgentId() {
  let id;
  do { id = 'a' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4); } while (agentById(id));
  return id;
}

const agentsChanged = () => { broadcast({ agentId: '*', kind: 'agents-changed' }); try { telegram.startAgentBots(tgCtx); } catch (e) { console.error('專屬 bot 重新啟動失敗：' + e.message); } };
// 給網頁的成員設定：不回傳 bot token，只告訴它有沒有設定
function maskAgent(a) {
  if (!a.telegram || !a.telegram.botToken) return a;
  const { botToken, ...t } = a.telegram;
  return { ...a, telegram: { ...t, hasBotToken: true, botHint: botToken.split(':')[0] } };
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
  return new Promise((resolve, reject) => {
    let d = '', bytes = 0, tooBig = false;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > 1024 * 1024) { tooBig = true; return; }
      d += c;
    });
    req.on('end', () => {
      if (tooBig) { const e = new Error('JSON 大小超過 1MB'); e.status = 413; return reject(e); }
      try { resolve(JSON.parse(d || '{}')); } catch { const e = new Error('不合法 JSON'); e.status = 400; reject(e); }
    });
    req.on('error', reject);
  });
}

const publicAgent = (a) => ({
  id: a.id, name: a.name, avatar: a.avatar, engine: a.engine, model: a.model || '', effort: a.effort || '', role: a.role || '',
  extraDirs: a.extraDirs || [], takeTurns: !!a.takeTurns, blocked: a.blocked || null,
  team: a.standalone ? null : a.team || null,
  standalone: !!a.standalone, tgPrefix: (a.telegram && a.telegram.prefix) || '', tgBot: !!(a.telegram && a.telegram.botToken),
  canHandoffTo: allowedTargets(a).map((t) => t.id),
  busy: runs.has(a.id), hasSession: !!state.sessions[a.id],
  queued: (queueInfo(a.id) || {}).count || 0, waitingOn: (queueInfo(a.id) || {}).waitingOn || null,
  runningSince: runs.has(a.id) ? runs.get(a.id).startedAt : null, lastActivity: runs.has(a.id) ? runs.get(a.id).lastActivity : null,
  stalled: runs.has(a.id) ? !!runs.get(a.id).stalled : false,
  ctx: ctxInfo(state.lastKey[a.id] || a.id, a.engine), shiftNo: ((state.shifts[state.lastKey[a.id] || a.id] || {}).n) || 1,
  shifting: runs.has(a.id) ? !!runs.get(a.id).opts.shift : false,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  if (!security.verifyHost(req)) return send(res, 403, { error: 'Host 不在白名單' });
  if (!security.checkOrigin(req)) return send(res, 403, { error: '拒絕跨來源操作' });
  if (p === '/api/auth/login' && req.method === 'POST') {
    if (!security.jsonRequest(req)) return send(res, 415, { error: '只接受 application/json' });
    try {
      const body = await readBody(req), result = security.login(req, body.token, body.remember === true);
      if (!result.ok) return send(res, result.blocked ? 429 : 401, { error: '登入失敗或暫時鎖定' });
      res.setHeader('Set-Cookie', result.cookie);
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }
  if (p.startsWith('/api/') && !security.authenticated(req)) return send(res, 401, { error: '請先登入' });
  if (p === '/api/auth/logout' && req.method === 'POST') {
    if (!security.jsonRequest(req) || !security.checkOrigin(req)) return send(res, 403, { error: '拒絕' });
    const all = security.authenticated(req) && (await readBody(req)).all === true;
    res.setHeader('Set-Cookie', all ? security.logoutAll(req) : security.logout(req));
    return send(res, 200, { ok: true });
  }
  if (p.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      p !== '/api/upload' && !security.jsonRequest(req))
    return send(res, 415, { error: '只接受 application/json' });

  let m0;
  try {
    if (p === '/api/info') return send(res, 200, { version: VERSION, started: STARTED_AT });

    // ---- 🐞 問題回報 ----
    if (p === '/api/diag/client-error' && req.method === 'POST') { reporter.clientError(await readBody(req), req.headers['user-agent']); return send(res, 200, { ok: true }); }
    if (p === '/api/diag/report' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await reporter.makeReport({ description: String(body.description || '').slice(0, 4000), agentId: body.agentId || '', taskId: Number(body.taskId) || null,
        includeChat: body.includeChat === true, uiVersion: String(body.uiVersion || ''), userAgent: req.headers['user-agent'], via: '網頁' });
      return send(res, 200, { name: r.name, size: r.size, path: r.file });
    }
    if (p === '/api/diag/reports' && req.method === 'GET') return send(res, 200, { dir: reporter.REP_DIR, reports: reporter.listReports() });
    if ((m0 = p.match(/^\/api\/diag\/reports\/([\w.-]+)$/)) && req.method === 'GET') {
      const f = reporter.reportPath(m0[1]);
      if (!f) return send(res, 404, { error: '找不到這份回報' });
      res.setHeader('Content-Disposition', 'attachment; filename="' + m0[1] + '"');
      return send(res, 200, fs.readFileSync(f), 'text/markdown; charset=utf-8');
    }

    // ---- ⬆️ 更新與重新啟動 ----
    if (p === '/api/update' && req.method === 'GET') return send(res, 200, { ...updater.status(), busy: [...runs.keys()].map((id) => (agentById(id) || {}).name || id), tasks: tasks.actives().length });
    if (p === '/api/update/check' && req.method === 'POST') return send(res, 200, await updater.check());
    if (p === '/api/update/failed' && req.method === 'DELETE') { updater.clearFailed(); return send(res, 200, { ok: true }); }
    if (p === '/api/update' && req.method === 'POST') {
      try {
        const r = await updater.update('網頁');
        if (r.upToDate) return send(res, 200, r);
        try { updater.restart(); } catch (e) { return send(res, 200, { ...r, restarting: false, note: e.message }); }
        return send(res, 200, { ...r, restarting: true });
      } catch (e) { return send(res, 409, { error: e.message }); }
    }
    if (p === '/api/restart' && req.method === 'POST') {
      try { updater.restart(); } catch (e) { return send(res, 409, { error: e.message }); }
      return send(res, 200, { restarting: true });
    }
    if (p === '/api/agents' && req.method === 'GET') return send(res, 200, AGENTS.map(publicAgent));

    // ---- Telegram 設定（網頁上貼 token、產生配對碼）----
    if (p === '/api/telegram' && req.method === 'GET') return send(res, 200, telegram.status());
    if (p === '/api/telegram' && req.method === 'PUT') {
      const body = await readBody(req);
      const t = (CONFIG.telegram = CONFIG.telegram || { allowedUserIds: [] });
      if (typeof body.botToken === 'string' && body.botToken.trim()) {
        const tok = body.botToken.trim();
        if (!/^\d+:[\w-]{20,}$/.test(tok)) return send(res, 400, { error: 'bot token 格式不對，應該像 123456789:ABC… 這樣' });
        if (tok !== t.botToken) {
          t.allowedUserIds = []; // 換了 bot，原本的配對作廢
          if (state.telegram) state.telegram.chats = {};
          saveState();
        }
        t.botToken = tok;
      }
      if (typeof body.enabled === 'boolean') t.enabled = body.enabled;
      if (body.defaultAgent && agentById(body.defaultAgent)) t.defaultAgent = body.defaultAgent;
      if (!Array.isArray(t.allowedUserIds)) t.allowedUserIds = [];
      saveConfig();
      telegram.start(tgCtx); telegram.startAgentBots(tgCtx);
      return send(res, 200, telegram.status());
    }
    if (p === '/api/telegram/pair' && req.method === 'POST') return send(res, 200, { pairing: telegram.newPairCode() });
    if (p === '/api/telegram/clear' && req.method === 'POST') {
      if (CONFIG.telegram) CONFIG.telegram.allowedUserIds = [];
      if (state.telegram) state.telegram.chats = {};
      saveConfig(); saveState(); broadcast({ agentId: '*', kind: 'telegram' });
      return send(res, 200, telegram.status());
    }
    // ---- 診斷 ----
    if ((m0 = p.match(/^\/api\/diag\/([\w-]+)$/)) && req.method === 'GET') return send(res, 200, diag(m0[1]));
    if ((m0 = p.match(/^\/api\/queue\/([\w-]+)\/clear$/)) && req.method === 'POST') {
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].agentId === m0[1]) pending.splice(i, 1);
      broadcast({ agentId: '*', kind: 'queue' });
      return send(res, 200, { ok: true });
    }
    // ---- 插話 ----
    if ((m0 = p.match(/^\/api\/interject\/([\w-]+)$/)) && req.method === 'POST') {
      const agent = agentById(m0[1]);
      if (!agent) return send(res, 404, { error: '找不到成員' });
      const { text } = await readBody(req);
      if (!String(text || '').trim()) return send(res, 400, { error: '訊息是空的' });
      return send(res, 200, { ok: true, result: interject(agent, String(text), 'web') });
    }
    // ---- 任務 ----
    if (p === '/api/tasks' && req.method === 'GET') return send(res, 200, { active: tasks.active() || null, actives: tasks.actives(), tasks: tasks.list() });
    if (p === '/api/tasks' && req.method === 'POST') {
      const { goal, teamId } = await readBody(req);
      try { const t = tasks.start(goal, 'web', teamId); return send(res, 200, { ok: true, id: t.id }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if ((m0 = p.match(/^\/api\/tasks\/(\d+)$/)) && req.method === 'GET') {
      const d = tasks.detail(m0[1]); return d ? send(res, 200, d) : send(res, 404, { error: '找不到任務' });
    }
    if ((m0 = p.match(/^\/api\/tasks\/(\d+)\/(approve|reject|reply|stop|note)$/)) && req.method === 'POST') {
      const body = await readBody(req);
      try {
        if (m0[2] === 'approve') tasks.approve(m0[1], body.note);
        else if (m0[2] === 'reject') tasks.reject(m0[1], body.feedback);
        else if (m0[2] === 'reply') { if (!String(body.text || '').trim()) throw new Error('訊息是空的'); tasks.reply(m0[1], body.text, 'web'); }
        else if (m0[2] === 'note') { if (!String(body.text || '').trim()) throw new Error('訊息是空的'); tasks.addNote(m0[1], body.text, 'web'); }
        else tasks.stop(m0[1]);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    // ---- Harness：守則、守則建議、專案記憶、觀測紀錄 ----
    if (p === '/api/harness' && req.method === 'GET') return send(res, 200, { ...harness.snapshot(), stats: harness.stats(url.searchParams.get('days') || 7) });
    if (p.startsWith('/api/harness/') && req.method !== 'GET') {
      const body = req.method === 'DELETE' ? {} : await readBody(req);
      try {
        if (p === '/api/harness/guides' && req.method === 'POST') return send(res, 200, harness.addGuide(body.text, body.scope, 'user'));
        if ((m0 = p.match(/^\/api\/harness\/guides\/(\d+)$/))) {
          if (req.method === 'PUT') return send(res, 200, harness.updateGuide(m0[1], { text: body.text, scope: body.scope, pinned: body.pinned, off: body.off }));
          if (req.method === 'DELETE') { harness.deleteGuide(m0[1]); return send(res, 200, { ok: true }); }
        }
        if ((m0 = p.match(/^\/api\/harness\/proposals\/(\d+)\/accept$/)) && req.method === 'POST') return send(res, 200, harness.acceptProposal(m0[1], body.text, body.scope));
        if ((m0 = p.match(/^\/api\/harness\/proposals\/(\d+)$/)) && req.method === 'DELETE') { harness.dismissProposal(m0[1]); return send(res, 200, { ok: true }); }
        if (p === '/api/harness/memory' && req.method === 'POST') return send(res, 200, harness.addMemory('note', body.text, null, null, body.team || ''));
        if ((m0 = p.match(/^\/api\/harness\/memory\/(\d+)$/)) && req.method === 'DELETE') { harness.deleteMemory(m0[1]); return send(res, 200, { ok: true }); }
      } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 404, { error: '找不到' });
    }
    if ((m0 = p.match(/^\/api\/shift\/([\w-]+)$/)) && req.method === 'POST') {
      const a = agentById(m0[1]); if (!a) return send(res, 404, { error: '找不到這位成員' });
      const err = manualShift(a);
      return err ? send(res, 409, { error: err }) : send(res, 200, { ok: true });
    }
    if ((m0 = p.match(/^\/api\/audit\/([\w-]+)$/)) && req.method === 'GET') {
      if (!agentById(m0[1])) return send(res, 404, { error: '找不到這位成員' });
      return send(res, 200, { records: readAudit(m0[1], Math.min(200, Number(url.searchParams.get('limit')) || 50)) });
    }
    if (p === '/api/usage' && req.method === 'GET') return send(res, 200, usageSnapshot());
    if (p === '/api/usage/refresh' && req.method === 'POST') { probeUsage(); return send(res, 200, { ok: true }); }
    if (p === '/api/config' && req.method === 'GET') {
      return send(res, 200, {
        agents: CONFIG.agents.map(maskAgent), teams: CONFIG.teams.map((t) => ({ ...t, sharedWith: sharedWith(t) })), workflow: CONFIG.teams[0].workflow, maxRelayHops: maxHops(), approveWritableHandoffs: CONFIG.approveWritableHandoffs === true,
        harness: harness.cfg(),
        options: { engines: ENGINES, efforts: EFFORTS, permissionModes: PERMISSION_MODES, sandboxes: SANDBOXES },
      });
    }
    if (p === '/api/agents' && req.method === 'POST') {
      const body = await readBody(req);
      let a;
      try { a = cleanAgent(body, newAgentId()); } catch (e) { return send(res, 400, { error: e.message }); }
      CONFIG.agents.push(a);
      saveConfig(); reloadAgents(); harness.docs(); agentsChanged();
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
        for (let i = pending.length - 1; i >= 0; i--) if (pending[i].agentId === m0[1]) pending.splice(i, 1);
        normalizeTeams();
      } else {
        const body = await readBody(req);
        let a;
        try { a = cleanAgent(body, m0[1]); } catch (e) { return send(res, 400, { error: e.message }); }
        const old = CONFIG.agents[idx];
        if (old.team && (a.standalone || a.team !== old.team)) {
          const t = teamById(old.team), owned = t ? t.workflow.stages.filter((st) => st.owner === a.id) : [];
          if (owned.length) return send(res, 400, { error: '「' + a.name + '」是「' + t.name + '」工作流程「' + owned.map((x) => x.name).join('、') + '」的負責人，請先到「⚙️ 工作流程」換人，再' + (a.standalone ? '改成獨立成員' : '換小組') });
        }
        if (!sameDir(old.cwd || './workspace', a.cwd)) {
          if (runs.has(a.id)) return send(res, 409, { error: '這位成員還在工作，先停止再換工作資料夾' });
          dropSessions(a.id);
        }
        CONFIG.agents[idx] = a;
        normalizeTeams();
      }
      saveConfig(); reloadAgents(); tasks.writeWorkflowDocs(); harness.docs(); agentsChanged(); pump();
      return send(res, 200, { ok: true });
    }
    // 附件：拖曳到對話框的檔案，存到該成員工作資料夾的 attachments/
    if (p === '/api/upload' && req.method === 'POST') {
      const agent = agentById(url.searchParams.get('agent'));
      if (!agent) return send(res, 404, { error: '找不到成員' });
      let name = path.basename(String(url.searchParams.get('name') || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(-120) || 'file';
      if (/^\.+$/.test(name)) name = 'file';
      const chunks = []; let size = 0, tooBig = false;
      await new Promise((resolve) => {
        req.on('data', (c) => { size += c.length; if (size > 25 * 1024 * 1024) { tooBig = true; req.destroy(); resolve(); } else chunks.push(c); });
        req.on('end', resolve); req.on('error', resolve);
      });
      if (tooBig) return send(res, 413, { error: '檔案太大（上限 25MB）' });
      const dir = path.join(agent.cwd, 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
      let final = name;
      for (let i = 2; fs.existsSync(path.join(dir, final)); i++) final = base + '-' + i + ext;
      fs.writeFileSync(path.join(dir, final), Buffer.concat(chunks));
      return send(res, 200, { ok: true, path: 'attachments/' + final, size, agent: agent.id });
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
    // ---- 小組 ----
    if (p === '/api/teams' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 20);
      if (!name) return send(res, 400, { error: '請輸入小組名稱' });
      if (CONFIG.teams.some((t) => t.name === name)) return send(res, 400, { error: '已經有叫「' + name + '」的小組' });
      if (CONFIG.teams.length >= 12) return send(res, 400, { error: '小組最多 12 個' });
      let id; do { id = 't' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4); } while (teamById(id));
      let cwd;
      try { cwd = cleanTeamCwd(body.cwd || './workspace/' + id); } catch (e) { return send(res, 400, { error: e.message }); }
      CONFIG.teams.push({ id, name, icon: [...String(body.icon || '🏢')].slice(0, 2).join('') || '🏢', cwd, workflow: taskLib.normalizeWorkflow(null, []) });
      saveConfig(); agentsChanged();
      return send(res, 200, { ok: true, id });
    }
    if ((m0 = p.match(/^\/api\/teams\/([\w-]+)$/)) && req.method === 'DELETE') {
      const t = teamById(m0[1]); if (!t) return send(res, 404, { error: '找不到這個小組' });
      if (CONFIG.teams.length <= 1) return send(res, 400, { error: '至少要留一個小組' });
      if (teamMembers(t.id).length) return send(res, 400, { error: '小組裡還有成員，請先把成員移到其他小組或刪除' });
      if (tasks.activeOf(t.id)) return send(res, 400, { error: '這個小組還有進行中的任務' });
      CONFIG.teams = CONFIG.teams.filter((x) => x.id !== t.id);
      saveConfig(); agentsChanged();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/team' && req.method === 'PUT') {
      const body = await readBody(req);
      const team = teamById(body.teamId) || CONFIG.teams[0];
      if (body.teamId && team.id !== body.teamId) return send(res, 404, { error: '找不到這個小組' });
      if (typeof body.name === 'string' && body.name.trim()) {
        const n = body.name.trim().slice(0, 20);
        if (CONFIG.teams.some((t) => t !== team && t.name === n)) return send(res, 400, { error: '已經有叫「' + n + '」的小組' });
        team.name = n;
      }
      if (typeof body.icon === 'string' && body.icon.trim()) team.icon = [...body.icon.trim()].slice(0, 2).join('');
      if (typeof body.cwd === 'string') {
        let cwd;
        try { cwd = cleanTeamCwd(body.cwd); } catch (e) { return send(res, 400, { error: e.message }); }
        const moving = body.moveMembers === true && cwd ? teamMembers(team.id).filter((a) => !sameDir(a.cwd || './workspace', cwd)) : [];
        if (moving.length) {
          const busy = moving.filter((a) => runs.has(a.id)).map((a) => a.name);
          if (busy.length) return send(res, 409, { error: busy.join('、') + ' 還在工作，先停止再搬資料夾' });
          if (tasks.activeOf(team.id)) return send(res, 409, { error: '這個小組還有進行中的任務，任務結束後再搬資料夾' });
        }
        if (cwd) team.cwd = cwd; else delete team.cwd;
        for (const a of moving) { a.cwd = cwd; dropSessions(a.id); }
        if (moving.length) reloadAgents();
      }
      if (body.workflow && typeof body.workflow === 'object') team.workflow = taskLib.cleanWorkflow(body.workflow, teamMembers(team.id));
      const h = Math.round(Number(body.maxRelayHops));
      if (h >= 1 && h <= 50) CONFIG.maxRelayHops = h;
      if (typeof body.approveWritableHandoffs === 'boolean') team.approveWritableHandoffs = body.approveWritableHandoffs;
      if (body.harness && typeof body.harness === 'object') {
        const hc = CONFIG.harness = CONFIG.harness || {};
        const num = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
        const r = num(body.harness.maxReworks, 1, 20); if (r != null) hc.maxReworks = r;
        const mm = num(body.harness.maxTaskMinutes, 0, 1440); if (mm != null) hc.maxTaskMinutes = mm;
        const ct = num(body.harness.checkTimeoutSec, 10, 3600); if (ct != null) hc.checkTimeoutSec = ct;
        const sp = num(body.harness.shiftPercent, 0, 95); if (sp != null) hc.shiftPercent = sp;
        const gc = num(body.harness.guideChars, 200, 8000); if (gc != null) hc.guideChars = gc;
      }
      if (Array.isArray(body.takeTurns)) {
        for (const x of teamMembers(team.id)) { if (body.takeTurns.includes(x.id)) x.takeTurns = true; else delete x.takeTurns; }
        reloadAgents();
      }
      saveConfig(); tasks.workflowSaved(team.id); harness.docs(); agentsChanged(); pump();
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
      const client = { req, res };
      clients.add(client);
      const ping = setInterval(() => {
        if (!security.authenticated(req)) { clearInterval(ping); clients.delete(client); res.end(); }
        else res.write(': ping\n\n');
      }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(client); });
      return;
    }

    let m;
    if ((m = p.match(/^\/api\/history\/([\w-]+)$/))) {
      const run = runs.get(m[1]);
      return send(res, 200, { history: loadHistory(m[1]), live: run ? run.segments : null, queue: queueInfo(m[1]) });
    }
    if ((m = p.match(/^\/api\/chat\/([\w-]+)$/)) && req.method === 'POST') {
      const agent = agentById(m[1]);
      if (!agent) return send(res, 404, { error: '找不到這個 agent' });
      const { text } = await readBody(req);
      if (!text || !String(text).trim()) return send(res, 400, { error: '訊息是空的' });
      const queued = mustWait(agent);
      const cc = userSend(agent, String(text));
      return send(res, 200, { ok: true, queued, cc: cc.map((a) => a.name) });
    }
    if (p === '/api/stopall' && req.method === 'POST') {
      for (const t of tasks.actives()) { try { tasks.stop(t.id); } catch {} }
      pending.length = 0;
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
      let target;
      try { target = security.fileWithin(agent.cwd, url.searchParams.get('p') || ''); }
      catch { return send(res, 403, { error: '檔案不可讀取或超出工作目錄' }); }
      const ext = path.extname(target).toLowerCase();
      const inline = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.mp3', '.wav', '.txt', '.md'].includes(ext);
      res.setHeader('Content-Security-Policy', 'sandbox');
      if (!inline) res.setHeader('Content-Disposition', 'attachment');
      return sendFile(res, target);
    }

    // 靜態檔
    const pubRoot = path.join(ROOT, 'public');
    const file = path.resolve(pubRoot, '.' + (p === '/' ? '/index.html' : p));
    if (!inside(pubRoot, file)) return send(res, 403, 'forbidden', 'text/plain');
    return sendFile(res, file);
  } catch (e) {
    if (!e.status) console.error('API 錯誤 ' + req.method + ' ' + p + '：', e);
    return send(res, e.status || 500, { error: e.status ? e.message : '內部錯誤，請查看伺服器日誌' });
  }
});

// 重新啟動時舊的程序可能還沒放開連接埠：等一下再試（最多 10 秒）
let listenTries = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && process.env.AGENTCHAT_LAUNCHER === '1' && listenTries++ < 20) { setTimeout(() => server.listen(PORT, HOST), 500); return; }
  console.error('伺服器無法啟動：' + e.message + (e.code === 'EADDRINUSE' ? '（連接埠 ' + PORT + ' 已被佔用，可能舊的視窗還開著）' : ''));
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  updater.afterStart((n, failed) => hooks.emit('restarted', { ...n, version: VERSION, failed }));
  // 背景檢查更新：啟動 1 分鐘後一次，之後每 6 小時（只 fetch，不會自己更新）
  if (process.env.AGENTCHAT_NO_UPDATE_CHECK !== '1') {
    const bg = () => updater.check().then((c) => { if (c.ok && c.behind) broadcast({ agentId: '*', kind: 'update-available', version: c.remoteVersion }); }).catch(() => {});
    setTimeout(bg, 60000).unref(); setInterval(bg, 6 * 3600000).unref();
  }
  console.log('✅ Agent Chat v' + VERSION + ' 已啟動： http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  for (const a of AGENTS) console.log('   ' + (a.avatar && !a.avatar.startsWith('img:') ? a.avatar : '•') + ' ' + a.name + '（' + [a.engine, a.model || '預設模型', a.effort].filter(Boolean).join(' · ') + '） → ' + a.cwd);
  for (const [k, v] of Object.entries(BIN)) console.log('   ' + (v ? '✔ ' + k + '：' + v : '✘ 找不到 ' + k + '（這個引擎的 agent 會無法回覆）'));
});

// Telegram 遙控（agents.json 有設定 telegram.botToken 才會啟動）
const telegram = require('./telegram');
const tgCtx = {
  config: CONFIG, agents: AGENTS, agentById, hooks, runs, state, saveState, saveConfig, broadcast,
  dispatch, userSend, stopRun, resetAgent, maxHops, usageSnapshot, tasks, interject,
  makeReport: (o) => reporter.makeReport(o), updater,
};
telegram.start(tgCtx);
telegram.startAgentBots(tgCtx);

// code 75 = 請啟動器重新啟動（一鍵更新／重啟）
const shutdown = (code) => {
  const had = runs.size;
  for (const id of runs.keys()) stopRun(id);
  const exit = () => process.exit(typeof code === 'number' ? code : 0);
  if (had) setTimeout(exit, 800); else exit();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
