import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.ts";
import { createBuffer } from "../src/buffer.ts";
import type { TelemetryConfig } from "../src/config.ts";
import type { ExtensionContext, BashOperations, UserBashEventResult } from "@earendil-works/pi-coding-agent";
import { createL1Stub } from "./helpers/l1-stub.ts";
import { registerSessionCapture } from "../src/capture/index.ts";
import { registerBashCapture } from "../src/capture/bash.ts";

function makeConfig(dbPath: string, overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    enabled: true,
    dbPath,
    bufferFlushMs: 10000,
    bufferMaxRows: 100,
    feedbackMaxBytes: 65536,
    capture: { toolArgs: false, toolResults: false, bashCommand: false },
    ...overrides,
  };
}

async function setupSession(stub: ReturnType<typeof createL1Stub>, t: ReturnType<typeof createBuffer>, sessionId = "sess-bash") {
  registerSessionCapture(stub.pi, t);
  await stub.fire("session_start", { reason: "startup" }, {
    sessionManager: { getSessionId: () => sessionId } as ExtensionContext["sessionManager"],
    cwd: "/tmp/proj",
  });
}

describe("bash execution capture", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-bash-"));
    dbPath = join(tmp, "telemetry.db");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("records a bash_executions row for a successful command", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerBashCapture(stub.pi, t);

    const result = await stub.fire<UserBashEventResult>("user_bash", {
      command: "echo hello",
      excludeFromContext: false,
      cwd: tmp,
    });

    assert.ok(result?.operations, "operations should be returned");
    const ops = result.operations as BashOperations;
    let receivedData = "";
    const execResult = await ops.exec("echo hello", tmp, {
      onData: (data: Buffer) => { receivedData += data.toString("utf8"); },
    });
    t.flush();

    assert.strictEqual(execResult.exitCode, 0);
    const row = db.prepare("SELECT * FROM bash_executions WHERE session_id = ?").get("sess-bash") as Record<string, unknown>;
    assert.ok(row, "bash_executions row should exist");
    assert.strictEqual(row.session_id, "sess-bash");
    assert.strictEqual(row.cwd, tmp);
    assert.strictEqual(typeof row.started_unix_ms, "number");
    assert.strictEqual(typeof row.duration_ms, "number");
    assert.ok((row.duration_ms as number) >= 0);
    assert.strictEqual(row.exit_code, 0);
    assert.strictEqual(row.cancelled, 0);
    assert.strictEqual(row.truncated, 0);
    assert.strictEqual(row.exclude_from_context, 0);
    assert.strictEqual(row.command_chars, 10);
    assert.strictEqual(row.command_hash, "584a331fd6b02dcb1ecbe2eba731f609a2e1e3dac0bb73ae998dfad14c309a77");
    assert.strictEqual(typeof row.output_chars, "number");
    assert.ok((row.output_chars as number) > 0);
  });

  it("records exit_code for a failing command", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerBashCapture(stub.pi, t);

    const result = await stub.fire<UserBashEventResult>("user_bash", {
      command: "exit 7",
      excludeFromContext: false,
      cwd: tmp,
    });
    const ops = result!.operations as BashOperations;
    const execResult = await ops.exec("exit 7", tmp, { onData: () => {} });
    t.flush();

    assert.strictEqual(execResult.exitCode, 7);
    const row = db.prepare("SELECT * FROM bash_executions WHERE session_id = ?").get("sess-bash") as Record<string, unknown>;
    assert.strictEqual(row.exit_code, 7);
    assert.strictEqual(row.cancelled, 0);
    assert.strictEqual(row.truncated, 0);
  });

  it("marks exclude_from_context for !! prefix commands", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerBashCapture(stub.pi, t);

    const result = await stub.fire<UserBashEventResult>("user_bash", {
      command: "echo secret",
      excludeFromContext: true,
      cwd: tmp,
    });
    const ops = result!.operations as BashOperations;
    await ops.exec("echo secret", tmp, { onData: () => {} });
    t.flush();

    const row = db.prepare("SELECT * FROM bash_executions WHERE session_id = ?").get("sess-bash") as Record<string, unknown>;
    assert.strictEqual(row.exclude_from_context, 1);
  });

  it("marks truncated for oversized output", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerBashCapture(stub.pi, t);

    const result = await stub.fire<UserBashEventResult>("user_bash", {
      command: "big",
      excludeFromContext: false,
      cwd: tmp,
    });
    const ops = result!.operations as BashOperations;
    await ops.exec(`node -e "process.stdout.write('x'.repeat(60000))"`, tmp, { onData: () => {} });
    t.flush();

    const row = db.prepare("SELECT * FROM bash_executions WHERE session_id = ?").get("sess-bash") as Record<string, unknown>;
    assert.strictEqual(row.truncated, 1);
    assert.ok((row.output_chars as number) >= 60000);
  });

  it("rethrows and records best-effort row when exec throws", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerBashCapture(stub.pi, t);

    const result = await stub.fire<UserBashEventResult>("user_bash", {
      command: "echo hi",
      excludeFromContext: false,
      cwd: tmp,
    });
    const ops = result!.operations as BashOperations;

    await assert.rejects(async () => {
      await ops.exec("echo hi", "/nonexistent/cwd/12345", { onData: () => {} });
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM bash_executions WHERE session_id = ?").all("sess-bash") as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0, "expected best-effort row");
    const row = rows[rows.length - 1];
    assert.strictEqual(row.exit_code, null);
  });

  it("records cancelled when the abort signal fires", async () => {
    const stub = createL1Stub();
    const t = createBuffer(makeConfig(dbPath), db);
    await setupSession(stub, t);
    registerBashCapture(stub.pi, t);

    const result = await stub.fire<UserBashEventResult>("user_bash", {
      command: "sleep 10",
      excludeFromContext: false,
      cwd: tmp,
    });
    const ops = result!.operations as BashOperations;

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(async () => {
      await ops.exec("sleep 10", tmp, { onData: () => {}, signal: controller.signal });
    });
    t.flush();

    const rows = db.prepare("SELECT * FROM bash_executions WHERE session_id = ?").all("sess-bash") as Array<Record<string, unknown>>;
    const cancelledRow = rows.find((r) => r.cancelled === 1);
    assert.ok(cancelledRow, "expected a cancelled row");
  });
});
