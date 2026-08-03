## Deviation report — swt-skill-versions-preset

### API surface changes
- **Planned (slice doc):** `query_telemetry` with `query:"skill_versions"` and `versionA:"2.4.0", versionB:"2.5.1"` returns per-skill rows with cost/turn/tool-error deltas between the two versions; skills present in only one version show a delta from zero. Implies SQL-level delta computation (UNION/self-join) and two tool params (`versionA`, `versionB`).
- **Planned (arch spec, overrides slice doc):** `skill_versions` accepts a single `version` filter parameter; returns `skill_cost` rows for one version only; the agent calls the preset twice (once per version) and computes the A/B delta client-side. No SQL UNION or self-join.
- **Actual:** Matches the arch spec exactly. Single `version: Type.Optional(Type.String(...))` tool param → mapped to `filters.verFilter` in `buildFilters` → applied via the `-- {{verFilter:ver.value_text}}` marker in the SQL. The preset returns one version's rows; no SQL-level delta. The `skill_versions` SQL is a copy of `skill_cost`'s SQL with the `-- {{verFilter:ver.value_text}}` marker added after `WHERE se.type = 'skill_invoke'`.
- **Impact:** None on dependent slices. This is the last slice in the feature (no dependents). The deviation from the slice doc is intentional and arch-spec-approved (Q1 decision: two filtered queries + client-side diff).

### Abstraction usage
- Used/was specified: **yes** — all specified abstractions were used:
  - `src/query/canned.ts` `CANNED` record + `CannedEntry { description, sql }` + the `-- {{key:column}}` filter-marker pattern (`applyFilters`): `skill_versions` entry added with the `-- {{verFilter:ver.value_text}}` marker. `applyFilters` handles `verFilter` via the generic `keyof CannedFilters` lookup (no special-casing needed).
  - `CannedFilters` — `verFilter?: string` added as specified.
  - `src/query/tool.ts` `PRESET_NAMES` + `StringEnum` + `buildFilters`: `skill_versions` added to `PRESET_NAMES`; `version` param added to the `Type.Object` schema; `buildFilters` maps `params.version → filters.verFilter`.
  - Reuses slice 1's `skill_cost` SQL (copy + marker, as the arch spec decision said "copy is fine, do not over-abstract").
  - `guardedQuery` (read-only, LIMIT 500, 3s timeout) via `runCanned` — no direct use needed.
- No reimplemented abstractions. No second query runner, no new filter mechanism.

### Out-of-scope changes
- **None.** The implementation is scoped exactly to the arch spec's slice 3 contract: one `CANNED` entry, one `PRESET_NAMES` entry, one `CannedFilters` field, one tool param, one `buildFilters` mapping, tests. No new tables, no migrations, no capture, no schema changes. No unrelated files touched.

### Acceptance criteria check (arch spec, the authoritative document)
- ✅ `query_telemetry` with `query:"skill_versions"` + `version:"2.5.1"` returns rows filtered to that version only (test: `skill_versions filters to a single version` asserts exactly 2 rows for version 2.5.1 with correct columns and values; tool integration test asserts `rowCount === 2` and all rows have version `2.5.1`).
- ✅ `EXPLAIN QUERY PLAN` uses the index (test: `skill_versions uses indexes` asserts no `SCAN` in the plan, and that `idx_sems_key_text` and `idx_turns_run` are used).
- ✅ Added to `CANNED` + `PRESET_NAMES` + tool params (`version`) + tool description lists `skill_versions` and `version`.
- ✅ `npm test` green (219/219), `tsc --noEmit` clean.
- ✅ Null-dimension rows: inner joins drop rows with no `skills_package_version` metadata (arch spec Q2 decision; documented in the `skill_versions` description: "Rows with no version or skill metadata are excluded" — actually this is in `skill_cost`'s description; `skill_versions`'s description says "Cost, tokens, and tool errors for a single skills_package_version" which implicitly assumes the version exists).

### Task doc update needed?
No. The arch spec already records the Q1 decision (two filtered queries + client-side diff) that overrides the slice doc's `versionA`/`versionB` framing. The implementation matches the approved spec. No task doc update needed — the deviation is already documented in the arch spec's open-questions section as APPROVED.

### User attention needed?
No. The deviation from the slice doc (single `version` param + client-side diff vs. `versionA`/`versionB` SQL delta) was explicitly approved in the arch spec's Q1 decision before implementation. No scope change, no API surface the user didn't sign off on. The slice doc is simply outdated relative to the approved arch spec, which is the expected workflow (arch spec amendments beat slice docs).
