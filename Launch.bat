@echo off
cd /d "%~dp0Internal"
REM -- Children Of Promise server supervisor --
REM
REM This used to be "node server.js" followed by "pause": any exit left the site
REM down until a person pressed a key (3 outages in one week, Oct 2026).
REM
REM Now it restarts node itself and writes every start/exit, with the exit code,
REM to server-exits.log so the next outage has evidence behind it.
REM
REM Exit code 0 = a deliberate restart (the portal's Restart button exits 0 after
REM spawning a fresh Launch.bat), so this loop ends and lets that one take over.
REM Any other exit is treated as a crash and restarted after 5 seconds.
REM Five quick failures in a row (< 30s uptime each) means a config problem that
REM restarting cannot fix, so it stops and says so instead of spinning forever.

set LOG=%~dp0Internal\server-exits.log
set FAST=0

if "%COFP_STAFF_PASSWORD%"=="" (
    echo [%date% %time%] NOT STARTING: COFP_STAFF_PASSWORD is not set. >> "%LOG%"
    echo NOT STARTING: COFP_STAFF_PASSWORD is not set. Use: setx COFP_STAFF_PASSWORD "..." /M
    pause
    exit /b 1
)

:loop
for /f %%t in ('powershell -nop -c "[int](Get-Date -UFormat %%s)"') do set T0=%%t
echo [%date% %time%] Server starting. >> "%LOG%"
node server.js
set CODE=%errorlevel%
for /f %%t in ('powershell -nop -c "[int](Get-Date -UFormat %%s)"') do set T1=%%t
set /a UP=%T1%-%T0%
echo [%date% %time%] node exited with code %CODE% after %UP%s. >> "%LOG%"

if "%CODE%"=="0" (
    echo [%date% %time%] Clean exit - handing over to the restart process. >> "%LOG%"
    exit /b 0
)

if %UP% LSS 30 (set /a FAST+=1) else (set FAST=0)
if %FAST% GEQ 5 (
    echo [%date% %time%] GIVING UP: 5 quick failures in a row. Check the messages above. >> "%LOG%"
    echo.
    echo Server failed 5 times in a row within seconds of starting.
    echo Restarting will not fix this. Read the error printed above.
    pause
    exit /b 1
)

echo [%date% %time%] Restarting in 5 seconds... >> "%LOG%"
timeout /t 5 /nobreak >nul
goto loop
