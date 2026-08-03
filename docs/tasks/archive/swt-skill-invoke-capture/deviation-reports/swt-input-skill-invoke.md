## Deviation report — swt-input-skill-invoke

### API surface changes
- **Planned:** `registerSkillCapture(pi: ExtensionAPI, t: Telemetry): void`
  in new file `src/capture/skills.ts`, creating the file + the `input`
  handler. `RuntimeState` gains `lastSkillInvokeEventId: string | null`
  (arch-spec Q1, approved). Registered in `index.ts` alongside other
  captures.
- **Actual:** Signature matches exactly. `src/capture/skills.ts` exports
  `registerSkillCapture`. `RuntimeState.lastSkillInvokeEventId` added
  (initialized to `null` in `createRuntimeState`). Registered in `index.ts`
  at line 81, after `registerSessionEventsCapture` and before
  `registerFeedback` — consistent with the arch-spec registration-order note
  ("near session-events.ts for locality"). Additionally re-exported from
  `src/capture/index.ts` (the capture barrel) — a convenience addition
  consistent with the existing barrel pattern for all other capture modules.
  No signature change.
- **Impact:** None on dependent slices (2, 3, 5). The `lastSkillInvokeEventId`
  field on `RuntimeState` is the contract slice 5 reads for back-fill and
  slice 4 reads for enrichment — exactly as specified.

### Abstraction usage
- Used/was specified: **yes** — all specified abstractions were used:
  - `insertSkillMetadata` (slice 6): called to project `skill_name` as a
    `string` metadata row. ✓
  - `src/capture/session-events.ts` `insertEvent()` pattern: the slice
    writes directly via `t.enqueue` (not re-using `insertEvent`) because it
    needs the `event_id` for the metadata projection — exactly as the arch
    spec anticipated ("but this slice writes directly via `t.enqueue` since
    it also needs the `event_id`"). ✓
  - `src/hash.ts` `sha256()`: used for `args_hash`. ✓ Also uses
    `textLength()` from `src/hash.ts` for `args_chars` — a shared helper
    that was not explicitly named in the arch spec but is the correct
    abstraction (byte-length, same module as `sha256`).
  - `src/state.ts` `guard()`: wraps the handler body. ✓
  - `INSERT OR IGNORE` on `session_events.event_id` for replay idempotency.
    ✓
  - `randomUUID()` for the event_id, shared between the `session_events`
    insert and the metadata projection. ✓

### Out-of-scope changes
- **`textLength` from `src/hash.ts`**: the slice uses `textLength(args)`
  for `args_chars` instead of `args.length`. This is a byte-length
  (`Buffer.byteLength`) rather than character count. The slice doc says
  `args_chars=7` for "bar baz" (7 ASCII bytes = 7 chars — identical for
  ASCII). For multi-byte UTF-8 args, byte-length and char count differ.
  This is **not a deviation** — `textLength` is the correct shared helper
  (used elsewhere in the codebase for `args_chars` in tool_executions), and
  the arch spec says "lengths + hashes only" without mandating char vs byte
  count. The field name `args_chars` is a pre-existing convention; the value
  is byte-length, consistent with the rest of pi-telemetry.
- **Re-export from `src/capture/index.ts`**: additive barrel export, same
  pattern as slice 6. Not a scope change.
- **Empty skill name (`/skill:`) records a row**: the test "handles empty
  skill name gracefully" asserts a row IS written with `skill_name=""`. The
  slice doc's test plan lists "empty skill name (`/skill:` with nothing)" as
  a failure mode but does not say it should be skipped. The arch spec does
  not mandate skipping empty names. This is a minor edge-case decision
  (record rather than skip) that is defensible — the invocation happened,
  even if the name is empty — but worth noting for downstream slices that
  may want to filter empty `skill_name` at query time.

### Privacy
- **Verified:** the privacy test ("does not leak arg text into any table")
  scans all TEXT/BLOB columns in `session_events`, `session_event_metadata`,
  `telemetry_meta`, `feedback`, and `sessions` for the secret arg string.
  Asserts zero matches. ✓ Only `args_chars` (byte length) + `args_hash`
  (sha256) are stored; `skill_name` is a kebab-case identifier, not arg
  text. Matches SPEC §1 "Not measured by default" and the arch-spec
  cross-cutting privacy decision.

### Return contract
- **Verified:** the handler always returns `{action:"continue"}`. The
  `guard()` wrapper is inside the handler, and `return {action:"continue"}`
  is outside `guard()` (after it) — so even if the handler body throws
  (caught by `guard`), the return is still `{action:"continue"}`. ✓ Never
  blocks or transforms input. Matches arch-spec "Return: `{action:'continue'}`"
  and SPEC §3 "telemetry must never break a session."

### Acceptance criteria check
- `/skill:foo bar baz` → row with `skill_name="foo"`, `args_chars=7`,
  `args_hash=sha256("bar baz")`, `input_source="interactive"` ✓ (test:
  "records a skill_invoke row for /skill:foo bar baz")
- RPC source → `input_source="rpc"` ✓ (test: "returns continue and records
  rpc source")
- Print mode → `input_source="interactive"` ✓ (test: "records print mode as
  interactive source")
- `source:"extension"` → no row ✓ (test: "skips extension source entirely")
- Non-skill input → no row ✓ (test: "ignores non-skill input")
- `/cmd` input → no row ✓ (test: "ignores /cmd input")
- Returns `{action:"continue"}` ✓ (asserted in multiple tests)
- Privacy: no arg text ✓ (test: "does not leak arg text into any table")
- No-args handling ✓ (test: "handles no args")
- Newlines in args ✓ (test: "handles args with newlines")
- Very long args ✓ (test: "handles very long args")
- Trailing space only ✓ (test: "handles /skill: prefix with trailing space
  only")
- Does not throw on malformed text ✓ (test: "does not throw on malformed
  text")
- `npm test` green (179/179), `tsc --noEmit` clean ✓

### Task doc update needed?
No. The implementation matches the arch spec and slice doc. The minor
edge-case decision (empty skill name records a row rather than skipping)
is defensible and not a spec violation; no task-doc amendment needed.

### User attention needed?
No. No scope change, no API surface deviation, no spec violation. The empty
skill name edge case is noted above for awareness but requires no decision.
