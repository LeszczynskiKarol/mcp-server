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

Process supervision: Windows Task Scheduler at user logon →
`start-mcp-hidden.vbs` → `start-mcp.bat` with `:loop ... node server.js ... goto loop`
restart loop. **NO PM2 locally.** The `pm2_status` tool still works on remote
hosts that DO use PM2 — that's fine, just not here.

## Verification per file type

After editing, run exactly this and nothing more:

- `.js` → `node --check <plik>`. STOP.
- `.json` → `node -e "JSON.parse(require('fs').readFileSync('<plik>','utf8'))"`. STOP.
- `.md`, `.txt`, `.bat`, `.vbs`, `.sh`, `.yml` → no verification. Trust the write.

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
  `logs/`. They're gitignored — keep it that way.

## Restart workflow (this MCP server edits itself)

Editing `D:\mcp-server\server.js` doesn't auto-reload — the running node
process must be restarted. Restart kills your current MCP session.

After such a failure:

1. STOP calling tools.
2. Tell me: "server restarted, send a new message to reconnect".
3. Wait. Session resumes when I send any message.

Restart procedure I run: `taskkill /F /IM node.exe` — the `:loop` in
`start-mcp.bat` picks up a new node process within ~5 seconds.

**New tools** added to `server.js` are NOT visible inside the current chat —
the tool list is loaded once at conversation start. After adding a new tool:
restart server → ask me to start a NEW chat (not just a new message in this
one).

NEVER run `pm2 ...` commands locally on this host. PM2 is gone here.

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
