@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 若自動找不到 CLI，把 where.exe 查到的完整路徑填在下面，並刪掉前面的 rem
rem set CLAUDE_BIN=C:\Users\你的帳號\AppData\Roaming\npm\claude.cmd
rem set CODEX_BIN=C:\Users\你的帳號\AppData\Roaming\npm\codex.cmd

rem 安全設計：不自動 taskkill 其他佔用 3939 的程式；請手動確認後關閉舊版本。

rem 成員要存取 workspace 以外的資料夾時，把那些資料夾（或它們的上層資料夾）加進白名單，多個用分號分隔
rem set AGENT_ALLOWED_ROOTS=C:\EM_reports_copy

rem 用手機 / Tailscale 遠端連線時才需要（本機使用不用設定）
rem set HOST=0.0.0.0
rem set ALLOWED_HOSTS=你的Tailscale-IP

rem 登入密碼：第一次啟動會在這個視窗顯示一次。忘記密碼的話，刪除 data\admin-password-hash.json 再重開，會產生新密碼

start "" http://localhost:3939
node server.js
pause
