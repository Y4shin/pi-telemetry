# Task for land-worker

Land slice "scaffold-write-path" for task "pi-telemetry".
Slice doc: docs/tasks/pi-telemetry/slices/1-scaffold-write-path.md
Task doc: docs/tasks/pi-telemetry/task.md
TDD output: # Slice: scaffold-write-path

Implemented the repository scaffold, extension entry, configuration, DB connection/schema/migrations, buffered write path, and L1/L2 test harnesses for `pi-telemetry`.

## What changed

- `package.json` / `tsconfig.json` — ESM, no runtime deps, devDeps only (`typescript`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`).
- `index.ts` — extension entry: loads config and opens DB on `session_start`, closes buffer on `session_shutdown`.
- `src/config.ts` — `loadConfig()` with SPEC §7 defaults, env-var overrides, and merged project/global `settings.json` blocks.
- `src/db.ts` — lazy `DatabaseSync` open, pragmas (WAL, NORMAL sync, 5s busy timeout, FKs), idempotent DDL for all 9 SPEC §2 tables, `PRAGMA user_version` migrations.
- `src/buffer.ts` — `WriteBuffer`/`createBuffer`: in-memory queue, threshold/timer/shutdown flush in single `BEGIN…COMMIT`, failure swallow with `telemetry_meta` row.
- `src/state.ts` — `Telemetry`/`RuntimeState` contract and `guard()` wrapper.
- `src/hash.ts` — SHA-256 helper.
- `test/helpers/l1-stub.ts` — typed `ExtensionAPI` stub that fires synthetic events.
- `test/helpers/l2-session.ts` — SDK mock session helper using `createAgentSession()` + `SessionManager.inMemory()` + `fauxProvider` mock provider.
- `test/config.test.ts`, `test/db.test.ts`, `test/buffer.test.ts`, `test/l1-harness.test.ts`, `test/l2-harness.test.ts`.
- `docs/testing.md` — framework, run commands, L1/L2 mock conventions.

## Divergence from plan

1. **Added `@earendil-works/pi-ai` devDependency.** The task doc states the SDK exports `createAssistantMessageEventStream`, but `pi-coding-agent@0.80.10` does not re-export it. The L2 harness imports `fauxProvider` / `fauxAssistantMessage` from `@earendil-works/pi-ai` directly.
2. **L2 harness manually emits `session_start`.** Neither `createAgentSession()` nor `createAgentSessionRuntime()` emits `session_start` during initial session creation in the tested SDK version. The harness fires it through `session.extensionRunner.emit({ type: "session_start", reason: "startup" })` so session-scoped extension initializers run.
3. **`npm test` uses a glob.** `node --test test/` resolves the directory as a module in this Node 24 environment, so the script is `node --test 'test/**/*.test.ts'`.
4. **No capture handlers yet.** Session/run/turn capture is intentionally left for slice 2; slice 1 only wires config, DB, buffer, and harness.

## Validation

```bash
npm run check   # tsc --noEmit — passed
npm test        # node --test 'test/**/*.test.ts' — 12 tests passed
```

Test summary:

- `config`: defaults, env overrides, settings.json merge.
- `db`: all 9 tables created, idempotent reopen, `user_version` set.
- `buffer`: threshold flush, timer flush, shutdown flush, DB error swallowed + `telemetry_meta` row.
- `L1 harness`: stub-fired `session_start` loads extension and creates DB/schema.
- `L2 harness`: SDK mock session with real extension default export creates and initializes DB.

## Residual risks

- `loadMergedSettings()` reads project-local `settings.json` without an explicit project-trust gate. This matches the slice doc wording but may need a `ctx.isProjectTrusted()` check when integrated with untrusted-project flows.
- L2 harness relies on SDK internals (`session.extensionRunner`) to emit `session_start`; if the SDK changes to emit it automatically, the harness can drop the manual emit.

## Acceptance report

Output saved to: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/20b97b9f-73ad-430c-bef2-52ad88d17117/tdd-scaffold-write-path/result.md (3.4 KB, 46 lines). Read this file if needed.. Verify output: # Verification: scaffold-write-path

## Gate Results

### Gate 1: Lint
- **Command:** `npm run check` (tsc --noEmit)
- **Result:** ✅ passed — zero type errors.

### Gate 2: Slice tests (fast)
- **Command:** `npm test`
- **Result:** ✅ passed — 12/12 tests, 5 suites, 0 failures.

```
▶ buffer
  ✔ flushes on row threshold
  ✔ flushes on timer
  ✔ flushes remaining rows on close
  ✔ swallows DB errors and records telemetry_meta row
▶ config
  ✔ returns defaults matching SPEC §7
  ✔ applies env overrides
  ✔ merges settings.json block
▶ db
  ✔ creates all 9 tables on open
  ✔ is idempotent on second open
  ✔ sets user_version and migrations do not reapply
▶ L1 harness
  ✔ stub-fired session_start creates DB and schema
▶ L2 harness
  ✔ SDK mock session with extension loaded creates and initializes DB
```

### Gate 3: Full project suite
- **Command:** `npm test` (same as slice — only 5 test files exist in the project)
- **Result:** ✅ passed — full suite is the slice suite; 12/12.

## Review

### Scope check
The implementation covers exactly what the slice doc describes: config loading, DB schema/migrations, buffered write path, state contract, SHA-256 helper, L1 stub harness, and L2 SDK mock harness. No capture handlers are implemented (intentionally deferred to slice 2 per the divergence notes). No extraneous features found.

### Diff
All implementation files match the accepted slice scope:
- `package.json`, `tsconfig.json` — ESM, devDeps only
- `index.ts` — extension entry with session_start/shutdown hooks
- `src/config.ts` — loadConfig with defaults, env vars, merged settings.json
- `src/db.ts` — DatabaseSync open, WAL/NORMAL pragmas, 9-table DDL, user_version migrations
- `src/buffer.ts` — WriteBuffer with threshold/timer/shutdown flush, BEGIN...COMMIT batching, error swallow + telemetry_meta
- `src/state.ts` — Telemetry/RuntimeState types and guard() wrapper
- `src/hash.ts` — SHA-256 helper
- `test/helpers/l1-stub.ts` — typed ExtensionAPI stub
- `test/helpers/l2-session.ts` — SDK mock session
- `test/*.test.ts` — 5 test files covering config, db, buffer, L1, L2
- `docs/testing.md` — framework docs

### Git state
- **Staged files:** none
- **Tracked modified (unstaged):** only `.pi-subagents/artifacts/` artifacts (not project code)
- **Untracked:** only `.pi-subagents/artifacts/` pipeline artifacts

### Residual risks noted in slice doc
- `loadMergedSettings()` reads project-local `settings.json` without a trust gate — acknowledged as matching the slice doc but needs attention in untrusted-project flows.
- L2 harness manually emits `session_start` via SDK internals — acknowledged divergence; harness can be simplified if/when SDK auto-emits it.

---

Slice `scaffold-write-path` verified — lint clean, slice tests passing, full project suite green.

Output saved to: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/20b97b9f-73ad-430c-bef2-52ad88d17117/verify-scaffold-write-path/result.md (2.8 KB, 67 lines). Read this file if needed..

Merge the slice branch into the task branch, archive the slice doc, commit.
Set task_set status done on the slice.

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/20b97b9f-73ad-430c-bef2-52ad88d17117/land-scaffold-write-path/result.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```