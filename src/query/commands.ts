import { statSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guardedQuery, type QueryResult } from "./sql-guard.ts";
import { runCanned } from "./canned.ts";
import { exportDatabase, type ExportOptions } from "./export.ts";

const MAX_CELL_WIDTH = 40;
const MAX_TABLE_WIDTH = 120;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (/\s/.test(ch) && !inQuotes) {
      if (current.length) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length) tokens.push(current);
  return tokens;
}

function parseTime(value: string, now: number): number | undefined {
  if (!value) return undefined;
  if (/^-?\d+$/.test(value)) return Number(value);
  const iso = Date.parse(value);
  if (!Number.isNaN(iso)) return iso;
  const m = value.match(/^(\d+)\s*([smhdw])$/i);
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

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.length <= MAX_CELL_WIDTH) return text;
  return text.slice(0, MAX_CELL_WIDTH - 1) + "…";
}

function formatTable(result: QueryResult): string[] {
  if (result.rows.length === 0) {
    return ["(no data)"];
  }

  const widths = result.columns.map((col, i) => {
    let w = String(col).length;
    for (const row of result.rows) {
      w = Math.max(w, renderCell(row[i]).length);
    }
    return Math.min(w, MAX_CELL_WIDTH);
  });

  // Keep every column wide enough for its header and a sensible minimum.
  const minWidths = result.columns.map((col) =>
    Math.min(MAX_CELL_WIDTH, Math.max(String(col).length, 8)),
  );

  // Shrink columns proportionally if the total width exceeds the TUI bound,
  // but never below the column minimum.
  let total = widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
  if (total > MAX_TABLE_WIDTH && widths.length > 0) {
    const excess = total - MAX_TABLE_WIDTH;
    const shrinkableSum = widths.reduce((sum, w, i) => sum + (w - minWidths[i]), 0);
    if (shrinkableSum > 0) {
      for (let i = 0; i < widths.length; i++) {
        const shrinkable = widths[i] - minWidths[i];
        const share = Math.floor((shrinkable / shrinkableSum) * excess);
        widths[i] = Math.max(minWidths[i], widths[i] - share);
      }
    }
  }

  const lines: string[] = [];
  lines.push(result.columns.map((c, i) => String(c).slice(0, widths[i]).padEnd(widths[i])).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of result.rows) {
    lines.push(
      row
        .map((v, i) => renderCell(v).slice(0, widths[i]).padEnd(widths[i]))
        .join("  "),
    );
  }
  return lines;
}

function formatResult(result: QueryResult): string {
  return formatTable(result).join("\n");
}

function notify(ctx: ExtensionCommandContext, text: string): void {
  ctx.ui?.notify?.(text, "info");
}

async function renderStatus(dbPath: string, t: Telemetry): Promise<string> {
  const stats = await guardedQuery(dbPath, `
    SELECT 'sessions' AS table_name, COUNT(*) AS rows FROM sessions
    UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs
    UNION ALL SELECT 'turns', COUNT(*) FROM turns
    UNION ALL SELECT 'llm_requests', COUNT(*) FROM llm_requests
    UNION ALL SELECT 'tool_executions', COUNT(*) FROM tool_executions
    UNION ALL SELECT 'session_events', COUNT(*) FROM session_events
    UNION ALL SELECT 'feedback', COUNT(*) FROM feedback
    UNION ALL SELECT 'telemetry_meta', COUNT(*) FROM telemetry_meta
  `);

  const meta = await guardedQuery(dbPath, `
    SELECT unix_ms, level, event, substr(coalesce(detail, ''), 1, 80) AS detail
    FROM telemetry_meta
    ORDER BY unix_ms DESC
    LIMIT 5
  `);

  let sizeText = "unknown";
  try {
    sizeText = `${statSync(dbPath).size} bytes`;
  } catch {
    // keep unknown
  }

  const lines: string[] = [
    `DB: ${dbPath}`,
    `Size: ${sizeText}`,
    "Tables:",
    ...formatTable(stats).map((l) => `  ${l}`),
    `Buffer: flushMs=${t.config.bufferFlushMs}, maxRows=${t.config.bufferMaxRows}`,
  ];

  if (meta.rows.length > 0) {
    lines.push("Last meta events:");
    lines.push(...formatTable(meta).map((l) => `  ${l}`));
  } else {
    lines.push("Last meta events: (none)");
  }

  return lines.join("\n");
}

async function renderSession(dbPath: string, t: Telemetry): Promise<string> {
  const sessionId = t.state.sessionId;
  if (!sessionId) {
    return "No active session.";
  }
  const result = await runCanned(dbPath, "session_summary", { sessionId });
  if (result.rows.length === 0) {
    return "No data for the active session.";
  }
  const row = result.rows[0];
  const lines: string[] = [];
  for (let i = 0; i < result.columns.length; i++) {
    const value = row[i] === null || row[i] === undefined ? "" : String(row[i]);
    lines.push(`${result.columns[i]}: ${value}`);
  }
  return lines.join("\n");
}

async function renderCost(dbPath: string, args: string, now: number): Promise<string> {
  const tokens = tokenize(args);
  const scope = tokens[1] ?? "today";
  let since: number | undefined;
  if (scope === "today") since = now - 24 * 60 * 60 * 1000;
  else if (scope === "week") since = now - 7 * 24 * 60 * 60 * 1000;
  else if (scope !== "all") return `Usage: /tm cost [today|week|all]`;

  const result = await runCanned(dbPath, "model_cost", { since });
  return formatResult(result);
}

async function renderSkills(dbPath: string): Promise<string> {
  const result = await runCanned(dbPath, "skill_cost");
  return formatResult(result);
}

async function renderErrors(dbPath: string, args: string, now: number): Promise<string> {
  const tokens = tokenize(args);
  let since: number | undefined;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === "--since" && i + 1 < tokens.length) {
      since = parseTime(tokens[i + 1], now);
      i++;
    }
  }
  const result = await runCanned(dbPath, "errors", { since });
  return formatResult(result);
}

async function renderFeedback(dbPath: string, args: string, now: number): Promise<string> {
  const tokens = tokenize(args);
  let since: number | undefined;
  let kind: string | undefined;
  let source: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === "--since" && i + 1 < tokens.length) {
      since = parseTime(tokens[i + 1], now);
      i++;
    } else if (tokens[i] === "--kind" && i + 1 < tokens.length) {
      kind = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--source" && i + 1 < tokens.length) {
      source = tokens[i + 1];
      i++;
    }
  }
  const result = await runCanned(dbPath, "feedback", { since, kind, source });
  return formatResult(result);
}

async function renderTree(dbPath: string, t: Telemetry): Promise<string> {
  const sessionId = t.state.sessionId;
  if (!sessionId) {
    return "No active session.";
  }
  const result = await runCanned(dbPath, "agent_tree", { sessionId });
  if (result.rows.length === 0) {
    return "No lineage data for the current session family.";
  }
  const depthIdx = result.columns.indexOf("depth");
  const labelIdx = result.columns.indexOf("agent_label");
  const idIdx = result.columns.indexOf("session_id");
  const parentIdx = result.columns.indexOf("parent_session_id");
  const lines: string[] = [];
  for (const row of result.rows) {
    const depth = depthIdx >= 0 ? (row[depthIdx] as number | null) ?? 0 : 0;
    const label = labelIdx >= 0 ? (row[labelIdx] as string | null) ?? "" : "";
    const id = idIdx >= 0 ? (row[idIdx] as string | null) ?? "" : "";
    const parent = parentIdx >= 0 ? (row[parentIdx] as string | null) ?? "" : "";
    const indent = "  ".repeat(Math.max(0, depth));
    const labelPart = label ? ` [${label}]` : "";
    const parentPart = parent ? ` <- ${parent}` : "";
    lines.push(`${indent}${id}${labelPart}${parentPart}`);
  }
  return lines.join("\n");
}

async function renderExport(dbPath: string, args: string, ctx: ExtensionCommandContext): Promise<string> {
  const tokens = tokenize(args);
  const options: ExportOptions = {};
  for (let i = 1; i < tokens.length; i++) {
    if ((tokens[i] === "--table" || tokens[i] === "-t") && i + 1 < tokens.length) {
      options.table = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--from" && i + 1 < tokens.length) {
      options.from = parseTime(tokens[i + 1], Date.now());
      i++;
    } else if (tokens[i] === "--to" && i + 1 < tokens.length) {
      options.to = parseTime(tokens[i + 1], Date.now());
      i++;
    } else if ((tokens[i] === "--out" || tokens[i] === "-o") && i + 1 < tokens.length) {
      options.out = tokens[i + 1];
      i++;
    }
  }

  if (!options.out) {
    return "Usage: /tm export [--table T] [--from time] [--to time] --out file.csv";
  }

  const written = await exportDatabase(dbPath, options);
  for (const path of written) {
    notify(ctx, `Wrote ${path}`);
  }
  return `Exported ${written.length} file(s):\n${written.map((p) => `  ${p}`).join("\n")}`;
}

async function renderSql(dbPath: string, args: string): Promise<string> {
  const sql = args.replace(/^\s*sql\s+/i, "").trim();
  if (!sql) {
    return "Usage: /tm sql \"SELECT ...\"";
  }
  const result = await guardedQuery(dbPath, sql);
  return formatResult(result);
}

async function handleCommand(
  args: string,
  dbPath: string,
  t: Telemetry,
  ctx: ExtensionCommandContext,
): Promise<string> {
  const trimmed = args.trim();
  const firstSpace = trimmed.search(/\s/);
  const subcommand = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);

  switch (subcommand) {
    case "":
    case "status":
      return renderStatus(dbPath, t);
    case "session":
      return renderSession(dbPath, t);
    case "cost":
      return renderCost(dbPath, trimmed, t.now());
    case "skills":
      return renderSkills(dbPath);
    case "errors":
      return renderErrors(dbPath, trimmed, t.now());
    case "feedback":
      return renderFeedback(dbPath, trimmed, t.now());
    case "tree":
      return renderTree(dbPath, t);
    case "export":
      return renderExport(dbPath, trimmed, ctx);
    case "sql":
      return renderSql(dbPath, trimmed);
    default:
      return `Unknown /tm subcommand: ${subcommand}\nUsage: /tm [status|session|cost|errors|feedback|tree|export|sql|skills]`;
  }
}

export function registerTelemetryCommands(pi: ExtensionAPI, t: Telemetry): void {
  const handler = async (args: string, ctx: ExtensionCommandContext): Promise<string> => {
    const dbPath = t.config.dbPath;
    if (!dbPath) {
      return "Telemetry DB path is not configured.";
    }
    try {
      const output = await handleCommand(args, dbPath, t, ctx);
      notify(ctx, output.split("\n")[0]);
      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `Telemetry query failed: ${message}`);
      return `Telemetry query failed: ${message}`;
    }
  };

  pi.registerCommand("telemetry", {
    description:
      "Telemetry query surface. Subcommands: status, session, cost [today|week|all], errors [--since], feedback [--kind --source --since], tree, export [--table --from --to --out], sql \"SELECT ...\", skills",
    handler: handler as unknown as (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  });

  pi.registerCommand("tm", {
    description:
      "Telemetry query surface. Subcommands: status, session, cost [today|week|all], errors [--since], feedback [--kind --source --since], tree, export [--table --from --to --out], sql \"SELECT ...\", skills",
    handler: handler as unknown as (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  });
}
