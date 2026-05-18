# mcp-server

> **Self-hosted MCP server for Claude.ai**
>
> Give Claude direct access to your AWS account, SSH into your servers, run shell commands on your laptop, query your databases, and manage PM2 processes — all from a Claude chat. **No Claude Code subscription needed. Your keys never leave your machine.**

[![CI](https://github.com/LeszczynskiKarol/mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/LeszczynskiKarol/mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-blue)](https://modelcontextprotocol.io/)

---

## What is this?

A small Node.js MCP server you run on your own machine (laptop, desktop, VPS) and connect to **Claude.ai** (or any MCP client) as a Custom Connector. It exposes a configurable set of tools that let Claude do real work on your infrastructure:

- Run AWS CLI commands using your local profile
- SSH into your servers using your `.pem` keys
- Execute shell commands on your local machine
- Hit the GitHub REST API with your Personal Access Token
- Query PostgreSQL databases on remote hosts via SSH
- Inspect PM2 processes on remote servers
- Iterate over very long documents (book editing) that exceed the context window

**Architecture:**

```
  Claude.ai  ──HTTPS──►  nginx + cert  ──HTTP──►  frps  ──tunnel──►  frpc + node
   (cloud)               on a VPS         :8080    (vhost)            (your PC)
                                                                          │
                                ┌───────────────┬───────────────┬─────────┼─────────┐
                                ▼               ▼               ▼         ▼         ▼
                            AWS CLI       ssh -i *.pem      cmd.exe    psql via   pm2 list
                            (local)       user@host         git/npm      SSH      (remote)
```

SSH keys, GitHub PAT and AWS credentials **never leave your local machine**. The tunnel only carries MCP requests and their results.

---

## Why self-host this?

The MCP ecosystem mostly does two things today:

1. **MCP servers as npm packages** that run via `stdio` and require Claude Desktop.
2. **Hosted MCP services** behind someone else's auth and API limits.

This project is the **third option**: your own MCP server, your keys, your servers, accessible from web Claude.ai (where you already work). It's a single ~900-line `server.js` file that you can read end-to-end in 20 minutes and extend in 5.

**Killer features:**

- ✅ **No Claude Code subscription needed** — works with regular Claude.ai (web)
- ✅ **OAuth 2.1 with PKCE** — proper Claude.ai integration, not a hacky workaround
- ✅ **Your keys stay yours** — SSH keys, GitHub PATs, AWS creds never leave your machine
- ✅ **Self-hostable** — Windows, Linux, Mac, anything that runs Node 18+
- ✅ **Configurable via JSON** — add a new server or new key without touching code
- ✅ **One file to read** — no framework magic, no hidden config

---

## Tools

| Tool | What it does |
|------|--------------|
| `aws_cli` | Run any `aws <command>` using your local AWS CLI profile |
| `ssh_exec` | SSH into any host using a key defined in `hosts.json` |
| `local_exec` | Run any shell command on the local Windows machine (`cmd.exe`) |
| `github_api` | Make REST API requests to GitHub using your Personal Access Token |
| `postgres_query` | Run `psql` queries via SSH (`sudo -u postgres`) on a host from `hosts.json` |
| `pm2_status` | Show `pm2 list` and optional logs on a remote server |
| `book_split` | Split a large text file into ~3000-word chunks |
| `book_chunk` | Read one chunk from a directory created by `book_split` |
| `book_note` | Manage JSON notes for iterative work on long documents |

---

## Requirements

- **Node.js 18+** (tested on 22, 24, 25)
- **SSH `.pem` keys** locally (for hosts you want to control)
- **AWS CLI configured locally** (`aws configure`) — only if you use the `aws_cli` tool
- **A public HTTPS endpoint** — only if you want to expose this to Claude.ai

---

## Quick start

```bash
git clone https://github.com/LeszczynskiKarol/mcp-server.git
cd mcp-server
npm install
cp .env.example .env                # fill in MCP_PASS and MCP_BASE_URL
cp hosts.example.json hosts.json    # add your servers
node server.js
```

You should see:

```
Loaded N hosts and M keys from ./hosts.json
MCP server: my-mcp-server
Port: 4500
MCP listening on :4500
```

That's it for local. To use this from Claude.ai (web), you need to expose it over HTTPS — see [Exposing publicly](#exposing-publicly-claudeai) below.

---

## Configuration

### `.env` (secrets — never commit)

```env
# REQUIRED
MCP_USER=admin
MCP_PASS=<long password, min 20 chars>
MCP_BASE_URL=https://your-domain.com

# OPTIONAL — GitHub integration
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxx
GITHUB_OWNER=YourGitHubUsername

# OPTIONAL — server tuning
PORT=4500
TOKEN_TTL_SECONDS=2592000      # 30 days
AUTH_CODE_TTL_SECONDS=600      # 10 minutes
EXEC_BUFFER_MB=10
MCP_SERVER_NAME=my-mcp-server
HOSTS_CONFIG=./hosts.json
```

### `hosts.json` (server list — never commit)

```json
{
  "hosts": {
    "production": {
      "ip": "1.2.3.4",
      "user": "ubuntu",
      "key": "main",
      "description": "Main production server"
    },
    "staging": {
      "ip": "5.6.7.8",
      "user": "ubuntu",
      "key": "main",
      "description": "Staging environment"
    }
  },
  "keys": {
    "main": "/path/to/main.pem"
  }
}
```

Key paths can use:

- Absolute paths: `D:/keys/server.pem` or `D:\\keys\\server.pem`
- Tilde expansion: `~/keys/server.pem` (resolved to `$HOME` / `%USERPROFILE%`)
- Forward slashes work on Windows too

---

## Exposing publicly (Claude.ai)

Claude.ai requires HTTPS. The recommended setup uses **FRP** (Fast Reverse Proxy) + **nginx** + **Let's Encrypt** on a small VPS.

### 1. DNS record

```
mcp.your-domain.com    A    <VPS_IP>    TTL 300
```

### 2. nginx vhost on VPS

`/etc/nginx/sites-available/mcp.your-domain.com`:

```nginx
server {
    server_name mcp.your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / long-lived MCP connections
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
    listen 80;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mcp.your-domain.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d mcp.your-domain.com
```

### 3. FRP server (`frps`) on VPS

`/etc/frp/frps.toml`:

```toml
bindPort = 7000
vhostHTTPPort = 8080
auth.method = "token"
auth.token = "<shared token>"
```

### 4. FRP client (`frpc`) on your local machine

`frpc-mcp.toml`:

```toml
serverAddr = "<VPS_IP>"
serverPort = 7000
auth.method = "token"
auth.token = "<shared token from frps>"

[[proxies]]
name = "mcp"
type = "http"
localPort = 4500
customDomains = ["mcp.your-domain.com"]
```

### 5. Add the connector in Claude.ai

1. Open **Settings → Connectors → Add custom connector**
2. URL: `https://mcp.your-domain.com/mcp` (with `/mcp` suffix!)
3. OAuth Client ID/Secret: **leave empty**
4. Click **Connect** → a login form appears → enter `MCP_USER` and `MCP_PASS` from your `.env`
5. In a chat: `+` → Connectors → toggle this MCP on → **start a new conversation** (tools attach at chat start)

---

## Running on Windows

### Option A: PM2 with auto-reload (recommended)

```bash
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd D:\mcp-server
pm2 start server.js --name mcp --watch --ignore-watch=".env node_modules .git *.log dump.pm2 hosts.json"
pm2 save
```

After this:

- Edit `server.js` → PM2 auto-reloads in 2 seconds
- Node crashes → PM2 restarts it
- Windows login → MCP starts automatically

Daily commands:

```bash
pm2 list                                  # status
pm2 logs mcp --lines 30 --nostream        # logs (snapshot)
pm2 restart mcp                           # manual restart
```

You'll still need the FRP tunnel running. Easiest: a `start-mcp.bat` that only launches `frpc`:

```bat
@echo off
cd /d C:\Users\YourUser\frp\frp_0.61.1_windows_amd64
start "FRP tunnel mcp" /min frpc.exe -c frpc-mcp.toml
```

Add it to Task Scheduler (At startup, with highest privileges).

### Option B: Task Scheduler + `.bat` (without PM2)

`D:\mcp-server\start-mcp.bat`:

```bat
@echo off
cd /d C:\Users\YourUser\frp\frp_0.61.1_windows_amd64
start "FRP tunnel" /min frpc.exe -c frpc-mcp.toml

cd /d D:\mcp-server
start "MCP server" /min cmd /k "node server.js"
```

Add to Task Scheduler with the same settings as Option A.

---

## Extending

### Adding a new host

Edit `hosts.json`:

```json
{
  "hosts": {
    "production": { },
    "new-server": {
      "ip": "5.6.7.8",
      "user": "ubuntu",
      "key": "main",
      "description": "New server"
    }
  }
}
```

PM2 with `--watch` will auto-reload. **In Claude.ai, disconnect and reconnect the connector** so it sees the new host in the `host` parameter dropdown.

### Adding a new SSH key

```json
{
  "keys": {
    "main": "/path/to/main.pem",
    "client-x": "~/keys/client-x.pem"
  }
}
```

### Adding a new tool

In `server.js`:

```javascript
server.tool(
  "your_tool_name",
  "Clear description of when Claude should use this tool",
  {
    param: z.string().describe("what this parameter does"),
  },
  async ({ param }) => {
    // your logic here
    return { content: [{ type: "text", text: "result" }] };
  },
);
```

After saving, PM2 (with `--watch`) auto-reloads. **Disconnect and reconnect the connector in Claude.ai** to see the new tool.

---

## Security

- **OAuth 2.1 with PKCE** and Dynamic Client Registration
- **Access tokens valid for 30 days** (configurable via `TOKEN_TTL_SECONDS`)
- **Local credentials stay local** — SSH keys, AWS creds, GitHub PAT never sent over the wire
- **401 + `WWW-Authenticate`** for unauthorized requests
- **Token values redacted** in logs (only `client_id` and `expires_in` logged)
- **Secret scanning enabled** on this repo by default

### Production hardening recommendations

1. **Read-only AWS profile** for `aws_cli` if you don't need mutations — create dedicated IAM credentials
2. **Whitelist commands** in `aws_cli` (e.g. allow only `describe-*`, `list-*`)
3. **Remove `StrictHostKeyChecking=no`** from `ssh_exec` and pre-populate `~/.ssh/known_hosts`
4. **Audit log** — write each tool call to a file with timestamp + client_id
5. **Persist OAuth state** — currently tokens are in memory; node restart = re-authorize from Claude.ai
6. **Rate limiting** on `/oauth/*` endpoints (e.g. `express-rate-limit`)
7. **Check `.gitignore`** — must include `.env`, `hosts.json`, `dump.pm2`, `node_modules`, `*.log`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Couldn't reach the MCP server` in Claude.ai | URL without `/mcp` | Use `https://domain/mcp` (with suffix) |
| `404 Not Found` from nginx | No vhost for the subdomain | Create vhost + run certbot |
| `502 Bad Gateway` | frpc not running or node crashed | Check `pm2 list` and frpc process |
| `connect EPERM \\.\pipe\rpc.sock` | PM2 daemon corrupted | `rm -rf ~/.pm2 && npm uninstall -g pm2 && npm install -g pm2` |
| `EADDRINUSE :4500` | Another node running on port 4500 | `Get-Process node \| Stop-Process -Force` in PowerShell as admin |
| `MCP_PASS - hasło do logowania` at startup | Missing `.env` | `cp .env.example .env` and fill in |
| `hosts.json not loaded` | Missing `hosts.json` | `cp hosts.example.json hosts.json` and fill in |
| `Unknown key 'xxx'` on SSH | Key not defined in `hosts.json` | Add it to the `keys` section |
| `ssh_exec` returns "Permission denied (publickey)" | Wrong user for the host | In `hosts.json` set the right user (usually `ubuntu` for Ubuntu AMIs, `ec2-user` for Amazon Linux) |
| `pm2: command not found` via `pm2_status` | NVM on remote host - non-interactive shell doesn't load nvm.sh | Tool handles this automatically (base64 + nvm.sh sourcing). Make sure NVM is in `$HOME/.nvm` on the remote |
| Claude sees connector but no tools | Toggle is off, or old chat session | `+` → Connectors → toggle on → **start a new conversation** |
| Changed tools, Claude shows old ones | MCP schema cache | Settings → Connectors → Disconnect → Connect |

---

## Project files

```
mcp-server/
├── server.js              # MCP server (Express + StreamableHTTP + OAuth)
├── package.json
├── .env                   # (gitignored) secrets
├── .env.example
├── hosts.json             # (gitignored) server list
├── hosts.example.json
├── .gitignore
├── README.md              # English (this file)
├── README.pl.md           # Polish translation
├── LICENSE
├── CHANGELOG.md
├── CONTRIBUTING.md
├── setup.bat              # quick start for Windows
├── setup.sh               # quick start for Linux/Mac
└── start-mcp.bat          # autostart FRP tunnel (Windows)
```

---

## Compatibility

| MCP Client | Status |
|------------|--------|
| Claude.ai (web) | ✅ Primary target — fully tested |
| Claude Desktop | ⚠️ Should work with the same connector URL, untested |
| Custom MCP client (with OAuth 2.1) | ✅ Standard implementation |
| Custom MCP client (without OAuth) | ❌ Requires modification — OAuth is mandatory in current code |

---

## Roadmap

Ideas for future versions (PRs welcome):

- [ ] Persistent OAuth state (SQLite) so node restart doesn't kill connections
- [ ] Audit log to file (`audit.log` with rotation)
- [ ] Per-tool ACL (which client can use which tool)
- [ ] Read-only mode for AWS / SSH (whitelist of safe commands)
- [ ] Docker Compose for one-command deployment
- [ ] More tools: S3 upload, CloudWatch logs, Sentry, Stripe
- [ ] Multi-user authentication (OIDC integration: Google / GitHub login)

---

## License

[MIT](LICENSE) © 2026 Karol Leszczynski

---

## Contributing

Pull requests welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

For questions or ideas, use [GitHub Discussions](https://github.com/LeszczynskiKarol/mcp-server/discussions) instead of issues.

---

🇵🇱 **Polski README**: [README.pl.md](README.pl.md)
