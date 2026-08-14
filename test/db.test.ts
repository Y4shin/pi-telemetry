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

  it("migrates an existing v4 database by nulling mis-measured ttft_ms=0 rows", () => {
    const v4Db = new DatabaseSync(dbPath);
    v4Db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id), started_unix_ms INTEGER NOT NULL);
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(run_id), session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE llm_requests (
        request_id        TEXT PRIMARY KEY,
        turn_id           TEXT REFERENCES turns(turn_id),
        run_id            TEXT,
        session_id        TEXT NOT NULL,
        provider          TEXT,
        model             TEXT,
        started_unix_ms   INTEGER NOT NULL,
        ttft_ms           INTEGER,
        stream_ms         INTEGER,
        duration_ms       INTEGER,
        input_tokens      INTEGER,
        output_tokens     INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_total_usd    REAL,
        stop_reason       TEXT,
        http_status       INTEGER,
        retry_after_ms    INTEGER
      );
      CREATE INDEX idx_llm_session ON llm_requests(session_id);
      CREATE INDEX idx_llm_model ON llm_requests(model);
      PRAGMA user_version = 4;
    `);
    v4Db.prepare(
      "INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)",
    ).run("sess-ttft", 1000);
    v4Db.prepare(
      "INSERT INTO agent_runs (run_id, session_id, started_unix_ms) VALUES (?, ?, ?)",
    ).run("run-ttft", "sess-ttft", 1000);
    v4Db.prepare(
      "INSERT INTO turns (turn_id, run_id, session_id, turn_index, started_unix_ms) VALUES (?, ?, ?, ?, ?)",
    ).run("turn-ttft", "run-ttft", "sess-ttft", 0, 1000);
    v4Db.prepare(
      "INSERT INTO llm_requests (request_id, session_id, started_unix_ms, ttft_ms, stream_ms) VALUES (?, ?, ?, ?, ?)",
    ).run("req-synthetic-zero", "sess-ttft", 1000, 0, 1500);
    v4Db.prepare(
      "INSERT INTO llm_requests (request_id, session_id, started_unix_ms, ttft_ms, stream_ms) VALUES (?, ?, ?, ?, ?)",
    ).run("req-degenerate-zero", "sess-ttft", 1000, 0, null);
    v4Db.prepare(
      "INSERT INTO llm_requests (request_id, session_id, started_unix_ms, ttft_ms, stream_ms) VALUES (?, ?, ?, ?, ?)",
    ).run("req-positive", "sess-ttft", 1000, 42, 1500);
    v4Db.close();

    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.strictEqual(version.user_version, MIGRATIONS.length);

    const rows = db
      .prepare("SELECT request_id, ttft_ms, stream_ms FROM llm_requests ORDER BY request_id")
      .all() as Array<{ request_id: string; ttft_ms: number | null; stream_ms: number | null }>;

    const synthetic = rows.find((r) => r.request_id === "req-synthetic-zero");
    const degenerate = rows.find((r) => r.request_id === "req-degenerate-zero");
    const positive = rows.find((r) => r.request_id === "req-positive");

    assert.strictEqual(synthetic?.ttft_ms, null, "synthetic zero ttft_ms should be nulled");
    assert.strictEqual(degenerate?.ttft_ms, null, "degenerate zero ttft_ms should be nulled");
    assert.strictEqual(positive?.ttft_ms, 42, "positive ttft_ms should be preserved");

    const zeroCount = db
      .prepare("SELECT COUNT(*) AS c FROM llm_requests WHERE ttft_ms = 0")
      .get() as { c: number };
    assert.strictEqual(zeroCount.c, 0, "no ttft_ms=0 rows should remain");
    db.close();
  });

  it("migrates a fresh v0 database to v5 and nulling migration is a no-op on empty llm_requests", () => {
    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.strictEqual(version.user_version, MIGRATIONS.length);
    const zeroCount = db
      .prepare("SELECT COUNT(*) AS c FROM llm_requests WHERE ttft_ms = 0")
      .get() as { c: number };
    assert.strictEqual(zeroCount.c, 0);
    db.close();
  });

  it("does not re-run the v5 ttft_ms nulling migration on an already v5 database", () => {
    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath);
    const versionBefore = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.strictEqual(versionBefore.user_version, MIGRATIONS.length);

    // Simulate a future row that somehow has ttft_ms=0. The migration must
    // NOT re-run on an already-migrated DB, so this row stays 0.
    db.prepare(
      "INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)",
    ).run("sess-reopen", 1000);
    db.prepare(
      "INSERT INTO agent_runs (run_id, session_id, started_unix_ms) VALUES (?, ?, ?)",
    ).run("run-reopen", "sess-reopen", 1000);
    db.prepare(
      "INSERT INTO turns (turn_id, run_id, session_id, turn_index, started_unix_ms) VALUES (?, ?, ?, ?, ?)",
    ).run("turn-reopen", "run-reopen", "sess-reopen", 0, 1000);
    db.prepare(
      "INSERT INTO llm_requests (request_id, session_id, started_unix_ms, ttft_ms, stream_ms) VALUES (?, ?, ?, ?, ?)",
    ).run("req-reopen-zero", "sess-reopen", 1000, 0, 1500);
    db.close();

    openDatabase(dbPath);
    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    const row = db2
      .prepare("SELECT ttft_ms FROM llm_requests WHERE request_id = ?")
      .get("req-reopen-zero") as { ttft_ms: number | null };
    assert.strictEqual(row.ttft_ms, 0, "v5 migration must not re-run");
    db2.close();
  });

  it("migrates an existing v5 database to v6 by adding nullable attempt column", () => {
    const v5Db = new DatabaseSync(dbPath);
    v5Db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id), started_unix_ms INTEGER NOT NULL);
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(run_id), session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, started_unix_ms INTEGER NOT NULL);
      CREATE TABLE llm_requests (
        request_id        TEXT PRIMARY KEY,
        turn_id           TEXT REFERENCES turns(turn_id),
        run_id            TEXT,
        session_id        TEXT NOT NULL,
        provider          TEXT,
        model             TEXT,
        started_unix_ms   INTEGER NOT NULL,
        ttft_ms           INTEGER,
        stream_ms         INTEGER,
        duration_ms       INTEGER,
        input_tokens      INTEGER,
        output_tokens     INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_total_usd    REAL,
        stop_reason       TEXT,
        http_status       INTEGER,
        retry_after_ms    INTEGER
      );
      CREATE INDEX idx_llm_session ON llm_requests(session_id);
      CREATE INDEX idx_llm_model ON llm_requests(model);
      PRAGMA user_version = 5;
    `);
    v5Db.prepare(
      "INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)",
    ).run("sess-v5", 1000);
    v5Db.prepare(
      "INSERT INTO agent_runs (run_id, session_id, started_unix_ms) VALUES (?, ?, ?)",
    ).run("run-v5", "sess-v5", 1000);
    v5Db.prepare(
      "INSERT INTO turns (turn_id, run_id, session_id, turn_index, started_unix_ms) VALUES (?, ?, ?, ?, ?)",
    ).run("turn-v5", "run-v5", "sess-v5", 0, 1000);
    v5Db.prepare(
      "INSERT INTO llm_requests (request_id, turn_id, session_id, started_unix_ms, stop_reason, http_status) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("req-v5", "turn-v5", "sess-v5", 1000, "error", 429);
    v5Db.close();

    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.strictEqual(version.user_version, MIGRATIONS.length);

    const columns = db
      .prepare("PRAGMA table_info(llm_requests)")
      .all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const attemptCol = columns.find((c) => c.name === "attempt");
    assert.ok(attemptCol, "attempt column must exist after v6 migration");
    assert.strictEqual(attemptCol.notnull, 0, "attempt must be nullable");

    const row = db
      .prepare("SELECT attempt, stop_reason, http_status FROM llm_requests WHERE request_id = ?")
      .get("req-v5") as { attempt: number | null; stop_reason: string; http_status: number };
    assert.strictEqual(row.attempt, null, "legacy rows must remain attempt = NULL");
    assert.strictEqual(row.stop_reason, "error");
    assert.strictEqual(row.http_status, 429);
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
