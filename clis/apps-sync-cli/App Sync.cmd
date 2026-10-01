@echo off
rem Compatibility shim: the tool lives in packages\apps-sync (oneezy/tools#75).
call "%~dp0..\..\packages\apps-sync\App Sync.cmd" %*
exit /b %errorlevel%
