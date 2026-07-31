---
kind: task
slug: telemetry-write-resilience
title: Telemetry write path resilience — survive replayed/duplicate keys without total data loss
description: |
  A single replayed `tool_call_id` (PK UNIQUE violation) poisons its entire
  flush batch: `src/buffer.ts` re-enqueues the whole batch on any statement
  error, so one bad row rolls back all unrelated rows and retries forever —
  total session telemetry loss. Live-DB proof: 3 sessions have 0 committed
  rows across every table (not even `sessions`), only `telemetry_meta`
  survived, and `flush_log` has no rows for them. Two intertwined fixes:
  (1) buffer flush must not lose the whole batch on one failing statement;
  (2) natural-key INSERTs must be idempotent across processes so a replayed
  key no-ops instead of raising. Bug doc: `docs/bugs/tool-executions-duplicate-insert.md`.
epic: null
type: bug
bug: tool-executions-duplicate-insert
slices:
- duplicate-key-resilience
status: done
started_at: 2026-07-31
---

# Telemetry write path resilience

**Bug doc:** `docs/bugs/tool-executions-duplicate-insert.md`
**Reproduction:** `repro.md` (next to this file) + `repro-duplicate-insert.ts`

## Outcome

The buffered write path must be resilient to a single bad statement: one
duplicate / malformed / constraint-violating row must never block unrelated
rows or silently destroy an entire session's telemetry. Replayed natural
keys (e.g. a `tool_call_id` re-emitted on session resume in a fresh
process) must no-op cleanly.

## User stories

- As a Pi user resuming a session, replayed tool calls / turns / requests
  must not corrupt or erase my telemetry — the store is append/idempotent
  for natural keys.
- As a telemetry consumer, a single failing INSERT must be logged and
  dropped, never roll back a whole batch or stall the buffer forever.

## Boundaries

- **In scope:** `src/buffer.ts` flush failure handling; natural-key INSERT
  idempotency across `src/capture/*`; regression test from `repro.md`.
- **Out of scope:** changing the schema (PKs stay); adding new tables;
  the cross-process `completedToolCallIds` in-memory dedup (stays as a
  fast-path, but must no longer be the only line of defense); the
  unrelated "97 missing tool_executions in session 019fb49e" anomaly
  (separate, unexplained — not this bug).

## Layers touched

- `src/buffer.ts` — flush() failure handling (primary).
- `src/capture/sessions.ts`, `runs.ts`, `turns.ts`, `llm.ts`, `tools.ts`,
  `bash.ts`, `session-events.ts`, `feedback.ts` — natural-key INSERTs.
- `test/` — regression test (converted from `repro-duplicate-insert.ts`).

## Slice

One default slice: `slices/1-duplicate-key-resilience.md`. May be split by
implement-task into (a) buffer resilience + (b) idempotency if the worker
struggles — the two defects are independent and separable.

## Implementation notes

### Slice `duplicate-key-resilience` (landed)

Both intertwined defects fixed in one slice:

1. **Buffer flush resilience (`src/buffer.ts`)** — `flush()` keeps the
   fast-path batched transaction, but on failure now rolls back and applies
   each statement individually. Healthy rows commit; offending rows are
   logged to `telemetry_meta` (`event = 'write_failed'`) and dropped. A bad
   row is no longer re-enqueued forever, so a single failing statement can
   no longer destroy a session's telemetry.

2. **Natural-key idempotency across processes (`src/capture/*`,
   `src/feedback.ts`)** — all natural-key INSERTs now use `INSERT OR IGNORE`
   (equivalent to `ON CONFLICT(<pk>) DO NOTHING`), so a replayed key from a
   resumed session no-ops instead of raising a UNIQUE violation. Tables
   updated: `tool_executions`, `agent_runs`, `turns`, `llm_requests`,
   `bash_executions`, `session_events`, `feedback`. `sessions` already used
   `INSERT OR IGNORE`. The in-memory dedup in `tools.ts` remains as a fast
   path.

**Tests:** `test/duplicate-key-resilience.test.ts` (4 tests) — replayed
`tool_call_id` does not poison the batch; buffer isolates an unrecoverable
statement; replayed `session_start` is idempotent; SQL audit that every
capture INSERT uses `INSERT OR IGNORE`.

**Deviations:**
- The idempotency sweep is covered by event-replay tests for
  `tool_executions` and `sessions` (tables whose natural keys arrive from
  SDK events) plus a SQL assertion test verifying every capture INSERT is
  `INSERT OR IGNORE`. Tables whose natural keys are generated inside the
  capture code (`agent_runs`, `turns`, `llm_requests`, `bash_executions`,
  `session_events`, `feedback`) cannot be replayed via event re-fire, so the
  SQL audit provides equivalent coverage.
- No new `MetaEvent` type was added; the fallback path logs per-statement
  failures under the existing `write_failed` event rather than introducing
  a `buffer_batch_failed` meta event.
- The original reproduction artifact
  `docs/tasks/telemetry-write-resilience/repro-duplicate-insert.ts` was
  left in place because it is referenced by the bug/task docs; the
  maintained regression test lives in `test/`.

**Validation:** `npm run check` clean; `node --test
test/duplicate-key-resilience.test.ts` pass 4 / fail 0; full `npm test` —
150 tests pass, 0 fail.

**Tradeoff note:** `INSERT OR IGNORE` silently drops a genuinely-different
row that reuses a key. With UUID keys this is effectively impossible; the
tradeoff (drop vs total session loss) favors idempotency.
