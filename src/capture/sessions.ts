import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  SessionShutdownEvent,
  SessionInfoChangedEvent,
} from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";
import { getExtensionVersion, getPiVersion } from "../version.ts";
import { readLineageFromEnv } from "../lineage.ts";

export function registerSessionCapture(pi: ExtensionAPI, t: Telemetry): void {
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    guard(t, () => {
      const sessionId = ctx.sessionManager.getSessionId();
      t.state.sessionId = sessionId;
      t.state.lineage = readLineageFromEnv(process.env);

      t.enqueue(
        `INSERT OR IGNORE INTO sessions (
          session_id, parent_session_id, parent_run_id, agent_label, depth,
          name, cwd, pi_version, ext_version, start_reason, end_reason,
          started_unix_ms, ended_unix_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          t.state.lineage.parentSessionId,
          t.state.lineage.parentRunId,
          t.state.lineage.agentLabel,
          t.state.lineage.depth,
          null,
          ctx.cwd,
          getPiVersion(),
          getExtensionVersion(),
          event.reason,
          null,
          t.now(),
          null,
        ],
      );
    });
  });

  pi.on("session_shutdown", async (event: SessionShutdownEvent) => {
    guard(t, () => {
      const sessionId = t.state.sessionId;
      if (!sessionId) return;
      t.enqueue(
        "UPDATE sessions SET ended_unix_ms = ?, end_reason = ? WHERE session_id = ?",
        [t.now(), event.reason, sessionId],
      );
    });
  });

  pi.on("session_info_changed", async (event: SessionInfoChangedEvent) => {
    guard(t, () => {
      const sessionId = t.state.sessionId;
      if (!sessionId) return;
      t.enqueue(
        "UPDATE sessions SET name = ? WHERE session_id = ?",
        [event.name ?? null, sessionId],
      );
    });
  });
}
