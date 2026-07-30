import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, MIGRATIONS } from "../src/db.ts";

const TABLES = [
  "sessions",
  "agent_runs",
  "turns",
  "llm_requests",
  "tool_executions",
  "bash_executions",
  "session_events",
  "feedback",
  "telemetry_meta",
];

describe("db", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
    dbPath = join(tmp, "telemetry.db");
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("creates all 9 tables on open", () => {
    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    for (const t of TABLES) {
      assert.ok(names.has(t), `missing table ${t}`);
    }
    db.close();
  });

  it("is idempotent on second open", () => {
    openDatabase(dbPath);
    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'")
      .get() as { c: number };
    assert.strictEqual(count.c, TABLES.length + 1); // + sqlite_sequence if AUTOINCREMENT used
    db.close();
  });

  it("sets user_version and migrations do not reapply", () => {
    openDatabase(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.strictEqual(version.user_version, MIGRATIONS.length);
    db.close();
  });
});
