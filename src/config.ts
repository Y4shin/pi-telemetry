import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";

export interface CaptureConfig {
  toolArgs: boolean;
  toolResults: boolean;
  // DEPRECATED (task: deprecate-bash-executions): bashCommand is a reserved /
  // dead flag kept for backward compatibility. It is deprecated alongside the
  // bash_executions table and will be removed in a later cleanup.
  bashCommand: boolean;
}

export interface TelemetryConfig {
  enabled: boolean;
  dbPath: string;
  bufferFlushMs: number;
  bufferMaxRows: number;
  feedbackMaxBytes: number;
  capture: CaptureConfig;
}

const DEFAULTS: TelemetryConfig = {
  enabled: true,
  dbPath: join(homedir(), ".pi", "telemetry.db"),
  bufferFlushMs: 2000,
  bufferMaxRows: 50,
  feedbackMaxBytes: 65536,
  capture: {
    toolArgs: false,
    toolResults: false,
    // DEPRECATED (task: deprecate-bash-executions): default kept for backward
    // compatibility; the bash_executions capture path is removed.
    bashCommand: false,
  },
};

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function readSettingsFile(path: string): unknown {
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function loadMergedSettings(cwd: string, agentDir = join(homedir(), ".pi", "agent")): unknown {
  const global = readSettingsFile(join(agentDir, "settings.json")) as Record<string, unknown> | undefined;
  const project = readSettingsFile(join(resolve(cwd), ".pi", "settings.json")) as Record<string, unknown> | undefined;
  return {
    ...(global ?? {}),
    ...(project ?? {}),
  };
}

export function loadConfig(
  env: Record<string, string | undefined>,
  settings?: unknown,
): TelemetryConfig {
  const block =
    settings && typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)["pi-telemetry"] ?? {}
      : {};

  const fromBlock = block as Partial<{
    enabled: boolean | string;
    dbPath: string;
    bufferFlushMs: number | string;
    bufferMaxRows: number | string;
    feedbackMaxBytes: number | string;
    capture: Partial<CaptureConfig>;
  }>;

  const boolEnv = (key: string): boolean | undefined => {
    const v = env[key];
    if (v === undefined) return undefined;
    return v === "1" || v.toLowerCase() === "true";
  };

  const numEnv = (key: string): number | undefined => {
    const v = env[key];
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const strEnv = (key: string): string | undefined => {
    const v = env[key];
    return v === "" ? undefined : v;
  };

  const parseBool = (v: boolean | string | undefined): boolean | undefined => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
    return undefined;
  };

  const parseNum = (v: number | string | undefined): number | undefined => {
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };

  const dbPath =
    strEnv("PI_TELEMETRY_DB_PATH") ??
    (typeof fromBlock.dbPath === "string" ? expandPath(fromBlock.dbPath) : undefined) ??
    DEFAULTS.dbPath;

  return {
    enabled:
      boolEnv("PI_TELEMETRY_ENABLED") ??
      parseBool(fromBlock.enabled) ??
      DEFAULTS.enabled,
    dbPath,
    bufferFlushMs:
      numEnv("PI_TELEMETRY_BUFFER_FLUSH_MS") ??
      parseNum(fromBlock.bufferFlushMs) ??
      DEFAULTS.bufferFlushMs,
    bufferMaxRows:
      numEnv("PI_TELEMETRY_BUFFER_MAX_ROWS") ??
      parseNum(fromBlock.bufferMaxRows) ??
      DEFAULTS.bufferMaxRows,
    feedbackMaxBytes:
      numEnv("PI_TELEMETRY_FEEDBACK_MAX_BYTES") ??
      parseNum(fromBlock.feedbackMaxBytes) ??
      DEFAULTS.feedbackMaxBytes,
    capture: {
      toolArgs:
        boolEnv("PI_TELEMETRY_CAPTURE_TOOL_ARGS") ??
        parseBool(fromBlock.capture?.toolArgs) ??
        DEFAULTS.capture.toolArgs,
      toolResults:
        boolEnv("PI_TELEMETRY_CAPTURE_TOOL_RESULTS") ??
        parseBool(fromBlock.capture?.toolResults) ??
        DEFAULTS.capture.toolResults,
      // DEPRECATED (task: deprecate-bash-executions): parsing is kept so older
      // configs still load, but the flag has no effect on live capture.
      bashCommand:
        boolEnv("PI_TELEMETRY_CAPTURE_BASH_COMMAND") ??
        parseBool(fromBlock.capture?.bashCommand) ??
        DEFAULTS.capture.bashCommand,
    },
  };
}
