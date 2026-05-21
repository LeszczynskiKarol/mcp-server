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

if (Test-McpAlive) {
    # Server is running, do nothing.
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
