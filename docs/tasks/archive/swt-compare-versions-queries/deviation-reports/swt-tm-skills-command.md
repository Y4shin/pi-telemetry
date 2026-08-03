## Deviation report — swt-tm-skills-command

### API surface changes
- **Planned:** Add a `case "skills":` to `handleCommand` in `src/query/commands.ts` that calls `runCanned(dbPath, "skill_cost")` and renders via `formatResult`. Update the `/tm` + `/telemetry` command description strings to list `skills`.
- **Actual:** Exactly as planned. `renderSkills(dbPath)` is a 3-line function that calls `runCanned(dbPath, "skill_cost")` → `formatResult`. Added `case "skills": return renderSkills(dbPath);` to the switch. Both command descriptions updated to include `skills` in the subcommand list. The `/tm` description was changed from `"Alias for /telemetry."` to the full duplicated description string (same as `/telemetry` + `, skills`). This matches the arch spec's requirement ("Added to the `/tm` + `/telemetry` command description string") and is arguably an improvement (the alias now has a self-contained description), though it does duplicate the full description text instead of saying "Alias for /telemetry."
- **Impact:** None on dependent slices (slice 3 `swt-skill-versions-preset` adds to `canned.ts`/`tool.ts`, not `commands.ts`). The `/tm` description duplication is cosmetic — if the `/telemetry` description changes later, `/tm` won't auto-track. Minor maintenance risk, not a functional issue.

### Abstraction usage
- Used/was specified: **yes** — `runCanned(dbPath, "skill_cost")` is reused (no second query runner); `formatResult` is reused (no second table formatter); the `handleCommand` switch + `renderCost`/`renderErrors` pattern is mirrored. All specified abstractions used correctly.

### Out-of-scope changes
- **`/tm` description duplication:** The `/tm` command description was changed from `"Alias for /telemetry."` to the full duplicated description string (same as `/telemetry` + `, skills`). The arch spec said "Added to the `/tm` + `/telemetry` command description string," which the implementer interpreted as "make both descriptions list `skills`" rather than "add `skills` to `/telemetry` and keep `/tm` as an alias." This is a reasonable interpretation and arguably better UX (the alias is self-describing), but it introduces a maintenance coupling: if the `/telemetry` description changes, `/tm` must be manually updated. Not a blocker.
- **`test/helpers/fixture-skill-events.ts`** (new file): a shared test fixture for seeding `session_events` + `session_event_metadata` + `turns` + `tool_executions` rows. Created in slice 1 (`55b5e35`), reused by this slice's tests. Not an out-of-scope addition by this slice — it was already landed by slice 1.

### Slice doc vs. arch spec column discrepancy (pre-existing, not this slice's fault)

The **slice doc** (2-swt-tm-skills-command.md) says the table should show: "skill name, package version, invocations, cost, **last target, most recent invocation time**."

The **arch spec** (approved, beats slice docs) says: "version, skill, invocations, cost, **tokens, tool_errors**."

The actual `skill_cost` preset (slice 1) returns: `skills_package_version, skill_name, invocations, cost_usd, tokens, tool_errors`.

The implementation correctly follows the **arch spec** (which explicitly states "its amendments beat the slice docs where they conflict"). The slice doc's "last target" and "most recent invocation time" columns were never in the approved `skill_cost` SQL (the arch spec's SQL sketch has `tokens` and `tool_errors` instead). This is a **slice-doc-stale-vs-arch-spec** discrepancy, not an implementation deviation. The implementation is correct; the slice doc should have been updated when the arch spec was approved. No action needed on the implementation.

### Task doc update needed?
No. The task doc's slice list already describes slice 2 accurately ("`/tm skills` subcommand"). The column discrepancy is a slice-doc issue, not a task-doc issue.

### User attention needed?
No. No scope changes, no API surface deviations, no user-judgment decisions. The `/tm` description duplication is a minor cosmetic choice, not a blocker.
