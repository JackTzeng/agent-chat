// Telegram 遙控：用手機傳訊息給 agent，agent 的回覆也會推送到 Telegram
// 設定可以在網頁上的「📱 Telegram」完成（貼 token、用配對碼綁定手機），
// 也可以寫在 agents.json 的 "telegram" 區塊，或用環境變數 TELEGRAM_BOT_TOKEN
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { inside } = require('./security');

const HELP =
  '🤖 Agent Chat 遙控\n\n' +
  '📋 任務（依照工作流程交接）\n' +
  '/task 目標　開始新任務\n' +
  '/status　目前任務的進度\n' +
  '/approve [補充]　核准交接\n' +
  '/reject 意見　退回修改\n' +
  '/cancel　停止目前任務\n' +
  '/note 指示　加入任務指示（不中斷，之後每一輪都會看到）\n' +
  '任務在等你回覆時，直接打字就會回給那位成員\n\n' +
  '⚡ 插話\n' +
  '成員正在工作時直接打字，會中斷它這一輪，帶著你的指示接著做\n' +
  '/later 訊息　不中斷，等它這輪做完再給\n\n' +
  '💬 自由聊天\n' +
  '直接打字：交給目前的對象\n' +
  '@名字 訊息：交給指定成員（不切換對象）\n\n' +
  '📒 獨立成員（例如記帳員）\n' +
  '訊息開頭寫它的前綴（例如 /記帳 昨天晚餐 350），或 /to 名字 切換過去，就會直接交給它，不會變成任務\n' +
  '照片和檔案也可以直接傳\n\n' +
  '/list　成員與狀態\n' +
  '/to 名字　切換對象\n' +
  '/stop　全部停止\n' +
  '/new　目前對象開新對話\n' +
  '/usage　Claude / Codex 用量額度\n' +
  '/mute　暫停推送（/unmute 恢復）\n' +
  '/help　顯示這份說明';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiBase = () => process.env.TELEGRAM_API || 'https://api.telegram.org';
const MAX_FILE = 20 * 1024 * 1024; // Telegram bot 能下載的檔案上限

// 一個 bot 的 API 呼叫（主 bot 與成員專屬 bot 共用）
function makeClient(token, signal) {
  const API = apiBase() + '/bot' + token;
  async function call(method, body, isForm) {
    const r = await fetch(API + '/' + method, isForm
      ? { method: 'POST', body, signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw Object.assign(new Error(j.description || 'HTTP ' + r.status), { code: j.error_code });
    return j.result;
  }
  async function say(chatId, text) {
    text = String(text || '').trim() || '（空白）';
    for (let i = 0; i < text.length; i += 3800) {
      try { await call('sendMessage', { chat_id: chatId, text: text.slice(i, i + 3800), disable_web_page_preview: true }); }
      catch (e) { console.error('Telegram 傳送失敗：' + e.message); return; }
    }
  }
  async function sendMedia(chatId, file) {
    const ext = path.extname(file).toLowerCase();
    const isImg = IMG_EXT.includes(ext), isVid = VIDEO_EXT.includes(ext);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(isImg ? 'photo' : isVid ? 'video' : 'document', new Blob([fs.readFileSync(file)]), path.basename(file));
    try { await call(isImg ? 'sendPhoto' : isVid ? 'sendVideo' : 'sendDocument', form, true); } catch (e) { console.error('Telegram 傳送檔案失敗：' + e.message); }
  }
  const typing = (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  async function download(fileId) {
    const f = await call('getFile', { file_id: fileId });
    if (f.file_size > MAX_FILE) throw new Error('檔案太大（Telegram bot 最多 20MB）');
    const r = await fetch(apiBase() + '/file/bot' + token + '/' + f.file_path, { signal });
    if (!r.ok) throw new Error('下載失敗 HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_FILE) throw new Error('檔案太大（Telegram bot 最多 20MB）');
    return { buf, filePath: String(f.file_path || '') };
  }
  return { call, say, sendMedia, typing, download };
}

// Telegram 傳來的照片／檔案存到成員工作資料夾的 attachments/，回傳相對路徑
async function saveAttachments(cl, msg, agent) {
  const items = [];
  if (Array.isArray(msg.photo) && msg.photo.length) items.push({ id: msg.photo[msg.photo.length - 1].file_id, name: '', size: msg.photo[msg.photo.length - 1].file_size });
  if (msg.document) items.push({ id: msg.document.file_id, name: String(msg.document.file_name || ''), size: msg.document.file_size });
  if (!items.length) return [];
  const dir = path.join(agent.cwd, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  const out = [];
  for (const it of items) {
    if (it.size > MAX_FILE) throw new Error('檔案太大（Telegram bot 最多 20MB）');
    const { buf, filePath } = await cl.download(it.id);
    let ext = path.extname(it.name || filePath).toLowerCase();
    if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = it.name ? '' : '.jpg';
    const stem = it.name ? path.basename(it.name, path.extname(it.name)).replace(/[\\/:*?"<>|\x00-\x1f%!^&]/g, '_').trim().slice(0, 60) : '';
    const base = 'tg-' + stamp + (stem ? '-' + stem : '');
    let final = base + ext;
    for (let i = 2; fs.existsSync(path.join(dir, final)); i++) final = base + '-' + i + ext;
    fs.writeFileSync(path.join(dir, final), buf);
    out.push('attachments/' + final);
  }
  return out;
}
const withAttachments = (text, files) => (!files.length ? text
  : (text || '請看附件。') + '\n\n📎 附件（已存到你的工作資料夾，請先讀取）：\n' + files.map((f) => '- ' + f).join('\n'));
const labelOf = (a) => (a.avatar && !a.avatar.startsWith('img:') ? a.avatar : '👤') + ' ' + a.name;

// 回覆中用 ![](路徑) 顯示的本機檔案（限該成員工作資料夾、20MB 內）
function mediaFilesOf(agent, text) {
  const out = [];
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    let src; try { src = decodeURI(m[1]); } catch { continue; }
    if (/^(https?:|data:)/i.test(src)) continue;
    if (![...IMG_EXT, ...VIDEO_EXT].includes(path.extname(src).toLowerCase())) continue;
    try {
      const f = fs.realpathSync(path.resolve(agent.cwd, src));
      if (!inside(fs.realpathSync(agent.cwd), f)) continue;
      if (fs.statSync(f).isFile() && fs.statSync(f).size < 20e6 && !out.includes(f)) out.push(f);
    } catch {}
  }
  return out;
}
// 一輪的結果傳回 Telegram：沒有文字也一定要有回應（錯誤或「沒有回覆」）
async function sendReply(cl, chatId, agent, segments, withLabel) {
  const texts = segments.filter((s) => s.type === 'text').map((s) => s.text);
  const errors = segments.filter((s) => s.type === 'error').map((s) => '⚠️ ' + s.text);
  let body = [...texts, ...errors].join('\n\n') || '（' + agent.name + ' 這一輪沒有回覆內容）';
  if (withLabel) body = labelOf(agent) + '\n\n' + body;
  await cl.say(chatId, body);
  for (const f of mediaFilesOf(agent, texts.join('\n'))) await cl.sendMedia(chatId, f);
}
// 交給獨立成員：不建立任務、不插話（忙的時候排隊），回覆只回到這個聊天
async function toStandalone(ctx, cl, agent, text, msg, botKey) {
  const chatId = msg.chat.id, userId = String(msg.from.id);
  const only = ((agent.telegram && agent.telegram.userIds) || []).map(String);
  if (only.length && !only.includes(userId)) {
    console.log('⚠️  Telegram：' + agent.name + ' 拒絕未指定的帳號 ' + userId);
    return botKey === 'main' ? cl.say(chatId, '⛔ ' + agent.name + ' 只接受指定的 Telegram 帳號。') : undefined;
  }
  let files = [];
  try { files = await saveAttachments(cl, msg, agent); } catch (e) { return cl.say(chatId, '⚠️ 附件下載失敗：' + e.message); }
  const body = withAttachments(String(text || '').trim(), files);
  if (!body) return cl.say(chatId, '請輸入內容，例如：昨天晚餐 350');
  cl.typing(chatId);
  const r = ctx.dispatch(agent, body, { via: 'telegram', tg: { bot: botKey, chatId }, tgUser: userId });
  if (r === 'queued') await cl.say(chatId, '⏳ ' + agent.name + ' 還在處理上一則，這則已排隊');
}
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const VIDEO_EXT = ['.mp4', '.mov', '.webm'];

// 連線狀態（給網頁顯示）與配對碼
const STATUS = { state: 'off', username: '', error: '' };
let session = null;   // 目前的連線，可以停止後重新開始（改 token 不用重開伺服器）
let pairing = null;   // { code, expires }
let lastCtx = null;
const badPairing = new Map();

function setStatus(patch) {
  Object.assign(STATUS, patch);
  if (lastCtx && lastCtx.broadcast) lastCtx.broadcast({ agentId: '*', kind: 'telegram' });
}
exports.status = () => {
  const cfg = (lastCtx && lastCtx.config.telegram) || {};
  const token = process.env.TELEGRAM_BOT_TOKEN || cfg.botToken || '';
  return {
    ...STATUS, enabled: cfg.enabled !== false, hasToken: !!token, fromEnv: !!process.env.TELEGRAM_BOT_TOKEN,
    tokenHint: token ? '…' + token.slice(-4) : '', allowedCount: (cfg.allowedUserIds || []).length, allowedIds: (cfg.allowedUserIds || []).map(String),
    defaultAgent: cfg.defaultAgent || '', pairing: pairing && pairing.expires > Date.now() ? { code: pairing.code, expires: pairing.expires } : null,
    agentBots: [...agentBots.entries()].map(([id, b]) => ({ agentId: id, state: b.status.state, username: b.status.username, error: b.status.error })),
  };
};

// ---------- 成員專屬 bot：這個 bot 的每則訊息都交給同一位獨立成員 ----------
const agentBots = new Map(); // agentId -> { token, stop, status }
exports.startAgentBots = function startAgentBots(ctx) {
  lastCtx = lastCtx || ctx;
  const want = new Map(ctx.agents.filter((a) => a.standalone && a.telegram && a.telegram.botToken).map((a) => [a.id, a]));
  for (const [id, b] of agentBots) {
    if (!want.has(id) || want.get(id).telegram.botToken !== b.token) { b.stop(); agentBots.delete(id); }
  }
  for (const [id, a] of want) if (!agentBots.has(id)) agentBots.set(id, startAgentBot(ctx, a));
  if (ctx.broadcast) ctx.broadcast({ agentId: '*', kind: 'telegram' });
};
exports.stopAgentBots = () => { for (const b of agentBots.values()) b.stop(); agentBots.clear(); };

function startAgentBot(ctx, a0) {
  const id = a0.id, token = a0.telegram.botToken;
  const ac = new AbortController();
  let alive = true;
  const cl = makeClient(token, ac.signal);
  const status = { state: 'connecting', username: '', error: '' };
  const changed = () => ctx.broadcast && ctx.broadcast({ agentId: '*', kind: 'telegram' });
  const onDone = ({ agent, tg, segments, shift }) => {
    if (agent.id !== id || !tg || tg.bot !== id) return;
    sendReply(cl, tg.chatId, agent, shift ? [{ type: 'text', text: '🔄 對話太長，已經寫好交班筆記，下一則起換成全新的對話接手' }] : segments, false).catch(() => {});
  };
  ctx.hooks.on('done', onDone);
  const st = (ctx.state.agentBots = ctx.state.agentBots || {});
  st[id] = st[id] || { offset: 0 };

  async function handle(msg) {
    if (!msg || !msg.from || !msg.chat || msg.chat.type !== 'private') return;
    const agent = ctx.agentById(id);
    if (!agent) return;
    const userId = String(msg.from.id), chatId = msg.chat.id;
    const paired = ((ctx.config.telegram || {}).allowedUserIds || []).map(String);
    const only = ((agent.telegram && agent.telegram.userIds) || []).map(String);
    // 只接受已配對（主 bot 配對過）且在名單內的帳號；其他人一律不回應
    if (!paired.includes(userId) || (only.length && !only.includes(userId))) {
      console.log('⚠️  Telegram（' + agent.name + ' 專屬 bot）：不處理未授權的帳號 ' + userId);
      return;
    }
    const text = String(msg.text || msg.caption || '').trim();
    const cmd = !msg.photo && !msg.document && text.match(/^\/(\w+)(?:@\w+)?\s*$/);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      if (name === 'start' || name === 'help') return cl.say(chatId, labelOf(agent) + ' 的專屬聊天\n\n直接傳文字或照片給它，回覆會傳回這裡。\n/new　開新對話（忘掉前面的內容）\n/stop　停止它目前的工作');
      if (name === 'new') return cl.say(chatId, ctx.resetAgent(agent.id) ? '🆕 已開新對話' : '它正在工作，請先 /stop');
      if (name === 'stop') { ctx.stopRun(agent.id); return cl.say(chatId, '⏹ 已停止'); }
    }
    await toStandalone(ctx, cl, agent, text, msg, id);
  }

  (async function poll() {
    let lastErr = '';
    try {
      const me = await cl.call('getMe', {});
      Object.assign(status, { state: 'connected', username: me.username, error: '' }); changed();
      console.log('📱 ' + a0.name + ' 的專屬 bot 已連線：@' + me.username);
    } catch (e) {
      if (!alive) return;
      Object.assign(status, { state: 'error', error: e.code === 401 ? 'bot token 不正確' : e.message }); changed();
      console.error('⚠️  ' + a0.name + ' 的專屬 bot 連線失敗：' + status.error);
      if (e.code === 401) return;
    }
    while (alive) {
      try {
        const updates = await cl.call('getUpdates', { offset: st[id].offset, timeout: 50, allowed_updates: ['message'] });
        if (status.state !== 'connected') { try { const me = await cl.call('getMe', {}); Object.assign(status, { state: 'connected', username: me.username, error: '' }); changed(); } catch {} }
        lastErr = '';
        for (const u of updates) {
          st[id].offset = u.update_id + 1; ctx.saveState();
          handle(u.message).catch((e) => console.error('專屬 bot 處理訊息失敗：' + e.message));
        }
      } catch (e) {
        if (!alive) return;
        if (e.message !== lastErr) { console.error('⚠️  ' + a0.name + ' 的專屬 bot：' + e.message + '，5 秒後重試'); lastErr = e.message; }
        if (e.code === 401) { Object.assign(status, { state: 'error', error: 'bot token 不正確' }); changed(); return; }
        if (e.code === 409) { Object.assign(status, { state: 'error', error: '同一個 bot 在別的地方也在執行' }); changed(); }
        await sleep(5000);
      }
    }
  })();

  return { token, status, stop() { alive = false; ac.abort(); ctx.hooks.off('done', onDone); } };
}
exports.newPairCode = () => {
  pairing = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + 5 * 60 * 1000 };
  return exports.status().pairing;
};
exports.stop = () => { if (session) { session.stop(); session = null; } setStatus({ state: 'off', username: '', error: '' }); };

exports.start = function start(ctx) {
  lastCtx = ctx;
  if (session) { session.stop(); session = null; }
  const cfg = (ctx.config.telegram = ctx.config.telegram || {});
  const token = process.env.TELEGRAM_BOT_TOKEN || cfg.botToken;
  if (!token || cfg.enabled === false) { setStatus({ state: 'off', username: '', error: '' }); return; }

  let alive = true;
  const ac = new AbortController();
  const listeners = [];
  const listen = (evt, fn) => { ctx.hooks.on(evt, fn); listeners.push([evt, fn]); };
  session = { stop() { alive = false; ac.abort(); for (const [e, f] of listeners) ctx.hooks.off(e, f); } };
  setStatus({ state: 'connecting', error: '' });

  const API = apiBase() + '/bot' + token;
  const cl = makeClient(token, ac.signal);
  const allowedIds = () => (cfg.allowedUserIds || []).map(String);
  const tg = (ctx.state.telegram = ctx.state.telegram || { offset: 0, chats: {} });
  const pushRecipients = () => Object.keys(tg.chats).filter((id) => {
    const c = tg.chats[id];
    return c && !c.muted && allowedIds().includes(String(c.userId || ''));
  });
  const defaultTarget = () => (ctx.agentById(cfg.defaultAgent) || ctx.agents[0]).id;
  // 成員可能在網頁上被刪除，找不到時退回第一位
  const targetOf = (c) => ctx.agentById(c.target) || ctx.agents[0];
  const label = (a) => (a.avatar && !a.avatar.startsWith('img:') ? a.avatar : '👤') + ' ' + a.name;

  async function call(method, body, isForm) {
    const r = await fetch(API + '/' + method, isForm
      ? { method: 'POST', body, signal: ac.signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw Object.assign(new Error(j.description || 'HTTP ' + r.status), { code: j.error_code });
    return j.result;
  }

  async function say(chatId, text) {
    text = String(text || '').trim() || '（空白）';
    for (let i = 0; i < text.length; i += 3800) {
      try { await call('sendMessage', { chat_id: chatId, text: text.slice(i, i + 3800), disable_web_page_preview: true }); }
      catch (e) { console.error('Telegram 傳送失敗：' + e.message); return; }
    }
  }

  async function sendMedia(chatId, file) {
    const ext = path.extname(file).toLowerCase();
    const isImg = IMG_EXT.includes(ext), isVid = VIDEO_EXT.includes(ext);
    const method = isImg ? 'sendPhoto' : isVid ? 'sendVideo' : 'sendDocument';
    const field = isImg ? 'photo' : isVid ? 'video' : 'document';
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(field, new Blob([fs.readFileSync(file)]), path.basename(file));
    try { await call(method, form, true); } catch (e) { console.error('Telegram 傳送檔案失敗：' + e.message); }
  }

  // 回覆中用 ![](路徑) 顯示的本機檔案（限該成員工作資料夾、20MB 內）
  function mediaFiles(agent, text) {
    const out = [];
    const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(text))) {
      let src; try { src = decodeURI(m[1]); } catch { continue; }
      if (/^(https?:|data:)/i.test(src)) continue;
      if (![...IMG_EXT, ...VIDEO_EXT].includes(path.extname(src).toLowerCase())) continue;
      try {
        const f = fs.realpathSync(path.resolve(agent.cwd, src));
        const root = fs.realpathSync(agent.cwd);
        if (!inside(root, f)) continue;
        if (fs.statSync(f).isFile() && fs.statSync(f).size < 20e6 && !out.includes(f)) out.push(f);
      } catch {}
    }
    return out;
  }

  function usageText() {
    const u = ctx.usageSnapshot(), now = Date.now();
    const NAMES = { '5h': '5 小時', week: '每週', week_opus: '每週 Opus', week_sonnet: '每週 Sonnet' };
    const block = (title, x) => {
      const wins = Object.entries((x && x.windows) || {});
      if (!wins.length) return title + '：還沒有資料';
      return title + (x.updatedAt ? '（' + new Date(x.updatedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) + ' 更新）' : '') + '\n' +
        wins.map(([k, w]) => {
          const reset = w.resetsAt && w.resetsAt * 1000 < now, used = reset ? 0 : w.pct;
          let left = '';
          if (w.resetsAt && !reset) { const m = Math.round((w.resetsAt * 1000 - now) / 60000); left = m < 1440 ? '，' + Math.floor(m / 60) + ' 小時 ' + (m % 60) + ' 分後重置' : '，' + Math.round(m / 1440) + ' 天後重置'; }
          return '　' + (NAMES[k] || k) + '：剩 ' + Math.round(100 - used) + '%' + (reset ? '（已重置）' : left);
        }).join('\n');
    };
    return '📊 用量額度\n\n' + block('Claude', u.claude) + '\n\n' + block('Codex', u.codex);
  }

  function taskStatusText() {
    const t = ctx.tasks.active();
    if (!t) {
      const last = ctx.tasks.list()[0];
      return '目前沒有進行中的任務。' + (last ? '\n最近一件：#' + last.id + ' ' + last.title + '（' + last.statusText + '）' : '') + '\n用 /task 目標 開始新任務';
    }
    const stages = ctx.config.workflow.stages;
    const line = stages.map((s) => (s.id === t.stageId ? '▶' : t.done.includes(s.id) ? '✅' : '○') + s.name).join(' → ');
    let msg = '📋 任務 #' + t.id + '：' + t.title + '\n狀態：' + t.statusText + '｜交接 ' + t.turns + ' 次\n' + line;
    if (t.status === 'awaiting_approval') msg += '\n\n等你核准：/approve 或 /reject 意見';
    if (t.status === 'waiting_user') msg += '\n\n等你回覆：直接打字即可';
    return msg;
  }

  // 任務事件推送（開始、等核准、等回覆、完成、停止、出錯）
  listen('task', async ({ task, event, message }) => {
    if (!event || event === 'handoff' || event === 'checking') return;
    const chats = pushRecipients();
    const head = { started: '📋', awaiting_approval: '🔔 需要你核准', waiting_user: '⏳ 等你回覆', done: '🎉 任務完成',
      stopped: '⏹', error: '⚠️ 任務暫停', rejected: '↩️', budget: '⏸ 超出預算', checks_failed: '🧪 自動檢查沒通過' }[event] || '📋';
    let body = head + '（任務 #' + task.id + '）\n' + (message || '');
    if (event === 'awaiting_approval') body += '\n\n👉 /approve 核准，或 /reject 意見 退回';
    if (event === 'waiting_user' || event === 'error' || event === 'budget') body += '\n\n👉 直接打字回覆，或 /cancel 停止任務';
    for (const id of chats) await say(id, body);
  });

  // 新的守則建議（要到網頁的 🧭 Harness 核准）
  listen('proposal', async ({ proposal, fromName }) => {
    for (const id of pushRecipients()) await say(id, '💡 新的守則建議（' + fromName + (proposal.taskId ? '，任務 #' + proposal.taskId : '') + '）：\n' + proposal.text + '\n\n請到網頁的「🧭 Harness」核准或略過。');
  });

  function chat(chatId, userId) {
    if (!tg.chats[chatId]) tg.chats[chatId] = { target: defaultTarget(), muted: false };
    // Every push recipient is bound to one private Telegram user, not merely a chat ID.
    tg.chats[chatId].userId = String(userId);
    ctx.saveState();
    return tg.chats[chatId];
  }

  function findAgent(name) {
    const n = String(name || '').trim().replace(/^@/, '').toLowerCase();
    if (!n) return null;
    return ctx.agents.find((a) => a.id.toLowerCase() === n || a.name.toLowerCase() === n) ||
      ctx.agents.find((a) => a.name.toLowerCase().includes(n));
  }

  function listText(c) {
    return '成員：\n' + ctx.agents.map((a) =>
      (a.id === targetOf(c).id ? '👉 ' : '　 ') + label(a) + (ctx.runs.has(a.id) ? ' ⏳工作中' : '') +
      '\n　　' + [a.role, [a.model || a.engine, a.effort].filter(Boolean).join(' · ')].filter(Boolean).join('｜')
    ).join('\n') + '\n\n目前對象：' + label(targetOf(c)) + '\n用 /to 名字 切換';
  }

  async function handle(msg) {
    if (!msg || !msg.from || !msg.chat || msg.chat.type !== 'private') return;
    const chatId = msg.chat.id, userId = String(msg.from.id);
    if (!allowedIds().includes(userId)) {
      // 配對：使用者在網頁上產生 6 位數配對碼，傳給 bot 就會加入白名單
      const digits = String(msg.text || '').trim();
      const attempts = badPairing.get(userId);
      const locked = attempts && attempts.until > Date.now() && attempts.count >= 5;
      if (locked) return;
      if (pairing && pairing.expires > Date.now() && digits === pairing.code) {
        badPairing.delete(userId);
        cfg.allowedUserIds = [...new Set([...(cfg.allowedUserIds || []), Number(userId)])];
        pairing = null;
        ctx.saveConfig();
        setStatus({});
        console.log('📱 Telegram：已配對使用者 ' + userId + (msg.from.username ? '（@' + msg.from.username + '）' : ''));
        chat(chatId, userId);
        return say(chatId, '✅ 配對成功！之後可以用這個帳號遙控 Agent Chat。\n\n' + HELP);
      }
      if (/^\d{6}$/.test(digits)) {
        const cur = badPairing.get(userId);
        badPairing.set(userId, { count: cur && cur.until > Date.now() ? cur.count + 1 : 1, until: Date.now() + 10 * 60000 });
      }
      console.log('⚠️  Telegram：拒絕未授權的使用者 ' + userId + (msg.from.username ? '（@' + msg.from.username + '）' : ''));
      return say(chatId, '⛔ 你還沒有使用權限。\n請在 Agent Chat 網頁按「📱 Telegram」→「產生配對碼」，再把 6 位數配對碼傳給我。');
    }
    const text = String(msg.text || msg.caption || '').trim();
    const hasFile = !!((msg.photo && msg.photo.length) || msg.document);
    if (!text && !hasFile) return say(chatId, '目前只支援文字、照片和檔案。');
    const c = chat(chatId, userId);
    // 獨立成員的前綴（例如「/記帳 昨天晚餐 350」）：直接交給它，不進任務流程
    const pre = ctx.agents.find((a) => a.standalone && a.telegram && a.telegram.prefix && (text === a.telegram.prefix || text.startsWith(a.telegram.prefix + ' ') || text.startsWith(a.telegram.prefix + '\n') || (!/^[\/@]/.test(a.telegram.prefix) && text.startsWith(a.telegram.prefix))));
    if (pre) return toStandalone(ctx, cl, pre, text.slice(pre.telegram.prefix.length).trim(), msg, 'main');
    // 照片／檔案存到收件成員的工作資料夾，路徑附在訊息後面
    const prep = async (a, t) => {
      if (!hasFile) return t;
      return withAttachments(t, await saveAttachments(cl, msg, a));
    };
    const cmd = hasFile ? null : text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);

    if (cmd) {
      const [, name, arg] = cmd;
      switch (name.toLowerCase()) {
        case 'start': case 'help': return say(chatId, HELP + '\n\n' + listText(c));
        case 'list': return say(chatId, listText(c));
        case 'to': {
          const a = findAgent(arg);
          if (!a) return say(chatId, '找不到「' + arg + '」。\n' + listText(c));
          c.target = a.id; ctx.saveState();
          return say(chatId, '之後的訊息會交給 ' + label(a));
        }
        case 'stop':
          for (const a of ctx.agents) ctx.stopRun(a.id);
          return say(chatId, '⏹ 已全部停止');
        case 'new': {
          const a = targetOf(c);
          return say(chatId, ctx.resetAgent(a.id) ? '🆕 ' + label(a) + ' 已開新對話' : a.name + ' 工作中，請先 /stop');
        }
        case 'usage': return say(chatId, usageText());
        case 'task': {
          if (!arg.trim()) return say(chatId, '用法：/task 任務目標\n例如：/task 做一個讀 CSV 算平均值的 Python 小工具');
          try { ctx.tasks.start(arg, 'telegram'); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return;
        }
        case 'status': case 'tasks': return say(chatId, taskStatusText());
        case 'approve': {
          const t = ctx.tasks.active();
          if (!t || t.status !== 'awaiting_approval') return say(chatId, '目前沒有等待核准的交接。');
          try { ctx.tasks.approve(t.id, arg.trim()); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return say(chatId, '✅ 已核准');
        }
        case 'reject': {
          const t = ctx.tasks.active();
          if (!t || t.status !== 'awaiting_approval') return say(chatId, '目前沒有等待核准的交接。');
          if (!arg.trim()) return say(chatId, '請附上意見，例如：/reject 驗收標準要寫清楚輸出格式');
          try { ctx.tasks.reject(t.id, arg.trim()); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return;
        }
        case 'note': {
          const t = ctx.tasks.active();
          if (!t) return say(chatId, '目前沒有進行中的任務。');
          if (!arg.trim()) return say(chatId, '用法：/note 指示內容');
          try { ctx.tasks.addNote(t.id, arg.trim(), 'telegram'); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return say(chatId, '📌 已加入任務指示，之後每一輪都會看到');
        }
        case 'later': {
          if (!arg.trim()) return say(chatId, '用法：/later 訊息');
          const a = targetOf(c);
          ctx.dispatch(a, arg.trim(), { via: 'telegram' });
          return say(chatId, '🕒 已排隊，' + label(a) + ' 做完這輪就會收到');
        }
        case 'cancel': {
          const t = ctx.tasks.active();
          if (!t) return say(chatId, '目前沒有進行中的任務。');
          try { ctx.tasks.stop(t.id); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return;
        }
        case 'mute': c.muted = true; ctx.saveState(); return say(chatId, '🔕 已暫停推送，/unmute 恢復');
        case 'unmute': c.muted = false; ctx.saveState(); return say(chatId, '🔔 已恢復推送');
        default: return say(chatId, '不認得這個指令。\n\n' + HELP);
      }
    }

    // @獨立成員，或目前對象就是獨立成員（/to 記帳員）→ 直接交給它，不受任務影響
    const at = text.match(/^@(\S+)\s*/);
    const atAgent = at && findAgent(at[1]);
    if (atAgent && atAgent.standalone) return toStandalone(ctx, cl, atAgent, text.slice(at[0].length), msg, 'main');
    if (!atAgent && targetOf(c).standalone) return toStandalone(ctx, cl, targetOf(c), text, msg, 'main');

    try {
    // 任務正在等使用者回覆 → 這則訊息就是回覆
    const t = ctx.tasks.active();
    if (t && (t.status === 'waiting_user' || t.status === 'error') && !/^@/.test(text)) {
      try { ctx.tasks.reply(t.id, await prep(ctx.agentById(t.waitingFor) || targetOf(c), text), 'telegram'); return say(chatId, '✅ 已回覆，任務繼續'); }
      catch (e) { return say(chatId, '⚠️ ' + e.message); }
    }

    // 開頭寫 @名字 → 直接交給那位，不切換對象
    let agent = targetOf(c);
    if (atAgent) agent = atAgent;
    // 任務進行中、沒有指定對象：插話給正在工作的成員
    if (t && t.status === 'running' && !at) {
      const st = ctx.config.workflow.stages.find((x) => x.id === t.stageId);
      const w = (st && ctx.runs.has(st.owner) && ctx.agentById(st.owner)) || ctx.agents.find((a) => ctx.runs.has(a.id));
      if (w) agent = w;
    }
    // 對象正在工作 → 插話（中斷這一輪，帶著指示繼續）
    const full = await prep(agent, text);
    if (ctx.runs.has(agent.id)) {
      ctx.interject(agent, full, 'telegram');
      return say(chatId, '⚡ 已插話給 ' + label(agent) + '，它會帶著你的指示接著做（不想中斷請用 /later）');
    }
    const busy = ctx.runs.has(agent.id);
    const cc = ctx.userSend(agent, full, 'telegram');
    await say(chatId, (busy ? '⏳ ' + label(agent) + ' 正在忙，已排隊' : '✅ 已交給 ' + label(agent)) +
      (cc.length ? '\n📢 也同時交給 ' + cc.map(label).join('、') : ''));
    } catch (e) { return say(chatId, '⚠️ ' + e.message); }
  }

  // 成員可能卡住
  listen('stalled', async ({ agent, text }) => {
    const chats = pushRecipients();
    for (const id of chats) await say(id, label(agent) + '\n' + text + '\n\n👉 /stop 全部停止');
  });

  // agent 每做完一輪就推送結果
  listen('done', async ({ agent, tg, segments, relayTo, shift }) => {
    // 獨立成員：只回到傳訊息來的那個聊天（網頁上的對話、專屬 bot 的對話不推到這裡）
    if (agent.standalone) {
      if (tg && tg.bot === 'main' && !shift) await sendReply(cl, tg.chatId, agent, segments, true);
      return;
    }
    const chats = pushRecipients();
    if (!chats.length || !segments.length) return;
    if (shift) { for (const id of chats) await say(id, label(agent) + ' 🔄 對話太長，已經寫好交班筆記，下一輪換成全新的對話接手'); return; }
    const texts = segments.filter((s) => s.type === 'text').map((s) => s.text);
    const errors = segments.filter((s) => s.type === 'error').map((s) => '⚠️ ' + s.text);
    const steps = segments.filter((s) => s.type === 'tool').length;
    let body = label(agent) + (steps ? '（' + steps + ' 個步驟）' : '') + '\n\n' + [...texts, ...errors].join('\n\n');
    if (relayTo && relayTo.length) body += '\n\n📨 轉交給 ' + relayTo.map(label).join('、');
    const files = mediaFiles(agent, texts.join('\n'));
    for (const id of chats) {
      await say(id, body);
      for (const f of files) await sendMedia(id, f);
    }
  });

  let offset = tg.offset || 0;
  let lastErr = '';
  (async function poll() {
    try {
      const me = await call('getMe', {});
      setStatus({ state: 'connected', username: me.username, error: '' });
      const n = allowedIds().length;
      console.log('📱 Telegram 已連線：@' + me.username + (n ? '（允許 ' + n + ' 位使用者）' : '（還沒配對手機：請在網頁按「📱 Telegram」產生配對碼）'));
    } catch (e) {
      if (!alive) return;
      const why = e.code === 401 ? 'bot token 不正確' : '連不上 Telegram（網路可能擋了 api.telegram.org）：' + e.message;
      setStatus({ state: 'error', username: '', error: why });
      console.error('⚠️  Telegram 連線失敗：' + why);
      if (e.code === 401) return;
    }
    while (alive) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        lastErr = '';
        if (STATUS.state !== 'connected') {
          try { const me = await call('getMe', {}); setStatus({ state: 'connected', username: me.username, error: '' }); } catch {}
        }
        for (const u of updates) {
          offset = u.update_id + 1;
          tg.offset = offset; ctx.saveState();
          handle(u.message).catch((e) => console.error('Telegram 處理訊息失敗：' + e.message));
        }
      } catch (e) {
        if (!alive) return;
        if (e.message !== lastErr) { console.error('⚠️  Telegram：' + e.message + '，5 秒後重試'); lastErr = e.message; }
        if (e.code === 401) { setStatus({ state: 'error', error: 'bot token 不正確' }); return; }
        if (e.code === 409) setStatus({ state: 'error', error: '同一個 bot 在別的地方也在執行（可能另一個 start.bat 還開著）' });
        await sleep(5000);
      }
    }
  })();
};
