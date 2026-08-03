## Deviation report — swt-telemetry-skill-context-tool

### API surface changes

- **Planned (arch spec §Slice 4):** Register a `telemetry_skill_context` tool
  via `pi.registerTool` (mirrors `src/feedback.ts`). Tool params
  `{ target?, map?, slice?, sliceCount?, extra? }`. Attribution: match the
  most-recent `skill_invoke` row for the current `session_id` whose `run_id`
  = `t.state.runId` and `turn_id` = `t.state.turnId`. If none, record a
  `telemetry_meta` note and return success. Privacy: non-slug `extra` values
  → length/hash. Return `{content:[{type:"text",text:"Recorded."}], details:{}}`.

- **Actual:** Tool name `telemetry_skill_context`, label "Telemetry Skill
  Context", params exactly `{ target?, map?, slice?, sliceCount?(Integer),
  extra?(Record<String,Unknown>) }`. Return shape matches exactly. The tool
  is registered inside `registerSkillCapture` in `src/capture/skills.ts`,
  alongside the `input` handler (slice 1), version resolution (slice 2),
  frontmatter reader (slice 3), and `turn_start` back-fill (slice 5) — all
  in one `registerSkillCapture` function, as the arch spec intended
  ("extends `registerSkillCapture`"). **No API surface deviation on the
  tool itself.**

- **Attribution mechanism deviation (justified):** The arch spec says to
  "match the most-recent `skill_invoke` row for the current `session_id`
  whose `run_id` = `t.state.runId` and `turn_id` = `t.state.turnId`." Because
  telemetry writes are buffered (the `skill_invoke` row may not yet be
  flushed to SQLite when the tool runs mid-turn), a `SELECT … WHERE run_id
  = ? AND turn_id = ?` lookup could miss the row. The implementation instead
  uses `t.state.lastSkillInvokeEventId` (set by slice 1 at `input` time,
  back-filled by slice 5 at `turn_start` time — arch-spec Q1 decision) and
  strengthens the `UPDATE` with `WHERE event_id = ? AND run_id = ? AND
  turn_id = ?`. This preserves the spec's matching semantics (run_id +
  turn_id guard) while using the in-memory event_id as the primary key —
  robust to the buffered-write design. **Impact: none on dependents.** This
  slice is the last in the chain; no downstream slices call it.

- **Privacy fallback extension (defensive, in-spec-spirit):** The slice doc
  requires length/hash for non-slug `extra` values. The implementation also
  applies the same `isKebabSlug` → length/hash fallback to the top-level
  string params `target`, `map`, and `slice` when they are not clean
  kebab-case slugs. This is a defensive extension: the arch spec's privacy
  posture says "non-slug `extra` values → length/hash" but doesn't
  explicitly say top-level params are exempt. The feature-wide privacy rule
  ("no arg text anywhere") supports this. **Impact: none.** A skill passing
  a clean slug like `pi-telemetry` is unaffected; a non-slug like `Not_A_Slug`
  gets hashed. Tested explicitly ("hashes non-slug target/map/slice values").

### Abstraction usage

- **`src/feedback.ts` `registerTool` pattern:** Used as specified. The tool
  registration mirrors `submit_feedback` — `pi.registerTool({ name, label,
  description, parameters, execute })`. The `execute` wrapper catches errors
  via `guard()` and always returns success. ✓
- **`t.state.correlation()`:** Used as specified — reads `sessionId`,
  `runId`, `turnId` from `t.state.correlation()` inside
  `handleTelemetrySkillContext`. ✓
- **`insertSkillMetadata` (slice 6):** Used as specified — the tool projects
  each param (`target`, `map`, `slice`, `sliceCount`, `extra.*`) as a typed
  `session_event_metadata` row via the shared helper. Types correctly
  mapped: strings → `value_text`, integers → `value_int`, booleans →
  `value_bool`, floats → `value_real`. ✓
- **`guard()`:** The `execute` function wraps `handleTelemetrySkillContext`
  in a try/catch that delegates to `guard()` on error, consistent with
  `feedback.ts`. ✓
- **`sha256` / `textLength` from `src/hash.ts`:** Used for the length/hash
  privacy fallback. ✓
- **`isKebabSlug` (local helper in `skills.ts`):** Already defined by slice 3
  (frontmatter reader); reused, not re-declared. The TDD report notes a
  first-run `SyntaxError: Identifier 'isKebabSlug' has already been declared`
  was resolved by removing the duplicate. ✓

### Out-of-scope changes

1. **Privacy fallback on top-level string params (`target`/`map`/`slice`):**
   The slice doc explicitly requires length/hash only for `extra` non-slug
   values. The implementation extends this to `target`/`map`/`slice` when
   they are not clean slugs. This is a **defensive extension** consistent
   with the feature-wide privacy posture ("no arg text anywhere") and the
   arch spec's cross-cutting privacy decision. It does not change the API
   surface or affect dependents. **Verdict: reasonable and in the spirit of
   the spec; the arch spec's privacy section supports it even though the
   slice doc's acceptance criteria only mention `extra`.**

2. **`json(?)` in `json_set` for type preservation:** The TDD report notes
   the initial `json_set(payload, '$.key', ?)` stored numbers/booleans as
   JSON strings. Switched to `json_set(payload, '$.key', json(?))` so SQLite
   parses the literal and preserves numeric/boolean JSON types. This is a
   correctness fix, not a scope change — the spec says "merges its params
   into the payload" and a number param should be a number in JSON, not a
   string. The `jsonLiteral()` helper builds the correct JSON literal
   (`true`/`false` for booleans, raw number for numbers, `JSON.stringify`
   for strings). **Verdict: correct fix, no scope impact.**

3. **`json_quote(?)` for enrichment UPDATEs (slices 2/3, not this slice):**
   The `enrichSkillInvokePayload` and `projectCapturedFields` functions (owned
   by slices 2/3 in the same file) use `json_quote(?)` to map SQL NULL to
   JSON null. This slice's `handleTelemetrySkillContext` uses `json(?)` +
   `jsonLiteral()` instead. Both are correct for their contexts
   (`json_quote` for nullable string values; `json(?)` for typed literals).
   No conflict, but the coherence refactor (Step 3) should verify the two
   JSON-update patterns are consistent. **Verdict: no issue for this slice;
   note for coherence.**

### Acceptance criteria check

| Criterion | Status | Evidence |
|---|---|---|
| Tool registered with params `{ target?, map?, slice?, sliceCount?, extra? }` | ✓ | `Type.Object({ target: Optional(String), map: Optional(String), slice: Optional(String), sliceCount: Optional(Integer), extra: Optional(Record(String,Unknown)) })` in `skills.ts` |
| When called mid-run, merges params into the session's most-recent `skill_invoke` row matching current `run_id`/`turn_id` | ✓ | Test "enriches the current skill_invoke row and projects metadata" asserts payload fields + metadata rows; UPDATE uses `WHERE event_id = ? AND run_id = ? AND turn_id = ?` |
| If no matching `skill_invoke` row exists, records a `telemetry_meta` note and returns success | ✓ | Test "records a telemetry_meta note when no skill_invoke preceded the turn" asserts meta row + 0 skill_invoke rows; test "records a telemetry_meta note when called outside a turn" asserts meta when run_id/turn_id are null |
| Tool returns `{content:[{type:"text",text:"Recorded."}], details:{}}` | ✓ | Test "returns success-neutral result" asserts exact return shape |
| Privacy: `extra` non-slug values → length/hash | ✓ | Test "hashes non-slug extra string values" asserts `extra.secret` = `length:hash` and raw text absent from metadata table |
| `npm test` green, `tsc --noEmit` clean | ✓ | 207 tests pass, tsc clean |

### Additional test coverage (beyond acceptance criteria)

- "hashes non-slug target/map/slice values" — verifies the defensive
  privacy extension on top-level params.
- "merges multiple enrichments on the same row" — two tool calls enrich the
  same `skill_invoke` row; asserts payload merge + metadata dedup (one
  `slice_count` metadata row, not two).
- "records a meta note for unserializable extra values and returns success"
  — circular reference in `extra` → `JSON.stringify` throws → meta note +
  success (never breaks the agent).
- "does not throw when no session is active" — null `sessionId` → meta note,
  no throw.

### Task doc update needed?

**No** — the implementation matches the arch spec's interface contract. The
two deviations (attribution via `lastSkillInvokeEventId` + run/turn guard;
privacy fallback on top-level params) are both justified by the spec's own
decisions (Q1 state field, cross-cutting privacy posture) and don't change
any API surface. The coherence-refactor queue (Step 3) should note the two
JSON-update patterns (`json_quote` vs `json(?)` + `jsonLiteral()`) in the
same file and verify consistency, but this is a minor style note, not a
task-doc update.

### User attention needed?

**No** — no scope change, no API surface difference, no user-judgment
decision. The attribution mechanism deviation is a justified adaptation to
the buffered-write design (the spec's "match the most-recent row" semantics
are preserved via the in-memory event_id + run/turn guard). The privacy
fallback extension is defensive and consistent with the feature-wide
posture.
