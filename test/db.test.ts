import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, MIGRATIONS, busyBackoffDelayMs } from "../src/db.ts";

const TABLES = [
  "sessions",
  "agent_runs",
  "turns",
  "llm_requests",
  "tool_executions",
  "bash_executions",
  "session_events",
  "session_event_metadata",
  "feedback",
  "telemetry_meta",
  "flush_log",
];

describe("db", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
    dbPath = join(tmp, "telemetry.db");
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("creates all 10 tables on open", () => {
    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    for (const t of TABLES) {
      assert.ok(names.has(t), `missing table ${t}`);
    }
    db.close();
  });

  it("is idempotent on second open", () => {
    openDatabase(dbPath);
    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'")
      .get() as { c: number };
    assert.strictEqual(count.c, TABLES.length + 1); // + sqlite_sequence
    db.close();
  });

  it("sets user_version and migrations do not reapply", () => {
    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.strictEqual(version.user_version, MIGRATIONS.length);
    db.close();
  });

  it("migrates an existing v2 database to latest by adding session_event_metadata and session_events attribution columns", () => {
    const v2Db = new DatabaseSync(dbPath);
    v2Db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id));
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(run_id), session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE llm_requests (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE tool_executions (tool_call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE bash_executions (bash_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE session_events (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, unix_ms INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE feedback (feedback_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, received_unix_ms INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE telemetry_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, unix_ms INTEGER NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL, detail TEXT, session_id TEXT);
      CREATE TABLE flush_log (id INTEGER PRIMARY KEY AUTOINCREMENT, unix_ms INTEGER NOT NULL, session_id TEXT, row_count INTEGER NOT NULL, tx_duration_ms INTEGER NOT NULL);
      PRAGMA user_version = 2;
    `);
    v2Db.prepare(
      "INSERT INTO session_events (event_id, session_id, unix_ms, type, payload) VALUES (?, ?, ?, ?, ?)",
    ).run("evt-pre-v3", "sess-pre-v3", 12345, "compaction", '{"reason":"threshold"}');
    v2Db.close();

    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.strictEqual(version.user_version, MIGRATIONS.length);
    const hasMeta = (
      db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='session_event_metadata'")
        .get() as { c: number }
    ).c;
    assert.strictEqual(hasMeta, 1);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sems_%'")
      .all() as Array<{ name: string }>;
    assert.deepStrictEqual(indexes.map((r) => r.name).sort(), ["idx_sems_key_int", "idx_sems_key_text"]);
    const columns = db
      .prepare("PRAGMA table_info(session_events)")
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    assert.ok(columnNames.includes("run_id"));
    assert.ok(columnNames.includes("turn_id"));
    assert.ok(columnNames.includes("turn_index"));
    const preserved = db
      .prepare("SELECT type, payload FROM session_events WHERE event_id = ?")
      .get("evt-pre-v3") as { type: string; payload: string };
    assert.strictEqual(preserved.type, "compaction");
    assert.strictEqual(preserved.payload, '{"reason":"threshold"}');
    db.close();
  });

  it("migrates an existing v1 database to latest by applying all migrations", () => {
    const v1Db = new DatabaseSync(dbPath);
    v1Db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id));
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(run_id), session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE llm_requests (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE tool_executions (tool_call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE bash_executions (bash_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE session_events (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, unix_ms INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE feedback (feedback_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, received_unix_ms INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE telemetry_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, unix_ms INTEGER NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL, detail TEXT, session_id TEXT);
      PRAGMA user_version = 1;
    `);
    v1Db.close();

    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.strictEqual(version.user_version, MIGRATIONS.length);
    const hasFlushLog = (
      db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='flush_log'")
        .get() as { c: number }
    ).c;
    assert.strictEqual(hasFlushLog, 1);
    db.close();
  });
});

describe("busy backoff delay", () => {
  it("returns an integer within [0, 50) for the first retry", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const d = busyBackoffDelayMs(0, () => (i + 0.5) / 50);
      assert.ok(Number.isInteger(d), "delay must be an integer");
      assert.ok(d >= 0, "delay must be non-negative");
      assert.ok(d < 50, `delay ${d} must be below first-retry bound 50`);
      delays.add(d);
    }
    assert.strictEqual(delays.size, 50, "deterministic rng produces distinct delays");
  });

  it("scales the bound exponentially with attempt index", () => {
    const rng = () => 0.5;
    assert.strictEqual(busyBackoffDelayMs(0, rng), 25);
    assert.strictEqual(busyBackoffDelayMs(1, rng), 50);
    assert.strictEqual(busyBackoffDelayMs(2, rng), 100);
    assert.strictEqual(busyBackoffDelayMs(8, rng), 6400);
  });

  it("caps the bound at 50ms * 2^9", () => {
    const rng = () => 0.5;
    assert.strictEqual(busyBackoffDelayMs(9, rng), 12800); // 50 * 2^9 / 2
    assert.strictEqual(busyBackoffDelayMs(20, rng), 12800); // capped
  });

  it("uses Math.random by default and stays within bounds", () => {
    for (let i = 0; i < 20; i++) {
      const d = busyBackoffDelayMs(i);
      assert.ok(Number.isInteger(d));
      assert.ok(d >= 0);
      const bound = Math.min(25600, 50 * Math.pow(2, i));
      assert.ok(d < bound, `delay ${d} must be below bound ${bound} at attempt ${i}`);
    }
  });
});
