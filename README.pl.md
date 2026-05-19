# MCP Server

Lokalny MCP server dający klientom MCP (Claude.ai, Claude Desktop, custom) bezpośredni dostęp do **AWS CLI**, **SSH na zdalne serwery**, **lokalnego shella**, **zapisu plików lokalnych**, **GitHub REST API**, **PostgreSQL** i **PM2** na zdalnych serwerach. Wystawiany przez tunel HTTPS z OAuth 2.1.

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

| Tool             | Co robi                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws_cli`        | Wykonuje `aws <command>` używając lokalnego profilu AWS CLI                                                                                                       |
| `ssh_exec`       | SSH na dowolny host przez klucz z `hosts.json`                                                                                                                    |
| `local_exec`     | Dowolne polecenie shell na lokalnej maszynie (cmd.exe na Windows, /bin/sh gdzie indziej)                                                                          |
| `write_file`     | Zapis tekstu do lokalnego pliku (overwrite lub append). Pełny UTF-8, bez problemów z escapowaniem shella — preferowany nad `local_exec` do nietrywialnych zapisów |
| `github_api`     | Request do GitHub REST API używając Personal Access Token                                                                                                         |
| `postgres_query` | `psql` przez SSH (sudo -u postgres) na hoście z `hosts.json`                                                                                                      |
| `pm2_status`     | `pm2 list` + opcjonalne logi na zdalnym hoście                                                                                                                    |
| `book_split`     | Dzieli duży plik tekstowy na chunki (~3000 słów)                                                                                                                  |
| `book_chunk`     | Czyta jeden chunk z katalogu z `_meta.json`                                                                                                                       |
| `book_note`      | Zarządza notatkami JSON dla iteracyjnej pracy nad książką                                                                                                         |

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
Static IP allowlist: (none)
Auto-enroll: enabled (TTL 30 days)
Trust proxy: false
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
CLIENT_TTL_SECONDS=7776000     # 90 dni (cleanup nieużywanych klientów)
EXEC_BUFFER_MB=10
EXEC_TIMEOUT_SECONDS=120       # timeout per komenda
MCP_SERVER_NAME=my-mcp-server
HOSTS_CONFIG=./hosts.json
OAUTH_STATE_FILE=./oauth-state.json

# OPCJONALNE - allowlist IP (bezpieczeństwo)
# Statyczne IPs/CIDRs które są zawsze dozwolone (lista oddzielona przecinkami).
# Zostaw puste jeśli chcesz tylko auto-enroll przez OAuth login.
MCP_ALLOWED_IPS=
# Trust X-Forwarded-For - użyj "loopback" gdy MCP jest za FRP/nginx na tej samej maszynie.
# Inne wartości: comma-separated lista zaufanych proxy IPs/CIDRs, "false"
# (default), albo "true" (odrzucane w produkcji - pozwoliłoby spoofować XFF).
MCP_TRUST_PROXY=loopback
# Auto-enroll podsieci /24 do allowlist po udanym OAuth login
MCP_AUTO_ENROLL=true
# Jak długo auto-enrolled podsieć siedzi w allowlist (default 30 dni)
MCP_ENROLL_TTL_SECONDS=2592000
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

Pierwszy request z nowego IP wymusi ponowny login OAuth — to celowe, podsieć `/24` zostanie wpisana do allowlist na 30 dni. Patrz [Bezpieczeństwo](#bezpieczeństwo).

## Uruchomienie (Windows)

Rekomendowany autostart na Windows to **Task Scheduler** + krótki `.bat` z pętlą restartu. PM2 było wcześniej rekomendowane, ale obecnie nie współpracuje z Node 25 (`EPERM \\.\pipe\rpc.sock` w named pipes), więc projekt przeszedł na Task Scheduler.

### Instalacja jednym poleceniem

Po wypełnieniu `.env` i `hosts.json`, odpal jako administrator:

```cmd
install-task.bat
```

To wrapper batch wokół `install-task.ps1`. Skrypt PowerShell:

1. Generuje `start-mcp-hidden.vbs` (żeby okno cmd.exe było ukryte).
2. Generuje `mcp-task.generated.xml` wypełnione `%USERDOMAIN%\%USERNAME%` — nic nie jest hardcoded.
3. Rejestruje task `MCP Server` który startuje przy każdym logowaniu z `HighestAvailable`.

Akcją taska jest `wscript.exe "...\start-mcp-hidden.vbs"`, który po cichu odpala `start-mcp.bat`. Ten bat trzyma noda przy życiu pętlą restartu:

```bat
@echo off
cd /d D:\mcp-server
if not exist logs mkdir logs
:loop
node server.js >> logs\mcp.log 2>&1
echo [%date% %time%] node exited, restarting in 5s >> logs\mcp.log
timeout /t 5 /nobreak >nul
goto loop
```

Przydatne polecenia:

```cmd
schtasks /run /tn "MCP Server"                :: start teraz
schtasks /query /tn "MCP Server" /v /fo LIST  :: status
schtasks /delete /tn "MCP Server" /f          :: usunięcie
tasklist | findstr node.exe                   :: sprawdź czy node żyje
type D:\mcp-server\logs\mcp.log               :: przeczytaj log
```

Restart po edycji `server.js`:

```cmd
taskkill /F /IM node.exe /T
```

`:loop` w `start-mcp.bat` zrestartuje noda w ciągu 5 sekund.

### Autostart tunelu FRP

Tunel jest niezależny od MCP. Najprościej osobny `start-mcp.bat` (inny plik, inny katalog) tylko z `frpc`:

```bat
@echo off
cd /d C:\Users\Admin\frp\frp_0.61.1_windows_amd64
start "FRP tunnel mcp" /min frpc.exe -c frpc-mcp.toml
```

Dodaj do Task Scheduler tak samo (At logon, highest privileges), albo wrzuć w `shell:startup`.

### Bez autostartu

Jak chcesz tylko ręcznie odpalać dla devu:

```cmd
cd /d D:\mcp-server
node server.js
```

Ctrl+C żeby zatrzymać.

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

Serwer czyta `hosts.json` przy starcie, więc zabij noda (`taskkill /F /IM node.exe /T`) — pętla restartu odpali świeży proces w 5 sekund. **W Claude.ai zrób disconnect/connect** żeby zauważyć nową opcję w `host` dropdown.

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

Po dodaniu `taskkill /F /IM node.exe /T`, pętla restartu podniesie noda z nowym tool. **Disconnect/connect connector** w Claude.ai żeby zobaczyć nowy tool.

## Bezpieczeństwo

Pełną listę zabezpieczeń znajdziesz w [SECURITY.md](SECURITY.md). Najważniejsze:

- **OAuth 2.1 z PKCE** (S256 only) i Dynamic Client Registration
- **Match `client_id`** na `/oauth/token` — code może być wymieniony tylko przez klienta, który go dostał (RFC 6749 §4.1.3)
- **Wymuszanie `client_secret`** na `/oauth/token` i `/oauth/revoke` — sekret wystawiony przy rejestracji jest faktycznie sprawdzany
- **Walidacja i rotacja refresh tokenów** — stary refresh token jest invalidowany przy każdym użyciu, nowy parę wystawiamy, i tylko właściwy klient może rotować
- **Trwały stan OAuth** w `oauth-state.json` — restart noda nie zmusza już do reauth w Claude.ai
- **Endpoint revoke** na `/oauth/revoke` (RFC 7009)
- **Dynamiczna allowlist IP** z auto-enroll — podsieć `/24` każdego udanego loginu OAuth jest wpisywana do allowlist na 30 dni. Nieznane IP dostaje 401 + `WWW-Authenticate`, Claude.ai cicho re-runuje OAuth, nowa podsieć ląduje na liście. Statyczne IPs/CIDRs konfigurowalne przez `MCP_ALLOWED_IPS`
- **Anti-clickjacking** na formularzu OAuth login przez `helmet`: `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`
- **Rate limit** na `/oauth/*`: 30 requestów / 15 minut / IP
- **Prevencja prototype pollution** w `book_note` (klucze `__proto__`, `constructor`, `prototype` odrzucane)
- **Wartości tokenów redagowane w logach** — tylko `client_id` i pierwsze 8 znaków tokena są logowane

### Rekomendowany deployment

Za FRP + nginx jak opisano wyżej:

```env
MCP_TRUST_PROXY=loopback   # frpc łączy się z node przez 127.0.0.1
MCP_AUTO_ENROLL=true       # niech IP egress Claude.ai sam się zenrolluje przy pierwszym logowaniu
MCP_ALLOWED_IPS=           # zostaw puste chyba że masz stałe IP firmowe/VPN
MCP_PASS=<random 20+ znaków>
```

`MCP_TRUST_PROXY=true` jest zbyt permisywne i **zostanie odrzucone** przez `express-rate-limit`, bo pozwoliłoby dowolnemu klientowi spoofować `X-Forwarded-For` i obejść rate limit. Używaj `loopback` (albo listy zaufanych proxy IPs).

### Dodatkowe hardening

1. **Read-only AWS profile** dla `aws_cli` jeśli nie potrzebujesz mutacji — osobne IAM creds z `ReadOnlyAccess`
2. **Whitelist komend** w `aws_cli` / `local_exec` / `ssh_exec` jeśli ufasz Claude mniej niż AWS console
3. **Usuń `StrictHostKeyChecking=no`** z `ssh_exec` i dodaj hosty raz do `known_hosts`
4. **Audit log do pliku** — Task Scheduler setup pisze do `logs/mcp.log`; rotacja jest Twoją sprawą
5. **Per-tool ACL** — restrykcje który klient (np. praca vs prywatne Claude.ai) może wołać który tool — wymaga custom dispatchera przed `server.tool`
6. **Sprawdź `.gitignore`** — musi zawierać `.env`, `hosts.json`, `oauth-state.json`, `logs/`, `mcp-task.generated.xml`, `start-mcp-hidden.vbs`

## Troubleshooting

| Objaw                                                        | Przyczyna                                                               | Rozwiązanie                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Couldn't reach the MCP server` w Claude.ai                  | URL bez `/mcp`                                                          | Użyj `https://domena/mcp` (z suffix)                                                                               |
| `Couldn't reach the MCP server` mimo poprawnego URL          | Node nie biega, tunel FRP padł, albo IP nie ma na allowlist             | Sprawdź `tasklist \| findstr node.exe`, process `frpc`, i log pod kątem `[allowlist] BLOCKED /mcp from X.X.X.X`    |
| `404 Not Found` od nginx                                     | Brak vhost dla subdomeny                                                | Stwórz vhost + certbot                                                                                             |
| `502 Bad Gateway`                                            | frpc nie chodzi albo node padł                                          | Sprawdź `tasklist` i process frpc                                                                                  |
| `[allowlist] BLOCKED /mcp from X.X.X.X`                      | Nowe IP, nie jest jeszcze zenrollowane                                  | Powinno samo się naprawić — Claude.ai re-runuje OAuth i doda `/24`. Zaloguj się raz, spróbuj jeszcze raz           |
| `ValidationError: The Express 'trust proxy' setting is true` | `MCP_TRUST_PROXY=true` jest za permisywne dla `express-rate-limit`      | W `.env` zmień na `MCP_TRUST_PROXY=loopback`                                                                       |
| `EADDRINUSE :4500`                                           | Inny node chodzi na 4500                                                | `taskkill /F /IM node.exe /T` w cmd admin                                                                          |
| `MCP_PASS - OAuth login password` przy starcie               | Brak `.env`                                                             | `cp .env.example .env` i wypełnij                                                                                  |
| `hosts.json not loaded`                                      | Brak `hosts.json`                                                       | `cp hosts.example.json hosts.json` i wypełnij                                                                      |
| `Unknown key 'xxx'` przy SSH                                 | Klucz nie w `hosts.json`                                                | Dodaj do sekcji `keys`                                                                                             |
| `ssh_exec` daje "Permission denied (publickey)"              | Zły user dla hosta                                                      | W `hosts.json` ustaw poprawnego usera (zwykle `ubuntu` dla Ubuntu, `ec2-user` dla Amazon Linux)                    |
| `pm2: command not found` przez `pm2_status`                  | NVM na zdalnym - non-interactive shell nie ładuje nvm.sh                | Tool radzi sobie z tym automatycznie (sourcing nvm.sh przez base64). Sprawdź czy na hoście jest nvm w `$HOME/.nvm` |
| Claude widzi connector ale nie tools                         | Toggle wyłączony albo stara sesja                                       | `+` → Connectors → włącz toggle → **nowa konwersacja**                                                             |
| Zmieniłeś tools, Claude pokazuje stare                       | Cache schemy MCP                                                        | Settings → Connectors → Disconnect → Connect                                                                       |
| Task Scheduler pokazuje `Last Result: 267009` a noda nie ma  | Task jest `Running` ale batch jeszcze nie podniósł noda, albo crashował | Czekaj 5 sek (pętla restartu), albo zrób `tasklist \| findstr node.exe` i `type logs\mcp.log`                      |

## Pliki w projekcie

```
mcp-server/
├── server.js              # MCP server (Express + StreamableHTTP + OAuth)
├── package.json
├── .env                   # (gitignore) sekrety
├── .env.example
├── hosts.json             # (gitignore) lista serwerów
├── hosts.example.json
├── oauth-state.json       # (gitignore) persisted OAuth state
├── .gitignore
├── README.md              # angielski (główny)
├── README.pl.md           # polski (ten plik)
├── LICENSE
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── setup.bat              # quick start dla Windows
├── setup.sh               # quick start dla Linux/Mac
├── start-mcp.bat          # pętla restartu noda (autostart Windows)
├── install-task.bat       # wrapper odpalający install-task.ps1
├── install-task.ps1       # rejestruje task "MCP Server"
└── logs/                  # (gitignore) mcp.log
```

## License

MIT
