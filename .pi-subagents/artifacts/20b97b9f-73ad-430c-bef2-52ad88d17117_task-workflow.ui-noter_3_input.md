# Task for task-workflow.ui-noter

Detect UI work in slice "scaffold-write-path" for task "pi-telemetry".

Implementation: # Slice: scaffold-write-path

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

Output saved to: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/20b97b9f-73ad-430c-bef2-52ad88d17117/tdd-scaffold-write-path/result.md (3.4 KB, 46 lines). Read this file if needed..
Review the diff created by the TDD implementation. (Expected: headless DB/scaffold slice — likely no_ui_work.)
Handoff note path if UI work IS found: docs/tasks/pi-telemetry/impeccable-note-scaffold-write-path.md

---
**Output:**
Write your findings to exactly this path: /home/pplattner/Projects/pi-telemetry/.pi-subagents/artifacts/outputs/20b97b9f-73ad-430c-bef2-52ad88d17117/ui-note-scaffold-write-path/result.md
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