# restart-mcp.ps1
# Selective restart of the MCP server. Does NOT touch other node.exe processes
# (Claude Code, npx-launched MCP plugins, dev servers, etc.).
#
# Strategy:
# 1. Read .pid file (server.js writes it on boot). Stop that PID.
# 2. Fallback: scan node.exe processes whose CommandLine references this
#    server.js path. Stop them.
# 3. Trigger start-mcp-hidden.vbs if no MCP process remains after kill.
#    Otherwise rely on start-mcp.bat's :loop to restart automatically.

$ErrorActionPreference = 'Stop'
$root = 'D:\mcp-server'
$pidFile = Join-Path $root '.pid'
$serverPath = Join-Path $root 'server.js'

function Stop-PidSafely($pid_) {
    try {
        $p = Get-Process -Id $pid_ -ErrorAction Stop
        # Sanity check: must be node.exe
        if ($p.ProcessName -ne 'node') {
            Write-Host "PID $pid_ is '$($p.ProcessName)', not node - SKIPPING"
            return $false
        }
        Stop-Process -Id $pid_ -Force
        Write-Host "stopped node.exe PID $pid_"
        return $true
    } catch {
        return $false
    }
}

$killed = @()

# Path 1: read .pid file
if (Test-Path $pidFile) {
    $pidContent = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($pidContent -match '^\d+$') {
        if (Stop-PidSafely([int]$pidContent)) {
            $killed += [int]$pidContent
        }
    }
}

# Path 2: scan command lines for processes still running with this server.js
$matchPattern = 'mcp-server[\\\/]server\.js'
$candidates = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object {
        $_.CommandLine -and ($_.CommandLine -match $matchPattern) -and ($killed -notcontains $_.ProcessId)
    }
foreach ($c in $candidates) {
    if (Stop-PidSafely($c.ProcessId)) {
        $killed += $c.ProcessId
    }
}

if ($killed.Count -eq 0) {
    Write-Host "no MCP process found to stop"
}

# Give the :loop in start-mcp.bat a chance to respawn
Start-Sleep -Seconds 6

# Verify a new process came up
$alive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match $matchPattern) }

if ($alive) {
    Write-Host "OK - MCP server respawned (PID $($alive[0].ProcessId))"
    exit 0
}

# Loop dead. Start fresh via the hidden launcher.
Write-Host "no MCP process after 6s - start-mcp.bat :loop is dead, starting fresh"
$vbs = Join-Path $root 'start-mcp-hidden.vbs'
if (-not (Test-Path $vbs)) {
    throw "missing $vbs"
}
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
Start-Sleep -Seconds 4

$alive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match $matchPattern) }
if ($alive) {
    Write-Host "OK - MCP server started fresh (PID $($alive[0].ProcessId))"
    exit 0
} else {
    Write-Host "FAILED - MCP did not start after fresh launch attempt"
    exit 1
}
