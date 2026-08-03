---
kind: task
type: feature
slug: swt-skill-invoke-capture
title: "Capture skill invocations: name + skills-package version + skill-declared metadata (frontmatter + tool)"
map: skill-workflow-telemetry
status: done
slices:
- swt-input-skill-invoke
- swt-skills-package-version
- swt-frontmatter-metadata-reader
- swt-telemetry-skill-context-tool
- swt-turn-start-backfill
- swt-queryability-schema
---

## User-visible outcome

After this feature, every `/skill:<name>` invocation (on TUI, RPC, and print
paths) is recorded in the telemetry DB as a `session_events` row of
`type='skill_invoke'`, carrying:

- the **skill name** and the **skills-package version** (e.g. `task-workflow`
  2.5.1) the skill was loaded from;
- **arg length + SHA-256 hash** (never arg text — v1 privacy posture);
- the **input source** (`interactive`/`rpc`/`extension`, skipping
  `extension`);
- **skill-declared metadata**: static fields from the skill's frontmatter
  `metadata.capture` keys (e.g. `target`/`map`/`slice` slugs), and dynamic
  fields attached mid-run via the new `telemetry_skill_context` tool (e.g.
  `slice_count`, outcome flags);
- the **run_id/turn_id/turn_index** of the turn the invocation started
  (back-filled at `turn_start`, since `input` fires before the turn).

A canned query can then group cost/tool-failures by skill and by
skills-package version (delivered in Feature B).

## User story

As a developer debugging my task-workflow skills, I run `/skill:implement-task
pi-telemetry` and later query telemetry to see "that invocation of
implement-task (from task-workflow v2.5.1) cost $X, ran N turns, had Y tool
errors, and targeted the pi-telemetry task" — and compare it to an invocation
under v2.4.0.

## Scope boundaries

- **In:** the `input` capture handler, version resolution, frontmatter
  `metadata.capture` reader, the `telemetry_skill_context` tool, the
  `turn_start` back-fill, and the queryability schema slice (**Option D: sparse
  EAV `session_event_metadata` table + CHECK constraint + indexes**, per the
  `swt-schema-prototype` EAV-extension result). The capture handler projects
  declared keys into `session_event_metadata` rows in the same buffered
  transaction as the `session_events` JSON payload insert.
- **Out (this feature):** the canned compare-versions *queries* (Feature B),
  the skills-package SKILL.md edits (manual task), run-level lineage (Fog),
  mid-stream `steer`/`followUp` capture (Fog — accepted gap), content capture
  of arg text (privacy posture).

## Acceptance criteria

- A `/skill:<name> <args>` typed in TUI produces one `skill_invoke` row with the
  correct `skill_name`, `skills_package_version`, `args_chars`, `args_hash`,
  and `input_source`.
- The same holds for RPC (`source:"rpc"`) and print (`pi -p`) paths.
- `source:"extension"` inputs do NOT produce a `skill_invoke` row.
- A skill with no enclosing `package.json` produces a row with
  `skills_package_version: null` (no crash).
- A skill whose SKILL.md has `metadata.capture: [target, map]` produces a row
  with those fields populated from the parsed args (when present); a skill
  without that key leaves them null.
- The `telemetry_skill_context` tool, when called mid-run, attaches its params
  to the session's current/most-recent `skill_invoke` row (run/turn-attributed).
- `turn_start` back-fills `run_id`/`turn_id`/`turn_index` on the session's
  most-recent un-attributed `skill_invoke` row.
- The capture handler returns `{action:"continue"}` (or nothing) — it never
  blocks or transforms input (telemetry must never break a session).
- Privacy test: no arg text appears in any table; only lengths + hashes.
- The queryability schema slice (Option D: sparse EAV `session_event_metadata`
  + CHECK constraint + indexes) is applied via a `user_version` migration and
  the compare-versions query uses an index (`EXPLAIN QUERY PLAN` shows
  `USING INDEX`, not a full scan).
- Every capture slice that records a skill-invocation field projects that field
  into a `session_event_metadata` row (one row per key, typed) in the same
  buffered transaction as the `session_events` JSON insert.
- `npm test` green, `tsc --noEmit` clean.

## Existing abstractions to use

- `src/capture/session-events.ts` `insertEvent()` — the generic-event insert
  pattern; mirror it for `type='skill_invoke'`.
- `src/version.ts` `getExtensionVersion()` — the `package.json` walk pattern;
  generalize for an arbitrary skill path.
- `src/feedback.ts` `registerTool` + `t.state.correlation()` — the tool +
  correlation pattern for `telemetry_skill_context`.
- `src/state.ts` `guard()` — wrap all handler bodies.
- `src/db.ts` migrations — `PRAGMA user_version` for the schema slice.

## Architecture / domain decisions

- **Option D (sparse EAV)** is the queryability approach (prototype EAV
  extension, `results-eav.md`). `session_events` JSON payload is the source of
  truth; `session_event_metadata(event_id, key, type, value_text/int/real/bool,
  PK(event_id,key), CHECK(…))` is the typed, queryable projection. New keys are
  rows, never a migration.
- **Schema-first slicing.** Slice 6 (`swt-queryability-schema`) lands FIRST and
  exposes a shared `insertSkillMetadata(eventId, key, type, value)` helper
  (in `src/capture/skills.ts` or a small `src/capture/skill-metadata.ts`). The
  data slices (1–5) call it; they do not each re-implement the projection. This
  keeps the projection concern in one place and makes every data slice
  independently verifiable (it can assert a `session_event_metadata` row exists).
- **Projection writes join the same buffered batch** as the `session_events`
  insert (one transaction), preserving the `telemetry-write-resilience`
  invariant (batched fast-path + per-statement fallback; `INSERT OR IGNORE` on
  `(event_id, key)` PK for replay idempotency).
- Version is a property of the **invocation**, not the session (a session can
  invoke skills from different packages).
- See `docs/tasks/swt-research-seams/findings.md` for the verified seams and
  `docs/tasks/swt-grill-decisions/task.md` for the settled decisions.

## Architecture notes

Arch spec drafted and **APPROVED 2026-08-03** at
`docs/tasks/swt-skill-invoke-capture/arch-spec.md`. Open questions resolved:
Q1 (state field) + Q2 (UPDATE enrichment) approved per spec recommendation;
Q3 (`insertSkillMetadata` wraps itself in `guard()`) decided; Q4 (zero-dep
frontmatter extractor, `yaml` not a repo dep) resolved by check. Slice order is
schema-first: [6] → [1] → [2,3,5] → [4].

## Slice list

Slices are tracer-bullet verticals; each is independently verifiable. **Slice 6
(schema + projection helper) lands FIRST** — it is unblocked (prototype done)
and the data slices depend on its helper to project metadata rows. Slices 1–5
then build on it; within that group, slice 1 (input handler) is the base, and
2/3/4/5 add fields/tools that call the same helper. Slice 4 also depends on
slice 5 (turn/turn attribution for the tool).

6. `swt-queryability-schema` (m) — **lands first.** Create
   `session_event_metadata` (1 table, typed value cols + CHECK constraint) +
   indexes via a `user_version` migration; expose a shared
   `insertSkillMetadata(eventId, key, type, value)` helper; verify `EXPLAIN
   QUERY PLAN` uses an index for the pivot compare-versions query.
1. `swt-input-skill-invoke` (s, blocked_by swt-queryability-schema) — `input`
   handler → `skill_invoke` `session_events` row (name + args length/hash +
   source) AND a `session_event_metadata` row for `skill_name` (via the helper);
   privacy test, skip `extension`, return `continue`.
2. `swt-skills-package-version` (m, blocked_by swt-input-skill-invoke) —
   `getCommands()` + walk-up `package.json` + cache invalidated on
   `resources_discover`; stamp `skill_source` + `skills_package_version` into
   the payload AND project `skills_package_version` as a metadata row.
3. `swt-frontmatter-metadata-reader` (m, blocked_by swt-input-skill-invoke) —
   re-read SKILL.md from `sourceInfo.path`, parse `metadata.capture`, extract
   named/positional slugs from args; project each captured key (e.g.
   `target`/`map`/`slice`) as a typed metadata row.
4. `swt-telemetry-skill-context-tool` (m, blocked_by swt-input-skill-invoke,
   swt-turn-start-backfill) — register the tool, attribute to current run/turn,
   merge its params into the session's most-recent `skill_invoke` payload AND
   project them as metadata rows.
5. `swt-turn-start-backfill` (s, blocked_by swt-input-skill-invoke) — set
   `run_id`/`turn_id`/`turn_index` on the session's most-recent un-attributed
   `skill_invoke` row at `turn_start`; also project `run_id` as a metadata row
   (key=`run_id`, type=`string`) so the compare-versions join reaches `turns`.

## Implementation notes

### Slice 6: swt-queryability-schema (landed)

- Added migration version 3 in `src/db.ts` creating `session_event_metadata`
  (sparse EAV with the exact CHECK constraint from `bench-eav.mjs`) plus
  `idx_sems_key_text`, `idx_sems_key_int`, and `idx_turns_run`.
- Added `src/capture/skill-metadata.ts` exporting
  `insertSkillMetadata(t, eventId, key, type, value)` — self-guarded, enqueues
  `INSERT OR IGNORE` into the same buffer as `session_events`, maps JS values
  to typed `value_*` columns, and skips `null` (and `undefined`).
- Re-exported `insertSkillMetadata` and `MetadataType` from
  `src/capture/index.ts` (barrel) for dependent slices.
- Updated `test/db.test.ts` and `test/ddl-first-start.test.ts` to use
  `MIGRATIONS.length` instead of hardcoded schema-version assertions;
  added a v2→v3 migration test with row-preservation check.
- Tests: 16 new cases in `test/capture/skill-metadata.test.ts` covering all
  four types, null handling, replay idempotency, type-mismatch, self-guarding,
  CHECK-constraint rejection, and `EXPLAIN QUERY PLAN` index usage.
- All 164 tests pass; `tsc --noEmit` clean. Migration is additive and
  idempotent; existing `session_events` rows are unaffected.
- Minor defensive additions beyond spec: `undefined` skip, `Number.isNaN`
  guard for float, exhaustiveness `default` case — strengthen robustness
  without changing the contract.

### Slice 1: swt-input-skill-invoke (landed)

- Added `lastSkillInvokeEventId: string | null` to `RuntimeState` in
  `src/state.ts` (initialized `null` in `createRuntimeState`) per arch-spec
  Q1 decision; stores the generated `event_id` for downstream slices to
  enrich/back-fill.
- Created `src/capture/skills.ts` exporting `registerSkillCapture(pi, t)`,
  which registers a `pi.on("input", …)` handler that detects `/skill:<name>`
  prefixed input, skips `source:"extension"`, and writes one `session_events`
  row of `type='skill_invoke'` (JSON payload: `skill_name`, `args_chars`,
  `args_hash`, `input_source`) plus one `session_event_metadata` row
  projecting `skill_name` (type=`string`) via the slice-6 `insertSkillMetadata`
  helper.
- The `event_id` is generated via `randomUUID()` and shared between the
  `session_events` insert and the metadata projection; `INSERT OR IGNORE` on
  `session_events.event_id` provides replay idempotency.
- Privacy: stores only `args_chars` (byte-length via shared `textLength`
  helper) + `args_hash` (sha256 via shared `sha256` helper), never arg text.
  `skill_name` is a kebab-case identifier.
- Handler body wrapped in `guard()`; `return {action:"continue"}` is outside
  the guard, so it is returned even if the body throws — input is never
  blocked or transformed.
- Registered `registerSkillCapture` in `index.ts` (after
  `registerSessionEventsCapture`, before `registerFeedback`) and re-exported
  from `src/capture/index.ts` (barrel, additive).
- Tests: 15 new cases in `test/capture/skills.test.ts` covering basic
  `/skill:foo bar baz` row, rpc/interactive/extension sources, non-skill and
  `/cmd` skipping, no-args, newlines, very long args, trailing-space-only,
  malformed text, and a privacy test scanning all TEXT/BLOB columns across
  5 tables for the secret arg string (zero matches).
- All 179 tests pass across 29 suites; `tsc --noEmit` clean.
- Notable: `/skill:` with empty skill name records a row with `skill_name=""`
  (slice doc lists it as a failure mode but does not mandate skipping;
  defensible — the invocation happened; downstream query filtering can
  exclude empty names).

### Slice 2: swt-skills-package-version (landed)

- Added `resolvePackageInfo(startPath)` to `src/version.ts` that walks up from
  any path to the nearest `package.json` returning `{ name, version }` or nulls;
  refactored `getExtensionVersion()` to reuse the new helper.
- Extended `registerSkillCapture` in `src/capture/skills.ts` to resolve the
  invoked skill's package name and version at `input` time: builds a lazy
  `skillName → { skillSource, packageVersion }` cache from `pi.getCommands()`
  (`source:"skill"` entries) + `resolvePackageInfo(sourceInfo.path)`, stamps
  `skill_source` and `skills_package_version` into the `skill_invoke` payload
  via `UPDATE session_events SET payload = json_set(...)` using `json_quote(?)`
  (so null values become JSON nulls and sibling keys are preserved for
  downstream slices), and projects `skills_package_version` as a metadata row
  via `insertSkillMetadata`.
- Cache is invalidated on `resources_discover` (both `"reload"` and
  `"startup"` reasons — wider than the slice doc's `"reload"`-only, but more
  conservative; harmless).
- Added `resetSkillVersionCache()` export for test isolation.
- `skill_source` is populated from `package.json`'s `name` field (per slice
  acceptance criterion), not from `sourceInfo.source`.
- `ResourcesDiscoverEvent`/`ResourcesDiscoverResult` are not re-exported from
  the `@earendil-works/pi-coding-agent` entry point; used small local structural
  copies (noted in a comment).
- Tests: 7 new cases in `test/capture/skills.test.ts` under a `skills package
  version` sub-suite (package-stamped, no-package nulls, no-version null,
  unreadable package.json, deeply nested path, cache reuse, cache invalidation
  on reload).
- All 186 tests pass across 30 suites; `tsc --noEmit` clean.

### Slice 3: swt-frontmatter-metadata-reader (landed)

- Extended `registerSkillCapture` in `src/capture/skills.ts` to read each
  invoked skill's `SKILL.md` from `sourceInfo.path`, extract
  `metadata.telemetry.capture` from YAML frontmatter using a zero-dependency
  parser, and project the captured slugs as typed `session_event_metadata`
  rows via the existing `insertSkillMetadata` helper.
- Implemented a minimal `---\n…\n---` frontmatter extractor with no YAML
  runtime dependency (preserves the zero-runtime-deps contract, per Q3).
  Capture-list parsing handles `metadata.telemetry.capture` in nested-map,
  inline dotted-key, or YAML-array form (comma/space-delimited).
- Arg extraction supports positional and named forms (`--key=value`,
  `-key=value`, `key=value`, `--key value`).
- Kebab-case slug validation: only clean slugs are stored as metadata
  values and JSON payload fields; non-slug/missing values become explicit
  JSON `null` and produce no metadata row. The existing slice-1
  `args_chars`/`args_hash` already covers the raw arg fingerprint, so the
  spec's length/hash fallback for non-slug values was simplified to a
  `null` payload field (no privacy regression).
- Frontmatter cache stored alongside the existing skill-version cache and
  invalidated on `resources_discover`.
- Best-effort error handling: malformed frontmatter (e.g. missing closing
  `---`) is logged to `telemetry_meta` and does not throw.
- Tests: 8 new cases in `test/capture/skills.test.ts` under a `frontmatter
  metadata capture` sub-suite (positional capture, multi-key positional,
  no-capture-key null fields, missing frontmatter, malformed frontmatter,
  non-slug arg → null + no metadata row, cache invalidation, nested-map
  capture form).
- All 194 tests pass across 31 suites; `tsc --noEmit` clean.
- Divergences (noted for coherence-refactor review): (1) non-slug captured
  values stored as JSON `null` + no metadata row instead of length/hash;
  (2) metadata key uses the capture identifier itself (e.g. `target` →
  key `target`), matching the general rule over the slice-doc example;
  (3) named-arg syntax implemented but only positional capture is tested.

### Slice 5: swt-turn-start-backfill (landed)

- Added a `turn_start` handler in `registerSkillCapture` (`src/capture/skills.ts`)
  that reads `t.state.runId`/`turnId`/`turnIndex`/`lastSkillInvokeEventId` and,
  when a prior `skill_invoke` event exists, issues
  `UPDATE session_events SET run_id=?, turn_id=?, turn_index=? WHERE event_id=?`
  to attribute the invocation to the turn it started. The precise `event_id`
  (stored by slice 1 in `t.state.lastSkillInvokeEventId`) is used, so the
  slice-doc's `ORDER BY unix_ms DESC LIMIT 1` form was not needed.
- Projects `run_id` as a typed `session_event_metadata` row (key=`run_id`,
  type=`string`) via `insertSkillMetadata`, so the compare-versions EAV join
  can reach `turns`.
- `lastSkillInvokeEventId` is intentionally left set after back-fill (consistent
  with the task description; a future slice may clear it).
- **Migration version 4** added in `src/db.ts`: `session_events` lacked the
  `run_id`/`turn_id`/`turn_index` columns the arch spec assumed. Added them
  (plus supporting indexes) via a new forward-only, idempotent migration using
  a conditional `addColumnIfMissing` helper (PRAGMA table_info check + benign
  "duplicate column name" race tolerance). This was required to keep
  `test/ddl-first-start.test.ts` green under 5 concurrent first-starts (raw
  `ALTER TABLE ADD COLUMN` is not concurrent-safe).
- **`Migration.apply` extension:** added an optional `apply(db) => void` field
  to the `Migration` interface so migration 4 can perform conditional,
  idempotent DDL beyond the statement-array form.
- Tests: 4 new cases in `test/capture/skills.test.ts` (attribute most-recent
  skill_invoke; no-op when no skill input preceded the turn; back-fill only
  the most-recent of two skill inputs; no-op with no active session), plus
  `test/db.test.ts` updated to assert `MIGRATIONS.length`.
- All 198 tests pass across 32 suites; `tsc --noEmit` clean.
- Divergence (noted for coherence-refactor review): the schema addition
  (migration 4) and the `Migration.apply` mechanism are necessary planning
  gaps — the arch spec should have specified them. Both are SPEC §8 compliant
  (nullable columns, forward-only, idempotent).

### Slice 4: swt-telemetry-skill-context-tool (landed)

- Registered the `telemetry_skill_context` tool inside `registerSkillCapture`
  (`src/capture/skills.ts`) via `pi.registerTool` (mirrors `src/feedback.ts`
  `registerTool` + `t.state.correlation()`). Tool params exactly
  `{ target?, map?, slice?, sliceCount?(Integer), extra?(Record<String,Unknown>) }`;
  returns `{content:[{type:"text",text:"Recorded."}], details:{}}`.
- Attribution: uses `t.state.lastSkillInvokeEventId` (set by slice 1, back-filled
  by slice 5) as the primary key instead of a DB lookup for the most-recent
  `skill_invoke` row, because telemetry writes are buffered and the matching row
  may not yet be flushed to SQLite when the tool runs mid-turn. The `UPDATE` is
  strengthened with `WHERE event_id = ? AND run_id = ? AND turn_id = ?` to
  preserve the spec's matching semantics within the existing buffered-write
  design.
- Enrichment: merges its params into the current `skill_invoke` row's JSON
  payload via `UPDATE session_events SET payload = json_set(payload, '$.key',
  json(?))` using a `jsonLiteral()` helper so SQLite parses the literal and
  preserves numeric/boolean JSON types (initial `json_set(payload, '$.key', ?)`
  stored numbers/booleans as JSON strings). Projects the same fields as typed
  `session_event_metadata` rows via `insertSkillMetadata`.
- Privacy fallback: the slice doc requires length/hash for non-slug `extra`
  values; the implementation also applies the same `isKebabSlug` → length/hash
  fallback to the top-level string params `target`, `map`, and `slice` when they
  are not clean kebab-case slugs (defensive extension consistent with the
  feature-wide privacy posture of never storing arbitrary raw text).
- No-match handling: when no `skill_invoke` row exists (no prior skill input, or
  called outside a turn), the tool records a `telemetry_meta` note and still
  returns success (never breaks the agent).
- First test run failed with `SyntaxError: Identifier 'isKebabSlug' has already
  been declared` because the existing skills.ts already defined the helper
  (from slice 3); removed the duplicate declaration.
- Tests: 9 new cases in `test/capture/skills.test.ts` under a
  `telemetry_skill_context tool` sub-suite (success-neutral result; enriches
  current skill_invoke row + projects metadata; meta note when no skill_invoke
  preceded the turn; meta note when called outside a turn; merges multiple
  enrichments on the same row; hashes non-slug extra string values; hashes
  non-slug target/map/slice values; meta note for unserializable extra values;
  does not throw when no session is active).
- All 207 tests pass across 32 suites; `tsc --noEmit` clean.
- Divergences (noted for coherence-refactor review): (1) attribution via
  `lastSkillInvokeEventId` instead of DB lookup (justified by buffered-write
  design, consistent with arch-spec Q1 decision); (2) privacy fallback extended
  to top-level string params (defensive, tested); (3) `json(?)` + `jsonLiteral()`
  type-preservation pattern coexists with slices 2/3's `json_quote(?)` pattern —
  both correct for their contexts, should be reviewed for consistency during
  the coherence refactor.
