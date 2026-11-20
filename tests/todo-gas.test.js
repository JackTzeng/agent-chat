'use strict';
// 待辦機器人的 Apps Script（templates/todo/Code.gs）：用假的 Google 環境（試算表、信箱、鎖、設定）載入真正要貼進 Sheet 的那份檔案來測。
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, iso, Sheet } = require('./helpers/fakegoogle');
const { makeXlsx } = require('./helpers/makexlsx');

const sheetRows = (env, name) => env.sheets.get(name).data;

test('setup creates the sheets and a key; key check and unknown ops', () => {
  const env = makeEnv();
  env.g.setup();
  for (const n of ['待辦', '成員', '設定', '紀錄']) assert.ok(env.sheets.get(n), '建立分頁 ' + n);
  assert.deepEqual(sheetRows(env, '待辦')[0].slice(0, 5), ['編號', '事項', '負責人', '期限', '狀態']);
  assert.match(env.props.KEY, /^[0-9a-f]{40}$/);
  assert.match(env.alerts.at(-1), /初始化完成/);
  assert.equal(sheetRows(env, '設定').length, 4, '預設設定');
  const keyBefore = env.props.KEY; env.g.setup(); assert.equal(env.props.KEY, keyBefore, '再按一次初始化不會換密鑰');
  assert.equal(env.call('ping', {}, 'wrong').ok, false);
  assert.match(env.call('ping', {}, 'wrong').error, /密鑰不對/);
  assert.equal(env.call('ping', {}, '').ok, false);
  assert.match(env.call('nope').error, /不認得/);
  assert.equal(env.call('ping').ok, true);
  assert.match(JSON.parse(env.g.doGet().text).note, /POST/);
  env.g.showKey(); assert.ok(env.alerts.at(-1).includes(env.props.KEY));
  env.g.resetKey(); assert.notEqual(env.props.KEY, keyBefore);
});

test('add / list / update / get with validation; humans can edit the sheet too', () => {
  const env = makeEnv(); env.g.setup();
  const a = env.call('add', { title: '完成 HPLC 校正紀錄', owner: '小王', due: iso(3), priority: '高', by: '王小明', note: '等試劑' });
  assert.equal(a.ok, true); assert.equal(a.item.id, 1);
  const b = env.call('add', { title: '訂購耗材', owner: '小李', due: '', by: '小李' }); assert.equal(b.item.id, 2);
  assert.equal(env.call('add', { title: '' }).ok, false);
  assert.match(env.call('add', { title: 'x', due: '明天' }).error, /YYYY-MM-DD/);
  assert.match(env.call('add', { title: 'x', due: '2026-02-31' }).error, /YYYY-MM-DD/);
  assert.match(env.call('add', { title: 'x', priority: '急' }).error, /高／中／低/);
  // 寫進去的是真的日期格式；其他欄位按欄位名稱放對位置
  const row = sheetRows(env, '待辦')[1]; assert.equal(row[1], '完成 HPLC 校正紀錄'); assert.ok(row[3] instanceof Date); assert.equal(row[4], '待辦'); assert.equal(row[7], '王小明');
  // 人直接在 Sheet 新增一列（沒有編號、沒有狀態）→ 下次讀取時補上
  env.sheets.get('待辦').appendRow(['', '人工新增的事項', '小張', '2026/12/5']);
  let list = env.call('list'); assert.equal(list.items.length, 3);
  const manual = list.items.find((x) => x.title === '人工新增的事項'); assert.equal(manual.id, 3); assert.equal(manual.status, '待辦'); assert.equal(manual.due, '2026-12-05');
  // 欄位順序被人調過、中間插了自己的欄：照樣能用
  const sh = env.sheets.get('待辦'); sh.data = sh.data.map((r) => { const c = r.slice(); c.splice(2, 0, c[0] === '編號' ? '我的欄位' : 'x'); return c; });
  assert.equal(env.call('add', { title: '調過欄位後新增', owner: '小王' }).item.id, 4);
  const last = sh.data.at(-1); assert.equal(last[sh.data[0].indexOf('事項')], '調過欄位後新增'); assert.equal(last[sh.data[0].indexOf('我的欄位')], '');
  // 更新
  const u = env.call('update', { id: 1, fields: { status: '進行中', due: iso(10), note: '試劑到了' }, by: '小王' });
  assert.equal(u.ok, true); assert.equal(u.item.status, '進行中'); assert.equal(u.item.due, iso(10)); assert.deepEqual(u.changed, ['期限', '備註', '狀態']);
  const done = env.call('update', { id: 1, fields: { status: '完成' }, by: '小王' });
  assert.equal(done.item.status, '完成'); assert.ok(done.item.doneAt, '有完成時間'); assert.equal(done.item.updatedBy, '小王');
  assert.ok(!env.call('list').items.some((x) => x.id === 1), '預設只列未完成的');
  assert.equal(env.call('list', { statuses: ['完成'] }).items.length, 1);
  assert.equal(env.call('update', { id: 1, fields: { status: '待辦' } }).item.doneAt, '', '重新打開就清掉完成時間');
  assert.equal(env.call('update', { id: 2, fields: { due: '' } }).item.due, '');
  assert.match(env.call('update', { id: 2, fields: { status: '搞定' } }).error, /狀態要是/);
  assert.match(env.call('update', { id: 99, fields: { note: 'x' } }).error, /找不到編號 #99/);
  assert.match(env.call('update', { id: 2, fields: {} }).error, /沒有要改/);
  assert.equal(env.call('get', { id: 2 }).item.title, '訂購耗材');
  assert.ok(sheetRows(env, '紀錄').length > 3, '有留紀錄');
});

test('members: register, bind pre-filled names, email, conflicts', () => {
  const env = makeEnv(); env.g.setup();
  env.sheets.get('成員').appendRow(['小王', 'wang@example.com', '成員', '', '']);          // 人先填好姓名與 email
  const r1 = env.call('register', { userId: 'U1', lineName: 'Wang🙂', name: '小王' });
  assert.equal(r1.member.email, 'wang@example.com'); assert.equal(r1.member.userId, 'U1');
  assert.equal(sheetRows(env, '成員').length, 2, '綁到原本那列，沒有多一列');
  const r2 = env.call('register', { userId: 'U2', lineName: 'Boss', name: '王主任' }); assert.equal(r2.member.role, '成員');
  assert.match(env.call('register', { userId: 'U3', name: '小王' }).error, /已經有人登記/);
  assert.equal(env.call('register', { userId: 'U2', name: '王主任（改）' }).member.name, '王主任（改）', '同一個人可以改名');
  assert.match(env.call('register', { userId: '', name: 'x' }).error, /LINE/);
  assert.equal(env.call('setEmail', { userId: 'U2', email: 'boss@example.com' }).member.email, 'boss@example.com');
  assert.match(env.call('setEmail', { userId: 'U2', email: 'not-an-email' }).error, /格式不對/);
  assert.match(env.call('setEmail', { userId: 'U9', email: 'a@b.co' }).error, /還沒登記/);
  assert.equal(env.call('members').members.length, 2);
});

test('daily digest: owners get theirs, managers get the summary, nothing when nothing is due', () => {
  const env = makeEnv(); env.g.setup();
  env.sheets.get('設定').data.forEach((r) => { if (r[0] === '週末是否寄信') r[1] = '是'; if (r[0] === '總表收件人') r[1] = 'head@example.com, boss@example.com'; });
  env.sheets.get('成員').appendRow(['小王', 'wang@example.com', '成員', '', 'U1']);
  env.sheets.get('成員').appendRow(['王主任', 'boss@example.com', '主管', '', 'U2']);
  assert.equal(env.call('digest').count, 0, '沒有事項就不寄');
  env.call('add', { title: '逾期的事', owner: '小王', due: iso(-2), priority: '高' });
  env.call('add', { title: '兩天後到期', owner: '小王', due: iso(2) });
  env.call('add', { title: '很久以後', owner: '小王', due: iso(30) });
  env.call('add', { title: '沒 email 的人的事', owner: '小李', due: iso(0) });
  env.call('add', { title: '沒有期限', owner: '小王' });
  env.call('add', { title: '擱置中', owner: '小王', due: iso(-5) }); env.call('update', { id: 6, fields: { status: '擱置' } });
  env.call('add', { title: '已經完成', owner: '小王', due: iso(-1) }); env.call('update', { id: 7, fields: { status: '完成' } });
  const prev = env.call('digest');
  assert.equal(prev.count, 2); assert.equal(prev.sent, false); assert.equal(env.sent.length, 0, '預覽不會寄');
  const r = env.call('digest', { send: true });
  assert.equal(r.sent, true); assert.equal(env.sent.length, 2);
  const owner = env.sent.find((m) => m.to === 'wang@example.com'), summary = env.sent.find((m) => m.to !== 'wang@example.com');
  assert.match(owner.subject, /【待辦提醒】小王：逾期 1 項、1 項快到期/);
  assert.match(owner.body, /#1 逾期的事（期限 \d+\/\d+（週.）?，已逾期 2 天，優先 高）/); assert.match(owner.body, /#2 兩天後到期.*2 天後到期/);
  assert.doesNotMatch(owner.body, /很久以後|沒有期限|擱置中|已經完成/);
  assert.deepEqual(summary.to.split(',').sort(), ['boss@example.com', 'head@example.com'], '主管與總表收件人（不重複）');
  assert.match(summary.subject, /【部門待辦總表】逾期 1 項、2 項快到期/);
  assert.match(summary.body, /■ 小王[\s\S]*■ 小李/); assert.match(summary.body, /沒有登記 email.*小李/);
  assert.equal(summary.name, '待辦提醒'); assert.equal(owner.name, '待辦提醒');
  // 寄信額度不夠
  const env2 = makeEnv({ mailQuota: 1 }); env2.g.setup();
  env2.sheets.get('設定').data.forEach((r) => { if (r[0] === '週末是否寄信') r[1] = '是'; if (r[0] === '總表收件人') r[1] = 'a@x.com'; });
  env2.sheets.get('成員').appendRow(['小王', 'wang@example.com', '成員', '', '']);
  env2.call('add', { title: 't', owner: '小王', due: iso(0) });
  assert.match(env2.call('digest', { send: true }).error, /額度不夠/);
});

test('digest weekend rule and the daily trigger', () => {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  const wd = d.getDay(); // 今天是週末：預設不寄；平日：預設會寄
  const env = makeEnv(); env.g.setup();
  env.sheets.get('成員').appendRow(['小王', 'wang@example.com', '成員', '', '']);
  env.call('add', { title: 't', owner: '小王', due: iso(0) });
  assert.equal(env.call('digest').count, wd === 0 || wd === 6 ? 0 : 1);
  env.g.installDigestTrigger(); env.g.installDigestTrigger();
  assert.equal(env.triggers.length, 1, '重複安裝只會有一個');
  env.g.removeDigestTrigger(); assert.equal(env.triggers.length, 0);
  env.g.installDigestTrigger(); env.g.dailyDigest(); // 不會丟錯
});

test('唯讀資料表：只讀「設定」登記過的表，日期轉成 YYYY-MM-DD，不會寫入', () => {
  const env = makeEnv(); env.g.setup();
  const URL = 'https://docs.google.com/spreadsheets/d/EQUIP/edit';
  const eq = new Sheet('儀器'); eq.data = [['ES-QA 儀器清單'], ['設備名稱', '編號', '校正到期日', '狀態'], ['HPLC', 'EQ-01', new Date(2026, 10, 27), '使用中'], ['天平', 'EQ-02', new Date(2026, 11, 31), '停用'], ['', '', '', '']];
  eq.readOnly = true;
  env.books.set(URL, { sheets: [new Sheet('封面'), eq] });
  assert.deepEqual(env.call('sources').sources, []);
  assert.match(env.call('readSource', { name: '儀器' }).error, /沒有這份唯讀資料表的網址/);
  const set = env.sheets.get('設定');
  set.appendRow(['唯讀資料表：儀器', URL, '儀器']);
  set.appendRow(['唯讀資料表：亂來', 'https://evil.example.com/x']); // 不是 Google 試算表網址 → 不算
  assert.deepEqual(env.call('sources').sources, [{ name: '儀器', tab: '儀器' }]);
  const r = env.call('readSource', { name: '儀器' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.headers, ['設備名稱', '編號', '校正到期日', '狀態'], '跳過標題上面的大標');
  assert.deepEqual(r.rows, [['HPLC', 'EQ-01', '2026-11-27', '使用中'], ['天平', 'EQ-02', '2026-12-31', '停用']], '空白列略過、日期統一格式');
  // Agent Chat 設定檔直接給網址（不用在「設定」分頁登記）；非 Google 試算表網址一律不收
  const byUrl = env.call('readSource', { name: '儀器2', url: URL, tab: '儀器' }); assert.equal(byUrl.ok, true); assert.equal(byUrl.rows.length, 2);
  assert.match(env.call('readSource', { name: 'x', url: 'https://evil.example.com/spreadsheets/d/abc' }).error, /沒有這份唯讀資料表的網址/);
  // 多分頁（一廠,三廠）：一次讀回來
  env.books.get(URL).sheets.push(Object.assign(new Sheet('三廠'), { data: [['設備名稱', '編號', '校正到期日', '狀態'], ['UV', 'EQ-09', new Date(2026, 10, 30), '']] }));
  set.data[set.data.length - 2][2] = '儀器,三廠';
  const mt = env.call('readSource', { name: '儀器' });
  assert.deepEqual(mt.tabs.map((t) => [t.sheet, t.rows.length]), [['儀器', 2], ['三廠', 1]]); assert.equal(mt.tabs[1].rows[0][2], '2026-11-30');
  set.data[set.data.length - 2][2] = '不存在'; assert.match(env.call('readSource', { name: '儀器' }).error, /找不到分頁/);
  set.data[set.data.length - 2][1] = 'https://docs.google.com/spreadsheets/d/NOACCESS/edit'; assert.match(env.call('readSource', { name: '儀器' }).error, /打不開.*檢視者/);
});

test('唯讀資料表：分頁關鍵字（挑今年的）、刪除線、跳過上面的大標', () => {
  const env = makeEnv(); env.g.setup();
  const URL = 'https://docs.google.com/spreadsheets/d/CTRL/edit';
  const y = String(new Date().getFullYear());
  const mk = (name, rows) => Object.assign(new Sheet(name), { data: rows });
  const oos = mk('三廠-' + y + '年OOS', [['三廠 OOS 管制表'], ['', '', '更新：每週'], ['OOS編號', '說明', '狀態', '應結案日期(30個工作天)', '實際結案日期'], ['OOS-01', 'pH 異常', '追蹤', new Date(2026, 10, 1), ''], ['OOS-02', '已作廢', '追蹤', '', ''], ['OOS-03', '含量', '結案', '', '']]);
  oos.strikes.add('5,1'); // OOS-02 的編號有刪除線
  env.books.set(URL, { sheets: [mk('三廠-' + (+y - 1) + '年OOS', [['OOS編號', '狀態'], ['OLD-1', '追蹤']]), oos, mk('一二三廠-CC', [['CC編號', '狀態'], ['CC-1', '追蹤']]), mk('一廠-DE', [['DE編號', '狀態']])] });
  const r = env.call('readSource', { name: '未結案', url: URL, tab: '三廠+OOS,一二三廠+CC,一廠+DE' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.tabs.map((t) => t.sheet), ['三廠-' + y + '年OOS', '一二三廠-CC', '一廠-DE'], '有好幾頁時挑今年的');
  assert.deepEqual(r.tabs[0].headers, ['OOS編號', '說明', '狀態', '應結案日期(30個工作天)', '實際結案日期'], '跳過大標與說明列');
  assert.equal(r.tabs[0].rows.length, 3); assert.equal(r.tabs[0].rows[0][3], '2026-11-01');
  assert.deepEqual(r.tabs[0].strikes, [[1, 0]], '第 2 筆的第 1 欄有刪除線');
  assert.deepEqual(r.tabs[2].rows, [], '沒有資料的分頁也要回來（報告要顯示全部已結案）');
  assert.match(env.call('readSource', { name: '未結案', url: URL, tab: '五廠+OOS' }).error, /找不到分頁：五廠\+OOS/);
});

test('唯讀資料表：Excel 檔（.xlsx）打不開 → 從雲端硬碟原檔唯讀下載交給 Agent Chat', () => {
  const env = makeEnv(); env.g.setup();
  const bytes = makeXlsx({ 'A': [['編號', '狀態'], ['X-1', '追蹤']] });
  env.driveFiles.set('XLSXFILE', { name: 'CAPA總表.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes });
  const r = env.call('readSource', { name: '未結案', url: 'https://docs.google.com/spreadsheets/d/XLSXFILE/edit?gid=1' });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.equal(Buffer.from(r.xlsx, 'base64').equals(bytes), true, '原檔一個 byte 都沒變');
  assert.equal(r.fileName, 'CAPA總表.xlsx'); assert.equal(r.modified, '2026-11-19 17:30');
  env.driveFiles.set('PDF', { name: 'a.pdf', mime: 'application/pdf', bytes: Buffer.from('x') });
  assert.match(env.call('readSource', { name: 'x', url: 'https://docs.google.com/spreadsheets/d/PDF/edit' }).error, /不是試算表/);
  env.driveFiles.set('DENY', { name: 'a.xlsx', mime: 'application/vnd.ms-excel', bytes: Buffer.from('x'), denied: true });
  assert.match(env.call('readSource', { name: 'x', url: 'https://docs.google.com/spreadsheets/d/DENY/edit' }).error, /① 初始化.*允許/);
  assert.match(env.call('readSource', { name: 'x', url: 'https://docs.google.com/spreadsheets/d/NOPE/edit' }).error, /打不開/);
});
