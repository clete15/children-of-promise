@echo off
echo Deploying Children Of Promise...
cd /d C:\app
"C:\Program Files\Git\bin\git.exe" fetch origin
"C:\Program Files\Git\bin\git.exe" reset --hard origin/master
taskkill /F /IM node.exe 2>nul
schtasks /run /tn "CofPServer"
echo Deploy complete!
