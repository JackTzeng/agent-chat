@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 若自動找不到 CLI，把 where.exe 查到的完整路徑填在下面，並刪掉前面的 rem
rem set CLAUDE_BIN=C:\Users\你的帳號\AppData\Roaming\npm\claude.cmd
rem set CODEX_BIN=C:\Users\你的帳號\AppData\Roaming\npm\codex.cmd

rem 先關掉還在跑的舊伺服器（佔用 3939 port 的程式）
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3939 ^| findstr LISTENING') do taskkill /pid %%p /f >nul 2>&1

start "" http://localhost:3939
node server.js
pause
