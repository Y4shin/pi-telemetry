import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";
import { createBuffer } from "../src/buffer.ts";
import type { TelemetryConfig } from "../src/config.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createL1Stub } from "./helpers/l1-stub.ts";
import { registerSessionCapture } from "../src/capture/index.ts";
import { registerSessionEventsCapture } from "../src/capture/session-events.ts";

function makeConfig(dbPath: string): TelemetryConfig {
  return {
    enabled: true,
    dbPath,
    bufferFlushMs: 10000,
    bufferMaxRows: 100,
    feedbackMaxBytes: 65536,
    capture: { toolArgs: false, toolResults: false, bashCommand: false },
  };
}

async function setupSession(stub: ReturnType<typeof createL1Stub>, t: ReturnType<typeof createBuffer>) {
  registerSessionCapture(stub.pi, t);
  await stub.fire("session_start", { reason: "startup" }, {
    sessionManager: { getSessionId: () => "sess-events" } as ExtensionContext["sessionManager"],
    cwd: "/tmp/proj",
  });
}

describe("session events capture", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-session-events-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("session_before_compact writes a compaction row", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    await stub.fire("session_before_compact", {
      preparation: { tokensBefore: 90000 },
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ?").all("sess-events") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.type, "compaction");
    const payload = JSON.parse(row.payload as string);
    assert.strictEqual(payload.reason, "threshold");
    assert.strictEqual(payload.tokens_before, 90000);
    assert.strictEqual(payload.will_retry, false);
  });

  it("session_compact writes a compaction row with from_extension", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    await stub.fire("session_compact", {
      compactionEntry: { tokensBefore: 80000 },
      fromExtension: true,
      reason: "manual",
      willRetry: true,
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ? AND type = ?").all("sess-events", "compaction") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload as string);
    assert.strictEqual(payload.reason, "manual");
    assert.strictEqual(payload.tokens_before, 80000);
    assert.strictEqual(payload.will_retry, true);
    assert.strictEqual(payload.from_extension, true);
  });

  it("model_select writes a model_change row", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    await stub.fire("model_select", {
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      previousModel: { provider: "openai", id: "gpt-4o" },
      source: "cycle",
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ?").all("sess-events") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].type, "model_change");
    const payload = JSON.parse(rows[0].payload as string);
    assert.strictEqual(payload.source, "cycle");
    assert.strictEqual(payload.from.provider, "openai");
    assert.strictEqual(payload.from.id, "gpt-4o");
    assert.strictEqual(payload.to.provider, "anthropic");
    assert.strictEqual(payload.to.id, "claude-sonnet-4");
  });

  it("model_select without previous model omits from field", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    await stub.fire("model_select", {
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      previousModel: undefined,
      source: "restore",
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ?").all("sess-events") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload as string);
    assert.strictEqual(payload.source, "restore");
    assert.strictEqual(payload.from, undefined);
    assert.strictEqual(payload.to.id, "claude-sonnet-4");
  });

  it("thinking_level_select writes a thinking_change row", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    await stub.fire("thinking_level_select", {
      previousLevel: "low",
      level: "high",
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ?").all("sess-events") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].type, "thinking_change");
    const payload = JSON.parse(rows[0].payload as string);
    assert.strictEqual(payload.from_level, "low");
    assert.strictEqual(payload.to_level, "high");
  });

  it("session_before_fork writes a branch row", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    await stub.fire("session_before_fork", {
      entryId: "entry-123",
      position: "before",
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ?").all("sess-events") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].type, "branch");
    const payload = JSON.parse(rows[0].payload as string);
    assert.strictEqual(payload.entry_id, "entry-123");
    assert.strictEqual(payload.position, "before");
  });

  it("session_tree writes a tree_nav row", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    await stub.fire("session_tree", {
      newLeafId: "leaf-new",
      oldLeafId: "leaf-old",
      summaryEntry: { id: "summary-1" },
      fromExtension: false,
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ?").all("sess-events") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].type, "tree_nav");
    const payload = JSON.parse(rows[0].payload as string);
    assert.strictEqual(payload.old_leaf_id, "leaf-old");
    assert.strictEqual(payload.new_leaf_id, "leaf-new");
    assert.strictEqual(payload.entry_id, "summary-1");
  });

  it("malformed payload fields are omitted rather than causing a throw", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    await assert.doesNotReject(async () => {
      await stub.fire("session_tree", {
        newLeafId: "leaf-new",
        // oldLeafId intentionally missing
      });
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ?").all("sess-events") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload as string);
    assert.strictEqual(payload.new_leaf_id, "leaf-new");
    assert.strictEqual(payload.old_leaf_id, undefined);
  });

  it("session_tree no-op move (same leaf) is still recorded", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    await stub.fire("session_tree", {
      newLeafId: "leaf-same",
      oldLeafId: "leaf-same",
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM session_events WHERE session_id = ?").all("sess-events") as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].type, "tree_nav");
    const payload = JSON.parse(rows[0].payload as string);
    assert.strictEqual(payload.old_leaf_id, "leaf-same");
    assert.strictEqual(payload.new_leaf_id, "leaf-same");
  });

  it("rows include unix_ms for ordering", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerSessionEventsCapture(stub.pi, t);

    const before = Date.now();
    await stub.fire("thinking_level_select", { previousLevel: "off", level: "medium" });
    t.flush();
    const after = Date.now();

    const row = db.prepare("SELECT * FROM session_events WHERE session_id = ?").get("sess-events") as Record<string, unknown>;
    assert.strictEqual(typeof row.unix_ms, "number");
    assert.ok((row.unix_ms as number) >= before);
    assert.ok((row.unix_ms as number) <= after);
  });

  it("event without session_id is skipped", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    registerSessionEventsCapture(stub.pi, t);

    await stub.fire("model_select", {
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      previousModel: undefined,
      source: "set",
    });
    t.flush();

    const count = db.prepare("SELECT COUNT(*) AS c FROM session_events").get() as { c: number };
    assert.strictEqual(count.c, 0);
  });
});
