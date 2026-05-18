// server.js

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { exec } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { config } from "dotenv";
config();

const OAUTH_USER = process.env.MCP_USER || "admin";
const OAUTH_PASS = process.env.MCP_PASS;
const BASE_URL = process.env.MCP_BASE_URL || "https://mcp.torweb.pl";

if (!OAUTH_PASS) {
  console.error("❌ Brak MCP_PASS w .env");
  process.exit(1);
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
if (!GITHUB_TOKEN)
  console.warn("⚠️ Brak GITHUB_TOKEN - tool github_api nie zadziała");

const clients = new Map(); // client_id -> { client_secret, redirect_uris }
const authCodes = new Map(); // code -> { client_id, redirect_uri, expires }
const accessTokens = new Map(); // access_token -> { client_id, expires }

const execAsync = promisify(exec);

const server = new McpServer({ name: "aws-ssh", version: "1.0.0" });

server.tool(
  "aws_cli",
  "Wykonuje polecenie AWS CLI",
  {
    command: z
      .string()
      .describe("np. 'ec2 describe-instances --region eu-central-1'"),
  },
  async ({ command }) => {
    const { stdout, stderr } = await execAsync(`aws ${command}`, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return { content: [{ type: "text", text: stdout || stderr }] };
  },
);

server.tool(
  "ssh_exec",
  "SSH do EC2 przez klucz .pem",
  {
    key: z.enum(["maturapolski", "moja-aplikacja"]),
    user: z.string().default("ec2-user"),
    host: z.string(),
    command: z.string(),
  },
  async ({ key, user, host, command }) => {
    const keyPath =
      key === "maturapolski"
        ? "D:\\maturapolski\\maturapolski-key.pem"
        : "D:\\maturapolski\\moja-aplikacja-key-pair.pem";
    const { stdout, stderr } = await execAsync(
      `ssh -i "${keyPath}" -o StrictHostKeyChecking=no ${user}@${host} "${command.replace(/"/g, '\\"')}"`,
      { maxBuffer: 10 * 1024 * 1024 },
    );
    return { content: [{ type: "text", text: stdout || stderr }] };
  },
);

server.tool(
  "local_exec",
  "Wykonuje dowolne polecenie shell na lokalnym komputerze (Windows). Użyj do edycji plików w D:\\mcp-server\\, restartowania pm2, git, npm itd. Komenda leci do cmd.exe.",
  {
    command: z
      .string()
      .describe(
        "polecenie shell, np. 'type D:\\mcp-server\\server.js' albo 'pm2 list'",
      ),
    cwd: z
      .string()
      .optional()
      .describe("katalog roboczy, np. 'D:\\mcp-server' (opcjonalne)"),
  },
  async ({ command, cwd }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 10 * 1024 * 1024,
        cwd: cwd || undefined,
        shell: "cmd.exe",
      });
      return {
        content: [{ type: "text", text: stdout || stderr || "(no output)" }],
      };
    } catch (e) {
      return {
        content: [
          { type: "text", text: `ERROR: ${e.message}\n${e.stderr || ""}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "github_api",
  "Wykonuje request do GitHub REST API. Używaj endpoint w formie '/repos/{owner}/{repo}/...' albo '/user/repos'. Domyślny owner: '" +
    GITHUB_OWNER +
    "'. Skróty: jeśli endpoint zaczyna się od '/repos/NAZWA' (bez owner/), automatycznie wstawia domyślnego ownera. Method GET (default), POST, PATCH, PUT, DELETE.",
  {
    endpoint: z
      .string()
      .describe(
        "ścieżka API, np. '/repos/maturapolski/issues' albo '/user/repos'. Bez 'https://api.github.com'.",
      ),
    method: z
      .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
      .default("GET")
      .describe("HTTP method"),
    body: z
      .record(z.any())
      .optional()
      .describe("body jako JSON object (dla POST/PATCH/PUT)"),
    query: z
      .record(z.string())
      .optional()
      .describe("query params jako object, np. {state:'open', per_page:'30'}"),
  },
  async ({ endpoint, method, body, query }) => {
    if (!GITHUB_TOKEN)
      return {
        content: [{ type: "text", text: "❌ Brak GITHUB_TOKEN w .env" }],
        isError: true,
      };

    // auto-prefix ownera jeśli krótki shortcut "/repos/nazwa-repo/..."
    let ep = endpoint.startsWith("/") ? endpoint : "/" + endpoint;
    const shortMatch = ep.match(/^\/repos\/([^\/]+)(\/.*)?$/);
    if (shortMatch && !shortMatch[1].includes("/") && GITHUB_OWNER) {
      // sprawdź czy to nie jest już owner/repo (czyli jest druga ukośnik wewnątrz pierwszego segmentu)
      const parts = ep.split("/");
      // /repos/X/Y/... -> parts = ["", "repos", "X", "Y", ...]
      // jeśli parts[3] istnieje i nie ma kropki (nazwa repo), to znaczy że X jest ownerem i Y jest repo
      // jeśli parts[3] nie istnieje albo wygląda na sub-resource, X jest skrótem nazwy repo
      if (parts.length < 4) {
        ep = `/repos/${GITHUB_OWNER}/${parts[2]}`;
      }
    }

    const url = new URL("https://api.github.com" + ep);
    if (query)
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    try {
      const resp = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mcp-aws-ssh",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await resp.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      const out =
        typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
      return {
        content: [{ type: "text", text: `HTTP ${resp.status}\n\n${out}` }],
        isError: !resp.ok,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `ERROR: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// Mapowanie hostów - rozszerz wg potrzeb
const HOSTS = {
  panel: { ip: "3.67.113.111", user: "ubuntu", key: "maturapolski" },
  matury: { ip: "3.68.187.152", user: "ubuntu", key: "maturapolski" },
};

function buildSsh(hostKey) {
  const h = HOSTS[hostKey];
  if (!h)
    throw new Error(
      `Nieznany host '${hostKey}'. Dostępne: ${Object.keys(HOSTS).join(", ")}`,
    );
  const keyPath =
    h.key === "maturapolski"
      ? "D:\\maturapolski\\maturapolski-key.pem"
      : "D:\\maturapolski\\moja-aplikacja-key-pair.pem";
  return `ssh -i "${keyPath}" -o StrictHostKeyChecking=no ${h.user}@${h.ip}`;
}

server.tool(
  "postgres_query",
  "Wykonuje zapytanie SQL na bazie PostgreSQL przez SSH na konkretnym serwerze. Host: 'panel' (panel.torweb.pl, 3.67.113.111). Używa psql przez sudo -u postgres, więc bez hasła. SELECT zwraca dane, inne komendy DML/DDL też działają (UWAGA: produkcja, nie testuj).",
  {
    host: z
      .enum(["panel", "matury"])
      .describe("który serwer - panel albo matury"),
    database: z
      .string()
      .describe("nazwa bazy, np. 'maturapolski' albo 'panel_torweb'"),
    query: z
      .string()
      .describe(
        "zapytanie SQL, np. \"SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '1 day'\"",
      ),
    format: z
      .enum(["table", "csv", "json"])
      .default("table")
      .describe("format outputu psql"),
  },
  async ({ host, database, query, format }) => {
    try {
      const ssh = buildSsh(host);
      // Escape pojedynczych cudzysłowów w SQL dla shella
      const sqlEscaped = query.replace(/'/g, "'\\''");
      // Format flagi psql
      const fmtFlag =
        format === "csv" ? "--csv" : format === "json" ? "-A -t" : "";
      // psql przez sudo -u postgres -d <db> -c '<query>'
      const cmd = `${ssh} "cd /tmp && sudo -u postgres psql -d ${database} ${fmtFlag} -c '${sqlEscaped}'"`;
      const { stdout, stderr } = await execAsync(cmd, {
        maxBuffer: 10 * 1024 * 1024,
      });
      const out = stdout || stderr || "(no output)";
      return { content: [{ type: "text", text: out }] };
    } catch (e) {
      return {
        content: [
          { type: "text", text: `ERROR: ${e.message}\n${e.stderr || ""}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "pm2_status",
  "Pokazuje status pm2 (lista procesów + opcjonalnie ostatnie logi) na wybranym serwerze EC2. Użyj do szybkiej diagnozy: 'pm2_status host=panel' albo z logami 'pm2_status host=matury app=mojaapka lines=100'.",
  {
    host: z.enum(["panel", "matury"]).describe("który serwer"),
    app: z
      .string()
      .optional()
      .describe(
        "nazwa konkretnej aplikacji pm2 (jeśli chcesz logi tylko jej). Bez tego = tylko lista procesów.",
      ),
    lines: z
      .number()
      .int()
      .min(0)
      .max(500)
      .default(0)
      .describe("ile linii logów. 0 = bez logów (tylko lista)"),
  },
  async ({ host, app, lines }) => {
    try {
      const ssh = buildSsh(host);
      // Explicite ładujemy nvm.sh, bo .bashrc ma early return dla non-interactive shelli
      const wrap = (cmd) => {
        const script = [
          'export NVM_DIR="$HOME/.nvm"',
          '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
          'export PATH="$PATH:/usr/local/bin:/usr/bin"',
          cmd,
        ].join("\n");
        const b64 = Buffer.from(script).toString("base64");
        return `${ssh} "echo ${b64} | base64 -d | bash"`;
      };

      const parts = [wrap("pm2 list")];
      if (lines > 0) {
        const target = app ? app : "all";
        parts.push(wrap(`pm2 logs ${target} --lines ${lines} --nostream`));
      }
      const outputs = [];
      for (const cmd of parts) {
        const { stdout, stderr } = await execAsync(cmd, {
          maxBuffer: 10 * 1024 * 1024,
        });
        outputs.push(stdout || stderr || "(no output)");
      }
      return { content: [{ type: "text", text: outputs.join("\n\n---\n\n") }] };
    } catch (e) {
      return {
        content: [
          { type: "text", text: `ERROR: ${e.message}\n${e.stderr || ""}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "book_chunk",
  "Czyta fragment dużego pliku tekstowego (np. książki) podzielony na 'chunks' (~3000 słów każdy). Użyj iteracyjnie żeby przeczytać całość. Tool zwraca chunk + metadane: chunk_index, total_chunks, line_range. Plik musi być wstępnie podzielony przez book_split.",
  {
    book_dir: z
      .string()
      .describe("katalog z chunks, np. 'D:\\ksiazka\\chunks'"),
    chunk_index: z.number().int().min(0).describe("który chunk (0-indexed)"),
  },
  async ({ book_dir, chunk_index }) => {
    try {
      const meta = JSON.parse(
        await fs.readFile(path.join(book_dir, "_meta.json"), "utf8"),
      );
      if (chunk_index >= meta.total_chunks) {
        return {
          content: [
            {
              type: "text",
              text: `Koniec książki. Total chunks: ${meta.total_chunks}`,
            },
          ],
        };
      }
      const chunkPath = path.join(
        book_dir,
        `chunk_${String(chunk_index).padStart(4, "0")}.txt`,
      );
      const text = await fs.readFile(chunkPath, "utf8");
      return {
        content: [
          {
            type: "text",
            text: `[CHUNK ${chunk_index + 1}/${meta.total_chunks}, lines ${meta.chunks[chunk_index].start_line}-${meta.chunks[chunk_index].end_line}]\n\n${text}`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `ERROR: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "book_split",
  "Dzieli duży plik tekstowy na chunks po ~3000 słów każdy. Zapisuje chunks + metadane do katalogu. Po tym używaj book_chunk żeby je czytać.",
  {
    input_file: z.string().describe("ścieżka do pliku, np. 'D:\\ksiazka.txt'"),
    output_dir: z
      .string()
      .describe("katalog na chunks, np. 'D:\\ksiazka\\chunks'"),
    words_per_chunk: z.number().int().min(500).max(10000).default(3000),
  },
  async ({ input_file, output_dir, words_per_chunk }) => {
    try {
      await fs.mkdir(output_dir, { recursive: true });
      const text = await fs.readFile(input_file, "utf8");
      const lines = text.split("\n");
      const chunks = [];
      let currentChunk = [];
      let currentWords = 0;
      let startLine = 1;

      for (let i = 0; i < lines.length; i++) {
        const lineWords = lines[i].split(/\s+/).filter(Boolean).length;
        currentChunk.push(lines[i]);
        currentWords += lineWords;

        if (currentWords >= words_per_chunk && lines[i].trim() === "") {
          chunks.push({
            start_line: startLine,
            end_line: i + 1,
            words: currentWords,
            lines: currentChunk,
          });
          currentChunk = [];
          currentWords = 0;
          startLine = i + 2;
        }
      }
      if (currentChunk.length > 0) {
        chunks.push({
          start_line: startLine,
          end_line: lines.length,
          words: currentWords,
          lines: currentChunk,
        });
      }

      for (let i = 0; i < chunks.length; i++) {
        const filename = path.join(
          output_dir,
          `chunk_${String(i).padStart(4, "0")}.txt`,
        );
        await fs.writeFile(filename, chunks[i].lines.join("\n"), "utf8");
      }

      const meta = {
        input_file,
        total_chunks: chunks.length,
        total_lines: lines.length,
        words_per_chunk,
        chunks: chunks.map((c) => ({
          start_line: c.start_line,
          end_line: c.end_line,
          words: c.words,
        })),
        created_at: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(output_dir, "_meta.json"),
        JSON.stringify(meta, null, 2),
        "utf8",
      );

      return {
        content: [
          {
            type: "text",
            text: `OK - podzielono na ${chunks.length} chunks po ~${words_per_chunk} słów. Meta: ${path.join(output_dir, "_meta.json")}`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `ERROR: ${e.message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "book_note",
  "Zarządza notatkami/mapą książki w pliku JSON. Claude może tu zapisywać i czytać: glosariusz postaci, streszczenia rozdziałów, listę poprawek do zrobienia, znalezione niespójności itd. Operacje: get (czyta cały JSON), set (nadpisuje klucz), append (dodaje do listy pod kluczem).",
  {
    book_dir: z.string().describe("katalog książki, np. 'D:\\ksiazka'"),
    operation: z.enum(["get", "set", "append"]),
    key: z
      .string()
      .optional()
      .describe("klucz w JSON (np. 'postacie', 'streszczenia.rozdzial_1')"),
    value: z
      .any()
      .optional()
      .describe("wartość do zapisu (string, obiekt, array)"),
  },
  async ({ book_dir, operation, key, value }) => {
    try {
      const notesFile = path.join(book_dir, "_notes.json");
      let notes = {};
      try {
        notes = JSON.parse(await fs.readFile(notesFile, "utf8"));
      } catch {}

      if (operation === "get") {
        if (!key)
          return {
            content: [{ type: "text", text: JSON.stringify(notes, null, 2) }],
          };
        const val = key.split(".").reduce((o, k) => o?.[k], notes);
        return {
          content: [
            { type: "text", text: JSON.stringify(val, null, 2) ?? "null" },
          ],
        };
      }

      if (operation === "set") {
        const keys = key.split(".");
        let obj = notes;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!obj[keys[i]]) obj[keys[i]] = {};
          obj = obj[keys[i]];
        }
        obj[keys[keys.length - 1]] = value;
      }

      if (operation === "append") {
        const keys = key.split(".");
        let obj = notes;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!obj[keys[i]]) obj[keys[i]] = {};
          obj = obj[keys[i]];
        }
        const k = keys[keys.length - 1];
        if (!Array.isArray(obj[k])) obj[k] = [];
        obj[k].push(value);
      }

      await fs.writeFile(notesFile, JSON.stringify(notes, null, 2), "utf8");
      return { content: [{ type: "text", text: `OK ${operation} ${key}` }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `ERROR: ${e.message}` }],
        isError: true,
      };
    }
  },
);

const app = express();
app.use(express.json());

// Log wszystkich requestów do OAuth/MCP
app.use((req, res, next) => {
  if (
    req.path.startsWith("/oauth") ||
    req.path.startsWith("/.well-known") ||
    req.path.startsWith("/mcp")
  ) {
    console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
    console.log("  query:", JSON.stringify(req.query));
    console.log("  body:", JSON.stringify(req.body));
    console.log("  headers.auth:", req.headers.authorization);
    console.log("  headers.content-type:", req.headers["content-type"]);
  }
  next();
});

app.all("/mcp", async (req, res) => {
  const auth = req.headers.authorization || "";
  const bearer = auth.replace(/^Bearer\s+/, "");
  const tokenData = accessTokens.get(bearer);
  if (!tokenData || tokenData.expires < Date.now()) {
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
    );
    return res.status(401).end();
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// === OAuth 2.1 endpoints dla MCP ===

// Discovery - Claude.ai pyta tu o endpointy
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  });
});

// Resource discovery - nowy standard MCP
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
  });
});

// Dynamic Client Registration - Claude rejestruje się tu automatycznie
app.post("/oauth/register", (req, res) => {
  const client_id = crypto.randomBytes(16).toString("hex");
  const client_secret = crypto.randomBytes(32).toString("hex");
  clients.set(client_id, {
    client_secret,
    redirect_uris: req.body.redirect_uris || [],
  });
  res.status(201).json({
    client_id,
    client_secret,
    redirect_uris: req.body.redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
});

// Authorize - pokazuje login form, po zatwierdzeniu redirect z code
app.get("/oauth/authorize", (req, res) => {
  const {
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
  } = req.query;
  if (!clients.has(client_id)) return res.status(400).send("Unknown client");
  res.send(`
    <html><body style="font-family:sans-serif;max-width:400px;margin:50px auto">
      <h2>Login do MCP</h2>
      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="client_id" value="${client_id}">
        <input type="hidden" name="redirect_uri" value="${redirect_uri}">
        <input type="hidden" name="state" value="${state || ""}">
        <input type="hidden" name="code_challenge" value="${code_challenge || ""}">
        <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ""}">
        <p><input name="username" placeholder="user" style="width:100%;padding:8px"></p>
        <p><input name="password" type="password" placeholder="hasło" style="width:100%;padding:8px"></p>
        <button type="submit" style="padding:10px 20px">Zaloguj</button>
      </form>
    </body></html>
  `);
});

app.post(
  "/oauth/authorize",
  express.urlencoded({ extended: true }),
  (req, res) => {
    const {
      username,
      password,
      client_id,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
    } = req.body;
    if (username !== OAUTH_USER || password !== OAUTH_PASS) {
      return res
        .status(401)
        .send(
          "Nieprawidłowe dane. <a href='javascript:history.back()'>Wróć</a>",
        );
    }
    const code = crypto.randomBytes(24).toString("hex");
    authCodes.set(code, {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      expires: Date.now() + 600000, // 10 min
    });
    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  },
);

// Token - wymiana code na access_token
app.post("/oauth/token", express.urlencoded({ extended: true }), (req, res) => {
  const { grant_type, code, client_id, code_verifier } = req.body;
  console.log("  TOKEN req:", {
    grant_type,
    code: code?.slice(0, 8),
    client_id,
    code_verifier: code_verifier?.slice(0, 8),
  });

  // Obsługa refresh_token grant
  if (grant_type === "refresh_token") {
    const { refresh_token: rt } = req.body;
    console.log("  REFRESH for token:", rt?.slice(0, 8));
    const new_at = crypto.randomBytes(32).toString("hex");
    const new_rt = crypto.randomBytes(32).toString("hex");
    accessTokens.set(new_at, {
      client_id,
      expires: Date.now() + 30 * 24 * 3600 * 1000,
    });
    const refResp = {
      access_token: new_at,
      token_type: "Bearer",
      expires_in: 30 * 24 * 3600,
      refresh_token: new_rt,
      scope: "mcp",
    };
    console.log("  REFRESH response:", JSON.stringify(refResp));
    return res.json(refResp);
  }

  if (grant_type !== "authorization_code") {
    console.log("  -> FAIL: bad grant_type:", grant_type);
    return res.status(400).json({ error: "unsupported_grant_type" });
  }
  const codeData = authCodes.get(code);
  if (!codeData || codeData.expires < Date.now()) {
    console.log(
      "  -> FAIL: invalid code (exists?",
      !!codeData,
      "expired?",
      codeData?.expires < Date.now(),
      ")",
    );
    return res.status(400).json({ error: "invalid_grant" });
  }

  // PKCE verify
  if (codeData.code_challenge) {
    let challenge = code_verifier;
    if (codeData.code_challenge_method === "S256") {
      challenge = crypto
        .createHash("sha256")
        .update(code_verifier)
        .digest("base64url");
    }
    console.log("  PKCE method=", codeData.code_challenge_method);
    console.log(
      "  PKCE expected=[",
      codeData.code_challenge,
      "] len=",
      codeData.code_challenge?.length,
    );
    console.log("  PKCE got=     [", challenge, "] len=", challenge?.length);
    console.log("  PKCE match=", challenge === codeData.code_challenge);
    if (challenge !== codeData.code_challenge) {
      console.log("  -> FAIL: PKCE mismatch");
      return res.status(400).json({ error: "invalid_grant" });
    }
  }

  authCodes.delete(code);
  const access_token = crypto.randomBytes(32).toString("hex");
  const refresh_token = crypto.randomBytes(32).toString("hex");
  accessTokens.set(access_token, {
    client_id,
    expires: Date.now() + 30 * 24 * 3600 * 1000, // 30 dni
  });
  const response = {
    access_token,
    token_type: "Bearer",
    expires_in: 30 * 24 * 3600,
    refresh_token,
    scope: "mcp",
  };
  console.log("  TOKEN response:", JSON.stringify(response));
  res.json(response);
});

app.listen(4500, () => console.log("MCP on :4500"));
