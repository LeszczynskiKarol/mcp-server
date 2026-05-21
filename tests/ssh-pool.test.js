// Tests for the persistent ssh2 connection pool. We mock the entire 'ssh2'
// module so no real SSH happens — only the pool logic runs.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

process.env.MCP_TEST_MODE = "true";

// Mock ssh2 BEFORE importing server.js.
// Use an async factory so we can dynamic-import node:events — vi.mock is
// hoisted above all top-level imports, so referencing a top-level
// `import { EventEmitter } from "node:events"` here would race the
// vitest module resolver.
vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  class MockSshClient extends EventEmitter {
    constructor() {
      super();
      this._sock = { destroyed: false };
      this._execHandlers = [];
      this._destroyed = false;
    }

    connect(opts) {
      this._opts = opts;
      // Emit 'ready' on next tick to mimic real async behavior
      setImmediate(() => this.emit("ready"));
    }

    exec(cmd, cb) {
      // Use a registered handler if set, else default stub
      const handler = this._execHandlers.shift();
      if (handler) return handler(cmd, cb);
      // Default: return empty stdout, exit 0
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.signal = vi.fn();
      stream.close = vi.fn();
      cb(null, stream);
      setImmediate(() => {
        stream.emit("data", Buffer.from("ok\n"));
        stream.emit("close", 0, null);
      });
    }

    sftp(cb) {
      // Minimal SFTP mock — returns an EventEmitter-ish object
      const sftp = {
        end: vi.fn(),
        stat: vi.fn(),
        createReadStream: vi.fn(),
        createWriteStream: vi.fn(),
        chmod: vi.fn(),
      };
      cb(null, sftp);
    }

    end() {
      this._sock.destroyed = true;
      this._destroyed = true;
      this.emit("close");
    }

    // Test helpers
    _queueExec(handler) {
      this._execHandlers.push(handler);
    }
    _simulateSocketDeath() {
      this._sock.destroyed = true;
    }
  }

  return { Client: MockSshClient };
});

// Mock fs.readFile so resolveKeyPath → fs.readFile(KEY) doesn't hit the disk
// (only matters for SSH pool — auth-utils tests don't trigger this path)
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual.default || actual,
    readFile: vi.fn().mockResolvedValue(Buffer.from("FAKE-PRIVATE-KEY")),
  };
});

const { getSshClient, execSsh, SSH_POOL, closeAllSshPool } = await import(
  "../server.js"
);

beforeEach(() => {
  closeAllSshPool();
  SSH_POOL.clear();
});

afterEach(() => {
  closeAllSshPool();
});

describe("getSshClient", () => {
  test("first call creates and pools a new ssh2 Client", async () => {
    expect(SSH_POOL.size).toBe(0);
    const client = await getSshClient("matury");
    expect(client).toBeDefined();
    expect(client._sock.destroyed).toBe(false);
    expect(SSH_POOL.has("matury")).toBe(true);
    expect(SSH_POOL.size).toBe(1);
  });

  test("second call returns the SAME client (reuse)", async () => {
    const c1 = await getSshClient("matury");
    const c2 = await getSshClient("matury");
    expect(c1).toBe(c2);
    expect(SSH_POOL.size).toBe(1);
  });

  test("dead socket triggers reconnection on next call", async () => {
    const c1 = await getSshClient("matury");
    c1._simulateSocketDeath();
    const c2 = await getSshClient("matury");
    expect(c2).not.toBe(c1);
    expect(SSH_POOL.size).toBe(1);
  });

  test("concurrent first-call requests await the same connecting promise", async () => {
    const [a, b, c] = await Promise.all([
      getSshClient("matury"),
      getSshClient("matury"),
      getSshClient("matury"),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(SSH_POOL.size).toBe(1);
  });

  test("throws on unknown host", async () => {
    await expect(getSshClient("nonexistent-host")).rejects.toThrow(
      /Unknown host.*'nonexistent-host'/,
    );
  });
});

describe("execSsh", () => {
  test("happy path: returns stdout and resolves with code 0", async () => {
    const client = await getSshClient("matury");
    client._queueExec((cmd, cb) => {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.signal = vi.fn();
      stream.close = vi.fn();
      cb(null, stream);
      setImmediate(() => {
        stream.emit("data", Buffer.from("hello world\n"));
        stream.emit("close", 0, null);
      });
    });
    const result = await execSsh("matury", "echo hi");
    expect(result.stdout).toBe("hello world\n");
    expect(result.code).toBe(0);
  });

  test("non-zero exit throws Error with .code, .stdout, .stderr attached", async () => {
    const client = await getSshClient("matury");
    client._queueExec((cmd, cb) => {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.signal = vi.fn();
      stream.close = vi.fn();
      cb(null, stream);
      setImmediate(() => {
        stream.emit("data", Buffer.from("partial-out"));
        stream.stderr.emit("data", Buffer.from("err-detail"));
        stream.emit("close", 3, null);
      });
    });
    try {
      await execSsh("matury", "false");
      throw new Error("expected execSsh to throw");
    } catch (e) {
      expect(e.message).toMatch(/exit code 3/);
      expect(e.code).toBe(3);
      expect(e.stdout).toBe("partial-out");
      expect(e.stderr).toBe("err-detail");
    }
  });

  test("timeout throws when no close event arrives", async () => {
    const client = await getSshClient("matury");
    client._queueExec((cmd, cb) => {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.signal = vi.fn();
      stream.close = vi.fn();
      cb(null, stream);
      // Never emit 'close' → should trigger timeout
    });
    await expect(
      execSsh("matury", "sleep forever", { timeoutMs: 80 }),
    ).rejects.toThrow(/timed out after 80ms/);
  });

  test("buffers stdout and reports truncation flag when over maxBuffer", async () => {
    const client = await getSshClient("matury");
    const big = Buffer.alloc(20, "X");
    client._queueExec((cmd, cb) => {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.signal = vi.fn();
      stream.close = vi.fn();
      cb(null, stream);
      setImmediate(() => {
        stream.emit("data", big);
        stream.emit("close", 0, null);
      });
    });
    const result = await execSsh("matury", "spam", { maxBuffer: 10 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(10);
  });
});

describe("closeAllSshPool", () => {
  test("closes all clients and empties the pool", async () => {
    await getSshClient("matury");
    await getSshClient("panel");
    expect(SSH_POOL.size).toBe(2);
    closeAllSshPool();
    expect(SSH_POOL.size).toBe(0);
  });
});
