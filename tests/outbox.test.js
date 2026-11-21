'use strict';
// 📮 outbox：暫時送不出去的通知存起來、依序重送、去重、過期放棄、重新啟動後接著送
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, retryableStatus } = require('../outbox');

function harness(extra = {}) {
  let t = 1_000_000;
  const state = {}; let saves = 0;
  const ob = create({ state, saveState: () => { saves++; }, now: () => t, ...extra });
  return { ob, state, advance: (ms) => { t += ms; }, saves: () => saves };
}

test('retryableStatus：連不上、429、5xx 才重送', () => {
  assert.equal(retryableStatus(0), true); assert.equal(retryableStatus(undefined), true);
  assert.equal(retryableStatus(429), true); assert.equal(retryableStatus(503), true);
  assert.equal(retryableStatus(400), false); assert.equal(retryableStatus(401), false); assert.equal(retryableStatus(403), false);
});

test('去重、同一個對象依序送、前一則卡住後面就等', async () => {
  const { ob, state, advance } = harness();
  const sent = []; let fail = true;
  ob.add({ channel: 'x', target: 'u1', payload: { text: 'A' }, error: 'down' });
  ob.add({ channel: 'x', target: 'u1', payload: { text: 'B' } });
  ob.add({ channel: 'x', target: 'u1', payload: { text: 'A' } }); // 重複 → 不會多一筆
  ob.add({ channel: 'x', target: 'u2', payload: { text: 'C' } });
  assert.equal(state.outbox.items.length, 3);
  ob.register('x', async (target, p) => { if (fail && p.text === 'A') return { ok: false, retry: true, error: '還是不行' }; sent.push(target + ':' + p.text); return { ok: true }; });
  await ob.tick();
  assert.deepEqual(sent, [], '還沒到重送時間');
  advance(31e3); await ob.tick();
  assert.deepEqual(sent, ['u2:C'], 'u1 的 A 失敗，B 要等（不亂序）；u2 不受影響');
  const a = state.outbox.items.find((x) => x.payload.text === 'A');
  assert.equal(a.tries, 2); assert.equal(a.lastError, '還是不行'); assert.ok(a.nextAt > 1_000_000 + 31e3 + 50e3, '下一次等更久（退避）');
  fail = false; advance(61e3); await ob.tick();
  assert.deepEqual(sent, ['u2:C', 'u1:A', 'u1:B']);
  assert.equal(state.outbox.items.length, 0);
  assert.deepEqual(ob.snapshot().history.map((h) => h.status), ['sent', 'sent', 'sent']);
});

test('永久錯誤直接放棄；太舊的放棄；頻道沒註冊就先等', async () => {
  const { ob, state, advance } = harness({ maxAgeMs: 3600e3 });
  ob.add({ channel: 'perm', target: 'u', payload: { text: 'x' } });
  ob.add({ channel: 'later', target: 'u', payload: { text: 'y' } });
  ob.register('perm', async () => ({ ok: false, retry: false, error: '403 被封鎖' }));
  advance(31e3); await ob.tick();
  assert.equal(ob.snapshot().history[0].status, 'failed'); assert.match(ob.snapshot().history[0].error, /403/);
  assert.equal(ob.snapshot().pending.length, 1); assert.equal(ob.snapshot().pending[0].waiting, true, '頻道還沒啟動');
  advance(3600e3); await ob.tick();
  assert.equal(state.outbox.items.length, 0);
  assert.match(ob.snapshot().history[0].error, /超過 1 小時/);
});

test('重新啟動：從 state 接著送；手動重送與移除', async () => {
  const { ob, state } = harness();
  ob.add({ channel: 'x', target: 'u', payload: { text: 'kept' } });
  ob.add({ channel: 'x', target: 'u', payload: { text: 'dropme' } });
  const saved = JSON.parse(JSON.stringify(state));
  // 新的程式（同一份 state）
  let t = 1_000_000; const sent = [];
  const ob2 = create({ state: saved, saveState() {}, now: () => t });
  ob2.register('x', async (u, p) => { sent.push(p.text); return { ok: true }; });
  const dropId = saved.outbox.items[1].id;
  ob2.drop(dropId);
  assert.throws(() => ob2.retry(999), /找不到/);
  ob2.retry(saved.outbox.items[0].id); // 不等退避，馬上送
  await ob2.tick();
  assert.deepEqual(sent, ['kept']);
  assert.deepEqual(ob2.snapshot().history.map((h) => h.status), ['sent', 'dropped']);
  const id3 = ob2.add({ channel: 'x', target: 'u', payload: { text: 'new' } }).id;
  assert.ok(id3 > dropId, '編號不會重複');
});

test('送出時丟例外也當成暫時失敗；排隊上限', async () => {
  const { ob, state, advance } = harness();
  ob.register('x', async () => { throw new Error('boom'); });
  ob.add({ channel: 'x', target: 'u', payload: { text: 'a' } });
  advance(31e3); await ob.tick();
  assert.equal(state.outbox.items[0].tries, 2); assert.equal(state.outbox.items[0].lastError, 'boom');
  ob.unregister('x');
  for (let i = 0; i < 205; i++) ob.add({ channel: 'y', target: 'u', payload: { text: 'n' + i } });
  assert.equal(state.outbox.items.length, 200);
  ob.stop();
});
