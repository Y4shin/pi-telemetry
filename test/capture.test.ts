import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";
import { createBuffer } from "../src/buffer.ts";
import type { TelemetryConfig } from "../src/config.ts";
import { getPiVersion } from "../src/version.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createL1Stub } from "./helpers/l1-stub.ts";
import {
  registerSessionCapture,
  registerRunCapture,
  registerTurnCapture,
} from "../src/capture/index.ts";

function ctxWithSession(sessionId: string): Partial<ExtensionContext> {
  return {
    sessionManager: { getSessionId: () => sessionId } as ExtensionContext["sessionManager"],
    cwd: "/tmp/proj",
  };
}

function fakeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0005,
        cacheWrite: 0.0001,
        total: 0.0036,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  } as AssistantMessage;
}

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
      sessionManager: { getSessionId: () => "sess-1" } as ExtensionContext["sessionManager"],
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
    assert.strictEqual(row.pi_version, getPiVersion());
    assert.ok(row.pi_version !== null, "pi_version should be populated from installed pi package");
  });

  it("session_shutdown updates ended_unix_ms and end_reason", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-2" } as ExtensionContext["sessionManager"],
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
      sessionManager: { getSessionId: () => "sess-3" } as ExtensionContext["sessionManager"],
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
      sessionManager: { getSessionId: () => "sess-4" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-4") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.ended_unix_ms, null);
  });

  it("second session_start with same id is ignored and preserves original row", async () => {
    const stub = createL1Stub();
    let clock = 1000;
    const t = createBuffer(makeConfig(dbPath), db, () => clock);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-resume" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    clock += 5000;
    await assert.doesNotReject(async () => {
      await stub.fire("session_start", { reason: "resume" }, {
        sessionManager: { getSessionId: () => "sess-resume" } as ExtensionContext["sessionManager"],
        cwd: "/tmp/other",
      });
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-resume") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.start_reason, "startup");
    assert.strictEqual(row.started_unix_ms, 1000);
    assert.strictEqual(row.cwd, "/tmp/proj");
    const metaCount = db.prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE session_id = ? AND event = ?").get("sess-resume", "write_failed") as { c: number };
    assert.strictEqual(metaCount.c, 0);
  });
});

describe("run capture", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-runs-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function setupSession(stub: ReturnType<typeof createL1Stub>, t: ReturnType<typeof createBuffer>) {
    registerSessionCapture(stub.pi, t);
    return stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-run" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
  }

  it("before_agent_start stages prompt lengths and agent_start inserts run row", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerRunCapture(stub.pi, t);

    await stub.fire("before_agent_start", {
      prompt: "hello",
      systemPrompt: "be helpful",
    });
    await stub.fire("agent_start", {});
    t.flush();

    const row = db.prepare("SELECT * FROM agent_runs WHERE session_id = ?").get("sess-run") as Record<string, unknown>;
    assert.ok(row, "agent_runs row should exist");
    assert.ok(typeof row.run_id, "string");
    assert.strictEqual(row.prompt_chars, 5);
    assert.strictEqual(row.system_prompt_chars, 10);
    assert.strictEqual(row.outcome, null);
  });

  it("agent_end and agent_settled produce distinct outcomes", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerRunCapture(stub.pi, t);

    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    await stub.fire("agent_end", { messages: [{}, {}, {}] });
    t.flush();

    const row1 = db.prepare("SELECT * FROM agent_runs WHERE session_id = ?").get("sess-run") as Record<string, unknown>;
    assert.strictEqual(row1.outcome, "end");
    assert.strictEqual(row1.message_count, 3);
    assert.strictEqual(typeof row1.duration_ms, "number");

    await stub.fire("agent_settled", {});
    t.flush();

    const row2 = db.prepare("SELECT * FROM agent_runs WHERE session_id = ?").get("sess-run") as Record<string, unknown>;
    assert.strictEqual(row2.outcome, "settled");
  });
});

describe("turn capture", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-turns-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  async function setupSessionAndRun(stub: ReturnType<typeof createL1Stub>, t: ReturnType<typeof createBuffer>) {
    registerSessionCapture(stub.pi, t);
    registerRunCapture(stub.pi, t);
    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-turn" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
  }

  it("turn_start inserts a turns row with context_tokens_at_start", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSessionAndRun(stub, t);
    registerTurnCapture(stub.pi, t);

    await stub.fire("turn_start", { turnIndex: 0, timestamp: Date.now() }, {
      getContextUsage: () => ({ tokens: 42, contextWindow: 100000, percent: 0.042 }),
    });
    t.flush();

    const row = db.prepare("SELECT * FROM turns WHERE session_id = ?").get("sess-turn") as Record<string, unknown>;
    assert.ok(row, "turns row should exist");
    assert.strictEqual(row.turn_index, 0);
    assert.strictEqual(row.context_tokens_at_start, 42);
    assert.strictEqual(row.run_id, t.state.runId);
    assert.ok(typeof row.turn_id, "string");
  });

  it("turn_end writes exact usage and cost fields", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSessionAndRun(stub, t);
    registerTurnCapture(stub.pi, t);

    await stub.fire("turn_start", { turnIndex: 0, timestamp: Date.now() }, {
      getContextUsage: () => ({ tokens: 0, contextWindow: 100000, percent: 0 }),
    });
    await new Promise((r) => setTimeout(r, 5));
    await stub.fire("turn_end", {
      turnIndex: 0,
      message: fakeAssistantMessage(),
      toolResults: [{}, {}],
    });
    t.flush();

    const row = db.prepare("SELECT * FROM turns WHERE session_id = ?").get("sess-turn") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.provider, "test-provider");
    assert.strictEqual(row.model, "test-model");
    assert.strictEqual(row.input_tokens, 10);
    assert.strictEqual(row.output_tokens, 5);
    assert.strictEqual(row.cache_read_tokens, 2);
    assert.strictEqual(row.cache_write_tokens, 1);
    assert.strictEqual(row.total_tokens, 18);
    assert.strictEqual(row.cost_input_usd, 0.001);
    assert.strictEqual(row.cost_output_usd, 0.002);
    assert.strictEqual(row.cost_cache_read_usd, 0.0005);
    assert.strictEqual(row.cost_cache_write_usd, 0.0001);
    assert.strictEqual(row.cost_total_usd, 0.0036);
    assert.strictEqual(row.stop_reason, "stop");
    assert.strictEqual(row.tool_result_count, 2);
    assert.strictEqual(typeof row.duration_ms, "number");
    assert.ok((row.duration_ms as number) >= 0);
  });

  it("context_tokens_at_start is sampled at turn_start", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSessionAndRun(stub, t);
    registerTurnCapture(stub.pi, t);

    await stub.fire("turn_start", { turnIndex: 0, timestamp: Date.now() }, {
      getContextUsage: () => ({ tokens: 7, contextWindow: 100000, percent: 0.00007 }),
    });
    await stub.fire("turn_end", {
      turnIndex: 0,
      message: fakeAssistantMessage(),
      toolResults: [],
    });
    t.flush();

    const row = db.prepare("SELECT * FROM turns WHERE session_id = ?").get("sess-turn") as Record<string, unknown>;
    assert.strictEqual(row.context_tokens_at_start, 7);
  });

  it("turn_end without matching turn_start does not crash", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSessionAndRun(stub, t);
    registerTurnCapture(stub.pi, t);

    await assert.doesNotReject(async () => {
      await stub.fire("turn_end", {
        turnIndex: 0,
        message: fakeAssistantMessage(),
        toolResults: [],
      });
    });
    t.flush();

    const count = db.prepare("SELECT COUNT(*) AS c FROM turns WHERE session_id = ?").get("sess-turn") as { c: number };
    assert.strictEqual(count.c, 0);
    const meta = db.prepare("SELECT * FROM telemetry_meta WHERE session_id = ? AND event = ?").get("sess-turn", "handler_error") as Record<string, unknown> | undefined;
    assert.ok(meta, "expected meta note for unmatched turn_end");
  });

  it("getContextUsage throwing leaves context_tokens_at_start NULL", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSessionAndRun(stub, t);
    registerTurnCapture(stub.pi, t);

    await stub.fire("turn_start", { turnIndex: 0, timestamp: Date.now() }, {
      getContextUsage: () => { throw new Error("boom"); },
    });
    t.flush();

    const row = db.prepare("SELECT * FROM turns WHERE session_id = ?").get("sess-turn") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.context_tokens_at_start, null);
  });
});
