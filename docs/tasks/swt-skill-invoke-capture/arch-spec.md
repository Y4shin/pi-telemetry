# Architecture spec — swt-skill-invoke-capture

Task: `swt-skill-invoke-capture` (feature)
Map: `skill-workflow-telemetry`
Drafted: 2026-08-03. Lives at `docs/tasks/swt-skill-invoke-capture/arch-spec.md`
(stable, shared across all slice chains). Read this BEFORE the slice doc;
its amendments beat the slice docs where they conflict.

This feature records `/skill:<name>` invocations and their skills-package
version + skill-declared metadata, so metrics can be compared across
skills-package versions and skills. The schema approach is **Option D
(sparse EAV)** — decided by `swt-schema-prototype` (`results-eav.md`):
`session_events` keeps the raw JSON payload (source of truth);
`session_event_metadata` is the typed, queryable projection (one row per
key, CHECK-constrained). See `docs/tasks/swt-grill-decisions/task.md` for
the settled decisions and `docs/tasks/swt-research-seams/findings.md` for
the verified Pi event seams.

---

## Global design

### Two tables, one transaction

Every skill invocation produces:
1. one `session_events` row (`type='skill_invoke'`, JSON `payload`) — the
   unconstrained source of truth; and
2. N `session_event_metadata` rows (one per projected key) — the typed,
   queryable projection.

Both are enqueued into the **same buffer batch** (the existing
`Telemetry.enqueue()` → `createBuffer` flush path), so they commit in one
transaction. This preserves the `telemetry-write-resilience` invariant
(batched fast-path + per-statement fallback; `INSERT OR IGNORE` on natural
keys for replay idempotency). No new write path.

### The projection helper (single owner — slice 6)

Slice 6 exposes the **only** function that writes `session_event_metadata`
rows. All data slices (1–5) call it; none re-implement the projection.

```typescript
// src/capture/skill-metadata.ts  (new file)
export type MetadataType = "string" | "int" | "float" | "bool";

/**
 * Project one skill-invocation metadata key into session_event_metadata.
 * Enqueues an INSERT OR IGNORE (replay-idempotent on (event_id, key)) into
 * the same buffer as session_events writes. Maps the JS value to the typed
 * value_* column by `type`; the CHECK constraint guarantees integrity.
 * Best-effort: failures go to telemetry_meta, never throw.
 */
export function insertSkillMetadata(
  t: Telemetry,
  eventId: string,
  key: string,
  type: MetadataType,
  value: string | number | boolean | null,
): void;
```

Mapping: `string`→`value_text`, `int`→`value_int`, `float`→`value_real`,
`bool`→`value_bool`. `value=null` is a no-op (skip the row). The helper
builds the `INSERT OR IGNORE INTO session_event_metadata (event_id, key,
type, value_text, value_int, value_real, value_bool) VALUES (?,?,?,?,?,?,?)`
statement with the right column set and the rest null, satisfying the CHECK
constraint. Wrapped in `guard()` by the caller (or internally — see slice 6
acceptance; pick one and be consistent).

### The capture module (new file: `src/capture/skills.ts`)

Mirrors `src/capture/session-events.ts`. Exports:

```typescript
export function registerSkillCapture(pi: ExtensionAPI, t: Telemetry): void;
```

Registered in `index.ts` alongside the other `register*Capture` calls. Owns
the `input` handler (slice 1), version resolution (slice 2), frontmatter
reader (slice 3), the `telemetry_skill_context` tool (slice 4), and the
`turn_start` back-fill (slice 5). Slice 6 owns `skill-metadata.ts` (the
helper) + the migration; `skills.ts` imports from it.

### Event ordering (verified — findings doc §1)

```
input (raw /skill:foo bar, BEFORE expansion)   ← slice 1/2/3 capture here
  → _expandSkillCommand
  → before_agent_start
  → agent_start        (sets t.state.runId)     ← runId available from here
  → turn_start         (sets t.state.turnId)   ← slice 5 back-fills here
  → ... turn body, tool calls ...
  → turn_end
  → agent_end / agent_settled
```

At `input` time, `t.state.runId`/`turnId` are **null** (the run/turn hasn't
started). So the `skill_invoke` row is written with `run_id=null`, and
slice 5 back-fills `run_id`/`turn_id`/`turn_index` at `turn_start` (the
most-recent un-attributed `skill_invoke` row in the session). This is also
what makes the compare-versions join efficient (join on `run_id`, not
`session_id` — see findings §4 / `results-eav.md`).

**Path coverage:** `input` fires on TUI (`interactive`), RPC (`rpc`), and
print (`pi -p`) — all route through `session.prompt()` → `emitInput`. It
does NOT fire on mid-stream `steer()`/`followUp()` (accepted gap, map Fog).
Skip `source:"extension"` (programmatic injection, not a skill invocation).

---

## Per-slice interface contracts

### Slice 6 — `swt-queryability-schema` (lands FIRST)

**Exports:**
- `insertSkillMetadata(t, eventId, key, type, value)` in
  `src/capture/skill-metadata.ts`.
- A new `Migration` in `src/db.ts` `MIGRATIONS` (version 3 — version 2 is
  `flush_log`): creates `session_event_metadata` + `idx_sems_key_text` +
  `idx_sems_key_int` + `idx_turns_run`.

**Existing abstractions to use:**
- `src/db.ts` `MIGRATIONS` array + `PRAGMA user_version` gate (mirror
  migration 2).
- `Telemetry.enqueue()` for the helper's writes.

**Do NOT reimplement:**
- Do not duplicate the `session_events` DDL; the migration only ADDS the new
  table + indexes.
- Do not write a custom flush path; the helper enqueues into the existing
  buffer.

**Interface contract for dependents:** every data slice (1–5) imports
`insertSkillMetadata` and calls it to project a key. The helper's signature
(above) is the contract — do not change it without updating all callers.

**CHECK constraint** (exact text, verified in `bench-eav.mjs`):
```sql
CHECK (
     (type = 'string' AND value_text IS NOT NULL AND value_int IS NULL AND value_real IS NULL AND value_bool IS NULL)
  OR (type = 'int'    AND value_int  IS NOT NULL AND value_text IS NULL AND value_real IS NULL AND value_bool IS NULL)
  OR (type = 'float'  AND value_real IS NOT NULL AND value_text IS NULL AND value_int  IS NULL AND value_bool IS NULL)
  OR (type = 'bool'   AND value_bool IS NOT NULL AND value_text IS NULL AND value_int  IS NULL AND value_real IS NULL)
)
```

### Slice 1 — `swt-input-skill-invoke` (blocked_by 6)

**Exports:** `registerSkillCapture(pi, t)` in `src/capture/skills.ts` (this
slice creates the file + the `input` handler; later slices extend the same
function). The handler parses `/skill:<name> <args>` and writes:
- `session_events` row (`type='skill_invoke'`, payload with `skill_name`,
  `args_chars`, `args_hash`, `input_source`); and
- `session_event_metadata` row for `skill_name` (type `string`) via
  `insertSkillMetadata`.

**Existing abstractions to use:**
- `src/capture/session-events.ts` `insertEvent()` pattern (but this slice
  writes directly via `t.enqueue` since it also needs the `event_id` to pass
  to `insertSkillMetadata` — see contract note).
- `src/hash.ts` `sha256()`.
- `src/state.ts` `guard()`.

**Do NOT reimplement:** do not re-create the `insertEvent` helper; if you
need the event_id, generate it with `randomUUID()` and use it for both the
`session_events` insert and the metadata projection.

**Interface contract for dependents (slices 2,3,5):** the `input` handler
must expose the generated `event_id` of the most-recent `skill_invoke` row
so slice 5 can back-fill it and slice 4 can enrich it. Since the handler
runs in-process, store the most-recent `skill_invoke` event_id + session_id
on `t.state` (e.g. `t.state.lastSkillInvokeEventId` / a small map) OR look
it up by `session_id` + `type='skill_invoke'` + `run_id IS NULL` at
back-fill time. **Recommended:** store the most-recent event_id in
`RuntimeState` (add a field) — avoids a DB lookup and is robust to
back-to-back invocations. Slice 5 updates this row; slice 4 reads it.

**Return:** `{action:"continue"}` — NEVER block or transform input.

### Slice 2 — `swt-skills-package-version` (blocked_by 1)

**Exports:** extends `registerSkillCapture`; adds a lazy
`skillName → { source, version }` cache built from `pi.getCommands()`
(`source:"skill"` entries) + a `package.json` walk-up from
`sourceInfo.path`. Invalidated on `resources_discover`.

**Existing abstractions to use:**
- `src/version.ts` `getExtensionVersion()` walk pattern — generalize to an
  arbitrary start path (extract a `readPackageVersion(filePath)` helper, or
  inline; keep `getExtensionVersion` working).
- `pi.getCommands()` (ExtensionAPI) for the skill `sourceInfo`.

**Do NOT reimplement:** do not assume the skills-package path; resolve it
from `getCommands()` at runtime (verified — findings §2).

**Interface contract:** stamps `skill_source` + `skills_package_version`
into the `session_events` payload (UPDATE the row from slice 1, or include
them at insert time if slices compose — see note) AND projects
`skills_package_version` as a metadata row (type `string`). **Composition
note:** since slice 1 writes the row and slice 2 enriches it, either (a)
slice 1 writes a minimal row and 2/3 UPDATE it, or (b) slices 1+2 compose
in one handler before insert. **Recommended (a):** slice 1 writes the row;
2/3 issue `UPDATE session_events SET payload = json_set(payload, …)` or a
typed UPDATE. Keeps each slice's acceptance independently testable. The
arch spec does not mandate the JSON-update mechanism — the slice may use
`json_set` or rebuild the payload; pick what's testable.

### Slice 3 — `swt-frontmatter-metadata-reader` (blocked_by 1)

**Exports:** extends `registerSkillCapture`; re-reads the invoked skill's
SKILL.md from `sourceInfo.path`, parses YAML frontmatter, and if
`metadata.telemetry.capture` is present (comma/space-delimited list of arg
identifiers), extracts those values from the parsed args (positional or
named) and projects each as a typed metadata row via `insertSkillMetadata`.

**Existing abstractions to use:**
- `node:fs` `readFileSync` + a YAML parse. **Check first:** does the project
  already depend on a YAML parser? `src/version.ts` uses `node:fs` only.
  `skills/package.json` (the read-only target) uses `yaml` (npm), but
  **this repo's** `package.json` deps must be checked — if no YAML dep,
  parse the frontmatter with a minimal regex/`yaml` add. **Decision for the
  slice:** prefer reusing an existing parser; if none, a tiny frontmatter
  extractor (the `---\n…\n---` block + `yaml` package) is acceptable. Keep
  the privacy posture: only kebab-case slug identifiers; non-slug args →
  length/hash, never raw text.

**Do NOT reimplement:** the Agent Skills `metadata` field is the standard
seam (findings §3); do not invent a custom frontmatter key.

**Interface contract:** projects `target`/`map`/`slice`/etc. as metadata
rows (typed by value). Cache the parsed frontmatter alongside slice 2's
version cache; invalidate on `resources_discover`.

### Slice 4 — `swt-telemetry-skill-context-tool` (blocked_by 1, 5)

**Exports:** registers a `telemetry_skill_context` tool via
`pi.registerTool` (mirrors `src/feedback.ts`). The skill's prose (added by
the manual task) instructs the model to call it mid-run with dynamic
metadata (`slice_count`, outcome flags, `extra`). The tool merges its
params into the session's most-recent `skill_invoke` row (matched on
`session_id` + `run_id` + `turn_id` after slice 5's back-fill) AND projects
them as metadata rows.

**Existing abstractions to use:**
- `src/feedback.ts` `registerTool` + `validateAndSerialize` +
  `t.state.correlation()` — the tool + correlation pattern.
- `insertSkillMetadata` (slice 6) for projection.

**Do NOT reimplement:** do not build a second feedback table; this enriches
`session_events`/`session_event_metadata`, not `feedback`.

**Interface contract:** tool params `{ target?, map?, slice?, sliceCount?,
extra? }`. Attribution: match the most-recent `skill_invoke` row for the
current `session_id` whose `run_id` = `t.state.runId` and `turn_id` =
`t.state.turnId`. If none, record a `telemetry_meta` note and return
success (never break the agent). Privacy: non-slug `extra` values →
length/hash.

### Slice 5 — `swt-turn-start-backfill` (blocked_by 1)

**Exports:** extends `registerSkillCapture`; adds a `turn_start` handler
that sets `run_id`/`turn_id`/`turn_index` on the session's most-recent
un-attributed `skill_invoke` row (the one slice 1 wrote with `run_id=null`).
Also projects `run_id` as a metadata row (key `run_id`, type `string`) so
the compare-versions join reaches `turns`.

**Existing abstractions to use:**
- `t.state.runId` / `t.state.turnId` / `t.state.turnIndex` — set by
  `runs.ts`/`turns.ts` at `agent_start`/`turn_start` (verified — see
  `src/capture/runs.ts`, `turns.ts`). At `turn_start`, `runId` is already
  set (agent_start precedes turn_start).
- `insertSkillMetadata` (slice 6) to project `run_id`.

**Do NOT reimplement:** do not re-derive run/turn ids; read them from
`t.state`.

**Interface contract:** the back-fill is an `UPDATE session_events SET
run_id=?, turn_id=?, turn_index=? WHERE event_id=?` (using the event_id
stored by slice 1) + `insertSkillMetadata(t, eventId, "run_id", "string",
runId)`. Two `/skill:` inputs before one turn: only the most-recent is
back-filled (documented; the older stays null).

---

## Cross-cutting decisions

- **Privacy:** no arg text anywhere. `skill_name` (kebab-case identifier) is
  stored. `args` → length + sha256 hash only. Frontmatter-captured slugs
  (kebab-case) are stored; non-slug args → length/hash. `extra` non-slug
  values → length/hash. Mirrors SPEC §1 "Not measured by default."
- **Idempotency:** all inserts use `INSERT OR IGNORE` on natural keys
  (`session_events.event_id`, `session_event_metadata.(event_id,key)`).
- **Failure handling:** every handler wrapped in `guard()`; failures →
  `telemetry_meta`, never throw (SPEC §3).
- **Migration:** version 3 in `MIGRATIONS`, forward-only, idempotent (`CREATE
  TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`). Existing rows
  unaffected.
- **No new runtime deps.** Check `package.json` before adding a YAML parser;
  prefer zero-dep frontmatter extraction if possible (the `metadata` block
  is simple YAML; a 20-line parser may suffice, but `yaml` is already a
  transitive dep of the skills package — verify it's in THIS repo's
  `package.json` before relying on it).
- **Registration order in `index.ts`:** `registerSkillCapture` after the
  other captures; it listens on `input` (which fires before `agent_start`)
  and `turn_start` (which fires after `turns.ts`). Order among captures
  doesn't matter (handlers are independent), but keep it near
  `session-events.ts` for locality.

## Open questions for the arch-spec review (resolve with the user)

1. **Most-recent skill_invoke event_id storage.** APPROVED — spec
   recommendation: add a field to `RuntimeState`
   (`lastSkillInvokeEventId: string | null`), set by slice 1 at `input` time.
   Avoids a DB lookup at back-fill and is robust to back-to-back invocations.
2. **JSON payload enrichment mechanism** (slice 2/3). APPROVED — spec
   recommendation: slice 1 writes a minimal row; slices 2/3 issue `UPDATE`
   (`json_set` or rebuild-payload) so each slice is independently testable.
3. **YAML frontmatter parsing dep.** RESOLVED by check: `yaml` is NOT a
   dependency of this repo and `src/` has no YAML usage. Slice 3 must use a
   **minimal zero-dep frontmatter extractor** (the `metadata.telemetry.capture`
   value is a simple comma/space-delimited string; a ~20-line parser for the
   `---\n…\n---` block + the specific keys suffices). This preserves the SPEC
   zero-runtime-deps contract. Do NOT add `yaml` as a dependency.
4. **`insertSkillMetadata` guard ownership.** DECIDED — the helper wraps itself
   in `guard()`. It's a thin projection called from multiple capture sites;
   self-contained best-effort error handling (→ `telemetry_meta`, never
   throw) means callers can't forget to guard it. Consistent with the SPEC §3
   "telemetry must never break a session" posture.

**Arch spec APPROVED 2026-08-03.** User approved the spec + the recommended
answers to Q1/Q2; Q3 decided as above (helper-wraps). Proceeding to per-slice
TDD chains starting with slice 6 (schema-first).
