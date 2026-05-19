# Instructions for Claude when working on this repo

This file is read by Claude (and other AI assistants) at the start of each session.
Follow these rules to avoid wasting time on common failure modes.

## Project layout

- `server.js` — main MCP server (~1000 lines, single file by design)
- `hosts.json` — gitignored, server/key registry for ssh_exec, postgres_query, pm2_status
- `.env` — gitignored, OAuth password + base URL + tokens
- `oauth-state.json` — gitignored, runtime persistence of OAuth clients/tokens
- PM2 runs the server with `--watch`, so saving server.js auto-reloads in ~2s

## File editing rules (CRITICAL)

When the user is on Windows (D:\mcp-server\) and asks to edit a file, follow these:

### Small edits (< 20 lines of change)

Use `local_exec` with PowerShell `-replace` or `Set-Content`. Do not pipe through cmd.exe with
non-ASCII content — it will mangle UTF-8.

### Large edits (> 20 lines, full file replacement, refactors)

**DO NOT** try to base64-chunk the file through cmd.exe. **DO NOT** write helper scripts
like `edit-server.js` that do the modification. Both approaches fail because:

- cmd.exe has an ~8191 char command-line limit
- Polish/non-ASCII characters get corrupted between sandbox and Windows
- PowerShell `-replace` with multi-line patterns and special chars is unreliable

Instead: **paste the complete new file content in a ```js code block in chat**.
Tell the user: "Save this as `D:\mcp-server\server.js`, then say 'saved' and I'll verify + commit."
After user confirms, run `node --check D:\mcp-server\server.js` then `git diff`, then commit if clean.

### Verification (always)

- After editing any `.js` file: `node --check <file>`
- After editing any `.json` file: `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`
- After commit: `git log -1 --oneline` to confirm

## Commits

- Commit messages in English (repo is international).
- One concept per commit. Don't bundle 5 unrelated changes.
- Use conventional-commit-ish prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `security:`.

## Restart and live-edit gotcha

If Claude is connected via this same MCP server (`mcp.torweb.pl`), then:

- Saving server.js triggers PM2 watch-reload (~2s)
- Reload **kills Claude's current MCP session** — next tool call will fail with "Session terminated"
- After such a failure: stop calling tools, tell the user "server restarted, please send a new
  message to reconnect"
- **Never** call `pm2 restart mcp` or `pm2 stop mcp` mid-session — it disconnects everything

## Anti-loop rules

If 3 consecutive tool calls on the same problem fail or return errors → **stop**. Don't keep
trying variations. Instead:

1. Describe the problem in 2-3 sentences
2. Propose 2-3 different approaches
3. Let the user choose

If something is taking more than ~5 tool calls and there's no visible progress → **stop**.
Propose a Plan B that doesn't involve the same approach.

## Things to NEVER do

- ❌ Do not use the bash sandbox (`bash_tool`) to "edit" files on D:\. The sandbox is Linux,
  it has no access to the Windows filesystem.
- ❌ Do not write helper scripts (`edit-X.js`, `transform-Y.js`) just to apply text edits.
  If the edit is too complex for `str_replace`, hand it to the user as a paste-ready code block.
- ❌ Do not base64-transfer files > 5KB through cmd.exe chunks. Use the paste-in-chat approach.
- ❌ Do not `git push --force`, `git reset --hard`, or rewrite history without explicit "ok"
  from the user.
- ❌ Do not commit `hosts.json`, `.env`, or `oauth-state.json`. They are gitignored — keep it
  that way.

## Style

- Respond in Polish if the user writes in Polish, English otherwise.
- Code, commit messages, file content, README — always English.
- Be concise. No "I'll be happy to help with that!" or "Great question!" preambles.

## When in doubt

Ask. A 30-second clarifying question beats a 20-minute failed implementation.
