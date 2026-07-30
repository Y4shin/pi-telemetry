import { createHash, randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";

const TOOL_START_PREFIX = "tool:";

type ErrorClass = "timeout" | "not_found" | "permission" | "validation" | "unknown";

interface InFlightTool {
  toolCallId: string;
  turnId: string;
  runId: string;
  sessionId: string;
  toolName: string;
  startMs: number;
  argsChars: number;
  argsJson: string | null;
}

interface StagedResult {
  resultChars: number;
  resultHash: string;
  resultText: string;
  isError: boolean;
  errorClass: ErrorClass | null;
}

const inFlightTools = new Map<string, InFlightTool>();
const stagedResults = new Map<string, StagedResult>();
const completedToolCallIds = new Set<string>();

function textLength(text: string | null | undefined): number {
  if (text === null || text === undefined) return 0;
  return Buffer.byteLength(text, "utf8");
}

function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function argsText(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  return safeJsonStringify(args) ?? String(args);
}

function isTextBlock(block: unknown): block is { text: string } {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as { type?: string }).type === "text" &&
    typeof (block as { text?: string }).text === "string"
  );
}

function classifyError(err: unknown): ErrorClass {
  let message = "";
  let code: string | undefined;

  if (err instanceof Error) {
    message = err.message;
    code = (err as { code?: string }).code;
  } else if (typeof err === "string") {
    message = err;
  } else if (err !== null && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    message = typeof obj.message === "string" ? obj.message : "";
    code = typeof obj.code === "string" ? obj.code : undefined;
  }

  const combined = `${message} ${code ?? ""}`.toLowerCase();
  if (combined.includes("timeout") || combined.includes("timed out") || code === "ETIMEDOUT") {
    return "timeout";
  }
  if (
    combined.includes("not found") ||
    combined.includes("enoent") ||
    combined.includes("does not exist") ||
    combined.includes("no such file")
  ) {
    return "not_found";
  }
  if (
    combined.includes("permission") ||
    combined.includes("eacces") ||
    combined.includes("eperm") ||
    combined.includes("access denied")
  ) {
    return "permission";
  }
  if (combined.includes("validation") || combined.includes("invalid")) {
    return "validation";
  }
  return "unknown";
}

function computeResultMetrics(result: unknown, includeText: boolean): StagedResult {
  const hasher = createHash("sha256");
  let chars = 0;
  let text = "";

  if (typeof result === "string") {
    hasher.update(result, "utf8");
    chars = textLength(result);
    if (includeText) text = result;
  } else if (
    result !== null &&
    typeof result === "object" &&
    Array.isArray((result as Record<string, unknown>).content)
  ) {
    for (const block of (result as { content: unknown[] }).content) {
      if (isTextBlock(block)) {
        const t = block.text;
        hasher.update(t, "utf8");
        chars += textLength(t);
        if (includeText) text += t;
      }
    }
  } else {
    const serialized = safeJsonStringify(result) ?? String(result);
    hasher.update(serialized, "utf8");
    chars = textLength(serialized);
    if (includeText) text = serialized;
  }

  return {
    resultChars: chars,
    resultHash: hasher.digest("hex"),
    resultText: text,
    isError: false,
    errorClass: null,
  };
}

function stageResult(toolCallId: string, result: unknown, isError: boolean, includeText: boolean): void {
  const metrics = computeResultMetrics(result, includeText);
  metrics.isError = isError;
  metrics.errorClass = isError ? classifyError(result) : null;
  stagedResults.set(toolCallId, metrics);
}

function insertToolExecution(
  t: Telemetry,
  toolCallId: string,
  toolName: string,
  startMs: number,
  durationMs: number | null,
  argsChars: number,
  argsJson: string | null,
  staged: StagedResult | undefined,
): void {
  const { sessionId, runId, turnId } = t.state.correlation();
  if (!sessionId) return;

  const captureArgs = t.config.capture.toolArgs;
  const captureResults = t.config.capture.toolResults;

  t.enqueue(
    `INSERT INTO tool_executions (
      tool_call_id, turn_id, run_id, session_id, tool_name, started_unix_ms,
      duration_ms, is_error, error_class, args_chars, result_chars, result_hash,
      args_json, result_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toolCallId,
      turnId,
      runId,
      sessionId,
      toolName,
      startMs,
      durationMs,
      staged?.isError ? 1 : 0,
      staged?.errorClass ?? null,
      argsChars,
      staged?.resultChars ?? 0,
      staged?.resultHash ?? createHash("sha256").update("").digest("hex"),
      captureArgs ? argsJson : null,
      captureResults ? staged?.resultText ?? null : null,
    ],
  );
}

export function registerToolCapture(pi: ExtensionAPI, t: Telemetry): void {
  pi.on("tool_execution_start", async (event: ToolExecutionStartEvent) => {
    guard(t, () => {
      const { sessionId, runId, turnId } = t.state.correlation();
      if (!sessionId || !turnId) return;

      const args = argsText(event.args);
      const argsChars = textLength(args);
      const argsJson = safeJsonStringify(event.args);

      const startMs = t.now();
      t.state.timers.set(`${TOOL_START_PREFIX}${event.toolCallId}`, startMs);

      inFlightTools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        turnId,
        runId,
        sessionId,
        toolName: event.toolName,
        startMs,
        argsChars,
        argsJson,
      });
    });
  });

  pi.on("tool_result", async (event: ToolResultEvent) => {
    guard(t, () => {
      const { sessionId, turnId } = t.state.correlation();
      if (!sessionId || !turnId) return;

      stageResult(event.toolCallId, event.content, event.isError, t.config.capture.toolResults);

      if (!inFlightTools.has(event.toolCallId) && !completedToolCallIds.has(event.toolCallId)) {
        const staged = stagedResults.get(event.toolCallId);
        const now = t.now();
        insertToolExecution(
          t,
          event.toolCallId,
          event.toolName,
          now,
          null,
          0,
          null,
          staged,
        );
        completedToolCallIds.add(event.toolCallId);
        stagedResults.delete(event.toolCallId);
      }
    });
  });

  pi.on("tool_execution_end", async (event: ToolExecutionEndEvent) => {
    guard(t, () => {
      if (completedToolCallIds.has(event.toolCallId)) {
        inFlightTools.delete(event.toolCallId);
        stagedResults.delete(event.toolCallId);
        t.state.timers.delete(`${TOOL_START_PREFIX}${event.toolCallId}`);
        return;
      }

      const inFlight = inFlightTools.get(event.toolCallId);
      const startMs =
        inFlight?.startMs ??
        t.state.timers.get(`${TOOL_START_PREFIX}${event.toolCallId}`) ??
        t.now();
      const durationMs = inFlight ? t.now() - inFlight.startMs : null;

      let staged = stagedResults.get(event.toolCallId);
      if (!staged) {
        stageResult(event.toolCallId, event.result, event.isError, t.config.capture.toolResults);
        staged = stagedResults.get(event.toolCallId)!;
      }

      const toolName = inFlight?.toolName ?? event.toolName;
      const argsChars = inFlight?.argsChars ?? 0;
      const argsJson = inFlight?.argsJson ?? null;

      insertToolExecution(
        t,
        event.toolCallId,
        toolName,
        startMs,
        durationMs,
        argsChars,
        argsJson,
        staged,
      );

      completedToolCallIds.add(event.toolCallId);
      inFlightTools.delete(event.toolCallId);
      stagedResults.delete(event.toolCallId);
      t.state.timers.delete(`${TOOL_START_PREFIX}${event.toolCallId}`);
    });
  });
}
