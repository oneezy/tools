@echo off
rem Compatibility shim: the tool lives in packages\remote-sessions (oneezy/tools#75).
call "%~dp0..\..\packages\remote-sessions\remote-control.cmd" %*
exit /b %errorlevel%
