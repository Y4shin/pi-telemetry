---
kind: task
type: feature
slug: error-raw-capture
title: "Opt-in capture of raw tool-error envelopes for classifier evaluation"
map: telemetry-signal-gaps
status: done
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

- [x] The chosen capture flag (grilling decision) is parsed in `config.ts`
      with default `false`, env-var + settings.json overrides consistent
      with the existing flags.
- [x] When enabled, `tool_result`/`tool_execution_end` stores `result_text`
      for `is_error=1` rows (per grilling: raw-as-is vs normalized).
- [x] When disabled, `result_text` stays `NULL` (no behavior change for
      existing users).
- [x] Enabling the flag emits the one-time privacy warning (reuse the
      existing path; SPEC §7).
- [x] Privacy test: default-config run asserts zero non-null `result_text`,
      including error rows.
- [x] `SPEC.md` §7 config table documents the new flag.

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

## Implementation notes

- **add-tool-error-raw-flag** (slice 1/2): Added the `capture.toolErrorRaw`
  boolean to `CaptureConfig` in `src/config.ts` (`DEFAULTS.capture`, env
  `PI_TELEMETRY_CAPTURE_TOOL_ERROR_RAW`, and settings.json parsing all follow
  the existing `toolArgs`/`toolResults` pattern; default `false`). Documented
  in `SPEC.md` §7 config table. Implemented the one-time content-capture
  privacy warning for the first time — a new `maybeEmitContentCaptureWarning`
  export in `src/capture/tools.ts` fires once per session (gated by a new
  `contentCaptureWarningShown` boolean on `RuntimeState` in `src/state.ts`)
  when ANY content-capture flag (`toolArgs`/`toolResults`/`toolErrorRaw`) is on,
  backfilling the warning for `toolArgs`/`toolResults` which had no warning
  before. The warning is invoked from the three tool-capture event handlers
  (`tool_execution_start`, `tool_result`, `tool_execution_end`); the boolean
  is set before emitting so a throw in the meta channel cannot cause a retry
  storm, and the `catch` swallows failures (telemetry never breaks a
  session). Tests in `test/config.test.ts`: flag default off, env on, settings
  on, env-overrides-settings-off, invalid-value-fallback, warning fires once,
  warning not emitted when all flags off. 12 test files updated to add
  `toolErrorRaw: false` to existing config literals. Full suite 246/246 green,
  tsc clean. No capture behavior changed — `result_text` stays NULL until
  slice 2.

- **capture-error-envelopes** (slice 2/2): Implemented the raw error-envelope
  capture path. Extended `StagedResult` in `src/capture/tools.ts` with a new
  `rawResultText: string | null` field populated at stage time via
  `safeJsonStringify(result)` (the raw envelope, as-is). `insertToolExecution`
  now writes `result_text` using the precedence chain: `capture.toolErrorRaw &&
  staged.isError` → `staged.rawResultText`; else `capture.toolResults` →
  `staged.resultText`; else `NULL`. Both event paths (`tool_result` and
  `tool_execution_end`) route through the same `stageResult`/`insertToolExecution`
  so coverage is uniform. Success rows stay `NULL` even with the flag on
  (errors-only flag); flag off → `NULL` for all rows (privacy test unchanged).
  Added 6 unit tests in `test/tools.test.ts`: flag-on+`is_error=1` (raw
  envelope JSON), flag-on+`is_error=0` (NULL), flag-off+`is_error=1` (NULL),
  multi-block + non-text-block preservation, envelope without a `content`
  array stored as-is, and `tool_result` event path. Full suite 252/252 green,
  tsc clean.
  **Cap policy decision:** grilling left the raw-error cap undecided; this
  slice implements **no cap** (documented in an inline comment in
  `insertToolExecution`). Rationale: tool error envelopes are protocol-bounded,
  the flag is opt-in, and truncating JSON would corrupt the raw-as-is shape
  the pluggable parser needs. If a cap is ever required, `feedbackMaxBytes` is
  the sane default to reuse. No schema change, no migration, no LLM
  error-body capture (tool-only scope).
