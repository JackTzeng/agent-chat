'use strict';
// 💚 LINE bot（Messaging API）：把一位成員（例如「助理」）接到 LINE，讓你在手機上用 LINE 跟它對話、收提醒。
//
// 安全設計：
// - LINE 只能把訊息送到「公開的網址」。Agent Chat 的網頁（預設 3939）絕對不經過公開通道：
//   這裡另外開一個只收 POST /line/webhook 的小伺服器（預設 3941、只聽 127.0.0.1），公開通道只接到這個連接埠。
// - 每個請求都先驗證 X-Line-Signature（用 Channel secret 做 HMAC-SHA256），不對就直接 401，不解析內容。
// - 只有「配對過」的 LINE 帳號才會轉給成員：在網頁產生 6 位數配對碼 → 在 LINE 傳給 bot。其他人只會收到「尚未配對」。
// - 一般的「你傳、它回」用 reply（不算 LINE 的訊息則數）；回覆太久（reply token 過期）或主動提醒才用 push（算則數）。
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const apiBase = () => (process.env.LINE_API_BASE || 'https://api.line.me').replace(/\/$/, '');
const REPLY_TOKEN_MS = () => (process.env.LINE_REPLY_TOKEN_MS != null ? Number(process.env.LINE_REPLY_TOKEN_MS) : 50000);
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// ---------- 小工具（有測試）----------
function verifySignature(raw, secret, header) {
  if (!secret || !header) return false;
  const mac = crypto.createHmac('sha256', secret).update(raw).digest();
  let got; try { got = Buffer.from(String(header), 'base64'); } catch { return false; }
  return got.length === mac.length && crypto.timingSafeEqual(got, mac);
}
// LINE 不會顯示 Markdown：把常見的標記轉成看得懂的純文字
function plain(s) {
  return String(s || '')
    .replace(/```[\w-]*\n?/g, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '■ ').replace(/^\s*[-*]\s+/gm, '・').replace(/\n{3,}/g, '\n\n').trim();
}
// 一則文字最多 5000 字、一次最多 5 則
function chunk(text, size = 4800, max = 5) {
  text = String(text || '').trim();
  const out = [];
  while (text && out.length < max) {
    if (text.length <= size) { out.push(text); text = ''; break; }
    let cut = text.lastIndexOf('\n', size); if (cut < size * 0.5) cut = size;
    out.push(text.slice(0, cut).trim()); text = text.slice(cut).trim();
  }
  if (text) out[out.length - 1] = out[out.length - 1].slice(0, size - 20) + '\n…（太長，後面省略了）';
  return out;
}
function replyText(segments) {
  const segs = segments || [];
  // 成員寫的【排程建議】那行是給系統看的；LINE 上改成「等你核准」的提示（見 onDone），所以這裡拿掉。提出失敗的原因要讓你看到
  const text = segs.filter((s) => s.type === 'text').map((s) => s.text).join('\n\n').split('\n').filter((l) => !/^[\s>*\-•]*(\*\*)?【排程建議】/.test(l)).join('\n').trim();
  const notes = segs.filter((s) => s.type === 'tool' && /^⏰ 排程建議沒有送出/.test(s.text)).map((s) => s.text);
  const errs = segs.filter((s) => s.type === 'error').map((s) => '⚠️ ' + s.text);
  return [plain(text), ...notes, ...errs].filter(Boolean).join('\n\n') || '（沒有回覆內容）';
}
const SECRET_RE = /^[0-9a-f]{32}$/i;
const TOKEN_RE = /^[A-Za-z0-9+/=_.\-]{80,}$/;
// 公開網址：只留 https://主機（去掉結尾的 / 和 /line/webhook）
function cleanPublicUrl(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '').replace(/\/line\/webhook$/i, '');
  if (!s) return '';
  let u; try { u = new URL(s); } catch { throw new Error('公開網址格式不對，應該像 https://xxxx.trycloudflare.com'); }
  if (u.protocol !== 'https:' && !(process.env.LINE_ALLOW_HTTP === '1' && u.protocol === 'http:')) throw new Error('公開網址要是 https:// 開頭（LINE 只接受 https）');
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('公開網址只要網域，不要帶路徑或帳號密碼');
  return u.origin;
}

function create(ctx) {
  // ctx: { config, state, saveState, saveConfig, hooks, broadcast, agentById, agents(), dispatch, stopRun, resetAgent, timers, proctree, ROOT }
  const cfg = () => (ctx.config.line = ctx.config.line || {});
  const S = () => (ctx.state.line = ctx.state.line || {});
  const port = () => Number(process.env.LINE_PORT) || 3941;
  const configured = () => !!(cfg().channelSecret && cfg().channelAccessToken);
  const allowed = () => (cfg().allowedUserIds || []).map(String);
  const changed = () => ctx.broadcast({ agentId: '*', kind: 'line' });
  const note = (msg) => { S().lastError = short(msg, 200); S().lastErrorAt = Date.now(); console.log('💚 LINE：' + msg); changed(); };
  const month = () => new Date().toISOString().slice(0, 7);
  let server = null, listening = false, pairing = null;
  const badPairing = new Map();
  const seen = new Set();

  // ---------- LINE API ----------
  function request(method, urlPath, body, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let u; try { u = new URL(apiBase() + urlPath); } catch (e) { return resolve({ status: 0, error: e.message }); }
      const lib = u.protocol === 'http:' ? http : https;
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const req = lib.request({ method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, timeout: timeoutMs,
        headers: { Authorization: 'Bearer ' + cfg().channelAccessToken, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
        const bufs = []; res.on('data', (c) => bufs.push(c));
        res.on('end', () => { const t = Buffer.concat(bufs).toString('utf8'); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} resolve({ status: res.statusCode, json: j, text: t.slice(0, 300) }); });
      });
      req.on('timeout', () => req.destroy(new Error('連線逾時')));
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      if (data) req.write(data);
      req.end();
    });
  }
  // 把 LINE 回的錯誤翻成看得懂的話
  function explain(r) {
    if (r.status === 0) return '連不上 LINE（' + (r.error || '網路問題') + '）。請確認這台電腦可以連到 api.line.me';
    if (r.status === 401) return 'Channel access token 不對或已失效：到 LINE Developers → 你的 channel → Messaging API 分頁，最下面重新 Issue 一個，貼回來';
    if (r.status === 403) return 'LINE 拒絕了這個操作（403）：請確認 channel 的權限，或這個功能需要升級方案';
    if (r.status === 429) return 'LINE 回 429：本月訊息額度用完了，或送得太頻繁';
    const m = r.json && (r.json.message || (r.json.details && r.json.details[0] && r.json.details[0].message));
    return 'LINE 回 ' + r.status + (m ? '：' + m : '');
  }
  async function reply(replyToken, texts) {
    return request('POST', '/v2/bot/message/reply', { replyToken, messages: texts.map((text) => ({ type: 'text', text })) });
  }
  async function push(to, texts) {
    const s = S();
    if (s.pushBlocked === month()) return { ok: false, error: '本月的推播額度用完了（LINE 回過 429），下個月才會恢復；用 LINE 回覆你的訊息不受影響' };
    const r = await request('POST', '/v2/bot/message/push', { to, messages: texts.map((text) => ({ type: 'text', text })) });
    if (r.status === 200) {
      if (s.pushedMonth !== month()) { s.pushedMonth = month(); s.pushed = 0; }
      s.pushed = (s.pushed || 0) + texts.length;
      ctx.saveState(); return { ok: true };
    }
    if (r.status === 429) { s.pushBlocked = month(); ctx.saveState(); }
    return { ok: false, error: explain(r) };
  }
  // 先試 reply（免費、不算則數）；token 過期、已用過或沒有，就用 push
  async function send(userId, text, tok) {
    const parts = chunk(text);
    if (!parts.length) return { ok: true };
    if (tok && tok.replyToken && Date.now() - (tok.at || 0) < REPLY_TOKEN_MS()) {
      const r = await reply(tok.replyToken, parts);
      if (r.status === 200) return { ok: true, via: 'reply' };
    }
    const p = await push(userId, parts);
    if (!p.ok) note('傳給 LINE 失敗：' + p.error);
    return { ...p, via: 'push' };
  }
  const loading = (userId) => request('POST', '/v2/bot/chat/loading/start', { chatId: userId, loadingSeconds: 60 }).catch(() => {});

  // ---------- 訊息處理 ----------
  const targetAgent = () => ctx.agentById(cfg().agentId);
  const HELP = '💚 我是 {name}。直接傳文字給我就好。\n指令：\n/new　開新對話（忘掉前面的內容）\n/stop　停止我正在做的事\n同意 3　核准我提出的提醒／排程 #3\n不要 3　不要那個提醒';
  const helpText = () => HELP.replace('{name}', (targetAgent() || {}).name || '助理');
  const announced = new Set(); // 已經在 LINE 告知過「待核准」的排程建議

  function pairingState() { return pairing && pairing.expires > Date.now() ? { code: pairing.code, expires: pairing.expires } : null; }
  function newPairCode() { pairing = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + 10 * 60 * 1000 }; changed(); return pairingState(); }

  async function handleEvent(ev) {
    const src = ev.source || {};
    if (src.type !== 'user' || !src.userId) return; // 群組、聊天室：不處理
    const uid = String(src.userId), rt = ev.replyToken, tok = { replyToken: rt, at: Date.now() };
    const say = (t) => send(uid, t, tok);
    const isPaired = allowed().includes(uid);
    S().lastEventAt = Date.now();
    if (ev.type === 'follow') {
      return say(isPaired ? helpText() : '👋 你好！我是 Agent Chat 的 LINE bot。\n要開始使用，請在電腦上打開 Agent Chat →「💚 LINE」→ 按「產生配對碼」，把 6 位數字傳給我。');
    }
    if (ev.type !== 'message') return;
    const m = ev.message || {};
    const text = String(m.type === 'text' ? m.text : '').trim();
    if (!isPaired) {
      // 配對：6 位數配對碼；連續錯 5 次就先鎖住
      const bad = badPairing.get(uid);
      if (bad && bad.count >= 5 && bad.until > Date.now()) return;
      if (m.type === 'text' && pairing && pairing.expires > Date.now() && text === pairing.code) {
        badPairing.delete(uid);
        cfg().allowedUserIds = [...new Set([...(cfg().allowedUserIds || []).map(String), uid])];
        pairing = null; ctx.saveConfig(); changed();
        console.log('💚 LINE：已配對一位使用者');
        return say('✅ 配對成功！\n\n' + helpText());
      }
      if (m.type === 'text' && /^\d{6}$/.test(text)) badPairing.set(uid, { count: (bad && bad.until > Date.now() ? bad.count : 0) + 1, until: Date.now() + 10 * 60 * 1000 });
      return say('🔒 還沒配對。請在電腦上打開 Agent Chat →「💚 LINE」→ 按「產生配對碼」，把 6 位數字傳給我。');
    }
    const agent = targetAgent();
    if (!agent) return say('⚠️ 這個 LINE bot 還沒有指定要連到哪位成員，請到 Agent Chat 的「💚 LINE」設定。');
    if (m.type !== 'text') return say('目前只收文字訊息（照片、貼圖、語音我還看不懂）。');
    if (!text) return;
    // 指令
    let mm;
    if (/^\/(help|start)$/i.test(text) || text === '說明') return say(helpText());
    if (/^\/new$/i.test(text)) return say(ctx.resetAgent(agent.id) ? '🆕 已開新對話' : '我正在工作，請先傳 /stop');
    if (/^\/stop$/i.test(text)) { ctx.stopRun(agent.id); return say('⏹ 已停止'); }
    if ((mm = /^(同意|核准|ok)\s*#?(\d+)$/i.exec(text))) {
      try { const t = ctx.timers.acceptProposal(mm[2]); announced.delete(Number(mm[2])); return say('✅ 已排程：' + t.name + '（' + ctx.timers.describe(t) + '）'); }
      catch (e) { return say('⚠️ ' + e.message); }
    }
    if ((mm = /^(不要|拒絕|取消|no)\s*#?(\d+)$/i.exec(text))) {
      try { ctx.timers.dismissProposal(mm[2]); announced.delete(Number(mm[2])); return say('🚫 好的，不排了'); }
      catch (e) { return say('⚠️ ' + e.message); }
    }
    loading(uid);
    ctx.dispatch(agent, text, { via: 'line', line: { userId: uid, replyToken: rt, at: tok.at } });
  }

  async function handleBody(raw) {
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return; }
    for (const ev of Array.isArray(body.events) ? body.events : []) {
      const id = ev.webhookEventId;
      if (id) { if (seen.has(id)) continue; seen.add(id); if (seen.size > 500) seen.delete(seen.values().next().value); }
      try { await handleEvent(ev); } catch (e) { note('處理事件失敗：' + e.message); }
    }
  }

  // ---------- Webhook 伺服器（獨立連接埠）----------
  function startServer() {
    if (server || !configured()) return;
    server = http.createServer((req, res) => {
      const u = (req.url || '').split('?')[0];
      if (req.method === 'GET' && u === '/line/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      if (req.method !== 'POST' || u !== '/line/webhook') { res.writeHead(404); return res.end(); }
      const bufs = []; let n = 0, tooBig = false;
      req.on('data', (c) => { n += c.length; if (n > 1024 * 1024) tooBig = true; else bufs.push(c); });
      req.on('end', () => {
        if (tooBig) { res.writeHead(413); return res.end(); }
        const raw = Buffer.concat(bufs);
        if (!verifySignature(raw, cfg().channelSecret, req.headers['x-line-signature'])) { res.writeHead(401); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); // 先回 200，內容慢慢處理
        handleBody(raw).catch((e) => note('處理失敗：' + e.message));
      });
      req.on('error', () => {});
    });
    server.on('error', (e) => { listening = false; server = null; note(e.code === 'EADDRINUSE' ? '連接埠 ' + port() + ' 被占用了（換一個：local-settings.txt 加 LINE_PORT=3942）' : 'webhook 伺服器錯誤：' + e.message); });
    server.listen(port(), '127.0.0.1', () => { listening = true; console.log('💚 LINE：webhook 在 127.0.0.1:' + port() + '/line/webhook 等待（要經過公開通道才收得到）'); changed(); });
  }
  function stopServer() { if (server) { try { server.close(); } catch {} server = null; listening = false; } }

  // ---------- 成員回覆 → LINE ----------
  const onDone = (e) => {
    if (e.via !== 'line' || !e.line || !e.agent) return;
    (async () => {
      let text = e.shift ? '🔄 對話太長，已經寫好交班筆記，下一則起換成全新的對話接手' : replyText(e.segments);
      // 這位成員剛提出、還沒核准的排程（例如提醒）：直接在 LINE 問你要不要
      const props = ctx.timers.snapshot().proposals.filter((p) => p.agentId === e.agent.id && !announced.has(p.id));
      for (const p of props) announced.add(p.id);
      if (props.length) text += '\n\n⏰ 等你核准：\n' + props.map((p) => '#' + p.id + ' ' + p.desc + '｜' + short(p.prompt, 60)).join('\n') + '\n回「同意 編號」就會排進去（例如：同意 ' + props[0].id + '），回「不要 編號」就不排。';
      await send(e.line.userId, text, e.line);
    })().catch((err) => note('回覆失敗：' + err.message));
  };
  // 助理的排程提醒時間到：只推給配對過的帳號（push，算則數）
  const onTimerAlert = ({ timer, agent, status, summary }) => {
    if (!configured() || !agent || agent.id !== cfg().agentId || status === 'paused') return;
    const icon = status === 'failed' ? '❌' : '⏰';
    const text = icon + ' ' + timer.name + '\n' + plain(summary || '');
    (async () => { for (const uid of allowed()) await send(uid, text, null); })().catch((err) => note('傳提醒失敗：' + err.message));
  };

  // ---------- 設定、檢查 ----------
  async function check() {
    if (!configured()) throw new Error('還沒設定 Channel secret 與 Channel access token');
    const out = { ok: false, steps: [] };
    const info = await request('GET', '/v2/bot/info');
    if (info.status !== 200) { out.steps.push({ ok: false, name: 'Channel access token', msg: explain(info) }); return out; }
    S().bot = { name: short(info.json.displayName, 40), basicId: short(info.json.basicId, 40) };
    out.steps.push({ ok: true, name: 'Channel access token', msg: '正常，bot 名稱：' + S().bot.name + (S().bot.basicId ? '（' + S().bot.basicId + '）' : '') });
    const wh = await request('GET', '/v2/bot/channel/webhook/endpoint');
    if (wh.status === 200) {
      S().webhook = { ...(S().webhook || {}), endpoint: wh.json.endpoint || '', active: !!wh.json.active, at: Date.now() };
      out.steps.push({ ok: !!(wh.json.endpoint && wh.json.active), name: 'Webhook 設定', msg: wh.json.endpoint ? wh.json.endpoint + (wh.json.active ? '（已啟用）' : '（沒有啟用：到 LINE Developers → Messaging API → 打開「Use webhook」）') : '還沒設定網址（按「設定 Webhook 並測試」）' });
    }
    const q = await request('GET', '/v2/bot/message/quota'), c = await request('GET', '/v2/bot/message/quota/consumption');
    if (q.status === 200 && c.status === 200) {
      S().quota = { type: q.json.type, value: q.json.value != null ? q.json.value : null, used: c.json.totalUsage, at: Date.now() };
      out.steps.push({ ok: true, name: '本月主動推播', msg: '已用 ' + c.json.totalUsage + (q.json.type === 'limited' ? ' / ' + q.json.value + ' 則（你傳我回的一般對話不算）' : ' 則（沒有上限）') });
    }
    out.ok = out.steps.every((s) => s.ok);
    ctx.saveState(); changed();
    return out;
  }
  // 設定 Webhook 網址並請 LINE 測試
  async function setupWebhook(publicUrl) {
    if (!configured()) throw new Error('還沒設定 Channel secret 與 Channel access token');
    const base = cleanPublicUrl(publicUrl || cfg().publicUrl);
    if (!base) throw new Error('請先填公開網址，或按「一鍵開啟公開通道」');
    startServer();
    const url = base + '/line/webhook';
    const put = await request('PUT', '/v2/bot/channel/webhook/endpoint', { endpoint: url });
    if (put.status !== 200) throw new Error('設定 Webhook 失敗：' + explain(put));
    cfg().publicUrl = base; ctx.saveConfig();
    let test = null;
    for (let i = 0; i < 3; i++) { // 剛開的通道網址可能還沒生效，多試幾次
      const r = await request('POST', '/v2/bot/channel/webhook/test', { endpoint: url });
      test = r.status === 200 && r.json ? r.json : { success: false, reason: explain(r) };
      if (test.success) break;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    const got = await request('GET', '/v2/bot/channel/webhook/endpoint'); // 「Use webhook」開關 API 改不了，讀回來看有沒有打開
    S().webhook = { endpoint: url, active: got.status === 200 ? !!(got.json && got.json.active) : null, at: Date.now(), tested: !!test.success, reason: test.success ? '' : short(test.reason || test.detail || '測試沒有通過', 200) };
    ctx.saveState(); changed();
    return { url, ok: !!test.success, reason: S().webhook.reason };
  }

  // ---------- 公開通道：cloudflared quick tunnel ----------
  let tun = { proc: null, state: 'off', url: '', error: '' }, tunWant = false, tunRestarts = 0;
  const tunnelBin = () => {
    if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
    for (const n of ['cloudflared.exe', 'cloudflared']) { const f = path.join(ctx.ROOT, n); try { if (fs.existsSync(f)) return f; } catch {} }
    return 'cloudflared';
  };
  function startTunnel() {
    if (tun.proc || !configured()) return;
    tunWant = true; tun = { proc: null, state: 'starting', url: '', error: '' }; changed();
    startServer();
    let proc;
    try { proc = spawn(tunnelBin(), ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + port()], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...ctx.proctree.groupOpts() }); ctx.proctree.track(proc); }
    catch (e) { tun = { proc: null, state: 'error', url: '', error: e.message }; changed(); return; }
    tun.proc = proc;
    const onData = (c) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(c));
      if (m && tun.url !== m[0]) { tun.url = m[0]; tun.state = 'on'; tunRestarts = 0; changed(); setupWebhook(m[0]).catch((e) => note(e.message)); }
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('error', (e) => { tun.proc = null; tunWant = false; tun.state = e.code === 'ENOENT' ? 'missing' : 'error'; tun.error = e.code === 'ENOENT' ? '找不到 cloudflared。請下載 cloudflared.exe 放進 Agent Chat 資料夾（作法見上面的說明）' : e.message; changed(); });
    proc.on('close', (code) => {
      const was = tun.state; tun.proc = null; tun.url = '';
      if (was === 'missing') return;
      if (tunWant) { tun.state = 'error'; tun.error = 'cloudflared 結束了（結束碼 ' + code + '）' + (tunRestarts < 5 ? '，5 秒後重試' : '，已停止重試'); changed(); if (tunRestarts++ < 5) setTimeout(() => { if (tunWant && !tun.proc) startTunnel(); }, 5000).unref(); }
      else { tun.state = 'off'; tun.error = ''; changed(); }
    });
  }
  function stopTunnel() { tunWant = false; tunRestarts = 0; if (tun.proc) ctx.proctree.killTree(tun.proc); else { tun.state = 'off'; tun.error = ''; } changed(); }

  // ---------- 對外 ----------
  function status() {
    const a = targetAgent(), s = S(), c = cfg();
    const secretHint = c.channelSecret ? c.channelSecret.slice(0, 4) + '…' : '';
    return {
      configured: configured(), hasSecret: !!c.channelSecret, hasToken: !!c.channelAccessToken, secretHint,
      agentId: c.agentId || '', agentName: a ? a.name : '', allowedCount: allowed().length, pairing: pairingState(),
      port: port(), listening, publicUrl: c.publicUrl || '', webhookUrl: c.publicUrl ? c.publicUrl + '/line/webhook' : '',
      webhook: s.webhook || null, bot: s.bot || null, quota: s.quota || null, pushedThisMonth: s.pushedMonth === month() ? s.pushed || 0 : 0, pushBlocked: s.pushBlocked === month(),
      tunnel: { wanted: !!c.tunnel, state: tun.state, url: tun.url, error: tun.error }, lastEventAt: s.lastEventAt || null, lastError: s.lastError || '', lastErrorAt: s.lastErrorAt || null,
    };
  }
  function update(body) {
    const c = cfg();
    if (body.clear === true) { stopTunnel(); stopServer(); ctx.config.line = {}; ctx.state.line = {}; ctx.saveConfig(); ctx.saveState(); changed(); return status(); }
    if (typeof body.channelSecret === 'string' && body.channelSecret.trim()) {
      const v = body.channelSecret.trim();
      if (!SECRET_RE.test(v)) throw new Error('Channel secret 格式不對：應該是 32 個英數字（LINE Developers → Basic settings 最下面）');
      if (v !== c.channelSecret) { c.allowedUserIds = []; } // 換了 channel，原本的配對作廢
      c.channelSecret = v;
    }
    if (typeof body.channelAccessToken === 'string' && body.channelAccessToken.trim()) {
      const v = body.channelAccessToken.trim();
      if (!TOKEN_RE.test(v)) throw new Error('Channel access token 格式不對：應該是一長串英數字（LINE Developers → Messaging API 最下面的 Channel access token (long-lived) → Issue）');
      c.channelAccessToken = v;
    }
    if (body.agentId !== undefined) { if (body.agentId && !ctx.agentById(String(body.agentId))) throw new Error('找不到這位成員'); c.agentId = String(body.agentId || ''); }
    if (body.publicUrl !== undefined) c.publicUrl = cleanPublicUrl(body.publicUrl);
    if (typeof body.tunnel === 'boolean') c.tunnel = body.tunnel;
    ctx.saveConfig(); changed();
    if (configured()) startServer(); else stopServer();
    return status();
  }
  function unpair() { cfg().allowedUserIds = []; ctx.saveConfig(); changed(); return status(); }

  function start() {
    ctx.hooks.on('done', onDone);
    ctx.hooks.on('timer-alert', onTimerAlert);
    if (configured()) { startServer(); if (cfg().tunnel) startTunnel(); }
  }
  function stop() { ctx.hooks.off('done', onDone); ctx.hooks.off('timer-alert', onTimerAlert); stopTunnel(); stopServer(); }

  return { start, stop, status, update, check, setupWebhook, newPairCode, unpair, startTunnel: () => { cfg().tunnel = true; ctx.saveConfig(); startTunnel(); return status(); },
    stopTunnel: () => { cfg().tunnel = false; ctx.saveConfig(); stopTunnel(); return status(); }, handleBody, port };
}

module.exports = { create, verifySignature, plain, chunk, replyText, cleanPublicUrl };
