// Tests for pure helpers in server.js: path resolution, constant-time
// comparison, and CSRF token round-trip. These have no network or fs side
// effects so they run fast and need no mocks.

import { describe, test, expect, beforeAll } from "vitest";

process.env.MCP_TEST_MODE = "true";

const {
  resolveKeyPath,
  safeCompare,
  makeCsrf,
  verifyCsrf,
} = await import("../server.js");

describe("resolveKeyPath", () => {
  test("resolves a known key from hosts.json", () => {
    // hosts.json has key 'maturapolski' pointing to a PEM path
    const resolved = resolveKeyPath("maturapolski");
    // Cross-platform: Windows path may use backslashes after normalization
    expect(resolved).toMatch(/maturapolski-key\.pem$/);
  });

  test("throws on unknown key with helpful message", () => {
    expect(() => resolveKeyPath("nonexistent-key-xyz")).toThrowError(
      /Unknown key.*'nonexistent-key-xyz'/,
    );
  });
});

describe("safeCompare", () => {
  test("returns true for equal strings", () => {
    expect(safeCompare("abc123", "abc123")).toBe(true);
  });

  test("returns false for different strings of equal length", () => {
    expect(safeCompare("abc123", "abc124")).toBe(false);
  });

  test("returns false for different lengths (early exit)", () => {
    expect(safeCompare("abc", "abc123")).toBe(false);
    expect(safeCompare("abc123", "abc")).toBe(false);
  });

  test("rejects non-string inputs", () => {
    expect(safeCompare(null, "abc")).toBe(false);
    expect(safeCompare("abc", null)).toBe(false);
    expect(safeCompare(123, 123)).toBe(false);
  });
});

describe("CSRF tokens", () => {
  test("round-trips with same client_id", () => {
    const token = makeCsrf("client-abc");
    expect(verifyCsrf(token, "client-abc")).toBe(true);
  });

  test("rejects cross-client_id replay", () => {
    const token = makeCsrf("client-abc");
    expect(verifyCsrf(token, "client-xyz")).toBe(false);
  });

  test("rejects tampered signature", () => {
    const token = makeCsrf("client-abc");
    // Flip the last character of the signature
    const dotIndex = token.indexOf(".");
    const ts = token.slice(0, dotIndex);
    const sig = token.slice(dotIndex + 1);
    const flippedChar = sig.endsWith("A") ? "B" : "A";
    const tampered = `${ts}.${sig.slice(0, -1)}${flippedChar}`;
    expect(verifyCsrf(tampered, "client-abc")).toBe(false);
  });

  test("rejects tokens older than TTL", () => {
    // Forge a token whose timestamp is 11 minutes ago (TTL is 10 min)
    const oldTs = Date.now() - 11 * 60 * 1000;
    const fakeToken = `${oldTs}.someSignature`;
    expect(verifyCsrf(fakeToken, "client-abc")).toBe(false);
  });

  test("rejects malformed tokens", () => {
    expect(verifyCsrf("no-dot-here", "client-abc")).toBe(false);
    expect(verifyCsrf("", "client-abc")).toBe(false);
    expect(verifyCsrf(null, "client-abc")).toBe(false);
    expect(verifyCsrf(".justSig", "client-abc")).toBe(false);
  });

  test("makeCsrf produces different signatures across calls (timestamp varies)", async () => {
    const t1 = makeCsrf("client-abc");
    await new Promise((r) => setTimeout(r, 5));
    const t2 = makeCsrf("client-abc");
    // Even if both verify, the literal token strings should differ (different ts)
    expect(t1).not.toBe(t2);
    expect(verifyCsrf(t1, "client-abc")).toBe(true);
    expect(verifyCsrf(t2, "client-abc")).toBe(true);
  });
});
