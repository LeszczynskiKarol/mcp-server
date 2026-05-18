# MCP Server — AWS CLI + SSH

Lokalny MCP server, który daje Claude.ai (lub innemu klientowi MCP) bezpośredni dostęp do **AWS CLI** oraz **SSH na instancje EC2 przez klucze .pem** — bez kopiowania promptów i bez Claude Code.

Server chodzi lokalnie na Windowsie. Wystawia się go publicznie przez tunel HTTPS (frp + nginx + Let's Encrypt na osobnym VPS). Claude.ai łączy się z nim jako Custom Connector i może wywoływać polecenia jakby siedział na Twoim kompie.

---

## Architektura

```
┌─────────────┐    HTTPS     ┌──────────────────┐    HTTP    ┌──────────┐    tunel    ┌─────────────┐
│  Claude.ai  │ ───────────► │  nginx + cert    │ ─────────► │   frps   │ ──────────► │ frpc + node │
│  (cloud)    │              │  na VPS AWS      │  :8080     │ (vhost)  │             │  (Twój PC)  │
└─────────────┘              └──────────────────┘            └──────────┘             └─────────────┘
                                                                                            │
                                                                              ┌─────────────┴─────────────┐
                                                                              ▼                           ▼
                                                                       ┌──────────┐              ┌────────────────┐
                                                                       │ AWS CLI  │              │ ssh -i *.pem   │
                                                                       │ (lokal)  │              │ ec2-user@host  │
                                                                       └──────────┘              └────────────────┘
```

---

## Co to robi

Wystawia dwa narzędzia MCP, których Claude może użyć w czacie:

- **`aws_cli`** — wykonuje dowolne polecenie AWS CLI używając lokalnego profilu (`aws ec2 describe-instances ...`)
- **`ssh_exec`** — wykonuje polecenie po SSH na wskazanym hoście, używając jednego z dwóch kluczy `.pem`

Klucze `.pem` **nigdy nie opuszczają Twojej maszyny**. Tunel przenosi tylko żądania MCP (komendy do wykonania) i ich wyniki.

---

## Wymagania

- Node.js 18+
- Lokalnie skonfigurowane AWS CLI (`aws configure`)
- Klucze SSH `.pem` w stałej lokalizacji
- Publiczny adres HTTPS dla MCP servera (tu: `https://mcp.torweb.pl/mcp` przez frp + nginx)

---

## Instalacja

```bash
cd D:\mcp-server
npm install
```

`package.json`:

```json
{
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.21.0",
    "zod": "^3.24.0",
    "dotenv": "^17.0.0"
  }
}
```

Utwórz plik `.env` w katalogu projektu:

```env
MCP_USER=admin
MCP_PASS=twoje-haslo
MCP_BASE_URL=https://mcp.torweb.pl
```

⚠️ Dodaj `.env` do `.gitignore`, żeby nie wypchnąć hasła do repo.

---

## Uruchomienie

### 1. MCP server (lokalnie)

```bash
node server.js
# MCP on :4500
```

### 2. Tunel FRP (osobny terminal)

Konfig `frpc-mcp.toml`:

```toml
serverAddr = "3.68.187.152"
serverPort = 7000
auth.method = "token"
auth.token = "***"

[[proxies]]
name = "mcp"
type = "http"
localPort = 4500
customDomains = ["mcp.torweb.pl"]
```

```bash
cd ~/frp/frp_0.61.1_windows_amd64
./frpc.exe -c frpc-mcp.toml
```

### 3. Dodaj connector w Claude.ai

- Settings → Connectors → Add custom connector
- URL: `https://mcp.torweb.pl/mcp`
- OAuth Client ID/Secret: **puste** (server nie używa OAuth)
- Add → Connect

W czacie: `+` → Connectors → włącz toggle dla swojego MCP.

---

## Konfiguracja serwera publicznego (VPS AWS)

Aby `mcp.torweb.pl` było osiągalne po HTTPS, na serwerze z `frps` potrzebne są:

### A. Rekord DNS (Route 53)

```
mcp.torweb.pl    A    3.68.187.152    TTL 300
```

### B. Vhost nginx — `/etc/nginx/sites-available/mcp.torweb.pl`

```nginx
server {
    server_name mcp.torweb.pl;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Dla MCP / SSE
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
sudo ln -s /etc/nginx/sites-available/mcp.torweb.pl /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d mcp.torweb.pl
```

### C. `frps.toml` — bez zmian

Wystarczy że `vhostHTTPPort = 8080` jest ustawiony i `bindPort = 7000`.

---

## Test

```bash
curl -i https://mcp.torweb.pl/mcp
```

Powinieneś dostać odpowiedź JSON-RPC (np. `406 Not Acceptable` z wymogiem `text/event-stream` — to oczekiwane od curla, Claude.ai wysyła ten nagłówek automatycznie).

---

## Bezpieczeństwo

Server wymaga **autoryzacji hasłem przez OAuth 2.1** (PKCE + Dynamic Client Registration). Claude.ai przy łączeniu otwiera login form, gdzie trzeba podać dane skonfigurowane w `.env`:

```env
MCP_USER=admin
MCP_PASS=twoje-haslo
```

Po zalogowaniu Claude dostaje access token (30 dni ważności) i dopiero z nim ma dostęp do tooli. Bez tokena każde `/mcp` zwraca `401 Unauthorized` z nagłówkiem `WWW-Authenticate` wskazującym na endpoint OAuth discovery.

Klucze `.pem` i tak nigdy nie opuszczają Twojej maszyny — tunel przenosi tylko żądania MCP.

**Dodatkowe zalecenia produkcyjne:**

1. **Whitelist komend** — w `aws_cli` ogranicz do `describe-*` / `list-*`, jeśli nie potrzebujesz mutacji
2. **Read-only AWS profile** — utwórz osobne IAM credentials tylko do odczytu i ustaw `AWS_PROFILE` przed odpaleniem node'a
3. **SSH known_hosts** — usuń `StrictHostKeyChecking=no` i dodaj hosty raz ręcznie do `~/.ssh/known_hosts`
4. **Loguj każdy tool call** do osobnego pliku — audyt + debug
5. **Persist OAuth state** — obecnie `clients` i `accessTokens` są w pamięci, po restarcie node'a trzeba ponownie się autoryzować w Claude.ai

**Zalecenia produkcyjne:**

1. **Whitelist komend** — w `aws_cli` ogranicz do `describe-*` / `list-*`, jeśli nie potrzebujesz mutacji
2. **Read-only AWS profile** — utwórz osobne IAM credentials tylko do odczytu i ustaw `AWS_PROFILE` przed odpaleniem nodea
3. **SSH known_hosts** — usuń `StrictHostKeyChecking=no` i dodaj hosty raz ręcznie do `~/.ssh/known_hosts`
4. **Basic auth w nginx** dla `mcp.torweb.pl` jeśli URL kiedyś wycieknie
5. **Loguj każdy tool call** do osobnego pliku — audyt + debug

---

## Autostart przy starcie Windows

### MCP server przez PM2

```bash
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd D:\mcp-server
pm2 start server.js --name mcp
pm2 save
```

### Tunel FRP przez Task Scheduler

`C:\Users\Admin\frp\frp_0.61.1_windows_amd64\start-mcp.bat`:

```bat
@echo off
cd /d C:\Users\Admin\frp\frp_0.61.1_windows_amd64
start "" /min frpc.exe -c frpc-mcp.toml
```

Task Scheduler → Create Task:

- **General**: Run whether user is logged on or not, highest privileges
- **Trigger**: At startup
- **Action**: Program = `C:\Users\Admin\frp\frp_0.61.1_windows_amd64\start-mcp.bat`
- **Settings**: Restart on failure (1 min, 3 razy)

> Ten bat odpala **tylko tunel mcp** — niezależnie od głównego `tunnel` (który nadpisuje `frpc.toml` i służy do frontend/backend). Oba procesy frpc chodzą równolegle, bez kolizji.

Task Scheduler → Create Task:

- **General**: Run whether user is logged on or not, highest privileges
- **Trigger**: At startup
- **Action**: Program = ścieżka do `start-mcp.bat`
- **Settings**: Restart on failure (1 min, 3 razy)

---

## Rozszerzanie

Każdy nowy tool to kilka linii w `server.js`:

```javascript
server.tool(
  "nazwa_tool",
  "Opis dla Claude — kiedy ma użyć tego narzędzia",
  {
    parametr: z.string().describe("co to za parametr"),
  },
  async ({ parametr }) => {
    // logika
    return { content: [{ type: "text", text: "wynik" }] };
  },
);
```

Po dodaniu — restart node, **disconnect/connect connector w Claude.ai** żeby zauważył nowe tools.

---

## Troubleshooting

| Objaw                                       | Przyczyna                                            | Rozwiązanie                                                  |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| `Couldn't reach the MCP server`             | Zły URL (bez `/mcp`)                                 | Użyj `https://mcp.torweb.pl/mcp`                             |
| `404 Not Found` od nginx                    | Brak vhost dla subdomeny                             | Stwórz `/etc/nginx/sites-available/mcp.torweb.pl` + certbot  |
| `502 Bad Gateway`                           | nginx → frps OK, ale frps nie ma tunelu na tę domenę | Sprawdź czy `./frpc.exe -c frpc-mcp.toml` chodzi             |
| `connection refused` w logach frps          | `node server.js` nie chodzi                          | Odpal node                                                   |
| Claude widzi connector, ale nie widzi tools | Toggle wyłączony w czacie                            | `+` → Connectors → włącz toggle, **start nowej konwersacji** |

---

## Pliki w projekcie

```
D:\mcp-server
├── server.js         # MCP server (Express + StreamableHTTP transport)
├── package.json
├── .env              # MCP_USER, MCP_PASS, MCP_BASE_URL (nie commitować!)
├── .gitignore
├── node_modules
└── frpc-mcp.toml     # osobny config tunela dla mcp (port 4500 → mcp.torweb.pl)
```
