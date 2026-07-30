import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";
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

    const turnId = turnRow.turn_id as string;
    const llmRow = db.prepare("SELECT * FROM llm_requests WHERE turn_id = ?").get(turnId) as Record<string, unknown> | undefined;
    assert.ok(llmRow, "llm_requests row expected");
    assert.strictEqual(llmRow.provider, "pi-telemetry-test");
    assert.strictEqual(llmRow.model, "test-model");
    assert.strictEqual(llmRow.session_id, sessionId);
    assert.strictEqual(llmRow.turn_id, turnRow.turn_id);
    assert.strictEqual(llmRow.run_id, runId);
    assert.strictEqual(typeof llmRow.started_unix_ms, "number");
    assert.strictEqual(typeof llmRow.duration_ms, "number");
    assert.ok((llmRow.duration_ms as number) >= 0, "duration_ms should be non-negative");

    db.close();
    await cleanup();
    delete process.env.PI_TELEMETRY_DB_PATH;
  });

  it("SDK scripted tool call produces a tool_executions row", async () => {
    const dbPath = join(tmp, "telemetry-tool.db");
    process.env.PI_TELEMETRY_DB_PATH = dbPath;

    const filePath = join(tmp, "sample.txt");
    writeFileSync(filePath, "sample content");

    const { session, cleanup } = await createL2Session({
      dbPath,
      cwd: tmp,
      extensionFactory: piTelemetryExtension,
      responses: [
        fauxAssistantMessage(fauxToolCall("read", { path: filePath }, { id: "call-read-1" })),
        fauxAssistantMessage("Done reading."),
      ],
    });

    await session.prompt("Read the file.");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

    assert.ok(existsSync(dbPath), "DB file should exist");
    const db = new DatabaseSync(dbPath, { readOnly: true });

    const sessionRow = db.prepare("SELECT * FROM sessions LIMIT 1").get() as Record<string, unknown> | undefined;
    assert.ok(sessionRow, "sessions row expected");
    const sessionId = sessionRow.session_id as string;

    const toolRow = db.prepare("SELECT * FROM tool_executions WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
    assert.ok(toolRow, "tool_executions row expected");
    assert.strictEqual(toolRow.tool_name, "read");
    assert.strictEqual(toolRow.tool_call_id, "call-read-1");
    assert.strictEqual(toolRow.is_error, 0);
    assert.strictEqual(toolRow.error_class, null);
    assert.strictEqual(typeof toolRow.started_unix_ms, "number");
    assert.strictEqual(typeof toolRow.duration_ms, "number");
    assert.ok((toolRow.duration_ms as number) >= 0, "duration_ms should be non-negative");
    assert.strictEqual(typeof toolRow.args_chars, "number");
    assert.strictEqual(typeof toolRow.result_chars, "number");
    assert.strictEqual(typeof toolRow.result_hash, "string");
    assert.strictEqual(toolRow.args_json, null);
    assert.strictEqual(toolRow.result_text, null);

    db.close();
    await cleanup();
    delete process.env.PI_TELEMETRY_DB_PATH;
  });
});
