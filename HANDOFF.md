# HANDOFF — pi-telemetry task, paused after slice 8

Written 2026-07-30 while pausing the implement-task workflow after
`tm-command-surface` landed. Another agent can pick up from here.

## Where things stand

- **Task:** `pi-telemetry` (docs/tasks/pi-telemetry/task.md). Source of
  truth: `SPEC.md` (repo root). Approved interface contracts:
  `docs/tasks/pi-telemetry/arch-spec.md` (READ FIRST — it contains
  post-approval amendments that beat the slice docs).
- **Branch:** `task/pi-telemetry` (all work lands here; `main` untouched
  until finalize-task). `git status` is clean.
- **Progress:** 8 of 10 slices landed. `npm test` → **114/114 green**,
  `npm run check` (`tsc --noEmit`) clean.
- Task status: `in-progress`. Remaining slice docs:
  - `docs/tasks/pi-telemetry/slices/9-query-telemetry-tool.md` (size m,
    depends on tm-command-surface)
  - `docs/tasks/pi-telemetry/slices/10-soak-privacy-gate.md` (size m,
    depends on query-telemetry-tool)

## How to resume

Continue the implement-task skill (`/skill:implement-task pi-telemetry`)
from Step 2, level 4 then level 5:

```
levels remaining: [ query-telemetry-tool ] → [ soak-privacy-gate ]
```

Dispatch each as the standard chain (see below), sequentially.

## Chain dispatch recipe (per slice)

Single foreground `subagent` chain call, `failFast: true`:

1. **tdd-worker** — implement the slice. Prompt MUST include:
   - Slice doc path + task doc + arch spec + SPEC.md paths
   - "Read arch spec first; its amendments beat slice docs"
   - Point to pi docs:
     `/nix/store/46l2syffzlyylqhs4mlzaxxyj5ivglry-pi-coding-agent-0.80.10/lib/node_modules/pi-monorepo/docs/extensions.md`
     and sdk.md; "installed node_modules types are authoritative, never invent event shapes"
   - Slice-9 specifics: `guardedQuery`/`runCanned` are **async** and
     `runCanned` takes `dbPath` first (arch spec §8 amendment); presets
     listed in slice doc exist in CANNED already; `sql` escape hatch uses
     `guardedQuery` — never duplicate preset SQL into the tool.
   - Slice-10 specifics: soak gated behind env flag `PI_TELEMETRY_SOAK=1`,
     excluded from default `npm test`; writer processes reuse the real
     `src/db.ts`/`src/buffer.ts`; privacy test exercises every capture path
     and asserts zero content strings; L2 harness = `test/helpers/l2-session.ts`.
2. **Parallel (concurrency 3):** slice-verifier ("Run npm run check and
   npm test; block on failure"), deviation-reporter (write report to
   `docs/tasks/pi-telemetry/deviation-reports/<slug>.md`), ui-noter
   (usually `no_ui_work`; handoff note path convention:
   `docs/tasks/pi-telemetry/impeccable-note-<slug>.md`).
3. **land-worker** — merge slice branch `--no-ff` into `task/pi-telemetry`,
   archive slice doc to `slices/archive/`, implementation note in task.md,
   `task_set status done`, update state.yaml, commit.

Prior outputs live at
`.pi-subagents/artifacts/outputs/<run-id>/{tdd,verify,deviation,ui-note,land}-<slug>/result.md`.

## ⚠ Model routing (REQUIRED — do not omit `model:` per dispatch)

The user demands per-agent model assignment this session. Omitting it caused
a kimi-k3 hang (exit 143, 0 turns) and a `contact_supervisor` wedge.

| Agent | Model |
|---|---|
| tdd-worker | `requesty/tensorx/kimi-k2.7-code` |
| slice-verifier | `tensorx/deepseek-v4-pro` |
| land-worker | `tensorx/deepseek-v4-pro` |
| deviation-reporter | `tensorx/glm-5.2` |
| task-workflow.ui-noter | `tensorx/deepseek-v4-flash` |

Do NOT edit global settings.json — pass `model:` per subagent call.
Tip from this session: tell the deviation-reporter in its prompt to record
findings in the report and only escalate genuine user-judgment decisions via
`contact_supervisor` (routine escalation wedged a chain once).

## Coherence-refactor queue (Step 3, after slice 10)

Accumulated across deviation reports — apply in this order:

1. **REQUIRED (supervisor-decided):** `src/lineage.ts` `buildEnvBlock` must
   derive the block from runtime state, not re-export `process.env`:
   `PARENT_SESSION_ID = t.state.sessionId`, `PARENT_RUN_ID = t.state.runId`,
   `DEPTH = t.state.lineage.depth + 1` (NULL→1),
   `AGENT_LABEL = t.state.lineage.agentLabel`. Update the env-export test in
   `test/lineage.test.ts` + module contract comment. Rationale in
   `deviation-reports/lineage-foundation.md` (SPEC §4 spawn-children intent).
2. **`pi_version` always NULL** (sessions): SPEC source "env" doesn't exist
   in pi v0.80.10. Decide: read from pi package version or accept NULL.
3. **Resume conflict:** `session_start` uses plain INSERT → PK conflict on
   resumed session ids, swallowed as write_failed. Apply `INSERT OR IGNORE`
   + test.
4. Dedup `textLength()` (in tools.ts + bash.ts) → move to `src/hash.ts`;
   consider shared `sha256Stream` (tools.ts inlines incremental createHash).
5. Align orphan-end policy: tools.ts writes best-effort row on orphan end,
   llm.ts drops — pick one policy.
6. Remove inert `if (sessionId !== undefined)` in `src/buffer.ts` recordMeta.
7. `docs/testing.md` documents `node --test test/`; actual is
   `node --test 'test/**/*.test.ts'` — fix doc.
8. Minor: meta event reuse (`handler_error` doubles as lineage note — maybe
   dedicated kind), `completedToolCallIds` unbounded growth, dead ids in
   `InFlightTool`, bash `output_chars` byte-based vs text-based elsewhere.

Also read ALL `docs/tasks/pi-telemetry/deviation-reports/*.md` and
`git diff main..task/pi-telemetry` at Step 3 per the skill.

## Then: finalize-task

After coherence refactor green: `/skill:finalize-task pi-telemetry`
(CI gate, knowledge harvest, changelog, archive, merge to main).

## Key facts a fresh agent needs

- Node 24, `node:sqlite` `DatabaseSync`, zero runtime deps (SPEC contract).
- Tests: `node --test 'test/**/*.test.ts'` (glob required on Node 24),
  typecheck `tsc --noEmit`.
- L1 harness `test/helpers/l1-stub.ts` (typed ExtensionAPI stub; its
  `fire()` returns the handler result since slice 4). L2 harness
  `test/helpers/l2-session.ts` uses `@earendil-works/pi-ai` `fauxProvider`
  (`createAssistantMessageEventStream` does NOT exist) and manually emits
  `session_start` via `session.extensionRunner.emit(...)`.
- L2 uses `fauxProvider` → zero-cost usage: exact figures asserted in L1
  (controllable injected clock `t.now`), existence/tolerance in L2.
- SPEC was amended post-approval (in SPEC.md + arch-spec.md):
  telemetry_meta has nullable unconstrained `session_id`; lineage bus
  events stamp `sessions` (never `agent_runs` — no lineage columns there).
- `after_provider_response` fires BEFORE `message_start` in the real SDK;
  llm.ts buffers per-turn. Marker keys are derived signatures (no
  request_id in payloads).
- `.pi-subagents/` is gitignored runtime workspace; don't commit it.
- User paused the workflow deliberately after slice 8 — confirm with the
  user before launching slice 9.
