---
kind: slice
slug: tm-command-surface
title: "/tm command surface"
task: ../task.md
mode: afk
status: todo
size: l
blocked_by:
  - llm-request-capture
  - tool-bash-capture
  - session-events-capture
  - feedback-collector
  - lineage-foundation
started_at:
completed_at:
---

# /tm command surface

SPEC §6.1: the human-facing query surface. `/telemetry` with alias
`/tm`, all subcommands, canned SQL for the derived metrics, CSV export,
and the guarded `/tm sql` path (shared implementation with slice 9).

## Scope

- Register `/telemetry` + `/tm` alias with subcommands per SPEC §6.1:
  - `status` — DB path, size, row counts, buffer state, last meta errors
  - `session` — current session: turns, cost, tool calls, duration,
    lineage
  - `cost [today|week|all]` — cost/tokens grouped by model, then day
  - `errors [--since]` — failed tools, non-2xx LLM statuses, meta errors
  - `feedback [--kind] [--source] [--since]` — newest first
  - `tree` — agent lineage tree for current session family (flat until
    lineage data exists)
  - `export [--table T] [--from] [--to] [--out file.csv]` — CSV dump
  - `sql "SELECT …"` — guarded read-only SQL
- Guarded SQL path (shared with slice 9): dedicated read-only
  connection (`DatabaseSync` `{readOnly:true}` + `PRAGMA query_only=ON`),
  `LIMIT 500` injected if the query lacks one, 3s statement timeout.
- Canned SQL for SPEC §1 derived metrics (cost per day/model/session,
  cache-hit ratio, tool failure rates, turn-latency percentiles,
  context growth, 429 frequency, TTFT percentiles per model) — named
  and tested, reused by slice 9 presets.

## Acceptance criteria

- Every subcommand renders sensible output against a seeded fixture DB
  (and against an empty DB — no crashes, clear "no data" output).
- `export` writes valid CSV (header + rows) honoring table/time
  filters; default dumps all tables.
- `/tm sql` executes SELECTs, injects `LIMIT 500` when absent, and
  rejects writes by construction (read-only connection).
- Output is readable in the TUI (bounded width, reasonable truncation).

## Testing strategy

- **Layers:** `src/query/commands.ts`, `src/query/sql-guard.ts`,
  `src/query/canned.ts`, `src/query/export.ts`.
- **Failure modes:** (1) query against empty tables → empty result
  rendering, not an exception; (2) malformed subcommand args → usage
  message, no DB access.
- **Key scenarios:** each subcommand against a multi-session fixture;
  CSV round-trip parse; `/tm sql` with SELECT, with write attempt, with
  runaway query (timeout).
- **Edge cases:** sessions spanning DST/UTC boundaries in `cost today`;
  very wide tables in terminal; export path unwritable → clean error
  message.
