@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem ============================================================
rem  Agent Chat 啟動檔
rem  你自己的設定（CLI 路徑、允許的資料夾、遠端連線）請寫在 start.local.bat：
rem  複製 start.local.example.bat、改名成 start.local.bat 再修改。更新時不會被蓋掉。
rem
rem  啟動後可以在網頁左下角「⬆️ 更新／重新啟動」一鍵更新，不用再關掉這個視窗。
rem  安全設計：不自動 taskkill 其他佔用 3939 的程式；請手動確認後關閉舊版本。
rem  登入密碼：第一次啟動會在這個視窗顯示一次。忘記密碼的話，刪除 data\admin-password-hash.json 再重開，會產生新密碼
rem ============================================================
rem 下面整段放在括號裡：cmd 會先整段讀進來再執行，更新時就算這個檔被換掉也不會出錯
(
  if exist start.local.bat call start.local.bat
  start "" http://localhost:3939
  node launcher.js
  echo.
  echo Agent Chat 已停止。
  pause
  exit /b
)
