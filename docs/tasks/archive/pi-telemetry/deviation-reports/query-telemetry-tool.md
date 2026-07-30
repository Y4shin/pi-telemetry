## Deviation report — query-telemetry-tool

### API surface changes

- **Planned:** `query_telemetry` tool consuming slice 8's `runCanned` /
  `guardedQuery`; adds only param validation, tool registration, result
  shaping. Preset SQL never duplicated into the tool. Async contract
  (await + `dbPath` first arg) per the amended arch spec.
- **Actual:** Matches the plan. Exported as `registerTelemetryTool(pi, t)`
  in `src/query/tool.ts`. Calls `await runCanned(dbPath, query, filters)`
  and `await guardedQuery(dbPath, sql)` — async contract honored, `dbPath`
  sourced from `t.config.dbPath`. No preset SQL strings appear in tool.ts.
  The `sql` escape hatch delegates entirely to `guardedQuery` (read-only by
  construction). Tool registered as `"query_telemetry"` alongside
  `"submit_feedback"` in `index.ts` — no collision (tested explicitly).
- **Impact:** None on dependent slices (slice 10 / soak-privacy-gate has no
  consumer of this tool's exports).

### Abstraction usage

- Used/was specified: **yes.** `runCanned`, `guardedQuery`, `CannedFilters`,
  `Table`, `QueryResult` all consumed from slice 8 as the arch spec
  prescribes. `Type.Object` / `Type.Optional` / `Type.String` from typebox
  for the parameter schema. `t.config.dbPath` and `t.now()` from the
  `Telemetry` interface. No new dependencies introduced.

### Out-of-scope changes

1. **`src/query/canned.ts` bug fix — justified, blocking.** Two slice-8
   canned queries (`turn_latency` and `ttft_by_model`) used nested
   correlated subqueries that failed in SQLite. The `ttft_by_model` preset
   is required by this slice's acceptance criteria, so the fix was
   blocking. Both were rewritten as window-function CTEs (`ROW_NUMBER() OVER`
   + `COUNT(*) OVER`). Semantics preserved: integer median offset
   `n / 2` (0-based OFFSET) → `rn = (n / 2) + 1` (1-based ROW_NUMBER);
   p95 offset `CAST(n * 0.95 AS INTEGER)` → `rn = CAST(n * 0.95 AS INTEGER)
   + 1`. Filter markers changed from qualified (`l.model`,
   `l.started_unix_ms`) to unqualified (`model`, `started_unix_ms`) because
   the CTE exposes bare column names without the outer alias. `turn_latency`
   is not a preset exposed by the tool but had the same bug pattern — fixed
   proactively. **This modifies slice-8 code; coherence refactor should
   review the rewritten SQL against the percentile semantics.**
2. **`Type.String` instead of `StringEnum` for the `query` param.** The
   slice doc says `query` is "enum of presets." The TDD worker reported that
   `StringEnum` is not exported from `@earendil-works/pi-ai`'s public entry
   point. **This claim is incorrect** — verified:
   `import('@earendil-works/pi-ai').then(m => typeof m.StringEnum)` →
   `"function"`, and `dist/index.js` contains
   `export * from "./utils/typebox-helpers.js"`. The fallback uses
   `Type.String` with a description listing valid presets + runtime
   validation (`PRESET_NAMES.includes(query)` → "Unknown preset" error).
   Functionally equivalent (the agent reads valid values from the
   description; the error lists all valid presets) but loses the formal
   JSON-schema `enum` constraint. **Coherence candidate:** replace
   `Type.String` with `StringEnum(PRESET_NAMES, { description: ... })`
   imported from `@earendil-works/pi-ai`.
3. **Extra `tool` filter param.** Not in the slice doc's explicit filter
   list ("kind/source/since, model, session, …") but reasonable — maps to
   `toolName` in `CannedFilters`. Additive, harmless.
4. **`docs/tasks/state.yaml` committed by the TDD worker** (same issue as
   lineage-foundation). Changed `slice: tm-command-surface` →
   `slice: query-telemetry-tool`. This is the orchestrator's state file and
   should not be committed by workers. Land-worker should revert. Consider
   adding `docs/tasks/state.yaml` to `.gitignore` to prevent recurrence.

### Acceptance criteria check (slice doc)

- Each preset returns expected aggregates against fixture DB: ✅ (all 7
  presets tested with `seedFixture`; 2–3 rows each with correct values)
- Write attempt via `sql` fails by construction: ✅ (test:
  `CREATE TABLE hack` → rejects with `/read[- ]only|query_only|attempt to write/i`)
- Query without LIMIT gets `LIMIT 500` injected: ✅ (test: 501 rows →
  `rowCount: 500`, `truncated: true`)
- Runaway query killed at 3s timeout: ✅ (tested in `test/sql-guard.test.ts`
  from slice 8; tool delegates to `guardedQuery`)
- Tool registered alongside `submit_feedback` without collision: ✅
  (explicit test: `names.sort()` equals
  `["query_telemetry", "submit_feedback"].sort()`)

### Additional contract checks

- **Preset SQL not duplicated:** ✅ confirmed — zero SQL string literals in
  `src/query/tool.ts`; all preset execution routes through `runCanned`.
- **Async contract:** ✅ both `runCanned` and `guardedQuery` are awaited;
  `dbPath` is the first positional arg in both calls.
- **Both-params rejection:** ✅ `if (hasQuery && hasSql) throw new Error(
  "Provide either query or sql, not both.")`
- **Unknown preset lists valid presets:** ✅ `Unknown preset: ${query}.
  Valid presets: ${PRESET_NAMES.join(", ")}`
- **Truncation noted in responses:** ✅ `truncated: result.truncated` in the
  JSON payload returned to the agent.
- **Tool description steers to presets first:** ✅ "Use named presets
  (query) first: … For custom analysis, supply raw sql as a SELECT
  statement."

### Task doc update needed?

**Yes** — append to `## Implementation notes`:
- `query_telemetry` tool registered as `registerTelemetryTool(pi, t)` in
  `src/query/tool.ts`; coexists with `submit_feedback` (no collision).
- Two slice-8 canned queries (`turn_latency`, `ttft_by_model`) rewritten
  with window-function CTEs — original correlated subqueries failed in
  SQLite. Review percentile semantics at coherence time.
- `StringEnum` from `@earendil-works/pi-ai` is available but unused;
  `Type.String` + runtime validation used instead (coherence candidate).
- `state.yaml` accidentally committed by TDD worker (recurring issue —
  consider `.gitignore`).

### User attention needed?

**No.** All acceptance criteria met (131/131 tests, tsc clean). The
canned.ts fix is a justified blocking bug fix (slice 8 shipped broken SQL
for a preset this slice requires). The `StringEnum` misdiagnosis is a minor
coherence candidate. Nothing changes the published API surface or affects
downstream slices.
