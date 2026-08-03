## Deviation report — swt-skill-cost-preset

### API surface changes
- **Planned:** `skill_cost` entry in `CANNED` (`src/query/canned.ts`) with
  the arch-spec compare-versions join; `skill_cost` added to `PRESET_NAMES`
  + tool description in `src/query/tool.ts`. Output columns:
  `skills_package_version, skill_name, invocations, cost_usd, tokens,
  tool_errors`.
- **Actual:** Matches exactly. The `CANNED.skill_cost` SQL is identical to
  the arch spec's SQL (same joins, same columns, same GROUP BY, same ORDER
  BY, same LIMIT 500). `PRESET_NAMES` includes `skill_cost`; the tool
  `description` and the `query` param `StringEnum` description both list it.
- **Impact:** None on dependent slices. Slice 2 (`/tm skills`) can call
  `runCanned(dbPath, "skill_cost")` directly. Slice 3 (`skill_versions`)
  can copy this SQL and add the `-- {{verFilter:ver.value_text}}` marker.

### Abstraction usage
- Used/was specified: **yes** — all specified abstractions were used:
  - `src/query/canned.ts` `CANNED` record + `CannedEntry { description, sql }`:
    `skill_cost` added as a new entry, mirroring the existing preset pattern.
  - `-- {{key:column}}` filter-marker pattern: the arch spec SQL included a
    `-- {{verFilter:ver.value_text}}` marker (for slice 3's use). The
    implementation **omitted** this marker — correct for slice 1, which adds
    NO new filter key (the arch spec explicitly says "slice 1 adds NO new
    filter key; slice 3 adds `verFilter`"). The marker will be added by slice 3.
  - `runCanned` + `guardedQuery` (read-only, LIMIT 500, 3s timeout): reused;
    no second query runner written.
  - `src/query/tool.ts` `PRESET_NAMES` + `StringEnum` + `buildFilters`:
    `skill_cost` added to the array; `buildFilters` unchanged (no new filter
    key this slice).

### SQL shape conformance (detailed)

| Element | Arch spec | Implementation | Match? |
|---|---|---|---|
| Join: `session_event_metadata ver ON ver.event_id = se.event_id AND ver.key = 'skills_package_version'` | yes | yes | ✅ |
| Join: `session_event_metadata skill ON skill.event_id = se.event_id AND skill.key = 'skill_name'` | yes | yes | ✅ |
| Join: `turns t ON t.run_id = se.run_id` (native column, not EAV pivot) | yes | yes | ✅ |
| Join: `tool_executions te ON te.turn_id = t.turn_id` | yes | yes | ✅ |
| `WHERE se.type = 'skill_invoke'` | yes | yes | ✅ |
| `GROUP BY ver.value_text, skill.value_text` | yes | yes | ✅ |
| `ORDER BY ver.value_text DESC, skill.value_text` | yes | yes | ✅ |
| `LIMIT 500` | yes | yes | ✅ |
| Columns: `skills_package_version, skill_name, invocations, cost_usd, tokens, tool_errors` | yes | yes | ✅ |
| `-- {{verFilter:ver.value_text}}` marker | in spec SQL (for slice 3) | omitted (correct — slice 1 adds no filter) | ✅ (intentional) |

The join uses the **native `session_events.run_id`** column (migration 4,
`idx_sev_run`) for the run→turns hop, and `session_event_metadata` for the
grouping dimensions (`skill_name`, `skills_package_version`) — exactly as
the arch spec prescribes. The EAV table is not used for the `run_id` join.

### EXPLAIN QUERY PLAN index usage
- **Planned:** `EXPLAIN QUERY PLAN` shows `USING INDEX` (no full scan).
- **Actual:** A dedicated test (`skill_cost uses indexes`) asserts:
  - `!details.includes("SCAN")` — no full table scans.
  - `details.includes("idx_sems_key_text")` — uses the EAV index.
  - `details.includes("idx_turns_run")` — uses the turns run-id index.
- **Impact:** None. The query is index-backed as specified.

### PRESET_NAMES + tool description update
- **Planned:** `skill_cost` added to `PRESET_NAMES` + tool description.
- **Actual:** `PRESET_NAMES` array includes `"skill_cost"` (appended after
  `"agent_tree"`). The tool `description` string lists `skill_cost` in the
  preset enumeration. The `query` param `StringEnum` description also lists
  it. All three locations updated.
- **Impact:** None. The agent will see `skill_cost` as a valid preset.

### No new filter keys this slice
- **Planned:** Slice 1 adds NO new filter key; `verFilter` is deferred to
  slice 3.
- **Actual:** `CannedFilters` interface unchanged. No new filter key added.
  The `skill_cost` SQL has no `-- {{...}}` markers (unfiltered — groups ALL
  versions, as specified).
- **Impact:** None. Slice 3 will add `verFilter` to `CannedFilters` and the
  `-- {{verFilter:ver.value_text}}` marker to its copy of the SQL.

### Out-of-scope changes
- **`test/helpers/fixture-skill-events.ts`** (new file): a shared test helper
  that seeds synthetic `skill_invoke` rows + metadata + turns + tool
  executions. Not specified in the arch spec but necessary for testing and
  consistent with the existing `test/helpers/fixture-db.ts` pattern. The
  arch spec did say "Test against a fixture DB with synthetic skill_invoke
  rows + metadata + turns + tools (mirror `test/canned.test.ts` /
  `test/helpers/fixture-db.ts`)." This helper fulfills that. Additive, no
  production impact.
- **`test/tool.test.ts`** (integration test): added a test that
  `query_telemetry` accepts and returns the `skill_cost` preset. Not
  explicitly specified but consistent with the existing tool-test pattern
  (other presets have integration tests). Additive.
- No production code outside `canned.ts` and `tool.ts` was changed. No new
  tables, no migrations, no capture changes — pure read-only queries, as
  specified.

### Slice doc vs. arch spec: `turns` vs. `tokens` column
- **Slice doc** acceptance criteria says: columns `skills_package_version,
  skill_name, invocations, cost_usd, turns, tool_errors`.
- **Arch spec** SQL says: `SUM(t.total_tokens) AS tokens` (not `turns`).
- **Implementation:** used `tokens` (matching the arch spec, which explicitly
  beats the slice doc per the feature resource: "its amendments beat the
  slice docs where they conflict").
- **Verdict:** correct. The arch spec is the authority; `tokens` is the
  intended column (total token consumption per skill+version, not a turn
  count). The slice doc's `turns` was a pre-amendment carryover. The slice
  doc should be updated to say `tokens` instead of `turns` for future
  readers, but this is a documentation fix, not a code deviation.

### Task doc update needed?
Yes — minor: the slice doc's acceptance criteria should be updated to say
`tokens` instead of `turns` to match the arch spec. Not a code issue.

### User attention needed?
No. No scope change, no API surface deviation, no user-judgment decision.
The `turns`→`tokens` column name is an arch-spec-vs-slice-doc reconciliation
already resolved in favor of the arch spec (the authority). The
`fixture-skill-events.ts` helper is an additive test utility consistent with
existing patterns.
