# Task for tdd-worker

Implement slice "scaffold-write-path" for task "pi-telemetry".

Slice doc: docs/tasks/pi-telemetry/slices/1-scaffold-write-path.md
Task doc: docs/tasks/pi-telemetry/task.md
Arch spec: docs/tasks/pi-telemetry/arch-spec.md
SPEC: SPEC.md (source of truth; §2 schema, §3 write path, §7 config, §8 migrations)

Before writing code:
1. Read the arch spec — the Telemetry/RuntimeState/guard() contract, module layout, and do-not-reimplement list are binding.
2. Read SPEC.md §2, §3, §7, §8.
3. Read pi docs (docs/extensions.md, docs/sdk.md in the pi-monorepo) for ExtensionAPI/session event shapes; the SDK exports createAgentSession, SessionManager.inMemory(), createAssistantMessageEventStream for the L2 harness.
4. Call get_guidelines for typescript.
5. Commit after each GREEN (checkpoint).

This is a greenfield repo: no package.json, no src/ yet. Create everything per the slice doc.
Note: SPEC §2 was amended after the slice doc was written — telemetry_meta now has a nullable session_id column (no FK). Use the amended DDL from SPEC.md.

If uncertain, write docs/tasks/pi-telemetry/.work/uncertainty.md and stop.

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/20b97b9f-73ad-430c-bef2-52ad88d17117/tdd-scaffold-write-path/result.md
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