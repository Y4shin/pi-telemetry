---
kind: task
type: feature
slug: error-raw-capture
title: "Opt-in capture of raw tool-error envelopes for classifier evaluation"
map: telemetry-signal-gaps
status: ready
blocked_by:
  - grill-error-raw-capture
slices:
  - add-tool-error-raw-flag
  - capture-error-envelopes
---

## User-visible outcome

When `capture.toolErrorRaw` (name pending grilling confirmation) is enabled,
pi-telemetry stores the raw tool-error envelope (`result_text` for
`is_error=1` rows) so users and the pluggable parser can see what errors
actually look like. Off by default; enabling shows the existing one-time
privacy warning.

## User story

As someone debugging why `error_class` is always `unknown`, I enable the raw
error-capture flag, run a session, then query `result_text` for error rows
to see the real envelope and design / validate error classification against
it.

## Scope boundaries

- **In:** one new `capture` flag (or reuse `toolResults` per grilling), the
  capture path that stores `result_text` for error rows, the config parsing,
  and the one-time warning reuse. No new column (the existing `result_text`
  column is already in the schema and unpopulated).
- **Out:** reclassifying historical `unknown` rows (no raw text was stored),
  the pluggable parser itself (separate task `pluggable-error-parser`), and
  (per grilling) LLM error bodies unless explicitly scoped in.
- **Privacy:** default OFF. SPEC §7 posture. Enabling shows the one-time
  warning the existing content flags use.

## Acceptance criteria

- [ ] The chosen capture flag (grilling decision) is parsed in `config.ts`
      with default `false`, env-var + settings.json overrides consistent
      with the existing flags.
- [ ] When enabled, `tool_result`/`tool_execution_end` stores `result_text`
      for `is_error=1` rows (per grilling: raw-as-is vs normalized).
- [ ] When disabled, `result_text` stays `NULL` (no behavior change for
      existing users).
- [ ] Enabling the flag emits the one-time privacy warning (reuse the
      existing path; SPEC §7).
- [ ] Privacy test: default-config run asserts zero non-null `result_text`,
      including error rows.
- [ ] `SPEC.md` §7 config table documents the new flag.

## Existing abstractions to use

- `src/config.ts` `CaptureConfig` + `loadConfig` parsing pattern (env-var
  → settings → default).
- `src/capture/tools.ts` `stageResult` / `insertToolExecution` already take
  an `includeText`-style decision and write `result_text` gated on
  `t.config.capture.toolResults`; the error-only path reuses this with an
  `is_error` condition.
- The one-time warning path used by `toolArgs` / `toolResults`.

## Architecture / domain decisions

- The `result_text` column already exists (SPEC §2) and is 0% populated today
  because the flags default off — no migration is needed to add this.
- Grilling decision (task `grill-error-raw-capture`) fixes the exact flag
  name, storage shape (raw vs normalized), error scope (tool-only vs +LLM),
  and warning behavior. This task implements the result.
