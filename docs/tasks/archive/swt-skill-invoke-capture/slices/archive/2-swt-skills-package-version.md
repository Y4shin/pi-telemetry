---
kind: slice
slug: swt-skills-package-version
title: "Resolve skills-package version via getCommands() + package.json walk; stamp into skill_invoke payload"
task: ../task.md
mode: afk
status: todo
size: m
blocked_by: [swt-input-skill-invoke]
---

## End-to-end behavior

At `input` time, resolve the invoked skill's source package and version:
call `pi.getCommands()`, find the matching `source:"skill"` command, walk up
from `sourceInfo.path` to the nearest `package.json`, read `name` +
`version`. Cache the `skillName → { source, version }` map; invalidate on
`resources_discover`. Stamp `skill_source` + `skills_package_version` into the
`skill_invoke` payload.

## Acceptance criteria

- A skill whose SKILL.md is under a `package.json` with `name:"task-workflow", version:"2.5.1"` produces a payload with `skill_source:"task-workflow"`, `skills_package_version:"2.5.1"`.
- A skill with no enclosing `package.json` produces `skill_source:null, skills_package_version:null` (no crash, no meta error).
- The version is resolved from `getCommands()` `sourceInfo.path` (not assumed).
- Cache: a second invocation of the same skill does NOT re-read `package.json` (assert the read count or use a spy).
- `resources_discover` with `reason:"reload"` invalidates the cache; a subsequent invocation re-resolves.
- `npm test` green, `tsc --noEmit` clean.

## Test plan

- Seams: L1 stub with a fake `getCommands()` returning a skill whose `sourceInfo.path` points at a temp SKILL.md under a temp `package.json`; assert the stamped version.
- Failure modes: `package.json` missing (null version); `package.json` with no `version` field (null); unreadable `package.json` (null, no throw).
- Scenarios: package skill vs global skill (no package.json) vs project skill.
- Edge cases: cache invalidation on `resources_discover`; deeply nested skill path.

## Constraints and dependencies

- Generalize `src/version.ts` walk pattern to an arbitrary path.
- `getCommands()` is available after `session_start` (bindCore), before first `input`.
- Does not depend on the prototype.
