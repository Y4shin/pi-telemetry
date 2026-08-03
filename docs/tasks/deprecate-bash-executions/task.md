---
kind: task
type: feature
slug: deprecate-bash-executions
title: Deprecate bash_executions — remove write/read code usage, keep the DDL, mark deprecated
map: deprecate-bash-executions
status: ready
slices:
- remove-bash-executions-usage
- mark-bash-executions-deprecated
---

# Deprecate bash_executions — remove write/read code usage, keep the DDL

## User-visible outcome

The `bash_executions` table is no longer written to or read by any code in
this repo. The `user_bash` capture handler, its registration, the export entry,
and the `/tm status` row-count line are all removed. Tests no longer reference
the table. The table DDL remains in `src/db.ts` (backward compat for older
in-flight extension versions), and the table plus the dead
`capture.bashCommand` config flag are explicitly marked deprecated in the
schema, the analyze skill, SPEC.md, and the existing bug doc.

## User story

As a maintainer, I want the unused `bash_executions` table out of the live
code path so that the codebase no longer carries a capture surface that has
never produced useful data (0 rows across 48 live sessions; agent bash calls
live in `tool_executions` by design), while keeping the physical table around
long enough that older extension versions still starting up do not crash on
INSERT.

## Scope boundaries

In scope:
- Remove `src/capture/bash.ts` and its registration/export from
  `src/capture/index.ts` and `index.ts`.
- Remove `bash_executions` from `src/query/export.ts` (`ALL_TABLES`,
  `timeColumn`) and `src/query/commands.ts` (`/tm status` UNION count).
- Remove all test references: delete `test/bash.test.ts`; remove the
  `registerBashCapture` import + call from `test/duplicate-key-resilience.test.ts`;
  fix the `user_bash` exercise + row assertions in `test/privacy.test.ts`;
  remove the bash seed row from `test/helpers/fixture-db.ts`; remove the
  `DELETE FROM bash_executions` cleanup lines from `test/canned.test.ts` and
  `test/commands.test.ts`. (The write path and test references are removed
  together because `tsconfig.json` includes `test/**/*.ts`, so a src-only
  removal cannot leave `tsc` clean.)
- Add a deprecation note to `src/config.ts` for `capture.bashCommand`.
- Mark the table deprecated in `src/db.ts` (comment above the DDL only — DDL
  stays), `SPEC.md` §1.6 + the DDL block + the `capture.bashCommand` row, the
  existing bug doc `docs/bugs/bash-executions-not-captured.md`, and
  `skills/telemetry-eval-analyze/resources/schema.md`.

Out of scope:
- Dropping the `bash_executions` table or its DDL.
- Removing `capture.bashCommand` from `config.ts` (deprecation note only).
- Any change to the agent's `bash` *tool* capture in `tool_executions`.
- Editing archived task docs (`docs/tasks/archive/**`) or idea docs
  (`docs/ideas/**`) — historical record, left as-is. (The bug doc is in
  `docs/bugs/`, not archive, and IS in scope to update.)

## Acceptance criteria

- `src/capture/bash.ts` no longer exists; `src/capture/index.ts` and
  `index.ts` no longer import or call `registerBashCapture`.
- `src/query/export.ts` `ALL_TABLES` and `timeColumn()` no longer list
  `bash_executions`; `src/query/commands.ts` `/tm status` no longer counts it.
- `test/bash.test.ts` is deleted; `test/duplicate-key-resilience.test.ts` no
  longer imports/calls `registerBashCapture`; `test/privacy.test.ts` no longer
  asserts a `bash_executions` row (the `user_bash` exercise is removed);
  `fixture-db.ts` has no bash seed row; canned and commands tests no longer
  `DELETE FROM bash_executions`.
- `npm test` is green and `tsc` reports no errors.
- `rg "bash_executions|registerBashCapture|capture/bash" src/ test/` returns
  nothing (the DDL in `src/db.ts` is untouched here and deprecation-marked in
  slice 2; archived task docs and idea docs are historical and out of scope).
- `src/db.ts` still contains `CREATE TABLE IF NOT EXISTS bash_executions`
  with a deprecation comment; `src/config.ts` `capture.bashCommand` carries a
  deprecation comment.
- `SPEC.md`, the bug doc, and the analyze skill `schema.md` mark the table
  deprecated and point to this task as the deprecation decision.

## Existing abstractions to use

- Capture handlers are registered via `pi.on(...)` in `src/capture/*.ts` and
  re-exported from `src/capture/index.ts`; `index.ts` calls each
  `register*Capture`. Follow that pattern to unregister.
- `/tm status` row counts are a single `UNION ALL` query in
  `src/query/commands.ts` `renderStatus`; export tables are enumerated in
  `src/query/export.ts` `ALL_TABLES` with per-table time columns in
  `timeColumn`.
- Tests use `node:test` + `node:assert`; the DB is opened via `openDatabase`
  from `src/db.ts`; fixtures via `test/helpers/fixture-db.ts`
  `seedFixture`.

## Architecture / domain decisions

- The table is kept for backward compatibility: older extension versions
  running at startup may still INSERT, so dropping the DDL would break them.
  Deprecation is documented, not physical.
- `capture.bashCommand` was always a reserved/dead flag (never wired to the
  writer, always `false`); it is deprecated in lockstep with the table rather
  than removed, to avoid churning ~12 test `makeConfig` objects for no
  behavioral change.
- Agent `bash` *tool* calls are recorded in `tool_executions`
  (`tool_name='bash'`) and are explicitly untouched.

## Implementation notes

### Slice `remove-bash-executions-usage` — landed

Removed the `bash_executions` live write/read path and all test references.
- Deleted `src/capture/bash.ts` and `test/bash.test.ts`.
- Removed `registerBashCapture` re-export from `src/capture/index.ts` and the import+registration call from `index.ts`.
- Removed `bash_executions` from `src/query/export.ts` (`ALL_TABLES` + `timeColumn`) and the UNION count line from `src/query/commands.ts` `renderStatus`.
- Cleaned test references in `test/duplicate-key-resilience.test.ts`, `test/privacy.test.ts`, `test/helpers/fixture-db.ts`, `test/canned.test.ts`, `test/commands.test.ts`.
- `test/export.test.ts` updated out-of-footprint: full-DB export assertion 9→8 CSV files (direct consequence of removing `bash_executions` from `ALL_TABLES`; spec footprint gap, not a scope violation).
- `src/db.ts` DDL and `test/db.test.ts` left untouched as required.

Validation: `tsc --noEmit` clean; `npm test` 147/147 green; `rg "bash_executions|registerBashCapture|capture/bash" src/ test/` returns only the intentional residuals (`src/db.ts` DDL, `test/db.test.ts` table references).
