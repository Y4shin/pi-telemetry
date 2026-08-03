# Architecture spec — swt-compare-versions-queries

Task: `swt-compare-versions-queries` (feature)
Map: `skill-workflow-telemetry`
Drafted: 2026-08-03. Lives at `docs/tasks/swt-compare-versions-queries/arch-spec.md`
(stable, shared across all slice chains). Read this BEFORE the slice doc;
its amendments beat the slice docs where they conflict.

This feature adds the query surface that answers "how do v2.4.0 and v2.5.1
of task-workflow differ?" and "which skill costs/fails the most?" — the
payoff of Feature A's capture. It adds two `query_telemetry` presets and one
`/tm skills` subcommand. **No new tables, no new capture, no migrations** —
these are pure read-only queries over the tables Feature A landed
(`session_events` type='skill_invoke' + native `run_id`/`turn_id`/`turn_index`
columns + `session_event_metadata`).

---

## Global design

### The compare-versions join (the core query shape)

Feature A's implementer added **native `run_id`/`turn_id`/`turn_index` columns
on `session_events`** (migration 4, `idx_sev_run`) — a better join path than
the metadata-pivot I originally planned. So the query joins on the native
`run_id`, not the EAV pivot, for the run→turns→tools hop. The EAV table
(`session_event_metadata`) is used only for the **grouping dimensions**
(`skill_name`, `skills_package_version`) via its typed `value_text` columns.

```sql
-- skill_cost: cost/tool-errors grouped by skills_package_version + skill_name
SELECT
  ver.value_text  AS skills_package_version,
  skill.value_text AS skill_name,
  COUNT(*)         AS invocations,
  ROUND(SUM(t.cost_total_usd), 6) AS cost_usd,
  SUM(t.total_tokens)            AS tokens,
  SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_events se
JOIN session_event_metadata ver   ON ver.event_id = se.event_id AND ver.key = 'skills_package_version'
JOIN session_event_metadata skill ON skill.event_id = se.event_id AND skill.key = 'skill_name'
JOIN turns t  ON t.run_id = se.run_id          -- native column, idx_sev_run + idx_turns_run
JOIN tool_executions te ON te.turn_id = t.turn_id  -- idx_tool_turn
WHERE se.type = 'skill_invoke'
  -- {{verFilter:ver.value_text}}   -- optional version filter (skill_versions preset)
GROUP BY ver.value_text, skill.value_text
ORDER BY ver.value_text DESC, skill.value_text
LIMIT 500
```

**Why this shape (not the metadata pivot for the join):** the native
`session_events.run_id` is a real column with `idx_sev_run`; joining
`turns ON t.run_id = se.run_id` is index-backed and direct. Using the EAV
`run_id` row for the join would add a metadata self-join for no gain. The EAV
table is reserved for the *variable* skill-declared dimensions (skill_name,
version, target, slice_count, …) which are index-backed via `idx_sems_key_text`.

**Confirmed index-backed** (verify with `EXPLAIN QUERY PLAN` in tests): the
prototype (`bench-eav.mjs` `QUERY_D`) showed `SEARCH … USING INDEX` at every
step for this shape. The native `run_id` column only makes it faster.

### Two new presets + one command

1. **`skill_cost`** preset → the query above (no version filter), grouped by
   version + skill. Answers "which skill costs/fails the most, per version?"
2. **`skill_versions`** preset → the same query with a version filter
   (`verFilter`), returning one version's rows; the *caller* (agent) compares
   two runs to get the A/B delta. (Doing the delta in SQL is fiddly; two
   filtered queries + client-side diff is simpler and reuses `skill_cost`'s
   SQL. The preset exists so the agent has a named entry point.)
3. **`/tm skills`** subcommand → human-facing table of the `skill_cost` query,
   newest-version-first, in the existing `/tm` surface style.

### No new capture, no migrations, no schema changes

This feature is **read-only queries** over existing tables. It does not
write, does not add tables, does not migrate. It only adds: two entries to
`CANNED` in `src/query/canned.ts`, one `PRESET_NAMES` entry (+ description
steering) in `src/query/tool.ts`, one subcommand in `src/query/commands.ts`,
and tests.

---

## Per-slice interface contracts

### Slice 1 — `swt-skill-cost-preset` (size s)

**Exports:** adds `skill_cost` to `CANNED` in `src/query/canned.ts`; adds
`skill_cost` to `PRESET_NAMES` + the tool description in `src/query/tool.ts`.

**Existing abstractions to use:**
- `src/query/canned.ts` `CANNED` record + `CannedEntry { description, sql }`
  + the `-- {{key:column}}` filter-marker pattern (`applyFilters`). Add a
  `verFilter` filter key (or reuse `since` for time; see below).
- `src/query/canned.ts` `CannedFilters` — add `verFilter?: string` (the
  version to filter to) if the preset supports it. **Decision:** keep
  `skill_cost` unfiltered (no version filter — it groups ALL versions); the
  version filter is only needed by `skill_versions` (slice 3). So slice 1
  adds NO new filter key; slice 3 adds `verFilter`.
- `src/query/sql-guard.ts` `guardedQuery` (read-only, LIMIT 500, 3s timeout)
  — used by `runCanned`; no direct use needed.
- `src/query/tool.ts` `PRESET_NAMES` + `StringEnum` + `buildFilters`.

**Do NOT reimplement:**
- Do not write a second query runner; reuse `runCanned`.
- Do not add a new filter mechanism; use the `-- {{key:column}}` markers.

**Interface contract for dependents (slice 2, 3):** slice 1 defines the
`skill_cost` SQL (the core join shape above). Slice 2 (`/tm skills`) reuses
`runCanned(dbPath, "skill_cost")` to render the table. Slice 3
(`skill_versions`) reuses the same SQL with a `verFilter` marker added.

**Acceptance:** `query_telemetry` with `query:"skill_cost"` returns rows
`skills_package_version, skill_name, invocations, cost_usd, tokens,
tool_errors`, ordered by version desc then skill. `EXPLAIN QUERY PLAN`
shows `USING INDEX` (no full scan). Added to `CANNED` + `PRESET_NAMES` +
tool description. `npm test` green, `tsc --noEmit` clean.

### Slice 2 — `swt-tm-skills-command` (size s, blocked_by 1)

**Exports:** adds a `skills` case to `handleCommand` in
`src/query/commands.ts` that calls `runCanned(dbPath, "skill_cost")` and
renders via `formatResult`.

**Existing abstractions to use:**
- `src/query/commands.ts` `handleCommand` switch + `formatResult` +
  `formatTable` + `notify`. Mirror `renderCost`/`renderErrors`.
- `src/query/canned.ts` `runCanned`.

**Do NOT reimplement:** do not write a second table formatter; reuse
`formatResult`.

**Interface contract:** `/tm skills` prints the `skill_cost` table. No
args (newest-version-first is the query's natural order). Added to the
`/tm` + `/telemetry` command `description` string.

**Acceptance:** `/tm skills` prints a human-readable table (version, skill,
invocations, cost, tokens, tool_errors), newest version first. Added to
`commands.ts` + the command description. `npm test` green, tsc clean.

### Slice 3 — `swt-skill-versions-preset` (size s, blocked_by 1)

**Exports:** adds `skill_versions` to `CANNED` (the `skill_cost` SQL + a
`-- {{verFilter:ver.value_text}}` marker) and to `PRESET_NAMES`; adds
`verFilter` to `CannedFilters` + `buildFilters` (read from a `version`
tool param).

**Existing abstractions to use:**
- Reuse slice 1's `skill_cost` SQL (copy + add the filter marker; or factor
  the SQL into a shared helper — **decision:** copy is fine, the SQL is
  short; do not over-abstract).
- `src/query/canned.ts` `CannedFilters` + `applyFilters` + markers.
- `src/query/tool.ts` `buildFilters` — add `version` param → `verFilter`.

**Do NOT reimplement:** do not build an A/B delta in SQL (two filtered
queries + client-side diff is the agent's job); this preset just filters to
one version.

**Interface contract:** `query_telemetry` with `query:"skill_versions"` +
`version:"2.5.1"` returns the `skill_cost` rows for that version only. The
agent calls it twice (per version) and diffs.

**Acceptance:** `query_telemetry` with `query:"skill_versions"` +
`version:"2.5.1"` returns rows filtered to that version. `EXPLAIN QUERY
PLAN` uses the index. Added to `CANNED` + `PRESET_NAMES` + tool params
(`version`). `npm test` green, tsc clean.

---

## Cross-cutting decisions

- **Read-only, always.** All queries go through `guardedQuery` (read-only
  connection, `PRAGMA query_only=ON`, LIMIT 500, 3s timeout) via `runCanned`.
  No writes, no DDL.
- **Join on native `session_events.run_id`** (migration 4, `idx_sev_run`),
  NOT the EAV `run_id` row — the native column is the efficient, index-backed
  join path. The EAV table is for the variable grouping dimensions only.
- **Grouping via `session_event_metadata` typed columns** (`value_text` for
  `skill_name`/`skills_package_version`), index-backed via
  `idx_sems_key_text` (the `(key, value_text)` index supports the
  `ver.key = 'skills_package_version'` lookup).
- **No new filter mechanism beyond the existing `-- {{key:column}}` markers.**
  Slice 3 adds one new filter key (`verFilter`) to `CannedFilters`.
- **`skill_name`/`skills_package_version` may be null** (skill with no
  enclosing package.json, or a skill_invoke row before slice 2 stamped the
  version). The query's inner joins drop null-dimension rows; that's
  acceptable (an invocation with no version isn't comparable across
  versions). Document this in the preset description.
- **Test against a fixture DB** with synthetic `skill_invoke` rows +
  metadata + turns + tools (mirror `test/canned.test.ts` / `test/helpers/fixture-db.ts`).
  Assert `EXPLAIN QUERY PLAN` uses indexes.

## Open questions (resolve during review or in-slice)

1. **`skill_versions` A/B delta in SQL vs two queries?** APPROVED — spec
   recommendation: two filtered queries + client-side diff (the agent calls
   `skill_versions` twice, once per version). Simpler, reuses `skill_cost`'s
   SQL. No single SQL UNION-diff.
2. **Null-dimension rows:** APPROVED — spec recommendation: inner joins drop
   skill_invoke rows with no `skills_package_version` metadata row. An
   invocation with no version isn't comparable across versions, so dropping
   them is correct. Document in the preset description.

**Arch spec APPROVED 2026-08-03.** User approved the spec + both recommended
answers. Proceeding to per-slice TDD chains (slice 1 first, then 2 + 3).
