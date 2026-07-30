## Deviation report — scaffold-write-path

Verified against arch-spec.md and slice doc; `npm run check` and `npm test` (12 tests) pass on the slice branch.

### API surface changes

- **`Telemetry` / `RuntimeState` / `guard()`** — **Planned:** spec contract (state.ts). **Actual:** matches exactly, including `correlation()`, `timers`, injectable `now`, and guard → `meta("error","handler_error")`. **Impact on dependents:** none; slices 2–9 consume this as specified.
- **`loadConfig()`** — **Planned:** `loadConfig()` reading settings + env. **Actual:** split into testable pieces — `loadConfig(env, settings?)` (pure) plus exported `loadMergedSettings(cwd, agentDir?)` and `readSettingsFile(path)`; index.ts composes them. **Impact:** none; only index.ts composes. Env override names are now concrete: `PI_TELEMETRY_ENABLED`, `PI_TELEMETRY_DB_PATH`, `PI_TELEMETRY_BUFFER_FLUSH_MS`, `PI_TELEMETRY_BUFFER_MAX_ROWS`, `PI_TELEMETRY_FEEDBACK_MAX_BYTES`, `PI_TELEMETRY_CAPTURE_TOOL_ARGS` / `_TOOL_RESULTS` / `_BASH_COMMAND`.
- **`openDatabase()` / `initSchema()`** — **Planned:** separate `openDatabase()` + `initSchema()` exports. **Actual:** schema+migration gating folded into `openDatabase(dbPath)`; `SCHEMA`, `MIGRATIONS`, `Migration` type exported instead — no `initSchema` symbol exists. **Impact:** none — dependent slice 10 (soak) reuses `openDatabase`, which is the documented entry.
- **`WriteBuffer`** — **Planned:** a `WriteBuffer` export. **Actual:** factory `createBuffer(config, db, now?)` returning the `Telemetry` interface; no `WriteBuffer` type is exported. **Impact:** none — all dependent slices consume the `Telemetry` interface, not the class.
- **`guard()` / `sha256()` / L1 stub / L2 helper** — match the spec.

### Abstraction usage

- `node:sqlite` `DatabaseSync` only — **yes** (pragmas WAL/NORMAL/5000/fk exactly per SPEC §3).
- `node:crypto` SHA-256 only — **yes** (`src/hash.ts`).
- `node:test`/`node:assert` only — **yes**; 12 tests pass; no runtime dependencies in package.json.
- L2 SDK harness (not hand-rolled) — **mostly yes, with a spec correction:** the spec told implementers to use `createAssistantMessageEventStream`, but `@earendil-works/pi-coding-agent@0.80.10` does not export that symbol. The real mock-provider API is `fauxProvider`/`fauxAssistantMessage` in `@earendil-works/pi-ai` — the harness uses it via `pi.registerProvider` + `extensionFactories` as specified in spirit. Workflow/planning error, not implementer error (feedback submitted).
- L2 harness manually emits `session_start` via the internal `session.extensionRunner.emit(...)` because `createAgentSession()` doesn't emit it — SDK gap, contained to the test helper.

### Out-of-scope changes

- **Added devDependencies** `@earendil-works/pi-ai` and `@types/node` beyond the slice doc's devDeps list. Both dev-only; runtime dependencies remain zero (SPEC contract preserved).
- **`npm test` uses a glob** (`node --test 'test/**/*.test.ts'`) instead of the slice doc's `node --test test/` (Node 24 resolves the bare dir as a module). Minor inconsistency: `docs/testing.md` still documents `node --test test/`.
- **Inert condition** in `src/buffer.ts` `recordMeta`: `if (sessionId !== undefined)` — `sessionId` is `string | null`, never `undefined`, so the branch is always taken. Harmless (NULL is attached when no session, as the spec requires), but the check should be cleaned up or removed in a later slice when this file is touched.
- L2 harness manually fires `session_start` through the internal `session.extensionRunner.emit(...)` — test-helper-only reliance on an SDK internal; documented by the implementer.
- **Residual:** `loadMergedSettings()` reads project `.pi/settings.json` without a project-trust gate (`ctx.isProjectTrusted()` not wired) — matches slice-doc wording, flag for any future untrusted-project flow.

### Slice-doc acceptance criteria

All satisfied: check+test green (verified: 12 pass); 9 tables created with idempotent reopen; `user_version` gated (migration 1, `version > current` gate); threshold/timer/shutdown flushes; write failure swallowed + `telemetry_meta` row; L1 + L2 harness tests pass; `docs/testing.md` filled (minor doc drift: it documents `node --test test/` while package.json uses the glob).

### Task doc update needed?

**Yes** — append to `## Implementation notes`:

- Env override names are concrete: `PI_TELEMETRY_ENABLED`, `PI_TELEMETRY_DB_PATH`, `PI_TELEMETRY_BUFFER_FLUSH_MS`, `PI_TELEMETRY_BUFFER_MAX_ROWS`, `PI_TELEMETRY_FEEDBACK_MAX_BYTES`, `PI_TELEMETRY_CAPTURE_TOOL_ARGS` / `_TOOL_RESULTS` / `_BASH_COMMAND`.
- L2 harness requires `@earendil-works/pi-ai` (`fauxProvider`); `createAssistantMessageEventStream` is **not** exported by pi-coding-agent@0.80.10 despite planning-doc claims.
- L2 harness manually emits `session_start` via `session.extensionRunner.emit(...)`; `createAgentSession()` does not emit it.
- `npm test` is `node --test 'test/**/*.test.ts'` (bare-dir invocation breaks on Node 24); update `docs/testing.md` script line to match.

### User attention needed?

**No** — no API surface change affects dependent slices (all consume the `Telemetry` interface, which matches the spec). The pi-ai devDependency is dev-only; runtime deps remain zero. Optional non-blocking cleanups: the inert `sessionId !== undefined` check in `buffer.ts:recordMeta` and the `docs/testing.md` script line.
