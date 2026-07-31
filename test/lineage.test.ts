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
import { registerSessionCapture, registerRunCapture } from "../src/capture/index.ts";
import { registerLineage } from "../src/lineage.ts";

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

function ctxWithSession(sessionId: string): Partial<ExtensionContext> {
  return {
    sessionManager: { getSessionId: () => sessionId } as ExtensionContext["sessionManager"],
    cwd: "/tmp/proj",
  };
}

describe("lineage foundation", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-lineage-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);

    for (const key of [
      "PI_TELEMETRY_PARENT_SESSION_ID",
      "PI_TELEMETRY_PARENT_RUN_ID",
      "PI_TELEMETRY_DEPTH",
      "PI_TELEMETRY_AGENT_LABEL",
      "PI_SUBAGENT_PARENT_SESSION",
      "PI_SUBAGENT_PARENT_RUN_ID",
      "PI_SUBAGENT_PARENT_DEPTH",
      "PI_SUBAGENT_CHILD_AGENT",
    ]) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
    for (const key of Object.keys(envBackup)) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
  });

  it("env vars present stamp the sessions row at session_start", async () => {
    process.env.PI_TELEMETRY_PARENT_SESSION_ID = "parent-sess-1";
    process.env.PI_TELEMETRY_PARENT_RUN_ID = "parent-run-1";
    process.env.PI_TELEMETRY_DEPTH = "3";
    process.env.PI_TELEMETRY_AGENT_LABEL = "reviewer";

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, ctxWithSession("sess-env-1"));
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-env-1") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.parent_session_id, "parent-sess-1");
    assert.strictEqual(row.parent_run_id, "parent-run-1");
    assert.strictEqual(row.depth, 3);
    assert.strictEqual(row.agent_label, "reviewer");
  });

  it("agent.spawned stamps the sessions row for the matching run_id", async () => {
    process.env.PI_TELEMETRY_PARENT_SESSION_ID = "parent-sess-2";

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);
    registerRunCapture(stub.pi, t);
    registerLineage(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, ctxWithSession("sess-spawn-1"));
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    const runId = t.state.runId;
    assert.ok(runId);

    stub.events.emit("pi-telemetry:agent.spawned", {
      run_id: runId,
      parent_session_id: "spawned-parent-sess",
      parent_run_id: "spawned-parent-run",
      depth: 5,
      agent_label: "spawner",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-spawn-1") as Record<string, unknown>;
    assert.ok(row);
    // env var lineage from startup stays on parent_session_id
    assert.strictEqual(row.parent_session_id, "spawned-parent-sess");
    assert.strictEqual(row.parent_run_id, "spawned-parent-run");
    assert.strictEqual(row.depth, 5);
    assert.strictEqual(row.agent_label, "spawner");
  });

  it("agent.completed stamps the sessions row for the matching run_id", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);
    registerRunCapture(stub.pi, t);
    registerLineage(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, ctxWithSession("sess-complete-1"));
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    const runId = t.state.runId;
    assert.ok(runId);

    stub.events.emit("pi-telemetry:agent.completed", {
      run_id: runId,
      parent_session_id: "completed-parent-sess",
      parent_run_id: "completed-parent-run",
      depth: 7,
      agent_label: "finisher",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-complete-1") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.parent_session_id, "completed-parent-sess");
    assert.strictEqual(row.parent_run_id, "completed-parent-run");
    assert.strictEqual(row.depth, 7);
    assert.strictEqual(row.agent_label, "finisher");
  });

  it("unknown run_id is a no-op and records a meta note", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);
    registerRunCapture(stub.pi, t);
    registerLineage(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, ctxWithSession("sess-unknown-1"));
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    t.flush();

    stub.events.emit("pi-telemetry:agent.spawned", {
      run_id: "not-the-current-run",
      parent_session_id: "x",
      depth: 1,
      agent_label: "y",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-unknown-1") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.parent_session_id, null);

    const meta = db.prepare("SELECT * FROM telemetry_meta WHERE session_id = ? AND event = ? AND level = ?").get("sess-unknown-1", "handler_error", "warn") as Record<string, unknown> | undefined;
    assert.ok(meta);
    assert.ok(String(meta.detail).includes("unknown run_id"));
  });

  it("malformed lineage payloads are swallowed and recorded as meta notes", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);
    registerRunCapture(stub.pi, t);
    registerLineage(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, ctxWithSession("sess-bad-1"));
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    t.flush();

    await assert.doesNotReject(async () => {
      stub.events.emit("pi-telemetry:agent.spawned", null);
      stub.events.emit("pi-telemetry:agent.spawned", "not an object");
      stub.events.emit("pi-telemetry:agent.completed", { run_id: 12345 });
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-bad-1") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.parent_session_id, null);

    const metaCount = db.prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE session_id = ? AND event = ? AND level = ?").get("sess-bad-1", "handler_error", "warn") as { c: number };
    assert.strictEqual(metaCount.c, 3);
  });

  it("env-export helper responds with the current env block", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);
    registerRunCapture(stub.pi, t);
    registerLineage(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, ctxWithSession("sess-export"));
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    t.flush();

    let response: unknown;
    stub.events.on("pi-telemetry:lineage-env.response", (data: unknown) => {
      response = data;
    });

    stub.events.emit("pi-telemetry:lineage-env.request", {});
    t.flush();

    assert.deepStrictEqual(response, {
      PI_TELEMETRY_PARENT_SESSION_ID: "sess-export",
      PI_TELEMETRY_PARENT_RUN_ID: t.state.runId,
      PI_TELEMETRY_DEPTH: 1,
      PI_TELEMETRY_AGENT_LABEL: null,
    });
  });

  it("env-export helper derives depth+1 from inherited lineage", async () => {
    process.env.PI_TELEMETRY_PARENT_SESSION_ID = "grandparent-sess";
    process.env.PI_TELEMETRY_PARENT_RUN_ID = "grandparent-run";
    process.env.PI_TELEMETRY_DEPTH = "2";
    process.env.PI_TELEMETRY_AGENT_LABEL = "reviewer";

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);
    registerRunCapture(stub.pi, t);
    registerLineage(stub.pi, t);

    await stub.fire("session_start", { reason: "fork" }, ctxWithSession("sess-export-depth"));
    await stub.fire("before_agent_start", { prompt: "x", systemPrompt: "y" });
    await stub.fire("agent_start", {});
    t.flush();

    let response: unknown;
    stub.events.on("pi-telemetry:lineage-env.response", (data: unknown) => {
      response = data;
    });

    stub.events.emit("pi-telemetry:lineage-env.request", {});
    t.flush();

    assert.deepStrictEqual(response, {
      PI_TELEMETRY_PARENT_SESSION_ID: "sess-export-depth",
      PI_TELEMETRY_PARENT_RUN_ID: t.state.runId,
      PI_TELEMETRY_DEPTH: 3,
      PI_TELEMETRY_AGENT_LABEL: "reviewer",
    });
  });

  it("partial env vars are stored without inference", async () => {
    process.env.PI_TELEMETRY_DEPTH = "9";

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, ctxWithSession("sess-partial-1"));
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-partial-1") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.parent_session_id, null);
    assert.strictEqual(row.parent_run_id, null);
    assert.strictEqual(row.depth, 9);
    assert.strictEqual(row.agent_label, null);
  });

  it("non-numeric depth env is tolerated as NULL", async () => {
    process.env.PI_TELEMETRY_DEPTH = "not-a-number";

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, ctxWithSession("sess-depth-1"));
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-depth-1") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.depth, null);
  });

  it("empty-string label env is stored as empty string", async () => {
    process.env.PI_TELEMETRY_AGENT_LABEL = "";

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, ctxWithSession("sess-empty-1"));
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-empty-1") as Record<string, unknown>;
    assert.ok(row);
    assert.strictEqual(row.agent_label, "");
  });
});
