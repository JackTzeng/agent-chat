'use strict';
// 🔐 caps.js：成員的實際能力（任務交接、LINE 群組檢查、權限畫面共用同一套判斷）
const test = require('node:test');
const assert = require('node:assert');
const caps = require('../caps');

const acts = (a) => caps.of(a).acts;

test('Claude：照權限模式、允許的工具、--tools 判斷', () => {
  assert.equal(acts({ engine: 'claude', permissionMode: 'plan' }), false);
  assert.equal(acts({ engine: 'claude', permissionMode: 'default' }), false, 'default＋沒有允許工具：-p 時需要確認的工具會被拒');
  assert.deepEqual(caps.of({ engine: 'claude', permissionMode: 'default', allowedTools: ['Write'] }), { write: true, exec: false, acts: true, label: '可改檔' });
  assert.deepEqual(caps.of({ engine: 'claude', permissionMode: 'default', allowedTools: ['Bash(git status)'] }).exec, true);
  assert.equal(acts({ engine: 'claude', permissionMode: 'default', allowedTools: ['Read', 'WebSearch'] }), false);
  assert.deepEqual(caps.of({ engine: 'claude', permissionMode: 'acceptEdits' }), { write: true, exec: false, acts: true, label: '可改檔' });
  assert.equal(caps.of({ engine: 'claude', permissionMode: 'auto' }).label, '可改檔、可執行指令');
  assert.equal(acts({ engine: 'claude' }), true, '沒填權限模式：CLI 會用使用者自己的預設，保守當成可動手');
  assert.equal(acts({ engine: 'claude', permissionMode: 'auto', tools: 'Read,Grep' }), false, '--tools 沒有寫檔與 Bash 工具就動不了手');
  assert.equal(caps.of({ engine: 'claude', permissionMode: 'auto', tools: 'Read,Bash' }).label, '可執行指令');
});

test('Codex：沒填 sandbox 是 workspace-write（可動手）', () => {
  assert.equal(acts({ engine: 'codex' }), true);
  assert.equal(acts({ engine: 'codex', sandbox: 'workspace-write' }), true);
  assert.equal(acts({ engine: 'codex', sandbox: 'read-only' }), false);
});

test('agy：只看 agyAccess（write 會改檔也會執行指令）', () => {
  assert.equal(acts({ engine: 'agy' }), false);
  assert.equal(acts({ engine: 'agy', agyAccess: 'read' }), false);
  assert.equal(caps.of({ engine: 'agy', agyAccess: 'write' }).label, '可改檔、可執行指令');
});

test('沒有成員', () => { assert.equal(acts(null), false); });
