# Telemetry database schema primer

`~/.pi/telemetry.db` contains 10 tables. All `*_unix_ms` columns are
INTEGER timestamps in **milliseconds since the Unix epoch**. Convert to a
pandas datetime with `pd.to_datetime(df['started_unix_ms'], unit='ms')`.

## Tables

### `sessions`

- **PK:** `session_id` TEXT
- **Parentage keys:** `parent_session_id`, `parent_run_id`
- **Key columns:** `agent_label`, `depth`, `name`, `cwd`, `pi_version`,
  `ext_version`, `start_reason`, `end_reason`
- **Timestamps:** `started_unix_ms` INTEGER NOT NULL, `ended_unix_ms` INTEGER

### `agent_runs`

- **PK:** `run_id` TEXT
- **FK / join key:** `session_id` TEXT NOT NULL → `sessions(session_id)`
- **Key columns:** `duration_ms`, `prompt_chars`, `system_prompt_chars`,
  `message_count`, `outcome`
- **Timestamps:** `started_unix_ms` INTEGER NOT NULL

### `turns`

- **PK:** `turn_id` TEXT
- **FKs / join keys:** `run_id` TEXT NOT NULL → `agent_runs(run_id)`;
  `session_id` TEXT NOT NULL
- **Key columns:** `turn_index` INTEGER NOT NULL, `provider`, `model`
- **Token buckets:** `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_write_tokens`, `total_tokens` (INTEGER)
- **Costs (USD, REAL):** `cost_input_usd`, `cost_output_usd`,
  `cost_cache_read_usd`, `cost_cache_write_usd`, `cost_total_usd`
- **Other:** `stop_reason`, `tool_result_count`, `context_tokens_at_start`,
  `duration_ms`
- **Timestamps:** `started_unix_ms` INTEGER NOT NULL
- **Indexes:** `idx_turns_session(session_id)`, `idx_turns_model(model)`

### `llm_requests`

- **PK:** `request_id` TEXT
- **FK / join key:** `turn_id` → `turns(turn_id)`; also `run_id`,
  `session_id` TEXT NOT NULL
- **Key columns:** `provider`, `model`
- **Latency:** `ttft_ms`, `stream_ms`, `duration_ms`
- **Tokens:** `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_write_tokens`
- **Cost:** `cost_total_usd` REAL
- **Other:** `stop_reason`, `http_status`, `retry_after_ms`
- **Timestamps:** `started_unix_ms` INTEGER NOT NULL
- **Indexes:** `idx_llm_session(session_id)`, `idx_llm_model(model)`

### `tool_executions`

- **PK:** `tool_call_id` TEXT
- **Join keys:** `turn_id`, `run_id`, `session_id` TEXT NOT NULL
- **Key columns:** `tool_name` TEXT NOT NULL
- **Outcome:** `is_error` INTEGER, `error_class`
- **Size / hashes:** `args_chars`, `result_chars`, `result_hash`
- **Full capture (only if capture flags enabled):** `args_json`,
  `result_text`
- **Timestamps:** `started_unix_ms` INTEGER NOT NULL, `duration_ms`
- **Indexes:** `idx_tool_session(session_id)`, `idx_tool_name(tool_name)`

### `bash_executions`

- **PK:** `bash_id` TEXT
- **Join key:** `session_id` TEXT NOT NULL
- **Key columns:** `cwd`, `exit_code`, `cancelled`, `truncated` INTEGER,
  `output_chars`, `exclude_from_context`, `command_chars`, `command_hash`
- **Timestamps:** `started_unix_ms` INTEGER NOT NULL, `duration_ms`

### `session_events`

- **PK:** `event_id` TEXT
- **Join key:** `session_id` TEXT NOT NULL
- **Key columns:** `type` TEXT NOT NULL, `payload` TEXT NOT NULL (JSON)
- **Timestamps:** `unix_ms` INTEGER NOT NULL
- **Indexes:** `idx_sev_session(session_id)`

### `feedback`

- **PK:** `feedback_id` TEXT
- **Join keys:** `session_id` TEXT NOT NULL, `run_id`, `turn_index`
- **Key columns:** `source` TEXT NOT NULL, `kind` TEXT NOT NULL,
  `data` TEXT NOT NULL (JSON)
- **Timestamps:** `received_unix_ms` INTEGER NOT NULL
- **Indexes:** `idx_feedback_kind(kind)`, `idx_feedback_source(source)`,
  `idx_feedback_time(received_unix_ms)`

### `telemetry_meta`

- **PK:** `id` INTEGER AUTOINCREMENT
- **Key columns:** `level` TEXT NOT NULL, `event` TEXT NOT NULL, `detail`,
  `session_id`
- **Timestamps:** `unix_ms` INTEGER NOT NULL

### `flush_log`

- **PK:** `id` INTEGER AUTOINCREMENT
- **Key columns:** `session_id`, `row_count` INTEGER NOT NULL,
  `tx_duration_ms` INTEGER NOT NULL
- **Timestamps:** `unix_ms` INTEGER NOT NULL

## Join map

```
sessions 1--* agent_runs    ON agent_runs.session_id = sessions.session_id
agent_runs 1--* turns         ON turns.run_id = agent_runs.run_id
turns 1--* llm_requests       ON llm_requests.turn_id = turns.turn_id
turns 1--* tool_executions    ON tool_executions.turn_id = turns.turn_id
sessions 1--* bash_executions ON bash_executions.session_id = sessions.session_id
sessions 1--* session_events  ON session_events.session_id = sessions.session_id
sessions 1--* feedback        ON feedback.session_id = sessions.session_id
```

`feedback` also carries `run_id` and `turn_index`, allowing finer-grained
joins to `agent_runs` and `turns`.

## Worked example join

Join a session through its runs, turns, and LLM requests:

```sql
SELECT
  s.session_id,
  s.name AS session_name,
  ar.run_id,
  ar.outcome AS run_outcome,
  t.turn_id,
  t.model,
  t.cost_total_usd AS turn_cost,
  lr.request_id,
  lr.duration_ms AS request_duration_ms
FROM sessions s
JOIN agent_runs ar  ON ar.session_id = s.session_id
JOIN turns t        ON t.run_id = ar.run_id
JOIN llm_requests lr ON lr.turn_id = t.turn_id
ORDER BY s.started_unix_ms DESC, t.turn_index
LIMIT 100;
```

Load with pandas:

```python
import pandas as pd
from telemetry_eval import connect

df = pd.read_sql_query(sql, con=connect())
```
