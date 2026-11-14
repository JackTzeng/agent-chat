// 🏢 卡通虛擬辦公室：把每位成員畫成辦公室裡的角色，依照工作狀態移動與動作
// 全部用 Canvas 程式繪製（原創造型，不使用外部美術素材）
'use strict';
(function () {
  const W = 1000, H = 640;           // 場景的邏輯尺寸，畫布會等比例縮放
  const DESK_COLS = 4, DESK_W = 118, DESK_H = 46, ROW0 = 205, ROW_STEP = 150, COL0 = 50, COL_STEP = 152;
  const CORRIDORS = [150, 285, 435, 590];
  const PANTRY = { x: 690, y: 110, w: 290, h: 220 };
  const LOUNGE = { x: 690, y: 360, w: 290, h: 255 };
  const DOOR = { x: 340, y: 628 };
  const SHIRTS = ['#e07a5f', '#3d85c6', '#81b29a', '#f2cc8f', '#9b5de5', '#f28482', '#4ea8de', '#e9c46a', '#2a9d8f', '#b5838d'];
  const HAIRS = ['#3b2a20', '#1f1f1f', '#7a4b2a', '#c98b3c', '#5b3a6e', '#8a3324'];

  let canvas, ctx, api = null, running = false, lastT = 0, scale = 1, offX = 0, offY = 0;
  const chars = new Map();   // agentId -> 角色狀態
  const effects = [];        // 飛行文件、彩帶、愛心、閃電
  const imgCache = new Map();
  let hover = null;
  const cat = { x: 760, y: 560, tx: 760, ty: 560, wait: 2, sleep: 0, hearts: 0, face: 1 };

  const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------- 位置 ----------
  function deskPos(i) {
    const c = i % DESK_COLS, r = Math.floor(i / DESK_COLS);
    const x = COL0 + c * COL_STEP, y = ROW0 + r * ROW_STEP;
    return { x, y, seat: { x: x + DESK_W / 2, y: y + 22 } };
  }
  const IDLE_SPOTS = [
    { x: 745, y: 300, label: 'coffee' }, { x: 800, y: 300, label: 'coffee' }, { x: 880, y: 255, label: 'table' },
    { x: 930, y: 255, label: 'table' }, { x: 905, y: 300, label: 'table' }, { x: 760, y: 470, label: 'sofa' },
    { x: 815, y: 470, label: 'sofa' }, { x: 610, y: 585, label: 'plant' }, { x: 300, y: 585, label: 'window' },
    { x: 520, y: 150, label: 'board' },
  ];
  const BENCH = (i) => ({ x: 735 + (i % 5) * 50, y: 588 - Math.floor(i / 5) * 18 });

  // 走路路線：辦公區裡先走到「這一排桌子上方的走道」，要換排時走右側的通道（不穿過桌子）；茶水間與休息區可以直接走
  const HALL = 652;
  const inDesk = (p) => p.x < 645;
  function rowCorr(p) {
    if (p.y < ROW0 - 40) return p.y;
    const r = Math.max(0, Math.round((p.y - ROW0) / ROW_STEP));
    return Math.min(H - 30, ROW0 + r * ROW_STEP - 55);
  }
  function corridorPath(from, to) {
    if (!inDesk(from) && !inDesk(to)) return [{ x: to.x, y: to.y }];
    const pts = [];
    let cur = { x: from.x, y: from.y };
    if (inDesk(cur)) { const cy = rowCorr(cur); if (Math.abs(cy - cur.y) > 2) { cur = { x: cur.x, y: cy }; pts.push(cur); } }
    const ty = inDesk(to) ? rowCorr(to) : to.y;
    if (!(inDesk(to) && inDesk(cur) && Math.abs(cur.y - ty) < 2)) {
      pts.push({ x: HALL, y: cur.y }, { x: HALL, y: ty });
    }
    pts.push({ x: to.x, y: ty });
    if (Math.abs(ty - to.y) > 2) pts.push({ x: to.x, y: to.y });
    return pts;
  }

  // ---------- 角色 ----------
  function ensureChar(a, i) {
    let c = chars.get(a.id);
    if (!c) {
      const h = hash(a.id);
      const start = { x: DOOR.x + rand(-20, 20), y: DOOR.y };
      c = { id: a.id, x: start.x, y: start.y, path: [], mode: 'idle', spot: null, dwell: rand(1, 4), phase: rand(0, 6),
        shirt: SHIRTS[h % SHIRTS.length], hair: HAIRS[(h >> 3) % HAIRS.length], bubble: null, face: 1, sitting: false };
      chars.set(a.id, c);
    }
    c.agent = a; c.index = i; c.desk = deskPos(i);
    return c;
  }
  function goTo(c, target) {
    const last = c.path.length ? c.path[c.path.length - 1] : { x: c.x, y: c.y };
    if (Math.hypot(last.x - target.x, last.y - target.y) < 4) return;
    c.path = corridorPath({ x: c.x, y: c.y }, target);
    c.sitting = false;
  }
  function say(c, text, secs, kind) { c.bubble = { text: String(text || ''), until: performance.now() + (secs || 5) * 1000, kind: kind || 'talk' }; }

  function updateChar(c, dt, queueIndex) {
    const a = c.agent;
    let mode = a.busy ? 'work' : a.queued ? 'queue' : 'idle';
    if (mode !== c.mode) {
      c.mode = mode; c.spot = null; c.dwell = 0;
      if (mode === 'work') goTo(c, c.desk.seat);
      if (mode === 'queue') goTo(c, BENCH(queueIndex));
    }
    if (mode === 'queue' && !c.path.length) { const b = BENCH(queueIndex); if (Math.hypot(b.x - c.x, b.y - c.y) > 4) goTo(c, b); }
    if (mode === 'idle') {
      c.dwell -= dt;
      if (!c.path.length && c.dwell <= 0) {
        const spots = IDLE_SPOTS.filter((s) => ![...chars.values()].some((o) => o !== c && o.spot === s));
        c.spot = spots[Math.floor(Math.random() * spots.length)] || IDLE_SPOTS[0];
        goTo(c, c.spot); c.dwell = rand(6, 14);
        if (c.spot.label === 'coffee' && Math.random() < 0.5) say(c, '☕', 3, 'icon');
      }
    }
    // 走路
    if (c.path.length) {
      const p = c.path[0], dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy), step = (c.mode === 'work' ? 420 : c.mode === 'queue' ? 220 : 110) * dt;
      if (Math.abs(dx) > 1) c.face = dx > 0 ? 1 : -1;
      if (d <= step) { c.x = p.x; c.y = p.y; c.path.shift(); } else { c.x += (dx / d) * step; c.y += (dy / d) * step; }
      c.walking = true;
    } else c.walking = false;
    c.sitting = mode === 'work' && !c.path.length;
    c.phase += dt;
  }

  // ---------- 繪圖小工具 ----------
  function rr(x, y, w, h, r, fill, stroke) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  }
  function circle(x, y, r, fill, stroke) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  }
  function text(t, x, y, size, color, align, weight) {
    ctx.font = (weight || '600') + ' ' + size + 'px "Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif';
    ctx.fillStyle = color; ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y);
  }
  function emoji(e, x, y, size) {
    ctx.font = size + 'px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(e, x, y + 1);
  }
  const INK = '#3a2f2a';

  // ---------- 場景 ----------
  function skyColor() {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    if (h < 5 || h >= 20) return ['#1d2b53', '#2c3e70'];
    if (h < 7) return ['#f6b38e', '#9ec5e8'];
    if (h < 17) return ['#8fd3ff', '#cdeeff'];
    if (h < 19) return ['#ffb36b', '#ffd9a0'];
    return ['#5b4b8a', '#c58db0'];
  }
  function drawRoom() {
    // 地板
    ctx.fillStyle = '#e9d7b9'; ctx.fillRect(0, 0, W, H);
    for (let y = 95; y < H; y += 32) for (let x = 0; x < 670; x += 64) {
      ctx.fillStyle = ((x / 64 + y / 32) % 2 < 1) ? '#e4cfae' : '#ead9bd'; ctx.fillRect(x + ((y / 32) % 2 ? 32 : 0), y, 64, 32);
    }
    // 茶水間與休息區地板
    ctx.fillStyle = '#d7e8e0'; ctx.fillRect(670, 95, 330, H - 95);
    for (let y = 95; y < H; y += 28) for (let x = 670; x < W; x += 28) { if ((x + y) % 56 === 0) { ctx.fillStyle = '#cbe0d6'; ctx.fillRect(x, y, 28, 28); } }
    // 牆
    rr(0, 0, W, 95, 0, '#f7efe2'); ctx.fillStyle = '#d9c7ab'; ctx.fillRect(0, 88, W, 7);
    ctx.fillStyle = '#c9b490'; ctx.fillRect(668, 95, 4, H - 95);
    // 窗戶
    const [s1, s2] = skyColor();
    for (const wx of [40, 200, 820]) {
      const g = ctx.createLinearGradient(0, 14, 0, 70); g.addColorStop(0, s1); g.addColorStop(1, s2);
      rr(wx, 14, 120, 58, 6, g, INK); ctx.fillStyle = INK; ctx.fillRect(wx + 59, 14, 2, 58); ctx.fillRect(wx, 42, 120, 2);
      const night = s1 === '#1d2b53';
      if (night) { ctx.fillStyle = '#fff6c2'; circle(wx + 95, 28, 6, '#fff6c2'); } else { circle(wx + 25, 30, 7, '#fff7d6'); }
    }
    drawBoard(); drawClock(700, 40);
    // 茶水間
    rr(PANTRY.x + 10, PANTRY.y + 12, 200, 40, 6, '#b08968', INK);            // 流理台
    rr(PANTRY.x + 25, PANTRY.y - 2, 38, 44, 6, '#5c6b73', INK);              // 咖啡機
    circle(PANTRY.x + 44, PANTRY.y + 14, 6, '#2b2d42'); ctx.fillStyle = '#e63946'; ctx.fillRect(PANTRY.x + 54, PANTRY.y + 4, 4, 4);
    rr(PANTRY.x + 90, PANTRY.y + 24, 18, 16, 3, '#ffffff', INK); emoji('☕', PANTRY.x + 140, PANTRY.y + 30, 18);
    rr(PANTRY.x + 225, PANTRY.y - 15, 50, 85, 6, '#e9f1f7', INK);              // 冰箱
    ctx.fillStyle = INK; ctx.fillRect(PANTRY.x + 228, PANTRY.y + 18, 44, 2); ctx.fillRect(PANTRY.x + 265, PANTRY.y, 3, 12);
    circle(PANTRY.x + 210, PANTRY.y + 140, 34, '#f4e1c1', INK);              // 圓桌
    text('茶水間', PANTRY.x + 60, PANTRY.y + 70, 13, '#6b5b4b');
    // 休息區
    rr(LOUNGE.x + 30, LOUNGE.y + 70, 150, 40, 12, '#8ecae6', INK); rr(LOUNGE.x + 30, LOUNGE.y + 55, 150, 22, 10, '#6fb3d6', INK); // 沙發
    rr(LOUNGE.x + 210, LOUNGE.y + 65, 50, 34, 6, '#c9a27e', INK);             // 茶几
    rr(LOUNGE.x + 25, LOUNGE.y + 215, 260, 16, 6, '#a47551', INK);            // 等候長椅
    text('等候區', LOUNGE.x + 150, LOUNGE.y + 196, 12, '#6b5b4b');
    plant(LOUNGE.x + 265, LOUNGE.y + 30); plant(640, 600); plant(25, 600); plant(980, 120);
    // 門口與信箱
    rr(DOOR.x - 40, H - 10, 80, 10, 2, '#a47551'); emoji('📮', DOOR.x + 60, H - 22, 20);
  }
  function plant(x, y) {
    rr(x - 12, y - 4, 24, 20, 4, '#c97b4a', INK);
    for (const [dx, dy, r] of [[0, -16, 12], [-10, -8, 9], [10, -9, 9]]) circle(x + dx, y + dy, r, '#5aa36b', INK);
  }
  function drawClock(x, y) {
    circle(x, y, 20, '#fffdf7', INK);
    const d = new Date(), h = (d.getHours() % 12) + d.getMinutes() / 60, m = d.getMinutes();
    ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x + Math.sin(h / 12 * Math.PI * 2) * 10, y - Math.cos(h / 12 * Math.PI * 2) * 10); ctx.stroke();
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x + Math.sin(m / 60 * Math.PI * 2) * 15, y - Math.cos(m / 60 * Math.PI * 2) * 15); ctx.stroke();
  }
  function drawBoard() {
    const x = 360, y = 10, w = 290, h = 74;
    rr(x, y, w, h, 6, '#ffffff', INK); ctx.fillStyle = '#a3a3a3'; ctx.fillRect(x + 10, y + h - 4, w - 20, 4);
    const st = api.state(), t = st.task, stages = (st.workflow && st.workflow.stages) || [];
    if (!t) { text('📋 目前沒有任務', x + w / 2, y + 26, 14, '#555'); text('在下方輸入目標就能開始', x + w / 2, y + 50, 11, '#888', 'center', '400'); return; }
    text('📋 #' + t.id + ' ' + (t.title.length > 16 ? t.title.slice(0, 16) + '…' : t.title), x + 10, y + 18, 13, INK, 'left');
    const n = Math.max(1, stages.length), cw = (w - 20) / n;
    stages.forEach((s, i) => {
      const cx = x + 10 + i * cw, cur = s.id === t.stageId && t.status !== 'done', done = t.status === 'done' || (t.done || []).includes(s.id);
      rr(cx + 2, y + 34, cw - 4, 22, 6, cur ? '#ffd166' : done ? '#b7e4c7' : '#eeeeee', INK);
      text((done && !cur ? '✓' : '') + s.name, cx + cw / 2, y + 45, 11, INK);
    });
    const label = { running: '進行中', awaiting_approval: '等你核准', waiting_user: '等你回覆', done: '完成 🎉', error: '暫停', stopped: '已停止' }[t.status] || '';
    text(label, x + w - 10, y + 18, 11, t.status === 'awaiting_approval' || t.status === 'waiting_user' ? '#c1121f' : '#555', 'right');
  }
  function drawDesk(c) {
    const { x, y } = c.desk, a = c.agent, working = c.sitting;
    rr(x, y, DESK_W, DESK_H, 6, '#c8a27a', INK);                               // 桌面
    ctx.fillStyle = '#a98461'; ctx.fillRect(x + 4, y + DESK_H - 8, DESK_W - 8, 6);
    // 螢幕
    rr(x + 12, y + 4, 44, 28, 4, '#2b2d42', INK);
    if (working) {
      ctx.fillStyle = a.stalled ? '#ffb4a2' : '#9ef0c2';
      for (let i = 0; i < 4; i++) { const w = 10 + ((Math.sin(c.phase * 6 + i) + 1) * 12); ctx.fillRect(x + 16, y + 8 + i * 6, w, 3); }
    } else { ctx.fillStyle = '#4a4e69'; ctx.fillRect(x + 15, y + 7, 38, 22); }
    rr(x + 30, y + 32, 8, 6, 1, '#555');
    rr(x + 64, y + 14, 34, 14, 3, '#f1f1f1', INK);                             // 鍵盤
    emoji(a.engine === 'codex' ? '📘' : '📙', x + 104, y + 30, 14);
    // 名牌
    rr(x + 24, y + DESK_H + 4, DESK_W - 48, 16, 8, '#fffdf7', INK);
    text(a.name.length > 8 ? a.name.slice(0, 8) + '…' : a.name, x + DESK_W / 2, y + DESK_H + 12, 11, INK);
  }

  function headImage(src) {
    if (!imgCache.has(src)) { const im = new Image(); im.src = src; imgCache.set(src, im); }
    return imgCache.get(src);
  }
  function drawChar(c) {
    const a = c.agent, x = c.x, bob = c.walking ? Math.abs(Math.sin(c.phase * 10)) * 3 : 0;
    const baseY = c.y - (c.sitting ? 6 : 0);
    // 影子
    ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(x, c.y + 2, 16, 5, 0, 0, Math.PI * 2); ctx.fill();
    // 腳
    if (!c.sitting) {
      const sw = c.walking ? Math.sin(c.phase * 10) * 5 : 0;
      rr(x - 9 + sw, baseY - 12, 7, 12, 3, '#3d405b'); rr(x + 2 - sw, baseY - 12, 7, 12, 3, '#3d405b');
    }
    const by = baseY - 12 - bob;
    // 身體
    rr(x - 14, by - 26, 28, 28, 10, c.shirt, INK);
    // 手（工作時打字）
    const typing = c.sitting ? Math.sin(c.phase * 14) * 2 : 0;
    circle(x - 15, by - 10 + typing, 5, '#f1c9a5', INK); circle(x + 15, by - 10 - typing, 5, '#f1c9a5', INK);
    // 頭（就是成員的頭像）
    const hy = by - 42;
    circle(x, hy, 19, '#fffdf7', INK);
    const av = a.avatar || '🤖';
    if (av.startsWith('img:')) {
      const im = headImage(api.avatarUrl(av));
      if (im.complete && im.naturalWidth) { ctx.save(); ctx.beginPath(); ctx.arc(x, hy, 17, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(im, x - 17, hy - 17, 34, 34); ctx.restore(); }
    } else emoji(av, x, hy, 24);
    // 狀態小圖示
    if (a.stalled) { emoji('💦', x + 18, hy - 14, 14); text('!', x - 20, hy - 18, 20, '#c1121f', 'center', '900'); }
    // 名字（不在座位上時顯示）
    if (!c.sitting) { rr(x - 30, c.y + 6, 60, 15, 7, 'rgba(255,253,247,.9)'); text(a.name.length > 7 ? a.name.slice(0, 7) + '…' : a.name, x, c.y + 13, 10, INK); }
    // 泡泡
    const now = performance.now();
    let b = c.bubble && c.bubble.until > now ? c.bubble : null;
    if (!b && c.mode === 'queue') b = { text: '🕒', kind: 'icon' };
    if (!b && a.stalled) b = { text: '😰 好像卡住了…', kind: 'warn' };
    if (b) bubble(x, hy - 26, b);
    if (hover === c) { ctx.strokeStyle = '#e07a5f'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, hy, 23, 0, Math.PI * 2); ctx.stroke(); }
  }
  function bubble(x, y, b) {
    const t = b.text.length > 22 ? b.text.slice(0, 22) + '…' : b.text;
    ctx.font = '600 12px "Noto Sans TC","Microsoft JhengHei",sans-serif';
    const w = Math.min(220, ctx.measureText(t).width + 18), bx = Math.max(4, Math.min(W - w - 4, x - w / 2));
    rr(bx, y - 26, w, 24, 10, b.kind === 'warn' ? '#ffe5e0' : '#ffffff', INK);
    ctx.beginPath(); ctx.moveTo(x - 5, y - 3); ctx.lineTo(x + 5, y - 3); ctx.lineTo(x, y + 4); ctx.closePath(); ctx.fillStyle = b.kind === 'warn' ? '#ffe5e0' : '#ffffff'; ctx.fill();
    text(t, bx + w / 2, y - 14, 12, INK);
  }

  function drawCat(dt) {
    cat.wait -= dt;
    const d = Math.hypot(cat.tx - cat.x, cat.ty - cat.y);
    if (d > 2) { const s = 40 * dt; cat.face = cat.tx > cat.x ? 1 : -1; cat.x += (cat.tx - cat.x) / d * Math.min(s, d); cat.y += (cat.ty - cat.y) / d * Math.min(s, d); }
    else if (cat.wait <= 0) {
      const idle = [...chars.values()].filter((c) => c.mode === 'idle' && !c.walking);
      if (idle.length && Math.random() < 0.5) { const o = idle[Math.floor(Math.random() * idle.length)]; cat.tx = o.x + 25; cat.ty = o.y + 8; }
      else { cat.tx = rand(700, 970); cat.ty = rand(380, 600); }
      cat.wait = rand(5, 12);
    }
    const sleeping = d <= 2 && cat.wait > 3;
    ctx.save(); ctx.translate(cat.x, cat.y); ctx.scale(cat.face, 1);
    ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.beginPath(); ctx.ellipse(0, 3, 14, 4, 0, 0, Math.PI * 2); ctx.fill();
    rr(-12, -12, 22, 13, 7, '#f4a261', INK);                                    // 身體
    circle(10, -14, 8, '#f4a261', INK);                                         // 頭
    ctx.fillStyle = '#f4a261'; ctx.strokeStyle = INK; ctx.lineWidth = 2;
    for (const ex of [6, 13]) { ctx.beginPath(); ctx.moveTo(ex - 3, -19); ctx.lineTo(ex, -26); ctx.lineTo(ex + 3, -19); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(-12, -8); ctx.quadraticCurveTo(-22, -16 + Math.sin(performance.now() / 300) * 3, -18, -22); ctx.stroke();
    if (sleeping) { ctx.restore(); emoji('💤', cat.x + 10, cat.y - 30, 12); } else ctx.restore();
  }

  // ---------- 特效 ----------
  function addPaper(from, to) { effects.push({ type: 'paper', from: { ...from }, to: { ...to }, t: 0, dur: 1.3 }); }
  function addConfetti(x, y) { for (let i = 0; i < 40; i++) effects.push({ type: 'confetti', x, y, vx: rand(-120, 120), vy: rand(-260, -80), t: 0, dur: rand(1.2, 2), color: SHIRTS[i % SHIRTS.length] }); }
  function drawEffects(dt) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i]; e.t += dt;
      if (e.t >= e.dur) { effects.splice(i, 1); continue; }
      const k = e.t / e.dur;
      if (e.type === 'paper') {
        const x = e.from.x + (e.to.x - e.from.x) * k, y = e.from.y + (e.to.y - e.from.y) * k - Math.sin(k * Math.PI) * 90;
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(k * 12) * 0.3); emoji('📄', 0, 0, 22); ctx.restore();
      } else if (e.type === 'confetti') {
        e.vy += 380 * dt; e.x += e.vx * dt; e.y += e.vy * dt;
        ctx.fillStyle = e.color; ctx.fillRect(e.x, e.y, 6, 4);
      } else if (e.type === 'float') {
        emoji(e.icon, e.x, e.y - k * 40, 18);
      }
    }
  }

  // ---------- 主迴圈 ----------
  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0); lastT = t;
    resize();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, offX, offY);
    const agents = api.state().agents;
    // 同步成員（新增、刪除）
    const ids = new Set(agents.map((a) => a.id));
    for (const id of chars.keys()) if (!ids.has(id)) chars.delete(id);
    let q = 0;
    agents.forEach((a, i) => { const c = ensureChar(a, i); updateChar(c, dt, a.queued && !a.busy ? q++ : 0); });
    drawRoom();
    for (const c of chars.values()) drawDesk(c);
    // 依 y 排序，前面的蓋住後面的；坐著的人要被桌子擋住下半身
    const list = [...chars.values()].sort((a, b) => a.y - b.y);
    for (const c of list) {
      drawChar(c);
      if (c.sitting) { ctx.save(); ctx.beginPath(); ctx.rect(c.desk.x - 4, c.desk.y + 2, DESK_W + 8, DESK_H + 26); ctx.clip(); drawDesk(c); ctx.restore(); }
    }
    drawCat(dt);
    drawEffects(dt);
    requestAnimationFrame(frame);
  }
  function resize() {
    const r = canvas.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const cw = Math.max(200, r.width), ch = Math.max(200, r.height);
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    }
    scale = Math.min(canvas.width / W, canvas.height / H);
    offX = (canvas.width - W * scale) / 2; offY = (canvas.height - H * scale) / 2;
  }
  function toWorld(ev) {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    return { x: ((ev.clientX - r.left) * dpr - offX) / scale, y: ((ev.clientY - r.top) * dpr - offY) / scale };
  }
  function pick(p) {
    let best = null, bd = 30;
    for (const c of chars.values()) {
      const hy = c.y - (c.sitting ? 6 : 0) - 54, d = Math.min(Math.hypot(p.x - c.x, p.y - hy), Math.hypot(p.x - c.x, p.y - (c.y - 25)));
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // ---------- 對外介面 ----------
  window.Office = {
    init(el, hooks) {
      api = hooks;
      canvas = document.createElement('canvas'); canvas.className = 'office-canvas'; el.appendChild(canvas);
      ctx = canvas.getContext('2d');
      const tip = document.createElement('div'); tip.className = 'office-tip'; el.appendChild(tip);
      canvas.addEventListener('mousemove', (ev) => {
        const p = toWorld(ev), c = pick(p);
        hover = c; canvas.style.cursor = c || Math.hypot(p.x - cat.x, p.y - cat.y) < 22 ? 'pointer' : 'default';
        if (c) {
          const a = c.agent;
          tip.innerHTML = '<b>' + api.esc(a.name) + '</b><br>' + api.esc(a.role || '') + '<br><small>' + api.esc([a.model || '預設模型', a.effort].filter(Boolean).join(' · ')) +
            '</small><br>' + (a.stalled ? '⚠️ 可能卡住' : a.busy ? '⌨️ 工作中' : a.queued ? '🕒 排隊中' : '☕ 休息中') + '<br><small>點一下開啟對話</small>';
          tip.style.display = 'block'; tip.style.left = (ev.offsetX + 14) + 'px'; tip.style.top = (ev.offsetY + 10) + 'px';
        } else tip.style.display = 'none';
      });
      canvas.addEventListener('mouseleave', () => { hover = null; tip.style.display = 'none'; });
      canvas.addEventListener('click', (ev) => {
        const p = toWorld(ev), c = pick(p);
        if (c) { api.open(c.id); return; }
        if (Math.hypot(p.x - cat.x, p.y - (cat.y - 10)) < 24) { for (let i = 0; i < 3; i++) effects.push({ type: 'float', icon: '💖', x: cat.x + rand(-10, 10), y: cat.y - 25, t: -i * 0.15, dur: 1.2 }); cat.wait = 6; }
      });
    },
    _debug: () => [...chars.values()].map((c) => ({ id: c.id, x: Math.round(c.x), y: Math.round(c.y), mode: c.mode, sitting: c.sitting, path: c.path.map((p) => [Math.round(p.x), Math.round(p.y)]), desk: [c.desk.x, c.desk.y] })),
    start() { if (running) return; running = true; lastT = performance.now(); requestAnimationFrame(frame); },
    stop() { running = false; },
    // 從伺服器的即時事件更新角色
    event(ev) {
      const c = chars.get(ev.agentId);
      if (ev.kind === 'segment' && c) {
        const s = ev.segment;
        if (s.type === 'tool') say(c, s.text, 8, 'talk');
        else if (s.type === 'error') say(c, '⚠️ ' + s.text, 8, 'warn');
        else if (s.type === 'text') say(c, '💬 ' + s.text.replace(/\s+/g, ' '), 6, 'talk');
      }
      if (ev.kind === 'user' && c) {
        if (ev.from && chars.get(ev.from)) {
          const f = chars.get(ev.from);
          addPaper({ x: f.x, y: f.y - 50 }, { x: c.desk.seat.x, y: c.desk.seat.y - 50 });
          say(f, '📨 交給 ' + c.agent.name, 3, 'talk');
        } else if (ev.interject) {
          effects.push({ type: 'float', icon: '⚡', x: c.x, y: c.y - 70, t: 0, dur: 1 });
        } else addPaper({ x: DOOR.x + 60, y: H - 30 }, { x: c.desk.seat.x, y: c.desk.seat.y - 50 });
      }
      if (ev.kind === 'done' && c) { if (!c.bubble || c.bubble.until < performance.now()) say(c, '✅ 這輪做完了', 3, 'talk'); }
    },
    taskEvent(ev, task) {
      if (task && task.status === 'done') {
        const pm = [...chars.values()][0];
        addConfetti(pm ? pm.x : 500, pm ? pm.y - 80 : 200);
        for (const c of chars.values()) say(c, '🎉', 3, 'icon');
      }
    },
  };
})();
