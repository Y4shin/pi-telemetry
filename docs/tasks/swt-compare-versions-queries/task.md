---
kind: task
type: feature
slug: swt-compare-versions-queries
title: Canned queries + /tm command to compare metrics across skills-package versions and skills
map: skill-workflow-telemetry
status: ready
blocked_by: []
slices:
- swt-skill-cost-preset
- swt-tm-skills-command
- swt-skill-versions-preset
---

## User-visible outcome

After this feature, the user can answer "how do v2.4.0 and v2.5.1 of
task-workflow differ?" and "which skill costs/fails the most?" via:

- `query_telemetry` preset `skill_cost` — cost, turns, tool-error count, and
  invocation count grouped by `skills_package_version` + `skill_name`.
- `query_telemetry` preset `skill_versions` — A/B delta between two versions
  of the same skill (cost/turn/tool-failure delta).
- `/tm skills` command — a human-facing table of skills invoked, counts,
  cost, version, and target.

## User story

As a developer comparing two versions of my skills package, I run
`/tm skills` (or the agent calls `query_telemetry` with `skill_versions`) and
see that implement-task under v2.5.1 averaged 40 turns / $0.30 / 2 tool errors
vs 55 turns / $0.45 / 5 errors under v2.4.0 — evidence the v2.5.1 refactor
reduced cost and failures.

## Scope boundaries

- **In:** the two `query_telemetry` presets, the `/tm skills` subcommand, and
  their tests.
- **Out:** the capture path (Feature A), the skills-package edits (manual),
  run-level lineage (Fog). No new tables — these query `session_events`
  `type='skill_invoke'` rows joined to `session_event_metadata` (Option D,
  sparse EAV, from Feature A slice 6) per key, then to `turns` on `run_id` →
  `tool_executions` on `turn_id`.

## Acceptance criteria

- `query_telemetry` with `query: "skill_cost"` returns rows grouped by
  `skills_package_version` + `skill_name` with invocation count, total cost,
  turn count, and tool-error count, ordered by version then skill.
- `query_telemetry` with `query: "skill_versions"` returns a per-skill delta
  between two versions (cost/turn/tool-error), accepting version filter params.
- `/tm skills` prints a human-readable table of the same, newest invocations
  first, in the command surface style of the existing `/tm` subcommands.
- The presets use the queryability index from Feature A slice 6
  (`EXPLAIN QUERY PLAN` shows `USING INDEX`).
- Presets are added to `src/query/canned.ts` and the tool description steers
  to them; `/tm skills` is added to `src/query/commands.ts`.
- `npm test` green, `tsc --noEmit` clean.

## Existing abstractions to use

- `src/query/canned.ts` — the named-preset pattern (mirror `session_cost`,
  `tool_failures`).
- `src/query/commands.ts` — the `/tm` subcommand pattern.
- `src/query/tool.ts` — the `query_telemetry` tool registration + preset
  steering.
- `src/query/sql-guard.ts` — the read-only guard for any raw SQL.

## Architecture / domain decisions

- **Option D pivot join.** Queries join `session_event_metadata` per key
  (version=filter, skill_name=group, run_id=join) → `turns` on `run_id` →
  `tool_executions` on `turn_id` — the `QUERY_D` shape from
  `docs/tasks/swt-schema-prototype/bench-eav.mjs`. **NOT** on `session_id`
  (which cross-products catastrophically; see findings doc §4 + the prototype).
- See `docs/tasks/swt-research-seams/findings.md` and
  `docs/tasks/swt-grill-decisions/task.md`.

## Architecture notes

Arch spec drafted and **APPROVED 2026-08-03** at
`docs/tasks/swt-compare-versions-queries/arch-spec.md`. Open questions resolved:
Q1 (two filtered queries + client-side diff for A/B) + Q2 (inner joins drop
null-version rows) approved per spec recommendation. Join uses native
`session_events.run_id` (migration 4) for the run→turns→tools hop; EAV table
only for grouping dimensions. No new tables/migrations — pure read-only queries.

## Slice list

1. `swt-skill-cost-preset` (s) — `query_telemetry` preset `skill_cost`.
2. `swt-tm-skills-command` (s) — `/tm skills` subcommand.
3. `swt-skill-versions-preset` (s) — `query_telemetry` preset `skill_versions`
   (A/B version delta).
