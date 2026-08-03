import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/db.ts";
import { createBuffer } from "../../src/buffer.ts";
import { registerSkillCapture, resetSkillVersionCache } from "../../src/capture/skills.ts";
import { sha256, textLength } from "../../src/hash.ts";
import type { TelemetryConfig } from "../../src/config.ts";
import { createL1Stub } from "../helpers/l1-stub.ts";
import type { InputEvent, ExtensionContext, ExtensionAPI, SlashCommandInfo, TurnStartEvent } from "@earendil-works/pi-coding-agent";

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

function inputEvent(text: string, source: "interactive" | "rpc" | "extension"): InputEvent {
  return { type: "input", text, source };
}

describe("registerSkillCapture input handler", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-skill-capture-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  async function setupSession(stub: ReturnType<typeof createL1Stub>, t: ReturnType<typeof createBuffer>, sessionId: string) {
    resetSkillVersionCache();
    registerSkillCapture(stub.pi, t);
    await stub.fire("session_start", { reason: "startup" }, {
      sessionManager: { getSessionId: () => sessionId } as unknown as ExtensionContext["sessionManager"],
      cwd: "/tmp/proj",
    });
    t.state.sessionId = sessionId;
    t.flush();
  }

  function makeSkillCommand(name: string, skillPath: string, baseDir: string): SlashCommandInfo {
    return {
      name: `skill:${name}`,
      description: `${name} skill`,
      source: "skill",
      sourceInfo: { path: skillPath, source: "git", scope: "user", origin: "package", baseDir },
    };
  }

  function writePackageJson(dir: string, pkg: { name?: string; version?: string }): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  }

  it("records a skill_invoke row for /skill:foo bar baz", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-1");

    const result = await stub.fire("input", inputEvent("/skill:foo bar baz", "interactive"));
    t.flush();

    assert.deepStrictEqual(result, { action: "continue" });

    const rows = db
      .prepare("SELECT event_id, session_id, type, payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-1") as Array<{ event_id: string; session_id: string; type: string; payload: string }>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    assert.strictEqual(payload.skill_name, "foo");
    assert.strictEqual(payload.args_chars, textLength("bar baz"));
    assert.strictEqual(payload.args_hash, sha256("bar baz"));
    assert.strictEqual(payload.input_source, "interactive");
  });

  it("records skill_name metadata row", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-2");

    await stub.fire("input", inputEvent("/skill:foo bar baz", "interactive"));
    t.flush();

    const rows = db
      .prepare("SELECT event_id FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-2") as Array<{ event_id: string }>;
    assert.strictEqual(rows.length, 1);
    const eventId = rows[0].event_id;

    const meta = db
      .prepare("SELECT key, type, value_text FROM session_event_metadata WHERE event_id = ?")
      .all(eventId) as Array<{ key: string; type: string; value_text: string | null }>;
    assert.strictEqual(meta.length, 1);
    assert.strictEqual(meta[0].key, "skill_name");
    assert.strictEqual(meta[0].type, "string");
    assert.strictEqual(meta[0].value_text, "foo");
  });

  it("stores lastSkillInvokeEventId in state", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-3");

    await stub.fire("input", inputEvent("/skill:foo bar baz", "interactive"));
    t.flush();

    const rows = db
      .prepare("SELECT event_id FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-3") as Array<{ event_id: string }>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(t.state.lastSkillInvokeEventId, rows[0].event_id);
  });

  it("returns continue and records rpc source", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-rpc");

    const result = await stub.fire("input", inputEvent("/skill:foo bar baz", "rpc"));
    t.flush();

    assert.deepStrictEqual(result, { action: "continue" });
    const rows = db
      .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-rpc") as Array<{ payload: string }>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    assert.strictEqual(payload.input_source, "rpc");
  });

  it("records print mode as interactive source", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-print");

    await stub.fire("input", inputEvent("/skill:foo bar baz", "interactive"), { mode: "print" });
    t.flush();

    const rows = db
      .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-print") as Array<{ payload: string }>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    assert.strictEqual(payload.input_source, "interactive");
  });

  it("skips extension source entirely", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-ext");

    const result = await stub.fire("input", inputEvent("/skill:foo bar baz", "extension"));
    t.flush();

    assert.deepStrictEqual(result, { action: "continue" });
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .get("sess-skill-ext") as { c: number };
    assert.strictEqual(rows.c, 0);
  });

  it("ignores non-skill input", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-none");

    const result = await stub.fire("input", inputEvent("hello world", "interactive"));
    t.flush();

    assert.deepStrictEqual(result, { action: "continue" });
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .get("sess-skill-none") as { c: number };
    assert.strictEqual(rows.c, 0);
  });

  it("ignores /cmd input", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-cmd");

    const result = await stub.fire("input", inputEvent("/cmd something", "interactive"));
    t.flush();

    assert.deepStrictEqual(result, { action: "continue" });
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .get("sess-skill-cmd") as { c: number };
    assert.strictEqual(rows.c, 0);
  });

  it("handles no args", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-noargs");

    await stub.fire("input", inputEvent("/skill:foo", "interactive"));
    t.flush();

    const rows = db
      .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-noargs") as Array<{ payload: string }>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    assert.strictEqual(payload.skill_name, "foo");
    assert.strictEqual(payload.args_chars, 0);
    assert.strictEqual(payload.args_hash, sha256(""));
    assert.strictEqual(payload.input_source, "interactive");
  });

  it("handles args with newlines", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-newlines");

    const args = "line1\nline2\nline3";
    await stub.fire("input", inputEvent(`/skill:foo ${args}`, "interactive"));
    t.flush();

    const rows = db
      .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-newlines") as Array<{ payload: string }>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    assert.strictEqual(payload.args_chars, textLength(args));
    assert.strictEqual(payload.args_hash, sha256(args));
  });

  it("handles very long args", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-long");

    const args = "x".repeat(100_000);
    await stub.fire("input", inputEvent(`/skill:foo ${args}`, "interactive"));
    t.flush();

    const rows = db
      .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-long") as Array<{ payload: string }>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    assert.strictEqual(payload.args_chars, textLength(args));
    assert.strictEqual(payload.args_hash, sha256(args));
  });

  it("handles /skill: prefix with trailing space only", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-trailing");

    await stub.fire("input", inputEvent("/skill:foo ", "interactive"));
    t.flush();

    const rows = db
      .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-trailing") as Array<{ payload: string }>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    assert.strictEqual(payload.skill_name, "foo");
    assert.strictEqual(payload.args_chars, 0);
  });

  it("handles empty skill name gracefully", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-empty");

    await stub.fire("input", inputEvent("/skill:", "interactive"));
    t.flush();

    const rows = db
      .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
      .all("sess-skill-empty") as Array<{ payload: string }>;
    assert.strictEqual(rows.length, 1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    assert.strictEqual(payload.skill_name, "");
    assert.strictEqual(payload.args_chars, 0);
    assert.strictEqual(payload.input_source, "interactive");
  });

  it("does not leak arg text into any table", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-privacy");

    const secret = "super-secret-arg-value-42";
    await stub.fire("input", inputEvent(`/skill:foo ${secret}`, "interactive"));
    t.flush();

    const tables = [
      "session_events",
      "session_event_metadata",
      "telemetry_meta",
      "feedback",
      "sessions",
    ];
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
      for (const column of columns) {
        if (column.type.toUpperCase().includes("TEXT") || column.type.toUpperCase().includes("BLOB")) {
          const count = db
            .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column.name} LIKE ?`)
            .get(`%${secret}%`) as { c: number };
          assert.strictEqual(count.c, 0, `arg text leaked into ${table}.${column.name}`);
        }
      }
    }
  });

  it("does not throw on malformed text", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t, "sess-skill-malf");

    await assert.doesNotReject(async () => {
      await stub.fire("input", inputEvent("/skill:\u0000weird", "interactive"));
    });
    t.flush();
  });

  describe("skills package version", () => {
    it("stamps skill_source and skills_package_version from package.json", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "pkg", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "# foo");
      writePackageJson(join(tmp, "pkg"), { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-version-1");

      await stub.fire("input", inputEvent("/skill:foo bar", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-version-1") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.skill_source, "task-workflow");
      assert.strictEqual(payload.skills_package_version, "2.5.1");

      const meta = db
        .prepare("SELECT key, type, value_text FROM session_event_metadata WHERE event_id = (SELECT event_id FROM session_events WHERE session_id = ? AND type = 'skill_invoke')")
        .all("sess-version-1") as Array<{ key: string; type: string; value_text: string | null }>;
      const versionMeta = meta.find((m) => m.key === "skills_package_version");
      assert.ok(versionMeta, "expected skills_package_version metadata row");
      assert.strictEqual(versionMeta.type, "string");
      assert.strictEqual(versionMeta.value_text, "2.5.1");
    });

    it("produces nulls when skill has no enclosing package.json", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "orphan", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "# foo");

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-version-orphan");

      await stub.fire("input", inputEvent("/skill:foo bar", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-version-orphan") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.skill_source, null);
      assert.strictEqual(payload.skills_package_version, null);

      const meta = db
        .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE event_id = (SELECT event_id FROM session_events WHERE session_id = ? AND type = 'skill_invoke') AND key = 'skills_package_version'")
        .get("sess-version-orphan") as { c: number };
      assert.strictEqual(meta.c, 0);

      const metaError = db
        .prepare("SELECT COUNT(*) AS c FROM telemetry_meta WHERE event = 'handler_error'")
        .get() as { c: number };
      assert.strictEqual(metaError.c, 0);
    });

    it("produces null version when package.json has no version field", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "no-version", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "# foo");
      writePackageJson(join(tmp, "no-version"), { name: "task-workflow" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-version-noversion");

      await stub.fire("input", inputEvent("/skill:foo bar", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-version-noversion") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.skill_source, "task-workflow");
      assert.strictEqual(payload.skills_package_version, null);
    });

    it("produces nulls when package.json is unreadable", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "bad-json", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "# foo");
      writeFileSync(join(tmp, "bad-json", "package.json"), "{ not valid json");

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-version-badjson");

      await stub.fire("input", inputEvent("/skill:foo bar", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-version-badjson") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.skill_source, null);
      assert.strictEqual(payload.skills_package_version, null);
    });

    it("resolves version from a deeply nested skill sourceInfo.path", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "deep", "skills", "category", "implement-task");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "# implement-task");
      writePackageJson(join(tmp, "deep"), { name: "task-workflow", version: "2.4.0" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("implement-task", skillPath, skillDir)];
      await setupSession(stub, t, "sess-version-deep");

      await stub.fire("input", inputEvent("/skill:implement-task target", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-version-deep") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.skill_source, "task-workflow");
      assert.strictEqual(payload.skills_package_version, "2.4.0");
    });

    it("caches package.json reads across repeated invocations", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "cache", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "# foo");
      const pkgDir = join(tmp, "cache");
      writePackageJson(pkgDir, { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-version-cache");

      await stub.fire("input", inputEvent("/skill:foo first", "interactive"));
      await stub.fire("input", inputEvent("/skill:foo second", "interactive"));
      t.flush();

      const rows = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke' ORDER BY rowid")
        .all("sess-version-cache") as Array<{ payload: string }>;
      assert.strictEqual(rows.length, 2);
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        assert.strictEqual(payload.skills_package_version, "2.5.1");
      }

      // Mutate the package.json; a cached lookup would still report the old version.
      writePackageJson(pkgDir, { name: "task-workflow", version: "3.0.0" });
      await stub.fire("input", inputEvent("/skill:foo third", "interactive"));
      t.flush();

      const row3 = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke' ORDER BY rowid LIMIT 1 OFFSET 2")
        .get("sess-version-cache") as { payload: string };
      const payload3 = JSON.parse(row3.payload) as Record<string, unknown>;
      assert.strictEqual(payload3.skills_package_version, "2.5.1");
    });

    it("invalidates cache on resources_discover reload and re-resolves", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "reload", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "# foo");
      const pkgDir = join(tmp, "reload");
      writePackageJson(pkgDir, { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-version-reload");

      await stub.fire("input", inputEvent("/skill:foo first", "interactive"));
      t.flush();

      writePackageJson(pkgDir, { name: "task-workflow", version: "3.0.0" });
      await stub.fire("resources_discover", { type: "resources_discover", cwd: "/tmp/proj", reason: "reload" });

      await stub.fire("input", inputEvent("/skill:foo second", "interactive"));
      t.flush();

      const rows = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke' ORDER BY rowid")
        .all("sess-version-reload") as Array<{ payload: string }>;
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(JSON.parse(rows[0].payload).skills_package_version, "2.5.1");
      assert.strictEqual(JSON.parse(rows[1].payload).skills_package_version, "3.0.0");
    });
  });

  describe("turn_start backfill", () => {
    function turnStartEvent(turnIndex: number): TurnStartEvent {
      return { type: "turn_start", turnIndex, timestamp: Date.now() };
    }

    it("sets run_id/turn_id/turn_index on the most-recent skill_invoke row", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSession(stub, t, "sess-backfill-1");

      await stub.fire("input", inputEvent("/skill:foo bar", "interactive"));
      t.flush();

      const before = db
        .prepare("SELECT event_id, run_id, turn_id, turn_index FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-backfill-1") as { event_id: string; run_id: string | null; turn_id: string | null; turn_index: number | null };
      assert.strictEqual(before.run_id, null);
      assert.strictEqual(before.turn_id, null);
      assert.strictEqual(before.turn_index, null);

      const runId = "run-111";
      const turnId = "turn-222";
      t.state.runId = runId;
      t.state.turnId = turnId;
      t.state.turnIndex = 3;
      await stub.fire("turn_start", turnStartEvent(3));
      t.flush();

      const after = db
        .prepare("SELECT event_id, run_id, turn_id, turn_index FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-backfill-1") as { event_id: string; run_id: string; turn_id: string; turn_index: number };
      assert.strictEqual(after.run_id, runId);
      assert.strictEqual(after.turn_id, turnId);
      assert.strictEqual(after.turn_index, 3);

      const meta = db
        .prepare("SELECT key, type, value_text FROM session_event_metadata WHERE event_id = ? ORDER BY key")
        .all(after.event_id) as Array<{ key: string; type: string; value_text: string | null }>;
      const runMeta = meta.find((m) => m.key === "run_id");
      assert.ok(runMeta, "expected run_id metadata row");
      assert.strictEqual(runMeta.type, "string");
      assert.strictEqual(runMeta.value_text, runId);
    });

    it("does not touch skill_invoke rows when no skill input preceded the turn", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSession(stub, t, "sess-backfill-none");

      t.state.runId = "run-333";
      t.state.turnId = "turn-444";
      t.state.turnIndex = 1;
      await stub.fire("turn_start", turnStartEvent(1));
      t.flush();

      const count = db
        .prepare("SELECT COUNT(*) AS c FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-backfill-none") as { c: number };
      assert.strictEqual(count.c, 0);
    });

    it("back-fills only the most-recent of two skill inputs before one turn", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSession(stub, t, "sess-backfill-multi");

      await stub.fire("input", inputEvent("/skill:first alpha", "interactive"));
      await stub.fire("input", inputEvent("/skill:second beta", "interactive"));
      t.flush();

      const rows = db
        .prepare("SELECT event_id, payload, run_id, turn_id, turn_index FROM session_events WHERE session_id = ? AND type = 'skill_invoke' ORDER BY rowid")
        .all("sess-backfill-multi") as Array<{ event_id: string; payload: string; run_id: string | null; turn_id: string | null; turn_index: number | null }>;
      assert.strictEqual(rows.length, 2);
      const older = rows[0];
      const newer = rows[1];

      const runId = "run-555";
      const turnId = "turn-666";
      t.state.runId = runId;
      t.state.turnId = turnId;
      t.state.turnIndex = 2;
      await stub.fire("turn_start", turnStartEvent(2));
      t.flush();

      const updated = db
        .prepare("SELECT event_id, run_id, turn_id, turn_index FROM session_events WHERE event_id = ?")
        .get(newer.event_id) as { event_id: string; run_id: string | null; turn_id: string | null; turn_index: number | null };
      assert.strictEqual(updated.run_id, runId);
      assert.strictEqual(updated.turn_id, turnId);
      assert.strictEqual(updated.turn_index, 2);

      const stale = db
        .prepare("SELECT event_id, run_id, turn_id, turn_index FROM session_events WHERE event_id = ?")
        .get(older.event_id) as { event_id: string; run_id: string | null; turn_id: string | null; turn_index: number | null };
      assert.strictEqual(stale.run_id, null);
      assert.strictEqual(stale.turn_id, null);
      assert.strictEqual(stale.turn_index, null);
    });

    it("is a no-op when there is no active session", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSession(stub, t, "sess-backfill-nosession");

      await stub.fire("input", inputEvent("/skill:foo bar", "interactive"));
      t.flush();

      const before = db
        .prepare("SELECT event_id FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-backfill-nosession") as { event_id: string };

      t.state.sessionId = null;
      t.state.runId = "run-777";
      t.state.turnId = "turn-888";
      t.state.turnIndex = 1;
      await assert.doesNotReject(async () => {
        await stub.fire("turn_start", turnStartEvent(1));
      });
      t.flush();

      const after = db
        .prepare("SELECT run_id, turn_id, turn_index FROM session_events WHERE event_id = ?")
        .get(before.event_id) as { run_id: string | null; turn_id: string | null; turn_index: number | null };
      assert.strictEqual(after.run_id, null);
      assert.strictEqual(after.turn_id, null);
      assert.strictEqual(after.turn_index, null);
    });
  });

  describe("frontmatter metadata capture", () => {
    it("populates a single captured slug from positional args", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "frontmatter", "skills", "implement-task");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(
        skillPath,
        "---\nmetadata:\n  telemetry:\n    capture: target\n---\n# implement-task\n",
      );
      writePackageJson(join(tmp, "frontmatter"), { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("implement-task", skillPath, skillDir)];
      await setupSession(stub, t, "sess-frontmatter-1");

      await stub.fire("input", inputEvent("/skill:implement-task pi-telemetry", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT event_id, payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-frontmatter-1") as { event_id: string; payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.target, "pi-telemetry");

      const meta = db
        .prepare("SELECT key, type, value_text FROM session_event_metadata WHERE event_id = ? ORDER BY key")
        .all(row.event_id) as Array<{ key: string; type: string; value_text: string | null }>;
      const targetMeta = meta.find((m) => m.key === "target");
      assert.ok(targetMeta, "expected target metadata row");
      assert.strictEqual(targetMeta.type, "string");
      assert.strictEqual(targetMeta.value_text, "pi-telemetry");
    });

    it("populates multiple captured slugs positionally", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "frontmatter-multi", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(
        skillPath,
        "---\nmetadata:\n  telemetry:\n    capture: target,map\n---\n# foo\n",
      );
      writePackageJson(join(tmp, "frontmatter-multi"), { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-frontmatter-2");

      await stub.fire("input", inputEvent("/skill:foo mytask mymap", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT event_id, payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-frontmatter-2") as { event_id: string; payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.target, "mytask");
      assert.strictEqual(payload.map, "mymap");

      const meta = db
        .prepare("SELECT key, value_text FROM session_event_metadata WHERE event_id = ? ORDER BY key")
        .all(row.event_id) as Array<{ key: string; value_text: string | null }>;
      const captured = meta.filter((m) => m.key === "target" || m.key === "map");
      assert.strictEqual(captured.length, 2);
      assert.strictEqual(captured[0].key, "map");
      assert.strictEqual(captured[0].value_text, "mymap");
      assert.strictEqual(captured[1].key, "target");
      assert.strictEqual(captured[1].value_text, "mytask");
    });

    it("leaves capture fields null when SKILL.md has no capture key", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "frontmatter-none", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "---\nmetadata:\n  telemetry: {}\n---\n# foo\n");
      writePackageJson(join(tmp, "frontmatter-none"), { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-frontmatter-none");

      await stub.fire("input", inputEvent("/skill:foo mytask", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT event_id, payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-frontmatter-none") as { event_id: string; payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.target, undefined);

      const count = db
        .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE event_id = ? AND key = 'target'")
        .get(row.event_id) as { c: number };
      assert.strictEqual(count.c, 0);
    });

    it("supports named capture with --key=value syntax", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "frontmatter-named", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(
        skillPath,
        "---\nmetadata:\n  telemetry:\n    capture: target,map\n---\n# foo\n",
      );
      writePackageJson(join(tmp, "frontmatter-named"), { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-frontmatter-named");

      await stub.fire("input", inputEvent("/skill:foo --target=pi-telemetry mymap", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT event_id, payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-frontmatter-named") as { event_id: string; payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.target, "pi-telemetry");
      assert.strictEqual(payload.map, "mymap");
    });

    it("stores a JSON null when a captured arg is missing", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "frontmatter-missing", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(
        skillPath,
        "---\nmetadata:\n  telemetry:\n    capture: target,map\n---\n# foo\n",
      );
      writePackageJson(join(tmp, "frontmatter-missing"), { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-frontmatter-missing");

      await stub.fire("input", inputEvent("/skill:foo only-one", "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT event_id, payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-frontmatter-missing") as { event_id: string; payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.target, "only-one");
      assert.strictEqual(payload.map, null);

      const count = db
        .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE event_id = ? AND key = 'map'")
        .get(row.event_id) as { c: number };
      assert.strictEqual(count.c, 0);
    });

    it("skips non-slug captured values and stores a JSON null", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "frontmatter-privacy", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(
        skillPath,
        "---\nmetadata:\n  telemetry:\n    capture: target\n---\n# foo\n",
      );
      writePackageJson(join(tmp, "frontmatter-privacy"), { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-frontmatter-privacy");

      const raw = "not_a_slug";
      await stub.fire("input", inputEvent(`/skill:foo ${raw}`, "interactive"));
      t.flush();

      const row = db
        .prepare("SELECT event_id, payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-frontmatter-privacy") as { event_id: string; payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.target, null);

      const count = db
        .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE event_id = ? AND key = 'target'")
        .get(row.event_id) as { c: number };
      assert.strictEqual(count.c, 0);

      const leaked = db
        .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE value_text LIKE ?")
        .get(`%${raw}%`) as { c: number };
      assert.strictEqual(leaked.c, 0);
    });

    it("invalidates frontmatter cache on resources_discover reload", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "frontmatter-reload", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(
        skillPath,
        "---\nmetadata:\n  telemetry:\n    capture: target\n---\n# foo\n",
      );
      writePackageJson(join(tmp, "frontmatter-reload"), { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-frontmatter-reload");

      await stub.fire("input", inputEvent("/skill:foo alpha", "interactive"));
      t.flush();

      writeFileSync(
        skillPath,
        "---\nmetadata:\n  telemetry:\n    capture: target,map\n---\n# foo\n",
      );
      await stub.fire("resources_discover", { type: "resources_discover", cwd: "/tmp/proj", reason: "reload" });

      await stub.fire("input", inputEvent("/skill:foo beta gamma", "interactive"));
      t.flush();

      const rows = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke' ORDER BY rowid")
      .all("sess-frontmatter-reload") as Array<{ payload: string }>;
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(JSON.parse(rows[0].payload).target, "alpha");
      assert.strictEqual(JSON.parse(rows[1].payload).target, "beta");
      assert.strictEqual(JSON.parse(rows[1].payload).map, "gamma");
    });

    it("does not throw on malformed frontmatter", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      const skillDir = join(tmp, "frontmatter-bad", "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "---\nmetadata:\n  telemetry:\n    capture: target\n");
      writePackageJson(join(tmp, "frontmatter-bad"), { name: "task-workflow", version: "2.5.1" });

      (stub.pi as ExtensionAPI).getCommands = () => [makeSkillCommand("foo", skillPath, skillDir)];
      await setupSession(stub, t, "sess-frontmatter-bad");

      await assert.doesNotReject(async () => {
        await stub.fire("input", inputEvent("/skill:foo pi-telemetry", "interactive"));
      });
      t.flush();

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-frontmatter-bad") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.target, undefined);
    });
  });

  describe("telemetry_skill_context tool", () => {
    function turnStartEvent(turnIndex: number): TurnStartEvent {
      return { type: "turn_start", turnIndex, timestamp: Date.now() };
    }

    function findTool(stub: ReturnType<typeof createL1Stub>) {
      const tool = stub.tools.find((t) => t.name === "telemetry_skill_context");
      assert.ok(tool, "telemetry_skill_context tool should be registered");
      return tool!.definition as {
        execute: (toolCallId: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
      };
    }

    async function setupSkillInvoke(stub: ReturnType<typeof createL1Stub>, t: ReturnType<typeof createBuffer>, sessionId: string, runId: string, turnId: string) {
      await setupSession(stub, t, sessionId);
      await stub.fire("input", inputEvent("/skill:foo bar baz", "interactive"));
      t.flush();
      t.state.runId = runId;
      t.state.turnId = turnId;
      t.state.turnIndex = 1;
      await stub.fire("turn_start", turnStartEvent(1));
      t.flush();
    }

    it("returns success-neutral result", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSkillInvoke(stub, t, "sess-tool-1", "run-tool-1", "turn-tool-1");

      const def = findTool(stub);
      const result = await def.execute("tc-1", { sliceCount: 1 });

      assert.ok(result);
      assert.deepStrictEqual((result as { content: unknown }).content, [{ type: "text", text: "Recorded." }]);
      assert.deepStrictEqual((result as { details: unknown }).details, {});
    });

    it("enriches the current skill_invoke row and projects metadata", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSkillInvoke(stub, t, "sess-tool-2", "run-tool-2", "turn-tool-2");

      const def = findTool(stub);
      await def.execute("tc-2", {
        target: "pi-telemetry",
        map: "skill-workflow",
        slice: "swt-telemetry-skill-context-tool",
        sliceCount: 4,
        extra: { outcome: "success", retry: false },
      });
      t.flush();

      const row = db
        .prepare("SELECT event_id, payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-tool-2") as { event_id: string; payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.target, "pi-telemetry");
      assert.strictEqual(payload.map, "skill-workflow");
      assert.strictEqual(payload.slice, "swt-telemetry-skill-context-tool");
      assert.strictEqual(payload.slice_count, 4);
      assert.deepStrictEqual(payload.extra, { outcome: "success", retry: false });

      const meta = db
        .prepare("SELECT key, type, value_text, value_int, value_bool FROM session_event_metadata WHERE event_id = ? ORDER BY key")
        .all(row.event_id) as Array<{ key: string; type: string; value_text: string | null; value_int: number | null; value_bool: number | null }>;
      const byKey = new Map(meta.map((m) => [m.key, m]));
      assert.strictEqual(byKey.get("target")?.type, "string");
      assert.strictEqual(byKey.get("target")?.value_text, "pi-telemetry");
      assert.strictEqual(byKey.get("map")?.value_text, "skill-workflow");
      assert.strictEqual(byKey.get("slice")?.value_text, "swt-telemetry-skill-context-tool");
      assert.strictEqual(byKey.get("slice_count")?.type, "int");
      assert.strictEqual(byKey.get("slice_count")?.value_int, 4);
      assert.strictEqual(byKey.get("outcome")?.type, "string");
      assert.strictEqual(byKey.get("outcome")?.value_text, "success");
      assert.strictEqual(byKey.get("retry")?.type, "bool");
      assert.strictEqual(byKey.get("retry")?.value_bool, 0);
    });

    it("records a telemetry_meta note when no skill_invoke preceded the turn", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSession(stub, t, "sess-tool-noskill");
      t.state.runId = "run-noskill";
      t.state.turnId = "turn-noskill";
      t.state.turnIndex = 1;

      const def = findTool(stub);
      await def.execute("tc-3", { sliceCount: 1 });
      t.flush();

      const count = db
        .prepare("SELECT COUNT(*) AS c FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-tool-noskill") as { c: number };
      assert.strictEqual(count.c, 0);

      const meta = db
        .prepare("SELECT * FROM telemetry_meta WHERE session_id = ? AND event = 'handler_error'")
        .get("sess-tool-noskill") as Record<string, unknown>;
      assert.ok(meta, "expected handler_error meta row");
      assert.strictEqual(meta.level, "warn");
    });

    it("records a telemetry_meta note when called outside a turn", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSession(stub, t, "sess-tool-noturn");
      await stub.fire("input", inputEvent("/skill:foo bar", "interactive"));
      t.flush();
      // run_id/turn_id intentionally left null.

      const def = findTool(stub);
      await def.execute("tc-4", { sliceCount: 1 });
      t.flush();

      const meta = db
        .prepare("SELECT * FROM telemetry_meta WHERE session_id = ? AND event = 'handler_error'")
        .get("sess-tool-noturn") as Record<string, unknown>;
      assert.ok(meta, "expected handler_error meta row");

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-tool-noturn") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.slice_count, undefined);
    });

    it("merges multiple enrichments on the same row", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSkillInvoke(stub, t, "sess-tool-merge", "run-tool-merge", "turn-tool-merge");

      const def = findTool(stub);
      await def.execute("tc-5a", { sliceCount: 1, extra: { alpha: 1 } });
      await def.execute("tc-5b", { extra: { beta: 2 }, target: "pi-telemetry" });
      t.flush();

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-tool-merge") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.slice_count, 1);
      assert.strictEqual(payload.target, "pi-telemetry");
      assert.deepStrictEqual(payload.extra, { alpha: 1, beta: 2 });

      const eventRow = db
        .prepare("SELECT event_id FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-tool-merge") as { event_id: string };
      const count = db
        .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE event_id = ? AND key = 'slice_count'")
        .get(eventRow.event_id) as { c: number };
      assert.strictEqual(count.c, 1);
    });

    it("hashes non-slug extra string values", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSkillInvoke(stub, t, "sess-tool-privacy", "run-tool-privacy", "turn-tool-privacy");

      const secret = "super secret value 42";
      const def = findTool(stub);
      await def.execute("tc-6", { extra: { secret } });
      t.flush();

      const row = db
        .prepare("SELECT event_id, payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-tool-privacy") as { event_id: string; payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const extra = payload.extra as Record<string, unknown>;
      const hashed = extra.secret as string;
      assert.notStrictEqual(hashed, secret);
      assert.strictEqual(hashed, `${textLength(secret)}:${sha256(secret)}`);

      const leaked = db
        .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE value_text = ?")
        .get(secret) as { c: number };
      assert.strictEqual(leaked.c, 0);
    });

    it("hashes non-slug target/map/slice values", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSkillInvoke(stub, t, "sess-tool-slug", "run-tool-slug", "turn-tool-slug");

      const raw = "Not_A_Slug";
      const def = findTool(stub);
      await def.execute("tc-7", { target: raw });
      t.flush();

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-tool-slug") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.target, `${textLength(raw)}:${sha256(raw)}`);

      const leaked = db
        .prepare("SELECT COUNT(*) AS c FROM session_event_metadata WHERE value_text = ?")
        .get(raw) as { c: number };
      assert.strictEqual(leaked.c, 0);
    });

    it("records a meta note for unserializable extra values and returns success", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSkillInvoke(stub, t, "sess-tool-badextra", "run-tool-badextra", "turn-tool-badextra");

      const bad: Record<string, unknown> = {};
      bad.self = bad;

      const def = findTool(stub);
      const result = await def.execute("tc-8", { extra: bad, sliceCount: 7 });
      t.flush();

      assert.deepStrictEqual((result as { content: unknown }).content, [{ type: "text", text: "Recorded." }]);

      const row = db
        .prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'skill_invoke'")
        .get("sess-tool-badextra") as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      assert.strictEqual(payload.slice_count, 7);
      assert.deepStrictEqual(payload.extra, {});

      const meta = db
        .prepare("SELECT * FROM telemetry_meta WHERE session_id = ? AND event = 'handler_error' AND detail LIKE '%circular%'")
        .get("sess-tool-badextra") as Record<string, unknown> | undefined;
      assert.ok(meta, "expected handler_error meta row for circular extra");
    });

    it("does not throw when no session is active", async () => {
      const stub = createL1Stub();
      const t = createBuffer(makeConfig(dbPath), db);
      await setupSession(stub, t, "sess-tool-nosession");
      t.state.sessionId = null;
      t.state.runId = "run-nosession";
      t.state.turnId = "turn-nosession";

      const def = findTool(stub);
      await assert.doesNotReject(async () => {
        await def.execute("tc-9", { sliceCount: 1 });
      });
      t.flush();

      const meta = db
        .prepare("SELECT * FROM telemetry_meta WHERE event = 'handler_error'")
        .all() as Array<Record<string, unknown>>;
      assert.ok(meta.length > 0, "expected handler_error meta row");
    });
  });
});
