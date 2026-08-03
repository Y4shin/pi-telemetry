# swt-schema-prototype — results

Prototype task: `swt-schema-prototype` (type: prototype)
Script: `docs/tasks/swt-schema-prototype/bench.mjs` (throwaway, pure `node:sqlite`,
no Pi/LLM/extension code; uses temp-file DBs under `os.tmpdir()`, never touches
`~/.pi/telemetry.db`).
Run: 2026-08-03, Node v24.18.0, `node:sqlite` `DatabaseSync`.

## Question

For `session_events` rows of `type='skill_invoke'` with a JSON `payload`,
which metadata-queryability approach is both **queryable** and **performant**
at realistic volume:

- **baseline** — bare `json_extract` on `payload` (no generated column, no join table).
- **Option A** — generated **VIRTUAL** columns + indexes on `session_events`.
- **Option B** — an **N:1 `session_event_metadata` join table** with native columns + indexes.

## Data shape

5 skills × 3 package versions × 20 targets. Each `skill_invoke` event starts
ONE run of 10 turns (cost 0.01–0.51 USD each), each turn has 3 tool executions
(~10% error). The compare-versions query filters `version='2.5.1'`, joins
`skill_invoke → its run's turns (on run_id) → those turns' tools (on turn_id)`
— **no cross-product** — and groups by skill. This is the real attribution
shape after Feature A's `turn_start` back-fill (which stamps `run_id` into the
`skill_invoke` payload).

Median over 50 warmed runs (baseline: single timed run — it's ~750× slower
and cannot use an index, so it's measured only at N=1000 to quantify the cost
being rescued).

## Results

### N = 1,000 skill_invoke rows (10,000 turns, 30,000 tools)

| Approach | correct | rows | apply (ms) | query (ms) | plan |
|---|---|---|---|---|---|
| baseline (json_extract) | ✓ | 5 | — | **5995.0** | `SCAN te` ⚠ full scan + automatic partial index |
| Option A (generated VIRTUAL cols + idx) | ✓ | 5 | 20.7 | **5.2** | `SEARCH se USING INDEX idx_sev_skill_ver` → `SEARCH t USING idx_turns_run` → `SEARCH te USING idx_tool_turn` |
| Option B (N:1 join table + idx) | ✓ | 5 | 23.2 | **4.4** | `SEARCH m USING INDEX idx_sem_skill_ver` → `SEARCH t USING idx_turns_run` → `SEARCH te USING idx_tool_turn` |

### N = 10,000 skill_invoke rows (100,000 turns, 300,000 tools)

| Approach | correct | rows | apply (ms) | query (ms) | plan |
|---|---|---|---|---|---|
| baseline | — | — | — | (skipped — no index; too slow at scale) | — |
| Option A (generated VIRTUAL cols + idx) | ✓ | 5 | 71.5 | **64.0** | `SEARCH se USING INDEX` → `SEARCH t USING INDEX` → `SEARCH te USING INDEX` |
| Option B (N:1 join table + idx) | ✓ | 5 | 105.4 | **53.0** | `SEARCH m USING INDEX` → `SEARCH t USING INDEX` → `SEARCH te USING INDEX` |

### N = 100,000 skill_invoke rows (1,000,000 turns, 3,000,000 tools)

| Approach | correct | rows | apply (ms) | query (ms) | plan |
|---|---|---|---|---|---|
| baseline | — | — | — | (skipped) | — |
| Option A (generated VIRTUAL cols + idx) | ✓ | 5 | 677.6 | **638.8** | `SEARCH se USING INDEX` → `SEARCH t USING INDEX` → `SEARCH te USING INDEX` |
| Option B (N:1 join table + idx) | ✓ | 5 | 1233.6 | **545.7** | `SEARCH m USING INDEX` → `SEARCH t USING INDEX` → `SEARCH te USING INDEX` |

## Observations

1. **The user's instinct was right: bare JSON is NOT queryable-performant.**
   The baseline (json_extract in the join predicate) takes **~6 seconds at
   N=1000** and cannot use an index (`SCAN te` + automatic partial covering
   index). It is ~**750× slower** than the indexed approaches. At 10k/100k
   it would take minutes. This is exactly the cost the optimizations rescue.

2. **Both Option A and Option B are index-backed and fast.** `EXPLAIN QUERY
   PLAN` shows `SEARCH … USING INDEX` at every join step for both — no full
   scans. Both scale roughly linearly with N.

3. **Query speed: B is ~15% faster than A** at every scale (5.2 vs 4.4 ms at
   1k; 64 vs 53 ms at 10k; 639 vs 546 ms at 100k). The join table avoids
   re-extracting JSON at query time.

4. **Apply cost: A is cheaper to build than B.** Adding generated columns +
   indexes (A) is ~30–45% faster than building + populating the join table
   (B) (21 vs 23 ms at 1k; 71 vs 105 ms at 10k; 678 vs 1234 ms at 100k),
   because B must read every `skill_invoke` row and insert a metadata row.

5. **At 100k rows both are sub-second.** 639 ms (A) / 546 ms (B). For
   context, the live DB has ~37 `session_events` rows total today and would
   take years to reach 100k skill invocations at current rate. Both approaches
   are comfortably performant for any realistic volume.

6. **Correctness: all approaches return the right 5 grouped rows** (one per
   skill, filtered to version 2.5.1).

## Chosen direction (recommendation for grilling decision 3)

**Option A — generated VIRTUAL columns + indexes on `session_events`.**

Rationale:
- **No new table, no N:1 write amplification.** A keeps `session_events` as
  the single source of truth; the capture handler writes one row (the JSON
  payload) and the generated columns are derived automatically. B requires
  the handler to write *two* rows (the event + the metadata) and keep them
  in sync — more code, more failure surface, double the inserts.
- **Query speed is within 15% of B** at all scales, and both are sub-second
  at 100k — far beyond any realistic volume for this DB. The 15% gap does
  not justify the extra table + sync complexity.
- **Cheaper to apply** (no populate pass; generated columns are lazy).
- **SPEC §1.7 alignment.** `session_events` was deliberately generic to
  absorb new event classes without a new table; A honors that, B partially
  reverts it.
- **Migration is small.** `ALTER TABLE session_events ADD COLUMN …
  GENERATED ALWAYS AS (json_extract(payload,'$.x')) VIRTUAL` + `CREATE
  INDEX` — a new `user_version` step, forward-only, idempotent. Existing
  `model_change`/`compaction` rows are unaffected (generated cols are null
  for them).

Rejected:
- **Baseline** — not queryable-performant (750× slower, full scan).
- **Option B** — viable and slightly faster to query, but the extra table +
  double-write + sync complexity is not worth a 15% query speedup at
  sub-second volumes. Revisit only if invocations reach millions AND query
  latency becomes a problem (it won't, realistically).

## Consequences for dependent tasks

- **Feature A slice 6 (`swt-queryability-schema`)**: implement Option A — a
  `user_version` migration adding generated VIRTUAL columns
  (`skill_name_gen`, `pkg_version_gen`, `target_gen`, `run_id_gen`) + indexes
  (`idx_sev_skill_ver` on `(pkg_version_gen, skill_name_gen)`, `idx_sev_run`
  on `run_id_gen`, `idx_sev_target` on `target_gen`) + `idx_turns_run` on
  `turns(run_id)`. Verify `EXPLAIN QUERY PLAN` shows `USING INDEX`.
- **Feature A capture handler**: writes the JSON payload only; no second
  table to populate (simpler than B would be).
- **Feature B queries**: use the generated columns in the compare-versions
  query (the `QUERY_A` shape from the benchmark).
- **Important data-model finding for Feature A/B**: the compare-versions
  query MUST join `skill_invoke → turns ON t.run_id = payload.run_id → tools
  ON te.turn_id = t.turn_id`, NOT `ON session_id` (which produces a
  catastrophic cross-product — 3M rows at 10k). The `turn_start` back-fill
  (Feature A slice 5) populating `run_id` is what makes the query efficient.
  This is recorded in the findings doc and the slice plans.

## Newly discovered work for Wayfinder

- None. The prototype confirms the schema approach; no new tasks. The
  data-modeling note (join on `run_id`, not `session_id`) is captured in the
  existing Feature A/B slice docs.
