# Task for deviation-reporter

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Check slice "session-run-turn-capture" of task pi-telemetry for deviations from the arch spec and slice doc.

Slice doc: docs/tasks/pi-telemetry/slices/2-session-run-turn-capture.md
Arch spec: docs/tasks/pi-telemetry/arch-spec.md
Implementation: # Slice: session-run-turn-capture — TDD result

## Summary

Implemented capture handlers for `sessions`, `agent_runs`, and `turns` per SPEC §1.1–1.3 and the slice-2 contract for downstream slices.

## What changed

- `src/state.ts` — extended `RuntimeState` with:
  - `lineage: { parentSessionId, parentRunId, depth, agentLabel }` (defaulted empty/null) so slice 7 only needs to populate the seam.
  - `stagedPromptChars` / `stagedSystemPromptChars` for run-row prompt-length staging.
- `src/capture/sessions.ts` — `session_start` INSERT (with the four lineage columns), `session_shutdown` UPDATE, `session_info_changed` UPDATE.
- `src/capture/runs.ts` — `before_agent_start` staging, `agent_start` INSERT with UUID `runId`, `agent_end`/`agent_settled` UPDATE with distinct outcomes.
- `src/capture/turns.ts` — `turn_start` INSERT with UUID `turnId` + `context_tokens_at_start` sampled from `ctx.getContextUsage()`, `turn_end` UPDATE with full usage/cost breakdown and `tool_result_count`.
- `src/capture/index.ts` — public barrel export.
- `src/version.ts` — reads extension version from `package.json` for the `sessions.ext_version` column.
- `index.ts` — registers capture handlers using a lightweight proxy so the real telemetry instance can be swapped in at `session_start`; close is ordered after the capture shutdown UPDATE.
- `test/capture.test.ts` — L1 fake-event coverage for all handlers plus failure modes.
- `test/l2-capture.test.ts` — L2 SDK mock-session test verifying real pipeline rows.

## Test results

- `npm run check` (tsc --noEmit): clean
- `npm test`: 24/24 passing
  - buffer: 4/4
  - session capture: 4/4
  - run capture: 2/2
  - turn capture: 5/5
  - config: 3/3
  - db: 3/3
  - L1 harness: 1/1
  - L2 capture: 1/1
  - L2 harness: 1/1

## Divergence from plan

1. Added `src/version.ts` to source `ext_version` from `package.json`; the slice doc did not list this file but the SPEC requires `ext_version` per session.
2. Extended `RuntimeState` now with `lineage`, `stagedPromptChars`, and `stagedSystemPromptChars` — these are required by this slice's run capture and the slice-7 lineage seam.
3. Used a proxy telemetry object in `index.ts` to register handlers once at factory load while lazily binding the real buffer at `session_start`. This avoids stale-handler problems if the same extension instance sees multiple `session_start` events.
4. The L2 mock-provider test asserts row existence, linkage, and field population rather than exact token/cost figures because `@earendil-works/pi-ai` `fauxProvider` computes token usage from context length and reports zero cost for the test model.

## Notable events

- First checkpoint commit accidentally included untracked `.pi-subagents` artifacts; reverted with `git reset --soft HEAD~1` and re-committed only project files.
- Added proxy wiring after realizing that registering capture handlers inside `session_start` could leave a stale `telemetry` reference on subsequent session-start events in the same instance.

## Residual risks

- `session_start` uses plain `INSERT`; if a resumed session reuses the same `session_id`, the resulting primary-key conflict will be swallowed by the buffer as a `write_failed` meta row. The slice doc lists "resume with pre-existing session row" as a key scenario but does not mandate `INSERT OR IGNORE`; downstream coherence review should decide whether to switch to `INSERT OR IGNORE`/`INSERT OR REPLACE`.
- `turn_end` without a matching `turn_start` records a `handler_error` meta row but does not attempt to INSERT a partial turn row; this matches the "no orphan UPDATE" requirement.

Output saved to: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/249a9b5b-488d-4c72-b726-767bba13bc5f/tdd-session-run-turn-capture/result.md (3.5 KB, 50 lines). Read this file if needed..

Compare the implementation against the spec. Pay special attention to the interface contract for dependent slices 3/4/7: RuntimeState ownership, correlation() values, lineage column seam in the sessions INSERT, and state.lineage default.
Write the deviation report to docs/tasks/pi-telemetry/deviation-reports/session-run-turn-capture.md (API surface changes, abstraction usage, out-of-scope additions, divergence from acceptance criteria). If the task doc's ## Implementation notes needs updating, note it.

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/249a9b5b-488d-4c72-b726-767bba13bc5f/deviation-session-run-turn-capture/result.md
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