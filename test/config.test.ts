import { describe, it } from "node:test";
import assert from "node:assert";
import { loadConfig } from "../src/config.ts";
import { createRuntimeState, type Telemetry } from "../src/state.ts";
import { maybeEmitContentCaptureWarning } from "../src/capture/tools.ts";

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
      toolErrorRaw: false,
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

  it("defaults capture.toolErrorRaw to false", () => {
    const config = loadConfig({});
    assert.strictEqual(config.capture.toolErrorRaw, false);
  });

  it("reads capture.toolErrorRaw from env", () => {
    const config = loadConfig({
      PI_TELEMETRY_CAPTURE_TOOL_ERROR_RAW: "1",
    });
    assert.strictEqual(config.capture.toolErrorRaw, true);
  });

  it("reads capture.toolErrorRaw from settings block", () => {
    const settings = {
      "pi-telemetry": { capture: { toolErrorRaw: true } },
    };
    const config = loadConfig({}, settings);
    assert.strictEqual(config.capture.toolErrorRaw, true);
  });

  it("env overrides settings for capture.toolErrorRaw off", () => {
    const settings = {
      "pi-telemetry": { capture: { toolErrorRaw: true } },
    };
    const config = loadConfig(
      { PI_TELEMETRY_CAPTURE_TOOL_ERROR_RAW: "0" },
      settings,
    );
    assert.strictEqual(config.capture.toolErrorRaw, false);
  });

  it("falls back to false for invalid capture.toolErrorRaw values", () => {
    const settings = {
      "pi-telemetry": { capture: { toolErrorRaw: "invalid" } },
    };
    const config = loadConfig({}, settings);
    assert.strictEqual(config.capture.toolErrorRaw, false);
  });

  it("emits the content-capture warning exactly once when a content flag is on", () => {
    const metaCalls: Array<{
      level: "warn" | "error";
      event: string;
      detail?: string;
    }> = [];
    const state = createRuntimeState();
    const config = loadConfig(
      {},
      { "pi-telemetry": { capture: { toolErrorRaw: true } } },
    );
    const t: Telemetry = {
      config,
      now: () => 1,
      state,
      enqueue: () => {},
      meta: (level, event, detail) => {
        metaCalls.push({ level, event, detail });
      },
      flush: () => {},
      close: () => {},
    };

    maybeEmitContentCaptureWarning(t);
    assert.strictEqual(metaCalls.length, 1);
    assert.strictEqual(metaCalls[0].level, "warn");
    assert.strictEqual(metaCalls[0].event, "content_capture_warning");
    assert.ok(
      String(metaCalls[0].detail).includes("toolErrorRaw"),
      "warning should mention the enabled flag",
    );

    maybeEmitContentCaptureWarning(t);
    assert.strictEqual(metaCalls.length, 1, "warning should fire only once");
  });

  it("does not emit the content-capture warning when all content flags are off", () => {
    const metaCalls: Array<{
      level: "warn" | "error";
      event: string;
      detail?: string;
    }> = [];
    const state = createRuntimeState();
    const config = loadConfig({});
    const t: Telemetry = {
      config,
      now: () => 1,
      state,
      enqueue: () => {},
      meta: (level, event, detail) => {
        metaCalls.push({ level, event, detail });
      },
      flush: () => {},
      close: () => {},
    };

    maybeEmitContentCaptureWarning(t);
    assert.strictEqual(metaCalls.length, 0);
  });
});
