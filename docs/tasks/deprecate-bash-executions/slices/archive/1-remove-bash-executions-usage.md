---
kind: slice
slug: remove-bash-executions-usage
title: "Remove all bash_executions write/read code and test references"
task: ../task.md
mode: afk
status: todo
size: m
blocked_by: []
---

# Remove all bash_executions write/read code and test references

## End-to-end behavior

No code or test in the repo references the `bash_executions` table or the
`registerBashCapture` symbol. The `user_bash` capture handler is deleted, the
read path (export + `/tm status`) is removed, and every test that referenced
the table or the handler is cleaned up. The table DDL stays (deprecation in
the next slice). The tree compiles (`tsc` clean) and the suite is green.

## Why this is one slice, not three

`tsconfig.json` includes `test/**/*.ts`, so removing the writer from `src/`
breaks `tsc` until the test files that import `registerBashCapture` are also
fixed. A src-only slice cannot leave a compiling tree. Therefore the write
path, read path, and all test references are removed together here; the
deprecation *comments* are a separate, independent slice.

## Changes

### Write path (src)
- Delete `src/capture/bash.ts`.
- Remove `export { registerBashCapture } from "./bash.ts";` from
  `src/capture/index.ts`.
- Remove the `registerBashCapture` import and the
  `registerBashCapture(pi, telemetry);` call from `index.ts`.

### Read path (src)
- `src/query/export.ts`: remove `"bash_executions"` from `ALL_TABLES` and the
  `case "bash_executions":` branch from `timeColumn()`.
- `src/query/commands.ts`: remove the
  `UNION ALL SELECT 'bash_executions', COUNT(*) FROM bash_executions` line
  from `renderStatus`.

### Tests (remove all references)
- Delete `test/bash.test.ts` (tests the removed writer).
- `test/duplicate-key-resilience.test.ts`: remove `registerBashCapture` from
  the import block and remove the `registerBashCapture(stub.pi, mockT ...)`
  call line.
- `test/privacy.test.ts`: remove the `user_bash` exercise block
  (`emitUserBash` + `ops.exec`) and the `bash_executions` row assertions
  (`bashRow` ok + `command_hash` leak check). Remove `BASH_COMMAND` from the
  sentinels list since it is no longer exercised; remove its const declaration.
- `test/helpers/fixture-db.ts`: remove the `bash` array and its
  `INSERT INTO bash_executions` prepared-statement block.
- `test/canned.test.ts` and `test/commands.test.ts`: remove the
  `emptyDb.exec("DELETE FROM bash_executions");` lines from the empty-DB
  setup blocks.
- Leave `test/db.test.ts` as-is — the table still exists, so "creates all 10
  tables" stays correct.

## Acceptance criteria

- `rg "bash_executions|registerBashCapture|capture/bash" src/ test/` returns
  nothing. (The only permitted `bash_executions` mention repo-wide after this
  slice is the DDL in `src/db.ts`, which is untouched here, plus docs/ideas/
  archive history.)
- `npx tsc --noEmit` is clean.
- `npm test` is green.
- `test/bash.test.ts` does not exist.
- `/tm export` (full) no longer writes `bash_executions.csv`; `/tm status` no
  longer lists a `bash_executions` row.

## Test plan

Seams:
- `index.ts` import list + registration block; `src/capture/index.ts` barrel;
  `src/query/export.ts` `ALL_TABLES` + `timeColumn`; `src/query/commands.ts`
  `renderStatus` UNION.
- `test/duplicate-key-resilience.test.ts` import block + the
  `registerBashCapture(...)` call in its setup.
- `test/privacy.test.ts` `user_bash` block, `BASH_COMMAND` const + sentinel
  list entry, `bashRow`/`command_hash` assertions.
- `test/helpers/fixture-db.ts` `bash` array + insert block; canned/commands
  empty-DB `DELETE` lines.

Failure modes:
- Leaving `bash_executions` in `ALL_TABLES` while removing it from
  `timeColumn` (or vice versa) — both must go together.
- Removing the `user_bash` block but leaving `BASH_COMMAND` in the sentinels
  list → a sentinel that is never exercised; clean it up.
- Removing the fixture `bash` insert but leaving a reference to the `bash`
  array → `tsc` error.
- Forgetting `test/duplicate-key-resilience.test.ts` → `tsc` TS2724 error on
  the missing export.

Scenarios:
- `tsc --noEmit` clean.
- Full `npm test` green, including privacy (remaining sentinels), canned,
  commands, duplicate-key-resilience, and db tests.
- `rg` confirms no live references remain in `src/` or `test/`.

## Constraints and dependencies

- None. This slice is self-contained and leaves a compiling + green tree.
- The deprecation comments (next slice) are independent and can land before
  or after this one, but conventionally after.
