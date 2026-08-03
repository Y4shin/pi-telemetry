## Deviation report — remove-bash-executions-usage

### API surface changes
- **Planned:** Remove the `registerBashCapture` symbol from `src/capture/index.ts` and `index.ts`; remove `bash_executions` from `src/query/export.ts` (`ALL_TABLES` + `timeColumn()`) and `src/query/commands.ts` (`renderStatus` UNION line). No new exports.
- **Actual:** Exactly as planned. No API surface was added or altered beyond the specified removals. The `user_bash` event is no longer listened to; the export enumeration drops from 9 to 8 tables; `/tm status` reports 8 measurement tables.
- **Impact:** None on dependent slices. Slice 2 (`mark-bash-executions-deprecated`) only adds deprecation comments/docs and depends on nothing from this slice except that the live code is gone — which is confirmed.

### Abstraction usage
- Used/was specified: yes. The capture-barrel pattern (`src/capture/index.ts` re-exports, `index.ts` `register*Capture` calls), the `ALL_TABLES`/`timeColumn` pair in `export.ts`, and the `renderStatus` UNION in `commands.ts` were all edited exactly as the arch spec directed. No reimplementation; the `user_bash` handler was deleted, not replaced.

### Out-of-scope changes
- **`test/export.test.ts` (1 line)** — not in the arch-spec footprint list. The assertion `assert.strictEqual(written.length, 9)` was changed to `8` because the full-database export now writes 8 CSV files instead of 9 (`bash_executions` removed from `ALL_TABLES`). This is a direct, unavoidable consequence of the intended API change and the only way to satisfy the `npm test` green gate. The change is correct and minimal (one constant). **Not a scope violation — a footprint gap in the spec.**

### Cross-slice invariant verification
- **`src/db.ts` DDL untouched:** confirmed. `git diff` shows no changes to `src/db.ts`; `CREATE TABLE IF NOT EXISTS bash_executions` is still present at line 101. Deprecation comment is slice 2's job.
- **`src/config.ts` `capture.bashCommand` untouched:** confirmed. `git diff` shows no changes to `src/config.ts`; `bashCommand` field, default (`false`), and parse block (`PI_TELEMETRY_CAPTURE_BASH_COMMAND`) all remain. Deprecation comment is slice 2's job.
- **`test/db.test.ts` untouched:** confirmed. Still references `bash_executions` in its `TABLES` array (line 15) and migration test (line 79) — correct, since the table still exists.
- **`src/capture/tools.ts` (agent bash tool) untouched:** confirmed. No diff. Agent `bash` tool calls remain captured in `tool_executions`.

### Residual grep analysis
The slice doc's acceptance criterion says `rg "bash_executions|registerBashCapture|capture/bash" src/ test/` should return nothing, but the doc itself notes the DDL in `src/db.ts` is untouched here. The actual residual matches are:
- `src/db.ts:101` — `CREATE TABLE IF NOT EXISTS bash_executions` (expected; deprecation is slice 2)
- `test/db.test.ts:15,79` — table membership + migration test (expected; table still exists)

These are explicitly permitted residuals, not deviations. The criterion's wording is slightly imprecise (says "returns nothing" but then carves out the DDL exception); the implementation matches the *intent*.

### Other remaining `bash` references (all correct, not the table)
- `test/tools.test.ts`, `test/tool.test.ts`, `test/helpers/fixture-db.ts` — reference `toolName: "bash"` / `tool_name: "bash"` in the **agent bash tool** path (`tool_executions`), which is untouched by design.
- ~10 test files set `capture: { ..., bashCommand: false }` in `makeConfig` — the dead config flag, untouched by design (deprecation is slice 2).
- `src/config.ts:140` — `PI_TELEMETRY_CAPTURE_BASH_COMMAND` env parse for the dead flag, untouched by design.

### Task doc update needed?
- **No.** The task doc's `## Implementation notes` does not need updating. The one out-of-footprint file (`test/export.test.ts`) is a spec footprint gap, not a scope change; the test-count assertion update is the only way to keep the suite green and is self-evidently correct. No API surface that dependents call was changed.

### User attention needed?
- **No.** Scope was not widened. The single out-of-footprint test change is a direct consequence of the intended removal and is the minimal correct fix. All cross-slice invariants hold; `tsc` clean; `npm test` 147/147 green; no staged files.
