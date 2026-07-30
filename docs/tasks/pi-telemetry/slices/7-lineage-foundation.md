---
kind: slice
slug: lineage-foundation
title: "Lineage foundation (env reader + bus listener)"
task: ../task.md
mode: afk
status: todo
size: s
blocked_by: [session-run-turn-capture]
started_at:
completed_at:
---

# Lineage foundation

SPEC §4, v1 scope: ship the reader and listener. **No emitter** —
`parent_*` stays NULL in vanilla use. Phase 2 (pi-subagents shim) is
out of scope.

## Scope

- At `session_start`: read `PI_TELEMETRY_PARENT_SESSION_ID`,
  `PI_TELEMETRY_PARENT_RUN_ID`, `PI_TELEMETRY_DEPTH`,
  `PI_TELEMETRY_AGENT_LABEL`; stamp the `sessions` row.
- Export the same env block via `pi.events` for orchestrators that ask
  (documented helper contract).
- Bus listener for `pi-telemetry:agent.spawned` /
  `pi-telemetry:agent.completed` (documented payload: run ids, label,
  depth) → stamp/update the corresponding `agent_runs` rows.
- Publish the payload shape as the only contract — no dependency
  either direction.

## Acceptance criteria

- Env vars present → sessions row stamped; absent → columns NULL.
- §9 lineage test: emitting `agent.spawned`/`.completed` on the bus
  produces the expected lineage stamps on `agent_runs` rows.
- Malformed lineage payloads are swallowed (meta best-effort), never
  thrown.

## Testing strategy

- **Layers:** `src/lineage.ts`, wiring in `src/capture/sessions.ts`.
- **Failure modes:** (1) partially-set env (e.g. depth without parent
  session) → store what's present, no inference; (2) bus event for an
  unknown run_id → no-op + meta note.
- **Key scenarios:** child process launched with full env block;
  in-process orchestrator emitting spawn/complete around a run.
- **Edge cases:** depth as non-numeric string; empty-string label;
  `agent.completed` without matching `agent.spawned`.
