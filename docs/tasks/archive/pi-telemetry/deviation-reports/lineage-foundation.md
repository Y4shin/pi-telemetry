## Deviation report — lineage-foundation

### API surface changes

- **Planned:** `registerLineage(pi, t)`; `state.lineage` with **optional**
  fields (`{ parentSessionId?, parentRunId?, depth?, agentLabel? }`); bus
  events update the `sessions` row of the matching in-process session;
  env-export helper "published via `pi.events` as documented contract"
  (mechanism and event names unspecified).
- **Actual:** `registerLineage` as planned. `LineageState` uses
  `string|null` / `number|null` fields instead of optionals (trivial —
  null is the natural DB sentinel, matches how slice 2 seed it).
  Bus events `agent.spawned`/`agent.completed` match `payload.run_id`
  against `t.state.runId`, then `UPDATE sessions` of the current
  in-process session — per the approved amendment, **not** agent_runs. ✅
  Env-export helper shipped as an implementer-chosen request/response
  pair: `pi-telemetry:lineage-env.request` (payload ignored) →
  `pi-telemetry:lineage-env.response` (env block payload). Contract
  documented in `src/lineage.ts` module comment.
- **Impact:** No dependent slices consume the env-export helper or bus
  events in v1 (`/tm tree` reads `sessions` columns, unaffected). The
  `registerLineage`/`LineageState` interface matches the contract
  semantically; no pending-slice updates needed.

### Abstraction usage

- Used/was specified: **yes.** `guard()` wraps every handler; `t.enqueue`
  raw SQL + params; `t.meta` best-effort; slice-2 seam filled exactly as
  planned (`readLineageFromEnv(process.env)` replaces the null-reset
  inside the `session_start` guard). No new dependencies. Depth parsed
  to `Number.isInteger` for the `INTEGER` column.

### Out-of-scope changes

- **`pi-telemetry:lineage-env.request`/`.response` event names** chosen
  by implementer (spec named no mechanism). Additive, documented — fine.
- Meta event reuse: unknown run_id and malformed payloads both reuse
  `handler_error` at `warn` level (no new `MetaEvent` member). Within
  contract; slightly muddies meta semantics — candidate for a
  dedicated kind at coherence time, low priority.
- Empty-string env values stored as empty strings (no inference) —
  documented, matches "store what's present".
- Process note: `docs/tasks/state.yaml` was accidentally committed in a
  wip commit (via `git add -A`) and reverted in a follow-up. No content
  impact.

### ⚠ Required fix — coherence phase (user-decided)

**Env-export helper response semantics (`src/lineage.ts`,
`buildEnvBlock` + the `LINEAGE_ENV_REQUEST_EVENT` handler).**

As built, the helper answers `pi-telemetry:lineage-env.request` with
`buildEnvBlock(process.env)` — it re-exports the vars **this** process
received from **its** parent. The user has decided this is a **bug
against SPEC §4's intent**, not a contract choice: §4's purpose is
exporting a block **for spawning children** ("pi-telemetry also *exports*
these vars for any children it learns about"). Re-exporting the received
env defeats that purpose twice over:

1. Interactive root sessions (no `PI_TELEMETRY_*` vars set) reply with
   an **all-nulls block** — a child launched with it stamps nothing.
2. `PI_TELEMETRY_DEPTH` carries the parent's own depth instead of
   depth+1, mislabeling grandchildren.

**Required fix (coherence refactor):** derive the response block from
current runtime state instead of `process.env`:

- `PI_TELEMETRY_PARENT_SESSION_ID` = `t.state.sessionId`
- `PI_TELEMETRY_PARENT_RUN_ID` = `t.state.runId`
- `PI_TELEMETRY_DEPTH` = `t.state.lineage.depth + 1` (null → 1)
- `PI_TELEMETRY_AGENT_LABEL` = `t.state.lineage.agentLabel`

Update the slice-7 test
(`env-export helper responds with the current env block` in
`test/lineage.test.ts`) to assert the derived block, and adjust the
payload contract comment in `src/lineage.ts`. Not caught by the slice's
acceptance criteria because v1 has no consumer and the existing test
asserts the (buggy) re-export behavior. Containment is good: no v1
consumer, `/tm tree` unaffected, fix is local to one function + one test.

### Acceptance criteria check (slice doc)

- Env vars present → sessions row stamped; absent → NULL: ✅ (tests:
  `env vars present stamp…`, `partial env vars stored without inference`)
- §9 lineage test: `agent.spawned`/`.completed` produce expected stamps:
  ✅ bus listeners tested; stamps land on `sessions` per amendment
  (slice doc said `agent_runs` — amendment supersedes)
- Malformed payloads swallowed (meta best-effort), never thrown: ✅
- Edge cases: non-numeric depth → NULL ✅; empty-string label ✅;
  `agent.completed` without `agent.spawned` → both handlers are
  stateless UPDATEs by run_id, so completed-alone stamps fine ✅
- No emitter shipped: ✅

### Task doc update needed?

**Yes** — append to `## Implementation notes`:
- Lineage bus events update `sessions` (amendment); slice-doc wording
  about `agent_runs` is obsolete.
- Env-export helper ships as `pi-telemetry:lineage-env.request` /
  `.response` pair; response block derived from current runtime state
  (per user decision; see required fix above) — coherence phase must
  also update the payload contract comment in `src/lineage.ts` and the
  module docs.
- `meta(handler_error, warn)` doubles as lineage unknown/malformed
  marker.

### User attention needed?

**Resolved — decision received.** Env-export helper must derive its
response from current runtime state (option b); recorded above as a
required coherence-phase fix. No further user input needed on this
slice; everything else is spec-conformant.
