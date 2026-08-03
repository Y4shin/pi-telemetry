## Deviation report — swt-turn-start-backfill

### API surface changes

- **Planned (arch spec §Slice 5):** A `turn_start` handler in
  `registerSkillCapture` that back-fills `run_id`/`turn_id`/`turn_index`
  on the session's most-recent un-attributed `skill_invoke` row using the
  event_id stored in `t.state.lastSkillInvokeEventId` (arch-spec Q1
  decision). Also projects `run_id` as a metadata row via
  `insertSkillMetadata`. The UPDATE is
  `UPDATE session_events SET run_id=?, turn_id=?, turn_index=? WHERE event_id=?`.

- **Actual:** The `turn_start` handler matches the spec exactly — reads
  `t.state.runId`, `t.state.turnId`, `t.state.turnIndex`, and
  `t.state.lastSkillInvokeEventId`; issues the exact UPDATE; calls
  `insertSkillMetadata(t, eventId, "run_id", "string", runId)`. Guarded by
  `guard()`. No-op when any of `sessionId`/`runId`/`turnId`/`eventId` is
  null. **No API surface deviation.**

- **However — unplanned schema migration (version 4):** The
  `session_events` table did not have `run_id`/`turn_id`/`turn_index`
  columns. The arch spec and slice doc both assume they exist (the slice
  doc's UPDATE references them; the arch spec's Slice 5 contract says
  "UPDATE session_events SET run_id=…"). The implementation added
  **migration version 4** to `src/db.ts` `MIGRATIONS` creating these three
  columns + two indexes (`idx_sev_run`, `idx_sev_turn`). This was necessary
  for the back-fill to execute — the columns are genuinely missing from the
  original schema (SPEC §2 `session_events` has only `event_id`, `session_id`,
  `unix_ms`, `type`, `payload`).

- **However — unplanned `Migration.apply` extension:** To keep
  `test/ddl-first-start.test.ts` (5 concurrent first-starts) green, the
  implementation added an optional `apply?(db: DatabaseSync) => void` field
  to the `Migration` interface in `src/db.ts`, plus an `addColumnIfMissing`
  helper that checks `PRAGMA table_info` before `ALTER TABLE ADD COLUMN`
  and tolerates benign "duplicate column name" races. Migration 4 uses
  `apply` instead of raw `sql` because `ALTER TABLE ADD COLUMN` is not
  `IF NOT EXISTS`-safe and would flake under concurrent first-starts.

- **Impact on dependent slices:** Slice 4 (`swt-telemetry-skill-context-tool`)
  depends on slice 5 and reads `run_id`/`turn_id` from `session_events` to
  match the most-recent `skill_invoke` row. Migration 4's new columns make
  that lookup possible. The `Migration.apply` interface change is additive
  (optional field; existing migrations 1–3 use `sql` and are unaffected).
  No downstream breakage.

### Abstraction usage

- **`t.state.runId` / `turnId` / `turnIndex`:** Used as specified (arch spec
  says "read them from `t.state`"; do not re-derive). Verified: the handler
  reads all three from `t.state`, set by `runs.ts`/`turns.ts` at
  `agent_start`/`turn_start`. ✓
- **`insertSkillMetadata` (slice 6):** Used as specified to project `run_id`
  as a metadata row (key `"run_id"`, type `"string"`). ✓
- **`guard()`:** Handler wrapped in `guard()`. ✓
- **`t.state.lastSkillInvokeEventId` (arch-spec Q1):** Used as specified —
  the handler reads it and does NOT do a DB lookup. Set by slice 1 at `input`
  time. ✓
- **`INSERT OR IGNORE` / `INSERT OR IGNORE` on `(event_id, key)`:** The
  `insertSkillMetadata` call uses it (slice 6 helper). The back-fill itself
  is an UPDATE, not an insert — no idempotency concern. ✓

### Out-of-scope changes

1. **Migration version 4 (new columns on `session_events`):** The arch spec
   did not anticipate that `session_events` needed `run_id`/`turn_id`/
   `turn_index` columns. The original SPEC §2 `session_events` schema has
   only `event_id`, `session_id`, `unix_ms`, `type`, `payload`. The arch
   spec's Slice 5 contract and the slice doc both reference these columns
   as if they exist. This is a **planning gap in the arch spec**, not an
   implementation overreach — the columns are genuinely required for the
   back-fill to work. The migration is forward-only, idempotent (uses
   `addColumnIfMissing`), and existing rows get NULL for the new columns
   (SPEC §8 multi-version coexistence: "new columns are nullable or have
   defaults"). **Verdict: necessary and correct, but the arch spec should
   have specified it.**

2. **`Migration.apply` optional field + `addColumnIfMissing` helper:**
   The `Migration` interface gained an optional `apply` function. This is
   an additive change to the migration system — existing migrations are
   unaffected (they use `sql`; `apply` is checked only when present). The
   `addColumnIfMissing` helper is a private function in `src/db.ts`. The
   `openDatabase` loop now checks `if (migration.apply) { migration.apply(db) }
   else { db.exec(migration.sql) }`. **Verdict: reasonable engineering to
   solve a real concurrency problem** (`ALTER TABLE ADD COLUMN` is not
   concurrent-safe, and `test/ddl-first-start.test.ts` validates 5
   concurrent first-starts). However, it introduces a new code path in the
   migration system that future migrations could use — a minor scope
   expansion.

3. **`lastSkillInvokeEventId` not reset after back-fill:** The TDD report
   notes this explicitly. The arch spec's Slice 5 contract does not mention
   resetting it. The slice doc says "Two `/skill:` inputs before one turn:
   only the most-recent is back-filled" — the implementation achieves this
   because `lastSkillInvokeEventId` holds only the *most recent* event_id
   (slice 1 overwrites it on each `input`), so the back-fill naturally
   targets only the latest. A second `turn_start` in the same run would
   re-UPDATE the same row (idempotent — same values). **Verdict: no issue;
   behavior matches the documented edge case.**

### The two-invocations-before-one-turn edge case

- **Spec (slice doc + arch spec):** "Two `/skill:` inputs before a single
  turn: only the most-recent is back-filled (the older one stays null)."
- **Actual:** Tested in `test/capture/skills.test.ts` "back-fills only the
  most-recent of two skill inputs before one turn". Two `input` events fire
  (each sets `lastSkillInvokeEventId` to its own event_id, so the second
  overwrites the first). At `turn_start`, the back-fill UPDATEs the row
  matching `lastSkillInvokeEventId` (the second/newer one). The older row's
  `run_id`/`turn_id`/`turn_index` stay NULL. **Matches spec exactly.** ✓

### Acceptance criteria check

| Criterion | Status | Evidence |
|---|---|---|
| After `/skill:foo` + `turn_start`, `skill_invoke` row has `run_id`/`turn_id`/`turn_index` set | ✓ | Test "sets run_id/turn_id/turn_index on the most-recent skill_invoke row" asserts all three |
| A turn NOT preceded by `/skill:` does not touch any `skill_invoke` row | ✓ | Test "does not touch skill_invoke rows when no skill input preceded the turn" asserts 0 rows with non-null run_id |
| Two `/skill:` inputs before one turn: only most-recent back-filled | ✓ | Test "back-fills only the most-recent of two skill inputs before one turn" asserts older stays null |
| `npm test` green, `tsc --noEmit` clean | ✓ | 198 tests pass, tsc clean |

### Task doc update needed?

**Yes** — append to `## Implementation notes`:
- Migration version 4 added `run_id`/`turn_id`/`turn_index` columns to
  `session_events` (not anticipated by the arch spec; the original SPEC §2
  schema lacks them). The `Migration` interface gained an optional `apply`
  field for concurrent-safe conditional DDL. The arch spec's assumption that
  these columns exist was a planning gap; the implementation correctly
  filled it.
- The coherence-refactor queue (Step 3) should review whether the
  `Migration.apply` mechanism is the right long-term pattern or whether
  future migrations should prefer `CREATE TABLE IF NOT EXISTS` + view/trigger
  approaches to avoid `ALTER TABLE` concurrency issues.

### User attention needed?

**No** — the schema migration (version 4) and the `Migration.apply`
extension are necessary, correct, and don't change any API surface that
dependents call. The `run_id`/`turn_id`/`turn_index` columns are nullable
additions to `session_events` (SPEC §8 compliant). No user-judgment decision
is required; this is a routine implementation gap-fill.
