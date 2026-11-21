'use strict';
// ⚙️ 每輪結束後執行（沙箱外）：獨立成員每一輪結束後，由 Agent Chat 在沙箱外執行一個「你事先設定好」的指令。
// 用途例：記帳員在沙箱裡記帳（不能連網），每輪結束後由這裡跑 `ledger/ledger.cmd sync` 把帳本同步到 Google Sheet。
// Agent Chat 不知道指令在做什麼（記帳邏輯不在這裡），只負責「安全地、在對的時機、跑一次」。
//
// 安全設計：
// - 只能由你在網頁設定（模型的輸出完全不會變成指令或參數）；指令檔必須在成員的工作資料夾裡（不接受 ..、絕對路徑、PATH 查找）
// - 不經 shell：一般執行檔直接執行；Windows 的 .cmd／.bat 經 cmd.exe，但指令路徑與參數都限制在安全字元，不可能夾帶 & | < > 等
// - 🔒 鎖定檔案：成員能改寫自己工作資料夾裡的檔案，如果它（或被誘導）改了這支程式，這裡就會在沙箱外執行被改過的程式。
//   所以儲存設定時記下指令檔與同資料夾程式檔的指紋，每次執行前比對，**有任何不同就不執行**，等你看過後按「重新核准」。
// - 同一位成員同時只跑一個；執行中又有一輪結束 → 只排「再跑一次」；結果寫稽核紀錄；輸出不會餵回模型、不會傳到 Telegram／LINE
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const SAFE_ARG = /^[\w.\-=:/@+,]{1,200}$/;          // 參數：不含空白、引號、& | < > ^ % ! 等
const SAFE_PATH = /^[\w.\-/\\ ()　-鿿＀-￯]+$/; // 指令路徑：可以有中文與空白，不能有 cmd 的特殊字元
const PIN_EXT = /\.(cmd|bat|ps1|py|js|mjs|cjs|vbs|sh|exe|dll|pyd|so)$/i;
const PIN_SKIP = new Set(['.venv', 'venv', 'node_modules', 'data', 'backups', 'attachments', '.git', '__pycache__', '.pytest_cache', 'tmp', 'logs']);
const MAX_PIN_FILES = 3000, MAX_PIN_BYTES = 200 * 1024 * 1024;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// 設定（從網頁來的）→ 驗證、正規化。cwd 是成員工作資料夾的完整路徑
function normalize(input, cwd, security) {
  if (!input || !String(input.command || '').trim()) return null;
  const command = String(input.command).trim().replace(/\\/g, '/');
  if (path.isAbsolute(command) || /^[a-z]:/i.test(command) || command.split('/').includes('..')) throw new Error('每輪後執行：指令要寫成工作資料夾裡的相對路徑（例如 ledger/ledger.cmd），不能用絕對路徑或 ..');
  if (!SAFE_PATH.test(command)) throw new Error('每輪後執行：指令路徑有不允許的字元（& | < > ^ % ! " 等）');
  try { security.fileWithin(cwd, command); } catch (e) { throw new Error('每輪後執行：在工作資料夾裡找不到「' + command + '」（' + e.message + '）'); }
  const args = (Array.isArray(input.args) ? input.args : String(input.args || '').split(/\s+/)).map((x) => String(x).trim()).filter(Boolean);
  if (args.length > 10) throw new Error('每輪後執行：參數最多 10 個');
  for (const a of args) if (!SAFE_ARG.test(a)) throw new Error('每輪後執行：參數「' + a + '」有不允許的字元（只能用英數字與 . - _ = : / @ + ,，不能有空白或引號）');
  let ifChanged = String(input.ifChanged || '').trim().replace(/\\/g, '/');
  if (ifChanged) {
    if (path.isAbsolute(ifChanged) || /^[a-z]:/i.test(ifChanged) || ifChanged.split('/').includes('..')) throw new Error('每輪後執行：「只有這個檔案有變動才執行」要寫工作資料夾裡的相對路徑');
    const full = path.resolve(cwd, ifChanged), rel = path.relative(cwd, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('每輪後執行：監看的檔案超出工作資料夾');
  }
  const timeoutSec = Math.min(600, Math.max(5, parseInt(input.timeoutSec, 10) || 60));
  const pin = (Array.isArray(input.pin) ? input.pin : String(input.pin || '').split(/[,\n]+/)).map((x) => String(x).trim().replace(/\\/g, '/')).filter(Boolean).slice(0, 20);
  for (const p of pin) if (path.isAbsolute(p) || /^[a-z]:/i.test(p) || p.split('/').includes('..')) throw new Error('每輪後執行：鎖定範圍要寫工作資料夾裡的相對路徑');
  return { command, args, ifChanged, timeoutSec, pin };
}

// 🔒 鎖定的檔案：指令檔＋（沒指定就）指令所在資料夾裡的程式檔（跳過 .venv、data、backups 等）
function pinnedFiles(cfg, cwd) {
  const roots = cfg.pin && cfg.pin.length ? cfg.pin : [path.posix.dirname(cfg.command) === '.' ? cfg.command : path.posix.dirname(cfg.command)];
  const files = new Set([path.resolve(cwd, cfg.command)]);
  let bytes = 0;
  const walk = (full, depth) => {
    let st; try { st = fs.statSync(full); } catch { return; }
    if (st.isFile()) { if (PIN_EXT.test(full) || files.has(full)) { files.add(full); bytes += st.size; } return; }
    if (!st.isDirectory() || depth > 8) return;
    for (const n of fs.readdirSync(full)) { if (PIN_SKIP.has(n.toLowerCase()) || /^tmp/i.test(n)) continue; walk(path.join(full, n), depth + 1); if (files.size > MAX_PIN_FILES) return; }
  };
  for (const r of roots) { const full = path.resolve(cwd, r), rel = path.relative(cwd, full); if (rel.startsWith('..') || path.isAbsolute(rel)) continue; walk(full, 0); }
  if (files.size > MAX_PIN_FILES || bytes > MAX_PIN_BYTES) throw new Error('每輪後執行：鎖定範圍太大（' + files.size + ' 個檔），請在「鎖定範圍」指定比較小的資料夾');
  return [...files].sort();
}
function fingerprint(cfg, cwd) {
  const map = {};
  for (const f of pinnedFiles(cfg, cwd)) { try { map[path.relative(cwd, f).replace(/\\/g, '/')] = sha(fs.readFileSync(f)); } catch { map[path.relative(cwd, f).replace(/\\/g, '/')] = 'missing'; } }
  return { hash: sha(Object.keys(map).sort().map((k) => k + '\0' + map[k]).join('\n')), files: map };
}

function create(ctx) {
  // ctx: { security, proctree, agentById, state, saveState, broadcast, logExchange, appendAudit, redact, decodeOutput }
  const S = () => { ctx.state.afterTurn = ctx.state.afterTurn || {}; return ctx.state.afterTurn; };
  const st = (id) => { const s = S(); s[id] = s[id] || {}; return s[id]; };
  const running = new Map(); // 成員 id → { proc, again }
  const statOf = (agent) => { try { const x = fs.statSync(path.resolve(agent.cwd, agent.afterTurn.ifChanged)); return x.mtimeMs + ':' + x.size; } catch { return 'none'; } };
  const enabled = (agent) => !!(agent && agent.standalone && agent.afterTurn && agent.afterTurn.command && !agent.blocked);

  // 開始一輪前：記下監看檔案的樣子（之後比對有沒有變）
  function before(agent) { if (enabled(agent) && agent.afterTurn.ifChanged) st(agent.id).seen = statOf(agent); }
  // 一輪結束：要不要跑
  function after(agent) {
    if (!enabled(agent)) return;
    const s = st(agent.id);
    if (agent.afterTurn.ifChanged) {
      const now = statOf(agent);
      if (s.seen === now) return; // 監看的檔案沒變（例如閒聊、查詢）→ 不跑
      s.seen = now;
    }
    trigger(agent.id);
  }
  function trigger(id) {
    const r = running.get(id);
    if (r) { r.again = true; return 'queued'; } // 執行中：只排一次「再跑一次」
    run(id);
    return 'started';
  }
  function record(agent, rec) {
    try { ctx.appendAudit(agent, { ts: Date.now(), agent: agent.id, type: 'afterTurn', command: [agent.afterTurn.command, ...agent.afterTurn.args].join(' '), ...rec }); } catch {}
  }
  function run(id) {
    const agent = ctx.agentById(id); if (!enabled(agent)) return;
    const cfg = agent.afterTurn, s = st(id);
    // 🔒 檔案被改過就不執行
    let fp; try { fp = fingerprint(cfg, agent.cwd); } catch (e) { fp = { hash: 'error:' + e.message, files: {} }; }
    if (!cfg.approvedHash || fp.hash !== cfg.approvedHash) {
      const changed = Object.keys({ ...fp.files, ...(cfg.approvedFiles || {}) }).filter((k) => (fp.files[k] || 'missing') !== ((cfg.approvedFiles || {})[k] || 'missing'));
      if (!s.needsApproval) {
        ctx.logExchange(agent, '', '🔒 每輪後執行（' + cfg.command + '）先暫停：鎖定的程式檔跟你核准時不一樣' + (changed.length ? '（' + changed.slice(0, 5).join('、') + (changed.length > 5 ? ' 等 ' + changed.length + ' 個' : '') + '）' : '') +
          '。可能是你自己更新了程式，也可能是成員改了它。確認沒問題後，到這位成員的設定按「🔒 重新核准」。');
        console.warn('🔒 ' + agent.name + ' 的每輪後執行已暫停：鎖定的檔案被改過');
      }
      s.needsApproval = true; s.changed = changed.slice(0, 20); ctx.saveState(); ctx.broadcast({ kind: 'afterturn', agentId: id });
      record(agent, { skipped: 'pinMismatch', changed: changed.slice(0, 20) });
      return;
    }
    const full = path.resolve(agent.cwd, cfg.command);
    const isCmd = IS_WIN && /\.(cmd|bat)$/i.test(full);
    // .cmd／.bat 要經 cmd.exe：路徑與參數都已限制在安全字元，整串用引號包好、不讓 cmd 再解讀
    const spawnArgs = isCmd ? ['/d', '/s', '/c', '""' + full + '"' + (cfg.args.length ? ' ' + cfg.args.join(' ') : '') + '"'] : cfg.args;
    const started = Date.now();
    let out = Buffer.alloc(0), timedOut = false, proc;
    const r = { proc: null, again: false }; running.set(id, r);
    const finish = (code, errMsg) => {
      if (r.done) return; r.done = true; clearTimeout(timer); running.delete(id);
      const text = ctx.redact(ctx.decodeOutput(out) + (errMsg ? '\n' + errMsg : '')).trim();
      const ok = code === 0 && !timedOut;
      record(agent, { exitCode: code, ms: Date.now() - started, timedOut, out: text.slice(-800) });
      const wasFailing = (s.fails || 0) > 0;
      s.lastAt = Date.now(); s.lastExit = code; s.lastMs = Date.now() - started; s.lastOut = text.slice(-300);
      if (ok) { s.fails = 0; if (wasFailing) ctx.logExchange(agent, '', '✅ 每輪後執行（' + cfg.command + '）恢復正常。'); }
      else {
        s.fails = (s.fails || 0) + 1;
        if (s.fails === 1 || s.fails % 10 === 0) ctx.logExchange(agent, '', '⚠️ 每輪後執行（' + cfg.command + ' ' + cfg.args.join(' ') + '）' + (timedOut ? '超過 ' + cfg.timeoutSec + ' 秒被停止' : '失敗（結束碼 ' + code + '）') + (s.fails > 1 ? '，已連續 ' + s.fails + ' 次' : '') + (text ? '：\n' + text.slice(-400) : ''));
      }
      ctx.saveState(); ctx.broadcast({ kind: 'afterturn', agentId: id });
      if (r.again) setImmediate(() => run(id));
    };
    try {
      proc = ctx.proctree.track(spawn(isCmd ? process.env.ComSpec || 'cmd.exe' : full, spawnArgs, { cwd: agent.cwd, shell: false, windowsHide: true, windowsVerbatimArguments: isCmd,
        env: { ...ctx.security.safeEnvironment(), ...(agent.env || {}) }, ...ctx.proctree.groupOpts() }));
    } catch (e) { return finish(-1, e.message); }
    r.proc = proc;
    const add = (d) => { if (out.length < 64000) out = Buffer.concat([out, d]); };
    proc.stdout.on('data', add); proc.stderr.on('data', add);
    proc.on('error', (e) => finish(-1, e.message));
    proc.on('close', (code) => finish(code == null ? -1 : code));
    const timer = setTimeout(() => { timedOut = true; ctx.proctree.killTree(proc); finish(-1); }, cfg.timeoutSec * 1000);
  }
  // 你核准（儲存設定或按「重新核准」）：記下目前的指紋
  function approve(cfg, cwd) { const fp = fingerprint(cfg, cwd); return { ...cfg, approvedHash: fp.hash, approvedFiles: fp.files, approvedAt: Date.now() }; }
  function clearAlert(id) { const s = st(id); delete s.needsApproval; delete s.changed; ctx.saveState(); }
  const status = (id) => { const s = S()[id] || {}; return { needsApproval: !!s.needsApproval, changed: s.changed || [], lastAt: s.lastAt || null, lastExit: s.lastExit ?? null, lastMs: s.lastMs || null, fails: s.fails || 0, lastOut: s.lastOut || '', running: running.has(id) }; };
  return { before, after, trigger, approve, clearAlert, status, normalize: (input, cwd) => normalize(input, cwd, ctx.security), fingerprint };
}

module.exports = { create, normalize, fingerprint, pinnedFiles };
