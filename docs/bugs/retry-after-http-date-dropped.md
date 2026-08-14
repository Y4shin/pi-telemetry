---
title: parseRetryAfterMs silently drops HTTP-date Retry-After headers (parseInt → NaN → null)
status: open
severity: minor
reported: 2026-08-14
confirmed_by: telemetry-signals-inventory review + source inspection
fix_commit:
promoted_to: retry-parse-hole
---

# parseRetryAfterMs silently drops HTTP-date Retry-After headers

## Observed

`llm_requests.retry_after_ms` is 100% null over 8,274 live rows. The capture
path is tested and works for the delta-seconds form
(`test/llm.test.ts`: `headers: { "retry-after": "2" }` → `2000`), so the
nulls are real-world (all 8,170 captured `http_status` are 200; no provider
sent `Retry-After` in 16 days). But there is a latent correctness bug:
`parseRetryAfterMs` only handles the delta-seconds form.

Evidence (live DB, 2026-08-14):

```sql
SELECT COUNT(*) AS total,
       SUM(CASE WHEN retry_after_ms IS NOT NULL THEN 1 ELSE 0 END) AS nonnull_retry
FROM llm_requests;
-- -> 8274, 0
SELECT http_status, COUNT(*) FROM llm_requests GROUP BY http_status;
-- -> (200, 8170), (NULL, 104)
```

## Expected

Both `Retry-After` forms (RFC 7231 §7.1.3) are parsed: delta-seconds →
`value * 1000`; HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`) →
`max(0, Date.parse(date) - responseReceivedMs)` (the wait time, consistent
with delta-seconds semantics). Unparseable or past-date values → `null` +
a `telemetry_meta` note (no silent drop).

## Root cause

`src/capture/llm.ts:35-41` `parseRetryAfterMs`:

```ts
function parseRetryAfterMs(headers: Record<string, string>): number | null {
  const value = headers["retry-after"] ?? headers["Retry-After"];
  if (!value) return null;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return parsed * 1000;
}
```

`parseInt("Wed, 21 Oct 2026 07:28:00 GMT", 10)` → `NaN` → silently `null`.
No `telemetry_meta` note is emitted for the dropped value. Untested —
`test/llm.test.ts` only covers `"2"` and `"3"` (delta-seconds).

## Suspected area

`src/capture/llm.ts` — `parseRetryAfterMs` (lines 35-41) and its caller in
the `after_provider_response` handler (lines 170-195), which has `t.now()`
available as `responseReceivedMs`.

## Fix

One slice (`parse-retry-after-http-date`): extend `parseRetryAfterMs` to
parse HTTP-date in addition to delta-seconds, accept a `responseReceivedMs`
parameter for the date computation, and emit a `telemetry_meta` note on
unparseable values (instead of silent `null`). Add tests for both forms,
past-date, garbage, and absent header. The 429 delta-seconds tests stay green.

## Notes

- This is the *small* retry fix; the *structural* gap (no retry linkage) is
  the `retry-linkage` feature task's domain, gated on `retry-seam-research`
  (which found linkage is feasible via a turn-scoped attempt counter).
- Low-urgency (no provider currently sends the date form) but cheap and
  correct to fix now.
