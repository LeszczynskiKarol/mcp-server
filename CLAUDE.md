# Instructions for Claude when working on this repo

This file is read by Claude (and other AI assistants) at the start of each session.
Follow these rules to avoid wasting time on common failure modes.

## Project layout

- `server.js` — main MCP server (~1100 lines, single file by design)
- `hosts.json` — gitignored, server/key registry for ssh_exec, postgres_query, pm2_status
- `.env` — gitignored, OAuth password + base URL + tokens
- `oauth-state.json` — gitignored, runtime persistence of OAuth clients/tokens
- The server runs as a Windows process started by Task Scheduler at user logon (via `start-mcp-hidden.vbs` → `start-mcp.bat`). No PM2. Logs go to `D:\mcp-server\logs\mcp.log`.

## File editing rules (CRITICAL)

### Workflow rules — do not waste roundtrips

- Read the file ONCE. Do not re-read it after every edit "to verify". Trust the write.
- Do NOT make backup copies (`*.bak`, `*.original`). The user has git.
- Do NOT create intermediate files in the sandbox just to mirror the Windows file.
- Do NOT call `find`, `dir`, `ls`, or "what's available" probes when you already know the path.
- After `write_file`, run `node --check` if it's JS. That's the verification. Done.

When the user is on Windows (D:\mcp-server\ or anywhere else) and asks to edit or create a file:

### Always prefer `write_file` over shell-based approaches

The `write_file` tool writes any text content directly via Node.js `fs.writeFile`. Full UTF-8,
no quoting, no chunking, no command-line length limits. Use it for:

- Creating new files of any size (markdown, source code, JSON, config)
- Replacing the full contents of an existing file (e.g. refactors, file rewrites)
- Any time the diff would be > 20 lines or contain non-ASCII characters

Example: `write_file(path: "D:\\projects\\app\\index.js", content: "...", mode: "overwrite")`.

### Small in-place edits (< 20 lines, surgical find-and-replace)

For tiny surgical edits to an existing file: `local_exec` with PowerShell `-replace`.
Do NOT pipe through cmd.exe with non-ASCII content — it will mangle UTF-8.

### Editing larger sections of an existing file

Read the current file ONCE (e.g. `Get-Content` via local_exec, or check the previous tool result if you already have it), modify in memory, and write the new version with `write_file` in a SINGLE call. Do NOT make a backup copy first, do NOT save the original to disk, do NOT create `server.original.js` or `server.js.bak` — those steps waste tokens and roundtrips. The user has git for that.

### What NEVER to do

- ❌ Do not base64-chunk files through cmd.exe — use `write_file`
- ❌ Do not write helper scripts (`edit-X.js`, `transform-Y.js`) — use `write_file` directly
- ❌ Do not ask the user to paste a file manually if `write_file` is available

### Verification (always)

- After editing any `.js` file: `node --check <file>`
- After editing any `.json` file: `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`
- After commit: `git log -1 --oneline` to confirm

## Commits

- Commit messages in English (repo is international).
- One concept per commit. Don't bundle 5 unrelated changes.
- Use conventional-commit-ish prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `security:`.

## Restart and live-edit gotcha

If Claude is connected via this same MCP server (`mcp.torweb.pl`):

- The server does NOT auto-reload on file changes. After editing `server.js`, the running process
  must be restarted manually for changes to take effect.
- Restarting kills Claude's current MCP session — the next tool call will fail with
  "Session terminated" or "MCP server connection lost".
- After such a failure: stop calling tools, tell the user "server restarted, please send a new
  message to reconnect". The session resumes when the user sends any message.
- New tools added to `server.js` are not visible inside the current chat — the tool list is loaded
  once at the start of a conversation. After adding a new tool: restart server → ask user to start
  a NEW chat (not just send a new message).

## Anti-loop rules

If 3 consecutive tool calls on the same problem fail or return errors → **stop**. Don't keep
trying variations. Instead:

1. Describe the problem in 2-3 sentences
2. Propose 2-3 different approaches
3. Let the user choose

If something is taking more than ~5 tool calls and there's no visible progress → **stop**.
Propose a Plan B that doesn't involve the same approach.

## Things to NEVER do

- ❌ Do not use a bash sandbox to "edit" files on D:\. There is no sandbox-to-Windows file bridge.
  Use `write_file` and `local_exec` only.
- ❌ Do not write helper scripts just to apply text edits. Use `write_file`.
- ❌ Do not `git push --force`, `git reset --hard`, or rewrite history without explicit "ok"
  from the user.
- ❌ Do not commit `hosts.json`, `.env`, or `oauth-state.json`. They are gitignored — keep it
  that way.
- ❌ Do not run `pm2 ...` commands locally on the host running this MCP server. PM2 is no longer
  used here. (The `pm2_status` tool still works on remote hosts that DO use PM2.)

## Style

- Respond in Polish if the user writes in Polish, English otherwise.
- Code, commit messages, file content, README — always English.
- Be concise. No "I'll be happy to help with that!" or "Great question!" preambles.

## When in doubt

Ask. A 30-second clarifying question beats a 20-minute failed implementation.
