import { describe, it } from "node:test";
import assert from "node:assert";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";

const WORKER_COUNT = 5;
const READY_TIMEOUT_MS = 30_000;

interface WorkerResult {
  code: number;
  signal: NodeJS.Signals | null;
  error?: string;
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

async function spawnDdlWorkers(dbPath: string): Promise<WorkerResult[]> {
  const children: ChildProcess[] = [];
  const results: WorkerResult[] = [];
  let readyCount = 0;

  const spawnOne = (i: number): Promise<void> => {
    return new Promise((resolve) => {
      const child = fork(join(import.meta.dirname, "helpers", "ddl-worker.ts"), [], {
        env: {
          ...process.env,
          PI_TELEMETRY_DDL_DB_PATH: dbPath,
        },
        silent: true,
      });
      children.push(child);

      child.on("message", (msg: unknown) => {
        const m = msg as { type: string; detail?: string };
        if (m.type === "ready") {
          readyCount++;
        } else if (m.type === "error") {
          results[i] = { code: 1, signal: null, error: m.detail };
          resolve();
        } else if (m.type === "done") {
          resolve();
        }
      });

      child.on("error", (err) => {
        results[i] = { code: 1, signal: null, error: err.message };
        resolve();
      });

      child.on("exit", (code, signal) => {
        results[i] = results[i] ?? { code: code ?? 0, signal };
        resolve();
      });
    });
  };

  const promises: Promise<void>[] = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    promises.push(spawnOne(i));
  }

  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (readyCount >= WORKER_COUNT) {
        resolve();
        return;
      }
      if (Date.now() - start > READY_TIMEOUT_MS) {
        killAll(children, "SIGKILL");
        reject(new Error(`DDL ready-phase timeout: ${readyCount}/${WORKER_COUNT} ready`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });

  for (const child of children) {
    try {
      child.send({ type: "start" });
    } catch (err) {
      killAll(children, "SIGKILL");
      throw new Error("failed to send start to DDL worker");
    }
  }

  await Promise.all(promises);
  return results;
}

describe("idempotent schema init", () => {
  it("survives 5 concurrent first-starts against a fresh DB", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-ddl-"));
    const dbPath = join(tmp, "telemetry.db");

    try {
      const results = await spawnDdlWorkers(dbPath);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        assert.strictEqual(
          r.code,
          0,
          `DDL worker ${i} failed (code ${r.code}, signal ${r.signal}): ${r.error ?? ""}`,
        );
      }

      const db = openDatabase(dbPath);
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      const tableCount = (
        db.prepare(
          "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table'",
        ).get() as { n: number }
      ).n;
      db.close();

      assert.strictEqual(version, 2, "schema version should be 2 after concurrent first-starts");
      assert.ok(tableCount > 0, "schema tables should exist after concurrent first-starts");
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(`${dbPath}${suffix}`, { force: true });
        } catch { /* ignore */ }
      }
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });
});
