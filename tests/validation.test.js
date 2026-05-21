// Tests for input validation helpers: control-char path check (used by
// write_file, local_exec, sftp tools) and database name regex (postgres_query
// SQL injection prevention).

import { describe, test, expect } from "vitest";

process.env.MCP_TEST_MODE = "true";

const { hasControlChar, isValidDatabaseName } = await import("../server.js");

describe("hasControlChar (path safety)", () => {
  test("clean paths pass", () => {
    expect(hasControlChar("D:/projects/file.ts")).toBe(false);
    expect(hasControlChar("D:\\projects\\file.ts")).toBe(false);
    expect(hasControlChar("/var/www/foo/bar.txt")).toBe(false);
    expect(hasControlChar("relative/path/file.md")).toBe(false);
    expect(hasControlChar("with spaces.txt")).toBe(false);
    expect(hasControlChar("non_ascii_äöü_żółć_éàç.txt")).toBe(false);
  });

  test("rejects TAB (\\x09) — the classic JSON-escape \\t bug", () => {
    expect(hasControlChar("D:\tempfile.txt")).toBe(true); // raw \t
    expect(hasControlChar("path/with\tabchar.txt")).toBe(true);
  });

  test("rejects newline (\\x0A) — JSON \\n bug", () => {
    expect(hasControlChar("D:\new\thing.txt")).toBe(true);
    expect(hasControlChar("path\nwith\nnewlines")).toBe(true);
  });

  test("rejects the 6 control chars commonly produced by JSON-escape bugs (\\0 \\t \\n \\v \\f \\r)", () => {
    expect(hasControlChar("path\rwith\rCR")).toBe(true);
    expect(hasControlChar("null\x00byte")).toBe(true);
    expect(hasControlChar("vert\x0Btab")).toBe(true);
    expect(hasControlChar("form\x0Cfeed")).toBe(true);
  });

  test("does NOT reject other ASCII control chars (ESC, BEL, etc) — by design", () => {
    // The regex deliberately scopes to common JSON-escape bug chars only.
    // Other control chars are extraordinarily rare in legitimate paths and
    // not flagged here. If they ever become a real issue, broaden the
    // regex to [\x00-\x1F].
    expect(hasControlChar("escape\x1Bchar")).toBe(false);
    expect(hasControlChar("bell\x07char")).toBe(false);
  });

  test("rejects non-string inputs gracefully (returns false, no throw)", () => {
    expect(hasControlChar(null)).toBe(false);
    expect(hasControlChar(undefined)).toBe(false);
    expect(hasControlChar(123)).toBe(false);
    expect(hasControlChar({})).toBe(false);
  });
});

describe("isValidDatabaseName (postgres_query SQL injection check)", () => {
  test("accepts plain alphanumeric and underscore names", () => {
    expect(isValidDatabaseName("matury_online")).toBe(true);
    expect(isValidDatabaseName("postgres")).toBe(true);
    expect(isValidDatabaseName("db123")).toBe(true);
    expect(isValidDatabaseName("a_b_c_2026")).toBe(true);
    expect(isValidDatabaseName("X")).toBe(true);
  });

  test("rejects names with whitespace", () => {
    expect(isValidDatabaseName("my db")).toBe(false);
    expect(isValidDatabaseName("\tdb")).toBe(false);
    expect(isValidDatabaseName("db\n")).toBe(false);
  });

  test("rejects names with semicolons (SQL termination injection)", () => {
    expect(isValidDatabaseName("matury;DROP")).toBe(false);
    expect(isValidDatabaseName("db'; --")).toBe(false);
  });

  test("rejects names with shell metacharacters (command injection vector)", () => {
    expect(isValidDatabaseName("db|cat")).toBe(false);
    expect(isValidDatabaseName("db`whoami`")).toBe(false);
    expect(isValidDatabaseName("db$(id)")).toBe(false);
    expect(isValidDatabaseName("db&&ls")).toBe(false);
    expect(isValidDatabaseName("db>out")).toBe(false);
  });

  test("rejects names with quotes", () => {
    expect(isValidDatabaseName('"quoted"')).toBe(false);
    expect(isValidDatabaseName("'single'")).toBe(false);
  });

  test("rejects empty and non-string inputs", () => {
    expect(isValidDatabaseName("")).toBe(false);
    expect(isValidDatabaseName(null)).toBe(false);
    expect(isValidDatabaseName(undefined)).toBe(false);
    expect(isValidDatabaseName(123)).toBe(false);
  });

  test("rejects dashes and dots (uncommon but valid PG names — locked down on purpose)", () => {
    // Postgres itself allows these in quoted identifiers, but our tool
    // disallows them since we don't quote the value going into psql -d.
    expect(isValidDatabaseName("my-db")).toBe(false);
    expect(isValidDatabaseName("schema.db")).toBe(false);
  });
});
