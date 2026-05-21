# cleanup-tmp.ps1
#
# Universal scratch-file cleanup for the MCP server / Claude workflow.
#
# Cleans TWO locations in one pass:
#
#  1. D:\mcp-server\tmp\ (the designated scratch directory)
#     -> deletes ANY file recursively, regardless of name or extension,
#        older than -MaxAgeHours. Anything in this directory is treated
#        as disposable by convention.
#
#  2. D:\ root (NOT recursive)
#     -> deletes files matching well-known scratch / throwaway naming
#        patterns (tmp_*, temp_*, _tmp*, _temp*, scratch_*, claude_*,
#        mcp_*, draft_*, *.tmp, *.bak, *~, test_utf8.*, ...), older
#        than -RootMaxAgeHours. Other files at D:\ root are left alone.
#
# This is the single source of truth for scratch cleanup. It is safe to
# run unattended from Task Scheduler — it never deletes files outside
# tmp\ unless they match the scratch patterns at D:\ root specifically.
#
# Usage:
#   # Defaults: tmp\ >24h, D:\ root scratch >24h, real delete
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\mcp-server\cleanup-tmp.ps1
#
#   # Tighter age for both:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\mcp-server\cleanup-tmp.ps1 -MaxAgeHours 1 -RootMaxAgeHours 1
#
#   # Preview without deleting:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\mcp-server\cleanup-tmp.ps1 -DryRun
#
#   # Skip the D:\ root sweep (only clean tmp\):
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\mcp-server\cleanup-tmp.ps1 -SkipRoot

[CmdletBinding()]
param(
    [int]$MaxAgeHours = 24,
    [int]$RootMaxAgeHours = 24,
    [switch]$DryRun,
    [switch]$SkipRoot
)

$ErrorActionPreference = 'Stop'

$TmpDir   = 'D:\mcp-server\tmp'
$LogDir   = 'D:\mcp-server\logs'
$LogFile  = Join-Path $LogDir 'cleanup-tmp.log'
$RootDrive = 'D:\'

# Patterns considered scratch / throwaway at D:\ root. Expand here when
# you spot a new naming convention Claude or any tool is leaving behind.
$RootPatterns = @(
    'tmp_*', 'temp_*', '_tmp*', '_temp*',
    'scratch_*', 'scratch.*',
    'claude_*', 'mcp_*',
    'draft_*', 'out_*.txt', 'output_*.txt',
    'chunk_*.txt', '_part_*',
    'test_utf8.*', 'test_*.tmp',
    '*.tmp', '*.bak', '*.old', '*~', '*.scratch'
)

# Patterns to EXCLUDE at D:\ root even if they matched above (defensive
# allowlist for real files you keep at root that happen to match).
$RootExclude = @(
    # add explicit filenames here if a real file ever gets caught
)

# --- setup ---
if (-not (Test-Path $TmpDir)) { New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log([string]$msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

$mode = if ($DryRun) { 'DRY-RUN' } else { 'DELETE' }
Write-Log "start mode=$mode tmp=$TmpDir maxAgeHours=$MaxAgeHours rootMaxAgeHours=$RootMaxAgeHours skipRoot=$SkipRoot"

$totalFiles = 0
$totalBytes = 0L

# --- 1. tmp directory: blanket cleanup ---
$cutoffTmp = (Get-Date).AddHours(-$MaxAgeHours)
$tmpStale = Get-ChildItem -LiteralPath $TmpDir -Recurse -Force -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cutoffTmp }

foreach ($f in $tmpStale) {
    $totalFiles++
    $totalBytes += $f.Length
    if ($DryRun) {
        Write-Log ('  [tmp] would-delete {0} ({1:N0} bytes, mtime {2:yyyy-MM-dd HH:mm})' -f $f.FullName, $f.Length, $f.LastWriteTime)
    } else {
        try {
            Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
            Write-Log ('  [tmp] deleted {0} ({1:N0} bytes)' -f $f.FullName, $f.Length)
        } catch {
            Write-Log ('  [tmp] FAILED {0} -- {1}' -f $f.FullName, $_.Exception.Message)
        }
    }
}

# remove empty subdirs left behind in tmp\ (keep tmp\ itself)
if (-not $DryRun) {
    Get-ChildItem -LiteralPath $TmpDir -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        ForEach-Object {
            if (-not (Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue)) {
                try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; Write-Log ('  [tmp] rmdir {0}' -f $_.FullName) } catch {}
            }
        }
}

# --- 2. D:\ root sweep: pattern-based ---
if (-not $SkipRoot) {
    $cutoffRoot = (Get-Date).AddHours(-$RootMaxAgeHours)
    $rootHits = foreach ($pat in $RootPatterns) {
        Get-ChildItem -LiteralPath $RootDrive -File -Filter $pat -Force -ErrorAction SilentlyContinue
    }
    $rootHits = $rootHits |
        Sort-Object FullName -Unique |
        Where-Object { $_.LastWriteTime -lt $cutoffRoot } |
        Where-Object { $RootExclude -notcontains $_.Name }

    foreach ($f in $rootHits) {
        $totalFiles++
        $totalBytes += $f.Length
        if ($DryRun) {
            Write-Log ('  [root] would-delete {0} ({1:N0} bytes, mtime {2:yyyy-MM-dd HH:mm})' -f $f.FullName, $f.Length, $f.LastWriteTime)
        } else {
            try {
                Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
                Write-Log ('  [root] deleted {0} ({1:N0} bytes)' -f $f.FullName, $f.Length)
            } catch {
                Write-Log ('  [root] FAILED {0} -- {1}' -f $f.FullName, $_.Exception.Message)
            }
        }
    }
}

Write-Log ('done files={0} bytes={1:N0}' -f $totalFiles, $totalBytes)
