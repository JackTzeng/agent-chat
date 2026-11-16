'use strict';
// 關子程式要連「孫程式」一起關：模擬 cmd.exe 裡面再開 claude／codex 的情況，不能留下殘留的程式
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const proctree = require('../proctree');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 已經結束、只是還沒被回收的（zombie，容器裡常見）也算關掉了
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(require('node:fs').readFileSync('/proc/' + pid + '/stat', 'utf8')); } catch { return true; }
};

test('Windows: taskkill /T /F on the whole tree', () => {
  const calls = [];
  const fake = { pid: 4321, exitCode: null, kill() { calls.push('kill'); } };
  assert.equal(proctree.killTree(fake, { platform: 'win32', spawn: (cmd, args) => { calls.push([cmd, ...args]); return { on() {} }; } }), true);
  assert.deepEqual(calls, [['taskkill', '/pid', '4321', '/T', '/F']]);
  assert.equal(proctree.killTree({ pid: 1, exitCode: 0 }, { platform: 'win32', spawn: () => { throw new Error('不該呼叫'); } }), false, '已經結束的不用關');
});

test('kills grandchildren started through a shell, and killAll cleans tracked processes', { skip: process.platform === 'win32' }, async () => {
  const start = () => {
    const p = proctree.track(spawn("sh -c 'sleep 60 & echo $!; wait'", { shell: true, stdio: ['ignore', 'pipe', 'ignore'], ...proctree.groupOpts() }));
    return new Promise((resolve) => p.stdout.once('data', (d) => { const grandchild = Number(String(d).trim()); assert.ok(grandchild > 1); resolve({ p, grandchild }); }));
  };
  const a = await start();
  assert.ok(alive(a.grandchild));
  proctree.killTree(a.p);
  for (let i = 0; i < 40 && alive(a.grandchild); i++) await sleep(50);
  assert.equal(alive(a.grandchild), false, '孫程式也被關掉');

  const b = await start(), c = await start();
  assert.ok(proctree.live.size >= 2);
  assert.ok(proctree.killAll() >= 2);
  for (let i = 0; i < 40 && (alive(b.grandchild) || alive(c.grandchild)); i++) await sleep(50);
  assert.equal(alive(b.grandchild) || alive(c.grandchild), false);
  for (let i = 0; i < 40 && proctree.live.size; i++) await sleep(50);
  assert.equal(proctree.live.size, 0, '結束後就不再追蹤');
});
