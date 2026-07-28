# pi-telemetry — Specification

Local-first observability for Pi workflows. A single Pi extension that captures
session/agent/turn/LLM/tool telemetry into **one centralized SQLite database**
on the local filesystem. No servers, no collectors, no dashboards — SQL is the
query language, CSV export is the interchange format, and Pi itself is a query
client via commands and an agent-facing tool.

- **Storage engine:** SQLite via `node:sqlite` (`DatabaseSync`) — zero npm dependencies.
- **Central store:** `~/.pi/telemetry.db` (WAL mode), shared by all Pi processes on the machine.
- **Privacy posture:** no content by default. Lengths + SHA-256 hashes only. Content capture
  flags exist but ship disabled.

---

## §1 Measurement catalog

Principle: **store facts, not aggregates.** One row per completed operation;
all rates/durations/percentiles/cost-sums are derived at query time.

Conventions: timestamps as ISO-8601 UTC text plus `*_unix_ms` integers;
durations in ms; token counts INTEGER; costs REAL USD. IDs are UUIDs generated
in-process. `session_id` correlates nearly all tables.

### 1.1 Sessions

Source events: `session_start`, `session_shutdown`, `session_info_changed`.

| Field | Source | Notes |
|---|---|---|
| session_id | `ctx.sessionManager.getSessionId()` | primary correlation key |
| started_at / ended_at | start/shutdown | `ended_at NULL` ⇒ crashed or running |
| start_reason / end_reason | `event.reason` | startup/new/resume/fork/reload vs quit/new/resume/fork/reload |
| name | `session_info_changed` (`/name`) | nullable, updated in place |
| cwd, pi_version, ext_version | `ctx.cwd`, env | slicing dimensions |
| parent_session_id, parent_run_id, agent_label, depth | env vars at startup | §4 lineage; NULL for interactive roots |

### 1.2 Agent runs

Source events: `agent_start`, `agent_end`, `agent_settled`, `before_agent_start`.

run_id, session_id, started_at, duration_ms, prompt_chars, system_prompt_chars
(`before_agent_start`, lengths only), message_count (`agent_end` messages),
outcome (`agent_end` vs `agent_settled` distinction).

### 1.3 Turns

Source events: `turn_start`, `turn_end`.

turn_id, run_id, turn_index, started_at, duration_ms, provider, model,
input/output/cache_read/cache_write/total_tokens (assistant `usage`),
cost_input/output/cache_read/cache_write/total (`usage.cost`), stop_reason,
tool_result_count, **context_tokens_at_start** (`ctx.getContextUsage()` sampled
at `turn_start` — context-pressure trend; decided: include).

### 1.4 LLM requests

Source events: `message_start` / `message_update` / `message_end` (assistant),
`after_provider_response`.

request_id, turn_id, provider, model, full usage + cost breakdown, stop_reason,
**ttft_ms** (message_start → first message_update), **stream_duration_ms**
(first update → message_end), duration_ms (decided: include streaming metrics —
primary motivation for the extension), http_status, retry_after_ms
(`after_provider_response`; 429 visibility).

### 1.5 Tool executions

Source events: `tool_execution_start`, `tool_execution_end`, `tool_result`.

tool_call_id, turn_id, tool_name, started_at, duration_ms, is_error,
error_class (bounded category, not message), args_chars, result_chars,
result_hash. Optional `args_json` / `result_text` columns populated only when
capture flags enabled (default off).

### 1.6 User bash (`!` / `!!`)

Source: `user_bash`, wrapping `createLocalBashOperations()` to time execution.

bash_id, session_id, cwd, started_at, duration_ms, exit_code, cancelled,
truncated, output_chars, exclude_from_context, command_chars, command_hash.
**Decided: no command content in v1 — length + SHA-256 only.**

### 1.7 Session-shape events

Source events: `session_before_compact`/`session_compact`, `model_select`,
`thinking_level_select`, `session_before_fork`, `session_tree`.

One generic `session_events` table (type + JSON payload), not four tables:

- `compaction`: reason (manual/threshold/overflow), tokens_before, will_retry, from_extension
- `model_change`: from→to model, source (set/cycle/restore)
- `thinking_change`: from→to level
- `branch` / `tree_nav`: entry ids, position, new/old leaf ids

### 1.8 Feedback

See §5. Rows: source plugin, sender-defined kind, arbitrary payload,
plus full session/run/turn context at receipt time.

### 1.9 Extension self-health

`telemetry_meta` table: handler errors, DB write failures, buffer drops,
SQLITE_BUSY retry counts, feedback validation rejections. The rows that tell
you the telemetry itself is lying.

### Not measured by default

Prompt text, tool args/results, bash commands, file paths → lengths + hashes
only. Opt-in capture flags (§7) with a redaction pass, same posture as ObservMe.

### Derived metrics (named, tested queries — not stored)

Cost/tokens per day/model/session; cache-hit ratio; tool failure rates;
turn-latency percentiles; context-growth curves; 429 frequency; agent tree
depth/width/fan-out; TTFT percentiles per model. Ships as canned SQL (§6).

---

## §2 Schema

```sql
-- Applied idempotently at every process startup. Migrations via PRAGMA user_version (§8).

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
  outcome             TEXT            -- 'end' | 'settled' | 'interrupted'
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
  args_json    TEXT,             -- NULL unless capture.toolArgs
  result_text  TEXT              -- NULL unless capture.toolResults
);
CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_name    ON tool_executions(tool_name);

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
  command_hash      TEXT         -- SHA-256, never content
);

CREATE TABLE IF NOT EXISTS session_events (
  event_id      TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  unix_ms       INTEGER NOT NULL,
  type          TEXT NOT NULL,   -- compaction|model_change|thinking_change|branch|tree_nav
  payload       TEXT NOT NULL    -- JSON
);
CREATE INDEX IF NOT EXISTS idx_sev_session ON session_events(session_id);

CREATE TABLE IF NOT EXISTS feedback (
  feedback_id      TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  run_id           TEXT,
  turn_index       INTEGER,
  received_unix_ms INTEGER NOT NULL,
  source           TEXT NOT NULL,  -- emitting plugin name, or 'pi' (§5)
  kind             TEXT NOT NULL,  -- sender-defined enum string
  data             TEXT NOT NULL   -- JSON text or plain string
);
CREATE INDEX IF NOT EXISTS idx_feedback_kind   ON feedback(kind);
CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
CREATE INDEX IF NOT EXISTS idx_feedback_time   ON feedback(received_unix_ms);

CREATE TABLE IF NOT EXISTS telemetry_meta (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  unix_ms INTEGER NOT NULL,
  level   TEXT NOT NULL,           -- warn | error
  event   TEXT NOT NULL,           -- write_failed|busy_retry|feedback_rejected|handler_error|buffer_drop
  detail  TEXT
);
```

---

## §3 Write path

- **Connection:** one `DatabaseSync` per process, opened lazily at `session_start`
  on the central path (`~/.pi/telemetry.db`, configurable). Closed at
  `session_shutdown`.
- **Pragmas at open:** `journal_mode=WAL`, `synchronous=NORMAL`,
  `busy_timeout=5000`, `foreign_keys=ON`.
- **Schema init:** idempotent DDL above, every startup. First process creates,
  rest no-op. Migrations gated by `PRAGMA user_version` (§8).
- **Ownership rule:** a process only writes rows keyed by its own session/run
  IDs. Completed operations are INSERT-once (the handler has duration/usage at
  the end event). The only UPDATE is the owning process closing its own
  `sessions`/`agent_runs` row. No cross-process row mutation, ever.
- **Batching:** handlers append rows to an in-memory buffer; flush in a single
  `BEGIN…COMMIT` when either `bufferFlushMs` (default 2000) elapses or
  `bufferMaxRows` (default 50) is reached. Crash loses ≤2s of telemetry —
  acceptable. Flush is synchronous (`DatabaseSync`), microseconds per batch.
  Measured headroom on target hardware: ~42k commits/s aggregate with 100
  concurrent writer processes; expected peak load ~100 commits/s.
- **Failure handling:** any DB error → row to `telemetry_meta` (best-effort),
  handler swallows it. Telemetry must never break a Pi session. SQLITE_BUSY
  retries counted in `telemetry_meta` as `busy_retry`.
- **In-flight state:** per-operation timers live in memory only
  (turn timers, TTFT markers, tool start times, bash wrappers).

---

## §4 Lineage (subagent correlation)

Two complementary mechanisms:

1. **Env vars (cross-process).** A launcher spawning a child Pi process sets:
   `PI_TELEMETRY_PARENT_SESSION_ID`, `PI_TELEMETRY_PARENT_RUN_ID`,
   `PI_TELEMETRY_DEPTH`, `PI_TELEMETRY_AGENT_LABEL`. pi-telemetry reads them at
   startup and stamps its `sessions` row. Same propagation pattern as
   ObservMe's integration API. pi-telemetry also *exports* these vars for any
   children it learns about, and exposes a helper env block via
   `pi.events` for orchestrators that ask.
2. **Event bus (in-process).** pi-telemetry listens on
   `pi-telemetry:agent.spawned` / `pi-telemetry:agent.completed` for
   orchestrators that run children in-process (payload: run ids, label,
   depth). Documented payload shape is the only contract; no dependency either
   direction.

Note: pi-subagents does not emit bus events today; a small shim extension (or
upstream contribution) is phase 2. Phase 1 works without lineage — rows still
centralize, `parent_*` columns stay NULL.

---

## §5 Feedback collector

Generic structured-feedback intake, replacing the OTLP-based
`submit_workflow_feedback` pipeline with local storage.

### 5.1 Inbound bus event

```typescript
pi.events.emit("pi-telemetry:submit-feedback", {
  source: "submitting-plugin-name",
  kind:   "some-sender-plugin-internal-kind-enum",
  data:   { some: "object" },   // or string
});
```

- pi-telemetry subscribes at load; emit with pi-telemetry absent is a no-op —
  producers never depend on it.
- Validation (defensive; `emit` is fire-and-forget, senders get no return):
  `source` and `kind` must be non-empty strings; `data` serialized as-is
  (JSON for objects, raw for strings); serialized payload capped at
  `feedbackMaxBytes` (default 64 KiB). Violations → `telemetry_meta`
  (`feedback_rejected`), never a throw.
- Enrichment at receipt: session_id, run_id, turn_index, timestamp,
  and lineage (agent_label/depth) if present.
- Trust model: all locally installed extensions are trusted; `source` is
  self-declared, not verified. `pi` is reserved for the tool below by
  convention, not enforced.

### 5.2 Agent-facing tool

```typescript
pi.registerTool({
  name: "submit_feedback",
  description: "Record structured workflow feedback (quality signals, " +
               "friction points, review outcomes) to the local telemetry store.",
  parameters: Type.Object({
    kind: Type.String({ description: "Feedback category, e.g. 'good', 'bad', 'architecture'" }),
    data: Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())]),
  }),
  // execute: insert feedback row with source = "pi"
});
```

The tool exposes exactly `kind` and `data`; `source` is forced to `"pi"`.
Same validation/cap as the bus path.

### 5.3 Retrieval

- `/telemetry feedback [--kind K] [--source S] [--since 7d]` command.
- `query_telemetry` (§6.2) named query `feedback` with kind/source/time filters.

---

## §6 Query surface

### 6.1 Commands (human-facing)

`/telemetry` (alias `/tm`) subcommands:

| Command | Output |
|---|---|
| `status` | DB path, size, row counts, buffer state, last meta errors |
| `session` | Current session: turns, cost, tool calls, duration, lineage |
| `cost [today\|week\|all]` | Cost/tokens grouped by model, then day |
| `errors [--since]` | Failed tools, non-2xx LLM statuses, meta errors |
| `feedback [--kind] [--source] [--since]` | Feedback rows, newest first |
| `tree` | Agent lineage tree for current session family |
| `export [--table T] [--from] [--to] [--out file.csv]` | CSV dump (all tables default) |
| `sql "SELECT …"` | Read-only passthrough (SELECT-only guard, statement timeout) |

### 6.2 Agent-facing query tool

`query_telemetry` with `query` (named preset: `session_cost`, `daily_cost`,
`tool_failures`, `feedback`, `ttft_by_model`, `context_growth`, `agent_tree`)
plus filter params; or `sql` for read-only SELECT with the same guard.
Lets the agent answer "what did today cost?" or "which tool fails most?" itself.

### 6.3 External

`sqlite3 ~/.pi/telemetry.db`, DuckDB, pandas — the DB is the API.

---

## §7 Configuration & privacy

Config via `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global)
under `pi-telemetry`, env-var overrides:

| Key | Default | Notes |
|---|---|---|
| `enabled` | true | |
| `dbPath` | `~/.pi/telemetry.db` | must be a local filesystem (no NFS) |
| `bufferFlushMs` | 2000 | |
| `bufferMaxRows` | 50 | |
| `feedbackMaxBytes` | 65536 | |
| `capture.toolArgs` / `capture.toolResults` | false | redaction pass planned before enabling |
| `capture.bashCommand` | false | v1 records hash only; flag reserved |

Privacy defaults: no prompts, no tool content, no command text, no file paths
(lengths/hashes). Content flags ship disabled; enabling shows a one-time
warning.

---

## §8 Migrations & lifecycle

- `PRAGMA user_version` gates forward-only migrations; each migration is a
  numbered, idempotent step in code. No external migration tool.
- Extension version stored in every session row for schema-correlation
  debugging.
- Multi-version coexistence: producers only INSERT; new columns are nullable or
  have defaults; older extensions keep writing against newer schemas.

---

## §9 Testing

- **Unit:** handler → row mapping against in-memory `node:sqlite` with a fake
  Pi event harness (simulated `turn_start`/`turn_end` payloads etc.).
- **Concurrency:** multi-process writer soak test (basis: measured 42k
  commits/s, 0 busy errors, 100 writers on target hardware) as a gated
  regression test.
- **Bus:** emit `pi-telemetry:submit-feedback` without a listener (no-op),
  with listener (row appears), malformed payload (meta row, no throw).
- **Privacy:** default-config run asserts zero content strings in all tables.

---

## §10 Non-goals

Live dashboards, alerting/SLOs, multi-host aggregation, real-time streaming,
content-first capture, Prometheus/OTLP export (a future `otlp-export` sidecar
extension could read the same DB if ever needed — the DB is the source of
truth, not the wire).
