---
title: Tool error_class is always 'unknown' — classifier reads the wrong error shape
status: open
severity: major
reported: 2026-08-14
confirmed_by: telemetry-signals-inventory review + DB + source inspection
fix_commit:
promoted_to: error-classifier-envelope
---

# Tool error_class is always 'unknown': classifier is shape-blind to the error payload

## Observed

`tool_executions.error_class` is populated (4.5%, 336 of 7,536 rows) but
**every non-null value is the literal string `unknown`** — the error type is
never actually classified. 0 rows have `timeout`, `not_found`, `permission`,
or `validation`, despite a classifier that emits those buckets.

Evidence (live DB, 2026-08-14):

```sql
SELECT DISTINCT error_class FROM tool_executions WHERE error_class IS NOT NULL;
-- -> ['unknown']
SELECT is_error, error_class, COUNT(*) FROM tool_executions
GROUP BY is_error, error_class;
-- -> (0, NULL, 7200)  and  (1, 'unknown', 336)
```

So `is_error` flagging itself is correct (336 errors flagged, 0 errors on
success rows); only the *classification* is broken.

## Expected

`error_class` reflects the bounded categories the SPEC §1.5 defines
(`timeout | not_found | permission | validation | unknown`), derived from the
error text that tools actually emit. A `timeout`-containing error becomes
`timeout`, a `not found` / `ENOENT` becomes `not_found`, etc.

## Root cause

`src/capture/tools.ts` `classifyError(err)` inspects `err.message` and
`err.code`:

```ts
if (err instanceof Error) { message = err.message; code = err.code; }
else if (typeof err === "string") { message = err; }
else if (err !== null && typeof err === "object") {
  const obj = err as Record<string, unknown>;
  message = typeof obj.message === "string" ? obj.message : "";
  code = typeof obj.code === "string" ? obj.code : undefined;
}
```

But tool errors arrive from the Pi `tool_result` event as Anthropic-style
content-block envelopes — `{ content: [{ type: "text", text: "..." }] }` —
with **neither** a `message` nor a `code` field. Every real error falls
through every `if` and lands on `return "unknown"`. The classifier is
shape-blind to the actual error payload.

Note: `stageResult` → `computeResultMetrics` already extracts text from
`content` arrays via `hashContentBlocks` (same file); the classifier doesn't
reuse that extraction.

## Suspected area

`src/capture/tools.ts` — the `classifyError` function.

## Fix

One slice (`fix-classifier-envelope`): make `classifyError` read error text
from the shapes tool errors actually arrive in — a bare string, an Anthropic
content-block envelope `{ content: [{ type: "text", text }] }` (reuse
`hashContentBlocks` / a shared extractor), and keep the `{ message, code }`
Error-like object path for safety. Keep the 5-bucket set and substring
matchers unchanged. Forward-only — historical `unknown` rows are not
reclassified (no raw error text was stored to reclassify from).

## Notes

- The inventory doc's framing ("error type is not being classified") was
  wrong about the cause — the classifier *is* invoked, it just can't see the
  payload. This fix corrects the shape, not "start classifying."
- The opt-in raw-capture task (`error-raw-capture`) and the pluggable parser
  (`pluggable-error-parser`) are separate tasks in the same map; this bug only
  fixes the built-in classifier's shape mismatch.
