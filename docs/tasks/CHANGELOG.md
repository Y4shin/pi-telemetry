# Task Changelog

## 2026-08-03 — Skill invocation capture (swt-skill-invoke-capture)

Feature A of the skill-workflow-telemetry map. Records `/skill:<name>`
invocations (the `input` event seam, TUI/RPC/print) with skill name + args
length/hash, the skills-package version (resolved via `getCommands()` +
`package.json` walk), and skill-declared metadata (frontmatter
`metadata.capture` keys + a `telemetry_skill_context` tool for dynamic
mid-run enrichment). Schema = Option D sparse EAV: `session_event_metadata`
(table + CHECK constraint, migration v3) is the typed queryable projection;
`session_events` keeps the JSON payload as source of truth. `turn_start`
back-fills `run_id`/`turn_id`/`turn_index` (native cols, migration v4) for the
compare-versions join. 6 slices schema-first (`[6]→[1]→[2,3,5]→[4]`); 207
tests green (was 147, +60), tsc clean. Zero new runtime deps (zero-dep
frontmatter extractor). No UI work.

## 2026-08-03 — Deprecate bash_executions table (deprecate-bash-executions)

Removed all `bash_executions` write/read code usage: deleted `src/capture/bash.ts` and `test/bash.test.ts`, dropped the table from `export.ts`/`commands.ts`, and stripped every test reference (`duplicate-key-resilience`, `privacy`, `fixture-db`, `canned`, `commands`, `export` count 9→8). The table DDL and the dead `capture.bashCommand` flag are **kept** (backward compat for older in-flight extension versions) and marked deprecated in `src/db.ts`, `src/config.ts`, `SPEC.md`, the bug doc, and the analyze skill `schema.md`. Re-planned from 3 slices to 2 after the first tdd-worker found `tsconfig.json` includes `test/**/*.ts`, so src removals and test cleanups must land together. Suite 147/147 green, tsc clean.

### Map finalized: deprecate-bash-executions

Single-child map complete. Destination met: `bash_executions` is no longer used by any code; the table + `capture.bashCommand` are retained and deprecated. Follow-up (in map fog): physically drop the table and remove the flag once all running agents have upgraded.

## 2026-07-31 — Subagent parentage env-var fallback (subagent-parentage-not-recorded)

Fixed: `readLineageFromEnv` only read `PI_TELEMETRY_*` env vars, but pi-subagents sets `PI_SUBAGENT_*` on child processes. Added fallback reads so subagent sessions now stamp `parent_session_id`, `parent_run_id`, `depth`, `agent_label` from `PI_SUBAGENT_PARENT_SESSION` / `_PARENT_RUN_ID` / `_PARENT_DEPTH` / `_CHILD_AGENT`. Empty strings treated as absent (non-fanout children). Added `test/subagent-parentage.test.ts` (3 tests); updated lineage + capture test env cleanup to isolate `PI_SUBAGENT_*`. Suite 150→153 green, tsc clean. Bug closed + archived.

## 2026-07-31 — Telemetry write path resilience (telemetry-write-resilience)

Fixed two intertwined defects that caused total session telemetry loss: `src/buffer.ts` `flush()` re-enqueued the whole batch on any statement error, so one duplicate `tool_call_id` (PK UNIQUE) rolled back all unrelated rows and retried forever — 3 live sessions lost every row (only `telemetry_meta` survived). Fix: flush keeps the batched fast-path but falls back to per-statement application (log+drop offenders, no re-enqueue); all natural-key capture INSERTs switched to `INSERT OR IGNORE` for cross-process idempotency (replayed keys no-op). Added `test/duplicate-key-resilience.test.ts` (4 tests: regression, buffer isolation, session idempotency, INSERT-OR-IGNORE SQL audit). Suite 146→150 green, tsc clean. Bug `tool-executions-duplicate-insert` closed.

## 2026-07-31 — Telemetry eval skills: python project + DB analysis (telemetry-eval-skills)

Authored two coupled in-repo skills (`skills/telemetry-eval-setup/` and `skills/telemetry-eval-analyze/`; deploy later manually into the codeberg skills repo). Setup bootstraps a Python project at `~/.pi/telemetry-eval/` (uv → `pyproject.toml`+`uv.lock`, else `.venv`+`requirements.txt`; deps pandas/matplotlib/numpy/duckdb) with a `telemetry_eval` package — `connect()`/`duck()`/`scratch()`/`resolve_db_path()` enforcing read-only access (`file:...?mode=ro`; `ATTACH ... READ_ONLY`) and NixOS-safe interpreter selection (never `uv python install`; stable-system-python gate; nix-ld `LD_LIBRARY_PATH` for compiled wheels). Analyze embeds the 10-table schema primer (derived from `src/db.ts`, not the idea doc) and the canonical `pd.read_sql_query(sql, con=connect())` pattern, pointing to the setup skill when the project is missing. Outcome: the LLM and user can run reproducible read-only eval scripts against `~/.pi/telemetry.db` instead of ad-hoc one-liners. Verified on NixOS/Python 3.13 against the live DB (smoke_test + `example_cost_by_model` non-empty; npm 146/146; tsc clean). No TS touched.

## 2026-07-30 — pi-telemetry — Local-first observability for Pi workflows (pi-telemetry)

Built the full v1 Pi extension from scratch across 10 slices: SPEC §1 catalog captured into a shared `~/.pi/telemetry.db` (node:sqlite WAL, zero runtime deps) with buffered batch writes; `/tm` command surface with guarded read-only SQL and canned derived-metric queries; `query_telemetry` agent tool (7 presets); feedback collector (bus + `submit_feedback`); lineage foundation (env reader + bus listeners, lineage stamped on `sessions` per approved amendment). Concurrency soak validated the shared-DB design once (~50k rows/s, 0 busy errors), then retired per user decision in favour of a new `flush_log` write-load table; user-approved amendments also gave `telemetry_meta` an optional unconstrained `session_id` and full-jitter BUSY backoff. Final suite: 146 tests green, tsc clean; SPEC.md amended to match shipped reality.
