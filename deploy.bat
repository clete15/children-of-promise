@echo off
echo Deploying Children Of Promise...
cd /d C:\app
"C:\Program Files\Git\bin\git.exe" pull
taskkill /F /IM node.exe 2>nul
schtasks /run /tn "CofPServer"
echo Deploy complete!
