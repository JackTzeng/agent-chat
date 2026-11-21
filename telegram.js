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
  '/task 目標　開始新任務（交給目前對象的小組；/task 小組名 目標 指定小組）\n' +
  '/status　目前任務的進度\n' +
  '/approve [補充]　核准交接\n' +
  '/reject 意見　退回修改\n' +
  '/cancel　停止目前任務\n' +
  '/note 指示　加入任務指示（不中斷，之後每一輪都會看到）\n' +
  '任務在等你回覆時，直接打字就會回給那位成員\n' +
  '同時有好幾件任務時，在訊息或指令後面加 #編號 指定任務，例如 /approve #12、#12 改用 CSV\n\n' +
  '⚡ 插話\n' +
  '成員正在工作時直接打字，會中斷它這一輪，帶著你的指示接著做\n' +
  'PM 派工寫了【緊急】也會中斷同事（冷卻時間內只能一次），之後同事會回頭做原本的事\n' +
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
  '/pause 原因　⏸ 暫停專案：成員做完這一輪、寫好交班筆記後停下，新的派工和排程先排隊（/pausenow 立刻停）\n' +
  '/resume 指示　▶ 重啟專案，可以加一句給所有成員的補充指示\n' +
  '/new　目前對象開新對話\n' +
  '/usage　Claude / Codex 用量額度、agy 本週用量\n' +
  '/skills　🧩 Skill 安裝申請；/skill 編號 ok（會再問一次）／no\n' +
  '/timers　⏰ 看所有排程；/timer 編號 run／on／off／ok／no\n' +
  '/fb　🐞 還沒解決的錯誤回報；/fb 編號 看內容、/fb 編號 done 備註（已解決）、doing（處理中）、open（改回未處理）\n' +
  '/md　📝 維修工程師的設定檔修改提案；/md 編號 看內容、/md 編號 ok 核准、/md 編號 no 不採用\n' +
  '/report 描述　🐞 產生問題回報檔傳給你（轉給 Claude 排查）\n' +
  '/update　⬆️ 檢查更新，有新版就更新並重新啟動\n' +
  '/restart　🔄 重新啟動伺服器\n' +
  '/mute　暫停推送（/unmute 恢復）\n' +
  '/help　顯示這份說明';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiBase = () => process.env.TELEGRAM_API || 'https://api.telegram.org';
const MAX_FILE = 20 * 1024 * 1024; // Telegram bot 能下載的檔案上限

// 一個 bot 的 API 呼叫（主 bot 與成員專屬 bot 共用）
// 📮 Telegram 送不出去時：連不上（沒有 error_code）、429、5xx 才交給 outbox 稍後重送；400／401／403（被封鎖、token 錯）重送也沒用
const tgRetryable = (e) => !e.code || e.code === 429 || e.code >= 500;
function makeSay(call, ctx, channel, label) {
  async function say(chatId, text) {
    text = String(text || '').trim() || '（空白）';
    const parts = [];
    for (let i = 0; i < text.length; i += 3800) parts.push(text.slice(i, i + 3800));
    for (let i = 0; i < parts.length; i++) {
      try { await call('sendMessage', { chat_id: chatId, text: parts[i], disable_web_page_preview: true }); }
      catch (e) {
        const queue = tgRetryable(e) && ctx && ctx.outbox;
        console.error('Telegram 傳送失敗' + (queue ? '，稍後會自動重送' : '') + '：' + e.message);
        if (queue) for (const t of parts.slice(i)) ctx.outbox.add({ channel, target: chatId, payload: { text: t }, label, error: e.message });
        return;
      }
    }
  }
  // 給 outbox 重送用：一次一段
  async function resend(chatId, payload) {
    try { await call('sendMessage', { chat_id: chatId, text: String(payload.text || ''), disable_web_page_preview: true }); return { ok: true }; }
    catch (e) { return { ok: false, retry: tgRetryable(e), error: e.message }; }
  }
  return { say, resend };
}
function makeClient(token, signal, ctx, channel, label) {
  const API = apiBase() + '/bot' + token;
  async function call(method, body, isForm) {
    const r = await fetch(API + '/' + method, isForm
      ? { method: 'POST', body, signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw Object.assign(new Error(j.description || 'HTTP ' + r.status), { code: j.error_code });
    return j.result;
  }
  const { say, resend } = makeSay(call, ctx, channel, label);
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
  return { call, say, resend, sendMedia, typing, download };
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
// 成員的 telegram.names：{ "帳號 ID": "名稱" }；名稱只在系統寫入的【傳訊者：…】出現
function senderName(agent, userId) {
  const names = (agent.telegram && agent.telegram.names) || {};
  return Object.prototype.hasOwnProperty.call(names, String(userId)) ? String(names[String(userId)]) : '';
}
exports.senderName = senderName;
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
  let body = withAttachments(String(text || '').trim(), files);
  if (!body) return cl.say(chatId, '請輸入內容，例如：昨天晚餐 350');
  // 成員設定了「帳號 ID=名稱」時，在訊息最前面告訴它是誰傳的（例如記帳員用來決定預設付款人）
  const who = senderName(agent, userId);
  // 使用者自己打的「【傳訊者：…】」不算數，只有系統加的那一個是真的
  if (who) body = '【傳訊者：' + who + '】' + body.replace(/【\s*傳訊者/g, '[傳訊者');
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
  const cl = makeClient(token, ac.signal, ctx, 'tg:' + id, 'Telegram（' + a0.name + '）');
  if (ctx.outbox) ctx.outbox.register('tg:' + id, cl.resend);
  const status = { state: 'connecting', username: '', error: '' };
  const changed = () => ctx.broadcast && ctx.broadcast({ agentId: '*', kind: 'telegram' });
  const onDone = ({ agent, tg, segments, shift }) => {
    if (agent.id !== id || !tg || tg.bot !== id) return;
    sendReply(cl, tg.chatId, agent, shift ? [{ type: 'text', text: '🔄 對話太長，已經寫好交班筆記，下一則起換成全新的對話接手' }] : segments, false).catch(() => {});
  };
  ctx.hooks.on('done', onDone);
  const st = (ctx.state.agentBots = ctx.state.agentBots || {});
  st[id] = st[id] || { offset: 0 };

  let myName = '';
  async function handle(msg) {
    if (!msg || !msg.from || !msg.chat) return;
    const agent = ctx.agentById(id);
    if (!agent) return;
    const inGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    // 群組只在成員勾了「接受群組訊息」而且有指定帳號名單時才處理；頻道等其他類型一律不理
    if (msg.chat.type !== 'private' && !(inGroup && agent.telegram && agent.telegram.groups && (agent.telegram.userIds || []).length)) return;
    if (msg.from.is_bot) return;
    const userId = String(msg.from.id), chatId = msg.chat.id;
    const paired = ((ctx.config.telegram || {}).allowedUserIds || []).map(String);
    const only = ((agent.telegram && agent.telegram.userIds) || []).map(String);
    // 只接受已配對（主 bot 配對過）且在名單內的帳號；其他人一律不回應（群組裡也不回，免得洗版）
    if (!paired.includes(userId) || (only.length && !only.includes(userId))) {
      console.log('⚠️  Telegram（' + agent.name + ' 專屬 bot）：不處理未授權的帳號 ' + userId + (inGroup ? '（群組 ' + chatId + '）' : ''));
      return;
    }
    let text = String(msg.text || msg.caption || '').trim();
    // 群組裡「@bot名稱 午餐 120」→ 拿掉開頭的 @bot名稱
    if (inGroup && myName) text = text.replace(new RegExp('^@' + myName.replace(/[^\w]/g, '') + '\\b[\\s,，:：]*', 'i'), '').trim();
    // 群組裡沒有文字也沒有附件（有人加入、改群組名稱、貼圖…）→ 不理
    if (inGroup && !text && !msg.photo && !msg.document) return;
    const cmd = !msg.photo && !msg.document && text.match(/^\/(\w+)(?:@(\w+))?\s*$/);
    // 群組裡「/new@別的bot」是給別的 bot 的
    if (cmd && inGroup && cmd[2] && myName && cmd[2].toLowerCase() !== myName.toLowerCase()) return;
    if (cmd) {
      const name = cmd[1].toLowerCase();
      if (name === 'start' || name === 'help') return cl.say(chatId, labelOf(agent) + (inGroup ? ' 在這個群組\n\n直接傳文字或照片給它（名單內的帳號才會處理），它會知道是誰傳的，回覆會傳回這個群組。' : ' 的專屬聊天\n\n直接傳文字或照片給它，回覆會傳回這裡。') + '\n/new　開新對話（忘掉前面的內容）\n/stop　停止它目前的工作');
      if (name === 'new') return cl.say(chatId, ctx.resetAgent(agent.id) ? '🆕 已開新對話' : '它正在工作，請先 /stop');
      if (name === 'stop') { ctx.stopRun(agent.id); return cl.say(chatId, '⏹ 已停止'); }
    }
    await toStandalone(ctx, cl, agent, text, msg, id);
  }

  (async function poll() {
    let lastErr = '';
    try {
      const me = await cl.call('getMe', {});
      Object.assign(status, { state: 'connected', username: me.username, error: '' }); changed(); myName = me.username || '';
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
        if (status.state !== 'connected') { try { const me = await cl.call('getMe', {}); Object.assign(status, { state: 'connected', username: me.username, error: '' }); changed(); myName = me.username || ''; } catch {} }
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

  return { token, status, stop() { alive = false; ac.abort(); ctx.hooks.off('done', onDone); if (ctx.outbox) ctx.outbox.unregister('tg:' + id, cl.resend); } };
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
  session = { stop() { alive = false; ac.abort(); for (const [e, f] of listeners) ctx.hooks.off(e, f); if (ctx.outbox) ctx.outbox.unregister('tg:main', resend); } };
  setStatus({ state: 'connecting', error: '' });

  const API = apiBase() + '/bot' + token;
  const cl = makeClient(token, ac.signal, ctx, 'tg:main', 'Telegram');
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

  const { say, resend } = makeSay(call, ctx, 'tg:main', 'Telegram');
  if (ctx.outbox) ctx.outbox.register('tg:main', resend);

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

  const fmtHm = (t) => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }); };
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
    const ag = (u.agy || []).map((a) => '　' + a.name + '：' + a.runs + ' 輪、' + a.tokens + ' tokens' +
      (a.out && a.out.until > now ? '（🪫 額度用完，預計 ' + fmtHm(a.out.until) + (a.out.estimated ? '（推估）' : '') + ' 恢復）' : ''));
    return '📊 用量額度\n\n' + block('Claude', u.claude) + '\n\n' + block('Codex', u.codex) + (ag.length ? '\n\nagy 本週（週一起，沒有剩餘額度可查）\n' + ag.join('\n') : '');
  }

  const teamOfTask = (t) => (ctx.config.teams || []).find((x) => x.id === t.teamId) || (ctx.config.teams || [])[0];
  function taskStatusText() {
    const list = ctx.tasks.actives();
    if (!list.length) {
      const last = ctx.tasks.list()[0];
      return '目前沒有進行中的任務。' + (last ? '\n最近一件：#' + last.id + ' ' + last.title + '（' + last.statusText + '）' : '') + '\n用 /task 目標 開始新任務';
    }
    return list.map((t) => {
      const team = teamOfTask(t);
      const line = team.workflow.stages.map((s) => (s.id === t.stageId ? '▶' : t.done.includes(s.id) ? '✅' : '○') + s.name).join(' → ');
      let msg = '📋 ' + (team.icon || '') + team.name + '｜任務 #' + t.id + '：' + t.title + '\n狀態：' + t.statusText + '｜交接 ' + t.turns + ' 次\n' + line;
      if (t.status === 'awaiting_approval') msg += '\n等你核准：/approve' + (list.length > 1 ? ' #' + t.id : '') + ' 或 /reject' + (list.length > 1 ? ' #' + t.id : '') + ' 意見';
      if (t.status === 'waiting_user') msg += '\n等你回覆：' + (list.length > 1 ? '#' + t.id + ' 加上回覆內容' : '直接打字即可');
      return msg;
    }).join('\n\n');
  }
  // 從指令參數找出要操作的任務：可以寫 #編號；沒寫時，符合狀態的只有一件就用那件
  function pickTask(arg, statuses, what) {
    const m = String(arg || '').match(/^\s*#(\d+)\s*([\s\S]*)$/);
    const list = ctx.tasks.actives().filter((t) => !statuses || statuses.includes(t.status));
    if (m) {
      const t = list.find((x) => x.id === Number(m[1]));
      return t ? { t, rest: m[2].trim() } : { err: '任務 #' + m[1] + ' 目前沒有' + what + '。' };
    }
    if (!list.length) return { err: '目前沒有' + what + '的任務。' };
    if (list.length > 1) return { err: '有 ' + list.length + ' 件任務' + what + '，請加上 #編號：\n' + list.map((t) => '#' + t.id + ' ' + (teamOfTask(t).name) + '：' + t.title).join('\n') };
    return { t: list[0], rest: String(arg || '').trim() };
  }

  // 任務事件推送（開始、等核准、等回覆、完成、停止、出錯）
  listen('task', async ({ task, event, message }) => {
    if (!event || event === 'handoff' || event === 'checking') return;
    const chats = pushRecipients();
    const head = { started: '📋', awaiting_approval: '🔔 需要你核准', waiting_user: '⏳ 等你回覆', done: '🎉 任務完成',
      stopped: '⏹', error: '⚠️ 任務暫停', rejected: '↩️', budget: '⏸ 超出預算', checks_failed: '🧪 自動檢查沒通過' }[event] || '📋';
    const team = teamOfTask(task);
    let body = head + '（' + (team ? team.name + '・' : '') + '任務 #' + task.id + '）\n' + (message || '');
    const many = ctx.tasks.actives().length > 1, tag = many ? ' #' + task.id : '';
    if (event === 'awaiting_approval') body += '\n\n👉 /approve' + tag + ' 核准，或 /reject' + tag + ' 意見 退回';
    if (event === 'waiting_user' || event === 'error' || event === 'budget') body += '\n\n👉 ' + (many ? '#' + task.id + ' 加上回覆內容' : '直接打字回覆') + '，或 /cancel' + tag + ' 停止任務';
    for (const id of chats) await say(id, body);
  });

  // 新的守則建議（要到網頁的 🧭 Harness 核准）
  // 重新啟動完成：通知當初按下 /update、/restart 的聊天室
  listen('restarted', async ({ chatId, text, version, failed }) => {
    if (!chatId) return;
    if (failed && failed.failedAt && Date.now() - failed.failedAt < 300000) await say(chatId, '⚠️ 新版本無法啟動，已自動退回原本的版本 v' + (failed.fromVersion || version) + '。可以傳 /report 產生問題回報給 Claude 看。');
    else await say(chatId, '✅ ' + (text || '重新啟動') + '完成，現在是 v' + version);
  });
  // ⚡ 緊急派工
  listen('urgent', async ({ from, to, status, reason }) => {
    const text = status === 'interrupted' ? '⚡ ' + label(from) + ' 緊急插話給 ' + label(to) + '，它先暫停手上的事處理，之後會回頭做原本的工作'
      : '⚡ ' + label(from) + ' 想緊急插話給 ' + label(to) + '，但改為排隊：' + reason;
    for (const id of pushRecipients()) await say(id, text);
  });
  // ⏸ 專案暫停完成／▶ 重啟
  listen('paused', async ({ label: lb, rec }) => {
    for (const id of pushRecipients()) await say(id, '⏸ ' + lb + '已暫停' + (rec.reason ? '（' + rec.reason + '）' : '') + '：' +
      (rec.notes ? rec.notes + ' 份交班筆記已存好，' : '') + (rec.restart && rec.restart.length ? rec.restart.length + ' 件做到一半的工作會在重啟後接著做，' : '') + '新的派工與排程都先排隊。\n👉 /resume 重啟（後面可以加一句給大家的指示）');
  });
  listen('resume', async ({ label: lb, minutes, restarted, held, text }) => {
    for (const id of pushRecipients()) await say(id, '▶ ' + lb + '已重啟（暫停了 ' + minutes + ' 分鐘）：' + (restarted ? restarted + ' 位成員接著做被停下的工作，' : '') + (held ? '放行 ' + held + ' 則排隊的訊息' : '沒有排隊的訊息') + (text ? '\n補充指示：' + text : ''));
  });
  // 🧩 Skill 安裝申請：下載檢查完成，等你核准
  listen('skill-request', async ({ req }) => {
    const rv = req.review || {};
    const lines = ['🧩 Skill 安裝申請 #' + req.id + '：' + (req.title || req.name),
      '來源：github.com/' + req.source + (req.from && ctx.agentById(req.from) ? '（' + ctx.agentById(req.from).name + ' 提出）' : ''),
      req.description ? '說明：' + req.description.slice(0, 200) : '',
      '安裝到：' + req.targetLabel,
      '內容：' + rv.fileCount + ' 個檔案、' + Math.max(1, Math.round((rv.bytes || 0) / 1024)) + ' KB',
      rv.scripts && rv.scripts.length ? '⚠️ 含可執行的腳本 ' + rv.scripts.length + ' 個：' + rv.scripts.slice(0, 5).join('、') + (rv.scripts.length > 5 ? '…' : '') : '✅ 沒有可執行的腳本',
      req.exists ? '⚠️ 同名的 Skill 已經存在，要到網頁勾「取代現有的」才能裝' : '',
      '', '核准：/skill ' + req.id + ' ok　拒絕：/skill ' + req.id + ' no（網頁「🧰 CLI 狀態 → 🧩 Skill」可以看完整檔案清單）'];
    for (const id of pushRecipients()) await say(id, lines.filter((x) => x !== '').join('\n'));
  });
  listen('skill-installed', async ({ req }) => {
    for (const id of pushRecipients()) await say(id, '✅ Skill「' + (req.title || req.name) + '」已安裝到' + req.targetLabel + '，相關成員下一輪就能用');
  });
  // 🪫 agy 額度用完：暫停自動派工，等恢復
  listen('agy-quota', async ({ agent, until, estimated, usage }) => {
    for (const id of pushRecipients()) await say(id, '🪫 ' + label(agent) + ' 的 agy 額度用完了，預計 ' + fmtHm(until) + (estimated ? '（推估）' : '') + ' 恢復。\n本週用了 ' + usage.runs + ' 輪、' + usage.tokens + ' tokens。\n在那之前同事轉交、任務、排程不會交給它（會通知派工的人改派）；你直接傳訊息給它會再試一次，成功就自動解除。');
  });
  listen('agy-quota-ok', async ({ agent }) => {
    for (const id of pushRecipients()) await say(id, '🔋 ' + label(agent) + ' 的 agy 額度恢復了，可以正常派工');
  });
  // 🚨 唯讀成員（agy）竟然改了檔案：已自動暫停
  listen('readonly-violation', async ({ agent, changes }) => {
    const list = changes.slice(0, 8).map((c) => (c.kind === 'add' ? '＋' : c.kind === 'del' ? '－' : '～') + c.path).join('、');
    for (const id of pushRecipients()) await say(id, '🚨 ' + label(agent) + ' 是唯讀成員，但資料夾裡有檔案被改了：' + list + '\n唯讀限制沒有擋住，已先暫停這位成員。請確認檔案後，到網頁「⚙️ 設定」按儲存解除。');
  });
  // ⏰ 排程：只有異常、失敗（或設定為每次都通知）才會到這裡
  listen('timer-alert', async ({ timer, agent, status, summary }) => {
    if (status === 'paused') {
      for (const id of pushRecipients()) await say(id, '⏸ 排程「' + timer.name + '」先暫停了（' + (agent ? agent.name : '') + '：' + summary + '）\n有新任務開始時會自動恢復；要現在恢復請傳 /timer ' + timer.id + ' on');
      return;
    }
    const icon = status === 'failed' ? '❌' : status === 'ok' ? '✅' : '🔔';
    for (const id of pushRecipients()) await say(id, icon + ' 排程「' + timer.name + '」（' + (agent ? agent.name : '') + '）' + (status === 'failed' ? '失敗' : '') + '：\n' + summary +
      '\n\n想看完整內容就切到 ' + (agent ? agent.name : '那位成員') + '（/to ' + (agent ? agent.name : '') + '），或傳 /timers 看所有排程');
  });
  listen('md-proposal', async ({ proposal: p }) => {
    for (const id of pushRecipients()) await say(id, '📝 ' + p.byName + ' 提出修改提案 #' + p.id + '：' + p.file + '（＋' + p.add + ' －' + p.del + ' 行）' + (p.reason ? '\n原因：' + p.reason : '') +
      '\n\n' + p.diff + '\n\n核准請傳 /md ' + p.id + ' ok，不要請傳 /md ' + p.id + ' no（核准後才會寫入，舊版會備份）');
  });
  listen('timer-proposal', async ({ proposal, agent, desc }) => {
    for (const id of pushRecipients()) await say(id, '⏰ ' + (agent ? agent.name : '成員') + ' 建議新增排程（#' + proposal.id + '）：\n' + desc + '｜' + proposal.prompt +
      '\n\n同意請傳 /timer ' + proposal.id + ' ok，不要請傳 /timer ' + proposal.id + ' no（也可以到網頁「⏰ 排程」修改後再核准）');
  });
  listen('proposal', async ({ proposal, fromName, scopeLabel }) => {
    for (const id of pushRecipients()) await say(id, '💡 新的守則建議（' + fromName + (proposal.taskId ? '，任務 #' + proposal.taskId : '') + '）：\n' + proposal.text + (scopeLabel ? '\n（預設只給 ' + scopeLabel + ' 遵守）' : '') + '\n\n請到網頁的「🧭 Harness」核准或略過。');
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
    const line = (a) => (a.id === targetOf(c).id ? '👉 ' : '　 ') + label(a) + (ctx.runs.has(a.id) ? ' ⏳工作中' : '') +
      '\n　　' + [a.role, [a.model || a.engine, a.effort].filter(Boolean).join(' · ')].filter(Boolean).join('｜');
    const groups = (ctx.config.teams || []).map((tm) => ({ title: (tm.icon || '') + ' ' + tm.name, list: ctx.agents.filter((a) => !a.standalone && a.team === tm.id) }));
    groups.push({ title: '🧍 獨立成員', list: ctx.agents.filter((a) => a.standalone) });
    return groups.filter((g) => g.list.length).map((g) => g.title + '\n' + g.list.map(line).join('\n')).join('\n\n') +
      '\n\n目前對象：' + label(targetOf(c)) + '\n用 /to 名字 切換';
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
        case 'pause': case 'pausenow': {
          if (!ctx.pauseProject) return say(chatId, '這個版本沒有暫停功能');
          try {
            const st = ctx.pauseProject('all', { mode: name.toLowerCase() === 'pausenow' ? 'now' : 'finish', reason: (arg || '').trim(), via: 'telegram' });
            const p = st.pauses.find((x) => x.scope === 'all') || {};
            if (p.phase === 'paused') return; // 馬上就停好了：上面的「已暫停」通知會告訴你
            return say(chatId, '⏸ 暫停中：' + (p.working && p.working.length ? p.working.join('、') + (name.toLowerCase() === 'pausenow' ? ' 立刻停下' : ' 做完這一輪就停') + '，' : '') + '大家寫好交班筆記後會再通知你');
          } catch (e) { return say(chatId, '⚠️ ' + e.message); }
        }
        case 'resume': {
          if (!ctx.resumeProject) return say(chatId, '這個版本沒有暫停功能');
          try { ctx.resumeProject(null, { text: (arg || '').trim(), via: 'telegram' }); return; } catch (e) { return say(chatId, '⚠️ ' + e.message); }
        }
        case 'new': {
          const a = targetOf(c);
          return say(chatId, ctx.resetAgent(a.id) ? '🆕 ' + label(a) + ' 已開新對話' : a.name + ' 工作中，請先 /stop');
        }
        case 'usage': return say(chatId, usageText());
        case 'fb': {
          const fbx = ctx.feedback; if (!fbx) return say(chatId, '錯誤回報功能還沒啟動');
          const ST = { open: '🔴 未處理', doing: '🟡 處理中', done: '✅ 已解決' };
          const mm = arg.trim().match(/^#?(\d+)(?:\s+(open|doing|done|未處理|處理中|已解決))?(?:\s+([\s\S]+))?$/i);
          const when = (ts) => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
          if (!mm) {
            const all = fbx.all(), todo = all.filter((f) => f.status !== 'done').reverse();
            if (!todo.length) return say(chatId, all.length ? '🐞 錯誤回報都處理完了（共 ' + all.length + ' 則）。' : '目前沒有錯誤回報。');
            return say(chatId, '🐞 還沒解決的錯誤回報（' + todo.length + ' 則）：\n' + todo.slice(0, 15).map((f) => '#' + f.id + ' ' + ST[f.status] + ' ' + when(f.ts) + ' ' + f.who + '→' + f.agentName + '：' + f.text.slice(0, 60)).join('\n') +
              (todo.length > 15 ? '\n…還有 ' + (todo.length - 15) + ' 則（網頁「🐞 錯誤回報」看全部）' : '') + '\n\n/fb 編號 看內容｜/fb 編號 done 備註 標成已解決');
          }
          try {
            if (!mm[2]) {
              const f = fbx.all().find((x) => x.id === Number(mm[1])); if (!f) return say(chatId, '⚠️ 找不到錯誤回報 #' + mm[1]);
              return say(chatId, '🐞 #' + f.id + ' ' + ST[f.status] + (f.note ? '（' + f.note + '）' : '') + '\n' + when(f.ts) + '｜' + f.via + '｜' + f.who + ' → ' + f.agentName + '\n回報：' + f.text +
                (f.lastReply ? '\n\nbot 當時的回覆：\n' + f.lastReply.slice(0, 1500) : '') + '\n\n/fb ' + f.id + ' done 備註｜/fb ' + f.id + ' doing');
            }
            const key = { 未處理: 'open', 處理中: 'doing', 已解決: 'done' }[mm[2]] || mm[2].toLowerCase();
            const f = fbx.set(mm[1], key, mm[3]);
            return say(chatId, '已把錯誤回報 #' + f.id + ' 標成 ' + ST[f.status] + (f.note ? '（' + f.note + '）' : ''));
          } catch (e) { return say(chatId, '⚠️ ' + e.message); }
        }
        case 'md': {
          const mt = ctx.maint && ctx.maint(); if (!mt) return say(chatId, '維運功能還沒啟動');
          const mm = arg.trim().match(/^#?(\d+)(?:\s+(ok|no))?$/i);
          if (!mm) { const ps = mt.pending(); return say(chatId, ps.length ? '📝 等你核准的設定檔修改：\n' + ps.map((p) => '#' + p.id + ' ' + p.byName + '→' + p.file + '（＋' + p.add + ' －' + p.del + '）' + (p.reason ? '：' + p.reason : '')).join('\n') + '\n\n/md 編號 看內容｜/md 編號 ok 核准｜/md 編號 no 不採用' : '目前沒有等你核准的設定檔修改。'); }
          try {
            if (!mm[2]) { const p = mt.full(mm[1]); return say(chatId, '📝 #' + p.id + ' ' + p.byName + '→' + p.file + (p.reason ? '\n原因：' + p.reason : '') + '\n\n改了這些：\n' + p.diff + '\n\n/md ' + p.id + ' ok 核准｜/md ' + p.id + ' no 不採用'); }
            const r = mt.resolve(mm[1], /^ok$/i.test(mm[2]), '你（Telegram）');
            return say(chatId, r.ok ? '✅ 已寫入 ' + r.proposal.file + '（舊版已備份），下一則訊息就生效' : '🚫 不採用修改提案 #' + r.proposal.id);
          } catch (e) { return say(chatId, '⚠️ ' + e.message); }
        }
        case 'timers': {
          const snap = ctx.timers.snapshot();
          if (!snap.timers.length && !snap.proposals.length) return say(chatId, '目前沒有排程。可以在網頁左下角「⏰ 排程」新增，或請成員用【排程建議】提出。');
          const fmtT = (ts) => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
          const st = { ok: '✅', alert: '🔔', failed: '❌', stopped: '⏹', interrupted: '⚠️' };
          const lines = snap.timers.map((t) => (t.enabled ? '▶️' : '⏸') + ' #' + t.id + ' ' + t.name + '（' + t.agentName + '）\n   ' + t.desc +
            (t.enabled && t.nextRun ? '｜下次 ' + fmtT(t.nextRun) : '') + (t.last ? '\n   上次 ' + fmtT(t.last.at) + ' ' + (st[t.last.status] || '') + ' ' + (t.last.summary || '').slice(0, 60) : ''));
          if (snap.proposals.length) lines.push('', '待核准的建議：', ...snap.proposals.map((p) => '#' + p.id + ' ' + p.agentName + '：' + p.desc + '｜' + p.prompt.slice(0, 60) + (p.precheck ? '｜先檢查：' + p.precheck : '')));
          return say(chatId, '⏰ 排程\n' + lines.join('\n') + '\n\n/timer 編號 run 立即執行｜on／off 開關｜ok／no 核准或略過建議');
        }
        case 'timer': {
          const m = arg.trim().match(/^#?(\d+)\s+(run|on|off|ok|no)$/i);
          if (!m) return say(chatId, '用法：/timer 編號 run（立即執行）、on／off（開關）、ok／no（核准或略過成員的建議）');
          const [, id, act] = m;
          try {
            if (/^ok$/i.test(act)) { const t = ctx.timers.acceptProposal(id); return say(chatId, '✅ 已新增排程 #' + t.id + '「' + t.name + '」：' + ctx.timers.describe(t)); }
            if (/^no$/i.test(act)) { ctx.timers.dismissProposal(id); return say(chatId, '已略過這個建議'); }
            if (/^run$/i.test(act)) { const r = ctx.timers.runNow(id); return say(chatId, r === 'skipped' ? '上一次還沒做完，先略過' : '▶️ 已觸發，做完有異常會通知你'); }
            const t = ctx.timers.setEnabled(id, /^on$/i.test(act));
            return say(chatId, (t.enabled ? '▶️ 已開啟' : '⏸ 已暫停') + '「' + t.name + '」');
          } catch (e) { return say(chatId, '⚠️ ' + e.message); }
        }
        case 'report': {
          await say(chatId, '🐞 正在整理問題回報…');
          try {
            const r = await ctx.makeReport({ description: arg.trim(), via: 'Telegram', agentId: targetOf(c).id });
            await sendMedia(chatId, r.file);
            return say(chatId, '已產生 ' + r.name + '（也存在電腦的 data/reports）。把這個檔案轉傳或拖進 Claude 的對話就能排查；密碼和 token 已經遮掉了。');
          } catch (e) { return say(chatId, '⚠️ 產生回報失敗：' + e.message); }
        }
        case 'update': case 'restart': {
          const up = ctx.updater;
          const busy = ctx.agents.filter((a) => ctx.runs.has(a.id)).map((a) => a.name);
          const running = ctx.tasks.actives().filter((t) => t.status === 'running').length;
          const sure = /^(yes|y|確定|ok)$/i.test(arg.trim());
          if (name.toLowerCase() === 'update') {
            await say(chatId, '🔍 檢查更新中…');
            const ck = await up.check();
            if (!ck.ok) return say(chatId, '⚠️ ' + ck.error);
            if (!ck.behind) return say(chatId, '✅ 已經是最新版 v' + ck.version);
            const what = '⬆️ 有新版本' + (ck.remoteVersion ? ' v' + ck.remoteVersion : '') + '（目前 v' + ck.version + '）：\n' + ck.commits.slice(0, 8).map((x) => '• ' + x.replace(/^\w+ /, '')).join('\n');
            if ((busy.length || running) && !sure) return say(chatId, what + '\n\n⚠️ ' + (busy.length ? busy.join('、') + ' 正在工作' : '有任務進行中') + '，重新啟動會中斷（任務會暫停，之後可以繼續）。確定要更新請傳 /update yes');
            await say(chatId, what + '\n\n更新中…');
            try {
              const r = await up.update('Telegram');
              up.restart({ chatId, text: '更新' });
              return say(chatId, '🔄 已更新到 ' + (r.toVersion ? 'v' + r.toVersion : r.to) + (r.moved && r.moved.length ? '（start.bat 的設定已搬到 local-settings.txt）' : '') + '，重新啟動中，好了會通知你。');
            } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          }
          if ((busy.length || running) && !sure) return say(chatId, '⚠️ ' + (busy.length ? busy.join('、') + ' 正在工作' : '有任務進行中') + '，重新啟動會中斷（任務會暫停，之後可以繼續）。確定請傳 /restart yes');
          try { up.restart({ chatId, text: '重新啟動' }); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return say(chatId, '🔄 重新啟動中，好了會通知你。');
        }
        case 'task': {
          if (!arg.trim()) return say(chatId, '用法：/task 任務目標\n例如：/task 做一個讀 CSV 算平均值的 Python 小工具\n指定小組：/task 小組名 目標');
          // 第一個詞是小組名稱 → 交給那個小組；否則交給目前對象所在的小組
          const teams = ctx.config.teams || [];
          const first = arg.trim().split(/\s+/)[0];
          let team = teams.find((x) => x.name === first || (x.icon || '') + x.name === first);
          let goal = team ? arg.trim().slice(first.length).trim() : arg;
          if (!team) team = teams.find((x) => x.id === targetOf(c).team) || teams[0];
          if (!goal) return say(chatId, '請在小組名稱後面寫任務目標');
          try { ctx.tasks.start(goal, 'telegram', team && team.id); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return;
        }
        case 'status': case 'tasks': return say(chatId, taskStatusText());
        case 'skills': {
          const snap = ctx.skills.snapshot();
          const list = snap.requests.filter((r) => ['ready', 'choose', 'fetching', 'failed'].includes(r.status)).slice(0, 8);
          if (!list.length) return say(chatId, '目前沒有 Skill 安裝申請。請成員幫你找 Skill，它會用【安裝 Skill】提出申請。');
          const ST = { ready: '等你核准', choose: '要在網頁選擇裝哪一個', fetching: '下載檢查中', failed: '失敗' };
          return say(chatId, '🧩 Skill 安裝申請\n' + list.map((r) => '#' + r.id + ' ' + (r.title || r.source) + '（' + ST[r.status] + (r.error ? '：' + r.error : '') + '）').join('\n') + '\n\n/skill 編號 ok 核准、/skill 編號 no 拒絕');
        }
        case 'skill': {
          const m = /^#?(\d+)\s+(ok|yes|no)\b/i.exec(arg || '');
          if (!m) return say(chatId, '用法：/skill 編號 ok（核准，會再問一次）或 /skill 編號 no（拒絕）');
          const r = ctx.skills.get(m[1]);
          if (!r) return say(chatId, '找不到 Skill 安裝申請 #' + m[1]);
          const act = m[2].toLowerCase();
          try {
            if (act === 'no') { ctx.skills.reject(r.id, 'telegram'); return say(chatId, '🚫 已拒絕 Skill 安裝申請 #' + r.id); }
            if (r.status !== 'ready') return say(chatId, '#' + r.id + ' 現在不能安裝（' + r.status + '）' + (r.error ? '：' + r.error : ''));
            if (act === 'ok') {
              c.skillConfirm = { id: r.id, at: Date.now() }; ctx.saveState();
              return say(chatId, '確定要安裝「' + (r.title || r.name) + '」到' + r.targetLabel + '？' + (r.review && r.review.scripts.length ? '\n⚠️ 它含 ' + r.review.scripts.length + ' 個可執行的腳本。' : '') + '\n確定請在 2 分鐘內傳：/skill ' + r.id + ' yes');
            }
            if (!c.skillConfirm || c.skillConfirm.id !== r.id || Date.now() - c.skillConfirm.at > 120000) return say(chatId, '請先傳 /skill ' + r.id + ' ok，再在 2 分鐘內確認');
            delete c.skillConfirm; ctx.saveState();
            ctx.skills.approve(r.id, { by: 'telegram' });
            return;
          } catch (e) { return say(chatId, '⚠️ ' + e.message); }
        }
        case 'approve': {
          const r = pickTask(arg, ['awaiting_approval'], '在等核准');
          if (r.err) return say(chatId, r.err);
          try { ctx.tasks.approve(r.t.id, r.rest); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return say(chatId, '✅ 已核准任務 #' + r.t.id);
        }
        case 'reject': {
          const r = pickTask(arg, ['awaiting_approval'], '在等核准');
          if (r.err) return say(chatId, r.err);
          if (!r.rest) return say(chatId, '請附上意見，例如：/reject 驗收標準要寫清楚輸出格式');
          try { ctx.tasks.reject(r.t.id, r.rest); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return;
        }
        case 'note': {
          const r = pickTask(arg, null, '在進行');
          if (r.err) return say(chatId, r.err);
          if (!r.rest) return say(chatId, '用法：/note 指示內容（多件任務時：/note #編號 指示內容）');
          try { ctx.tasks.addNote(r.t.id, r.rest, 'telegram'); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
          return say(chatId, '📌 已加入任務 #' + r.t.id + ' 的指示，之後每一輪都會看到');
        }
        case 'later': {
          if (!arg.trim()) return say(chatId, '用法：/later 訊息');
          const a = targetOf(c);
          ctx.dispatch(a, arg.trim(), { via: 'telegram' });
          return say(chatId, '🕒 已排隊，' + label(a) + ' 做完這輪就會收到');
        }
        case 'cancel': {
          const r = pickTask(arg, null, '在進行');
          if (r.err) return say(chatId, r.err);
          try { ctx.tasks.stop(r.t.id); } catch (e) { return say(chatId, '⚠️ ' + e.message); }
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
    // 開頭寫 #編號 → 指定那件任務（等回覆就回覆，進行中就插話給正在做的成員）
    const all = ctx.tasks.actives();
    const hash = text.match(/^#(\d+)\s+([\s\S]+)$/);
    let t = null, body = text;
    if (hash) {
      t = all.find((x) => x.id === Number(hash[1]));
      if (!t) return say(chatId, '任務 #' + hash[1] + ' 不是進行中的任務。\n\n' + taskStatusText());
      body = hash[2].trim();
    }
    // 任務正在等使用者回覆 → 這則訊息就是回覆（同時有好幾件在等時，要寫 #編號）
    const waiting = all.filter((x) => x.status === 'waiting_user' || x.status === 'error');
    if (!t && !at && waiting.length === 1) t = waiting[0];
    else if (!t && !at && waiting.length > 1) return say(chatId, '有 ' + waiting.length + ' 件任務在等你回覆，請在開頭加 #編號：\n' + waiting.map((x) => '#' + x.id + ' ' + teamOfTask(x).name + '：' + x.title).join('\n'));
    if (t && (t.status === 'waiting_user' || t.status === 'error')) {
      try { ctx.tasks.reply(t.id, await prep(ctx.agentById(t.waitingFor) || targetOf(c), body), 'telegram'); return say(chatId, '✅ 已回覆任務 #' + t.id + '，任務繼續'); }
      catch (e) { return say(chatId, '⚠️ ' + e.message); }
    }

    // 開頭寫 @名字 → 直接交給那位，不切換對象
    let agent = targetOf(c);
    if (atAgent) agent = atAgent;
    // 任務進行中、沒有指定對象：插話給正在工作的成員（只看目前對象所在小組的任務，或 #編號 指定的任務）
    const rt = t && t.status === 'running' ? t : !at ? all.find((x) => x.status === 'running' && x.teamId === targetOf(c).team) : null;
    if (rt) {
      const st = teamOfTask(rt).workflow.stages.find((x) => x.id === rt.stageId);
      const w = (st && ctx.runs.has(st.owner) && ctx.agentById(st.owner)) || ctx.agents.find((a) => ctx.runs.has(a.id) && a.team === teamOfTask(rt).id);
      if (w) agent = w;
    }
    // 對象正在工作 → 插話（中斷這一輪，帶著指示繼續）
    const full = await prep(agent, body);
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
  listen('done', async ({ agent, tg, segments, relayTo, shift, pauseNote }) => {
    // 獨立成員：只回到傳訊息來的那個聊天（網頁上的對話、專屬 bot 的對話不推到這裡）
    if (agent.standalone) {
      if (tg && tg.bot === 'main' && !shift) await sendReply(cl, tg.chatId, agent, segments, true);
      return;
    }
    const chats = pushRecipients();
    if (!chats.length || !segments.length) return;
    if (pauseNote) return; // 專案暫停的交班筆記：全部寫好後會一起通知
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
