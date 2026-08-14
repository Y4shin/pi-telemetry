---
kind: slice
slug: capture-error-envelopes
title: Store result_text for is_error rows when the raw-error flag is enabled
task: ../task.md
mode: afk
status: todo
size: s
blocked_by:
  - add-tool-error-raw-flag
---

## End-to-end behavior

With the raw-error flag on, `tool_result` / `tool_execution_end` stores the
error envelope in `result_text` for `is_error=1` rows, in the grilling-chosen
shape (raw-as-is or normalized text). Off → `result_text` stays `NULL`.

## Acceptance criteria

- [ ] `src/capture/tools.ts` `stageResult` / `insertToolExecution` writes
      `result_text` for error rows when the flag is on, in the grilling-decided
      shape (raw JSON of `event.content`/`event.result`, or extracted text).
- [ ] Success rows: `result_text` stays `NULL` even with the flag on (this is
      the errors-only flag, not `toolResults`).
- [ ] With the flag off, no `result_text` is written (privacy test holds).
- [ ] Unit test: flag on + `is_error=1` → `result_text` populated; flag on +
      `is_error=0` → `NULL`; flag off → `NULL` for both.

## Test plan

**Seam:** `test/tools.test.ts` + `test/privacy.test.ts`.
**Scenarios:** error row with flag on (populated, expected shape); success
      row with flag on (NULL); any row with flag off (NULL); envelope with
      multiple content blocks; envelope with no text blocks.
**Edge cases:** very large error text — enforce the same cap the feedback
      path uses if a cap is decided in grilling (Fog: cap policy for raw
      errors).
**Privacy regression:** `test/privacy.test.ts` default-config run must still
      assert zero non-null `result_text` (the flag default is off).

## Constraints and dependencies

- Depends on `add-tool-error-raw-flag`.
- Reuses the existing `result_text` column — no migration.
- Grilling decisions on storage shape + scope (tool-only vs +LLM) are the
  contract for this slice's `WHERE`/`if` conditions.
