# MCP Server — AWS CLI + SSH + Local + GitHub + Postgres + PM2

Lokalny MCP server, który daje Claude.ai (lub innemu klientowi MCP) bezpośredni dostęp do **AWS CLI**, **SSH na instancje EC2 przez klucze .pem**, **lokalnego shella Windows** oraz **GitHub REST API** — bez kopiowania promptów i bez Claude Code.

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

Wystawia cztery narzędzia MCP, których Claude może użyć w czacie:

- **`aws_cli`** — wykonuje dowolne polecenie AWS CLI używając lokalnego profilu (`aws ec2 describe-instances ...`)
- **`ssh_exec`** — wykonuje polecenie po SSH na wskazanym hoście, używając jednego z dwóch kluczy `.pem` (`maturapolski` lub `moja-aplikacja`)
- **`local_exec`** — wykonuje dowolne polecenie shell (`cmd.exe`) na lokalnym Windowsie. Edycja plików, git, npm, pm2 lokalny, dowolny soft.
- **`github_api`** — wykonuje request do GitHub REST API używając Personal Access Token. Issues, PRs, commits, contents, workflows.
- **`postgres_query`** — wykonuje zapytanie SQL na bazie PostgreSQL przez SSH (`sudo -u postgres psql`). Działa na zdefiniowanych hostach (`panel`, `matury`), bez hasła do bazy.
- **`pm2_status`** — pokazuje `pm2 list` i opcjonalnie ostatnie logi (`pm2 logs --nostream`) na wskazanym serwerze. Szybka diagnoza bez wchodzenia ręcznie po SSH.

Klucze `.pem` i GitHub PAT **nigdy nie opuszczają Twojej maszyny**. Tunel przenosi tylko żądania MCP (komendy do wykonania) i ich wyniki.

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

# GitHub (opcjonalne — tylko jeśli chcesz tool github_api)
# PAT wygeneruj na https://github.com/settings/tokens (Fine-grained, Contents R/W)
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxx
GITHUB_OWNER=LeszczynskiKarol
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
- OAuth Client ID/Secret: **puste**
- Add → Connect
- W oknie logowania wpisz `MCP_USER` i `MCP_PASS` z `.env`

W czacie: `+` → Connectors → włącz toggle dla swojego MCP, **i zacznij nową konwersację** (tools podpinają się przy starcie chatu).

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

## Autostart przy starcie Windows

Jeden plik startowy odpala oba procesy — tunel FRP (port 4500 → mcp.torweb.pl) oraz MCP server (`node server.js`).

`D:\mcp-server\start-mcp.bat`:

```bat
@echo off
cd /d C:\Users\Admin\frp\frp_0.61.1_windows_amd64
start "FRP tunnel mcp" /min frpc.exe -c frpc-mcp.toml

cd /d D:\mcp-server
start "MCP server" /min cmd /k "node server.js"
```

Task Scheduler → Create Task:

- **General**: nazwa np. `MCP Auto-Start`, Run whether user is logged on or not, Run with highest privileges
- **Trigger**: At startup (z opóźnieniem 30s żeby sieć/disk się ustabilizowała)
- **Action**: Program = `D:\mcp-server\start-mcp.bat`
- **Settings**: If the task fails, restart every 1 minute, do tego 3 razy

> Ten bat odpala **tylko tunel mcp** i node servera — niezależnie od głównego `tunnel` (który nadpisuje `frpc.toml` i służy do frontend/backend). Oba procesy frpc chodzą równolegle, bez kolizji.

**Alternatywnie - PM2 dla node servera** (jeśli chcesz że samo się restartuje przy crashu node'a, nie tylko przy crashu całego komputera):

```bash
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd D:\mcp-server
pm2 start server.js --name mcp
pm2 save
```

Jak używasz PM2, w `start-mcp.bat` usuń drugą część (`cd /d D:\mcp-server && start "MCP server"...`) — PM2 sam wystartuje node przy bootcie.

---

## Rozszerzanie

### Dodawanie kolejnego serwera

W `server.js` znajdź obiekt `HOSTS` i dorzuć nowy wpis:

```javascript
const HOSTS = {
  panel: { ip: "3.67.113.111", user: "ubuntu", key: "maturapolski" },
  matury: { ip: "3.68.187.152", user: "ubuntu", key: "maturapolski" },
  nowy: { ip: "1.2.3.4", user: "ubuntu", key: "moja-aplikacja" },
};
```

Po tym `postgres_query` i `pm2_status` automatycznie obsłużą alias `nowy`.

### Dodawanie nowego toola

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

## Przykłady użycia w czacie Claude

**Diagnostyka AWS:**

- _"Wylistuj instancje EC2 w eu-central-1 razem ze statusem"_
- _"Sprawdź obciążenie CPU instancji `i-0c621a1c7abc9e4f7` z ostatnich 24h przez CloudWatch"_

**SSH na EC2:**

- _"Zaloguj się na 3.67.113.111 i pokaż `pm2 list`"_
- _"Sprawdź ile wolnego miejsca na obu serwerach (`df -h`)"_

**Lokalna robota:**

- _"Otwórz `D:\\maturapolski\\src\\index.ts`, znajdź funkcję X i napraw bug Y, zacommituj"_
- _"Pobierz najnowsze zmiany z mojego repo GitHub i odpal `npm install`"_

**GitHub:**

- _"Wylistuj otwarte issue w repo maturapolski"_
- _"Pokaż commits w main z ostatniego tygodnia"_
- _"Utwórz nowego brancha `fix/login-bug` z aktualnego maina"_

**Postgres bez logowania do bazy:**

- _"Ile użytkowników zarejestrowało się dzisiaj w maturapolski?"_ → `postgres_query host=panel database=maturapolski query="SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '1 day'"`
- _"Pokaż 10 ostatnich błędów płatności w bazie panel_torweb"_
- _"Jaka jest wielkość tabeli `arkusze` w bazie maturapolski?"_

**PM2 - szybka diagnoza:**

- _"Co działa na panel.torweb.pl?"_ → `pm2_status host=panel`
- _"Pokaż ostatnie 100 linii logów aplikacji `maturapolski-api` na serwerze panel"_ → `pm2_status host=panel app=maturapolski-api lines=100`
- _"Sprawdź czy wszystkie procesy pm2 są w stanie 'online' na obu serwerach"_

**End-to-end (4 narzędzia naraz):**

- _"Backend na panel.torweb.pl zwraca 502. Zdiagnozuj, popraw kod lokalnie, zacommituj, wdróż na serwer."_  
   → ssh_exec sprawdzi logi → local_exec edytuje plik → local_exec robi git commit/push → github_api opcjonalnie PR → ssh_exec pull/restart.

---

## Pliki w projekcie

```
D:\mcp-server
├── server.js              # MCP server (Express + StreamableHTTP + OAuth)
├── package.json
├── package-lock.json
├── .env                   # MCP_USER, MCP_PASS, GITHUB_TOKEN, GITHUB_OWNER (NIE commitować!)
├── .env.example           # szablon do skopiowania
├── .gitignore
├── README.md
├── start-mcp.bat          # odpala FRP tunnel + node server (autostart)
└── node_modules\
C:\Users\Admin\frp\frp_0.61.1_windows_amd64
└── frpc-mcp.toml          # osobny config tunela mcp (port 4500 → mcp.torweb.pl)

```
