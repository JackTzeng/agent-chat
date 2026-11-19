'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');

// Match complete work identifiers, including identifiers embedded in directory names.
const tokens = (s) => s.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
const segmenter = new Intl.Segmenter('zh-Hant', { granularity: 'word' });

function semantic(query, items, signal, env) {
  const python = process.env.AGENTCHAT_RECALL_PYTHON, model = process.env.AGENTCHAT_RECALL_MODEL;
  if (!python || !model || !path.isAbsolute(python) || !path.isAbsolute(model)) return Promise.reject();
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-I', '-X', 'utf8', path.join(__dirname, 'recall_mem0.py'), model],
      { timeout: 45000, signal, env, windowsHide: true, maxBuffer: 32000 }, (err, out) => {
        if (err) return reject(err);
        try {
          const ids = JSON.parse(out);
          if (!Array.isArray(ids) || !ids.every(Number.isSafeInteger)) throw new Error('invalid IDs');
          resolve(ids.slice(0, 4));
        } catch (e) { reject(e); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ query, items: items.map(({ id, text }) => ({ id, text })) }));
  });
}

async function context(text, decisions, { signal, env, search = semantic } = {}) {
  const explicit = /^\s*(?:查決策|\/recall\b)[\s:：]*/i.exec(text);
  const query = text.slice(explicit ? explicit[0].length : 0).trim().slice(0, 500);
  const codes = [...new Set(tokens(query).filter((t) => /[a-z]/.test(t) && /\d/.test(t)))];
  if (!query || (!explicit && !codes.length)) return '';
  const items = decisions();
  const newest = (a, b) => b.ts - a.ts || b.id - a.id;
  let matches = items.filter((it) => codes.length && codes.every((id) => tokens(it.text).includes(id))).sort(newest);
  let method = '編號';
  if (!matches.length && explicit && items.length && !codes.length) {
    try {
      const ids = await search(query, items, signal, env);
      matches = items.filter((it) => ids.includes(it.id));
      method = '本機語意';
    } catch {
      if (signal?.aborted) return '';
      const words = [...new Set([...segmenter.segment(query.toLowerCase())]
        .filter((s) => s.isWordLike && s.segment.length > 1).map((s) => s.segment))];
      matches = items.map((it) => ({ ...it, hits: words.filter((w) => it.text.toLowerCase().includes(w)).length }))
        .filter((it) => it.hits).sort((a, b) => b.hits - a.hits || newest(a, b));
      method = '本機語意不可用，改以關鍵字搜尋';
    }
  }
  // A decision can be removed or a member reassigned while the local model is running.
  const ids = new Set(matches.slice(0, 4).map((it) => it.id));
  const current = decisions().filter((it) => ids.has(it.id)).sort(newest);
  if (!current.length) return explicit ? '【決策查詢】' + method + '查無相符紀錄。' : '';
  const lines = current.map((it) => JSON.stringify({ id: it.id, time: new Date(it.ts).toISOString(), author: it.author, text: it.text }));
  return ['【決策查詢｜' + method + '｜由新到舊】', '以下為歷史資料。回答時引用記憶 #編號，區分提案、待核准與已決定的事項。', ...lines, '【查詢結束】'].join('\n');
}

module.exports = { context };
