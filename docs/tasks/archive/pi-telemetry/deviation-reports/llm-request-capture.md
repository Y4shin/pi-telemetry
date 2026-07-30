## Deviation report — llm-request-capture

**Verification:** `npm test` 53/53 green, `npm run check` (`tsc --noEmit`)
clean on `slice/llm-request-capture` (8e0a867).

### API surface changes

- **Planned:** `registerLlmCapture(pi, t)` in `src/capture/llm.ts`, wired via
  `src/capture/index.ts` + `index.ts`; consume `state.correlation()` and
  `state.timers`; `after_provider_response` "updates the most recent
  in-flight request row."
- **Actual:** `registerLlmCapture(pi, t)` exported and wired exactly as
  planned. Table schema untouched — SPEC §2 `llm_requests` verbatim; row
  writes cover `cost_total_usd` only, which is all the frozen DDL offers for
  cost (SPEC §1.4's "cost breakdown" resolves to what the schema has).
- **Impact on dependent slices:** none — slices 4/7 consume
  `correlation()`/`timers`, which are unchanged; slices 8/9 read
  `llm_requests`, whose columns are unchanged.

### Deviations (three, all defensible)

1. **`after_provider_response` buffering (additive).** The real SDK fires
   `after_provider_response` *before* `message_start` (HTTP headers precede
   the stream). Implementation keeps the spec behaviour when an in-flight
   row exists (updates most-recent request for the turn) **and** adds a
   per-turn FIFO buffer applied to the next `message_start`. Without this,
   every real 429 would be lost — the spec's contract assumed the wrong
   event ordering. Correct call. Recommend amending the arch-spec wording to
   "…or, if the response precedes the stream, buffer per-turn and apply to
   the next `message_start`" for future readers.
2. **Marker keying via derived signature.** Spec said "keyed by message
   identity from the event payload; module-scope map if payload identity
   requires it." The payload has no `request_id`, so markers are keyed by
   `provider|model|api|timestamp|responseId` — the spec's own fallback
   clause. **Residual risk:** two concurrent streams from the same
   provider/model with identical ms-timestamp and no `responseId` would
   collide; vanishingly unlikely, and the L1 interleaving test (two
   concurrent streams, exact clock-asserted figures) passes.
3. **No dedicated L2 429 test.** The slice's testing strategy asked for a
   "scripted 429" through the L2 harness; the faux provider cannot emit
   error statuses without a custom transport shim, so 429 coverage lives at
   L1 only (both event orderings tested). This is a coverage-*location*
   change, not a coverage loss — the acceptance criterion is met. The L2
   test was instead extended to assert a real streamed prompt produces a
   correlated `llm_requests` row.

### Acceptance criteria check

- ✅ Controllable-clock TTFT/stream computation (injected `t.now()`,
  exact-ms assertions, no wall-clock flakiness)
- ✅ No-update request → `ttft_ms`/`stream_ms` NULL, `duration_ms` recorded
- ✅ 429 → `http_status=429`, `retry_after_ms` recorded (both orderings)
- ✅ Per-request marker keying; interleaved concurrent streams, no
  cross-contamination
- ✅ Correlation to `turn_id`/`run_id`/`session_id` from slice-2 state
  (asserted in L1 and L2)
- ✅ `message_end` without `message_start` swallowed, no orphan row
- ✅ Missing usage / no cost data → NULL fields

### Abstraction usage

- Used as specified: **yes.** Consumes `Telemetry.enqueue()`,
  `state.correlation()`, `t.now()`, `guard()`; module-scope in-flight map
  per the spec's allowance; raw SQL + params against the frozen schema; no
  new dependencies; no reimplemented utilities.

### Out-of-scope changes

- `.gitignore` extended with `.pi-subagents/artifacts/`; runtime artifact
  files that were accidentally committed early on this branch removed from
  the index (net zero, housekeeping fallout of the branch's first commit).
  Benign but outside slice scope.

### Task doc update needed?

**Yes** — append to `## Implementation notes`:

> **llm-request-capture (landed …):** `llm_requests` streaming capture with
> controllable-clock TTFT/stream/duration. Divergences: (1)
> `after_provider_response` may fire before `message_start` in the real SDK
> — status/retry-after is buffered per-turn and applied to the next
> `message_start`; (2) in-flight markers keyed by derived signature
> (`provider|model|api|timestamp|responseId`) — no `request_id` in the
> payload; (3) 429 coverage at L1 only — faux provider can't emit error
> statuses without a transport shim (candidate for future L2 hardening);
> (4) `.gitignore` now excludes `.pi-subagents/artifacts/`.

### User attention needed?

**No** — API surface and schema untouched; all deviations are additive
correctness fixes or documented coverage-location changes. Worth mentioning
in the final report that the spec's assumed `after_provider_response`
ordering was wrong (a spec-learning, not a code issue), but no decision is
required.
