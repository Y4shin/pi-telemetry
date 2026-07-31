---
title: tool_executions INSERT fails UNIQUE on tool_call_id (duplicate inserts)
status: fixed
severity: major
reported: 2026-07-31
confirmed_by: L1 repro 2026-07-31
fix_commit: 0402641befd01c26126430909118a29fa7d11b36
promoted_to: telemetry-write-resilience
---

# tool_executions INSERT fails UNIQUE on tool_call_id (duplicate inserts)

## Observed

`telemetry_meta` contains **457 `write_failed`** rows, all with the same
detail:

```
UNIQUE constraint failed: tool_executions.tool_call_id
```

Spread across 3 sessions:

| session_id                          | failures |
|-------------------------------------|----------|
| 019fb793-c2f0-7e95-88c1-c66a94cd59d3 | 289      |
| 019fb504-1c82-7997-8abf-4ddc2fb55241 | 96       |
| 019fb79c-4e4a-721a-b67c-5ad24cc3d2fa | 72       |

The failures are **spread over ~4-5 minutes within each session** (not a
single instantaneous burst), indicating the same `tool_call_id` reaches
`INSERT` more than once during normal operation — a systematic
double-insert, not a one-off retry.

Note: this is a **different** set of sessions from the "97 turns with tools
but 0 `tool_executions`" anomaly (which is session `019fb49e`). The two
symptoms are likely different root causes; this bug covers only the
duplicate-INSERT / UNIQUE-violation symptom.

## Expected

No UNIQUE constraint violations on `tool_executions.tool_call_id`, and no
`write_failed` rows for this constraint. Telemetry's contract is "never
drop data / never break the session," yet writes are silently failing.

## Reproduction

### Live DB (already confirmed)

```bash
cd ~/.pi/telemetry-eval && uv run python -c "
from telemetry_eval import connect
import pandas as pd
con = connect()
print(pd.read_sql_query(
  \"SELECT session_id, COUNT(*) AS n FROM telemetry_meta WHERE event='write_failed' GROUP BY session_id ORDER BY n DESC\",
  con).to_string(index=False))
"
# -> 3 sessions, 457 total, all 'UNIQUE constraint failed: tool_executions.tool_call_id'
```

### In-repo (code trace + L1 + L2)

1. **Code trace** — read `src/capture/tools.ts` (the `completedToolCallIds`
   dedup guard around `insertToolExecution`) and `src/buffer.ts` (whether
   committed rows are drained after a flush, or re-enqueued/re-flushed) to
   find the path by which a `tool_call_id` reaches `INSERT` twice.
2. **L1 unit test** — emit the triggering event sequence via
   `test/helpers/l1-stub.ts` and assert exactly one `tool_executions` row
   and **no** `telemetry_meta` `write_failed` row. Currently red.
3. **L2 SDK session** — drive a tool call through `test/helpers/l2-session.ts`
   with `fauxProvider` and confirm no `write_failed` row appears.

See `docs/tasks/telemetry-write-resilience/repro.md` for the exact scripts
and the root-cause trace (moved next to the task on promotion).

## Suspected area

`src/capture/tools.ts` (the `completedToolCallIds` / `inFlightTools` dedup
guard around `insertToolExecution`) and/or `src/buffer.ts` (rows not drained
after a committed flush, causing re-insert on a subsequent flush).

## Root cause

**Two intertwined defects, both reproduced.**

### Defect 1 — buffer catastrophe (`src/buffer.ts`)

`flush()` wraps the whole batch in one transaction and, on ANY statement
error, re-enqueues the ENTIRE batch via `buffer.unshift(...batch)`. A single
duplicate `tool_call_id` INSERT (PK `UNIQUE` violation) rolls back **all**
statements in the batch — including the unrelated `session`/`run`/`turn`/
other-tool rows — and the batch is retried on every subsequent flush,
failing the same way forever. `recordMeta` writes via its own transaction,
so the errors log even while the main buffer is permanently stuck.
Everything enqueued after the poison is lost on session close.

Live-DB proof: the 3 affected sessions have **0** rows in `tool_executions`,
`turns`, `llm_requests`, `session_events`, AND `sessions` — only
`telemetry_meta` survived. `flush_log` has no rows for them. Total data
loss.

### Defect 2 — duplicate source (`src/capture/tools.ts`)

The insert dedup is module-level in-memory (`inFlightTools`,
`stagedResults`, `completedToolCallIds`) and does NOT survive across
processes. When a session is resumed/replayed in a fresh process (e.g. pi
restart resuming a session and replaying already-executed tool calls),
already-recorded `tool_call_id`s are re-emitted; the empty
`completedToolCallIds` lets the INSERT through, colliding with the
prior-process row — the poison that triggers Defect 1.

The within-process dedup is correct (covered by `test/tools.test.ts`:
duplicate `tool_execution_end` → single row). The gap is purely
 cross-process / replay.

## Fix summary

Fixed in task `telemetry-write-resilience`, slice `duplicate-key-resilience`
(commit `0402641`). Both intertwined defects addressed:

1. **Buffer flush resilience (`src/buffer.ts`)** — `flush()` keeps the
   fast-path batched transaction, but on failure now rolls back and applies
   each statement individually (`applyOne`). Healthy rows commit;
   offending rows are logged to `telemetry_meta` (`event='write_failed'`)
   and **dropped — never re-enqueued**. A single failing statement can no
   longer poison unrelated rows or retry forever.

2. **Natural-key idempotency (`src/capture/*`, `src/feedback.ts`)** — all
   natural-key INSERTs now use `INSERT OR IGNORE` (≡
   `ON CONFLICT(<pk>) DO NOTHING`), so a replayed key from a resumed
   session no-ops instead of raising UNIQUE. The in-memory dedup in
   `tools.ts` stays as a fast path but is no longer the only defense.

**Regression test:** `test/duplicate-key-resilience.test.ts` (4 tests) —
replayed `tool_call_id` does not poison the batch; buffer isolates an
unrecoverable statement; replayed `session_start` is idempotent; SQL audit
that every capture INSERT is `INSERT OR IGNORE`. Validation: `npm run check`
clean; full `npm test` 150 pass / 0 fail (was 146).

**Tradeoff:** `INSERT OR IGNORE` silently drops a genuinely-different row
that reuses a key; with UUID keys this is effectively impossible, and the
tradeoff (drop vs total session loss) favors idempotency.
