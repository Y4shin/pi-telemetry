---
kind: task
type: feature
slug: retry-linkage
title: "Link LLM request attempts so retries are countable"
map: telemetry-signal-gaps
status: done
blocked_by:
  - retry-seam-research
slices:
  - link-retry-attempts
---

## User-visible outcome

Retries of an LLM request are countable: either via a Pi retry seam
(identified by `retry-seam-research`) or a reliable heuristic, `llm_requests`
rows in the same attempt group are linked so queries can report retry counts
and backoff per model/provider.

## User story

As someone diagnosing provider reliability, I query "how many retries
happened per model this week, and what was the backoff?" — currently
impossible because each retry gets a fresh `request_id` with no attempt
counter or parent link.

## Scope boundaries

- **In:** whatever `retry-seam-research` permits — an `attempt` /
  `parent_request_id` / `request_group_id` column (research-recommended) +
  the capture-path change to populate it from the seam, OR a heuristic
  derivation + a query preset that exposes it.
- **Out:** changing Pi upstream (if the research finds no seam, this task
  stops with a discovery and returns to Wayfinder — map Fog item 3). Not in
  scope: building a heuristic if the research deems it unreliable.
- **Migration:** any new column is a nullable addition (SPEC §8
  forward-only, older extensions keep writing).

## Acceptance criteria

- [ ] Schema addition (if any) per `retry-seam-research` recommendation,
      via a version-gated migration, nullable, no backfill.
- [ ] Capture path populates the linkage from the identified seam, OR the
      heuristic is implemented + its reliability documented.
- [ ] New unit test: a retry scenario (per the seam or heuristic) produces
      linked rows with the expected `attempt`/parent.
- [ ] A `query_telemetry` preset (or extension to an existing one) exposes
      retry count per model, IF linkage is feasible. If blocked, this
      criterion is voided by the discovery.
- [ ] `SPEC.md` §1.4 updated to document the linkage + its provenance
      (seam vs heuristic) and any limits.

## Existing abstractions to use

- `src/capture/llm.ts` `inFlightRequests` + `pendingResponses` — the
  per-turn, per-request tracking the linkage must build on.
- `src/db.ts` `MIGRATIONS` — the version-gated column addition.
- The "does not cross-contaminate interleaved concurrent requests" test
  pattern in `test/llm.test.ts` — the linkage must preserve per-request
  attribution.

## Architecture / domain decisions

- `retry-seam-research` is the gate. If it returns "blocked, no seam, no
  reliable heuristic," this task's outcome is a documented gap (SPEC §1.4
  note) and the feature is descoped to Fog, not forced.
- The recommended schema shape comes from the research; do not choose a
  column shape here.

## Implementation notes

- **link-retry-attempts** (the only slice): Added a turn-scoped `attempt`
  counter to `llm_requests` via migration v6 (`addColumnIfMissing`, nullable,
  no backfill — legacy rows stay NULL). The counter lives in `RuntimeState`
  (`attempt: number`, init 0), reset to 0 on `turn_start` in
  `src/capture/turns.ts` and incremented before the INSERT on `message_start`
  in `src/capture/llm.ts` (first request = 1). Capture records the neutral
  fact (position in turn); retry classification is query-time only, in the new
  `retry_count` preset (`src/query/canned.ts`, registered in
  `src/query/tool.ts`) which classifies `attempt > 1 AND prior_stop_reason =
  'error'` as a retry and excludes tool-use continuations. `SPEC.md` §1.4 was
  updated with the inference note (provenance, query-time classification,
  tool-use exclusion, retry-after-tool-use limitation). Tests: `test/llm.test.ts`
  (retry scenario asserting attempt=1/error then attempt=2/stop on same
  `turn_id`), `test/db.test.ts` (v5→v6 migration asserts legacy `row.attempt
  === null`), `test/canned.test.ts` (`retry_count` preset — error→success
  counts as retry, tool-use continuations excluded). Per-request attribution
  preserved: the existing interleaved-concurrent test still passes. Full suite
  239/239 green. Deviation report clean — implementation matches the arch spec
  and slice doc precisely, no scope widened, no abstraction replaced.
  The research-recommended `parent_request_id`/`attempt_group_id` shapes were
  explicitly rejected (arch spec Option B/C); only `attempt` was added.
