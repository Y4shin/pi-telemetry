---
kind: slice
slug: swt-skill-cost-preset
title: "query_telemetry preset skill_cost — cost/turns/tool-errors by skills_package_version + skill_name"
task: ../task.md
mode: afk
status: done
size: s
blocked_by: []
---

## End-to-end behavior

Add a `skill_cost` named preset to `query_telemetry`: returns invocation count,
total cost, turn count, and tool-error count grouped by
`skills_package_version` + `skill_name`, ordered by version then skill. Uses
the **Option D pivot join** — `session_event_metadata` per key (version=filter,
skill_name=group, run_id=join) → `turns` on `run_id` → `tool_executions` on
`turn_id` (`QUERY_D` from `docs/tasks/swt-schema-prototype/bench-eav.mjs`),
backed by the indexes from Feature A slice 6.

## Acceptance criteria

- `query_telemetry` with `query:"skill_cost"` returns rows with columns `skills_package_version`, `skill_name`, `invocations`, `cost_usd`, `turns`, `tool_errors`.
- Rows are ordered by version (desc), then skill name.
- The query uses the index (`EXPLAIN QUERY PLAN` shows `USING INDEX`).
- The preset is added to `src/query/canned.ts` and listed in the tool description.
- `npm test` green, `tsc --noEmit` clean.

## Test plan

- Seams: `test/canned.test.ts` with a fixture DB of synthetic skill_invoke rows.
- Failure modes: no skill_invoke rows (empty result); null version grouping; null target.
- Scenarios: multiple versions of the same skill; multiple skills; zero-cost invocations.

## Constraints and dependencies

- Depends on Feature A slice 6 (`swt-queryability-schema`) for the
  `session_event_metadata` table + indexes; can be developed against
  synthetic data with the table/indexes pre-applied.
- Mirror `src/query/canned.ts` preset pattern; use the `QUERY_D` pivot shape.
