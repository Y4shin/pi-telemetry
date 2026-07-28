---
kind: idea
title: "pi-telemetry — Local-first observability for Pi workflows"
slug: pi-telemetry
status: ready
created_at: 2026-07-28T18:17:29Z
grilled_at: 2026-07-28T18:51:56Z
converted_to:
---

# pi-telemetry — Local-first observability for Pi workflows

A single Pi extension that captures session/agent/turn/LLM/tool telemetry into
**one centralized SQLite database** on the local filesystem. No servers, no
collectors, no dashboards — SQL is the query language, CSV export is the
interchange format, and Pi itself is a query client via commands
(`/telemetry` aka `/tm`) and an agent-facing tool (`query_telemetry`).

**Engine:** SQLite via `node:sqlite` `DatabaseSync` — zero npm deps.
**Central store:** `~/.pi/telemetry.db` (WAL), shared by all Pi processes.
**Privacy:** no content by default — lengths + SHA-256 hashes only; content
capture flags exist but ship disabled.

> The full, detailed spec lives in `SPEC.md` at the repo root. This doc is the
> living artifact for the grill-me session: it captures the idea and tracks the
> open decisions that must be settled before `/skill:create-task` can slice the
> work. Decisions folded in here supersede any conflicting line in `SPEC.md`
> until the spec is regenerated.

## Why (stated motivation)

§1.4 calls streaming metrics (TTFT `message_start`→first `message_update`, and
`stream_duration_ms`) the **primary motivation for the extension** — latencies
that are hard to get out of the OTLP/Grafana path. The local SQL store is
additionally valuable because the agent itself can query it (`query_telemetry`)
and answer "what did today cost?" / "which tool fails most?" without a dashboard.

## Decisions (grilling log)

- **[2026-07-28] Relationship to ObservMe → Independent alternative.**
  pi-telemetry is self-contained and written neutrally. It does **not** assume
  ObservMe exists or co-runs. "Replaces the OTLP-based
  `submit_workflow_feedback` pipeline" (§5) means it *offers a local
  alternative path* — it does **not** suppress or override the OTLP tool. If a
  user runs both extensions, every standard Pi event gets processed twice; that
  is the user's call, not something the spec must solve (though a one-line note
  in the spec is worth adding). Lineage (§4) defines pi-telemetry's **own**
  env-var contract (`PI_TELEMETRY_*`), mirroring ObservMe's propagation
  *pattern* as inspiration only — no dependency on ObservMe's integration API.
- **[2026-07-28] v1 scope → Full catalog as spec.** v1 = all 8 tables
  (`sessions`, `agent_runs`, `turns`, `llm_requests`, `tool_executions`,
  `bash_executions`, `session_events`, `feedback`, plus `telemetry_meta`), the
  `/tm` command surface, and the `query_telemetry` tool. Only lineage is
  deferred to phase 2. The "streaming metrics = primary motivation" framing
  explains *why the extension exists*, not *what ships first* — once the
  write-path infra exists, each extra table is a cheap incremental handler.
- **[2026-07-28] Concurrency claim → design target, §9 validates.** Keep the
  synchronous-flush / single-shared-WAL-DB design. Reframe §3's "Measured ~42k
  commits/s, 0 busy, 100 writers" as the **target** the §9 multi-process soak
  must reproduce, so the spec doesn't lean on an un-reproducible prior number.
  The design is sound (SQLite WAL + `busy_timeout=5000` + INSERT-only + batched
  commits is a well-understood pattern for ~100 low-rate writers). No fallback
  (per-process DB / async write-behind queue) unless the §9 soak shows busy
  contention or throughput collapse.
- **[2026-07-28] `query_telemetry` SQL surface → Presets primary + guarded
  raw SQL.** Named presets are the agent's primary path. The `sql` param stays
  as a constrained escape hatch: runs on a **read-only connection**
  (`DatabaseSync` `{readOnly:true}` + `PRAGMA query_only=ON` — writes and
  schema changes blocked by construction, no regex guard to bypass), results
  capped at a row limit with a `LIMIT 500` **injected if the query lacks one**,
  and a **3s statement timeout** kills runaway queries. Tool description steers
  the agent to presets first. `/tm sql` (human) uses the same guarded path.
- **[2026-07-28] Lineage in v1 → Ship the foundation.** v1 ships the env-var
  reader (reads `PI_TELEMETRY_*` at startup, stamps the `sessions` row) + the
  bus listener (subscribes to `pi-telemetry:agent.spawned`/`.completed`). No
  emitter exists yet, so `parent_*` stays NULL in vanilla use — but the
  contract is published and a power user or future orchestrator can opt in
  immediately. `/tm tree` + the `agent_tree` preset ship (flat trees until
  lineage data exists). Phase 2 = the pi-subagents emitter shim only. §9 gains
  a test that emits a bus event and asserts lineage stamps. Matches SPEC §4.
- **[2026-07-28] Feedback `source` convention → convention is enough.**
  Keep `source` self-declared on the bus path and hardcoded `"pi"` on the
  agent-tool path (§5.2). The trust model (§5.1: all local extensions trusted;
  `source` self-declared, not verified) already accepts this — enforcing a
  `source="pi"` reservation would add rejection logic for no security gain.
  No separate `origin` column; `source` already distinguishes agent-emitted
  (`pi`) from extension-emitted (plugin name) in practice. **Ordering:** no
  cross-path ordering guarantee; both insert with `received_unix_ms` and
  queries order by time. *(Folded recommendation — confirm at finish.)*
- **[2026-07-28] DB scope → one shared DB, configurable.**
  `~/.pi/telemetry.db` shared by all Pi processes on the machine is the point —
  cross-session / cross-project correlation lets the agent answer "what did
  today cost?" across all work. `dbPath` (§7) is already configurable for users
  who want per-project or per-profile isolation; no `scope` setting needed in
  v1. *(Folded recommendation — confirm at finish.)*
- **[2026-07-28] `submit_feedback` / `submit_workflow_feedback` coexistence
  → coexist, steer via description.** As an independent alternative,
  pi-telemetry does not suppress the OTLP `submit_workflow_feedback` tool. If
  both are registered, the agent sees two feedback tools; pi-telemetry's
  `submit_feedback` `description` should state it records to the **local**
  telemetry store (vs the OTLP tool's backend) so the agent chooses
  intentionally. No `promptGuidelines` hard-steering. *(Folded recommendation
  — confirm at finish.)*

## Shape (condensed from SPEC.md)

- **8 tables:** `sessions`, `agent_runs`, `turns`, `llm_requests`,
  `tool_executions`, `bash_executions`, `session_events` (generic JSON-payload
  table for compaction/model/thinking/branch/tree events),
  `feedback`, `telemetry_meta` (self-health: write failures, busy retries,
  buffer drops, feedback rejections).
- **Store facts, not aggregates:** one row per completed op; all
  rates/percentiles/cost-sums derived at query time. IDs are in-process UUIDs;
  `session_id` correlates nearly everything.
- **Write path:** one `DatabaseSync` per process, opened lazily at
  `session_start`, closed at `session_shutdown`. WAL + `synchronous=NORMAL` +
  `busy_timeout=5000`. In-memory buffer flushed every 2000ms or 50 rows in one
  `BEGIN…COMMIT`. Crash loses ≤2s. Failure → best-effort `telemetry_meta` row,
  handler swallows (telemetry must never break a session).
- **Lineage (§4):** two mechanisms — env vars across processes
  (`PI_TELEMETRY_PARENT_SESSION_ID` etc., same propagation pattern as
  ObservMe's integration API) and an in-process event bus
  (`pi-telemetry:agent.spawned`/`.completed`). **pi-subagents emits no bus
  events today; a shim is "phase 2". Phase 1 works without lineage —
  `parent_*` columns stay NULL.**
- **Feedback (§5):** generic intake replacing the OTLP-based
  `submit_workflow_feedback` pipeline. Inbound bus event
  `pi-telemetry:submit-feedback` (producers emit, no-op if absent) **and** an
  agent tool `submit_feedback` (forces `source="pi"`). Same validation/cap,
  one `feedback` table. Retrieval via `/telemetry feedback` and the
  `feedback` named query.
- **Query surface:** `/tm` subcommands (status/session/cost/errors/feedback/
  tree/export/sql) + `query_telemetry` tool (named presets + read-only SELECT
  guard) + external (`sqlite3`, DuckDB, pandas).
- **Config:** `pi-telemetry` block in settings.json; env overrides.
  Defaults: enabled, `~/.pi/telemetry.db`, flush 2000ms/50 rows,
  feedback cap 64KiB, all content flags off.
- **Migrations:** `PRAGMA user_version`, forward-only, idempotent DDL every
  startup. Producers only INSERT; new columns nullable/defaulted for
  multi-version coexistence.
- **Testing:** unit (handler→row vs in-memory sqlite + fake Pi events),
  multi-process writer soak (basis: "measured 42k commits/s, 0 busy, 100
  writers"), bus no-op/happy/malformed, privacy default-config run asserts
  zero content strings.
- **Non-goals:** live dashboards, alerting/SLOs, multi-host aggregation,
  real-time streaming, content-first capture, Prometheus/OTLP export. (A future
  `otlp-export` sidecar *could* read the same DB; the DB is the source of truth.)

## Environment facts (verified during grilling)

- Runtime Node **v24.18.0**; `node:sqlite` `DatabaseSync` is available and
  functional. Hard prereq satisfied.
- **ObservMe (`npm:@senad-d/observme`) is installed and active** in this
  environment. It captures the *same* standard Pi event categories
  (session/agent/turn/LLM/tool/bash/compaction/model/thinking) and exports via
  OTLP to Grafana/Tempo/Loki/Prometheus. It exposes a versioned integration API
  on the `observme:integration:request` bus channel (v1/v2, with
  `startSubagent`/`completeSubagent`/`wait`/`join` lifecycle + env propagation).
- No `submit_feedback` tool is registered by any installed extension today, so
  the proposed tool name is free. The `submit_workflow_feedback` OTLP tool
  present in the harness is not defined in ObservMe's `src/` — provenance
  unconfirmed (likely built-in or another package); no name collision either
  way.
- User has Grafana access (`aws-grafana` knowledge base, `grafana-plai-prod`
  MCP server) — the OTLP/Grafana stack is reachable, not hypothetical.

## Open questions

- [x] **[ROOT] Relationship to ObservMe** → Independent alternative (see
  Decisions). Self-contained; no ObservMe coupling; feedback "replacement" is a
  parallel local path, not suppression; lineage uses its own env-var contract.
- [x] **Primary motivation vs. catalog breadth** → Full v1 as spec (see
  Decisions). Streaming-metrics line explains existence, not ship-order;
  extra tables are cheap incremental handlers once write-path infra exists.
- [x] **`submit_workflow_feedback` coexistence** → Coexist, steer via tool
  description (see Decisions). No suppression; description notes local store.
- [x] **Lineage deferral** → Ship foundation in v1 (reader + listener,
  NULL until emitter); emitter shim is phase 2 (see Decisions).
- [x] **Concurrency-claim provenance** → Treat as design target; §9 soak
  validates (see Decisions). No fallback unless the soak fails.
- [x] **Feedback bus vs. tool; `source="pi"` convention** → Convention is
  enough; no `origin` column; no cross-path ordering guarantee (see Decisions).
- [x] **`query_telemetry` raw-SQL surface** → Presets primary + guarded raw
  SQL on a read-only connection, LIMIT 500 clamp, 3s timeout (see Decisions).
- [x] **DB scope & isolation** → One shared DB is the point;
  `dbPath` configurable for isolation (see Decisions).
