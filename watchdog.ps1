# watchdog.ps1
# Run every 2 minutes by Task Scheduler. If the MCP server process is missing
# (start-mcp.bat's :loop got killed, e.g. Ctrl+C in its console), respawn via
# start-mcp-hidden.vbs. Cheap and quiet otherwise.

$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\mcp-server'
$logFile = Join-Path $root 'logs\watchdog.log'
$matchPattern = 'mcp-server[\\\/]server\.js'

function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch {}
}

$alive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match $matchPattern) }

if ($alive) {
    # Server is running, do nothing.
    exit 0
}

Write-Log "MCP server not found, respawning via start-mcp-hidden.vbs"

$vbs = Join-Path $root 'start-mcp-hidden.vbs'
if (-not (Test-Path $vbs)) {
    Write-Log "ERROR: $vbs missing - cannot respawn"
    exit 1
}

try {
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
} catch {
    Write-Log "ERROR: Start-Process failed: $_"
    exit 1
}

Start-Sleep -Seconds 5

$alive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match $matchPattern) }

if ($alive) {
    Write-Log "OK - MCP server respawned (PID $($alive[0].ProcessId))"
    exit 0
} else {
    Write-Log "ERROR: respawn did not produce a running MCP process"
    exit 1
}
