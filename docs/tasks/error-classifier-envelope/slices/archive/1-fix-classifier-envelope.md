---
kind: slice
slug: fix-classifier-envelope
title: Make classifyError read tool-error content-block envelopes
task: ../task.md
mode: afk
status: done
size: s
blocked_by: []
---

## End-to-end behavior

`tool_executions.error_class` reflects the bounded category derived from the
error text tools actually emit, instead of always `unknown`.

## Acceptance criteria

- [ ] `classifyError` in `src/capture/tools.ts` extracts error text from the
      shapes tool errors actually arrive in:
      - a bare string error,
      - an Anthropic content-block envelope `{ content: [{ type: "text",
        text }] }` (reuse `hashContentBlocks` / a shared extractor),
      - a `{ message, code }` Error-like object (keep for safety).
- [ ] The 5 buckets (`timeout | not_found | permission | validation |
      unknown`) and their substring matchers are unchanged.
- [ ] `error_class` is still `NULL` for `is_error=0` rows (no change to the
      success path).
- [ ] Red-first: a test that feeds an envelope like
      `{ content: [{ type: "text", text: "Command timed out" }] }` asserts
      `error_class === "timeout"` — fails before the fix, passes after.

## Test plan

**Seam:** `test/tools.test.ts` — drive `classifyError` (export it, or drive
      via the `tool_result` capture path) with representative envelopes.
**Failure mode (red-first):** feed `{ content: [{ type:"text",
      text:"EBADF: no such file" }] }` → before fix, `unknown`; after fix,
      `not_found`.
**Scenarios** (one per bucket + fallback):
  - `"Command timed out"` / `ETIMEDOUT` → `timeout`
  - `"ENOENT: no such file"` / `"not found"` → `not_found`
  - `"EACCES: permission denied"` → `permission`
  - `"invalid argument"` → `validation`
  - a content-block envelope wrapping each of the above → same bucket
  - an unrecognized envelope → `unknown`
  - bare string of each phrase → same bucket
  - `null`/`undefined` input → `unknown` (no throw)
**Edge cases:**
  - envelope with no `content` array (e.g., `{ error: "x" }`) → `unknown`,
    no throw.
  - multiple content blocks — concatenate text from all text blocks before
    matching.
  - `message` present AND `content` present — prefer `content` (the actual
    tool-error shape), but fall back to `message` if `content` has no text.

## Constraints and dependencies

- No schema change; no migration. Capture-only.
- No new capture flag — works on the already-stored error signal path. The
  raw-envelope capture flag lives in `error-raw-capture` (separate task).
- Don't overfit the matchers to one provider — keep the substring approach;
  the pluggable parser (later task) is where per-tool customization goes.
