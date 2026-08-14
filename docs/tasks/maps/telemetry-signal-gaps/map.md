---
kind: map
slug: telemetry-signal-gaps
title: Fix the genuine capture-accuracy gaps from the telemetry-signals-inventory review
status: active
tasks:
  - ttft-first-token-fix
  - error-classifier-envelope
  - grill-error-raw-capture
  - error-raw-capture
  - grill-pluggable-parser
  - pluggable-error-parser
  - retry-seam-research
  - retry-linkage
  - retry-parse-hole
---

## Destination

All genuine capture-accuracy defects surfaced by the `telemetry-signals-inventory`
review are fixed, and the two extensibility seams the user wants — opt-in raw
error capture and a pluggable error classifier — are designed (grilled) and
shipped. After this map, TTFT, error classification, and retry headers are
measured correctly, and error parsing is extensible.

## Constraints

- **v1 privacy posture.** No content by default. Any new raw-capture flag
  ships OFF; enabling shows the existing one-time warning path.
- **Forward-only migrations.** `PRAGMA user_version` gated, idempotent. The
  TTFT data-correction migration runs once on upgrade from `<= 0.4.0`
  (`user_version < 5`) and is a no-op on fresh DBs (empty table).
- **Telemetry must never break a session** (existing SPEC §3 constraint).
- **No upstream Pi changes assumed.** Retry linkage must work with existing
  Pi events or be documented as blocked by a missing upstream seam.
- **SPEC conformance.** `error_class` stays a bounded category string (SPEC
  §1.5); new capture flags extend the §7 config block; migrations follow §8.

## Decisions so far

- **Scope excludes the other agent's misidentified items.** `args_json` /
  `result_text` 0% (by design — flags default off), `write_failed` "data loss"
  (benign duplicate-PK rejection via `INSERT OR IGNORE` + drop), `bash_executions`
  (deprecated), `feedback` / `session_events` sparseness (adoption, not capture),
  `depth` / `parent_run_id` null (lineage not wired — separate future map per
  HANDOFF coherence-refactor #1). All documented in Out of scope.
- **TTFT.** Gate `firstUpdateMs` on `assistantMessageEvent.type === 'text_delta'`
  (the root cause: `llm.ts:115` fires on the first update of *any* type). Null
  historically mis-measured `ttft_ms` values via a version-gated migration
  (user decision: "set the cells that have nonsensical/wrong values as null").
- **Error classifier.** Fix the envelope shape mismatch first (read content-block
  text, not `err.message` / `err.code`). Add opt-in raw error capture (approach
  decided by grilling). Add a pluggable parser (design decided by a second
  grilling, after the fix lands).
- **Retry.** Fix the HTTP-date `Retry-After` parse hole. Research whether a
  Pi retry seam exists; if feasible, add `attempt` / `parent_request_id`
  linkage.
- **Error raw capture (grilled 2026-08-14).** Dedicated `capture.toolErrorRaw`
  flag (default OFF), storing the raw error envelope as-is (JSON of
  `event.content`/`event.result`) in `result_text` for `is_error=1` rows only.
  Tool errors only (no LLM error bodies). Reuse the SPEC §7 one-time warning —
  but NOTE: that warning is spec'd but NOT implemented today, so the feature
  task implements it for the first time (and backfills toolArgs/toolResults).

## Fog

- Real error-envelope data (from `error-raw-capture`) would inform the
  pluggable-parser grilling; the user may want to enable the raw flag and
  collect data before `grill-pluggable-parser` runs.
- The 455 fully-degenerate TTFT rows (`duration_ms=0 AND stream_ms=0`, no
  generation) — should `ttft` be `NULL` or `0` there? The migration's `WHERE`
  clause must decide; 0 ms is physically impossible for networked providers,
  but these represent "no first token arrived," which is arguably `NULL`.
- Retry linkage may surface an upstream blocker (no Pi retry seam); if so,
  `retry-linkage` stops with a clear discovery and returns to Wayfinder.
- Whether `error-raw-capture` and `pluggable-error-parser` should share one
  capture column or stay separate — the grillings may converge them.

## Out of scope

- `args_json` / `result_text` 0% population — by design (capture flags default
  off; SPEC §7). Not a defect.
- `write_failed` 8,802 rows — benign duplicate-`tool_call_id` rejection
  (`INSERT OR IGNORE` + explicit drop in `buffer.ts`). Not data loss.
- `bash_executions` deprecation — already handled (task:
  `deprecate-bash-executions`).
- `feedback` sparseness (3 rows) — adoption, not a capture defect.
- `session_events` / `session_event_metadata` sparseness — adoption.
- `sessions.depth` / `parent_run_id` null — lineage not wired (pi-subagents
  does not emit bus events today); belongs to a separate lineage map per
  HANDOFF coherence-refactor #1.
- The inventory doc's own overcalls (TTFT "~99% zero", `write_failed`
  "data-integrity threat") — corrected in the review verdict, not extension
  work.
