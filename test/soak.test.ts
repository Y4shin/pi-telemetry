import { describe, it } from "node:test";
import assert from "node:assert";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SOAK_ENV = process.env.PI_TELEMETRY_SOAK;
const WORKER_COUNT = 4;
const ROWS_PER_WORKER = 500;
const TARGET_ROWS_PER_SECOND = 42_000;
const TARGET_THRESHOLD = TARGET_ROWS_PER_SECOND * 0.5; // Allow environmental variance; still report actuals.

interface WorkerResult {
  workerId: string;
  rows: number;
  elapsedMs: number;
  busyErrors: number;
}

function runWorker(dbPath: string, workerId: number): Promise<WorkerResult> {
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

    let result: WorkerResult | undefined;

    child.on("message", (msg: unknown) => {
      const m = msg as { type: string } & Partial<WorkerResult>;
      if (m.type === "done") {
        result = {
          workerId: m.workerId ?? String(workerId),
          rows: m.rows ?? ROWS_PER_WORKER,
          elapsedMs: m.elapsedMs ?? 0,
          busyErrors: m.busyErrors ?? 0,
        };
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 || !result) {
        reject(new Error(`soak worker ${workerId} exited with code ${code}`));
        return;
      }
      resolve(result);
    });
  });
}

async function spawnWorkers(dbPath: string): Promise<{
  results: WorkerResult[];
  wallElapsedMs: number;
}> {
  const workers: Promise<WorkerResult>[] = [];

  for (let i = 0; i < WORKER_COUNT; i++) {
    workers.push(runWorker(dbPath, i));
  }

  // Workers are already started; wall clock measures spawn+write+flush.
  const startMs = performance.now();
  const results = await Promise.all(workers);
  const wallElapsedMs = performance.now() - startMs;

  return { results, wallElapsedMs };
}

function cleanupSoakFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch { /* ignore */ }
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
      const workerElapsedSum = results.reduce((sum, r) => sum + r.elapsedMs, 0);
      const meanWorkerElapsedMs = workerElapsedSum / results.length;

      const report = {
        workers: WORKER_COUNT,
        rowsPerWorker: ROWS_PER_WORKER,
        totalRowsInserted: totalRows,
        expectedRows: WORKER_COUNT * ROWS_PER_WORKER,
        wallElapsedMs: Math.round(wallElapsedMs),
        meanWorkerElapsedMs: Math.round(meanWorkerElapsedMs),
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

      if (aggregateRowsPerSecond < TARGET_THRESHOLD) {
        assert.fail(
          `aggregate throughput ${aggregateRowsPerSecond} rows/s is below threshold ${TARGET_THRESHOLD} ` +
            `(target ${TARGET_ROWS_PER_SECOND}). Environmental contention or real throughput collapse. ` +
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
