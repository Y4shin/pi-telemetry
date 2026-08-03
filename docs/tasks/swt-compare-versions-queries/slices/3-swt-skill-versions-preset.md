---
kind: slice
slug: swt-skill-versions-preset
title: "query_telemetry preset skill_versions — A/B delta between two versions of the same skill"
task: ../task.md
mode: afk
status: todo
size: s
blocked_by: [swt-skill-cost-preset]
---

## End-to-end behavior

Add a `skill_versions` named preset to `query_telemetry`: returns a per-skill
delta between two versions (cost/turn/tool-error delta), accepting version
filter params (e.g. `versionA`, `versionB`).

## Acceptance criteria

- `query_telemetry` with `query:"skill_versions"` and `versionA:"2.4.0", versionB:"2.5.1"` returns per-skill rows with cost/turn/tool-error deltas between the two versions.
- Skills present in only one version show a delta from zero.
- The query uses the index.
- Added to `src/query/canned.ts`; tool description lists it.
- `npm test` green, `tsc --noEmit` clean.

## Test plan

- Seams: `test/canned.test.ts` with synthetic rows for two versions.
- Failure modes: a skill absent in one version; both versions identical (zero deltas); version with no invocations.
- Scenarios: cost went down; tool errors went up; new skill added in the newer version.

## Constraints and dependencies

- Depends on slice 1 (shared query structure).
- Mirror `src/query/canned.ts` preset pattern.
