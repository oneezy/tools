@echo off
where py >nul 2>nul
if errorlevel 1 goto python
py -3 "%~dp0skills_sync.py" %*
goto done
:python
python "%~dp0skills_sync.py" %*
:done
set "launcherExit=%errorlevel%"
if "%~1"=="" pause
exit /b %launcherExit%
