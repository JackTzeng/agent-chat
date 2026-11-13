// Telegram 遙控：用手機傳訊息給 agent，agent 的回覆也會推送到 Telegram
// 設定在 agents.json 的 "telegram" 區塊，或用環境變數 TELEGRAM_BOT_TOKEN
'use strict';
const fs = require('fs');
const path = require('path');

const HELP =
  '🤖 Agent Chat 遙控\n\n' +
  '📋 任務（依照工作流程交接）\n' +
  '/task 目標　開始新任務\n' +
  '/status　目前任務的進度\n' +
  '/approve [補充]　核准交接\n' +
  '/reject 意見　退回修改\n' +
  '/cancel　停止目前任務\n' +
  '任務在等你回覆時，直接打字就會回給那位成員\n\n' +
  '💬 自由聊天\n' +
  '直接打字：交給目前的對象\n' +
  '@名字 訊息：交給指定成員（不切換對象）\n\n' +
  '/list　成員與狀態\n' +
  '/to 名字　切換對象\n' +
  '/stop　全部停止\n' +
  '/new　目前對象開新對話\n' +
  '/usage　Claude / Codex 用量額度\n' +
  '/mute　暫停推送（/unmute 恢復）\n' +
  '/help　顯示這份說明';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const VIDEO_EXT = ['.mp4', '.mov', '.webm'];

exports.start = function start(ctx) {
  const cfg = ctx.config.telegram || {};
  const token = process.env.TELEGRAM_BOT_TOKEN || cfg.botToken;
  if (!token || cfg.enabled === false) return;

  const API = (process.env.TELEGRAM_API || 'https://api.telegram.org') + '/bot' + token;
  const allowed = (cfg.allowedUserIds || []).map(String);
  const tg = (ctx.state.telegram = ctx.state.telegram || { offset: 0, chats: {} });
  const defaultTarget = () => (ctx.agentById(cfg.defaultAgent) || ctx.agents[0]).id;
  // 成員可能在網頁上被刪除，找不到時退回第一位
  const targetOf = (c) => ctx.agentById(c.target) || ctx.agents[0];
  const label = (a) => (a.avatar && !a.avatar.startsWith('img:') ? a.avatar : '👤') + ' ' + a.name;

  async function call(method, body, isForm) {
    const r = await fetch(API + '/' + method, isForm
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
      const src = decodeURI(m[1]);
      if (/^(https?:|data:)/i.test(src)) continue;
      const f = path.resolve(agent.cwd, src);
      const rel = path.relative(agent.cwd, f);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      try { if (fs.statSync(f).size < 20e6 && !out.includes(f)) out.push(f); } catch {}
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
  ctx.hooks.on('task', async ({ task, event, message }) => {
    if (!event || event === 'handoff') return;
    const chats = Object.keys(tg.chats).filter((id) => !tg.chats[id].muted);
    const head = { started: '📋', awaiting_approval: '🔔 需要你核准', waiting_user: '⏳ 等你回覆', done: '🎉 任務完成',
      stopped: '⏹', error: '⚠️ 任務暫停', rejected: '↩️' }[event] || '📋';
    let body = head + '（任務 #' + task.id + '）\n' + (message || '');
    if (event === 'awaiting_approval') body += '\n\n👉 /approve 核准，或 /reject 意見 退回';
    if (event === 'waiting_user' || event === 'error') body += '\n\n👉 直接打字回覆，或 /cancel 停止任務';
    for (const id of chats) await say(id, body);
  });

  function chat(chatId) {
    if (!tg.chats[chatId]) { tg.chats[chatId] = { target: defaultTarget(), muted: false }; ctx.saveState(); }
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
    if (!msg || !msg.from) return;
    const chatId = msg.chat.id, userId = String(msg.from.id);
    if (!allowed.includes(userId)) {
      console.log('⚠️  Telegram：拒絕未授權的使用者 ' + userId + (msg.from.username ? '（@' + msg.from.username + '）' : ''));
      return say(chatId, '⛔ 你沒有使用權限。\n你的 Telegram user id 是：' + userId +
        '\n如果這是你本人，請把它加進 agents.json 的 telegram.allowedUserIds，再重開 start.bat。');
    }
    if (!msg.text) return say(chatId, '目前只支援文字訊息。');
    const c = chat(chatId);
    const text = msg.text.trim();
    const cmd = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);

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

    // 任務正在等使用者回覆 → 這則訊息就是回覆
    const t = ctx.tasks.active();
    if (t && (t.status === 'waiting_user' || t.status === 'error') && !/^@/.test(text)) {
      try { ctx.tasks.reply(t.id, text, 'telegram'); return say(chatId, '✅ 已回覆，任務繼續'); }
      catch (e) { return say(chatId, '⚠️ ' + e.message); }
    }

    // 開頭寫 @名字 → 直接交給那位，不切換對象
    let agent = targetOf(c);
    const at = text.match(/^@(\S+)\s*/);
    if (at) { const a = findAgent(at[1]); if (a) agent = a; }
    const busy = ctx.runs.has(agent.id);
    const cc = ctx.userSend(agent, text, 'telegram');
    await say(chatId, (busy ? '⏳ ' + label(agent) + ' 正在忙，已排隊' : '✅ 已交給 ' + label(agent)) +
      (cc.length ? '\n📢 也同時交給 ' + cc.map(label).join('、') : ''));
  }

  // agent 每做完一輪就推送結果
  ctx.hooks.on('done', async ({ agent, segments, relayTo }) => {
    const chats = Object.keys(tg.chats).filter((id) => !tg.chats[id].muted);
    if (!chats.length || !segments.length) return;
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
      console.log('📱 Telegram 已連線：@' + me.username + (allowed.length ? '（允許 ' + allowed.length + ' 位使用者）' : '（尚未設定 allowedUserIds，先傳訊息給 bot 取得你的 id）'));
    } catch (e) {
      console.error('⚠️  Telegram 連線失敗：' + e.message + (e.code === 401 ? '（botToken 不正確）' : '（網路可能擋了 api.telegram.org）'));
      if (e.code === 401) return;
    }
    for (;;) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        lastErr = '';
        for (const u of updates) {
          offset = u.update_id + 1;
          tg.offset = offset; ctx.saveState();
          handle(u.message).catch((e) => console.error('Telegram 處理訊息失敗：' + e.message));
        }
      } catch (e) {
        if (e.message !== lastErr) { console.error('⚠️  Telegram：' + e.message + '，5 秒後重試'); lastErr = e.message; }
        if (e.code === 401) return;
        await sleep(5000);
      }
    }
  })();
};
