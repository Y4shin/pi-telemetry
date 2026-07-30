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
});
