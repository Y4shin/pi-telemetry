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
import { registerSessionCapture } from "../src/capture/index.ts";
import { registerFeedback } from "../src/feedback.ts";

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

async function setupSession(stub: ReturnType<typeof createL1Stub>, t: ReturnType<typeof createBuffer>, sessionId = "sess-fb") {
  registerSessionCapture(stub.pi, t);
  await stub.fire("session_start", { reason: "startup" }, {
    sessionManager: { getSessionId: () => sessionId } as ExtensionContext["sessionManager"],
    cwd: "/tmp/proj",
  });
}

describe("feedback collector", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-feedback-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("bus emit happy path stores a feedback row with enrichment", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    stub.events.emit("pi-telemetry:submit-feedback", {
      source: "test-plugin",
      kind: "good",
      data: { score: 5 },
    });
    t.flush();

    const row = db.prepare("SELECT * FROM feedback WHERE session_id = ?").get("sess-fb") as Record<string, unknown>;
    assert.ok(row, "feedback row should exist");
    assert.strictEqual(row.session_id, "sess-fb");
    assert.strictEqual(row.source, "test-plugin");
    assert.strictEqual(row.kind, "good");
    assert.strictEqual(row.data, JSON.stringify({ score: 5 }));
    assert.strictEqual(typeof row.received_unix_ms, "number");
    assert.strictEqual(row.run_id, null);
    assert.strictEqual(row.turn_index, 0);
  });

  it("bus emit without listener is a no-op for producers", async () => {
    const stub = createL1Stub();
    // Do not register feedback; emit should not throw.
    await assert.doesNotReject(async () => {
      stub.events.emit("pi-telemetry:submit-feedback", { source: "x", kind: "y", data: "z" });
    });
  });

  it("malformed bus payload records feedback_rejected meta and does not throw", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    await assert.doesNotReject(async () => {
      stub.events.emit("pi-telemetry:submit-feedback", { source: "", kind: "kind", data: {} });
    });
    t.flush();

    const row = db.prepare("SELECT * FROM feedback WHERE session_id = ?").get("sess-fb") as Record<string, unknown> | undefined;
    assert.strictEqual(row, undefined);
    const meta = db.prepare("SELECT * FROM telemetry_meta WHERE session_id = ? AND event = ?").get("sess-fb", "feedback_rejected") as Record<string, unknown>;
    assert.ok(meta, "expected feedback_rejected meta row");
    assert.strictEqual(meta.level, "warn");
  });

  it("oversized bus payload is rejected into meta, not stored", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath, { feedbackMaxBytes: 10 }), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    stub.events.emit("pi-telemetry:submit-feedback", {
      source: "test-plugin",
      kind: "big",
      data: "this payload is definitely more than ten bytes",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM feedback WHERE session_id = ?").get("sess-fb") as Record<string, unknown> | undefined;
    assert.strictEqual(row, undefined);
    const meta = db.prepare("SELECT * FROM telemetry_meta WHERE session_id = ? AND event = ?").get("sess-fb", "feedback_rejected") as Record<string, unknown>;
    assert.ok(meta);
  });

  it("tool submit_feedback forces source=pi", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    const tool = stub.tools.find((t) => t.name === "submit_feedback");
    assert.ok(tool, "submit_feedback tool should be registered");

    const def = tool.definition as { execute: (toolCallId: string, params: unknown) => Promise<unknown> };
    await def.execute("tc-1", { kind: "bad", data: "too hot" });
    t.flush();

    const row = db.prepare("SELECT * FROM feedback WHERE session_id = ?").get("sess-fb") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.source, "pi");
    assert.strictEqual(row.kind, "bad");
    assert.strictEqual(row.data, "too hot");
  });

  it("tool submit_feedback returns success-neutral result", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    const tool = stub.tools.find((t) => t.name === "submit_feedback");
    const def = tool!.definition as { execute: (toolCallId: string, params: unknown) => Promise<unknown> };
    const result = await def.execute("tc-2", { kind: "architecture", data: { pattern: "mvc" } });

    assert.ok(result);
    assert.deepStrictEqual((result as { content: unknown }).content, [{ type: "text", text: "Feedback recorded." }]);
  });

  it("data stored raw for strings and JSON for objects", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    stub.events.emit("pi-telemetry:submit-feedback", { source: "s1", kind: "string", data: "plain text" });
    stub.events.emit("pi-telemetry:submit-feedback", { source: "s2", kind: "object", data: { a: 1 } });
    t.flush();

    const rows = db.prepare("SELECT * FROM feedback WHERE session_id = ? ORDER BY received_unix_ms").all("sess-fb") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].data, "plain text");
    assert.strictEqual(rows[1].data, JSON.stringify({ a: 1 }));
  });

  it("exactly-at-cap payload is accepted", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath, { feedbackMaxBytes: 5 }), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    stub.events.emit("pi-telemetry:submit-feedback", { source: "s", kind: "k", data: "12345" });
    t.flush();

    const row = db.prepare("SELECT * FROM feedback WHERE session_id = ?").get("sess-fb") as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.strictEqual(row.data, "12345");
  });

  it("emit before first flush is buffered and written on flush", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath, { bufferMaxRows: 50, bufferFlushMs: 10000 }), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    stub.events.emit("pi-telemetry:submit-feedback", { source: "buf", kind: "buf", data: "x" });

    const before = db.prepare("SELECT COUNT(*) AS c FROM feedback").get() as { c: number };
    assert.strictEqual(before.c, 0);

    t.flush();
    const after = db.prepare("SELECT * FROM feedback WHERE session_id = ?").get("sess-fb") as Record<string, unknown>;
    assert.ok(after);
  });

  it("DB write failure during insert records meta and tool returns success-neutral", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath, { bufferMaxRows: 1 }), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    // Drop the feedback table to force insert failure.
    db.exec("DROP TABLE feedback");

    const tool = stub.tools.find((t) => t.name === "submit_feedback");
    const def = tool!.definition as { execute: (toolCallId: string, params: unknown) => Promise<unknown> };
    const result = await def.execute("tc-3", { kind: "fail", data: "boom" });

    assert.ok(result);
    const meta = db.prepare("SELECT * FROM telemetry_meta WHERE session_id = ?").get("sess-fb") as Record<string, unknown>;
    assert.ok(meta, "expected meta row for DB failure");
  });

  it("bus and tool inserts are ordered by received_unix_ms", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerFeedback(stub.pi, t);

    const tool = stub.tools.find((t) => t.name === "submit_feedback");
    const def = tool!.definition as { execute: (toolCallId: string, params: unknown) => Promise<unknown> };

    stub.events.emit("pi-telemetry:submit-feedback", { source: "bus", kind: "first", data: "a" });
    await def.execute("tc-4", { kind: "second", data: "b" });
    stub.events.emit("pi-telemetry:submit-feedback", { source: "bus", kind: "third", data: "c" });
    t.flush();

    const rows = db.prepare("SELECT kind FROM feedback WHERE session_id = ? ORDER BY received_unix_ms").all("sess-fb") as Array<{ kind: string }>;
    assert.deepStrictEqual(rows.map((r) => r.kind), ["first", "second", "third"]);
  });
});
