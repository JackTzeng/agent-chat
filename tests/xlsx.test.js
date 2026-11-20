'use strict';
// 📊 xlsx.js：零相依讀 .xlsx（Excel 檔放在 Google 雲端硬碟、用 Google 試算表檢視的那種）。刪除線、日期、分頁挑選。
const test = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('../xlsx');
const { makeXlsx } = require('./helpers/makexlsx');

test('讀 .xlsx：分頁、標題列、日期、刪除線（儲存格樣式與 rich text）', () => {
  const buf = makeXlsx({
    '封面': [['CAPA/OOS 總表']],
    '三廠-2025年OOS': [['OOS編號', '狀態'], ['OLD-1', '追蹤']],
    '三廠-2026年OOS': [
      ['三廠 OOS 管制表'],
      ['OOS編號', '說明', '狀態', '應結案日期 (30個工作天)', '實際結案日期'],
      ['2026年度'],
      ['OOS-01', 'pH & 異常 <高>', '追蹤', { date: '2026-11-12' }, ''],
      [{ v: 'OOS-02', strike: true }, '作廢', '追蹤', '', ''],
      [{ rich: [['OOS-', true], ['03', true]] }, 'rich 全部刪除線', '追蹤', '', ''],
      [{ rich: [['OOS-', false], ['04', true]] }, 'rich 只有一段', '追蹤', '', ''],
      ['OOS-05', '數字', '結案', 45678, { date: '2026-11-01' }],
    ],
  });
  const book = xlsx.open(buf);
  assert.deepEqual(book.sheets, ['封面', '三廠-2025年OOS', '三廠-2026年OOS']);
  const t = xlsx.toTab(book, '三廠-2026年OOS');
  assert.deepEqual(t.headers, ['OOS編號', '說明', '狀態', '應結案日期 (30個工作天)', '實際結案日期'], '跳過大標');
  assert.equal(t.rows.length, 6, '「2026年度」分隔列還在（由判讀規則處理），空白列不算');
  assert.deepEqual(t.rows[1], ['OOS-01', 'pH & 異常 <高>', '追蹤', '2026-11-12', ''], 'XML 跳脫字元還原、日期轉成 YYYY-MM-DD');
  assert.equal(t.rows[5][3], '45678', '一般數字不當成日期');
  assert.equal(t.rows[5][4], '2026-11-01');
  assert.deepEqual(t.strikes, [[2, 0], [3, 0]], '樣式刪除線、rich text 全部刪除線都算；只有一段刪除線不算');
  assert.equal(xlsx.toTab(book, '三廠-2026年OOS', 2).headers[0], 'OOS編號', '指定標題列');
  // 分頁：關鍵字、挑今年的、再來是年份最大的
  assert.equal(xlsx.pickSheet(book.sheets, '三廠+OOS', '2026'), '三廠-2026年OOS');
  assert.equal(xlsx.pickSheet(book.sheets, '三廠+OOS', '2030'), '三廠-2026年OOS', '沒有今年的就挑年份最大的');
  assert.equal(xlsx.pickSheet(book.sheets, '封面'), '封面');
  assert.equal(xlsx.pickSheet(book.sheets, '五廠+OOS'), null);
  assert.throws(() => xlsx.open(Buffer.from('not a zip at all, definitely not')), /不是 .xlsx 檔/);
});
