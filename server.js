// Agent Chat — 把 Claude Code 與 Codex CLI 包成聊天介面
// 不需要 npm install，只要 Node.js 18 以上。啟動：node server.js
'use strict';
const VERSION = '3.20.2';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const EventEmitter = require('events');
const hooks = new EventEmitter(); // 給 Telegram 等外掛監聽：user / done / task
const taskLib = require('./tasks');
const agy = require('./agy');
const cliStatusLib = require('./clistatus');
const skillsLib = require('./skills');
const lineLib = require('./line');
const todoLib = require('./todo');
const harnessLib = require('./harness');
const { createSecurity, inside, isProtectedEnvKey } = require('./security');

const ROOT = __dirname;
// 你自己的設定（local-settings.txt）：要在讀 PORT、HOST、AGENT_ALLOWED_ROOTS 之前載入
const LOCAL = require('./localsettings').load(ROOT);
const proctree = require('./proctree'); // 關子程式時連整串一起關，不留殘留的 CLI
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
    path.join(home, '.gemini', 'bin', name + '.exe'), // Google Antigravity CLI（agy）
    path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', name + '.exe'), // Google Antigravity CLI（agy）Windows 安裝位置
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
  agy: resolveBin('agy', 'AGY_BIN'),
};
// ---------- 🗜 rtk：壓縮 Claude 成員的指令輸出（只限 Claude 成員）----------
// rtk 要另外裝在電腦上（winget install rtk-ai.rtk）。不改你的全域 ~/.claude/settings.json：
// 只有勾了「壓縮指令輸出」的 Claude 成員，啟動時用 --settings 額外接上 hook；hook 經過 rtkhook.js，
// 只採用 rtk 的指令改寫，不讓它自動核准指令（權限仍由 Claude 與 Agent Chat 的設定決定）。
const RTK = { bin: null, at: 0, version: null };
function rtkBin(force) {
  if (process.env.RTK_BIN) return process.env.RTK_BIN;
  if (RTK.bin && fs.existsSync(RTK.bin)) return RTK.bin;
  if (!force && RTK.at && Date.now() - RTK.at < 300000) return RTK.bin; // 找不到時 5 分鐘內不重找（找一次可能要好幾秒）
  RTK.at = Date.now(); RTK.bin = null; RTK.version = null;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cands = IS_WIN
    ? [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'rtk.exe'), path.join(home, '.cargo', 'bin', 'rtk.exe'), path.join(home, '.local', 'bin', 'rtk.exe')]
    : [path.join(home, '.cargo', 'bin', 'rtk'), path.join(home, '.local', 'bin', 'rtk'), '/opt/homebrew/bin/rtk', '/usr/local/bin/rtk'];
  RTK.bin = cands.find((c) => c && fs.existsSync(c)) || null;
  if (!RTK.bin) {
    try {
      const out = execFileSync(IS_WIN ? 'where' : 'which', ['rtk'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
        .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      RTK.bin = (IS_WIN ? out.find((f) => /\.exe$/i.test(f)) : out[0]) || null;
    } catch {}
  }
  return RTK.bin;
}
// 這位成員實際會不會用 rtk：Claude、不是獨立成員、沒有限制工具（獨立成員的最小權限不受任何 hook 影響）
const rtkWanted = (a) => !!a && a.engine === 'claude' && !!a.rtk && !a.standalone && !a.tools && !(a.allowedTools || []).length;
function rtkSettingsFile(bin) {
  const fwd = (x) => String(x).replace(/\\/g, '/');
  const command = '"' + fwd(process.execPath) + '" "' + fwd(path.join(ROOT, 'rtkhook.js')) + '" "' + fwd(bin) + '"';
  const json = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 15 }] }] } }, null, 2);
  const file = path.join(DATA_DIR, 'rtk-claude-settings.json');
  let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  if (cur !== json) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, json); }
  return file;
}
// 你自己有沒有用 rtk init -g 裝過全域的 hook（那樣你所有的 Claude 都會被壓縮）
function rtkGlobalHook() {
  try {
    const t = fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude', 'settings.json'), 'utf8');
    return /rtk hook claude|rtk-rewrite/.test(t);
  } catch { return false; }
}
function rtkRun(args, timeout = 10000) {
  const bin = rtkBin(); if (!bin) return null;
  try {
    return execFileSync(bin, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout, env: { ...process.env, NO_COLOR: '1' } })
      .replace(/\x1b\[[0-9;]*m/g, '').trim();
  } catch (e) { return e.stdout ? String(e.stdout).replace(/\x1b\[[0-9;]*m/g, '').trim() : null; }
}
function rtkStatus(withGain) {
  const bin = rtkBin(true);
  if (bin && !RTK.version) RTK.version = rtkRun(['--version'], 5000);
  return { bin, version: bin ? RTK.version : null, global: rtkGlobalHook(),
    members: AGENTS.filter((a) => a.rtk).map((a) => ({ id: a.id, name: a.name, active: rtkWanted(a), why: a.engine !== 'claude' ? '只限 Claude 成員' : a.standalone ? '獨立成員不使用' : !rtkWanted(a) ? '有限制工具的成員不使用' : '' })),
    gain: withGain && bin ? (rtkRun(['gain'], 15000) || '').slice(0, 4000) : null };
}

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

// 要從回報、紀錄裡遮掉的機密：Telegram bot token、LINE channel secret／access token
function secretList() { const c = CONFIG; return [c.telegram && c.telegram.botToken, c.line && c.line.channelSecret, c.line && c.line.channelAccessToken, c.todo && c.todo.key]; }

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
  localSettings: () => ({ ...LOCAL, missingRoots: security.missingRoots }),
  updateStatus: () => late(() => updater.status()),
  timers: () => late(() => timers.snapshot()),
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
const warned = new Set();
// 依暫停原因給對應的處理方式
function blockedHelp(reason) {
  if (/add-dir 不會強制唯讀/.test(reason))
    return '怎麼處理：到這位成員的「⚙️ 設定」→ 額外資料夾，把這個資料夾改成「可讀寫」後儲存（如果是副本資料夾通常沒關係）；需要真的唯讀的話，改用 Codex 成員讀它，或在 Windows 資料夾內容的「安全性」設成唯讀。';
  if (/不在核准的工作根目錄內|不存在，先略過/.test(reason))
    return '怎麼處理：在程式資料夾的 local-settings.txt 加一行 AGENT_ALLOWED_ROOTS=那個資料夾（或它的上層），再按左下角「⬆️ 更新／重新啟動」→「🔄 只重新啟動」。';
  if (/唯讀限制沒有擋住/.test(reason))
    return '怎麼處理：先確認資料夾裡被改的檔案；沒問題的話，到這位成員的「⚙️ 設定」按儲存就會解除暫停。要讓它改檔案，請把存取等級改成「可寫入」。';
  if (/完整權限模式/.test(reason))
    return '怎麼處理：到這位成員的「⚙️ 設定」把權限改成 auto、acceptEdits 或 Codex 的 workspace-write。';
  return '怎麼處理：到這位成員的「⚙️ 設定」修改，或按左下角「🐞 問題回報」把檔案給 Claude 看。';
}
const prepAgent = (a) => {
  try {
    const cwd = security.assertAllowedDir(a.cwd || './workspace');
    security.checkAgent({ ...a, cwd });
    fs.mkdirSync(cwd, { recursive: true });
    return { ...a, cwd };
  } catch (e) {
    const msg = '⛔ 成員「' + a.name + '」的設定不符合安全規則，已暫停使用：' + e.message;
    if (!warned.has(msg)) { warned.add(msg); console.error(msg); }
    return { ...a, cwd: path.resolve(ROOT, 'workspace'), blocked: e.message };
  }
};
// agy 可寫成員的工作資料夾在 Agent Chat 程式資料夾裡面：它會執行指令，範圍限制還沒確認，可能動到程式本身與 agents.json
function insideApp(dir) {
  const rel = path.relative(ROOT, path.resolve(ROOT, String(dir || '')));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function agyWriteRisk(a) {
  if (!a || a.engine !== 'agy' || agy.access(a) !== 'write') return null;
  const dirs = [a.cwd || './workspace', ...(a.extraDirs || []).filter((d) => d.mode !== 'ro').map((d) => d.path)].filter(insideApp);
  return dirs.length ? '這位 agy 可寫成員會執行指令，而它的資料夾（' + dirs.join('、') + '）在 Agent Chat 程式資料夾（' + ROOT + '）裡面。agy 能不能被限制在資料夾內還沒確認，它可能動到 Agent Chat 本身或 agents.json。建議把工作資料夾改到 Agent Chat 外面（同小組成員一起改），或先改用 read 等級。' : null;
}
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

const pending = [];     // 排隊中的訊息：{ agentId, text, opts }（存在 state.queue，程式重新啟動後會接著排）
let queueFrozen = false; // 關閉程式時：先把排隊內容存好，之後不再被「停止」清掉
let state = { sessions: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
const saveState = () => {
  if (!queueFrozen) state.queue = pending.map((x) => ({ agentId: x.agentId, text: x.text, opts: x.opts }));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};
state.ctx = state.ctx || {};       // 每段對話（session）目前大約用了多少 context：{ tokens, window, at }
state.shifts = state.shifts || {}; // 換班：{ n: 第幾班, due: 下一輪前要換班, note: 交班筆記, pendingNote: 新的一班還沒讀到筆記 }
state.lastKey = state.lastKey || {}; // 每位成員最近一次用的是哪一段對話
state.agyQuota = state.agyQuota || {}; // agy 額度用完：{ [成員 id]: { at, until, estimated, msg, notified: [已通知的派工者] } }
state.agyUsage = state.agyUsage || {}; // agy 本週用量：{ [成員 id]: { week: 週一 0 點, runs, tokens, quotaHits, lastQuotaAt } }
state.cliSeen = state.cliSeen || {}; // 🧰 每個 CLI 最近一次成員執行的結果：{ claude|codex|agy: { ok, at, login, err } }
state.hdr = state.hdr || {};       // 開頭說明去重：每段對話最近完整送過的版本 { hash, n: 之後省略了幾輪, saved: 累計少送的字數 }
state.pause = state.pause || {};   // ⏸ 專案暫停：範圍（'all' 或小組 id）→ { at, reason, mode, phase, restart: [被中途停下的工作], notes: 份數 }
for (const k of Object.keys(state.pause)) if (state.pause[k].phase === 'pausing') state.pause[k].phase = 'paused'; // 重新啟動時正在跑的都已經停了
if (Array.isArray(state.queue)) for (const q of state.queue) if (q && q.agentId && q.opts) pending.push(q);

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
// 排隊中的訊息 pending 定義在 state 旁邊（要跟著存檔）

// 這位成員可以 @ 誰（自由聊天模式）：有設定 canHandoffTo 就照設定，沒設定就是全部同事
function allowedTargets(agent) {
  if (agent.standalone) return [];
  const others = AGENTS.filter((a) => a.id !== agent.id && !a.standalone && a.team === agent.team); // 只在同一個小組內轉交；獨立成員不參與
  return Array.isArray(agent.canHandoffTo) ? others.filter((a) => agent.canHandoffTo.includes(a.id)) : others;
}

// 成員可以存取的資料夾（每一輪都告訴它）
// 待辦管家：把待辦清單附在訊息裡，寫入由系統代做（模型不能讀寫檔、不能執行指令）。LINE 群組指定的成員自動算；也可以在成員設定勾選
let lineBotRef = null; // 建好 lineBot 之後才有值
const isTodoKeeper = (a) => { if (!a) return false; if (a.todoKeeper === true) return true; const g = lineBotRef && lineBotRef.groupAgent(); return !!g && g.id === a.id; };
function accessText(agent) {
  const base = accessBase(agent) + (rtkWanted(agent) && rtkBin() ? '\n【指令輸出精簡】你在 Bash 執行的常見指令（git、測試、建置、列出檔案等）輸出會先經過 rtk 精簡。如果需要完整的原始輸出才能判斷，請在回覆中說明，使用者可以暫時關掉這個選項。' : '');
  return agent.engine === 'agy' ? base + '\n' + (agy.access(agent) === 'read' ? (isTodoKeeper(agent) || agent.brief ? agy.NO_FILES_NOTE : agy.READ_ONLY_NOTE) : agy.WRITE_NOTE) : base;
}
function accessBase(agent) {
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
  const uh = urgentHint(agent);
  if (uh && others.length) L.push('', uh);
  return L.join('\n');
}

// 開頭說明（身分、團隊、守則、記憶…）每一輪都一樣，重複送會讓 CLI 的對話紀錄越堆越長。
// 同一段對話內容沒變，就只送一行提示；第一輪、內容有變、或每 N 輪（避免被 CLI 自動壓縮掉）才完整送。
const headerRefresh = () => { const n = Number(harness.cfg().headerRefresh); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10; };
const HEADER_SAME = '【說明沒有變動】你的身分、團隊成員、交接規則、守則與記憶，都和這段對話開頭給你的那一份完全相同，請照那一份做。';
function fullHeader(agent, opts) { return (opts.taskId ? tasks.promptHeader(agent, opts) : freeHeader(agent)) + '\n' + timers.promptHint(); }
function dedupHeader(agent, opts, key) {
  const full = fullHeader(agent, opts), every = headerRefresh();
  const hash = require('crypto').createHash('sha1').update(full).digest('hex').slice(0, 12);
  const h = state.hdr[key];
  if (every > 0 && state.sessions[key] && h && h.hash === hash && h.n < every - 1 && full.length > HEADER_SAME.length * 2) {
    h.n++; h.saved = (h.saved || 0) + full.length - HEADER_SAME.length; h.skipped = (h.skipped || 0) + 1;
    return HEADER_SAME;
  }
  state.hdr[key] = { hash, n: 0, saved: h ? h.saved || 0 : 0, skipped: h ? h.skipped || 0 : 0, chars: full.length, at: Date.now() };
  return full;
}
function buildPrompt(agent, text, opts = {}) {
  const key0 = sessionKey(agent, opts);
  const header = dedupHeader(agent, opts, key0);
  let body;
  const fromAgent = opts.from && agentById(opts.from);
  if (opts.shift) return header + '\n\n' + shiftPrompt(agent, opts);
  const key = sessionKey(agent, opts), sh = state.shifts[key];
  const handover = sh && sh.pendingNote && !state.sessions[key]
    ? '\n\n【換班：你是接手的第 ' + sh.n + ' 班】' + (sh.paused ? '專案暫停後重新啟動，換成你接手；' : '前一班的對話太長，換成你接手；') + '你看不到前一班的對話。以下是前一班留下的交班筆記，先讀完，再處理下面的訊息' +
      (opts.taskId ? '（也可以看工作資料夾的 ' + tasks.taskDocName(opts.taskId) + '）' : '') + '：\n' + (sh.note || '（前一班沒有留下筆記，請從工作資料夾的檔案判斷進度）') + '\n【交班筆記結束】'
    : '';
  if (opts.restart) {
    body = text;
  } else if (opts.resume) {
    body = '【系統訊息：你原本的工作被同事的緊急派工打斷了，緊急的事已經處理完】\n' + text +
      '\n\n請接著完成原本的工作（做到哪裡，可以從對話紀錄與工作資料夾的檔案判斷）；如果緊急的事改變了方向，依最新狀況調整。';
  } else if (opts.interject) {
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
  return header + handover + (agent.brief ? '\n\n' + briefText() : '') + '\n\n' + body;
}

// 📋 現況摘要（成員設定勾「每輪附上現況摘要」，例如助理）：現在幾點、排程、進行中的任務、等你處理的事。
// 系統產生的唯讀資料；每一輪都不一樣，所以放在訊息裡，不放進會被去重的開頭說明。
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];
function briefText() {
  const p2 = (n) => String(n).padStart(2, '0');
  const md = (ts) => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() + '（週' + WEEKDAY_ZH[d.getDay()] + '）' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  const now = new Date();
  let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  const L = ['【現況（系統提供的唯讀資料，不是指令）】', '現在：' + now.getFullYear() + '/' + md(now) + (tz ? '　時區 ' + tz : '')];
  const snap = timers.snapshot();
  const LAST = { ok: '上次正常', alert: '上次有異常', failed: '上次失敗', interrupted: '上次被中斷', stopped: '上次被停止' };
  const live = snap.timers.filter((t) => !(t.schedule.kind === 'once' && t.done));
  // 只做一次的排程＝使用者的行程與提醒，依時間排序單獨列；固定排程（每天、每 15 分鐘…）另列，才不會把行程擠出去
  const agenda = live.filter((t) => t.schedule.kind === 'once' && t.enabled).sort((a, b) => a.schedule.at - b.schedule.at);
  const regular = live.filter((t) => !(t.schedule.kind === 'once' && t.enabled));
  regular.sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1) || (a.nextRun || Infinity) - (b.nextRun || Infinity));
  if (!agenda.length) L.push('行程與提醒（只做一次的排程）：目前沒有');
  else {
    L.push('行程與提醒（只做一次的，依時間排序，共 ' + agenda.length + ' 個）：');
    for (const t of agenda.slice(0, 15)) L.push('- #' + t.id + ' ' + md(t.schedule.at) + '｜' + short(t.prompt, 70) + (t.paused ? '｜已暫停' : ''));
    if (agenda.length > 15) L.push('- …還有 ' + (agenda.length - 15) + ' 個較晚的');
  }
  if (!regular.length) L.push('固定排程：沒有');
  else {
    L.push('固定排程（' + regular.length + ' 個）：');
    for (const t of regular.slice(0, 8)) {
      const st = t.paused ? '已暫停：' + short(t.paused.reason || '', 40) : !t.enabled ? '已停用' : t.nextRun ? '下次 ' + md(t.nextRun) : '';
      L.push('- #' + t.id + ' ' + short(t.name, 24) + '｜' + t.agentName + '｜' + t.desc + (st ? '｜' + st : '') + (t.last && LAST[t.last.status] ? '｜' + LAST[t.last.status] : ''));
    }
    if (regular.length > 8) L.push('- …還有 ' + (regular.length - 8) + ' 個');
  }
  if (snap.proposals.length) L.push('等你核准的排程建議：' + snap.proposals.length + ' 則（' + snap.proposals.slice(0, 3).map((p) => short(p.name, 16) + '／' + p.desc).join('、') + (snap.proposals.length > 3 ? '…' : '') + '）');
  const act = tasks.actives();
  if (act.length) L.push('進行中的任務：' + act.slice(0, 5).map((t) => '#' + t.id + ' ' + short(t.title || t.goal, 20) + '（' + t.statusText + '）').join('、') + (act.length > 5 ? '…' : ''));
  const wait = [];
  if (harness.pendingCount()) wait.push('守則建議 ' + harness.pendingCount() + ' 則');
  if (skills.pendingCount()) wait.push('Skill 安裝申請 ' + skills.pendingCount() + ' 則');
  if (wait.length) L.push('等你處理：' + wait.join('、'));
  const paused = pauseStatus().pauses;
  if (paused.length) L.push('⏸ 專案暫停中：' + paused.map((x) => x.label + (x.reason ? '（' + short(x.reason, 30) + '）' : '')).join('、'));
  return L.join('\n').slice(0, 2400);
}

// 📏 上下文用量：每位成員「每一輪固定帶的說明」有多大（字數）、省了多少、目前對話用了多少
function contextLoad() {
  return AGENTS.map((a) => {
    let header = 0, guides = 0, memory = 0, persona = 0;
    try { header = fullHeader(a, {}).length; } catch {}
    try { guides = harness.guidesText(a, {}).length; memory = harness.memoryText(a).length; } catch {}
    persona = (a.persona || '').length + (a.personaFile ? personaFileText(a).length : 0);
    const key = state.lastKey[a.id] || a.id, h = state.hdr[key] || {};
    return { id: a.id, name: a.name, header, guides, memory, persona, other: Math.max(0, header - guides - memory - persona),
      saved: h.saved || 0, skipped: h.skipped || 0, ctx: ctxInfo(key, a.engine) };
  });
}

// ---------- 換班：對話太長時，請成員寫交班筆記，再換成全新的一段對話接手 ----------
const CTX_DEFAULT = { claude: 200000, codex: 272000, agy: 1000000 };
function ctxInfo(key, engine) {
  const c = state.ctx[key]; if (!c || !c.tokens) return null;
  const window = c.window || CTX_DEFAULT[engine] || 200000;
  return { tokens: c.tokens, window, pct: Math.min(100, Math.round((c.tokens / window) * 100)), at: c.at };
}
function shiftPrompt(agent, opts) {
  const c = ctxInfo(sessionKey(agent, opts), agent.engine);
  if (opts.pauseNote) {
    const rec = pauseOf(agent);
    return '【系統：專案暫停】使用者暫停了專案' + (rec && rec.reason ? '（原因：' + rec.reason + '）' : '') + '，所有工作先停下。等使用者重啟時，會由一個全新的你接手，新的你看不到這段對話。\n' +
      '請現在只寫一份交班筆記：不要繼續原本的工作、不要修改檔案、不要 @ 任何人、不要寫【交接】區塊。用下面的格式，寫得具體到可以直接照著接手，1500 字以內：\n' +
      '## 目標\n## 已完成\n## 進行中（做到哪、卡在哪；被停下的那一步也要寫）\n## 下一步\n## 重要決定與注意事項（使用者的要求、規格、不能動的東西）\n## 相關檔案';
  }
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
  state.shifts[key] = { n: (prev.n || 1) + 1, note: note ? note.slice(0, 8000) : '', at: Date.now(), pendingNote: true, due: false, ...(run.opts.pauseNote ? { paused: true } : {}) };
  delete state.sessions[key]; delete state.ctx[key];
  saveState();
  try {
    const dir = path.join(DATA_DIR, 'harness', 'shifts'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.md'),
      '\n\n# 第 ' + (prev.n || 1) + ' 班 → 第 ' + state.shifts[key].n + ' 班（' + new Date().toLocaleString('zh-TW', { hour12: false }) + '）\n\n' + (note || '（沒有交班筆記）') + '\n');
  } catch {}
  harness.record({ type: 'shift', agent: agent.id, taskId: run.opts.taskId || null, n: state.shifts[key].n, tokens: c ? c.tokens : null, pct: c ? c.pct : null, manual: !!run.opts.manualShift });
  const t = run.opts.pauseNote ? '⏸ 交班筆記已存好：重啟後由全新的對話接手，會先讀這份筆記'
    : '🔄 換班完成：下一輪起由第 ' + state.shifts[key].n + ' 班（全新的對話）接手，會先讀這份交班筆記';
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
// ---------- 緊急派工：PM 等被授權的成員，可以中斷正在工作的同事 ----------
// 訊息裡寫「【緊急】」才會觸發；只有被授權的成員（成員設定的「可緊急插話」，沒設定時預設是角色有 PM 的成員）有效。
// 防止互相打斷：同一位對象在冷卻時間內只會被插話一次，也不能反過來插話剛插話過自己的人。冷卻時間 0 分鐘＝整個功能關閉。
const URGENT_RE = /【緊急】/;
const urgentCooldownMs = () => { const m = CONFIG.urgentCooldownMin; return (m === undefined || m === null || m === '' ? 5 : Math.max(0, Number(m) || 0)) * 60000; };
const canUrgent = (a) => !!a && !a.standalone && (a.canInterrupt !== undefined ? !!a.canInterrupt : /\bPM\b|專案經理/i.test(a.role || ''));
const urgentHint = (agent) => canUrgent(agent) && urgentCooldownMs() > 0
  ? '【緊急派工】你被授權可以中斷正在工作的同事：在派給他的訊息裡寫「【緊急】」，他會立刻暫停手上的事先處理你的訊息，處理完再回頭做原本的工作。' +
    '只有「方向改變、或他正在做的事會擋住別人／做白工」才用；一般派工不要寫，會排隊等他做完這一輪。同一位同事 ' + urgentCooldownMs() / 60000 + ' 分鐘內只能被緊急插話一次。'
  : '';
const urgentLog = new Map(); // 'from>to' → 上次緊急插話的時間
function tryUrgent(target, text, opts) {
  if (!URGENT_RE.test(text)) return null;
  const sender = agentById(opts.from);
  if (!sender || sender.id === target.id) return null;
  const run = runs.get(target.id);
  const say = (status, reason) => {
    hooks.emit('urgent', { from: sender, to: target, status, reason });
    broadcast({ agentId: '*', kind: 'urgent', from: sender.name, to: target.name, status, reason });
    return null;
  };
  const cd = urgentCooldownMs(), now = Date.now();
  if (!run || !run.proc) return null;
  if (!cd) return say('queued', '緊急插話功能已關閉');
  if (!canUrgent(sender)) return say('queued', sender.name + ' 沒有緊急插話的授權');
  if (target.standalone || sender.team !== target.team) return say('queued', '只能插話給同一小組的成員');
  if (run.interrupt) return say('queued', target.name + ' 已經在被插話了');
  if (run.opts && run.opts.shift) return say('queued', target.name + ' 正在寫交班筆記，不能打斷');
  if (now - (urgentLog.get(sender.id + '>' + target.id) || 0) < cd) return say('queued', target.name + ' 剛被緊急插話過（冷卻 ' + cd / 60000 + ' 分鐘）');
  if (now - (urgentLog.get(target.id + '>' + sender.id) || 0) < cd) return say('queued', target.name + ' 剛緊急插話過 ' + sender.name + '，不能反過來打斷');
  urgentLog.set(sender.id + '>' + target.id, now);
  const note = '⚡【緊急派工：' + sender.name + '】你手上的工作已經被暫停，請先處理這件事；處理完系統會讓你接著做原本的工作。\n\n' + text;
  run.interrupt = { urgent: { text: note, opts: { ...opts, urgent: true } }, via: opts.via };
  proctree.killTree(run.proc);
  say('interrupted', '');
  return 'interrupted';
}
// ---------- ⏸ 暫停／▶ 重啟專案 ----------
// 暫停：新的派工、同事轉交、任務交接、排程一律排隊不叫醒；正在工作的成員做完這一輪（或立刻停），
// 再請每位成員寫一份交班筆記（對話很短的略過）。重啟：放行排隊的訊息，被中途停下的工作接著做，
// 寫過筆記的成員用全新的對話接手。使用者自己直接傳給成員的訊息不受影響。獨立成員（記帳員等）不屬於專案，不會被暫停。
const pauseOf = (agent) => (!agent || agent.standalone ? null : state.pause.all || (agent.team && state.pause[agent.team]) || null);
const isHeld = (agent, opts) => !!pauseOf(agent) && !opts.shift && !opts.restart &&
  !!(opts.from || opts.system || opts.resume || opts.urgent || (opts.via === 'timer' && !opts.manual));
const pauseScopeLabel = (scope) => (scope === 'all' ? '整個專案' : '小組「' + ((teamById(scope) || {}).name || scope) + '」');
const inScope = (scope, a) => !a.standalone && (scope === 'all' || a.team === scope);
const pauseNoteTokens = () => { const n = Number(harness.cfg().pauseNoteTokens); return Number.isFinite(n) && n >= 0 ? n : 20000; };
// 這段對話要不要寫交班筆記：主對話與進行中任務的對話才寫；對話很短就不用（重啟後直接接著原本的對話）
function pauseNoteOpts(agent, key) {
  if (!state.sessions[key]) return null;
  let o = null;
  if (key === agent.id) o = {};
  else {
    const m = /^t(\d+):(.+)$/.exec(key);
    const t = m && m[2] === agent.id && tasks.actives().find((x) => x.id === Number(m[1]));
    if (t) o = { taskId: t.id, stageId: t.stageId };
  }
  if (!o) return null;
  const min = pauseNoteTokens(), c = ctxInfo(key, agent.engine);
  return min > 0 && c && c.tokens < min ? null : o;
}
function pauseProject(scope, { mode = 'finish', reason = '', via = 'web' } = {}) {
  scope = scope && scope !== 'all' ? String(scope) : 'all';
  if (scope !== 'all' && !teamById(scope)) throw new Error('找不到這個小組');
  if (state.pause.all) throw new Error('整個專案已經暫停了');
  if (state.pause[scope]) throw new Error(pauseScopeLabel(scope) + '已經暫停了');
  const rec = { at: Date.now(), reason: String(reason || '').trim().slice(0, 300), mode: mode === 'now' ? 'now' : 'finish', via, phase: 'pausing', restart: [], notes: 0 };
  if (scope === 'all') for (const k of Object.keys(state.pause)) { rec.restart.push(...(state.pause[k].restart || [])); rec.notes += state.pause[k].notes || 0; delete state.pause[k]; }
  state.pause[scope] = rec;
  const members = AGENTS.filter((a) => inScope(scope, a));
  for (const a of members) {
    const run = runs.get(a.id);
    if (run && run.proc && rec.mode === 'now' && !run.opts.shift && !run.interrupt) { run.interrupt = { pause: scope }; proctree.killTree(run.proc); }
  }
  // 每段需要的對話各寫一份交班筆記（成員還在工作就排在這一輪之後）
  const why = rec.reason ? '（原因：' + rec.reason + '）' : '';
  for (const a of members) {
    for (const key of Object.keys(state.sessions)) {
      if (key !== a.id && !key.endsWith(':' + a.id)) continue;
      const o = pauseNoteOpts(a, key);
      if (!o) continue;
      if (pending.some((q) => q.agentId === a.id && q.opts.pauseNote && sessionKey(a, q.opts) === key)) continue;
      rec.notes++;
      dispatch(a, '（專案暫停' + why + '）', { ...o, shift: true, pauseNote: true, system: true });
    }
  }
  saveState();
  harness.record({ type: 'pause', scope, mode: rec.mode, reason: rec.reason });
  hooks.emit('pause', { scope, label: pauseScopeLabel(scope), rec, members: members.length });
  broadcast({ agentId: '*', kind: 'pause' });
  checkPaused();
  return pauseStatus();
}
// 暫停中：範圍內還有成員在工作、或交班筆記還沒寫完 → 'pausing'；都好了 → 'paused'（通知一次）
function checkPaused() {
  for (const [scope, rec] of Object.entries(state.pause)) {
    if (rec.phase !== 'pausing') continue;
    const busy = AGENTS.some((a) => inScope(scope, a) && (runs.has(a.id) || pending.some((q) => q.agentId === a.id && q.opts.shift)));
    if (busy) continue;
    rec.phase = 'paused'; rec.pausedAt = Date.now(); saveState();
    hooks.emit('paused', { scope, label: pauseScopeLabel(scope), rec });
    broadcast({ agentId: '*', kind: 'pause' });
  }
}
function resumeProject(scope, { text = '', via = 'web' } = {}) {
  scope = scope && scope !== 'all' ? String(scope) : (state.pause.all ? 'all' : Object.keys(state.pause)[0]);
  const rec = scope && state.pause[scope];
  if (!rec) throw new Error('目前沒有暫停');
  delete state.pause[scope];
  const extra = String(text || '').trim().slice(0, 2000);
  const ms = Date.now() - rec.at;
  try { tasks.addPausedTime(ms, scope === 'all' ? null : scope); } catch {}
  const members = AGENTS.filter((a) => inScope(scope, a) && !pauseOf(a));
  const got = new Set();
  const tail = extra ? '\n\n【使用者重啟時的補充指示（優先照這個做）】\n' + extra : '';
  // 被中途停下的工作：接著做
  for (const r of rec.restart || []) {
    const a = agentById(r.agentId);
    if (!a || !members.includes(a)) continue;
    got.add(a.id);
    dispatch(a, '【系統：專案重啟】暫停前你正在做下面這件事，做到一半被停下了。請先看交班筆記（如果有）和工作資料夾的檔案，判斷做到哪裡，再接著完成：\n\n' + r.text + tail,
      { ...r.opts, restart: true, system: true, via });
  }
  // 有補充指示：其他成員也都要知道（交給它最近的對話：進行中任務或主對話）
  if (extra) for (const a of members) {
    if (got.has(a.id)) continue;
    const key = state.lastKey[a.id] || a.id;
    const m = /^t(\d+):/.exec(key);
    const t = m && tasks.actives().find((x) => x.id === Number(m[1]));
    dispatch(a, '【系統：專案重啟】使用者重新啟動了專案，並給所有人這段補充指示：\n' + extra +
      '\n\n請依照它調整你接下來的工作。如果和你目前的工作無關，簡短回覆「收到」就好，不要 @ 任何人。',
      { ...(t ? { taskId: t.id, stageId: t.stageId } : {}), restart: true, system: true, via });
  }
  saveState();
  harness.record({ type: 'resume', scope, minutes: Math.round(ms / 60000), restarted: got.size });
  hooks.emit('resume', { scope, label: pauseScopeLabel(scope), minutes: Math.round(ms / 60000), restarted: got.size, held: pending.filter((q) => members.some((a) => a.id === q.agentId)).length, text: extra });
  broadcast({ agentId: '*', kind: 'pause' });
  pump();
  return pauseStatus();
}
function pauseStatus() {
  return { pauses: Object.entries(state.pause).map(([scope, r]) => ({ scope, label: pauseScopeLabel(scope), at: r.at, reason: r.reason, mode: r.mode, phase: r.phase, notes: r.notes || 0,
    restart: (r.restart || []).length,
    held: pending.filter((q) => { const a = agentById(q.agentId); return a && inScope(scope, a) && isHeld(a, q.opts); }).length,
    working: AGENTS.filter((a) => inScope(scope, a) && runs.has(a.id)).map((a) => a.name) })) };
}

function dispatch(agent, text, opts = {}) {
  if (opts.from && !opts.urgent && runs.has(agent.id)) {
    const r = tryUrgent(agent, text, opts);
    if (r) return r;
  }
  if (mustWait(agent) || isHeld(agent, opts)) {
    pending.push({ agentId: agent.id, text, opts });
    saveState();
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
  return { count: items.length, waitingOn: blocker ? blocker[0] : null, paused: !!pauseOf(a),
    items: items.map((p) => ({ text: p.text, from: p.opts.from || null, via: p.opts.via || null, taskId: p.opts.taskId || null })) };
}
function pump() {
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i], agent = agentById(item.agentId);
    if (!agent) { pending.splice(i--, 1); continue; }
    if (mustWait(agent) || isHeld(agent, item.opts)) continue;
    pending.splice(i--, 1);
    startRun(agent, item.text, item.opts);
  }
  saveState();
  checkPaused();
  broadcast({ agentId: '*', kind: 'queue' });
}
function cancelTask(taskId) {
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].opts.taskId === taskId) pending.splice(i, 1);
  for (const [id, r] of runs) if (r.opts && r.opts.taskId === taskId) stopRun(id, true);
}

// 任務、排程（ownSession）各用自己的對話，不會擠在和你的主對話裡
const sessionKey = (agent, opts) => (opts.taskId ? 't' + opts.taskId + ':' + agent.id : opts.sessionTag ? opts.sessionTag + ':' + agent.id : agent.id);

function buildCommand(agent, sid, prompt) {
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
    if (rtkWanted(agent)) { const rb = rtkBin(); if (rb) args.push('--settings', rtkSettingsFile(rb)); }
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
  if (agent.engine === 'agy') {
    // 預設用 stdin 傳提示（一行 JSON 的 user 事件），避免 Windows 命令列的引號／換行問題；
    // AGY_PROMPT_MODE=arg 時改用 -p（直接執行 agy.exe 才安全）
    const argMode = process.env.AGY_PROMPT_MODE === 'arg';
    const args = argMode ? ['--output-format', 'stream-json'] : ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('--effort', agent.effort);
    // 唯讀（預設）：計畫模式＋終端機沙箱；可寫：agy 的預設模式（可以寫檔，也會真的執行指令；是否限制在工作資料夾內尚待實測）。永遠不使用 --dangerously-skip-permissions。
    args.push(...(agy.access(agent) === 'read' ? agy.readOnlyArgs() : agy.writeArgs()));
    for (const d of agent.extraDirs || []) args.push('--add-dir', d.path);
    if (sid) args.push('--conversation', sid);
    if (argMode) args.push('-p', prompt || '');
    return { cmd: getBin('agy'), args, stdinPrompt: !argMode };
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

// agy 回報的時間與 tokens 是「整段對話累計」（連續兩輪的秒數差剛好是你兩則訊息的間隔），不是這一輪的：
// 時間改成這一輪實際花的，tokens 標明是累計，免得以為這一輪花了很久
function agyMeta(meta, ms) {
  return String(meta || '').split(' · ').map((p) => (/^\d+ tokens$/.test(p) ? '對話累計 ' + p : /^\d+(\.\d+)?s$/.test(p) ? (ms / 1000).toFixed(1) + 's' : p)).join(' · ');
}

function startRun(agent, userText, opts = {}) {
  const key = sessionKey(agent, opts);
  // 排程（沒勾「記得上次的對話」）每次都開全新的對話，不會一個鐘頭一輪地越堆越長
  if (opts.fresh && state.sessions[key] && !opts.shift && !opts.resume) { delete state.sessions[key]; delete state.ctx[key]; delete state.hdr[key]; saveState(); }
  // 對話太長：先換班（寫交班筆記），原本的訊息排在換班之後
  if (!opts.shift && !opts.interject && !opts.resume && !agent.blocked && shiftDue(agent, key)) {
    pending.unshift({ agentId: agent.id, text: userText, opts });
    return startRun(agent, '（換班）', { taskId: opts.taskId, stageId: opts.stageId, sessionTag: opts.sessionTag, shift: true, system: true });
  }
  state.lastKey[agent.id] = key;
  const sid = state.sessions[key];
  let cmd = null, args = [], stdinPrompt = false, blocked = agent.blocked || null;
  const hops = opts.hops || 0;
  const prompt = buildPrompt(agent, userText, opts);
  if (!blocked && agent.engine === 'agy' && state.agyHold && state.agyHold[agent.id]) blocked = '唯讀限制沒有擋住（上一輪有檔案被改），已暫停這位成員';
  // 🪫 agy 額度用完：同事轉交、任務、排程直接退回（不浪費一次呼叫）；你自己直接傳的訊息照樣試，成功就自動解除
  let quotaStop = null;
  if (!blocked && agent.engine === 'agy' && !userDirect(opts)) {
    const q = agyQuotaHold(agent);
    if (q) { quotaStop = '🪫 ' + agent.name + ' 的 agy 額度用完了，預計 ' + fmtUntil(q) + ' 恢復，這則沒有執行。'; blocked = quotaStop; }
  }
  if (!blocked) {
    try { ({ cmd, args, stdinPrompt } = buildCommand(agent, sid, prompt)); } catch (e) { blocked = e.message; }
  }
  const meta = { from: opts.from, via: opts.via, cc: opts.cc, taskId: opts.taskId, stageId: opts.stageId, system: opts.system, interject: opts.interject, shift: opts.shift, timerId: opts.timerId };

  const shownText = opts.pauseNote ? '⏸ 專案暫停：請成員寫交班筆記，重啟後換成全新的對話接手' : opts.shift ? '🔄 換班：' + (opts.manualShift ? '你要求換班' : '對話已經很長') + '，請成員寫交班筆記，之後換成全新的對話接手' : opts.shown || userText;
  appendHistory(agent.id, { role: 'user', text: shownText, ...meta, ts: Date.now() });
  broadcast({ agentId: agent.id, kind: 'user', text: shownText, ...meta });
  hooks.emit('user', { agent, text: userText, from: opts.from, via: opts.via });

  const run = { userText, segments: [], calls: [], meta: '', finished: false, stderr: Buffer.alloc(0), cwd: agent.cwd, opts, takeTurns: !!agent.takeTurns && !agent.standalone, team: agent.team || null,
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
    run.segments.push({ type: 'error', text: quotaStop ? quotaStop + '\n要現在試試看，請你直接傳訊息給它（成功會自動解除）；或到「⚙️ 設定」按儲存解除。'
      : '⛔ 這位成員的設定不符合安全規則，暫停使用：\n' + blocked + '\n' + blockedHelp(blocked) });
    if (quotaStop) agyQuotaNotifySender(agent, opts, userText);
    broadcast({ agentId: agent.id, kind: 'segment', segment: run.segments[0] });
    finish();
    hooks.emit('done', { agent, timerId: opts.timerId, stopped: !!run.stopped, tg: opts.tg, line: opts.line, via: opts.via, segments: run.segments, meta: '', relayTo: [] });
    if (opts.taskId) tasks.onTurnDone(agent, run, opts, null);
    setImmediate(pump);
    return;
  }
  if (!cmd) {
    const how = agent.engine === 'claude' ? 'npm.cmd i -g @anthropic-ai/claude-code' : agent.engine === 'agy' ? '到 https://antigravity.google/download 安裝 Antigravity CLI，然後在 PowerShell 輸入 agy 登入一次' : 'npm.cmd i -g @openai/codex';
    run.segments.push({ type: 'error', text: '找不到 ' + agent.engine + ' 指令。\n' +
      '還沒安裝的話，在 PowerShell 輸入：' + how + '\n' +
      '已經安裝了，請在 PowerShell 輸入「where.exe ' + agent.engine + '」，把顯示的路徑填進 start.bat 的 ' +
      agent.engine.toUpperCase() + '_BIN。' });
    broadcast({ agentId: agent.id, kind: 'segment', segment: run.segments[0] });
    finish();
    hooks.emit('done', { agent, timerId: opts.timerId, stopped: !!run.stopped, tg: opts.tg, line: opts.line, via: opts.via, segments: run.segments, meta: '', relayTo: [] });
    if (opts.taskId) tasks.onTurnDone(agent, run, opts, null);
    setImmediate(pump);
    return;
  }

  // 任務模式：記下工作資料夾目前的樣子，結束後比對出實際變更的檔案
  const before = opts.taskId && !opts.shift ? tasks.snapshotFor(agent) : null;
  // agy 唯讀成員：記下所有資料夾目前的樣子，結束後確認真的沒有任何檔案被改（CLI 的唯讀限制還沒有被實測證明可靠，所以這裡再檢查一次）
  const roBefore = agent.engine === 'agy' && agy.access(agent) === 'read' && !opts.shift ? tasks.snapshotAll(agent) : null;

  // .exe 直接執行；.cmd（npm 安裝的）要透過 cmd.exe，路徑有空白時要加引號
  const needShell = IS_WIN && !/\.exe$/i.test(cmd);
  const spawnCmd = needShell && /\s/.test(cmd) ? '"' + cmd + '"' : cmd;
  // 透過 cmd.exe 執行時，含空白或特殊符號的參數（例如資料夾路徑）要加引號
  const spawnArgs = needShell ? args.map((x) => (/[\s&|<>^()]/.test(x) && !x.includes('"') ? '"' + x + '"' : x)) : args;
  const proc = proctree.track(spawn(spawnCmd, spawnArgs, { cwd: agent.cwd, shell: needShell, env: { ...security.safeEnvironment(), ...(agent.env || {}) }, windowsHide: true }));
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
    if (e.kind === 'done') { run.meta = agent.engine === 'agy' ? agyMeta(e.meta, Date.now() - run.startedAt) : e.meta || ''; run.finished = true; if (e.stats) run.stats = e.stats; return; }
    if (e.kind === 'toolres') {
      // 工具結果：記進稽核紀錄；被擋下或失敗的顯示一行
      let c = e.id && run.calls.find((x) => x.id === e.id);
      if (!c) { c = { ...(e.call || {}), at: Date.now() }; run.calls.push(c); }
      const m = /exit code[:\s]+(\d+)/i.exec(e.text || '');
      c.isError = e.isError; c.exitCode = e.exitCode != null ? e.exitCode : m ? Number(m[1]) : e.isError ? null : 0;
      c.output = security.redact(String(e.text || '').slice(0, 2000));
      if (e.isError && (agent.engine === 'claude' || agent.engine === 'agy')) {
        const seg = { type: 'tool', text: '⛔ ' + short(e.text || '工具執行失敗', 160) };
        run.segments.push(seg); broadcast({ agentId: agent.id, kind: 'segment', segment: seg });
      }
      return;
    }
    if (e.call) run.calls.push({ ...e.call, at: Date.now() });
    run.segments.push({ type: e.kind, text: e.text });
    broadcast({ agentId: agent.id, kind: 'segment', segment: { type: e.kind, text: e.text } });
  };
  const parse = agent.engine === 'claude' ? parseClaude : agent.engine === 'agy' ? agy.makeParser(short) : parseCodex;

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
  proc.on('close', async (code) => {
    if (run.interrupt && run.interrupt.pause) {
      // 專案暫停（立刻停）：這一輪先停下，記下來，重啟時接著做
      emit({ kind: 'tool', text: '⏸ 專案暫停，這一輪先停下（重啟後會接著做）' });
      finish();
      hooks.emit('done', { agent, timerId: opts.timerId, stopped: true, tg: opts.tg, line: opts.line, via: opts.via, segments: run.segments, meta: run.meta, relayTo: [], taskId: opts.taskId });
      if (opts.taskId) tasks.noteInterrupt(agent, opts, before, '專案暫停');
      if (agent.engine === 'codex') { setTimeout(readCodexUsage, 500); codexContext(key); }
      const rec = state.pause[run.interrupt.pause] || pauseOf(agent);
      if (rec && opts.via !== 'timer') rec.restart.push({ agentId: agent.id, text: userText,
        opts: { taskId: opts.taskId, stageId: opts.stageId, sessionTag: opts.sessionTag, hops: opts.hops, via: opts.via, tg: opts.tg } });
      saveState();
      pump();
      return;
    }
    if (run.interrupt) {
      // 使用者插話：結束這一輪（不轉交、不判斷任務交接），馬上帶著指示接著做同一段對話
      const urgent = run.interrupt.urgent;
      emit({ kind: 'tool', text: urgent ? '⚡ 收到 ' + ((agentById(urgent.opts.from) || {}).name || '同事') + ' 的緊急派工，這一輪先暫停' : '⚡ 使用者插話，這一輪先暫停' });
      finish();
      hooks.emit('done', { agent, timerId: null, stopped: false, tg: opts.tg, line: opts.line, via: opts.via, segments: run.segments, meta: run.meta, relayTo: [], taskId: opts.taskId });
      if (opts.taskId) tasks.noteInterrupt(agent, opts, before, urgent ? urgent.text : run.interrupt.text);
      if (agent.engine === 'codex') setTimeout(readCodexUsage, 500);
      if (urgent) {
        // 先做緊急的事（照它自己的任務與對話），做完再接著原本被打斷的工作
        const back = { taskId: opts.taskId, stageId: opts.stageId, hops: opts.hops, via: opts.via, resume: true, system: true, timerId: opts.timerId, sessionTag: opts.sessionTag };
        pending.unshift({ agentId: agent.id, text: (run.interrupt.text ? run.interrupt.text + '\n\n' : '') + '（緊急的事處理完了，請繼續原本的工作）', opts: back });
        pending.unshift({ agentId: agent.id, text: urgent.text, opts: urgent.opts });
        pump();
        return;
      }
      startRun(agentById(agent.id) || agent, run.interrupt.text,
        { taskId: opts.taskId, stageId: opts.stageId, hops: opts.hops, via: run.interrupt.via, interject: true, timerId: opts.timerId, sessionTag: opts.sessionTag });
      pump();
      return;
    }
    run.exitCode = code;
    if (!run.stopped) noteCliRun(agent, run, code);
    if (agent.engine === 'agy' && !run.stopped) agyAfter(agent, run, emit, code, roBefore);
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
      hooks.emit('done', { agent, timerId: opts.timerId, stopped: !!run.stopped, tg: opts.tg, line: opts.line, via: opts.via, segments: run.segments, meta: run.meta, relayTo: [], taskId: opts.taskId, shift: true, pauseNote: !!opts.pauseNote });
      pump();
      return;
    }

    // 自由聊天模式：回覆裡 @ 了同事 → 自動轉交（任務模式改由流程決定）
    const replyText = run.segments.filter((s) => s.type === 'text').map((s) => s.text).join('\n\n');
    if (!opts.taskId && replyText && !run.stopped && !agent.standalone) harness.collect(agent, replyText, null);
    // 🧩【安裝 Skill】→ 建立安裝申請（等使用者核准，不會自動安裝）
    if (replyText && !run.stopped) for (const r of skills.fromReply(agent, replyText))
      emit({ kind: 'tool', text: r.error ? '🧩 Skill 安裝申請沒有送出：' + r.error : '🧩 已送出 Skill 安裝申請 #' + r.id + '（' + r.source + ' → ' + r.targetLabel + '），下載檢查後等使用者核准' });
    if (replyText && !run.stopped) for (const r of timers.collect(agent, replyText, opts.taskId || null))
      emit({ kind: 'tool', text: r.error ? '⏰ 排程建議沒有送出：' + r.error : '⏰ 已送出排程建議（' + timers.describe(r.proposal) + '），等你在「排程」核准' });
    // 📋 網頁對話的待辦管家：模型寫的【待辦】動作行，由系統（以管理員／主管身分）檢查後寫進 Google Sheet，結果附在這一輪後面
    if (opts.todoWeb && replyText && !run.stopped) {
      try {
        const parsed = todoLib.parseReply(replyText);
        if (parsed.actions.length) for (const n of await todoBook.execute(todoLib.WEB_OWNER, parsed.actions)) emit({ kind: 'tool', text: '📋 ' + n });
        else if (/(已|幫你|我).{0,8}(登記|新增|記下|更新|改成|完成了|取消)/.test(parsed.text)) emit({ kind: 'tool', text: '📋 （提醒：這則回覆沒有產生任何寫入，清單沒有變動，請再說一次。）' });
      } catch (e) { emit({ kind: 'tool', text: '📋 ⚠️ 寫入待辦失敗：' + e.message }); }
    }
    const targets = opts.taskId || run.stopped || !replyText ? [] : findMentions(agent, replyText);
    if (targets.length && hops >= maxHops()) {
      emit({ kind: 'tool', text: '⛔ 已達自動轉交上限（' + maxHops() + ' 次），沒有再轉給 ' +
        targets.map((t) => t.name).join('、') + '。需要的話請你手動接手。' });
    }
    finish();
    hooks.emit('done', { agent, timerId: opts.timerId, stopped: !!run.stopped, tg: opts.tg, line: opts.line, via: opts.via, segments: run.segments, meta: run.meta, relayTo: hops < maxHops() ? targets : [], taskId: opts.taskId });

    if (opts.taskId && !run.silentStop) tasks.onTurnDone(agent, run, opts, before);
    if (hops < maxHops()) for (const t of targets) dispatch(t, replyText, { from: agent.id, hops: hops + 1 });
    pump();
  });

  proc.stdin.on('error', () => {});
  if (userDirect(opts) && !agent.standalone && agent.engine !== 'agy' && agent.id === process.env.AGENTCHAT_RECALL_AGENT) {
    const lookup = require('./recall');
    const controller = new AbortController();
    proc.once('close', () => controller.abort());
    const decisions = () => harness.recallDecisions(agentById(agent.id));
    const deliver = (context) => {
      if (runs.get(agent.id) !== run || run.stopped || run.interrupt || proc.stdin.destroyed) return;
      const current = agentById(agent.id);
      if (!current || current.standalone || current.blocked || current.team !== run.team) {
        run.stopped = true;
        proctree.killTree(proc);
        return;
      }
      proc.stdin.end(context ? context + '\n\n' + prompt : prompt);
    };
    lookup.context(userText, decisions, { signal: controller.signal, env: security.safeEnvironment() })
      .then(deliver, () => deliver(''));
  } else {
    proc.stdin.end(agent.engine === 'agy' ? (stdinPrompt ? agy.stdinMessage(prompt) : '') : prompt);
  }
}

// agy 一輪結束後：登入問題提示、被擋下的動作、唯讀成員有沒有改到檔案
function agyAfter(agent, run, emit, code, roBefore) {
  const err = decodeOutput(run.stderr);
  agyQuotaCheck(agent, run, emit, code, err);
  if (code && /auth|login|credential|sign.?in|unauthenticated/i.test(err))
    emit({ kind: 'error', text: '🔑 agy 還沒登入或登入過期：請在這台電腦的 PowerShell 執行 agy，用 Google 帳號登入一次，之後這裡就能用了。' });
  const denied = err.split(/\r?\n/).map((l) => l.trim()).filter((l) => /denied|not permitted|requires approval|permission/i.test(l)).slice(0, 3);
  for (const l of denied) emit({ kind: 'tool', text: '⛔ ' + short(l, 160) });
  if (!roBefore) return;
  let changes = [];
  try { changes = tasks.diffSnapshots(roBefore, tasks.snapshotAll(agent)); } catch {}
  if (!changes.length) return;
  const list = changes.slice(0, 8).map((c) => (c.kind === 'add' ? '＋' : c.kind === 'del' ? '－' : '～') + c.path).join('、');
  state.agyHold = state.agyHold || {};
  state.agyHold[agent.id] = { at: Date.now(), files: changes.slice(0, 20).map((c) => c.kind + ':' + c.path) };
  saveState();
  emit({ kind: 'error', text: '🚨 ' + agent.name + ' 是唯讀成員，但這一輪之後資料夾裡有檔案被改了：' + list + '\n唯讀限制沒有擋住，已先暫停這位成員。請確認那些檔案，再到「⚙️ 設定」按儲存解除暫停（或改用可寫入的存取等級）。' });
  hooks.emit('readonly-violation', { agent, changes });
}

// ---------- 🪫 agy 額度 ----------
// agy 不提供剩餘額度，只能：從錯誤訊息判斷「用完了」（暫停自動派工並通知），以及自己統計本週用了幾輪、多少 tokens。
const AGY_QUOTA_RETRY_MS = 60 * 60 * 1000; // 錯誤訊息沒寫恢復時間時，先擋一個鐘頭，之後下一則訊息會再試
// 你自己直接傳的訊息（網頁／Telegram），不是同事轉交、任務、排程、系統自動送的
const userDirect = (opts) => !opts.from && !opts.system && !opts.resume && !opts.urgent && !opts.taskId && !opts.shift && !(opts.via === 'timer' && !opts.manual);
function agyQuotaHold(agent) {
  const q = state.agyQuota[agent.id];
  return q && q.until > Date.now() ? q : null;
}
const fmtUntil = (q) => { const d = new Date(q.until); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + (q.estimated ? '（推估）' : ''); };
function weekStart(t = Date.now()) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function agyUsageOf(id) {
  const w = weekStart(), u = state.agyUsage[id];
  if (!u || u.week !== w) state.agyUsage[id] = { week: w, runs: 0, tokens: 0, quotaHits: 0, lastQuotaAt: u && u.lastQuotaAt ? u.lastQuotaAt : null };
  return state.agyUsage[id];
}
// 把「額度用完」告訴派工給它的同事，請他改派（同一段額度用完期間，每位同事只通知一次，避免來回）
function agyQuotaNotifySender(agent, opts, text) {
  const q = state.agyQuota[agent.id], sender = opts.from && agentById(opts.from);
  if (!q || !sender || sender.id === agent.id) return;
  q.notified = q.notified || [];
  if (q.notified.includes(sender.id)) return;
  q.notified.push(sender.id); saveState();
  const hops = (opts.hops || 0) + 1;
  if (hops > maxHops()) return;
  dispatch(sender, '【系統通知】' + agent.name + ' 的 agy 額度用完了，預計 ' + fmtUntil(q) + ' 恢復。你剛才交給他的工作沒有執行：\n「' + short(text, 300) + '」\n請改派給其他成員，或等恢復後再交給他；不要再 @ 他。',
    { system: true, via: 'system', hops });
}
function agyQuotaCheck(agent, run, emit, code, err) {
  const u = agyUsageOf(agent.id), st = run.stats || {};
  u.runs++; u.tokens += (st.inTok || 0) + (st.outTok || 0);
  const errs = run.segments.filter((s) => s.type === 'error').map((s) => s.text).join('\n');
  const failed = !!code || !!errs;
  const hay = errs + '\n' + (failed ? err : '');
  if (failed && agy.quotaHit(hay)) {
    const now = Date.now(), reset = agy.quotaReset(hay, now);
    const prev = state.agyQuota[agent.id];
    const q = state.agyQuota[agent.id] = { at: now, until: reset || now + AGY_QUOTA_RETRY_MS, estimated: !reset, msg: short(hay.trim(), 300),
      notified: prev && prev.until > now ? prev.notified || [] : [] };
    u.quotaHits++; u.lastQuotaAt = now;
    saveState();
    emit({ kind: 'error', text: '🪫 ' + agent.name + ' 的 agy 額度用完了，預計 ' + fmtUntil(q) + ' 恢復。\n在那之前，同事轉交、任務、排程不會再交給它（會退回並通知派工的人改派）；你直接傳訊息給它會再試一次，成功就自動解除。' +
      (q.estimated ? '\n（錯誤訊息沒寫恢復時間，先等一個鐘頭再試。）' : '') });
    hooks.emit('agy-quota', { agent, until: q.until, estimated: q.estimated, msg: q.msg, usage: u });
    broadcast({ agentId: '*', kind: 'usage' });
    agyQuotaNotifySender(agent, run.opts || {}, run.userText || '');
    return;
  }
  if (!failed && state.agyQuota[agent.id]) {
    delete state.agyQuota[agent.id];
    emit({ kind: 'tool', text: '🔋 agy 額度恢復了，' + agent.name + ' 可以正常派工' });
    hooks.emit('agy-quota-ok', { agent });
  }
  saveState();
  broadcast({ agentId: '*', kind: 'usage' });
}
function agyUsageSnapshot() {
  return CONFIG.agents.filter((a) => a.engine === 'agy').map((a) => {
    const u = agyUsageOf(a.id), q = state.agyQuota[a.id];
    return { id: a.id, name: a.name, model: a.model || '', runs: u.runs, tokens: u.tokens, quotaHits: u.quotaHits, lastQuotaAt: u.lastQuotaAt,
      out: q && q.until > Date.now() ? { until: q.until, estimated: !!q.estimated, msg: q.msg } : null };
  });
}

// silent：任務被整個停止時，不再觸發任務的後續判斷
function stopRun(id, silent) {
  if (!queueFrozen) { for (let i = pending.length - 1; i >= 0; i--) if (pending[i].agentId === id) pending.splice(i, 1); saveState(); }
  broadcast({ agentId: '*', kind: 'queue' });
  const run = runs.get(id);
  if (!run || !run.proc) return false;
  run.stopped = true;
  if (silent) run.silentStop = true;
  proctree.killTree(run.proc);
  return true;
}

// 插話：中斷正在工作的成員，結束後馬上用同一段對話帶著使用者的指示繼續
function interruptRun(id, text, via) {
  const run = runs.get(id);
  if (!run || !run.proc) return false;
  if (run.interrupt) { run.interrupt.text = (run.interrupt.text ? run.interrupt.text + '\n' : '') + text; return true; }
  run.interrupt = { text, via };
  proctree.killTree(run.proc);
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
      cmdline: security.redact(run.cmdline, secretList()),
      stderrTail: security.redact(decodeOutput(run.stderr).split(/\r?\n/).slice(-40).join('\n'), secretList()),
      stdoutTail: run.stdoutTail.map((s) => security.redact(s, secretList())), segments: run.segments.length, taskId: run.opts.taskId || null,
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
  delete state.sessions[id]; delete state.ctx[id]; delete state.hdr[id]; delete state.shifts[id]; delete state.lastKey[id]; saveState();
  try { fs.unlinkSync(histFile(id)); } catch {}
  broadcast({ agentId: id, kind: 'reset' });
  return true;
}

// ---------- Harness（守則、自動檢查、預算、記憶、觀測）----------
const harness = harnessLib.create({
  CONFIG, AGENTS, agentById, teamById, DATA_DIR, hooks, broadcast, IS_WIN, decode: decodeOutput,
  safeEnv: () => security.safeEnvironment(),
  redact: (s) => security.redact(s, secretList()),
});

// ---------- 任務與工作流程（tasks.js）----------
const tasks = taskLib.create({
  CONFIG, AGENTS, agentById, DATA_DIR, hooks, broadcast, dispatch, cancelTask, accessText, urgentHint, harness,
  teams: () => CONFIG.teams, teamById,
});
tasks.writeWorkflowDocs();

// ---------- ⏰ 排程（timers.js）----------
const timers = require('./timers').create({
  DATA_DIR, agentById, dispatch: (agent, text, opts) => dispatch(agent, text, opts),
  onChange: () => broadcast({ agentId: '*', kind: 'timers' }),
  notify: (e) => hooks.emit('timer-alert', e),
  onProposal: (p, agent) => hooks.emit('timer-proposal', { proposal: p, agent, desc: timers.describe(p) }),
  runCheck: (agent, command) => runPrecheck(agent, command),
  isPaused: (agent) => !!pauseOf(agent),
});
// 前置檢查：在成員的工作資料夾跑一行指令（不花 AI 額度），60 秒逾時，連子程式一起關
function runPrecheck(agent, command) {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0), done = false, timedOut = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, timedOut, out: decodeOutput(out).slice(0, 8000) }); };
    let proc;
    try {
      proc = proctree.track(spawn(command, { cwd: agent.cwd, shell: true, windowsHide: true, env: { ...security.safeEnvironment(), ...(agent.env || {}) }, ...proctree.groupOpts() }));
    } catch (e) { return resolve({ code: -1, out: '', error: e.message }); }
    const add = (d) => { if (out.length < 64000) out = Buffer.concat([out, d]); };
    proc.stdout.on('data', add); proc.stderr.on('data', add);
    proc.on('error', (e) => { out = Buffer.concat([out, Buffer.from(e.message)]); finish(-1); });
    proc.on('close', (code) => finish(code == null ? -1 : code));
    const timer = setTimeout(() => { timedOut = true; proctree.killTree(proc); finish(-1); }, 60000);
  });
}
// 有新任務開始：被成員暫停的排程（那個小組的成員）自動恢復
hooks.on('task', ({ task, event }) => {
  if (event !== 'started') return;
  const ids = CONFIG.agents.filter((a) => !a.standalone && a.team === task.teamId).map((a) => a.id);
  const back = timers.resumePaused(ids, '任務 #' + task.id + ' 開始');
  for (const t of back) console.log('⏰ 排程「' + t.name + '」自動恢復（任務 #' + task.id + ' 開始）');
});
hooks.on('done', (e) => { if (e.timerId) { try { timers.onDone(e); } catch (err) { console.error('排程結果處理失敗：' + err.message); } } });

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
    const proc = proctree.track(spawn(needShell && /\s/.test(cmd) ? '"' + cmd + '"' : cmd, args,
      { cwd, shell: needShell, env: security.safeEnvironment(), windowsHide: true, ...proctree.groupOpts() }));
    let buf = '', err = '';
    // 逾時：連 cmd 裡面的 claude／codex 一起關（只關 cmd 的話，CLI 會殘留在背景佔記憶體）
    const timer = setTimeout(() => proctree.killTree(proc), timeoutMs);
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
// 執行一個查詢指令並收下全部輸出（🧰 CLI 狀態用；stdin 直接關閉，逾時連子程式一起關）
function runCapture(cmd, args, { cwd, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const dir = cwd || path.join(DATA_DIR, 'probe'); try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const needShell = IS_WIN && !/\.exe$/i.test(cmd);
    let proc;
    try { proc = proctree.track(spawn(needShell && /\s/.test(cmd) ? '"' + cmd + '"' : cmd, args, { cwd: dir, shell: needShell, env: security.safeEnvironment(), windowsHide: true, ...proctree.groupOpts() })); }
    catch (e) { return resolve({ code: null, out: '', err: e.message }); }
    const outB = [], errB = []; let n = 0;
    const timer = setTimeout(() => proctree.killTree(proc), timeoutMs);
    proc.stdout.on('data', (c) => { if (n < 200000) { outB.push(c); n += c.length; } });
    proc.stderr.on('data', (c) => { errB.push(c); });
    const text = () => ({ out: decodeOutput(Buffer.concat(outB)), err: decodeOutput(Buffer.concat(errB)).slice(-4000) });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out: text().out, err: e.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, ...text() }); });
    proc.stdin.on('error', () => {}); proc.stdin.end();
  });
}
// 每個 CLI 最近一次成員執行的結果（給 🧰 CLI 狀態判斷登入；agy 沒有查登入的指令，只能靠這個）
function noteCliRun(agent, run, code) {
  const errs = run.segments.filter((x) => x.type === 'error').map((x) => x.text).join('\n');
  const err = errs + '\n' + decodeOutput(run.stderr);
  const login = /auth|login|credential|sign.?in|unauthenticated|not logged in|401/i.test(err) && (!!code || !!errs);
  state.cliSeen[agent.engine] = { ok: !code && !errs, at: Date.now(), login, err: !code && !errs ? '' : short(security.redact(errs || err, []).trim(), 160) };
}
const cliStatus = cliStatusLib.create({ getBin, run: runCapture, agents: () => AGENTS.filter((a) => !a.blocked), seen: () => state.cliSeen, broadcast: (e) => broadcast(e) });

const skills = skillsLib.create({ DATA_DIR, state, saveState: () => saveState(), broadcast: (e) => broadcast(e), hooks,
  agents: () => AGENTS.filter((a) => !a.blocked), agentById, teams: () => CONFIG.teams, teamById,
  findAgentByName: (n) => AGENTS.find((a) => a.name === n || a.name.toLowerCase() === String(n).toLowerCase()) });

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
  return { claude: USAGE.claude, codex: USAGE.codex, agy: agyUsageSnapshot(), weekStart: weekStart(), probing, now: Date.now() };
}

// ---------- 成員設定（網頁上新增 / 編輯 / 刪除）----------
const ENGINES = ['claude', 'codex', 'agy'];
const AGY_ACCESS = ['read', 'write'];
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
  if (!ENGINES.includes(a.engine)) throw new Error('引擎只能是 claude、codex 或 agy');
  if (!EFFORTS.includes(a.effort)) throw new Error('強度不正確');
  if (/[\s"'`$&|;<>]/.test(a.model)) throw new Error('模型名稱不能有空白或特殊符號');
  if (a.engine === 'claude') {
    a.permissionMode = PERMISSION_MODES.includes(input.permissionMode) ? input.permissionMode : 'auto';
  } else if (a.engine === 'agy') {
    a.agyAccess = AGY_ACCESS.includes(input.agyAccess) ? input.agyAccess : 'read';
  } else {
    a.sandbox = SANDBOXES.includes(input.sandbox) ? input.sandbox : 'workspace-write';
  }
  if (input.takeTurns) a.takeTurns = true;
  if (a.engine === 'claude' && input.rtk === true) a.rtk = true;
  if (input.todoKeeper === true) a.todoKeeper = true; // 📋 待辦管家模式
  if (input.brief === true) a.brief = true; // 📋 每輪附上現況摘要（時間、排程、任務、待處理）
  if (typeof input.canInterrupt === 'boolean' && !input.standalone) a.canInterrupt = input.canInterrupt;
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
      if ((a.engine === 'claude' || (a.engine === 'agy' && a.agyAccess === 'write')) && d.mode === 'ro') throw new Error((a.engine === 'claude' ? 'Claude --add-dir' : 'agy 的可寫成員額外資料夾') + ' 無法強制唯讀；請使用 OS ACL 或唯讀副本（agy 的「唯讀」存取等級則所有資料夾都只讀）');
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
  extraDirs: a.extraDirs || [], takeTurns: !!a.takeTurns, canInterrupt: canUrgent(a), rtk: !!a.rtk, rtkOn: rtkWanted(a) && !!(process.env.RTK_BIN || RTK.bin), agyAccess: a.engine === 'agy' ? agy.access(a) : undefined, agyRisk: agyWriteRisk(a), agyOut: a.engine === 'agy' && agyQuotaHold(a) ? agyQuotaHold(a).until : null, blocked: a.blocked || null,
  team: a.standalone ? null : a.team || null,
  standalone: !!a.standalone, tgPrefix: (a.telegram && a.telegram.prefix) || '', tgBot: !!(a.telegram && a.telegram.botToken),
  canHandoffTo: allowedTargets(a).map((t) => t.id),
  busy: runs.has(a.id), hasSession: !!state.sessions[a.id],
  queued: (queueInfo(a.id) || {}).count || 0, waitingOn: (queueInfo(a.id) || {}).waitingOn || null,
  runningSince: runs.has(a.id) ? runs.get(a.id).startedAt : null, lastActivity: runs.has(a.id) ? runs.get(a.id).lastActivity : null,
  stalled: runs.has(a.id) ? !!runs.get(a.id).stalled : false, paused: !!pauseOf(a),
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

    // ---- ⏰ 排程 ----
    if (p === '/api/timers' && req.method === 'GET') return send(res, 200, timers.snapshot());
    if (p === '/api/timers' && req.method === 'POST') { try { return send(res, 200, timers.create(await readBody(req))); } catch (e) { return send(res, 400, { error: e.message }); } }
    if ((m0 = p.match(/^\/api\/timers\/proposals\/(\d+)(\/accept)?$/))) {
      try {
        if (req.method === 'POST' && m0[2]) return send(res, 200, timers.acceptProposal(m0[1], await readBody(req)));
        if (req.method === 'DELETE' && !m0[2]) { timers.dismissProposal(m0[1]); return send(res, 200, { ok: true }); }
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if ((m0 = p.match(/^\/api\/timers\/(\d+)(\/run|\/enable|\/disable)?$/))) {
      try {
        if (req.method === 'PUT' && !m0[2]) return send(res, 200, timers.update(m0[1], await readBody(req)));
        if (req.method === 'DELETE' && !m0[2]) { timers.remove(m0[1]); return send(res, 200, { ok: true }); }
        if (req.method === 'POST' && m0[2] === '/run') return send(res, 200, { result: timers.runNow(m0[1]) });
        if (req.method === 'POST' && m0[2]) return send(res, 200, timers.setEnabled(m0[1], m0[2] === '/enable'));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

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
    // ---- 📋 待辦清單（Google Sheet）----
    if (p === '/api/todo' && req.method === 'GET') return send(res, 200, todoBook.status());
    if (p === '/api/todo' && req.method === 'PUT') { try { return send(res, 200, todoBook.update(await readBody(req))); } catch (e) { return send(res, e.status || 400, { error: e.message }); } }
    if (p === '/api/todo/ping' && req.method === 'POST') { try { return send(res, 200, { ...(await todoBook.ping()), status: todoBook.status() }); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (p === '/api/todo/digest' && req.method === 'POST') { try { const b = await readBody(req); return send(res, 200, await todoBook.digest(b.send === true)); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (p === '/api/todo/script' && req.method === 'GET') { try { return send(res, 200, { code: fs.readFileSync(path.join(ROOT, 'templates', 'todo', 'Code.gs'), 'utf8') }); } catch (e) { return send(res, 500, { error: '找不到 Apps Script 範本：' + e.message }); } }
    // ---- 💚 LINE ----
    if (p === '/api/line' && req.method === 'GET') return send(res, 200, lineBot.status());
    if (p === '/api/line' && req.method === 'PUT') { try { return send(res, 200, lineBot.update(await readBody(req))); } catch (e) { return send(res, e.status || 400, { error: e.message }); } }
    if (p === '/api/line/check' && req.method === 'POST') { try { return send(res, 200, { ...(await lineBot.check()), status: lineBot.status() }); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (p === '/api/line/pair' && req.method === 'POST') { if (!lineBot.status().configured) return send(res, 400, { error: '請先貼上 Channel secret 與 Channel access token 並儲存' }); lineBot.newPairCode(); return send(res, 200, lineBot.status()); }
    if (p === '/api/line/unpair' && req.method === 'POST') return send(res, 200, lineBot.unpair());
    if (p === '/api/line/webhook' && req.method === 'POST') { try { const b = await readBody(req); return send(res, 200, { ...(await lineBot.setupWebhook(b.publicUrl)), status: lineBot.status() }); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (p === '/api/line/tunnel' && req.method === 'POST') { try { const b = await readBody(req); return send(res, 200, b.on === false ? lineBot.stopTunnel() : lineBot.startTunnel()); } catch (e) { return send(res, 400, { error: e.message }); } }
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
    if (p === '/api/harness' && req.method === 'GET') return send(res, 200, { ...harness.snapshot(), stats: harness.stats(url.searchParams.get('days') || 7), contextLoad: contextLoad(), headerRefresh: headerRefresh(), rtk: AGENTS.some((a) => a.rtk) ? rtkStatus(false) : null });
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
    if (p === '/api/clistatus' && req.method === 'GET') { const snap = cliStatus.snapshot(); if (!snap.at && !snap.running) { cliStatus.refresh().catch((e) => console.error('CLI 狀態檢查失敗：' + e.message)); snap.running = true; } return send(res, 200, snap); }
    if (p === '/api/skills' && req.method === 'GET') return send(res, 200, skills.snapshot());
    if (p.startsWith('/api/skills') && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({})); let m;
      try {
        if (p === '/api/skills/requests') { skills.request(String(b.source || ''), { targetKey: String(b.target || ''), via: 'web', want: String(b.skill || '') }); return send(res, 200, skills.snapshot()); }
        if ((m = /^\/api\/skills\/requests\/(\d+)\/(approve|reject|choose|retry)$/.exec(p))) {
          const id = m[1];
          if (m[2] === 'approve') skills.approve(id, { target: b.target, replace: b.replace === true, by: 'web' });
          else if (m[2] === 'reject') skills.reject(id, 'web');
          else if (m[2] === 'choose') skills.choose(id, String(b.skill || ''));
          else skills.retry(id);
          return send(res, 200, skills.snapshot());
        }
        if (p === '/api/skills/remove') { skills.remove(b.root, b.name); return send(res, 200, skills.snapshot()); }
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/clistatus/refresh' && req.method === 'POST') { cliStatus.refresh().catch((e) => console.error('CLI 狀態檢查失敗：' + e.message)); return send(res, 200, { ok: true }); }
    if (p === '/api/usage/refresh' && req.method === 'POST') { probeUsage(); return send(res, 200, { ok: true }); }
    if (p === '/api/config' && req.method === 'GET') {
      return send(res, 200, {
        agents: CONFIG.agents.map(maskAgent), teams: CONFIG.teams.map((t) => ({ ...t, sharedWith: sharedWith(t) })), workflow: CONFIG.teams[0].workflow, maxRelayHops: maxHops(), urgentCooldownMin: urgentCooldownMs() / 60000, approveWritableHandoffs: CONFIG.approveWritableHandoffs === true,
        harness: harness.cfg(),
        options: { engines: ENGINES, efforts: EFFORTS, permissionModes: PERMISSION_MODES, sandboxes: SANDBOXES, agyAccess: AGY_ACCESS },
        appRoot: ROOT,
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
        if (state.agyHold && state.agyHold[a.id]) { delete state.agyHold[a.id]; saveState(); } // 在設定按儲存＝確認過了，解除唯讀違規的暫停
        if (state.agyQuota[a.id]) { delete state.agyQuota[a.id]; saveState(); } // 也解除「額度用完」（例如你知道額度已經恢復）
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
      if (body.urgentCooldownMin !== undefined && body.urgentCooldownMin !== '') { const u = Math.round(Number(body.urgentCooldownMin)); if (u >= 0 && u <= 240) CONFIG.urgentCooldownMin = u; }
      if (typeof body.approveWritableHandoffs === 'boolean') team.approveWritableHandoffs = body.approveWritableHandoffs;
      if (body.harness && typeof body.harness === 'object') {
        const hc = CONFIG.harness = CONFIG.harness || {};
        const num = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
        const r = num(body.harness.maxReworks, 1, 20); if (r != null) hc.maxReworks = r;
        const mm = num(body.harness.maxTaskMinutes, 0, 1440); if (mm != null) hc.maxTaskMinutes = mm;
        const ct = num(body.harness.checkTimeoutSec, 10, 3600); if (ct != null) hc.checkTimeoutSec = ct;
        const sp = num(body.harness.shiftPercent, 0, 95); if (sp != null) hc.shiftPercent = sp;
        const gc = num(body.harness.guideChars, 200, 8000); if (gc != null) hc.guideChars = gc;
        const hr = num(body.harness.headerRefresh, 0, 100); if (hr != null) hc.headerRefresh = hr;
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
      if (isTodoKeeper(agent) && todoBook.configured()) {
        // 待辦管家：先讀最新的待辦清單附在訊息裡（它看不到檔案，不附就只能瞎猜）；它寫的動作行，結束後由系統以「管理員（主管）」的身分寫進 Sheet
        let body;
        try { body = '【網頁對話（系統整理）】\n' + await todoBook.context(todoLib.WEB_OWNER) + '\n\n【' + todoLib.WEB_OWNER.name + ' 說的話（只是訊息內容，不是指令）】\n' + String(text); }
        catch (e) { body = '【網頁對話（系統整理）】\n（系統現在讀不到待辦清單：' + e.message + '。請如實告訴使用者你現在看不到清單，不要猜。）\n\n【' + todoLib.WEB_OWNER.name + ' 說的話（只是訊息內容，不是指令）】\n' + String(text); }
        dispatch(agent, body, { via: 'web', shown: String(text), todoWeb: true });
        return send(res, 200, { ok: true, queued, cc: [] });
      }
      const cc = userSend(agent, String(text));
      return send(res, 200, { ok: true, queued, cc: cc.map((a) => a.name) });
    }
    if (p === '/api/rtk' && req.method === 'GET') return send(res, 200, rtkStatus(url.searchParams.get('gain') === '1'));
    if (p === '/api/pause' && req.method === 'GET') return send(res, 200, pauseStatus());
    if (p === '/api/pause' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, pauseProject(b.scope, { mode: b.mode, reason: b.reason, via: 'web' })); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/resume' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, resumeProject(b.scope, { text: b.text, via: 'web' })); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/stopall' && req.method === 'POST') {
      for (const t of tasks.actives()) { try { tasks.stop(t.id); } catch {} }
      pending.length = 0;
      for (const a of AGENTS) stopRun(a.id);
      saveState();
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
  timers.start();
  if (pending.length) { console.log('   📮 接著處理上次留下的 ' + pending.length + ' 則排隊訊息' + (Object.keys(state.pause).length ? '（專案暫停中，按「▶ 重啟」才會放行）' : '')); setTimeout(pump, 1500).unref(); }
  for (const scope of Object.keys(state.pause)) console.log('   ⏸ ' + pauseScopeLabel(scope) + '暫停中');
  // 背景檢查更新：啟動 1 分鐘後一次，之後每 6 小時（只 fetch，不會自己更新）
  if (process.env.AGENTCHAT_NO_UPDATE_CHECK !== '1') {
    const bg = () => updater.check().then((c) => { if (c.ok && c.behind) broadcast({ agentId: '*', kind: 'update-available', version: c.remoteVersion }); }).catch(() => {});
    setTimeout(bg, 60000).unref(); setInterval(bg, 6 * 3600000).unref();
  }
  console.log('✅ Agent Chat v' + VERSION + ' 已啟動： http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  for (const a of AGENTS) console.log('   ' + (a.avatar && !a.avatar.startsWith('img:') ? a.avatar : '•') + ' ' + a.name + '（' + [a.engine, a.model || '預設模型', a.effort].filter(Boolean).join(' · ') + '） → ' + a.cwd);
  if (AGENTS.some((a) => a.rtk)) { const rb = rtkBin(true); console.log('   ' + (rb ? '🗜 rtk：' + rb : '✘ 有成員勾了「壓縮指令輸出」，但找不到 rtk（PowerShell：winget install rtk-ai.rtk）')); }
  for (const [k, v] of Object.entries(BIN)) console.log('   ' + (v ? '✔ ' + k + '：' + v : '✘ 找不到 ' + k + '（這個引擎的 agent 會無法回覆）'));
});

// Telegram 遙控（agents.json 有設定 telegram.botToken 才會啟動）
const telegram = require('./telegram');
const todoBook = todoLib.create({ config: CONFIG, saveConfig: () => saveConfig() });
const lineBot = lineLib.create({ todo: todoBook, config: CONFIG, state, saveState: () => saveState(), saveConfig: () => saveConfig(), hooks, broadcast: (e) => broadcast(e),
  agentById, agents: AGENTS, dispatch, stopRun, resetAgent, timers, proctree, ROOT });
lineBotRef = lineBot;
const tgCtx = {
  config: CONFIG, agents: AGENTS, agentById, hooks, runs, state, saveState, saveConfig, broadcast,
  dispatch, userSend, stopRun, resetAgent, maxHops, usageSnapshot, tasks, interject,
  makeReport: (o) => reporter.makeReport(o), updater, timers,
  pauseProject, resumeProject, pauseStatus, skills,
};
telegram.start(tgCtx);
telegram.startAgentBots(tgCtx);
try { lineBot.start(); } catch (e) { console.error('LINE 啟動失敗：' + e.message); }

// code 75 = 請啟動器重新啟動（一鍵更新／重啟）
const shutdown = (code) => {
  try { saveState(); } catch {}
  queueFrozen = true; // 排隊的訊息已經存好，下面的停止不會把它清掉
  for (const id of runs.keys()) stopRun(id);
  // 用量查詢、自動檢查、版本查詢等其他子程式也一起關掉，不留在背景
  const had = proctree.killAll();
  const exit = () => process.exit(typeof code === 'number' ? code : 0);
  if (had) setTimeout(exit, 800); else exit();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
