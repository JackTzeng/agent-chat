@echo off
rem ==================================================================
rem  Agent Chat - start script (ASCII only: cmd.exe misreads UTF-8 text)
rem  Your own settings go in local-settings.txt (copy local-settings.example.txt).
rem  After that, use the web page: "Update / Restart" at the bottom-left.
rem ==================================================================
cd /d "%~dp0"
(
  if exist start.local.bat call start.local.bat
  start "" http://localhost:3939
  node launcher.js
  echo.
  echo Agent Chat stopped. Press any key to close this window.
  pause >nul
  exit /b
)
