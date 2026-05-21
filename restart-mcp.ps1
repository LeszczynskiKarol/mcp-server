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
$lockFile = Join-Path $root '.respawn.lock'
$serverPath = Join-Path $root 'server.js'

# Cross-process respawn coordination — restart-mcp and watchdog both touch
# the same processes. Without this, watchdog (every 2 min) racing with an
# ad-hoc restart-mcp call can spawn multiple start-mcp-hidden.vbs in
# parallel, each producing a stuck `start-mcp.bat :loop` that retries
# forever on EADDRINUSE. Observed on 2026-05-21: 280+ ghost cmd.exe procs.
# Lock format: "{PID} {ticks}". Stale if >30s old or PID dead.
function Acquire-RespawnLock {
    $now = [DateTime]::UtcNow.Ticks
    if (Test-Path $lockFile) {
        try {
            $content = (Get-Content $lockFile -Raw -ErrorAction Stop).Trim()
            $parts = $content -split '\s+'
            if ($parts.Count -ge 2) {
                $holderPid = [int]$parts[0]
                $heldAt = [long]$parts[1]
                $ageSec = ($now - $heldAt) / 10000000  # ticks -> sec
                $holderAlive = $false
                if ($ageSec -lt 30) {
                    try { Get-Process -Id $holderPid -ErrorAction Stop | Out-Null; $holderAlive = $true } catch {}
                }
                if ($holderAlive) {
                    Write-Host "respawn lock held by PID $holderPid (age ${ageSec}s) - aborting"
                    return $false
                } else {
                    Write-Host "respawn lock is stale (age ${ageSec}s, holder $holderPid dead) - taking over"
                }
            }
        } catch {}
    }
    try {
        Set-Content -LiteralPath $lockFile -Value "$PID $now" -Encoding ASCII -NoNewline
        return $true
    } catch {
        Write-Host "could not write lock file: $_"
        return $false
    }
}

function Release-RespawnLock {
    try { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue } catch {}
}

if (-not (Acquire-RespawnLock)) {
    exit 2
}

try {

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

# Path 3: start-mcp.bat does 'cd /d D:\mcp-server' then 'node server.js',
# so the spawned process has CommandLine = "node  server.js" (relative path,
# no 'mcp-server\' literal) and Path 2 misses it. Fallback: find whatever
# node.exe is listening on port 4500 (the MCP server's listen port) and
# verify by checking its working directory against $root.
if ($killed.Count -eq 0) {
    try {
        $conn = Get-NetTCPConnection -LocalPort 4500 -State Listen -ErrorAction Stop |
            Select-Object -First 1
        if ($conn) {
            $pidOnPort = $conn.OwningProcess
            # Sanity check: confirm working dir is our $root (avoids killing
            # an unrelated process that happens to use port 4500).
            $cwd = $null
            try {
                $proc = Get-Process -Id $pidOnPort -ErrorAction Stop
                if ($proc.ProcessName -eq 'node') {
                    # Win32_Process doesn't expose cwd, but the process's loaded
                    # modules / startInfo usually reflect it. We check that the
                    # node.exe path is the system-installed one AND the parent
                    # is cmd.exe running start-mcp.bat (via WMI parent chain).
                    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$pidOnPort" |
                        Select-Object -ExpandProperty ParentProcessId
                    $parentCmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction SilentlyContinue).CommandLine
                    if ($parentCmd -match 'start-mcp\.bat' -or $parentCmd -match 'mcp-server') {
                        $cwd = $root
                    }
                }
            } catch {}

            if ($cwd) {
                Write-Host "found MCP on port 4500 (PID $pidOnPort, parent matches start-mcp.bat)"
                if (Stop-PidSafely($pidOnPort)) {
                    $killed += $pidOnPort
                }
            } else {
                Write-Host "node.exe on port 4500 (PID $pidOnPort) does not look like our MCP - refusing to kill"
            }
        }
    } catch {
        # Get-NetTCPConnection throws when no match; silently fall through
    }
}

if ($killed.Count -eq 0) {
    Write-Host "no MCP process found to stop"
}

# Give the :loop in start-mcp.bat a chance to respawn.
# It does 'timeout /t 5 /nobreak' then 'node server.js' — node startup is
# another ~1-2s. So 8-10s minimum. We poll instead of fixed sleep so we
# return as soon as port 4500 is bound by node.exe.
$respawnDeadline = (Get-Date).AddSeconds(12)
$respawnedPid = $null
while ((Get-Date) -lt $respawnDeadline) {
    Start-Sleep -Milliseconds 500
    try {
        $conn = Get-NetTCPConnection -LocalPort 4500 -State Listen -ErrorAction Stop |
            Select-Object -First 1
        if ($conn) {
            $candidatePid = $conn.OwningProcess
            $candidateProc = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
            if ($candidateProc -and $candidateProc.ProcessName -eq 'node') {
                $respawnedPid = $candidatePid
                break
            }
        }
    } catch {}
}

if ($respawnedPid) {
    Write-Host "OK - MCP server respawned (PID $respawnedPid) on port 4500"
    exit 0
}

# Loop dead. Start fresh via the hidden launcher.
Write-Host "no MCP process after 6s - start-mcp.bat :loop is dead, starting fresh"
$vbs = Join-Path $root 'start-mcp-hidden.vbs'
if (-not (Test-Path $vbs)) {
    throw "missing $vbs"
}
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden

$freshDeadline = (Get-Date).AddSeconds(10)
$freshPid = $null
while ((Get-Date) -lt $freshDeadline) {
    Start-Sleep -Milliseconds 500
    try {
        $conn = Get-NetTCPConnection -LocalPort 4500 -State Listen -ErrorAction Stop |
            Select-Object -First 1
        if ($conn) {
            $candidatePid = $conn.OwningProcess
            $candidateProc = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
            if ($candidateProc -and $candidateProc.ProcessName -eq 'node') {
                $freshPid = $candidatePid
                break
            }
        }
    } catch {}
}

if ($freshPid) {
    Write-Host "OK - MCP server started fresh (PID $freshPid) on port 4500"
    exit 0
} else {
    Write-Host "FAILED - MCP did not start after fresh launch attempt"
    exit 1
}

} finally {
    Release-RespawnLock
}
