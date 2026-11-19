'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { context } = require('../recall');
const { create } = require('../harness');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('scope, direct identifier, history beyond the recent ten, and literal source order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agent = { id: 'pm', team: 'A', cwd: dir };
  const h = create({ DATA_DIR: dir, CONFIG: {}, AGENTS: [agent], agentById: () => agent, teamById: (id) => ({ id }), broadcast() {} });
  h.addMemory('decision', 'run07 核准後可重跑', null, null, 'A');
  h.addMemory('decision', 'run07 已取消', null, null, 'A');
  h.addMemory('decision', 'run070 混淆編號', null, null, 'A');
  h.addMemory('decision', 'run07 他組資料', null, null, 'B');
  h.addMemory('note', 'run07 一般備註', null, null, 'A');
  for (let n = 0; n < 12; n++) h.addMemory('decision', '其他決策 ' + n);
  assert.doesNotMatch(h.memoryText(agent), /run07/);
  const found = await context('現在還能不能跑 run07？', () => h.recallDecisions(agent));
  assert.match(found, /"id":2[^\n]*run07 已取消[\s\S]*"id":1[^\n]*核准後/);
  assert.doesNotMatch(found, /混淆|他組|備註/);
  assert.deepEqual(h.recallDecisions({ ...agent, standalone: true }), []);
  assert.equal(await context('早安', () => { throw new Error('unnecessary read'); }), '');
});

test('semantic results resolve to current allowed originals, failure falls back locally', async () => {
  let items = [{ id: 1, ts: 1, text: '更新資料庫', author: 'PM' }, { id: 2, ts: 2, text: '操作手冊', author: 'QA' }];
  const read = () => items;
  const stale = await context('查決策 操作方式', read, { search: async () => { items = items.slice(0, 1); return [2, 999]; } });
  assert.doesNotMatch(stale, /操作手冊|999/);
  const fallback = await context('/recall 資料庫', read, { search: async () => { throw new Error('offline'); } });
  assert.match(fallback, /關鍵字搜尋[\s\S]*更新資料庫/);
});
