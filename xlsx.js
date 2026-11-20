'use strict';
// 📊 讀 .xlsx（Excel 檔）：零相依，用 Node 內建的 zlib 解開 zip，再用正規表示式讀 XML。
// 只讀不寫。會讀出每一格的「顯示用文字」、日期（轉成 YYYY-MM-DD）、以及有沒有刪除線（巡檢規則常用：刪除線＝作廢）。
const zlib = require('zlib');

const MAX_FILE = 40 * 1024 * 1024, MAX_ENTRY = 120 * 1024 * 1024;

// ---------- zip ----------
function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.length > MAX_FILE) throw new Error('不是可以讀的 .xlsx 檔（大小不對）');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是 .xlsx 檔（找不到 zip 目錄）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('.xlsx 檔的 zip 目錄壞了');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    files.set(name, () => {
      if (usize > MAX_ENTRY) throw new Error('.xlsx 檔裡的「' + name + '」太大');
      const l = off, start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }).toString('utf8');
      throw new Error('.xlsx 檔用了不支援的壓縮方式');
    });
  }
  return files;
}

// ---------- XML 小工具 ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));
const attr = (tag, name) => { const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag); return m ? unesc(m[1]) : null; };
const texts = (xml) => { let out = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g; let m; while ((m = re.exec(xml))) out += m[1] ? unesc(m[1]) : ''; return out; };
const isStrike = (rpr) => { const m = /<strike(\s[^>]*)?\/?>/.exec(rpr || ''); return !!m && !/val="(0|false)"/.test(m[1] || ''); };

// 欄位字母 → 0 起算的索引
const colOf = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const p2 = (n) => String(n).padStart(2, '0');
function serialToIso(v) {
  const d = new Date(Math.round((v - 25569) * 86400000));
  return isNaN(d) ? '' : d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
}
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);

// ---------- 讀活頁簿 ----------
// 回傳 { sheets: [名稱...], read(名稱) → { headers?, cells: [[{ v, strike }]] } }；只有讀到的分頁才解析（大檔比較快）
function open(buf) {
  const z = unzip(buf), get = (n) => (z.has(n) ? z.get(n)() : '');
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('不是 .xlsx 檔（沒有 workbook）');
  const rels = new Map(); { const re = /<Relationship\s[^>]*>/g; let m; const x = get('xl/_rels/workbook.xml.rels'); while ((m = re.exec(x))) rels.set(attr(m[0], 'Id'), attr(m[0], 'Target')); }
  const sheets = []; { const re = /<sheet\s[^>]*>/g; let m; while ((m = re.exec(wb))) { const t = rels.get(attr(m[0], 'r:id')) || ''; sheets.push({ name: attr(m[0], 'name'), path: t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''), hidden: attr(m[0], 'state') === 'hidden' || attr(m[0], 'state') === 'veryHidden' }); } }
  // 共用字串：rich text 每一段都有刪除線，才算整格刪除線
  const shared = []; { const x = get('xl/sharedStrings.xml'); const re = /<si>([\s\S]*?)<\/si>|<si\s*\/>/g; let m;
    while ((m = re.exec(x))) { const si = m[1] || ''; const runs = [...si.matchAll(/<r>([\s\S]*?)<\/r>/g)]; shared.push({ v: texts(si), strike: runs.length > 0 && runs.every((r) => isStrike((/<rPr>([\s\S]*?)<\/rPr>/.exec(r[1]) || [])[1])) }); } }
  // 樣式：格式（日期）與字型（刪除線）
  const st = get('xl/styles.xml'), fmts = new Map(), fonts = [], xfs = [];
  { const re = /<numFmt\s[^>]*>/g; let m; while ((m = re.exec(st))) fmts.set(+attr(m[0], 'numFmtId'), attr(m[0], 'formatCode') || ''); }
  { const f = (/<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(st) || [])[1] || ''; const re = /<font>([\s\S]*?)<\/font>|<font\s*\/>/g; let m; while ((m = re.exec(f))) fonts.push(isStrike(m[1] || '')); }
  { const x = (/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st) || [])[1] || ''; const re = /<xf\s[^>]*?(\/>|>)/g; let m;
    while ((m = re.exec(x))) { const id = +(attr(m[0], 'numFmtId') || 0), code = fmts.get(id) || '';
      xfs.push({ strike: !!fonts[+(attr(m[0], 'fontId') || 0)], date: DATE_FMT_IDS.has(id) || (/[ymd]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%\s]+$/.test(code)) }); } }
  function read(name) {
    const sh = sheets.find((s) => s.name === name); if (!sh) throw new Error('找不到分頁：' + name);
    const x = get(sh.path), rows = [];
    const rre = /<row\s[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g; let rm;
    while ((rm = rre.exec(x))) {
      const ri = +(attr(rm[0], 'r') || rows.length + 1) - 1; if (ri > 5000) break;
      const row = []; const cre = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
      while ((cm = cre.exec(rm[1] || ''))) {
        const tag = '<c ' + cm[1] + '>', ref = attr(tag, 'r'), t = attr(tag, 't'), s = +(attr(tag, 's') || 0), inner = cm[2] || '';
        const ci = ref ? colOf(ref) : row.length; if (ci > 60) continue;
        const xf = xfs[s] || {}, vRaw = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        let v = '', strike = !!xf.strike;
        if (t === 's') { const ss = shared[+vRaw] || { v: '' }; v = ss.v; strike = strike || ss.strike; }
        else if (t === 'inlineStr') v = texts(inner);
        else if (t === 'str' || t === 'e') v = vRaw != null ? unesc(vRaw) : '';
        else if (t === 'b') v = vRaw === '1' ? 'TRUE' : 'FALSE';
        else if (vRaw != null && vRaw !== '') { const n = Number(vRaw); v = xf.date && isFinite(n) && n > 0 && n < 2958466 ? serialToIso(n) : String(n); }
        row[ci] = { v: String(v).slice(0, 300), strike };
      }
      rows[ri] = row;
    }
    return { cells: rows.map((r) => (r || []).map((c) => c || { v: '', strike: false })) };
  }
  return { sheets: sheets.map((s) => s.name), hidden: sheets.filter((s) => s.hidden).map((s) => s.name), read };
}

// 讀成跟 Google 試算表一樣的格式：{ sheet, headers, rows, strikes }（strikes＝[[第幾筆, 第幾欄]]，那一格有刪除線）
function toTab(book, name, headerRow = 0) {
  const { cells } = book.read(name);
  const txt = (r) => (cells[r] || []).map((c) => String(c.v || '').replace(/\s+/g, ' ').trim());
  // 標題列：指定第幾列；不然在前 8 列裡找第一個「有字的格子數 ≥ 最多那列的 6 成」的列（跳過上面的大標、說明）——跟 Apps Script 的規則一樣
  let h = 0;
  if (headerRow >= 1 && headerRow <= cells.length) h = headerRow - 1;
  else { const cnt = (i) => txt(i).filter(Boolean).length; let mx = 0; for (let i = 0; i < Math.min(8, cells.length); i++) mx = Math.max(mx, cnt(i)); for (let i = 0; i < Math.min(8, cells.length); i++) if (cnt(i) >= Math.max(2, mx * 0.6)) { h = i; break; } }
  const width = Math.min(60, Math.max(0, ...cells.map((r) => (r || []).length)));
  const hd = txt(h); const headers = Array.from({ length: width }, (_, j) => hd[j] || '第' + (j + 1) + '欄');
  const rows = [], strikes = [];
  for (let r = h + 1; r < cells.length; r++) {
    const row = Array.from({ length: width }, (_, j) => ((cells[r] || [])[j] || {}).v || '');
    if (!row.some((x) => String(x).trim())) continue;
    for (let j = 0; j < width; j++) if (((cells[r] || [])[j] || {}).strike) strikes.push([rows.length, j]);
    rows.push(row);
  }
  return { sheet: name, headers, rows, strikes };
}

// 挑分頁：完全同名；不然「三廠+OOS」＝名稱同時含這些字，有好幾頁就挑今年的、再來是年份最大的（跟 Apps Script 一樣）
function pickSheet(names, spec, year = String(new Date().getFullYear())) {
  if (!spec) return names[0] || null;
  if (names.includes(spec)) return spec;
  const keys = spec.split('+').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const hits = names.filter((n) => keys.every((k) => n.toLowerCase().includes(k)));
  if (hits.length <= 1) return hits[0] || null;
  const cur = hits.filter((n) => n.includes(year)); if (cur.length) return cur[0];
  const yr = (n) => Math.max(0, ...(n.match(/20\d\d/g) || []).map(Number));
  return hits.slice().sort((a, b) => yr(b) - yr(a))[0];
}

module.exports = { open, toTab, unzip, serialToIso, pickSheet };
