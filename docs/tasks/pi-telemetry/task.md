---
kind: task
slug: pi-telemetry
title: pi-telemetry — Local-first observability for Pi workflows
description: |
  Build the full v1 pi-telemetry extension from scratch: capture session/agent-run/turn/LLM-request/tool/bash/session-shape/feedback telemetry into one shared ~/.pi/telemetry.db (node:sqlite, WAL, zero runtime deps); query it via /tm commands, the query_telemetry agent tool, and external SQL clients; ship the feedback collector and the lineage foundation. SPEC.md at the repo root is the single source of truth.
epic: null
slices:
- scaffold-write-path
- session-run-turn-capture
- llm-request-capture
- tool-bash-capture
- session-events-capture
- feedback-collector
- lineage-foundation
- tm-command-surface
- query-telemetry-tool
- soak-privacy-gate
status: in-progress
started_at: 2026-07-30
completed_at: null
---

# pi-telemetry — Local-first observability for Pi workflows

**Source of truth: `SPEC.md` at the repo root.** All grilling decisions
(`docs/ideas/pi-telemetry.md`) are folded into it. Where this doc and
SPEC.md disagree, SPEC.md wins.

## Outcome

A working Pi extension in this (greenfield) repo that:

- Captures the full SPEC §1 measurement catalog into
  `~/.pi/telemetry.db` (WAL, `node:sqlite` `DatabaseSync`, zero runtime
  npm dependencies, one shared DB across all Pi processes on the machine).
- Write path per SPEC §3: lazy open at `session_start`, idempotent DDL,
  in-memory buffer flushed every 2000ms or 50 rows in one
  `BEGIN…COMMIT`, failures swallowed into `telemetry_meta`. Design
  target ~42k commits/s aggregate with 100 concurrent writers, 0 busy
  errors — validated by the soak slice, no fallback unless it fails.
- Query surface per SPEC §6: `/telemetry` (alias `/tm`) subcommands
  (status/session/cost/errors/feedback/tree/export/sql) and the
  `query_telemetry` agent tool (named presets primary; guarded raw SQL
  on a read-only connection, `LIMIT 500` injected, 3s statement
  timeout).
- Feedback per SPEC §5: `pi-telemetry:submit-feedback` bus intake +
  `submit_feedback` agent tool (`source="pi"` forced; coexists with the
  OTLP `submit_workflow_feedback` tool — no suppression, description
  steers).
- Lineage foundation per SPEC §4: `PI_TELEMETRY_*` env reader + bus
  listener for `pi-telemetry:agent.spawned`/`.completed`. No emitter in
  v1 — `parent_*` stays NULL in vanilla use.
- Privacy per SPEC §7: lengths + SHA-256 hashes only by default;
  content flags exist but ship disabled.

## User stories

- As a Pi user, my sessions, turns, LLM calls, tool runs and bash
  commands are recorded locally with no server or collector, so I can
  answer "what did today cost?" across all projects and sessions.
- As an agent, I can query my own telemetry (`query_telemetry`
  presets) and record structured workflow feedback (`submit_feedback`)
  without any external backend.
- As a power user, the DB is the API — `sqlite3`, DuckDB, pandas all
  work directly against `~/.pi/telemetry.db`.

## Boundaries (out of scope)

- The pi-subagents emitter shim (phase 2).
- OTLP/Prometheus export, live dashboards, alerting/SLOs, multi-host
  aggregation, real-time streaming (SPEC §10).
- Enabling content capture by default; `capture.bashCommand` content
  (hash only in v1).
- Any dependency on or coupling to ObservMe; suppressing or overriding
  the OTLP `submit_workflow_feedback` tool.

## Toolchain

TypeScript, **no build step** — pi loads `.ts` extensions directly
(host-injected `ExtensionAPI`; `typebox` and pi types are host-resolved
imports, not npm dependencies). `node --test` with Node 24 native
type-stripping; `tsc --noEmit` for typechecking. `dependencies: {}` —
devDeps only (`typescript`, `@earendil-works/pi-coding-agent`,
`typebox`).

## Layers / files

- `index.ts` — extension entry (default export, handler registration).
- `src/config.ts` — settings.json `pi-telemetry` block + env overrides.
- `src/db.ts` — connection, pragmas, DDL/migrations, buffer/flush.
- `src/capture/*.ts` — event handlers per table group.
- `src/feedback.ts`, `src/lineage.ts`.
- `src/query/*.ts` — canned SQL, `/tm` commands, `query_telemetry`.
- `test/*.test.ts` — `node:test`, in-memory `node:sqlite`, fake Pi
  event harness.

No existing abstractions to reuse — greenfield repo.

## Testing strategy (SPEC §9)

Two levels; the harness is built in slice 1 and conventions are
recorded in `docs/testing.md` during slice 1:

- **L1 unit:** handler → row mapping against in-memory `node:sqlite`
  with a thin typed `ExtensionAPI` stub firing synthetic events
  (`turn_start`/`turn_end` etc.). Fast; covers edge cases and failure
  modes.
- **L2 mock pi sessions:** real headless sessions via the pi SDK —
  `createAgentSession()` + `SessionManager.inMemory()`, the extension
  loaded through `extensionFactories` (its actual default export → real
  dispatch), and a scripted mock provider implementing the documented
  streaming API (`createAssistantMessageEventStream`; deterministic
  timing, exact usage/cost figures, scripted tool calls, simulated
  429s). No API keys. Used where event-shape fidelity matters (slices
  2/3/4) and for the slice-10 full-session gate.
- **Bus:** emit `pi-telemetry:submit-feedback` without listener
  (no-op), with listener (row appears), malformed payload (meta row, no
  throw). Lineage: emit `agent.spawned`/`.completed`, assert stamps.
- **Privacy:** default-config run asserts zero content strings in all
  tables.
- **Concurrency:** multi-process writer soak (gated) validating the §3
  design target (~42k commits/s aggregate, 0 busy, 100 writers).

## Implementation notes

- **scaffold-write-path (landed 2026-07-30):** repo scaffold,
  extension entry, config (SPEC §7 defaults + env overrides + merged
  settings.json), DB open/pragmas/9-table DDL/`user_version`
  migrations, buffered write path (threshold/timer/shutdown flush in
  one `BEGIN…COMMIT`, failure swallowed into `telemetry_meta`), and the
  two-level test harness. 12/12 tests green, `tsc --noEmit` clean.
  Divergences from plan: (1) added `@earendil-works/pi-ai` devDep
  because `pi-coding-agent@0.80.10` does not re-export
  `createAssistantMessageEventStream` (L2 harness imports
  `fauxProvider`/`fauxAssistantMessage` directly); (2) L2 harness
  manually emits `session_start` via `session.extensionRunner` since
  the SDK does not fire it on initial session creation; (3) `npm test`
  uses the glob `node --test 'test/**/*.test.ts'`. Capture handlers
  intentionally deferred to slice 2. Residual risk:
  `loadMergedSettings()` reads project `settings.json` without a trust
  gate — revisit for untrusted-project flows.
- **session-run-turn-capture (landed 2026-07-30):** capture handlers
  for `sessions` / `agent_runs` / `turns` (SPEC §1.1–1.3) —
  `session_start`/shutdown/info_changed INSERT+UPDATEs,
  `agent_start`/`agent_end`/`agent_settled` with distinct outcomes,
  `turn_start` sampling `ctx.getContextUsage()` and `turn_end` writing
  the full usage/cost breakdown; in-memory timers/IDs only. `index.ts`
  registers handlers through a lazy proxy telemetry object so the real
  buffer binds at `session_start` without stale references across
  multiple starts. 24/24 tests green (L1 fake-event + L2 SDK
  mock-session), `tsc --noEmit` clean. Divergences from plan: (1)
  added `src/version.ts` to source `ext_version` from `package.json`;
  (2) `RuntimeState` extended now with `lineage` (slice-7 seam) and
  `stagedPromptChars`/`stagedSystemPromptChars`; (3) proxy wiring in
  `index.ts` for reload safety; (4) L2 test asserts row
  existence/linkage/population rather than exact token/cost figures
  (`fauxProvider` derives usage from context length, zero cost).
  Residual risks: `session_start` is plain INSERT — a resumed session
  reusing the same `session_id` hits a PK conflict swallowed into
  `telemetry_meta` (coherence review to decide INSERT OR IGNORE);
  `turn_end` without `turn_start` writes a meta row, no orphan
  UPDATE (intended).
- **session-events-capture (landed 2026-07-30):** capture handlers
  for SPEC section 1.7 generic `session_events` (one table, type +
  JSON payload) -- `session_before_compact`/`session_compact` ->
  `compaction`, `model_select` -> `model_change`,
  `thinking_level_select` -> `thinking_change`, `session_before_fork`
  -> `branch`, `session_tree` -> `tree_nav`. Each row has a UUID
  `event_id`, `session_id`, `unix_ms`, and a JSON payload built only
  from documented event fields (absent/null omitted, never
  fabricated); JSON serialization failure is caught, logged to
  `telemetry_meta`, and the handler continues with an empty payload.
  11 L1 unit tests green, full suite 35/35, `tsc --noEmit` clean.
  Divergences from plan: (1) `from_extension` emitted only for
  `session_compact`, not `session_before_compact` (the Pi
  `SessionBeforeCompactEvent` type does not expose `fromExtension` --
  it cannot be known before compaction runs); (2) `model_change`
  payload uses `from`/`to` objects `{ provider, id }` rather than
  bare model-id strings for cross-provider query usefulness; (3)
  `session_before_tree` intentionally not handled -- it is outside
  the slice's listed event types, left for future work. Note: handler
  uses contextual typing from `pi.on` overloads since
  `ModelSelectEvent`/`ThinkingLevelSelectEvent` are not top-level
  exports of `@earendil-works/pi-coding-agent`.
- **feedback-collector (landed 2026-07-30):** SPEC section 5 generic
  structured-feedback intake via a shared
  `validateAndSerialize`/`handleFeedback` path funneling both the
  `pi-telemetry:submit-feedback` bus listener and the
  `submit_feedback` agent tool. Bus listener registered at extension
  load (emit without pi-telemetry is a documented no-op). Validation:
  non-empty `source`/`kind`; `data` serialized as JSON (objects) or
  stored raw (strings); UTF-8 byte cap against
  `config.feedbackMaxBytes` (64 KiB). Violations ->
  `telemetry_meta.feedback_rejected`, never a throw. Tool forces
  `source = "pi"`, describes the local telemetry store (coexistence
  with the OTLP tool; no `promptGuidelines` per SPEC section 5.2).
  Enrichment: `session_id`, `run_id`, `turn_index`,
  `received_unix_ms`; both paths stamp `received_unix_ms` at receipt
  and queries order by it. Tool `execute` is guarded so telemetry
  never breaks the Pi session; DB failures are recorded to
  `telemetry_meta` and the tool returns a success-neutral result.
  11 new tests green, full suite 46/46, `tsc --noEmit` clean.
  Divergences/notes vs plan: (1) lineage (`agent_label`, `depth`) is
  NOT stored on feedback rows -- SPEC section 2's `feedback` table
  has no lineage columns; feedback carries `session_id`/`run_id`/
  `turn_index` so lineage is reachable via join to `sessions`
  (schema-conformant, mirrors the approved lineage-on-sessions
  amendment); (2) `label: "Submit Feedback"` added to the tool
  definition (SPEC section 5.2's snippet omits it, but the installed
  `ToolDefinition` type requires it); (3) feedback arriving before
  `session_start` is rejected as `feedback_rejected` ("no active
  session") because `feedback.session_id` is NOT NULL and the proxy
  has no session context; (4) `data: null`/`undefined` rejected as
  `feedback_rejected` (SPEC silent on nulls; defensive reading);
  (5) extra exports `validateAndSerialize`/`handleFeedback` are
        additive test seams, not consumed elsewhere. Residual risks:
  `submit_feedback` stays registered if telemetry is disabled at
  `session_start` (calls silently produce no rows); the tool
  intentionally cannot distinguish "stored" from "failed to store"
  from the agent's perspective.
- **llm-request-capture (landed 2026-07-30):** capture handler for
  SPEC section 1.4 `llm_requests` -- assistant `message_start`
  INSERTs a `llm_requests` row (derived `request_id` signature
  `provider|model|api|timestamp|responseId`, turn/run/session IDs from
  runtime state) and records an in-memory TTFT start marker keyed per
  request; first `message_update` computes `ttft_ms`; `message_end`
  UPDATEs `stream_ms`, `duration_ms`, usage + cost breakdown and
  `stop_reason`; `after_provider_response` records
  `http_status`/`retry_after_ms`. TTFT/stream durations use the
  injectable `t.now()` clock, so L1 asserts exact figures with no
  wall-clock flakiness. Rows with no `message_update` keep
  `ttft_ms`/`stream_ms` NULL but record `duration_ms`; interleaved
  concurrent streams stay uncontaminated (marker keyed per request).
  7 new tests green, full suite 53/53, `tsc --noEmit` clean.
  Divergences from plan: (1) `after_provider_response` actually fires
  *before* `message_start` in the real SDK (headers arrive before
  the first stream event), so the handler buffers status/retry-after
  for the turn when no in-flight request exists yet and applies it to
  the next `message_start`; if an in-flight row exists it updates it
  directly; (2) no stable `request_id` in the event payload, so a
  derived signature keys in-flight markers (`responseId` included
  when providers set it); (3) no dedicated L2 429 test -- simulating
  a 429 through the faux provider needs a custom transport shim, out
  of slice scope; 429 path fully covered in L1, and the L2 test now
  asserts a normal streamed prompt produces a correlated
  `llm_requests` row. Residual risks: the four message/provider event
  types are not top-level exports of `@earendil-works/pi-coding-agent`
  (handler relies on contextual typing from `ExtensionAPI["on"]`
  overloads -- an SDK overload change could break typing silently);
  the ordering-buffer logic depends on current SDK event ordering. A
  deviation report is at
  `docs/tasks/pi-telemetry/deviation-reports/llm-request-capture.md`.
- **tool-bash-capture (landed 2026-07-30):** capture handlers for SPEC
  section 1.5-1.6 `tool_executions` and `bash_executions`.
  `registerToolCapture` handles `tool_execution_start`/`tool_result`/
  `tool_execution_end`, writes exactly one row per `tool_call_id`
  (deduplicated across `tool_result`+`tool_execution_end`
  interleaves), classifies errors into the bounded set
  `timeout|not_found|permission|validation|unknown` (raw messages
  never stored), and keeps `args_json`/`result_text` NULL unless
  `capture.toolArgs`/`capture.toolResults` are explicitly enabled
  (default: `*_chars` lengths + SHA-256 `result_hash` only).
  `registerBashCapture` wraps `createLocalBashOperations()` to time
  `user_bash` execution and INSERT `bash_executions` rows with
  `exit_code`/`cancelled`/`truncated`/`output_chars`/
  `exclude_from_context` plus command length and SHA-256 hash -- no
  command content ever stored; exec errors rethrow after a best-effort
  row so original behavior is preserved. 15 new tests green (8 tool +
  6 bash + 1 L2 scripted `read` tool-call row), full suite 68/68,
  `tsc --noEmit` clean. Divergences from plan: (1) L1 harness widened
  -- `test/helpers/l1-stub.ts` `fire()` now returns the fired
  handler's result (`Promise<R | undefined>`) so value-returning
  events (`user_bash`, `before_agent_start`, `tool_call`) are testable
  in L1; additive and backward-compatible, existing tests ignore it;
  (2) `tools.ts` inlines incremental `createHash().update()` for
  streaming result hashing instead of the string-only `sha256()` from
  `src/hash.ts` (used by `bash.ts`); `textLength()` is duplicated
  verbatim between the two modules -- coherence-refactor candidates
  for the step-3 cleanup (consolidate into a shared
  `sha256Stream`/`textLength` in `src/hash.ts`); (3)
  `ToolExecutionStartEvent`/`ToolExecutionEndEvent`/`ToolResultEvent`
  are not top-level exports of `@earendil-works/pi-coding-agent`; the
  handler relies on contextual typing from `pi.on` overloads, matching
  `src/capture/llm.ts`. Other coherence-review notes: orphan
  `tool_execution_end` writes a best-effort row with `duration_ms
  NULL` (whereas `llm.ts` drops orphans -- both satisfy their slice
  docs; consistency nuance for the refactor); `completedToolCallIds`
  grows unboundedly for process lifetime (consider clearing at
  session/run boundary); `InFlightTool` captures session/run/turn ids
  at start but the INSERT uses fresh `correlation()` (dead data).
  Residual risks: bash `output_chars` counts raw buffer bytes rather
  than UTF-8 text bytes (defensible, differs from other `*_chars`
  columns); bash `truncated` is inferred from raw byte/line counts vs
  `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`, an approximation of pi's
  sanitized-text truncation (bounded by pi's rolling buffer, so
  reliable in practice); tool capture builds the full result text for
  hashing -- large results allocate when `capture.toolResults` is
  enabled only. A deviation report is at
  `docs/tasks/pi-telemetry/deviation-reports/tool-bash-capture.md`.
