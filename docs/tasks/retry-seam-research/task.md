---
kind: task
type: research
slug: retry-seam-research
title: Does Pi expose any retry seam, and can retries be inferred/linked from existing events?
map: telemetry-signal-gaps
status: done
blocked_by: []
slices: []
---

## Precise question

`retry_after_ms` capture works and is tested, but counting retries needs a
seam Pi does not obviously expose (retries happen inside
`@earendil-works/pi-ai` provider clients, which generate a fresh
`message_start` → new `request_id` per attempt). Answer, with citations to
exact files/types (not paraphrase):

1. **Retry seam in Pi.** Does Pi v0.80.10 emit any event on a provider retry
   (e.g. a `message_retry` / `request_retry` event, a retry counter on
   `message_start`, or an `after_provider_response` with the *original*
   request id)? Search the installed pi types
   (`/nix/store/46l2syffzlyylqhs4mlzaxxyj5ivglry-pi-coding-agent-0.80.10/lib/node_modules/pi-monorepo/`
   and `node_modules/@earendil-works/pi-ai`) for retry-related events and
   `message_start` payload fields. Verdict: seam EXISTS / DOES NOT EXIST,
   with the exact event/field or the exhaustive absence.
2. **Header reliability.** Does `after_provider_response` fire for the
   original (failed) attempt as well as the retry, or only once? If it fires
   per attempt with the same turn context, `http_status` per attempt is
   capturable even without a retry counter. Verify against the types + the
   existing `llm.ts` `pendingResponses` queue logic.
3. **Heuristic inference.** If no seam exists, can retries be *inferred* from
   existing rows — e.g. two `llm_requests` in the same `turn_id` with
   sequential `started_unix_ms` where the first has `http_status >= 500` or
   `= 429` and the second succeeds? Evaluate accuracy + limits (false
   positives from concurrent requests, parallel tool calls, etc.). The
   existing "does not cross-contaminate interleaved concurrent requests"
   test shows multiple requests per turn are already tracked — is that
   join reliable enough for a heuristic, or too noisy?
4. **Linkage schema.** If a seam or reliable heuristic exists, what is the
   minimal schema addition to link attempts: `attempt INTEGER` on
   `llm_requests`, `parent_request_id TEXT`, or a derived
   `request_group_id`? Each implies a different write-path change. Recommend
   one with the trade-off.
5. **Upstream blocker.** If no seam and no reliable heuristic exist, state
   plainly that retry linkage is blocked by a missing upstream Pi retry
   event, so `retry-linkage` stops with a clear discovery and returns to
   Wayfinder (map Fog item 3).

## Decision or task it unblocks

Unblocks `retry-linkage` (feature) — its scope (attempt counter, parent
linkage, or a documented gap) is determined by this research. If blocked,
`retry-linkage` is descoped and the gap stays in Fog.

## Trusted source boundaries

- **Primary:** installed pi types at
  `/nix/store/46l2syffzlyylqhs4mlzaxxyj5ivglry-pi-coding-agent-0.80.10/lib/node_modules/pi-monorepo/`
  (`docs/extensions.md` event reference, `docs/sdk.md`) and
  `node_modules/@earendil-works/pi-ai` type declarations. Types are
  authoritative; never invent event shapes (HANDOFF rule).
- **This repo:** `src/capture/llm.ts` (the `after_provider_response` +
  `pendingResponses` + `message_start`/`message_end` paths), `src/db.ts`
  (`llm_requests` schema), `SPEC.md` §1.4.
- **Web:** only to confirm pi event semantics if local docs are ambiguous;
  prefer the installed types.

## Evidence required for completion

A findings document at `docs/tasks/retry-seam-research/findings.md` with,
for each of the 5 questions: the verified answer + citation (file:line / type
declaration), a concrete recommendation, and a list of newly-sharp
decisions for `retry-linkage` (or a clear "blocked, return to Wayfinder"
verdict). The findings doc is the artifact; `retry-linkage` implements only
what it permits.

## Likely dependent tasks

- `retry-linkage` (feature, blocked_by this task) — implements linkage if
  feasible.
- `retry-parse-hole` (bug) is independent of this research and can proceed
  in parallel.
