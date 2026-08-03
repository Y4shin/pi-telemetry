---
kind: slice
slug: swt-queryability-schema
title: "Apply prototype-chosen queryability approach (generated columns+indexes OR session_event_metadata join table) via user_version migration"
task: ../task.md
mode: afk
status: todo
size: m
blocked_by: []
---

## End-to-end behavior

**Lands first.** Apply the queryability approach chosen from the
`swt-schema-prototype` EAV-extension results: **Option D — sparse EAV**
(`session_event_metadata`, 1 table with a CHECK constraint). Create the table
via a new `PRAGMA user_version` migration, and expose a shared
`insertSkillMetadata(t, eventId, key, type, value)` helper (in
`src/capture/skills.ts` or a small `src/capture/skill-metadata.ts`) that the
other data slices call to project a key into a metadata row. The
compare-versions query (Feature B) joins `session_event_metadata` per key
and must use an index (`EXPLAIN QUERY PLAN` shows `USING INDEX`).

This slice owns the schema + the single projection helper so the data slices
don't each re-implement it.

## Acceptance criteria

- A new `user_version` migration creates:
  ```sql
  CREATE TABLE IF NOT EXISTS session_event_metadata (
    event_id   TEXT NOT NULL REFERENCES session_events(event_id),
    key        TEXT NOT NULL,
    type       TEXT NOT NULL,   -- 'string'|'int'|'float'|'bool'
    value_text TEXT,
    value_int  INTEGER,
    value_real REAL,
    value_bool INTEGER,
    PRIMARY KEY (event_id, key),
    CHECK (
         (type = 'string' AND value_text IS NOT NULL AND value_int IS NULL AND value_real IS NULL AND value_bool IS NULL)
      OR (type = 'int'    AND value_int  IS NOT NULL AND value_text IS NULL AND value_real IS NULL AND value_bool IS NULL)
      OR (type = 'float'  AND value_real IS NOT NULL AND value_text IS NULL AND value_int  IS NULL AND value_bool IS NULL)
      OR (type = 'bool'   AND value_bool IS NOT NULL AND value_text IS NULL AND value_int  IS NULL AND value_real IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_sems_key_text ON session_event_metadata(key, value_text);
  CREATE INDEX IF NOT EXISTS idx_sems_key_int  ON session_event_metadata(key, value_int);
  CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id);
  ```
- The CHECK constraint rejects malformed rows (verified in `bench-eav.mjs`):
  type/value mismatch, two value cols non-null, all value cols null.
- A shared `insertSkillMetadata(t, eventId, key, type, value)` helper is
  exported and enqueues an `INSERT OR IGNORE INTO session_event_metadata …`
  row (typed by `type`) into the same buffer as `session_events` writes. It
  maps JS `string`→`value_text`, `number`→`value_int`/`value_real` by
  `Number.isInteger`, `boolean`→`value_bool`.
- `EXPLAIN QUERY PLAN` for the pivot compare-versions query (`QUERY_D` from
  `bench-eav.mjs`) shows `SEARCH … USING INDEX` at every step.
- Existing `session_events` rows (model_change, compaction) are unaffected.
- The migration is a new numbered `user_version` step in `src/db.ts`,
  idempotent, forward-only.
- `npm test` green, `tsc --noEmit` clean.

## Test plan

- Seams: `test/db.test.ts` migration test; `test/helpers/fixture-db.ts`.
- Failure modes: migration on a DB with existing session_events rows;
  re-running migration (idempotent); migration on a fresh DB; CHECK constraint
  rejects a malformed metadata row (assert the insert raises).
- Scenarios: `EXPLAIN QUERY PLAN` assertion for the indexed pivot query;
  compare-versions query returns correct grouped rows; a new key with no
  prior planning still inserts (universality).
- Edge cases: metadata row absent for non-skill events; `run_id` projected as
  `string` so the join to `turns` works.

## Constraints and dependencies

- The prototype is DONE (user chose Option D); this slice is unblocked.
- **Lands first** — the data slices (1–5) depend on its `insertSkillMetadata`
  helper to project metadata rows.
- Follow SPEC §8 migration rules (forward-only, idempotent).
- The helper writes metadata rows via the same buffer (preserves the
  `telemetry-write-resilience` invariant: batched fast-path + per-statement
  fallback; `INSERT OR IGNORE` on `(event_id, key)` PK for replay idempotency).
