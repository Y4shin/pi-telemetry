# Testing

> Template. Fill in framework/command specifics in the first implementing task
> once the project scaffolding (package.json, tsconfig, test runner) exists.
> The **strategy** below is fixed by `SPEC.md` §9.

## Framework

**TBD** — decide during the first task (e.g. `node --test`, vitest). No runtime
dependencies beyond `node:sqlite` are expected; prefer the Node built-in test
runner to keep the extension zero-dependency.

## Run commands

```bash
# Run all tests (placeholder — confirm in first task)
npm test            # or: node --test

# Run a single test file
npm test -- path/to/file.test.ts

# Concurrency soak test (gated; see below)
npm run test:soak
```

## Strategy (from SPEC §9)

- **Unit — handler → row mapping.** Each event handler maps a simulated Pi
  event payload to exactly one DB row. Assert column values, not aggregates.
  Drive an in-memory `node:sqlite` (`DatabaseSync`) with a fresh DB per test.
- **Fake Pi event harness.** Simulate `turn_start`/`turn_end`,
  `message_start`/`message_update`/`message_end`, `tool_execution_start`/`_end`,
  `session_start`/`_shutdown`, etc. with hand-built payloads.
- **Concurrency — multi-process writer soak test.** Spawn N writer processes
  against one shared DB; assert 0 SQLITE_BUSY errors (within busy_timeout) and
  no lost rows. Treated as a gated regression test, not part of the default
  fast suite.
- **Bus — feedback collector.**
  - emit `pi-telemetry:submit-feedback` with no listener ⇒ no-op, no throw.
  - with listener ⇒ feedback row appears with enriched context.
  - malformed payload (missing `source`/`kind`, oversized `data`) ⇒
    `telemetry_meta` row (`feedback_rejected`), no throw.
- **Privacy — default config.** A default-configuration run asserts **zero
  content strings** (prompt text, tool args/results, bash commands, file paths)
  land in any table — only lengths + SHA-256 hashes.

## Mock conventions

- **DB:** in-memory `node:sqlite`, WAL pragmas still applied where relevant.
  Never touch `~/.pi/telemetry.db` from tests.
- **Clocks:** inject a deterministic time source for `*_unix_ms` and duration
  assertions; do not call `Date.now()` directly in handlers under test.
- **IDs:** generate UUIDs via the real path under test, but assert on
  presence/format, not exact values, unless the test fixes the generator.
- **Event bus:** a minimal fake `pi.events` recording emissions for the
  no-listener / with-listener / malformed cases.
