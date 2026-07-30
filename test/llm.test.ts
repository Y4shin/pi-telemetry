import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";
import { createBuffer } from "../src/buffer.ts";
import type { TelemetryConfig } from "../src/config.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

describe("llm request capture", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-llm-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  async function setupSessionRunTurn(stub: ReturnType<typeof createL1Stub>, t: ReturnType<typeof createBuffer>) {
    registerSessionCapture(stub.pi, t);
    registerRunCapture(stub.pi, t);
    registerTurnCapture(stub.pi, t);
    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "sess-llm" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    await stub.fire("turn_start", { turnIndex: 0, timestamp: 1000 }, {
      getContextUsage: () => ({ tokens: 0, contextWindow: 100000, percent: 0 }),
    });
  }

  it("leaves ttft_ms and stream_ms NULL for a non-streamed request", async () => {
    const stub = createL1Stub();
    let clock = 1000;
    const t = createBuffer(makeConfig(dbPath), db, () => clock);
    await setupSessionRunTurn(stub, t);

    const { registerLlmCapture } = await import("../src/capture/llm.ts");
    registerLlmCapture(stub.pi, t);

    const msg = fakeAssistantMessage({ timestamp: 2000 });
    await stub.fire("message_start", { message: msg });
    clock += 75;
    await stub.fire("message_end", { message: msg });
    t.flush();

    const row = db.prepare("SELECT * FROM llm_requests WHERE session_id = ?").get("sess-llm") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.ttft_ms, null);
    assert.strictEqual(row.stream_ms, null);
    assert.strictEqual(row.duration_ms, 75);
    assert.strictEqual(row.input_tokens, 10);
    assert.strictEqual(row.output_tokens, 5);
    assert.strictEqual(row.stop_reason, "stop");
  });

  it("records http_status and retry_after_ms for a 429 response", async () => {
    const stub = createL1Stub();
    let clock = 1000;
    const t = createBuffer(makeConfig(dbPath), db, () => clock);
    await setupSessionRunTurn(stub, t);

    const { registerLlmCapture } = await import("../src/capture/llm.ts");
    registerLlmCapture(stub.pi, t);

    const msg = fakeAssistantMessage({ timestamp: 2000 });
    await stub.fire("message_start", { message: msg });
    await stub.fire("after_provider_response", { status: 429, headers: { "retry-after": "2" } });
    clock += 80;
    await stub.fire("message_end", { message: msg });
    t.flush();

    const row = db.prepare("SELECT * FROM llm_requests WHERE session_id = ?").get("sess-llm") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.http_status, 429);
    assert.strictEqual(row.retry_after_ms, 2000);
  });

  it("records 429 status when after_provider_response fires before message_start", async () => {
    const stub = createL1Stub();
    let clock = 1000;
    const t = createBuffer(makeConfig(dbPath), db, () => clock);
    await setupSessionRunTurn(stub, t);

    const { registerLlmCapture } = await import("../src/capture/llm.ts");
    registerLlmCapture(stub.pi, t);

    const msg = fakeAssistantMessage({ timestamp: 2000 });
    await stub.fire("after_provider_response", { status: 429, headers: { "retry-after": "3" } });
    await stub.fire("message_start", { message: msg });
    clock += 80;
    await stub.fire("message_end", { message: msg });
    t.flush();

    const row = db.prepare("SELECT * FROM llm_requests WHERE session_id = ?").get("sess-llm") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.http_status, 429);
    assert.strictEqual(row.retry_after_ms, 3000);
  });

  it("swallows message_end without matching message_start", async () => {
    const stub = createL1Stub();
    let clock = 1000;
    const t = createBuffer(makeConfig(dbPath), db, () => clock);
    await setupSessionRunTurn(stub, t);

    const { registerLlmCapture } = await import("../src/capture/llm.ts");
    registerLlmCapture(stub.pi, t);

    const msg = fakeAssistantMessage({ timestamp: 2000 });
    await stub.fire("message_end", { message: msg });
    t.flush();

    const count = db.prepare("SELECT COUNT(*) AS c FROM llm_requests WHERE session_id = ?").get("sess-llm") as { c: number };
    assert.strictEqual(count.c, 0);
  });

  it("does not cross-contaminate interleaved concurrent requests", async () => {
    const stub = createL1Stub();
    let clock = 1000;
    const t = createBuffer(makeConfig(dbPath), db, () => clock);
    await setupSessionRunTurn(stub, t);

    const { registerLlmCapture } = await import("../src/capture/llm.ts");
    registerLlmCapture(stub.pi, t);

    const msgA = fakeAssistantMessage({ timestamp: 2000, provider: "p-a", model: "m-a" });
    const msgB = fakeAssistantMessage({ timestamp: 3000, provider: "p-b", model: "m-b" });

    await stub.fire("message_start", { message: msgA });
    clock += 10;
    await stub.fire("message_start", { message: msgB });
    clock += 20;
    await stub.fire("message_update", { message: msgA, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a", partial: msgA } });
    clock += 30;
    await stub.fire("message_update", { message: msgB, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b", partial: msgB } });
    clock += 40;
    await stub.fire("message_end", { message: msgA });
    clock += 50;
    await stub.fire("message_end", { message: msgB });
    t.flush();

    const rows = db.prepare("SELECT * FROM llm_requests WHERE session_id = ? ORDER BY started_unix_ms").all("sess-llm") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 2);

    const rowA = rows[0];
    const rowB = rows[1];
    assert.strictEqual(rowA.provider, "p-a");
    assert.strictEqual(rowA.ttft_ms, 30);
    assert.strictEqual(rowA.stream_ms, 70);
    assert.strictEqual(rowA.duration_ms, 100);

    assert.strictEqual(rowB.provider, "p-b");
    assert.strictEqual(rowB.ttft_ms, 50);
    assert.strictEqual(rowB.stream_ms, 90);
    assert.strictEqual(rowB.duration_ms, 140);
  });

  it("records NULL costs when usage is missing", async () => {
    const stub = createL1Stub();
    let clock = 1000;
    const t = createBuffer(makeConfig(dbPath), db, () => clock);
    await setupSessionRunTurn(stub, t);

    const { registerLlmCapture } = await import("../src/capture/llm.ts");
    registerLlmCapture(stub.pi, t);

    const msg = fakeAssistantMessage({ timestamp: 2000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (msg as any).usage;
    await stub.fire("message_start", { message: msg });
    clock += 10;
    await stub.fire("message_update", { message: msg, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "h", partial: msg } });
    clock += 20;
    await stub.fire("message_end", { message: msg });
    t.flush();

    const row = db.prepare("SELECT * FROM llm_requests WHERE session_id = ?").get("sess-llm") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.input_tokens, null);
    assert.strictEqual(row.output_tokens, null);
    assert.strictEqual(row.cost_total_usd, null);
    assert.strictEqual(row.duration_ms, 30);
  });

  it("records ttft_ms, stream_ms and duration_ms for a streamed request", async () => {
    const stub = createL1Stub();
    let clock = 1000;
    const t = createBuffer(makeConfig(dbPath), db, () => clock);
    await setupSessionRunTurn(stub, t);

    const { registerLlmCapture } = await import("../src/capture/llm.ts");
    registerLlmCapture(stub.pi, t);

    const msg = fakeAssistantMessage({ timestamp: 2000 });
    await stub.fire("message_start", { message: msg });
    clock += 50;
    await stub.fire("message_update", { message: msg, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "h", partial: msg } });
    clock += 100;
    await stub.fire("message_end", { message: msg });
    t.flush();

    const row = db.prepare("SELECT * FROM llm_requests WHERE session_id = ?").get("sess-llm") as Record<string, unknown>;
    assert.ok(row, "llm_requests row should exist");
    assert.strictEqual(row.provider, "test-provider");
    assert.strictEqual(row.model, "test-model");
    assert.strictEqual(row.ttft_ms, 50);
    assert.strictEqual(row.stream_ms, 100);
    assert.strictEqual(row.duration_ms, 150);
    assert.strictEqual(row.input_tokens, 10);
    assert.strictEqual(row.output_tokens, 5);
    assert.strictEqual(row.cache_read_tokens, 2);
    assert.strictEqual(row.cache_write_tokens, 1);
    assert.strictEqual(row.cost_total_usd, 0.0036);
    assert.strictEqual(row.stop_reason, "stop");
    assert.strictEqual(row.session_id, "sess-llm");
    assert.strictEqual(row.turn_id, t.state.turnId);
    assert.strictEqual(row.run_id, t.state.runId);
  });
});
