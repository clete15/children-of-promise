@echo off
cd /d "%~dp0Internal"
echo Starting Children Of Promise...
start "" "http://localhost/staff/"
node server.js
pause
