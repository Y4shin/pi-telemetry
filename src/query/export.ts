import { writeFileSync } from "node:fs";
import { guardedQuery, type QueryResult } from "./sql-guard.ts";

const EXPORT_ROW_LIMIT = 10000;
const EXPORT_TIMEOUT_MS = 30000;

const ALL_TABLES = [
  "sessions",
  "agent_runs",
  "turns",
  "llm_requests",
  "tool_executions",
  "session_events",
  "feedback",
  "telemetry_meta",
];

export interface ExportOptions {
  table?: string;
  from?: number;
  to?: number;
  out?: string;
}

function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(result: QueryResult): string {
  const lines: string[] = [];
  lines.push(result.columns.map(escapeCsvCell).join(","));
  for (const row of result.rows) {
    lines.push((row as unknown[]).map(escapeCsvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

function timeColumn(table: string): string | null {
  switch (table) {
    case "sessions":
    case "agent_runs":
    case "turns":
    case "llm_requests":
    case "tool_executions":
      return "started_unix_ms";
    case "session_events":
    case "telemetry_meta":
      return "unix_ms";
    case "feedback":
      return "received_unix_ms";
    default:
      return null;
  }
}

function timeFilter(table: string, from?: number, to?: number): string {
  if (!from && !to) return "";
  const col = timeColumn(table);
  if (!col) return "";
  const conditions: string[] = [];
  if (from) conditions.push(`${col} >= ${from}`);
  if (to) conditions.push(`${col} <= ${to}`);
  return `WHERE ${conditions.join(" AND ")}`;
}

export async function exportTable(
  dbPath: string,
  table: string,
  from?: number,
  to?: number,
): Promise<QueryResult> {
  const filter = timeFilter(table, from, to);
  const sql = `SELECT * FROM ${table} ${filter} ORDER BY ROWID LIMIT ${EXPORT_ROW_LIMIT}`.trim();
  return guardedQuery(dbPath, sql, EXPORT_TIMEOUT_MS);
}

export async function exportDatabase(
  dbPath: string,
  options: ExportOptions,
): Promise<string[]> {
  const { table, from, to, out } = options;
  if (table) {
    const result = await exportTable(dbPath, table, from, to);
    const path = out ?? `${table}.csv`;
    writeFileSync(path, toCsv(result));
    return [path];
  }

  const written: string[] = [];
  for (const t of ALL_TABLES) {
    const result = await exportTable(dbPath, t, from, to);
    const path = out ? `${out}.${t}.csv` : `${t}.csv`;
    writeFileSync(path, toCsv(result));
    written.push(path);
  }
  return written;
}
