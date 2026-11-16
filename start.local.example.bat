@echo off
rem ============================================================
rem  你自己的設定：複製這個檔、改名成 start.local.bat 再修改（start.local.bat 不會進 git，更新時不會被蓋掉）
rem  要啟用某一行，刪掉前面的 rem
rem ============================================================

rem 若自動找不到 CLI，把 where.exe 查到的完整路徑填在下面
rem set CLAUDE_BIN=C:\Users\你的帳號\AppData\Roaming\npm\claude.cmd
rem set CODEX_BIN=C:\Users\你的帳號\AppData\Roaming\npm\codex.cmd

rem 成員要存取 workspace 以外的資料夾時，把那些資料夾（或它們的上層資料夾）加進白名單，多個用分號分隔
rem set AGENT_ALLOWED_ROOTS=C:\EM_reports_copy

rem 用手機 / Tailscale 遠端連線時才需要（本機使用不用設定）
rem set HOST=0.0.0.0
rem set ALLOWED_HOSTS=你的Tailscale-IP
