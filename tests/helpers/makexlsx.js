'use strict';
// 測試用：產生一個真的 .xlsx（zip＋XML），可以指定哪一格有刪除線、哪一格是日期。給 xlsx.js 與 Apps Script 的 Excel 備援路線測試用。
const zlib = require('node:zlib');

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(raw), nb = Buffer.from(name, 'utf8'), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const serial = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000 + 25569;

// sheets: { 名稱: [[格子...]] }；格子可以是字串、數字、{ date: 'YYYY-MM-DD' }、{ v: '文字', strike: true }、{ rich: [['字', 刪除線?], ...] }
function makeXlsx(sheets) {
  const shared = [], sidx = new Map();
  const ss = (key, xml) => { if (!sidx.has(key)) { sidx.set(key, shared.length); shared.push(xml); } return sidx.get(key); };
  const names = Object.keys(sheets), files = {};
  names.forEach((n, i) => {
    const rows = sheets[n].map((row, r) => '<row r="' + (r + 1) + '">' + row.map((c, j) => {
      if (c === '' || c == null) return '';
      const ref = colName(j) + (r + 1);
      if (typeof c === 'number') return '<c r="' + ref + '"><v>' + c + '</v></c>';
      if (c.date) return '<c r="' + ref + '" s="1"><v>' + serial(c.date) + '</v></c>';
      if (c.rich) return '<c r="' + ref + '" t="s"><v>' + ss('rich:' + JSON.stringify(c.rich), '<si>' + c.rich.map(([t, st]) => '<r>' + (st ? '<rPr><strike/></rPr>' : '<rPr><b/></rPr>') + '<t>' + esc(t) + '</t></r>').join('') + '</si>') + '</v></c>';
      const v = typeof c === 'object' ? c.v : c, st = typeof c === 'object' && c.strike;
      return '<c r="' + ref + '" t="s"' + (st ? ' s="2"' : '') + '><v>' + ss('t:' + v, '<si><t xml:space="preserve">' + esc(v) + '</t></si>') + '</v></c>';
    }).join('') + '</row>').join('');
    files['xl/worksheets/sheet' + (i + 1) + '.xml'] = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows + '</sheetData></worksheet>';
  });
  files['xl/workbook.xml'] = '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map((n, i) => '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>';
  files['xl/_rels/workbook.xml.rels'] = '<?xml version="1.0"?><Relationships>' + names.map((n, i) => '<Relationship Id="rId' + (i + 1) + '" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '</Relationships>';
  files['xl/sharedStrings.xml'] = '<?xml version="1.0"?><sst count="' + shared.length + '">' + shared.join('') + '</sst>';
  files['xl/styles.xml'] = '<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts><fonts count="2"><font><sz val="11"/></font><font><strike/><sz val="11"/></font></fonts><cellXfs count="3"><xf numFmtId="0" fontId="0"/><xf numFmtId="164" fontId="0"/><xf numFmtId="0" fontId="1"/></cellXfs></styleSheet>';
  return zip(files);
}

module.exports = { makeXlsx };
