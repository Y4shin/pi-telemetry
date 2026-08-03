import type { DatabaseSync } from "node:sqlite";

export interface SkillEventSeed {
  run_id: string;
  version: string;
  skill: string;
  cost: number;
  tokens: number;
  is_error: number;
}

export const DEFAULT_SKILL_EVENTS: SkillEventSeed[] = [
  { run_id: "run-skill-a", version: "2.5.1", skill: "implement-task", cost: 0.1, tokens: 50, is_error: 0 },
  { run_id: "run-skill-b", version: "2.5.1", skill: "implement-task", cost: 0.2, tokens: 100, is_error: 1 },
  { run_id: "run-skill-c", version: "2.4.0", skill: "implement-task", cost: 0.05, tokens: 25, is_error: 0 },
  { run_id: "run-skill-d", version: "2.5.1", skill: "wayfinder", cost: 0.015, tokens: 30, is_error: 1 },
];

export function seedSkillEvents(db: DatabaseSync, now: number, events: SkillEventSeed[] = DEFAULT_SKILL_EVENTS) {
  db.prepare(
    "INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)",
  ).run("sess-skill-cost", now);

  for (const s of events) {
    const turnId = `${s.run_id}-turn`;
    const toolId = `${s.run_id}-tool`;
    const eventId = `${s.run_id}-evt`;

    db.prepare(
      "INSERT INTO agent_runs (run_id, session_id, started_unix_ms) VALUES (?, ?, ?)",
    ).run(s.run_id, "sess-skill-cost", now);
    db.prepare(
      "INSERT INTO turns (turn_id, run_id, session_id, turn_index, started_unix_ms, total_tokens, cost_total_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(turnId, s.run_id, "sess-skill-cost", 1, now, s.tokens, s.cost);
    db.prepare(
      "INSERT INTO tool_executions (tool_call_id, turn_id, run_id, session_id, tool_name, started_unix_ms, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(toolId, turnId, s.run_id, "sess-skill-cost", "bash", now, s.is_error);
    db.prepare(
      "INSERT INTO session_events (event_id, session_id, unix_ms, type, payload, run_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(eventId, "sess-skill-cost", now, "skill_invoke", "{}", s.run_id);
    db.prepare(
      "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(eventId, "skills_package_version", "string", s.version, null, null, null);
    db.prepare(
      "INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(eventId, "skill_name", "string", s.skill, null, null, null);
  }
}
