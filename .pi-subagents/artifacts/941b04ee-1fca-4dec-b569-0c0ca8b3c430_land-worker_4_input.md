# Task for land-worker

Land slice "session-events-capture" for task "pi-telemetry".
Slice doc: docs/tasks/pi-telemetry/slices/5-session-events-capture.md
Task doc: docs/tasks/pi-telemetry/task.md
TDD output: # Session-shape events capture — implementation result

Slice `session-events-capture` for task `pi-telemetry` is complete on branch `slice/session-events-capture`.

## What changed

- `src/capture/session-events.ts` — new handler module exporting `registerSessionEventsCapture(pi, t)`.
  - Maps `session_before_compact` / `session_compact` → `compaction`
  - Maps `model_select` → `model_change`
  - Maps `thinking_level_select` → `thinking_change`
  - Maps `session_before_fork` → `branch`
  - Maps `session_tree` → `tree_nav`
  - Each row gets a UUID `event_id`, the current `session_id`, `unix_ms = t.now()`, a JSON `payload`, and the mapped `type`.
  - Payloads are built only from documented event fields; absent / null fields are omitted, never fabricated.
  - JSON serialization failure is caught, logged to `telemetry_meta`, and the handler continues with an empty payload object.
- `src/capture/index.ts` — re-exports `registerSessionEventsCapture`.
- `index.ts` — registers the new handler in the extension entry.
- `test/session-events.test.ts` — 11 new L1 unit tests covering all five event types, missing-field omission, no-session skip, same-leaf tree nav, and `unix_ms` ordering.

## Divergence from plan

1. **`from_extension` on `session_before_compact`:** the slice doc lists `from_extension` as part of the `compaction` payload for both `session_before_compact` and `session_compact`. The installed Pi type `SessionBeforeCompactEvent` does not expose a `fromExtension` field (it cannot be known before compaction runs), so `from_extension` is emitted only for `session_compact`. This follows the spec rule that absent fields are omitted, not fabricated.
2. **`model_change` payload shape:** the slice doc says "from→to model, source". To remain useful for cross-provider telemetry queries, the payload uses `from`/`to` objects containing `{ provider, id }` rather than bare model id strings. The `source` field is emitted exactly as documented.
3. **`session_before_tree` not handled:** it is outside the slice doc's listed event types and is intentionally left for future work.

## Validation

- `node --test test/session-events.test.ts` — 11/11 passing.
- `npm test` — full suite 35/35 passing.
- `npm run check` — `tsc --noEmit` clean.

## Notable events

- Top-level `@earendil-works/pi-coding-agent` does not export `ModelSelectEvent` / `ThinkingLevelSelectEvent`, so the handler uses contextual typing from the `pi.on` overloads rather than explicit type annotations.
- Pre-existing `.pi-subagents/artifacts` churn and `docs/tasks/state.yaml` modifications were left unstaged; only slice-relevant files were committed.

## Acceptance report

Output saved to: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/941b04ee-1fca-4dec-b569-0c0ca8b3c430/tdd-session-events-capture/result.md (2.6 KB, 37 lines). Read this file if needed.. Verify output: # Verify: session-events-capture

Slice `session-events-capture` on branch `slice/session-events-capture` — verified.

## Quality gate

1. **Lint** (`npm run check` → `tsc --noEmit`): passed, zero errors.
2. **Slice tests** (`node --test test/session-events.test.ts`): 11/11 passing.
3. **Full project suite** (`npm test` → `node --test 'test/**/*.test.ts'`): 35/35 passing across all 10 suites.

## Summary

Slice `session-events-capture` verified — lint clean, slice tests passing, full project suite green.

Output saved to: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/941b04ee-1fca-4dec-b569-0c0ca8b3c430/verify-session-events-capture/result.md (517 B, 13 lines). Read this file if needed..

Merge the slice branch into the task branch, archive the slice doc, commit.
Set task_set status done on the slice.

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/941b04ee-1fca-4dec-b569-0c0ca8b3c430/land-session-events-capture/result.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```