---
kind: task
type: research
slug: swt-research-seams
title: Find the capture seams for skill invocations, skills-package version, and skill self-declared metadata
map: skill-workflow-telemetry
status: done
blocked_by: []
slices: []
---

## Precise question

What are the exact, verified seams in Pi v0.80.10 + the installed extensions
for pi-telemetry to record, for the `task-workflow` skills package:

1. **Skill invocations** — which Pi event(s) fire when a user runs
   `/skill:<name> <args>`, on which paths (TUI, RPC, `pi -p`), with what payload
   fields, and does any path bypass the chosen event?
2. **Skills-package version** — where is the `task-workflow` package version
   discoverable at runtime from inside a pi-telemetry capture handler
   (`package.json` of the registered extension? a frontmatter field? git
   tag/HEAD of the skills repo?), and is it available at `session_start` or
   only later?
3. **Skill self-declared metadata** — two candidate mechanisms to evaluate:
   (a) **frontmatter keys** in `SKILL.md` naming which input args to capture
   (e.g. `telemetry.capture: [task, map, sliceCount]`), and (b) a **tool call**
   the skill makes mid-run to enrich its invocation metadata. For each: what
   exactly must change, in which package (pi-telemetry vs the read-only skills
   package vs pi itself), and what the attribution contract is (which
   invocation/turn/run does the metadata attach to?).
4. **Schema recommendation** — record skill invocations as a new
   `session_events` row with `type='skill_invoke'` + JSON payload (SPEC §1.7,
   no migration) vs a dedicated `skill_invocations` table (heavier, queryable
   columns). Recommend one, with the trade-off.
5. **Run-level correlation pressure** — does skill-invocation capture need
   `parent_run_id`/`depth` lineage (currently NULL for all 98 live sessions;
   HANDOFF coherence-refactor #1 is the fix) to group "one invocation = top
   session + subagent fan-out"? Or is per-skill + per-target grouping
   sufficient without it?

## Decision or task it unblocks

Unblocks `swt-grill-decisions` (the user sign-off grilling task), which in turn
graduates the three implementation features from the map's Fog:
- skill-invocation capture (name + structured arg slugs + skill-declared metadata)
- skills-package version as a correlation dimension
- canned compare-across-versions-and-skills queries

## Trusted source boundaries

- **Primary:** the installed pi package types at
  `/nix/store/46l2syffzlyylqhs4mlzaxxyj5ivglry-pi-coding-agent-0.80.10/lib/node_modules/pi-monorepo/`
  — `docs/extensions.md` (event reference, especially `user_input`), `docs/sdk.md`,
  and the installed `node_modules/@earendil-works/pi-coding-agent` type
  declarations. The types are authoritative; never invent event shapes
  (HANDOFF rule).
- **This repo:** `SPEC.md` (§1.7 session_events, §3 write path, §7 config),
  `src/capture/session-events.ts` (the generic-event handler pattern to mirror),
  `src/capture/sessions.ts` (version-stamping pattern), `src/lineage.ts`
  (lineage + `buildEnvBlock` — the coherence-refactor #1 context),
  `docs/ideas/skill-invocation-capture.md` (prior hook-point hypothesis to
  verify, not trust).
- **Skills package (READ-ONLY):** `/home/pplattner/Projects/skills` —
  `package.json` (version 2.4.0, `pi.skills`/`pi.extensions` manifest),
  `skills/*/SKILL.md` frontmatter (confirm NO version field exists today),
  `src/pi.ts` (extension entry, what it registers). Do not edit.
- **Web:** only to confirm pi event semantics if local docs are ambiguous;
  prefer the installed types over web sources.

## Evidence required for completion

A findings document at `docs/tasks/swt-research-seams/findings.md` containing,
for each of the 5 questions above:

- the verified answer with a citation to the exact file:line / type declaration
  / event payload shape (not a paraphrase);
- a concrete code-level sketch of the capture handler (which event, which
  fields extracted, which table/row written) — enough that a feature task can
  write slices directly from it;
- for the self-declaration mechanisms (frontmatter vs tool call): an explicit
  "requires editing the read-only skills package: YES/NO, and exactly what"
  verdict, because the user's consent gates that;
- the schema recommendation with the SQL sketch (column list or payload JSON
  shape) and the query it enables;
- a list of newly-sharp decisions that must go to the grilling task, and any
  work that should stay in Fog or move to Out of scope.

The findings doc is the artifact; it is reviewed in `swt-grill-decisions`
before any code is written.

## Likely dependent tasks

- `swt-grill-decisions` (grilling, blocked_by this task).
- After grilling sign-off, three feature tasks graduate from the map's Fog:
  skill-invocation capture, skills-package version dimension, and the
  compare-versions-and-skills canned queries.
- A `manual` task to consent/coordinate skills-package edits, **only if** this
  research finds the chosen self-declaration mechanism requires them.
