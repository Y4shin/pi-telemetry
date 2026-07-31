import { DatabaseSync } from "node:sqlite";
import type { TelemetryConfig } from "./config.ts";
import {
  type Telemetry,
  type RuntimeState,
  type MetaEvent,
  createRuntimeState,
} from "./state.ts";

interface QueuedStatement {
  sql: string;
  params: readonly (string | number | null)[];
}

export function createBuffer(
  config: TelemetryConfig,
  db: DatabaseSync,
  now = () => Date.now(),
): Telemetry {
  let closed = false;
  let buffer: QueuedStatement[] = [];
  let timer: NodeJS.Timeout | null = null;
  const state = createRuntimeState();

  const schedule = () => {
    if (timer) return;
    if (config.bufferFlushMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, config.bufferFlushMs);
  };

  const cancelTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const recordMeta = (
    level: "warn" | "error",
    event: MetaEvent,
    detail?: string,
  ) => {
    const params: (string | number | null)[] = [
      now(),
      level,
      event,
      detail ?? null,
      state.sessionId,
    ];
    try {
      db.exec("BEGIN IMMEDIATE");
      const stmt = db.prepare(
        "INSERT INTO telemetry_meta (unix_ms, level, event, detail, session_id) VALUES (?, ?, ?, ?, ?)",
      );
      stmt.run(...params);
      db.exec("COMMIT");
    } catch (err) {
      // Best-effort failed; swallow to avoid breaking the session.
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
  };

  const logFlush = (rowCount: number, txDurationMs: number) => {
    try {
      const stmt = db.prepare(
        "INSERT INTO flush_log (unix_ms, session_id, row_count, tx_duration_ms) VALUES (?, ?, ?, ?)",
      );
      stmt.run(now(), state.sessionId ?? null, rowCount, txDurationMs);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordMeta("error", "write_failed", detail);
    }
  };

  const applyOne = (stmt: QueuedStatement): boolean => {
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(stmt.sql).run(...stmt.params);
      db.exec("COMMIT");
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      recordMeta("error", "write_failed", `${stmt.sql} | ${detail}`);
      return false;
    }
  };

  const flush = () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    cancelTimer();
    const rowCount = batch.length;
    const startMs = now();
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const stmt of batch) {
        db.prepare(stmt.sql).run(...stmt.params);
      }
      db.exec("COMMIT");
    } catch (err) {
      // Fast-path batch failed. Roll back, then apply statements
      // individually so one bad row cannot poison unrelated rows or retry
      // forever. Offenders are logged and dropped.
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      let committed = 0;
      for (const stmt of batch) {
        if (applyOne(stmt)) {
          committed++;
        }
      }
      const txDurationMs = now() - startMs;
      if (committed > 0) {
        logFlush(committed, txDurationMs);
      }
      return;
    }
    const txDurationMs = now() - startMs;
    logFlush(rowCount, txDurationMs);
  };

  const enqueue = (
    sql: string,
    params: readonly (string | number | null)[],
  ) => {
    if (closed) {
      recordMeta("warn", "buffer_drop", "enqueue after close");
      return;
    }
    buffer.push({ sql, params });
    if (config.bufferMaxRows > 0 && buffer.length >= config.bufferMaxRows) {
      flush();
    } else {
      schedule();
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    cancelTimer();
    flush();
  };

  const meta = (
    level: "warn" | "error",
    event: MetaEvent,
    detail?: string,
  ) => {
    recordMeta(level, event, detail);
  };

  return {
    config,
    now,
    state,
    enqueue,
    meta,
    flush,
    close,
  };
}
