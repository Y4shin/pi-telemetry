import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";
import { createBuffer } from "../src/buffer.ts";
import type { TelemetryConfig } from "../src/config.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createL1Stub } from "./helpers/l1-stub.ts";
import {
  registerSessionCapture,
  registerRunCapture,
  registerTurnCapture,
  registerToolCapture,
  registerLlmCapture,
  registerBashCapture,
  registerSessionEventsCapture,
} from "../src/capture/index.ts";
import { registerFeedback } from "../src/feedback.ts";

function makeConfig(dbPath: string, overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    enabled: true,
    dbPath,
    bufferFlushMs: 0, // disable auto-flush; we flush manually
    bufferMaxRows: 1_000_000, // never auto-flush by count
    feedbackMaxBytes: 65536,
    capture: { toolArgs: false, toolResults: false, bashCommand: false },
    ...overrides,
  };
}

async function setupSessionRunTurn(
  stub: ReturnType<typeof createL1Stub>,
  t: ReturnType<typeof createBuffer>,
  sessionId = "sess-new",
) {
  registerSessionCapture(stub.pi, t);
  registerRunCapture(stub.pi, t);
  registerTurnCapture(stub.pi, t);
  await stub.fire("session_start", { reason: "startup" }, {
    sessionManager: { getSessionId: () => sessionId } as ExtensionContext["sessionManager"],
    cwd: "/tmp/proj",
  });
  await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
  await stub.fire("agent_start", {});
  await stub.fire("turn_start", { turnIndex: 0, timestamp: 5000 }, {
    getContextUsage: () => ({ tokens: 0, contextWindow: 100000, percent: 0 }),
  });
}

describe("duplicate key resilience", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-dup-key-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("replayed tool_call_id does not poison the batch", async () => {
    // Simulate a PRIOR process that already recorded tool_call_id "tc-replayed".
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

    // Fresh process: new buffer => module-level dedup is empty.
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db, () => 5000);
    await setupSessionRunTurn(stub, t, "sess-new");
    registerToolCapture(stub.pi, t);

    // Replayed tool call collides with the pre-seeded row.
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

    // A brand-new, valid tool call in the SAME batch should commit.
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

    t.flush();

    const teNew = db.prepare("SELECT COUNT(*) AS c FROM tool_executions WHERE tool_call_id = ?")
      .get("tc-new") as { c: number };
    const sessNew = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE session_id = ?")
      .get("sess-new") as { c: number };
    const wf = db.prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'write_failed'")
      .get() as { c: number };
    const fl = db.prepare("SELECT COUNT(*) AS c FROM flush_log").get() as { c: number };

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

  it("buffer isolates an unrecoverable statement from the rest of the batch", () => {
    const t = createBuffer(makeConfig(dbPath), db, () => 1000);

    // Two healthy rows and one statement that fails for a reason idempotency
    // cannot fix (NOT NULL violation on a required column).
    t.enqueue(
      "INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)",
      [1, "warn", "good-1"],
    );
    t.enqueue(
      "INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)",
      [2, "warn", "good-2"],
    );
    t.enqueue(
      "INSERT INTO telemetry_meta (unix_ms, level, event) VALUES (?, ?, ?)",
      [null, "warn", "bad-null"],
    );

    t.flush();

    const good = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event LIKE 'good-%'")
      .get() as { c: number };
    const bad = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'bad-null'")
      .get() as { c: number };
    const failed = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'write_failed'")
      .get() as { c: number };

    assert.strictEqual(good.c, 2, "healthy rows should commit");
    assert.strictEqual(bad.c, 0, "offending row should be dropped");
    assert.strictEqual(failed.c, 1, "offender is logged once");

    // Second flush must not retry the offender.
    t.flush();
    const failed2 = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'write_failed'")
      .get() as { c: number };
    assert.strictEqual(failed2.c, 1, "offender must not be retried");
  });

  it("replayed session_start is idempotent", async () => {
    // Prior process recorded the session.
    db.prepare("INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)")
      .run("sess-replay", 1000);

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db, () => 2000);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-replay" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    t.flush();

    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE session_id = ?")
      .get("sess-replay") as { c: number };
    const wf = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'write_failed'")
      .get() as { c: number };

    assert.strictEqual(rows.c, 1, "session row should remain exactly one");
    assert.strictEqual(wf.c, 0, "no write_failed for replayed session");
  });

  it("natural-key capture INSERTs use INSERT OR IGNORE", async () => {
    const stub = createL1Stub();
    const sql: string[] = [];
    const mockT = {
      config: makeConfig(dbPath),
      now: () => 1000,
      state: {
        sessionId: "sess-mock",
        runId: "run-mock",
        turnId: "turn-mock",
        turnIndex: 0,
        lineage: {},
        timers: new Map(),
        stagedPromptChars: null,
        stagedSystemPromptChars: null,
        correlation: () => ({
          sessionId: "sess-mock",
          runId: "run-mock",
          turnId: "turn-mock",
        }),
      },
      enqueue: (s: string) => sql.push(s),
      meta: () => {},
      flush: () => {},
      close: () => {},
    };

    registerSessionCapture(stub.pi, mockT as unknown as ReturnType<typeof createBuffer>);
    registerRunCapture(stub.pi, mockT as unknown as ReturnType<typeof createBuffer>);
    registerTurnCapture(stub.pi, mockT as unknown as ReturnType<typeof createBuffer>);
    registerToolCapture(stub.pi, mockT as unknown as ReturnType<typeof createBuffer>);
    registerLlmCapture(stub.pi, mockT as unknown as ReturnType<typeof createBuffer>);
    registerBashCapture(stub.pi, mockT as unknown as ReturnType<typeof createBuffer>);
    registerSessionEventsCapture(stub.pi, mockT as unknown as ReturnType<typeof createBuffer>);
    registerFeedback(stub.pi, mockT as unknown as ReturnType<typeof createBuffer>);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-mock" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    await stub.fire("turn_start", { turnIndex: 0, timestamp: 1000 }, {
      getContextUsage: () => ({ tokens: 0, contextWindow: 100000, percent: 0 }),
    });
    await stub.fire("tool_execution_start", { toolCallId: "tc-mock", toolName: "read", args: {} });
    await stub.fire("tool_execution_end", { toolCallId: "tc-mock", toolName: "read", result: "ok", isError: false });
    await stub.fire("session_before_compact", { reason: "x", willRetry: false });
    stub.events.emit("pi-telemetry:submit-feedback", { source: "s", kind: "k", data: "d" });

    // Collect any INSERT statements. We only care that natural-key INSERTs use
    // INSERT OR IGNORE; UPDATE statements are irrelevant.
    const insertStatements = sql.filter((s) => s.trim().toUpperCase().startsWith("INSERT"));
    assert.ok(insertStatements.length > 0, "capture should emit INSERT statements");
    for (const stmt of insertStatements) {
      assert.ok(
        /INSERT\s+OR\s+IGNORE/i.test(stmt),
        `natural-key INSERT should be idempotent: ${stmt.slice(0, 80)}`,
      );
    }
  });
});
