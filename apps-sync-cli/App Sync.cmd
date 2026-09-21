@echo off
setlocal
title App Updater
set "UPDATER_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%UPDATER_PWSH%" (
  echo PowerShell 7 is unavailable. See README.md for setup.
  pause
  exit /b 1
)
"%UPDATER_PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Manage-Software.ps1" %*
set "UPDATER_EXIT=%errorlevel%"
echo.
echo App Updater exited with code %UPDATER_EXIT%.
pause
exit /b %UPDATER_EXIT%
