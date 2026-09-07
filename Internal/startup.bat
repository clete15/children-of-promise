@echo off
cd /d "%~dp0"

REM ── Children Of Promise server launcher ──
REM
REM Two problems this guards against, both of which bit us on 7 Sep 2026:
REM
REM  1. A second copy started while the first was still running. The old loop
REM     treated "port already in use" as a crash and retried every 5 seconds
REM     forever, burning CPU and filling the console, while the ORIGINAL process
REM     carried on serving. Restarting therefore appeared to work while actually
REM     changing nothing, so three deploys of server.js went live-but-not-running.
REM
REM  2. The retry loop restarted on ANY exit, including a deliberate refusal to
REM     start. A server that exits on purpose must stay exited.

echo Starting Children Of Promise server...
echo.

REM ── Refuse to start if something already holds port 80 ──
REM Checking before launching turns a silent 5-second loop into one clear message.
netstat -ano | findstr /R /C:":80 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto :inuse

REM ── Refuse to start without a password, rather than falling back to a default ──
if "%COFP_STAFF_PASSWORD%"=="" goto :nopassword

:loop
echo [%date% %time%] Server starting...
node server.js

REM Exit code 1 is a deliberate refusal (bad config). Restarting cannot fix it,
REM so stop and leave the message on screen instead of scrolling it away.
if errorlevel 1 goto :refused

echo [%date% %time%] Server stopped unexpectedly. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop

:inuse
echo  ============================================================
echo   NOT STARTING: something is already listening on port 80.
echo.
echo   The server is almost certainly already running. Starting a
echo   second copy cannot work, and the copy already running will
echo   keep serving the OLD code - so a restart would appear to
echo   succeed while changing nothing.
echo.
echo   To see what holds it:
echo       Get-Process node ^| Select-Object Id,StartTime
echo.
echo   To restart properly:
echo       Stop-Process -Name node -Force
echo       .\startup.bat
echo  ============================================================
echo.
pause
exit /b 1

:nopassword
echo  ============================================================
echo   NOT STARTING: COFP_STAFF_PASSWORD is not set.
echo.
echo   The staff password is no longer kept in the source code.
echo   Set it once, in an Administrator PowerShell:
echo.
echo       setx COFP_STAFF_PASSWORD "your-new-password" /M
echo.
echo   Then open a NEW console and run this again. setx only
echo   affects processes started after it runs.
echo  ============================================================
echo.
pause
exit /b 1

:refused
echo.
echo  The server refused to start. The reason is printed above.
echo  Not retrying, because a restart will not fix a config problem.
echo.
pause
exit /b 1
