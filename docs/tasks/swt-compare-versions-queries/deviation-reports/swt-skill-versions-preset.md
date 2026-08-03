# Deviation report — swt-skill-versions-preset

## Slice doc vs. implementation

The slice doc acceptance criteria state:

> `query_telemetry` with `query:"skill_versions"` and `versionA:"2.4.0", versionB:"2.5.1"` returns per-skill rows with cost/turn/tool-error deltas between the two versions.
> Skills present in only one version show a delta from zero.

## Actual implementation

Implemented per the **approved architecture spec** and Q1 decision:

- `skill_versions` accepts a single `version` filter parameter (mapped to `verFilter`).
- The preset returns the `skill_cost` rows for **one version only**.
- The **agent/caller computes the A/B delta client-side** by calling the preset twice (once per version) and diffing the results.
- No SQL UNION or self-join delta is performed in the database.

## Rationale

The architecture spec explicitly approved "two filtered queries + client-side diff" as simpler and reusing the existing `skill_cost` SQL. It is the authoritative document and overrides the slice doc where they conflict. This keeps the query read-only, avoids complex self-joins, and lets the agent control how deltas are computed.

## Files changed

- `src/query/canned.ts` — added `verFilter` to `CannedFilters`, added `skill_versions` preset with `-- {{verFilter:ver.value_text}}` marker.
- `src/query/tool.ts` — added `skill_versions` to `PRESET_NAMES`, added `version` tool parameter mapped to `verFilter`, updated descriptions.
- `test/canned.test.ts` — added `skill_versions` filter and index tests.
- `test/tool.test.ts` — added `query:"skill_versions"` + `version` integration test.
