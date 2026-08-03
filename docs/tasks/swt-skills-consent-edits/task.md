---
kind: task
type: manual
slug: swt-skills-consent-edits
title: "Add telemetry metadata.capture keys + telemetry_skill_context call prose to task-workflow SKILL.md files (no commit, no install)"
map: skill-workflow-telemetry
status: ready
blocked_by: [swt-skill-invoke-capture]
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
