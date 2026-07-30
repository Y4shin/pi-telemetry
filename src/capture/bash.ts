import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  UserBashEvent,
  UserBashEventResult,
  BashOperations,
} from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";
import { sha256 } from "../hash.ts";

function textLength(text: string | null | undefined): number {
  if (text === null || text === undefined) return 0;
  return Buffer.byteLength(text, "utf8");
}

function recordBashExecution(
  t: Telemetry,
  event: UserBashEvent,
  startMs: number,
  durationMs: number | null,
  result: {
    exitCode: number | null;
    cancelled: boolean;
    truncated: boolean;
    outputChars: number;
  },
): void {
  const sessionId = t.state.sessionId;
  if (!sessionId) return;

  t.enqueue(
    `INSERT INTO bash_executions (
      bash_id, session_id, cwd, started_unix_ms, duration_ms, exit_code,
      cancelled, truncated, output_chars, exclude_from_context, command_chars,
      command_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      sessionId,
      event.cwd,
      startMs,
      durationMs,
      result.exitCode,
      result.cancelled ? 1 : 0,
      result.truncated ? 1 : 0,
      result.outputChars,
      event.excludeFromContext ? 1 : 0,
      textLength(event.command),
      sha256(event.command),
    ],
  );
}

export function registerBashCapture(pi: ExtensionAPI, t: Telemetry): void {
  pi.on("user_bash", async (event: UserBashEvent, _ctx: ExtensionContext) => {
    let result: UserBashEventResult | undefined;
    guard(t, () => {
      const sessionId = t.state.sessionId;
      if (!sessionId) return;

      const local = createLocalBashOperations();
      const wrappedOps: BashOperations = {
        exec: async (command: string, cwd: string, options) => {
          const startMs = t.now();
          let outputBytes = 0;
          let outputLines = 0;
          let endsWithNewline = true;
          let cancelled = options.signal?.aborted ?? false;

          const onAbort = () => {
            cancelled = true;
          };
          options.signal?.addEventListener("abort", onAbort);

          const wrappedOnData = (data: Buffer) => {
            outputBytes += data.length;
            for (let i = 0; i < data.length; i++) {
              if (data[i] === 0x0a) outputLines++;
            }
            endsWithNewline = data.length > 0 && data[data.length - 1] === 0x0a;
            options.onData(data);
          };

          try {
            const execResult = await local.exec(command, cwd, {
              ...options,
              onData: wrappedOnData,
            });
            const durationMs = t.now() - startMs;
            const totalLines = outputLines + (outputBytes > 0 && !endsWithNewline ? 1 : 0);
            const truncated = outputBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES;
            recordBashExecution(t, event, startMs, durationMs, {
              exitCode: execResult.exitCode ?? null,
              cancelled,
              truncated,
              outputChars: outputBytes,
            });
            return execResult;
          } catch (err) {
            const durationMs = t.now() - startMs;
            recordBashExecution(t, event, startMs, durationMs, {
              exitCode: null,
              cancelled,
              truncated: false,
              outputChars: outputBytes,
            });
            throw err;
          } finally {
            options.signal?.removeEventListener("abort", onAbort);
          }
        },
      };

      result = { operations: wrappedOps };
    });
    return result;
  });
}
