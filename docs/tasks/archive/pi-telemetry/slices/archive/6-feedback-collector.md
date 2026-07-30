---
kind: slice
slug: feedback-collector
title: "Feedback collector (bus + submit_feedback tool)"
task: ../task.md
mode: afk
status: done
size: m
blocked_by: [scaffold-write-path]
started_at: 2026-07-30
completed_at: 2026-07-30
---

# Feedback collector

SPEC §5: generic structured-feedback intake — local alternative to the
OTLP `submit_workflow_feedback` pipeline. Coexists, never suppresses.

## Scope

- Bus listener `pi-telemetry:submit-feedback` at load: validate
  `source`/`kind` non-empty strings; serialize `data` (JSON for
  objects, raw for strings); cap serialized payload at
  `feedbackMaxBytes` (64 KiB). Violations → `telemetry_meta`
  (`feedback_rejected`), never a throw.
- Enrichment at receipt: session_id, run_id, turn_index,
  received_unix_ms, lineage (agent_label/depth) if present.
- `submit_feedback` agent tool: `Type.Object({kind, data})`, `source`
  forced to `"pi"`, same validation/cap. Description states it records
  to the **local** telemetry store (coexistence steering per SPEC
  §5.2; no `promptGuidelines`).
- No cross-path ordering guarantee; both paths stamp
  `received_unix_ms` at receipt and queries order by it.

## Acceptance criteria

- SPEC §9 bus tests pass: emit without listener is a no-op; with
  listener the row appears; malformed payload → meta row, no throw.
- Oversized payload (>64KiB) rejected into meta, not stored.
- Tool path forces `source="pi"` regardless of params.
- Emitting with pi-telemetry absent is a no-op for producers
  (documented contract).

## Testing strategy

- **Layers:** `src/feedback.ts`, tool registration in `index.ts`.
- **Failure modes:** (1) validation violation (empty kind, wrong
  types) → `feedback_rejected` meta row; (2) DB write failure during
  insert → meta row, tool returns success-neutral result (telemetry
  never breaks the session).
- **Key scenarios:** bus emit happy path; tool call happy path;
  interleaved bus+tool inserts ordered by `received_unix_ms`.
- **Edge cases:** `data` as plain string vs object; exactly-at-cap
  payload; emit before first flush (buffered correctly).
