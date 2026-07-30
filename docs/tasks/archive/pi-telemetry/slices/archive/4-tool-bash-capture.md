---
kind: slice
slug: tool-bash-capture
title: "Tool + bash execution capture"
task: ../task.md
mode: afk
status: done
size: m
blocked_by: [session-run-turn-capture]
started_at: 2026-07-30
completed_at: 2026-07-30
---

# Tool + bash execution capture

Handlers for SPEC §1.5–1.6: `tool_executions`, `bash_executions`.

## Scope

- `tool_execution_start` → timer + args length; `tool_execution_end` /
  `tool_result` → INSERT `tool_executions` (tool_call_id, turn_id,
  run_id, session_id, tool_name, started_unix_ms, duration_ms,
  is_error, error_class, args_chars, result_chars,
  result_hash=SHA-256). `args_json`/`result_text` stay NULL unless
  `capture.toolArgs`/`capture.toolResults` enabled (flags exist,
  default off).
- `error_class`: bounded category string (e.g. timeout, not-found,
  permission, validation, unknown), **never** the raw error message.
- `user_bash`: wrap `createLocalBashOperations()` to time execution →
  INSERT `bash_executions` (bash_id, session_id, cwd, started_unix_ms,
  duration_ms, exit_code, cancelled, truncated, output_chars,
  exclude_from_context, command_chars, command_hash=SHA-256). **No
  command content** — length + hash only (SPEC §1.6 decision).

## Acceptance criteria

- Every completed tool call produces exactly one row keyed by
  `tool_call_id`; errors set `is_error` + bounded `error_class`.
- SHA-256 hashes are stable (same input → same hash) and content is
  never stored under default flags.
- Bash rows capture exit_code/cancelled/truncated/output_chars
  correctly for success, failure, and cancelled runs.
- Capture flags on → `args_json`/`result_text` populated (tested with
  flags explicitly enabled).

## Testing strategy

- **Layers:** `src/capture/tools.ts`, `src/capture/bash.ts`.
- **Failure modes:** (1) `tool_execution_end` without start (or
  duplicated IDs) → no crash, single consistent row; (2) bash wrapper
  throws timing the operation → original behavior preserved, row
  best-effort.
- **Key scenarios:** success, tool error, user-cancelled bash,
  truncated output, `!!` (exclude_from_context).
- **L2 mock session:** scripted `toolcall_end` for a real tool → real
  execution through pi → `tool_executions` row with actual duration,
  is_error, args_chars/result_chars/result_hash from the real run.
  (User-bash `!`/`!!` stays L1 — not prompt-drivable headlessly.)
- **Edge cases:** empty args/result (chars=0, hash of empty);
  non-JSON-serializable args (chars only); very large results
  (length + hash only, no big allocations).
