# Land: session-run-turn-capture

**Status:** landed on `task/pi-telemetry`.

## Actions

1. Merged `slice/session-run-turn-capture` into `task/pi-telemetry` (`--no-ff`,
   commit `ba6532a slice(pi-telemetry): Session + agent-run + turn capture`) —
   clean merge, no conflicts. Slice branch deleted.
2. Archived slice doc to `docs/tasks/pi-telemetry/slices/archive/2-session-run-turn-capture.md`
   via `git mv`; frontmatter set to `status: done`, `completed_at: 2026-07-30`.
3. Appended implementation note (divergences + residual risks from TDD output) to
   `## Implementation notes` in `docs/tasks/pi-telemetry/task.md`.
4. Committed `56cc090 docs(slice): land session-run-turn-capture` (docs/tasks only;
   `.pi-subagents/` artifacts intentionally excluded, matching the earlier fix for
   accidental artifact commits).
5. Remaining slices: 3–10 (8 slices) — task stays `in-progress`; `docs/tasks/state.yaml`
   updated to `slice: null`, `last_landed: session-run-turn-capture`.

## Post-merge verification (on task/pi-telemetry)

- `npm run check` (`tsc --noEmit`): clean.
- `npm test`: 24/24 passing across 9 suites (buffer 4, session capture 4, run capture 2,
  turn capture 5, config 3, db 3, L1 harness 1, L2 capture 1, L2 harness 1).

## Merge diff summary

9 files, +828/−5: `index.ts`, `src/capture/{index,sessions,runs,turns}.ts`,
`src/state.ts`, `src/version.ts`, `test/capture.test.ts`, `test/l2-capture.test.ts`.