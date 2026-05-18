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

## Recognition

Reporters who follow responsible disclosure will be credited in the release notes of the version that contains the fix, unless they prefer to remain anonymous.
