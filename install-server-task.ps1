# Run ONCE on the VPS, in an Administrator PowerShell, after `git pull`:
#     powershell -ExecutionPolicy Bypass -File C:\app\install-server-task.ps1
#
# Replaces the old CofPServer task (which ran node.exe directly, last fired 22 Jun 2026,
# and was never what kept the site up). The new one:
#   - starts at boot, whether or not anyone is logged in
#   - runs Launch.bat, which restarts node itself if it exits
#   - restarts Launch.bat if THAT dies
#   - runs as YOUR account, because server.js talks to SQL with Windows login (-E)
#     and SYSTEM has no SQL login.
#
# It does NOT start the server for you, so it cannot collide with the node that is
# running now. Restart once at a quiet time (see end of output).

$ErrorActionPreference = 'Stop'
$me = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Task will run as: $me"
$cred = Get-Credential -UserName $me -Message 'Windows password for this account (stored by Task Scheduler)'

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c C:\app\Launch.bat' -WorkingDirectory 'C:\app'
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if (Get-ScheduledTask -TaskName CofPServer -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName CofPServer -Confirm:$false
}
Register-ScheduledTask -TaskName CofPServer -Action $action -Trigger $trigger -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest | Out-Null

Get-ScheduledTask -TaskName CofPServer | Select TaskName, State
Write-Host ''
Write-Host 'Installed. To switch over now (brief downtime, a few seconds):'
Write-Host '    Get-Process node | Stop-Process -Force'
Write-Host '    Start-ScheduledTask -TaskName CofPServer'
Write-Host '    Start-Sleep 8; (Invoke-WebRequest https://childrenofpromisedaycare.com/api/health -UseBasicParsing).Content'
Write-Host ''
Write-Host 'From then on, exits are recorded in C:\app\Internal\server-exits.log'
