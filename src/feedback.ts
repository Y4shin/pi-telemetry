import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "./state.ts";
import { guard } from "./state.ts";

export interface FeedbackPayload {
  source?: unknown;
  kind?: unknown;
  data?: unknown;
}

export interface ValidatedFeedback {
  source: string;
  kind: string;
  dataText: string;
}

export function validateAndSerialize(
  source: unknown,
  kind: unknown,
  data: unknown,
  maxBytes: number,
): { ok: true } & ValidatedFeedback | { ok: false; reason: string } {
  if (typeof source !== "string" || source.length === 0) {
    return { ok: false, reason: "source must be a non-empty string" };
  }
  if (typeof kind !== "string" || kind.length === 0) {
    return { ok: false, reason: "kind must be a non-empty string" };
  }

  let dataText: string;
  if (data !== null && typeof data === "object") {
    try {
      dataText = JSON.stringify(data);
    } catch (err) {
      return { ok: false, reason: `data serialization failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else if (typeof data === "string") {
    dataText = data;
  } else {
    return { ok: false, reason: "data must be an object or string" };
  }

  const byteLength = new TextEncoder().encode(dataText).length;
  if (byteLength > maxBytes) {
    return { ok: false, reason: `feedback payload ${byteLength} bytes exceeds max ${maxBytes}` };
  }

  return { ok: true, source, kind, dataText };
}

function insertFeedback(
  t: Telemetry,
  source: string,
  kind: string,
  dataText: string,
  receivedMs: number,
): void {
  const { sessionId, runId, turnIndex } = t.state.correlation();
  t.enqueue(
    `INSERT OR IGNORE INTO feedback (
      feedback_id, session_id, run_id, turn_index, received_unix_ms,
      source, kind, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      sessionId,
      runId,
      turnIndex,
      receivedMs,
      source,
      kind,
      dataText,
    ],
  );
}

export function handleFeedback(
  t: Telemetry,
  source: unknown,
  kind: unknown,
  data: unknown,
  receivedMs: number,
): void {
  const sessionId = t.state.sessionId;
  if (!sessionId) {
    t.meta("warn", "feedback_rejected", "no active session");
    return;
  }

  const result = validateAndSerialize(source, kind, data, t.config.feedbackMaxBytes);
  if (!result.ok) {
    t.meta("warn", "feedback_rejected", result.reason);
    return;
  }

  insertFeedback(t, result.source, result.kind, result.dataText, receivedMs);
}

export function registerFeedback(pi: ExtensionAPI, t: Telemetry): void {
  pi.events.on("pi-telemetry:submit-feedback", (payload: unknown) => {
    guard(t, () => {
      const p = payload as Partial<FeedbackPayload>;
      handleFeedback(t, p.source, p.kind, p.data, t.now());
    });
  });

  pi.registerTool({
    name: "submit_feedback",
    label: "Submit Feedback",
    description: "Record structured workflow feedback (quality signals, friction points, review outcomes) to the local telemetry store.",
    parameters: Type.Object({
      kind: Type.String({ description: "Feedback category, e.g. 'good', 'bad', 'architecture'" }),
      data: Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())]),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        handleFeedback(t, "pi", params.kind, params.data, t.now());
      } catch (err) {
        guard(t, () => {
          throw err;
        });
      }
      return { content: [{ type: "text", text: "Feedback recorded." }], details: {} };
    },
  });
}
