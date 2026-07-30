# Task for deviation-reporter

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Check slice "feedback-collector" of task pi-telemetry for deviations from the arch spec and slice doc.

Slice doc: docs/tasks/pi-telemetry/slices/6-feedback-collector.md
Arch spec: docs/tasks/pi-telemetry/arch-spec.md
Implementation: # Slice result: feedback-collector

## Summary

Implemented `src/feedback.ts` exporting `registerFeedback(pi, t)` and wired it into `index.ts`. The slice delivers:

- A shared `validateAndSerialize` + `handleFeedback` path used by both the `pi-telemetry:submit-feedback` bus listener and the `submit_feedback` agent tool.
- Bus listener registered at extension load; emit without pi-telemetry is a documented no-op.
- Validation: non-empty `source`/`kind`; `data` serialized as JSON (objects) or stored raw (strings); UTF-8 byte cap against `config.feedbackMaxBytes`.
- Violations → `telemetry_meta.feedback_rejected`; no path throws.
- Tool forces `source = "pi"`, describes the **local** telemetry store, and omits `promptGuidelines` per SPEC §5.2.
- Enrichment: `session_id`, `run_id`, `turn_index`, `received_unix_ms`. (Lineage lives on `sessions` per the schema and is reachable by join; the feedback table has no lineage columns.)
- Tool `execute` is guarded so telemetry never breaks the Pi session; DB failures are recorded to `telemetry_meta` and the tool still returns a success-neutral result.

Tests added in `test/feedback.test.ts` cover bus happy path, malformed payload rejection, oversized payload rejection, tool source forcing, string vs object data serialization, exactly-at-cap acceptance, buffering before flush, DB-failure handling, and ordering by `received_unix_ms`.

## Divergence from plan

- **Lineage enrichment:** The slice doc calls for enriching feedback with lineage (`agent_label`, `depth`). SPEC §2's `feedback` table does not include lineage columns, and the arch spec amendment places lineage on `sessions`. This implementation records correlation IDs (`session_id`, `run_id`, `turn_index`) so lineage is available via join to `sessions`; no schema change was made.
- **Tool `label`:** SPEC §5.2's snippet omitted `label`, but the installed `ToolDefinition` type requires it. Added `label: "Submit Feedback"`.
- **"No active session" guard:** Added an explicit rejection path that records `feedback_rejected` when feedback arrives before `session_start`, because `feedback.session_id` is `NOT NULL` and the telemetry proxy has no session context yet.
- **Tool execute guard:** Added a try/catch around `handleFeedback` inside the tool executor to ensure any unexpected synchronous error is funnelled through `guard(t, …)` and the tool still returns a neutral success result.

## Notable events

- Existing full suite (35 tests) remained green after the change; the new feedback suite adds 11 tests for a total of 46/46 passing.
- `tsc --noEmit` is clean.

Output saved to: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/9ab87caa-5aeb-4e6e-a240-fe0d9f90c0a5/tdd-feedback-collector/result.md (2.5 KB, 27 lines). Read this file if needed..

Check specifically: one shared validate+serialize function (not duplicated logic between bus and tool); tool forces source="pi"; validation/64KiB cap behavior; SPEC §9 bus tests (no-listener no-op, malformed → meta no throw).
Write the deviation report to docs/tasks/pi-telemetry/deviation-reports/feedback-collector.md. If the task doc's ## Implementation notes needs updating, note it.

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/9ab87caa-5aeb-4e6e-a240-fe0d9f90c0a5/deviation-feedback-collector/result.md
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