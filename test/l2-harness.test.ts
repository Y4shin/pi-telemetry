import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createL2Session } from "./helpers/l2-session.ts";
import piTelemetryExtension from "../index.ts";

describe("L2 harness", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-l2-"));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("SDK mock session with extension loaded creates and initializes DB", async () => {
    const dbPath = join(tmp, "telemetry.db");
    process.env.PI_TELEMETRY_DB_PATH = dbPath;

    const { session, cleanup } = await createL2Session({
      dbPath,
      extensionFactory: piTelemetryExtension,
    });

    // Wait briefly for session_start to run and DB to be initialized.
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(existsSync(dbPath), "DB file should be created");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    assert.ok(names.has("sessions"), "sessions table should exist");
    assert.ok(names.has("telemetry_meta"), "telemetry_meta table should exist");
    db.close();

    await cleanup();
    delete process.env.PI_TELEMETRY_DB_PATH;
  });
});
