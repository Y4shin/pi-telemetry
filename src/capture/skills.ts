import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult, SlashCommandInfo, TurnStartEvent } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";
import { sha256, textLength } from "../hash.ts";
import { insertSkillMetadata, type MetadataType } from "./skill-metadata.ts";
import { resolvePackageInfo } from "../version.ts";

const SKILL_PREFIX = "/skill:";

interface SkillInfo {
  skillSource: string | null;
  packageVersion: string | null;
  captureKeys: string[] | null;
}

// These types mirror the Pi SDK shapes but are not re-exported from the
// package entry point, so we keep local structural copies.
interface ResourcesDiscoverEvent {
  type: "resources_discover";
  cwd: string;
  reason: "startup" | "reload";
}

interface ResourcesDiscoverResult {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
}

let skillInfoCache: Map<string, SkillInfo> | null = null;

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

function skillMdPathFromCommand(cmd: SlashCommandInfo): string {
  const p = cmd.sourceInfo.path;
  return p.endsWith(".md") ? p : join(p, "SKILL.md");
}

const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

function parseSkillArgs(args: string): { positionals: string[]; named: Map<string, string> } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const positionals: string[] = [];
  const named = new Map<string, string>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("-")) {
      const raw = tok.replace(/^-+/, "");
      const eqIdx = raw.indexOf("=");
      let key: string;
      let value: string | undefined;
      if (eqIdx >= 0) {
        key = raw.slice(0, eqIdx);
        value = raw.slice(eqIdx + 1);
      } else {
        key = raw;
        if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
          value = tokens[++i];
        }
      }
      named.set(key, value ?? "");
    } else if (tok.includes("=")) {
      const eqIdx = tok.indexOf("=");
      named.set(tok.slice(0, eqIdx), tok.slice(eqIdx + 1));
    } else {
      positionals.push(tok);
    }
  }

  return { positionals, named };
}

function isKebabSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function parseFrontmatterCapture(block: string): string[] | null {
  const lines = block.split(/\r?\n/);
  const stack: { indent: number; key: string }[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*/, "");
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    stack.push({ indent, key });

    const path = stack.map((s) => s.key).join(".");
    if (path === "metadata.telemetry.capture") {
      if (!value) return [];
      const cleaned = value.replace(/^["']|["']$/g, "");
      if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
        return cleaned
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return cleaned.split(/[,\s]+/).filter(Boolean);
    }
  }

  return null;
}

function readSkillFrontmatterCapture(skillMdPath: string): { captureKeys: string[] | null; error?: string } {
  let content: string;
  try {
    content = readFileSync(skillMdPath, "utf8");
  } catch (err) {
    return {
      captureKeys: null,
      error: `cannot read SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!content.trimStart().startsWith("---")) {
    return { captureKeys: null };
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/m);
  if (!match) {
    return { captureKeys: null, error: "malformed frontmatter: missing closing ---" };
  }

  const captureKeys = parseFrontmatterCapture(match[1]);
  return { captureKeys };
}

function buildSkillInfoCache(pi: ExtensionAPI, t: Telemetry): Map<string, SkillInfo> {
  const cache = new Map<string, SkillInfo>();
  try {
    const commands = pi.getCommands();
    for (const cmd of commands) {
      if (cmd.source !== "skill") continue;
      const skillName = skillNameFromCommand(cmd);
      if (!skillName) continue;

      const pkg = resolvePackageInfo(cmd.sourceInfo.path);
      let captureKeys: string[] | null = null;
      try {
        const mdPath = skillMdPathFromCommand(cmd);
        const result = readSkillFrontmatterCapture(mdPath);
        captureKeys = result.captureKeys;
        if (result.error) {
          t.meta("warn", "handler_error", `SKILL.md frontmatter for ${skillName}: ${result.error}`);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        t.meta("warn", "handler_error", `SKILL.md read failed for ${skillName}: ${detail}`);
      }

      cache.set(skillName, {
        skillSource: pkg.name,
        packageVersion: pkg.version,
        captureKeys,
      });
    }
  } catch {
    // Best-effort: if getCommands() fails, the cache stays empty.
  }
  return cache;
}

function getSkillInfo(pi: ExtensionAPI, t: Telemetry, skillName: string): SkillInfo {
  if (skillInfoCache === null) {
    skillInfoCache = buildSkillInfoCache(pi, t);
  }
  return skillInfoCache.get(skillName) ?? {
    skillSource: null,
    packageVersion: null,
    captureKeys: null,
  };
}

/** Clears the lazy skill info cache. Exported for test isolation. */
export function resetSkillVersionCache(): void {
  skillInfoCache = null;
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

  // json_quote maps SQL NULL to JSON null and SQL text to a JSON string,
  // so missing package info becomes explicit nulls without removing sibling keys.
  t.enqueue(
    `UPDATE session_events
     SET payload = json_set(
       payload,
       '$.skill_source', json_quote(?),
       '$.skills_package_version', json_quote(?)
     )
     WHERE event_id = ?`,
    [skillSource, packageVersion, eventId],
  );

  insertSkillMetadata(t, eventId, "skills_package_version", "string", packageVersion);
}

function projectCapturedFields(
  t: Telemetry,
  eventId: string,
  args: string,
  captureKeys: string[] | null,
): void {
  if (!captureKeys || captureKeys.length === 0) return;

  const sessionId = t.state.sessionId;
  if (!sessionId) return;

  const { positionals, named } = parseSkillArgs(args);
  let positionalIndex = 0;

  for (const key of captureKeys) {
    if (!KEY_RE.test(key)) continue;

    let raw: string | null = null;
    if (named.has(key)) {
      raw = named.get(key)!;
    } else if (positionalIndex < positionals.length) {
      raw = positionals[positionalIndex];
      positionalIndex++;
    }

    // Privacy: only clean kebab-case slugs are stored as values.
    const value = raw && isKebabSlug(raw) ? raw : null;

    // Always set the JSON field so absent/non-slug values are explicit nulls.
    t.enqueue(
      `UPDATE session_events SET payload = json_set(payload, ?, json_quote(?)) WHERE event_id = ?`,
      [`$.${key}`, value, eventId],
    );

    if (value) {
      insertSkillMetadata(t, eventId, key, "string", value);
    }
  }
}

interface TelemetrySkillContextParams {
  target?: string;
  map?: string;
  slice?: string;
  sliceCount?: number;
  extra?: Record<string, unknown>;
}

interface NormalizedValue {
  /** JSON payload value (strings, numbers, booleans). */
  readonly payloadValue: string | number | boolean;
  /** Metadata projection value. */
  readonly metadataValue: string | number | boolean;
  /** Metadata projection type. */
  readonly metadataType: MetadataType;
}

function hashValue(value: string): string {
  return `${textLength(value)}:${sha256(value)}`;
}

function normalizeStringParam(value: string): { value: string } {
  if (isKebabSlug(value)) {
    return { value };
  }
  return { value: hashValue(value) };
}

function normalizeExtraValue(
  t: Telemetry,
  key: string,
  value: unknown,
): NormalizedValue | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "boolean") {
    return {
      payloadValue: value,
      metadataValue: value,
      metadataType: "bool",
    };
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      t.meta("warn", "handler_error", `telemetry_skill_context: extra key ${key} is NaN`);
      return null;
    }
    if (Number.isInteger(value)) {
      return {
        payloadValue: value,
        metadataValue: value,
        metadataType: "int",
      };
    }
    return {
      payloadValue: value,
      metadataValue: value,
      metadataType: "float",
    };
  }

  if (typeof value === "string") {
    if (isKebabSlug(value)) {
      return {
        payloadValue: value,
        metadataValue: value,
        metadataType: "string",
      };
    }
    const hashed = hashValue(value);
    return {
      payloadValue: hashed,
      metadataValue: hashed,
      metadataType: "string",
    };
  }

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    t.meta(
      "warn",
      "handler_error",
      `telemetry_skill_context: extra key ${key} is unserializable: ${detail}`,
    );
    return null;
  }

  const hashed = hashValue(json);
  return {
    payloadValue: hashed,
    metadataValue: hashed,
    metadataType: "string",
  };
}

function jsonLiteral(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function handleTelemetrySkillContext(
  t: Telemetry,
  params: TelemetrySkillContextParams,
): void {
  const { sessionId, runId, turnId } = t.state.correlation();
  const eventId = t.state.lastSkillInvokeEventId;

  if (!sessionId || !runId || !turnId || !eventId) {
    t.meta(
      "warn",
      "handler_error",
      "telemetry_skill_context: no active skill invocation for current run/turn",
    );
    return;
  }

  const updates: Array<{ path: string; value: string | number | boolean }> = [];
  const metadata: Array<{ key: string; type: MetadataType; value: string | number | boolean }> = [];

  for (const key of ["target", "map", "slice"] as const) {
    const value = params[key];
    if (value === undefined) continue;
    const normalized = normalizeStringParam(value);
    updates.push({ path: `$.${key}`, value: normalized.value });
    metadata.push({ key, type: "string", value: normalized.value });
  }

  if (params.sliceCount !== undefined) {
    if (typeof params.sliceCount === "number" && Number.isInteger(params.sliceCount)) {
      updates.push({ path: "$.slice_count", value: params.sliceCount });
      metadata.push({ key: "slice_count", type: "int", value: params.sliceCount });
    } else {
      t.meta(
        "warn",
        "handler_error",
        `telemetry_skill_context: sliceCount must be an integer`,
      );
    }
  }

  if (params.extra !== undefined && typeof params.extra === "object" && params.extra !== null) {
    let extraKeysWritten = 0;
    for (const [key, value] of Object.entries(params.extra)) {
      if (!KEY_RE.test(key)) {
        t.meta(
          "warn",
          "handler_error",
          `telemetry_skill_context: extra key ${key} is not a valid identifier`,
        );
        continue;
      }
      const normalized = normalizeExtraValue(t, key, value);
      if (normalized) {
        extraKeysWritten++;
        updates.push({ path: `$.extra.${key}`, value: normalized.payloadValue });
        metadata.push({ key, type: normalized.metadataType, value: normalized.metadataValue });
      }
    }
    if (extraKeysWritten === 0) {
      t.enqueue(
        `UPDATE session_events
         SET payload = json_set(payload, '$.extra', json('{}'))
         WHERE event_id = ? AND run_id = ? AND turn_id = ?`,
        [eventId, runId, turnId],
      );
    }
  }

  for (const { path, value } of updates) {
    t.enqueue(
      `UPDATE session_events
       SET payload = json_set(payload, ?, json(?))
       WHERE event_id = ? AND run_id = ? AND turn_id = ?`,
      [path, jsonLiteral(value), eventId, runId, turnId],
    );
  }

  for (const { key, type, value } of metadata) {
    insertSkillMetadata(t, eventId, key, type, value);
  }
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

      const { skillSource, packageVersion, captureKeys } = getSkillInfo(pi, t, skillName);
      enrichSkillInvokePayload(t, eventId, skillSource, packageVersion);
      projectCapturedFields(t, eventId, args, captureKeys);
    });

    return { action: "continue" };
  });

  pi.on("turn_start", async (_event: TurnStartEvent, _ctx: ExtensionContext) => {
    guard(t, () => {
      const sessionId = t.state.sessionId;
      const runId = t.state.runId;
      const turnId = t.state.turnId;
      const eventId = t.state.lastSkillInvokeEventId;
      if (!sessionId || !runId || !turnId || !eventId) return;

      t.enqueue(
        `UPDATE session_events
         SET run_id = ?, turn_id = ?, turn_index = ?
         WHERE event_id = ?`,
        [runId, turnId, t.state.turnIndex, eventId],
      );

      insertSkillMetadata(t, eventId, "run_id", "string", runId);
    });
  });

  pi.on("resources_discover", async (_event: ResourcesDiscoverEvent, _ctx: ExtensionContext): Promise<ResourcesDiscoverResult> => {
    guard(t, () => {
      skillInfoCache = null;
    });
    return {};
  });

  pi.registerTool({
    name: "telemetry_skill_context",
    label: "Telemetry Skill Context",
    description:
      "Attach dynamic metadata (target, map, slice, slice_count, extra) to the current skill invocation.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Target slug" })),
      map: Type.Optional(Type.String({ description: "Map slug" })),
      slice: Type.Optional(Type.String({ description: "Slice slug" })),
      sliceCount: Type.Optional(Type.Integer({ description: "Number of slices" })),
      extra: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Extra key-value metadata",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        handleTelemetrySkillContext(t, params as TelemetrySkillContextParams);
      } catch (err) {
        guard(t, () => {
          throw err;
        });
      }
      return { content: [{ type: "text", text: "Recorded." }], details: {} };
    },
  });
}
