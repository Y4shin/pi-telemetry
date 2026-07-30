import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";
import { guardedQuery } from "../src/query/sql-guard.ts";

describe("sql-guard", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
    db.exec(
      "INSERT INTO telemetry_meta (unix_ms, level, event, detail) VALUES (1, 'error', 'handler_error', 'boom')",
    );
    db.exec(
      "INSERT INTO telemetry_meta (unix_ms, level, event, detail) VALUES (2, 'warn', 'busy_retry', 'retry')",
    );
  });

  afterEach(() => {
    try {
      db.close();
    } catch { /* ignore */ }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("returns columns and rows for a SELECT", async () => {
    const result = await guardedQuery(dbPath, "SELECT level, event FROM telemetry_meta ORDER BY unix_ms");
    assert.deepStrictEqual(result.columns, ["level", "event"]);
    assert.strictEqual(result.rows.length, 2);
    assert.deepStrictEqual(result.rows[0], ["error", "handler_error"]);
    assert.deepStrictEqual(result.rows[1], ["warn", "busy_retry"]);
    assert.strictEqual(result.truncated, false);
  });

  it("injects LIMIT 500 when absent", async () => {
    const result = await guardedQuery(dbPath, "SELECT level FROM telemetry_meta");
    assert.ok(result.rows.length <= 500);
    assert.strictEqual(result.truncated, false);
  });

  it("enforces a 500-row cap and reports truncation", async () => {
    // Insert enough rows to exceed the cap.
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, 'info', 'x')");
    for (let i = 0; i < 600; i++) {
      insert.run(i + 10);
    }
    db.exec("COMMIT");
    const result = await guardedQuery(dbPath, "SELECT level FROM telemetry_meta");
    assert.strictEqual(result.rows.length, 500);
    assert.strictEqual(result.truncated, true);
  });

  it("does not double-inject LIMIT when present", async () => {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, 'info', 'x')");
    for (let i = 0; i < 10; i++) {
      insert.run(i + 10);
    }
    db.exec("COMMIT");
    const result = await guardedQuery(dbPath, "SELECT level FROM telemetry_meta LIMIT 5");
    assert.strictEqual(result.rows.length, 5);
    assert.strictEqual(result.truncated, false);
  });

  it("rejects writes by construction on a read-only connection", async () => {
    await assert.rejects(
      () => guardedQuery(dbPath, "CREATE TABLE hack (x TEXT)"),
      /read-only|query_only|attempt to write/i,
    );
  });

  it("kills a runaway query at the configured timeout", async () => {
    // randomblob(8MB) takes ~20ms; timeout of 10ms should interrupt it.
    await assert.rejects(
      () => guardedQuery(dbPath, "SELECT randomblob(8000000)", 10),
      /timed out/i,
    );
  });
});
