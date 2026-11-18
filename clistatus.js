'use strict';
// 🧰 CLI 狀態：三個 CLI（Claude Code、Codex、Google agy）的安裝、登入、MCP 串接，以及每位成員實際用得到哪些 MCP。
// 只看不改：不寫任何 CLI 的設定檔；只跑不耗額度的查詢指令（--version、mcp list、login status），讀設定檔時只取名稱，
// 不回傳任何指令參數、環境變數、網址或 token（MCP 設定裡常有機密）。查不到就標「無法判斷」，不猜。
const fs = require('fs');
const os = require('os');
const path = require('path');

const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
const firstLine = (s) => strip(s).split('\n').map((l) => l.trim()).find(Boolean) || '';
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
const maskEmail = (e) => { const m = /^([^@]{1,2})[^@]*(@.+)$/.exec(String(e || '')); return m ? m[1] + '***' + m[2] : ''; };
// MCP 名稱只留安全字元（避免把奇怪的內容帶到網頁上）
const safeName = (n) => String(n || '').replace(/[^\w.@:/ -]/g, '').trim().slice(0, 60);

// ---------- 解析 ----------
// `claude mcp list`：每行「名稱: 指令或網址 - ✓ Connected」。只取名稱與狀態，指令與網址不保留（可能含 token）
function parseClaudeMcpList(text) {
  const out = [];
  for (const raw of strip(text).split('\n')) {
    const line = raw.trim();
    if (!line || /^checking mcp|^no mcp servers/i.test(line)) continue;
    const m = /^([^\s:][^:]{0,80}?):\s.*\s-\s+(.+)$/.exec(line);
    if (!m) continue;
    const st = m[2].trim();
    const status = /✓|connected/i.test(st) && !/not connected|disconnected/i.test(st) ? 'ok' : /auth|login|needs|pending|approv/i.test(st) ? 'warn' : /✗|fail|error|disconnected|not connected/i.test(st) ? 'fail' : 'unknown';
    out.push({ name: safeName(m[1]), status, detail: st.replace(/^[✓✗⚠!]\s*/, '').slice(0, 60) });
  }
  return out;
}
// Codex 的 config.toml：[mcp_servers.名稱] 段落（不讀 command／args／env 的值）
function parseCodexToml(text) {
  const out = [], seen = new Set();
  let cur = null;
  for (const raw of strip(text).split('\n')) {
    const line = raw.trim();
    const h = /^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\].]+))\]$/.exec(line);
    if (h) { const name = safeName(h[1] || h[2] || h[3]); cur = seen.has(name) ? null : { name, status: 'configured', detail: '已設定' }; if (cur) { seen.add(name); out.push(cur); } continue; }
    if (/^\[/.test(line)) { cur = null; continue; }
    if (cur && /^enabled\s*=\s*false/i.test(line)) { cur.status = 'off'; cur.detail = '已停用（enabled = false）'; }
  }
  return out;
}
// `codex mcp list --json`：只取名稱與是否啟用
function parseCodexJson(text) {
  let arr; try { arr = JSON.parse(strip(text).trim()); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr.filter((x) => x && x.name).map((x) => ({ name: safeName(x.name), status: x.enabled === false ? 'off' : 'configured', detail: x.enabled === false ? '已停用' : '已設定' }));
}
// `codex login status`
function parseCodexLogin(text) {
  const t = strip(text);
  if (/not logged in/i.test(t)) return { state: 'no', detail: '還沒登入' };
  if (/logged in using chatgpt/i.test(t)) return { state: 'ok', detail: '已登入（ChatGPT 帳號）' };
  if (/logged in using an? api key/i.test(t)) return { state: 'ok', detail: '已登入（API 金鑰）' };
  if (/logged in/i.test(t)) return { state: 'ok', detail: '已登入' };
  return null;
}
// ---------- 讀設定檔（只取名稱）----------
const claudeJsonPath = () => path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
function claudeConfigServers(cwd) {
  const j = readJson(claudeJsonPath()) || {}, out = [];
  const add = (obj, scope) => { for (const n of Object.keys(obj || {})) out.push({ name: safeName(n), status: 'configured', detail: '已設定（' + scope + '）' }); };
  add(j.mcpServers, '使用者');
  const projects = j.projects || {}, key = Object.keys(projects).find((k) => path.resolve(k).toLowerCase() === path.resolve(cwd).toLowerCase());
  if (key) add(projects[key].mcpServers, '這個資料夾');
  add((readJson(path.join(cwd, '.mcp.json')) || {}).mcpServers, '專案 .mcp.json');
  const seen = new Set();
  return out.filter((s) => (seen.has(s.name) ? false : seen.add(s.name)));
}
function claudeConfigLogin() {
  const j = readJson(claudeJsonPath());
  const acct = j && j.oauthAccount;
  if (acct && (acct.emailAddress || acct.accountUuid)) return { state: 'ok', detail: '已登入（訂閱帳號）', email: maskEmail(acct.emailAddress), org: String(acct.organizationName || '').slice(0, 40), source: '設定檔' };
  if (process.env.ANTHROPIC_API_KEY) return { state: 'ok', detail: '使用 API 金鑰（ANTHROPIC_API_KEY）', source: '環境變數' };
  return null;
}
function codexConfigLogin() {
  const j = readJson(path.join(codexHome(), 'auth.json'));
  if (!j) return null;
  if (j.tokens && (j.tokens.id_token || j.tokens.access_token)) return { state: 'ok', detail: '已登入（ChatGPT 帳號）', source: '設定檔' };
  if (j.OPENAI_API_KEY) return { state: 'ok', detail: '已登入（API 金鑰）', source: '設定檔' };
  return null;
}
// agy 的 MCP 設定位置還沒實測確認：找得到就列名稱，找不到就說無法判斷
const AGY_MCP_FILES = () => [path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'), path.join(os.homedir(), '.gemini', 'settings.json')];
function agyConfigServers() {
  for (const f of AGY_MCP_FILES()) {
    const j = readJson(f);
    if (j && j.mcpServers && typeof j.mcpServers === 'object') return { file: f, servers: Object.keys(j.mcpServers).map((n) => ({ name: safeName(n), status: 'configured', detail: '已設定' })) };
  }
  return null;
}

// ---------- 成員實際用得到哪些 ----------
function memberMcp(agent, servers) {
  const list = servers || [];
  if (agent.engine === 'agy') return { servers: list.map((s) => s.name), note: agent.agyAccess === 'write' ? 'agy 成員能不能用 MCP 還沒實測' : '唯讀（計畫模式）：能不能用 MCP 還沒實測' };
  if (agent.engine === 'codex') return { servers: list.filter((s) => s.status !== 'off').map((s) => s.name), note: (agent.sandbox || 'workspace-write') === 'read-only' ? '唯讀沙箱：MCP 工具若要寫入或連網可能被擋' : '' };
  const deny = (agent.disallowedTools || []).filter((t) => /^mcp__/.test(t));
  const denied = (n) => deny.some((t) => t === 'mcp__' + n || t.startsWith('mcp__' + n + '__'));
  let names = list.filter((s) => !denied(s.name)).map((s) => s.name), note = '';
  if (agent.permissionMode === 'default' && (agent.allowedTools || []).length) {
    const allow = agent.allowedTools.filter((t) => /^mcp__/.test(t));
    names = names.filter((n) => allow.some((t) => t === 'mcp__' + n || t.startsWith('mcp__' + n + '__')));
    note = allow.length ? '最小權限：只能用允許清單裡的 MCP' : '最小權限：允許清單沒有 MCP，實際用不到';
  } else if (agent.permissionMode === 'plan') note = 'plan 模式：只規劃，不會實際動手';
  if (deny.length) note = (note ? note + '；' : '') + '已排除 ' + deny.length + ' 項';
  return { servers: names, note };
}

function create(ctx) {
  // ctx: { getBin(engine), run(cmd, args, { cwd, timeoutMs }) → { code, out, err }, agents() → 執行中的成員, seen() → 最近一次執行的結果, broadcast }
  let last = null, running = null;
  const T = 45000;

  async function version(bin) {
    if (!bin) return null;
    const r = await ctx.run(bin, ['--version'], { timeoutMs: 20000 });
    return r.code === 0 ? firstLine(r.out || r.err).slice(0, 60) : null;
  }

  async function checkClaude(bin, cwds) {
    const e = { engine: 'claude', name: 'Claude Code', installed: !!bin, version: null, login: null, mcp: [], loginHelp: '在 PowerShell 執行 claude，依畫面登入（或在 claude 裡輸入 /login）' };
    if (!bin) return e;
    e.version = await version(bin);
    // 不跑 `claude auth status`：舊版沒有這個子指令，可能被當成一句提示送出、用掉額度。改讀設定檔＋最近一次執行
    e.login = claudeConfigLogin() || { state: 'unknown', detail: '無法判斷（設定檔裡找不到登入資料）' };
    const s = ctx.seen().claude; if (s) e.login.lastRun = s;
    for (const cwd of cwds) {
      const r = await ctx.run(bin, ['mcp', 'list'], { cwd, timeoutMs: T });
      const list = r.code === 0 ? parseClaudeMcpList(r.out) : null;
      e.mcp.push(list ? { cwd, servers: list, source: 'claude mcp list（有實際連線檢查）' }
        : { cwd, servers: claudeConfigServers(cwd), source: '設定檔（claude mcp list 失敗，沒有連線檢查）' });
    }
    return e;
  }

  async function checkCodex(bin) {
    const e = { engine: 'codex', name: 'Codex', installed: !!bin, version: null, login: null, mcp: [], loginHelp: '在 PowerShell 執行 codex login' };
    if (!bin) return e;
    e.version = await version(bin);
    const a = await ctx.run(bin, ['login', 'status'], { timeoutMs: 20000 });
    e.login = parseCodexLogin(a.out + '\n' + a.err);
    if (e.login) e.login.source = 'codex login status';
    else e.login = codexConfigLogin() || { state: 'unknown', detail: '無法判斷' };
    const s = ctx.seen().codex; if (s) e.login.lastRun = s;
    const r = await ctx.run(bin, ['mcp', 'list', '--json'], { timeoutMs: T });
    let list = r.code === 0 ? parseCodexJson(r.out) : null, source = 'codex mcp list';
    if (!list) { let t = ''; try { t = fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8'); } catch {} list = parseCodexToml(t); source = '設定檔 config.toml'; }
    e.mcp.push({ cwd: null, servers: list, source: source + '（Codex 不提供連線檢查）' });
    return e;
  }

  async function checkAgy(bin) {
    const e = { engine: 'agy', name: 'Google agy', installed: !!bin, version: null, login: null, mcp: [], loginHelp: '在 PowerShell 執行 agy，用 Google 帳號登入一次' };
    if (!bin) return e;
    e.version = await version(bin);
    // agy 沒有確認過的「查登入狀態」指令：用最近一次成員執行的結果判斷
    const s = ctx.seen().agy;
    e.login = s ? (s.ok ? { state: 'ok', detail: '最近一次執行正常', lastRun: s } : { state: s.login ? 'no' : 'warn', detail: s.login ? '最近一次執行出現登入錯誤' : '最近一次執行失敗', lastRun: s })
      : { state: 'unknown', detail: '還沒有成員執行過，無法判斷（agy 沒有查登入狀態的指令）' };
    e.login.source = '最近一次執行';
    const c = agyConfigServers();
    e.mcp.push(c ? { cwd: null, servers: c.servers, source: '設定檔 ' + path.basename(c.file) + '（沒有連線檢查）' } : { cwd: null, servers: [], source: '找不到 agy 的 MCP 設定（位置還沒實測確認）', unknown: true });
    return e;
  }

  async function refresh() {
    if (running) return running;
    running = (async () => {
      const agents = ctx.agents();
      const claudeCwds = [...new Set(agents.filter((a) => a.engine === 'claude').map((a) => a.cwd))].slice(0, 8);
      const [claude, codex, agy] = await Promise.all([checkClaude(ctx.getBin('claude'), claudeCwds), checkCodex(ctx.getBin('codex')), checkAgy(ctx.getBin('agy'))]);
      const engines = { claude, codex, agy };
      const members = agents.map((a) => {
        const e = engines[a.engine]; if (!e) return null;
        const block = a.engine === 'claude' ? e.mcp.find((m) => m.cwd === a.cwd) : e.mcp[0];
        const mm = memberMcp(a, block ? block.servers : []);
        return { id: a.id, name: a.name, avatar: a.avatar, engine: a.engine, cwd: a.cwd, standalone: !!a.standalone, ...mm };
      }).filter(Boolean);
      last = { at: Date.now(), engines: [claude, codex, agy], members };
      return last;
    })().finally(() => { running = null; if (ctx.broadcast) ctx.broadcast({ agentId: '*', kind: 'clistatus' }); });
    return running;
  }

  return { refresh, snapshot: () => ({ ...(last || { at: null, engines: [], members: [] }), running: !!running }) };
}

module.exports = { create, parseClaudeMcpList, parseCodexToml, parseCodexJson, parseCodexLogin, memberMcp, maskEmail };
