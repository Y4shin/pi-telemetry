# Slice: session-run-turn-capture — TDD result

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