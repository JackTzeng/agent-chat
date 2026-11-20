'use strict';
// 📮 通知補送（outbox）
//
// 先照原本的方式直接送；送不出去、而且是「暫時性」的失敗（網路斷、對方伺服器 5xx、送太快 429）才放進這裡，
// 存在 state.outbox（程式重新啟動也不會丟），背景依退避時間重送。
//  - 同一個頻道＋對象，前一則沒送出去，後面的就先等，不會亂序。
//  - 同一個內容在排隊中只會有一筆（去重），不會因為兩個地方都排了就送兩次。
//  - 太舊的（預設 12 小時）就放棄、標成失敗：過時的提醒送到也沒意義。
//  - 永久性的錯誤（token 錯、被封鎖、本月額度用完）不會排進來，由呼叫的地方照原本方式回報。
//
// 頻道（channel）由各模組註冊送出的函式：register('line', fn)、register('tg:main', fn)、register('tg:<成員 id>', fn)。
// fn(target, payload) 回傳 { ok: true } 或 { ok: false, retry: true/false, error }。頻道還沒註冊（例如 bot 還沒啟動）就先等。

const crypto = require('crypto');

const BACKOFF_MS = [30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3, 60 * 60e3];
const MAX_PENDING = 200, MAX_HISTORY = 50;

const keyOf = (channel, target, payload) => crypto.createHash('sha1').update(channel + '\n' + target + '\n' + JSON.stringify(payload)).digest('hex').slice(0, 16);
const preview = (payload) => {
  const p = payload || {};
  const t = p.text != null ? p.text : Array.isArray(p.texts) ? p.texts.join(' ') : '';
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 80);
};

function create(ctx) {
  // ctx: { state, saveState, broadcast, now?, maxAgeMs?, tickMs? }
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const maxAge = () => Number(ctx.maxAgeMs) || Number(process.env.OUTBOX_MAX_AGE_MS) || 12 * 3600e3;
  const backoff = (n) => (process.env.OUTBOX_BACKOFF_MS ? Number(process.env.OUTBOX_BACKOFF_MS) : BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)]);
  const S = () => {
    const s = (ctx.state.outbox = ctx.state.outbox || {});
    s.seq = s.seq || 0; s.items = Array.isArray(s.items) ? s.items : []; s.history = Array.isArray(s.history) ? s.history : [];
    return s;
  };
  const senders = new Map();
  const changed = () => { try { ctx.saveState(); } catch {} if (ctx.broadcast) ctx.broadcast({ agentId: '*', kind: 'outbox' }); };
  let timer = null, busy = false;

  function register(channel, fn) { senders.set(channel, fn); schedule(50); }
  function unregister(channel, fn) { if (!fn || senders.get(channel) === fn) senders.delete(channel); }

  function finish(s, item, status, error) {
    s.items = s.items.filter((x) => x !== item);
    s.history.unshift({ id: item.id, channel: item.channel, label: item.label, preview: preview(item.payload), created: item.created, tries: item.tries, status, error: error || '', at: now() });
    s.history = s.history.slice(0, MAX_HISTORY);
  }

  // 第一次直接送失敗後呼叫；回傳排進去的那筆（重複的回傳原本那筆）
  function add({ channel, target, payload, label = '', error = '' }) {
    if (!channel || target == null) return null;
    const s = S(), key = keyOf(channel, String(target), payload);
    const dup = s.items.find((x) => x.key === key);
    if (dup) return dup;
    const t = now();
    const item = { id: ++s.seq, key, channel, target: String(target), payload, label: String(label || '').slice(0, 40), created: t, tries: 1, nextAt: t + backoff(1), lastError: String(error || '').slice(0, 200) };
    s.items.push(item);
    while (s.items.length > MAX_PENDING) finish(s, s.items[0], 'failed', '排隊太多，最舊的放棄');
    console.log('📮 送出失敗，稍後重送（#' + item.id + ' ' + channel + '）：' + item.lastError);
    changed(); schedule();
    return item;
  }

  async function tick() {
    if (busy) return; busy = true;
    try {
      const s = S(); let dirty = false;
      const blocked = new Set(); // 同一個頻道＋對象，前面還卡著，後面先不送
      for (const item of s.items.slice().sort((a, b) => a.id - b.id)) {
        const lane = item.channel + '|' + item.target;
        if (now() - item.created > maxAge()) { finish(s, item, 'failed', '超過 ' + Math.round(maxAge() / 3600e3) + ' 小時還送不出去，已放棄（最後的錯誤：' + (item.lastError || '不明') + '）'); dirty = true; continue; }
        if (blocked.has(lane)) continue;
        const fn = senders.get(item.channel);
        if (!fn || item.nextAt > now()) { blocked.add(lane); continue; }
        let r;
        try { r = (await fn(item.target, item.payload)) || { ok: false, retry: true, error: '沒有回應' }; }
        catch (e) { r = { ok: false, retry: true, error: e.message }; }
        dirty = true;
        if (!s.items.includes(item)) continue; // 送的期間被人工移除了
        if (r.ok) { finish(s, item, 'sent'); continue; }
        item.tries++; item.lastError = String(r.error || '失敗').slice(0, 200);
        if (r.retry === false) { finish(s, item, 'failed', item.lastError); continue; }
        item.nextAt = now() + backoff(item.tries);
        blocked.add(lane);
      }
      if (dirty) changed();
    } finally { busy = false; schedule(); }
  }

  // 下一次檢查：最早要送的那筆（最多等 tickMs，讓過期的也能處理）
  function schedule(ms) {
    if (!timer && ms == null && !S().items.length) return;
    if (timer) clearTimeout(timer);
    const s = S();
    const soonest = s.items.length ? Math.min(...s.items.map((x) => x.nextAt)) - now() : Infinity;
    const wait = ms != null ? ms : Math.max(200, Math.min(soonest, Number(ctx.tickMs) || 60e3));
    timer = setTimeout(() => { timer = null; tick(); }, wait);
    if (timer.unref) timer.unref();
  }

  function snapshot() {
    const s = S();
    return {
      pending: s.items.map((x) => ({ id: x.id, channel: x.channel, label: x.label, preview: preview(x.payload), created: x.created, tries: x.tries, nextAt: x.nextAt, lastError: x.lastError, waiting: !senders.has(x.channel) })),
      history: s.history.slice(0, 20),
    };
  }
  function retry(id) {
    const it = S().items.find((x) => x.id === Number(id));
    if (!it) throw new Error('找不到 #' + id + '（可能已經送出或放棄了）');
    it.nextAt = now(); changed(); schedule(10); return true;
  }
  function drop(id) {
    const s = S(), it = s.items.find((x) => x.id === Number(id));
    if (!it) throw new Error('找不到 #' + id);
    finish(s, it, 'dropped', '手動移除'); changed(); return true;
  }
  function start() { schedule(1500); }
  function stop() { if (timer) clearTimeout(timer); timer = null; }

  return { register, unregister, add, tick, snapshot, retry, drop, start, stop };
}

// HTTP 狀態碼 → 要不要重送（0＝連不上、逾時）
const retryableStatus = (status) => !status || status === 429 || status >= 500;

module.exports = { create, retryableStatus, keyOf };
