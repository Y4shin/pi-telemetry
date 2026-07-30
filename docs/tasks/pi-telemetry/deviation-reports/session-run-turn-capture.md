## Deviation report — session-run-turn-capture

Reviewed diff `task/pi-telemetry..slice/session-run-turn-capture`
(index.ts, src/capture/{index,sessions,runs,turns}.ts, src/state.ts,
src/version.ts, test/capture.test.ts, test/l2-capture.test.ts) against
`arch-spec.md` and the slice doc. Interface contract checked with slices 3/4/7
in mind.

### API surface changes

**RuntimeState extension (planned for slice 2, partially ahead of schedule)**
- **Planned:** slice 2 adds `stagedPromptChars`/`stagedSystemPromptChars`;
  slice **7** adds `state.lineage`.
- **Actual:** slice 2 already added `lineage: LineageState` (non-optional,
  all-null default) and the staged fields. The sessions INSERT includes the
  four lineage columns reading from `state.lineage` ✓.
- **Impact:** none on slices 3/4 (they only consume `correlation()` +
  `timers`). Slice 7 shrinks to *populating* `lineage` instead of adding it —
  additive, backward-compatible, no dependent-slice changes needed.

**Lineage seam narrowed (minor, actionable for slice 7)**
- **Planned:** "slice 7 populates `state.lineage` at session_start before the
  sessions INSERT (slice 2 leaves the seam)."
- **Actual:** the `session_start` handler in `src/capture/sessions.ts` *resets*
  `t.state.lineage` to all-null **inside the same `guard()` as the INSERT**.
  A slice-7 handler registered earlier (registration order) would be clobbered;
  slice 7 must edit the `session_start` handler body (replace the reset with
  the env read) rather than merely registering a prior listener.
- **Impact:** confined to slice 7, whose slice doc already anticipates "wiring
  in `src/capture/sessions.ts`". No re-work of slice 2 needed.

**`correlation()` semantics (matches spec, one note)**
- `turnId` is set at `turn_start` and nulled at `turn_end` (timers cleaned up);
  `turnIndex` resets to 0 — slices 3/4 see a null `turnId` between turns ✓.
- `runId` is set at `agent_start` but **never cleared** at
  `agent_end`/`agent_settled` — after a run settles, `correlation().runId`
  remains set until the next `agent_start`. Benign for attribution (a bash
  command after the run arguably belongs to it), but slice 3/4 writers should
  not assume "runId set ⇒ run in flight".

**Unplanned additions**
- `src/capture/index.ts` barrel (re-exports the three `register*Capture`).
- `src/version.ts` → `getExtensionVersion()` (reads `package.json`; needed for
  `sessions.ext_version` per SPEC §1.1 but not in the arch-spec module layout).
- Telemetry proxy wiring in `index.ts` (handlers registered once at factory
  load, real `Telemetry` bound at `session_start`) — internal, no contract
  change; keeps reload/multi-start safe.

### Abstraction usage
- Used/was specified: **yes.** Raw SQL + params through `t.enqueue()`; no ORM,
  no row builders. `node:crypto` `randomUUID` for run/turn IDs. SDK event types
  (`SessionStartEvent`, `TurnEndEvent`, …) imported from
  `@earendil-works/pi-coding-agent`, not invented. L2 test uses the
  `fauxProvider`/`createAssistantMessageEventStream`-class harness per the
  slice-1 correction (no `@earendil-works/pi-ai` helper of that name exists —
  harness helper used instead). `guard()` wraps every handler; meta rows
  best-effort. Zero new dependencies.

### Out-of-scope changes
- None beyond the additions above; no unrelated files touched, no API
  surfaces outside the slice altered.

### Divergence from acceptance criteria / spec sources

1. **`pi_version` will be NULL in production.** `sessions.ts` writes
   `process.env.PI_VERSION ?? null`. SPEC §1.1 lists the source as "env", but
   pi v0.80.10 sets **no `PI_VERSION` env var** and `ExtensionContext` exposes
   no version property — so the column is always NULL in real sessions. The
   implementer followed the spec's letter and had to invent the variable name.
   *Needs a coherence/user decision* (e.g. import pi's own package version,
   drop the column's population, or accept NULL).
2. **`outcome = 'interrupted'` has no producer.** SPEC §1.2's enum comment
   includes 'interrupted'; only `'end'` and `'settled'` are written. The slice
   doc only requires the end/settled distinction (met ✓, with a defensive
   `COALESCE` on settled not clobbering end). Flagging for completeness —
   decide whether interruption detection belongs in v1.
3. **Resume scenario unhandled/untested.** `session_start` uses a plain
   `INSERT`; a resume reusing the same `session_id` yields a PK conflict
   swallowed into `telemetry_meta` as `write_failed` (tdd worker flagged this
   itself). The slice doc lists "resume with pre-existing session row" as a key
   scenario without mandating behavior. *Coherence decision:* switch to
   `INSERT OR IGNORE` (or upsert updating `start_reason`) and add the test.
4. **L2 assertion level reduced.** The slice doc's testing strategy says
   "exact token/cost figures from the script"; `test/l2-capture.test.ts`
   asserts row existence, linkage, and field population instead, because
   `fauxProvider` derives usage from context length and reports zero cost.
   Environmental, documented by the worker. *Convention for slices 3/4:* follow
   the same pattern — exact figures in L1 (controllable), existence/linkage/
   tolerance in L2.
5. Passed criteria (spot-checked in tests + code): crash ⇒ `ended_at NULL`;
   end vs settled outcomes distinct; `context_tokens_at_start` sampled at
   `turn_start` with `getContextUsage()` failure → NULL + warn meta;
   `turn_end` without `turn_start` → meta note, no orphan UPDATE; per-event
   row shapes per SPEC §1.1–1.3.

### Task doc update needed?
**Yes** — append to `## Implementation notes` (create the section):
- `pi_version` source caveat (`PI_VERSION` env does not exist; decision pending).
- Resume/INSERT-OR-IGNORE decision pending (tdd-flagged).
- L2 assertion-level convention (existence/linkage/tolerance, exact figures in L1).
- `'interrupted'` outcome currently unproduced.
- Slice-7 note: populate lineage **inside** the `session_start` handler in
  `src/capture/sessions.ts` (replacing the null reset), not via a prior listener.

### User attention needed?
**Yes — low urgency, both resolvable at coherence refactor:**
1. `pi_version` env source doesn't exist in pi (SPEC §1.1 attribution is wrong;
   column NULL in production). Recommend deciding the source or accepting NULL.
2. Resume re-INSERT conflict: recommend `INSERT OR IGNORE` (+ test) unless user
   prefers an upsert that overwrites `start_reason`/`started_unix_ms`.
Neither blocks dispatch of level-1 slices 5/6 or level-2 slices 3/4/7 — slice 7
only needs the documented seam note.
