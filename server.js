// server.js

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { exec } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import crypto from "crypto";

const OAUTH_USER = "admin";
const OAUTH_PASS = "*****"; // tylko Ty będziesz to znać
const BASE_URL = "https://mcp.torweb.pl";

const clients = new Map(); // client_id -> { client_secret, redirect_uris }
const authCodes = new Map(); // code -> { client_id, redirect_uri, expires }
const accessTokens = new Map(); // access_token -> { client_id, expires }

const execAsync = promisify(exec);
const TOKEN = "Basketball321**"; // prosta autoryzacja

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
