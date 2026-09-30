@echo off
where py >nul 2>nul
if errorlevel 1 goto python
py -3 "%~dp0remote_sessions.py" %*
goto done
:python
python "%~dp0remote_sessions.py" %*
:done
set "launcherExit=%errorlevel%"
if "%~1"=="" if not "%launcherExit%"=="0" pause
exit /b %launcherExit%
