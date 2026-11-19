'use strict';
// 🧩 Skill：列出各 CLI 裝了哪些 Skill、每位成員用得到哪些，以及「成員提出 → 使用者核准 → Agent Chat 自己安裝」。
// 安全原則：成員只能「提出」安裝（回覆裡寫【安裝 Skill】），一定要使用者核准；下載後先列出檔案與腳本給使用者看；
// 不執行 Skill 裡的任何東西；只接受 GitHub 公開 repo；不跟隨符號連結、不寫到 Skill 資料夾以外；移除是搬到回收區（可復原）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const MAX_DOWNLOAD = 30 * 1024 * 1024;   // 下載的壓縮檔上限
const MAX_UNPACKED = 120 * 1024 * 1024;  // 解壓後上限
const MAX_FILES = 400, MAX_SKILL_BYTES = 10 * 1024 * 1024; // 單一 Skill 的檔案數與大小上限
const SCRIPT_EXT = /\.(js|mjs|cjs|ts|py|sh|bash|ps1|psm1|bat|cmd|exe|dll|so|dylib|rb|pl|php|jar|vbs|wsf|msi|scr|com)$/i;

const safeName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// SKILL.md 開頭的 YAML：只取 name、description（不跑 YAML 解析器，避免意外）
function frontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) { const buf = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) buf.push(lines[++i].trim()); v = buf.join(' '); }
    out[kv[1]] = short(v.replace(/^["']|["']$/g, ''), 300);
  }
  return out;
}

// 來源寫法：owner/repo、owner/repo/子路徑、owner/repo@分支、https://github.com/owner/repo/tree/分支/子路徑
function parseSpec(raw) {
  let s = String(raw || '').trim().replace(/^<|>$/g, '').replace(/[)。，,；;]+$/, '');
  let ref = null, m;
  if ((m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/([^/\s]+)(\/[^\s#?]*)?)?/i.exec(s))) {
    return check({ owner: m[1], repo: m[2].replace(/\.git$/i, ''), ref: m[3] || null, sub: (m[4] || '').replace(/^\/|\/$/g, '').replace(/\/SKILL\.md$/i, '') });
  }
  if ((m = /^([^@\s]+)@([\w.\-/]+)$/.exec(s))) { s = m[1]; ref = m[2]; }
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return check({ owner: parts[0], repo: parts[1].replace(/\.git$/i, ''), ref, sub: parts.slice(2).join('/').replace(/\/SKILL\.md$/i, '') });
}
function check(sp) {
  const ok = (x) => /^[A-Za-z0-9_.-]{1,100}$/.test(x) && !/^\.+$/.test(x);
  if (!ok(sp.owner) || !ok(sp.repo)) return null;
  if (sp.ref && !/^[\w.\-/]{1,100}$/.test(sp.ref)) return null;
  if (sp.sub && (sp.sub.split('/').some((p) => !p || p === '..' || p === '.') || sp.sub.length > 300)) return null;
  return sp;
}
const specText = (sp) => sp.owner + '/' + sp.repo + (sp.sub ? '/' + sp.sub : '') + (sp.ref ? '@' + sp.ref : '');

// 回覆裡的【安裝 Skill】來源 → 對象（對象可省略；可寫成員、小組或「全域」）
function collect(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*【安裝\s*[Ss][Kk][Ii][Ll][Ll]】\s*[:：]?\s*(\S+)(?:\s*(?:→|->|給|for)\s*@?(.+?))?\s*$/.exec(line);
    if (!m) continue;
    const sp = parseSpec(m[1]);
    out.push(sp ? { spec: sp, target: (m[2] || '').trim().slice(0, 40) } : { error: '看不懂的來源：' + short(m[1], 80) });
  }
  return out.slice(0, 5);
}

// ---------- tar.gz（GitHub 的 repo 壓縮檔）----------
function untar(buf) {
  const entries = [];
  let off = 0, longName = null, paxPath = null;
  const str = (b, s, l) => { const x = b.subarray(s, s + l); const z = x.indexOf(0); return x.subarray(0, z < 0 ? l : z).toString('utf8'); };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h, 345, 155);
    let name = (prefix ? prefix + '/' : '') + str(h, 0, 100);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(data, 0, size); continue; }
    if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8')); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type === '0' || type === '\0' || type === '7') entries.push({ path: name, data });
    // 目錄、符號連結、硬連結、裝置檔：一律略過（不跟隨連結）
  }
  return entries;
}
// 去掉最上層的「owner-repo-sha/」，並擋掉奇怪的路徑
function normalizeEntries(entries) {
  const out = [];
  for (const e of entries) {
    const parts = e.path.replace(/\\/g, '/').split('/').filter(Boolean).slice(1);
    if (!parts.length || parts.some((p) => p === '..' || p === '.' || /[<>:"|?*\x00-\x1f]/.test(p))) continue;
    out.push({ path: parts.join('/'), data: e.data });
  }
  return out;
}
// 找出 repo 裡所有的 Skill（含 SKILL.md 的資料夾）
function findSkills(files) {
  const dirs = files.filter((f) => /(^|\/)SKILL\.md$/i.test(f.path)).map((f) => ({ dir: f.path.replace(/\/?SKILL\.md$/i, ''), md: f.data.toString('utf8') }));
  return dirs.map((d) => {
    const fm = frontmatter(d.md);
    const inside = files.filter((f) => (d.dir ? f.path.startsWith(d.dir + '/') : true));
    return { dir: d.dir, name: safeName(fm.name || path.posix.basename(d.dir) || ''), title: fm.name || path.posix.basename(d.dir), description: fm.description || '', files: inside };
  }).filter((s) => s.name);
}
function chooseSkill(skills, sp, want) {
  if (sp.sub) { const s = skills.find((x) => x.dir === sp.sub) || skills.find((x) => x.dir.endsWith('/' + sp.sub)); return s ? { skill: s } : { error: '這個路徑下找不到 SKILL.md：' + sp.sub }; }
  if (want) { const s = skills.find((x) => x.name === safeName(want) || path.posix.basename(x.dir) === want); if (s) return { skill: s }; }
  if (skills.length === 1) return { skill: skills[0] };
  if (!skills.length) return { error: '這個 repo 裡沒有 SKILL.md，不是 Skill' };
  return { choices: skills.map((s) => ({ name: s.name, dir: s.dir, description: short(s.description, 120) })) };
}
// 檢查內容：檔案清單、有沒有可執行的腳本
function review(skill) {
  const rel = (p) => (skill.dir ? p.slice(skill.dir.length + 1) : p);
  const files = skill.files.map((f) => {
    const r = rel(f.path), head = f.data.subarray(0, 2).toString('latin1');
    return { path: r, size: f.data.length, script: SCRIPT_EXT.test(r) || head === '#!' };
  });
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const problems = [];
  if (files.length > MAX_FILES) problems.push('檔案太多（' + files.length + ' 個，上限 ' + MAX_FILES + '）');
  if (bytes > MAX_SKILL_BYTES) problems.push('太大（' + Math.round(bytes / 1024) + ' KB，上限 ' + MAX_SKILL_BYTES / 1024 / 1024 + ' MB）');
  return { files: files.slice(0, 200), fileCount: files.length, bytes, scripts: files.filter((f) => f.script).map((f) => f.path).slice(0, 50), problems };
}

function create(ctx) {
  // ctx: { DATA_DIR, state, saveState, broadcast, hooks, agents(), agentById, teams(), teamById, findAgentByName, fetch?, tarballBase? }
  const S = ctx.state;
  S.skillReqs = S.skillReqs || [];
  S.skillSeq = S.skillSeq || 0;
  // 程式重新啟動時還在下載的申請：標成失敗，讓使用者按重試
  for (const r of S.skillReqs) if (r.status === 'fetching') { r.status = 'failed'; r.error = '下載到一半程式重新啟動了，請按重試'; }
  const STAGE = path.join(ctx.DATA_DIR, 'skills-staging'), TRASH = path.join(ctx.DATA_DIR, 'skills-trash');
  const base = () => (process.env.SKILL_TARBALL_BASE || 'https://codeload.github.com').replace(/\/$/, '');
  const doFetch = ctx.fetch || ((u, o) => fetch(u, o));
  const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const globalRoot = () => path.join(claudeHome(), 'skills');
  const projectRoot = (cwd) => path.join(cwd, '.claude', 'skills');
  const changed = () => { ctx.saveState(); ctx.broadcast({ agentId: '*', kind: 'skills' }); };

  // 安裝位置：成員或小組的工作資料夾（只影響那裡的成員），或全域（所有成員與你自己的 Claude）
  function targets() {
    const list = [{ key: 'global', label: '🌐 全域（所有 Claude 成員，也包括你自己在終端機用的 Claude）', root: globalRoot() }];
    const seen = new Set();
    for (const t of ctx.teams()) {
      const cwd = (ctx.agents().find((a) => a.team === t.id && !a.standalone) || {}).cwd;
      if (cwd && !seen.has(cwd)) { seen.add(cwd); list.push({ key: 'dir:' + cwd, label: (t.icon || '👥') + ' 小組「' + t.name + '」的工作資料夾', root: projectRoot(cwd), cwd }); }
    }
    for (const a of ctx.agents()) if (a.engine === 'claude' && a.cwd && !seen.has(a.cwd)) { seen.add(a.cwd); list.push({ key: 'dir:' + a.cwd, label: '👤 ' + a.name + ' 的工作資料夾', root: projectRoot(a.cwd), cwd: a.cwd }); }
    return list;
  }
  function resolveTarget(requester, name) {
    const n = String(name || '').trim(), all = targets();
    if (/^(全域|全部|所有人|global|all)$/i.test(n)) return all[0];
    const a = n && (ctx.findAgentByName(n) || ctx.agentById(n));
    if (a && a.cwd) return all.find((t) => t.cwd === a.cwd);
    const t = n && ctx.teams().find((x) => x.name === n || x.id === n);
    if (t) { const m = ctx.agents().find((x) => x.team === t.id && !x.standalone); if (m) return all.find((x) => x.cwd === m.cwd); }
    if (requester && requester.cwd) return all.find((x) => x.cwd === requester.cwd);
    return all[0];
  }

  async function download(sp) {
    const url = base() + '/' + encodeURIComponent(sp.owner) + '/' + encodeURIComponent(sp.repo) + '/tar.gz/' + (sp.ref ? sp.ref.split('/').map(encodeURIComponent).join('/') : 'HEAD');
    const res = await doFetch(url, { redirect: 'follow', headers: { 'User-Agent': 'agent-chat-skill-installer' } });
    if (res.status === 404) throw new Error('找不到這個 repo（或它不是公開的）：' + specText(sp));
    if (!res.ok) throw new Error('下載失敗（HTTP ' + res.status + '）');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_DOWNLOAD) throw new Error('repo 太大（' + Math.round(len / 1048576) + ' MB）');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD) throw new Error('repo 太大');
    let tar;
    try { tar = zlib.gunzipSync(buf, { maxOutputLength: MAX_UNPACKED }); } catch (e) { throw new Error('解壓縮失敗：' + e.message); }
    return normalizeEntries(untar(tar));
  }

  // 下載並整理成待核准的內容（存到暫存區，核准後才複製到正式位置）
  async function prepare(req, want) {
    req.status = 'fetching'; req.error = null; changed();
    try {
      const files = await download(req.spec);
      const pick = chooseSkill(findSkills(files), req.spec, want || req.want);
      if (pick.error) throw new Error(pick.error);
      if (pick.choices) { req.status = 'choose'; req.choices = pick.choices; changed(); return req; }
      const sk = pick.skill, rv = review(sk);
      const dir = path.join(STAGE, String(req.id));
      fs.rmSync(dir, { recursive: true, force: true });
      if (!rv.problems.length) for (const f of sk.files) {
        const rel = sk.dir ? f.path.slice(sk.dir.length + 1) : f.path;
        const dest = path.join(dir, ...rel.split('/'));
        if (!dest.startsWith(dir + path.sep)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.data);
      }
      Object.assign(req, { status: rv.problems.length ? 'failed' : 'ready', name: sk.name, title: sk.title, description: sk.description, dir: sk.dir, review: rv,
        error: rv.problems.length ? '不能安裝：' + rv.problems.join('；') : null, choices: null });
      req.exists = fs.existsSync(path.join(req.targetRoot, req.name));
    } catch (e) {
      req.status = 'failed'; req.error = short(e.message, 300);
    }
    changed();
    if (req.status === 'ready' && ctx.hooks) ctx.hooks.emit('skill-request', { req });
    return req;
  }

  function request(spec, { from = null, target = '', targetKey = '', via = 'agent', want = '' } = {}) {
    const sp = typeof spec === 'string' ? parseSpec(spec) : spec;
    if (!sp) throw new Error('看不懂的來源，請寫成「擁有者/repo」或 GitHub 網址');
    const requester = from && ctx.agentById(from);
    const tg = (targetKey && targets().find((t) => t.key === targetKey)) || resolveTarget(requester, target);
    const dup = S.skillReqs.find((r) => ['fetching', 'ready', 'choose'].includes(r.status) && specText(r.spec) === specText(sp) && r.targetKey === tg.key);
    if (dup) return dup;
    const req = { id: ++S.skillSeq, spec: sp, source: specText(sp), from, via, want, targetKey: tg.key, targetLabel: tg.label, targetRoot: tg.root, status: 'fetching', at: Date.now() };
    S.skillReqs.unshift(req);
    S.skillReqs = S.skillReqs.slice(0, 50);
    prepare(req).catch(() => {});
    return req;
  }
  const findReq = (id) => { const r = S.skillReqs.find((x) => x.id === Number(id)); if (!r) throw new Error('找不到這個安裝申請 #' + id); return r; };

  function approve(id, { target, replace = false, by = 'web' } = {}) {
    const req = findReq(id);
    if (req.status !== 'ready') throw new Error('這個申請現在不能安裝（' + req.status + '）');
    if (target && target !== req.targetKey) {
      const t = targets().find((x) => x.key === target);
      if (!t) throw new Error('找不到這個安裝位置');
      Object.assign(req, { targetKey: t.key, targetLabel: t.label, targetRoot: t.root });
    }
    const src = path.join(STAGE, String(req.id)), dest = path.join(req.targetRoot, req.name);
    if (!fs.existsSync(src)) throw new Error('暫存的檔案不見了，請重新下載');
    if (fs.existsSync(dest)) {
      if (!replace) throw new Error('這裡已經有同名的 Skill「' + req.name + '」；要覆蓋請勾「取代現有的」');
      moveToTrash(dest, req.name);
    }
    fs.mkdirSync(req.targetRoot, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, dereference: false });
    fs.rmSync(src, { recursive: true, force: true });
    Object.assign(req, { status: 'installed', doneAt: Date.now(), by, installedPath: dest });
    changed();
    if (ctx.hooks) ctx.hooks.emit('skill-installed', { req });
    return req;
  }
  function reject(id, by = 'web') {
    const req = findReq(id);
    if (['installed', 'rejected'].includes(req.status)) return req;
    fs.rmSync(path.join(STAGE, String(req.id)), { recursive: true, force: true });
    Object.assign(req, { status: 'rejected', doneAt: Date.now(), by });
    changed();
    return req;
  }
  function choose(id, name) {
    const req = findReq(id);
    if (req.status !== 'choose') throw new Error('這個申請不需要選擇');
    req.want = name;
    prepare(req, name).catch(() => {});
    return req;
  }
  function retry(id) { const req = findReq(id); if (req.status !== 'failed') throw new Error('只有失敗的申請可以重試'); prepare(req).catch(() => {}); return req; }

  function moveToTrash(dir, name) {
    fs.mkdirSync(TRASH, { recursive: true });
    const to = path.join(TRASH, new Date().toISOString().replace(/[:.]/g, '-') + '_' + safeName(name));
    try { fs.renameSync(dir, to); } catch { fs.cpSync(dir, to, { recursive: true }); fs.rmSync(dir, { recursive: true, force: true }); }
    return to;
  }

  // 列出已安裝的 Skill（只讀 SKILL.md 開頭的 name／description）
  function scan(root) {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); } catch { return []; }
    return names.map((n) => {
      let md = ''; try { md = fs.readFileSync(path.join(root, n, 'SKILL.md'), 'utf8').slice(0, 8000); } catch { return null; }
      const fm = frontmatter(md);
      return { name: n, title: fm.name || n, description: fm.description || '' };
    }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }
  function remove(root, name) {
    const t = targets().find((x) => path.resolve(x.root) === path.resolve(String(root || '')));
    if (!t) throw new Error('只能移除 Agent Chat 管理的位置裡的 Skill');
    const n = String(name || '');
    if (!n || n !== path.basename(n) || n === '.' || n === '..') throw new Error('名稱不正確');
    const dir = path.join(t.root, n);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('找不到這個 Skill');
    const to = moveToTrash(dir, n);
    changed();
    return { trashed: to };
  }

  // 每位成員用得到哪些：Claude 成員＝全域＋自己工作資料夾的；有限制工具／最小權限且沒有 Skill 工具的用不到
  function memberSkills(a, roots) {
    if (a.engine !== 'claude') return { skills: [], note: a.engine === 'codex' ? 'Codex 的 Skill 位置還沒在你的電腦上確認' : 'agy 的 Skill 位置還沒在你的電腦上確認' };
    const g = roots.find((r) => r.key === 'global'), p = roots.find((r) => r.cwd && path.resolve(r.cwd) === path.resolve(a.cwd));
    let names = [...new Set([...(g ? g.skills : []), ...(p ? p.skills : [])].map((s) => s.name))];
    let note = '';
    const tools = String(a.tools || '').split(/[\s,]+/).filter(Boolean);
    if (tools.length && !tools.includes('Skill')) { names = []; note = '限制工具：沒有開放 Skill 工具，實際用不到'; }
    else if (a.permissionMode === 'default' && (a.allowedTools || []).length && !(a.allowedTools || []).some((t) => /^Skill(\(|$)/.test(t))) { names = []; note = '最小權限：允許清單沒有 Skill，實際用不到'; }
    return { skills: names, note };
  }
  function snapshot() {
    const roots = targets().map((t) => ({ key: t.key, label: t.label, root: t.root, cwd: t.cwd || null, skills: scan(t.root) }));
    const extra = [['Codex', path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills')], ['agy', path.join(os.homedir(), '.gemini', 'antigravity', 'skills')]]
      .map(([cli, dir]) => ({ cli, root: dir, found: fs.existsSync(dir), skills: scan(dir) }));
    const members = ctx.agents().map((a) => ({ id: a.id, name: a.name, engine: a.engine, ...memberSkills(a, roots) }));
    const reqs = S.skillReqs.slice(0, 20).map((r) => ({ ...r, spec: undefined, fromName: r.from ? (ctx.agentById(r.from) || {}).name || r.from : null }));
    return { roots, extra, members, requests: reqs, pending: S.skillReqs.filter((r) => ['ready', 'choose'].includes(r.status)).length, targets: targets().map((t) => ({ key: t.key, label: t.label })) };
  }

  // 成員回覆裡的【安裝 Skill】→ 建立申請（不會自動安裝）
  function fromReply(agent, text) {
    const found = collect(text), made = [];
    for (const f of found) {
      if (f.error) { made.push({ error: f.error }); continue; }
      try { made.push(request(f.spec, { from: agent.id, target: f.target, via: 'agent' })); } catch (e) { made.push({ error: e.message }); }
    }
    return made;
  }

  return { request, approve, reject, choose, retry, remove, snapshot, fromReply, targets, pendingCount: () => S.skillReqs.filter((r) => ['ready', 'choose'].includes(r.status)).length, get: (id) => S.skillReqs.find((x) => x.id === Number(id)) };
}

module.exports = { create, parseSpec, collect, frontmatter, untar, normalizeEntries, findSkills, chooseSkill, review, specText, safeName };
