'use strict';
// 測試共用：把伺服器需要的原始碼複製到暫存資料夾。
// 自動列出 repo 根目錄所有 .js，新增模組時不必再改每個測試檔的清單。
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.resolve(__dirname, '..');
const SERVER_FILES = fs.readdirSync(SOURCE).filter((f) => f.endsWith('.js')).sort();

// extra：其他要一起複製的檔案（例如 agents.example.json），路徑相對於 repo 根目錄
function copyServer(dir, extra = []) {
  for (const f of [...SERVER_FILES, ...extra]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(SOURCE, f), path.join(dir, f));
  }
}

module.exports = { SOURCE, SERVER_FILES, copyServer };
