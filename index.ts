import type { ExtensionAPI, ExtensionContext, SessionStartEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadMergedSettings } from "./src/config.ts";
import { openDatabase } from "./src/db.ts";
import { createBuffer } from "./src/buffer.ts";
import type { Telemetry } from "./src/state.ts";

export default function piTelemetryExtension(pi: ExtensionAPI) {
  let telemetry: Telemetry | null = null;

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const config = loadConfig(
      process.env as Record<string, string>,
      loadMergedSettings(ctx.cwd),
    );
    if (!config.enabled) return;

    try {
      const db = openDatabase(config.dbPath);
      telemetry = createBuffer(config, db);
    } catch (err) {
      // Best-effort: telemetry disabled if DB cannot be opened.
      // eslint-disable-next-line no-console
      console.error("[pi-telemetry] failed to open DB:", err instanceof Error ? err.message : err);
    }
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent) => {
    telemetry?.close();
    telemetry = null;
  });
}

export type { TelemetryConfig } from "./src/config.ts";
export { loadConfig, loadMergedSettings } from "./src/config.ts";
export { openDatabase, type Migration } from "./src/db.ts";
export { createBuffer } from "./src/buffer.ts";
export { sha256 } from "./src/hash.ts";
export { guard, createRuntimeState, type Telemetry, type RuntimeState } from "./src/state.ts";
