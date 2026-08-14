# Telemetry Signals Inventory

**Generated:** 2026-08-14
**Source database:** `~/.pi/telemetry.db`
**Analysis method:** Read-only queries via `telemetry_eval` helpers (`scripts/` convention from the `telemetry-eval-analyze` skill)

## Scope of the source data

| Metric | Value |
|---|---|
| Date range | 2026-07-30 → 2026-08-14 (16 days) |
| Sessions | 248 |
| Agent runs | 770 |
| Turns | 8,279 |
| LLM requests | 8,262 |
| Tool executions | 7,520 |
| Total spend | $611.70 |
| Total tokens | ~1.1 billion |

## Tables and population status

| Status | Tables |
|---|---|
| Richly populated | `sessions`, `agent_runs`, `turns`, `llm_requests`, `tool_executions`, `telemetry_meta`, `flush_log` |
| Sparse but valuable | `session_events` (57), `session_event_metadata` (39), `feedback` (3) |
| Unused / deprecated | `bash_executions` (deprecated, 0 rows) |

### Capture-disabled columns

These columns exist in the schema but are 0% populated (capture flags off):

- `tool_executions.args_json` — 0%
- `tool_executions.result_text` — 0%

### Universally-null columns

These columns are present but never written in this database:

- `sessions.depth`
- `sessions.parent_run_id`
- `llm_requests.retry_after_ms`

Note: `tool_executions.error_class` is populated (4.5%), but every non-null value is the
literal string `unknown` — the error type is not being classified.

---

## The 7 signal families

### 1. Cost & spend

**Columns:** `turns.cost_input_usd`, `cost_output_usd`, `cost_cache_read_usd`,
`cost_cache_write_usd`, `cost_total_usd`; `llm_requests.cost_total_usd`

You have per-turn **and** per-request USD costs broken into input / output / cache-read /
cache-write components.

**What you can glean:**

- **Total spend by model.** Money is concentrated: `nebius/glm-5.2` ($173) and
  `sference/glm-5.2` ($164) account for over half of all spend. `claude-sonnet-4-6` is
  nearly free ($0.55) despite being a premium model.
- **Cost outliers / runaway sessions.** Max turn duration is 5.6M ms (~93 min), so
  long-running expensive sessions are detectable.
- **Cache economics.** `cache_read_tokens` vs `cache_write_tokens` per model shows
  which providers are actually caching. `sference` averages 136K cache-read/turn;
  `nebius/glm-5.2` shows 0 cache reads, meaning it is not caching and you are paying
  full input price repeatedly.
- **Cost-per-task** by joining to `agent_runs` / `feedback`.

**Observed spend by model (turns):**

| Model | Turns | Cost (USD) | Avg in | Avg out | Avg cache read |
|---|---:|---:|---:|---:|---:|
| nebius/glm-5.2 | 637 | 173.549 | 188,476 | 1,950 | 0 |
| sference/glm-5.2 | 3,924 | 163.573 | 3,463 | 524 | 135,876 |
| tensorx/kimi-k3 | 310 | 66.968 | 15,060 | 863 | 210,524 |
| tensorx/kimi-k2.7-code | 1,918 | 50.265 | 1,030 | 379 | 74,890 |
| tensorx/glm-5.2 | 907 | 33.690 | 7,110 | 830 | 59,848 |
| nebius/kimi-k3 | 144 | 10.271 | 19,356 | 884 | 118,076 |
| sference/kimi-k3 | 39 | 3.277 | 8,033 | 378 | 274,235 |
| tensorx/deepseek-v4-pro | 325 | 1.995 | 1,165 | 215 | 7,604 |
| claude-sonnet-4-6 | 17 | 0.547 | 1 | 1,182 | 16,358 |
| inceptron/glm-5.2 | 12 | 0.158 | 3,207 | 239 | 31,931 |
| inceptron/kimi-k2.7-Code | 6 | 0.038 | 4,573 | 138 | 12,488 |

### 2. Token & context dynamics

**Columns:** `turns.input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_write_tokens`, `total_tokens`, `context_tokens_at_start`

**What you can glean:**

- **Context window growth.** `context_tokens_at_start` does not grow linearly: it stays
  around 110K for the first 30 turns, then jumps to an average of 186K at turn 60+.
  This is the compaction signature.
- **Prompt bloat.** `nebius/glm-5.2` averages 188K input tokens/turn versus
  `kimi-k2.7-code`'s 1K — a large variance in how each model is used.
- **Cache efficiency.** Compare `cache_read` to `input` per model to see who benefits
  from prompt caching.
- **Compaction events.** `session_events.type = 'compaction'` (12 events) pinpoints
  exactly when sessions were compacted.

**Context growth by turn-index bucket:**

| Turn bucket | Turns | Avg context | Max context |
|---|---:|---:|---:|
| 00–04 | 2,745 | 113,182 | 628,424 |
| 05–14 | 2,442 | 104,853 | 597,264 |
| 15–29 | 1,469 | 115,623 | 618,709 |
| 30–59 | 759 | 125,588 | 544,109 |
| 60+ | 859 | 186,167 | 294,133 |

### 3. Latency & performance

**Columns:** `llm_requests.ttft_ms`, `stream_ms`, `duration_ms`;
`tool_executions.duration_ms`; `turns.duration_ms`

**What you can glean:**

- **TTFT is anomalous.** p50 = 0 ms, p99 = 1,286 ms. A zero TTFT is almost certainly a
  measurement gap (provider not returning true first-token time, or non-streaming
  requests). Only the tail is meaningful.
- **Streaming time.** p50 721 ms, p99 72.7s, max 819s (~13.6 min). Long generations
  are detectable.
- **Tool latency.** p50 23 ms (cheap reads), but p99 210s and max 5.5M ms (~92 min) —
  likely a `subagent_wait` or a hung bash call. Outliers are findable.
- **Per-model latency.** Join `llm_requests` on `model` to rank providers by speed.

**Latency percentiles (ms):**

| Metric | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|
| llm_requests.ttft_ms | 0 | 1 | 1,286 | 113,679 |
| llm_requests.stream_ms | 721 | 11,222 | 72,676 | 819,069 |
| llm_requests.duration_ms | 742 | 11,236 | 72,663 | 819,069 |
| tool_executions.duration_ms | 23 | 1,518 | 210,919 | 5,557,562 |
| turns.duration_ms | 2,997 | 27,503 | 297,554 | 5,597,421 |

### 4. Tool usage & failure patterns

**Columns:** `tool_executions.tool_name`, `is_error`, `error_class`, `args_chars`,
`result_chars`, `result_hash`, `duration_ms`

7,520 tool calls with counts, args/result sizes (chars + hashes), durations, and error
flags.

**What you can glean:**

- **Tool mix.** `bash` dominates (4,063 / 54%), then `read` (1,294), `edit` (801),
  `write` (329), `subagent` (185). This is the agent's working-style fingerprint.
- **Error hotspots (the useful part).** The task-workflow map tools fail
  systematically:
  - `task_map_finalizable` — 88.9% error rate (8/9 calls fail)
  - `task_map_tick` — 63.6% (7/11)
  - `task_assert_kind` — 42.9%
  - `browser_eval` — 12.5%, `task_finalizable` — 15.4%, `subagent` — 9.2%
- **Bash error rate.** 4.5% (184 failures) — the volume base rate.
- **You CANNOT see what failed.** `error_class` is always `unknown`, and
  `args_json` / `result_text` are 0% populated (capture flags off). Error counts and
  which tool failed are visible; error content is not.

**Error rate by tool (error-prone, sorted):**

| Tool | Calls | Errors | Error % |
|---|---:|---:|---:|
| task_map_finalizable | 9 | 8 | 88.9% |
| task_map_tick | 11 | 7 | 63.6% |
| task_assert_kind | 7 | 3 | 42.9% |
| task_finalizable | 13 | 2 | 15.4% |
| browser_eval | 56 | 7 | 12.5% |
| subagent | 185 | 17 | 9.2% |
| edit | 801 | 63 | 7.9% |
| browser_click | 44 | 3 | 6.8% |
| task_dependency_levels | 30 | 2 | 6.7% |
| ask_user_question | 81 | 5 | 6.2% |
| read | 1,294 | 27 | 2.1% |
| bash | 4,065 | 184 | 4.5% |

### 5. Agent topology & orchestration

**Columns:** `sessions.parent_session_id`, `agent_label`, `name`, `cwd`;
`agent_runs.outcome`; `session_events.type`

**What you can glean:**

- **Subagent fan-out.** 56% of sessions have a `parent_session_id` (139/248), and
  `agent_label` reveals a real multi-agent fleet: `worker` (36), `tdd-worker` (23),
  `land-worker` (19), `slice-verifier` (17), `deviation-reporter` (15),
  `reviewer` (12). You can map the parent→child tree and measure each role's cost and
  duration.
- **Run outcomes.** 668 `settled`, 62 `end`, 40 null. The 62 `end` outcomes are runs
  that stopped early — candidates for "why did this die?" analysis.
- **Session lifecycle.** `start_reason` is always `startup`; `end_reason` is `quit`
  (212) or null (36 still-active/aborted). `depth` is always null (parentage is
  tracked via `parent_session_id` instead).
- **Model switching.** `session_events.type = 'model_change'` (36 events) shows
  mid-session model swaps. `skill_invoke` (9) shows skill usage.

**Agent labels:**

| Agent label | Sessions |
|---|---:|
| (null) | 109 |
| worker | 36 |
| tdd-worker | 23 |
| land-worker | 19 |
| slice-verifier | 17 |
| deviation-reporter | 15 |
| task-workflow.ui-noter | 14 |
| reviewer | 12 |
| researcher | 2 |
| delegate | 1 |

### 6. Skill / workflow metadata

**Table:** `session_event_metadata` (EAV: `key`, `type`, `value_text`/`value_int`/`value_real`/`value_bool`)

Keys observed: `skill_name`, `skills_package_version`, `run_id`, `map`, `target`,
`slice_count`.

**What you can glean:**

- **Skill attribution.** Attribute a run's cost/tokens back to the skill that
  launched it (`implement-task`, `wayfinder`, etc.) and the map/slice it operated on.
- **Slice counts.** Measure per-slice work volume.
- Sparse (39 rows) but high-value when present.

### 7. Reliability / system health

**Tables:** `telemetry_meta`, `flush_log`, `feedback`

**What you can glean:**

- **Write failures dominate telemetry_meta.** 8,802 of 8,803 rows are
  `level=error, event=write_failed`. The telemetry pipeline is failing to write
  almost constantly. This is a serious data-integrity signal — you may be losing
  telemetry. The `detail` field (not expanded here) holds the root cause.
- **Flush performance.** `flush_log` (9,250 rows) gives `row_count` and
  `tx_duration_ms` per flush — track write throughput and backpressure.
- **Feedback is essentially empty.** Only 3 rows (`good` / `good` / `bad`, all
  `source=pi`). Human-coded quality signal is not being collected, so outcomes
  cannot currently be correlated to perceived quality.

---

## What you CANNOT glean (the gaps)

1. **Why tools fail.** `error_class` is always `unknown`; no args/result text is
   captured.
2. **True TTFT.** ~99% of `ttft_ms` values are 0; the metric is not meaningful at the
   median.
3. **Retries.** `retry_after_ms` is 100% null; API retry behavior is not measurable.
4. **User-perceived quality.** Only 3 feedback rows; satisfaction is not measurable.
5. **Error classification.** `bash_executions` (which had `exit_code`) is
   deprecated/empty.

---

## Recommended next analyses

Given the available signals, the highest-value questions that can actually be
answered:

1. **What is causing 8,802 write failures?** Pull `telemetry_meta.detail` grouped;
   this threatens all other data.
2. **Why do task-workflow map tools fail 60–90% of the time?** Drill
   `tool_executions` WHERE `tool_name LIKE 'task_map%'` AND `is_error=1`, join to
   sessions.
3. **Cache ROI by provider.** Which models actually save money via cache reads vs
   paying full input (`nebius/glm-5.2` appears to never cache).
4. **Subagent fleet efficiency.** Cost + duration + outcome per `agent_label` to find
   expensive or underperforming roles.
5. **Context compaction trigger.** Correlate `session_events='compaction'` with
   `context_tokens_at_start` to find the threshold and cost of compaction.

---

## Reproduction

The findings above were derived with read-only queries against the live database
using the `telemetry_eval` helpers. To re-run or extend the analysis, see the
`telemetry-eval-analyze` skill and place named scripts in
`~/.pi/telemetry-eval/scripts/`.
