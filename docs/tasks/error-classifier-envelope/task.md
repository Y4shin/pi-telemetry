---
kind: task
type: bug
slug: error-classifier-envelope
title: "Tool error_class is always 'unknown': classifier reads the wrong shape"
map: telemetry-signal-gaps
status: done
bug: error-classifier-shape-blind
slices:
  - fix-classifier-envelope
---

## Observed behavior

`tool_executions.error_class` is populated (4.5%, 336 of 7,536 rows) but
**every non-null value is the literal string `unknown`** — the error type is
never actually classified. 0 rows have `timeout`, `not_found`, `permission`,
or `validation`, despite a classifier that emits those buckets.

Root cause in `src/capture/tools.ts`: `classifyError(err)` inspects
`err.message` and `err.code`:
```ts
if (err instanceof Error) { message = err.message; code = err.code; }
else if (typeof err === "string") { message = err; }
else if (err !== null && typeof err === "object") { ... obj.message ... }
```
But tool errors arrive from the Pi `tool_result` event as Anthropic-style
content-block envelopes — `{ content: [{ type: "text", text: "..." }] }` —
with **neither** a `message` nor a `code` field. Every real error falls
through every `if` and lands on `return "unknown"`. The classifier is
shape-blind to the actual error payload.

## Expected behavior

`error_class` reflects the bounded categories the SPEC §1.5 defines, derived
from the error text that tools actually emit. A `timeout`-containing error
becomes `timeout`, a `not found` / `ENOENT` becomes `not_found`, etc.

## Reproduction / evidence

- DB: `SELECT DISTINCT error_class FROM tool_executions WHERE error_class IS
  NOT NULL` → `['unknown']` only. `SELECT is_error, error_class, COUNT(*)
  FROM tool_executions GROUP BY is_error, error_class` → all errors map to
  `unknown`; 0 on success rows (so `is_error` flagging itself is correct).
- Source: `src/capture/tools.ts` `classifyError` — the `else if (err !== null
  && typeof err === "object")` branch reads `obj.message`, which is absent on
  content-block envelopes. `stageResult` → `computeResultMetrics` already
  extracts text from `content` arrays via `hashContentBlocks`; the classifier
  doesn't reuse that extraction.

## Scope boundaries

- Fix the classifier to read the error text from the content-block envelope
  (reuse `hashContentBlocks`'s extraction logic, or extract `text` from
  `{content:[{type:"text",text}]}` and from bare strings).
- Keep the 5-bucket set (`timeout | not_found | permission | validation |
  unknown`) — bounded category per SPEC.
- **Forward-only.** Historical `unknown` rows are not reclassified (we don't
  have the raw error text to reclassify from). Historical correction depends
  on the opt-in raw capture (see `error-raw-capture`) collecting envelopes
  going forward; deferring historical reclassification is acceptable.
- Opt-in raw capture and the pluggable parser are **separate tasks** in this
  map (`error-raw-capture`, `pluggable-error-parser`); this task only fixes
  the built-in classifier's shape mismatch.

## Acceptance criteria

- [ ] `classifyError` reads text from content-block envelopes and bare
      strings, not `err.message` / `err.code`.
- [ ] New unit tests: feed representative error envelopes and assert the
      expected bucket for each (timeout, not_found, permission, validation,
      unknown-fallback).
- [ ] The 5-bucket set is unchanged; `error_class` stays a bounded string.
- [ ] No behavior change for `is_error` flagging (already correct).

## Notes

- The inventory doc's framing ("error type is not being classified") was
  wrong about the cause — the classifier *is* invoked, it just can't see the
  payload. This task fixes the shape, not "start classifying."
- The opt-in raw-capture task (`error-raw-capture`) is what lets us *evaluate*
  whether the 5 buckets match real error vocabulary; the pluggable parser
  task (`pluggable-error-parser`) makes classification extensible after that.

## Implementation notes

- **fix-classifier-envelope** (landed): Refactored `classifyError` in
  `src/capture/tools.ts` to extract error text from the shapes tool errors
  actually arrive in, via two new helpers: `extractContentText(content)`
  (concatenates `text` from all `{type:"text",text}` blocks via the existing
  `isTextBlock` guard) and `extractErrorText(err)` (the orchestrator).
  `extractErrorText` handles: `Error` instances (`message` + `code`), bare
  strings, and objects. For objects it prefers a `content` array envelope
  (the actual Anthropic `tool_result` shape) and only falls back to
  `message`/`code` when `content` holds no text; objects without `content`
  still read `message`/`code` as before. The 5-bucket substring matchers and
  their order (`timeout | not_found | permission | validation | unknown`)
  are unchanged — only the text extraction in front of them changed — and
  `classifyError` is now exported so tests can drive it directly. `null`/
  `undefined`/non-text-content inputs return `unknown` without throwing.
  No schema change, no migration; capture-only and forward-only (historical
  `unknown` rows are not reclassified — deferred to `error-raw-capture`).
  Seven new tests added in `test/tools.test.ts` covering one representative
  envelope per bucket, multi-block concatenation, content-preferred-over-
  message with fallback, bare strings, Error-like objects, and unrecognized/
  null/undefined inputs. All 232 tests pass; `tsc --noEmit` clean; privacy
  gate intact (`test/privacy.test.ts` passes).
