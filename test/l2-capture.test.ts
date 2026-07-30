import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createL2Session } from "./helpers/l2-session.ts";
import piTelemetryExtension from "../index.ts";

describe("L2 capture", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-l2-cap-"));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("SDK mock prompt produces sessions, agent_runs, and turns rows", async () => {
    const dbPath = join(tmp, "telemetry.db");
    process.env.PI_TELEMETRY_DB_PATH = dbPath;

    const { session, cleanup } = await createL2Session({
      dbPath,
      extensionFactory: piTelemetryExtension,
    });

    await session.prompt("Say hello.");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

    assert.ok(existsSync(dbPath), "DB file should exist");
    const db = new DatabaseSync(dbPath, { readOnly: true });

    const sessionRow = db.prepare("SELECT * FROM sessions LIMIT 1").get() as Record<string, unknown> | undefined;
    assert.ok(sessionRow, "sessions row expected");
    assert.strictEqual(typeof sessionRow.session_id, "string");
    const sessionId = sessionRow.session_id as string;

    const runRow = db.prepare("SELECT * FROM agent_runs WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
    assert.ok(runRow, "agent_runs row expected");
    assert.strictEqual(runRow.outcome, "settled");
    assert.strictEqual(typeof runRow.run_id, "string");
    const runId = runRow.run_id as string;

    const turnRow = db.prepare("SELECT * FROM turns WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    assert.ok(turnRow, "turns row expected");
    assert.strictEqual(turnRow.provider, "pi-telemetry-test");
    assert.strictEqual(turnRow.model, "test-model");
    assert.strictEqual(typeof turnRow.input_tokens, "number");
    assert.strictEqual(typeof turnRow.output_tokens, "number");
    assert.strictEqual(typeof turnRow.total_tokens, "number");

    db.close();
    await cleanup();
    delete process.env.PI_TELEMETRY_DB_PATH;
  });
});
