---
kind: slice
slug: swt-tm-skills-command
title: "/tm skills subcommand — human-facing table of skills invoked, counts, cost, version, target"
task: ../task.md
mode: afk
status: todo
size: s
blocked_by: [swt-skill-cost-preset]
---

## End-to-end behavior

Add a `/tm skills` subcommand that prints a human-readable table of skills
invoked (newest first), with invocation count, cost, version, and target, in
the style of the existing `/tm` subcommands.

## Acceptance criteria

- `/tm skills` prints a table: skill name, package version, invocations, cost, last target, most recent invocation time.
- Newest invocations first.
- Added to `src/query/commands.ts`; registered in the `/tm` surface.
- `npm test` green, `tsc --noEmit` clean.

## Test plan

- Seams: `test/commands.test.ts` with a fixture DB.
- Failure modes: no skill_invoke rows (empty/zero message); many skills (table formatting).
- Scenarios: one skill; multiple versions; null version.

## Constraints and dependencies

- Depends on slice 1 (shares the query).
- Mirror `src/query/commands.ts` subcommand pattern.
