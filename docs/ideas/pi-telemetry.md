---
kind: idea
title: "pi-telemetry — Local-first observability for Pi workflows"
slug: pi-telemetry
status: proposed
created_at: 2026-07-28T18:17:29Z
grilled_at:
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

- [ ] **[ROOT] Relationship to ObservMe.** The spec says pi-telemetry
  "replaces the OTLP-based `submit_workflow_feedback` pipeline" (§5) yet also
  mirrors ObservMe's privacy posture and integration-API propagation pattern
  (§4). ObservMe is actively installed. Is pi-telemetry a *replacement* (disable
  ObservMe), a *complement* (both run), or an *independent alternative* (don't
  assume either way; each user picks)? This decides the feedback fate, whether
  to reuse ObservMe's lineage API, and whether double-capture is a concern.
- [ ] **Primary motivation vs. catalog breadth.** §1.4 names streaming metrics
  (TTFT/stream duration) as the primary motivation, but the catalog spans 8
  tables + feedback + lineage + commands + query tool. Is the Phase 1 MVP the
  full catalog, or a streaming-metrics-first slice (turns + llm_requests +
  sessions) with the rest behind it?
- [ ] **`submit_workflow_feedback` replacement mechanics.** "Replaces" how,
  concretely — register a `submit_feedback` tool that shadows/overrides the
  OTLP one, or just provide a parallel path and leave the OTLP tool alone?
  What happens to existing OTLP-log consumers if the OTLP tool is suppressed?
- [ ] **Lineage deferral.** §4 defers the pi-subagents bus shim to phase 2 and
  ships v1 with `parent_*` NULL. Is NULL lineage acceptable for v1's value, or
  is correlation essential to the point of the extension?
- [ ] **Concurrency-claim provenance.** "Measured 42k commits/s, 0 busy, 100
  writers" is load-bearing for the synchronous-flush, single-shared-DB design.
  Was this actually measured on target hardware, or is it an estimate? If the
  latter, the flush strategy may need a fallback (per-process DB, async queue,
  etc.).
- [ ] **Feedback bus vs. tool; `source="pi"` convention.** §5 routes both the
  bus event and the agent tool into one `feedback` table, reserving
  `source="pi"` for the tool "by convention, not enforced." Is convention
  enough, or should the tool path be structurally distinguished? Any ordering
  guarantee between bus-emitted and tool-emitted feedback within a turn?
- [ ] **`query_telemetry` raw-SQL surface.** §6.2 offers named presets *and*
  read-only SELECT with a guard. How exposed is the raw-SQL path to the agent
  — is it expected to be the common path (needing strong resource limits /
  injection hardening) or an escape hatch? This sizes the security work.
- [ ] **DB scope & isolation.** `~/.pi/telemetry.db` is shared by *all* Pi
  processes on the machine (single-user, cross-project). Is project-scoped or
  per-profile isolation ever wanted, or is one big correlated DB the point?
