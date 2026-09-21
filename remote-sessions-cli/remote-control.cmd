@echo off
rem Double-click: starts every Claude Remote Control server, or stops them all if any are running.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0remote-control.ps1" toggle
echo.
timeout /t 4 >nul
