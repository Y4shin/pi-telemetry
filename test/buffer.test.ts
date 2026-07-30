import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";
import { createBuffer } from "../src/buffer.ts";
import type { TelemetryConfig } from "../src/config.ts";

describe("buffer", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;
  let config: TelemetryConfig;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
    config = {
      enabled: true,
      dbPath,
      bufferFlushMs: 10000,
      bufferMaxRows: 50,
      feedbackMaxBytes: 65536,
      capture: { toolArgs: false, toolResults: false, bashCommand: false },
    };
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("flushes on row threshold", () => {
    const t = createBuffer({ ...config, bufferMaxRows: 5 }, db);
    for (let i = 0; i < 5; i++) {
      t.enqueue(
        "INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)",
        [i, "error", "test"],
      );
    }
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta")
      .get() as { c: number };
    assert.strictEqual(count.c, 5);
  });

  it("flushes on timer", async () => {
    const t = createBuffer({ ...config, bufferFlushMs: 10, bufferMaxRows: 100 }, db);
    t.enqueue(
      "INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)",
      [1, "warn", "timer-test"],
    );
    await new Promise((r) => setTimeout(r, 50));
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta")
      .get() as { c: number };
    assert.strictEqual(count.c, 1);
  });

  it("flushes remaining rows on close", () => {
    const t = createBuffer({ ...config, bufferMaxRows: 100 }, db);
    t.enqueue(
      "INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)",
      [1, "error", "close-test"],
    );
    t.close();
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta")
      .get() as { c: number };
    assert.strictEqual(count.c, 1);
  });

  it("swallows DB errors and records telemetry_meta row", () => {
    const t = createBuffer({ ...config, bufferMaxRows: 1 }, db);
    t.enqueue("INSERT INTO no_such_table (x) VALUES (?)", [1]);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'write_failed'")
      .get() as { c: number };
    assert.strictEqual(count.c, 1);
  });
});

describe("flush_log", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;
  let config: TelemetryConfig;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
    config = {
      enabled: true,
      dbPath,
      bufferFlushMs: 10000,
      bufferMaxRows: 50,
      feedbackMaxBytes: 65536,
      capture: { toolArgs: false, toolResults: false, bashCommand: false },
    };
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function flushLogRows(): Array<{
    id: number;
    unix_ms: number;
    session_id: string | null;
    row_count: number;
    tx_duration_ms: number;
  }> {
    return db.prepare("SELECT id, unix_ms, session_id, row_count, tx_duration_ms FROM flush_log ORDER BY id").all() as Array<{
      id: number;
      unix_ms: number;
      session_id: string | null;
      row_count: number;
      tx_duration_ms: number;
    }>;
  }

  it("writes one flush_log row per non-empty flush with row_count and duration", () => {
    const t = createBuffer({ ...config, bufferMaxRows: 2 }, db);
    t.enqueue("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)", [1, "warn", "a"]);
    t.enqueue("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)", [2, "warn", "b"]);
    const rows = flushLogRows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].row_count, 2);
    assert.ok(rows[0].tx_duration_ms >= 0, "tx_duration_ms must be non-negative");
    assert.strictEqual(rows[0].session_id, null);
  });

  it("stamps session_id on flush_log when session is known", () => {
    const t = createBuffer({ ...config, bufferMaxRows: 1 }, db);
    t.state.sessionId = "sess-flush";
    t.enqueue("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)", [1, "warn", "a"]);
    const rows = flushLogRows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].session_id, "sess-flush");
  });

  it("does not count the flush_log row in the batch it logs", () => {
    const t = createBuffer({ ...config, bufferMaxRows: 1 }, db);
    t.enqueue("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)", [1, "warn", "a"]);
    const rows = flushLogRows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].row_count, 1);
    // The logged row itself should not have appeared in the buffered batch.
    const metaCount = db.prepare("SELECT COUNT(*) AS c FROM telemetry_meta").get() as { c: number };
    assert.strictEqual(metaCount.c, 1);
  });

  it("does not write a flush_log row for empty flushes", () => {
    const t = createBuffer({ ...config, bufferMaxRows: 1 }, db);
    t.flush();
    t.close();
    const rows = flushLogRows();
    assert.strictEqual(rows.length, 0);
  });

  it("does not recurse: a second flush contains only new buffered rows", () => {
    const t = createBuffer({ ...config, bufferMaxRows: 2 }, db);
    t.enqueue("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)", [1, "warn", "a"]);
    t.enqueue("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)", [2, "warn", "b"]);
    const rows = flushLogRows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].row_count, 2);

    t.enqueue("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)", [3, "warn", "c"]);
    t.flush();
    const rows2 = flushLogRows();
    assert.strictEqual(rows2.length, 2);
    assert.strictEqual(rows2[1].row_count, 1);
    const metaCount = db.prepare("SELECT COUNT(*) AS c FROM telemetry_meta").get() as { c: number };
    assert.strictEqual(metaCount.c, 3);
  });

  it("swallows flush_log insert failure and records write_failed meta", () => {
    const t = createBuffer({ ...config, bufferMaxRows: 2 }, db);
    db.exec("DROP TABLE flush_log");
    t.enqueue("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)", [1, "warn", "a"]);
    t.enqueue("INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)", [2, "warn", "b"]);
    const metaCount = db.prepare("SELECT COUNT(*) AS c FROM telemetry_meta").get() as { c: number };
    assert.strictEqual(metaCount.c, 3); // 2 data rows + 1 best-effort write_failed meta
    const failed = db.prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'write_failed'").get() as { c: number };
    assert.strictEqual(failed.c, 1);
  });
});
