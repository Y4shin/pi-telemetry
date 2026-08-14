# Reproduction — parseRetryAfterMs drops HTTP-date Retry-After headers

## Symptom

`src/capture/llm.ts` `parseRetryAfterMs` only parses the delta-seconds form
of `Retry-After`. An RFC 7231 HTTP-date value (`"Wed, 21 Oct 2026 07:28:00
GMT"`) goes through `parseInt` → `NaN` → silently `null`, with no
`telemetry_meta` note. Untested.

## Investigation

### 1. Root cause in source

`src/capture/llm.ts:35-41`:

```ts
function parseRetryAfterMs(headers: Record<string, string>): number | null {
  const value = headers["retry-after"] ?? headers["Retry-After"];
  if (!value) return null;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return parsed * 1000;
}
```

`parseInt("Wed, 21 Oct 2026 07:28:00 GMT", 10)` → `NaN` → `return null`.

The caller, the `after_provider_response` handler (`src/capture/llm.ts:170-195`),
has `t.now()` available as `responseReceivedMs` but does not pass it to
`parseRetryAfterMs`.

### 2. Existing test coverage (delta-seconds only)

`test/llm.test.ts`:
- "records http_status and retry_after_ms for a 429 response" →
  `headers: { "retry-after": "2" }` asserts `retry_after_ms = 2000`.
- "records 429 status when after_provider_response fires before
  message_start" → `headers: { "retry-after": "3" }` asserts `3000`.

No HTTP-date case. No unparseable-value case. No `telemetry_meta` note
assertion.

### 3. The fix (slice: `parse-retry-after-http-date`)

- Extend `parseRetryAfterMs` to accept a `responseReceivedMs: number`
  parameter.
- Try delta-seconds first: if `parseInt(value, 10)` is not NaN, return
  `parsed * 1000` (unchanged behavior).
- Else try HTTP-date: `const ms = Date.parse(value)`. If `ms` is NaN →
  unparseable → return `null` (caller emits a `telemetry_meta` note). If
  `ms <= responseReceivedMs` (past or now) → return `null` (no wait). Else
  return `ms - responseReceivedMs` (the wait time).
- The caller passes `t.now()` and, on a `null` return where a header WAS
  present, emits `t.meta("warn", "handler_error", ...)` (no silent drop, no
  throw). Note: only when the header was present and unparseable — absent
  header stays a quiet `null` (no meta noise).
- `Date.parse` accepts the RFC 1123 format (`"Wed, 21 Oct 2026 07:28:00
  GMT"`); confirm in the test.

### 4. Regression test (the test rule)

In `test/llm.test.ts`, add tests driving the `after_provider_response` harness:

- delta-seconds `"2"` → `retry_after_ms = 2000` (regression, unchanged).
- HTTP-date in the future (e.g. a date ~5s ahead of the fixed clock) →
  positive `retry_after_ms` ≈ 5000. **RED before fix:** returns `null`;
  **GREEN after:** returns the computed wait.
- HTTP-date in the past → `null` (no wait), and a `telemetry_meta` note is
  present (no silent drop).
- garbage `"abc"` (header present, unparseable) → `null` + a
  `telemetry_meta` note.
- header absent → `null`, no `telemetry_meta` note (no noise on absent
  headers).
- case variants `"Retry-After"` / `"retry-after"` (existing coverage; keep
  green).

The RED signal: the future-HTTP-date test returns `null` before the fix
(`parseInt` → NaN) and a positive wait after.

## Verdict

Real (latent) bug — a parse hole that silently drops a valid header form.
Low-urgency (no provider currently sends the date form) but cheap and
correct to fix now. One slice; independent of `retry-seam-research` /
`retry-linkage`.
