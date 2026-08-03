import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createL1Stub, type L1Stub } from "./helpers/l1-stub.ts";
import { seedFixture } from "./helpers/fixture-db.ts";
import { seedSkillEvents } from "./helpers/fixture-skill-events.ts";
import { createRuntimeState, type Telemetry } from "../src/state.ts";
import { registerTelemetryCommands } from "../src/query/commands.ts";

interface CommandDef {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<string> | string;
}

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

describe("telemetry commands", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;
  const now = Date.now();

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

  function cmd(stub: L1Stub, name: string): CommandDef {
    const entry = stub.commands.find((c) => c.name === name);
    assert.ok(entry, `command ${name} not registered`);
    return entry.options as CommandDef;
  }

  function ctx() {
    return { ui: { notify: () => {} } };
  }

  it("registers /telemetry and /tm", () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    assert.deepStrictEqual(stub.commands.map((c) => c.name).sort(), ["telemetry", "tm"]);
  });

  it("status shows DB path, size, counts, and meta events", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler("", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes(basename(dbPath)));
    assert.ok(out.includes("sessions"));
    assert.ok(out.includes("telemetry_meta"));
  });

  it("session returns current session summary", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath, "sess-root"));
    const out = await cmd(stub, "telemetry").handler("session", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("sess-root"));
    assert.ok(out.includes("cost_usd"));
  });

  it("session without active session says no data", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath, null));
    const out = await cmd(stub, "telemetry").handler("session", ctx());
    assert.strictEqual(out, "No active session.");
  });

  it("cost today groups recent model costs", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler("cost today", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("model"));
    assert.ok(out.includes("cost_usd"));
  });

  it("cost all returns all rows", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler("cost all", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("claude-sonnet") || out.includes("gpt-4o") || out.includes("claude-haiku"));
  });

  it("errors shows failed tools and non-2xx LLM statuses", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler("errors", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("bash") || out.includes("HTTP 429") || out.includes("write_failed"));
  });

  it("errors --since filters old rows", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler(`errors --since ${now + 1000}`, ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("(no data)"));
  });

  it("feedback respects filters", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler("feedback --source pi", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("pi"));
    assert.ok(!out.includes("plugin"));
  });

  it("tree renders lineage rows", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath, "sess-root"));
    const out = await cmd(stub, "telemetry").handler("tree", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("sess-root") || out.includes("No lineage data"));
  });

  it("export writes CSV files", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const outPath = join(tmp, "out.csv");
    const out = await cmd(stub, "telemetry").handler(`export --out ${outPath}`, ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes(outPath));
    const text = readFileSync(`${outPath}.sessions.csv`, "utf8");
    assert.ok(text.includes("sess-root"));
  });

  it("sql runs a guarded SELECT", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler('sql SELECT session_id FROM sessions', ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("sess-root"));
  });

  it("sql rejects a write attempt", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler('sql CREATE TABLE hack (x TEXT)', ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("failed") || out.includes("read-only") || out.includes("query_only"));
  });

  it("empty DB renders clear no-data output", async () => {
    const emptyPath = join(tmp, "empty.db");
    const emptyDb = seedFixture(emptyPath, { now });
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

    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(emptyPath));
    const out = await cmd(stub, "telemetry").handler("cost all", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("(no data)"));
  });

  it("unknown subcommand returns usage", async () => {
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler("frobnicate", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("Usage"));
  });

  it("skills renders skill cost table rows", async () => {
    seedSkillEvents(db, now);
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler("skills", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("skills_package_version"));
    assert.ok(out.includes("skill_name"));
    assert.ok(out.includes("invocations"));
    assert.ok(out.includes("cost_usd"));
    assert.ok(out.includes("tokens"));
    assert.ok(out.includes("tool_errors"));
    assert.ok(out.includes("implement-task"));
    assert.ok(out.includes("2.5.1"));
    assert.ok(out.includes("2.4.0"));
  });

  it("skills orders newest version first", async () => {
    seedSkillEvents(db, now);
    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(dbPath));
    const out = await cmd(stub, "telemetry").handler("skills", ctx());
    const idx251 = out.indexOf("2.5.1");
    const idx240 = out.indexOf("2.4.0");
    assert.ok(idx251 >= 0);
    assert.ok(idx240 >= 0);
    assert.ok(idx251 < idx240, "expected 2.5.1 before 2.4.0");
  });

  it("skills on empty DB shows no data", async () => {
    const emptyPath = join(tmp, "empty.db");
    const emptyDb = seedFixture(emptyPath, { now });
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

    const stub = createL1Stub();
    registerTelemetryCommands(stub.pi, makeTelemetry(emptyPath));
    const out = await cmd(stub, "telemetry").handler("skills", ctx());
    assert.ok(typeof out === "string");
    assert.ok(out.includes("(no data)"));
  });
});
