import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";

export type MetadataType = "string" | "int" | "float" | "bool";

/**
 * Project one skill-invocation metadata key into session_event_metadata.
 * Enqueues an INSERT OR IGNORE (replay-idempotent on (event_id, key)) into
 * the same buffer as session_events writes. Maps the JS value to the typed
 * value_* column by `type`; the CHECK constraint guarantees integrity.
 * Best-effort: failures go to telemetry_meta, never throw.
 */
export function insertSkillMetadata(
  t: Telemetry,
  eventId: string,
  key: string,
  type: MetadataType,
  value: string | number | boolean | null,
): void {
  guard(t, () => {
    if (value === null || value === undefined) {
      return;
    }

    let valueText: string | null = null;
    let valueInt: number | null = null;
    let valueReal: number | null = null;
    let valueBool: number | null = null;

    switch (type) {
      case "string": {
        if (typeof value !== "string") {
          t.meta(
            "warn",
            "handler_error",
            `insertSkillMetadata type mismatch for key ${key}: expected string, got ${typeof value}`,
          );
          return;
        }
        valueText = value;
        break;
      }
      case "int": {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          t.meta(
            "warn",
            "handler_error",
            `insertSkillMetadata type mismatch for key ${key}: expected integer, got ${typeof value}`,
          );
          return;
        }
        valueInt = value;
        break;
      }
      case "float": {
        if (typeof value !== "number" || Number.isNaN(value)) {
          t.meta(
            "warn",
            "handler_error",
            `insertSkillMetadata type mismatch for key ${key}: expected number, got ${typeof value}`,
          );
          return;
        }
        valueReal = value;
        break;
      }
      case "bool": {
        if (typeof value !== "boolean") {
          t.meta(
            "warn",
            "handler_error",
            `insertSkillMetadata type mismatch for key ${key}: expected boolean, got ${typeof value}`,
          );
          return;
        }
        valueBool = value ? 1 : 0;
        break;
      }
      default: {
        // Exhaustiveness guard: unknown type is a programmer error.
        t.meta(
          "warn",
          "handler_error",
          `insertSkillMetadata unknown type for key ${key}: ${type}`,
        );
        return;
      }
    }

    t.enqueue(
      `INSERT OR IGNORE INTO session_event_metadata (
        event_id, key, type, value_text, value_int, value_real, value_bool
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [eventId, key, type, valueText, valueInt, valueReal, valueBool],
    );
  });
}
