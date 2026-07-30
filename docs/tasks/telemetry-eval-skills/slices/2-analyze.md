---
kind: slice
slug: analyze
title: "telemetry-eval-analyze skill + schema primer"
task: ../task.md
mode: afk
status: todo
size: m
blocked_by: [setup]
started_at:
completed_at:
---

# telemetry-eval-analyze skill + schema primer

Author the `telemetry-eval-analyze` skill at
`skills/telemetry-eval-analyze/SKILL.md` plus its `resources/` (schema
primer + example eval script). The skill instructs the LLM to use the
`~/.pi/telemetry-eval/` project to write read-only eval scripts against
`~/.pi/telemetry.db`, loading rows into pandas DataFrames via the shared
helpers.

## Scope

- **`skills/telemetry-eval-analyze/SKILL.md`** — frontmatter `name:
  telemetry-eval-analyze` + one-line `description`. Body:
  - **Preflight:** if `~/.pi/telemetry-eval/` is missing (no
    `pyproject.toml` *and* no `requirements.txt`), stop and point the user
    to `/skill:telemetry-eval-setup`. Do not attempt to create the project.
  - Instruct using `from telemetry_eval import connect, duck` (never
    hand-roll the read-only URI / path logic).
  - Canonical pandas pattern: `pd.read_sql_query(sql, con=connect())`.
  - Delegates the schema reference to `resources/schema.md` via
    `follow resource "resources/schema.md"`.
  - **Script layout:** long-held named evals →
    `~/.pi/telemetry-eval/scripts/`; one-offs → ad-hoc root files or
    `uv run python -c "..."` (or `.venv/bin/python ...` no-uv). Run via
    `uv run python scripts/<name>.py`.
- **`resources/schema.md`** — the 10-table primer, covering each table's
  PK, foreign/join keys, key columns, and the `unix_ms` (INTEGER
  milliseconds) timestamp convention:
  - `sessions` (session_id PK; parent_session_id/run_id; agent_label;
    depth; name; cwd; pi/ext version; start/end reason; started/ended).
  - `agent_runs` (run_id PK; session_id FK; started/duration_ms; prompt &
    system_prompt chars; message_count; outcome).
  - `turns` (turn_id PK; run_id/session_id; turn_index; provider/model;
    token buckets input/output/cache_read/cache_write/total; per-bucket
    cost_usd + cost_total_usd; stop_reason; tool_result_count;
    context_tokens_at_start; indexed session_id, model).
  - `llm_requests` (request_id PK; turn_id FK; provider/model; ttft_ms;
    stream_ms; duration_ms; tokens; cost_total_usd; http_status;
    retry_after; indexed session_id, model).
  - `tool_executions` (tool_call_id PK; turn/run/session; tool_name;
    duration_ms; is_error; error_class; args/result chars+hash; full
    args_json/result_text only if capture flags on; indexed session_id,
    tool_name).
  - `bash_executions` (bash_id PK; session_id; cwd; exit_code; cancelled;
    truncated; output_chars; exclude_from_context; command_chars/hash).
  - `session_events` (event_id PK; session_id; type; payload JSON TEXT).
  - `feedback` (feedback_id PK; session/run/turn; source; kind; data
    JSON; indexed kind, source, time).
  - `telemetry_meta` (autoincrement log; level; event; detail; session_id).
  - `flush_log` (flush timing/row_count per tx).
  - Join map: `sessions` 1—* `agent_runs` 1—* `turns` 1—*
    `llm_requests`; `turns` 1—* `tool_executions`; `sessions` 1—*
    `bash_executions` / `session_events` / `feedback`.
- **`resources/scripts/example_cost_by_model.py`** — example eval: groups
    `turns` by `model`, sums `cost_total_usd` and token buckets, returns a
    pandas DataFrame sorted by total cost desc; uses `connect()`.

## Acceptance criteria

- With the project present (from the `setup` slice), following the skill
  writes an eval script that imports `telemetry_eval` and returns a
  **non-empty** pandas DataFrame from the live DB — verified by
  `scripts/example_cost_by_model.py` running clean via
  `uv run python scripts/example_cost_by_model.py` (or `.venv/bin/python`
  no-uv) and printing rows.
- The example script opens the DB **read-only** (uses `connect()`, not a
  bare `sqlite3.connect`).
- With the project **absent**, the skill stops and emits a pointer to
  `/skill:telemetry-eval-setup` (does not create the project itself).
- `resources/schema.md` documents all 10 tables, their join keys, and the
  `unix_ms` convention; a reader can write a JOIN across
  sessions→agent_runs→turns→llm_requests from it alone.

## Testing strategy

- **Layers:** `skills/telemetry-eval-analyze/SKILL.md` +
  `resources/schema.md` + `resources/scripts/example_cost_by_model.py`.
- **Failure modes:** (1) project missing → skill points to setup instead
  of failing opaquely; (2) a script that hand-rolls a read-write
  connection is a usage error the skill's examples steer away from.
- **Key scenarios:** run `example_cost_by_model.py` against the live DB
  → non-empty DataFrame; run a one-off via `uv run python -c` using
  `connect()` → rows.
- **Edge cases:** empty DB (no sessions yet) → DataFrame is empty but the
  script exits 0 (no crash); DB path overridden via
  `PI_TELEMETRY_DB_PATH` → example still reads the right DB (proves
  `resolve_db_path` is used, not a hardcoded path).
