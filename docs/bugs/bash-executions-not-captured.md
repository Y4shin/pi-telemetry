---
title: bash_executions table never populated
status: wontfix
severity: major
reported: 2026-07-31
confirmed_by: investigation 2026-07-31
fix_commit:
promoted_to:
---

> **Verdict: not a bug — deprecated by design.** The empty table reflects
> the removal of the `user_bash` capture path (task: `deprecate-bash-executions`),
> not a broken collector. The `bash_executions` DDL is retained for backward
> compatibility with older in-flight extension versions; a later task may drop
> it once all running agents have upgraded. See
> `repro-bash-executions-not-captured.md` for the historical trace.

# bash_executions table never populated

## Observed

In the live `~/.pi/telemetry.db` (30 sessions across pi-telemetry ext
versions 0.1.0 and 0.2.0), the `bash_executions` table contains **0
rows** while `tool_executions` records **731 `bash` tool calls** — bash
accounts for ~65% of all tool activity. The dedicated per-command
columns defined in the schema are never written:

- `exit_code`, `command_hash`, `command_chars`, `output_chars`
- `cwd`, `duration_ms`
- `cancelled`, `truncated`, `exclude_from_context`

Evidence (live DB, 2026-07-31):

```
bash_executions rows:            0
tool_executions WHERE name=bash: 731
```

The gap is present in both ext 0.1.0 (28 sessions, 731 bash calls) and
ext 0.2.0 (2 sessions, 5 bash calls), so this is not a version
regression — the table has never been populated.

## Expected

Every `bash` tool execution that yields a `tool_executions` row should
also yield a companion `bash_executions` row carrying the command's
exit code, output size, duration, cwd, and cancellation/truncation
flags. Referential shape: `bash_executions.session_id -> sessions`.

## Reproduction

### Live DB (already confirmed)

```bash
cd ~/.pi/telemetry-eval && uv run python -c "
import sqlite3, os
c = sqlite3.connect('file:'+os.path.expanduser('~/.pi/telemetry.db')+'?mode=ro', uri=True)
print('bash_executions:', c.execute('SELECT COUNT(*) FROM bash_executions').fetchone()[0])
print('bash tool_calls:', c.execute(\"SELECT COUNT(*) FROM tool_executions WHERE tool_name='bash'\").fetchone()[0])
"
# -> bash_executions: 0
# -> bash tool_calls: 731
```

### In-repo (L1 unit test)

Fire the bash tool-execution event through the capture handler using
`test/helpers/l1-stub.ts` and assert a `bash_executions` row is
written. See `repro.md` for the exact script; it currently produces no
row.

## Suspected area

`src/capture/bash.ts` — the bash capture handler is either not wired to
emit a `bash_executions` INSERT, or the event hook that should trigger
it is not firing. The `tool_executions` row IS written (so the tool
event reaches the extension), but no companion `bash_executions` row
follows.

## Root cause

**By design — not a defect.** `bash_executions` is SPEC'd (SPEC.md §1.6
"User bash (`!` / `!!`)") to capture only **user-typed** bash commands via
the `user_bash` event. The collector works: `test/bash.test.ts` passes 6/6,
and when `user_bash` fires it writes a correct `bash_executions` row
(success, failing exit code, exclude_from_context, truncated, rethrow,
cancelled).

The empty table is explained by the SDK wiring, not a bug:

- `user_bash` is emitted from exactly **one** site — interactive mode's
  `handleBashCommand` (the user-typed `!`/`!!` path). `handleBashCommand`
  passes the intercepted `operations` to `session.executeBash`, which runs
  the wrapped `exec` and records the row.
- The **agent's `bash` tool** (`createBashToolDefinition.execute`) calls
  `ops.exec` directly and emits `tool_execution_start` / `tool_result` /
  `tool_execution_end` (captured in `tool_executions`), but **never emits
  `user_bash`**. So the 731 agent bash calls were never meant to populate
  `bash_executions` — they live in `tool_executions` by design.
- No `!`/`!!` commands were typed in the captured sessions → 0 rows.

This was originally flagged as a collection gap in the DB health analysis;
that flag was a false alarm based on the mistaken assumption that
`bash_executions` should hold all bash activity including agent tool calls.

## Fix summary

No code fix — the `bash_executions` table and `capture.bashCommand` flag are
**deprecated** as of task `deprecate-bash-executions`. The table's code usage
has been removed; the table DDL is kept for backward compatibility with older
extension versions and can be dropped in a later task once all running agents
have upgraded. Agent bash tool calls continue to be recorded in
`tool_executions` (`tool_name='bash'`) as before. If richer per-command metrics
for **agent** bash tool calls are wanted, that is a feature request, not a bug
fix.
