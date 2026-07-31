---
kind: slice
slug: duplicate-key-resilience
title: "Buffer poison resilience + natural-key idempotency"
task: ../task.md
mode: afk
status: done
size: l
blocked_by: []
started_at: 2026-07-31
---

# Buffer poison resilience + natural-key idempotency

Fix both intertwined defects from the bug doc so a single replayed /
constraint-violating row can no longer destroy a session's telemetry.

## Scope

### Defect 1 — buffer flush must not lose the whole batch (`src/buffer.ts`)

`flush()` currently wraps the whole batch in one `BEGIN…COMMIT` and, on any
statement error, does `buffer.unshift(...batch)` — re-enqueuing the ENTIRE
batch for retry. One failing statement rolls back all unrelated rows and
retries forever (the batch can never commit), so everything enqueued after
the poison is lost on session close.

Fix: a single failing statement must not prevent the other statements in
the batch (or later batches) from committing. Acceptable approaches (pick
one, justify in the deviation if added):

- Per-statement application: attempt each statement individually, commit
  the ones that succeed, and log+drop the offender(s) to `telemetry_meta`.
  Keeps the fast path batched (try the batch first; on failure, fall back
  to per-statement).
- Or: keep the batch transaction but on failure, replay statements one by
  one, skipping + logging the one that raised.

The key invariant: **no infinite retry**; a bad row is dropped (logged),
not re-enqueued forever.

### Defect 2 — natural-key INSERTs idempotent across processes (`src/capture/*`)

The capture dedup (`completedToolCallIds` etc. in `tools.ts`) is
module-level in-memory and does not survive across processes. A resumed
session replaying already-recorded keys re-emits them; the empty dedup lets
the INSERT through, colliding with the prior-process row.

Fix: make natural-key capture INSERTs idempotent — `INSERT OR IGNORE`
(equivalently `ON CONFLICT(<pk>) DO NOTHING`) for the natural-key tables:

- `tool_executions` (PK `tool_call_id`) — the proven trigger.
- `sessions` (PK `session_id`), `agent_runs` (PK `run_id`),
  `turns` (PK `turn_id`), `llm_requests` (PK `request_id`),
  `bash_executions` (PK `bash_id`), `session_events` (PK `event_id`),
  `feedback` (PK `feedback_id`).

The in-memory dedup stays as a fast path but is no longer the only defense.
`telemetry_meta` and `flush_log` are append-only autoincrement — leave as-is.

## Acceptance criteria

- A replayed `tool_call_id` (pre-seeded in a prior process) no-ops; the
  brand-new tool call in the SAME batch commits. No `write_failed` row.
  (This is the regression test from `repro.md`.)
- A flush batch containing one genuinely-unrecoverable statement (e.g. a
  row that violates a non-UNIQUE constraint) commits all OTHER rows in the
  batch; the offender is logged to `telemetry_meta` (`event=write_failed`)
  and dropped; no infinite retry (a second flush does not re-log the same
  row forever).
- All existing capture tests stay green (no behavior regression for the
  within-process dedup: duplicate `tool_execution_end` → single row).
- `npm run check` (tsc) clean; full `npm test` green.

## Test plan

- **Red-first regression test** (the test rule): convert
  `repro-duplicate-insert.ts` (next to `repro.md`) into a `test/` test
  asserting HEALTHY behavior — replayed `tool_call_id` no-ops, the new
  `tool_call_id` commits, the session row commits, no `write_failed`, a
  `flush_log` row exists, and a second flush stays clean. This is RED
  against the unfixed code (already verified: fails on
  `tc-new should have committed (0 !== 1)`), GREEN after the fix.
- **Buffer isolation test**: construct a batch where one statement is
  unrecoverable (e.g. INSERT violating a NOT NULL or FK that idempotency
  does NOT catch) and assert the other statements commit + the offender is
  logged + dropped + not retried forever.
- **Idempotency sweep**: for each natural-key table, pre-seed a row then
  re-fire the capture event in a fresh buffer; assert exactly one row, no
  `write_failed`.
- Re-run the full existing suite (`npm test`) — no regressions.

## Notes

- `INSERT OR IGNORE` silently drops a genuinely-different row that reuses a
  key. With UUID keys this is effectively impossible; the tradeoff (drop vs
  total session loss) clearly favors idempotency. Document in the deviation.
- Buffer resilience is the more general fix (protects against ANY statement
  error, not just UNIQUE); idempotency removes the observed trigger. Both
  land.
