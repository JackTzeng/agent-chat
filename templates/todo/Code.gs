/**
 * 待辦機器人（Google Apps Script）
 *
 * 用法：打開你的 Google Sheet → 擴充功能 → Apps Script → 把這整份貼進去、存檔 → 回到 Sheet 重新整理，
 * 上方會多一個選單「待辦機器人」→「① 初始化」。詳細步驟在 Agent Chat 的「📋 待辦清單」視窗。
 *
 * 它做兩件事：
 *  1. 讓 Agent Chat 的 LINE 機器人讀寫這份 Sheet（要有連線密鑰才行）；人也可以直接在 Sheet 上改。
 *  2. 每天早上自動寄 email：每位負責人收到自己逾期／快到期的事項，主管收到部門總表。
 *     這部分由 Google 的定時功能執行，不需要 AI、不耗額度，電腦關機也會寄。
 *
 * 欄位都是用「欄位名稱」找的：你可以調整欄位順序、自己加欄位，不會壞。
 */
var VERSION = '1.0.1';
var TASK_SHEET = '待辦', MEMBER_SHEET = '成員', SETTING_SHEET = '設定', LOG_SHEET = '紀錄';
var TASK_HEADERS = ['編號', '事項', '負責人', '期限', '狀態', '優先', '備註', '提出人', '建立時間', '最後更新', '更新者', '完成時間'];
var MEMBER_HEADERS = ['姓名', 'Email', '角色', 'LINE 名稱', 'LINE ID'];
var SETTING_HEADERS = ['項目', '值', '說明'];
var SETTING_DEFAULTS = [
  ['總表收件人', '', '除了「角色＝主管」的人，還要收部門待辦總表的 email（多個用逗號隔開）'],
  ['提前提醒天數', '3', '幾天內到期就開始提醒'],
  ['週末是否寄信', '否', '填「是」週末也會寄'],
];
var STATUSES = ['待辦', '進行中', '完成', '擱置', '取消'];
var OPEN_STATUSES = ['待辦', '進行中', '擱置'];
var PRIORITIES = ['高', '中', '低'];
var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

// ---------- 入口：Agent Chat 用 POST 呼叫 ----------
function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return out_({ ok: true, name: '待辦機器人', version: VERSION, note: '這個網址只接受 Agent Chat 的 POST 請求，用瀏覽器開看不到資料' }); }
function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return out_({ ok: false, error: '請求不是 JSON' }); }
  if (!checkKey_(req.key)) return out_({ ok: false, error: '密鑰不對（到 Sheet 選單「待辦機器人 → 顯示連線密鑰」複製）' });
  var fn = OPS_[req.op];
  if (!fn) return out_({ ok: false, error: '不認得的動作：' + req.op });
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) { return out_({ ok: false, error: '系統忙碌，請稍後再試' }); }
  try { return out_(Object.assign({ ok: true }, fn(req))); }
  catch (err) { return out_({ ok: false, error: String((err && err.message) || err) }); }
  finally { lock.releaseLock(); }
}
function checkKey_(k) {
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || typeof k !== 'string' || k.length !== key.length) return false;
  var diff = 0;
  for (var i = 0; i < key.length; i++) diff |= k.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

// ---------- 小工具 ----------
function tz_() { return Session.getScriptTimeZone(); }
function str_(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function clean_(v, max) { return str_(v).replace(/[\r\n\t]+/g, ' ').slice(0, max); }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function todayIso_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function isoOk_(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return false; var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; }
function utcOf_(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return Date.UTC(+m[1], +m[2] - 1, +m[3]); }
function dayDiff_(a, b) { return Math.round((utcOf_(a) - utcOf_(b)) / 86400000); }
function weekdayOf_(iso) { return WEEK[new Date(utcOf_(iso)).getUTCDay()]; }
function mdw_(iso) { return Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10)) + '（週' + weekdayOf_(iso) + '）'; }
// 儲存格的日期 → 'YYYY-MM-DD'；看不懂的文字回傳 raw
function dateCell_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return { iso: Utilities.formatDate(v, tz_(), 'yyyy-MM-dd'), raw: '' };
  var s = str_(v); if (!s) return { iso: '', raw: '' };
  var m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/.exec(s);
  if (m) { var iso = m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]); if (isoOk_(iso)) return { iso: iso, raw: '' }; }
  return { iso: '', raw: s };
}
function timeCell_(v) { return v instanceof Date && !isNaN(v.getTime()) ? Utilities.formatDate(v, tz_(), 'yyyy-MM-dd HH:mm') : str_(v); }
function isoToDate_(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return new Date(+m[1], +m[2] - 1, +m[3]); }
function parseDue_(v) {
  var s = str_(v);
  if (!s || s === '無' || s === '不設期限') return '';
  var m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(s);
  var iso = m ? m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]) : s;
  if (!isoOk_(iso)) throw new Error('期限要寫成 YYYY-MM-DD（例如 2026-11-27），收到：' + s);
  return iso;
}

// ---------- 讀寫分頁（用欄位名稱找欄，不怕人調整順序或加欄）----------
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function readTable_(name) {
  var sheet = ss_().getSheetByName(name);
  if (!sheet) throw new Error('找不到分頁「' + name + '」，請到 Sheet 選單「待辦機器人」按「① 初始化」');
  var values = sheet.getDataRange().getValues();
  var headers = (values[0] || []).map(function (h) { return str_(h); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (r.every(function (c) { return c === '' || c === null || c === undefined; })) continue;
    rows.push({ n: i + 1, v: r });
  }
  return { sheet: sheet, headers: headers, rows: rows };
}
function need_(t, name) { var i = t.headers.indexOf(name); if (i < 0) throw new Error('分頁「' + t.sheet.getName() + '」少了欄位「' + name + '」（請按選單「① 初始化」補上）'); return i; }
function cell_(t, r, name) { var i = t.headers.indexOf(name); return i < 0 || r.v[i] === undefined ? '' : r.v[i]; }
function setCell_(t, r, name, value) { var i = t.headers.indexOf(name); if (i < 0) return; t.sheet.getRange(r.n, i + 1).setValue(value); r.v[i] = value; }
function itemOf_(t, r) {
  var due = dateCell_(cell_(t, r, '期限'));
  return { id: Number(cell_(t, r, '編號')) || 0, title: str_(cell_(t, r, '事項')), owner: str_(cell_(t, r, '負責人')), due: due.iso, dueRaw: due.raw,
    status: str_(cell_(t, r, '狀態')) || '待辦', priority: str_(cell_(t, r, '優先')), note: str_(cell_(t, r, '備註')), proposer: str_(cell_(t, r, '提出人')),
    created: timeCell_(cell_(t, r, '建立時間')), updated: timeCell_(cell_(t, r, '最後更新')), updatedBy: str_(cell_(t, r, '更新者')), doneAt: timeCell_(cell_(t, r, '完成時間')) };
}
function nextId_(t) { var c = need_(t, '編號'), max = 0; t.rows.forEach(function (r) { var n = Number(r.v[c]); if (n > max) max = n; }); return max + 1; }
// 人直接在 Sheet 新增的列（沒有編號）：補上編號、狀態、建立時間
function ensureIds_(t) {
  need_(t, '編號'); need_(t, '事項');
  var now = new Date();
  t.rows.forEach(function (r) {
    if (!str_(cell_(t, r, '事項')) || Number(cell_(t, r, '編號'))) return;
    setCell_(t, r, '編號', nextId_(t));
    if (!str_(cell_(t, r, '狀態'))) setCell_(t, r, '狀態', '待辦');
    if (!cell_(t, r, '建立時間')) setCell_(t, r, '建立時間', now);
  });
}
function findById_(t, id) { var c = need_(t, '編號'); id = Number(id); for (var i = 0; i < t.rows.length; i++) if (Number(t.rows[i].v[c]) === id) return t.rows[i]; return null; }
function ensureSheet_(name, headers) {
  var s = ss_().getSheetByName(name) || ss_().insertSheet(name);
  var have = s.getLastColumn() > 0 ? s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(str_) : [];
  headers.forEach(function (h) { if (have.indexOf(h) < 0) { s.getRange(1, have.length + 1).setValue(h); have.push(h); } });
  s.setFrozenRows(1);
  return s;
}
function log_(action, id, detail, who) {
  try { var s = ss_().getSheetByName(LOG_SHEET); if (s) s.appendRow([new Date(), who || '', action, id || '', String(detail || '').slice(0, 200)]); } catch (e) {}
}
function settings_() {
  var out = { recipients: [], days: 3, weekend: false };
  var s = ss_().getSheetByName(SETTING_SHEET); if (!s) return out;
  var map = {}; s.getDataRange().getValues().forEach(function (r) { map[str_(r[0])] = str_(r[1]); });
  out.recipients = (map['總表收件人'] || '').split(/[,;，；\s]+/).filter(function (x) { return /@/.test(x); });
  var d = parseInt(map['提前提醒天數'], 10); if (d >= 0 && d <= 30) out.days = d;
  out.weekend = map['週末是否寄信'] === '是';
  return out;
}

// ---------- 動作 ----------
function opPing_() {
  var t = readTable_(TASK_SHEET); ensureIds_(t);
  var open = 0; t.rows.forEach(function (r) { if (OPEN_STATUSES.indexOf(itemOf_(t, r).status) >= 0 && str_(cell_(t, r, '事項'))) open++; });
  return { version: VERSION, tz: tz_(), total: t.rows.length, open: open, today: todayIso_() };
}
function opList_(req) {
  var t = readTable_(TASK_SHEET); ensureIds_(t);
  var want = req.statuses && req.statuses.length ? req.statuses : OPEN_STATUSES;
  var items = t.rows.map(function (r) { return itemOf_(t, r); }).filter(function (it) { return it.title && want.indexOf(it.status) >= 0; });
  return { items: items, today: todayIso_() };
}
function opGet_(req) {
  var t = readTable_(TASK_SHEET); ensureIds_(t);
  var r = findById_(t, req.id); if (!r) throw new Error('找不到編號 #' + req.id);
  return { item: itemOf_(t, r) };
}
function opAdd_(req) {
  var t = readTable_(TASK_SHEET); ensureIds_(t);
  var title = clean_(req.title, 100); if (!title) throw new Error('事項不能是空的');
  var owner = clean_(req.owner, 30), note = clean_(req.note, 300), by = clean_(req.by, 30), due = parseDue_(req.due);
  var pr = str_(req.priority); if (pr && PRIORITIES.indexOf(pr) < 0) throw new Error('優先要是 高／中／低');
  var id = nextId_(t), now = new Date();
  var row = t.headers.map(function (h) {
    switch (h) {
      case '編號': return id; case '事項': return title; case '負責人': return owner; case '期限': return due ? isoToDate_(due) : '';
      case '狀態': return '待辦'; case '優先': return pr; case '備註': return note; case '提出人': return by;
      case '建立時間': case '最後更新': return now; case '更新者': return by; default: return '';
    }
  });
  t.sheet.appendRow(row);
  log_('新增', id, title, by);
  return { item: { id: id, title: title, owner: owner, due: due, dueRaw: '', status: '待辦', priority: pr, note: note, proposer: by } };
}
function opUpdate_(req) {
  var t = readTable_(TASK_SHEET); ensureIds_(t);
  var r = findById_(t, req.id); if (!r) throw new Error('找不到編號 #' + req.id);
  var f = req.fields || {}, by = clean_(req.by, 30), now = new Date(), sets = {}, changes = [];
  if ('title' in f) { var ti = clean_(f.title, 100); if (!ti) throw new Error('事項不能是空的'); sets['事項'] = ti; changes.push('事項'); }
  if ('owner' in f) { sets['負責人'] = clean_(f.owner, 30); changes.push('負責人'); }
  if ('due' in f) { var d = parseDue_(f.due); sets['期限'] = d ? isoToDate_(d) : ''; changes.push('期限'); }
  if ('priority' in f) { var p = str_(f.priority); if (p && PRIORITIES.indexOf(p) < 0) throw new Error('優先要是 高／中／低'); sets['優先'] = p; changes.push('優先'); }
  if ('note' in f) { sets['備註'] = clean_(f.note, 300); changes.push('備註'); }
  if ('status' in f) {
    if (STATUSES.indexOf(f.status) < 0) throw new Error('狀態要是：' + STATUSES.join('、'));
    sets['狀態'] = f.status; sets['完成時間'] = f.status === '完成' ? now : ''; changes.push('狀態');
  }
  if (!changes.length) throw new Error('沒有要改的欄位');
  sets['最後更新'] = now; sets['更新者'] = by;
  Object.keys(sets).forEach(function (h) { setCell_(t, r, h, sets[h]); });
  log_('更新', req.id, changes.join('、') + '：' + JSON.stringify(f).slice(0, 120), by);
  return { item: itemOf_(t, r), changed: changes };
}
function memberOf_(t, r) { return { name: str_(cell_(t, r, '姓名')), email: str_(cell_(t, r, 'Email')), role: str_(cell_(t, r, '角色')) || '成員', lineName: str_(cell_(t, r, 'LINE 名稱')), userId: str_(cell_(t, r, 'LINE ID')) }; }
function opMembers_() {
  var t = readTable_(MEMBER_SHEET);
  return { members: t.rows.map(function (r) { return memberOf_(t, r); }).filter(function (m) { return m.name; }) };
}
function opRegister_(req) {
  var t = readTable_(MEMBER_SHEET), name = clean_(req.name, 20), uid = str_(req.userId), line = clean_(req.lineName, 40);
  if (!name) throw new Error('請告訴我你的姓名'); if (!uid) throw new Error('缺少 LINE 帳號資料');
  var byId = null, byName = null;
  t.rows.forEach(function (r) { var m = memberOf_(t, r); if (m.userId === uid) byId = r; else if (m.name.toLowerCase() === name.toLowerCase()) byName = { r: r, m: m }; });
  if (byName && byName.m.userId && byName.m.userId !== uid) throw new Error('「' + name + '」已經有人登記了，請加上全名或換個稱呼');
  // 安全：已登記的人不能改名成名單上的別人；名單上預先填好的主管（還沒有 LINE ID）不能自己認領，要管理員填 LINE ID
  if (byId && byName) throw new Error('「' + name + '」已經在名單上，請加上全名或換個稱呼');
  if (!byId && byName && !byName.m.userId && byName.m.role === '主管') { log_('拒絕認領主管', '', name, 'LINE ID ' + uid); throw new Error('「' + name + '」是名單上的主管，為了安全不能自己認領。請管理員在「成員」分頁把你的 LINE ID 填到那一列（已記在「紀錄」分頁）'); }
  var r2 = byId || (byName && byName.r);
  if (r2) { setCell_(t, r2, '姓名', name); setCell_(t, r2, 'LINE ID', uid); if (line) setCell_(t, r2, 'LINE 名稱', line); log_('登記成員', '', name, name); return { member: memberOf_(t, r2) }; }
  t.sheet.appendRow(t.headers.map(function (h) { return h === '姓名' ? name : h === '角色' ? '成員' : h === 'LINE 名稱' ? line : h === 'LINE ID' ? uid : ''; }));
  log_('登記成員', '', name, name);
  return { member: { name: name, email: '', role: '成員', lineName: line, userId: uid } };
}
function opSetEmail_(req) {
  var t = readTable_(MEMBER_SHEET), email = str_(req.email), uid = str_(req.userId);
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) throw new Error('email 格式不對：' + email);
  var hit = null; t.rows.forEach(function (r) { if (str_(cell_(t, r, 'LINE ID')) === uid) hit = r; });
  if (!hit) throw new Error('還沒登記，請先回覆「我是 你的姓名」');
  setCell_(t, hit, 'Email', email); log_('設定 email', '', str_(cell_(t, hit, '姓名')), str_(cell_(t, hit, '姓名')));
  return { member: memberOf_(t, hit) };
}

// ---------- 每日提醒信 ----------
// 純函式：items（未完成的事項）、members、設定、今天(YYYY-MM-DD) → 要寄的信
function buildDigests_(items, members, st, today) {
  var wd = new Date(utcOf_(today)).getUTCDay();
  if ((wd === 0 || wd === 6) && !st.weekend) return [];
  var rows = [];
  items.forEach(function (it) {
    if (!it.due || OPEN_STATUSES.indexOf(it.status) < 0 || it.status === '擱置') return;
    var d = dayDiff_(it.due, today);
    if (d < 0 || d <= st.days) rows.push({ it: it, d: d });
  });
  if (!rows.length) return [];
  rows.sort(function (a, b) { return a.d - b.d || a.it.id - b.it.id; });
  var line = function (x) { return '#' + x.it.id + ' ' + x.it.title + '（期限 ' + mdw_(x.it.due) + '，' + (x.d < 0 ? '已逾期 ' + (-x.d) + ' 天' : x.d === 0 ? '今天到期' : x.d + ' 天後到期') + (x.it.priority ? '，優先 ' + x.it.priority : '') + '）'; };
  var count = function (list) { var o = list.filter(function (x) { return x.d < 0; }).length; return '逾期 ' + o + ' 項、' + (list.length - o) + ' 項快到期'; };
  var emailOf = {}; members.forEach(function (m) { if (m.email) emailOf[m.name.toLowerCase()] = m.email; });
  var byOwner = {}; rows.forEach(function (x) { var k = x.it.owner || '（沒有負責人）'; (byOwner[k] = byOwner[k] || []).push(x); });
  var mails = [];
  Object.keys(byOwner).forEach(function (o) {
    var to = emailOf[o.toLowerCase()]; if (!to) return;
    mails.push({ kind: 'owner', to: to, subject: '【待辦提醒】' + o + '：' + count(byOwner[o]) + '（' + mdw_(today) + '）',
      body: o + ' 你好，這是你的待辦提醒：\n\n' + byOwner[o].map(line).join('\n') + '\n\n要更新請在 LINE 群組 @待辦管家，或直接改 Google Sheet。' });
  });
  var mgr = {}; members.forEach(function (m) { if (m.role === '主管' && m.email) mgr[m.email.toLowerCase()] = m.email; });
  st.recipients.forEach(function (e) { mgr[e.toLowerCase()] = e; });
  var mgrTo = Object.keys(mgr).map(function (k) { return mgr[k]; });
  if (mgrTo.length) {
    var noMail = Object.keys(byOwner).filter(function (o) { return !emailOf[o.toLowerCase()]; });
    mails.push({ kind: 'summary', to: mgrTo.join(','), subject: '【部門待辦總表】' + count(rows) + '（' + mdw_(today) + '）',
      body: Object.keys(byOwner).map(function (o) { return '■ ' + o + '\n' + byOwner[o].map(line).join('\n'); }).join('\n\n') +
        (noMail.length ? '\n\n⚠️ 這些負責人沒有登記 email，收不到提醒：' + noMail.join('、') : '') });
  }
  return mails;
}
function opDigest_(req) {
  var t = readTable_(TASK_SHEET); ensureIds_(t);
  var items = t.rows.map(function (r) { return itemOf_(t, r); }).filter(function (it) { return it.title; });
  var members = opMembers_().members;
  var mails = buildDigests_(items, members, settings_(), todayIso_());
  if (req && req.send) {
    var left = MailApp.getRemainingDailyQuota();
    var n = mails.reduce(function (s, m) { return s + m.to.split(',').length; }, 0);
    if (n > left) throw new Error('今天的寄信額度不夠（需要 ' + n + ' 封、剩 ' + left + ' 封），明天再試');
    mails.forEach(function (m) { MailApp.sendEmail({ to: m.to, subject: m.subject, body: m.body, name: '待辦提醒' }); });
    log_('寄提醒信', '', mails.length + ' 封', '系統');
  }
  return { count: mails.length, sent: !!(req && req.send), mails: mails.map(function (m) { return { kind: m.kind, to: m.to, subject: m.subject }; }) };
}
var OPS_ = { ping: opPing_, list: opList_, get: opGet_, add: opAdd_, update: opUpdate_, members: opMembers_, register: opRegister_, setEmail: opSetEmail_, digest: opDigest_ };

// ---------- 選單與初始化 ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('待辦機器人')
    .addItem('① 初始化（建立分頁與下拉選單）', 'setup')
    .addItem('② 顯示連線密鑰（貼到 Agent Chat）', 'showKey')
    .addItem('③ 安裝每日提醒信（每天 8:30）', 'installDigestTrigger')
    .addSeparator()
    .addItem('寄一次提醒信（測試）', 'sendDigestNow')
    .addItem('重新產生密鑰', 'resetKey')
    .addItem('移除每日提醒信', 'removeDigestTrigger')
    .addToUi();
}
function newKey_() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function setup() {
  var tasks = ensureSheet_(TASK_SHEET, TASK_HEADERS), members = ensureSheet_(MEMBER_SHEET, MEMBER_HEADERS);
  var set = ensureSheet_(SETTING_SHEET, SETTING_HEADERS); ensureSheet_(LOG_SHEET, ['時間', '誰', '動作', '編號', '內容']);
  if (set.getLastRow() < 2) SETTING_DEFAULTS.forEach(function (r) { set.appendRow(r); });
  var list = function (arr) { return SpreadsheetApp.newDataValidation().requireValueInList(arr, true).setAllowInvalid(false).build(); };
  var col = function (sheet, name) { return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(str_).indexOf(name) + 1; };
  try {
    tasks.getRange(2, col(tasks, '狀態'), 998, 1).setDataValidation(list(STATUSES));
    tasks.getRange(2, col(tasks, '優先'), 998, 1).setDataValidation(list(PRIORITIES));
    tasks.getRange(2, col(tasks, '期限'), 998, 1).setNumberFormat('yyyy-mm-dd');
    members.getRange(2, col(members, '角色'), 998, 1).setDataValidation(list(['成員', '主管']));
  } catch (e) {}
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KEY')) props.setProperty('KEY', newKey_());
  SpreadsheetApp.getUi().alert('初始化完成 ✅\n\n已建立分頁：待辦、成員、設定、紀錄。\n\n下一步：選單「待辦機器人 → ② 顯示連線密鑰」，複製密鑰；再依 Agent Chat「📋 待辦清單」視窗的步驟「部署」成網頁應用程式。');
}
function showKey() {
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key) { setup(); key = PropertiesService.getScriptProperties().getProperty('KEY'); }
  SpreadsheetApp.getUi().alert('連線密鑰（請複製，貼到 Agent Chat「📋 待辦清單」；不要貼到別的地方）：\n\n' + key);
}
function resetKey() {
  PropertiesService.getScriptProperties().setProperty('KEY', newKey_());
  SpreadsheetApp.getUi().alert('已重新產生密鑰。舊的密鑰立刻失效，請到「顯示連線密鑰」複製新的，貼回 Agent Chat。');
}
function installDigestTrigger() {
  removeDigestTrigger_();
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(8).nearMinute(30).everyDays(1).create();
  SpreadsheetApp.getUi().alert('已安裝：每天約 8:30 自動寄提醒信（週末預設不寄；收件人與提前天數在「設定」分頁調整）。\n第一次安裝 Google 會要求授權寄信權限，請按「允許」。\n\n也可以先用「寄一次提醒信（測試）」看看。');
}
function removeDigestTrigger_() { ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'dailyDigest') ScriptApp.deleteTrigger(tr); }); }
function removeDigestTrigger() { removeDigestTrigger_(); SpreadsheetApp.getUi().alert('已移除每日提醒信。'); }
function dailyDigest() {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try { opDigest_({ send: true }); } catch (err) { log_('寄信失敗', '', String(err && err.message || err), '系統'); } finally { lock.releaseLock(); }
}
function sendDigestNow() {
  var r = opDigest_({ send: true });
  SpreadsheetApp.getUi().alert(r.count ? '已寄出 ' + r.count + ' 封：\n' + r.mails.map(function (m) { return '・' + m.subject + ' → ' + m.to; }).join('\n') : '現在沒有需要提醒的事項（或今天是週末），所以沒有寄信。');
}
