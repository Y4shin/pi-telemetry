---
kind: task
type: grilling
slug: grill-pluggable-parser
title: "Design the pluggable error-classification parser (hook shape, config surface, precedence)"
map: telemetry-signal-gaps
status: ready
blocked_by:
  - error-classifier-envelope
  - error-raw-capture
slices: []
---

## Decision to settle

The built-in `classifyError` (fixed in `error-classifier-envelope`) handles a
fixed 5-bucket substring set. The user wants user-extensible error parsing.
Settle, one question at a time, never answering on the user's behalf:

1. **Hook shape.** A user-supplied function (loaded how — settings path to a
   module? an exported factory?) **vs** a declarative pattern map (settings
   `errorPatterns: [{ match: "ETIMEDOUT", class: "timeout" }]`) **vs** both
   (function for power users, pattern map for simple cases). Trade-off:
   functions are fully expressive but un-sandboxable in-process; pattern maps
   are safe and declarative but limited.
2. **Precedence.** Does a user parser/supplied pattern **replace** the
   built-in `classifyError`, **run before it** (user wins on match, built-in
   is fallback), or **run after it** (built-in wins, user fills the gaps)?
   "Before with fallback" is the likely default — present it first.
3. **Config surface + loading.** Where does the user declare the parser —
   `~/.pi/agent/settings.json` / project `.pi/settings.json` under
   `pi-telemetry.errorClassifier`? A separate file path? How is a function
   safely loaded (Node `require`/`import` of a user path is a trust
   boundary — all local extensions are trusted per SPEC §5, but document it).
4. **Bucket vocabulary.** Keep the SPEC's bounded set
   (`timeout|not_found|permission|validation|unknown`) and force user
   patterns into it, or allow user-defined categories (free-form `error_class`
   strings)? Bounded keeps queries clean; free-form is more flexible but can
   fragment the dimension.
5. **Default behavior.** Out of the box (no user config), is the built-in
   fixed classifier the only thing that runs, or is there a documented
   no-op default that users override? Confirm "built-in fixed classifier is
   the default; pluggable is opt-in."

## Parent decisions it depends on

- `error-classifier-envelope` (the fixed built-in classifier must be correct
  before layering a pluggable one on top — otherwise the pluggable parser
  papers over a still-broken default).
- `error-raw-capture` (the raw envelopes it collects are the evidence for
  designing the pattern map / function contract; the user may want to collect
  data with the flag before this grilling — map Fog item 1).

## Choices already known

- Pluggable parsing is wanted as separate tasks after the fix (user decision:
  "pluggable parser too as separate tasks inside this map, first the fix then
  the pluggable parser").
- The pluggable parser needs this grilling to align on how it should work
  before implementation (user decision: "should need a grilling session to
  align on how it should work first").
- Built-in 5-bucket classifier is the fallback/default (SPEC §1.5 bounded
  category).

## Recommended starting answer

**Pattern map in settings + optional function path; user-before-built-in with
built-in fallback; bounded vocabulary with an escape hatch for custom
categories; built-in classifier is the out-of-the-box default.** Present as
the first option per question; let the user override each axis.

## What downstream work the answer may create

- Graduates `pluggable-error-parser` (feature) into precise slices:
  config/schema for the parser declaration, the precedence/dispatch logic in
  `classifyError`, and tests for each precedence mode.
- May require a small SPEC §1.5 / §7 amendment if custom categories are
  allowed (un-bounding `error_class`) — record the decision.
- If a function-loading path is chosen, a trust-boundary note in SPEC §7
  (mirrors the §5 "all locally installed extensions are trusted" posture).
