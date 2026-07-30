import type { TelemetryConfig } from "./config.ts";

export type MetaEvent =
  | "write_failed"
  | "busy_retry"
  | "feedback_rejected"
  | "handler_error"
  | "buffer_drop";

export interface RuntimeState {
  sessionId: string | null;
  runId: string | null;
  turnId: string | null;
  turnIndex: number;
  timers: Map<string, number>;
  correlation(): {
    sessionId: string | null;
    runId: string | null;
    turnId: string | null;
    turnIndex: number;
  };
}

export interface Telemetry {
  readonly config: TelemetryConfig;
  readonly now: () => number;
  enqueue(sql: string, params: readonly (string | number | null)[]): void;
  meta(level: "warn" | "error", event: MetaEvent, detail?: string): void;
  readonly state: RuntimeState;
  flush(): void;
  close(): void;
}

export function createRuntimeState(): RuntimeState {
  const state: RuntimeState = {
    sessionId: null,
    runId: null,
    turnId: null,
    turnIndex: 0,
    timers: new Map(),
    correlation() {
      return {
        sessionId: state.sessionId,
        runId: state.runId,
        turnId: state.turnId,
        turnIndex: state.turnIndex,
      };
    },
  };
  return state;
}

export function guard(t: Telemetry, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      t.meta("error", "handler_error", detail);
    } catch {
      // Last-resort swallow: telemetry must never break the session.
    }
  }
}
