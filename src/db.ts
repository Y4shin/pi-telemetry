import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  parent_session_id TEXT,
  parent_run_id     TEXT,
  agent_label       TEXT,
  depth             INTEGER,
  name              TEXT,
  cwd               TEXT,
  pi_version        TEXT,
  ext_version       TEXT,
  start_reason      TEXT,
  end_reason        TEXT,
  started_unix_ms   INTEGER NOT NULL,
  ended_unix_ms     INTEGER
);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id              TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  started_unix_ms     INTEGER NOT NULL,
  duration_ms         INTEGER,
  prompt_chars        INTEGER,
  system_prompt_chars INTEGER,
  message_count       INTEGER,
  outcome             TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  turn_id                 TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES agent_runs(run_id),
  session_id              TEXT NOT NULL,
  turn_index              INTEGER NOT NULL,
  started_unix_ms         INTEGER NOT NULL,
  duration_ms             INTEGER,
  provider                TEXT,
  model                   TEXT,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  cache_read_tokens       INTEGER,
  cache_write_tokens      INTEGER,
  total_tokens            INTEGER,
  cost_input_usd          REAL,
  cost_output_usd         REAL,
  cost_cache_read_usd     REAL,
  cost_cache_write_usd    REAL,
  cost_total_usd          REAL,
  stop_reason             TEXT,
  tool_result_count       INTEGER,
  context_tokens_at_start INTEGER
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_model   ON turns(model);

CREATE TABLE IF NOT EXISTS llm_requests (
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
CREATE INDEX IF NOT EXISTS idx_llm_session ON llm_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_llm_model   ON llm_requests(model);

CREATE TABLE IF NOT EXISTS tool_executions (
  tool_call_id TEXT PRIMARY KEY,
  turn_id      TEXT,
  run_id       TEXT,
  session_id   TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  started_unix_ms INTEGER NOT NULL,
  duration_ms  INTEGER,
  is_error     INTEGER,
  error_class  TEXT,
  args_chars   INTEGER,
  result_chars INTEGER,
  result_hash  TEXT,
  args_json    TEXT,
  result_text  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_name    ON tool_executions(tool_name);

-- DEPRECATED (task: deprecate-bash-executions): The bash_executions table is
-- no longer written or read by current code. It is retained here for backward
-- compatibility with older in-flight extension versions that may still INSERT
-- into it at startup. A later task may drop this DDL once all running agents
-- have upgraded past the bash_executions usage.

CREATE TABLE IF NOT EXISTS bash_executions (
  bash_id           TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  cwd               TEXT,
  started_unix_ms   INTEGER NOT NULL,
  duration_ms       INTEGER,
  exit_code         INTEGER,
  cancelled         INTEGER,
  truncated         INTEGER,
  output_chars      INTEGER,
  exclude_from_context INTEGER,
  command_chars     INTEGER,
  command_hash      TEXT
);

CREATE TABLE IF NOT EXISTS session_events (
  event_id      TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  unix_ms       INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sev_session ON session_events(session_id);

CREATE TABLE IF NOT EXISTS feedback (
  feedback_id      TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  run_id           TEXT,
  turn_index       INTEGER,
  received_unix_ms INTEGER NOT NULL,
  source           TEXT NOT NULL,
  kind             TEXT NOT NULL,
  data             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_kind   ON feedback(kind);
CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
CREATE INDEX IF NOT EXISTS idx_feedback_time   ON feedback(received_unix_ms);

CREATE TABLE IF NOT EXISTS telemetry_meta (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  unix_ms    INTEGER NOT NULL,
  level      TEXT NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS flush_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  unix_ms        INTEGER NOT NULL,
  session_id     TEXT,
  row_count      INTEGER NOT NULL,
  tx_duration_ms INTEGER NOT NULL
);
`;

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "initial schema",
    sql: SCHEMA,
  },
  {
    version: 2,
    description: "add flush_log",
    sql: `CREATE TABLE IF NOT EXISTS flush_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  unix_ms        INTEGER NOT NULL,
  session_id     TEXT,
  row_count      INTEGER NOT NULL,
  tx_duration_ms INTEGER NOT NULL
);`,
  },
  {
    version: 3,
    description: "add session_event_metadata and turns run index",
    sql: `CREATE TABLE IF NOT EXISTS session_event_metadata (
  event_id   TEXT NOT NULL REFERENCES session_events(event_id),
  key        TEXT NOT NULL,
  type       TEXT NOT NULL,
  value_text TEXT,
  value_int  INTEGER,
  value_real REAL,
  value_bool INTEGER,
  PRIMARY KEY (event_id, key),
  CHECK (
       (type = 'string' AND value_text IS NOT NULL AND value_int IS NULL AND value_real IS NULL AND value_bool IS NULL)
    OR (type = 'int'    AND value_int  IS NOT NULL AND value_text IS NULL AND value_real IS NULL AND value_bool IS NULL)
    OR (type = 'float'  AND value_real IS NOT NULL AND value_text IS NULL AND value_int  IS NULL AND value_bool IS NULL)
    OR (type = 'bool'   AND value_bool IS NOT NULL AND value_text IS NULL AND value_int  IS NULL AND value_real IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_sems_key_text ON session_event_metadata(key, value_text);
CREATE INDEX IF NOT EXISTS idx_sems_key_int  ON session_event_metadata(key, value_int);
CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id);`,
  },
];

function isBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("database is locked") || msg.includes("BUSY");
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const BUSY_RETRY_CAP_MS = 50 * Math.pow(2, 9);

export function busyBackoffDelayMs(
  attemptIndex: number,
  rng: () => number = Math.random,
): number {
  const bound = Math.min(BUSY_RETRY_CAP_MS, 50 * Math.pow(2, attemptIndex));
  return Math.floor(rng() * bound);
}

export interface OpenDatabaseOptions {
  rng?: () => number;
}

export function openDatabase(
  dbPath: string,
  options: OpenDatabaseOptions = {},
): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  const init = () => {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");

    const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (const migration of MIGRATIONS) {
      if (migration.version > current) {
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
    }
  };

  // Concurrent first-starts can race on the initial CREATE TABLE IF NOT EXISTS.
  // Retry with exponential backoff so that idempotent DDL survives the race.
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      init();
      return db;
    } catch (err) {
      if (!isBusyError(err) || attempt === maxAttempts) {
        throw err;
      }
      syncSleep(busyBackoffDelayMs(attempt - 1, options.rng));
    }
  }
  return db; // unreachable; satisfies TypeScript.
}
