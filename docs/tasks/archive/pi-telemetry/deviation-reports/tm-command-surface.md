## Deviation report — tm-command-surface

### API surface changes

- **Planned (arch spec):**
  ```ts
  guardedQuery(dbPath, sql): { columns: string[]; rows: unknown[][]; truncated: boolean }
  CANNED: Record<string, { description: string; sql: string }>
  runCanned(name, filters): Table
  registerTelemetryCommands(pi, t): void
  ```
- **Actual:**
  ```ts
  guardedQuery(dbPath: string, sql: string, timeoutMs?: number): Promise<QueryResult>
  runCanned(dbPath: string, name: string, filters?: CannedFilters): Promise<Table>
  ```
  Both `guardedQuery` and `runCanned` are **async** (return `Promise`). `runCanned`
  takes `dbPath` as its first argument (canned.ts has no config dependency).
  `QueryResult = { columns: string[]; rows: unknown[][]; truncated: boolean }`
  matches the spec exactly. `Table extends QueryResult { description: string }`.
  An optional `timeoutMs` third param on `guardedQuery` defaults to 3000.
- **Impact on slice 9:** `query_telemetry` must `await` both `guardedQuery` and
  `runCanned`, and must pass `dbPath` (from `t.config.dbPath`) as the first
  argument to `runCanned`. The arch spec's sync signatures are stale — slice 9's
  prompt should note this. No other contract changes affect slice 9.

### Why async was necessary

`node:sqlite` `DatabaseSync` has no statement-timeout API. The 3 s timeout
(SPEC §6.2, slice doc acceptance criteria) requires running the query in a
worker thread and terminating it after the deadline. Worker threads are
inherently async. This is an implementation constraint, not a design choice.

### Read-only enforcement (spec-conformant)

- `DatabaseSync(dbPath, { readOnly: true })` + `PRAGMA query_only=ON` — confirmed
  in `doQuery()` (`src/query/sql-guard.ts:24-25`). Writes blocked by
  construction.
- The `isReadOnlySelect()` regex (`sql-guard.ts:16-18`) is used **only** to
  decide whether to inject `LIMIT 500` — it does **not** gate writes. A
  non-SELECT statement (e.g. `CREATE TABLE`) bypasses LIMIT injection but still
  fails against the read-only connection. This satisfies the arch spec's "no
  regex SQL validation ever" — the regex cannot be bypassed to enable writes.
- Test: `test/sql-guard.test.ts` "rejects writes by construction on a
  read-only connection" — `CREATE TABLE` rejected with
  `/read-only|query_only|attempt to write/i`.

### LIMIT 500 / timeout / row cap (spec-conformant)

- `ROW_LIMIT = 500`; injected for SELECT/WITH queries lacking a LIMIT clause
  (`hasLimitClause` strips string literals first). Rows sliced to 500;
  `truncated = rawRows.length > ROW_LIMIT || rows.length >= ROW_LIMIT`.
- 3 s default timeout via `setTimeout` + `worker.terminate()`. Test with 10 ms
  timeout against `randomblob(8000000)` confirms kill path.
- `runCanned` delegates to `guardedQuery`, inheriting all guards. Preset SQL
  strings include their own `LIMIT 500` (so no double-injection).

### Canned SQL coverage (spec-conformant)

All SPEC §1 derived metrics present in `CANNED`:
`session_cost`, `daily_cost`, `model_cost`, `cache_hit_ratio`, `tool_failures`,
`turn_latency` (median + p95), `context_growth`, `frequency_429`,
`ttft_by_model` (median + p95), `feedback`, `agent_tree`.
Slice-9 presets (`session_cost`, `daily_cost`, `tool_failures`, `feedback`,
`ttft_by_model`, `context_growth`, `agent_tree`) all present. ✅

Filter markers: `-- {{key:column}}` comments replaced by `applyFilters()` when
a matching filter is supplied; left in place (valid SQL comment) when absent.
The `errors` query correctly uses different column names per UNION branch
(`started_unix_ms` vs `unix_ms`) via the marker's column field. ✅

### CSV export (spec-conformant)

- `toCsv()`: header row + data rows, RFC-4180 escaping (commas, quotes,
  newlines). Test verifies round-trip parse.
- `exportDatabase()`: single-table (`--table`) or all 9 tables (default).
  Time filters (`--from`/`--to`) map to the correct time column per table
  (`started_unix_ms` / `unix_ms` / `received_unix_ms`). Row limit 10 000,
  30 s timeout for exports.

### Subcommand rendering (spec-conformant)

- All 8 subcommands tested against a multi-session fixture DB and an empty DB
  (no crashes, "(no data)" output). Unknown subcommand → usage message.
- TUI-bounded: `MAX_CELL_WIDTH = 40`, `MAX_TABLE_WIDTH = 120`, proportional
  shrink with column minimums. No table-formatting deps.

### Abstraction usage

- Used/was specified: **yes.** `guardedQuery` uses `node:sqlite` `DatabaseSync`
  with `{ readOnly: true }` per arch spec. `runCanned` delegates to
  `guardedQuery`. `registerTelemetryCommands(pi, t)` matches the contract.
  `node:worker_threads` for timeout (not in the "do NOT reimplement" list, and
  necessary since DatabaseSync has no timeout API). No external deps added.

### Out-of-scope changes

- **Additive canned queries:** `session_summary`, `model_cost`, `errors` are
  not in the slice-9 preset list but serve the command surface (`session`,
  `cost`, `errors` subcommands). Correct — the command surface needs them.
- **`CannedFilters` interface** (exported) with `toolName` field — additive,
  used by `tool_failures` preset filtering.
- **`CannedEntry` / `Table` / `QueryResult` / `ExportOptions` interfaces**
  exported — additive, aids slice-9 consumption.
- **`exportTable()` exported** alongside `exportDatabase()` — additive.

### Minor deviations from slice doc (non-blocking)

1. **`export` requires `--out`** — slice doc shows `--out` as optional
   (`export [--table T] [--from] [--to] [--out file.csv]`). Implementation
   returns a usage message if `--out` is absent. Intentional: avoids writing
   files into the cwd unexpectedly. Low impact — users always need a path.
2. **`status` buffer state** — slice doc says "buffer state". Implementation
   shows `flushMs` and `maxRows` config values, not an in-memory pending count.
   The `Telemetry` interface (slice 1) does not expose a pending-row count.
   This is an interface limitation, not a slice-8 defect.
3. **`tree` shows current session only** — slice doc says "current session
   family". Implementation filters `agent_tree` by `sessionId`, returning
   only the current session's row. Acceptable for v1 (no emitter → no family
   data). A future phase-2 emitter would require updating the query to walk
   the tree by `parent_session_id`.
4. **`session` renders key/value pairs** — `session_summary` returns 18
   columns (too wide for a single table row). Key/value rendering is a
   reasonable adaptation; all fields are present.
5. **Command handler cast** — `handler as unknown as (args, ctx) =>
   Promise<void>` because pi's `registerCommand` types the handler as
   `Promise<void>`, but the handler returns a string for print/headless
   mode. Pragmatic workaround; the string is still returned at runtime.

### Task doc update needed?

**Yes** — append to `## Implementation notes`:
- `guardedQuery` and `runCanned` are **async** (`Promise`); `runCanned` takes
  `dbPath` as first arg. Slice 9 must `await` and pass `dbPath`.
- `export` requires `--out` (intentional safety).
- `status` shows buffer config, not pending count (Telemetry interface
  limitation).
- `tree` filters to current session; family walk deferred to phase 2.
- Extra canned queries (`session_summary`, `model_cost`, `errors`) serve the
  command surface and are available to slice 9.

### User attention needed?

**No.** All deviations are either necessary implementation constraints
(async signatures due to worker-thread timeout), reasonable adaptations
(key/value rendering for wide results), or additive (extra canned queries).
The async signature change is the only one affecting slice 9, and it is a
straightforward adaptation. No scope or API-semantics decisions required.
