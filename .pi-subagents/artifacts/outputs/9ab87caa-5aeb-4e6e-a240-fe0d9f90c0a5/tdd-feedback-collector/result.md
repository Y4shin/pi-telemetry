# Slice result: feedback-collector

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

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented only the feedback collector scope: src/feedback.ts, index.ts wiring, and test/feedback.test.ts. No unrelated files changed."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "All 46 tests pass (including 11 new feedback tests); tsc --noEmit clean; changed files, commands run, and residual risks listed below."
    }
  ],
  "changedFiles": [
    "src/feedback.ts",
    "index.ts",
    "test/feedback.test.ts"
  ],
  "testsAddedOrUpdated": [
    "test/feedback.test.ts"
  ],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "46/46 tests passing across 11 suites"
    },
    {
      "command": "npm run check",
      "result": "passed",
      "summary": "tsc --noEmit completed with no errors"
    }
  ],
  "validationOutput": [
    "node --test: 46 pass, 0 fail",
    "tsc --noEmit: clean"
  ],
  "residualRisks": [
    "Lineage is not stored directly on feedback rows; consumers must join sessions for agent_label/depth.",
    "Tool remains registered even if telemetry is disabled at session_start; calls silently produce no rows."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added src/feedback.ts with registerFeedback, shared validate+serialize, bus listener and submit_feedback tool; wired into index.ts; added 11 feedback tests.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "Commit 2ca08ea on slice/feedback-collector. The .pi-subagents artifact files and docs/tasks/state.yaml changes are unrelated workflow state and were not committed."
}
```
