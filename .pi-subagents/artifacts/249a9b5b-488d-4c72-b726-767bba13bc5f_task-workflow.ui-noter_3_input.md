# Task for task-workflow.ui-noter

Detect UI work in slice "session-run-turn-capture" for task "pi-telemetry".
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
Review the diff created by the TDD implementation. (Expected: headless event-handler slice — likely no_ui_work.)
Handoff note path if UI work IS found: docs/tasks/pi-telemetry/impeccable-note-session-run-turn-capture.md

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/249a9b5b-488d-4c72-b726-767bba13bc5f/ui-note-session-run-turn-capture/result.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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