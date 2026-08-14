---
kind: task
type: bug
slug: retry-parse-hole
title: "parseRetryAfterMs silently drops HTTP-date Retry-After headers (parseInt → NaN → null)"
map: telemetry-signal-gaps
status: done
bug: retry-after-http-date-dropped
slices:
  - parse-retry-after-http-date
---

## Observed behavior

`llm_requests.retry_after_ms` is 100% null over 8,274 live rows. The capture
path is tested and works for the delta-seconds form
(`test/llm.test.ts`: `headers: { "retry-after": "2" }` → `2000`), so the
nulls are real-world (all 8,170 captured `http_status` are 200; no provider
sent `Retry-After` in 16 days). But there is a latent correctness bug:
`parseRetryAfterMs` only handles the delta-seconds form:

```ts
function parseRetryAfterMs(headers): number | null {
  const value = headers["retry-after"] ?? headers["Retry-After"];
  if (!value) return null;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return parsed * 1000;
}
```

RFC 7231 §7.1.3 allows `Retry-After` as either a delta-seconds integer **or**
an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`). An HTTP-date value goes
through `parseInt` → `NaN` → silently `null`. The error envelope is dropped
with no `telemetry_meta` note. Untested.

## Expected behavior

Both `Retry-After` forms are parsed: delta-seconds → `value * 1000`;
HTTP-date → `max(0, Date.parse(date) - responseReceivedMs)` (the wait time,
consistent with delta-seconds semantics), or `null` if the date is in the past
/ unparseable (with a `telemetry_meta` note, not a silent drop).

## Reproduction / evidence

- Source: `src/capture/llm.ts:35` `parseRetryAfterMs` — `parseInt(value, 10)`
  on the raw header; `Number.isNaN` → `null`. No HTTP-date branch.
- Test gap: `test/llm.test.ts` only covers `"2"` and `"3"` (delta-seconds);
  no HTTP-date case.

## Scope boundaries

- **In:** extend `parseRetryAfterMs` to parse HTTP-date, add tests for both
  forms, and emit a `telemetry_meta` note on unparseable values (instead of
  silent `null`).
- **Out:** retry *linkage* (that's `retry-linkage`), and any change to the
  `after_provider_response` event contract.
- The `responseReceivedMs` for the HTTP-date computation: the
  `after_provider_response` handler has `t.now()` available — pass it in.

## Acceptance criteria

- [x] `parseRetryAfterMs` parses delta-seconds (unchanged) and HTTP-date
      (new) into a millisecond wait.
- [x] HTTP-date in the past or unparseable → `null` + a `telemetry_meta`
      note (no silent drop).
- [x] New unit tests: delta-seconds (`"2"` → 2000), HTTP-date future (→
      positive wait), HTTP-date past (→ null + meta), garbage (→ null +
      meta), header absent (→ null, no meta).
- [x] Existing 429 tests still pass.

## Notes

- This is the *small* retry fix; the *structural* gap (no retry linkage) is
  `retry-linkage`'s domain, gated on `retry-seam-research`.
- The review found this is a latent hole (no provider currently sends the
  date form), so it's low-urgency but cheap and correct to fix now.

## Implementation notes

- Slice `parse-retry-after-http-date` landed. `parseRetryAfterMs`
  (`src/capture/llm.ts`) now accepts a `responseReceivedMs` parameter and
  tries delta-seconds first (unchanged path), then falls back to
  `Date.parse(value)` for the HTTP-date form. A future date yields
  `dateMs - responseReceivedMs` (the wait); a past date or unparseable
  value returns `null`.
- The `after_provider_response` handler passes `t.now()` as
  `responseReceivedMs` and, when the header is present but
  `parseRetryAfterMs` returns `null`, emits a `telemetry_meta` warn-level
  `handler_error` note — no silent drop, no throw. Absent headers stay a
  quiet `null` with no meta noise.
- 4 new tests added in `test/llm.test.ts`: future HTTP-date → positive
  wait, past HTTP-date → null + meta, garbage `"abc"` → null + meta,
  absent header → null + no meta. The existing delta-seconds tests
  ("2" → 2000, "3" → 3000) remain unchanged. Full suite (236 tests)
  green, `tsc --noEmit` clean.
