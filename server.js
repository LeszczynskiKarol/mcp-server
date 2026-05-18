// server.js

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { exec } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { config } from "dotenv";
config();

// === Load hosts.json ===
const HOSTS_CONFIG_PATH =
  process.env.HOSTS_CONFIG || path.join(process.cwd(), "hosts.json");
let HOSTS_CONFIG = { hosts: {}, keys: {} };
try {
  const raw = fsSync.readFileSync(HOSTS_CONFIG_PATH, "utf8");
  HOSTS_CONFIG = JSON.parse(raw);
  console.log(
    `Loaded ${Object.keys(HOSTS_CONFIG.hosts || {}).length} hosts and ${Object.keys(HOSTS_CONFIG.keys || {}).length} keys from ${HOSTS_CONFIG_PATH}`,
  );
} catch (e) {
  console.warn(
    `hosts.json not loaded (${e.code || e.message}). Tools ssh_exec/postgres_query/pm2_status won't work until you create ${HOSTS_CONFIG_PATH}`,
  );
}

// === Configuration from env ===
const OAUTH_USER = process.env.MCP_USER || "admin";
const OAUTH_PASS = process.env.MCP_PASS;
const BASE_URL = process.env.MCP_BASE_URL;
const PORT = parseInt(process.env.PORT || "4500", 10);
const SERVER_NAME = process.env.MCP_SERVER_NAME || "mcp-server";
const TOKEN_TTL_MS =
  parseInt(process.env.TOKEN_TTL_SECONDS || "2592000", 10) * 1000;
const AUTH_CODE_TTL_MS =
  parseInt(process.env.AUTH_CODE_TTL_SECONDS || "600", 10) * 1000;
const EXEC_BUFFER =
  parseInt(process.env.EXEC_BUFFER_MB || "10", 10) * 1024 * 1024;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";

// Validate required env
const errors = [];
if (!OAUTH_PASS) errors.push("MCP_PASS - OAuth login password");
if (!BASE_URL) errors.push("MCP_BASE_URL - e.g. https://your-domain.com");
if (errors.length) {
  console.error("Missing required environment variables in .env:");
  errors.forEach((e) => console.error("  - " + e));
  console.error("Copy .env.example to .env and fill it in.");
  process.exit(1);
}

if (!GITHUB_TOKEN)
  console.warn("GITHUB_TOKEN not set - github_api tool will not work");

console.log(`MCP server: ${SERVER_NAME}`);
console.log(`Base URL: ${BASE_URL}`);
console.log(`Port: ${PORT}`);
console.log(`Token TTL: ${TOKEN_TTL_MS / 1000 / 86400} days`);

const clients = new Map(); // client_id -> { client_secret, redirect_uris }
const authCodes = new Map(); // code -> { client_id, redirect_uri, expires }
const accessTokens = new Map(); // access_token -> { client_id, expires }

const execAsync = promisify(exec);

const server = new McpServer({ name: SERVER_NAME, version: "1.0.0" });

server.tool(
  "aws_cli",
  "Run an AWS CLI command using the locally configured AWS profile. Use for any AWS operation: describe-instances, s3 ls, logs filter-log-events, etc.",
  {
    command: z
      .string()
      .describe(
        "AWS CLI command without the 'aws' prefix, e.g. 'ec2 describe-instances --region eu-central-1'",
      ),
  },
  async ({ command }) => {
    const { stdout, stderr } = await execAsync(`aws ${command}`, {
      maxBuffer: EXEC_BUFFER,
    });
    return { content: [{ type: "text", text: stdout || stderr }] };
  },
);

server.tool(
  "ssh_exec",
  "Run a shell command on a remote host over SSH using a key defined in hosts.json (the 'keys' section). Host is any IP or DNS, user defaults to 'ubuntu'.",
  {
    key: z
      .string()
      .describe("key name from hosts.json (e.g. 'main', 'production-key')"),
    user: z.string().default("ubuntu").describe("SSH user (default: ubuntu)"),
    host: z
      .string()
      .describe("IP or DNS, e.g. '1.2.3.4' or 'server.example.com'"),
    command: z.string().describe("shell command to run on the remote host"),
  },
  async ({ key, user, host, command }) => {
    try {
      const keyPath = resolveKeyPath(key);
      const { stdout, stderr } = await execAsync(
        `ssh -i "${keyPath}" -o StrictHostKeyChecking=no ${user}@${host} "${command.replace(/"/g, '\\"')}"`,
        { maxBuffer: EXEC_BUFFER },
      );
      return { content: [{ type: "text", text: stdout || stderr }] };
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
  "local_exec",
  "Run a shell command on the local machine where this MCP server is running. On Windows the command goes to cmd.exe; on Linux/Mac to /bin/sh. Use for git, npm, file edits, pm2 control, etc.",
  {
    command: z
      .string()
      .describe(
        "shell command, e.g. 'git status' or 'npm install' or 'pm2 list'",
      ),
    cwd: z.string().optional().describe("working directory (optional)"),
  },
  async ({ command, cwd }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: EXEC_BUFFER,
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
  "Make a request to the GitHub REST API using the configured Personal Access Token. Use endpoint paths like '/repos/{owner}/{repo}/...' or '/user/repos'. Default owner: '" +
    GITHUB_OWNER +
    "'. Shortcut: if the endpoint starts with '/repos/NAME' (without owner/), the default owner is auto-prepended. Methods: GET (default), POST, PATCH, PUT, DELETE.",
  {
    endpoint: z
      .string()
      .describe(
        "API path, e.g. '/repos/owner/repo/issues' or '/user/repos'. Do not include 'https://api.github.com'.",
      ),
    method: z
      .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
      .default("GET")
      .describe("HTTP method"),
    body: z
      .record(z.any())
      .optional()
      .describe("body as JSON object (for POST/PATCH/PUT)"),
    query: z
      .record(z.string())
      .optional()
      .describe(
        "query params as an object, e.g. {state:'open', per_page:'30'}",
      ),
  },
  async ({ endpoint, method, body, query }) => {
    if (!GITHUB_TOKEN)
      return {
        content: [{ type: "text", text: "GITHUB_TOKEN not set in .env" }],
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
          "User-Agent": SERVER_NAME,
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

function resolveKeyPath(keyName) {
  const p = (HOSTS_CONFIG.keys || {})[keyName];
  if (!p)
    throw new Error(
      `Unknown key '${keyName}'. Available: ${Object.keys(HOSTS_CONFIG.keys || {}).join(", ") || "(hosts.json not loaded)"}`,
    );
  // Cross-platform path normalization: tilde, forward slashes
  let resolved = p;
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    resolved = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      resolved.slice(2),
    );
  }
  return path.normalize(resolved);
}

function buildSsh(hostKey) {
  const h = (HOSTS_CONFIG.hosts || {})[hostKey];
  if (!h)
    throw new Error(
      `Unknown host '${hostKey}'. Available: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(hosts.json not loaded)"}`,
    );
  const user = h.user || "ubuntu";
  return `ssh -i "${resolveKeyPath(h.key)}" -o StrictHostKeyChecking=no ${user}@${h.ip}`;
}

server.tool(
  "postgres_query",
  "Run a SQL query on a PostgreSQL database over SSH on a remote host from hosts.json. Uses psql via 'sudo -u postgres', so no password is needed (passwordless sudo required on the remote). SELECT returns data; DML/DDL also work - be careful on production databases.",
  {
    host: z
      .string()
      .describe(
        `host from hosts.json - available: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(none - hosts.json not loaded)"}`,
      ),
    database: z
      .string()
      .describe("database name, e.g. 'mydb' or 'app_production'"),
    query: z
      .string()
      .describe(
        "SQL query, e.g. \"SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '1 day'\"",
      ),
    format: z
      .enum(["table", "csv", "json"])
      .default("table")
      .describe("psql output format"),
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
        maxBuffer: EXEC_BUFFER,
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
  "Show PM2 status (process list and optionally recent logs) on a remote host. Quick diagnostics: 'pm2_status host=production' or with logs 'pm2_status host=production app=myapp lines=100'. Requires PM2 installed on the remote (under NVM is fine - nvm.sh is auto-sourced).",
  {
    host: z
      .string()
      .describe(
        `host from hosts.json - available: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(none - hosts.json not loaded)"}`,
      ),
    app: z
      .string()
      .optional()
      .describe(
        "specific PM2 app name (if you want logs for one app only). Omit for process list only.",
      ),
    lines: z
      .number()
      .int()
      .min(0)
      .max(500)
      .default(0)
      .describe("how many log lines to show. 0 = no logs (list only)"),
  },
  async ({ host, app, lines }) => {
    try {
      const ssh = buildSsh(host);
      // Explicitly source nvm.sh because .bashrc has an early return for non-interactive shells
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
          maxBuffer: EXEC_BUFFER,
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
  "Read one chunk of a large text file (e.g. a book) that was pre-split into ~3000-word chunks by book_split. Use iteratively to read through a whole document that does not fit in the context window. Returns the chunk text plus metadata (chunk_index, total_chunks, line_range).",
  {
    book_dir: z
      .string()
      .describe("directory containing chunks, e.g. '/path/to/book/chunks'"),
    chunk_index: z
      .number()
      .int()
      .min(0)
      .describe("which chunk to read (0-indexed)"),
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
              text: `End of document. Total chunks: ${meta.total_chunks}`,
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
  "Split a large text file into chunks of ~N words each (default 3000). Saves chunks and a _meta.json index to the output directory. After splitting, use book_chunk to iterate through them.",
  {
    input_file: z
      .string()
      .describe("path to the source text file, e.g. '/path/to/book.txt'"),
    output_dir: z
      .string()
      .describe(
        "directory where chunks will be written, e.g. '/path/to/book/chunks'",
      ),
    words_per_chunk: z
      .number()
      .int()
      .min(500)
      .max(10000)
      .default(3000)
      .describe("target words per chunk (default 3000)"),
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
            text: `OK - split into ${chunks.length} chunks of ~${words_per_chunk} words. Meta: ${path.join(output_dir, "_meta.json")}`,
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
  "Read/write structured notes for a long document in a JSON file (_notes.json in book_dir). Useful for tracking glossaries, chapter summaries, TODO lists, inconsistencies found while iterating through a long text. Operations: get (read the whole JSON or one key), set (overwrite a key), append (push to a list under a key). Keys support dot-notation for nesting (e.g. 'summaries.chapter_1').",
  {
    book_dir: z
      .string()
      .describe(
        "book directory (where _notes.json lives), e.g. '/path/to/book'",
      ),
    operation: z.enum(["get", "set", "append"]).describe("get | set | append"),
    key: z
      .string()
      .optional()
      .describe(
        "JSON key with optional dot-notation, e.g. 'characters' or 'summaries.chapter_1'",
      ),
    value: z
      .any()
      .optional()
      .describe(
        "value to write (string, object, array) - required for set/append",
      ),
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
      <h2>Sign in to MCP</h2>
      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="client_id" value="${client_id}">
        <input type="hidden" name="redirect_uri" value="${redirect_uri}">
        <input type="hidden" name="state" value="${state || ""}">
        <input type="hidden" name="code_challenge" value="${code_challenge || ""}">
        <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ""}">
        <p><input name="username" placeholder="username" style="width:100%;padding:8px"></p>
        <p><input name="password" type="password" placeholder="password" style="width:100%;padding:8px"></p>
        <button type="submit" style="padding:10px 20px">Sign in</button>
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
          "Invalid credentials. <a href='javascript:history.back()'>Back</a>",
        );
    }
    const code = crypto.randomBytes(24).toString("hex");
    authCodes.set(code, {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      expires: Date.now() + AUTH_CODE_TTL_MS,
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
      expires: Date.now() + TOKEN_TTL_MS,
    });
    const refResp = {
      access_token: new_at,
      token_type: "Bearer",
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      refresh_token: new_rt,
      scope: "mcp",
    };
    console.log("  REFRESH issued for client:", client_id);
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
    expires: Date.now() + TOKEN_TTL_MS, // 30 days by default
  });
  const response = {
    access_token,
    token_type: "Bearer",
    expires_in: Math.floor(TOKEN_TTL_MS / 1000),
    refresh_token,
    scope: "mcp",
  };
  console.log(
    "  TOKEN issued for client:",
    client_id,
    "expires_in:",
    response.expires_in,
  );
  res.json(response);
});

app.listen(PORT, () => console.log(`MCP listening on :${PORT}`));
