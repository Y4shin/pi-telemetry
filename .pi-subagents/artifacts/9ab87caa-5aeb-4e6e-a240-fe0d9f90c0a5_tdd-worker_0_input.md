# Task for tdd-worker

Implement slice "feedback-collector" for task "pi-telemetry".

Slice doc: docs/tasks/pi-telemetry/slices/6-feedback-collector.md
Task doc: docs/tasks/pi-telemetry/task.md
Arch spec: docs/tasks/pi-telemetry/arch-spec.md
SPEC: SPEC.md (source of truth; §5 for this slice)

Before writing code:
1. Read the arch spec — feedback contract: ONE shared local validate+serialize function used by both the bus listener and the submit_feedback tool (source differs; tool forces "pi"). Module: src/feedback.ts exporting registerFeedback(pi, t).
2. Read existing sources: src/state.ts, src/capture/*, index.ts, test/capture.test.ts, test/helpers/, src/config.ts (feedbackMaxBytes).
3. Pi docs (pi.events bus, pi.registerTool, TypeBox): /nix/store/46l2syffzlyylqhs4mlzaxxyj5ivglry-pi-coding-agent-0.80.10/lib/node_modules/pi-monorepo/docs/extensions.md. Installed types authoritative. Tool description must state it records to the LOCAL telemetry store (SPEC §5.2 coexistence); no promptGuidelines.
4. Validation rules (SPEC §5.1): source/kind non-empty strings; data serialized as-is (JSON for objects, raw for strings); cap at feedbackMaxBytes (64KiB default); violations → telemetry_meta feedback_rejected, never throw. Enrichment: session_id, run_id, turn_index, received_unix_ms.
5. Commit after each GREEN.

If uncertain, write docs/tasks/pi-telemetry/.work/uncertainty.md and stop.

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/9ab87caa-5aeb-4e6e-a240-fe0d9f90c0a5/tdd-feedback-collector/result.md
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