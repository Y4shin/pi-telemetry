---
kind: slice
slug: swt-frontmatter-metadata-reader
title: "Read metadata.capture from SKILL.md frontmatter; extract named/positional slugs into skill_invoke payload"
task: ../task.md
mode: afk
status: done
size: m
blocked_by: [swt-input-skill-invoke]
---

## End-to-end behavior

At `input` time, re-read the invoked skill's SKILL.md from `sourceInfo.path`,
parse its YAML frontmatter, and if a `metadata.telemetry.capture` key is
present (a comma/space-delimited list of arg identifiers), extract those
values from the parsed args (by position or name) into the `skill_invoke`
payload as structured fields (`target`, `map`, `slice`, etc.). Skills without
the key get null fields.

## Acceptance criteria

- A skill whose SKILL.md has `metadata.telemetry.capture: "task"` invoked as `/skill:implement-task pi-telemetry` produces a payload with `target:"pi-telemetry"`.
- A skill with `metadata.telemetry.capture: "task,map"` invoked as `/skill:foo mytask mymap` populates both `target` and `map` positionally.
- A skill with no `metadata` or no `telemetry.capture` key leaves the structured fields null (the row still records name + version + args hash).
- Re-reading SKILL.md is cached alongside the version cache (slice 2) and invalidated on `resources_discover`.
- Only kebab-case slug identifiers are recorded; if a captured arg is not a clean slug, store its length/hash instead of the raw text (privacy posture).
- `npm test` green, `tsc --noEmit` clean.

## Test plan

- Seams: L1 stub with a temp SKILL.md containing `metadata.telemetry.capture`; assert extracted fields.
- Failure modes: missing frontmatter; `metadata` not a map; `telemetry.capture` not a string; arg count < named keys (missing → null); arg not a slug (→ length/hash).
- Scenarios: positional capture, named capture (if supported), no capture key.
- Edge cases: frontmatter parse error (→ null fields, no throw, meta note).

## Constraints and dependencies

- Use the Agent Skills standard `metadata` field (spec-compliant).
- Privacy: never store raw arg text; slugs only, else length/hash.
- Does not depend on the prototype.
