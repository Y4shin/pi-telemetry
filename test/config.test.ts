import { describe, it } from "node:test";
import assert from "node:assert";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createRuntimeState, type Telemetry } from "../src/state.ts";
import { maybeEmitContentCaptureWarning } from "../src/capture/tools.ts";

const ENV_DB_PATH = join(tmpdir(), "pi-telemetry-config", "telemetry.db");

describe("config", () => {
  it("returns defaults matching SPEC §7", () => {
    const config = loadConfig({});
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.dbPath, join(homedir(), ".pi", "telemetry.db"));
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
      PI_TELEMETRY_DB_PATH: ENV_DB_PATH,
      PI_TELEMETRY_BUFFER_FLUSH_MS: "100",
      PI_TELEMETRY_BUFFER_MAX_ROWS: "5",
      PI_TELEMETRY_FEEDBACK_MAX_BYTES: "1024",
    });
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.dbPath, ENV_DB_PATH);
    assert.strictEqual(config.bufferFlushMs, 100);
    assert.strictEqual(config.bufferMaxRows, 5);
    assert.strictEqual(config.feedbackMaxBytes, 1024);
  });

  it("merges settings.json block", () => {
    const settings = {
      "pi-telemetry": {
        dbPath: join(tmpdir(), "pi-telemetry-config", "project.db"),
        capture: { toolArgs: true },
      },
    };
    const config = loadConfig({}, settings);
    assert.strictEqual(config.dbPath, join(tmpdir(), "pi-telemetry-config", "project.db"));
    assert.strictEqual(config.capture.toolArgs, true);
    assert.strictEqual(config.capture.toolResults, false);
  });

  it("expands a POSIX home prefix to the user's home directory", () => {
    const settings = { "pi-telemetry": { dbPath: "~/.pi/telemetry.db" } };
    const config = loadConfig({}, settings);
    assert.strictEqual(config.dbPath, join(homedir(), ".pi", "telemetry.db"));
  });

  it("expands a Windows home prefix to the user's home directory", () => {
    const settings = { "pi-telemetry": { dbPath: "~\\telemetry.db" } };
    const config = loadConfig({}, settings);
    assert.strictEqual(config.dbPath, join(homedir(), "telemetry.db"));
  });

  it("leaves shell-style home variables untouched", () => {
    // %USERPROFILE% and $HOME arrive verbatim from a settings file; expanding
    // them would make one config mean different things in different shells.
    const values = ["%USERPROFILE%\\telemetry.db", "$HOME/telemetry.db", "~"];
    for (const dbPath of values) {
      const config = loadConfig({}, { "pi-telemetry": { dbPath } });
      assert.strictEqual(config.dbPath, dbPath);
    }
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

const IS_WINDOWS = process.platform === "win32";

// The two blocks below assert the shape of the resolved path on the host that
// runs them. They are skipped on the other OS and executed by the matching job
// in .github/workflows/ci.yml.
describe(
  "config on Windows",
  { skip: IS_WINDOWS ? false : "POSIX host: runs in the CI windows-latest job" },
  () => {
    it("builds the default database path from the Windows home directory", () => {
      const config = loadConfig({});
      assert.strictEqual(config.dbPath, join(homedir(), ".pi", "telemetry.db"));
      assert.ok(isAbsolute(config.dbPath), `${config.dbPath} should be absolute`);
      assert.ok(!config.dbPath.includes("/"), `expected native separators, got ${config.dbPath}`);
    });

    it("expands a backslash home prefix into a native absolute path", () => {
      const config = loadConfig({}, { "pi-telemetry": { dbPath: "~\\telemetry.db" } });
      assert.strictEqual(config.dbPath, join(homedir(), "telemetry.db"));
      assert.ok(!config.dbPath.includes("/"), `expected native separators, got ${config.dbPath}`);
    });
  },
);

describe(
  "config on POSIX",
  { skip: IS_WINDOWS ? "Windows host: runs in the CI ubuntu-latest job" : false },
  () => {
    it("keeps the POSIX default database path byte-identical", () => {
      // Literal concatenation on purpose: this is the exact string the previous
      // `join(homedir(), p.slice(2))` produced and must keep producing.
      const config = loadConfig({});
      assert.strictEqual(config.dbPath, `${homedir()}/.pi/telemetry.db`);
    });

    it("expands a slash home prefix without changing the separator", () => {
      const config = loadConfig({}, { "pi-telemetry": { dbPath: "~/.pi/telemetry.db" } });
      assert.strictEqual(config.dbPath, `${homedir()}/.pi/telemetry.db`);
    });
  },
);
