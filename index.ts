import type { ExtensionAPI, ExtensionContext, SessionStartEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadMergedSettings } from "./src/config.ts";
import { openDatabase } from "./src/db.ts";
import { createBuffer } from "./src/buffer.ts";
import type { Telemetry, RuntimeState, MetaEvent } from "./src/state.ts";
import type { TelemetryConfig } from "./src/config.ts";
import { getExtensionVersion } from "./src/version.ts";
import {
  registerSessionCapture,
  registerRunCapture,
  registerTurnCapture,
  registerLlmCapture,
  registerToolCapture,
  registerBashCapture,
  registerSessionEventsCapture,
} from "./src/capture/index.ts";
import { registerFeedback } from "./src/feedback.ts";

function createTelemetryProxy(): Telemetry & { setTarget(t: Telemetry | null): void } {
  let target: Telemetry | null = null;
  return {
    get config(): TelemetryConfig {
      return target?.config ?? ({} as TelemetryConfig);
    },
    get now() {
      return target?.now ?? (() => Date.now());
    },
    get state(): RuntimeState {
      return target?.state ?? ({} as RuntimeState);
    },
    enqueue(sql: string, params: readonly (string | number | null)[]): void {
      target?.enqueue(sql, params);
    },
    meta(level: "warn" | "error", event: MetaEvent, detail?: string): void {
      target?.meta(level, event, detail);
    },
    flush(): void {
      target?.flush();
    },
    close(): void {
      target?.close();
      target = null;
    },
    setTarget(t: Telemetry | null): void {
      target = t;
    },
  } as Telemetry & { setTarget(t: Telemetry | null): void };
}

export default function piTelemetryExtension(pi: ExtensionAPI) {
  const telemetry = createTelemetryProxy();

  // This handler runs first on every session_start; it creates the real
  // telemetry instance so later-registered capture handlers can enqueue rows.
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const config = loadConfig(
      process.env as Record<string, string>,
      loadMergedSettings(ctx.cwd),
    );
    if (!config.enabled) return;

    try {
      const db = openDatabase(config.dbPath);
      telemetry.setTarget(createBuffer(config, db));
    } catch (err) {
      // Best-effort: telemetry disabled if DB cannot be opened.
      // eslint-disable-next-line no-console
      console.error("[pi-telemetry] failed to open DB:", err instanceof Error ? err.message : err);
    }
  });

  registerRunCapture(pi, telemetry);
  registerTurnCapture(pi, telemetry);
  registerSessionCapture(pi, telemetry);
  registerLlmCapture(pi, telemetry);
  registerToolCapture(pi, telemetry);
  registerBashCapture(pi, telemetry);
  registerSessionEventsCapture(pi, telemetry);
  registerFeedback(pi, telemetry);

  // Close after the session-capture shutdown handler has enqueued its UPDATE.
  pi.on("session_shutdown", async (_event: SessionShutdownEvent) => {
    telemetry.close();
  });
}

export type { TelemetryConfig } from "./src/config.ts";
export { loadConfig, loadMergedSettings } from "./src/config.ts";
export { openDatabase, type Migration } from "./src/db.ts";
export { createBuffer } from "./src/buffer.ts";
export { sha256 } from "./src/hash.ts";
export { guard, createRuntimeState, type Telemetry, type RuntimeState } from "./src/state.ts";
