import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  AgentStartEvent,
  AgentEndEvent,
  AgentSettledEvent,
} from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";

const RUN_START_PREFIX = "run:";

export function registerRunCapture(pi: ExtensionAPI, t: Telemetry): void {
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
    guard(t, () => {
      t.state.stagedPromptChars = event.prompt.length;
      t.state.stagedSystemPromptChars = event.systemPrompt.length;
    });
  });

  pi.on("agent_start", async (_event: AgentStartEvent, _ctx: ExtensionContext) => {
    guard(t, () => {
      const sessionId = t.state.sessionId;
      if (!sessionId) return;

      const runId = randomUUID();
      const now = t.now();
      t.state.runId = runId;
      t.state.timers.set(`${RUN_START_PREFIX}${runId}`, now);

      t.enqueue(
        `INSERT INTO agent_runs (
          run_id, session_id, started_unix_ms, duration_ms,
          prompt_chars, system_prompt_chars, message_count, outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          sessionId,
          now,
          null,
          t.state.stagedPromptChars,
          t.state.stagedSystemPromptChars,
          null,
          null,
        ],
      );

      t.state.stagedPromptChars = null;
      t.state.stagedSystemPromptChars = null;
    });
  });

  pi.on("agent_end", async (event: AgentEndEvent, _ctx: ExtensionContext) => {
    guard(t, () => {
      const runId = t.state.runId;
      if (!runId) return;

      const started = t.state.timers.get(`${RUN_START_PREFIX}${runId}`);
      const duration = started !== undefined ? t.now() - started : null;

      t.enqueue(
        `UPDATE agent_runs SET
          duration_ms = ?,
          message_count = ?,
          outcome = ?
        WHERE run_id = ?`,
        [duration, event.messages.length, "end", runId],
      );
    });
  });

  pi.on("agent_settled", async (_event: AgentSettledEvent, _ctx: ExtensionContext) => {
    guard(t, () => {
      const runId = t.state.runId;
      if (!runId) return;

      const started = t.state.timers.get(`${RUN_START_PREFIX}${runId}`);
      const duration = started !== undefined ? t.now() - started : null;

      t.enqueue(
        `UPDATE agent_runs SET
          duration_ms = COALESCE(duration_ms, ?),
          outcome = ?
        WHERE run_id = ?`,
        [duration, "settled", runId],
      );
    });
  });
}
