---
title: tool_executions INSERT fails UNIQUE on tool_call_id (duplicate inserts)
status: reported
severity: major
reported: 2026-07-31
confirmed_by:
fix_commit:
promoted_to:
---

# tool_executions INSERT fails UNIQUE on tool_call_id (duplicate inserts)

## Observed

`telemetry_meta` contains **457 `write_failed`** rows, all with the same
detail:

```
UNIQUE constraint failed: tool_executions.tool_call_id
```

Spread across 3 sessions:

| session_id                          | failures |
|-------------------------------------|----------|
| 019fb793-c2f0-7e95-88c1-c66a94cd59d3 | 289      |
| 019fb504-1c82-7997-8abf-4ddc2fb55241 | 96       |
| 019fb79c-4e4a-721a-b67c-5ad24cc3d2fa | 72       |

The failures are **spread over ~4-5 minutes within each session** (not a
single instantaneous burst), indicating the same `tool_call_id` reaches
`INSERT` more than once during normal operation — a systematic
double-insert, not a one-off retry.

Note: this is a **different** set of sessions from the "97 turns with tools
but 0 `tool_executions`" anomaly (which is session `019fb49e`). The two
symptoms are likely different root causes; this bug covers only the
duplicate-INSERT / UNIQUE-violation symptom.

## Expected

No UNIQUE constraint violations on `tool_executions.tool_call_id`, and no
`write_failed` rows for this constraint. Telemetry's contract is "never
drop data / never break the session," yet writes are silently failing.

## Reproduction

### Live DB (already confirmed)

```bash
cd ~/.pi/telemetry-eval && uv run python -c "
from telemetry_eval import connect
import pandas as pd
con = connect()
print(pd.read_sql_query(
  \"SELECT session_id, COUNT(*) AS n FROM telemetry_meta WHERE event='write_failed' GROUP BY session_id ORDER BY n DESC\",
  con).to_string(index=False))
"
# -> 3 sessions, 457 total, all 'UNIQUE constraint failed: tool_executions.tool_call_id'
```

### In-repo (code trace + L1 + L2)

1. **Code trace** — read `src/capture/tools.ts` (the `completedToolCallIds`
   dedup guard around `insertToolExecution`) and `src/buffer.ts` (whether
   committed rows are drained after a flush, or re-enqueued/re-flushed) to
   find the path by which a `tool_call_id` reaches `INSERT` twice.
2. **L1 unit test** — emit the triggering event sequence via
   `test/helpers/l1-stub.ts` and assert exactly one `tool_executions` row
   and **no** `telemetry_meta` `write_failed` row. Currently red.
3. **L2 SDK session** — drive a tool call through `test/helpers/l2-session.ts`
   with `fauxProvider` and confirm no `write_failed` row appears.

See `repro.md` for the exact scripts and the root-cause trace.

## Suspected area

`src/capture/tools.ts` (the `completedToolCallIds` / `inFlightTools` dedup
guard around `insertToolExecution`) and/or `src/buffer.ts` (rows not drained
after a committed flush, causing re-insert on a subsequent flush).

## Root cause

_To be filled during reproduction/triage._

## Fix summary

_To be filled after the fix._
