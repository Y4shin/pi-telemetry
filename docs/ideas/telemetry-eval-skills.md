---
kind: idea
title: "Telemetry eval skills: python project + DB analysis"
slug: telemetry-eval-skills
status: in-grilling
created_at: 2026-07-30T21:43:58Z
grilled_at:
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

## Open questions

- [ ] **Skill scope/location** — user-level git skills repo (available in
      every session) vs project-local `.pi/skills/` (only when working in
      pi-telemetry)?
- [ ] **Dependency set** — exactly which packages count as "standard
      data-analysis deps"?
- [ ] **Python version pin** — 3.15.0b4 is beta; pin a stable Python via uv?
- [ ] **Read-only DB safety** — should the analyze skill force read-only
      SQLite access to protect the live WAL DB?
- [ ] **DB path resolution** — hardcode `~/.pi/telemetry.db` or mirror
      config.ts (env `PI_TELEMETRY_DB_PATH` → setting → default)?
- [ ] **Script organization** — where do long-held vs one-off scripts live
      inside `~/.pi/telemetry-eval/`?
