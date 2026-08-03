import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";
import { sha256, textLength } from "../hash.ts";
import { insertSkillMetadata } from "./skill-metadata.ts";

const SKILL_PREFIX = "/skill:";

function parseSkillInput(text: string): { skillName: string; args: string } {
  const withoutPrefix = text.slice(SKILL_PREFIX.length);
  const firstSpace = withoutPrefix.indexOf(" ");
  if (firstSpace === -1) {
    return { skillName: withoutPrefix, args: "" };
  }
  return {
    skillName: withoutPrefix.slice(0, firstSpace),
    args: withoutPrefix.slice(firstSpace + 1),
  };
}

function insertSkillInvokeEvent(
  t: Telemetry,
  eventId: string,
  skillName: string,
  args: string,
  inputSource: string,
): void {
  const sessionId = t.state.sessionId;
  if (!sessionId) return;

  const payload = {
    skill_name: skillName,
    args_chars: textLength(args),
    args_hash: sha256(args),
    input_source: inputSource,
  };

  t.enqueue(
    `INSERT OR IGNORE INTO session_events (
      event_id, session_id, unix_ms, type, payload
    ) VALUES (?, ?, ?, ?, ?)`,
    [eventId, sessionId, t.now(), "skill_invoke", JSON.stringify(payload)],
  );
}

export function registerSkillCapture(pi: ExtensionAPI, t: Telemetry): void {
  pi.on("input", async (event: InputEvent, _ctx: ExtensionContext): Promise<InputEventResult> => {
    guard(t, () => {
      if (event.source === "extension") return;
      if (!event.text.startsWith(SKILL_PREFIX)) return;

      const sessionId = t.state.sessionId;
      if (!sessionId) return;

      const { skillName, args } = parseSkillInput(event.text);
      const eventId = randomUUID();

      insertSkillInvokeEvent(t, eventId, skillName, args, event.source);
      t.state.lastSkillInvokeEventId = eventId;
      insertSkillMetadata(t, eventId, "skill_name", "string", skillName);
    });

    return { action: "continue" };
  });
}
