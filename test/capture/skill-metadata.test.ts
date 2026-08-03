import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/db.ts";
import { createBuffer } from "../../src/buffer.ts";
import { insertSkillMetadata } from "../../src/capture/skill-metadata.ts";
import type { TelemetryConfig } from "../../src/config.ts";

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

function setupBase(db: DatabaseSync, sessionId: string, eventId: string) {
  db.prepare(
    "INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)",
  ).run(sessionId, Date.now());
  db.prepare(
    "INSERT INTO session_events (event_id, session_id, unix_ms, type, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(eventId, sessionId, Date.now(), "skill_invoke", "{}");
}

function metaRows(db: DatabaseSync, eventId: string): Array<{
  key: string;
  type: string;
  value_text: string | null;
  value_int: number | null;
  value_real: number | null;
  value_bool: number | null;
}> {
  return db
    .prepare(
      "SELECT key, type, value_text, value_int, value_real, value_bool FROM session_event_metadata WHERE event_id = ? ORDER BY key",
    )
    .all(eventId) as Array<{
      key: string;
      type: string;
      value_text: string | null;
      value_int: number | null;
      value_real: number | null;
      value_bool: number | null;
    }>;
}

describe("insertSkillMetadata", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-skill-meta-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("projects a string value into value_text", () => {
    const t = createBuffer(makeConfig(dbPath), db);
    const eventId = "evt-string";
    setupBase(db, "sess-string", eventId);

    insertSkillMetadata(t, eventId, "skill_name", "string", "implement-task");
    t.flush();

    const rows = metaRows(db, eventId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].key, "skill_name");
    assert.strictEqual(rows[0].type, "string");
    assert.strictEqual(rows[0].value_text, "implement-task");
    assert.strictEqual(rows[0].value_int, null);
    assert.strictEqual(rows[0].value_real, null);
    assert.strictEqual(rows[0].value_bool, null);
  });

  it("projects an integer value into value_int", () => {
    const t = createBuffer(makeConfig(dbPath), db);
    const eventId = "evt-int";
    setupBase(db, "sess-int", eventId);

    insertSkillMetadata(t, eventId, "slice_count", "int", 7);
    t.flush();

    const rows = metaRows(db, eventId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].type, "int");
    assert.strictEqual(rows[0].value_int, 7);
    assert.strictEqual(rows[0].value_text, null);
    assert.strictEqual(rows[0].value_real, null);
    assert.strictEqual(rows[0].value_bool, null);
  });

  it("projects a float value into value_real", () => {
    const t = createBuffer(makeConfig(dbPath), db);
    const eventId = "evt-float";
    setupBase(db, "sess-float", eventId);

    insertSkillMetadata(t, eventId, "cost_usd", "float", 0.00215);
    t.flush();

    const rows = metaRows(db, eventId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].type, "float");
    assert.strictEqual(rows[0].value_real, 0.00215);
    assert.strictEqual(rows[0].value_text, null);
    assert.strictEqual(rows[0].value_int, null);
    assert.strictEqual(rows[0].value_bool, null);
  });

  it("projects a boolean true value into value_bool=1", () => {
    const t = createBuffer(makeConfig(dbPath), db);
    const eventId = "evt-bool";
    setupBase(db, "sess-bool", eventId);

    insertSkillMetadata(t, eventId, "succeeded", "bool", true);
    t.flush();

    const rows = metaRows(db, eventId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].type, "bool");
    assert.strictEqual(rows[0].value_bool, 1);
    assert.strictEqual(rows[0].value_text, null);
    assert.strictEqual(rows[0].value_int, null);
    assert.strictEqual(rows[0].value_real, null);
  });

  it("projects a boolean false value into value_bool=0", () => {
    const t = createBuffer(makeConfig(dbPath), db);
    const eventId = "evt-bool-false";
    setupBase(db, "sess-bool-false", eventId);

    insertSkillMetadata(t, eventId, "succeeded", "bool", false);
    t.flush();

    const rows = metaRows(db, eventId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].value_bool, 0);
  });

  it("skips null values", () => {
    const t = createBuffer(makeConfig(dbPath), db);
    const eventId = "evt-null";
    setupBase(db, "sess-null", eventId);

    insertSkillMetadata(t, eventId, "target", "string", null);
    t.flush();

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE event_id = ?")
      .get(eventId) as { c: number };
    assert.strictEqual(count.c, 0);
  });

  it("uses INSERT OR IGNORE for replay idempotency", () => {
    const t = createBuffer(makeConfig(dbPath), db);
    const eventId = "evt-dup";
    setupBase(db, "sess-dup", eventId);

    insertSkillMetadata(t, eventId, "skill_name", "string", "first");
    insertSkillMetadata(t, eventId, "skill_name", "string", "second");
    t.flush();

    const rows = metaRows(db, eventId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].value_text, "first");
  });

  it("records a meta note on type mismatch instead of throwing", () => {
    const t = createBuffer(makeConfig(dbPath), db);
    const eventId = "evt-mismatch";
    setupBase(db, "sess-mismatch", eventId);

    insertSkillMetadata(t, eventId, "slice_count", "int", "not-a-number" as unknown as number);
    t.flush();

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE event_id = ?")
      .get(eventId) as { c: number };
    assert.strictEqual(count.c, 0);
    const meta = db
      .prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'handler_error' AND detail LIKE ?")
      .get("%insertSkillMetadata%") as { c: number };
    assert.ok(meta.c >= 1, "expected a handler_error meta note for type mismatch");
  });

  it("is self-guarded: errors are swallowed and never thrown", () => {
    const t = createBuffer(makeConfig(dbPath), db);
    // Deliberately do not create the parent session_events row; the FK will
    // fail on flush. The helper should not throw.
    assert.doesNotThrow(() => {
      insertSkillMetadata(t, "evt-orphan", "skill_name", "string", "x");
      t.flush();
    });
  });
});

describe("session_event_metadata CHECK constraint", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-check-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function setupEvent(eventId: string) {
    db.prepare(
      "INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)",
    ).run("sess-check", Date.now());
    db.prepare(
      "INSERT INTO session_events (event_id, session_id, unix_ms, type, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(eventId, "sess-check", Date.now(), "skill_invoke", "{}");
  }

  it("accepts a valid string row", () => {
    setupEvent("e-valid-string");
    db.prepare(
      "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("e-valid-string", "k", "string", "v", null, null, null);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE event_id = ?")
      .get("e-valid-string") as { c: number };
    assert.strictEqual(count.c, 1);
  });

  it("rejects a row with type=string but value_int set", () => {
    setupEvent("e-bad-string");
    assert.throws(() => {
      db.prepare(
        "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("e-bad-string", "k", "string", null, 5, null, null);
    }, /CHECK/);
  });

  it("rejects a row with type=int but value_text set", () => {
    setupEvent("e-bad-int");
    assert.throws(() => {
      db.prepare(
        "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("e-bad-int", "k", "int", "v", null, null, null);
    }, /CHECK/);
  });

  it("rejects a row with two value columns non-null", () => {
    setupEvent("e-two-nonnull");
    assert.throws(() => {
      db.prepare(
        "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("e-two-nonnull", "k", "string", "v", 5, null, null);
    }, /CHECK/);
  });

  it("rejects a row with all value columns null", () => {
    setupEvent("e-all-null");
    assert.throws(() => {
      db.prepare(
        "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("e-all-null", "k", "string", null, null, null, null);
    }, /CHECK/);
  });
});

describe("compare-versions pivot query (QUERY_D)", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-query-d-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("uses indexes at every step", () => {
    db.prepare(
      "INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)",
    ).run("sess-plan", Date.now());
    db.prepare(
      "INSERT INTO agent_runs (run_id, session_id, started_unix_ms) VALUES (?, ?, ?)",
    ).run("run-plan", "sess-plan", Date.now());
    db.prepare(
      "INSERT INTO turns (turn_id, run_id, session_id, turn_index, started_unix_ms, cost_total_usd) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("turn-plan", "run-plan", "sess-plan", 1, Date.now(), 0.001);
    db.prepare(
      "INSERT INTO tool_executions (tool_call_id, turn_id, run_id, session_id, tool_name, started_unix_ms, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("tool-plan", "turn-plan", "run-plan", "sess-plan", "bash", Date.now(), 0);
    db.prepare(
      "INSERT INTO session_events (event_id, session_id, unix_ms, type, payload) VALUES (?, ?, ?, ?, ?)",
    ).run("evt-plan", "sess-plan", Date.now(), "skill_invoke", "{}");
    db.prepare(
      "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("evt-plan", "skills_package_version", "string", "2.5.1", null, null, null);
    db.prepare(
      "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("evt-plan", "skill_name", "string", "wayfinder", null, null, null);
    db.prepare(
      "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("evt-plan", "run_id", "string", "run-plan", null, null, null);

    const QUERY_D = `
SELECT m_ver.value_text AS ver, m_skill.value_text AS skill, COUNT(*) AS invocations,
  ROUND(SUM(t.cost_total_usd), 3) AS cost_usd, SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_event_metadata m_ver
JOIN session_event_metadata m_skill ON m_skill.event_id = m_ver.event_id AND m_skill.key = 'skill_name'
JOIN session_event_metadata m_run ON m_run.event_id = m_ver.event_id AND m_run.key = 'run_id'
JOIN turns t ON t.run_id = m_run.value_text
JOIN tool_executions te ON te.turn_id = t.turn_id
WHERE m_ver.key = 'skills_package_version' AND m_ver.value_text = ?
GROUP BY m_ver.value_text, m_skill.value_text ORDER BY m_skill.value_text`;

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${QUERY_D}`).all("2.5.1") as Array<{
      detail: string;
    }>;
    const details = plan.map((r) => r.detail).join("\n");
    const searches = plan.filter((r) => r.detail.includes("SEARCH") && r.detail.includes("USING INDEX"));
    assert.ok(searches.length >= 4, `expected at least 4 indexed searches, got:\n${details}`);
    assert.ok(details.includes("idx_sems_key_text"), "should use idx_sems_key_text");
    assert.ok(details.includes("idx_turns_run"), "should use idx_turns_run");
  });

  it("returns correct grouped rows", () => {
    const now = Date.now();
    db.prepare("INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)").run("sess-q", now);
    db.prepare("INSERT INTO agent_runs (run_id, session_id, started_unix_ms) VALUES (?, ?, ?)").run("run-q", "sess-q", now);
    db.prepare(
      "INSERT INTO turns (turn_id, run_id, session_id, turn_index, started_unix_ms, cost_total_usd) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("turn-q", "run-q", "sess-q", 1, now, 0.123);
    db.prepare(
      "INSERT INTO tool_executions (tool_call_id, turn_id, run_id, session_id, tool_name, started_unix_ms, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("tool-q", "turn-q", "run-q", "sess-q", "bash", now, 1);
    db.prepare(
      "INSERT INTO session_events (event_id, session_id, unix_ms, type, payload) VALUES (?, ?, ?, ?, ?)",
    ).run("evt-q", "sess-q", now, "skill_invoke", "{}");
    db.prepare(
      "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("evt-q", "skills_package_version", "string", "2.5.1", null, null, null);
    db.prepare(
      "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("evt-q", "skill_name", "string", "implement-task", null, null, null);
    db.prepare(
      "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("evt-q", "run_id", "string", "run-q", null, null, null);

    const QUERY_D = `
SELECT m_ver.value_text AS ver, m_skill.value_text AS skill, COUNT(*) AS invocations,
  ROUND(SUM(t.cost_total_usd), 3) AS cost_usd, SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_event_metadata m_ver
JOIN session_event_metadata m_skill ON m_skill.event_id = m_ver.event_id AND m_skill.key = 'skill_name'
JOIN session_event_metadata m_run ON m_run.event_id = m_ver.event_id AND m_run.key = 'run_id'
JOIN turns t ON t.run_id = m_run.value_text
JOIN tool_executions te ON te.turn_id = t.turn_id
WHERE m_ver.key = 'skills_package_version' AND m_ver.value_text = ?
GROUP BY m_ver.value_text, m_skill.value_text ORDER BY m_skill.value_text`;

    const rows = db.prepare(QUERY_D).all("2.5.1") as Array<{
      ver: string;
      skill: string;
      invocations: number;
      cost_usd: number;
      tool_errors: number;
    }>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ver, "2.5.1");
    assert.strictEqual(rows[0].skill, "implement-task");
    assert.strictEqual(rows[0].invocations, 1);
    assert.strictEqual(rows[0].cost_usd, 0.123);
    assert.strictEqual(rows[0].tool_errors, 1);
  });
});
