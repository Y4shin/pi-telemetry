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
 *   PI_TELEMETRY_PARENT_SESSION_ID: string | null,
 *   PI_TELEMETRY_PARENT_RUN_ID:     string | null,
 *   PI_TELEMETRY_DEPTH:             number | null,
 *   PI_TELEMETRY_AGENT_LABEL:       string | null,
 * }
 */
const LINEAGE_ENV_REQUEST_EVENT = "pi-telemetry:lineage-env.request";
const LINEAGE_ENV_RESPONSE_EVENT = "pi-telemetry:lineage-env.response";

export function readLineageFromEnv(
  env: Record<string, string | undefined>,
): LineageState {
  const parentSessionId = env.PI_TELEMETRY_PARENT_SESSION_ID ?? null;
  const parentRunId = env.PI_TELEMETRY_PARENT_RUN_ID ?? null;

  const depthRaw = env.PI_TELEMETRY_DEPTH;
  let depth: number | null = null;
  if (depthRaw !== undefined) {
    const n = Number(depthRaw);
    if (Number.isInteger(n)) {
      depth = n;
    }
    // Non-numeric depth is tolerated: leave as NULL per schema INTEGER type.
  }

  const agentLabel = env.PI_TELEMETRY_AGENT_LABEL ?? null;

  return {
    parentSessionId: parentSessionId ?? null,
    parentRunId: parentRunId ?? null,
    depth,
    agentLabel: agentLabel ?? null,
  };
}

function buildEnvBlock(env: Record<string, string | undefined>) {
  const lineage = readLineageFromEnv(env);
  return {
    PI_TELEMETRY_PARENT_SESSION_ID: lineage.parentSessionId,
    PI_TELEMETRY_PARENT_RUN_ID: lineage.parentRunId,
    PI_TELEMETRY_DEPTH: lineage.depth,
    PI_TELEMETRY_AGENT_LABEL: lineage.agentLabel,
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
  return {};
}

export function registerLineage(pi: ExtensionAPI, t: Telemetry): void {
  pi.events.on(LINEAGE_ENV_REQUEST_EVENT, (_req: unknown) => {
    guard(t, () => {
      pi.events.emit(LINEAGE_ENV_RESPONSE_EVENT, buildEnvBlock(process.env));
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
    });
  }

  pi.events.on("pi-telemetry:agent.spawned", (payload: unknown) => {
    handleAgentLineage("agent.spawned", payload);
  });
  pi.events.on("pi-telemetry:agent.completed", (payload: unknown) => {
    handleAgentLineage("agent.completed", payload);
  });
}
