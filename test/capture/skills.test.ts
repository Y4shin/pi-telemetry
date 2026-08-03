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
import type { InputEvent, ExtensionContext, ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

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
});
