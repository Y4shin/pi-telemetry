---
kind: slice
slug: capture-error-envelopes
title: Store result_text for is_error rows when the raw-error flag is enabled
task: ../task.md
mode: afk
status: done
size: s
blocked_by:
  - add-tool-error-raw-flag
---

## End-to-end behavior

With the raw-error flag on, `tool_result` / `tool_execution_end` stores the
error envelope in `result_text` for `is_error=1` rows, **raw-as-is** (JSON of
`event.content`/`event.result`, per grilling decision). Off → `result_text`
stays `NULL`.

## Acceptance criteria

- [x] `src/capture/tools.ts` `stageResult` / `insertToolExecution` writes
      `result_text` for error rows when the flag is on, storing the raw
      envelope as-is (`JSON.stringify(event.content)`/`event.result`) — NOT
      extracted/normalized text (grilling decision: raw-as-is preserves the
      shape the pluggable parser needs).
- [x] Success rows: `result_text` stays `NULL` even with the flag on (this is
      the errors-only flag, not `toolResults`).
- [x] With the flag off, no `result_text` is written (privacy test holds).
- [x] Unit test: flag on + `is_error=1` → `result_text` populated with the raw
      envelope JSON; flag on + `is_error=0` → `NULL`; flag off → `NULL` for
      both.

## Test plan

**Seam:** `test/tools.test.ts` + `test/privacy.test.ts`.
**Scenarios:** error row with flag on (populated with raw envelope JSON,
      including multi-block + non-text-block preservation); success row with
      flag on (NULL); any row with flag off (NULL); envelope with no content
      array (store the raw `{error:...}` shape, don't throw).
**Edge cases:** very large error text — enforce the same cap the feedback
      path uses if a cap is decided in grilling (Fog: cap policy for raw
      errors; grilling did not set one — default to no cap, or reuse
      `feedbackMaxBytes` — decide in-slice and document).
**Privacy regression:** `test/privacy.test.ts` default-config run must still
      assert zero non-null `result_text` (the flag default is off).

## Constraints and dependencies

- Depends on `add-tool-error-raw-flag`.
- Reuses the existing `result_text` column — no migration.
- Grilling decisions (raw-as-is shape, tool-only scope) are the contract for
  this slice's `WHERE`/`if` conditions.
