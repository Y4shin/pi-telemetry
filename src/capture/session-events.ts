import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";

function cleanPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

function insertEvent(
  t: Telemetry,
  type: string,
  payload: Record<string, unknown>,
): void {
  const sessionId = t.state.sessionId;
  if (!sessionId) return;

  const cleaned = cleanPayload(payload);

  let payloadText: string;
  try {
    payloadText = JSON.stringify(cleaned);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    t.meta("warn", "handler_error", `session_events payload serialization failed: ${detail}`);
    payloadText = "{}";
  }

  t.enqueue(
    `INSERT OR IGNORE INTO session_events (
      event_id, session_id, unix_ms, type, payload
    ) VALUES (?, ?, ?, ?, ?)`,
    [randomUUID(), sessionId, t.now(), type, payloadText],
  );
}

export function registerSessionEventsCapture(pi: ExtensionAPI, t: Telemetry): void {
  pi.on("session_before_compact", async (event) => {
    guard(t, () => {
      const payload: Record<string, unknown> = {
        reason: event.reason,
        tokens_before: event.preparation?.tokensBefore,
        will_retry: event.willRetry,
      };
      insertEvent(t, "compaction", payload);
    });
  });

  pi.on("session_compact", async (event) => {
    guard(t, () => {
      const payload: Record<string, unknown> = {
        reason: event.reason,
        tokens_before: event.compactionEntry?.tokensBefore,
        will_retry: event.willRetry,
        from_extension: event.fromExtension,
      };
      insertEvent(t, "compaction", payload);
    });
  });

  pi.on("model_select", async (event) => {
    guard(t, () => {
      const payload: Record<string, unknown> = {
        source: event.source,
      };
      if (event.previousModel) {
        payload.from = {
          provider: event.previousModel.provider,
          id: event.previousModel.id,
        };
      }
      payload.to = {
        provider: event.model.provider,
        id: event.model.id,
      };
      insertEvent(t, "model_change", payload);
    });
  });

  pi.on("thinking_level_select", async (event) => {
    guard(t, () => {
      const payload: Record<string, unknown> = {
        from_level: event.previousLevel,
        to_level: event.level,
      };
      insertEvent(t, "thinking_change", payload);
    });
  });

  pi.on("session_before_fork", async (event) => {
    guard(t, () => {
      const payload: Record<string, unknown> = {
        entry_id: event.entryId,
        position: event.position,
      };
      insertEvent(t, "branch", payload);
    });
  });

  pi.on("session_tree", async (event) => {
    guard(t, () => {
      const payload: Record<string, unknown> = {
        old_leaf_id: event.oldLeafId,
        new_leaf_id: event.newLeafId,
      };
      const entryId = event.summaryEntry?.id;
      if (entryId) {
        payload.entry_id = entryId;
      }
      insertEvent(t, "tree_nav", payload);
    });
  });
}
