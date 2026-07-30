# Land result: feedback-collector

## What was done

1. **Merge** - `slice/feedback-collector` merged into `task/pi-telemetry` with `--no-ff`
   (merge commit 8798904, message "slice(pi-telemetry): Feedback collector (bus + submit_feedback tool)").
   No conflicts. The merge brought in `src/feedback.ts` (+128), `test/feedback.test.ts`
   (+237), 2-line wiring in `index.ts`, and `docs/ideas/skill-invocation-capture.md`
   (mid-branch idea-doc commit by the parent/user mid-branch, which the deviation
   reporter explicitly said to leave in place). Slice branch deleted.
2. **Archive** - slice doc frontmatter set (`status: done`, `started_at/completed_at:
   2026-07-30`, matching the slices 1/2 convention) and `git mv` to
   `docs/tasks/pi-telemetry/slices/archive/6-feedback-collector.md`.
3. **Task doc** - appended a "feedback-collector (landed 2026-07-30)" note to
   `## Implementation notes` capturing the shared validate/serialize path feeding both
   the bus listener and the `submit_feedback` tool, validation/cap semantics, the five
   documented divergences (lineage-via-join instead of columns on feedback rows; `label`
   required by the `ToolDefinition` type; pre-session_start rejection; data-null
   rejection; additive test-seam exports), and the two residual risks (tool stays
   registered when telemetry is disabled; success-neutral result hides store failure
   from the agent).
4. **Docs commit** - `93dafb9 docs(slice): land feedback-collector` containing the
   archived slice doc, task.md note, `state.yaml` (`slice: null`,
   `last_landed: feedback-collector`), and the deviation report
   `deviation-reports/feedback-collector.md` (same file set as the previous landing
   commit fdf3d740).
5. **Remaining slices** - NOT the last slice; 6 remain (3-llm-request-capture,
   4-tool-bash-capture, 7-lineage-foundation, 8-tm-command-surface,
   9-query-telemetry-tool, 10-soak-privacy-gate). Task status stays `in-progress`.

## Verification on merged task branch

- `npm run check` (`tsc --noEmit`): clean.
- `npm test`: 46/46 pass, 11 suites, 0 fail.

## Notes for reviewer

- TDD output's divergence list matches the deviation report exactly; the lineage
  acceptance-criterion wording is satisfied in a SPEC section 2 conformant way (feedback
  rows carry session_id/run_id/turn_index; agent_label/depth live on `sessions` and are
  reachable by join).
- Working tree still contains runtime-appended `.pi-subagents/artifacts/*` transcript
  files (not part of the slice; intentionally left uncommitted/untracked, exactly as in
  prior landings). Git index is clean (`git diff --cached --quiet` passes).