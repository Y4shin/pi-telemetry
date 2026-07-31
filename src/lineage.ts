import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Telemetry, LineageState } from "./state.ts";
import { guard } from "./state.ts";

/**
 * Request/response event names for the env-export helper.
 *
 * Contract: orchestrators emit `pi-telemetry:lineage-env.request` (payload
 * ignored). pi-telemetry replies on `pi-telemetry:lineage-env.response`
 * with an env block shaped like:
 *
 * {
 *   PI_TELEMETRY_PARENT_SESSION_ID: t.state.sessionId,
 *   PI_TELEMETRY_PARENT_RUN_ID:     t.state.runId,
 *   PI_TELEMETRY_DEPTH:             (t.state.lineage.depth ?? 0) + 1,
 *   PI_TELEMETRY_AGENT_LABEL:       t.state.lineage.agentLabel,
 * }
 */
const LINEAGE_ENV_REQUEST_EVENT = "pi-telemetry:lineage-env.request";
const LINEAGE_ENV_RESPONSE_EVENT = "pi-telemetry:lineage-env.response";

export function readLineageFromEnv(
  env: Record<string, string | undefined>,
): LineageState {
  // Primary: PI_TELEMETRY_* (SPEC §4 contract). Empty strings are preserved
  // as-is (the original behavior; tested by the lineage suite).
  // Fallback: PI_SUBAGENT_* (what pi-subagents actually sets today — it
  // uses its own namespace, not PI_TELEMETRY_*). Empty strings from
  // PI_SUBAGENT_* are treated as absent (pi-subagents sets "" for
  // unset fields on non-fanout children).
  const parentSessionId =
    env.PI_TELEMETRY_PARENT_SESSION_ID
    ?? (env.PI_SUBAGENT_PARENT_SESSION || null);
  const parentRunId =
    env.PI_TELEMETRY_PARENT_RUN_ID
    ?? (env.PI_SUBAGENT_PARENT_RUN_ID || null);

  const depthRaw =
    env.PI_TELEMETRY_DEPTH
    ?? (env.PI_SUBAGENT_PARENT_DEPTH || undefined);
  let depth: number | null = null;
  if (depthRaw !== undefined) {
    const n = Number(depthRaw);
    if (Number.isInteger(n)) {
      depth = n;
    }
    // Non-numeric depth is tolerated: leave as NULL per schema INTEGER type.
  }

  const agentLabel =
    env.PI_TELEMETRY_AGENT_LABEL
    ?? (env.PI_SUBAGENT_CHILD_AGENT || null);

  return {
    parentSessionId: parentSessionId ?? null,
    parentRunId: parentRunId ?? null,
    depth,
    agentLabel: agentLabel ?? null,
  };
}

function buildEnvBlock(t: Telemetry) {
  return {
    PI_TELEMETRY_PARENT_SESSION_ID: t.state.sessionId,
    PI_TELEMETRY_PARENT_RUN_ID: t.state.runId,
    PI_TELEMETRY_DEPTH: (t.state.lineage.depth ?? 0) + 1,
    PI_TELEMETRY_AGENT_LABEL: t.state.lineage.agentLabel,
  };
}

export interface AgentLineagePayload {
  run_id?: unknown;
  parent_session_id?: unknown;
  parent_run_id?: unknown;
  depth?: unknown;
  agent_label?: unknown;
}

function isValidLineagePayload(payload: unknown): payload is Record<string, unknown> {
  return payload !== null && typeof payload === "object";
}

function coerceLineageUpdate(payload: Record<string, unknown>): Partial<LineageState> {
  const update: Partial<LineageState> = {};

  const parentSessionId = payload.parent_session_id;
  if (typeof parentSessionId === "string") {
    update.parentSessionId = parentSessionId;
  }

  const parentRunId = payload.parent_run_id;
  if (typeof parentRunId === "string") {
    update.parentRunId = parentRunId;
  }

  const depthRaw = payload.depth;
  if (typeof depthRaw === "number" && Number.isInteger(depthRaw)) {
    update.depth = depthRaw;
  } else if (typeof depthRaw === "string") {
    const n = Number(depthRaw);
    if (Number.isInteger(n)) {
      update.depth = n;
    }
  }

  const agentLabel = payload.agent_label;
  if (typeof agentLabel === "string") {
    update.agentLabel = agentLabel;
  }

  return update;
}

export function registerLineage(pi: ExtensionAPI, t: Telemetry): void {
  pi.events.on(LINEAGE_ENV_REQUEST_EVENT, (_req: unknown) => {
    guard(t, () => {
      pi.events.emit(LINEAGE_ENV_RESPONSE_EVENT, buildEnvBlock(t));
    });
  });

  function handleAgentLineage(eventName: string, payload: unknown): void {
    guard(t, () => {
      if (!isValidLineagePayload(payload)) {
        t.meta("warn", "handler_error", `lineage: malformed ${eventName} payload`);
        return;
      }
      const runId = (payload as Partial<AgentLineagePayload>).run_id;
      if (runId !== t.state.runId) {
        t.meta("warn", "handler_error", `lineage: unknown run_id in ${eventName}: ${runId}`);
        return;
      }

      const sessionId = t.state.sessionId;
      if (!sessionId) {
        t.meta("warn", "handler_error", `lineage: ${eventName} with no active session`);
        return;
      }

      const update = coerceLineageUpdate(payload);
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      if (update.parentSessionId !== undefined) {
        sets.push("parent_session_id = ?");
        values.push(update.parentSessionId);
      }
      if (update.parentRunId !== undefined) {
        sets.push("parent_run_id = ?");
        values.push(update.parentRunId);
      }
      if (update.depth !== undefined) {
        sets.push("depth = ?");
        values.push(update.depth);
      }
      if (update.agentLabel !== undefined) {
        sets.push("agent_label = ?");
        values.push(update.agentLabel);
      }
      if (sets.length === 0) return;

      values.push(sessionId);
      t.enqueue(
        `UPDATE sessions SET ${sets.join(", ")} WHERE session_id = ?`,
        values,
      );
    });
  }

  pi.events.on("pi-telemetry:agent.spawned", (payload: unknown) => {
    handleAgentLineage("agent.spawned", payload);
  });
  pi.events.on("pi-telemetry:agent.completed", (payload: unknown) => {
    handleAgentLineage("agent.completed", payload);
  });
}
