---
kind: map
slug: skill-workflow-telemetry
title: "Skill & workflow observability — correlate pi-telemetry metrics to skills-package versions and workflow invocations"
status: active
tasks:
  - swt-research-seams
  - swt-grill-decisions
  - swt-schema-prototype
  - swt-skill-invoke-capture
  - swt-skills-consent-edits
  - swt-compare-versions-queries
---

## Destination

pi-telemetry can answer, for the `task-workflow` skills package (the user's
main debugging candidate, currently v2.4.0 at `/home/pplattner/Projects/skills`):

- "How do metrics differ between **version v2.3.0 and v2.4.0** of the skills
  package?" — the skills-package version is a first-class correlation dimension,
  captured per session/invocation, queryable via `query_telemetry` and `/tm`.
- "Which **skill** was invoked, and how much did that invocation cost / what did
  it do?" — every `/skill:<name>` invocation is recorded with the skill name and
  structured, low-sensitivity arg identifiers (task/map/slice slugs), never raw
  prompt text.
- "How do invocations group by **workflow-defined metadata**?" — e.g. the
  number of slices a task had, the map slug, the target task slug — metadata the
  skill itself declares, attached to the invocation.
- The skill can **self-declare what to capture** — either via frontmatter keys
  naming which input args to record, or by calling a telemetry tool mid-run to
  enrich its invocation metadata (the research task decides which, or both).

Done looks like: a real `/skill:implement-task` run (and its subagent fan-out)
can be attributed to a specific skills-package version and a specific skill +
target, and a canned query compares cost/tool-failure/turn-count across
versions and skills. The v1 privacy posture (lengths + SHA-256, no content by
default) is preserved; any richer capture is opt-in.

## Constraints

- **Read-only skills package without explicit consent.** `/home/pplattner/Projects/skills`
  may not be edited unless the user approves. Any self-declaration mechanism
  that requires a skills-package change must surface that as a coordination
  item (a `manual` task or a grilling decision), not be silently assumed.
- **v1 privacy posture holds.** Raw prompt text is never stored. Skill name +
  kebab-case slug identifiers are low-sensitivity and acceptable; richer arg
  capture is opt-in behind a flag, mirroring `capture.toolArgs`.
- **No schema migration if avoidable.** SPEC §1.7 deliberately made
  `session_events` a generic `type` + JSON `payload` table to absorb new event
  classes without migration. A `type: 'skill_invoke'` row is the cheap path;
  a dedicated `skill_invocations` table is the heavier path — the research task
  recommends which.
- **Telemetry must never break a session.** All new capture is best-effort,
  failure → `telemetry_meta`, handler swallows (SPEC §3).
- **Multi-version coexistence.** New columns/tables are nullable or have
  defaults; older extension versions keep writing against newer schemas
  (SPEC §8).
- **Tests required.** Every change lands at least one test (project rule,
  `docs/testing.md`). L1 handler→row mapping + privacy assertion for new
  capture; canned-query tests for new presets.

## Decisions so far

- **[2026-08-03] Schema = DECIDED: Option D (sparse EAV, 1 table + CHECK
  constraint)** (prototype EAV extension closed decision 3, superseding the
  earlier Option A). Universal/migration-free: new metadata keys are rows, not
  schema changes. `session_event_metadata(event_id, key, type, value_text,
  value_int, value_real, value_bool, PK(event_id,key), CHECK(exactly one
  value_* non-null matching type))` + indexes. `session_events` keeps the raw
  JSON payload as source of truth; the metadata table is the typed queryable
  projection. Cost: ~1.5× query / ~5× write vs generated columns, both
  sub-second at 100k. Chosen for universality (telemetry store should not
  overfit to one workflow).
- **[2026-08-03] Skills-package consent = YES, with constraints** (grilling).
  Consent to edit `/home/pplattner/Projects/skills` **after `git pull`** to add
  `metadata.capture` keys + `telemetry_skill_context` call prose to each
  task-workflow SKILL.md. **Do NOT commit or install — the user handles commit +
  install themselves.** The installed copy is not edited directly; the user syncs
  it on their own schedule. Graduates a `manual` task (pull → edit → stop).
- **[2026-08-03] Self-declaration mechanism = BOTH** (grilling). Ship frontmatter
  `metadata.capture` keys for static args (task/map/slice slugs known at invoke
  time) AND the `telemetry_skill_context` tool for dynamic metadata known only
  mid-run (slice count, outcome flags). They compose. Both function without a
  skills-package edit; both need one to be *useful* for task-workflow (consent
  TBD in decision 2).
- **Version axis = task-workflow package version**, not pi-telemetry's own
  `ext_version` (already captured) and not `pi_version`. The skills-package
  version is a new dimension.
- **Invocation grouping = skill name + workflow-defined metadata.** Per-skill
  is the base; the skill can attach structured metadata (slice count, target
  slug, etc.) to its invocation.
- **Self-declaration is in scope** — frontmatter keys and/or a tool call the
  skill makes to enrich metadata. The exact mechanism is a research finding +
  grilling decision, not pre-decided.
- **Process = formal findings doc, reviewed before code.** A research task
  produces a gap/options/schema doc; the user signs off (grilling task) before
  any feature work.
- **Lineage/run-level correlation is NOT yet a task** — `parent_run_id` and
  `depth` are NULL for all 98 live sessions; the HANDOFF coherence-refactor #1
  (`buildEnvBlock` derive-from-runtime-state) is the known fix but the user did
  not select per-workflow-run grouping. It stays in Fog until research
  determines whether skill-invocation capture needs it.

## Fog

- **Run-level correlation (parent_run_id / depth always NULL).** Left in Fog
  by grilling decision 4. Per-skill + per-version + per-target grouping does
  not need it. Graduate a separate lineage feature (HANDOFF coherence-refactor
  #1 + a pi-subagents emitter) only if the user later wants 'one invocation =
  whole subagent tree' grouping.
- **Mid-stream `steer`/`followUp` capture gap.** Left in Fog by grilling
  decision 5. The `input` event misses `/skill:` commands invoked while the
  agent is streaming. Accepted; document in SPEC + the query tool description.
  Do not hook a second seam now.
- **`telemetry_skill_context` attribution via a correlation_id passed into the
  skill body** — needs Pi `transform` support; too invasive for now.
- **Custom commands (`/cmd`) and prompt templates (`/template`)** — same
  `input` seam could capture them, but the user asked about *skills*
  specifically. Leave for a future map.
- **Where the skills-package version is read from at runtime** — RESOLVED by
  research: walk up from `sourceInfo.path` to nearest `package.json`.
  (Graduated; no longer fog.)

## Out of scope

- pi-telemetry's own `ext_version` as a correlation target (already captured).
- Live dashboards, alerting/SLOs, OTLP export (SPEC §10 non-goals).
- Editing the installed skills copy
  (`~/.pi/agent/git/github.com/Y4shin/skills`) directly — the user syncs it
  themselves from the source repo.
- Content-first capture of prompt text (privacy posture).
- Multi-host aggregation (single shared local DB by design).
- Upstreaming a dedicated `skill_invoke` event into Pi itself (clean long-term
  seam, but an upstream pi change; the `input` seam is sufficient for v1).
- A dedicated `skill_invocations` table — `session_events` JSON (+ generated
  columns / join table per the prototype) is sufficient; revisit only if query
  perf demands it.
- Run-level lineage as part of this map (Fog; separate future map if needed).
