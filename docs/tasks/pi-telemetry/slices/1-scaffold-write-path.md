---
kind: slice
slug: scaffold-write-path
title: "Scaffold + DB write path"
task: ../task.md
mode: afk
status: todo
size: m
blocked_by: []
started_at:
completed_at:
---

# Scaffold + DB write path

Foundation every other slice builds on: repo scaffold, extension entry,
config, DB connection, schema, and the buffered write path (SPEC §2, §3,
§7, §8).

## Scope

- `package.json` (`"type": "module"`, `dependencies: {}`, devDeps:
  `typescript`, `@earendil-works/pi-coding-agent`, `typebox`; scripts:
  `test` → `node --test test/`, `check` → `tsc --noEmit`) and
  `tsconfig.json` (noEmit, strict).
- `index.ts` extension entry: default export, registers config load at
  `session_start`, close at `session_shutdown`.
- `src/config.ts`: read `pi-telemetry` block from project/global
  settings.json with env-var overrides; defaults per SPEC §7 (enabled,
  `~/.pi/telemetry.db`, flush 2000ms/50 rows, feedback cap 64KiB, all
  content flags off).
- `src/db.ts`: lazy `DatabaseSync` open at `session_start`; pragmas
  `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
  `foreign_keys=ON`; idempotent DDL for all tables in SPEC §2
  (sessions, agent_runs, turns, llm_requests, tool_executions,
  bash_executions, session_events, feedback, telemetry_meta);
  `PRAGMA user_version` migration gate (forward-only, numbered steps);
  close at `session_shutdown`.
- Write buffer: handlers append rows; flush in a single
  `BEGIN…COMMIT` when `bufferFlushMs` (2000) elapses or `bufferMaxRows`
  (50) is reached; final flush on shutdown.
- Failure handling: any DB error → best-effort `telemetry_meta` row
  (`write_failed`/`busy_retry`), then swallow. Telemetry must never
  break a Pi session.
- Test harness (`test/helpers/`, two levels per the task doc):
  - L1: thin typed `ExtensionAPI` stub (`pi.on` registry, `pi.events`,
    `registerTool`/`registerCommand` capture) firing synthetic events.
  - L2: SDK mock-session helper — `createAgentSession()` +
    `SessionManager.inMemory()`, the extension loaded via
    `extensionFactories` (its real default export), plus a scripted
    mock provider (`createAssistantMessageEventStream`; deterministic
    events, exact usage figures) registered through
    `pi.registerProvider` in a test-helper factory. No API keys.
- Fill `docs/testing.md`: framework (`node:test`), run commands, mock
  conventions (L1/L2 split above).

## Acceptance criteria

- `npm run check` and `npm test` pass.
- Opening the extension creates the DB file with all 9 tables; a second
  open (same or new process) is a no-op — DDL is idempotent.
- Buffer flushes on row threshold, on timer, and on shutdown.
- A simulated write failure is swallowed and recorded in
  `telemetry_meta`; the event handler returns normally.
- `user_version` is set; re-running migrations does not reapply steps.
- Harness proven: one L1 test (stub-fired event → row) and one L2 test
  (SDK mock session with the extension loaded → DB created and
  initialized) pass.
- `docs/testing.md` is no longer the bare template.

## Testing strategy

- **Layers:** `src/config.ts`, `src/db.ts`, `index.ts` wiring.
- **Failure modes:** (1) DB open fails (bad path/permissions) → meta
  best-effort + all handlers no-op safely; (2) flush fails mid-batch →
  meta row, session continues, next flush retries remaining buffer.
- **Key scenarios:** fresh DB creation; reopen existing DB; threshold
  flush; timer flush; shutdown flush; `user_version` gating.
- **Edge cases:** `enabled=false` → complete no-op; `dbPath` pointing
  to a nonexistent directory (create or fail safe into meta);
  `bufferMaxRows=1` (flush every row).
