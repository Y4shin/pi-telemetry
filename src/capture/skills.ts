import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult, ResourcesDiscoverEvent, ResourcesDiscoverResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";
import { sha256, textLength } from "../hash.ts";
import { insertSkillMetadata } from "./skill-metadata.ts";
import { resolvePackageInfo } from "../version.ts";

const SKILL_PREFIX = "/skill:";

interface SkillPackageInfo {
  skillSource: string | null;
  packageVersion: string | null;
}

let skillVersionCache: Map<string, SkillPackageInfo> | null = null;

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

function skillNameFromCommand(cmd: SlashCommandInfo): string | null {
  if (!cmd.name.startsWith("skill:")) return null;
  return cmd.name.slice("skill:".length);
}

function buildSkillVersionCache(pi: ExtensionAPI): Map<string, SkillPackageInfo> {
  const cache = new Map<string, SkillPackageInfo>();
  try {
    const commands = pi.getCommands();
    for (const cmd of commands) {
      if (cmd.source !== "skill") continue;
      const skillName = skillNameFromCommand(cmd);
      if (!skillName) continue;
      const info = resolvePackageInfo(cmd.sourceInfo.path);
      cache.set(skillName, { skillSource: info.name, packageVersion: info.version });
    }
  } catch {
    // Best-effort: if getCommands() fails, the cache stays empty.
  }
  return cache;
}

function getSkillPackageInfo(pi: ExtensionAPI, skillName: string): SkillPackageInfo {
  if (skillVersionCache === null) {
    skillVersionCache = buildSkillVersionCache(pi);
  }
  return skillVersionCache.get(skillName) ?? { skillSource: null, packageVersion: null };
}

/** Clears the lazy skill version cache. Exported for test isolation. */
export function resetSkillVersionCache(): void {
  skillVersionCache = null;
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

function enrichSkillInvokePayload(
  t: Telemetry,
  eventId: string,
  skillSource: string | null,
  packageVersion: string | null,
): void {
  const sessionId = t.state.sessionId;
  if (!sessionId) return;

  t.enqueue(
    `UPDATE session_events
     SET payload = (
       SELECT json_object(
         'skill_name', json_extract(payload, '$.skill_name'),
         'args_chars', json_extract(payload, '$.args_chars'),
         'args_hash', json_extract(payload, '$.args_hash'),
         'input_source', json_extract(payload, '$.input_source'),
         'skill_source', ?,
         'skills_package_version', ?
       )
       FROM session_events
       WHERE event_id = ?
     )
     WHERE event_id = ?`,
    [skillSource, packageVersion, eventId, eventId],
  );

  insertSkillMetadata(t, eventId, "skills_package_version", "string", packageVersion);
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

      const { skillSource, packageVersion } = getSkillPackageInfo(pi, skillName);
      enrichSkillInvokePayload(t, eventId, skillSource, packageVersion);
    });

    return { action: "continue" };
  });

  pi.on("resources_discover", async (_event: ResourcesDiscoverEvent, _ctx: ExtensionContext): Promise<ResourcesDiscoverResult> => {
    guard(t, () => {
      skillVersionCache = null;
    });
    return {};
  });
}
