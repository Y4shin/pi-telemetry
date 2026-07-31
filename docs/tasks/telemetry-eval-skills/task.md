---
kind: task
slug: telemetry-eval-skills
title: "Telemetry eval skills: python project + DB analysis"
description: |
  Two coupled skills authored at skills/<name>/SKILL.md in this repo (deployed later, manually, into ~/.pi/agent/git/codeberg.org/Yashin/skills/skills/<name>/). (1) telemetry-eval-setup creates a Python project at ~/.pi/telemetry-eval/ (uv -> pyproject.toml + uv.lock; else in-dir .venv + requirements.txt; deps pandas/matplotlib/numpy/duckdb; NixOS-safe interpreter resolution) and ships a telemetry_eval/ package with read-only connect()/duck() helpers. (2) telemetry-eval-analyze uses that project to write read-only eval scripts against ~/.pi/telemetry.db, embedding the 10-table schema primer and the pandas pattern; if the project is missing it points to the setup skill.
epic: null
slices:
- setup
- analyze
status: draft
started_at: null
completed_at: null
---

# Telemetry eval skills: python project + DB analysis

**Source of truth:** `docs/ideas/telemetry-eval-skills.md` (status `ready`,
all grilling decisions folded in). Where this doc and the idea disagree,
the idea's "Resolved design" section wins.

## Outcome

Two LLM-instruction skills that let the LLM (and the user) analyze
pi-telemetry data with proper Python tooling instead of ad-hoc one-liners:

1. **`telemetry-eval-setup`** — bootstraps `~/.pi/telemetry-eval/`, a Python
   project with the standard data-analysis deps, and a `telemetry_eval/`
   package whose `connect()`/`duck()` helpers encapsulate read-only access +
   DB-path resolution + NixOS-safe interpreter selection.
2. **`telemetry-eval-analyze`** — writes one-off or long-held eval scripts
   against `~/.pi/telemetry.db` using the project, embedding the 10-table
   schema primer and the canonical pandas pattern.

## User stories

- As a developer, I want the LLM to bootstrap a proper Python
  data-analysis environment for telemetry so I stop writing ad-hoc
  one-liners.
- As a developer, I want the LLM to write reproducible **read-only** eval
  scripts against the telemetry DB without risking the live WAL DB.
- As a developer, I want a shared `connect()` helper so every eval script
  resolves the DB path and opens read-only the same way — no boilerplate,
  no drift.

## Boundaries (out of scope)

- **Deployment** into `~/.pi/agent/git/codeberg.org/Yashin/skills/skills/<name>/`
  — manual, later. This task only *authors* the skills in this repo.
- **Extending the `query_telemetry` TS tool** — separate concern; untouched.
- **Building a query DSL / library** on top of the schema — helpers +
  examples only, no abstraction layer.
- **Windows support** — best-effort via the uv path; NixOS-safe logic
  targets Linux/macOS.
- **Notebooks** — scripts, not Jupyter (no ipython/jupyter deps).

## Layers / files

New files only; **no TS source touched.**

```
skills/
  telemetry-eval-setup/
    SKILL.md
    resources/
      telemetry_eval/__init__.py     # connect(), duck(), resolve_db_path()
      pyproject.toml                 # uv template (deps, requires-python)
      requirements.txt               # no-uv fallback (same deps)
      scripts/smoke_test.py          # acceptance smoke test
  telemetry-eval-analyze/
    SKILL.md
    resources/
      schema.md                      # 10-table primer + join keys + unix_ms
      scripts/example_cost_by_model.py
```

## Architecture notes (must follow)

- **Resource-template pattern.** Skills ship exact file templates under
  `resources/` and write them verbatim into `~/.pi/telemetry-eval/`, via
  `follow resource "resources/..."` (mirrors the existing `implement-task`
  skill's `resources/feature.md` pattern). The read-only URI + NixOS-safe +
  path-resolution logic must be exact, never reinvented per run.
- **DB path resolution** mirrors `src/config.ts` exactly:
  `PI_TELEMETRY_DB_PATH` env → `pi-telemetry.dbPath` in
  `~/.pi/agent/settings.json` → `<cwd>/.pi/settings.json` → default
  `~/.pi/telemetry.db`. (See `src/config.ts` lines ~107-110.)
- **Read-only, always.** sqlite3 via `file:<path>?mode=ro` URI (WAL-aware,
  sees latest committed rows; any write/DDL raises). duckdb via
  `ATTACH '<path>' AS tel (READ_ONLY)`. Derived/scratch data writes to a
  *separate* file (e.g. `~/.pi/telemetry-eval/scratch.db`), never the live
  DB — matches the `query_telemetry` tool's read-only discipline.
- **NixOS rule.** Never run `uv python install` (downloaded
  python-build-standalone binaries don't run on NixOS — no FHS `ld-linux`).
  Detect NixOS via `/etc/NIXOS` or `$NIX_OS`; on NixOS point uv at a
  *system* interpreter:
  `uv venv --python "$(command -v python3.13 || command -v python3)"`.
  Elsewhere, prefer Python 3.13 via `.python-version`. System `python3` is
  `3.15.0b4` (a beta) — prefer an installed stable system Python.
- **Shared helper.** `from telemetry_eval import connect` returns a
  read-only sqlite3 Connection; `duck()` returns a duckdb connection with
  the live DB attached read-only. Scripts use these, never hand-roll the
  URI/path logic.
- **Idempotent setup.** If `~/.pi/telemetry-eval/` already exists and is
  healthy, the setup skill refreshes deps (`uv sync` / `pip install -r`)
  rather than recreating.

## Slices

1. **`setup`** (S) — the `telemetry-eval-setup` skill + resource templates
   (`telemetry_eval/__init__.py`, `pyproject.toml`, `requirements.txt`,
   `scripts/smoke_test.py`).
2. **`analyze`** (M, `blocked_by: [setup]`) — the `telemetry-eval-analyze`
   skill + `resources/schema.md` primer + `scripts/example_cost_by_model.py`.

## Testing strategy

Per-slice acceptance via shipped scripts (objective & reproducible). **No
TS `test/` changes** — these are Python skills, not part of the TS project.

- **setup slice:** `scripts/smoke_test.py` exits 0 — imports
  `pandas`/`duckdb`/`telemetry_eval` clean; a read-only `SELECT` returns
  rows from the live DB; a write/DDL attempt raises (proving read-only).
- **analyze slice:** `scripts/example_cost_by_model.py` returns a non-empty
  pandas DataFrame (group turns by model, sum `cost_total_usd`).

Failure modes covered: missing project → analyze skill points to setup;
non-NixOS uv path vs NixOS system-interpreter path; read-only enforcement
on both sqlite3 and duckdb.

## Implementation notes

### setup — telemetry-eval-setup skill + telemetry_eval package (landed)

Landed 5 files under `skills/telemetry-eval-setup/`: `SKILL.md` +
resources `telemetry_eval/__init__.py`, `pyproject.toml`, `requirements.txt`,
`scripts/smoke_test.py`. Package contract exported by `telemetry_eval`:
`resolve_db_path() -> str` (never creates the DB; raises `FileNotFoundError`
with the resolved path + a hint if absent), `connect() -> sqlite3.Connection`
(`file:<path>?mode=ro`, uri=True; WAL-aware, sees latest committed rows; any
write/DDL raises), `duck() -> duckdb` connection (`INSTALL sqlite; LOAD sqlite;
ATTACH '<path>' AS tel (TYPE sqlite, READ_ONLY)`), `scratch(path="scratch.db")`
(rw connection to a *separate* file under `~/.pi/telemetry-eval/`, never the
live DB). DB-path precedence: `PI_TELEMETRY_DB_PATH` env (empty = unset) →
global `~/.pi/agent/settings.json` (`pi-telemetry.dbPath`) → project
`<cwd>/.pi/settings.json` → default `~/.pi/telemetry.db`; leading `~/` expanded.

**Sanctioned deviation (recorded, not a defect):** precedence is
**global→project**, the reverse of `src/config.ts`'s `loadMergedSettings`
(`{...global, ...project}` = project→global), per arch-spec decision 1 and the
idea text. Consequence: an eval script may resolve a different DB than the
live pi process when a project `settings.json` overrides the global one.
Approved trade-off.

Verified green on the target (uv) path: `scripts/smoke_test.py` exits 0
(imports `pandas`/`duckdb`/`telemetry_eval` clean; `connect()` `SELECT
count(*) FROM sessions` returns rows; a `CREATE TABLE` write raises;
`duck()` attaches ro and `SELECT * FROM tel.turns LIMIT 1` works); `npm test`
146/146; `npm run check` (`tsc --noEmit`) clean.

In-scope implementation choices (no new scope, recorded for the record):
- `[build-system] requires = ["setuptools>=61"]` + `[tool.setuptools]
  packages = ["telemetry_eval"]` added to `pyproject.toml` so `uv sync`
  installs the local `telemetry_eval` package into site-packages. Required
  because `uv run python scripts/x.py` (script-file mode) puts `scripts/`
  on `sys.path[0]`, **not** the project root — without the build-system,
  `import telemetry_eval` fails in that invocation mode.
- NixOS uses the **system** nix interpreter (never `uv python install`;
  stable-python gate, `python3.13 → python3.12 → python3` fallback). On the
  target NixOS box that interpreter needs `LD_LIBRARY_PATH` pointed at nix-ld
  (`NIX_LD_LIBRARY_PATH` else `/run/current-system/sw/share/nix-ld/lib`)
  for pip wheels (`numpy`/`duckdb`) to load `libstdc++.so.6`/`libz.so.1`;
  documented in `SKILL.md`.

**Known gap (medium, latent — not exercised on the target, which has uv):**
the **no-uv fallback path** (`pip install -r requirements.txt` +
`.venv/bin/python scripts/<name>.py`) installs only the four deps and does
NOT install the local `telemetry_eval` package, so `import telemetry_eval`
fails in that invocation mode (script-file mode → `scripts/` on `sys.path`,
project root not on path). Recommended fix before/within the `analyze` slice
or the coherence step: add `.venv/bin/pip install -e .` to the no-uv setup
section of `SKILL.md` (the `[build-system]` already supports editable
installs), or document `PYTHONPATH=.` / `python -m scripts.<name>` for that
path. Not a blocker for landing `setup` — the operative (uv) path is
verified green.

### analyze — telemetry-eval-analyze skill + schema primer (landed)

Landed 3 files under `skills/telemetry-eval-analyze/`: `SKILL.md` +
resources `schema.md` (10-table primer) + `scripts/example_cost_by_model.py`
(+284 lines, no other dirs touched). The skill consumes the setup package's
`connect()`/`duck()` helpers (never hand-rolls the read-only URI/path); the
canonical pandas pattern is `pd.read_sql_query(sql, con=connect())` with an
explicit `follow resource "resources/schema.md"`. **Preflight** stops and
points the user to `/skill:telemetry-eval-setup` when `~/.pi/telemetry-eval/`
is missing (`pyproject.toml` *and* `requirements.txt` both absent) — it does
not create the project. Read-only discipline documented: forbids bare
`sqlite3.connect` on the live DB; derived writes go through
`telemetry_eval.scratch()`. The NixOS `LD_LIBRARY_PATH`→nix-ld note is
carried over from the setup skill.

`resources/schema.md` documents all 10 tables (`sessions`, `agent_runs`,
`turns`, `llm_requests`, `tool_executions`, `bash_executions`,
`session_events`, `feedback`, `telemetry_meta`, `flush_log`) with PK,
FK/join keys, key columns, and the `unix_ms` (INTEGER ms) convention up
front; a join map and a worked `sessions→agent_runs→turns→llm_requests` JOIN
+ pandas-load example make that JOIN derivable from the primer alone. Column
names cross-checked against `src/db.ts` and match exactly (e.g.
`llm_requests.retry_after_ms`, `turns.started_unix_ms`+`duration_ms`,
`feedback.received_unix_ms`).

`example_cost_by_model.py` groups `turns` by `model`, sums
`cost_total_usd` (`SUM(cost_total_usd) AS cost_total_usd`,
`ORDER BY ... DESC`) and three token buckets (`input_tokens`,
`output_tokens`, `total_tokens`) into a pandas DataFrame via
`pd.read_sql_query(sql, con=connect())`; handles the empty-DB edge case
(`if df.empty: print(...); return 0` — exit 0, no crash). Uses `connect()`
read-only — no `sqlite3`, no hardcoded path.

Verified green: `python3.13 -m py_compile` on the example script (clean);
the example copied into the real project and run against the live DB on
NixOS (`export
LD_LIBRARY_PATH=/run/current-system/sw/share/nix-ld/lib`, then `uv run
python scripts/example_cost_by_model.py`) exited 0 with a non-empty
DataFrame (5 rows, incl. a `NaN` model group); `npm test` 146/146;
`npx tsc --noEmit` clean. No TS source files modified (diff confirms exactly
the 3 skill files).

**Minor (low, non-blocking — for the coherence step's discretion):** the
example script sums 3 of `turns`' 5 token columns; it omits
`cache_read_tokens` and `cache_write_tokens`. All binding acceptance
criteria (`cost_total_usd` + non-empty + read-only + empty-DB +
preflight→setup + schema-primer-complete) are met; the "and token buckets"
phrasing is a completeness nicety, not a failed criterion. Optional 2-line
SQL bump if desired.

