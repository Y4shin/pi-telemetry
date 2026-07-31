---
title: bash_executions table never populated
status: reported
severity: major
reported: 2026-07-31
confirmed_by:
fix_commit:
promoted_to:
---

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

_To be filled during reproduction/triage._

## Fix summary

_To be filled after the fix._
