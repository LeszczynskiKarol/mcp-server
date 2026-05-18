# MCP Server

Lokalny MCP server dający klientom MCP (Claude.ai, Claude Desktop, custom) bezpośredni dostęp do **AWS CLI**, **SSH na zdalne serwery**, **lokalnego shella**, **GitHub REST API**, **PostgreSQL** i **PM2** na zdalnych serwerach. Wystawiany przez tunel HTTPS z OAuth 2.1.

## Architektura

```
┌─────────────┐   HTTPS    ┌──────────────────┐   HTTP    ┌──────────┐   tunel   ┌─────────────┐
│  Claude.ai  │ ─────────► │  nginx + cert    │ ────────► │   frps   │ ────────► │ frpc + node │
│   (cloud)   │            │   na VPS         │  :8080    │ (vhost)  │           │ (lokalny PC)│
└─────────────┘            └──────────────────┘           └──────────┘           └─────────────┘
                                                                                       │
                                                       ┌───────────────────────────────┼───────────────────────────────┐
                                                       ▼                               ▼                               ▼
                                                 ┌──────────┐                  ┌────────────────┐              ┌──────────────┐
                                                 │ AWS CLI  │                  │ ssh -i *.pem   │              │ cmd.exe      │
                                                 │ (lokal)  │                  │ user@host      │              │ git/npm/...  │
                                                 └──────────┘                  └────────────────┘              └──────────────┘
```

Klucze SSH, GitHub PAT i AWS credentials **nigdy nie opuszczają lokalnej maszyny**. Tunel przenosi tylko żądania MCP i ich wyniki.

## Tools

| Tool             | Co robi                                                      |
| ---------------- | ------------------------------------------------------------ |
| `aws_cli`        | Wykonuje `aws <command>` używając lokalnego profilu AWS CLI  |
| `ssh_exec`       | SSH na dowolny host przez klucz z `hosts.json`               |
| `local_exec`     | Dowolne polecenie shell na lokalnym Windows (cmd.exe)        |
| `github_api`     | Request do GitHub REST API używając Personal Access Token    |
| `postgres_query` | `psql` przez SSH (sudo -u postgres) na hoście z `hosts.json` |
| `pm2_status`     | `pm2 list` + opcjonalne logi na zdalnym hoście               |
| `book_split`     | Dzieli duży plik tekstowy na chunki (~3000 słów)             |
| `book_chunk`     | Czyta jeden chunk z katalogu z `_meta.json`                  |
| `book_note`      | Zarządza notatkami JSON dla iteracyjnej pracy nad książką    |

## Wymagania

- Node.js 18+ (sprawdzone na 22, 24, 25)
- Klucze SSH `.pem` lokalnie (do hostów które chcesz kontrolować)
- AWS CLI skonfigurowane lokalnie (`aws configure`) - tylko jeśli używasz `aws_cli`
- Publiczna domena z HTTPS - jeśli wystawiasz dla Claude.ai

## Quick start

```bash
git clone https://github.com/LeszczynskiKarol/mcp-server.git
cd mcp-server
npm install
cp .env.example .env          # wypełnij MCP_PASS i MCP_BASE_URL
cp hosts.example.json hosts.json   # dodaj swoje serwery
node server.js
```

Powinieneś zobaczyć:

```
Loaded N hosts and M keys from ./hosts.json
MCP server: ...
Port: 4500
MCP listening on :4500
```

## Konfiguracja

### `.env` (sekrety, NIE commitować)

```env
# WYMAGANE
MCP_USER=admin
MCP_PASS=<długie hasło, min 20 znaków>
MCP_BASE_URL=https://your-domain.com

# OPCJONALNE - GitHub
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxx
GITHUB_OWNER=YourGitHubUsername

# OPCJONALNE - tuning
PORT=4500
TOKEN_TTL_SECONDS=2592000      # 30 dni
AUTH_CODE_TTL_SECONDS=600      # 10 min
EXEC_BUFFER_MB=10
MCP_SERVER_NAME=my-mcp-server
HOSTS_CONFIG=./hosts.json
```

### `hosts.json` (lista serwerów, NIE commitować)

```json
{
  "hosts": {
    "production": {
      "ip": "1.2.3.4",
      "user": "ubuntu",
      "key": "main",
      "description": "Główny serwer"
    }
  },
  "keys": {
    "main": "/path/to/key.pem"
  }
}
```

Ścieżki do kluczy mogą używać:

- Absolute paths: `D:/keys/server.pem` lub `D:\\keys\\server.pem`
- Tilde: `~/keys/server.pem` (rozwijane na `$HOME`/`%USERPROFILE%`)
- Forward slashes działają na Windows

## Wystawianie publicznie (Claude.ai)

Claude.ai wymaga HTTPS. Setup z FRP + nginx + Let's Encrypt na VPS:

### 1. DNS

```
mcp.your-domain.com    A    <VPS_IP>    TTL 300
```

### 2. Vhost nginx na VPS - `/etc/nginx/sites-available/mcp.your-domain.com`

```nginx
server {
    server_name mcp.your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / długie połączenia MCP
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

### 3. FRP server (`frps`) na VPS

W `/etc/frp/frps.toml`:

```toml
bindPort = 7000
vhostHTTPPort = 8080
auth.method = "token"
auth.token = "<wspólny token>"
```

### 4. FRP client (`frpc`) na lokalnym Windows

`C:\Users\<user>\frp\frp_0.61.1_windows_amd64\frpc-mcp.toml`:

```toml
serverAddr = "<VPS_IP>"
serverPort = 7000
auth.method = "token"
auth.token = "<wspólny token z frps>"

[[proxies]]
name = "mcp"
type = "http"
localPort = 4500
customDomains = ["mcp.your-domain.com"]
```

### 5. Dodaj connector w Claude.ai

- Settings → Connectors → Add custom connector
- URL: `https://mcp.your-domain.com/mcp` (z `/mcp` na końcu!)
- OAuth Client ID/Secret: **puste**
- Connect → login form → wpisz `MCP_USER` i `MCP_PASS` z `.env`
- W czacie: `+` → Connectors → włącz toggle → **start nowej konwersacji**

## Uruchomienie (Windows)

### Opcja A: PM2 z auto-reload

```bash
npm install -g pm2 pm2-windows-startup
pm2-startup install   # autostart po zalogowaniu Windows
cd D:\mcp-server
pm2 start server.js --name mcp --watch --ignore-watch=".env node_modules .git *.log dump.pm2 hosts.json"
pm2 save
```

Po tym:

- Zmiana `server.js` = auto-restart w 2 sek
- Crash node = auto-restart
- Po zalogowaniu Windows = auto-start

Komendy codzienne:

```bash
pm2 list                                  # status
pm2 logs mcp --lines 30 --nostream        # logi (snapshot)
pm2 restart mcp                           # ręczny restart
```

### Opcja B: Task Scheduler + bat (bez PM2)

`D:\mcp-server\start-mcp.bat`:

```bat
@echo off
cd /d C:\Users\Admin\frp\frp_0.61.1_windows_amd64
start "FRP tunnel" /min frpc.exe -c frpc-mcp.toml

cd /d D:\mcp-server
start "MCP server" /min cmd /k "node server.js"
```

Task Scheduler → Create Task:

- General: Run with highest privileges, At startup
- Trigger: At startup (delay 30s)
- Action: `D:\mcp-server\start-mcp.bat`

Zmiana `server.js` = ręczny restart przez zabicie node i odpalenie bata.

### FRP tunel - osobny start

Niezależnie od wyboru A/B - tunel FRP musi chodzić. Najprościej przez Task Scheduler:

`start-mcp.bat` (jeśli PM2 zarządza node):

```bat
@echo off
cd /d C:\Users\Admin\frp\frp_0.61.1_windows_amd64
start "FRP tunnel mcp" /min frpc.exe -c frpc-mcp.toml
```

## Rozszerzanie

### Dodanie nowego hosta

Edytuj `hosts.json`:

```json
{
  "hosts": {
    "production": {...},
    "nowy": {
      "ip": "5.6.7.8",
      "user": "ubuntu",
      "key": "main",
      "description": "Nowy serwer"
    }
  }
}
```

PM2 z `--watch` automatycznie przeładuje. **W Claude.ai zrób disconnect/connect** żeby zauważyć nową opcję w `host` dropdown.

### Dodanie nowego klucza SSH

```json
{
  "keys": {
    "main": "/path/to/main.pem",
    "klient-x": "~/keys/klient-x.pem"
  }
}
```

### Dodanie nowego toola

W `server.js`:

```javascript
server.tool(
  "nazwa_tool",
  "Opis dla Claude - kiedy ma użyć tego narzędzia",
  {
    parametr: z.string().describe("co to za parametr"),
  },
  async ({ parametr }) => {
    // logika
    return { content: [{ type: "text", text: "wynik" }] };
  },
);
```

Po dodaniu PM2 (z `--watch`) auto-przeładuje. **Disconnect/connect connector** w Claude.ai żeby zobaczyć nowy tool.

## Bezpieczeństwo

- OAuth 2.1 z PKCE i Dynamic Client Registration
- Access tokeny ważne 30 dni (konfigurowalne)
- Klucze SSH, AWS creds, GitHub PAT zostają lokalnie
- 401 + `WWW-Authenticate` dla nieautoryzowanych

### Zalecenia produkcyjne

1. **Read-only AWS profile** dla `aws_cli` jeśli nie potrzebujesz mutacji - osobne IAM credentials
2. **Whitelist komend** w `aws_cli` (np. tylko `describe-*`, `list-*`)
3. **Usuń `StrictHostKeyChecking=no`** z `ssh_exec` i dodaj hosty raz do `known_hosts`
4. **Audit log** - każdy tool call do osobnego pliku z timestamp + user
5. **Persist OAuth state** - obecnie tokeny są w pamięci, restart node = nowa autoryzacja
6. **Rate limiting** na endpointy `/oauth/*` (np. express-rate-limit)
7. **`.gitignore`** - sprawdź czy zawiera `.env`, `hosts.json`, `dump.pm2`, `node_modules`, `*.log`

## Troubleshooting

| Objaw                                           | Przyczyna                                                | Rozwiązanie                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Couldn't reach the MCP server` w Claude.ai     | URL bez `/mcp`                                           | Użyj `https://domena/mcp` (z suffix)                                                                               |
| `404 Not Found` od nginx                        | Brak vhost dla subdomeny                                 | Stwórz vhost + certbot                                                                                             |
| `502 Bad Gateway`                               | frpc nie chodzi albo node padł                           | Sprawdź `pm2 list` i process frpc                                                                                  |
| `connect EPERM \\.\pipe\rpc.sock`               | PM2 daemon corrupted                                     | `rm -rf ~/.pm2 && npm uninstall -g pm2 && npm install -g pm2`                                                      |
| `EADDRINUSE :4500`                              | Inny node chodzi na 4500                                 | `Get-Process node \| Stop-Process -Force` w PowerShell admin                                                       |
| `MCP_PASS - hasło do logowania` przy starcie    | Brak `.env`                                              | `cp .env.example .env` i wypełnij                                                                                  |
| `hosts.json not loaded`                         | Brak `hosts.json`                                        | `cp hosts.example.json hosts.json` i wypełnij                                                                      |
| `Nieznany klucz 'xxx'` przy SSH                 | Klucz nie w `hosts.json`                                 | Dodaj do sekcji `keys`                                                                                             |
| `ssh_exec` daje "Permission denied (publickey)" | Zły user dla hosta                                       | W `hosts.json` ustaw poprawnego usera (zwykle `ubuntu` dla Ubuntu, `ec2-user` dla Amazon Linux)                    |
| `pm2: command not found` przez `pm2_status`     | NVM na zdalnym - non-interactive shell nie ładuje nvm.sh | Tool radzi sobie z tym automatycznie (sourcing nvm.sh przez base64). Sprawdź czy na hoście jest nvm w `$HOME/.nvm` |
| Claude widzi connector ale nie tools            | Toggle wyłączony albo stara sesja                        | `+` → Connectors → włącz toggle → **nowa konwersacja**                                                             |
| Zmieniłeś tools, Claude pokazuje stare          | Cache schemy MCP                                         | Settings → Connectors → Disconnect → Connect                                                                       |

## Pliki w projekcie

```
mcp-server/
├── server.js              # MCP server (Express + StreamableHTTP + OAuth)
├── package.json
├── .env                   # (gitignore) - sekrety
├── .env.example
├── hosts.json             # (gitignore) - lista serwerów
├── hosts.example.json
├── .gitignore
├── README.md
├── setup.bat              # quick start dla Windows
├── setup.sh               # quick start dla Linux/Mac
└── start-mcp.bat          # autostart FRP tunnel (Windows)
```

## License

MIT
