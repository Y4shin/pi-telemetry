import { describe, it } from "node:test";
import assert from "node:assert";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";

const SOAK_ENV = process.env.PI_TELEMETRY_SOAK;
const WORKER_COUNT = 100;
const ROWS_PER_WORKER = 500;
const TARGET_ROWS_PER_SECOND = 42_000;

const READY_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_MS = 60_000;
const SPAWN_STAGGER_MS = 10;

interface WorkerResult {
  workerId: string;
  rows: number;
  elapsedMs: number;
  busyErrors: number;
}

interface PendingWorker {
  child: ChildProcess;
  resolve: (result: WorkerResult) => void;
  reject: (err: Error) => void;
  ready: boolean;
  done: boolean;
}

function cleanupSoakFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch { /* ignore */ }
  }
}

function killAll(children: ChildProcess[], signal: NodeJS.Signals = "SIGKILL") {
  for (const child of children) {
    if (!child.killed && child.connected !== false) {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
  }
}

async function spawnWorkers(dbPath: string): Promise<{
  results: WorkerResult[];
  wallElapsedMs: number;
}> {
  const pending = new Map<string, PendingWorker>();
  const children: ChildProcess[] = [];
  let readyCount = 0;
  let failFastError: Error | null = null;

  const fail = (err: Error) => {
    if (failFastError) return;
    failFastError = err;
    killAll(children, "SIGKILL");
    for (const pw of pending.values()) {
      pw.reject(err);
    }
  };

  const spawnOne = (workerId: number): Promise<WorkerResult> => {
    return new Promise((resolve, reject) => {
      const child = fork(join(import.meta.dirname, "helpers", "soak-worker.ts"), [], {
        env: {
          ...process.env,
          PI_TELEMETRY_SOAK_DB_PATH: dbPath,
          PI_TELEMETRY_SOAK_WORKER_ID: String(workerId),
          PI_TELEMETRY_SOAK_ROWS_PER_WORKER: String(ROWS_PER_WORKER),
        },
        silent: true,
      });

      children.push(child);
      const pw: PendingWorker = { child, resolve, reject, ready: false, done: false };
      pending.set(String(workerId), pw);

      child.on("message", (msg: unknown) => {
        const m = msg as { type: string } & Partial<WorkerResult>;
        if (m.type === "ready") {
          pw.ready = true;
          readyCount++;
        } else if (m.type === "done" && !pw.done) {
          pw.done = true;
          pw.resolve({
            workerId: m.workerId ?? String(workerId),
            rows: m.rows ?? ROWS_PER_WORKER,
            elapsedMs: m.elapsedMs ?? 0,
            busyErrors: m.busyErrors ?? 0,
          });
        }
      });

      child.on("error", (err) => {
        if (!pw.ready) {
          fail(new Error(`soak worker ${workerId} errored before ready: ${err.message}`));
        }
        reject(err);
      });

      child.on("exit", (code, signal) => {
        if (!pw.ready) {
          fail(
            new Error(
              `soak worker ${workerId} exited before sending ready (code ${code}, signal ${signal})`,
            ),
          );
        } else if (!pw.done && code !== 0) {
          reject(new Error(`soak worker ${workerId} exited with code ${code} after ready`));
        }
      });
    });
  };

  // Stagger spawns to avoid a thundering herd of 100 simultaneous forks.
  const workerPromises: Promise<WorkerResult>[] = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    workerPromises.push(spawnOne(i));
    if (i < WORKER_COUNT - 1) {
      await new Promise((r) => setTimeout(r, SPAWN_STAGGER_MS));
    }
    if (failFastError) break;
  }

  // Ready-phase timeout: if not all workers are ready within READY_TIMEOUT_MS, kill everything.
  const readyTimeout = setTimeout(() => {
    fail(
      new Error(
        `ready-phase timeout: ${readyCount}/${WORKER_COUNT} workers reported ready within ${READY_TIMEOUT_MS}ms`,
      ),
    );
  }, READY_TIMEOUT_MS);

  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (failFastError) {
        clearTimeout(readyTimeout);
        reject(failFastError);
        return;
      }
      if (readyCount >= workerPromises.length) {
        clearTimeout(readyTimeout);
        resolve();
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });

  // All ready; broadcast start.
  const startMs = performance.now();
  for (const child of children) {
    try {
      child.send({ type: "start" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      fail(new Error(`failed to send start to a worker: ${detail}`));
    }
  }

  // Execution-phase timeout.
  const execTimeout = setTimeout(() => {
    killAll(children, "SIGKILL");
    failFastError = new Error(
      `execution timeout: workers did not finish within ${EXEC_TIMEOUT_MS}ms`,
    );
  }, EXEC_TIMEOUT_MS);

  try {
    const results = await Promise.all(workerPromises);
    const wallElapsedMs = performance.now() - startMs;
    return { results, wallElapsedMs };
  } finally {
    clearTimeout(execTimeout);
  }
}

describe("concurrency soak", () => {
  it("spawns 100 concurrent writers against a shared DB", async (t) => {
    if (SOAK_ENV !== "1") {
      t.skip("soak gated by PI_TELEMETRY_SOAK=1");
      return;
    }

    const tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-soak-"));
    const dbPath = join(tmp, "telemetry.db");

    try {
      // Pre-create the DB and schema in the parent so children only open an
      // existing database. This eliminates concurrent DDL on first start.
      const parentDb = openDatabase(dbPath);
      parentDb.close();

      const { results, wallElapsedMs } = await spawnWorkers(dbPath);

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const totalRows = (
        db.prepare("SELECT COUNT(*) as n FROM telemetry_meta WHERE event = 'soak'").get() as {
          n: number;
        }
      ).n;
      const totalBusyErrors = (
        db.prepare(
          "SELECT COUNT(*) as n FROM telemetry_meta WHERE event IN ('busy_retry', 'write_failed') AND detail LIKE '%BUSY%'",
        ).get() as { n: number }
      ).n;
      db.close();

      const perWorkerBusy = results.reduce((sum, r) => sum + r.busyErrors, 0);
      const aggregateRowsPerSecond = (totalRows / wallElapsedMs) * 1000;
      const workerElapsedTimes = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
      const meanWorkerElapsedMs =
        workerElapsedTimes.reduce((a, b) => a + b, 0) / workerElapsedTimes.length;
      const minWorkerElapsedMs = workerElapsedTimes[0];
      const maxWorkerElapsedMs = workerElapsedTimes[workerElapsedTimes.length - 1];

      const report = {
        workers: WORKER_COUNT,
        rowsPerWorker: ROWS_PER_WORKER,
        totalRowsInserted: totalRows,
        expectedRows: WORKER_COUNT * ROWS_PER_WORKER,
        wallElapsedMs: Math.round(wallElapsedMs),
        meanWorkerElapsedMs: Math.round(meanWorkerElapsedMs),
        minWorkerElapsedMs: Math.round(minWorkerElapsedMs),
        maxWorkerElapsedMs: Math.round(maxWorkerElapsedMs),
        aggregateRowsPerSecond: Math.round(aggregateRowsPerSecond),
        targetRowsPerSecond: TARGET_ROWS_PER_SECOND,
        busyErrors: totalBusyErrors,
        perWorkerBusyErrorSum: perWorkerBusy,
      };

      console.log("SOAK REPORT:", JSON.stringify(report, null, 2));

      assert.strictEqual(
        totalRows,
        WORKER_COUNT * ROWS_PER_WORKER,
        `expected ${WORKER_COUNT * ROWS_PER_WORKER} soak rows, got ${totalRows}`,
      );
      assert.strictEqual(
        totalBusyErrors,
        0,
        `expected 0 busy errors, got ${totalBusyErrors} (per-worker sum ${perWorkerBusy})`,
      );

      // Keep the §3 design target as the asserted bar. If the local environment
      // cannot reproduce it, the detailed report above documents the deviation.
      // We do not silently weaken the target.
      if (aggregateRowsPerSecond < TARGET_ROWS_PER_SECOND) {
        assert.fail(
          `aggregate throughput ${aggregateRowsPerSecond} rows/s is below target ${TARGET_ROWS_PER_SECOND} ` +
            `rows/s. This may be environmental contention or a real throughput collapse. ` +
            `Full report: ${JSON.stringify(report)}`,
        );
      }
    } finally {
      cleanupSoakFiles(dbPath);
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });
});
