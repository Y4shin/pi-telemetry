---
kind: slice
slug: swt-telemetry-skill-context-tool
title: "Register telemetry_skill_context tool to attach dynamic metadata mid-run to the current skill_invoke row"
task: ../task.md
mode: afk
status: todo
size: m
blocked_by: [swt-input-skill-invoke, swt-turn-start-backfill]
---

## End-to-end behavior

Register a `telemetry_skill_context` tool (mirrors `submit_feedback`) that the
skill's prose instructs the model to call mid-run with dynamic metadata
(`slice_count`, outcome flags, `extra` key-value). The tool attaches its
params to the session's current/most-recent `skill_invoke` row (matched on
`session_id` + `run_id` + `turn_id` after the `turn_start` back-fill).

## Acceptance criteria

- The tool is registered with params `{ target?, map?, slice?, sliceCount?, extra? }`.
- When called mid-run, it merges its params into the session's most-recent `skill_invoke` row that matches the current `run_id`/`turn_id`.
- If no matching `skill_invoke` row exists (e.g. the turn wasn't started by a `/skill:` input), the tool records a `telemetry_meta` note and still returns success (never breaks the agent).
- The tool returns `{content:[{type:"text",text:"Recorded."}], details:{}}`.
- Privacy: `extra` values that aren't clean slugs are stored as length/hash, not raw text.
- `npm test` green, `tsc --noEmit` clean.

## Test plan

- Seams: L1 stub; fire `input` (creates skill_invoke row) → `turn_start` (back-fills run/turn) → call the tool → assert the row is enriched.
- Failure modes: no prior skill_invoke row (meta note, success); tool called outside a turn (meta note); unserializable `extra` (meta note).
- Scenarios: enrich with `slice_count`; enrich with `extra` map; multiple enrichments to the same row merge.
- Edge cases: tool must not throw on any input.

## Constraints and dependencies

- Mirror `src/feedback.ts` `registerTool` + `t.state.correlation()`.
- Depends on slice 5 (`turn_start` back-fill) for run/turn attribution.
- Does not depend on the prototype.
