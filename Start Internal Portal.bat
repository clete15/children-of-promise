@echo off
cd /d "%~dp0Internal"
echo ============================================
echo  Children Of Promise - Internal Portal
echo ============================================

REM Check if the server is already running on port 3000
netstat -ano | findstr ":3000 " >nul 2>&1
if %errorlevel% == 0 (
    echo Server is already running on port 3000.
) else (
    echo Starting Node.js server...
    start /b "" "C:\Program Files\nodejs\node.exe" server.js
    echo Waiting for server to start...
    timeout /t 2 /nobreak >nul
)

echo Opening portal...
start "" "%~dp0index.html"
timeout /t 3 /nobreak >nul
