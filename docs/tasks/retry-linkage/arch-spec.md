# Architecture spec — retry-linkage

**Task:** `retry-linkage` (feature, single slice `link-retry-attempts`)
**Map:** `telemetry-signal-gaps`
**Research basis:** `docs/tasks/retry-seam-research/findings.md` (Q1-Q5)

The research verdict: no upstream Pi retry seam exists for extensions, but a
reliable in-turn heuristic is available via the existing `message_start`/
`message_end`/`turn_start` events. Recommended schema: **Option A — a
turn-scoped `attempt` counter** on `llm_requests`.

## Exports / public API surface

- **Schema:** `llm_requests.attempt INTEGER` (nullable; default `NULL` for
  legacy rows, `1` for the first request in a new turn after this lands).
  Added via a forward-only migration.
- **Capture:** `src/capture/llm.ts` writes `attempt` on every `message_start`
  INSERT, sourced from a turn-scoped counter in `src/state.ts`.
- **Query:** a `query_telemetry` preset exposing retry count per model
  (deferred to a follow-up unless trivial; the slice's primary deliverable is
  the column + counter). The slice doc lists the preset as an acceptance
  criterion — implement the simplest correct version.

## Existing abstractions to use

- `src/state.ts` `RuntimeState` — add a per-turn `attempt` counter (a
  `number` field, like the existing `turnId`/`turnIndex`). Reset to 0 on
  `turn_start` (in `src/capture/turns.ts`), incremented on each `message_start`
  in `src/capture/llm.ts`.
- `src/capture/llm.ts` `message_start` handler (lines 56-100) — the INSERT
  already lists 18 columns; add `attempt` as the 19th value, sourced from the
  counter (incremented *before* the INSERT so the first request is `attempt =
  1`).
- `src/capture/turns.ts` `turn_start` handler (lines 14-68) — zero the counter
  alongside setting `t.state.turnId`.
- `src/db.ts` `MIGRATIONS` — add the column via a version-gated migration.
  **Migration-version coordination:** `ttft-first-token-fix` slice 2 already
  consumed `user_version` 5 (the `ttft_ms = NULL` nulling). This task uses
  **`user_version` 6** with an `addColumnIfMissing`-style apply function
  (matching migration 4's pattern) so it is idempotent under concurrent
  first-starts and safe on fresh DBs.
- `test/helpers/l1-stub.ts` + the `llm.test.ts` harness — the existing
  "does not cross-contaminate interleaved concurrent requests" test is the
  pattern for multi-request-per-turn tests.

## Do NOT reimplement

- Do not add a `parent_request_id` or `attempt_group_id` (research rejected
  these — Option B/C; see findings Q4). The turn already groups attempts;
  `attempt` + `turn_id` is sufficient.
- Do not hook a non-existent Pi retry event (research Q1: `auto_retry_*` is
  internal-only, not extension-facing).
- Do not write retry *classification* (is this `error` row a retry of the prior
  row?) into the capture path — that is a **query-time** decision
  (`attempt > 1 AND prior_row.stop_reason = 'error'`), per findings Q3/Q4.
  The counter records the neutral fact (position in turn).

## Interface contract (single slice — no dependents in this task)

The slice exports `llm_requests.attempt` populated for all new requests. No
downstream slice in this task consumes it. The `grill-pluggable-parser` /
`error-raw-capture` tasks are independent and do not read `attempt`.

## Retry classification (query-time, documented)

For the acceptance-criterion preset and the SPEC note, retries are
identified at query time as: rows where `attempt > 1` AND the prior row in the
same `turn_id` (ordered by `started_unix_ms`) had `stop_reason = 'error'`.
Tool-use continuations (prior row `stop_reason = 'toolUse'`) are excluded.
This disambiguator is the research's documented limitation (findings Q3); it
must be stated in `SPEC.md` §1.4.

## Out of scope

- No upstream Pi change (research confirmed none is needed).
- No backfill of historical rows (the counter didn't exist; legacy rows stay
  `attempt = NULL`).
- No `auto_retry_*` capture (internal event, not extension-facing).
- The `grill-error-raw-capture` / `pluggable-error-parser` tasks are separate.
