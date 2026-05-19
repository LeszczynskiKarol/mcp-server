# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
