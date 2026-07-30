import { describe, it } from "node:test";
import assert from "node:assert";
import { loadConfig } from "../src/config.ts";

describe("config", () => {
  it("returns defaults matching SPEC §7", () => {
    const config = loadConfig({});
    assert.strictEqual(config.enabled, true);
    assert.match(config.dbPath, /\.pi\/telemetry\.db$/);
    assert.strictEqual(config.bufferFlushMs, 2000);
    assert.strictEqual(config.bufferMaxRows, 50);
    assert.strictEqual(config.feedbackMaxBytes, 65536);
    assert.deepStrictEqual(config.capture, {
      toolArgs: false,
      toolResults: false,
      bashCommand: false,
    });
  });

  it("applies env overrides", () => {
    const config = loadConfig({
      PI_TELEMETRY_ENABLED: "false",
      PI_TELEMETRY_DB_PATH: "/tmp/telemetry.db",
      PI_TELEMETRY_BUFFER_FLUSH_MS: "100",
      PI_TELEMETRY_BUFFER_MAX_ROWS: "5",
      PI_TELEMETRY_FEEDBACK_MAX_BYTES: "1024",
    });
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.dbPath, "/tmp/telemetry.db");
    assert.strictEqual(config.bufferFlushMs, 100);
    assert.strictEqual(config.bufferMaxRows, 5);
    assert.strictEqual(config.feedbackMaxBytes, 1024);
  });

  it("merges settings.json block", () => {
    const settings = {
      "pi-telemetry": {
        dbPath: "/project/telemetry.db",
        capture: { toolArgs: true },
      },
    };
    const config = loadConfig({}, settings);
    assert.strictEqual(config.dbPath, "/project/telemetry.db");
    assert.strictEqual(config.capture.toolArgs, true);
    assert.strictEqual(config.capture.toolResults, false);
  });
});
