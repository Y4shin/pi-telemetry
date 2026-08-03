---
kind: task
type: feature
slug: swt-skill-invoke-capture
title: "Capture skill invocations: name + skills-package version + skill-declared metadata (frontmatter + tool)"
map: skill-workflow-telemetry
status: ready
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
