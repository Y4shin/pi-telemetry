import { guardedQuery, type QueryResult } from "./sql-guard.ts";

export interface CannedFilters {
  since?: number;
  model?: string;
  kind?: string;
  source?: string;
  sessionId?: string;
  toolName?: string;
}

export interface Table extends QueryResult {
  readonly description: string;
}

export interface CannedEntry {
  readonly description: string;
  readonly sql: string;
}

const MARKER_RE = /--\s*\{\{(\w+):([\w.]+)\}\}/g;

function applyFilters(sql: string, filters: CannedFilters): string {
  const escapeString = (v: string) => `'${v.replace(/'/g, "''")}'`;
  return sql.replace(MARKER_RE, (_match, key: string, column: string) => {
    const value = filters[key as keyof CannedFilters];
    if (value === undefined || value === null) {
      return _match; // leave the comment in place; SQL remains valid
    }
    if (typeof value === "number") {
      return `AND ${column} >= ${value}`;
    }
    return `AND ${column} = ${escapeString(String(value))}`;
  });
}

export const CANNED: Record<string, CannedEntry> = {
  session_summary: {
    description: "Summary of a single session including runs, turns, cost, and lineage",
    sql: `
SELECT
  s.session_id,
  s.name,
  s.cwd,
  s.start_reason,
  s.end_reason,
  datetime(s.started_unix_ms/1000, 'unixepoch') AS started_at,
  datetime(s.ended_unix_ms/1000, 'unixepoch') AS ended_at,
  s.parent_session_id,
  s.parent_run_id,
  s.agent_label,
  s.depth,
  COUNT(DISTINCT r.run_id) AS runs,
  COUNT(DISTINCT t.turn_id) AS turns,
  COUNT(DISTINCT x.tool_call_id) AS tool_calls,
  ROUND(SUM(t.cost_total_usd), 6) AS cost_usd,
  SUM(t.total_tokens) AS tokens,
  SUM(t.tool_result_count) AS tool_results,
  ROUND(SUM(t.duration_ms), 0) AS duration_ms
FROM sessions s
LEFT JOIN agent_runs r ON r.session_id = s.session_id
LEFT JOIN turns t ON t.session_id = s.session_id
LEFT JOIN tool_executions x ON x.session_id = s.session_id
WHERE 1=1
  -- {{sessionId:s.session_id}}
GROUP BY s.session_id
LIMIT 1
`.trim(),
  },

  daily_cost: {
    description: "Cost and tokens grouped by day",
    sql: `
SELECT
  date(datetime(t.started_unix_ms/1000, 'unixepoch')) AS day,
  COUNT(*) AS turns,
  COUNT(DISTINCT t.model) AS models,
  ROUND(SUM(t.cost_total_usd), 6) AS cost_usd,
  SUM(t.total_tokens) AS tokens
FROM turns t
WHERE 1=1
  -- {{since:t.started_unix_ms}}
GROUP BY day
ORDER BY day DESC
LIMIT 500
`.trim(),
  },

  model_cost: {
    description: "Cost and tokens grouped by model, then day",
    sql: `
SELECT
  date(datetime(t.started_unix_ms/1000, 'unixepoch')) AS day,
  t.model,
  COUNT(*) AS turns,
  ROUND(SUM(t.cost_total_usd), 6) AS cost_usd,
  SUM(t.total_tokens) AS tokens
FROM turns t
WHERE 1=1
  -- {{since:t.started_unix_ms}}
  -- {{model:t.model}}
GROUP BY day, t.model
ORDER BY day DESC, t.model
LIMIT 500
`.trim(),
  },

  session_cost: {
    description: "Cost and tokens grouped by session",
    sql: `
SELECT
  s.session_id,
  s.name,
  datetime(s.started_unix_ms/1000, 'unixepoch') AS started_at,
  COUNT(t.turn_id) AS turns,
  ROUND(SUM(t.cost_total_usd), 6) AS cost_usd,
  SUM(t.total_tokens) AS tokens
FROM sessions s
LEFT JOIN turns t ON t.session_id = s.session_id
WHERE 1=1
  -- {{since:s.started_unix_ms}}
  -- {{sessionId:s.session_id}}
GROUP BY s.session_id
ORDER BY s.started_unix_ms DESC
LIMIT 500
`.trim(),
  },

  cache_hit_ratio: {
    description: "Cache-read ratio by model",
    sql: `
SELECT
  t.model,
  COUNT(*) AS turns,
  SUM(COALESCE(t.cache_read_tokens, 0)) AS cache_read,
  SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.cache_read_tokens, 0)) AS total_input,
  ROUND(
    100.0 * SUM(COALESCE(t.cache_read_tokens, 0)) /
    NULLIF(SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.cache_read_tokens, 0)), 0),
    2
  ) AS cache_hit_pct
FROM turns t
WHERE 1=1
  -- {{since:t.started_unix_ms}}
  -- {{model:t.model}}
GROUP BY t.model
ORDER BY cache_hit_pct DESC
LIMIT 500
`.trim(),
  },

  tool_failures: {
    description: "Tool failure counts and rates by tool name",
    sql: `
SELECT
  tool_name,
  COUNT(*) AS total,
  SUM(is_error) AS errors,
  ROUND(100.0 * SUM(is_error) / COUNT(*), 2) AS error_rate_pct,
  ROUND(AVG(duration_ms), 0) AS avg_duration_ms
FROM tool_executions
WHERE 1=1
  -- {{since:started_unix_ms}}
  -- {{toolName:tool_name}}
GROUP BY tool_name
ORDER BY error_rate_pct DESC, total DESC
LIMIT 500
`.trim(),
  },

  turn_latency: {
    description: "Turn duration percentiles by model",
    sql: `
WITH ranked AS (
  SELECT
    model,
    duration_ms,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY duration_ms) AS rn,
    COUNT(*) OVER (PARTITION BY model) AS n
  FROM turns
  WHERE duration_ms IS NOT NULL
    -- {{since:started_unix_ms}}
    -- {{model:model}}
)
SELECT
  model,
  COUNT(*) AS turns,
  ROUND(AVG(duration_ms), 0) AS avg_ms,
  MIN(duration_ms) AS min_ms,
  MAX(duration_ms) AS max_ms,
  MAX(CASE WHEN rn = (n / 2) + 1 THEN duration_ms END) AS median_ms,
  MAX(CASE WHEN rn = CAST(n * 0.95 AS INTEGER) + 1 THEN duration_ms END) AS p95_ms
FROM ranked
GROUP BY model
ORDER BY turns DESC
LIMIT 500
`.trim(),
  },

  context_growth: {
    description: "Context tokens at the start of each turn",
    sql: `
SELECT
  session_id,
  turn_index,
  model,
  datetime(started_unix_ms/1000, 'unixepoch') AS started_at,
  context_tokens_at_start,
  total_tokens
FROM turns
WHERE 1=1
  -- {{since:started_unix_ms}}
  -- {{sessionId:session_id}}
ORDER BY session_id, turn_index
LIMIT 500
`.trim(),
  },

  frequency_429: {
    description: "HTTP 429 frequency by provider and model",
    sql: `
SELECT
  provider,
  model,
  COUNT(*) AS total,
  SUM(CASE WHEN http_status = 429 THEN 1 ELSE 0 END) AS count_429,
  ROUND(100.0 * SUM(CASE WHEN http_status = 429 THEN 1 ELSE 0 END) / COUNT(*), 2) AS freq_429_pct
FROM llm_requests
WHERE 1=1
  -- {{since:started_unix_ms}}
  -- {{model:model}}
GROUP BY provider, model
ORDER BY count_429 DESC
LIMIT 500
`.trim(),
  },

  ttft_by_model: {
    description: "Time-to-first-token percentiles by model",
    sql: `
WITH ranked AS (
  SELECT
    model,
    ttft_ms,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY ttft_ms) AS rn,
    COUNT(*) OVER (PARTITION BY model) AS n
  FROM llm_requests
  WHERE ttft_ms IS NOT NULL
    -- {{since:started_unix_ms}}
    -- {{model:model}}
)
SELECT
  model,
  COUNT(*) AS requests,
  ROUND(AVG(ttft_ms), 0) AS avg_ttft_ms,
  MIN(ttft_ms) AS min_ttft_ms,
  MAX(ttft_ms) AS max_ttft_ms,
  MAX(CASE WHEN rn = (n / 2) + 1 THEN ttft_ms END) AS median_ttft_ms,
  MAX(CASE WHEN rn = CAST(n * 0.95 AS INTEGER) + 1 THEN ttft_ms END) AS p95_ttft_ms
FROM ranked
GROUP BY model
ORDER BY requests DESC
LIMIT 500
`.trim(),
  },

  feedback: {
    description: "Structured feedback rows, newest first",
    sql: `
SELECT
  received_unix_ms,
  source,
  kind,
  session_id,
  run_id,
  turn_index,
  substr(data, 1, 200) AS data_preview
FROM feedback
WHERE 1=1
  -- {{since:received_unix_ms}}
  -- {{kind:kind}}
  -- {{source:source}}
ORDER BY received_unix_ms DESC
LIMIT 500
`.trim(),
  },

  errors: {
    description: "Failed tools, non-2xx LLM responses, and meta errors",
    sql: `
SELECT 'tool' AS source, tool_name AS name, error_class AS detail, started_unix_ms AS unix_ms, session_id
FROM tool_executions
WHERE is_error = 1
  -- {{since:started_unix_ms}}
UNION ALL
SELECT 'llm' AS source, provider || '/' || model AS name, 'HTTP ' || http_status AS detail, started_unix_ms AS unix_ms, session_id
FROM llm_requests
WHERE http_status IS NOT NULL AND (http_status < 200 OR http_status >= 300)
  -- {{since:started_unix_ms}}
UNION ALL
SELECT 'meta' AS source, event AS name, detail, unix_ms, session_id
FROM telemetry_meta
WHERE level = 'error'
  -- {{since:unix_ms}}
ORDER BY unix_ms DESC
LIMIT 500
`.trim(),
  },

  agent_tree: {
    description: "Agent lineage sessions",
    sql: `
SELECT
  session_id,
  parent_session_id,
  parent_run_id,
  agent_label,
  depth,
  datetime(started_unix_ms/1000, 'unixepoch') AS started_at
FROM sessions
WHERE 1=1
  -- {{sessionId:session_id}}
ORDER BY started_unix_ms DESC
LIMIT 500
`.trim(),
  },

  skill_cost: {
    description: "Cost, tokens, and tool errors per skills_package_version and skill_name. Rows with no version or skill metadata are excluded.",
    sql: `
SELECT
  ver.value_text AS skills_package_version,
  skill.value_text AS skill_name,
  COUNT(*) AS invocations,
  ROUND(SUM(t.cost_total_usd), 6) AS cost_usd,
  SUM(t.total_tokens) AS tokens,
  SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_events se
JOIN session_event_metadata ver ON ver.event_id = se.event_id AND ver.key = 'skills_package_version'
JOIN session_event_metadata skill ON skill.event_id = se.event_id AND skill.key = 'skill_name'
JOIN turns t ON t.run_id = se.run_id
JOIN tool_executions te ON te.turn_id = t.turn_id
WHERE se.type = 'skill_invoke'
GROUP BY ver.value_text, skill.value_text
ORDER BY ver.value_text DESC, skill.value_text
LIMIT 500
`.trim(),
  },
};

export function runCanned(
  dbPath: string,
  name: string,
  filters: CannedFilters = {},
): Promise<Table> {
  const entry = CANNED[name];
  if (!entry) {
    return Promise.reject(new Error(`Unknown canned query: ${name}`));
  }
  const sql = applyFilters(entry.sql, filters);
  return guardedQuery(dbPath, sql).then((result) => ({
    description: entry.description,
    ...result,
  }));
}
