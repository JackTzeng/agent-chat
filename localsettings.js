// 你自己的設定：local-settings.txt（不進 git，更新時不會被蓋掉）
// 格式：一行一個「名稱=值」，# 開頭是註解。中文路徑沒問題（UTF-8 或記事本預設的 Big5 都讀得懂）。
// 伺服器啟動時讀取，所以改完按網頁的「🔄 只重新啟動」就會生效，不用重開 start.bat。
// 舊版放在 start.bat／start.local.bat 的 set 設定，會自動搬進來。
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = 'local-settings.txt';
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('big5').decode(buf); } catch {}
  return buf.toString('latin1');
}
const unquote = (v) => { v = v.trim(); return /^"(.*)"$/.test(v) || /^'(.*)'$/.test(v) ? v.slice(1, -1) : v; };

// 「名稱=值」與 batch 的「set 名稱=值」都接受
function parse(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^(rem\b|::|@echo)/i.test(line)) continue;
    let l = line.replace(/^set\s+/i, '');
    if (/^".*"$/.test(l)) l = l.slice(1, -1); // set "名稱=值"
    const i = l.indexOf('=');
    if (i < 1) continue;
    const k = l.slice(0, i).trim();
    if (KEY.test(k)) out[k.toUpperCase()] = unquote(l.slice(i + 1));
  }
  return out;
}
const readText = (f) => { try { return decode(fs.readFileSync(f)); } catch { return null; } };

// 把 batch 檔裡的 set 設定搬進 local-settings.txt（已經有的名稱不覆蓋）；回傳搬了哪些行
function migrateFromBat(root, batName) {
  const text = readText(path.join(root, batName));
  if (text == null) return [];
  const sets = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^set\s+"?[A-Za-z_]\w*=/i.test(l));
  if (!sets.length) return [];
  const file = path.join(root, FILE);
  const have = readText(file) || '';
  const known = parse(have);
  const add = sets.filter((l) => { const k = Object.keys(parse(l))[0]; return k && !(k in known); });
  if (!add.length) return [];
  const lines = add.map((l) => { const [k, v] = Object.entries(parse(l))[0]; return k + '=' + v; });
  const head = have ? '' : '# 你自己的設定（不進 git，更新時不會被蓋掉）。一行一個「名稱=值」，# 開頭是註解。\r\n# 改完按網頁左下角「⬆️ 更新／重新啟動」→「🔄 只重新啟動」就會生效。\r\n';
  fs.writeFileSync(file, (have && !/\n$/.test(have) ? have + '\r\n' : have) + head + '# 從 ' + batName + ' 搬過來的設定\r\n' + lines.join('\r\n') + '\r\n');
  return lines;
}

// 啟動時呼叫：先搬舊設定，再把 local-settings.txt 的值放進 process.env（檔案裡的值優先）
function load(root, env = process.env) {
  const moved = [...migrateFromBat(root, 'start.local.bat')];
  const text = readText(path.join(root, FILE));
  const values = text == null ? {} : parse(text);
  for (const [k, v] of Object.entries(values)) env[k] = v;
  return { file: path.join(root, FILE), exists: text != null, keys: Object.keys(values), moved };
}

module.exports = { FILE, parse, load, migrateFromBat };
