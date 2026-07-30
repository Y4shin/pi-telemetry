import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

export interface QueryResult {
  readonly columns: string[];
  readonly rows: unknown[][];
  readonly truncated: boolean;
}

const ROW_LIMIT = 500;
const DEFAULT_TIMEOUT_MS = 3000;

function isReadOnlySelect(sql: string): boolean {
  return /^\s*(WITH\b|SELECT\b)/i.test(sql);
}

function hasLimitClause(sql: string): boolean {
  // Strip string literals so a LIMIT inside a literal does not count.
  const withoutStrings = sql.replace(/'[^']*'/g, "''");
  return /\bLIMIT\s+\d+/i.test(withoutStrings);
}

function injectLimit(sql: string, limit: number): string {
  const trimmed = sql.trimEnd().replace(/;+\s*$/, "");
  return `${trimmed} LIMIT ${limit}`;
}

function doQuery(dbPath: string, sql: string): QueryResult {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 });
  try {
    db.exec("PRAGMA query_only=ON");
    db.exec("PRAGMA busy_timeout=3000");
    const needsLimit = isReadOnlySelect(sql) && !hasLimitClause(sql);
    const guardedSql = needsLimit ? injectLimit(sql, ROW_LIMIT) : sql;
    const stmt = db.prepare(guardedSql);
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    const rawRows = (stmt.all() as unknown) as unknown[][];
    const rows = rawRows.slice(0, ROW_LIMIT);
    return { columns, rows, truncated: rawRows.length > ROW_LIMIT || rows.length >= ROW_LIMIT };
  } finally {
    try {
      db.close();
    } catch {
      // Closing a read-only connection should never fail, but swallow to avoid leaking throws.
    }
  }
}

if (!isMainThread && workerData && (workerData as Record<string, unknown>).__sqlGuardWorker) {
  const { dbPath, sql } = workerData as { dbPath: string; sql: string };
  try {
    const result = doQuery(dbPath, sql);
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function guardedQuery(
  dbPath: string,
  sql: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { __sqlGuardWorker: true, dbPath, sql },
    });

    const timer = setTimeout(() => {
      settled = true;
      worker.terminate();
      reject(new Error(`Query timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.on("message", (msg: { ok: boolean; result?: QueryResult; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (msg.ok && msg.result) {
        resolve(msg.result);
      } else {
        reject(new Error(msg.error ?? "Unknown worker error"));
      }
    });

    worker.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    worker.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Query worker exited unexpectedly (code ${code})`));
    });
  });
}
