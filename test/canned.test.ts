import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { seedFixture } from "./helpers/fixture-db.ts";
import { CANNED, runCanned } from "../src/query/canned.ts";

describe("canned queries", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
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

  it("exports every SPEC derived metric", () => {
    const required = [
      "session_cost",
      "daily_cost",
      "model_cost",
      "cache_hit_ratio",
      "tool_failures",
      "turn_latency",
      "context_growth",
      "frequency_429",
      "ttft_by_model",
      "feedback",
      "agent_tree",
    ];
    for (const name of required) {
      assert.ok(CANNED[name], `missing canned query ${name}`);
      assert.ok(CANNED[name].description, `${name} has a description`);
      assert.ok(CANNED[name].sql, `${name} has SQL`);
    }
  });

  it("session_summary returns current session stats", async () => {
    const table = await runCanned(dbPath, "session_summary", { sessionId: "sess-root" });
    assert.ok(table.columns.includes("session_id"));
    assert.ok(table.columns.includes("cost_usd"));
    assert.strictEqual(table.rows.length, 1);
    const row = table.rows[0] as (string | number | null)[];
    assert.strictEqual(row[0], "sess-root");
    const costIdx = table.columns.indexOf("cost_usd");
    assert.ok(costIdx >= 0);
    // cost_total: 0.00215 + 0.0004 = 0.00255
    assert.ok(Math.abs((row[costIdx] as number) - 0.00255) < 0.0001);
  });

  it("daily_cost groups by day", async () => {
    const table = await runCanned(dbPath, "daily_cost");
    assert.ok(table.columns.includes("day"));
    assert.ok(table.columns.includes("cost_usd"));
    assert.strictEqual(table.rows.length, 2);
  });

  it("model_cost respects model filter", async () => {
    const table = await runCanned(dbPath, "model_cost", { model: "claude-sonnet" });
    assert.strictEqual(table.rows.length, 1);
    assert.strictEqual((table.rows[0] as (string | number | null)[])[1], "claude-sonnet");
  });

  it("tool_failures reports error rate", async () => {
    const table = await runCanned(dbPath, "tool_failures");
    assert.ok(table.columns.includes("error_rate_pct"));
    const bash = table.rows.find((r) => (r as (string | number | null)[])[0] === "bash") as (string | number | null)[];
    assert.ok(bash);
    assert.strictEqual(bash[2], 1); // errors
    assert.strictEqual(bash[3], 100); // 100% error rate
  });

  it("frequency_429 counts 429s", async () => {
    const table = await runCanned(dbPath, "frequency_429");
    assert.strictEqual(table.rows.length, 2);
    const haiku = table.rows.find((r) => (r as (string | number | null)[])[1] === "claude-haiku") as (string | number | null)[];
    assert.ok(haiku);
    assert.strictEqual(haiku[3], 1); // count_429
  });

  it("feedback respects kind and source filters", async () => {
    const all = await runCanned(dbPath, "feedback");
    assert.strictEqual(all.rows.length, 2);
    const piOnly = await runCanned(dbPath, "feedback", { source: "pi" });
    assert.strictEqual(piOnly.rows.length, 1);
    const goodOnly = await runCanned(dbPath, "feedback", { kind: "good" });
    assert.strictEqual(goodOnly.rows.length, 1);
  });

  it("errors respects since filter", async () => {
    const all = await runCanned(dbPath, "errors");
    assert.ok(all.rows.length >= 1);
    const future = await runCanned(dbPath, "errors", { since: now + dayMs });
    assert.strictEqual(future.rows.length, 0);
  });

  it("returns empty table when DB is empty", async () => {
    const emptyPath = join(tmp, "empty.db");
    const emptyDb = seedFixture(emptyPath, { now });
    // Truncate all measurement tables so only schema remains.
    emptyDb.exec("PRAGMA foreign_keys=OFF");
    emptyDb.exec("DELETE FROM feedback");
    emptyDb.exec("DELETE FROM tool_executions");
    emptyDb.exec("DELETE FROM llm_requests");
    emptyDb.exec("DELETE FROM turns");
    emptyDb.exec("DELETE FROM agent_runs");
    emptyDb.exec("DELETE FROM sessions");
    emptyDb.exec("DELETE FROM telemetry_meta");
    emptyDb.exec("PRAGMA foreign_keys=ON");
    emptyDb.close();

    const table = await runCanned(emptyPath, "daily_cost");
    assert.strictEqual(table.rows.length, 0);
    assert.strictEqual(table.truncated, false);
  });

  it("rejects unknown canned names", async () => {
    await assert.rejects(() => runCanned(dbPath, "no-such-query"), /Unknown canned query/);
  });
});
