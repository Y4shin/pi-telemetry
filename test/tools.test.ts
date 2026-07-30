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
} from "../src/capture/index.ts";

function makeConfig(dbPath: string, overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    enabled: true,
    dbPath,
    bufferFlushMs: 10000,
    bufferMaxRows: 100,
    feedbackMaxBytes: 65536,
    capture: { toolArgs: false, toolResults: false, bashCommand: false },
    ...overrides,
  };
}

async function setupSessionRunTurn(stub: ReturnType<typeof createL1Stub>, t: ReturnType<typeof createBuffer>, sessionId = "sess-tool") {
  registerSessionCapture(stub.pi, t);
  registerRunCapture(stub.pi, t);
  registerTurnCapture(stub.pi, t);
  await stub.fire("session_start", { reason: "startup" }, {
    sessionManager: { getSessionId: () => sessionId } as ExtensionContext["sessionManager"],
    cwd: "/tmp/proj",
  });
  await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
  await stub.fire("agent_start", {});
  await stub.fire("turn_start", { turnIndex: 0, timestamp: 1000 }, {
    getContextUsage: () => ({ tokens: 0, contextWindow: 100000, percent: 0 }),
  });
}

describe("tool execution capture", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-tools-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("tool_execution_start and tool_execution_end insert a row with default flags off", async () => {
    const stub = createL1Stub();
    let clock = 1000;
    const t = createBuffer(makeConfig(dbPath), db, () => clock);
    await setupSessionRunTurn(stub, t);
    registerToolCapture(stub.pi, t);

    await stub.fire("tool_execution_start", {
      toolCallId: "tc-1",
      toolName: "read",
      args: { path: "/tmp/foo" },
    });
    clock += 50;
    await stub.fire("tool_execution_end", {
      toolCallId: "tc-1",
      toolName: "read",
      result: { output: "hello" },
      isError: false,
    });
    t.flush();

    const row = db.prepare("SELECT * FROM tool_executions WHERE tool_call_id = ?").get("tc-1") as Record<string, unknown>;
    assert.ok(row, "tool_executions row should exist");
    assert.strictEqual(row.tool_call_id, "tc-1");
    assert.strictEqual(row.tool_name, "read");
    assert.strictEqual(row.session_id, "sess-tool");
    assert.strictEqual(row.turn_id, t.state.turnId);
    assert.strictEqual(row.run_id, t.state.runId);
    assert.strictEqual(row.started_unix_ms, 1000);
    assert.strictEqual(row.duration_ms, 50);
    assert.strictEqual(row.is_error, 0);
    assert.strictEqual(row.error_class, null);
    assert.strictEqual(row.args_chars, 19); // {"path":"/tmp/foo"}
    assert.strictEqual(row.result_chars, 18); // {"output":"hello"}
    assert.strictEqual(row.result_hash, "639909023015218900ef28cc942c51401cd9108e7179f4d1f5826985c7233ccc");
    assert.strictEqual(row.args_json, null);
    assert.strictEqual(row.result_text, null);
  });

  it("classifies errors into bounded error_class values", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSessionRunTurn(stub, t);
    registerToolCapture(stub.pi, t);

    const cases: { error: unknown; expected: string }[] = [
      { error: new Error("request timed out"), expected: "timeout" },
      { error: { message: "file not found", code: "ENOENT" }, expected: "not_found" },
      { error: { message: "permission denied", code: "EACCES" }, expected: "permission" },
      { error: { message: "validation failed" }, expected: "validation" },
      { error: new Error("something else"), expected: "unknown" },
    ];

    for (let i = 0; i < cases.length; i++) {
      const tc = `tc-err-${i}`;
      await stub.fire("tool_execution_start", { toolCallId: tc, toolName: "bash", args: {} });
      await stub.fire("tool_execution_end", { toolCallId: tc, toolName: "bash", result: cases[i].error, isError: true });
    }
    t.flush();

    for (let i = 0; i < cases.length; i++) {
      const tc = `tc-err-${i}`;
      const row = db.prepare("SELECT * FROM tool_executions WHERE tool_call_id = ?").get(tc) as Record<string, unknown>;
      assert.ok(row, `row for ${tc}`);
      assert.strictEqual(row.is_error, 1);
      assert.strictEqual(row.error_class, cases[i].expected);
      assert.strictEqual(typeof row.error_class, "string");
      assert.strictEqual((row.error_class as string).includes(" "), false, "error_class should be a single category token");
    }
  });

  it("produces stable sha256 hashes and keeps content NULL by default", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSessionRunTurn(stub, t);
    registerToolCapture(stub.pi, t);

    const result = "same result";
    const expectedHash = "e57d621119a4d36445e24f71ed022c3833c2ee8b200480346f576930a2a7b5dc";

    await stub.fire("tool_execution_start", { toolCallId: "tc-hash-1", toolName: "read", args: {} });
    await stub.fire("tool_execution_end", { toolCallId: "tc-hash-1", toolName: "read", result, isError: false });
    await stub.fire("tool_execution_start", { toolCallId: "tc-hash-2", toolName: "read", args: {} });
    await stub.fire("tool_execution_end", { toolCallId: "tc-hash-2", toolName: "read", result, isError: false });
    t.flush();

    const rows = db.prepare("SELECT * FROM tool_executions WHERE session_id = ? ORDER BY tool_call_id").all("sess-tool") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].result_hash, rows[1].result_hash);
    assert.strictEqual(rows[0].result_text, null);
    assert.strictEqual(rows[0].args_json, null);
  });

  it("populates args_json and result_text when capture flags are enabled", async () => {
    const stub = createL1Stub();
    const t = createBuffer(
      makeConfig(dbPath, { capture: { toolArgs: true, toolResults: true, bashCommand: false } }),
      db,
    );
    await setupSessionRunTurn(stub, t);
    registerToolCapture(stub.pi, t);

    await stub.fire("tool_execution_start", {
      toolCallId: "tc-content",
      toolName: "read",
      args: { path: "/tmp/foo" },
    });
    await stub.fire("tool_execution_end", {
      toolCallId: "tc-content",
      toolName: "read",
      result: { content: [{ type: "text", text: "file body" }] },
      isError: false,
    });
    t.flush();

    const row = db.prepare("SELECT * FROM tool_executions WHERE tool_call_id = ?").get("tc-content") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.args_json, JSON.stringify({ path: "/tmp/foo" }));
    assert.strictEqual(row.result_text, "file body");
  });
});
