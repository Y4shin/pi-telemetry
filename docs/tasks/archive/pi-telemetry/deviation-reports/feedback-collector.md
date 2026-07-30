## Deviation report — feedback-collector

### API surface changes
- **Planned:** `registerFeedback(pi, t)` exporting one shared validate+serialize path; tool `submit_feedback` with exactly `{kind, data}` params, `source` forced to `"pi"`.
- **Actual:** Exactly as planned, plus two additional named exports: `validateAndSerialize(source, kind, data, maxBytes)` and `handleFeedback(t, source, kind, data, receivedMs)` — both exported (not module-private) and unit-testable, and `FeedbackPayload`/`ValidatedFeedback` types. The shared path is genuinely shared: bus listener and tool both funnel through `handleFeedback` → `validateAndSerialize`; no duplicated validation logic.
- **Impact:** None on dependent slices (8/9 query the `feedback` table, whose SPEC §2 shape is unchanged). The extra exports are additive test seams, not consumed elsewhere.

### Abstraction usage
- Used/was specified: **yes.** Uses `Telemetry.enqueue`/`meta`/`guard`/`state.correlation()` from slice 1, `randomUUID` + `TextEncoder` from node, `TypeBox` for tool params (arch-spec mandated). No new dependencies. `state.lineage` is *not* present yet (slice 7) and the implementation correctly does not reference it.

### Acceptance criteria check (all pass — 46/46 tests, `tsc --noEmit` clean)
- SPEC §9 bus tests: no-listener emit is a no-op (test asserts no throw against an unregistered stub); with listener the row appears; malformed payload → `feedback_rejected` meta row, no throw. ✅
- Oversized (>64KiB via `config.feedbackMaxBytes`) rejected into meta, not stored; UTF-8 byte-accurate cap; exactly-at-cap accepted. ✅
- Tool forces `source="pi"` regardless of params (test asserts a row with source `pi`). ✅
- Emit with pi-telemetry absent is a no-op for producers (documented contract, tested). ✅
- DB write failure during insert → meta row, tool still returns success-neutral result. ✅
- Interleaved bus+tool inserts ordered by `received_unix_ms`. ✅

### Deviations vs slice doc (deliberate, schema-consistent)
1. **Lineage enrichment not added to feedback rows.** Slice doc says enrich with `agent_label`/`depth` if present, but SPEC §2's `feedback` table has no such columns and the approved arch-spec amendment puts lineage on `sessions`. Implementation records `session_id`/`run_id`/`turn_index` — lineage recoverable by join. Consistent with the amendment; the slice doc wording loses to the schema, same as slice 7's bus-event resolution.
2. **`label: "Submit Feedback"` added to tool definition.** SPEC §5.2's snippet omits `label`; the installed `ToolDefinition` type requires it. Mechanical type conformance, not a design decision.
3. **"No active session" guard (additive).** Feedback arriving before `session_start` is rejected as `feedback_rejected` ("no active session") instead of being buffered or crashing, because `feedback.session_id` is `NOT NULL` and the telemetry proxy has no session context. Defensive and consistent with the schema; pre-session feedback is a documented no-op+meta, not queued.
4. **Explicit `try/catch` around `handleFeedback` in the tool executor**, funneling unexpected sync errors through `guard(t, …)` so the tool always returns a neutral result. Consistent with SPEC §3's "never break a session"; costs one nested-throw indirection (`catch → guard(() => { throw err })` reads awkwardly — harmless, candidate for coherence-refactor polish).
5. **`data: null`/`undefined` rejected** as `feedback_rejected` ("data must be an object or string"). SPEC says "serialized as-is (JSON for objects, raw for strings)" and is silent on nulls; rejection is a reasonable defensive reading, not specified.

### Out-of-scope changes
- `docs/ideas/skill-invocation-capture.md` (+1 commit refining it) exists in the branch diff. These were committed by the **parent/user mid-branch** (idea-capture for post-v1 skill telemetry), not by the tdd-worker. Unrelated to this slice; land-worker should leave the file in place — it's a separable docs addition, not slice work.
- No production-code changes outside `src/feedback.ts` + 2-line wiring in `index.ts` + `test/feedback.test.ts`.

### Task doc update needed?
**Yes** — append to `## Implementation notes` in `docs/tasks/pi-telemetry/task.md`:
- Feedback rows carry `session_id`/`run_id`/`turn_index` only; `agent_label`/`depth` are reachable via join to `sessions` (schema-conformant; mirrors the approved lineage-on-sessions amendment).
- Feedback before `session_start` and `data: null` are rejected into `telemetry_meta.feedback_rejected` (defensive guards; SPEC §5 silent on both).

### User attention needed?
**No.** All four acceptance clusters verified green; deviations are schema-mandated or small defensive additives within SPEC §3's failure-handling posture. No API-surface change affects slice 8/9's feedback queries. The slice-doc wording ("enrich with lineage if present") is what was imprecise, not the implementation.
