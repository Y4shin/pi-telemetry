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
});
