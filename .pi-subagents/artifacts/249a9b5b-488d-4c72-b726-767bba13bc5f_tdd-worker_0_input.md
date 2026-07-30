# Task for tdd-worker

Implement slice "session-run-turn-capture" for task "pi-telemetry".

Slice doc: docs/tasks/pi-telemetry/slices/2-session-run-turn-capture.md
Task doc: docs/tasks/pi-telemetry/task.md
Arch spec: docs/tasks/pi-telemetry/arch-spec.md
SPEC: SPEC.md (source of truth; §1.1–1.3 for this slice)

Before writing code:
1. Read the arch spec — especially the slice-2 contract for slices 3/4/7: you OWN RuntimeState maintenance (sessionId at session_start, runId UUID at agent_start, turnId UUID + turnIndex at turn_start, staged prompt lengths). Write the sessions INSERT with the four lineage columns ALREADY in the column list, filled from state.lineage (NULL for now — slice 7 fills the seam later; you must define state.lineage in RuntimeState, defaulted empty).
2. Read the existing sources: src/state.ts, src/buffer.ts, src/db.ts, index.ts, test/helpers/.
3. Pi docs (event payload shapes): /nix/store/46l2syffzlyylqhs4mlzaxxyj5ivglry-pi-coding-agent-0.80.10/lib/node_modules/pi-monorepo/docs/extensions.md and sdk.md. Installed types in node_modules/@earendil-works/pi-coding-agent are authoritative.
4. L2 harness note: use test/helpers/l2-session.ts (fauxProvider from @earendil-works/pi-ai — createAssistantMessageEventStream does NOT exist).
5. Commit after each GREEN.

If uncertain, write docs/tasks/pi-telemetry/.work/uncertainty.md and stop.

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/249a9b5b-488d-4c72-b726-767bba13bc5f/tdd-session-run-turn-capture/result.md
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