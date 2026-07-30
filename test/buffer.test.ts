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
