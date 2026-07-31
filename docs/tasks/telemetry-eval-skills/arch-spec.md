# Architecture spec — telemetry-eval-skills

Shared across both slice chains. Grounded in `src/config.ts`, `src/db.ts`,
`index.ts`, and a live spike against `~/.pi/telemetry.db` on this NixOS box
(Python 3.13.14).

## Resolved decisions (user-approved)

1. **DB path precedence — follow the doc text.** `resolve_db_path()` uses:
   `PI_TELEMETRY_DB_PATH` env → `pi-telemetry.dbPath` in
   `~/.pi/agent/settings.json` (global) → `pi-telemetry.dbPath` in
   `<cwd>/.pi/settings.json` (project) → default `~/.pi/telemetry.db`.

   > Note: `src/config.ts` `loadMergedSettings` actually merges
   > `{...global, ...project}` so the live process resolves project→global
   > (project wins). The task/idea doc states global→project. The user
   > chose to follow the doc text, so the Python helper deliberately uses
   > global→project. This is a sanctioned deviation from the TS behavior;
   > recorded here so the deviation-reporter does not flag it as a defect.

2. **Verification — real, against the live DB, on Python 3.13.** The user
   swapped the system Python from 3.15.0b4 to 3.13.14. Spike confirmed:
   pandas/matplotlib/numpy/duckdb install from cp313 wheels (no compiler
   needed); the sqlite read-only URI blocks writes; the duckdb
   `ATTACH '<path>' AS tel (TYPE sqlite, READ_ONLY)` works on NixOS and
   blocks writes; `pd.read_sql_query(sql, con=connect())` returns rows.

## Shared facts

- **Resource-template pattern** (mirrors `implement-task`'s
  `resources/feature.md`): skills ship exact files under `resources/` and
  write them verbatim into `~/.pi/telemetry-eval/` via
  `follow resource "resources/..."`. Never reinvent per run.
- **Read-only, always.** sqlite3 via `file:<path>?mode=ro` URI (WAL-aware,
  sees latest committed rows; any write/DDL raises). duckdb via
  `INSTALL sqlite; LOAD sqlite; ATTACH '<path>' AS tel (TYPE sqlite,
  READ_ONLY)`. Derived/scratch data writes to a *separate* file
  (`~/.pi/telemetry-eval/scratch.db`), never the live DB.
- **NixOS rule.** Never `uv python install` (python-build-standalone won't
  run on NixOS — no FHS `ld-linux`). Detect NixOS via `/etc/NIXOS` or
  non-empty `$NIX_OS`. On NixOS use a *system* interpreter:
  `uv venv --python "$(command -v python3.13 || command -v python3.12 ||
  command -v python3)"`. The setup skill gates on a **stable** system
  Python; if only a beta/unstable python is found, it instructs the user to
  install a stable one (`nix profile install nixpkgs#python313`) and stops.
- **Schema source of truth:** `src/db.ts` (10 tables). Corrections vs the
  idea doc's summary, captured for `resources/schema.md`:
  - `llm_requests.retry_after_ms` (idea doc said `retry_after`).
  - `turns` has `started_unix_ms` + `duration_ms`.
  - `session_events.unix_ms`; `feedback.received_unix_ms`.
  - `flush_log` has `unix_ms` + `row_count` + `tx_duration_ms`.

## Slice 1 — `setup` (size s, no deps)

### Exports (files authored)
- `skills/telemetry-eval-setup/SKILL.md` — frontmatter `name:
  telemetry-eval-setup` + one-line `description`. Body: idempotent (if
  `~/.pi/telemetry-eval/` exists and is healthy → refresh deps via
  `uv sync` / `pip install -r requirements.txt` and stop; do not overwrite
  user scripts); else create the dir and populate from templates via
  `follow resource "resources/..."`. NixOS-safe interpreter resolution;
  no-uv fallback.
- `resources/telemetry_eval/__init__.py` — exports the helpers below.
- `resources/pyproject.toml` — `requires-python = ">=3.12"`, deps
  `pandas`, `matplotlib`, `numpy`, `duckdb`; `telemetry_eval` package.
- `resources/requirements.txt` — same four deps, compatible pinned ranges.
- `resources/scripts/smoke_test.py` — acceptance smoke test.

### Interface contract (consumed by slice 2)
```python
resolve_db_path() -> str
    # env -> ~/.pi/agent/settings.json (global) -> <cwd>/.pi/settings.json
    # (project) -> ~/.pi/telemetry.db   [global→project, per decision 1]
    # Raises a clear error if the resolved DB file does not exist;
    # never creates the DB.

connect() -> sqlite3.Connection
    # sqlite3.connect("file:<path>?mode=ro", uri=True); WAL-aware, sees
    # latest committed rows; any write/DDL raises.

duck() -> duckdb.DuckDBPyConnection
    # duckdb.connect(); INSTALL sqlite; LOAD sqlite;
    # ATTACH '<path>' AS tel (TYPE sqlite, READ_ONLY). Writes to tel.* raise.

scratch(path="scratch.db") -> sqlite3.Connection
    # read-write connection to a separate file under the project
    # (~/.pi/telemetry-eval/scratch.db by default); never the live DB.
```

### Existing abstractions to use
Mirror `src/config.ts` *path-resolution structure* (env → settings →
default, with `expandPath` for `~/`) and the read-only discipline of
`src/query/sql-guard.ts` (`readOnly: true`).

### Do NOT reimplement
- The read-only URI / path-resolution logic lives **only** in
  `telemetry_eval/__init__.py`. The smoke test imports it; never hand-rolls
  URIs or paths.
- Do not author the `telemetry-eval-analyze` skill or `schema.md` here
  (that's slice 2).

## Slice 2 — `analyze` (size m, blocked_by [setup])

### Exports (files authored)
- `skills/telemetry-eval-analyze/SKILL.md` — frontmatter `name:
  telemetry-eval-analyze` + one-line `description`. Body:
  - **Preflight:** if `~/.pi/telemetry-eval/` is missing (no
    `pyproject.toml` *and* no `requirements.txt`), stop and point the user
    to `/skill:telemetry-eval-setup`. Do not create the project.
  - Use `from telemetry_eval import connect, duck` (never hand-roll the
    read-only URI / path logic).
  - Canonical pandas pattern: `pd.read_sql_query(sql, con=connect())`.
  - Delegate schema reference: `follow resource "resources/schema.md"`.
  - Script layout: long-held named evals →
    `~/.pi/telemetry-eval/scripts/`; one-offs → ad-hoc root files or
    `uv run python -c "..."` (`.venv/bin/python ...` no-uv). Run via
    `uv run python scripts/<name>.py`.
- `resources/schema.md` — the 10-table primer (each table's PK, FKs/join
  keys, key columns) + join map (sessions 1—* agent_runs 1—* turns 1—*
  llm_requests; turns 1—* tool_executions; sessions 1—* bash_executions /
  session_events / feedback) + the `unix_ms` (INTEGER milliseconds)
  convention.
- `resources/scripts/example_cost_by_model.py` — example eval.

### Existing abstractions to use
`from telemetry_eval import connect, duck` (from slice 1). The example
script uses `connect()` (read-only), groups `turns` by `model`, sums
`cost_total_usd` and the token buckets, returns a pandas DataFrame sorted
by total cost desc. Must return a **non-empty** DataFrame on the live DB
(verified: 4 models present).

### Do NOT reimplement
- No path/URI logic — always via `telemetry_eval`.
- No schema hardcoding in scripts — the schema lives in `schema.md`; scripts
  write SQL, the skill points readers at the primer.
