---
kind: slice
slug: swt-input-skill-invoke
title: "input handler records skill_invoke session_events row (name + args length/hash + source)"
task: ../task.md
mode: afk
status: todo
size: s
blocked_by: [swt-queryability-schema]
---

## End-to-end behavior

Register a `pi.on("input", …)` handler that, when `event.text` starts with
`/skill:`, parses the skill name + args and writes one `session_events` row of
`type='skill_invoke'` with a JSON payload (`skill_name`, `args_chars`,
`args_hash`, `input_source`), AND projects `skill_name` into a
`session_event_metadata` row (key=`skill_name`, type=`string`) via the shared
`insertSkillMetadata` helper from slice 6. The handler returns
`{action:"continue"}` (never blocks/transforms).

## Acceptance criteria

- A `/skill:foo bar baz` input produces one `session_events` row, `type='skill_invoke'`, payload `skill_name="foo"`, `args_chars=7`, `args_hash=sha256("bar baz")`, `input_source="interactive"`.
- RPC source (`"rpc"`) and print mode produce the row with `input_source="rpc"`/`"interactive"`.
- `source:"extension"` inputs produce NO `skill_invoke` row.
- Non-skill inputs (`hello`, `/cmd`) produce NO `skill_invoke` row.
- The handler returns `{action:"continue"}` (or nothing) — input is never blocked or transformed.
- Privacy: no `args` text appears in the payload or any table — only `args_chars` + `args_hash` (sha256). `skill_name` (a kebab-case identifier) is stored.
- `npm test` green, `tsc --noEmit` clean.

## Test plan

- Seams: L1 stub (`test/helpers/l1-stub.ts`) firing `input` events; assert the `session_events` row.
- Failure modes: empty skill name (`/skill:` with nothing), no args, args with newlines, very long args.
- Scenarios: interactive / rpc / extension sources; non-skill text; `/skill:` prefix with trailing space only.
- Edge cases: handler must not throw on malformed text; must not alter input.
- Privacy test: grep the DB for the arg text string → must be absent.

## Constraints and dependencies

- Mirror `src/capture/session-events.ts` `insertEvent()`.
- Use `src/hash.ts` `sha256()`.
- Wrap in `src/state.ts` `guard()`.
- **Depends on slice 6** (`swt-queryability-schema`) for the
  `insertSkillMetadata` helper and the `session_event_metadata` table.
