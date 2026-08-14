---
kind: slice
slug: parse-retry-after-http-date
title: Parse HTTP-date Retry-After headers + warn on unparseable values
task: ../task.md
mode: afk
status: done
size: s
blocked_by: []
---

## End-to-end behavior

`parseRetryAfterMs` handles both `Retry-After` forms (delta-seconds and
HTTP-date) and warns on unparseable values instead of silently returning
`null`.

## Acceptance criteria

- [x] `parseRetryAfterMs` in `src/capture/llm.ts` parses delta-seconds
      (unchanged) and HTTP-date (RFC 7231) into a ms wait.
- [x] HTTP-date wait = `max(0, Date.parse(value) - responseReceivedMs)`; the
      `after_provider_response` handler passes `t.now()` as
      `responseReceivedMs`.
- [x] Unparseable or past-date values → `null` + a `telemetry_meta`
      `handler_error`-class note (no silent drop, no throw).
- [x] Red-first: a test feeding `headers: { "retry-after": "Wed, 21 Oct 2026
      07:28:00 GMT" }` asserts a positive `retry_after_ms` — fails before the
      fix (returns null), passes after.

## Test plan

**Seam:** `test/llm.test.ts` `after_provider_response` harness.
**Failure mode (red-first):** HTTP-date header → before fix `retry_after_ms`
      is null; after fix it's the computed wait.
**Scenarios:**
  - delta-seconds `"2"` → 2000 (regression, unchanged).
  - HTTP-date in the future → positive wait = `(date - now)`.
  - HTTP-date in the past → null + meta note.
  - garbage `"abc"` → null + meta note.
  - header absent → null, no meta.
  - case variants `"Retry-After"` / `"retry-after"` (existing coverage).
**Edge cases:** HTTP-date with a timezone offset; very large delta-seconds
      (cap to a sane max? decide in-slice, document).

## Constraints and dependencies

- No schema change; capture-only.
- `Date.parse` on HTTP-date is implementation-dependent but accepts the
  RFC 1123 format (`"Wed, 21 Oct 2026 07:28:00 GMT"`); confirm in the test.
- Independent of `retry-seam-research` / `retry-linkage` (parallel-safe).
