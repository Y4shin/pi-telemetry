---
kind: map
slug: deprecate-bash-executions
title: Deprecate the bash_executions table — remove all code usage, keep the DDL
status: active
tasks: [deprecate-bash-executions]
---

## Destination

The `bash_executions` table is no longer used by any code in this repo. The
write path (capture handler) and read path (export + `/tm status` count) are
removed, all tests that referenced the table are cleaned up, and the table
plus the dead `capture.bashCommand` config flag are explicitly marked
deprecated in the schema, skills, SPEC, and the existing bug doc. The table
DDL itself stays in `src/db.ts` so older pi-telemetry extension versions that
are still running during the rollout can keep inserting without error.

## Constraints

- **Do not drop the `bash_executions` table.** Older extension versions
  running concurrently at startup time may still INSERT into it; the DDL must
  remain so those writes do not fail. A later, separate task can drop it once
  every running agent has upgraded.
- Read-only discipline for any DB inspection: this repo's own DB is opened
  read-only for analysis via the `telemetry_eval` helpers; do not write to
  `~/.pi/telemetry.db`.
- Keep the change TS- and test-clean: `npm test` green, `tsc` clean.
- No behavioral change to the agent's own `bash` *tool* — that is captured in
  `tool_executions` and is untouched.

## Decisions so far

- **Keep the table DDL.** Backward compatibility for in-flight older versions
  outweighs a clean drop. Deprecation is documented, not physical.
- **Leave `capture.bashCommand` in `src/config.ts` but mark it deprecated**
  (parallel to the table). It is a dead/reserved flag that was never wired to
  the writer; removing it now would churn ~12 test `makeConfig` objects for no
  behavioral gain. It is flagged for deletion alongside the table.
- **Remove all dead test references**, not just the writer test: the fixture
  seed row and the `DELETE FROM bash_executions` cleanup lines go too, so
  "delete all usage of it within the code" is consistent end to end.
- **Deprecate in SPEC.md and the bug doc as well**, not only the skill
  `schema.md`, so the spec no longer describes a live capture path.

## Fog

- Whether/when to physically drop the `bash_executions` table and remove the
  `capture.bashCommand` flag. This is deferred until every running agent has
  upgraded past the versions that INSERT into it. Tracked as a follow-up, not
  part of this map.

## Out of scope

- Dropping the `bash_executions` table or its DDL.
- Removing the `capture.bashCommand` config flag from `config.ts` (only a
  deprecation note is added here).
- Any change to how the agent's `bash` *tool* is recorded — it lives in
  `tool_executions` and is unaffected.
- Re-pointing richer per-command bash metrics (exit code, cwd, output size) at
  `tool_executions`. That is a separate feature if ever wanted.
- Editing archived task docs under `docs/tasks/archive/**` and idea docs under
  `docs/ideas/**` — they are historical record and left as-is.
