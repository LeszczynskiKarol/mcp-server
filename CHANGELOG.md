# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
