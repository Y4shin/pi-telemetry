---
kind: slice
slug: setup
title: "telemetry-eval-setup skill + telemetry_eval package"
task: ../task.md
mode: afk
status: done
size: s
blocked_by: []
started_at:
completed_at: 2026-07-31T09:56:12Z
---

# telemetry-eval-setup skill + telemetry_eval package

Author the `telemetry-eval-setup` skill at
`skills/telemetry-eval-setup/SKILL.md` plus its `resources/` templates. The
skill instructs the LLM to bootstrap a Python project at
`~/.pi/telemetry-eval/` with the standard data-analysis deps and a
`telemetry_eval/` package whose `connect()`/`duck()` helpers enforce
read-only access and correct DB-path resolution.

## Scope

- **`skills/telemetry-eval-setup/SKILL.md`** — frontmatter `name:
  telemetry-eval-setup` + a one-line `description`. Body instructs:
  - If `~/.pi/telemetry-eval/` already exists and is healthy → refresh deps
    (`uv sync` or `pip install -r requirements.txt`) and stop.
  - Else create `~/.pi/telemetry-eval/` and populate it from the resource
    templates via `follow resource "resources/..."`.
- **Interpreter / env resolution** (in SKILL.md, NixOS-safe):
  - `uv` on PATH → `uv venv` + `uv sync` using `pyproject.toml`/`uv.lock`.
    - Detect NixOS (`test -f /etc/NIXOS` or non-empty `$NIX_OS`).
    - On NixOS: **do not** `uv python install`; use a system interpreter —
      `uv venv --python "$(command -v python3.13 || command -v python3)"`.
    - Elsewhere: prefer Python 3.13 (`.python-version`); fall back to an
      installed stable system Python.
  - No `uv` → `python3 -m venv .venv` + `pip install -r requirements.txt`;
    use a stable system python3 if available (note: 3.15.0b4 is a beta).
- **`resources/pyproject.toml`** — `requires-python = ">=3.12"`, deps
  `pandas`, `matplotlib`, `numpy`, `duckdb`; a `telemetry_eval` package
  entry so `from telemetry_eval import connect` works.
- **`resources/requirements.txt`**** — same four deps pinned to compatible
  ranges (no-uv fallback).
- **`resources/telemetry_eval/__init__.py`** — exports:
  - `resolve_db_path() -> str` — mirror `src/config.ts`: `PI_TELEMETRY_DB_PATH`
    env → `pi-telemetry.dbPath` in `~/.pi/agent/settings.json` →
    `<cwd>/.pi/settings.json` → default `~/.pi/telemetry.db`.
  - `connect() -> sqlite3.Connection` — opens via
    `sqlite3.connect("file:<path>?mode=ro", uri=True)`; WAL-aware, sees
    latest committed rows; any write/DDL raises.
  - `duck() -> duckdb.DuckDBPyConnection` — `ATTACH '<path>' AS tel (READ_ONLY)`.
  - `scratch(path="scratch.db") -> sqlite3.Connection` — read-write
    connection to a *separate* file under the project for derived data,
    never the live DB.
- **`resources/scripts/smoke_test.py`** — the acceptance smoke test (see
  Acceptance criteria). Dropped into `~/.pi/telemetry-eval/scripts/`.

## Acceptance criteria

- Following the skill creates `~/.pi/telemetry-eval/` with `pyproject.toml`
  (uv path) **or** `requirements.txt` (no-uv path) plus `telemetry_eval/`
  and `scripts/smoke_test.py`.
- `~/.pi/telemetry-eval/scripts/smoke_test.py` exits 0:
  - `import pandas, duckdb, telemetry_eval` succeeds.
  - `telemetry_eval.connect()` returns a connection; a `SELECT count(*) FROM
    sessions` returns a row (DB reachable, read-only).
  - A write attempt (`CREATE TABLE ...` or `INSERT`) on the live-DB
    connection raises (read-only enforced).
  - `telemetry_eval.duck()` attaches the live DB read-only and
    `SELECT * FROM tel.turns LIMIT 1` works.
- Re-running the skill on an existing healthy project refreshes deps and
  does not recreate/overwrite user scripts.
- On NixOS, the skill never invokes `uv python install` (no
  python-build-standalone download).

## Testing strategy

- **Layers:** `skills/telemetry-eval-setup/SKILL.md` + all `resources/*`.
- **Failure modes:** (1) DB path misconfigured — `connect()` must fall
  through to default `~/.pi/telemetry.db` when env/setting absent; (2) a
  write/DDL against the live DB must raise (not silently succeed and risk
  the WAL DB).
- **Key scenarios:** uv-present path creates `uv.lock` and syncs; no-uv
  path builds `.venv` from `requirements.txt`; NixOS path uses a system
  interpreter (no `uv python install`).
- **Edge cases:** project dir exists but is broken (missing
  `telemetry_eval/`) — skill repairs by re-templating the package; DB file
  absent — `connect()` raises a clear error pointing to the expected path,
  does not create the DB.
