---
kind: slice
slug: llm-request-capture
title: "LLM request capture (streaming metrics)"
task: ../task.md
mode: afk
status: done
size: m
blocked_by: [session-run-turn-capture]
started_at: 2026-07-30
completed_at: 2026-07-30
---

# LLM request capture (streaming metrics)

Handlers for SPEC §1.4: `llm_requests`, including TTFT and stream
duration — the extension's primary motivation.

## Scope

- `message_start` (assistant) → INSERT `llm_requests` (request_id,
  turn_id, run_id, session_id, provider, model, started_unix_ms);
  record in-memory TTFT start marker.
- First `message_update` → compute `ttft_ms`; mark stream start.
- `message_end` → UPDATE: `stream_ms` (first update → end),
  `duration_ms`, usage + cost breakdown, `stop_reason`.
- `after_provider_response` → record `http_status`,
  `retry_after_ms` (429 visibility).

## Acceptance criteria

- `ttft_ms` and `stream_ms` are computed from the event sequence with a
  controllable clock in tests (no wall-clock flakiness).
- A request with no `message_update` leaves `ttft_ms`/`stream_ms` NULL
  but still records `duration_ms`.
- A 429 response records `http_status=429` and `retry_after_ms`.
- Rows correlate to `turn_id`/`run_id`/`session_id` from slice 2
  state.

## Testing strategy

- **Layers:** `src/capture/llm.ts`.
- **Failure modes:** (1) `message_end` without `message_start` →
  swallowed, no orphan row; (2) interleaved concurrent requests
  (multiple in-flight message streams) → markers keyed per request, no
  cross-contamination.
- **Key scenarios:** normal streamed request; non-streamed (start→end)
  request; error/abort mid-stream; rate-limited response with
  retry-after.
- **L2 mock session:** scripted stream with fixed inter-event delays →
  `ttft_ms`/`stream_ms` within tolerance ranges (real wall clock in
  L2 — exact values are asserted in L1 with the controllable clock);
  scripted 429 → `http_status`/`retry_after_ms` recorded.
- **Edge cases:** zero-duration stream (single update); missing usage
  on `message_end`; provider without cost data (NULL costs).
