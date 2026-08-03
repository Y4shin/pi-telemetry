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
import { openDatabase } from "../src/db.ts";
import { seedSkillEvents } from "./helpers/fixture-skill-events.ts";

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

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: {
    description: string;
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    truncated: boolean;
  };
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

  async function execute(stub: ReturnType<typeof createL1Stub>, params: Record<string, unknown>): Promise<ToolResult> {
    const result = await tool(stub, "query_telemetry").execute("tc-1", params);
    return result as ToolResult;
  }

  it("registers query_telemetry alongside submit_feedback without collision", () => {
    const stub = createL1Stub();
    registerFeedback(stub.pi, makeTelemetry(dbPath));
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const names = stub.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ["query_telemetry", "submit_feedback"].sort());
  });

  it("session_cost preset returns cost aggregates per session", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "session_cost" });
    assert.strictEqual(result.details.rowCount, 2);
    const ids = result.details.rows.map((r) => r[0]);
    assert.ok(ids.includes("sess-root"));
    assert.ok(ids.includes("sess-child"));
  });

  it("daily_cost preset returns cost grouped by day", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "daily_cost" });
    assert.strictEqual(result.details.rowCount, 2);
    const costs = result.details.rows.map((r) => r[result.details.columns.indexOf("cost_usd")]);
    assert.ok(costs.some((c) => typeof c === "number" && c > 0));
  });

  it("tool_failures preset returns error rates by tool", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "tool_failures" });
    assert.strictEqual(result.details.rowCount, 2);
    const idx = {
      tool: result.details.columns.indexOf("tool_name"),
      errors: result.details.columns.indexOf("errors"),
      rate: result.details.columns.indexOf("error_rate_pct"),
    };
    const bash = result.details.rows.find((r) => r[idx.tool] === "bash");
    assert.ok(bash);
    assert.strictEqual(bash![idx.errors], 1);
    assert.ok((bash![idx.rate] as number) >= 99);
  });

  it("feedback preset returns rows newest first", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "feedback" });
    assert.strictEqual(result.details.rowCount, 2);
    const idx = result.details.columns.indexOf("source");
    assert.strictEqual(result.details.rows[0][idx], "plugin");
    assert.strictEqual(result.details.rows[1][idx], "pi");
  });

  it("ttft_by_model preset returns percentiles", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "ttft_by_model" });
    assert.strictEqual(result.details.rowCount, 2);
    const idx = result.details.columns.indexOf("model");
    const models = result.details.rows.map((r) => r[idx]);
    assert.ok(models.includes("claude-sonnet"));
    assert.ok(models.includes("claude-haiku"));
  });

  it("context_growth preset returns context tokens per turn", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "context_growth" });
    assert.strictEqual(result.details.rowCount, 3);
    const idx = result.details.columns.indexOf("context_tokens_at_start");
    const contexts = result.details.rows.map((r) => r[idx]);
    assert.deepStrictEqual(contexts, [500, 200, 300]);
  });

  it("agent_tree preset returns lineage sessions", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "agent_tree" });
    assert.strictEqual(result.details.rowCount, 2);
    const idx = result.details.columns.indexOf("session_id");
    const ids = result.details.rows.map((r) => r[idx]);
    assert.ok(ids.includes("sess-root"));
    assert.ok(ids.includes("sess-child"));
  });

  it("skill_cost preset returns rows grouped by version and skill", async () => {
    seedSkillEvents(db, now);
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "skill_cost" });
    assert.strictEqual(result.details.rowCount, 3);
    const idx = {
      version: result.details.columns.indexOf("skills_package_version"),
      skill: result.details.columns.indexOf("skill_name"),
      invocations: result.details.columns.indexOf("invocations"),
      cost: result.details.columns.indexOf("cost_usd"),
      tokens: result.details.columns.indexOf("tokens"),
      errors: result.details.columns.indexOf("tool_errors"),
    };
    const first = result.details.rows[0];
    assert.strictEqual(first[idx.version], "2.5.1");
    assert.strictEqual(first[idx.skill], "implement-task");
    assert.strictEqual(first[idx.invocations], 2);
    assert.strictEqual(first[idx.cost], 0.3);
    assert.strictEqual(first[idx.tokens], 150);
    assert.strictEqual(first[idx.errors], 1);
  });

  it("sql escape hatch runs raw SELECT", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { sql: "SELECT session_id FROM sessions ORDER BY session_id" });
    assert.strictEqual(result.details.rowCount, 2);
    assert.strictEqual(result.details.description, "Raw SQL query");
    assert.strictEqual(result.details.truncated, false);
  });

  it("sql write attempt fails by construction with clear read-only error", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    await assert.rejects(async () => {
      await execute(stub, { sql: "CREATE TABLE hack (x TEXT)" });
    }, /read[- ]only|query_only|attempt to write/i);
  });

  it("sql query without LIMIT is capped at 500 rows with truncation noted", async () => {
    const hugePath = join(tmp, "huge.db");
    const hugeDb = openDatabase(hugePath);
    const insert = hugeDb.prepare("INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)");
    hugeDb.exec("BEGIN");
    for (let i = 0; i < 501; i++) {
      insert.run(`sess-${i}`, now - i);
    }
    hugeDb.exec("COMMIT");
    hugeDb.close();

    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(hugePath));
    const result = await execute(stub, { sql: "SELECT session_id FROM sessions ORDER BY started_unix_ms DESC" });
    assert.strictEqual(result.details.rowCount, 500);
    assert.strictEqual(result.details.truncated, true);
  });

  it("unknown preset returns validation error listing valid presets", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    await assert.rejects(async () => {
      await execute(stub, { query: "not_a_preset" });
    }, /Unknown preset.*session_cost.*daily_cost.*tool_failures/i);
  });

  it("both query and sql supplied is rejected", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    await assert.rejects(async () => {
      await execute(stub, { query: "daily_cost", sql: "SELECT 1" });
    }, /either query or sql, not both/i);
  });

  it("neither query nor sql supplied is rejected", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    await assert.rejects(async () => {
      await execute(stub, {});
    }, /either query.*or sql/i);
  });

  it("empty result set returns rowCount 0", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "feedback", source: "no-such-source" });
    assert.strictEqual(result.details.rowCount, 0);
    assert.deepStrictEqual(result.details.rows, []);
  });

  it("filter combo with matches returns only matching rows", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "feedback", source: "pi" });
    assert.strictEqual(result.details.rowCount, 1);
    const idx = result.details.columns.indexOf("source");
    assert.strictEqual(result.details.rows[0][idx], "pi");
  });

  it("since filter excludes old rows", async () => {
    const stub = createL1Stub();
    registerTelemetryTool(stub.pi, makeTelemetry(dbPath));
    const result = await execute(stub, { query: "daily_cost", since: "1d" });
    assert.strictEqual(result.details.rowCount, 1);
    const idx = result.details.columns.indexOf("day");
    const day = result.details.rows[0][idx] as string;
    const recentDay = new Date(now - 0.5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.strictEqual(day, recentDay);
  });
});
