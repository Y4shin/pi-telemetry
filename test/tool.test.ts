import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { seedFixture } from "./helpers/fixture-db.ts";
import { createRuntimeState, type Telemetry } from "../src/state.ts";
import { createL1Stub } from "./helpers/l1-stub.ts";
import { registerTelemetryTool } from "../src/query/tool.ts";
import { registerFeedback } from "../src/feedback.ts";

function makeTelemetry(dbPath: string, sessionId: string | null = null): Telemetry {
  const state = createRuntimeState();
  state.sessionId = sessionId;
  return {
    config: {
      dbPath,
      enabled: true,
      bufferFlushMs: 2000,
      bufferMaxRows: 50,
      feedbackMaxBytes: 65536,
      capture: { toolArgs: false, toolResults: false, bashCommand: false },
    },
    now: () => Date.now(),
    state,
    enqueue: () => {},
    meta: () => {},
    flush: () => {},
    close: () => {},
  } as unknown as Telemetry;
}

describe("query_telemetry tool", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;
  const now = Date.now();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-tool-"));
    dbPath = join(tmp, "telemetry.db");
    db = seedFixture(dbPath, { now });
  });

  afterEach(() => {
    try {
      db.close();
    } catch { /* ignore */ }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function tool(stub: ReturnType<typeof createL1Stub>, name: string) {
    const entry = stub.tools.find((t) => t.name === name);
    assert.ok(entry, `tool ${name} not registered`);
    return entry.definition as { execute: (toolCallId: string, params: unknown) => Promise<unknown> };
  }

  it("registers query_telemetry alongside submit_feedback without collision", () => {
    const stub = createL1Stub();
    registerFeedback(stub.pi, makeTelemetry(dbPath));
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const names = stub.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ["query_telemetry", "submit_feedback"].sort());
  });
});
