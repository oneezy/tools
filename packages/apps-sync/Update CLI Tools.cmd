@echo off
rem Compatibility launcher: the same local-first application.
call "%~dp0App Sync.cmd" %*
exit /b %errorlevel%
