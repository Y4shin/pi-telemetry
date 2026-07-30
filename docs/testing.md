# Testing

## Framework

Tests use Node.js built-ins only:

- `node:test` for test runner and assertions (via `node:assert`).
- `node:sqlite` `DatabaseSync` for in-memory/on-disk SQLite assertions.
- No Jest/Vitest; TypeScript is stripped by Node 24 native ESM type-stripping.

## Run commands

```bash
npm run check   # tsc --noEmit
npm test        # node --test test/
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

## Failure-mode testing

- Simulate DB errors by enqueuing SQL against a non-existent table; assert a `telemetry_meta` row appears and no exception escapes.
- Use isolated temp directories per test; clean up in `afterEach`.

## Environment overrides

Config tests pass an explicit `env` object to `loadConfig()` to avoid mutating `process.env`. L2 tests set `PI_TELEMETRY_DB_PATH` before creating the session and clean it up afterward.
