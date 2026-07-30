import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxToolCall, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createL2Session } from "./helpers/l2-session.ts";
import piTelemetryExtension from "../index.ts";

// Unique sentinels that must never appear as literal strings outside the
// intentional feedback row. If they do, the test reports the offending table/column.
const PROMPT_TEXT = "PRIVACY-PROMPT-sentinel-7a3f9e2b";
const TOOL_ARGS_TEXT = "PRIVACY-TOOL-ARGS-sentinel-8c4d1e5a";
const TOOL_RESULT_TEXT = "PRIVACY-TOOL-RESULT-sentinel-9e7b2c4d";
const BASH_COMMAND = "printf 'PRIVACY-BASH-COMMAND-sentinel-1f6a8b3c'";
const FEEDBACK_DATA = { note: "PRIVACY-FEEDBACK-sentinel-4d9e7a1b" };

interface Leak {
  table: string;
  column: string;
  value: string;
  sentinel: string;
}

function findSentinels(db: DatabaseSync, sentinels: string[]): Leak[] {
  const leaks: Leak[] = [];
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;

  for (const { name: table } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      type: string;
    }>;
    const textColumns = columns
      .filter((c) => c.type.toUpperCase() === "TEXT" || c.type.toUpperCase() === "")
      .map((c) => c.name);

    if (textColumns.length === 0) continue;

    const rows = db.prepare(`SELECT ${textColumns.join(", ")} FROM ${table}`).all() as Array<
      Record<string, unknown>
    >;

    for (const row of rows) {
      for (const column of textColumns) {
        const value = row[column];
        if (typeof value !== "string") continue;
        for (const sentinel of sentinels) {
          if (value.includes(sentinel)) {
            leaks.push({ table, column, value, sentinel });
          }
        }
      }
    }
  }

  return leaks;
}

describe("privacy gate", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-privacy-"));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
    delete process.env.PI_TELEMETRY_DB_PATH;
  });

  it("default config stores lengths and hashes only, no content strings", async () => {
    const dbPath = join(tmp, "telemetry.db");
    process.env.PI_TELEMETRY_DB_PATH = dbPath;

    const filePath = join(tmp, "sample.txt");
    writeFileSync(filePath, TOOL_RESULT_TEXT);

    const { session, cleanup } = await createL2Session({
      dbPath,
      cwd: tmp,
      extensionFactory: piTelemetryExtension,
      responses: [
        fauxAssistantMessage(fauxToolCall("read", { path: filePath, marker: TOOL_ARGS_TEXT }, { id: "call-privacy-1" })),
        fauxAssistantMessage("Done reading."),
      ],
    });

    await session.prompt(PROMPT_TEXT);

    // Bash capture path: emit user_bash and exercise the returned operations.
    const bashResult = await session.extensionRunner.emitUserBash({
      type: "user_bash",
      command: BASH_COMMAND,
      cwd: tmp,
      excludeFromContext: false,
    });
    await bashResult!.operations!.exec(BASH_COMMAND, tmp, {
      onData: () => {},
      signal: new AbortController().signal,
    });

    // Session-shape events.
    const model = { provider: "pi-telemetry-test", id: "test-model" } as unknown as Model<any>;
    await session.extensionRunner.emit({
      type: "model_select",
      source: "set",
      model,
      previousModel: undefined,
    } as any);
    await session.extensionRunner.emit({
      type: "thinking_level_select",
      previousLevel: "off",
      level: "medium",
    } as any);

    // Feedback capture path: execute the registered submit_feedback tool directly.
    const registered = session.extensionRunner.getAllRegisteredTools();
    const submitFeedback = registered.find((t) => t.definition.name === "submit_feedback");
    assert.ok(submitFeedback, "submit_feedback tool should be registered");
    await submitFeedback.definition.execute(
      "call-privacy-feedback",
      { kind: "architecture", data: FEEDBACK_DATA },
      undefined,
      undefined,
      {
        cwd: tmp,
        mode: "print",
        hasUI: false,
        sessionManager: session.sessionManager,
        isProjectTrusted: () => true,
      } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext,
    );

    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

    const db = new DatabaseSync(dbPath, { readOnly: true });

    // Verify every capture path produced at least one row.
    const sessionRow = db.prepare("SELECT * FROM sessions LIMIT 1").get() as Record<
      string,
      unknown
    >;
    assert.ok(sessionRow, "sessions row expected");

    const runRow = db.prepare("SELECT * FROM agent_runs LIMIT 1").get() as Record<
      string,
      unknown
    >;
    assert.ok(runRow, "agent_runs row expected");

    const turnRow = db.prepare("SELECT * FROM turns LIMIT 1").get() as Record<string, unknown>;
    assert.ok(turnRow, "turns row expected");

    const llmRow = db.prepare("SELECT * FROM llm_requests LIMIT 1").get() as Record<
      string,
      unknown
    >;
    assert.ok(llmRow, "llm_requests row expected");

    const toolRow = db.prepare("SELECT * FROM tool_executions LIMIT 1").get() as Record<
      string,
      unknown
    >;
    assert.ok(toolRow, "tool_executions row expected");

    const bashRow = db.prepare("SELECT * FROM bash_executions LIMIT 1").get() as Record<
      string,
      unknown
    >;
    assert.ok(bashRow, "bash_executions row expected");

    const eventRow = db.prepare("SELECT * FROM session_events LIMIT 1").get() as Record<
      string,
      unknown
    >;
    assert.ok(eventRow, "session_events row expected");

    const feedbackRow = db.prepare("SELECT * FROM feedback LIMIT 1").get() as Record<
      string,
      unknown
    >;
    assert.ok(feedbackRow, "feedback row expected");

    // Default config must leave content columns NULL.
    assert.strictEqual(toolRow.args_json, null, "tool_executions.args_json should be NULL by default");
    assert.strictEqual(toolRow.result_text, null, "tool_executions.result_text should be NULL by default");

    // Bash command must be hashed, not stored literally.
    const bashContentLeaks = db
      .prepare("SELECT COUNT(*) as n FROM bash_executions WHERE command_hash IS NULL OR command_hash = ''")
      .get() as { n: number };
    assert.strictEqual(bashContentLeaks.n, 0, "bash_executions rows must have a command_hash");

    const sentinels = [PROMPT_TEXT, TOOL_ARGS_TEXT, TOOL_RESULT_TEXT, BASH_COMMAND];
    const leaks = findSentinels(db, sentinels);

    db.close();
    await cleanup();

    if (leaks.length > 0) {
      const report = leaks
        .map((l) => `leak: ${l.table}.${l.column} contains sentinel "${l.sentinel}": ${l.value.slice(0, 200)}`)
        .join("\n");
      assert.fail(`content strings leaked into DB:\n${report}`);
    }
  });
});
