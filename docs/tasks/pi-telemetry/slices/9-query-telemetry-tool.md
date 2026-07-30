---
kind: slice
slug: query-telemetry-tool
title: "query_telemetry agent tool"
task: ../task.md
mode: afk
status: todo
size: m
blocked_by: [tm-command-surface]
started_at:
completed_at:
---

# query_telemetry agent tool

SPEC §6.2: the agent-facing query tool. Named presets are the primary
path; raw SQL is a constrained escape hatch on the guarded path from
slice 8.

## Scope

- `query_telemetry` tool with params: `query` (enum of presets:
  `session_cost`, `daily_cost`, `tool_failures`, `feedback`,
  `ttft_by_model`, `context_growth`, `agent_tree`) plus preset-specific
  filter params (kind/source/since, model, session, …); **or** `sql`
  for raw SELECT.
- Presets reuse slice 8's canned SQL.
- `sql` escape hatch: read-only connection + `PRAGMA query_only=ON`
  (writes/schema changes blocked by construction — no regex guard),
  `LIMIT 500` injected if absent, 3s statement timeout, row cap.
- Tool description steers the agent to presets first, `sql` second.

## Acceptance criteria

- Each preset returns the expected aggregates against the slice-8
  fixture DB.
- A write attempt via `sql` fails by construction (read-only
  connection), with a clear error returned to the agent.
- A query without LIMIT gets `LIMIT 500` injected; a runaway query is
  killed at the 3s timeout.
- The tool is registered alongside `submit_feedback` without name
  collisions.

## Testing strategy

- **Layers:** `src/query/tool.ts`, reuse of `sql-guard.ts` /
  `canned.ts`.
- **Failure modes:** (1) unknown preset name → validation error
  listing valid presets; (2) `sql` returning huge result → capped at
  500 rows, truncation noted in the response.
- **Key scenarios:** "what did today cost?" via `daily_cost`; "which
  tool fails most?" via `tool_failures`; feedback retrieval with
  kind/source/since filters; agent tree on lineage fixtures.
- **Edge cases:** both `query` and `sql` supplied (reject, pick one);
  empty result sets; filter combos with no matches.
