## Deviation report — mark-bash-executions-deprecated

### API surface changes
- **Planned:** No new exports. Add deprecation comments/docs only; no code behavior or DDL change.
- **Actual:** Exactly as planned. No API surface was added, removed, or altered. The slice is purely additive comments and documentation.
- **Impact:** None on dependent slices. This is the final slice; nothing depends on it.

### Abstraction usage
- Used/was specified: yes. No new abstractions were needed or used. The arch spec said "Existing abstractions to use: none new; edit existing comments/docs." The implementation edited only comments and documentation text in the five specified files.

### Out-of-scope changes
- None. The five changed files are exactly the five named in the slice doc:
  `src/db.ts`, `src/config.ts`, `SPEC.md`, `docs/bugs/bash-executions-not-captured.md`, and `skills/telemetry-eval-analyze/resources/schema.md`.
- No archived task docs (`docs/tasks/archive/**`) or idea docs (`docs/ideas/**`) were edited.
- No test files were touched.
- No code behavior changed (comments only in `src/`; docs-only elsewhere).

### Cross-slice invariant verification
- **`src/db.ts` DDL verbatim:** confirmed. `git diff -- src/db.ts` shows only `+` comment lines above the `CREATE TABLE IF NOT EXISTS bash_executions` block; zero `-` content lines (no deletions). The DDL text is byte-for-byte unchanged.
- **`src/config.ts` `capture.bashCommand` verbatim:** confirmed. `git diff -- src/config.ts` shows only `+` comment lines on the `CaptureConfig.bashCommand` field, the `DEFAULTS.capture.bashCommand` default, and the parse block; zero `-` content lines. The field, default (`false`), and parse logic (`PI_TELEMETRY_CAPTURE_BASH_COMMAND` / `fromBlock.capture?.bashCommand`) all remain.
- **Deprecation notes reference task slug:** confirmed in all five files:
  - `src/db.ts`: 1 reference (comment above DDL)
  - `src/config.ts`: 3 references (interface field, default, parse block)
  - `SPEC.md`: 3 references (§1.6 heading, DDL comment, `capture.bashCommand` config row)
  - `docs/bugs/bash-executions-not-captured.md`: 2 references (verdict block, fix summary)
  - `skills/telemetry-eval-analyze/resources/schema.md`: 2 references (table heading, join-map line)
- **Agent `bash` tool path untouched:** confirmed (no `src/capture/tools.ts` or `tool_executions` changes).

### Task doc update needed?
- **No.** The task doc's `## Implementation notes` section already records slice 1's landing. This slice (slice 2) is a comments/docs-only change with no divergence; appending a note is not required, though the parent may optionally add a one-line entry recording that deprecation comments were added. No API surface that dependents call was changed.

### User attention needed?
- **No.** Scope was not widened. All changes are additive comments/docs within the five specified files. The DDL and config flag are verbatim. `tsc` clean; `npm test` 147/147 green; no staged files.
