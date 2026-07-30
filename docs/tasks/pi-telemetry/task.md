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
