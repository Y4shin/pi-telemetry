---
kind: slice
slug: dispatch-with-precedence
title: Dispatch classifyError through user parser + built-in fallback per grilling precedence
task: ../task.md
mode: afk
status: todo
size: m
blocked_by:
  - declare-error-parser
---

## End-to-end behavior

`classifyError` dispatches through the user-declared parser and the built-in
classifier in the grilling-chosen precedence (before-with-fallback
recommended), so `error_class` reflects user patterns where they match and
the built-in buckets otherwise.

## Acceptance criteria

- [ ] `classifyError` in `src/capture/tools.ts` consults the user parser
      (pattern map and/or function) and the built-in classifier in the
      grilling-decided order.
- [ ] With no user parser declared, behavior is identical to
      `error-classifier-envelope`'s fixed classifier (built-in only).
- [ ] Vocabulary enforcement per grilling: user classes mapped into the
      bounded set, or accepted free-form, as decided.
- [ ] A user-parser throw is caught → falls back to built-in + a
      `telemetry_meta` note (never breaks the session).
- [ ] Unit tests for each precedence outcome: user match wins; no user
      match → built-in; user parser throws → built-in + meta; no user parser
      → built-in only.

## Test plan

**Seam:** `test/tools.test.ts` driving `classifyError` with a declared
      parser.
**Scenarios (before-with-fallback):** user pattern matches "ETIMEDOUT" →
      user class; user pattern misses, built-in matches "ENOENT" →
      `not_found`; both miss → `unknown`; user function throws → built-in
      result + meta row.
**Edge cases:** user class outside bounded vocabulary (per grilling: reject
      → `unknown` + meta, or accept); function parser returning non-string;
      pattern map with overlapping matches (first-wins or specificity —
      decide in grilling, document in test).
**Privacy/regression:** default-config (no parser) behavior unchanged from
      `error-classifier-envelope`.

## Constraints and dependencies

- Depends on `declare-error-parser` (config must be parseable first).
- Depends on `error-classifier-envelope` being done (the built-in fallback
      must be correct).
- `SPEC.md` §1.5 amended to document precedence + vocabulary decision.
