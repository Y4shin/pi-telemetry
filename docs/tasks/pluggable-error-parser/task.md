---
kind: task
type: feature
slug: pluggable-error-parser
title: "User-extensible tool-error classification (pattern map / function hook)"
map: telemetry-signal-gaps
status: ready
blocked_by:
  - grill-pluggable-parser
slices:
  - declare-error-parser
  - dispatch-with-precedence
---

## User-visible outcome

Users can declare their own tool-error classification (a pattern map and/or a
function, per grilling) that extends or overrides the built-in `classifyError`
buckets, so `tool_executions.error_class` can reflect tool- or
project-specific error vocabulary without editing the extension.

## User story

As a user of a tool with non-standard error strings (e.g. a custom MCP tool
that returns `{"error":"RATE_LIMIT"}`), I declare a pattern mapping
`RATE_LIMIT → rate_limit` (or a small function) in my settings, and subsequent
`tool_executions` rows carry `error_class = 'rate_limit'` instead of
`unknown`.

## Scope boundaries

- **In:** the config declaration surface (grilling-decided), the dispatch
  logic that runs the user parser before/after/replacing the built-in
  `classifyError` (grilling-decided precedence), bounded-vs-free-form
  vocabulary (grilling-decided), and tests for each precedence mode.
- **Out:** changing the built-in 5-bucket set (that's `error-classifier-envelope`'s
  domain), historical reclassification, and any UI for authoring patterns
  (declarative config only).
- **Trust:** all local extensions are trusted (SPEC §5 posture); a
  function-loading path inherits that trust and must document it.

## Acceptance criteria

- [ ] A user can declare the parser via the grilling-chosen config surface
      (settings key and/or file path).
- [ ] Dispatch follows the grilling-chosen precedence (before-with-fallback
      recommended); built-in classifier is the out-of-the-box default when no
      user parser is declared.
- [ ] Vocabulary is bounded to the SPEC set, or free-form with a documented
      amendment, per grilling.
- [ ] Unit tests: user pattern matches → user class; no user match →
      built-in fallback; user parser absent → built-in only; precedence mode
      behaves as chosen.
- [ ] `SPEC.md` §1.5 / §7 amended to document the parser declaration +
      precedence + trust note.

## Existing abstractions to use

- `src/capture/tools.ts` `classifyError` — the dispatch point; the pluggable
  parser wraps it.
- `src/config.ts` `loadMergedSettings` + `loadConfig` — the config surface for
  the declaration.
- SPEC §5 trust posture ("all locally installed extensions are trusted") as
  the precedent for loading user-supplied code.

## Architecture / domain decisions

- Grilling (`grill-pluggable-parser`) fixes hook shape, precedence, config
  surface, vocabulary, and default behavior. This task implements the result.
- The built-in classifier (fixed in `error-classifier-envelope`) remains the
  default; the pluggable parser is opt-in and layered on top.
