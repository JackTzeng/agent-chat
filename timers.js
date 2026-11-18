// ⏰ 排程：定時叫某位成員做一件事（例如每小時檢查派工、每天 08:30 整理昨天的帳）
// 依照 Claude 常駐代理指南的做法：
// - 排程表（data/timers.json）只放「未來要做的事」；到期時變成一則普通訊息交給成員（和你傳訊息走同一條路）
// - 每次觸發都記下「哪一次」（firedKey），重新啟動後不會重複觸發同一次；錯過的（電腦或程式沒開）補做一次
// - 上一次還沒做完就略過這一次，不會疊在一起
// - 「做完」和「要不要通知」分開判斷：成員回【無異常】就安靜，【通知】才傳到 Telegram；跟上次一樣的通知不重複發
// - 成員可以用【排程建議】提出排程，要你核准才會生效
// - 沒事就不要叫醒成員：
//   · 前置檢查（precheck）：到點先跑一個小指令，沒有輸出 = 沒有待辦 → 跳過，不花 AI 額度；有輸出才叫醒成員並附上輸出
//   · 成員回【排程暫停】→ 排程先暫停，有新任務開始時自動恢復
'use strict';
const fs = require('fs');
const path = require('path');

const MIN_EVERY = 15;          // 最短每 15 分鐘一次（每次都會用到 CLI 額度）
const MAX_TIMERS = 50;
const MAX_RUNS_LOG = 300;
const DAY = 86400000;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
const fmt = (ts) => { if (!ts) return '—'; const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm(d); };
const short = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const parseHM = (s) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); if (!m || +m[1] > 23 || +m[2] > 59) return null; return +m[1] * 60 + +m[2]; };

// ---------- 排程規則 ----------
// schedule：{ kind:'every', minutes } | { kind:'daily', time:'08:30' } | { kind:'once', at: 時間戳 }
// days：允許的星期（0=日 … 6=六），空 = 每天；hours：{ from:'08:00', to:'18:00' } 只用在 every
function cleanSchedule(input) {
  const s = input && input.schedule || {};
  const kind = ['every', 'daily', 'once'].includes(s.kind) ? s.kind : null;
  if (!kind) throw new Error('請選擇排程方式');
  const out = { kind };
  if (kind === 'every') {
    const m = Math.round(Number(s.minutes));
    if (!(m >= MIN_EVERY && m <= 7 * 24 * 60)) throw new Error('間隔要在 ' + MIN_EVERY + ' 分鐘到 7 天之間');
    out.minutes = m;
  } else if (kind === 'daily') {
    if (parseHM(s.time) == null) throw new Error('時間格式要像 08:30');
    out.time = String(s.time).padStart(5, '0');
  } else {
    const at = typeof s.at === 'number' ? s.at : Date.parse(s.at);
    if (!at || Number.isNaN(at)) throw new Error('請填寫執行時間');
    out.at = at;
  }
  const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [];
  let hours = null;
  if (kind === 'every' && input.hours && (input.hours.from || input.hours.to)) {
    const f = parseHM(input.hours.from), t = parseHM(input.hours.to);
    if (f == null || t == null || f >= t) throw new Error('工作時間要像 08:00～18:00，而且開始要早於結束');
    hours = { from: input.hours.from.padStart(5, '0'), to: input.hours.to.padStart(5, '0') };
  }
  return { schedule: out, days: days.length === 7 ? [] : days, hours };
}

// 前置檢查指令：一行、不超過 500 字、不能有控制字元
function cleanPrecheck(v) {
  const c = String(v || '').trim();
  if (!c) return '';
  if (c.length > 500 || /[\u0000-\u001f]/.test(c)) throw new Error('前置檢查要是一行指令（500 字以內）');
  return c;
}

function describe(t) {
  const s = t.schedule || {};
  const days = t.days && t.days.length ? (t.days.join() === '1,2,3,4,5' ? '平日' : '每週' + t.days.map((d) => WEEK[d]).join('、')) : '';
  if (s.kind === 'every') {
    const every = s.minutes % 60 === 0 ? (s.minutes === 60 ? '每小時' : '每 ' + s.minutes / 60 + ' 小時') : '每 ' + s.minutes + ' 分鐘';
    return (days ? days + ' ' : '') + every + (t.hours ? '（' + t.hours.from + '～' + t.hours.to + '）' : '');
  }
  if (s.kind === 'daily') return (days || '每天') + ' ' + s.time;
  if (s.kind === 'once') return '只做一次：' + fmt(s.at);
  return '?';
}

// 在 from 之後、符合星期與工作時間的最早時間
function allowed(t, ts) {
  const d = new Date(ts);
  if (t.days && t.days.length && !t.days.includes(d.getDay())) return false;
  if (t.hours) { const m = d.getHours() * 60 + d.getMinutes(); if (m < parseHM(t.hours.from) || m > parseHM(t.hours.to)) return false; }
  return true;
}
function windowStart(t, ts) {
  // 從 ts 往後找下一個允許的時段開頭（最多看 8 天）
  for (let i = 0; i < 9; i++) {
    const d = new Date(ts); d.setDate(d.getDate() + i);
    const start = t.hours ? parseHM(t.hours.from) : 0;
    d.setHours(Math.floor(start / 60), start % 60, 0, 0);
    const cand = Math.max(d.getTime(), i === 0 ? ts : 0);
    if (allowed(t, cand)) return cand;
  }
  return null;
}
function computeNext(t, from) {
  const s = t.schedule;
  if (s.kind === 'once') return t.done ? null : s.at;
  if (s.kind === 'daily') {
    const min = parseHM(s.time);
    for (let i = 0; i < 9; i++) {
      const d = new Date(from); d.setDate(d.getDate() + i); d.setHours(Math.floor(min / 60), min % 60, 0, 0);
      if (d.getTime() > from && allowed({ days: t.days }, d.getTime())) return d.getTime();
    }
    return null;
  }
  // 能整除一小時或一天的間隔（15、30、60 分鐘、2 小時…）對齊整點：每小時 → 10:00、11:00，而不是從建立的時間開始算
  let next;
  if (60 % s.minutes === 0 || (s.minutes % 60 === 0 && 1440 % s.minutes === 0)) {
    const mid = new Date(from); mid.setHours(0, 0, 0, 0);
    const minNow = Math.floor((from - mid.getTime()) / 60000);
    next = mid.getTime() + (Math.floor(minNow / s.minutes) + 1) * s.minutes * 60000;
  } else next = from + s.minutes * 60000;
  return allowed(t, next) ? next : windowStart(t, next);
}

// 「每小時」「每 30 分鐘」「每 2 小時」「每天 08:30」「平日 08:30」→ 排程（給【排程建議】用）
function parsePhrase(text) {
  const s = String(text || '').replace(/\s+/g, '');
  let m;
  const days = /^平日|工作日/.test(s) ? [1, 2, 3, 4, 5] : [];
  if ((m = s.match(/(\d{1,2})[:：](\d{2})/)) && /每天|每日|平日|工作日|每週/.test(s)) return { schedule: { kind: 'daily', time: pad(+m[1]) + ':' + m[2] }, days };
  if (/每小時|每一小時/.test(s)) return { schedule: { kind: 'every', minutes: 60 }, days };
  if ((m = s.match(/每(\d+)(小時|分鐘|分)/))) return { schedule: { kind: 'every', minutes: m[2] === '小時' ? +m[1] * 60 : +m[1] }, days };
  return null;
}

exports.describe = describe;
exports.computeNext = computeNext;
exports.parsePhrase = parsePhrase;

exports.create = function create(ctx) {
  const FILE = path.join(ctx.DATA_DIR, 'timers.json');
  const RUNS = path.join(ctx.DATA_DIR, 'timer-runs.jsonl');
  let S = { seq: 0, timers: [], proposals: [] };
  try { S = { ...S, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  const save = () => { try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(S, null, 2)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('排程存檔失敗：' + e.message); } };
  const byId = (id) => S.timers.find((t) => t.id === Number(id));
  const changed = () => { save(); if (ctx.onChange) ctx.onChange(); };
  let recent = [];
  try { recent = fs.readFileSync(RUNS, 'utf8').trim().split('\n').slice(-MAX_RUNS_LOG).map((l) => JSON.parse(l)); } catch {}
  function logRun(entry) {
    const e = { ts: Date.now(), ...entry };
    recent.push(e); if (recent.length > MAX_RUNS_LOG) recent.splice(0, recent.length - MAX_RUNS_LOG);
    try { fs.appendFileSync(RUNS, JSON.stringify(e) + '\n'); if (fs.statSync(RUNS).size > 1024 * 1024) fs.writeFileSync(RUNS, recent.map((x) => JSON.stringify(x)).join('\n') + '\n'); } catch {}
  }

  function clean(input, existing) {
    const name = String(input.name || '').trim().slice(0, 40);
    if (!name) throw new Error('請幫排程取個名字');
    const prompt = String(input.prompt || '').trim().slice(0, 3000);
    if (!prompt) throw new Error('請寫下要成員做什麼');
    const agent = ctx.agentById(String(input.agentId || ''));
    if (!agent) throw new Error('找不到這位成員');
    const sch = cleanSchedule(input);
    return {
      name, prompt, agentId: agent.id, ...sch,
      notify: ['changes', 'always', 'never'].includes(input.notify) ? input.notify : 'changes',
      ownSession: input.ownSession !== false,
      keepSession: !!input.keepSession,
      precheck: cleanPrecheck(input.precheck),
      allowPause: input.allowPause !== false,
      enabled: input.enabled !== false,
      ...(existing ? {} : { createdAt: Date.now(), createdBy: input.createdBy || 'user' }),
    };
  }
  function create(input) {
    if (S.timers.length >= MAX_TIMERS) throw new Error('排程最多 ' + MAX_TIMERS + ' 個');
    const t = { id: ++S.seq, ...clean(input), runs: 0, done: false };
    t.nextRun = t.enabled ? computeNext(t, Date.now() - 1) : null;
    if (t.schedule.kind === 'once' && t.schedule.at < Date.now() - 60000) throw new Error('執行時間已經過了');
    S.timers.push(t); changed();
    return t;
  }
  function update(id, input) {
    const t = byId(id);
    if (!t) throw new Error('找不到這個排程');
    const merged = { ...t, ...input, schedule: input.schedule || t.schedule, days: input.days || t.days, hours: 'hours' in input ? input.hours : t.hours };
    Object.assign(t, clean(merged, t));
    if (input.schedule) t.done = false;
    t.nextRun = t.enabled ? computeNext(t, Date.now() - 1) : null;
    changed();
    return t;
  }
  function remove(id) {
    const i = S.timers.findIndex((t) => t.id === Number(id));
    if (i < 0) throw new Error('找不到這個排程');
    S.timers.splice(i, 1); changed();
  }
  function setEnabled(id, on) {
    const t = byId(id);
    if (!t) throw new Error('找不到這個排程');
    if (on && t.schedule.kind === 'once' && t.done) throw new Error('這個只做一次的排程已經做過了');
    t.enabled = !!on;
    delete t.paused;
    t.nextRun = on ? computeNext(t, Date.now() - 1) : null;
    changed(); return t;
  }

  // 有新任務開始：恢復「被成員暫停」的排程（只限那個小組的成員；你自己暫停的不會被恢復）
  function resumePaused(agentIds, why) {
    const ids = new Set(agentIds);
    const back = [];
    for (const t of S.timers) {
      if (!t.paused || t.enabled || !ids.has(t.agentId)) continue;
      delete t.paused; t.enabled = true;
      t.nextRun = computeNext(t, Date.now());
      back.push(t);
      logRun({ timerId: t.id, name: t.name, agentId: t.agentId, status: 'resumed', summary: why || '有新任務' });
    }
    if (back.length) changed();
    return back;
  }

  // ---------- 觸發 ----------
  function header(t, why, checkOut) {
    const lines = ['【⏰ 排程：' + t.name + '】第 ' + (t.runs + 1) + ' 次' + (why ? '（' + why + '）' : '') +
      (t.last ? '｜上次 ' + fmt(t.last.at) + '：' + (t.last.summary ? short(t.last.summary, t.keepSession ? 120 : 400) : t.last.status) : '')];
    lines.push(t.prompt);
    if (checkOut) lines.push('', '【前置檢查 ' + t.precheck + ' 的輸出】', checkOut);
    if (t.notify !== 'never') {
      lines.push('', '回覆規則（系統會依這個決定要不要通知使用者）：',
        '- 沒有需要使用者注意的事：第一行寫「【無異常】」再簡短說明，系統不會打擾使用者。',
        '- 有需要使用者知道或處理的事：寫一行「【通知】一句話重點」，系統會把這句話傳到使用者的 Telegram。');
    }
    if (t.allowPause) lines.push('- 如果所有工作都已完成、短期內不會有新的事，這個排程繼續跑只是浪費額度：另起一行寫「【排程暫停】原因」，系統會暫停這個排程，有新任務開始時自動恢復。');
    return lines.join('\n');
  }
  // ---------- 前置檢查 ----------
  function runPrecheck(t, agent) {
    if (!ctx.runCheck) return Promise.resolve({ code: 0, out: 'X' });
    return ctx.runCheck(agent, t.precheck).catch((e) => ({ code: -1, out: '', error: e.message }));
  }

  // why：'補做' 之類的說明；manual：手動「立即執行」
  function fire(t, { why = '', manual = false, slot = null } = {}) {
    const agent = ctx.agentById(t.agentId);
    const key = slot != null ? String(slot) : 'm' + Date.now();
    if (!agent) { t.last = { at: Date.now(), status: 'failed', summary: '找不到成員（可能被刪除了）', key }; logRun({ timerId: t.id, name: t.name, status: 'failed', summary: t.last.summary }); return 'failed'; }
    if (t.active && Date.now() - t.active.at < 6 * 3600000) {
      logRun({ timerId: t.id, name: t.name, agentId: agent.id, status: 'skipped', summary: '上一次還沒做完，這次略過' });
      t.last = { ...(t.last || {}), skippedAt: Date.now() };
      return 'skipped';
    }
    t.active = { at: Date.now(), key, manual };
    t.firedKey = key;
    const wake = (checkOut) => {
      const r = ctx.dispatch(agent, header(t, why, checkOut), { via: 'timer', timerId: t.id, sessionTag: t.ownSession ? 'x' + t.id : null, fresh: !!t.ownSession && !t.keepSession, system: false });
      logRun({ timerId: t.id, name: t.name, agentId: agent.id, status: r === 'queued' ? 'queued' : 'started', manual, why });
      return r;
    };
    // 手動執行一定叫醒成員；自動執行有前置檢查就先檢查
    if (!t.precheck || manual) return wake('');
    t.active.checking = true;
    runPrecheck(t, agent).then((res) => {
      const out = String(res.out || '').trim();
      if (res.code === 0 && !out) {
        delete t.active;
        t.checks = (t.checks || 0) + 1;
        t.last = { ...(t.last || {}), checkedAt: Date.now(), idle: true };
        logRun({ timerId: t.id, name: t.name, agentId: agent.id, status: 'idle', summary: '前置檢查沒有發現待辦，沒有叫醒成員' });
        changed();
        return;
      }
      if (t.active) delete t.active.checking;
      const note = res.code !== 0 ? '（前置檢查結束碼 ' + res.code + (res.timedOut ? '，逾時' : '') + (res.error ? '：' + res.error : '') + '）\n' : '';
      wake((note + out).slice(0, 4000) || '（沒有輸出）');
      changed();
    });
    return 'checking';
  }
  function runNow(id) {
    const t = byId(id);
    if (!t) throw new Error('找不到這個排程');
    const r = fire(t, { manual: true, why: '手動執行' });
    changed();
    return r;
  }

  // 每 20 秒看一次：到期的就觸發，並算出下一次
  function tick(now = Date.now()) {
    let dirty = false;
    for (const t of S.timers) {
      if (!t.enabled || !t.nextRun || t.nextRun > now) continue;
      const slot = t.nextRun;
      if (t.firedKey === String(slot)) { t.nextRun = computeNext(t, now); dirty = true; continue; } // 這一次已經觸發過（例如重新啟動前）
      const late = now - slot;
      fire(t, { slot, why: late > 5 * 60000 ? '補做：原本 ' + fmt(slot) + ' 該執行，當時電腦或程式沒開' : '' });
      if (t.schedule.kind === 'once') { t.done = true; t.enabled = false; t.nextRun = null; }
      else t.nextRun = computeNext(t, now); // 錯過好幾次也只補做一次
      dirty = true;
    }
    if (dirty) changed();
  }

  // 成員做完：記下結果，決定要不要通知
  function onDone({ timerId, agent, segments, stopped }) {
    const t = byId(timerId);
    if (!t) return;
    const text = (segments || []).filter((s) => s.type === 'text').map((s) => s.text).join('\n').trim();
    const err = (segments || []).filter((s) => s.type === 'error').map((s) => s.text).join(' / ');
    const quiet = /【無異常】/.test(text);
    const pause = t.allowPause && (text.match(/【排程暫停】\s*[:：]?\s*(.*)/) || null);
    const tag = (text.match(/【通知】\s*[:：]?\s*(.+)/) || [])[1];
    let status, summary;
    if (stopped) { status = 'stopped'; summary = '被手動停止'; }
    else if (err && !text) { status = 'failed'; summary = short(err, 300); }
    else if (quiet) { status = 'ok'; summary = short(text.replace(/【無異常】/, ''), 200) || '無異常'; }
    else { status = 'alert'; summary = short(tag || text, 300) || '（沒有回覆內容）'; }
    // 要不要通知：失敗一定通知；有異常依設定；跟上次通知的內容一樣就不重複發
    let notify = false, why = '';
    if (t.notify === 'never') why = '設定為不通知';
    else if (status === 'failed') notify = true;
    else if (status === 'stopped') why = '手動停止';
    else if (t.notify === 'always') notify = true;
    else if (status === 'ok') why = '無異常';
    else notify = true;
    if (notify && t.lastNotified && t.lastNotified.summary === summary && Date.now() - t.lastNotified.at < DAY) { notify = false; why = '和上次通知的內容一樣，不重複發'; }
    t.runs = (t.runs || 0) + 1;
    t.last = { at: Date.now(), status, summary, notified: notify, quietReason: why };
    delete t.active;
    t.last.idle = false;
    if (pause && status !== 'failed') {
      t.enabled = false; t.nextRun = null;
      t.paused = { by: agent ? agent.id : null, reason: short(pause[1] || '所有工作都完成了', 200), at: Date.now() };
      t.last.paused = true;
      logRun({ timerId: t.id, name: t.name, agentId: agent && agent.id, status: 'paused', summary: t.paused.reason });
      if (ctx.notify && t.notify !== 'never') ctx.notify({ timer: t, agent, status: 'paused', summary: t.paused.reason });
    }
    if (notify) {
      t.lastNotified = { at: Date.now(), summary };
      if (ctx.notify) ctx.notify({ timer: t, agent, status, summary });
    }
    logRun({ timerId: t.id, name: t.name, agentId: agent && agent.id, status, summary, notified: notify, quietReason: why });
    changed();
  }

  // 重新啟動後：上次「進行中」的不會回來了（排隊的訊息在記憶體裡），標成中斷，等下一次
  for (const t of S.timers) {
    if (t.active) { t.last = { at: Date.now(), status: 'interrupted', summary: '程式重新啟動，這次中斷了' }; delete t.active; }
    if (t.enabled && !t.nextRun && t.schedule.kind !== 'once') t.nextRun = computeNext(t, Date.now());
  }
  save();

  // ---------- 成員提出的排程建議（要使用者核准）----------
  // 【排程建議】每天 08:30｜整理昨天的帳並寫進表單
  function propose(agent, line, taskId) {
    // 【排程建議】每小時｜要做的事｜先檢查：node pm/check.mjs
    const parts = String(line).split(/[｜|]/).map((x) => x.trim());
    if (parts.length < 2) return null;
    const m = [line, parts[0], parts.slice(1).filter((x) => !/^先檢查\s*[:：]/.test(x)).join('｜')];
    const pre = (parts.find((x) => /^先檢查\s*[:：]/.test(x)) || '').replace(/^先檢查\s*[:：]\s*/, '');
    const sch = parsePhrase(m[1]);
    if (!sch || !m[2]) return null;
    let precheck = '';
    try { precheck = cleanPrecheck(pre); } catch { return null; }
    const prompt = m[2].trim().slice(0, 1000);
    const norm = (s) => s.replace(/\s+/g, '');
    if (S.proposals.some((p) => norm(p.prompt) === norm(prompt) && p.agentId === agent.id)) return null;
    const p = { id: ++S.seq, agentId: agent.id, name: short(prompt, 20), prompt, ...sch, notify: 'changes', ownSession: true, allowPause: true, precheck, taskId: taskId || null, createdAt: Date.now(), phrase: m[1].trim() };
    S.proposals.push(p); changed();
    if (ctx.onProposal) ctx.onProposal(p, agent);
    return p;
  }
  function collect(agent, text, taskId) {
    for (const raw of String(text || '').split('\n')) {
      const m = raw.replace(/^[\s>*\-•]+/, '').replace(/\*\*/g, '').match(/^【排程建議】\s*[:：]?\s*(.+)$/);
      if (m) propose(agent, m[1].trim(), taskId);
    }
  }
  function acceptProposal(id, edits = {}) {
    const i = S.proposals.findIndex((p) => p.id === Number(id));
    if (i < 0) throw new Error('找不到這個排程建議');
    const p = S.proposals[i];
    const t = create({ ...p, ...edits, createdBy: p.agentId });
    S.proposals.splice(S.proposals.indexOf(p), 1); changed();
    return t;
  }
  function dismissProposal(id) {
    const i = S.proposals.findIndex((p) => p.id === Number(id));
    if (i < 0) throw new Error('找不到這個排程建議');
    S.proposals.splice(i, 1); changed();
  }

  const view = (t) => ({ ...t, desc: describe(t), agentName: (ctx.agentById(t.agentId) || {}).name || t.agentId });
  const snapshot = () => ({ timers: S.timers.map(view), proposals: S.proposals.map(view), runs: recent.slice(-80).reverse(), minEvery: MIN_EVERY });
  const promptHint = () => '【排程】需要定期或稍後再做的事（例如每小時檢查、每天早上整理），不要自己建立 Windows 排程或背景程式；在回覆中另起一行寫「【排程建議】每天 08:30｜要做的事」（也可以寫「每小時」「每 30 分鐘」「平日 08:30」），使用者核准後系統會準時叫你。' +
    '定期檢查最好附一個不花 AI 額度的檢查指令：「【排程建議】每小時｜要做的事｜先檢查：node 檢查腳本.mjs」，腳本在沒有待辦時不要輸出任何東西，系統就不會叫醒你。';

  let timer = null;
  const start = () => { if (!timer) { timer = setInterval(() => { try { tick(); } catch (e) { console.error('排程錯誤：' + e.message); } }, Number(process.env.AGENTCHAT_TIMER_TICK_MS) || 20000); timer.unref(); setTimeout(() => tick(), 3000).unref(); } };
  const stop = () => { clearInterval(timer); timer = null; };

  return { create, update, remove, setEnabled, runNow, tick, onDone, collect, propose, acceptProposal, dismissProposal, resumePaused,
    snapshot, byId, list: () => S.timers, describe, promptHint, start, stop };
};
