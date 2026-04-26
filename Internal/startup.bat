@echo off
cd /d "%~dp0"
echo Starting Children Of Promise server...
start "" http://localhost:3000
"C:\Program Files\nodejs\node.exe" server.js
pause
