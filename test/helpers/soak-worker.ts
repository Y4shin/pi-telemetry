import { openDatabase } from "../../src/db.ts";
import { createBuffer } from "../../src/buffer.ts";
import type { TelemetryConfig } from "../../src/config.ts";

const dbPath = process.env.PI_TELEMETRY_SOAK_DB_PATH;
const workerId = process.env.PI_TELEMETRY_SOAK_WORKER_ID;
const rowsPerWorker = Number(process.env.PI_TELEMETRY_SOAK_ROWS_PER_WORKER ?? "500");

if (!dbPath || workerId === undefined) {
  throw new Error("soak-worker missing env");
}

if (!process.send) {
  throw new Error("soak-worker must be forked with IPC");
}

const send = (msg: unknown) => {
  try {
    process.send!(msg);
  } catch (err) {
    // Parent may have gone away during shutdown; ignore.
  }
};

const config: TelemetryConfig = {
  enabled: true,
  dbPath,
  bufferFlushMs: 50,
  bufferMaxRows: 50,
  feedbackMaxBytes: 65536,
  capture: { toolArgs: false, toolResults: false, bashCommand: false },
};

const db = openDatabase(dbPath);
const t = createBuffer(config, db, () => Date.now());

// Seed a session row so meta rows have an attributable session_id.
const sessionId = `soak-${workerId}-${Date.now()}`;
t.enqueue("INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)", [sessionId, Date.now()]);
t.state.sessionId = sessionId;

send({ type: "ready", workerId });

process.once("message", (raw) => {
  const msg = raw as { type?: string };
  if (msg.type !== "start") return;

  const startMs = performance.now();

  for (let i = 0; i < rowsPerWorker; i++) {
    t.enqueue(
      "INSERT INTO telemetry_meta (unix_ms, level, event, detail, session_id) VALUES (?, ?, ?, ?, ?)",
      [Date.now(), "warn", "soak", `worker-${workerId}-row-${i}`, sessionId],
    );
  }

  t.flush();
  t.close();

  const elapsedMs = performance.now() - startMs;

  const busyRow = db
    .prepare(
      "SELECT COUNT(*) as n FROM telemetry_meta WHERE event = 'busy_retry' AND detail LIKE ?",
    )
    .get(`worker-${workerId}%`) as { n: number };
  const writeFailedRow = db
    .prepare(
      "SELECT COUNT(*) as n FROM telemetry_meta WHERE event = 'write_failed' AND detail LIKE '%BUSY%' AND detail LIKE ?",
    )
    .get(`worker-${workerId}%`) as { n: number };

  db.close();

  send({
    type: "done",
    workerId,
    rows: rowsPerWorker,
    elapsedMs,
    busyErrors: busyRow.n + writeFailedRow.n,
  });
  process.exit(0);
});
