# Instructions for Claude when working on this repo

This file is read by Claude (and other AI assistants) at the start of each
session. The CORE rules (Trust the write, sandbox isolation, anti-loop,
artifacts vs MCP, file-tool hierarchy, Windows path escaping, chunking long
outputs) live in my Anthropic user preferences and apply to ALL repos.
See `CLAUDE_PREFERENCES.md` in this repo for the full text.

This file adds context specific to `mcp-server`.

## Project layout

- `server.js` — main MCP server (single file by design, ~1700 lines after
  hardening). Don't split into multiple files unless I explicitly ask.
- `hosts.json` — gitignored, server/key registry for `ssh_exec`,
  `postgres_query`, `pm2_status`.
- `.env` — gitignored, OAuth password + base URL + GitHub token.
- `oauth-state.json` — gitignored, runtime persistence of OAuth clients and
  tokens (tokens stored sha256-hashed, never plaintext).
- `known_hosts` — gitignored, SSH host fingerprints (pinned on first connect).
- `logs/mcp.log` — gitignored.
- `.pid` — gitignored, server.js writes its own PID here on boot. Used by
  `restart-mcp.ps1` to find the exact node.exe to kill.
- `restart-mcp.ps1` — selective restart (see Restart workflow below).
- `watchdog.ps1` — runs every 2 minutes via Task Scheduler "MCP Server
  Watchdog", respawns the server if both the node.exe AND its start-mcp.bat
  loop are dead. Logs to `logs/watchdog.log`.
- `tmp/` — gitignored, designated scratch directory. Anything written here
  is treated as disposable and gets pruned by `cleanup-tmp.ps1` (see Scratch
  files convention below).
- `cleanup-tmp.ps1` — Task Scheduler "MCP Tmp Cleanup" (hourly), universal
  scratch cleanup. In one pass:
    1. Deletes ANY file in `tmp/` older than `-MaxAgeHours` (default 24),
       regardless of name / extension. Recursive.
    2. Sweeps `D:\` root for files matching scratch patterns (`tmp_*`,
       `temp_*`, `_tmp*`, `_temp*`, `scratch_*`, `claude_*`, `mcp_*`,
       `draft_*`, `out_*.txt`, `output_*.txt`, `chunk_*.txt`, `_part_*`,
       `test_utf8.*`, `test_*.tmp`, `*.tmp`, `*.bak`, `*.old`, `*~`,
       `*.scratch`) older than `-RootMaxAgeHours` (default 24).
  Flags: `-DryRun`, `-SkipRoot`, `-MaxAgeHours N`, `-RootMaxAgeHours N`.
  Add new patterns to `$RootPatterns` in the script when needed; protect
  specific real files via `$RootExclude`. Logs to `logs/cleanup-tmp.log`.

Process supervision:

1. Task Scheduler "MCP Server" at user logon → `start-mcp-hidden.vbs` →
   `start-mcp.bat` (which has `:loop ... node server.js ... goto loop`). This
   handles normal `node` crashes — the loop respawns in ~5s.
2. Task Scheduler "MCP Server Watchdog" every 2 minutes → `watchdog.ps1`.
   This handles the case where the `start-mcp.bat` itself died (typically
   from Ctrl+C in an interactive console). If no `mcp-server\server.js`
   process is found, watchdog launches `start-mcp-hidden.vbs` again.

**NO PM2 locally.** The `pm2_status` tool still works on remote hosts that
DO use PM2 — that's fine, just not here.

## Scratch files convention

When you need to write an intermediate / throwaway file (a partial chunk
buffer, a regex test, a `tmp_*` log, anything not a real project artifact),
write it to:

```
D:\mcp-server\tmp\
```

NOT to `D:\` root, NOT to `D:\tmp\` (that's used by other tools), NOT to
the project directory you're working on. Filename inside `tmp\` is free —
use a task-scoped name like `D:\mcp-server\tmp\jwu_source.txt` or
`D:\mcp-server\tmp\<task>_part.txt` for chunked writes.

A scheduled task (`cleanup-tmp.ps1`, hourly) deletes anything in this
directory older than 24h. You do NOT need to clean up after yourself —
the system handles it. If you want to clean immediately, just call
`local_exec` with `powershell -NoProfile -ExecutionPolicy Bypass -File D:\mcp-server\cleanup-tmp.ps1 -MaxAgeHours 0`.

This replaces the older "D:/tmp_<task>_part.txt" pattern referenced in
CLAUDE_PREFERENCES.md — that pattern produced scattered orphaned files
at `D:\` root with no cleanup story.

## Verification per file type

After editing, run exactly this and nothing more:

- `.js` → `node --check <file>`. STOP.
- `.json` → `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`. STOP.
- `.md`, `.txt`, `.bat`, `.vbs`, `.sh`, `.yml`, `.ps1` → no verification. Trust the write.

Do NOT re-read the file to "make sure it saved". `write_file` returned bytes =
it saved.

## Commits

- Messages in English (public repo on GitHub, international audience).
- One concept per commit. Don't bundle unrelated changes.
- Conventional prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
  `security:`.
- NEVER `git push --force`, `git reset --hard`, or rewrite history without my
  explicit "ok".
- NEVER commit `hosts.json`, `.env`, `oauth-state.json`, `known_hosts`,
  `logs/`, `.pid`. They're gitignored — keep it that way.

## Restart workflow (this MCP server edits itself)

Editing `D:\mcp-server\server.js` doesn't auto-reload — the running node
process must be restarted. Restart kills your current MCP session.

### CORRECT restart procedure (use this)

```
powershell -NoProfile -ExecutionPolicy Bypass -File D:\mcp-server\restart-mcp.ps1
```

This script:

1. Reads `.pid` to find the exact MCP node.exe and stops only that PID.
2. Falls back to scanning `Get-CimInstance Win32_Process` for node.exe
   processes whose CommandLine matches `mcp-server\server.js` — selective
   match, can't hit unrelated node processes.
3. Waits 6s for `start-mcp.bat`'s `:loop` to respawn.
4. If nothing came back up (loop is dead), launches
   `start-mcp-hidden.vbs` fresh.

After such a failure:

1. STOP calling tools.
2. Tell me: "server restarted, send a new message to reconnect".
3. Wait. Session resumes when I send any message.

### NEVER do this — globally fatal

```
taskkill /F /IM node.exe       <-- KILLS EVERY node.exe ON THIS BOX
```

That includes any running **Claude Code** sessions (it's a node CLI),
`npx`-launched MCP plugins, Vite/Astro/Next dev servers, etc. Use
`restart-mcp.ps1` instead. The script's command-line filter ensures only the
MCP node gets terminated.

**New tools** added to `server.js` are NOT visible inside the current chat —
the tool list is loaded once at conversation start. After adding a new tool:
restart server → ask me to start a NEW chat (not just a new message in this
one).

NEVER run `pm2 ...` commands locally on this host. PM2 is gone here.

## Named hosts and AWS SG auto-sync

`ssh_exec` accepts two call forms:

- **Preferred:** `host=<name from hosts.json>` (e.g. `host=matury`). No `key`
  or `user` needed — both come from hosts.json. The tool's description string
  lists the available named hosts at call time, so Claude.ai sees them in the
  schema directly.
- **Legacy:** `host=<raw IP/DNS>` + `key=<key name>`. Skips SG sync — you
  manage AWS allowlisting yourself.

`pm2_status` and `postgres_query` already use the named-host form (it's the
only way they accept input).

When a host entry has `security_group_id` (and optionally `region`, defaults
to `eu-central-1`), every `ssh_exec` / `pm2_status` / `postgres_query` call
runs `ensureSshAccess(host)` first. That helper:

1. Fetches the local public IP from api.ipify.org (5s timeout).
2. Lists current SG ingress rules on port 22.
3. Adds the local IP/32 with `Description='mcp-auto-ssh'` if missing.
4. Revokes any other /32 rules tagged `mcp-auto-ssh` (stale entries from
   previous home-IP sessions).
5. Caches the result per SG for `SG_CHECK_TTL_MS` (default 60000ms) to avoid
   hammering the AWS API on each tool call.

Failure modes are non-fatal — if AWS API errors out (credentials missing,
network down, throttling), `ensureSshAccess` warns to stderr and returns
null. The SSH attempt proceeds against whatever ACL is currently in place.
This mirrors the deploy.yml pattern from matury-online's GitHub Actions.

The local AWS CLI profile (from `~/.aws/credentials` or env vars) must have
`ec2:DescribeSecurityGroups`, `ec2:AuthorizeSecurityGroupIngress`,
`ec2:RevokeSecurityGroupIngress` on the configured SG.

To disable for one host: remove `security_group_id` from its hosts.json
entry. To disable globally: don't set `security_group_id` on any host.

## Persistent SSH connection pool (ssh2)

Since 2026-05-21, `ssh_exec` (named-host path), `pm2_status`, and
`postgres_query` no longer spawn a fresh `ssh` CLI per call. They route
through an in-process pool of `ssh2.Client` instances kept in the
`SSH_POOL` Map (one entry per `hostKey`).

Why: Windows OpenSSH `ControlMaster` is broken (named-pipe stack), so the
CLI can't multiplex. The pool replaces that with in-process persistence.
First call: full SSH handshake (~500-700ms). Subsequent calls within
`SSH_IDLE_TIMEOUT_SECONDS` (default 300s): ~100-200ms total.

Key invariants:

1. **Eviction**: a `setInterval` janitor closes entries idle for more than
   `SSH_IDLE_TIMEOUT_SECONDS`. The interval is `.unref()`-ed so it doesn't
   keep the process alive at shutdown.
2. **Failure recovery**: `client.on('close')` and `client.on('error')`
   delete the pool entry. Next `execSsh` call to that host reconnects.
3. **Liveness probe**: `getSshClient` checks `client._sock.destroyed`
   before reusing — caught dead sockets without paying for a roundtrip.
4. **Cleanup**: `closeAllSshPool()` is wired into the PID-file cleanup
   handler — runs on `SIGINT`, `SIGTERM`, and `process.on('exit')`.
   Hard kills (taskkill /F, port-kill workaround) skip this — orphan
   connections die from server-side keepalive within ~90s.
5. **Concurrency**: if two callers race to create a connection for the
   same host, the second one awaits the first's `connecting` promise
   instead of opening a parallel session.

`execSsh(hostKey, command, opts)` is the public helper. It mimics
`execFileAsync`: throws on non-zero exit with `.stdout`, `.stderr`,
`.code`, `.signal` attached to the error. Existing `try/catch` blocks
work unchanged. Output is capped at `EXEC_BUFFER` (default 10MB); past
that the `.truncated` flag is set and the remote stream is closed.

Raw IP/DNS path of `ssh_exec` (host not in `hosts.json`) still uses the
`ssh` CLI via `execFile` — we don't cache arbitrary IPs.

`resolveKeyPath` and `buildSshArgs` were hoisted to module scope so the
pool can call them. Don't push them back inside the registration block —
they're shared module utilities now.

`postgres_query` error output now includes `--- SQL ---` followed by the
actual SQL (up to 1000 chars). Helps debug what the base64-wrapped
remote command was actually trying to run.

`sftp_download` and `sftp_upload` (added 2026-05-21) use the same pool:
they call `withSftp(hostKey, fn)` which grabs the persistent ssh2 Client
and opens a per-transfer SFTP channel via `client.sftp()`. The SFTP
channel is closed when `fn` settles. Streaming-based — no in-memory
buffering, so file size is not RAM-bound. The motivating use case is
Claude.ai web sessions, where the cloud sandbox has no access to the
local D:\ and no native `scp` — without these tools, file transfer to/
from the VPS is impossible from web Claude.

`restart-mcp.ps1` has a **known bug** as of 2026-05-21: its
`Win32_Process` CommandLine filter pattern `mcp-server[\\/]server\.js`
doesn't match the loop-spawned process whose CommandLine is just
`node  server.js` (relative path, no `mcp-server\`). The script then
reports "no MCP process found to stop" and tries to start fresh →
EADDRINUSE on 4500 → exits 1. Workaround until fixed: kill by listening
port. Fix would be to also match by listening on port 4500 or by parent
process chain.

## OAuth / Express specifics

- Tokens stored sha256-hashed. The migration code in `loadOauthState`
  auto-converts legacy plaintext entries on load — don't break it.
- CSRF is HMAC-signed, stateless. `CSRF_SECRET` is regenerated at boot, so
  login forms opened during a restart will fail submit with "Invalid or
  expired form token". That's intentional, not a bug.
- Rate limiters: `oauthLimiter` (100 / 15min) on /authorize, /token, /revoke;
  `registerLimiter` (10 / hour) on /register. `MAX_CLIENTS = 1000` cap on
  `/oauth/register`.
- `MCP_TRUST_PROXY` env: must NOT be `"true"` (express-rate-limit refuses
  permissive mode). Use `"loopback"` for the nginx + frpc → 127.0.0.1 setup.
- Auto-enroll: a successful login OR token exchange enrolls the source IP's
  **/24** subnet (not /32) for `MCP_ENROLL_TTL_SECONDS` (default 30 days).
  Claude.ai rotates IPs within /24, so a /32 entry breaks the very next
  request. Don't "tighten" this to /32.
- The MCP handler creates a FRESH `McpServer` instance per request (factory
  `createMcpServer()`). Don't refactor to a shared singleton — concurrent
  requests on a shared instance throw "Already connected to a transport" and
  crash the process.

## write_file defensive limits

The `write_file` tool enforces two protections to prevent silent corruption:

1. **Path control character check** — paths containing TAB / CR / LF / NUL
   are rejected with explicit JSON-escape advice. This catches the common
   `"D:\temp\..."` bug where `\t` becomes a literal TAB before reaching
   `fs.mkdir`.
2. **50KB hard limit on mode='overwrite'** — large overwrite writes are at
   high risk of being truncated mid-stream by output limits or overload
   retries. Beyond 50KB, callers must chunk via `mode='append'` (chunk by
   chunk, each piece durable on disk). Threshold values: HARD_LIMIT 50KB,
   WARN_LIMIT 30KB (logs warning, still proceeds).

Don't relax these without strong reason. They saved real work from being
lost on 2026-05-19 / 20.

## When in doubt about this repo

Ask. A 30-second clarifying question beats 20 minutes of broken auth code in
production.
