@echo off
cd /d "%~dp0"
echo Starting Children Of Promise server...

:loop
echo [%date% %time%] Server starting...
node server.js
echo [%date% %time%] Server stopped. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
