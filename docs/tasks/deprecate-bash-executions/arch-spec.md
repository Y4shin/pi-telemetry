# Architecture spec — deprecate-bash-executions

Shared across all slice chains for task `deprecate-bash-executions`. This is a
removal/deprecation task: it deletes code/test references and marks things
deprecated. There are **no new exports**.

## Why two slices, not three

`tsconfig.json` `include` covers `test/**/*.ts`. Removing the writer from
`src/` makes `tsc` fail on every test that imports `registerBashCapture`
(`test/bash.test.ts`, `test/duplicate-key-resilience.test.ts`) until those
test references are also removed. A src-only slice cannot leave a compiling
tree. So the write path, read path, and **all** test references are removed
together in slice 1; the deprecation comments are an independent slice 2.
Each slice leaves a compiling + green tree.

## Slice 1 — remove-bash-executions-usage

- **Exports:** none. Removes `src/capture/bash.ts`, the `registerBashCapture`
  symbol from the capture barrel + entry point, and `bash_executions` from the
  export/status read path.
- **Existing abstractions to use:**
  - Capture handlers are registered in `index.ts` via
    `register*Capture(pi, telemetry)` and re-exported from
    `src/capture/index.ts`. Remove the bash one following the others' pattern.
  - `src/query/export.ts` `ALL_TABLES` + `timeColumn()` — remove the
    `bash_executions` entries from both together (must stay in sync).
  - `src/query/commands.ts` `renderStatus` — drop the one `UNION ALL` line.
  - Tests use `node:test` + `node:assert`; DB via `openDatabase`; fixtures via
    `test/helpers/fixture-db.ts` `seedFixture`.
- **Do NOT reimplement:**
  - Do not replace the `user_bash` handler with anything.
  - Do not touch the agent `bash` *tool* capture (`src/capture/tools.ts`,
    `tool_executions`) — unrelated and must stay.
  - Do not drop the `bash_executions` DDL in `src/db.ts` (deprecation is slice 2).
  - Do not remove `capture.bashCommand` from `src/config.ts` (slice 2).
  - Do not edit `test/db.test.ts` — the table still exists, so "creates all 10
    tables" stays correct.
- **Interface contract for dependents:** after this slice,
  `rg "bash_executions|registerBashCapture|capture/bash" src/ test/` returns
  nothing; `tsc` clean; `npm test` green. Slice 2 only adds comments/docs and
  depends on nothing from slice 1 except that the live code is gone.

### Full footprint to remove (slice 1)
- `src/capture/bash.ts` (delete file)
- `src/capture/index.ts` (remove the `registerBashCapture` re-export line)
- `index.ts` (remove import + `registerBashCapture(pi, telemetry);` call)
- `src/query/export.ts` (`ALL_TABLES` array entry + `timeColumn()` case)
- `src/query/commands.ts` (`renderStatus` UNION line)
- `test/bash.test.ts` (delete file)
- `test/duplicate-key-resilience.test.ts` (remove `registerBashCapture` from
  import block + remove the `registerBashCapture(stub.pi, mockT ...)` call line)
- `test/privacy.test.ts` (remove `user_bash` exercise block, `BASH_COMMAND`
  const + its sentinel-list entry, `bashRow` ok + `command_hash` leak check)
- `test/helpers/fixture-db.ts` (remove `bash` array + `INSERT INTO
  bash_executions` prepared-statement block)
- `test/canned.test.ts` (remove `DELETE FROM bash_executions` line)
- `test/commands.test.ts` (remove `DELETE FROM bash_executions` line)

## Slice 2 — mark-bash-executions-deprecated

- **Exports:** none. Adds deprecation comments/docs only.
- **Existing abstractions to use:** none new; edit existing comments/docs.
- **Do NOT reimplement:**
  - Do NOT drop or alter the `bash_executions` DDL in `src/db.ts` — add a
    deprecation comment above it; the `CREATE TABLE IF NOT EXISTS` stays
    verbatim.
  - Do NOT remove `capture.bashCommand` from `src/config.ts` — add a
    deprecation comment; field/default/parse stay (flagged for later deletion
    with the table).
  - Do NOT edit `docs/tasks/archive/**` or `docs/ideas/**` (historical record).
- **Interface contract for dependents:** final slice. State: deprecation
  notes present in `src/db.ts`, `src/config.ts`, `SPEC.md`, the bug doc, and
  the analyze skill `schema.md`.

## Cross-slice invariants

- The `bash_executions` table DDL in `src/db.ts` is never removed by any
  slice. Only a deprecation comment is added (slice 2).
- The agent `bash` *tool* path (`tool_executions`, `src/capture/tools.ts`) is
  untouched by every slice.
- No slice drops the table or the `capture.bashCommand` flag — both are kept
  and (in slice 2) marked deprecated.
