# Architecture spec — error-raw-capture

**Task:** `error-raw-capture` (feature, 2 slices)
**Map:** `telemetry-signal-gaps`
**Grilling basis:** `docs/tasks/grill-error-raw-capture/task.md` (decisions
settled 2026-08-14)

The grilling settled: a dedicated `capture.toolErrorRaw` flag (default OFF)
stores the raw error envelope as-is (`JSON.stringify(event.content)`/
`event.result`) in `result_text` for `is_error=1` rows only. Tool errors
only. Reuse/implement the SPEC §7 one-time warning.

## Exports / public API surface

- **Config:** `capture.toolErrorRaw: boolean` (default `false`) in
  `CaptureConfig`, parsed from env (`PI_TELEMETRY_CAPTURE_TOOL_ERROR_RAW`)
  + settings.json, following the existing `toolArgs`/`toolResults` pattern.
- **Capture:** `src/capture/tools.ts` writes the raw envelope to
  `result_text` for error rows when the flag is on. No new column — the
  existing `result_text` is reused.
- **Warning:** a one-time content-capture warning emitted when any content
  flag is on (new mechanism — see slice 1).
- **Docs:** `SPEC.md` §7 config table gains the flag.

## Existing abstractions to use

- `src/config.ts` `CaptureConfig` + `loadConfig` — add `toolErrorRaw` next
  to `toolArgs`/`toolResults`; parse via the existing `boolEnv`/`parseBool`
  + settings `fromBlock.capture` path; default `false`.
- `src/capture/tools.ts` `stageResult`/`insertToolExecution` — the
  `result_text` value is currently `captureResults ? staged?.resultText :
  null`. Add an errors-only path: when `capture.toolErrorRaw` is on AND
  `staged.isError`, write the **raw envelope** (not `staged.resultText`,
  which is the *extracted* text from `computeResultMetrics`). The raw
  envelope must be captured at `stageResult` time (where `event.content`/
  `event.result` is in scope) and carried in `StagedResult`, because
  `insertToolExecution` no longer has the original event object.
- `src/capture/tools.ts` `safeJsonStringify` — reuse to serialize the
  envelope.
- `result_text` column — already in `tool_executions` schema (SPEC §2),
  0% populated today. No migration.

## Do NOT reimplement

- Do not extract/normalize text for `result_text` (grilling decision: raw
  envelope as-is). The existing `computeResultMetrics` extracted text path
  stays for the `toolResults` flag; `toolErrorRaw` is a separate, raw path.
- Do not capture success results (errors-only flag).
- Do not add an `llm_requests.error_body` column (grilling decision: tool
  errors only).
- Do not add a cap policy beyond reusing `feedbackMaxBytes` if needed
  (grilling left the cap undecided; reuse `feedbackMaxBytes` as the sane
  default if a cap is needed — decide in-slice, document).

## Interface contract between slices

- **Slice 1 (`add-tool-error-raw-flag`)** exports the parsed
  `capture.toolErrorRaw` boolean on `TelemetryConfig` (default `false`) +
  the one-time warning mechanism. Slice 2 depends on the flag being
  parseable and on the warning existing.
- **Slice 2 (`capture-error-envelopes`)** consumes `t.config.capture.toolErrorRaw`
  in `insertToolExecution` and writes the raw envelope to `result_text` for
  `is_error=1` rows. It must extend `StagedResult` to carry the raw envelope
  (set in `stageResult`), since `insertToolExecution` lacks the original
  event object.

## The one-time warning mechanism (slice 1, new)

SPEC §7 says "enabling shows a one-time warning" but no warning is
implemented today. Slice 1 implements it for the first time, covering
`toolErrorRaw` AND backfilling `toolArgs`/`toolResults` for §7 consistency.
Design: emit once per session when any content-capture flag is on, via a
session-scoped boolean (on `RuntimeState` or a module flag) set on first
observation. Must never throw (SPEC §3). The exact emission channel (e.g.
`console.warn` at `session_start`, or a `telemetry_meta` note) is an
in-slice decision — prefer the existing `t.meta` path for testability, or
`console.warn` if the warning must reach the user before any telemetry
row. Document the choice.

## Out of scope

- No schema change / migration (the `result_text` column exists).
- No historical backfill (flag is off by default; legacy rows stay NULL).
- No LLM error-body capture.
- The pluggable parser is a separate task (`pluggable-error-parser`).
