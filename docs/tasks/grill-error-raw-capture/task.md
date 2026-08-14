---
kind: task
type: grilling
slug: grill-error-raw-capture
title: "Decide the opt-in raw error-capture approach: dedicated flag vs reuse toolResults"
map: telemetry-signal-gaps
status: ready
blocked_by: []
slices: []
---

## Decision to settle

We want an opt-in way to collect the raw fields `classifyError` parses (the
tool-error envelope `{ content: [{ type: "text", text }] }`) so we can
evaluate real error shapes and later feed the pluggable parser. One question
at a time; never answer on the user's behalf:

1. **Capture approach.** A dedicated `capture.toolErrorRaw` flag storing
   `result_text` only for `is_error=1` rows (minimal privacy footprint,
   targeted at the classifier problem; `toolArgs` / `toolResults` stay
   separate and off by default) **vs** reusing the existing
   `capture.toolResults` flag (captures all results incl. errors; simpler
   config, broader content exposure since success results are stored too).
2. **Storage shape.** Store the raw envelope as-is (the JSON string of
   `event.content` / `event.result`) in `result_text`, or extract/normalize
   it first (concatenated text from content blocks). Raw-as-is preserves
   everything for future parser design; normalized loses structure but is
   cheaper and directly consumable.
3. **Scope of "error."** `is_error=1` only, or also `http_status` non-2xx
   LLM responses (a different table — `llm_requests`)? The classifier gap is
   tool-only; decide if LLM error bodies are in or out of this flag.
4. **Warning behavior.** The existing content flags show a one-time warning
   when enabled (SPEC §7). Confirm the same applies, or whether an
   error-only flag warrants a lighter touch (errors are a smaller privacy
   surface but may contain stack traces / file paths).

## Parent decisions it depends on

- The review's verdict that the classifier is shape-blind and needs real
  envelopes to evaluate (task `error-classifier-envelope` confirms the shape
  but can't see today's stored text).
- SPEC §7 config + privacy posture (no content by default; flags ship OFF).
- This task does **not** depend on `error-classifier-envelope` being done —
  the capture approach is orthogonal to the built-in classifier fix.

## Choices already known

- An opt-in flag is wanted (user decision: "add some (opt-in) flag to collect
  the raw fields we are parsing there, so we can evaluate how they look like").
- Default is OFF (privacy posture).
- The data this collects feeds `grill-pluggable-parser` (the pluggable
  parser design benefits from seeing real envelopes).

## Recommended starting answer

**Dedicated `capture.toolErrorRaw` flag, raw envelope as-is, `is_error=1`
rows only, reuse the existing one-time warning path.** Rationale: targeted at
the actual gap (error envelopes), minimal privacy footprint, and raw-as-is
preserves the structure the pluggable parser will need. Present this as the
first option but let the user override on any of the four axes.

## What downstream work the answer may create

- Graduates `error-raw-capture` (feature) into precise slices: config flag +
  migration-free column reuse (the existing `result_text` column is already
  present, just unpopulated) + capture path + warning + tests.
- May shrink `error-raw-capture` scope if LLM error bodies are ruled out (or
  expand it to `llm_requests` if in — that would need a new column).
- Feeds `grill-pluggable-parser`: the raw shapes collected here inform the
  parser hook design. The user may want to enable the flag and collect data
  before running the pluggable-parser grilling (recorded in map Fog).
