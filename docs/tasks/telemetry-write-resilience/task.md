---
kind: task
slug: telemetry-write-resilience
title: Telemetry write path resilience — survive replayed/duplicate keys without total data loss
description: |
  A single replayed `tool_call_id` (PK UNIQUE violation) poisons its entire
  flush batch: `src/buffer.ts` re-enqueues the whole batch on any statement
  error, so one bad row rolls back all unrelated rows and retries forever —
  total session telemetry loss. Live-DB proof: 3 sessions have 0 committed
  rows across every table (not even `sessions`), only `telemetry_meta`
  survived, and `flush_log` has no rows for them. Two intertwined fixes:
  (1) buffer flush must not lose the whole batch on one failing statement;
  (2) natural-key INSERTs must be idempotent across processes so a replayed
  key no-ops instead of raising. Bug doc: `docs/bugs/tool-executions-duplicate-insert.md`.
epic: null
type: bug
bug: tool-executions-duplicate-insert
slices:
- duplicate-key-resilience
status: draft
started_at: 2026-07-31
---

# Telemetry write path resilience

**Bug doc:** `docs/bugs/tool-executions-duplicate-insert.md`
**Reproduction:** `repro.md` (next to this file) + `repro-duplicate-insert.ts`

## Outcome

The buffered write path must be resilient to a single bad statement: one
duplicate / malformed / constraint-violating row must never block unrelated
rows or silently destroy an entire session's telemetry. Replayed natural
keys (e.g. a `tool_call_id` re-emitted on session resume in a fresh
process) must no-op cleanly.

## User stories

- As a Pi user resuming a session, replayed tool calls / turns / requests
  must not corrupt or erase my telemetry — the store is append/idempotent
  for natural keys.
- As a telemetry consumer, a single failing INSERT must be logged and
  dropped, never roll back a whole batch or stall the buffer forever.

## Boundaries

- **In scope:** `src/buffer.ts` flush failure handling; natural-key INSERT
  idempotency across `src/capture/*`; regression test from `repro.md`.
- **Out of scope:** changing the schema (PKs stay); adding new tables;
  the cross-process `completedToolCallIds` in-memory dedup (stays as a
  fast-path, but must no longer be the only line of defense); the
  unrelated "97 missing tool_executions in session 019fb49e" anomaly
  (separate, unexplained — not this bug).

## Layers touched

- `src/buffer.ts` — flush() failure handling (primary).
- `src/capture/sessions.ts`, `runs.ts`, `turns.ts`, `llm.ts`, `tools.ts`,
  `bash.ts`, `session-events.ts`, `feedback.ts` — natural-key INSERTs.
- `test/` — regression test (converted from `repro-duplicate-insert.ts`).

## Slice

One default slice: `slices/1-duplicate-key-resilience.md`. May be split by
implement-task into (a) buffer resilience + (b) idempotency if the worker
struggles — the two defects are independent and separable.
