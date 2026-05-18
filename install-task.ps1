# install-task.ps1 - register MCP Server as a Windows scheduled task
# Runs hidden at logon, auto-restarts on crash, logs to logs\mcp.log

$ErrorActionPreference = 'Stop'
$TaskName = 'MCP Server'
$BaseDir  = $PSScriptRoot
$User     = "$env:USERDOMAIN\$env:USERNAME"
$VbsFile  = Join-Path $BaseDir 'start-mcp-hidden.vbs'
$BatFile  = Join-Path $BaseDir 'start-mcp.bat'
$XmlFile  = Join-Path $BaseDir 'mcp-task.generated.xml'

Write-Host "Installing scheduled task '$TaskName'"
Write-Host "  user: $User"
Write-Host "  base: $BaseDir"

# 1. VBS wrapper that hides the cmd window
$vbs = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & "$BatFile" & Chr(34), 0
Set WshShell = Nothing
"@
[System.IO.File]::WriteAllText($VbsFile, $vbs, [System.Text.Encoding]::ASCII)

# 2. Task XML
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$User</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"$VbsFile"</Arguments>
    </Exec>
  </Actions>
</Task>
"@
[System.IO.File]::WriteAllText($XmlFile, $xml, [System.Text.Encoding]::Unicode)

# 3. Register
& schtasks.exe /create /tn $TaskName /xml $XmlFile /f
if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Done."
Write-Host "  Start now: schtasks /run /tn `"$TaskName`""
Write-Host "  Check:     schtasks /query /tn `"$TaskName`""
Write-Host "  Remove:    schtasks /delete /tn `"$TaskName`" /f"