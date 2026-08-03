---
kind: task
type: prototype
slug: swt-schema-prototype
title: "Prototype: generated columns vs N:1 join table for querying skill_invoke session_events — queryable + performant?"
map: skill-workflow-telemetry
status: done
blocked_by: []
slices: []
---

## Single design/behavior question

For `session_events` rows of `type='skill_invoke'` carrying a JSON `payload`
(`skill_name`, `skills_package_version`, `target`, `map`, `slice`, plus
dynamic `extra`), which metadata-queryability approach is both **queryable**
(supports the compare-versions-and-skills query naturally) and **performant**
at realistic volume under the real `node:sqlite` `DatabaseSync` engine — with
**no Pi / no LLM / no extension involvement** (pure DB benchmark):

- **Option A — generated VIRTUAL columns + indexes on `session_events`.**
  `ALTER TABLE session_events ADD COLUMN skill_name_gen TEXT GENERATED ALWAYS
  AS (json_extract(payload,'$.skill_name')) VIRTUAL;` repeated for
  `skills_package_version`, `target`; `CREATE INDEX` on each. JSON stays the
  source of truth; generated cols are queryable + index-backed.
- **Option B — an N:1 `session_event_metadata` join table.** Native columns
  (`event_id` PK/FK → `session_events.event_id`, `skill_name`,
  `skills_package_version`, `target`, …), join on `event_id`. No JSON parsing
  at query time; index the native columns.

## Alternatives worth comparing

- A vs B as above (primary comparison).
- Within A: VIRTUAL vs STORED generated columns — note that STORED cannot be
  `ALTER`-added to an existing table (verified), so VIRTUAL is the only
  add-to-existing-table path; record whether STORED-on-create is meaningfully
  faster for reads.
- Within B: one-row-per-event (N:1) vs a wider denormalized table that
  duplicates session/run/turn columns for direct aggregation without joins.
- Baseline: bare `json_extract` with no generated column / no join, just to
  quantify the cost the optimizations are rescuing.

## Smallest artifact that can answer it

A throwaway Node script (no test framework, no Pi imports) at
`docs/tasks/swt-schema-prototype/bench.mjs` that, on a **temporary**
`:memory:` or temp-file DB (NEVER the live `~/.pi/telemetry.db`):

1. Creates the real `session_events` schema (copy `src/db.ts` DDL) plus the
   companion `sessions`/`turns`/`tool_executions` tables needed for the
   compare-versions join.
2. Populates N synthetic `skill_invoke` rows (N = 1k, 10k, 100k) across ~5
   skill names, ~3 package versions, ~20 targets, each attached to synthetic
   sessions/turns/tools so the compare-versions query has real joins.
3. For each approach (A, B, baseline json_extract), runs the compare-versions
   query (cost + tool-error count grouped by `skills_package_version` +
   `skill_name`, joining `session_events`→`turns`→`tool_executions`) and
   records:
   - correctness: does it return the expected grouped rows?
   - `EXPLAIN QUERY PLAN` (does it use an index or full-scan?);
   - timing (median over ~50 runs, warmed up).
4. Writes a short results table to stdout and to
   `docs/tasks/swt-schema-prototype/results.md`: approach × N × (plan, ms).

The script must be delete-safe: it creates its own temp DB and never touches
`~/.pi/telemetry.db` (open with `:memory:` or a temp path under
`/tmp`/`os.tmpdir()`).

## Who must react to the result

The user, in the `swt-grill-decisions` grilling task (decision 3), picks A or
B (or a hybrid) from the numbers. The prototype does not decide.

## Decision or implementation tasks it should unblock

- Closes grilling decision 3 (schema queryability approach).
- Unblocks the generated-column/index slice of Feature A
  (`swt-skill-invoke-capture`): if A wins, that slice adds generated columns +
  indexes via a `user_version` migration; if B wins, that slice creates the
  `session_event_metadata` table + a trigger/handler to populate it.
- Does NOT block the capture-handler slice (writes the JSON row regardless) or
  Features B/C.

## Constraints

- **No Pi, no LLM, no extension code.** Pure `node:sqlite` benchmark.
- **Never touch the live DB.** Temp/`:memory:` only.
- **Throwaway.** Production implementation belongs in the feature task, not
  here. The script and results doc are the artifact.
- Realistic but synthetic data; document the data shape in results.md so the
  user can sanity-check the volume assumptions.
