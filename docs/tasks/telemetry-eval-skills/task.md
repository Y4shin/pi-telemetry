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
