# Testing

## Framework

Tests use Node.js built-ins only:

- `node:test` for test runner and assertions (via `node:assert`).
- `node:sqlite` `DatabaseSync` for in-memory/on-disk SQLite assertions.
- No Jest/Vitest; TypeScript is stripped by Node 24 native ESM type-stripping.

## Run commands

```bash
npm run check   # tsc --noEmit
npm test        # node --test 'test/**/*.test.ts'
```

Single-file runs work for fast iteration:

```bash
node --test test/config.test.ts
node --test test/db.test.ts
node --test test/buffer.test.ts
node --test test/l1-harness.test.ts
node --test test/l2-harness.test.ts
```

## Mock conventions

### L1 unit harness (`test/helpers/l1-stub.ts`)

A lightweight typed `ExtensionAPI` stub for handler → row mapping tests:

- `pi.on` registry captures handlers by event name.
- `pi.events` is a minimal in-process event bus (`on`/`emit`).
- `pi.registerTool` / `pi.registerCommand` capture definitions.
- `stub.fire(event, payload, ctx?)` awaits all registered handlers with a partial `ExtensionContext`.

Use L1 when you need to assert that an event handler produces a specific DB row and do not need real SDK event fidelity.

### L2 SDK mock session harness (`test/helpers/l2-session.ts`)

Uses the real Pi SDK with no API keys:

- `createAgentSession()` + `SessionManager.inMemory()`.
- `DefaultResourceLoader` with `extensionFactories` to load the real extension default export and a scripted mock provider.
- Mock provider built with `@earendil-works/pi-ai` `fauxProvider` and deterministic `fauxAssistantMessage` responses.
- Because the SDK does not emit `session_start` during `createAgentSession`, the harness manually fires it through `session.extensionRunner.emit({ type: "session_start", reason: "startup" })` so session-scoped extension initializers run.

Use L2 when event-shape fidelity matters (future capture slices) or for full-session gates.

L2 conventions proven during pi-telemetry:

- `after_provider_response` fires BEFORE the assistant `message_start` stream
  in the real SDK — never assume stream-then-response ordering; buffer per turn.
- `fauxProvider` computes usage from context length and reports ZERO cost —
  assert exact token/timing figures in L1 (injected clock `t.now()`), only
  existence/tolerance in L2.
- `StringEnum` IS exported from `@earendil-works/pi-ai` (via
  `export * from "./utils/typebox-helpers.js"`) — despite some helper paths
  being internal-only.
- Concurrency: `test/ddl-first-start.test.ts` forks 5 processes via
  `test/helpers/ddl-worker.ts` and uses a parent-driven ready→start handshake
  with fail-fast kill + hard timeouts — reuse that pattern for any future
  multi-process test (a plain fork-and-wait deadlocks if a child dies early).

## Failure-mode testing

- Simulate DB errors by enqueuing SQL against a non-existent table; assert a `telemetry_meta` row appears and no exception escapes.
- Use isolated temp directories per test; clean up in `afterEach`.

### Write-path conventions (resilience)

Two invariants landed with the `telemetry-write-resilience` bug task; any
future write-path change must preserve them:

- **Batched fast-path + per-statement fallback.** `createBuffer`'s `flush()`
  first attempts the whole batch in one `BEGIN…COMMIT`. On ANY statement
  error it rolls back, then applies each statement individually via
  `applyOne`: healthy rows commit, offenders are logged to `telemetry_meta`
  (`event='write_failed'`, detail includes the SQL) and **dropped — never
  re-enqueued**. The buffer is cleared at the top of `flush()`, so a failing
  row cannot poison unrelated rows or retry forever. Regression:
  `test/duplicate-key-resilience.test.ts` (buffer isolation case). When
  adding a new capture path, do NOT reintroduce `buffer.unshift(...batch)`
  on flush failure.
- **Natural-key idempotency (`INSERT OR IGNORE`).** Every natural-key
  capture INSERT uses `INSERT OR IGNORE` (≡ `ON CONFLICT(<pk>) DO NOTHING`)
  so a key replayed across processes (e.g. session resume re-firing an
  already-recorded `tool_call_id`) no-ops instead of raising UNIQUE. The
  in-memory dedup in `tools.ts` (`completedToolCallIds` etc.) stays as a
  fast path but is NOT the only defense — it does not survive process
  restarts. Audit coverage: the SQL-audit test in
  `test/duplicate-key-resilience.test.ts` asserts every capture INSERT is
  `INSERT OR IGNORE`; keep that test green when adding capture tables.
- **Cross-process replay tests** pre-seed a row (simulating a prior
  process) in `beforeEach`, then fire events through a fresh `createBuffer`
  (empty module-level dedup) and assert exactly one row + no `write_failed`.
  Reuse this pattern for any new natural-key table.

## Soak policy

Synthetic multi-writer soak tests are retired (user decision 2026-07-30):
expected load never justifies 100-writer contention tests. Write-load
visibility in production comes from the `flush_log` table (one row per
buffer flush: row_count, tx_duration_ms, optional session_id).

## Environment overrides

Config tests pass an explicit `env` object to `loadConfig()` to avoid mutating `process.env`. L2 tests set `PI_TELEMETRY_DB_PATH` before creating the session and clean it up afterward.

## Removal-slice boundary caveat

`tsconfig.json` `include` covers `test/**/*.ts`, so a slice that deletes a
`src/` symbol imported by tests cannot leave `tsc` clean until those test
references are also removed in the same slice. Plan removals that touch
imported symbols as one cohesive slice (src + tests together), not as a
src-only slice followed by a test-cleanup slice. (Learned from
`deprecate-bash-executions`: the original 3-slice plan was unworkable and
was re-planned into 2.)

## Python eval tooling (off-repo, read-only)

Two skills authored in-repo at `skills/telemetry-eval-{setup,analyze}/`
(deploy later into `~/.pi/agent/git/codeberg.org/Yashin/skills/skills/<name>/`)
bootstrap a Python project at `~/.pi/telemetry-eval/` (uv → `pyproject.toml`
+ `uv.lock`, else `.venv` + `requirements.txt`; deps
 pandas/matplotlib/numpy/duckdb) for read-only analysis of `~/.pi/telemetry.db`.
NOT part of the npm CI — verified manually.

- `telemetry-eval-setup` creates the project + a `telemetry_eval` package:
  `connect()` (sqlite `file:<path>?mode=ro`, WAL-aware, write/DDL raises),
  `duck()` (duckdb `ATTACH '<path>' AS tel (TYPE sqlite, READ_ONLY)`),
  `scratch()` (rw, *separate* file — never the live DB), `resolve_db_path()`
  (env `PI_TELEMETRY_DB_PATH` → global → project `settings.json` →
  `~/.pi/telemetry.db`). NixOS: never `uv python install`; gate on a stable
  system python; compiled wheels need `LD_LIBRARY_PATH`→nix-ld.
- `telemetry-eval-analyze` writes eval scripts via
  `from telemetry_eval import connect` + `pd.read_sql_query(sql, con=connect())`;
  embeds the 10-table schema primer (`resources/schema.md`, derived from
  `src/db.ts`).
- Acceptance: `~/.pi/telemetry-eval/scripts/smoke_test.py` exits 0; the example
  `example_cost_by_model.py` returns a non-empty DataFrame. Run with
  `cd ~/.pi/telemetry-eval && [LD_LIBRARY_PATH=...] uv run python scripts/x.py`.

### Skill invocation capture (`src/capture/skills.ts`, landed task
`swt-skill-invoke-capture`)

Patterns proven for capturing `input`-event-driven, pre-expansion telemetry:

- **The `input` event is the skill-invocation seam.** `pi.on("input", …)`
  fires on TUI (`interactive`), RPC (`rpc`), and print (`pi -p`) — all route
  through `session.prompt()` → `emitInput` — and sees raw `/skill:<name> <args>`
  text BEFORE skill/template expansion. Skip `source:"extension"`
  (programmatic injection, not a skill invocation). The handler MUST return
  `{action:"continue"}` (outside the `guard()` body, so it returns even if the
  body throws) — telemetry must never block or transform input. Mid-stream
  `steer()`/`followUp()` expand skills WITHOUT firing `input` (accepted gap).
- **Skills-package version discovery.** `pi.getCommands()` returns
  `SlashCommandInfo[]` including `source:"skill"` entries with `sourceInfo.path`
  (the SKILL.md absolute path). Walk up from that path to the nearest
  `package.json` and read `name`+`version` (generalized in
  `src/version.ts` `resolvePackageInfo(startPath)`). Available after
  `session_start`, before the first `input`. Cache per skill; invalidate on
  `resources_discover`.
- **Zero-dep frontmatter extraction.** The Agent Skills standard `metadata`
  frontmatter field (`metadata.telemetry.capture: "key1,key2"`) is the
  self-declaration seam. `src/` has NO yaml dependency (and must not gain one —
  SPEC zero-runtime-deps contract); `skills.ts` uses a minimal `---\n…\n---`
  extractor. Only kebab-case slug identifiers are stored as metadata values;
  non-slug args → JSON `null` + no metadata row (the slice-1 `args_hash` already
  fingerprints the raw arg).
- **`session_event_metadata` (sparse EAV + CHECK).** The typed, queryable
  projection of skill-invocation dimensions (`skill_name`,
  `skills_package_version`, `target`, `run_id`, …). One row per (event_id, key);
  `INSERT OR IGNORE` for replay idempotency. The CHECK constraint enforces
  exactly one `value_*` column non-null matching `type`. The single writer is
  `insertSkillMetadata(t, eventId, key, type, value)` in
  `src/capture/skill-metadata.ts` (self-guarded). New queryable keys are rows,
  never a schema migration.
- **`run_id` attribution + back-fill.** The `input` event fires BEFORE
  `agent_start`, so the `skill_invoke` row starts with `run_id=null`. A
  `turn_start` handler back-fills `run_id`/`turn_id`/`turn_index` (native
  columns on `session_events`, migration 4) using the `event_id` stored in
  `RuntimeState.lastSkillInvokeEventId` (set at `input` time). This is what
  makes the compare-versions join efficient — join on `session_events.run_id`
  (native column, `idx_sev_run`), NOT on `session_id` (which cross-products).
- **Mid-run enrichment tool.** `telemetry_skill_context` (mirrors
  `submit_feedback`) lets a skill attach dynamic metadata mid-run. Attribution
  uses `lastSkillInvokeEventId` + `run_id` + `turn_id` (NOT a DB lookup —
  telemetry writes are buffered and the row may not be flushed yet when the
  tool runs). `json_set(payload, '$.key', json(?))` via a `jsonLiteral()` helper
  preserves numeric/boolean JSON types (plain `json_set(payload,'$.key',?)`
  stores them as JSON strings).
- **L1 harness for `input`.** `test/helpers/l1-stub.ts` `stub.fire("input",
  {type:"input", text:"/skill:foo bar", source:"interactive"})` drives the
  handler; assert `session_events` + `session_event_metadata` rows. The privacy
  test scans all TEXT/BLOB columns across the tables for the secret arg
  string (zero matches).
