import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";

interface InFlightRequest {
  requestId: string;
  startMs: number;
  firstUpdateMs: number | null;
  signature: string;
  turnId: string;
}

const inFlightRequests = new Map<string, InFlightRequest>();

interface PendingResponse {
  status: number;
  retryAfterMs: number | null;
}

const pendingResponses = new Map<string, PendingResponse[]>();

function getMessageSignature(message: AssistantMessage): string {
  const parts = [
    message.provider ?? "",
    message.model ?? "",
    message.api ?? "",
    String(message.timestamp ?? ""),
    message.responseId ?? "",
  ];
  return parts.join("|");
}

function parseRetryAfterMs(headers: Record<string, string>): number | null {
  const value = headers["retry-after"] ?? headers["Retry-After"];
  if (!value) return null;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return parsed * 1000;
}

function takePendingResponse(turnId: string): PendingResponse | undefined {
  const list = pendingResponses.get(turnId);
  if (!list) return undefined;
  const next = list.shift();
  if (list.length === 0) pendingResponses.delete(turnId);
  return next;
}

export function registerLlmCapture(pi: ExtensionAPI, t: Telemetry): void {
  pi.on("message_start", async (event) => {
    guard(t, () => {
      const message = event.message as AssistantMessage;
      if (message.role !== "assistant") return;

      const { sessionId, runId, turnId } = t.state.correlation();
      if (!sessionId || !turnId) return;

      const requestId = randomUUID();
      const startMs = t.now();
      const signature = getMessageSignature(message);
      const pending = turnId ? takePendingResponse(turnId) : undefined;

      const inFlight: InFlightRequest = {
        requestId,
        startMs,
        firstUpdateMs: null,
        signature,
        turnId,
      };
      inFlightRequests.set(signature, inFlight);

      t.enqueue(
        `INSERT INTO llm_requests (
          request_id, turn_id, run_id, session_id, provider, model,
          started_unix_ms, ttft_ms, stream_ms, duration_ms,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_total_usd, stop_reason, http_status, retry_after_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          requestId,
          turnId,
          runId,
          sessionId,
          message.provider ?? null,
          message.model ?? null,
          startMs,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          pending?.status ?? null,
          pending?.retryAfterMs ?? null,
        ],
      );
    });
  });

  pi.on("message_update", async (event) => {
    guard(t, () => {
      const message = event.message as AssistantMessage;
      if (message.role !== "assistant") return;

      const signature = getMessageSignature(message);
      const req = inFlightRequests.get(signature);
      if (!req) return;

      const now = t.now();
      if (req.firstUpdateMs === null) {
        req.firstUpdateMs = now;
        const ttftMs = now - req.startMs;
        t.enqueue(
          "UPDATE llm_requests SET ttft_ms = ? WHERE request_id = ?",
          [ttftMs, req.requestId],
        );
      }
    });
  });

  pi.on("message_end", async (event) => {
    guard(t, () => {
      const message = event.message as AssistantMessage;
      if (message.role !== "assistant") return;

      const signature = getMessageSignature(message);
      const req = inFlightRequests.get(signature);
      if (!req) return;

      const now = t.now();
      const durationMs = now - req.startMs;
      const streamMs = req.firstUpdateMs !== null ? now - req.firstUpdateMs : null;

      const usage = message.usage;
      const cost = usage?.cost;

      t.enqueue(
        `UPDATE llm_requests SET
          duration_ms = ?,
          stream_ms = ?,
          input_tokens = ?,
          output_tokens = ?,
          cache_read_tokens = ?,
          cache_write_tokens = ?,
          cost_total_usd = ?,
          stop_reason = ?
        WHERE request_id = ?`,
        [
          durationMs,
          streamMs,
          usage?.input ?? null,
          usage?.output ?? null,
          usage?.cacheRead ?? null,
          usage?.cacheWrite ?? null,
          cost?.total ?? null,
          message.stopReason ?? null,
          req.requestId,
        ],
      );

      inFlightRequests.delete(signature);
    });
  });

  pi.on("after_provider_response", async (event) => {
    guard(t, () => {
      const { turnId } = t.state.correlation();
      if (!turnId) return;

      const retryAfterMs = parseRetryAfterMs(event.headers);

      // Find the most recent in-flight request for this turn.
      let target: InFlightRequest | undefined;
      for (const req of inFlightRequests.values()) {
        if (req.turnId === turnId) {
          if (!target || req.startMs > target.startMs) {
            target = req;
          }
        }
      }

      if (target) {
        t.enqueue(
          "UPDATE llm_requests SET http_status = ?, retry_after_ms = ? WHERE request_id = ?",
          [event.status, retryAfterMs, target.requestId],
        );
      } else {
        const list = pendingResponses.get(turnId) ?? [];
        list.push({ status: event.status, retryAfterMs });
        pendingResponses.set(turnId, list);
      }
    });
  });
}
