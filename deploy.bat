@echo off
echo Deploying Children Of Promise...
cd /d C:\app
"C:\Program Files\Git\bin\git.exe" pull
net stop CofPServer
net start CofPServer
echo Deploy complete!
