---
kind: task
type: feature
slug: swt-compare-versions-queries
title: Canned queries + /tm command to compare metrics across skills-package versions and skills
map: skill-workflow-telemetry
status: done
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

## Implementation notes

### swt-skill-cost-preset (landed)

- Added the `skill_cost` preset to `src/query/canned.ts` (Option D pivot join:
  `session_events` `type='skill_invoke'` → `session_event_metadata` EAV per key
  for `skills_package_version` + `skill_name` → `turns` on native `run_id` →\  `tool_executions` on `turn_id`, grouped by version+skill, ordered version desc
  then skill, `LIMIT 500`). Listed `skill_cost` in `PRESET_NAMES` and the tool
  description in `src/query/tool.ts`.
- Output columns: `skills_package_version, skill_name, invocations, cost_usd,
  tokens, tool_errors`. Note: the slice doc acceptance criteria listed `turns`,
  but the approved arch-spec SQL and the task instructions both use `tokens`
  (`SUM(t.total_tokens) AS tokens`). Implemented `tokens` per the arch spec,
  which is authoritative where it conflicts with the slice docs.
- No new filter keys this slice (`verFilter` deferred to slice 3); the
  `-- {{verFilter:ver.value_text}}` marker is intentionally absent and will be
  added by slice 3.
- Tests: `test/canned.test.ts` (grouping/order, `EXPLAIN QUERY PLAN` index
  usage asserting `idx_sems_key_text` + `idx_turns_run`, null-version/skill
  drop), `test/tool.test.ts` (integration that `query_telemetry` accepts the
  preset), and a shared `test/helpers/fixture-skill-events.ts` seeder.
- Verification: `node --test test/canned.test.ts test/tool.test.ts` 31/31;
  `npm test` 213/213; `npm run check` clean.
- Deviation report: `docs/tasks/swt-compare-versions-queries/deviation-reports/swt-skill-cost-preset.md`.

### swt-tm-skills-command (landed)

- Added `/tm skills` subcommand to `src/query/commands.ts`: `renderSkills(dbPath)`
  calls `runCanned(dbPath, "skill_cost")` and renders via the shared
  `formatResult` table formatter. Registered `case "skills":` in the
  `handleCommand` switch.
- Updated both the `/telemetry` and `/tm` command description strings to list
  `skills` in the subcommand list. The `/tm` description was changed from
  `"Alias for /telemetry."` to the full duplicated description string so the
  alias is self-describing (minor maintenance coupling: `/tm` won't auto-track
  `/telemetry` if the latter changes).
- Reuses the `skill_cost` preset from slice 1 — no second query runner, no
  second table formatter. Output columns are the arch-spec columns
  (`skills_package_version, skill_name, invocations, cost_usd, tokens,
  tool_errors`); the slice doc's "last target" / "most recent invocation time"
  columns were never in the approved `skill_cost` SQL (arch spec is
  authoritative where it conflicts with slice docs).
- Tests: `test/commands.test.ts` — three `skills` tests (normal output table
  rows, newest-version-first ordering, empty-DB no-data message) plus a
  description-listing assertion. Reused the `test/helpers/fixture-skill-events.ts`
  seeder from slice 1.
- Verification: `npm test` 216/216 across 33 suites; `npm run check` (tsc
  --noEmit) clean.
- Deviation report: `docs/tasks/swt-compare-versions-queries/deviation-reports/swt-tm-skills-command.md`.

### swt-skill-versions-preset (landed)

- Added the `skill_versions` preset to `src/query/canned.ts`: a copy of slice
  1's `skill_cost` SQL with the `-- {{verFilter:ver.value_text}}` marker added
  after `WHERE se.type = 'skill_invoke'`. Added `verFilter?: string` to
  `CannedFilters` (deferred from slice 1). `applyFilters` handles `verFilter` via
  the generic `keyof CannedFilters` lookup — no special-casing.
- Added `skill_versions` to `PRESET_NAMES` and a `version: Type.Optional(
  Type.String(...))` tool parameter to `src/query/tool.ts`; `buildFilters` maps
  `params.version → filters.verFilter`. Updated the `query_telemetry` and `query`
  parameter descriptions to list `skill_versions` and `version`.
- **Arch-spec divergence (approved):** the slice doc described `versionA`/
  `versionB` params with a SQL-level delta. The approved arch spec Q1 decision
  calls for a single `version` filter + two filtered queries with client-side
  diff. Implemented the arch spec approach (authoritative where it conflicts).
  The preset returns one version's `skill_cost` rows; the agent calls it twice
  and computes the A/B delta client-side. No SQL UNION/self-join.
- Tests: `test/canned.test.ts` (`skill_versions filters to a single version` —
  exact rows for version `2.5.1`; `skill_versions uses indexes` — asserts no
  `SCAN`, uses `idx_sems_key_text` + `idx_turns_run`), `test/tool.test.ts`
  (integration: `query:"skill_versions"` + `version:"2.5.1"` returns two rows,
  all version `2.5.1`). Reused the `test/helpers/fixture-skill-events.ts` seeder.
- Verification: `node --test test/canned.test.ts` 15/15; `node --test
  test/tool.test.ts` 19/19; `npm test` 219/219 across 33 suites; `npm run check`
  (tsc --noEmit) clean.
- Deviation report: `docs/tasks/swt-compare-versions-queries/deviation-reports/swt-skill-versions-preset.md`.
- This was the last slice in the feature; all three slices now landed.
