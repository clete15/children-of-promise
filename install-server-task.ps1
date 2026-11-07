# Run ONCE on the VPS, in an Administrator PowerShell, after `git pull`.
#
#   Account HAS a Windows password:
#       powershell -ExecutionPolicy Bypass -File C:\app\install-server-task.ps1
#     Starts at boot, whether or not anyone is logged in. Asks for the password.
#
#   Account has NO password (Windows will not store a blank one for a background task):
#       powershell -ExecutionPolicy Bypass -File C:\app\install-server-task.ps1 -NoPassword
#     Starts when you log in to the remote desktop, and keeps running after you
#     DISCONNECT (close the window with the X). It stops if you SIGN OUT, and after a
#     reboot nothing starts until someone logs in.
#
# Either way it replaces the old CofPServer task (which ran node.exe directly, last fired
# 22 Jun 2026, and was never what kept the site up). The new task runs Launch.bat, which
# restarts node itself if it exits, and Task Scheduler restarts Launch.bat if THAT dies.
# It runs as YOUR account because server.js talks to SQL with Windows login (-E) and
# SYSTEM has no SQL login.
#
# It does NOT start the server, so it cannot collide with the node running now.

param([switch]$NoPassword)
$ErrorActionPreference = 'Stop'
$me = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Task will run as: $me"

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c C:\app\Launch.bat' -WorkingDirectory 'C:\app'
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if ($NoPassword) {
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
} else {
    $cred = Get-Credential -UserName $me -Message 'Windows password for this account (stored by Task Scheduler)'
    if (-not $cred) { throw 'No credentials given. Nothing changed.' }
    $trigger = New-ScheduledTaskTrigger -AtStartup
}

# Only now touch the existing task, so a cancelled prompt cannot delete it.
if (Get-ScheduledTask -TaskName CofPServer -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName CofPServer -Confirm:$false
}
if ($NoPassword) {
    Register-ScheduledTask -TaskName CofPServer -InputObject $task | Out-Null
} else {
    Register-ScheduledTask -TaskName CofPServer -Action $action -Trigger $trigger -Settings $settings `
        -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest | Out-Null
}

Get-ScheduledTask -TaskName CofPServer | Select TaskName, State
Write-Host ''
Write-Host 'Installed. To switch over now (a few seconds of downtime):'
Write-Host '    Get-Process node | Stop-Process -Force'
Write-Host '    Start-ScheduledTask -TaskName CofPServer'
Write-Host '    Start-Sleep 8; (Invoke-WebRequest https://childrenofpromisedaycare.com/api/health -UseBasicParsing).Content'
Write-Host ''
Write-Host 'From then on, exits are recorded in C:\app\Internal\server-exits.log'
