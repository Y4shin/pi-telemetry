## Deviation report — analyze

Slice `analyze` (telemetry-eval-skills). Branch
`slice/telemetry-eval-skills-analyze`. Compared against
`docs/tasks/telemetry-eval-skills/arch-spec.md` (Slice 2) and
`docs/tasks/telemetry-eval-skills/slices/2-analyze.md`. Schema cross-checked
against `src/db.ts`.

**Diff:** exactly 3 new files under `skills/telemetry-eval-analyze/`
(284 insertions, 0 deletions; no other dirs touched; no setup-skill or TS
files modified — verified via `git diff --name-only task/telemetry-eval-skills..HEAD`).

```
skills/telemetry-eval-analyze/SKILL.md                                   | 93 +
skills/telemetry-eval-analyze/resources/schema.md                        | 151 +
skills/telemetry-eval-analyze/resources/scripts/example_cost_by_model.py | 40 +
```

### API surface changes
- **Planned (arch-spec Slice 2 contract):**
  - `SKILL.md` — preflight (stop + point to `/skill:telemetry-eval-setup` if
    project missing; do not create it); `from telemetry_eval import connect,
    duck`; canonical `pd.read_sql_query(sql, con=connect())`;
    `follow resource "resources/schema.md"`; script layout;
    `uv run python scripts/<name>.py`.
  - `resources/schema.md` — 10-table primer + join map + `unix_ms` convention.
  - `resources/scripts/example_cost_by_model.py` — groups `turns` by `model`,
    sums `cost_total_usd` (read-only via `connect()`), non-empty DataFrame
    sorted by cost desc.
- **Actual:** all three files conform to the contract. The example script uses
  `from telemetry_eval import connect` + `pd.read_sql_query(SQL, con=connect())`;
  no `sqlite3` import; no hand-rolled URI/path (verified: `grep` finds no
  `sqlite3`/`mode=ro`/`telemetry.db` literal in the script). The SKILL.md
  preflight stops and points to `/skill:telemetry-eval-setup` and explicitly
  says to not create the project. `schema.md` covers all 10 tables with correct
  column names.
- **Impact:** none. This slice consumes the setup slice's
  `telemetry_eval.connect()`; the sanctioned global→project DB-path precedence
  lives in the setup slice, not here (not re-flagged per instructions).

### Abstraction usage
- **Used what was specified: yes.** `from telemetry_eval import connect`
  (`duck` is documented in SKILL.md's DuckDB section too); canonical
  `pd.read_sql_query(sql, con=connect())`. No path/URI/`sqlite3.connect`
  hand-rolling in the example script. Schema is delegated to
  `resources/schema.md` (not hardcoded in the script). ✓
- **Read-only enforcement:** the example opens the live DB only via
  `connect()` (read-only). No bare `sqlite3.connect`. ✓
- **DuckDB pattern:** SKILL.md documents `duck()` +
  `con.execute(...).fetchdf()` as the DuckDB alternative (bonus; consistent
  with the arch-spec `duck()` contract, not required by this slice). ✓

### Out-of-scope changes
- **File set:** none out of scope — exactly the three files the slice lists;
  no TS source, no setup-skill files modified (diff confirms only
  `skills/telemetry-eval-analyze/` paths), no `docs/tasks` edits.
- **In-file additions (in scope, not deviations):**
  - SKILL.md adds a "NixOS note" (`LD_LIBRARY_PATH`→nix-ld for compiled-wheel
    imports) and a "Read-only discipline" section. Both are consistent with the
    setup slice's NixOS note and the arch-spec's read-only-always rule; not new
    scope.
  - SKILL.md references `telemetry_eval.scratch()` for derived writes —
    extends read-only discipline; consistent with the setup package's
    `scratch()` contract.

### Schema primer completeness (cross-checked against `src/db.ts`)

All 10 tables documented with PK, FK/join keys, key columns, timestamps, and
indexes; **every column name matches `src/db.ts` exactly** (verified
column-by-column). The arch-spec corrections are correctly applied:

| Check | schema.md | src/db.ts | Match |
|---|---|---|---|
| `llm_requests.retry_after_ms` (not `retry_after`) | `retry_after_ms` | `retry_after_ms` | ✓ |
| `turns.started_unix_ms` + `duration_ms` | present | present | ✓ |
| `session_events.unix_ms` | `unix_ms` | `unix_ms` | ✓ |
| `feedback.received_unix_ms` | `received_unix_ms` | `received_unix_ms` | ✓ |
| `flush_log` `unix_ms`+`row_count`+`tx_duration_ms` | all present | all present | ✓ |

Column counts per table (schema.md vs db.ts): sessions 13/13, agent_runs 8/8,
turns 21/21, llm_requests 18/18, tool_executions 14/14, bash_executions 12/12,
session_events 5/5, feedback 8/8, telemetry_meta 6/6, flush_log 5/5 — all
complete. Indexes documented match db.ts (idx_turns_session/model,
idx_llm_session/model, idx_tool_session/name, idx_sev_session,
idx_feedback_kind/source/time); tables without indexes in db.ts (bash_executions,
telemetry_meta, flush_log) claim none.

Join map matches the slice doc (sessions 1—* agent_runs 1—* turns 1—*
llm_requests; turns 1—* tool_executions; sessions 1—* bash_executions /
session_events / feedback). The worked example provides the full
`sessions→agent_runs→turns→llm_requests` JOIN SQL + pandas load, so "a reader
can write a JOIN across sessions→agent_runs→turns→llm_requests from it alone" is
satisfied. The `unix_ms` (INTEGER ms) convention is documented up front with a
`pd.to_datetime(..., unit='ms')` conversion tip.

**No wrong or missing columns found.**

### Example script findings

`resources/scripts/example_cost_by_model.py`:
- `GROUP BY model` ✓; `SUM(cost_total_usd) AS cost_total_usd` ✓;
  `ORDER BY cost_total_usd DESC` ✓.
- Uses `connect()` (read-only); no `sqlite3`; no hardcoded DB path (delegates
  to `resolve_db_path()` via `connect()`). ✓
- Empty-DB edge case handled: `if df.empty: print(...); return 0` — exits 0, no
  crash. ✓ (code path correct; not exercised against an actually-empty DB.)
- Verified non-empty against the live DB (TDD: 5 rows incl. a `NaN` model
  group). ✓

**MINOR observation (NON-BLOCKING, severity low):** the script sums
`input_tokens`, `output_tokens`, `total_tokens` but **omits
`cache_read_tokens` and `cache_write_tokens`**. The slice doc / arch-spec say
the example should "sum `cost_total_usd` and token buckets." The `turns` table
has 5 token columns; the example covers 3. The acceptance criteria (which bind
only on `cost_total_usd`, non-empty, read-only, empty-DB handling) are still met
— this is a completeness nicety vs the scope's "and token buckets" phrasing,
not a failed criterion. **Optional:** add the two cache buckets to the SUM
(2-line SQL change) during the coherence step.

### Divergence from the slice doc's acceptance criteria
- ✅ Project-present path: the example script imports `telemetry_eval` and
  returns a non-empty DataFrame from the live DB; runs clean via
  `uv run python scripts/example_cost_by_model.py` (NixOS: needs
  `LD_LIBRARY_PATH`, documented in SKILL.md).
- ✅ Read-only: uses `connect()`, not a bare `sqlite3.connect`.
- ✅ Project-absent preflight: SKILL.md stops and points to
  `/skill:telemetry-eval-setup`; does not create the project.
- ✅ Schema primer: all 10 tables, join keys, `unix_ms` convention; a JOIN
  across sessions→agent_runs→turns→llm_requests is derivable from it alone
  (worked example provided).

**All four acceptance criteria satisfied. No unsanctioned deviations.** (The
sanctioned global→project DB-path precedence belongs to the setup slice and is
not re-flagged here.)

### Task doc update needed?
**No** (mandatory). Optional: if the parent applies the minor
cache-token-bucket fix during coherence, append a one-line note to
`## Implementation notes` that `example_cost_by_model.py` now sums all 5 token
buckets. Not required otherwise.

### User attention needed?
**No.** No scope change; no API-surface change; all acceptance criteria met.
The only finding is a low-severity completeness observation on the example
script's token-bucket coverage.
