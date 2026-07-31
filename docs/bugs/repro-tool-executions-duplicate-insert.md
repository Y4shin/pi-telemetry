# Reproduction — tool_executions duplicate INSERT / UNIQUE violation

## Symptom (live DB)

`telemetry_meta` has 457 `write_failed` rows, all
`UNIQUE constraint failed: tool_executions.tool_call_id`, across 3 sessions:

| session_id                          | failures | committed rows |
|-------------------------------------|----------|----------------|
| 019fb793-c2f0-7e95-88c1-c66a94cd59d3 | 289      | 0 (not even in `sessions`) |
| 019fb504-1c82-7997-8abf-4ddc2fb55241 | 96       | 0 (not even in `sessions`) |
| 019fb79c-4e4a-721a-b67c-5ad24cc3d2fa | 72       | 0 (not even in `sessions`) |

Each affected session has **ZERO** rows in `tool_executions`, `turns`,
`llm_requests`, `session_events`, AND `sessions` — only `telemetry_meta`
survived. `flush_log` has no rows for them (no flush ever committed). This is
**total data loss**, not a few dropped rows.

## Root cause (two intertwined defects)

### Defect 1 — buffer catastrophe (`src/buffer.ts`)

`flush()` wraps the whole batch in one transaction and, on ANY statement
error, re-enqueues the ENTIRE batch:

```ts
try {
  db.exec("BEGIN IMMEDIATE");
  for (const stmt of batch) {
    db.prepare(stmt.sql).run(...stmt.params);   // one fails => whole tx rolls back
  }
  db.exec("COMMIT");
} catch (err) {
  buffer.unshift(...batch);                      // re-enqueue EVERYTHING
  ...
  recordMeta("error", "write_failed", detail);
  return;
}
```

A single duplicate `tool_call_id` INSERT (PK `UNIQUE` violation) rolls back
**all** statements in the batch — including the unrelated `session`, `run`,
`turn`, and other-tool rows — and the batch is retried on every subsequent
flush, failing the same way forever. `recordMeta` writes via its OWN
transaction, so the errors log even while the main buffer is permanently
stuck. Everything enqueued after the poison is lost on session close.

### Defect 2 — duplicate source (`src/capture/tools.ts`)

The insert dedup is module-level in-memory:

```ts
const inFlightTools = new Map<string, InFlightTool>();
const stagedResults = new Map<string, StagedResult>();
const completedToolCallIds = new Set<string>();
```

These do NOT survive across processes. When a session is resumed/replayed in
a fresh process (e.g. pi restart resuming a session and replaying the
conversation, including already-executed tool calls), already-recorded
`tool_call_id`s are re-emitted. The empty `completedToolCallIds` lets the
INSERT through, colliding with the prior-process row → Defect 1's poison.

The within-process dedup itself is correct (covered by
`test/tools.test.ts`: duplicate `tool_execution_end` → single row). The gap
is purely cross-process / replay.

## Reproduction (L1, confirmed)

`repro-duplicate-insert.ts` simulates the trigger and demonstrates the
catastrophe:

1. Pre-seed the DB with a prior-process recording: a `sessions` row
   (`sess-prior`) + a `tool_executions` row (`tc-replayed`).
2. Fresh `createBuffer` (module-level `completedToolCallIds` is empty).
3. Register capture; fire `session_start` (new `sess-new`), run/turn setup.
4. Fire `tool_execution_start`/`tool_execution_end` for the **replayed**
   `tc-replayed` (collides with the pre-seeded row) AND for a brand-new,
   valid `tc-new`.
5. `t.flush()`.

### Result (bug present → test is RED)

```json
{
  "tc_new_committed": 0,      // expected 1 → FAILS
  "sess_new_committed": 0,    // expected 1 → FAILS
  "write_failed_rows": 1,     // expected 0 → FAILS
  "flush_log_rows": 0         // expected 1 → FAILS
}
```

The test asserts healthy behavior and fails on `tc-new should have
committed` (`0 !== 1`). That red state is the reproduction (it proves the
bug exists). After the fix, all four assertions pass (green).

```bash
cd /home/pplattner/Projects/pi-telemetry
node --test docs/bugs/repro-duplicate-insert.ts
# ✖ one replayed tool_call_id poisons the whole batch and loses everything
#   AssertionError: tc-new should have committed  (0 !== 1)
```

## Verdict

**Confirmed.** Both defects reproduce. This is `major`→ effectively
`critical` in impact: a single replayed tool call silently destroys the
entire session's telemetry.

## Fix direction (for the task)

Two layers must become resilient:

1. **Buffer** — on a batch flush failure, do NOT blindly re-enqueue the whole
   batch forever. Options: retry statements individually and commit the
   valid ones while dropping/logging the offender; or cap retries; or both.
   A single bad row must never block unrelated rows.
2. **Capture idempotency** — make `tool_executions` (and other natural-key
   tables) inserts idempotent across processes: `INSERT OR IGNORE` /
   `INSERT ... ON CONFLICT(tool_call_id) DO NOTHING`, so a replayed
   `tool_call_id` no-ops instead of raising. (Caveat to weigh in the task:
   this silently drops a genuinely-different tool call that reuses an ID —
   but that is strictly better than total session loss.)

Regression test: the L1 repro above, re-asserted to expect `tc-new` committed
(1), `sess-new` committed (1), `write_failed` absent, and no infinite retry.
