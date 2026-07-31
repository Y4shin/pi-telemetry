// Reproduction for: subagent parentage not recorded
//
// Simulates a child pi process session_start with PI_SUBAGENT_* env vars
// set (as pi-subagents does) and asserts the sessions row gets parentage.
// RED against unfixed code (readLineageFromEnv only reads PI_TELEMETRY_*).
//
// Run:  node --test docs/bugs/repro-subagent-parentage.ts

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
import { registerSessionCapture } from "../../src/capture/index.ts";

function makeConfig(dbPath: string): TelemetryConfig {
  return {
    enabled: true,
    dbPath,
    bufferFlushMs: 0,
    bufferMaxRows: 1_000_000,
    feedbackMaxBytes: 65536,
    capture: { toolArgs: false, toolResults: false, bashCommand: false },
  };
}

describe("REPRO: subagent parentage from PI_SUBAGENT_* env vars", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;
  const savedEnv: Record<string, string | undefined> = {};

  const envVarsToSet = [
    "PI_SUBAGENT_CHILD",
    "PI_SUBAGENT_PARENT_SESSION",
    "PI_SUBAGENT_PARENT_RUN_ID",
    "PI_SUBAGENT_PARENT_DEPTH",
    "PI_SUBAGENT_CHILD_AGENT",
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-parentage-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
    for (const k of envVarsToSet) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of envVarsToSet) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("stamps parentage from PI_SUBAGENT_* env vars at session_start", async () => {
    // Simulate what pi-subagents sets on a child process.
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_PARENT_SESSION = "parent-session-123";
    process.env.PI_SUBAGENT_PARENT_RUN_ID = "parent-run-456";
    process.env.PI_SUBAGENT_PARENT_DEPTH = "1";
    process.env.PI_SUBAGENT_CHILD_AGENT = "code-analysis";

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db, () => 5000);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "child-session-789" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get("child-session-789") as Record<string, unknown>;

    assert.ok(row, "session row should exist");
    assert.strictEqual(row.parent_session_id, "parent-session-123",
      "parent_session_id should come from PI_SUBAGENT_PARENT_SESSION");
    assert.strictEqual(row.parent_run_id, "parent-run-456",
      "parent_run_id should come from PI_SUBAGENT_PARENT_RUN_ID");
    assert.strictEqual(row.depth, 1,
      "depth should come from PI_SUBAGENT_PARENT_DEPTH");
    assert.strictEqual(row.agent_label, "code-analysis",
      "agent_label should come from PI_SUBAGENT_CHILD_AGENT");
  });

  it("leaves parentage NULL for root sessions (no PI_SUBAGENT_* env)", async () => {
    // Ensure no subagent env vars are set.
    for (const k of envVarsToSet) delete process.env[k];

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db, () => 5000);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "root-session-000" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get("root-session-000") as Record<string, unknown>;

    assert.ok(row, "session row should exist");
    assert.strictEqual(row.parent_session_id, null, "root session has no parent");
    assert.strictEqual(row.depth, null, "root session has no depth");
  });

  it("treats empty PI_SUBAGENT_* strings as absent (non-fanout children)", async () => {
    // Non-fanout children get PI_SUBAGENT_PARENT_RUN_ID="" and
    // PI_SUBAGENT_PARENT_DEPTH="" from pi-subagents.
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_PARENT_SESSION = "parent-session-abc";
    process.env.PI_SUBAGENT_PARENT_RUN_ID = "";
    process.env.PI_SUBAGENT_PARENT_DEPTH = "";
    process.env.PI_SUBAGENT_CHILD_AGENT = "reviewer";

    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db, () => 5000);
    registerSessionCapture(stub.pi, t);

    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => "child-session-def" } as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    t.flush();

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get("child-session-def") as Record<string, unknown>;

    assert.ok(row, "session row should exist");
    assert.strictEqual(row.parent_session_id, "parent-session-abc",
      "parent_session_id should be set from PI_SUBAGENT_PARENT_SESSION");
    assert.strictEqual(row.parent_run_id, null,
      "empty PI_SUBAGENT_PARENT_RUN_ID should yield NULL, not empty string");
    assert.strictEqual(row.depth, null,
      "empty PI_SUBAGENT_PARENT_DEPTH should yield NULL, not 0");
    assert.strictEqual(row.agent_label, "reviewer",
      "agent_label should be set from PI_SUBAGENT_CHILD_AGENT");
  });
});
