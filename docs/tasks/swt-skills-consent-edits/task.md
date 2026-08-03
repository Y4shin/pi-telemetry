---
kind: task
type: manual
slug: swt-skills-consent-edits
title: Add telemetry metadata.capture keys + telemetry_skill_context call prose to task-workflow SKILL.md files (no commit, no install)
map: skill-workflow-telemetry
status: done
blocked_by: []
---

## Exact prerequisite

Feature A (`swt-skill-invoke-capture`) must have landed the `metadata.capture`
reader and the `telemetry_skill_context` tool in pi-telemetry, so the edits
made here have something to be read/called by. Do this only after Feature A
is done.

## Owner / actor

The agent executes the file edits (with the user's consent, granted in
grilling decision 2). The user performs the commit and the install themselves.

## Checklist / safe automation boundary

1. **`git pull`** in `/home/pplattner/Projects/skills` first (the user
   requires this before any edits). Confirm a clean working tree before
   editing; if pull brings conflicts, STOP and report.
2. For each task-workflow skill SKILL.md under
   `/home/pplattner/Projects/skills/skills/<name>/` (the skills that take a
   task/map/slice target — at minimum `wayfinder`, `implement-task`,
   `finalize-task`, `report-bug`; decide per-skill whether it has a useful
   target to capture):
   - Add a `metadata:` block to the YAML frontmatter with a
     `telemetry.capture` key naming the structured arg identifiers to record
     (e.g. `telemetry.capture: "task,map"` for implement-task, which is
     invoked as `/skill:implement-task <task-slug>`). Use the Agent Skills
     standard `metadata` field (a string-keyed map); keep it spec-compliant.
   - Add a short prose line in the SKILL.md body instructing the model to call
     the `telemetry_skill_context` tool mid-run to attach dynamic metadata
     (slice count, outcome) where that is meaningful for the skill.
3. **Do NOT `git commit`.** Do NOT `git push`. Do NOT copy files into
   `~/.pi/agent/git/github.com/Y4shin/skills` or run any install command.
   Leave the edits as unstaged working-tree changes for the user to review,
   commit, and install on their own schedule.
4. Report back: which SKILL.md files were edited, the exact `metadata.capture`
   keys added to each, and the prose line added. Note any skill where no
   useful target exists (skipped, with reason).

## Evidence required to mark it done

- `git status` in `/home/pplattner/Projects/skills` shows the edited SKILL.md
  files as modified, unstaged.
- `git diff` shows only the intended frontmatter `metadata` + prose additions;
  no unrelated changes, no commits, no install artifacts.
- A short report (in the task body or a results note) listing each edited
  skill, its `telemetry.capture` keys, and the prose line.

## Dependent tasks that remain blocked

- Feature B (`swt-compare-versions-queries`) is blocked by this manual task:
  the canned queries are only meaningful once task-workflow skills actually
  emit structured target metadata. If the user wants to develop the queries
  against synthetic data first, Feature B can be unblocked earlier — but
  real per-target comparison needs this task done.

## Constraints

- **Read-only consent was granted for editing only, after `git pull`.** No
  commit, no install (user's explicit constraint from grilling decision 2).
- Keep edits spec-compliant (Agent Skills `metadata` field; lowercase
  kebab-case-safe keys).
- Do not edit the installed copy
  (`~/.pi/agent/git/github.com/Y4shin/skills`) — the user syncs it themselves.

## Execution report (2026-08-03)

Performed by the agent in `/home/pplattner/Projects/skills` after `git pull`
(clean tree, up to date). Edits left as **unstaged working-tree changes** —
NOT committed, NOT installed (per user constraint). The user will review,
commit, and sync to the installed copy themselves.

| Skill | `metadata.telemetry.capture` | Prose line added | Rationale |
|---|---|---|---|
| `implement-task` | `"target"` | call `telemetry_skill_context` mid-run with `{ target, sliceCount }` (and `map` when known) | First positional arg = task/map slug; static capture at invoke time + dynamic slice count mid-run. |
| `finalize-task` | `"target"` | call `telemetry_skill_context` mid-run with `{ target }` (and `map` when the task belongs to a map) | First positional arg = task slug. |
| `wayfinder` | _(none)_ | once the map slug is known, call `telemetry_skill_context` with `{ map }` (and `target`/`slice` when focused) | No clean positional slug at invoke time (the map slug is created mid-session); capture is dynamic-only via the tool. |
| `report-bug` | _(none)_ | once the bug slug is derived, call `telemetry_skill_context` with `{ target }` (the bug slug) | Arg is free-form text, not a slug; the bug slug is derived mid-run, so capture is dynamic-only via the tool. |

**Skipped skills (no useful target to capture):** `create-task` (retired
compatibility redirect), `onboard-workflow` (no target arg — initializes a
repo), `task-overview` (read-only router), `refine-idea` (idea slug is
fleshed out during the session, not a clean invoke-time slug). These could
be added later if a target dimension becomes useful.

**Evidence:** `git status` in `/home/pplattner/Projects/skills` shows the 4
SKILL.md files as modified, unstaged. `git diff` shows only the intended
frontmatter `metadata` + prose additions; no unrelated changes, no commits,
no install artifacts.

**Remaining risks / follow-up:**
- The edits are inert until the user commits + syncs them into the installed
  copy (`~/.pi/agent/git/github.com/Y4shin/skills`); until then, live
  `/skill:` invocations won't carry `metadata.capture` or the tool-call prose.
- Feature B (`swt-compare-versions-queries`) can now be unblocked — the
  capture capability + the skills opt-in are both in place (once the user
  syncs). Real per-target comparison data will flow after the first
  post-sync invocation.
