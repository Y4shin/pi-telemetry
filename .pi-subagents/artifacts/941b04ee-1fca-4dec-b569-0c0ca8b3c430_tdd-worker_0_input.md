# Task for tdd-worker

Implement slice "session-events-capture" for task "pi-telemetry".

Slice doc: docs/tasks/pi-telemetry/slices/5-session-events-capture.md
Task doc: docs/tasks/pi-telemetry/task.md
Arch spec: docs/tasks/pi-telemetry/arch-spec.md
SPEC: SPEC.md (source of truth; §1.7 for this slice)

Before writing code:
1. Read the arch spec — module layout, write-path contract (Telemetry/guard()/enqueue()), do-not-reimplement list. Your target module: src/capture/session-events.ts exporting registerSessionEventsCapture(pi, t).
2. Read existing sources: src/state.ts, src/capture/{sessions,runs,turns}.ts, index.ts, test/capture.test.ts, test/helpers/.
3. Pi docs (event payload shapes for session_before_compact/session_compact/model_select/thinking_level_select/session_before_fork/session_tree): /nix/store/46l2syffzlyylqhs4mlzaxxyj5ivglry-pi-coding-agent-0.80.10/lib/node_modules/pi-monorepo/docs/extensions.md. Installed types in node_modules/@earendil-works/pi-coding-agent are authoritative. Payloads: build from documented event fields only; absent fields omitted, never fabricated.
4. Convention from slice 2: exact figures asserted in L1; tolerance/existence in L2.
5. Commit after each GREEN.

If uncertain, write docs/tasks/pi-telemetry/.work/uncertainty.md and stop.

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/941b04ee-1fca-4dec-b569-0c0ca8b3c430/tdd-session-events-capture/result.md
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