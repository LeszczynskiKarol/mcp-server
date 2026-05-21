# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`sftp_download` and `sftp_upload` tools** — stream files between the
  local filesystem and a named host over SFTP, reusing the persistent SSH
  pool. Motivating use case: Claude.ai web sessions, where the cloud
  sandbox has no access to the local disk and no native `scp` — without
  these tools, file transfer to/from the VPS is impossible. Streaming-
  based, so file size is not RAM-bound. `sftp_upload` accepts an
  optional `mode` flag (POSIX octal). Parent dir must exist on the
  remote (mkdir not auto-created — call `ssh_exec` with `mkdir -p`
  first if needed).
- **Persistent in-process ssh2 connection pool.** `ssh_exec` (named-host
  path), `pm2_status`, `postgres_query` now reuse a long-lived
  `ssh2.Client` per host instead of spawning a fresh OpenSSH CLI per
  call. First call to a host: full handshake (~500-700ms). Subsequent
  calls within `SSH_IDLE_TIMEOUT_SECONDS` (default 300s): ~100-200ms
  total. Windows OpenSSH `ControlMaster` is broken (named-pipe issues),
  so the persistence is in-process. New env var:
  `SSH_IDLE_TIMEOUT_SECONDS`. New dependency: `ssh2`.
- **Cross-process respawn lock** (`.respawn.lock`). `restart-mcp.ps1`
  and `watchdog.ps1` now coordinate before spawning a fresh
  `start-mcp-hidden.vbs`. Lock format: `{PID} {ticks}`. Stale if older
  than 30s OR the holder PID is dead. Prevents the multi-loop race
  that produced 280+ ghost `cmd.exe` processes over hours of
  accumulated watchdog false-negatives.
- **Vitest test suite** (35 tests across `tests/auth-utils.test.js`,
  `tests/ssh-pool.test.js`, `tests/validation.test.js`). Covers pure
  helpers, the SSH pool with mocked `ssh2`, and input validation
  helpers. Run with `npm test` (single run) or `npm run test:watch`
  (watch mode). New devDependency: `vitest`.
- `MCP_TEST_MODE` env var gates `app.listen()` and signal handlers so
  the server module can be imported by tests without binding to port
  4500. `ensureSshAccess` is also a no-op in test mode so tests don't
  hit AWS.
- Internal helpers `hasControlChar(s)` and `isValidDatabaseName(name)`
  exported for testing and DRY across `write_file`, `local_exec`,
  `sftp_upload`, `sftp_download`, and `postgres_query`.

### Fixed

- **`restart-mcp.ps1` could not detect the running MCP** when the
  process was spawned by `start-mcp.bat :loop`. The bat does
  `cd /d D:\mcp-server` then `node server.js`, so the resulting
  `CommandLine` is just `node  server.js` (relative path), and the
  existing regex `mcp-server[\\/]server\.js` never matched. The
  script reported "no MCP process found", tried a fresh start, hit
  EADDRINUSE, and exited 1. Now: Path 3 fallback resolves the
  process by listening port 4500 with parent-process verification
  (must trace to `start-mcp.bat` or `mcp-server`). Same root-cause
  bug fixed in `watchdog.ps1`, which had been spawning ghost VBS
  launchers every 2 minutes for an unknown duration before this
  fix.
- `restart-mcp.ps1` waited a fixed 6 seconds for `start-mcp.bat :loop`
  to respawn the server. The loop does `timeout /t 5 /nobreak` plus
  ~1-2s of Node bootstrap, so the wait often timed out and the
  script fell through to a fresh-launch path, creating a second
  `:loop`. Replaced with a 12-second polling loop that checks port
  4500 every 500ms — returns immediately on respawn.
- **Race condition in the SSH connection pool.** `getSshClient` set
  the pool entry AFTER two `await` points (`ensureSshAccess` +
  `fs.readFile`), so 3 concurrent callers each saw an empty pool
  and created 3 separate `ssh2.Client` instances (2 leaked). Now
  the slot is reserved synchronously before any await. Reuse check
  uses the client's underlying socket liveness instead of the
  `connecting` flag (microtask-order-safe). Caught by a unit test
  in the new suite.
- The path control-character check in `sftp_upload`/`sftp_download`
  used regex `/[\x00-\x08\x0B\x0C\x0E-\x1F]/`, which did NOT catch
  TAB, LF, or CR — but the error message claimed it did ("TAB/
  CR/LF/NUL"). The parallel check in `local_exec`/`write_file` used
  the correct `/[\t\r\n\0\v\f]/`. Unified into a single helper
  (`hasControlChar`) using the strict regex.
- Em-dash gotcha in `restart-mcp.ps1`: Windows PowerShell 5.1 parses
  `.ps1` files without BOM as Windows-1252. UTF-8 bytes for em-dash
  (`E2 80 94`) then decode as `â € "` and the embedded close-quote
  character prematurely terminates the surrounding string literal,
  cascading into "Missing closing '}'" parser errors. Replaced
  em-dashes with ASCII hyphens.

### Changed

- All inline copies of the path-control-character regex and the
  database-name regex are replaced by single-source-of-truth helpers
  (`hasControlChar`, `isValidDatabaseName`). Behavior unchanged for
  the regexes that were already correct; behavior tightened for
  the SFTP path-validation one (now also rejects TAB/CR/LF/NUL, as
  intended).
- `postgres_query` error output now appends `--- SQL ---` followed
  by a preview of the actual SQL (up to 1000 chars). The base64-
  wrapped remote command was unreadable in error context; the
  preview lets the caller see what they tried to run.
- `resolveKeyPath` and `buildSshArgs` hoisted from the
  tool-registration block to module scope so the persistent SSH
  pool helpers can call them.

## [1.1.0] - 2026-05-18

### Added

- `/oauth/revoke` endpoint (RFC 7009) for invalidating access and refresh
  tokens. Advertised via `revocation_endpoint` in the discovery document.
- **Dynamic IP allowlist** with auto-enroll: after a successful OAuth login,
  the requesting `/24` subnet is automatically allowlisted for 30 days
  (configurable). Static IPs/CIDRs can be added via `MCP_ALLOWED_IPS`.
  When an unknown IP hits `/mcp` the server replies 401 with
  `WWW-Authenticate` so the client re-runs OAuth and the new subnet is
  enrolled transparently.
- Anti-clickjacking on the OAuth login form: `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'` via `helmet`.
- Windows autostart via Task Scheduler: `install-task.bat` +
  `install-task.ps1` register a hidden, auto-restarting task scoped to the
  current user (`%USERDOMAIN%\%USERNAME%`). Logs go to `logs/mcp.log`.
- New environment variables: `MCP_ALLOWED_IPS`, `MCP_TRUST_PROXY`,
  `MCP_AUTO_ENROLL`, `MCP_ENROLL_TTL_SECONDS`, `OAUTH_STATE_FILE`,
  `CLIENT_TTL_SECONDS`, `EXEC_TIMEOUT_SECONDS`.
- Refresh tokens are now persisted to `oauth-state.json` alongside access
  tokens; node restart no longer forces re-authorization in Claude.ai.

### Changed

- `grant_types_supported` in the discovery document now correctly lists
  `refresh_token` in addition to `authorization_code`.
- `MCP_TRUST_PROXY` accepts `loopback`, a comma-separated list of trusted
  proxy IPs/CIDRs, or `true` (permissive — rate limiter will reject this
  in production, so use only for local testing). Previously only `true`
  was supported, which triggered an `express-rate-limit` validation error.
- Windows autostart documentation switched from PM2 (incompatible with
  Node 25's named-pipe handling — `EPERM \\.\pipe\rpc.sock`) to Task
  Scheduler.

### Fixed

- **Refresh token rotation now actually validates the incoming token.**
  Previously `/oauth/token` with `grant_type=refresh_token` would mint a
  new access token without checking that the supplied refresh token
  existed or belonged to the requesting client. Any string would do.
- `/oauth/token` now verifies `codeData.client_id === req.body.client_id`
  before issuing tokens (RFC 6749 §4.1.3).
- `/oauth/token` and `/oauth/revoke` now enforce `client_secret` when the
  client has one registered. Previously the secret was issued at
  registration but never checked.
- Prototype pollution in `book_note`: keys `__proto__`, `constructor`,
  `prototype` are now rejected in `get`, `set` and `append` operations.
- `.env.example`: corrected mismatched comment/value for
  `EXEC_TIMEOUT_SECONDS` (was `default 120` with value `720`).

### Security

- Refresh tokens are now rotated on use: the old refresh token is
  invalidated as soon as a new pair is issued.
- The OAuth state file (`oauth-state.json`) is added to `.gitignore`.
- See [SECURITY.md](SECURITY.md) for the full list of implemented
  security features and the recommended deployment posture (FRP/nginx
  with `X-Forwarded-For`, `MCP_TRUST_PROXY=loopback`).

### Removed

- `ecosystem.config.cjs` (PM2 config). PM2 currently fails with `EPERM`
  on Windows + Node 25; Task Scheduler is the new recommended approach.

## [1.0.0] - 2026-05-18

### Added

- Initial public release.
- OAuth 2.1 with PKCE and Dynamic Client Registration for Claude.ai integration.
- Tools: `aws_cli`, `ssh_exec`, `local_exec`, `github_api`, `postgres_query`, `pm2_status`.
- Book editing tools (`book_split`, `book_chunk`, `book_note`) for iterative work
  on long documents that exceed the context window.
- Configuration via `.env` (secrets) and `hosts.json` (server list).
- Cross-platform key path resolution (Windows, Linux, macOS).
- Configurable token TTL, port, exec buffer size and server name via environment.
- Token logs redacted (only `client_id` and `expires_in` logged, not token values).
