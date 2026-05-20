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

## Verification per file type

After editing, run exactly this and nothing more:

- `.js` → `node --check <plik>`. STOP.
- `.json` → `node -e "JSON.parse(require('fs').readFileSync('<plik>','utf8'))"`. STOP.
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
