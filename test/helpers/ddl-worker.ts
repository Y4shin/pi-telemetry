import { openDatabase } from "../../src/db.ts";

const dbPath = process.env.PI_TELEMETRY_DDL_DB_PATH;

if (!dbPath) {
  throw new Error("ddl-worker missing PI_TELEMETRY_DDL_DB_PATH");
}

if (!process.send) {
  throw new Error("ddl-worker must be forked with IPC");
}

const send = (msg: unknown) => {
  try {
    process.send!(msg);
  } catch {
    // Parent may have gone away during shutdown; ignore.
  }
};

try {
  const db = openDatabase(dbPath);
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const tableCount = (
    db.prepare(
      "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='telemetry_meta'",
    ).get() as { n: number }
  ).n;
  db.close();

  send({ type: "ready", version, tableCount });

  process.once("message", (raw) => {
    const msg = raw as { type?: string };
    if (msg.type !== "start") return;
    send({ type: "done", version, tableCount });
    process.exit(0);
  });
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  send({ type: "error", detail });
  process.exit(1);
}
