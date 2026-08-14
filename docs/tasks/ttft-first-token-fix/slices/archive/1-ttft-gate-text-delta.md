---
kind: slice
slug: ttft-gate-text-delta
title: Gate TTFT first-token detection on text_delta events
task: ../task.md
mode: afk
status: todo
size: s
blocked_by: []
---

## End-to-end behavior

`llm_requests.ttft_ms` reflects `message_start` → first **content** event
(`assistantMessageEvent.type === 'text_delta'`), not the first update of any
type. Forward-only; existing rows untouched.

## Acceptance criteria

- [ ] In `src/capture/llm.ts` `message_update` handler, set `firstUpdateMs`
      only when `event.assistantMessageEvent?.type === "text_delta"`.
- [ ] When no `text_delta` arrives before `message_end`, `ttft_ms` stays
      `NULL` (and `stream_ms` is `NULL` — already the case via the existing
      `firstUpdateMs !== null ? ... : null` branch).
- [ ] Existing `llm.test.ts` streaming test still passes (it sends
      `text_delta`).
- [ ] New regression test: `message_start` → non-`text_delta` `message_update`
      at the same ms → `text_delta` later → `message_end`; assert `ttft_ms`
      equals the `text_delta` delta, not `0`.

## Test plan

**Seam:** `test/llm.test.ts` `message_update` harness (`createL1Stub` +
      `fakeAssistantMessage`).
**Failure mode (red-first):** with the unfixed code, the new test sees
      `ttft_ms = 0`; the fix makes it see the `text_delta` delta.
**Scenarios:**
  - non-`text_delta` update at same ms then `text_delta` later (core fix).
  - `text_delta` as the very first update (unchanged behavior).
  - only non-`text_delta` updates, then end (`ttft_ms` → `NULL`).
  - concurrent interleaved requests (existing test) still attribute per
    request via signature — confirm the gate doesn't break correlation.
**Edge cases:** `assistantMessageEvent` is `undefined` (older provider) —
  fall back to treating it as content-bearing? Decide per the installed pi
  types; if `text_delta` is the only content type, `undefined`-event updates
  are not content. Document the decision in the test.

## Constraints and dependencies

- No schema change, no migration. Capture-only fix.
- `event.assistantMessageEvent` shape — verify against installed
  `@earendil-works/pi-ai` types (the `assistantMessageEvent` discriminated
  union); do not invent the type set.
