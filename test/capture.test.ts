import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";
import { createBuffer } from "../src/buffer.ts";
import type { TelemetryConfig } from "../src/config.ts";
import { createL1Stub } from "./helpers/l1-stub.ts";
import {
  registerSessionCapture,
  registerRunCapture,
  registerTurnCapture,
} from "../src/capture/index.ts";

function makeConfig(dbPath: string): TelemetryConfig {
  return {
    enabled: true,
    dbPath,
    bufferFlushMs: 10000,
    bufferMaxRows: 100,
    feedbackMaxBytes: 65536,
    capture: { toolArgs: false, toolResults: false, bashCommand: false },
  };
}

describe("session capture", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-capture-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("session_start inserts a sessions row with lineage columns", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-1" },
      cwd: "/tmp/proj",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-1") as Record<string, unknown>;
    assert.ok(row, "sessions row should exist");
    assert.strictEqual(row.session_id, "sess-1");
    assert.strictEqual(row.start_reason, "startup");
    assert.strictEqual(row.cwd, "/tmp/proj");
    assert.strictEqual(row.ended_unix_ms, null);
    assert.strictEqual(row.parent_session_id, null);
    assert.strictEqual(row.parent_run_id, null);
    assert.strictEqual(row.agent_label, null);
    assert.strictEqual(row.depth, null);
  });

  it("session_shutdown updates ended_unix_ms and end_reason", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-2" },
      cwd: "/tmp/proj",
    });
    await stub.fire("session_shutdown", { reason: "quit" });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-2") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.end_reason, "quit");
    assert.strictEqual(typeof row.ended_unix_ms, "number");
  });

  it("session_info_changed updates name", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-3" },
      cwd: "/tmp/proj",
    });
    await stub.fire("session_info_changed", { name: "renamed" });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-3") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.name, "renamed");
  });

  it("session without shutdown leaves ended_at NULL", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-4" },
      cwd: "/tmp/proj",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-4") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.ended_unix_ms, null);
  });
});
