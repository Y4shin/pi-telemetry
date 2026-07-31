// Reproduction for: tool_executions INSERT fails UNIQUE on tool_call_id
//
// Simulates the suspected trigger (session resumption / cross-process replay of
// an already-recorded tool_call_id) and demonstrates the buffer catastrophe:
// a single duplicate INSERT poisons its whole flush batch, which is re-enqueued
// forever, blocking ALL telemetry for the session (total data loss).
//
// Run:  node --test docs/bugs/repro-duplicate-insert.ts
// (or:  npx tsx docs/bugs/repro-duplicate-insert.ts  -- but node 24 type-strips)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/db.ts";
import { createBuffer } from "../../src/buffer.ts";
import type { TelemetryConfig } from "../../src/config.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createL1Stub } from "../../test/helpers/l1-stub.ts";
import {
  registerSessionCapture,
  registerRunCapture,
  registerTurnCapture,
  registerToolCapture,
} from "../../src/capture/index.ts";

function makeConfig(dbPath: string): TelemetryConfig {
  return {
    enabled: true,
    dbPath,
    bufferFlushMs: 0, // disable auto-flush; we flush manually
    bufferMaxRows: 1_000_000, // never auto-flush by count
    feedbackMaxBytes: 65536,
    capture: { toolArgs: false, toolResults: false, bashCommand: false },
  };
}

describe("REPRO: duplicate tool_call_id causes total session data loss", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-repro-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("one replayed tool_call_id poisons the whole batch and loses everything", async () => {
    // --- Simulate a PRIOR process that already recorded tool_call_id "tc-replayed" ---
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)",
    ).run("sess-prior", 1000);
    db.prepare(
      `INSERT INTO tool_executions
       (tool_call_id, session_id, tool_name, started_unix_ms)
       VALUES (?, ?, ?, ?)`,
    ).run("tc-replayed", "sess-prior", "read", 2000);
    db.exec("COMMIT");

    // --- Fresh process: new buffer => completedToolCallIds is EMPTY (module-level),
    //     so the in-memory dedup in tools.ts cannot see the prior-process row. ---
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db, () => 5000);
    registerSessionCapture(stub.pi, t);
    registerRunCapture(stub.pi, t);
    registerTurnCapture(stub.pi, t);
    registerToolCapture(stub.pi, t);

    // Normal session/run/turn setup for a NEW session.
    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-new" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    await stub.fire("turn_start", { turnIndex: 0, timestamp: 5000 }, {
      getContextUsage: () => ({ tokens: 0, contextWindow: 100000, percent: 0 }),
    });

    // The SDK replays an already-recorded tool call (e.g. on session resume).
    await stub.fire("tool_execution_start", {
      toolCallId: "tc-replayed",
      toolName: "read",
      args: { path: "/tmp/foo" },
    });
    await stub.fire("tool_execution_end", {
      toolCallId: "tc-replayed",
      toolName: "read",
      result: { output: "hello" },
      isError: false,
    });

    // A brand-new, perfectly valid tool call that SHOULD commit.
    await stub.fire("tool_execution_start", {
      toolCallId: "tc-new",
      toolName: "read",
      args: { path: "/tmp/bar" },
    });
    await stub.fire("tool_execution_end", {
      toolCallId: "tc-new",
      toolName: "read",
      result: { output: "world" },
      isError: false,
    });

    // --- First flush: the batch contains [session, run, turn, tc-replayed, tc-new].
    //     tc-replayed collides on tool_call_id PK => UNIQUE violation => the ENTIRE
    //     transaction rolls back and the whole batch is re-enqueued. ---
    t.flush();

    const teNew = db.prepare("SELECT COUNT(*) AS c FROM tool_executions WHERE tool_call_id = ?")
      .get("tc-new") as { c: number };
    const sessNew = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE session_id = ?")
      .get("sess-new") as { c: number };
    const wf = db.prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'write_failed'")
      .get() as { c: number };
    const fl = db.prepare("SELECT COUNT(*) AS c FROM flush_log").get() as { c: number };

    console.log(JSON.stringify({
      tc_new_committed: teNew.c,        // expected 1 (healthy)
      sess_new_committed: sessNew.c,    // expected 1 (healthy)
      write_failed_rows: wf.c,          // expected 0 (healthy)
      flush_log_rows: fl.c,             // expected 1 (healthy: a flush committed)
    }, null, 2));

    // Healthy behavior: tc-new commits, the session row commits, no
    // write_failed, and a flush_log row exists. A replayed tool_call_id
    // must NOT poison the batch.
    assert.strictEqual(teNew.c, 1, "tc-new should have committed");
    assert.strictEqual(sessNew.c, 1, "sess-new session row should have committed");
    assert.strictEqual(wf.c, 0, "no write_failed should have been logged");
    assert.strictEqual(fl.c, 1, "a flush should have committed (flush_log row)");

    // A second flush must remain healthy (no infinite retry).
    t.flush();
    const wf2 = db.prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'write_failed'")
      .get() as { c: number };
    assert.strictEqual(wf2.c, 0, "no write_failed on second flush");
    const teNew2 = db.prepare("SELECT COUNT(*) AS c FROM tool_executions WHERE tool_call_id = ?")
      .get("tc-new") as { c: number };
    assert.strictEqual(teNew2.c, 1, "tc-new should still be exactly one row");
  });
});
