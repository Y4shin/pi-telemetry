---
kind: idea
title: "Telemetry eval skills: python project + DB analysis"
slug: telemetry-eval-skills
status: ready
created_at: 2026-07-30T21:43:58Z
grilled_at: 2026-07-30T21:58:00Z
converted_to:
---

# Telemetry eval skills: python project + DB analysis

## The idea (in the user's words)

Two coupled skills:

1. **Setup skill** — instructs the LLM to create a Python project at
   `~/.pi/telemetry-eval/` that installs the standard data-analysis
   dependencies. The project uses **uv** when available
   (`pyproject.toml` + `uv.lock`), otherwise falls back to a manual
   in-directory venv driven by `requirements.txt`.

2. **Analyze skill** — instructs the LLM to use that Python project to write
   one-off or long-held eval scripts against the pi-telemetry database. It
   explains the DB schema and how to load the data into pandas DataFrames.
   If the project does not exist, it points the user to the setup skill.

Goal: let the LLM (and the user) poke through telemetry data with proper
Python tooling instead of ad-hoc one-liners.

## What exploration established (context, not decisions)

- **uv is installed** (`uv 0.11.28` at `~/.nix-profile/bin/uv`). System
  `python3` is `3.15.0b4` — a **beta**; uv can install a stable Python.
- **Database location**: default `~/.pi/telemetry.db` (SQLite, WAL mode).
  Overridable via env `PI_TELEMETRY_DB_PATH` or the `pi-telemetry.dbPath`
  field in `~/.pi/agent/settings.json` / `<cwd>/.pi/settings.json`
  (see `src/config.ts`). The live DB is being written to concurrently.
- **Schema** (`src/db.ts`, 10 tables):
  - `sessions` — session_id PK, parent_session_id/run_id, agent_label,
    depth, name, cwd, pi/ext version, start/end reason, started/ended_unix_ms.
  - `agent_runs` — run_id PK, session_id FK, started/duration_ms, prompt &
    system_prompt chars, message_count, outcome.
  - `turns` — turn_id PK, run_id/session_id, turn_index, provider/model,
    token buckets (input/output/cache_read/cache_write/total), per-bucket
    cost_usd + cost_total_usd, stop_reason, tool_result_count,
    context_tokens_at_start. Indexed on session_id, model.
  - `llm_requests` — request_id PK, turn_id FK, provider/model, ttft_ms,
    stream_ms, duration_ms, tokens, cost_total_usd, http_status, retry_after.
  - `tool_executions` — tool_call_id PK, turn/run/session, tool_name,
    duration_ms, is_error, error_class, args/result chars + hash, and full
    `args_json`/`result_text` (only captured if capture flags on). Indexed
    session_id, tool_name.
  - `bash_executions` — bash_id PK, session_id, cwd, exit_code, cancelled,
    truncated, output_chars, exclude_from_context, command_chars/hash.
  - `session_events` — event_id PK, session_id, type, payload (JSON TEXT).
  - `feedback` — feedback_id PK, session/run/turn, source, kind, data (JSON).
  - `telemetry_meta` — autoincrement log: level, event, detail, session_id.
  - `flush_log` — flush timing/row_count per tx.
  - All timestamps are `unix_ms` (INTEGER milliseconds).
- **Skill format**: a `SKILL.md` with YAML frontmatter
  (`name`, `description`) under
  `~/.pi/agent/git/codeberg.org/Yashin/skills/skills/<name>/`. That repo is a
  git repo (codeberg.org/Yashin/skills). A project-local alternative is
  `<cwd>/.pi/skills/<name>/SKILL.md`.
- The `query_telemetry` tool already blocks writes/schema changes "by
  construction" — eval scripts touching the live DB should follow the same
  read-only discipline to avoid corrupting the WAL DB.

## Resolved design

### Two skills, authored in this repo at `skills/<name>/SKILL.md`

Deployment target (later, manual): copy each `skills/<name>/` into
`~/.pi/agent/git/codeberg.org/Yashin/skills/skills/<name>/`.

### Skill 1 — `telemetry-eval-setup`

Instructs the LLM to create the Python project at `~/.pi/telemetry-eval/`:

- **If `uv` is on PATH** → `pyproject.toml` (deps: pandas, matplotlib,
  numpy, duckdb; `requires-python = ">=3.12"`) + `uv.lock`. Resolve the
  interpreter the **NixOS-safe** way:
  - Detect NixOS (`test -f /etc/NIXOS` or non-empty `$NIX_OS`).
  - On NixOS: do **not** run `uv python install` (downloaded
    python-build-standalone binaries don't run — no FHS `ld-linux`). Use a
    system interpreter: `uv venv --python "$(command -v python3.13 || command -v python3)"`.
  - Elsewhere: let uv manage Python; prefer 3.13 via a `.python-version`.
  - Prefer 3.13; fall back to an already-installed stable system Python if
    one exists and works.
- **If `uv` is NOT on PATH** → manual in-dir venv: `python3 -m venv .venv`
  + `requirements.txt` (same deps) + `pip install -r requirements.txt`. Use
  a stable system python3 if available; note that 3.15.0b4 is a beta.
- Ship a small `telemetry_eval/` package with a `connect()` helper (see
  below) so the analyze skill has something to import.
- Idempotent: if `~/.pi/telemetry-eval/` already exists and is healthy,
  the skill refreshes deps (`uv sync` / `pip install -r`) rather than
  recreating.

### Skill 2 — `telemetry-eval-analyze`

Instructs the LLM to use the project to write eval scripts:

- **Preflight:** if `~/.pi/telemetry-eval/` is missing (no `pyproject.toml`
  *and* no `requirements.txt`), stop and point the user to
  `/skill:telemetry-eval-setup`.
- **DB path resolution** (mirror `src/config.ts`):
  `PI_TELEMETRY_DB_PATH` env → `pi-telemetry.dbPath` in
  `~/.pi/agent/settings.json` → `<cwd>/.pi/settings.json` → default
  `~/.pi/telemetry.db`.
- **Read-only, always:** open via a `file:<path>?mode=ro` URI with stdlib
  `sqlite3` (WAL-aware, sees latest committed rows; any write/DDL raises).
  For duckdb: `ATTACH '<path>' AS tel (READ_ONLY)`. Derived/scratch data
  writes to a *separate* file (e.g. `~/.pi/telemetry-eval/scratch.db`),
  never the live DB.
- **Shared helper:** `from telemetry_eval import connect` returns a
  read-only sqlite3 Connection; a sibling `duck()` returns a duckdb
  connection with the live DB attached read-only. Scripts use these, never
  hand-roll the URI/path logic.
- **Schema primer:** the skill body embeds the 10-table schema summary
  (sessions → agent_runs → turns → llm_requests; tool_executions;
  bash_executions; session_events; feedback; telemetry_meta; flush_log)
  with the join keys and the `unix_ms` timestamp convention, plus the
  canonical pandas pattern: `pd.read_sql_query(sql, con=connect())`.
- **Script layout:** long-held, named evals go in
  `~/.pi/telemetry-eval/scripts/`; one-offs are ad-hoc files at the root or
  `uv run python -c "..."`. Run scripts via `uv run python scripts/x.py`
  (or `.venv/bin/python scripts/x.py`).

## Open questions

- [x] **Skill scope/location** — ANSWERED: author in the pi-telemetry
      repo; deploy later into
      `~/.pi/agent/git/codeberg.org/Yashin/skills/skills/<name>/`.
- [x] **Authoring path in this repo** — ANSWERED: `skills/<name>/SKILL.md`
      (mirrors codeberg layout; later install is a straight copy).
- [x] **Dependency set** — ANSWERED: pandas + matplotlib + numpy + duckdb.
      Connection via stdlib `sqlite3`; duckdb reads SQLite directly for
      ergonomic SQL→DataFrame. No ipython/jupyter (scripts, not notebooks).
- [x] **Python version pin** — ANSWERED: prefer Python 3.13, but if a
      stable system Python is already installed, use that unless it causes
      problems. **NixOS rule:** never run uv-downloaded Python binaries
      (python-build-standalone) — they don't work on NixOS (no FHS
      `ld-linux`). On NixOS, point uv at a *system* interpreter
      (`uv venv --python $(command -v python3.13 || command -v python3)`)
      instead of `uv python install`. Detect NixOS via `/etc/NIXOS` or
      `NIX_OS` env.
- [x] **Read-only DB safety** — ANSWERED: force read-only everywhere
      (`file:...?mode=ro` for sqlite3, still WAL-aware; `ATTACH ... (READ_ONLY)`
      for duckdb). Derived/scratch data goes to a separate file, never the
      live DB.
- [x] **DB path resolution** — ANSWERED: mirror config.ts
      (`PI_TELEMETRY_DB_PATH` env → `pi-telemetry.dbPath` in settings →
      default `~/.pi/telemetry.db`).
- [x] **Script organization** — ANSWERED: a small `telemetry_eval/`
      package with a `connect()` helper (encapsulates read-only +
      path-resolution) + `scripts/` for long-held named evals; one-offs
      ad-hoc at root or via `uv run python -c`. Scripts import the shared
      helper, never re-copy boilerplate.
