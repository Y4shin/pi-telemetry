---
kind: slice
slug: swt-turn-start-backfill
title: "turn_start back-fills run_id/turn_id/turn_index on the session's most-recent un-attributed skill_invoke row"
task: ../task.md
mode: afk
status: done
size: s
blocked_by: [swt-input-skill-invoke]
---

## End-to-end behavior

At `turn_start`, find the session's most-recent `skill_invoke` row whose
`run_id`/`turn_id` are null and set them to the upcoming turn's ids + index.
This attributes the invocation (which fired at `input`, before the turn) to
the turn it started.

## Acceptance criteria

- After a `/skill:foo` input followed by a `turn_start`, the `skill_invoke` row has `run_id`, `turn_id`, `turn_index` set to that turn's values.
- A turn that was NOT preceded by a `/skill:` input does not touch any `skill_invoke` row.
- Two `/skill:` inputs before a single turn: only the most-recent is back-filled (the older one stays null — documented behavior).
- `npm test` green, `tsc --noEmit` clean.

## Test plan

- Seams: L1 stub; fire `input` then `turn_start`; assert the row is attributed.
- Failure modes: no prior skill_invoke (no-op); multiple skill_invoke before one turn.
- Scenarios: skill invoke → turn; non-skill input → turn (no row touched).
- Edge cases: `turn_start` with no active session (no-op).

## Constraints and dependencies

- The back-fill is an `UPDATE session_events SET run_id=?, turn_id=?, turn_index=? WHERE session_id=? AND type='skill_invoke' AND run_id IS NULL ORDER BY unix_ms DESC LIMIT 1` (or equivalent).
- Does not depend on the prototype.
