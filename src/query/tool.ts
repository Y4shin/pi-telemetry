import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { runCanned, type CannedFilters, type Table } from "./canned.ts";
import { guardedQuery, type QueryResult } from "./sql-guard.ts";

const PRESET_NAMES = [
  "session_cost",
  "daily_cost",
  "tool_failures",
  "feedback",
  "ttft_by_model",
  "context_growth",
  "agent_tree",
] as const;

type PresetName = typeof PRESET_NAMES[number];

function parseTime(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  const iso = Date.parse(trimmed);
  if (!Number.isNaN(iso)) return iso;
  const m = trimmed.match(/^(\d+)\s*([smhdw])$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const mult: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    };
    if (mult[unit] !== undefined) {
      return now - n * mult[unit];
    }
  }
  return undefined;
}

function buildFilters(params: Record<string, unknown>, now: number): CannedFilters {
  const filters: CannedFilters = {};
  if (typeof params.since === "string") {
    const since = parseTime(params.since, now);
    if (since !== undefined) filters.since = since;
  }
  if (typeof params.model === "string") filters.model = params.model;
  if (typeof params.kind === "string") filters.kind = params.kind;
  if (typeof params.source === "string") filters.source = params.source;
  if (typeof params.session === "string") filters.sessionId = params.session;
  if (typeof params.tool === "string") filters.toolName = params.tool;
  return filters;
}

function formatResult(result: Table | QueryResult) {
  const payload = {
    description: "description" in result ? result.description : "Raw SQL query",
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rows.length,
    truncated: result.truncated,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function registerTelemetryTool(pi: ExtensionAPI, t: Telemetry): void {
  pi.registerTool({
    name: "query_telemetry",
    label: "Query Telemetry",
    description:
      "Query the local pi-telemetry database. Use named presets (query) first: session_cost, daily_cost, tool_failures, feedback, ttft_by_model, context_growth, agent_tree. Optional filters: since, model, kind, source, session, tool. For custom analysis, supply raw sql as a SELECT statement (read-only, LIMIT 500 injected, 3s timeout).",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Named preset. Valid: session_cost, daily_cost, tool_failures, feedback, ttft_by_model, context_growth, agent_tree",
        }),
      ),
      sql: Type.Optional(
        Type.String({
          description: "Raw SELECT statement. Read-only; writes and schema changes are blocked by construction.",
        }),
      ),
      since: Type.Optional(
        Type.String({
          description: "Time filter: ISO timestamp, unix ms, or shorthand like 1h, 1d, 7d",
        }),
      ),
      model: Type.Optional(Type.String({ description: "Filter to a model ID" })),
      kind: Type.Optional(Type.String({ description: "Filter feedback to a kind" })),
      source: Type.Optional(Type.String({ description: "Filter feedback to a source" })),
      session: Type.Optional(Type.String({ description: "Filter to a session_id" })),
      tool: Type.Optional(Type.String({ description: "Filter tool_executions to a tool_name" })),
    }),
    async execute(_toolCallId, params) {
      const dbPath = t.config.dbPath;
      if (!dbPath) {
        throw new Error("Telemetry DB path is not configured.");
      }

      const query = typeof params.query === "string" ? params.query.trim() : "";
      const sql = typeof params.sql === "string" ? params.sql.trim() : "";
      const hasQuery = query.length > 0;
      const hasSql = sql.length > 0;

      if (hasQuery && hasSql) {
        throw new Error("Provide either query or sql, not both.");
      }
      if (!hasQuery && !hasSql) {
        throw new Error("Provide either query (preset name) or sql (raw SELECT).");
      }

      if (hasQuery) {
        if (!(PRESET_NAMES as readonly string[]).includes(query)) {
          throw new Error(`Unknown preset: ${query}. Valid presets: ${PRESET_NAMES.join(", ")}`);
        }
        const filters = buildFilters(params as Record<string, unknown>, t.now());
        const result = await runCanned(dbPath, query, filters);
        return formatResult(result);
      }

      const result = await guardedQuery(dbPath, sql);
      return formatResult(result);
    },
  });
}
