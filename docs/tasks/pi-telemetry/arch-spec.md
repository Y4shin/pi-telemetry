# Architecture spec — pi-telemetry

Approved by user. Source of truth remains `SPEC.md`; this spec records the
binding module/API contracts every slice chain must follow. Two amendments to
SPEC.md were decided at approval time and are folded into SPEC.md itself:

1. **Lineage recording:** bus events `pi-telemetry:agent.spawned`/`.completed`
   update the `sessions` row of the matching in-process session (SPEC §2's
   `agent_runs` has no lineage columns — the slice-doc wording loses to the
   schema). Unknown run_ids → no-op + meta note. `session_id` is the star
   schema's correlation hub; lineage on `sessions` is one join from all 8
   measurement tables.
2. **`telemetry_meta.session_id`:** new **nullable** column, attached when the
   meta row is attributable to a known session, NULL otherwise (process-local
   failures, session-table write failures). **No foreign-key constraint** —
   meta rows must never fail on a missing/unflushed session.

## Shared foundations

**Module layout:**

```
index.ts                      extension entry — wires config, db, buffer, all register*() calls
src/config.ts                 loadConfig(): settings.json block + PI_TELEMETRY_* env overrides
src/db.ts                     openDatabase(), initSchema() (SPEC §2 DDL verbatim), MIGRATIONS[]
src/buffer.ts                 WriteBuffer: enqueue/flush/close, threshold + timer, BEGIN…COMMIT
src/hash.ts                   sha256(text) — node:crypto only
src/state.ts                  Telemetry + RuntimeState + guard() error wrapper
src/capture/{sessions,runs,turns,llm,tools,bash,session-events}.ts
src/feedback.ts   src/lineage.ts
src/query/{sql-guard,canned,export,commands,tool}.ts
test/helpers/l1-stub.ts   test/helpers/l2-session.ts
```

**The write-path contract** (slice 1 exports; every capture slice consumes):

```ts
export interface Telemetry {
  readonly config: TelemetryConfig;
  readonly now: () => number;                                // injectable clock
  enqueue(sql: string, params: readonly (string|number|null)[]): void;
  meta(level: "warn"|"error", event: MetaEvent, detail?: string): void;   // best-effort, never throws
  readonly state: RuntimeState;
  flush(): void;  close(): void;
}
export interface RuntimeState {
  sessionId: string|null; runId: string|null;
  turnId: string|null; turnIndex: number;
  timers: Map<string,number>;                                // "ttft:<id>", "tool:<callId>", …
  correlation(): { sessionId; runId; turnId; turnIndex };    // current ids, or nulls
}
export function guard(t: Telemetry, fn: () => void): void;   // try/catch → meta("error","handler_error")
```

`meta()` attaches `state.sessionId` to the `telemetry_meta.session_id` column
when non-null, NULL otherwise.

Handlers write **raw SQL + params against the frozen SPEC §2 schema** — no
per-table row builders, no ORM. In-flight state lives only in
`RuntimeState`/module-scope maps, never in the DB (SPEC §3).

**Do NOT reimplement:**
- `node:sqlite` `DatabaseSync` is the only DB API — no better-sqlite3, no ORM,
  no migration framework.
- `node:crypto` `createHash("sha256")` for all hashing — no hash deps.
- `node:test` + `node:assert` only — no jest/vitest.
- `TypeBox` from pi for tool parameters.
- `createLocalBashOperations` from `@earendil-works/pi-coding-agent` — no
  manual process spawning for user-bash capture.
- L2 tests use SDK `createAgentSession()` + `SessionManager.inMemory()` +
  `createAssistantMessageEventStream` mock provider registered via
  `pi.registerProvider` — never hand-rolled provider protocol, never mocked DB.
- Event payload shapes come from pi docs `docs/extensions.md` / `docs/sdk.md`
  (v0.80.10) and the real `@earendil-works/pi-coding-agent` types — never
  invented.

## Per-slice contracts

**1. scaffold-write-path** — Exports: `Telemetry`, `RuntimeState`, `guard()`,
`loadConfig()`, `openDatabase()`, `WriteBuffer`, `sha256()`, L1 `ExtensionAPI`
stub, L2 session helper. The contract above is its contract.

**2. session-run-turn-capture** — Exports `registerSessionCapture(pi, t)`,
`registerRunCapture(pi, t)`, `registerTurnCapture(pi, t)`. **Contract for
slices 3/4/7:** owns all `RuntimeState` maintenance — sets `sessionId` at
`session_start`, generates/sets `runId` (UUID) at `agent_start`, `turnId`
(UUID) + `turnIndex` at `turn_start`, stages prompt lengths for run rows.
Lineage columns written from `state.lineage` (NULL until slice 7 populates
it); the INSERT column list already includes the four lineage columns so
slice 7 only fills the seam.

**3. llm-request-capture** — Exports `registerLlmCapture(pi, t)`. Consumes
`state.correlation()` and `state.timers` (TTFT/stream markers keyed by message
identity from the event payload; module-scope map if payload identity requires
it). `after_provider_response` updates the most recent in-flight request row —
or, if the response precedes the stream (real SDK ordering: HTTP headers
arrive before `message_start`), buffers status/retry-after per-turn and
applies them to the next `message_start`. Markers are keyed by derived
signature (`provider|model|api|timestamp|responseId`) since the payload has
no `request_id`.

**4. tool-bash-capture** — Exports `registerToolCapture(pi, t)`,
`registerBashCapture(pi, t)`. Consumes `correlation()`, `timers`, `sha256()`,
`config.capture` flags. `error_class` is a bounded set
(`timeout|not_found|permission|validation|unknown`); never raw messages.

**5. session-events-capture** — Exports `registerSessionEventsCapture(pi, t)`.
Payloads built from documented event fields only; absent fields omitted.

**6. feedback-collector** — Exports `registerFeedback(pi, t)`. One shared
local validate+serialize function for both the bus listener and the
`submit_feedback` tool (`source` differs; tool forces `"pi"`).

**7. lineage-foundation** — Exports `registerLineage(pi, t)`. Adds
`state.lineage: { parentSessionId?, parentRunId?, depth?, agentLabel? }`
populated at `session_start` before the sessions INSERT (slice 2 leaves the
seam). Bus events update the `sessions` row of the matching in-process
session; unknown run_id → no-op + meta note. Env-export helper published via
`pi.events` as documented contract. No emitter.

**8. tm-command-surface** — Exports for slice 9 (interface contract):

```ts
// src/query/sql-guard.ts
guardedQuery(dbPath, sql): { columns: string[]; rows: unknown[][]; truncated: boolean }
// src/query/canned.ts
CANNED: Record<string, { description: string; sql: string }>
runCanned(name, filters): Table
// src/query/commands.ts
registerTelemetryCommands(pi, t): void
```

Read-only enforcement is `DatabaseSync { readOnly: true }` +
`PRAGMA query_only=ON` — **no regex SQL validation ever**. Rendering is
TUI-bounded ASCII; no table-formatting deps.

**9. query-telemetry-tool** — Consumes slice 8's `guardedQuery` +
`CANNED`/`runCanned`; adds only param validation, tool registration, result
shaping. Preset SQL is **never** duplicated into the tool.

**10. soak-privacy-gate** — No production exports. Adds
`test/soak.test.ts` (env-gated `PI_TELEMETRY_SOAK=1`) and
`test/privacy.test.ts`. Soak writer processes reuse the real `src/db.ts` /
`src/buffer.ts`.

## Error-handling pattern

Every event handler body runs inside `guard(t, ...)`. Every DB error path is:
best-effort `meta()` row (with `session_id` attached when known) → swallow →
handler returns normally. Telemetry must never break a Pi session (SPEC §3).
