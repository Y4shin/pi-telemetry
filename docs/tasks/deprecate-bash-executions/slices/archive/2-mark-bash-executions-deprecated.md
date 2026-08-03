---
kind: slice
slug: mark-bash-executions-deprecated
title: "Mark bash_executions + capture.bashCommand deprecated in code, SPEC, bug doc, skill"
task: ../task.md
mode: afk
status: todo
size: s
blocked_by: []
---

# Mark bash_executions + capture.bashCommand deprecated in code, SPEC, bug doc, skill

## End-to-end behavior

Every place that documents the `bash_executions` table or the
`capture.bashCommand` config flag carries an explicit deprecation note
pointing to this task as the decision. The table DDL and the config flag
stay (backward compat for older in-flight extension versions); only
comments/docs change.

## Changes

- `src/db.ts`: add a deprecation comment immediately above the
  `CREATE TABLE IF NOT EXISTS bash_executions (...)` block. DDL stays verbatim.
- `src/config.ts`: add a deprecation comment on the `bashCommand` field in the
  `capture` interface, the `DEFAULTS.capture.bashCommand` default, and the
  parse block. Flag stays verbatim.
- `SPEC.md` §1.6 ("User bash (`!` / `!!`)"): mark the section deprecated; note
  the `user_bash` capture path was removed and the table is retained for
  backward compat with older extension versions. Mark the DDL block
  (`CREATE TABLE IF NOT EXISTS bash_executions`) and the `capture.bashCommand`
  config-table row deprecated.
- `docs/bugs/bash-executions-not-captured.md`: update the verdict / fix
  summary to reference this deprecation decision — the table's code usage is
  now removed; the table is kept for older versions; a later task can drop it
  once all running agents have upgraded.
- `skills/telemetry-eval-analyze/resources/schema.md`: mark the
  `bash_executions` table section and its join-map line deprecated; note it
  is no longer written by current versions and will be empty/absent.

## Acceptance criteria

- `src/db.ts` still contains `CREATE TABLE IF NOT EXISTS bash_executions`
  with a deprecation comment above it referencing task
  `deprecate-bash-executions`.
- `src/config.ts` `bashCommand` carries a deprecation comment.
- SPEC.md, the bug doc, and the analyze skill schema.md each contain a
  deprecation note referencing this task.
- `npm test` green; `tsc` clean (comments only, no behavior change).

## Test plan

Seams:
- `src/db.ts` DDL block; `src/config.ts` capture interface + DEFAULTS + parse.
- Doc files: SPEC.md §1.6 + DDL + config table; bug doc; skill schema.md.

Failure modes:
- Accidentally editing the DDL text itself (must stay verbatim) — only add a
  comment above it.
- Accidentally removing `bashCommand` from config (must stay) — only add a
  comment.
- Deprecation note that does not reference the task slug.

Scenarios:
- `git diff` shows only comment/whitespace additions in `src/db.ts` and
  `src/config.ts`; docs-only changes elsewhere.
- `tsc --noEmit` clean; `npm test` green (no behavior change).

## Constraints and dependencies

- None. Purely additive comments/docs; no code behavior change.
- May land before or after slice 1; conventionally lands after the usage is
  removed.
