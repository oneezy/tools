@echo off
rem Compatibility shim: the tool lives in packages\task-manager (oneezy/tools#75).
call "%~dp0..\..\packages\task-manager\task-manager.cmd" %*
exit /b %errorlevel%
