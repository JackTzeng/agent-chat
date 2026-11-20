'use strict';
// 假的 Google 環境（試算表、信箱、鎖、設定、定時器），用來載入並執行真正的 templates/todo/Code.gs。測試共用。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const CODE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'templates', 'todo', 'Code.gs'), 'utf8');
const p2 = (n) => String(n).padStart(2, '0');
const iso = (offset = 0) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };

class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getDataRange() { const w = this.getLastColumn(); return { getNumRows: () => this.data.length, getNumColumns: () => w, getValues: () => this.data.map((r) => { const c = r.slice(); while (c.length < w) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) {
    const self = this;
    return {
      getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (self.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; },
      getDisplayValues() { return this.getValues().map((row) => row.map((v) => (v instanceof Date ? v.getFullYear() + '/' + (v.getMonth() + 1) + '/' + v.getDate() : String(v)))); },
      setValue(v) { self._set(r, c, v); return this; },
      setDataValidation() { return this; }, setNumberFormat() { return this; },
    };
  }
  _set(r, c, v) { if (this.readOnly) throw new Error('不該寫入唯讀的表：' + this.name); while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  appendRow(a) { this.data.push(a.slice()); }
  setFrozenRows() {}
}
function makeEnv({ mailQuota = 100 } = {}) {
  const books = new Map(); // 別人的試算表：網址 → { sheets: [Sheet] }（openByUrl 讀得到的）
  const sheets = new Map(), props = {}, sent = [], alerts = [], triggers = [], cache = new Map();
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new Sheet(n); sheets.set(n, s); return s; },
  };
  const chain = (extra = {}) => new Proxy(extra, { get: (t, k) => (k in t ? t[k] : () => proxy), }); // 任何方法都回傳自己
  const proxy = chain();
  const g = {
    console, Object, JSON, Math, Number, String, Array, Date, Error, parseInt, isNaN, RegExp,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openByUrl: (u) => { const b = books.get(u); if (!b) throw new Error('沒有權限'); return { getSheetByName: (n) => b.sheets.find((x) => x.name === n) || null, getSheets: () => b.sheets, getSpreadsheetTimeZone: () => 'Asia/Taipei' }; },
      getUi: () => ({ createMenu: () => proxy, alert: (m) => alerts.push(m) }),
      newDataValidation: () => ({ requireValueInList() { return this; }, setAllowInvalid() { return this; }, build() { return {}; } }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    ContentService: { createTextOutput: (text) => ({ text, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => { cache.set(k, v); } }) },
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, _tz, fmt) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + (fmt.includes('HH') ? ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) : ''),
    },
    MailApp: { sendEmail: (o) => sent.push(o), getRemainingDailyQuota: () => mailQuota },
    ScriptApp: {
      newTrigger: (fn) => { const t = { fn, timeBased() { return this; }, atHour() { return this; }, nearMinute() { return this; }, everyDays() { return this; }, create() { triggers.push({ fn }); return this; } }; return t; },
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn, _t: t })),
      deleteTrigger: (tr) => { const i = triggers.indexOf(tr._t); if (i >= 0) triggers.splice(i, 1); },
    },
  };
  vm.createContext(g);
  vm.runInContext(CODE, g);
  const call = (op, args = {}, key) => JSON.parse(g.doPost({ postData: { contents: JSON.stringify({ key: key === undefined ? props.KEY : key, op, ...args }) } }).text);
  return { g, call, sheets, props, sent, alerts, triggers, ss, books, cache };
}

module.exports = { makeEnv, iso, Sheet };
