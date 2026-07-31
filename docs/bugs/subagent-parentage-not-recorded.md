---
title: Subagent child sessions never record parentage (parent_* always NULL)
status: fixed
severity: major
reported: 2026-07-31
confirmed_by: code trace + L1 repro 2026-07-31
fix_commit: 109af0968d4bfca029b2f9e821962727575a5edf
promoted_to:
---

# Subagent child sessions never record parentage (parent_* always NULL)

## Observed

All 54 sessions in `~/.pi/telemetry.db` have NULL `depth`,
`parent_session_id`, `parent_run_id`, and `agent_label` — including
sessions that are subagent child processes. 5 sessions made 43 `subagent`
tool calls (which spawn child pi subprocesses), yet no child session has
parentage stamped.

```
total  with_depth  with_parent_sess  with_parent_run  with_label
   54           0                 0                0           0
```

## Expected

A subagent child pi process should be able to determine that it is a
subagent and record its parentage (`parent_session_id`, `parent_run_id`,
`depth`, `agent_label`) on its `sessions` row, via whatever mechanism
works. SPEC §4 outlines two complementary approaches (env vars
cross-process, bus events in-process), but the implementation is free to
use any method that achieves the outcome.

## Reproduction

### Live DB (already confirmed)

```bash
cd ~/.pi/telemetry-eval && uv run python -c "
from telemetry_eval import connect
import pandas as pd
con = connect()
print(pd.read_sql_query('''
SELECT COUNT(*) AS total,
  SUM(CASE WHEN depth IS NOT NULL THEN 1 ELSE 0 END) AS with_depth,
  SUM(CASE WHEN parent_session_id IS NOT NULL THEN 1 ELSE 0 END) AS with_parent
FROM sessions
''', con).to_string(index=False))
"
# -> total 54, with_depth 0, with_parent 0
```

### In-repo (code trace + L1, L2 optional)

1. **Code trace** — read `src/lineage.ts` (env-var reader + bus listener),
   `src/capture/sessions.ts` (whether `readLineageFromEnv` is called at
   session_start), and the SDK's `subagent` tool (whether it sets
   `PI_TELEMETRY_*` env vars on the child process or emits
   `pi-telemetry:agent.spawned`).
2. **L1 unit test** — simulate a child-process session start with
   `PI_TELEMETRY_*` env vars set (or a bus event fired) and assert the
   `sessions` row has parentage stamped. Currently red.
3. **L2 (optional, if the TDD worker finds it helpful)** — drive a
   subagent spawn through the L2 session harness and confirm the child
   session has parentage.

See `repro.md` for the exact trace and scripts.

## Suspected area

`src/lineage.ts` (env-var reader + bus listener) and/or
`src/capture/sessions.ts` (whether lineage is read/stamped at
session_start). The defect may also be upstream — the `subagent` tool
not setting `PI_TELEMETRY_*` env vars on the child process or not
emitting the `pi-telemetry:agent.spawned` bus event — which would make
this a cross-package issue (pi-subagents side).

## Root cause

**Env-var namespace mismatch between pi-telemetry and pi-subagents.**

pi-telemetry's `readLineageFromEnv` (`src/lineage.ts`) reads `PI_TELEMETRY_*`
env vars. pi-subagents — the only actual spawner of child pi processes —
sets its own `PI_SUBAGENT_*` env vars on children and never sets
`PI_TELEMETRY_*`. The data is available in the child's environment but
under a different namespace, so `readLineageFromEnv` returns all-NULL.

The mapping:

| pi-telemetry reads | pi-subagents sets |
|---|---|
| `PI_TELEMETRY_PARENT_SESSION_ID` | `PI_SUBAGENT_PARENT_SESSION` |
| `PI_TELEMETRY_PARENT_RUN_ID` | `PI_SUBAGENT_PARENT_RUN_ID` |
| `PI_TELEMETRY_DEPTH` | `PI_SUBAGENT_PARENT_DEPTH` |
| `PI_TELEMETRY_AGENT_LABEL` | `PI_SUBAGENT_CHILD_AGENT` |

Note: `PI_SUBAGENT_PARENT_RUN_ID` and `PI_SUBAGENT_PARENT_DEPTH` are set
to `""` (empty string) for non-fanout children, so the fallback must
treat empty strings as absent.

## Fix summary

Fixed in `src/lineage.ts`: `readLineageFromEnv` now falls back to
`PI_SUBAGENT_*` env vars when `PI_TELEMETRY_*` aren't set. The
`PI_TELEMETRY_*` contract stays as the primary mechanism (SPEC §4);
`PI_SUBAGENT_*` is a pragmatic fallback so parentage works with the
actual spawner (pi-subagents) today.

- `PI_TELEMETRY_*` vars preserve original semantics (empty string →
  empty string, tested by the existing lineage suite).
- `PI_SUBAGENT_*` fallback vars treat empty strings as absent (`||` not
  `??`), since pi-subagents sets `""` for unset fields on non-fanout
  children.

**Regression test:** `test/subagent-parentage.test.ts` (3 tests) —
stamps parentage from `PI_SUBAGENT_*` env vars; leaves root sessions NULL;
treats empty `PI_SUBAGENT_*` strings as absent. Also updated
`test/lineage.test.ts` and `test/capture.test.ts` env cleanup to isolate
`PI_SUBAGENT_*` vars (which leak from the real pi-subagents environment).

Validation: `npm run check` clean; full `npm test` 153 pass / 0 fail.
