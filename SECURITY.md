# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it privately.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **kontakt@karol-leszczynski.pl**

Include in your report:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

You can expect an initial response within 72 hours. Once the issue is confirmed, a fix will typically be released within 14 days, depending on severity.

## Scope

This policy applies to the latest released version on the `main` branch.

**In scope:**

- The `server.js` MCP server itself (OAuth flow, token handling, tool execution)
- Configuration loading (`.env`, `hosts.json`)
- Shell command construction in tools (`ssh_exec`, `local_exec`, `postgres_query`, `aws_cli`)

**Out of scope:**

- Vulnerabilities in dependencies that already have an upstream advisory (please report to the upstream project; Dependabot tracks these here automatically)
- Issues that require physical access to the host running this MCP server
- Misconfigurations of the user's own infrastructure (SSH keys, AWS credentials, network exposure)

## Implemented security features

What the server actually enforces today (as of 1.1.0):

### OAuth 2.1 / token handling

- **PKCE with S256 only.** `plain` is rejected.
- **`client_id` match** on `/oauth/token` (authorization code flow) — the code can only be redeemed by the client it was issued to.
- **`client_secret` enforcement** on `/oauth/token` and `/oauth/revoke` — if a client has a secret registered, every call must present it (constant-time compare).
- **Refresh token validation and rotation.** The supplied refresh token must exist, be unexpired and belong to the requesting client. On use, the old token is invalidated and a fresh pair (access + refresh) is issued.
- **Persistent OAuth state.** Clients, access tokens and refresh tokens survive node restarts (atomic write to `oauth-state.json`).
- **Token revocation endpoint** (RFC 7009) at `/oauth/revoke`. Always returns 200 unless client auth fails, to avoid leaking whether a token existed.
- **Token values redacted in logs.** Only `client_id`, first 8 chars of token, and `expires_in` are logged.
- **Expired-entry cleanup** runs every 60 s for auth codes, access tokens, refresh tokens and unused clients.

### Network / transport

- **Dynamic IP allowlist with auto-enroll.** After a successful OAuth login the requesting `/24` subnet is allowlisted for 30 days. Unknown IPs get 401 + `WWW-Authenticate`, prompting the client to re-run OAuth so a new subnet is enrolled. Static IPs/CIDRs can be configured via `MCP_ALLOWED_IPS`.
- **Narrow `trust proxy` setting.** `MCP_TRUST_PROXY=loopback` is the recommended value for the FRP/nginx topology. Setting `true` is rejected by `express-rate-limit` because it would let any client spoof `X-Forwarded-For` and bypass rate limiting.
- **Rate limit** on `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`: 30 requests / 15 min / IP.
- **HTTPS termination on the VPS** via `certbot` + nginx in the recommended topology — TLS material never reaches your local machine.

### Application

- **Anti-clickjacking on the OAuth login form** via `helmet`: `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.
- **Prototype pollution prevention in `book_note`.** Keys `__proto__`, `constructor` and `prototype` are rejected in `get`, `set` and `append`.
- **Database name validation** in `postgres_query` — `[a-zA-Z0-9_]+` only, no shell metacharacters.
- **SQL passed via stdin** in `postgres_query` (base64 over SSH) to sidestep shell quoting issues.
- **Constant-time string compares** for the OAuth password and `client_secret`.

## Recommended deployment posture

Run the server behind a reverse proxy that terminates TLS and sets `X-Forwarded-For`. With the recommended FRP + nginx topology:

```
.env on the local machine
  MCP_TRUST_PROXY=loopback        # frpc connects to node over 127.0.0.1
  MCP_AUTO_ENROLL=true            # let Claude.ai's egress IP enroll itself on first login
  MCP_ALLOWED_IPS=                # leave empty unless you have a fixed office/VPN IP
  MCP_PASS=<random 20+ chars>     # generate with openssl rand -base64 32
```

If your client IP changes frequently (e.g. consumer ISP, mobile), keep `MCP_AUTO_ENROLL=true`. The first request from a new subnet will get 401 and Claude.ai will silently re-authenticate ( you log in once with your `MCP_PASS` and the new `/24` is added to the allowlist for 30 days.

## Hardening you can apply on top

These are explicit trade-offs the server does **not** make for you:

1. **Read-only AWS profile** for `aws_cli` if you don't need mutations — create dedicated IAM credentials with `ReadOnlyAccess`.
2. **Command whitelist** over `aws_cli` / `local_exec` / `ssh_exec` if you trust Claude less than the AWS console / a teammate.
3. **Pin SSH host keys.** Remove `StrictHostKeyChecking=no` from `ssh_exec` and pre-populate `~/.ssh/known_hosts`.
4. **Audit log to a file** — currently tool calls are logged to stdout (and `logs/mcp.log` under the Task Scheduler setup). Persistent rotation is up to you.
5. **Per-tool ACL.** If you want to restrict which client (e.g. work vs personal Claude.ai account) can call which tool, you'll need a small custom dispatcher in front of `server.tool`.

## Recognition

Reporters who follow responsible disclosure will be credited in the release notes of the version that contains the fix, unless they prefer to remain anonymous.
