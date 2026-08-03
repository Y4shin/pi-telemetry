---
kind: task
type: grilling
slug: swt-grill-decisions
title: "Sign off on skill-workflow-telemetry findings: self-declaration mechanism, skills-package consent, schema, and run-level correlation scope"
map: skill-workflow-telemetry
status: done
blocked_by:
- swt-research-seams
slices: []
---

## Decision to settle

After reading `docs/tasks/swt-research-seams/findings.md`, settle, one question
at a time (never answer on the user's behalf):

1. **Self-declaration mechanism.** Frontmatter keys in `SKILL.md` naming which
   args to capture, a tool call the skill makes to enrich its invocation
   metadata, both, or neither (telemetry infers from arg shape). The research
   doc presents the trade-off; the user picks.
2. **Skills-package consent.** Does the chosen mechanism require editing the
   read-only `/home/pplattner/Projects/skills`, and if so does the user consent?
   If yes → graduate a `manual` task (consent + the exact edits). If no →
   confirm the mechanism is achievable purely in pi-telemetry.
3. **Schema.** Sign off on the research doc's recommendation: `session_events`
   `type='skill_invoke'` JSON rows (no migration) vs a dedicated
   `skill_invocations` table. Confirm the fields/payload shape.
4. **Run-level correlation scope.** Is "one invocation = top session + subagent
   fan-out tree" grouping in scope (requires fixing `parent_run_id`/`depth`
   lineage per HANDOFF coherence-refactor #1), or is per-skill + per-target
   grouping enough for now? If in → graduate a feature task for the lineage fix.
5. **Feature graduation.** Confirm which of the three Fog features graduate to
   real tasks with slices, and their order:
   - skill-invocation capture (name + structured arg slugs + skill-declared
     metadata);
   - skills-package version as a correlation dimension;
   - canned compare-across-versions-and-skills queries.

## Parent decisions it depends on

- `swt-research-seams` findings (the evidence for every choice above).
- The map's constraints: v1 privacy posture, no schema migration if
  avoidable, read-only skills package, telemetry must never break a session.

## Choices already known

- Version axis = task-workflow package version (decided in map).
- Invocation grouping includes skill name + workflow-defined metadata (decided
  in map).
- Process = formal findings doc reviewed before code (decided in map).

## Decisions settled (grilling log)

- **[2026-08-03] Self-declaration mechanism = BOTH.** Ship (a) frontmatter
  `metadata.capture` keys for static args known at invoke time (task/map/slice
  slugs) AND (b) the `telemetry_skill_context` tool for dynamic metadata known
  only mid-run (slice count, outcome flags). They compose; neither blocks the
  other. Research confirmed both are feasible without a Pi upstream change;
  both function without a skills-package edit but need one to be *useful* for
  task-workflow specifically (see decision 2). Rejected: frontmatter-only (loses
  dynamic mid-run metadata), tool-only (loses clean static attribution), neither
  (loses per-target grouping).
- **[2026-08-03] Schema = REVISED: Option D (sparse EAV, 1 table + CHECK
  constraint), superseding the earlier Option A.** The user flagged that
  generated VIRTUAL columns (Option A) are per-key and need a migration for
  every new queryable dimension — overfit to a specific workflow. The
  `swt-schema-prototype` EAV extension (`bench-eav.mjs`, `results-eav.md`)
  benchmarked two migration-free EAV variants against A: C (typed EAV, 5
  tables) and D (sparse EAV, 1 table with a CHECK constraint enforcing exactly
  one `value_*` col non-null matching `type`). Findings: all three are
  index-backed and correct; A is ~1.5× faster to query and ~5× cheaper to
  write, but D is universal (new keys = rows, never a migration) with enforced
  type integrity, and D dominates C (same query speed, 40% cheaper to write,
  one table not five). Chose D for universality (the user's explicit goal for a
  telemetry store meant to outlive any one workflow). `session_events` keeps
  the raw JSON payload (source of truth); `session_event_metadata` is the
  typed, queryable projection. Cost: 1.5× query / 5× write vs A, both
  sub-second at 100k. Rejected: A (overfits), C (5 tables, no advantage),
  baseline (not performant).
- **[2026-08-03] Skills-package consent = YES, with constraints.** Consent to
  edit `/home/pplattner/Projects/skills` **after `git pull`** to add
  `metadata.capture` keys + `telemetry_skill_context` call prose to each
  task-workflow SKILL.md. **Constraint: do NOT commit the skills edits and do NOT
  attempt to install them into the environment — the user will handle commit +
  install themselves.** The installed copy
  (`~/.pi/agent/git/github.com/Y4shin/skills`, v2.5.1) is NOT to be edited
  directly; the user will sync it from the source repo on their own schedule.
  Graduates a `manual` task scoped to: `git pull` → edit SKILL.md files → stop
  (no commit, no install).
- **[2026-08-03] Run-level correlation = leave in Fog.** Per-skill +
  per-version + per-target grouping (the selected dimensions) does not need
  `parent_run_id`/`depth`. The three core features ship without it. Lineage
  (HANDOFF coherence-refactor #1 + a pi-subagents emitter) remains a separate
  future map if the user later wants 'one invocation = whole subagent tree'
  grouping. Not graduated now.
- **[2026-08-03] Mid-stream steer/followUp gap = accept + document.** The
  `input` event fires on TUI/RPC/print (idle invocations) but NOT on mid-stream
  `steer()`/`followUp()` skill commands. Skills are usually invoked when idle,
  so the gap is narrow. Ship capture on `input` only; record the limitation in
  map Fog (and later in SPEC + the query tool description). Do NOT hook a second
  seam now.
- **[2026-08-03] Feature graduation + order = Prototype → Capture → Manual →
  Queries.** Graduated tasks, in execution order:
  1. `swt-schema-prototype` (prototype, ready now) → user reviews numbers →
     closes schema decision.
  2. `swt-skill-invoke-capture` (feature A): `input` handler + skills-package
     version resolution + frontmatter `metadata.capture` reader +
     `telemetry_skill_context` tool + `turn_start` run/turn back-fill; the
     generated-column/join-table slice is shaped by the prototype result.
  3. `swt-skills-consent-edits` (manual): `git pull` `/home/pplattner/Projects/skills`
     → add `metadata.capture` keys + `telemetry_skill_context` call prose to each
     task-workflow SKILL.md → STOP (no commit, no install; user handles those).
  4. `swt-compare-versions-queries` (feature B): `query_telemetry` presets
     (`skill_cost`, `skill_versions`) + `/tm skills` command.
  Feature C (run-level lineage) stays in Fog per decision 4.
- **[2026-08-03] Schema = DEFERRED pending prototype.** `session_events` with
  `type='skill_invoke'` JSON payload is the base (no new table). The
  queryability/indexing approach is deferred to a **prototype task** that tests,
  against the real `node:sqlite` engine with NO Pi/LLM involvement:
  (a) **generated VIRTUAL columns** (`skill_name`, `skills_package_version`,
  `target`) backed by `json_extract` + indexes on `session_events`; vs.
  (b) an alternative **`session_event_metadata` N:1 join table** (one metadata
  row per session_event, native columns, join on event_id). The prototype
  populates both at realistic volume (10k–100k skill_invoke rows) and measures
  query correctness + `EXPLAIN QUERY PLAN` + timing of the compare-versions-and-
  skills query. User reviews the numbers and picks. Verified fact so far:
  `json_extract` works; VIRTUAL generated columns + indexes are index-backed
  (`EXPLAIN QUERY PLAN` → `USING INDEX`); STORED columns can't be ALTER-added to
  an existing table. This decision (3) blocks the capture feature's
  generated-column slice only; it does NOT block the capture handler slice or
  the other features.

## Recommended starting answer

Defer to the research doc's recommendation for each question; the grilling
task presents that recommendation as the first option but lets the user
override. For self-declaration, the likely recommendation is "frontmatter keys
for static capture + an optional tool call for dynamic enrichment," but the
research must confirm feasibility before it's offered.

## What downstream work the answer may create

- Graduates 2–4 feature tasks (the three Fog features + possibly the lineage
  fix) into the map's `tasks` list with slice docs.
- May create a `manual` task for skills-package edits if consent is given.
- Updates the map's Decisions, Fog, and Out-of-scope sections to reflect the
  settled choices.
- Hands off to `/skill:implement-task skill-workflow-telemetry` once the
  frontier is meaningful.
