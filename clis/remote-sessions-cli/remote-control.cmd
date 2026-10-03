@echo off
rem Double-click the saved-session picker, or pass status/start/resume/stop arguments.
pwsh -NoProfile -File "%~dp0remote-control.ps1" %*
set "launcherExit=%errorlevel%"
if "%~1"=="" if not "%launcherExit%"=="0" pause
exit /b %launcherExit%
