# Reproduction — subagent parentage not recorded

## Symptom (live DB)

All 54 sessions have NULL `depth`, `parent_session_id`, `parent_run_id`,
`agent_label` — including subagent child processes.

## Root cause

**Env-var namespace mismatch between pi-telemetry and pi-subagents.**

pi-telemetry's `readLineageFromEnv` (`src/lineage.ts`) reads:

```
PI_TELEMETRY_PARENT_SESSION_ID
PI_TELEMETRY_PARENT_RUN_ID
PI_TELEMETRY_DEPTH
PI_TELEMETRY_AGENT_LABEL
```

pi-subagents sets on child processes (`src/runs/shared/pi-args.ts`):

```
PI_SUBAGENT_PARENT_SESSION     (= parent session ID, set in process.env at index.ts:555)
PI_SUBAGENT_PARENT_RUN_ID      (= parent run ID, only for fanout-authorized)
PI_SUBAGENT_PARENT_DEPTH       (= child's depth: 1 for first-level, inherited+1 for nested)
PI_SUBAGENT_CHILD_AGENT        (= agent name/label)
```

These never match → `readLineageFromEnv` returns all-NULL → sessions row has
no parentage. SPEC §4 mechanism #1 (env vars) was designed for
`PI_TELEMETRY_*` vars, but pi-subagents — the only actual spawner — uses
its own `PI_SUBAGENT_*` namespace and never sets `PI_TELEMETRY_*`.

The pi-telemetry side is correctly wired: `sessions.ts:18` calls
`readLineageFromEnv(process.env)` at `session_start` and stamps the row.
The gap is purely the env-var name mismatch.

## Reproduction (L1)

`repro-subagent-parentage.ts` — simulate a child process session_start with
`PI_SUBAGENT_*` env vars set and assert the sessions row gets parentage.

```bash
cd /home/pplattner/Projects/pi-telemetry
node --test docs/bugs/repro-subagent-parentage.ts
# RED: depth should be 1, got null
```

## Fix

Make `readLineageFromEnv` fall back to `PI_SUBAGENT_*` env vars when
`PI_TELEMETRY_*` aren't set — a one-liner per field. The `PI_TELEMETRY_*`
contract stays as the primary mechanism (SPEC §4); `PI_SUBAGENT_*` is a
pragmatic fallback so parentage works with the actual spawner today.

Note: `PI_SUBAGENT_PARENT_RUN_ID` and `PI_SUBAGENT_PARENT_DEPTH` are set
to `""` (empty string) for non-fanout children, so the fallback must treat
empty strings as absent (`||` not `??`).
