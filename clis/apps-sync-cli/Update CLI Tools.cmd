@echo off
rem Compatibility launcher: the same local-first application.
call "%~dp0Manage Software.cmd" %*
exit /b %errorlevel%
