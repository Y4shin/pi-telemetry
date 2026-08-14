---
kind: slice
slug: link-retry-attempts
title: Add attempt/linkage column + populate from the retry seam or heuristic
task: ../task.md
mode: afk
status: done
size: m
blocked_by: []
---

## End-to-end behavior

LLM request attempts in the same retry group are linked (via the
`retry-seam-research`-recommended column + capture path), so retries are
countable per model/provider. If the research blocked linkage, this slice
is void and the task returns to Wayfinder.

## Acceptance criteria

- [ ] If research recommended a column: migration (next version) adds it
      nullable; capture path in `src/capture/llm.ts` populates it from the
      identified seam.
- [ ] If research recommended a heuristic: implemented + reliability
      documented in `SPEC.md` §1.4 + the slice body.
- [ ] If research blocked linkage: no code change; the slice records the
      discovery and returns to Wayfinder (map Fog item 3).
- [ ] New unit test for the feasible path reproduces a retry and asserts
      linked rows / attempt counter.
- [ ] Per-request attribution preserved (the existing interleaved-concurrent
      test still passes).

## Test plan

**Seam:** `test/llm.test.ts` + `test/db.test.ts` (migration).
**Scenarios (seam path):** seam fires a retry event → new `llm_requests` row
      linked to the original with `attempt=2`; original has the non-2xx
      `http_status`.
**Scenarios (heuristic path):** two rows same `turn_id`, first 429, second
      200 → linked; concurrent unrelated requests not falsely linked.
**Failure mode:** if no seam and heuristic unreliable, the red test is the
      documented absence (the slice writes the discovery, not a failing test).
**Edge cases:** retries across `turn_start` boundaries; retries with no
      `after_provider_response` (the 104 `http_status`-null rows).

## Constraints and dependencies

- Depends on `retry-seam-research` findings — the slice body is deliberately
  conditional on the research verdict.
- Never touch `~/.pi/telemetry.db` from tests.
- Forward-only migration; no backfill (historical rows can't be linked
  without the seam having fired).
