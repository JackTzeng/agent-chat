// 🐞 問題回報：把排查需要的資訊整理成一個 Markdown 檔，方便帶給 Claude 或其他人看。
// - 伺服器紀錄：攔截 console 輸出，保留最近 600 行，也寫進 data/logs/server.log（滿 2 MB 換檔）
// - 網頁錯誤：瀏覽器端的 JS 錯誤與失敗的 API 呼叫，保留最近 100 筆
// - 上次異常結束：未處理的例外會同步寫進 data/logs/crash.log，下次回報會附上
// 所有內容寫出前都會遮蔽密碼、token、API 金鑰與成員的環境變數值。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const proctree = require('./proctree');

const MAX_LOG = 600, MAX_CLIENT = 100, MAX_REPORTS = 30;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const short = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

// 常見的金鑰格式：就算不知道值，也用格式遮掉
const PATTERNS = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[TELEGRAM_TOKEN]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, '[API_KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[GITHUB_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[GOOGLE_KEY]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, '[SLACK_TOKEN]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[REDACTED]'],
  [/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)["']?[^\s"',;]{6,}/gi, '$1[REDACTED]'],
];

exports.create = function create(ctx) {
  const LOG_DIR = path.join(ctx.DATA_DIR, 'logs'), REP_DIR = path.join(ctx.DATA_DIR, 'reports');
  fs.mkdirSync(LOG_DIR, { recursive: true }); fs.mkdirSync(REP_DIR, { recursive: true });
  const LOG_FILE = path.join(LOG_DIR, 'server.log'), CRASH_FILE = path.join(LOG_DIR, 'crash.log');
  const startedAt = Date.now();
  const logs = [], clientErrors = [];
  // 上一次執行的最後 150 行（重新啟動、當機前發生了什麼）
  try {
    const prev = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-150);
    if (prev.length && prev[0]) { for (const l of prev) logs.push({ ts: 0, level: 'prev', text: l }); logs.push({ ts: 0, level: 'prev', text: '—————— 以上是這次啟動之前的紀錄 ——————' }); }
  } catch {}

  // 目前已知的秘密值：登入密碼、Telegram bot token、成員專屬環境變數的值
  function secrets() {
    const list = [];
    const C = ctx.CONFIG || {};
    if (C.telegram && C.telegram.botToken) list.push(C.telegram.botToken);
    if (C.todo && C.todo.key) list.push(C.todo.key);
    if (C.line) { if (C.line.channelSecret) list.push(C.line.channelSecret); if (C.line.channelAccessToken) list.push(C.line.channelAccessToken); }
    for (const a of C.agents || []) {
      if (a.telegram && a.telegram.botToken) list.push(a.telegram.botToken);
      for (const v of Object.values(a.env || {})) list.push(String(v));
    }
    for (const k of ['ACCESS_TOKEN', 'TELEGRAM_BOT_TOKEN']) if (process.env[k]) list.push(process.env[k]);
    return list.filter((v) => typeof v === 'string' && v.length >= 6);
  }
  function redact(s) {
    s = String(s == null ? '' : s);
    if (ctx.redact) s = ctx.redact(s, secrets());
    for (const v of secrets()) s = s.split(v).join('[REDACTED]');
    for (const [re, to] of PATTERNS) s = s.replace(re, to);
    return s;
  }

  // ---------- 伺服器紀錄 ----------
  function push(level, text) {
    const line = { ts: Date.now(), level, text: short(text, 2000) };
    logs.push(line); if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG);
    try {
      fs.appendFileSync(LOG_FILE, stamp(line.ts) + ' [' + level + '] ' + redact(line.text).replace(/\n/g, '\n    ') + '\n');
      if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch {}
  }
  const fmtArgs = (args) => args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'object' ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })() : String(a))).join(' ');
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); try { push(level === 'log' ? 'info' : level, fmtArgs(args)); } catch {} };
  }
  // 不改變原本的當機行為，只在當掉前把原因寫下來
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    try { fs.appendFileSync(CRASH_FILE, stamp(Date.now()) + ' ' + origin + '\n' + redact(err && err.stack || String(err)) + '\n\n'); } catch {}
  });
  push('info', 'Agent Chat v' + ctx.VERSION + ' 啟動（Node ' + process.version + '，' + process.platform + '）');

  function clientError(body, ua) {
    const e = { ts: Date.now(), kind: short(body && body.kind || 'error', 30), message: short(body && body.message, 800),
      where: short(body && body.where, 300), ua: short(ua, 200) };
    if (!e.message) return;
    clientErrors.push(e); if (clientErrors.length > MAX_CLIENT) clientErrors.splice(0, clientErrors.length - MAX_CLIENT);
  }

  // ---------- CLI 版本（快取 10 分鐘）----------
  const verCache = {};
  function cliVersion(engine) {
    const c = verCache[engine];
    if (c && Date.now() - c.at < 600000) return Promise.resolve(c.v);
    const cmd = ctx.getBin(engine);
    if (!cmd) return Promise.resolve('（找不到 ' + engine + ' 指令）');
    return new Promise((resolve) => {
      const needShell = process.platform === 'win32' && !/\.exe$/i.test(cmd);
      let out = '', done = false;
      const finish = (v) => { if (done) return; done = true; verCache[engine] = { at: Date.now(), v }; resolve(v); };
      let proc;
      try { proc = proctree.track(spawn(needShell && /\s/.test(cmd) ? '"' + cmd + '"' : cmd, ['--version'], { shell: needShell, env: ctx.safeEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...proctree.groupOpts() })); }
      catch (e) { return finish('（無法執行：' + e.message + '）'); }
      const timer = setTimeout(() => { proctree.killTree(proc); finish('（逾時）'); }, 10000);
      proc.stdout.on('data', (d) => (out += d)); proc.stderr.on('data', (d) => (out += d));
      proc.on('error', (e) => { clearTimeout(timer); finish('（無法執行：' + e.message + '）'); });
      proc.on('close', () => { clearTimeout(timer); finish(short(out.trim().split(/\r?\n/)[0] || '（沒有輸出）', 200) + '（' + cmd + '）'); });
    });
  }

  // ---------- 產生回報 ----------
  const tail = (f, n) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').slice(-n); } catch { return []; } };
  const code = (s, lang) => '```' + (lang || '') + '\n' + String(s).replace(/```/g, "'''") + '\n```';
  function agentSummary(a, pub) {
    const L = [];
    L.push('- **' + a.name + '**（id: `' + a.id + '`）' + (a.standalone ? '｜🧍 獨立成員' : '｜小組：' + (((ctx.CONFIG.teams || []).find((t) => t.id === a.team) || {}).name || a.team)));
    L.push('  - 引擎：' + a.engine + (a.model ? ' / ' + a.model : '') + (a.effort ? ' / ' + a.effort : '') +
      '｜權限：' + (a.engine === 'codex' ? 'sandbox ' + (a.sandbox || 'workspace-write') : 'mode ' + (a.permissionMode || '預設')) +
      (a.takeTurns ? '｜🔁 輪流' : '') + (a.blocked ? '｜⛔ 暫停使用：' + (a.blocked.reason || '') : ''));
    L.push('  - 工作資料夾：`' + a.cwd + '`' + ((a.extraDirs || []).length ? '｜額外：' + a.extraDirs.map((d) => '`' + d.path + '`(' + (d.mode || 'rw') + ')').join('、') : ''));
    if (a.tools || (a.allowedTools || []).length || (a.disallowedTools || []).length)
      L.push('  - 工具：' + (a.tools || '（全部）') + '｜允許：' + ((a.allowedTools || []).join(' ') || '—') + '｜禁止：' + ((a.disallowedTools || []).join(' ') || '—'));
    if (a.env && Object.keys(a.env).length) L.push('  - 環境變數（只列名稱）：' + Object.keys(a.env).join('、'));
    if (pub) L.push('  - 狀態：' + (pub.busy ? '⚙️ 工作中' + (pub.stalled ? '（可能卡住）' : '') + '，開始於 ' + stamp(pub.runningSince) : '閒置') +
      (pub.queued ? '｜排隊 ' + pub.queued : '') + '｜對話：' + (pub.hasSession ? '有' : '新對話') +
      (pub.ctx ? '｜context ' + pub.ctx.pct + '%' : '') + '｜第 ' + pub.shiftNo + ' 班');
    return L.join('\n');
  }
  // full：最近 n 則對話（使用者訊息、回覆文字、錯誤）；否則只挑錯誤
  function historyTail(id, n, full) {
    const out = [];
    for (const m of ctx.loadHistory(id) || []) {
      const when = '[' + stamp(m.ts || 0) + '] ';
      const segs = Array.isArray(m.segments) ? m.segments : [];
      const errs = segs.filter((x) => x.type === 'error').map((x) => x.text);
      if (full) {
        if (m.role === 'user') out.push(when + '使用者' + (m.from ? '(' + m.from + ')' : '') + '：' + short(String(m.text || '').replace(/\s+/g, ' '), 600));
        else {
          const txt = segs.filter((x) => x.type === 'text').map((x) => x.text).join(' ');
          const tools = segs.filter((x) => x.type === 'tool').length;
          out.push(when + '回覆' + (tools ? '（用了 ' + tools + ' 次工具）' : '') + '：' + short(txt.replace(/\s+/g, ' '), 600) + (errs.length ? '｜錯誤：' + short(errs.join(' / '), 400) : '') + (m.meta ? '｜' + short(m.meta, 120) : ''));
        }
      } else if (errs.length) out.push(when + '錯誤' + (m.taskId ? '（任務 #' + m.taskId + '）' : '') + '：' + short(errs.join(' / ').replace(/\s+/g, ' '), 600));
    }
    return out.slice(-n);
  }

  async function makeReport(opts = {}) {
    const now = Date.now();
    const C = ctx.CONFIG;
    const L = [];
    L.push('# Agent Chat 問題回報', '');
    L.push('> 把這個檔案拖進 Claude 的對話就能排查。密碼、token、API 金鑰與成員環境變數的值已自動遮蔽；' + (opts.includeChat ? '**包含最近的對話內容**，' : '不含對話內容，') + '寄出前可以先打開看一下。', '');
    L.push('- 產生時間：' + stamp(now) + '（' + Intl.DateTimeFormat().resolvedOptions().timeZone + '）');
    L.push('- 來源：' + (opts.via || '網頁'));
    L.push('', '## 1. 發生了什麼事', '', opts.description ? opts.description : '（使用者沒有填寫）');
    if (opts.agentId) { const a = ctx.agentById(opts.agentId); L.push('', '相關成員：' + (a ? a.name + '（' + a.id + '）' : opts.agentId)); }
    if (opts.taskId) L.push('相關任務：#' + opts.taskId);

    L.push('', '## 2. 環境', '');
    const [cv, xv] = await Promise.all([cliVersion('claude'), cliVersion('codex')]);
    L.push('- Agent Chat：v' + ctx.VERSION + (opts.uiVersion && opts.uiVersion !== ctx.VERSION ? '（⚠️ 網頁是 v' + opts.uiVersion + '，請按 F5 重新整理）' : ''));
    L.push('- Node.js：' + process.version + '｜' + process.platform + ' ' + os.release() + ' ' + process.arch + '｜電腦名稱：' + os.hostname());
    L.push('- 伺服器已執行：' + Math.round((now - startedAt) / 60000) + ' 分鐘｜記憶體：' + Math.round(process.memoryUsage().rss / 1048576) + ' MB｜可用記憶體：' + Math.round(os.freemem() / 1048576) + ' MB');
    L.push('- Claude CLI：' + cv);
    L.push('- Codex CLI：' + xv);
    L.push('- 程式資料夾：`' + ctx.ROOT + '`');
    const g = (args) => { try { const r = spawnSync('git', args, { cwd: ctx.ROOT, encoding: 'utf8', windowsHide: true, timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : ''; } catch { return ''; } };
    const head = g(['log', '-1', '--format=%h %s (%ci)']);
    const dirty = g(['diff', '--name-only', 'HEAD']);
    L.push('- git：' + (head || '（不是 git 資料夾或找不到 git）') + (dirty ? '｜⚠️ 自己改過的檔案：' + dirty.split('\n').join('、') : ''));
    const us = ctx.updateStatus ? ctx.updateStatus() : null;
    if (us) L.push('- 啟動方式：' + (us.launcher ? 'start.bat → launcher.js（可一鍵重啟）' : '直接執行 server.js（不能一鍵重啟）') +
      (us.failed ? '｜⚠️ 上次更新失敗、已退回：' + JSON.stringify(us.failed) : '') + (us.last && !us.last.ok ? '｜上次檢查更新失敗：' + us.last.error : ''));
    const ls = ctx.localSettings ? ctx.localSettings() : null;
    if (ls) L.push('- local-settings.txt：' + (ls.exists ? '有（' + (ls.keys.join('、') || '沒有設定') + '）' : '沒有') +
      (ls.moved && ls.moved.length ? '｜這次啟動從 start.local.bat 搬過來：' + ls.moved.map((l) => l.split('=')[0]).join('、') : '') +
      (ls.missingRoots && ls.missingRoots.length ? '｜⚠️ 不存在而略過的資料夾：' + ls.missingRoots.join('、') : ''));
    L.push('- 允許的資料夾（AGENT_ALLOWED_ROOTS）：' + ((ctx.allowedRoots || []).map((d) => '`' + d + '`').join('、') || '—'));
    L.push('- 監聽：' + ctx.HOST + ':' + ctx.PORT + '｜ALLOWED_HOSTS：' + (process.env.ALLOWED_HOSTS ? '有設定' : '未設定'));
    L.push('- 瀏覽器：' + short(opts.userAgent || '（不明）', 200));

    L.push('', '## 3. 成員', '');
    for (const a of ctx.AGENTS) L.push(agentSummary(a, ctx.publicAgent(a)));

    L.push('', '## 4. 小組與工作流程', '');
    for (const t of C.teams || []) {
      const st = (t.workflow && t.workflow.stages) || [];
      L.push('- **' + (t.icon || '') + ' ' + t.name + '**（`' + t.id + '`）' + (t.cwd ? '｜資料夾 `' + t.cwd + '`' : '') +
        '｜流程：' + (st.map((s) => s.name + (s.approval ? '🔒' : '') + (s.owner ? '(' + ((ctx.agentById(s.owner) || {}).name || s.owner + '❓') + ')' : '(❓無負責人)') +
          ((s.checks || []).length ? '🧪' + s.checks.length : '')).join(' → ') || '（沒有階段）'));
    }
    L.push('- 設定：交接上限 ' + (C.maxRelayHops || 12) + '｜Harness ' + JSON.stringify(ctx.harnessCfg()));

    L.push('', '## 5. 任務', '');
    const acts = ctx.tasks.actives();
    if (!acts.length) L.push('（目前沒有進行中的任務）');
    for (const t of acts) L.push('- 進行中 #' + t.id + '「' + short(t.title, 60) + '」｜' + (t.teamName || '') + '｜' + t.statusText + (t.note ? '｜' + short(t.note, 200) : ''));
    const wantTask = opts.taskId || (acts[0] && acts[0].id);
    const recent = ctx.tasks.list().slice(0, 8);
    if (recent.length) L.push('', '最近的任務：', ...recent.map((t) => '- #' + t.id + ' ' + short(t.title, 50) + '｜' + (t.teamName || '') + '｜' + t.statusText + '｜' + stamp(t.updatedAt || t.createdAt)));
    if (wantTask) {
      const d = ctx.tasks.detail(wantTask);
      if (d) L.push('', '<details><summary>任務 #' + wantTask + ' 的 TASK.md</summary>', '', code(short(d.markdown, 12000), 'markdown'), '</details>');
    }

    if (ctx.timers) {
      const ts = ctx.timers();
      L.push('', '### ⏰ 排程', '');
      if (!ts.timers.length) L.push('（沒有排程）');
      for (const t of ts.timers) L.push('- #' + t.id + ' ' + t.name + '｜' + t.agentName + '｜' + t.desc + '｜' + (t.enabled ? '下次 ' + (t.nextRun ? stamp(t.nextRun) : '—') : '已停用') +
        (t.last ? '｜上次 ' + stamp(t.last.at) + ' ' + t.last.status + (t.last.summary ? '：' + short(t.last.summary, 120) : '') : '') + (t.active ? '｜⚙️ 進行中' : ''));
      const bad = ts.runs.filter((r) => ['failed', 'skipped', 'interrupted', 'stopped'].includes(r.status)).slice(0, 15);
      if (bad.length) L.push('', '最近的排程問題：', code(bad.map((r) => stamp(r.ts) + ' #' + r.timerId + ' ' + r.name + ' ' + r.status + (r.summary ? '：' + short(r.summary, 150) : '')).join('\n'), 'text'));
    }
    if (ctx.outbox) {
      const ob = ctx.outbox();
      if (ob && (ob.pending.length || ob.history.length)) {
        // 只列頻道、次數、錯誤，不列訊息內容
        L.push('', '### 📮 通知補送', '');
        for (const x of ob.pending) L.push('- 待重送 #' + x.id + '｜' + x.channel + '｜試了 ' + x.tries + ' 次｜建立 ' + stamp(x.created) + (x.waiting ? '｜頻道還沒啟動' : '') + '｜' + short(x.lastError, 150));
        for (const x of ob.history.filter((h) => h.status !== 'sent').slice(0, 10)) L.push('- ' + x.status + ' #' + x.id + '｜' + x.channel + '｜' + stamp(x.at) + '｜' + short(x.error, 150));
        const sent = ob.history.filter((h) => h.status === 'sent').length;
        if (sent) L.push('- 最近補送成功 ' + sent + ' 則');
      }
    }
    L.push('', '## 6. 最近的錯誤與事件', '');
    const ev = ctx.harnessRuns(150).filter((r) => r.type !== 'turn' || r.error || r.interrupted);
    L.push(ev.length ? code(ev.slice(-60).map((r) => stamp(r.ts) + ' ' + JSON.stringify({ ...r, ts: undefined })).join('\n'), 'text') : '（沒有）');
    const per = [];
    for (const a of ctx.AGENTS) {
      const lines = historyTail(a.id, opts.includeChat ? 15 : 8, !!opts.includeChat);
      if (lines.length) per.push('### ' + a.name + (opts.includeChat ? '（最近 15 則對話）' : '（最近的錯誤與系統訊息）'), code(lines.join('\n'), 'text'));
    }
    L.push(...(per.length ? per : ['（各成員的對話裡沒有錯誤訊息）']));

    L.push('', '## 7. 網頁端錯誤', '');
    L.push(clientErrors.length ? code(clientErrors.slice(-40).map((e) => stamp(e.ts) + ' [' + e.kind + '] ' + e.message + (e.where ? ' @ ' + e.where : '')).join('\n'), 'text') : '（沒有）');

    L.push('', '## 8. Telegram', '');
    try { const s = { ...ctx.telegramStatus() }; delete s.pairing; L.push(code(JSON.stringify(s, null, 2), 'json')); } catch (e) { L.push('（無法取得：' + e.message + '）'); }

    L.push('', '## 8b. 使用者錯誤回報（LINE 上說「錯誤回報 …」，最近 20 則）', '');
    try { const fb = ctx.feedback ? ctx.feedback(20) : []; L.push(fb.length ? fb.map((f) => '- #' + f.id + ' ' + stamp(f.ts) + '｜' + f.via + '｜' + f.who + '｜對象：' + f.agentName + '\n  回報：' + f.text + (f.lastReply ? '\n  bot 上一則回覆：' + f.lastReply.replace(/\n/g, ' ') : '')).join('\n') : '（沒有）'); } catch (e) { L.push('（無法取得：' + e.message + '）'); }

    L.push('', '## 9. 伺服器紀錄（最近 300 行）', '');
    L.push(code(logs.slice(-300).map((l) => (l.level === 'prev' ? l.text : stamp(l.ts) + ' [' + l.level + '] ' + l.text)).join('\n') || '（沒有）', 'text'));
    const crash = tail(CRASH_FILE, 60);
    if (crash.length) L.push('', '### 上次異常結束（crash.log）', '', code(crash.join('\n'), 'text'));

    let text = redact(L.join('\n') + '\n');
    if (text.length > 400000) text = text.slice(0, 400000) + '\n\n（回報太長，後面省略）\n';
    const d = new Date(now);
    const name = 'agentchat-report-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.md';
    fs.writeFileSync(path.join(REP_DIR, name), text);
    // 只保留最近 30 份
    try { for (const f of listReports().slice(MAX_REPORTS)) fs.unlinkSync(path.join(REP_DIR, f.name)); } catch {}
    push('info', '已產生問題回報 ' + name);
    return { name, file: path.join(REP_DIR, name), size: Buffer.byteLength(text) };
  }
  function listReports() {
    try {
      return fs.readdirSync(REP_DIR).filter((f) => /^agentchat-report-[\d-]+\.md$/.test(f))
        .map((f) => ({ name: f, size: fs.statSync(path.join(REP_DIR, f)).size, at: fs.statSync(path.join(REP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
    } catch { return []; }
  }
  function reportPath(name) {
    if (!/^agentchat-report-[\d-]+\.md$/.test(String(name))) return null;
    const f = path.join(REP_DIR, name);
    return fs.existsSync(f) ? f : null;
  }

  return { makeReport, listReports, reportPath, clientError, redact, REP_DIR };
};
