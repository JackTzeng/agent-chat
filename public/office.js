// 🏢 等角像素辦公室：每個小組一間辦公室，獨立成員有自己的小隔間，大家共用茶水間・會議室
// 全部用 Canvas 程式繪製（原創造型，不使用外部美術素材）；低解析度畫好再放大，保持像素感
'use strict';
(function () {
  const TWP = 16, THP = 8;            // 一格在低解析度畫布上的大小（等角菱形）
  const WALL = 34;                     // 外牆高度（像素）
  const SPEED = { work: 4.2, queue: 3, idle: 1.6, hand: 4 }; // 格/秒
  const SHIRTS = ['#c8553d', '#3f8f5f', '#3d6fb6', '#e0b43a', '#7a5bb5', '#2f8c8c', '#d4775c', '#5a8fd0', '#9b6b3d', '#b5838d'];
  const HAIRS = ['#3b2a20', '#1d1d1f', '#6b4226', '#b8572a', '#5b3a29', '#2a2a2a'];
  const SKINS = ['#f2c9a0', '#e8b58c', '#f5d0b0', '#f0c49b', '#e9be96'];
  const FLOORS = [['#c49a6c', '#b98f62'], ['#9fb7c9', '#94acbe'], ['#b9c99f', '#aebf94'], ['#c9a9b9', '#bf9eaf'], ['#c9bc9f', '#bfb294'], ['#a9b9c9', '#9eaebf']];

  let host, canvas, ctx, off, g, api = null, running = false, lastT = 0, tip;
  let L = null, layoutKey = '';
  const chars = new Map(), effects = [];
  const cam = { k: 1, x: 0, y: 0, tk: 1, tx: 0, ty: 0, focus: null };
  let hover = null, pickables = [];

  const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };
  const rand = (a, b) => a + Math.random() * (b - a);
  const shade = (hex, k) => {
    const n = parseInt(hex.slice(1), 16); const f = (c) => Math.max(0, Math.min(255, Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k))));
    return 'rgb(' + f(n >> 16) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
  };

  // ---------- 版面：依小組與成員自動排出辦公室 ----------
  // 每一排（band）放幾間小組辦公室，排與排之間是走廊；最右邊有一條直向走廊把各排連起來；最下面一排是記帳亭等獨立成員的小隔間與茶水間
  function buildLayout(st) {
    const teams = st.teams.length ? st.teams : [{ id: '_', name: '辦公室', icon: '🏢' }];
    const members = (tid) => st.agents.filter((a) => !a.standalone && (a.team === tid || (tid === teams[0].id && !teams.some((t) => t.id === a.team))));
    const solos = st.agents.filter((a) => a.standalone);
    const MAXW = 30, HALL = 2;
    const rooms = [], desks = new Map(), bands = [];
    let y = 0, row = [], rowW = 0;
    const flush = () => {
      if (!row.length) return;
      const h = Math.max(...row.map((r) => r.h));
      let x = 0;
      for (const r of row) { r.x = x; r.y = y; r.h = h; x += r.w; rooms.push(r); }
      bands.push({ y, h, hallY: y + h + HALL / 2, w: x });
      y += h + HALL; row = []; rowW = 0;
    };
    teams.forEach((t, i) => {
      const m = members(t.id), cols = Math.min(3, Math.max(2, m.length)), rows = Math.max(1, Math.ceil(m.length / 3));
      const r = { kind: 'team', id: t.id, team: t, name: (t.icon || '🏢') + ' ' + t.name, w: 1 + cols * 4, h: 3 * rows + 3, rows, floor: FLOORS[i % FLOORS.length], members: m };
      if (rowW + r.w > MAXW && row.length) flush();
      row.push(r); rowW += r.w;
    });
    flush();
    const teamW = Math.max(...bands.map((b) => b.w));
    // 最下面一排：獨立成員的小隔間＋茶水間
    const bottomY = y, bh = 8;
    let x = 0;
    for (const a of solos) { rooms.push({ kind: 'booth', id: 'booth-' + a.id, name: (a.avatar && !String(a.avatar).startsWith('img:') ? a.avatar : '🧍') + ' ' + a.name, x, y: bottomY, w: 6, h: bh, floor: ['#d8c58f', '#cdb984'], members: [a] }); x += 6; }
    const loungeW = Math.max(12, teamW - x);
    rooms.push({ kind: 'lounge', id: 'lounge', name: '☕ 茶水間・會議室', x, y: bottomY, w: loungeW, h: bh, floor: ['#b9b2c9', '#aea6bf'], members: [] });
    const W = Math.max(teamW, x + loungeW) + 2, H = bottomY + bh;
    const eastX = W - 1;
    // 每間辦公室：門、桌子、座位、走道
    for (const r of rooms) {
      if (r.kind === 'team') {
        const band = bands.find((b) => b.y === r.y);
        r.door = { x: r.x + Math.floor(r.w / 2) + 0.5, side: 'S' }; r.hallY = band.hallY;
        r.corrY = r.y + r.h - 0.9; r.aisleX = r.x + 0.6;
        r.members.forEach((a, i) => {
          const c = i % 3, rr = Math.floor(i / 3);
          const d = { x: r.x + 1.5 + c * 4, y: r.y + 1.2 + rr * 3, room: r };
          d.seat = { x: d.x + 1, y: d.y + 1.3 }; d.aisle = d.y + 2.2;
          desks.set(a.id, d);
        });
      } else {
        r.door = { x: r.x + Math.floor(r.w / 2) + 0.5, side: 'N' }; r.hallY = bands.length ? bands[bands.length - 1].hallY : r.y - 1;
        r.corrY = r.y + 1.0;
        if (r.kind === 'booth') { const a = r.members[0]; const d = { x: r.x + 2, y: r.y + 3, room: r }; d.seat = { x: d.x + 1, y: d.y + 1.3 }; d.aisle = d.y + 2.3; desks.set(a.id, d); }
      }
    }
    const lounge = rooms.find((r) => r.kind === 'lounge');
    const lx = lounge.x, ly = lounge.y;
    lounge.spots = [
      { x: lx + 2.2, y: ly + 2.6, label: 'coffee' }, { x: lx + 3.4, y: ly + 2.6, label: 'coffee' },
      { x: lx + 2.6, y: ly + 6.4, label: 'sofa' }, { x: lx + 3.8, y: ly + 6.4, label: 'sofa' }, { x: lx + 5, y: ly + 6.4, label: 'sofa' },
      ...[0, 1, 2].map((i) => ({ x: lx + 7.7 + i * 1.3, y: ly + 2.9, label: 'meet' })), ...[0, 1, 2].map((i) => ({ x: lx + 7.7 + i * 1.3, y: ly + 6.0, label: 'meet' })),
    ].filter((s) => s.x < lx + lounge.w - 0.8);
    lounge.bench = (i) => ({ x: lx + lounge.w - 1.4 - (i % 6) * 0.9, y: ly + 1.6 + Math.floor(i / 6) * 0.9 });
    return { rooms, desks, bands, W, H, eastX, lounge };
  }
  const roomAt = (p) => L.rooms.find((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
  // 走路路線（曼哈頓）：房間裡先走到走道 → 門 → 走廊（必要時經過東側直向走廊）→ 目的地房間的門 → 走道 → 目的地
  function route(from, to) {
    const ra = roomAt(from), rb = roomAt(to), pts = [];
    const exitRoom = (p, r) => {
      if (!r) return p;
      if (r.kind === 'team') {
        const d = [...L.desks.values()].find((k) => k.room === r && Math.abs(k.seat.x - p.x) < 0.01 && Math.abs(k.seat.y - p.y) < 0.01);
        if (d) { pts.push({ x: p.x, y: d.aisle }); p = { x: p.x, y: d.aisle }; if (Math.abs(d.aisle - r.corrY) > 0.3) { pts.push({ x: r.aisleX, y: d.aisle }, { x: r.aisleX, y: r.corrY }); p = { x: r.aisleX, y: r.corrY }; } }
        pts.push({ x: p.x, y: r.corrY }, { x: r.door.x, y: r.corrY }, { x: r.door.x, y: r.hallY });
      } else { pts.push({ x: p.x, y: r.corrY }, { x: r.door.x, y: r.corrY }, { x: r.door.x, y: r.hallY }); }
      return { x: r.door.x, y: r.hallY };
    };
    const enterRoom = (r, p) => {
      if (r.kind === 'team') {
        const d = [...L.desks.values()].find((k) => k.room === r && Math.abs(k.seat.x - p.x) < 0.01 && Math.abs(k.seat.y - p.y) < 0.01);
        pts.push({ x: r.door.x, y: r.corrY });
        if (d && Math.abs(d.aisle - r.corrY) > 0.3) pts.push({ x: r.aisleX, y: r.corrY }, { x: r.aisleX, y: d.aisle }, { x: p.x, y: d.aisle });
        else pts.push({ x: p.x, y: d ? d.aisle : r.corrY });
        pts.push(p);
      } else { pts.push({ x: r.door.x, y: r.corrY }, { x: p.x, y: r.corrY }, p); }
    };
    if (ra && ra === rb) {
      if (ra.kind === 'team') {
        const da = [...L.desks.values()].find((k) => k.room === ra && k.seat.x === from.x && k.seat.y === from.y);
        const db = [...L.desks.values()].find((k) => k.room === rb && k.seat.x === to.x && k.seat.y === to.y);
        const ya = da ? da.aisle : from.y, yb = db ? db.aisle : to.y;
        pts.push({ x: from.x, y: ya });
        if (Math.abs(ya - yb) > 0.3) pts.push({ x: ra.aisleX, y: ya }, { x: ra.aisleX, y: yb });
        pts.push({ x: to.x, y: yb }, to);
      } else pts.push({ x: from.x, y: to.y }, to);
      return pts;
    }
    let p = exitRoom(from, ra);
    const hy = rb ? rb.hallY : p.y;
    if (Math.abs(p.y - hy) > 0.3) { pts.push({ x: L.eastX, y: p.y }, { x: L.eastX, y: hy }); p = { x: L.eastX, y: hy }; }
    if (rb) { pts.push({ x: rb.door.x, y: hy }); enterRoom(rb, to); } else pts.push(to);
    return pts;
  }

  // ---------- 角色 ----------
  function ensureChar(a) {
    let c = chars.get(a.id);
    const desk = L.desks.get(a.id);
    if (!c) {
      const h = hash(a.id), av = String(a.avatar || '');
      c = { id: a.id, x: desk ? desk.seat.x : L.lounge.x + 2, y: desk ? desk.seat.y : L.lounge.y + 3, path: [], mode: 'idle', dwell: rand(2, 8), phase: rand(0, 6),
        shirt: SHIRTS[h % SHIRTS.length], hair: HAIRS[(h >> 3) % HAIRS.length], skin: SKINS[(h >> 6) % SKINS.length],
        hat: /🎩|🤠|👒/.test(av), glasses: /🤓|👓|📜|🔍/.test(av), bun: (h >> 9) % 4 === 0, bubble: null, dir: 'up', spot: null };
      chars.set(a.id, c);
    }
    c.agent = a; c.desk = desk;
    return c;
  }
  function goTo(c, target, mode) {
    const last = c.path.length ? c.path[c.path.length - 1] : { x: c.x, y: c.y };
    if (Math.abs(last.x - target.x) + Math.abs(last.y - target.y) < 0.05) return;
    c.path = route({ x: c.x, y: c.y }, target); c.walkMode = mode || c.mode;
  }
  function say(c, text, secs, kind) { c.bubble = { text: String(text || ''), until: performance.now() + (secs || 5) * 1000, kind: kind || 'talk' }; }
  const atSeat = (c) => c.desk && Math.abs(c.x - c.desk.seat.x) < 0.05 && Math.abs(c.y - c.desk.seat.y) < 0.05;

  function updateChar(c, dt, qi) {
    const a = c.agent;
    const mode = c.handoff ? 'hand' : a.busy ? 'work' : a.queued ? 'queue' : 'idle';
    if (mode !== c.mode) {
      c.mode = mode; c.spot = null; c.dwell = rand(4, 10);
      if (mode === 'work' && c.desk) goTo(c, c.desk.seat, 'work');
      if (mode === 'queue') goTo(c, L.lounge.bench(qi), 'queue');
      if (mode === 'idle' && c.desk && !atSeat(c)) goTo(c, c.desk.seat, 'idle');
    }
    if (mode === 'hand' && !c.path.length) {
      c.handoff.wait -= dt;
      if (c.handoff.wait <= 0) { c.handoff = null; c.mode = 'idle'; if (c.desk) goTo(c, c.desk.seat, 'idle'); }
    }
    if (mode === 'idle' && !c.path.length) {
      c.dwell -= dt;
      if (c.dwell <= 0) { // 沒事時偶爾去茶水間，大部分時間待在位子上
        c.dwell = rand(10, 22);
        if (c.spot || !c.desk || Math.random() < 0.45) {
          const taken = new Set([...chars.values()].filter((o) => o !== c && o.spot).map((o) => o.spot));
          const free = L.lounge.spots.filter((s) => !taken.has(s));
          if (!c.spot && free.length && Math.random() < 0.8) { c.spot = free[Math.floor(Math.random() * free.length)]; goTo(c, c.spot, 'idle'); if (c.spot.label === 'coffee') say(c, '☕', 3, 'icon'); }
          else if (c.desk) { c.spot = null; goTo(c, c.desk.seat, 'idle'); }
        }
      }
    }
    if (c.path.length) {
      const p = c.path[0], dx = p.x - c.x, dy = p.y - c.y, d = Math.abs(dx) + Math.abs(dy), step = (SPEED[c.walkMode] || SPEED.idle) * dt;
      c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      if (d <= step) { c.x = p.x; c.y = p.y; c.path.shift(); }
      else if (Math.abs(dx) > 0.001) c.x += Math.sign(dx) * Math.min(step, Math.abs(dx));
      else c.y += Math.sign(dy) * Math.min(step, Math.abs(dy));
      c.walking = true;
    } else c.walking = false;
    c.sitting = !c.walking && atSeat(c);
    if (c.sitting) c.dir = 'up';
    else if (!c.walking && c.spot && c.spot.label === 'sofa') c.dir = 'down';
    c.phase += dt;
  }

  // ---------- 繪圖（低解析度畫布）----------
  let iso = null;
  const P = (x, y, z = 0) => ({ x: iso.ox + (x - y) * TWP / 2, y: iso.oy + (x + y) * THP / 2 - z });
  function quad(pts, fill) { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.fillStyle = fill; g.fill(); }
  function box(x, y, w, d, h, z, col) {
    const a = P(x, y, z + h), b = P(x + w, y, z + h), c = P(x + w, y + d, z + h), e = P(x, y + d, z + h);
    const b0 = P(x + w, y, z), c0 = P(x + w, y + d, z), e0 = P(x, y + d, z);
    quad([e, c, c0, e0], shade(col, -0.15)); quad([c, b, b0, c0], shade(col, -0.35)); quad([a, b, c, e], shade(col, 0.15));
  }
  function person(c, t) {
    const q = P(c.x, c.y, 0); const step = c.walking ? Math.floor(t * 8) % 2 : 0;
    const x = Math.round(q.x), y = Math.round(q.y);
    const R = (dx, dy, w, h, col) => { g.fillStyle = col; g.fillRect(x + dx, y + dy, w, h); };
    R(-4, -1, 8, 2, 'rgba(0,0,0,.28)');
    const sit = c.sitting || (!c.walking && c.spot && c.spot.label !== 'coffee'), lift = sit ? 3 : 0;
    const typing = c.sitting && c.agent.busy ? (Math.floor(t * 6) % 2) : 0;
    if (!sit) { R(-3, -4, 2, 4 - step, '#2d3047'); R(1, -4, 2, 3 + step, '#2d3047'); }
    R(-4, -10 + lift, 8, 6, c.shirt); R(-5, -9 + lift - typing, 1, 4, c.skin); R(4, -9 + lift - (1 - typing) * (c.sitting && c.agent.busy ? 1 : 0), 1, 4, c.skin);
    R(-3, -16 + lift, 6, 6, c.skin); R(-3, -17 + lift, 6, c.dir === 'up' ? 6 : 3, c.hair);
    if (c.dir !== 'up') { R(-2, -13 + lift, 1, 1, '#222'); R(1, -13 + lift, 1, 1, '#222'); if (c.glasses) R(-3, -14 + lift, 6, 1, '#333'); }
    if (c.hat) { R(-4, -18 + lift, 8, 1, '#1b1b22'); R(-2, -22 + lift, 4, 4, '#1b1b22'); R(-2, -19 + lift, 4, 1, '#a33'); }
    else if (c.bun) R(-1, -19 + lift, 2, 2, c.hair);
    if (c.handoff || c.carrying) R(4, -9, 3, 4, '#f4f1e6');
    return { x, y: y - 22 + lift };
  }
  function plant(x, y) { box(x, y, 0.6, 0.6, 5, 0, '#b5651d'); const q = P(x + 0.3, y + 0.3, 12); g.fillStyle = '#3e8e41'; g.beginPath(); g.ellipse(q.x, q.y, 6, 7, 0, 0, 7); g.fill(); g.fillStyle = '#58b05c'; g.fillRect(Math.round(q.x - 2), Math.round(q.y - 5), 3, 3); }

  function render(t, night) {
    const W = L.W, H = L.H;
    const pad = 12;
    off.width = (W + H) * TWP / 2 + pad * 2; off.height = (W + H) * THP / 2 + WALL + pad * 2 + 6;
    iso = { ox: pad + H * TWP / 2, oy: pad + WALL };
    g.clearRect(0, 0, off.width, off.height);
    // 地板：辦公室各自的顏色，走廊灰色
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const r = L.rooms.find((k) => x >= k.x && x < k.x + k.w && y >= k.y && y < k.y + k.h);
      quad([P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)], r ? r.floor[(x + y) % 2] : ((x + y) % 2 ? '#8a8a92' : '#838390'));
    }
    // 外牆（後方兩面）與窗戶
    quad([P(0, 0), P(W, 0), P(W, 0, WALL), P(0, 0, WALL)], night ? '#5c5870' : '#e8dcc6');
    quad([P(0, 0), P(0, H), P(0, H, WALL), P(0, 0, WALL)], night ? '#4e4a62' : '#d6c6ab');
    for (let wx = 2; wx + 2.4 < W - 2; wx += 6.5) {
      const q = [P(wx, 0, 10), P(wx + 2.4, 0, 10), P(wx + 2.4, 0, 28), P(wx, 0, 28)];
      g.beginPath(); q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
      const gr = g.createLinearGradient(0, q[3].y, 0, q[0].y); gr.addColorStop(0, night ? '#1a2250' : '#7cc6f2'); gr.addColorStop(1, night ? '#2c3a78' : '#cdeefe');
      g.fillStyle = gr; g.fill(); g.strokeStyle = '#7a5a3e'; g.lineWidth = 2; g.stroke();
    }
    for (const r of L.rooms) if (r.x === 0 && r.kind === 'team') quad([P(0, r.y + 1, 10), P(0, r.y + Math.min(r.h - 1, 4), 10), P(0, r.y + Math.min(r.h - 1, 4), 26), P(0, r.y + 1, 26)], '#fbfbf6'); // 白板
    const items = [];
    // 矮隔間（門口留空）：每段一格，方便前後排序
    for (const r of L.rooms) {
      const door = (i) => Math.abs(i + 0.5 - r.door.x) < 1.01;
      for (let i = r.x; i < r.x + r.w; i++) {
        if (!(r.door.side === 'S' && door(i)) && r.y + r.h < H) items.push({ k: i + r.y + r.h, f: ((i) => () => box(i, r.y + r.h - 0.2, 1, 0.2, 8, 0, '#e2d5bd'))(i) });
        if (r.y > 0 && !(r.door.side === 'N' && door(i))) items.push({ k: i + r.y + 0.2, f: ((i) => () => box(i, r.y, 1, 0.2, 8, 0, '#e2d5bd'))(i) });
      }
      if (r.x + r.w < W) for (let j = r.y; j < r.y + r.h; j++) items.push({ k: r.x + r.w + j + 1, f: ((j) => () => box(r.x + r.w - 0.2, j, 0.2, 1, 8, 0, '#e2d5bd'))(j) });
    }
    // 桌子
    for (const [id, d] of L.desks) {
      const c = chars.get(id), on = c && c.sitting && c.agent.busy;
      items.push({ k: d.x + d.y + 1.2, f: () => {
        box(d.x, d.y, 2, 1, 7, 0, '#c79a6b');
        box(d.x + 0.7, d.y + 0.15, 0.7, 0.15, 8, 7, '#2a2d36');
        const s1 = P(d.x + 0.75, d.y + 0.3, 14), s2 = P(d.x + 1.35, d.y + 0.3, 14);
        g.fillStyle = on ? '#7fe3a0' : c && c.agent.blocked ? '#e5484d' : '#3a4256'; g.fillRect(Math.round(s1.x), Math.round(s1.y) - 1, Math.round(s2.x - s1.x), 4);
        if (d.room.kind === 'booth') box(d.x + 1.5, d.y + 0.4, 0.3, 0.4, 1, 7, '#f4f1e6');
        box(d.x + 0.8, d.y + 1.15, 0.6, 0.5, 4, 0, '#2f3542');
      } });
    }
    // 茶水間：咖啡機、沙發、會議桌；房間角落放植物
    const lo = L.lounge;
    items.push({ k: lo.x + 1.6 + lo.y + 1.4, f: () => { box(lo.x + 1.6, lo.y + 1.2, 0.8, 0.6, 14, 0, '#3a3d46'); box(lo.x + 2.6, lo.y + 1.2, 1.6, 0.6, 7, 0, '#d8cbb5'); } });
    items.push({ k: lo.x + 2 + lo.y + 7.6, f: () => { box(lo.x + 2, lo.y + 6.8, 3.6, 1, 5, 0, '#a64848'); box(lo.x + 2, lo.y + 7.5, 3.6, 0.3, 9, 0, '#8c3b3b'); } });
    if (lo.w >= 12) items.push({ k: lo.x + 7.3 + lo.y + 5, f: () => box(lo.x + 7.3, lo.y + 3.5, Math.min(4, lo.w - 8), 2, 7, 0, '#e9e1d2') });
    for (const r of L.rooms) { plant(r.x + r.w - 0.9, r.y + 0.3); items.push({ k: r.x + 0.2 + r.y + r.h - 0.2, f: () => plant(r.x + 0.2, r.y + r.h - 0.9) }); }
    // 人物
    const tags = [];
    for (const c of chars.values()) items.push({ k: c.x + c.y + 0.1, f: () => tags.push({ c, at: person(c, t) }) });
    items.sort((a, b) => a.k - b.k).forEach((it) => it.f());
    // 特效：飛行文件、彩帶
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i]; e.t += e.dt || 0;
      if (e.t >= e.dur) { effects.splice(i, 1); continue; }
      if (e.type === 'confetti') { e.vy += 60 * (e.dt || 0); e.x += e.vx * (e.dt || 0); e.y += e.vy * (e.dt || 0); g.fillStyle = e.color; g.fillRect(Math.round(e.x), Math.round(e.y), 2, 2); }
    }
    if (night) {
      g.fillStyle = 'rgba(12,16,48,.45)'; g.fillRect(0, 0, off.width, off.height);
      g.globalCompositeOperation = 'lighter';
      for (const [id, d] of L.desks) { const c = chars.get(id); if (c && c.sitting && c.agent.busy) { const q = P(d.x + 1, d.y + 0.3, 14); const gr = g.createRadialGradient(q.x, q.y, 1, q.x, q.y, 22); gr.addColorStop(0, 'rgba(120,255,180,.4)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(q.x - 22, q.y - 22, 44, 44); } }
      g.globalCompositeOperation = 'source-over';
    }
    return tags;
  }

  // ---------- 畫到畫面（放大、文字用高解析度）----------
  function label(x, y, text, o = {}) {
    ctx.font = o.font || '700 12px "Noto Sans TC", "Microsoft JhengHei", monospace';
    const w = ctx.measureText(text).width + 12, h = o.h || 20;
    ctx.fillStyle = o.bg || 'rgba(10,12,20,.8)'; ctx.fillRect(Math.round(x - w / 2), Math.round(y - h), Math.round(w), h);
    if (o.border) { ctx.strokeStyle = o.border; ctx.lineWidth = 2; ctx.strokeRect(Math.round(x - w / 2), Math.round(y - h), Math.round(w), h); }
    ctx.fillStyle = o.color || '#ffe9b0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y - h / 2 + 1);
    return { x: x - w / 2, y: y - h, w, h };
  }
  function bubble(x, y, text, kind) {
    ctx.font = '700 12px "Noto Sans TC", "Microsoft JhengHei", monospace';
    const s = text.length > 24 ? text.slice(0, 23) + '…' : text;
    const w = ctx.measureText(s).width + 16, h = 24, bx = Math.round(x - w / 2), by = Math.round(y - h - 8);
    ctx.fillStyle = kind === 'warn' ? '#ffe3e0' : '#fffbe9'; ctx.fillRect(bx, by, Math.round(w), h);
    ctx.fillRect(Math.round(x - 4), by + h, 8, 4); ctx.fillRect(Math.round(x - 2), by + h + 4, 4, 3);
    ctx.strokeStyle = kind === 'warn' ? '#b33' : '#2b2b2b'; ctx.lineWidth = 2; ctx.strokeRect(bx, by, Math.round(w), h);
    ctx.fillStyle = '#2b2b2b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s, x, by + h / 2 + 1);
  }
  function fitCamera(instant) {
    const cw = canvas.width, ch = canvas.height;
    let bx = 0, by = 0, bw = off.width, bh = off.height;
    if (cam.focus) {
      const r = L.rooms.find((x) => x.id === cam.focus);
      if (r) { const a = P(r.x, r.y, WALL), b = P(r.x + r.w, r.y), c = P(r.x + r.w, r.y + r.h), d = P(r.x, r.y + r.h);
        bx = d.x - 10; bw = b.x - d.x + 20; by = a.y - 10; bh = c.y - a.y + 30; } else cam.focus = null;
    }
    cam.tk = Math.min(cw / bw, ch / bh) * (cam.focus ? 0.95 : 1);
    cam.tx = (cw - bw * cam.tk) / 2 - bx * cam.tk; cam.ty = (ch - bh * cam.tk) / 2 - by * cam.tk;
    if (instant) { cam.k = cam.tk; cam.x = cam.tx; cam.y = cam.ty; }
  }
  const toScreen = (p) => ({ x: cam.x + p.x * cam.k, y: cam.y + p.y * cam.k });

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0); lastT = now;
    const t = now / 1000;
    resize();
    const st = api.state();
    const key = JSON.stringify([st.teams.map((x) => [x.id, x.name, x.icon]), st.agents.map((a) => [a.id, a.team, !!a.standalone, a.name, a.avatar])]);
    if (key !== layoutKey) { L = buildLayout(st); layoutKey = key; for (const c of chars.values()) { c.path = []; c.spot = null; c.mode = ''; } }
    const ids = new Set(st.agents.map((a) => a.id));
    for (const id of chars.keys()) if (!ids.has(id)) chars.delete(id);
    let q = 0;
    for (const a of st.agents) { const c = ensureChar(a); updateChar(c, dt, a.queued && !a.busy ? q++ : 0); }
    for (const e of effects) e.dt = dt;
    const hour = new Date().getHours(), night = hour >= 19 || hour < 6;
    const tags = render(t, night);
    const first = !cam.init; cam.init = true;
    fitCamera(first);
    const ease = 1 - Math.pow(0.001, dt);
    cam.k += (cam.tk - cam.k) * ease; cam.x += (cam.tx - cam.x) * ease; cam.y += (cam.ty - cam.y) * ease;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = night ? '#0c0f1e' : '#283048'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, cam.x, cam.y, off.width * cam.k, off.height * cam.k);
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pickables = [];
    // 房間名牌：小組名稱＋目前任務狀態；點一下放大這一間
    const STATUS = { running: '▶', awaiting_approval: '🔔 等你核准', waiting_user: '⏳ 等你回覆', error: '⚠️' };
    for (const r of L.rooms) {
      const s = toScreen(P(r.x + r.w / 2, r.y + r.h - 0.5, 0)); const sx = s.x / dpr, sy = s.y / dpr;
      let sub = '';
      if (r.kind === 'team') { const tk = st.tasks.find((x) => x.teamId === r.id); const stg = tk && r.team.workflow && r.team.workflow.stages.find((x) => x.id === tk.stageId);
        sub = tk ? (STATUS[tk.status] || '') + ' #' + tk.id + (stg ? ' ' + stg.name : '') : '沒有進行中的任務'; }
      else if (r.kind === 'booth') sub = '獨立成員'; else sub = '大家共用';
      const b1 = label(sx, sy + 4, r.name, { bg: 'rgba(20,16,12,.85)', color: '#fff2c4', font: '700 13px "Noto Sans TC", monospace', border: cam.focus === r.id ? '#f0a35e' : null });
      label(sx, sy + 22, sub, { bg: 'rgba(20,16,12,.6)', color: '#e6e0d0', font: '500 11px "Noto Sans TC", monospace', h: 17 });
      pickables.push({ kind: 'room', id: r.id, ...b1 });
    }
    for (const { c, at } of tags) {
      const s = toScreen(at), sx = s.x / dpr, sy = s.y / dpr, a = c.agent;
      const lb = label(sx, sy + 31 * cam.k / dpr + 4, a.name, { bg: hover === c.id ? 'rgba(240,163,94,.95)' : 'rgba(10,12,20,.8)', color: hover === c.id ? '#1b1206' : '#ffe9b0', font: '700 11px "Noto Sans TC", monospace', h: 17 });
      pickables.push({ kind: 'agent', id: c.id, x: Math.min(lb.x, sx - 6 * cam.k / dpr), y: sy, w: Math.max(lb.w, 12 * cam.k / dpr), h: lb.y + lb.h - sy });
      let b = c.bubble && c.bubble.until > performance.now() ? c.bubble : null;
      if (!b) b = a.blocked ? { text: '⛔ 設定需修正', kind: 'warn' } : a.stalled ? { text: '❓ 可能卡住了', kind: 'warn' } : a.queued && !a.busy ? { text: '🕒 排隊中', kind: 'talk' } : c.handoff && !c.path.length ? { text: '📄 交給你了！' } : null;
      if (b) bubble(sx, sy, b.text, b.kind);
    }
    requestAnimationFrame(frame);
  }
  function resize() {
    const r = host.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const cw = Math.max(200, r.width), ch = Math.max(200, r.height);
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      cam.init = false;
    }
  }
  const hit = (ev) => { const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    return pickables.slice().reverse().find((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) || null; };

  window.Office = {
    init(el, hooks) {
      api = hooks; host = el;
      canvas = document.createElement('canvas'); canvas.className = 'office-canvas'; el.appendChild(canvas);
      ctx = canvas.getContext('2d');
      off = document.createElement('canvas'); g = off.getContext('2d');
      tip = document.createElement('div'); tip.className = 'office-tip'; el.appendChild(tip);
      const btn = document.createElement('button'); btn.className = 'office-zoom'; btn.textContent = '🗺 全景'; btn.style.display = 'none'; el.appendChild(btn);
      btn.onclick = () => { cam.focus = null; btn.style.display = 'none'; };
      canvas.addEventListener('mousemove', (ev) => {
        const p = hit(ev);
        hover = p && p.kind === 'agent' ? p.id : null;
        canvas.style.cursor = p ? 'pointer' : 'default';
        if (p && p.kind === 'agent') {
          const a = (chars.get(p.id) || {}).agent; if (!a) return;
          tip.innerHTML = '<b>' + api.esc(a.name) + '</b><br>' + api.esc(a.role || '') + '<br><small>' + api.esc([a.model || '預設模型', a.effort].filter(Boolean).join(' · ')) +
            '</small><br>' + (a.blocked ? '⛔ 設定需修正' : a.stalled ? '⚠️ 可能卡住' : a.busy ? '⌨️ 工作中' : a.queued ? '🕒 排隊中' : '☕ 休息中') + '<br><small>點一下開啟對話</small>';
          tip.style.display = 'block'; tip.style.left = (ev.offsetX + 14) + 'px'; tip.style.top = (ev.offsetY + 10) + 'px';
        } else if (p && p.kind === 'room') {
          tip.innerHTML = cam.focus === p.id ? '點一下回到全景' : '點一下放大這一間'; tip.style.display = 'block'; tip.style.left = (ev.offsetX + 14) + 'px'; tip.style.top = (ev.offsetY + 10) + 'px';
        } else tip.style.display = 'none';
      });
      canvas.addEventListener('mouseleave', () => { hover = null; tip.style.display = 'none'; });
      canvas.addEventListener('click', (ev) => {
        const p = hit(ev); if (!p) return;
        if (p.kind === 'agent') return api.open(p.id);
        cam.focus = cam.focus === p.id ? null : p.id; btn.style.display = cam.focus ? '' : 'none';
      });
    },
    _debug: () => ({ layout: L && { W: L.W, H: L.H, rooms: L.rooms.map((r) => ({ id: r.id, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h })) },
      chars: [...chars.values()].map((c) => ({ id: c.id, x: +c.x.toFixed(2), y: +c.y.toFixed(2), mode: c.mode, sitting: c.sitting, path: c.path.length })) }),
    focus(id) { cam.focus = id; },
    start() { if (running) return; running = true; lastT = performance.now(); cam.init = false; requestAnimationFrame(frame); },
    stop() { running = false; },
    // 從伺服器的即時事件更新角色
    event(ev) {
      const c = chars.get(ev.agentId);
      if (ev.kind === 'segment' && c) {
        const s = ev.segment;
        if (s.type === 'tool') say(c, s.text, 7, 'talk');
        else if (s.type === 'error') say(c, '⚠️ ' + s.text, 8, 'warn');
        else if (s.type === 'text') say(c, '💬 ' + s.text.replace(/\s+/g, ' '), 6, 'talk');
      }
      if (ev.kind === 'user' && c) {
        const f = ev.from && chars.get(ev.from);
        if (f && f !== c && c.desk && L) { // 交接：上一位拿著文件走到下一位的座位旁邊，交完再走回去
          const spot = { x: c.desk.seat.x + 1.1, y: c.desk.aisle };
          f.handoff = { to: c.id, wait: 1.6 }; f.mode = 'hand'; f.spot = null; goTo(f, spot, 'hand');
          say(f, '📄 交給 ' + c.agent.name, 4, 'talk');
        } else if (ev.interject) say(c, '⚡ 收到插話', 3, 'talk');
        else if (!f) say(c, '📨 新的訊息', 3, 'talk');
      }
      if (ev.kind === 'done' && c) { if (!c.bubble || c.bubble.until < performance.now()) say(c, '✅ 這輪做完了', 3, 'talk'); }
    },
    taskEvent(ev, task) {
      if (!task || task.status !== 'done' || !L) return;
      const r = L.rooms.find((x) => x.id === task.teamId) || L.rooms[0];
      const q = P(r.x + r.w / 2, r.y + r.h / 2, 30);
      for (let i = 0; i < 50; i++) effects.push({ type: 'confetti', x: q.x, y: q.y, vx: rand(-40, 40), vy: rand(-60, -15), t: 0, dur: rand(1.5, 2.5), color: SHIRTS[i % SHIRTS.length] });
      for (const c of chars.values()) if (c.agent.team === task.teamId) say(c, '🎉 任務完成', 4, 'talk');
    },
  };
})();
