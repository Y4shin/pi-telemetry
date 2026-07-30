import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createL1Stub } from "./helpers/l1-stub.ts";
import piTelemetryExtension from "../index.ts";

describe("L1 harness", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-l1-"));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("stub-fired session_start creates DB and schema", async () => {
    const stub = createL1Stub();
    const dbPath = join(tmp, "telemetry.db");
    process.env.PI_TELEMETRY_DB_PATH = dbPath;

    piTelemetryExtension(stub.pi);

    await stub.fire("session_start", { reason: "startup" });

    assert.ok(existsSync(dbPath), "DB file should be created");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    assert.ok(names.has("telemetry_meta"));
    db.close();

    delete process.env.PI_TELEMETRY_DB_PATH;
  });
});
