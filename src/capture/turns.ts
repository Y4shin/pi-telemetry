import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  TurnStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";

const TURN_START_PREFIX = "turn:";

export function registerTurnCapture(pi: ExtensionAPI, t: Telemetry): void {
  pi.on("turn_start", async (event: TurnStartEvent, ctx: ExtensionContext) => {
    guard(t, () => {
      const sessionId = t.state.sessionId;
      const runId = t.state.runId;
      if (!sessionId || !runId) return;

      const turnId = randomUUID();
      const now = event.timestamp ?? t.now();
      t.state.turnId = turnId;
      t.state.turnIndex = event.turnIndex;
      t.state.timers.set(`${TURN_START_PREFIX}${turnId}`, now);

      let contextTokens: number | null = null;
      try {
        const usage = ctx.getContextUsage();
        if (usage && usage.tokens !== null && usage.tokens !== undefined) {
          contextTokens = usage.tokens;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        t.meta("warn", "handler_error", `getContextUsage failed: ${detail}`);
      }

      t.enqueue(
        `INSERT INTO turns (
          turn_id, run_id, session_id, turn_index, started_unix_ms,
          duration_ms, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens,
          cost_input_usd, cost_output_usd, cost_cache_read_usd,
          cost_cache_write_usd, cost_total_usd, stop_reason,
          tool_result_count, context_tokens_at_start
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          turnId,
          runId,
          sessionId,
          event.turnIndex,
          now,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          contextTokens,
        ],
      );
    });
  });

  pi.on("turn_end", async (event: TurnEndEvent, _ctx: ExtensionContext) => {
    guard(t, () => {
      const turnId = t.state.turnId;
      if (!turnId) {
        t.meta("warn", "handler_error", "turn_end without matching turn_start");
        return;
      }

      const started = t.state.timers.get(`${TURN_START_PREFIX}${turnId}`);
      const duration = started !== undefined ? t.now() - started : null;

      const message = event.message as {
        provider?: string;
        model?: string;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          totalTokens?: number;
          cost?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            total?: number;
          };
        };
        stopReason?: string;
      };

      const usage = message.usage ?? {};
      const cost = usage.cost ?? {};

      t.enqueue(
        `UPDATE turns SET
          duration_ms = ?,
          provider = ?,
          model = ?,
          input_tokens = ?,
          output_tokens = ?,
          cache_read_tokens = ?,
          cache_write_tokens = ?,
          total_tokens = ?,
          cost_input_usd = ?,
          cost_output_usd = ?,
          cost_cache_read_usd = ?,
          cost_cache_write_usd = ?,
          cost_total_usd = ?,
          stop_reason = ?,
          tool_result_count = ?
        WHERE turn_id = ?`,
        [
          duration,
          message.provider ?? null,
          message.model ?? null,
          usage.input ?? null,
          usage.output ?? null,
          usage.cacheRead ?? null,
          usage.cacheWrite ?? null,
          usage.totalTokens ?? null,
          cost.input ?? null,
          cost.output ?? null,
          cost.cacheRead ?? null,
          cost.cacheWrite ?? null,
          cost.total ?? null,
          message.stopReason ?? null,
          event.toolResults.length,
          turnId,
        ],
      );

      t.state.turnId = null;
      t.state.turnIndex = 0;
      t.state.timers.delete(`${TURN_START_PREFIX}${turnId}`);
    });
  });
}
