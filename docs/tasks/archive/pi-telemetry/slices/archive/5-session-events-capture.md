---
kind: slice
slug: session-events-capture
title: "Session-shape events capture"
task: ../task.md
mode: afk
status: todo
size: s
blocked_by: [scaffold-write-path]
started_at:
completed_at:
---

# Session-shape events capture

Handlers for SPEC §1.7: the generic `session_events` table (type + JSON
payload, not four tables).

## Scope

- `session_before_compact` / `session_compact` → `compaction` payload:
  reason (manual/threshold/overflow), tokens_before, will_retry,
  from_extension.
- `model_select` → `model_change`: from→to model, source
  (set/cycle/restore).
- `thinking_level_select` → `thinking_change`: from→to level.
- `session_before_fork` / `session_tree` → `branch` / `tree_nav`:
  entry ids, position, new/old leaf ids.

## Acceptance criteria

- Each event type produces one `session_events` row with the documented
  payload keys (unit-tested per type).
- Payloads are valid JSON; unknown/absent fields are NULL/omitted, not
  fabricated.
- Event rows carry session_id + unix_ms for ordering.

## Testing strategy

- **Layers:** `src/capture/session-events.ts`.
- **Failure modes:** (1) malformed/partial event payload → row with
  available fields, no throw; (2) JSON serialization failure → meta
  note, handler continues.
- **Key scenarios:** each of the five event types end-to-end through
  the fake harness.
- **Edge cases:** compaction with `will_retry`; model restore on
  session resume; tree navigation to the same leaf (no-op move).
