---
kind: idea
title: "pi-telemetry: skill invocation capture"
slug: skill-invocation-capture
status: raw
created_at: 2026-07-30T14:05:00Z
---

# pi-telemetry: skill invocation capture

Follow-up to pi-telemetry v1 (SPEC §1). v1 captures sessions, runs, turns, LLM
requests, tool executions, user bash, and five session-shape event types —
but **not** skill invocations (`/skill:name`). User asked about it during
implementation; out of v1 grilling scope.

## Goal

Record skill invocations as telemetry so queries can answer "which skills do
I actually use?", "how much do skills cost per session?", "do skill-driven
sessions have different failure/feedback patterns?"

## Why it's cheap

The generic `session_events` table (SPEC §1.7: `type` + JSON `payload`) was
deliberately designed to absorb new event classes **without a schema
migration** — a new `type: 'skill_invoke'` row is a small slice: one handler,
payload mapping, tests. No new table needed.

## Hook point (needs verification)

Pi v0.80.10 has **no dedicated skill event**. Candidate: the `user_input`
event fires after extension commands but **before** skill/template expansion,
with `event.text` as the raw input (`docs/extensions.md` ~line 878) — an
extension can see `/skill:foo` before expansion.

**Privacy caveat:** `event.text` is raw user input. Capture must extract
only the command name + argument *lengths/hashes* (SPEC privacy posture),
never the text. A dedicated upstream skill event (clean name + args, no raw
input) would be preferable — consider upstreaming before building on
`user_input`.

## Open questions for grilling

- `/skill:name` only, or also skill-triggered slash commands and
  auto-invoked skills?
- Payload fields: name, args length/hash, source (user/typed vs.
  programmatic)? Correlate with run/turn at invocation time?
- Does `user_input` see all invocation paths (TUI, RPC, `pi -p`)? Are there
  paths that bypass it?
- Should this also cover custom commands/prompt templates (`/template`)?
  Same seam, same questions.
- Upstream a dedicated `skill_invoke` event into pi first, or ship on
  `user_input` now and migrate the handler later?
