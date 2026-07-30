import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";

export function registerTelemetryTool(pi: ExtensionAPI, t: Telemetry): void {
  pi.registerTool({
    name: "query_telemetry",
    label: "Query Telemetry",
    description: "Query the local telemetry database. Prefer named presets (query) over raw SQL (sql).",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Named preset" })),
    }),
    async execute(_toolCallId, _params) {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
}
