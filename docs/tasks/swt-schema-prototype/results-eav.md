# swt-schema-prototype — EAV extension results

Prototype task: `swt-schema-prototype` (type: prototype)
Script: `docs/tasks/swt-schema-prototype/bench-eav.mjs` (throwaway, pure
`node:sqlite`, temp DBs only, never touches the live DB).
Run: 2026-08-03, Node v24.18.0.

## Why this extension

The first benchmark (`results.md`) decided between generated VIRTUAL columns
(Option A) and a fixed-column N:1 join table (Option B), and recommended A.
But generated columns are **per-key, fixed at migration time**: a new payload
key needs a new `ALTER … ADD COLUMN … VIRTUAL` + `CREATE INDEX` to be
queryable. The user flagged this as overfit to a specific workflow and asked
for a **universal, migration-free** schema that supports arbitrary typed
metadata. This extension benchmarks two EAV (entity-attribute-value) variants
that never need a migration for new keys, against Option A as the baseline.

## Approaches

- **A — generated VIRTUAL columns + indexes** (baseline from `results.md`).
  Fixed keys; new key → migration. Single source of truth = JSON payload.
- **C — typed EAV (5 tables).** `session_event_metadata(event_id, key, type)`
  + four typed value tables (`metadata_string/int/float/bool`) keyed by
  `metadata_id`. New keys = new rows, no migration. Type-correct range
  queries via the matching typed table.
- **D — sparse EAV (1 table + CHECK).** `session_event_metadata(event_id, key,
  type, value_text, value_int, value_real, value_bool)` with `PRIMARY KEY
  (event_id, key)` and a **CHECK constraint**: exactly one `value_*` column
  non-null AND it must match `type`:
  - `type='string'` ⇒ `value_text` set, others null
  - `type='int'` ⇒ `value_int` set, others null
  - `type='float'` ⇒ `value_real` set, others null
  - `type='bool'` ⇒ `value_bool` set, others null
  New keys = new rows, no migration. Indexes on `(key, value_text)` and
  `(key, value_int)` for the common query shapes.

## Pivot compare-versions query

The honest multi-key cost: filter by `skills_package_version`, group by
`skill_name`, join to `turns` on `run_id` → `tool_executions` on `turn_id`.
This selects **3 keys** (not 1) — the real cost EAV exists to serve. Each event
has 5 metadata keys (`skill_name`, `skills_package_version`, `target`,
`run_id`, `slice_count[int]`). Each `skill_invoke` = 1 run of 10 turns, 3
tools/turn (~10% error). Median over 50 warmed runs.

## CHECK constraint verification (Option D)

**PASS.** Valid rows accepted (string, int); malformed rows rejected with
`CHECK constraint failed`:
- `type='string'` but `value_int` set → rejected ✓
- `type='int'` but `value_text` set → rejected ✓
- two `value_*` cols non-null → rejected ✓
- all `value_*` cols null → rejected ✓

The integrity rule (exactly one value column non-null, matching `type`) is
enforced by SQLite at insert/update time.

## Results

### N = 1,000 skill_invoke rows (10,000 turns, 30,000 tools)

| Approach | correct | apply (ms) | query (ms) | plan (pivot, 3 keys) |
|---|---|---|---|---|
| A (generated VIRTUAL cols) | ✓ | 17.4 | **4.9** | 3 index searches |
| C (typed EAV, 5 tables) | ✓ | 51.6 | 7.3 | 8 steps (covering idx + PK lookups + 2 typed-table joins) |
| D (sparse EAV, 1 table + CHECK) | ✓ | 29.1 | 7.4 | 5 index searches |

### N = 10,000 (100,000 turns, 300,000 tools)

| Approach | correct | apply (ms) | query (ms) | plan |
|---|---|---|---|---|
| A (generated VIRTUAL cols) | ✓ | 58.1 | **60.0** | 3 index searches |
| C (typed EAV, 5 tables) | ✓ | 333.3 | 91.5 | 8 steps |
| D (sparse EAV, 1 table + CHECK) | ✓ | 230.3 | 93.1 | 5 index searches |

### N = 100,000 (1,000,000 turns, 3,000,000 tools)

| Approach | correct | apply (ms) | query (ms) | plan |
|---|---|---|---|---|
| A (generated VIRTUAL cols) | ✓ | 568.5 | **667.3** | 3 index searches |
| C (typed EAV, 5 tables) | ✓ | 4056.8 | 1079.7 | 8 steps |
| D (sparse EAV, 1 table + CHECK) | ✓ | 2675.7 | 1088.4 | 5 index searches |

## Observations

1. **All three are index-backed and return correct results** (5 grouped rows).
   `EXPLAIN QUERY PLAN` shows `SEARCH … USING INDEX` at every step for all
   three — no full scans even at 100k.

2. **Query speed: A is ~1.5× faster than the EAV variants** at 10k/100k
   (60 vs 91–93 ms at 10k; 667 vs 1080–1088 ms at 100k). The EAV pivot needs
   2–5 extra joins to reassemble the wide row from tall data. Honest cost of
   universality.

3. **Apply/write cost: A is far cheaper.** Building the queryable structure
   takes 568 ms (A) vs 2676 ms (D) vs 4057 ms (C) at 100k — because EAV writes
   **5 metadata rows + 5 typed rows (C) or 5 sparse rows (D) per event** vs A's
   zero extra writes (generated columns are lazy). At write time the capture
   handler would do 1 insert (A) vs ~10 (C) vs 5 (D) per invocation.

4. **C vs D: D is the clear winner among EAV.** D (sparse, 1 table) has the
   same query speed as C (typed, 5 tables) but is ~40% cheaper to populate
   (2676 vs 4057 ms at 100k) and uses **one table, not five** — less DDL, less
   join machinery, simpler queries. The CHECK constraint gives D the same
   type integrity C's separate tables provide. C's only advantage (pure
   type separation per value table) does not justify 5 tables.

5. **At 100k rows all three are sub-1.1-second** for the pivot query. For
   context, the live DB has ~37 `session_events` rows today; reaching 100k
   skill invocations would take years at current rate. All three are
   comfortably performant for any realistic volume.

6. **The universality trade-off is real but bounded.** A is faster and
   cheaper but needs a migration per new *queryable* key. C/D never need a
   migration but cost ~1.5× query time and ~5–8× write cost. The question is
   how often new queryable dimensions actually appear.

## Chosen direction (recommendation)

**Option D — sparse EAV (1 table + CHECK constraint).**

Rationale:
- **Universal / not overfit** (the user's explicit goal). New metadata keys
  are new rows — never a schema migration. Any skill, any future telemetry
  dimension, any type (string/int/float/bool) is captured without touching
  the schema. This is the decisive factor over A.
- **Type integrity enforced.** The CHECK constraint guarantees exactly one
  value column is non-null and matches `type` — the same integrity C's
  separate typed tables provide, without 5 tables.
- **One table, simplest EAV.** D beats C on write cost and simplicity with
  identical query speed. The 5-table design (C) adds machinery for no gain.
- **Acceptable cost.** 1.5× slower queries and ~5× more writes than A, but
  both are sub-second at 100k and writes are batched by the existing buffer.
  The universality is worth it for a telemetry store meant to outlive any one
  workflow.
- **Clean separation.** `session_events` keeps the raw JSON `payload` (the
  unconstrained source of truth); `session_event_metadata` is the typed,
  queryable projection. A skill can stuff anything into `extra` in the
  payload; only keys projected into the metadata table are queryable, and
  the capture handler decides which keys to project (frontmatter
  `metadata.capture` + the `telemetry_skill_context` tool).

Rejected:
- **A (generated columns)** — faster and cheaper, but overfits to known
  keys; every new queryable dimension needs a migration. Wrong for a
  universal telemetry store. (Still the right choice if the dimension set
  were truly fixed and small — it isn't here.)
- **C (typed EAV, 5 tables)** — same universality as D but 5 tables, higher
  write cost, more complex queries, no query-speed advantage. D dominates it.
- **Baseline (bare json_extract)** — not performant (see `results.md`).

## Consequences for dependent tasks

- **Feature A slice 6 (`swt-queryability-schema`)**: implement Option D — a
  `user_version` migration creating `session_event_metadata(event_id, key,
  type, value_text, value_int, value_real, value_bool, PRIMARY KEY(event_id,
  key), CHECK(…))` + indexes `idx_sems_key_text(key, value_text)`,
  `idx_sems_key_int(key, value_int)`, plus `idx_turns_run ON turns(run_id)`.
  The CHECK constraint text is in `bench-eav.mjs` `EAV_SPARSE_SCHEMA`.
- **Feature A capture handler**: writes the JSON payload to `session_events`
  AND projects the declared keys into `session_event_metadata` rows (one row
  per key, typed). `run_id` is projected as a `string` key so the join works.
  The handler is the single writer that keeps payload + metadata in sync.
- **Feature B queries**: use the `QUERY_D` pivot shape (join `session_event_metadata`
  per key). The compare-versions query is the `QUERY_D` from `bench-eav.mjs`.
- **Write-path invariant**: the metadata inserts join the same buffered batch
  as the `session_events` insert (one transaction), preserving the
  `telemetry-write-resilience` invariant (batched fast-path + per-statement
  fallback; `INSERT OR IGNORE` on the `(event_id, key)` PK for replay
  idempotency).

## Newly discovered work for Wayfinder

- None. The prototype confirms Option D; no new tasks. The CHECK constraint
  and the projection-handler responsibility are captured in Feature A slice 6.
