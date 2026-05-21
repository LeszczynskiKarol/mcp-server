// server.js

import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { Client as SshClient } from "ssh2";
import { config } from "dotenv";
config();

process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e);
});

// === Write PID file for watchdog/restart scripts ===
try {
  fsSync.writeFileSync(".pid", process.pid.toString());
  const cleanup = () => {
    try { fsSync.unlinkSync(".pid"); } catch {}
    try { closeAllSshPool(); } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
} catch (e) {
  console.warn("[pid] failed to write .pid file: " + e.message);
}

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

// === hosts.json schema validation ===
if (
  Object.keys(HOSTS_CONFIG.hosts || {}).length > 0 ||
  Object.keys(HOSTS_CONFIG.keys || {}).length > 0
) {
  const HostsSchema = z
    .object({
      hosts: z
        .record(
          z.object({
            ip: z.string().min(1),
            user: z.string().optional(),
            key: z.string().min(1),
            description: z.string().optional(),
            security_group_id: z.string().optional(),
            region: z.string().optional(),
          }),
        )
        .optional()
        .default({}),
      keys: z.record(z.string().min(1)).optional().default({}),
    })
    .passthrough();
  try {
    HOSTS_CONFIG = HostsSchema.parse(HOSTS_CONFIG);
  } catch (e) {
    if (e instanceof z.ZodError) {
      console.error("hosts.json schema invalid:");
      for (const issue of e.issues) {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw e;
  }
  // Warn about hosts that reference unknown keys
  for (const [name, h] of Object.entries(HOSTS_CONFIG.hosts)) {
    if (!HOSTS_CONFIG.keys[h.key]) {
      console.warn(
        `[hosts.json] host '${name}' references unknown key '${h.key}'`,
      );
    }
  }
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
const EXEC_TIMEOUT_MS =
  parseInt(process.env.EXEC_TIMEOUT_SECONDS || "120", 10) * 1000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const ALLOWED_IPS = (process.env.MCP_ALLOWED_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Trust proxy can be: "false"/unset (no), "true" (any — INSECURE), "loopback"
// (127.0.0.1, ::1), or a comma-separated list of trusted proxy IPs/CIDRs.
const TRUST_PROXY_RAW = process.env.MCP_TRUST_PROXY || "";
let TRUST_PROXY;
if (TRUST_PROXY_RAW === "" || TRUST_PROXY_RAW === "false") {
  TRUST_PROXY = false;
} else if (TRUST_PROXY_RAW === "true") {
  TRUST_PROXY = true; // permissive — rate limiter will refuse this
} else {
  // Express accepts: "loopback", "linklocal", "uniquelocal", IPs, CIDRs, comma-separated
  TRUST_PROXY = TRUST_PROXY_RAW;
}
const AUTO_ENROLL = process.env.MCP_AUTO_ENROLL !== "false"; // default true
const ENROLL_TTL_MS =
  parseInt(process.env.MCP_ENROLL_TTL_SECONDS || "2592000", 10) * 1000;

// Validate required env
const errors = [];
if (!OAUTH_PASS) errors.push("MCP_PASS - OAuth login password");
if (!BASE_URL) errors.push("MCP_BASE_URL - e.g. https://your-domain.com");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  errors.push(`PORT must be an integer 1-65535, got '${process.env.PORT}'`);
}
if (errors.length) {
  console.error("Missing or invalid environment variables in .env:");
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
console.log(
  `Static IP allowlist: ${ALLOWED_IPS.length ? ALLOWED_IPS.join(", ") : "(none)"}`,
);
console.log(
  `Auto-enroll: ${AUTO_ENROLL ? `enabled (TTL ${ENROLL_TTL_MS / 1000 / 86400} days)` : "disabled"}`,
);
console.log(`Trust proxy: ${TRUST_PROXY}`);

// === SSH known_hosts (host key pinning) ===
// First connection to a host pins its fingerprint; subsequent connections
// fail if the host key changes (MITM defence).
const SSH_KNOWN_HOSTS =
  process.env.SSH_KNOWN_HOSTS || path.join(process.cwd(), "known_hosts");
try {
  // Create empty file if it does not exist yet (touch)
  fsSync.closeSync(fsSync.openSync(SSH_KNOWN_HOSTS, "a"));
} catch (e) {
  console.warn(
    `[ssh] could not open known_hosts at ${SSH_KNOWN_HOSTS}: ${e.message}`,
  );
}
const SSH_BASE_OPTS = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=30",
];

// Module-level so the persistent SSH pool below can resolve key paths.
// (Tool registrations later in the file also call these.)
function resolveKeyPath(keyName) {
  const p = (HOSTS_CONFIG.keys || {})[keyName];
  if (!p)
    throw new Error(
      `Unknown key '${keyName}'. Available: ${Object.keys(HOSTS_CONFIG.keys || {}).join(", ") || "(hosts.json not loaded)"}`,
    );
  let resolved = p;
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    resolved = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      resolved.slice(2),
    );
  }
  return path.normalize(resolved);
}

function buildSshArgs(hostKey) {
  const h = (HOSTS_CONFIG.hosts || {})[hostKey];
  if (!h)
    throw new Error(
      `Unknown host '${hostKey}'. Available: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(hosts.json not loaded)"}`,
    );
  const user = h.user || "ubuntu";
  return ["-i", resolveKeyPath(h.key), ...SSH_BASE_OPTS, `${user}@${h.ip}`];
}

// ════════════════════════════════════════════════════════════════════════
// Persistent SSH connection pool (ssh2)
// ────────────────────────────────────────────────────────────────────────
// Each named host gets one long-lived ssh2 Client kept in this Map. Calls
// to execSsh(hostKey, cmd) reuse the existing connection instead of doing
// a fresh TCP+TLS+auth handshake every time (which saves ~500ms per call).
// Connections are evicted after SSH_IDLE_TIMEOUT_MS of inactivity, and
// auto-closed on SIGINT/SIGTERM (see PID-cleanup section).
// Windows OpenSSH ControlMaster is broken (named-pipe issues) so we keep
// the persistence inside this process instead of relying on the ssh CLI.
// ════════════════════════════════════════════════════════════════════════
const SSH_POOL = new Map(); // hostKey -> { client, lastUsed, connecting }
const SSH_IDLE_TIMEOUT_MS =
  parseInt(process.env.SSH_IDLE_TIMEOUT_SECONDS || "300", 10) * 1000;

// Periodic eviction of idle connections
const sshPoolJanitor = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of SSH_POOL) {
    if (entry.connecting) continue;
    if (now - entry.lastUsed > SSH_IDLE_TIMEOUT_MS) {
      try { entry.client.end(); } catch {}
      SSH_POOL.delete(key);
      console.log(`[ssh-pool] evicted idle: ${key}`);
    }
  }
}, 60 * 1000);
if (sshPoolJanitor.unref) sshPoolJanitor.unref();

function closeAllSshPool() {
  for (const [, entry] of SSH_POOL) {
    try { entry.client.end(); } catch {}
  }
  SSH_POOL.clear();
}

// ── Shared validation helpers ─────────────────────────────────────────────
// Detect control characters in paths/commands. Almost always indicates a
// JSON-escape bug in tool arguments — caller sent `\t`, `\n`, `\r`, `\0`
// expecting a literal backslash + letter but JSON parsed them as the actual
// control characters (TAB, LF, CR, NUL). mkdir/exec would do garbage with
// these. Single source of truth used by write_file, local_exec, sftp_upload,
// sftp_download — keep all four call sites in sync.
const PATH_CONTROL_CHAR_REGEX = /[\t\r\n\0\v\f]/;
function hasControlChar(s) {
  return typeof s === "string" && PATH_CONTROL_CHAR_REGEX.test(s);
}

// Postgres database names must be plain alphanumeric+underscore. Anything
// else opens up SQL injection through the `-d ${database}` interpolation
// in postgres_query. Lock it down with the same charset Postgres itself
// accepts for unquoted identifiers.
const VALID_DB_NAME_REGEX = /^[a-zA-Z0-9_]+$/;
function isValidDatabaseName(name) {
  return typeof name === "string" && VALID_DB_NAME_REGEX.test(name);
}

async function getSshClient(hostKey) {
  const h = (HOSTS_CONFIG.hosts || {})[hostKey];
  if (!h) {
    throw new Error(
      `Unknown host '${hostKey}'. Available: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(hosts.json not loaded)"}`,
    );
  }

  const existing = SSH_POOL.get(hostKey);
  if (existing) {
    if (existing.connecting) {
      // Another caller is already connecting — wait for it.
      // Important: after the await we check the CLIENT'S liveness, not
      // `entry.connecting`. The original holder of the connecting promise
      // hasn't necessarily cleared its flag yet (microtask ordering means
      // our continuation can run before theirs), so a "still connecting"
      // flag here is a false negative.
      await existing.connecting;
      const refreshed = SSH_POOL.get(hostKey);
      if (refreshed && refreshed.client && refreshed.client._sock && !refreshed.client._sock.destroyed) {
        refreshed.lastUsed = Date.now();
        return refreshed.client;
      }
    } else {
      // Probe: ssh2 doesn't expose a public liveness flag, but the underlying
      // socket sets .destroyed when torn down.
      const sock = existing.client._sock;
      if (sock && !sock.destroyed) {
        existing.lastUsed = Date.now();
        return existing.client;
      }
      SSH_POOL.delete(hostKey);
    }
  }

  // Reserve the pool slot BEFORE any await. Otherwise concurrent callers
  // racing through `ensureSshAccess` / `fs.readFile` would each see an empty
  // pool and spawn their own ssh2 Client (leaking N-1 connections).
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const client = new SshClient();
  const entry = { client, lastUsed: Date.now(), connecting: ready };
  SSH_POOL.set(hostKey, entry);

  // Drop entry from pool on any termination signal
  client.on("close", () => {
    SSH_POOL.delete(hostKey);
  });
  client.on("error", (err) => {
    console.warn(`[ssh-pool] ${hostKey} error: ${err.message}`);
    SSH_POOL.delete(hostKey);
  });

  // Wire ready/error → our promise resolvers
  client.once("ready", () => resolveReady());
  client.once("error", (err) => rejectReady(err));

  try {
    await ensureSshAccess(hostKey);
    const keyPath = resolveKeyPath(h.key);
    const privateKey = await fs.readFile(keyPath);

    client.connect({
      host: h.ip,
      port: 22,
      username: h.user || "ubuntu",
      privateKey,
      readyTimeout: 10_000,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
    });

    await ready;
  } catch (err) {
    SSH_POOL.delete(hostKey);
    rejectReady(err);
    throw err;
  }
  entry.connecting = null;
  console.log(`[ssh-pool] new connection: ${hostKey} (${h.ip})`);
  return client;
}

// Mimics execFileAsync's behavior: throws on non-zero exit with stdout/stderr
// attached to the error, so existing error handlers keep working unchanged.
async function execSsh(hostKey, command, opts = {}) {
  const timeoutMs = opts.timeoutMs || EXEC_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer || EXEC_BUFFER;
  const client = await getSshClient(hostKey);

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let stream;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { stream && stream.signal("TERM"); } catch {}
      try { stream && stream.close(); } catch {}
      const err = new Error(`Command timed out after ${timeoutMs}ms`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, timeoutMs);

    client.exec(command, (err, s) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      stream = s;

      s.on("data", (chunk) => {
        if (truncated) return;
        if (stdout.length + chunk.length > maxBuffer) {
          stdout += chunk.toString("utf8").slice(0, maxBuffer - stdout.length);
          truncated = true;
          try { s.close(); } catch {}
        } else {
          stdout += chunk.toString("utf8");
        }
      });
      s.stderr.on("data", (chunk) => {
        if (stderr.length + chunk.length > maxBuffer) {
          stderr += chunk.toString("utf8").slice(0, maxBuffer - stderr.length);
        } else {
          stderr += chunk.toString("utf8");
        }
      });
      s.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) return;

        // Refresh lastUsed on successful completion
        const entry = SSH_POOL.get(hostKey);
        if (entry) entry.lastUsed = Date.now();

        if (code !== 0 && code != null) {
          const e = new Error(
            `Command failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}`,
          );
          e.code = code;
          e.signal = signal;
          e.stdout = stdout;
          e.stderr = stderr;
          return reject(e);
        }
        resolve({ stdout, stderr, code, signal, truncated });
      });
      s.on("error", (e) => {
        clearTimeout(timer);
        if (!timedOut) reject(e);
      });
    });
  });
}

// Open an SFTP session over the persistent SSH connection. The caller's
// async fn gets the session; it is closed (sftp.end()) automatically when
// fn settles, regardless of success or failure.
//
// SFTP channels are cheap to open once the SSH transport is up — no
// handshake. We don't cache sftp sessions themselves; they're created per
// transfer and torn down. The underlying ssh2.Client stays warm in the
// SSH_POOL.
async function withSftp(hostKey, fn) {
  const client = await getSshClient(hostKey);
  const sftp = await new Promise((resolve, reject) => {
    client.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });
  try {
    return await fn(sftp);
  } finally {
    try { sftp.end(); } catch {}
  }
}

// === OAuth state persistence ===
const OAUTH_STATE_FILE =
  process.env.OAUTH_STATE_FILE || path.join(process.cwd(), "oauth-state.json");
const CLIENT_TTL_MS =
  parseInt(process.env.CLIENT_TTL_SECONDS || "7776000", 10) * 1000; // 90 days
const MAX_CLIENTS = parseInt(process.env.MCP_MAX_CLIENTS || "1000", 10);

// Tokens are stored hashed (sha256). Raw tokens are issued to the client only
// once; the server keeps only the hash, so leaking oauth-state.json does not
// grant session access.
function hashToken(token) {
  return "sha256:" + crypto.createHash("sha256").update(token).digest("hex");
}

function loadOauthState() {
  try {
    const raw = fsSync.readFileSync(OAUTH_STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    // Auto-migrate legacy plaintext token keys to hashed keys on load
    let migrated = 0;
    const migrateMap = (obj) => {
      const out = {};
      for (const [k, v] of Object.entries(obj || {})) {
        if (k.startsWith("sha256:")) {
          out[k] = v;
        } else {
          out[hashToken(k)] = v;
          migrated++;
        }
      }
      return out;
    };
    const accessRaw = migrateMap(data.accessTokens);
    const refreshRaw = migrateMap(data.refreshTokens);
    if (migrated > 0) {
      console.log(
        `[oauth] migrated ${migrated} plaintext token(s) to hashed form`,
      );
    }
    console.log(
      `[oauth] loaded state: ${Object.keys(data.clients || {}).length} clients, ${Object.keys(accessRaw).length} tokens`,
    );
    return {
      clients: new Map(Object.entries(data.clients || {})),
      authCodes: new Map(Object.entries(data.authCodes || {})),
      accessTokens: new Map(Object.entries(accessRaw)),
      refreshTokens: new Map(Object.entries(refreshRaw)),
      dynamicAllowlist: new Map(Object.entries(data.dynamicAllowlist || {})),
    };
  } catch (e) {
    if (e.code !== "ENOENT")
      console.warn(`[oauth] state load failed: ${e.message}`);
    return {
      clients: new Map(),
      authCodes: new Map(),
      accessTokens: new Map(),
      refreshTokens: new Map(),
      dynamicAllowlist: new Map(),
    };
  }
}

const { clients, authCodes, accessTokens, refreshTokens, dynamicAllowlist } =
  loadOauthState();

let saveTimer = null;
let saveInFlight = false;
let saveQueued = false;

async function flushState() {
  const data = {
    clients: Object.fromEntries(clients),
    authCodes: Object.fromEntries(authCodes),
    accessTokens: Object.fromEntries(accessTokens),
    refreshTokens: Object.fromEntries(refreshTokens),
    dynamicAllowlist: Object.fromEntries(dynamicAllowlist),
  };
  const tmp = OAUTH_STATE_FILE + ".tmp";
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, OAUTH_STATE_FILE);
  } catch (e) {
    console.error(`[oauth] state save failed: ${e.message}`);
  }
}

function saveOauthState() {
  if (saveInFlight) {
    saveQueued = true;
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    saveInFlight = true;
    try {
      await flushState();
    } finally {
      saveInFlight = false;
      if (saveQueued) {
        saveQueued = false;
        saveOauthState();
      }
    }
  }, 500).unref();
}

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, v] of authCodes) {
    if (v.expires < now) {
      authCodes.delete(k);
      cleaned++;
    }
  }
  for (const [k, v] of accessTokens) {
    if (v.expires < now) {
      accessTokens.delete(k);
      cleaned++;
    }
  }
  for (const [k, v] of refreshTokens) {
    if (v.expires < now) {
      refreshTokens.delete(k);
      cleaned++;
    }
  }
  for (const [ip, v] of dynamicAllowlist) {
    if (v.expires < now) {
      dynamicAllowlist.delete(ip);
      cleaned++;
      console.log(`[allowlist] auto-enrolled IP ${ip} expired and removed`);
    }
  }
  // Clean unused clients (no active tokens, created > CLIENT_TTL_MS ago)
  const activeClientIds = new Set();
  for (const v of accessTokens.values()) activeClientIds.add(v.client_id);
  for (const [k, v] of clients) {
    if (
      !activeClientIds.has(k) &&
      v.created_at &&
      now - v.created_at > CLIENT_TTL_MS
    ) {
      clients.delete(k);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[oauth cleanup] removed ${cleaned} expired entries`);
    saveOauthState();
  }
}, 60_000).unref();

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// === Security group SSH access auto-sync ===
// When a host in hosts.json has 'security_group_id' set, ssh_exec / pm2_status /
// postgres_query call ensureSshAccess(hostKey) before connecting. It fetches the
// local machine's public IP, adds a tagged rule (Description='mcp-auto-ssh') to
// the SG on port 22, and revokes any other rules with the same tag (stale IPs
// from previous sessions). Result cached for SG_CHECK_TTL_MS to avoid hitting
// the AWS API on every call. Falls back gracefully (warn + null) on any AWS
// error so the SSH attempt still runs.
const SG_CHECK_TTL_MS = parseInt(process.env.SG_CHECK_TTL_MS || "60000", 10);
const SG_AUTO_TAG = "mcp-auto-ssh";
const sgCheckCache = new Map(); // sg_id -> { until: ms, ip }

async function syncSecurityGroupSsh(sgId, region) {
  const r = region || "eu-central-1";
  const ipResp = await fetch("https://api.ipify.org", {
    signal: AbortSignal.timeout(5000),
  });
  const myIp = (await ipResp.text()).trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(myIp)) {
    throw new Error(`Got invalid public IP from ipify: ${myIp}`);
  }
  const myCidr = `${myIp}/32`;
  const { stdout } = await execFileAsync(
    "aws",
    [
      "ec2",
      "describe-security-groups",
      "--group-ids",
      sgId,
      "--region",
      r,
      "--output",
      "json",
    ],
    { maxBuffer: EXEC_BUFFER, timeout: EXEC_TIMEOUT_MS, windowsHide: true },
  );
  const sgData = JSON.parse(stdout);
  const sshPermission = (sgData.SecurityGroups[0].IpPermissions || []).find(
    (p) => p.IpProtocol === "tcp" && p.FromPort === 22 && p.ToPort === 22,
  );
  let alreadyExists = false;
  const staleRules = [];
  if (sshPermission) {
    for (const range of sshPermission.IpRanges || []) {
      if (range.CidrIp === myCidr) alreadyExists = true;
      else if (range.Description === SG_AUTO_TAG)
        staleRules.push(range.CidrIp);
    }
  }
  if (staleRules.length > 0) {
    const revokeIpPerm = JSON.stringify([
      {
        IpProtocol: "tcp",
        FromPort: 22,
        ToPort: 22,
        IpRanges: staleRules.map((cidr) => ({ CidrIp: cidr })),
      },
    ]);
    try {
      await execFileAsync(
        "aws",
        [
          "ec2",
          "revoke-security-group-ingress",
          "--group-id",
          sgId,
          "--region",
          r,
          "--ip-permissions",
          revokeIpPerm,
        ],
        { maxBuffer: EXEC_BUFFER, timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      );
    } catch (e) {
      console.warn(`[sg-sync] revoke stale rules failed: ${e.message}`);
    }
  }
  if (!alreadyExists) {
    const authIpPerm = JSON.stringify([
      {
        IpProtocol: "tcp",
        FromPort: 22,
        ToPort: 22,
        IpRanges: [{ CidrIp: myCidr, Description: SG_AUTO_TAG }],
      },
    ]);
    await execFileAsync(
      "aws",
      [
        "ec2",
        "authorize-security-group-ingress",
        "--group-id",
        sgId,
        "--region",
        r,
        "--ip-permissions",
        authIpPerm,
      ],
      { maxBuffer: EXEC_BUFFER, timeout: EXEC_TIMEOUT_MS, windowsHide: true },
    );
  }
  return { ip: myIp, added: !alreadyExists, revoked_stale: staleRules.length };
}

async function ensureSshAccess(hostKey) {
  // Tests don't hit real AWS — silently no-op when invoked under vitest.
  if (process.env.MCP_TEST_MODE === "true") return null;
  const h = (HOSTS_CONFIG.hosts || {})[hostKey];
  if (!h || !h.security_group_id) return null;
  const cached = sgCheckCache.get(h.security_group_id);
  if (cached && cached.until > Date.now())
    return { cached: true, ip: cached.ip };
  try {
    const result = await syncSecurityGroupSsh(h.security_group_id, h.region);
    sgCheckCache.set(h.security_group_id, {
      until: Date.now() + SG_CHECK_TTL_MS,
      ip: result.ip,
    });
    console.log(
      `[sg-sync] ${hostKey} (${h.security_group_id}): IP=${result.ip} added=${result.added} revoked_stale=${result.revoked_stale}`,
    );
    return result;
  } catch (e) {
    console.warn(
      `[sg-sync] ${hostKey} failed (continuing with stale ACL): ${e.message}`,
    );
    return null;
  }
}


function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// CSRF token: HMAC-signed, bound to client_id, 10 min TTL. Stateless — no
// cookies, no session. CSRF_SECRET is regenerated at boot, so any form already
// open during a restart will get a 400 on submit (acceptable trade-off).
const CSRF_SECRET = crypto.randomBytes(32);
const CSRF_TTL_MS = 10 * 60 * 1000;

function makeCsrf(client_id) {
  const ts = Date.now().toString();
  const sig = crypto
    .createHmac("sha256", CSRF_SECRET)
    .update(`${client_id}|${ts}`)
    .digest("base64url");
  return `${ts}.${sig}`;
}

function verifyCsrf(token, client_id) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return false;
  const age = Date.now() - tsNum;
  if (age < 0 || age > CSRF_TTL_MS) return false;
  const expected = crypto
    .createHmac("sha256", CSRF_SECRET)
    .update(`${client_id}|${ts}`)
    .digest("base64url");
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_registrations" },
});

function createMcpServer() {
  const server = new McpServer({ name: SERVER_NAME, version: "1.0.0" });

  server.tool(
    "aws_cli",
    "Run an AWS CLI command using the locally configured AWS profile. Pass arguments as an array of strings (no 'aws' prefix). Each flag and its value must be separate elements. Examples: ['ec2','describe-instances','--region','eu-central-1'], ['s3','ls'], ['logs','filter-log-events','--log-group-name','/aws/lambda/my-fn'].",
    {
      args: z
        .array(z.string())
        .min(1)
        .describe(
          "AWS CLI arguments as an array of strings, e.g. ['ec2','describe-instances','--region','eu-central-1']",
        ),
    },
    async ({ args }) => {
      try {
        const { stdout, stderr } = await execFileAsync("aws", args, {
          maxBuffer: EXEC_BUFFER,
          timeout: EXEC_TIMEOUT_MS,
          windowsHide: true,
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
    "ssh_exec",
    `Run a shell command on a remote host over SSH. Two ways to specify the target:\n\n(A) PREFERRED: pass host=<name from hosts.json> only — no 'key' or 'user' needed (defaults from hosts.json). Named hosts available: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(none - hosts.json not loaded)"}. If the host has 'security_group_id' set in hosts.json, the local public IP is auto-added to that SG on port 22 (and any stale rules tagged 'mcp-auto-ssh' from previous sessions are revoked) before connecting. Result cached 60s.\n\n(B) Legacy: pass host=<raw IP or DNS> AND key=<name from hosts.json 'keys' section>. No SG management.`,
    {
      host: z
        .string()
        .describe(
          `name from hosts.json (preferred) OR raw IP/DNS. Named hosts: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(none)"}`,
        ),
      key: z
        .string()
        .optional()
        .describe(
          "ONLY required if 'host' is a raw IP/DNS. Key name from hosts.json 'keys' section.",
        ),
      user: z
        .string()
        .default("ubuntu")
        .describe("SSH user (default: ubuntu, ignored for named hosts)"),
      command: z.string().describe("shell command to run on the remote host"),
    },
    async ({ host, key, user, command }) => {
      try {
        let stdout, stderr;
        if ((HOSTS_CONFIG.hosts || {})[host]) {
          // Named host — use persistent ssh2 connection pool
          ({ stdout, stderr } = await execSsh(host, command));
        } else {
          // Raw IP/DNS — fall back to ssh CLI (no caching)
          if (!key) {
            throw new Error(
              `host '${host}' not found in hosts.json. Either use a known host (${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "none configured"}) or pass 'key' for raw IP/DNS access.`,
            );
          }
          const keyPath = resolveKeyPath(key);
          const sshArgs = ["-i", keyPath, ...SSH_BASE_OPTS, `${user}@${host}`];
          ({ stdout, stderr } = await execFileAsync(
            "ssh",
            [...sshArgs, command],
            { maxBuffer: EXEC_BUFFER, timeout: EXEC_TIMEOUT_MS, windowsHide: true },
          ));
        }
        const parts = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`--- stderr ---\n${stderr}`);
        return {
          content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
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
    "sftp_download",
    `Download a file from a remote host (over SFTP, reusing the persistent SSH pool) to the local filesystem where this MCP server is running. Streams the transfer — file size is not RAM-bound. Use this when working from Claude.ai web (the cloud sandbox has no access to the local disk) or when scp/rsync isn't a fit. Named hosts only — same pool as ssh_exec/postgres_query/pm2_status. Available hosts: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(none - hosts.json not loaded)"}`,
    {
      host: z
        .string()
        .describe(
          `host from hosts.json — available: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(none)"}`,
        ),
      remote_path: z
        .string()
        .min(1)
        .describe(
          "Absolute path on the remote host (e.g. '/home/ubuntu/backup.sql.gz' or '/var/log/nginx/access.log')",
        ),
      local_path: z
        .string()
        .min(1)
        .describe(
          "Absolute path on the local machine where the file will be written (e.g. 'D:/downloads/backup.sql.gz'). Parent directory is created if missing. Existing file is overwritten unless overwrite=false.",
        ),
      overwrite: z
        .boolean()
        .default(true)
        .describe("If false, fail when local_path already exists. Default true."),
    },
    async ({ host, remote_path, local_path, overwrite }) => {
      const t0 = Date.now();
      try {
        if (hasControlChar(local_path)) {
          throw new Error(
            "local_path contains control characters. Use forward slashes (D:/path/file) or escaped backslashes (D:\\\\path\\\\file) in JSON arguments.",
          );
        }

        const resolvedLocal = path.resolve(local_path);

        if (!overwrite) {
          try {
            await fs.access(resolvedLocal);
            throw new Error(
              `local_path exists and overwrite=false: ${resolvedLocal}`,
            );
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }

        await fs.mkdir(path.dirname(resolvedLocal), { recursive: true });

        const bytes = await withSftp(host, (sftp) =>
          new Promise((resolve, reject) => {
            sftp.stat(remote_path, (statErr, attrs) => {
              if (statErr) {
                return reject(
                  new Error(`remote file not accessible: ${statErr.message}`),
                );
              }
              const expected = attrs.size;
              const readStream = sftp.createReadStream(remote_path);
              const writeStream = fsSync.createWriteStream(resolvedLocal);
              let transferred = 0;
              readStream.on("data", (chunk) => {
                transferred += chunk.length;
              });
              readStream.on("error", reject);
              writeStream.on("error", reject);
              writeStream.on("finish", () => resolve({ transferred, expected }));
              readStream.pipe(writeStream);
            });
          }),
        );

        const ms = Date.now() - t0;
        const sizeMb = (bytes.transferred / 1024 / 1024).toFixed(2);
        const rate = bytes.transferred / ms; // bytes/ms = KB/s
        return {
          content: [
            {
              type: "text",
              text: `OK\nfrom: ${host}:${remote_path}\nto:   ${resolvedLocal}\nbytes: ${bytes.transferred}${bytes.expected !== bytes.transferred ? ` (expected ${bytes.expected})` : ""}\nsize: ${sizeMb} MB\nduration: ${ms}ms\nthroughput: ${rate.toFixed(0)} KB/s`,
            },
          ],
        };
      } catch (e) {
        const ms = Date.now() - t0;
        return {
          content: [
            {
              type: "text",
              text: `ERROR: ${e.message}\nafter ${ms}ms\nfrom: ${host}:${remote_path}\nto:   ${local_path}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "sftp_upload",
    `Upload a local file to a remote host (over SFTP, reusing the persistent SSH pool). Streams the transfer. Use when scp/rsync isn't available (Claude.ai web sandbox, no native shell). Named hosts only. Available hosts: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(none - hosts.json not loaded)"}. NOTE: this writes as the SSH user (typically 'ubuntu'). For root-owned destinations, upload to /tmp first and move via ssh_exec + sudo.`,
    {
      host: z
        .string()
        .describe(
          `host from hosts.json — available: ${Object.keys(HOSTS_CONFIG.hosts || {}).join(", ") || "(none)"}`,
        ),
      local_path: z
        .string()
        .min(1)
        .describe(
          "Absolute path on the local machine to read from (e.g. 'D:/projects/my-config.json')",
        ),
      remote_path: z
        .string()
        .min(1)
        .describe(
          "Absolute path on the remote host where the file will be written (e.g. '/home/ubuntu/uploads/config.json'). Parent directory must already exist — SFTP upload does not create intermediate dirs.",
        ),
      overwrite: z
        .boolean()
        .default(true)
        .describe("If false, fail when remote_path already exists. Default true."),
      mode: z
        .string()
        .regex(/^0?[0-7]{3,4}$/)
        .optional()
        .describe(
          "Optional POSIX mode in octal (e.g. '0644', '0755'). If omitted, server default applies.",
        ),
    },
    async ({ host, local_path, remote_path, overwrite, mode }) => {
      const t0 = Date.now();
      try {
        if (hasControlChar(local_path)) {
          throw new Error(
            "local_path contains control characters. Use forward slashes (D:/path/file) or escaped backslashes in JSON.",
          );
        }
        const resolvedLocal = path.resolve(local_path);
        const localStat = await fs.stat(resolvedLocal).catch((e) => {
          throw new Error(`local file not readable: ${e.message}`);
        });
        if (!localStat.isFile()) {
          throw new Error(`local_path is not a regular file: ${resolvedLocal}`);
        }
        const expectedBytes = localStat.size;

        const result = await withSftp(host, (sftp) =>
          new Promise((resolve, reject) => {
            const proceed = () => {
              const readStream = fsSync.createReadStream(resolvedLocal);
              const writeStream = sftp.createWriteStream(remote_path);
              let transferred = 0;
              readStream.on("data", (c) => (transferred += c.length));
              readStream.on("error", reject);
              writeStream.on("error", reject);
              writeStream.on("close", () => {
                if (mode) {
                  const modeNum = parseInt(mode, 8);
                  sftp.chmod(remote_path, modeNum, (chmodErr) => {
                    if (chmodErr) {
                      return reject(
                        new Error(`upload ok but chmod failed: ${chmodErr.message}`),
                      );
                    }
                    resolve({ transferred });
                  });
                } else {
                  resolve({ transferred });
                }
              });
              readStream.pipe(writeStream);
            };

            if (!overwrite) {
              sftp.stat(remote_path, (statErr) => {
                if (!statErr) {
                  return reject(
                    new Error(
                      `remote_path exists and overwrite=false: ${remote_path}`,
                    ),
                  );
                }
                // ENOENT or similar — file does not exist, proceed
                proceed();
              });
            } else {
              proceed();
            }
          }),
        );

        const ms = Date.now() - t0;
        const sizeMb = (result.transferred / 1024 / 1024).toFixed(2);
        const rate = result.transferred / ms;
        return {
          content: [
            {
              type: "text",
              text: `OK\nfrom: ${resolvedLocal}\nto:   ${host}:${remote_path}\nbytes: ${result.transferred}${result.transferred !== expectedBytes ? ` (local stat said ${expectedBytes})` : ""}\nsize: ${sizeMb} MB\nduration: ${ms}ms\nthroughput: ${rate.toFixed(0)} KB/s${mode ? `\nmode: ${mode}` : ""}`,
            },
          ],
        };
      } catch (e) {
        const ms = Date.now() - t0;
        return {
          content: [
            {
              type: "text",
              text: `ERROR: ${e.message}\nafter ${ms}ms\nfrom: ${local_path}\nto:   ${host}:${remote_path}`,
            },
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
      // Catch JSON-escape disasters in command strings the same way write_file
      // catches them in paths: a TAB / CR / LF that crept in via single backslash
      // in JSON (e.g. "D:\\tmp" -> literal TAB). Cmd.exe sometimes silently
      // normalizes (splits the path on TAB) producing surprising behavior; bash
      // never does. Reject early with the same diagnostic message.
      if (hasControlChar(command)) {
        const codes = [...command]
          .slice(0, 60)
          .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join(" ");
        return {
          content: [
            {
              type: "text",
              text: `ERROR: command contains control character (TAB/CR/LF/NUL). Likely a JSON-escape bug — you probably wrote "D:\\temp" instead of "D:\\\\temp" or "D:/temp". First 60 bytes (hex): ${codes}`,
            },
          ],
          isError: true,
        };
      }
      try {
        const { stdout, stderr } = await execAsync(command, {
          maxBuffer: EXEC_BUFFER,
          cwd: cwd || undefined,
          shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
          timeout: EXEC_TIMEOUT_MS,
          windowsHide: true,
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
    "write_file",
    "Write text content to a file on the local machine. Creates parent directories if needed. Overwrites existing files. Use this for creating or replacing any text file (source code, markdown, JSON, config files, etc.) - no shell quoting, no encoding issues, full Unicode support. For appending to a file, use mode='append'.",
    {
      path: z
        .string()
        .describe(
          "absolute path to the file, e.g. 'D:\\\\projects\\\\myapp\\\\src\\\\index.js' or '/home/user/notes.md'",
        ),
      content: z.string().describe("full text content to write"),
      mode: z
        .enum(["overwrite", "append"])
        .default("overwrite")
        .describe(
          "'overwrite' replaces the file (default), 'append' adds to the end",
        ),
    },
    async ({ path: filePath, content, mode }) => {
      // Detect JSON-escape disasters: TAB/CR/LF/NUL in path = client sent
      // `\t`, `\n`, `\r`, `\0` as single backslash instead of `\\t` etc.
      // mkdir would create or fail silently with garbage names. Reject early.
      if (hasControlChar(filePath)) {
        const codes = [...filePath]
          .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join(" ");
        return {
          content: [
            {
              type: "text",
              text: `ERROR: path contains control character (TAB/CR/LF/NUL). Likely a JSON-escape bug — you probably wrote "D:\\temp" instead of "D:\\\\temp" or "D:/temp". Path bytes: ${codes}`,
            },
          ],
          isError: true,
        };
      }
      // Defensive size limit: large overwrite content is at high risk of
      // being truncated mid-stream by client output limits or overload retries.
      // For mega-files, the caller MUST chunk via mode=append. This prevents
      // silent corruption where only part of intended content lands on disk.
      const sizeBytes = Buffer.byteLength(content, "utf8");
      const HARD_LIMIT = 50 * 1024;
      const WARN_LIMIT = 30 * 1024;
      if (sizeBytes > HARD_LIMIT && mode === "overwrite") {
        return {
          content: [
            {
              type: "text",
              text:
                "ERROR: content size " +
                (sizeBytes / 1024).toFixed(1) +
                " KB " +
                "exceeds single-write hard limit (" +
                HARD_LIMIT / 1024 +
                " KB). " +
                "This write would risk being truncated by output limits or " +
                "overload retries.\\n\\n" +
                "REQUIRED FIX: chunk the content.\\n" +
                '1. First call: write_file mode=\"overwrite\" with first ~20-30 KB ' +
                "(opening structure + first section)\\n" +
                '2. Subsequent calls: write_file mode=\"append\", each ~20-30 KB chunk\\n' +
                '3. Final call: write_file mode=\"append\" with closing structure\\n\\n' +
                "If you got this error after a previous chunk succeeded, your retry " +
                "was using overwrite mode - switch to append.",
            },
          ],
          isError: true,
        };
      }
      if (sizeBytes > WARN_LIMIT) {
        console.warn(
          `[write_file] large content ${(sizeBytes / 1024).toFixed(1)} KB to ${filePath} - consider chunking`,
        );
      }
      try {
        const dir = path.dirname(filePath);
        // Only mkdir for actual subdirectories. path.dirname returns the drive root
        // (e.g. 'D:/' or 'C:\\') when the file lives directly on the root \u2014 fs.mkdir
        // would throw EPERM trying to 'create' the root. Skip in that case.
        const isWindowsRoot = /^[A-Za-z]:[\\\\/]?$/.test(dir);
        const isPosixRoot = dir === "/";
        if (!isWindowsRoot && !isPosixRoot) {
          await fs.mkdir(dir, { recursive: true });
        }
        if (mode === "append") {
          await fs.appendFile(filePath, content, "utf8");
        } else {
          await fs.writeFile(filePath, content, "utf8");
        }
        const stat = await fs.stat(filePath);
        return {
          content: [
            {
              type: "text",
              text: `OK ${mode === "append" ? "appended to" : "wrote"} ${filePath} (${stat.size} bytes)`,
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

      // auto-prefix owner if shortcut form "/repos/repo-name[/sub-resource...]"
      // Detection: if the second segment after /repos/ is a known GitHub sub-resource,
      // then the first segment is a repo name (not an owner) and we prepend GITHUB_OWNER.
      let ep = endpoint.startsWith("/") ? endpoint : "/" + endpoint;
      const KNOWN_SUBRESOURCES = new Set([
        "issues",
        "pulls",
        "commits",
        "contents",
        "branches",
        "tags",
        "releases",
        "actions",
        "workflows",
        "labels",
        "milestones",
        "comments",
        "events",
        "collaborators",
        "deployments",
        "hooks",
        "keys",
        "languages",
        "stargazers",
        "subscribers",
        "topics",
        "readme",
        "license",
        "git",
        "compare",
        "statuses",
        "check-runs",
        "check-suites",
        "code-scanning",
        "secret-scanning",
        "dependabot",
        "pages",
        "vulnerability-alerts",
        "traffic",
        "forks",
        "merges",
        "import",
      ]);
      if (GITHUB_OWNER) {
        const parts = ep.split("/").filter(Boolean); // [repos, X, Y, ...]
        if (
          parts[0] === "repos" &&
          parts[1] &&
          (!parts[2] || KNOWN_SUBRESOURCES.has(parts[2]))
        ) {
          ep = "/" + ["repos", GITHUB_OWNER, ...parts.slice(1)].join("/");
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

  server.tool(
    "postgres_query",
    "Run a SQL query on a PostgreSQL database over SSH on a remote host from hosts.json. Uses psql via 'sudo -u postgres', so no password is needed (passwordless sudo required on the remote). SELECT returns data; DML/DDL also work - be careful on production databases. format='json' wraps SELECT/WITH queries with json_agg and returns a real JSON array.",
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
        .describe(
          "Output format. 'table' = psql aligned text; 'csv' = psql --csv; 'json' = real JSON array (SELECT/WITH only).",
        ),
    },
    async ({ host, database, query, format }) => {
      let finalQuery = query;
      try {
        if (!isValidDatabaseName(database)) {
          throw new Error(
            `Invalid database name: must match [a-zA-Z0-9_]+, got '${database}'`,
          );
        }
        let fmtFlag = "";
        if (format === "csv") {
          fmtFlag = "--csv";
        } else if (format === "json") {
          const trimmed = query.trim().replace(/;+\s*$/, "");
          if (!/^\s*(select|with)\b/i.test(trimmed)) {
            throw new Error(
              "format='json' only works with SELECT or WITH queries",
            );
          }
          finalQuery = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (${trimmed}) t;`;
          fmtFlag = "-A -t";
        }
        // pass SQL via base64 -> stdin to avoid any shell quoting nightmares
        const sqlB64 = Buffer.from(finalQuery, "utf8").toString("base64");
        const remoteCmd = `cd /tmp && echo ${sqlB64} | base64 -d | sudo -u postgres psql -d ${database} ${fmtFlag}`;
        const { stdout, stderr } = await execSsh(host, remoteCmd);
        const parts = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`--- stderr ---\n${stderr}`);
        return {
          content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
        };
      } catch (e) {
        // Include the actual SQL (truncated) so the user can see what failed —
        // base64-wrapped command in stderr is unreadable on its own.
        const sqlPreview =
          finalQuery.length > 1000
            ? finalQuery.slice(0, 1000) + "\n... [truncated]"
            : finalQuery;
        return {
          content: [
            {
              type: "text",
              text: `ERROR: ${e.message}\n${e.stderr || ""}\n--- SQL ---\n${sqlPreview}`,
            },
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
        const buildRemote = (cmd) => {
          const script = [
            'export NVM_DIR="$HOME/.nvm"',
            '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
            'export PATH="$PATH:/usr/local/bin:/usr/bin"',
            cmd,
          ].join("\n");
          const b64 = Buffer.from(script).toString("base64");
          return `echo ${b64} | base64 -d | bash`;
        };
        const remoteCmds = [buildRemote("pm2 list")];
        if (lines > 0) {
          const target = app ? app : "all";
          remoteCmds.push(
            buildRemote(`pm2 logs ${target} --lines ${lines} --nostream`),
          );
        }
        const outputs = [];
        for (const rc of remoteCmds) {
          const { stdout, stderr } = await execSsh(host, rc);
          const partOut = [];
          if (stdout) partOut.push(stdout);
          if (stderr) partOut.push(`--- stderr ---\n${stderr}`);
          outputs.push(partOut.join("\n") || "(no output)");
        }
        return {
          content: [{ type: "text", text: outputs.join("\n\n---\n\n") }],
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

        // Sentence terminator followed by optional closing punctuation (straight
        // and curly quotes, guillemets, right brackets) and end-of-line.
        // Catches: . ! ? ... ." ?>> !) ..." -- common across natural-language
        // and dialog-heavy texts.
        const SENTENCE_END =
          /[.!?\u2026][\s"'\u201D\u2019\u00BB\u203A)\]]*\s*$/;

        for (let i = 0; i < lines.length; i++) {
          const lineWords = lines[i].split(/\s+/).filter(Boolean).length;
          currentChunk.push(lines[i]);
          currentWords += lineWords;
          // primary boundary: empty line after reaching target
          // fallback: any line ending with sentence terminator after 1.5x target
          // hard cap: 2x target on any line break
          const onEmpty =
            currentWords >= words_per_chunk && lines[i].trim() === "";
          const onSentence =
            currentWords >= words_per_chunk * 1.5 &&
            SENTENCE_END.test(lines[i]);
          const onHardCap = currentWords >= words_per_chunk * 2;
          if (onEmpty || onSentence || onHardCap) {
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
      operation: z
        .enum(["get", "set", "append"])
        .describe("get | set | append"),
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
          const keys = key.split(".");
          if (
            keys.some((k) =>
              ["__proto__", "constructor", "prototype"].includes(k),
            )
          ) {
            throw new Error(`Forbidden key segment in '${key}'`);
          }
          const val = keys.reduce(
            (o, k) =>
              o && Object.prototype.hasOwnProperty.call(o, k)
                ? o[k]
                : undefined,
            notes,
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(val, null, 2) ?? "null" },
            ],
          };
        }

        const FORBIDDEN_KEYS = new Set([
          "__proto__",
          "constructor",
          "prototype",
        ]);
        const validatePath = (keys) => {
          for (const k of keys) {
            if (FORBIDDEN_KEYS.has(k)) {
              throw new Error(`Forbidden key segment: '${k}'`);
            }
          }
        };

        if (operation === "set") {
          const keys = key.split(".");
          validatePath(keys);
          let obj = notes;
          for (let i = 0; i < keys.length - 1; i++) {
            if (
              !Object.prototype.hasOwnProperty.call(obj, keys[i]) ||
              typeof obj[keys[i]] !== "object" ||
              obj[keys[i]] === null
            ) {
              obj[keys[i]] = {};
            }
            obj = obj[keys[i]];
          }
          obj[keys[keys.length - 1]] = value;
        }

        if (operation === "append") {
          const keys = key.split(".");
          validatePath(keys);
          let obj = notes;
          for (let i = 0; i < keys.length - 1; i++) {
            if (
              !Object.prototype.hasOwnProperty.call(obj, keys[i]) ||
              typeof obj[keys[i]] !== "object" ||
              obj[keys[i]] === null
            ) {
              obj[keys[i]] = {};
            }
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

  return server;
}

function normalizeIp(ip) {
  if (!ip) return "";
  return ip.replace(/^::ffff:/, "");
}

function ipMatches(clientIp, rule) {
  const a = normalizeIp(clientIp);
  const b = normalizeIp(rule);
  if (a === b) return true;
  if (rule.includes("/")) {
    const [range, bitsStr] = rule.split("/");
    const bits = parseInt(bitsStr, 10);
    const normRange = normalizeIp(range);
    if (!a.includes(".") || !normRange.includes(".")) return false; // IPv4 CIDR only
    const ipToInt = (ip) =>
      ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>>
      0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipToInt(a) & mask) === (ipToInt(normRange) & mask);
  }
  return false;
}

function ipToSubnet(ip) {
  // 160.79.106.37 -> 160.79.106.0/24
  if (!ip.includes(".")) return ip; // IPv6 — store as-is
  const octets = ip.split(".");
  if (octets.length !== 4) return ip;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

function enrollIp(req, label) {
  if (!AUTO_ENROLL) return;
  const ip = normalizeIp(req.ip || req.connection?.remoteAddress || "");
  if (!ip) {
    console.log(`[allowlist] enroll skipped (${label}): no IP detected`);
    return;
  }
  // Don't re-enroll if static rule already covers it
  if (ALLOWED_IPS.some((rule) => ipMatches(ip, rule))) {
    console.log(`[allowlist] enroll skipped (${label}): ${ip} matches static`);
    return;
  }
  // Enroll the whole /24 subnet. Claude.ai (and many cloud egresses) rotate
  // source IPs within a /24, so enrolling a single /32 makes the very next
  // request fail. /24 = 256 IPs, acceptable trade-off for personal use.
  const subnet = ipToSubnet(ip);
  // Already covered by another dynamic entry?
  if (dynamicAllowlist.has(subnet)) {
    const existing = dynamicAllowlist.get(subnet);
    if (existing.expires > Date.now()) {
      // Refresh TTL
      existing.expires = Date.now() + ENROLL_TTL_MS;
      saveOauthState();
      console.log(`[allowlist] refreshed ${subnet} via ${label}`);
      return;
    }
  }
  dynamicAllowlist.set(subnet, {
    expires: Date.now() + ENROLL_TTL_MS,
    enrolled_at: Date.now(),
    via: label,
    source_ip: ip,
  });
  saveOauthState();
  console.log(
    `[allowlist] enrolled subnet ${subnet} (from ${ip}) via ${label} (TTL ${ENROLL_TTL_MS / 1000 / 86400}d)`,
  );
}

function isIpAllowed(req) {
  const ip = normalizeIp(req.ip || req.connection?.remoteAddress || "");
  if (!ip) return false;
  if (ALLOWED_IPS.some((rule) => ipMatches(ip, rule))) return true;
  // Iterate dynamicAllowlist — entries are CIDR ranges, not single IPs
  for (const [rule, data] of dynamicAllowlist) {
    if (data.expires <= Date.now()) continue;
    if (ipMatches(ip, rule)) return true;
  }
  return false;
}

const app = express();
if (TRUST_PROXY !== false) {
  app.set("trust proxy", TRUST_PROXY);
  console.log(`[trust proxy] set to: ${JSON.stringify(TRUST_PROXY)}`);
}
app.use(express.json({ limit: "50mb" }));

// Log all OAuth/MCP requests
const SENSITIVE_KEYS = new Set([
  "password",
  "client_secret",
  "code_verifier",
  "refresh_token",
  "code",
  "access_token",
]);

function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : v;
  }
  return out;
}

app.use((req, res, next) => {
  if (
    req.path.startsWith("/oauth") ||
    req.path.startsWith("/.well-known") ||
    req.path.startsWith("/mcp")
  ) {
    console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
    console.log("  query:", JSON.stringify(redact(req.query)));
    console.log("  body:", JSON.stringify(redact(req.body)));
    console.log(
      "  headers.auth:",
      req.headers.authorization ? "Bearer [REDACTED]" : "(none)",
    );
    console.log("  headers.content-type:", req.headers["content-type"]);
  }
  next();
});

app.use("/oauth/token", oauthLimiter);
app.use("/oauth/authorize", oauthLimiter);
app.use("/oauth/revoke", oauthLimiter);
app.use("/oauth/register", registerLimiter);

// Anti-clickjacking on the login form: deny framing entirely.
// frameguard only — full helmet defaults add headers that can break the form
// (HSTS over HTTP if local, CSP that blocks inline styles, etc.)
app.use(
  "/oauth/authorize",
  helmet.frameguard({ action: "deny" }),
  helmet.contentSecurityPolicy({
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'unsafe-inline'"], // login form uses inline style attrs
      frameAncestors: ["'none'"],
    },
    dangerouslyDisableDefaultSrc: false,
  }),
);

const mcpHandler = async (req, res) => {
  // IP allowlist gate — applies to /mcp only.
  // Returns 401 (not 403) with WWW-Authenticate so the OAuth client re-runs the
  // login flow, which will auto-enroll the new IP.
  if (!isIpAllowed(req)) {
    const ip = normalizeIp(req.ip || req.connection?.remoteAddress || "");
    console.log(`[allowlist] BLOCKED /mcp from ${ip} (not on list)`);
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
    );
    return res.status(401).end();
  }
  const auth = req.headers.authorization || "";
  const bearer = auth.replace(/^Bearer\s+/, "");
  const tokenData = bearer ? accessTokens.get(hashToken(bearer)) : null;
  if (!tokenData || tokenData.expires < Date.now()) {
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
    );
    return res.status(401).end();
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
};

app.post("/mcp", mcpHandler);
app.get("/mcp", mcpHandler);
app.delete("/mcp", mcpHandler);

// === OAuth 2.1 endpoints for MCP ===

// Discovery - Claude.ai fetches endpoint URLs here
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    revocation_endpoint: `${BASE_URL}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post"],
  });
});

// Resource discovery - new MCP standard
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
  });
});

// Dynamic Client Registration - Claude registers itself here automatically
app.post("/oauth/register", (req, res) => {
  if (clients.size >= MAX_CLIENTS) {
    console.warn(
      `[oauth] register rejected: client registry full (${clients.size}/${MAX_CLIENTS})`,
    );
    return res.status(503).json({ error: "client_registry_full" });
  }
  const client_id = crypto.randomBytes(16).toString("hex");
  const client_secret = crypto.randomBytes(32).toString("hex");
  clients.set(client_id, {
    client_secret,
    redirect_uris: req.body.redirect_uris || [],
    token_endpoint_auth_method:
      req.body.token_endpoint_auth_method || "client_secret_post",
    created_at: Date.now(),
  });
  saveOauthState();

  res.status(201).json({
    client_id,
    client_secret,
    redirect_uris: req.body.redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
});

// Authorize - shows login form; on submit redirects with an auth code
app.get("/oauth/authorize", (req, res) => {
  const {
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
  } = req.query;
  const client = clients.get(client_id);
  if (!client) return res.status(400).send("Unknown client");
  if (
    !Array.isArray(client.redirect_uris) ||
    !client.redirect_uris.includes(redirect_uri)
  ) {
    console.log(
      "  -> FAIL: redirect_uri mismatch. got=",
      redirect_uri,
      "expected one of=",
      client.redirect_uris,
    );
    return res.status(400).send("Invalid redirect_uri");
  }
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const csrf = makeCsrf(client_id);
  res.send(`
    <html><body style="font-family:sans-serif;max-width:400px;margin:50px auto">
      <h2>Sign in to MCP</h2>
      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="client_id" value="${esc(client_id)}">
        <input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}">
        <input type="hidden" name="state" value="${esc(state)}">
        <input type="hidden" name="code_challenge" value="${esc(code_challenge)}">
        <input type="hidden" name="code_challenge_method" value="${esc(code_challenge_method)}">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
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
      csrf,
    } = req.body;
    const client = clients.get(client_id);
    if (!client) return res.status(400).send("Unknown client");
    if (
      !Array.isArray(client.redirect_uris) ||
      !client.redirect_uris.includes(redirect_uri)
    ) {
      return res.status(400).send("Invalid redirect_uri");
    }
    if (!verifyCsrf(csrf, client_id)) {
      console.log("  -> FAIL: CSRF token invalid or expired");
      return res
        .status(400)
        .send(
          "Invalid or expired form token. <a href='javascript:history.back()'>Back</a>",
        );
    }
    if (
      !safeCompare(username, OAUTH_USER) ||
      !safeCompare(password, OAUTH_PASS)
    ) {
      const ip = normalizeIp(req.ip || req.connection?.remoteAddress || "");
      console.log(`[auth] FAIL login from ${ip} user='${username}'`);
      return res
        .status(401)
        .send(
          "Invalid credentials. <a href='javascript:history.back()'>Back</a>",
        );
    }
    enrollIp(req, "oauth_login");
    const code = crypto.randomBytes(24).toString("hex");
    authCodes.set(code, {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      expires: Date.now() + AUTH_CODE_TTL_MS,
    });
    saveOauthState();

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  },
);

// Token - exchange auth code for access_token
app.post("/oauth/token", express.urlencoded({ extended: true }), (req, res) => {
  const { grant_type, code, client_id, code_verifier } = req.body;
  const provided_client_secret = req.body.client_secret;
  console.log("  TOKEN req:", {
    grant_type,
    code: code ? `${code.slice(0, 8)}...` : undefined,
    client_id,
    code_verifier: code_verifier ? "[REDACTED]" : undefined,
    client_secret: provided_client_secret ? "[REDACTED]" : undefined,
  });

  // Authenticate client (if it has a secret stored, it MUST present it)
  const clientRecord = clients.get(client_id);
  if (!clientRecord) {
    console.log("  -> FAIL: unknown client_id:", client_id);
    return res.status(401).json({ error: "invalid_client" });
  }
  if (clientRecord.client_secret) {
    if (
      !provided_client_secret ||
      !safeCompare(provided_client_secret, clientRecord.client_secret)
    ) {
      console.log("  -> FAIL: bad client_secret for client:", client_id);
      return res.status(401).json({ error: "invalid_client" });
    }
  }

  // refresh_token grant
  if (grant_type === "refresh_token") {
    const { refresh_token: rt } = req.body;
    console.log("  REFRESH for token:", rt?.slice(0, 8));
    if (!rt) {
      console.log("  -> FAIL: missing refresh_token");
      return res.status(400).json({ error: "invalid_request" });
    }
    const rtHash = hashToken(rt);
    const rtData = refreshTokens.get(rtHash);
    if (!rtData || rtData.expires < Date.now()) {
      console.log(
        "  -> FAIL: invalid refresh_token (exists?",
        !!rtData,
        "expired?",
        rtData?.expires < Date.now(),
        ")",
      );
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (rtData.client_id !== client_id) {
      console.log(
        "  -> FAIL: refresh_token client_id mismatch. token=",
        rtData.client_id,
        "req=",
        client_id,
      );
      return res.status(400).json({ error: "invalid_grant" });
    }
    // Rotation: invalidate the old refresh_token
    refreshTokens.delete(rtHash);
    const new_at = crypto.randomBytes(32).toString("hex");
    const new_rt = crypto.randomBytes(32).toString("hex");
    accessTokens.set(hashToken(new_at), {
      client_id,
      expires: Date.now() + TOKEN_TTL_MS,
    });
    refreshTokens.set(hashToken(new_rt), {
      client_id,
      expires: Date.now() + TOKEN_TTL_MS,
    });
    saveOauthState();

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
  if (codeData.client_id !== client_id) {
    console.log(
      "  -> FAIL: code client_id mismatch. code=",
      codeData.client_id,
      "req=",
      client_id,
    );
    authCodes.delete(code); // one-time use — invalidate
    return res.status(400).json({ error: "invalid_grant" });
  }

  // PKCE verify - S256 only
  if (codeData.code_challenge) {
    if (codeData.code_challenge_method !== "S256") {
      console.log(
        "  -> FAIL: PKCE method not S256:",
        codeData.code_challenge_method,
      );
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (!code_verifier) {
      console.log("  -> FAIL: missing code_verifier");
      return res.status(400).json({ error: "invalid_grant" });
    }
    const challenge = crypto
      .createHash("sha256")
      .update(code_verifier)
      .digest("base64url");
    if (
      challenge.length !== codeData.code_challenge.length ||
      !crypto.timingSafeEqual(
        Buffer.from(challenge),
        Buffer.from(codeData.code_challenge),
      )
    ) {
      console.log("  -> FAIL: PKCE mismatch");
      return res.status(400).json({ error: "invalid_grant" });
    }
    console.log("  PKCE OK");
  }

  authCodes.delete(code);
  const access_token = crypto.randomBytes(32).toString("hex");
  const refresh_token = crypto.randomBytes(32).toString("hex");
  accessTokens.set(hashToken(access_token), {
    client_id,
    expires: Date.now() + TOKEN_TTL_MS, // 30 days by default
  });
  refreshTokens.set(hashToken(refresh_token), {
    client_id,
    expires: Date.now() + TOKEN_TTL_MS,
  });
  enrollIp(req, "token_exchange");
  saveOauthState();

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

// RFC 7009 - Token Revocation
// Client authenticates (same as /oauth/token), then sends:
//   token=<the_token>
//   token_type_hint=access_token|refresh_token  (optional)
// Always returns 200 unless client auth fails, even if the token doesn't exist
// (RFC requirement — don't leak whether a token was valid).
app.post(
  "/oauth/revoke",
  express.urlencoded({ extended: true }),
  (req, res) => {
    const { token, token_type_hint, client_id } = req.body;
    const provided_client_secret = req.body.client_secret;
    console.log("  REVOKE req:", {
      token: token ? `${token.slice(0, 8)}...` : undefined,
      token_type_hint,
      client_id,
      client_secret: provided_client_secret ? "[REDACTED]" : undefined,
    });

    // Client authentication (same rules as /oauth/token)
    const clientRecord = clients.get(client_id);
    if (!clientRecord) {
      console.log("  -> FAIL: unknown client_id:", client_id);
      return res.status(401).json({ error: "invalid_client" });
    }
    if (clientRecord.client_secret) {
      if (
        !provided_client_secret ||
        !safeCompare(provided_client_secret, clientRecord.client_secret)
      ) {
        console.log("  -> FAIL: bad client_secret for client:", client_id);
        return res.status(401).json({ error: "invalid_client" });
      }
    }

    if (!token) {
      // RFC: missing token is a 200 anyway (idempotent revoke)
      return res.status(200).end();
    }

    // Look up token by hash. token_type_hint is optimization only — we check both maps.
    const tokenHash = hashToken(token);
    const order =
      token_type_hint === "refresh_token"
        ? ["refresh", "access"]
        : ["access", "refresh"];
    let revoked = false;
    for (const kind of order) {
      const map = kind === "access" ? accessTokens : refreshTokens;
      const data = map.get(tokenHash);
      if (!data) continue;
      // Only the owning client can revoke
      if (data.client_id !== client_id) {
        console.log(
          `  -> FAIL: ${kind}_token belongs to ${data.client_id}, request from ${client_id}`,
        );
        // RFC says still respond 200 to avoid leaking info, but log it.
        break;
      }
      map.delete(tokenHash);
      revoked = true;
      console.log(`  REVOKED ${kind}_token for client ${client_id}`);
      break;
    }

    if (revoked) saveOauthState();
    else console.log("  (no matching token found — 200 anyway per RFC 7009)");

    res.status(200).end();
  },
);

// MCP_TEST_MODE=true is set by vitest. In that mode we skip app.listen so the
// test process can import this file as a module to get at its internal
// helpers (resolveKeyPath, safeCompare, makeCsrf/verifyCsrf, getSshClient,
// execSsh, withSftp) without binding to port 4500 or registering signal
// handlers that would crash test shutdown.
let httpServer = null;
if (process.env.MCP_TEST_MODE !== "true") {
  httpServer = app.listen(PORT, () =>
    console.log(`MCP listening on :${PORT}`),
  );

  async function shutdown(signal) {
    console.log(`\n[${signal}] graceful shutdown...`);
    httpServer.close(async () => {
      // Flush pending state save
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        await flushState();
      } catch (e) {
        console.error(`[shutdown] state flush failed: ${e.message}`);
      }
      console.log("[shutdown] done");
      process.exit(0);
    });
    // Force exit after 10s if connections hang
    setTimeout(() => {
      console.error("[shutdown] forced exit");
      process.exit(1);
    }, 10000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// === Exports for vitest ===
// Production server doesn't read these; test files import them directly.
// Kept at module bottom so all definitions above are hoisted into scope.
export {
  resolveKeyPath,
  buildSshArgs,
  safeCompare,
  makeCsrf,
  verifyCsrf,
  getSshClient,
  execSsh,
  withSftp,
  closeAllSshPool,
  SSH_POOL,
  hasControlChar,
  isValidDatabaseName,
};
