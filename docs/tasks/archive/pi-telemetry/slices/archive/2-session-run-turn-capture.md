---
kind: slice
slug: session-run-turn-capture
title: "Session + agent-run + turn capture"
task: ../task.md
mode: afk
status: done
size: l
blocked_by: [scaffold-write-path]
started_at: 2026-07-30
completed_at: 2026-07-30
---

# Session + agent-run + turn capture

Handlers for SPEC §1.1–1.3: `sessions`, `agent_runs`, `turns`.

## Scope

- `session_start` → INSERT `sessions` (session_id, cwd, pi_version,
  ext_version, start_reason, started_unix_ms; lineage columns NULL for
  now — slice 7 stamps them).
- `session_shutdown` → UPDATE own row (`ended_unix_ms`, `end_reason`).
  Ownership rule (SPEC §3): only the owning process mutates its rows.
- `session_info_changed` → UPDATE `name`.
- `before_agent_start` → capture prompt/system-prompt lengths;
  `agent_start` → INSERT `agent_runs`; `agent_end` / `agent_settled` →
  UPDATE (`duration_ms`, `message_count`, `outcome` = end | settled |
  interrupted).
- `turn_start` → INSERT `turns` (turn_index, started_unix_ms,
  `context_tokens_at_start` from `ctx.getContextUsage()`);
  `turn_end` → UPDATE (duration, provider/model, full token usage, cost
  breakdown, stop_reason, tool_result_count).
- In-memory per-operation timers/IDs only (SPEC §3) — no in-flight
  state in the DB.

## Acceptance criteria

- Fake-event unit tests: each event maps to the documented row shape;
  `turn_end` writes the exact `usage` token/cost fields from SPEC §1.3.
- A session that never fires `session_shutdown` leaves `ended_at NULL`
  (crash-or-running semantics).
- `agent_end` vs `agent_settled` produce distinct `outcome` values.
- `context_tokens_at_start` is sampled at `turn_start`, not turn_end.

## Testing strategy

- **Layers:** `src/capture/sessions.ts`, `src/capture/runs.ts`,
  `src/capture/turns.ts` (or equivalent split).
- **Failure modes:** (1) `turn_end` without matching `turn_start`
  (dropped event) → no crash, no orphan UPDATE, best-effort meta note;
  (2) `ctx.getContextUsage()` throws → column NULL, handler continues.
- **Key scenarios:** full happy-path session (start → run → turns →
  shutdown); `/name` rename mid-session; fork/resume start reasons.
- **L2 mock session:** scripted provider turn driven through the SDK
  harness → `sessions`/`agent_runs`/`turns` rows match the known script
  (event-shape fidelity against the real pipeline — exact token/cost
  figures from the script).
- **Edge cases:** multiple agent runs in one session; turn_index
  sequencing across runs; resume with pre-existing session row.
