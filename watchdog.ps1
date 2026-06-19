# watchdog.ps1
# Run every 2 minutes by Task Scheduler. If the MCP server process is missing
# (start-mcp.bat's :loop got killed, e.g. Ctrl+C in its console), respawn via
# start-mcp-hidden.vbs. Cheap and quiet otherwise.

$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\mcp-server'
$logFile = Join-Path $root 'logs\watchdog.log'
$lockFile = Join-Path $root '.respawn.lock'

function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch {}
}

# Liveness check: node.exe listening on port 4500.
# (Regex-based CommandLine matching used to live here but missed the
# relative-path spawn from start-mcp.bat's :loop, which caused this
# watchdog to spawn a fresh VBS every 2 minutes for hours — leading
# to 280+ accumulated ghost cmd.exe processes by 2026-05-21.)
function Test-McpAlive {
    $conn = Get-NetTCPConnection -LocalPort 4500 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') { return $conn.OwningProcess }
    return $null
}

function Test-McpTunnel {
    # Probes https://mcp.torweb.pl/mcp. Returns:
    #   $true  -> tunnel OK (got 401 — frps reached MCP, Bearer just missing)
    #   $false -> tunnel broken (got 404 from frps, no proxy registered)
    #   $null  -> network error / can't reach frps at all
    try {
        $r = Invoke-WebRequest -Uri 'https://mcp.torweb.pl/mcp' `
            -Method Post `
            -ContentType 'application/json' `
            -Body '{"jsonrpc":"2.0","id":1,"method":"ping"}' `
            -TimeoutSec 8 `
            -UseBasicParsing `
            -ErrorAction Stop
        return $false  # 2xx without auth is unexpected, treat as broken
    } catch {
        $code = $null
        try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
        if ($code -eq 401) { return $true }
        if ($code -eq 404) { return $false }
        return $null
    }
}

function Restart-Frpc {
    Write-Log "frpc tunnel broken (mcp.torweb.pl -> 404), restarting frpc.exe"
    $frpcDir = 'C:\Users\Admin\frp\frp_0.61.1_windows_amd64'
    $frpcExe = Join-Path $frpcDir 'frpc.exe'
    if (-not (Test-Path $frpcExe)) {
        Write-Log "ERROR: $frpcExe missing - cannot restart"
        return $false
    }
    Get-Process -Name frpc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    try {
        Start-Process -FilePath $frpcExe -ArgumentList '-c','frpc.toml' -WorkingDirectory $frpcDir -WindowStyle Hidden
    } catch {
        Write-Log "ERROR: frpc Start-Process failed: $_"
        return $false
    }
    Start-Sleep -Seconds 3
    $tunnelOk = Test-McpTunnel
    if ($tunnelOk -eq $true) {
        Write-Log "OK - frpc restarted, tunnel responding"
        return $true
    }
    Write-Log "ERROR: frpc restarted but tunnel still not responding (Test-McpTunnel returned: $tunnelOk)"
    return $false
}

if (Test-McpAlive) {
    # Local server is running. Verify tunnel too — frpc can die independently
    # of the MCP node process (as happened 2026-05-24: frpc.toml was missing
    # the mcp proxy block, so tunnel returned 404 even though :4500 was alive,
    # which caused 5 wasted Claude runs in claude-egzaminy).
    $tunnel = Test-McpTunnel
    if ($tunnel -eq $false) {
        Restart-Frpc | Out-Null
    }
    exit 0
}

# Coordination with restart-mcp.ps1 — if it's mid-restart we MUST NOT also
# spawn a parallel VBS launcher. Lock format: "{PID} {ticks}". Stale if
# >30s old or PID dead. Same format as restart-mcp.ps1.
$now = [DateTime]::UtcNow.Ticks
if (Test-Path $lockFile) {
    try {
        $content = (Get-Content $lockFile -Raw -ErrorAction Stop).Trim()
        $parts = $content -split '\s+'
        if ($parts.Count -ge 2) {
            $holderPid = [int]$parts[0]
            $heldAt = [long]$parts[1]
            $ageSec = ($now - $heldAt) / 10000000
            $holderAlive = $false
            if ($ageSec -lt 30) {
                try { Get-Process -Id $holderPid -ErrorAction Stop | Out-Null; $holderAlive = $true } catch {}
            }
            if ($holderAlive) {
                Write-Log "respawn lock held by PID $holderPid (age ${ageSec}s) - skipping"
                exit 0
            }
        }
    } catch {}
}
try { Set-Content -LiteralPath $lockFile -Value "$PID $now" -Encoding ASCII -NoNewline } catch {}

try {

Write-Log "MCP server not found (port 4500 unbound), respawning via start-mcp-hidden.vbs"

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

# Poll for up to 10s — node startup + start-mcp.bat's 'timeout /t 5' first
# iteration can take 5-7s total.
$deadline = (Get-Date).AddSeconds(10)
$alivePid = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $alivePid = Test-McpAlive
    if ($alivePid) { break }
}

if ($alivePid) {
    Write-Log "OK - MCP server respawned (PID $alivePid) on port 4500"
    exit 0
} else {
    Write-Log "ERROR: respawn did not produce a running MCP process within 10s"
    exit 1
}

} finally {
    try { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue } catch {}
}
