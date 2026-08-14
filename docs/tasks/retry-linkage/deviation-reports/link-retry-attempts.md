## Deviation report — link-retry-attempts

### API surface changes
- **Planned:** `llm_requests.attempt INTEGER` (nullable, default NULL for legacy, 1 for first request in a new turn), populated from a turn-scoped counter in `RuntimeState`, reset on `turn_start`, incremented on `message_start`. A `query_telemetry` preset (`retry_count`) exposing inferred retry counts per model. `SPEC.md` §1.4 updated with the inference note + limitation. Migration v6 via `addColumnIfMissing`.
- **Actual:** Exactly what was planned. `src/state.ts` adds `attempt: number` (init 0). `src/capture/turns.ts:24` resets `t.state.attempt = 0` on `turn_start`. `src/capture/llm.ts:77` increments `t.state.attempt += 1` before the INSERT (first request = 1). The INSERT adds `attempt` as the 19th column/value. Migration v6 in `src/db.ts` uses `addColumnIfMissing` (idempotent). `retry_count` preset added to `src/query/canned.ts` + registered in `src/query/tool.ts` PRESET_NAMES + description string. `SPEC.md` §1.4 has the full inference note (internal `auto_retry_*` not extension-facing; query-time `attempt > 1 AND prior_stop_reason = 'error'` classification; tool-use exclusion; retry-after-tool-use limitation).
- **Impact:** None on dependent slices — no downstream slice in this task or the map consumes `attempt`. The `grill-pluggable-parser` / `error-raw-capture` tasks are independent and don't read it.

### Abstraction usage
- **RuntimeState counter:** ✅ Used — `attempt: number` field in `RuntimeState` interface + `createRuntimeState()` init 0, matching the existing `turnId`/`turnIndex` pattern.
- **turn_start reset:** ✅ Used — `t.state.attempt = 0` in `turns.ts` alongside `t.state.turnId`/`turnIndex` assignment.
- **message_start increment:** ✅ Used — `t.state.attempt += 1` before the INSERT in `llm.ts`, so the first request is `attempt = 1`.
- **Migration v6 via addColumnIfMissing:** ✅ Used — migration version 6, `apply(db)` calls `addColumnIfMissing(db, "llm_requests", "attempt", "INTEGER")`, matching migration 4's pattern. The `sql` field also has the `ALTER TABLE` statement (for the non-apply path), consistent with existing migrations.
- **L1-stub / llm.test.ts harness:** ✅ Used — the new test reuses `createL1Stub`, `createBuffer`, `makeConfig`, `fakeAssistantMessage`, and `setupSessionRunTurn`.

### Out-of-scope changes
- **`parent_request_id` / `attempt_group_id`:** ✅ Not added — the arch spec explicitly rejected these (Option B/C from research findings Q4). Only `attempt` was implemented.
- **Capture-time retry classification:** ✅ Not implemented — the counter records the neutral fact (position in turn). Retry classification is query-time only, in the `retry_count` preset SQL (`WHERE attempt > 1 AND prior_stop_reason = 'error'`). Matches the arch spec's "Do NOT reimplement" directive.
- **Upstream Pi event hook:** ✅ Not attempted — no `auto_retry_*` capture.
- **Backfill of historical rows:** ✅ Not done — legacy rows stay `attempt = NULL` (verified by the db.test.ts v5→v6 migration test asserting `row.attempt === null`).
- **No out-of-scope additions detected.** The diff touches only the 10 files listed and all changes are within the spec's scope.

### Divergence from slice doc acceptance criteria

| Criterion | Status | Notes |
|---|---|---|
| Migration adds column nullable; capture populates it | ✅ Met | Migration v6 adds nullable `attempt`; `llm.ts` populates from counter |
| Heuristic implemented + reliability documented in SPEC §1.4 | ✅ Met | Counter is the heuristic; SPEC §1.4 has the full inference note + limitation |
| New unit test reproduces a retry scenario with linked rows / attempt counter | ✅ Met | `test/llm.test.ts` "increments attempt counter per message_start within a turn" — fires failed message_start→end (attempt=1, stop_reason=error), then retry message_start→end (attempt=2, stop_reason=stop), asserts same turn_id, attempt values, stop_reasons |
| Per-request attribution preserved (interleaved-concurrent test still passes) | ✅ Met | 239/239 tests pass, including the existing "does not cross-contaminate interleaved concurrent requests" test |
| query_telemetry preset exposes retry count per model | ✅ Met | `retry_count` preset in `canned.ts` + registered in `tool.ts`; `canned.test.ts` has a dedicated test asserting error→success counts as retry, tool-use continuations excluded |
| SPEC.md §1.4 updated | ✅ Met | Full inference note added (provenance, query-time classification, tool-use exclusion, retry-after-tool-use limitation) |

### Task doc update needed?
**No.** The implementation matches the arch spec and slice doc precisely. No API surfaces diverged; no scope widened; no abstraction was replaced. The task doc's `## Architecture notes` / `## Implementation notes` do not need updating from this slice's outcome.

### User attention needed?
**No.** No scope changed, no API surfaces differ from the spec, no out-of-scope work was added. The implementation is a faithful realization of the arch spec.

### Minor observations (non-blocking)

1. **Migration `sql` + `apply` dual definition:** Migration 6 defines both a `sql` string (`ALTER TABLE llm_requests ADD COLUMN attempt INTEGER;`) and an `apply` function (`addColumnIfMissing`). The `openDatabase` logic runs `apply` if present, else `db.exec(sql)`. Since `apply` is present, `sql` is never executed — it's documentation-only. This is consistent with migration 4's pattern (which also has both), so it's a project convention, not a deviation.

2. **`retry_count` preset SQL uses a template comment for filters:** `-- {{since:started_unix_ms}}` and `-- {{model:model}}` are SQL comments, not actual parameterized filters. This matches the existing preset pattern in `canned.ts` (other presets use the same `{{key:column}}` comment convention), so the filters are applied by the `query_telemetry` tool's parameter-injection logic. Consistent with the codebase, not a deviation.

3. **SPEC §1.4 schema block:** The `attempt` column is added to the §2 schema block (line 241) in addition to the §1.4 prose. Both are consistent with the arch spec.
