## Deviation report — swt-queryability-schema

### API surface changes
- **Planned:** `insertSkillMetadata(t, eventId, key, type, value)` in
  `src/capture/skill-metadata.ts` with signature
  `(t: Telemetry, eventId: string, key: string, type: MetadataType, value:
  string | number | boolean | null): void`. Migration version 3 in
  `src/db.ts` `MIGRATIONS`.
- **Actual:** Signature matches exactly. Migration version 3 matches
  exactly (table + 3 indexes, CHECK constraint text identical to spec).
  Additionally, `insertSkillMetadata` and `MetadataType` are re-exported from
  `src/capture/index.ts` (the capture barrel file) — a convenience addition
  not specified in the arch spec, but consistent with the barrel-export
  pattern already used for all other capture modules. No signature change.
- **Impact:** None on dependent slices. Dependent slices (1–5) can import
  from either `src/capture/skill-metadata.ts` directly or
  `src/capture/index.ts`. The re-export is additive; no existing exports
  were changed.

### Abstraction usage
- Used/was specified: **yes** — all specified abstractions were used:
  - `src/db.ts` `MIGRATIONS` array + `PRAGMA user_version` gate: migration
    version 3 added as the third entry, mirroring migration 2's structure.
  - `Telemetry.enqueue()`: the helper enqueues `INSERT OR IGNORE` via
    `t.enqueue()`, same buffer as `session_events` writes. No custom flush
    path.
  - `src/state.ts` `guard()`: the helper wraps itself in `guard()`
    internally, matching arch-spec Q4 decision (helper-wraps). Self-guarded;
    callers need not wrap.
  - `INSERT OR IGNORE` on `(event_id, key)` PK for replay idempotency:
    confirmed in the SQL string and tested (replay idempotency test).

### Out-of-scope changes
- **Re-export from `src/capture/index.ts`**: the barrel file gained one line
  re-exporting `insertSkillMetadata` and `MetadataType`. This is a minor
  convenience addition; the arch spec specified the helper lives in
  `src/capture/skill-metadata.ts` (it does), and the re-export is
  consistent with the existing barrel pattern. Not a scope change.
- **Updated `test/db.test.ts` and `test/ddl-first-start.test.ts`**: existing
  tests had hardcoded `user_version === 2` assertions. These were updated
  to use `MIGRATIONS.length` (now 3) instead of a hardcoded number. The
  tests' intent (schema is applied, forward-only, idempotent) is preserved.
  This was expected and necessary — the slice introduces migration version
  3, so existing assertions needed to reflect the new count. The TDD worker
  correctly identified and updated them.
- **`undefined` handling in the helper**: the implementation checks
  `value === null || value === undefined` for the no-op skip, while the
  arch spec says `value=null` is a no-op. The type signature is
  `string | number | boolean | null` (no `undefined`), so this is a
  defensive measure that doesn't change the contract — `undefined` would
  only arrive from a caller bug, and skipping it is safer than letting it
  reach the CHECK constraint (which would reject it, but via a throw path
  that `guard()` would catch anyway). No impact.
- **`Number.isNaN` guard for `float` type**: the implementation rejects
  `NaN` floats with a meta note instead of inserting them. The arch spec
  says `number`→`value_int`/`value_real` by `Number.isInteger`; it doesn't
  mention `NaN`. Rejecting `NaN` is sound (storing `NaN` in a `REAL` column
  is technically valid in SQLite but semantically useless for queries).
  No impact; a reasonable defensive addition.
- **Exhaustiveness `default` case in the `switch`**: the implementation
  has a `default` branch that records a meta note for unknown `type` values.
  The arch spec's `MetadataType` union is `"string" | "int" | "float" |
  "bool"`, so at the type level this is unreachable. At runtime (if called
  with a cast) it's a defensive guard. No impact.

### Task doc update needed?
No. The `## Architecture notes` section in the task doc already records the
arch spec approval and the Q1–Q4 decisions. No update needed from this
slice's deviations — they are all minor/defensive additions that don't
change the interface contract or scope.

### User attention needed?
No. The deviations are:
1. A barrel re-export (convenience, consistent with existing pattern).
2. Existing test assertions updated to reflect the new migration count
   (expected and necessary).
3. Minor defensive additions (`undefined` skip, `NaN` guard, exhaustiveness
   default) that strengthen robustness without changing the contract.

None of these change the API surface, scope, or interface contract for
dependent slices. The CHECK constraint text, the `insertSkillMetadata`
signature, the migration version/DDL, and the `EXPLAIN QUERY PLAN` index
usage all match the spec exactly.
