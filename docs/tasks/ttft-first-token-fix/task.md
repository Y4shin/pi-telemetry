---
kind: task
type: bug
slug: ttft-first-token-fix
title: "TTFT mis-measured: message_update of any type is treated as first token"
map: telemetry-signal-gaps
status: ready
bug: ttft-first-token-mismeasured
slices:
  - ttft-gate-text-delta
  - ttft-null-mismeasured-history
---

## Observed behavior

`llm_requests.ttft_ms` is structurally wrong. Distribution over 8,276 live
rows:

- 6,883 (83%) are `0`.
- 1,269 (15%) are positive (plausible).
- 122 (1.5%) are `NULL` (genuinely unmeasured — no `message_update` fired).

A `0` ms first-token time is physically impossible for networked providers,
and the data proves the zero is a measurement artifact: **6,425 zero-ttft
rows have positive `stream_ms`**, 2,984 of which ran **≥1 second** with
positive `output_tokens` — a request cannot stream for seconds with a 0 ms
first token. All zero rows route through one gateway (`provider='requesty'`,
proxied from sference/tensorx/nebius/inceptron).

Root cause in `src/capture/llm.ts:105-120`: the `message_update` handler sets
`req.firstUpdateMs = now` on the **first `message_update` of any type** and
ignores `event.assistantMessageEvent.type`. For the `requesty` gateway the
first `message_update` is a synthetic/empty event (role marker, usage ping, or
keepalive) fired in the same `Date.now()` millisecond as `message_start`, so
`ttft = now - startMs = 0`. Real text (`text_delta`) arrives later.

## Expected behavior

`ttft_ms` records `message_start` → first **content** event
(`assistantMessageEvent.type === 'text_delta'`), matching SPEC §1.4
("message_start → first message_update") where the spirit is "first token,"
not "first update of any kind." `0` is no longer a valid value for a networked
request; genuinely-unmeasured requests stay `NULL`.

## Reproduction / evidence

- DB: `~/.pi/telemetry.db` — query `SELECT ttft_ms, stream_ms, duration_ms,
  output_tokens FROM llm_requests WHERE ttft_ms=0 AND stream_ms > 1000 LIMIT 20`
  returns multi-second streams with `ttft=0`.
- Source: `src/capture/llm.ts:115` — `if (req.firstUpdateMs === null) {
  req.firstUpdateMs = now; ... }` with no type gate; every existing test in
  `test/llm.test.ts` happens to pass `{ type: "text_delta", ... }`, so the
  type field is present but unused.

## Scope boundaries

- **Fix slice:** gate `firstUpdateMs` on `assistantMessageEvent.type ===
  'text_delta'` only. Forward-only — does not reinterpret existing rows. If no
  `text_delta` ever arrives for a request, `ttft_ms` stays `NULL` (already the
  documented "unmeasured" state; `stream_ms` falls back to `NULL` too).
- **History slice:** one-time migration that sets `ttft_ms = NULL` where the
  value is nonsensical/wrong, gated on `user_version < 5` (current is 4), run
  once on upgrade. See slice doc for the exact `WHERE` clause and the
  degenerate-rows decision (Fog item 2).

## Acceptance criteria

- [ ] `ttft_ms` is no longer `0` for any new request that streams real text.
- [ ] A request whose only `message_update` is a non-`text_delta` event keeps
  `ttft_ms = NULL` (no false zero).
- [ ] New unit test: fire a non-`text_delta` `message_update` at the same ms
  as `message_start`, then a `text_delta` later — assert `ttft_ms` reflects
  the `text_delta` delta, not the first update.
- [ ] Migration nulls historically mis-measured `ttft_ms` rows (see history
  slice).
- [ ] `ttft_by_model` and other canned queries no longer report a `0` median.

## Implementation notes

- **ttft-gate-text-delta** (landed): Gated `firstUpdateMs` in the
  `message_update` handler (`src/capture/llm.ts`) on
  `event.assistantMessageEvent?.type === "text_delta"`, so synthetic
  non-content updates (role markers, usage pings, keepalives) no longer
  produce `ttft_ms = 0`. When no `text_delta` arrives before
  `message_end`, `ttft_ms` stays `NULL` (and `stream_ms` falls back to
  `NULL` via the existing branch). Three regression tests added in
  `test/llm.test.ts`: (1) non-`text_delta` update at same ms then
  `text_delta` later asserts `ttft_ms` reflects the `text_delta` delta; (2)
  only non-`text_delta` updates then end asserts `ttft_ms = NULL`; (3)
  missing `assistantMessageEvent` (older provider) asserts `ttft_ms = NULL`.
  All 222 tests pass; `tsc --noEmit` clean. Forward-only — no schema change,
  no migration; existing rows untouched (history slice handles backfill).
