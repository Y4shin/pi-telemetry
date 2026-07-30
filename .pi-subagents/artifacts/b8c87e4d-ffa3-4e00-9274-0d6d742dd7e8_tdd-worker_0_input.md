# Task for tdd-worker

Implement slice "llm-request-capture" for task "pi-telemetry".

Slice doc: docs/tasks/pi-telemetry/slices/3-llm-request-capture.md
Task doc: docs/tasks/pi-telemetry/task.md
Arch spec: docs/tasks/pi-telemetry/arch-spec.md
SPEC: SPEC.md (source of truth; §1.4 for this slice — TTFT + stream duration are the extension's primary motivation)

Before writing code:
1. Read the arch spec — your contract: src/capture/llm.ts exporting registerLlmCapture(pi, t); consume state.correlation() and state.timers (or a module-scope map keyed by message identity); after_provider_response updates the most recent in-flight request row. NOTE from deviation reports: state.runId is set at agent_start and NOT cleared at end/settled — do not assume "runId set ⇒ run in flight".
2. Read existing sources: src/state.ts, src/capture/{sessions,runs,turns,session-events}.ts, src/feedback.ts, index.ts, test/capture.test.ts, test/helpers/.
3. Pi docs (message_start/update/end, after_provider_response payload shapes): /nix/store/46l2syffzlyylqhs4mlzaxxyj5ivglry-pi-coding-agent-0.80.10/lib/node_modules/pi-monorepo/docs/extensions.md. Installed types in node_modules/@earendil-works are authoritative — verify actual field names, never invent.
4. Conventions: exact token/timing figures asserted in L1 with the controllable clock (t.now); L2 asserts existence/tolerance (fauxProvider computes usage from context length, zero cost). Interleaved concurrent requests must not cross-contaminate markers.
5. Commit after each GREEN.

If uncertain, write docs/tasks/pi-telemetry/.work/uncertainty.md and stop.

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/b8c87e4d-ffa3-4e00-9274-0d6d742dd7e8/tdd-llm-request-capture/result.md
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