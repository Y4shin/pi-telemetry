---
kind: task
type: feature
slug: retry-linkage
title: "Link LLM request attempts so retries are countable"
map: telemetry-signal-gaps
status: ready
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
