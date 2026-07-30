# Deviation report — session-run-turn-capture (pi-telemetry)

Full report written to `docs/tasks/pi-telemetry/deviation-reports/session-run-turn-capture.md`.

## API surface changes
- **RuntimeState**: `lineage: LineageState` (non-optional, all-null default) added *ahead of schedule* (spec assigned it to slice 7) plus the planned `stagedPromptChars`/`stagedSystemPromptChars`. Sessions INSERT includes all four lineage columns reading from `state.lineage` ✓. Impact on slices 3/4: none (they consume `correlation()` + `timers` only). Slice 7 shrinks to populating `lineage`.
- **Lineage seam narrowed (actionable for slice 7)**: the `session_start` handler resets `t.state.lineage` to nulls *inside the same guard* as the INSERT, so slice 7 cannot populate it via an earlier-registered listener — it must edit the handler body in `src/capture/sessions.ts` (replacing the reset). Consistent with slice-7 doc's "wiring in src/capture/sessions.ts".
- **`correlation()` semantics**: `turnId` nulled at `turn_end` ✓; `runId` set at `agent_start` but **never cleared** at end/settled — stale runId visible after a run settles. Benign for attribution; slices 3/4 must not assume "runId set ⇒ run in flight".
- **Unplanned additions**: `src/capture/index.ts` barrel, `src/version.ts` (`getExtensionVersion()`, needed for `ext_version` per SPEC §1.1), telemetry proxy wiring in `index.ts` (internal; reload-safe). No contract changes for dependents.

## Abstraction usage
Yes — raw SQL+params via `enqueue()` (no ORM/row builders), `node:crypto` `randomUUID`, SDK event types from `@earendil-works/pi-coding-agent` (not invented), `guard()` on every handler, L2 uses the fauxProvider-class harness per slice-1 correction. Zero new dependencies.

## Divergence from acceptance criteria / spec
1. **`pi_version` always NULL**: writes `process.env.PI_VERSION ?? null`; SPEC §1.1 says source "env" but pi v0.80.10 sets no `PI_VERSION` and `ExtensionContext` exposes no version. Spec-attribution error; needs user/coherence decision.
2. **`outcome='interrupted'` unproduced** (SPEC §1.2 enum); only 'end'/'settled' written. Slice doc only required the end/settled distinction (met ✓).
3. **Resume unhandled/untested**: plain `INSERT` on `session_start` → PK conflict on resume, swallowed as `write_failed` meta (tdd self-flagged). Slice doc lists resume as a key scenario. Coherence decision: `INSERT OR IGNORE` + test (recommended) vs upsert.
4. **L2 assertion level reduced**: existence/linkage/field-population instead of exact token/cost figures (`fauxProvider` reports zero cost) — environmental; convention for 3/4: exact figures in L1, tolerance in L2.
5. Passed (spot-checked): crash ⇒ `ended_at NULL`; distinct end/settled outcomes; `context_tokens_at_start` at `turn_start` with failure → NULL + warn; `turn_end` w/o `turn_start` → meta, no orphan UPDATE; SPEC §1.1–1.3 row shapes.

## Out-of-scope changes
None (only the additions above).

## Task doc update needed?
Yes — create/append `## Implementation notes`: pi_version caveat; resume/INSERT-OR-IGNORE pending; L2 assertion-level convention; 'interrupted' unproduced; slice-7 lineage seam note.

## User attention needed?
**Yes — low urgency** (resolvable at coherence refactor, does not block levels 1–2):
1. `pi_version` source (SPEC §1.1 wrong; column NULL in production) — decide source or accept NULL.
2. Resume re-INSERT conflict — recommend `INSERT OR IGNORE` + test.