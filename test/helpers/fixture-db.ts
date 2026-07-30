import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/db.ts";

export interface FixtureOptions {
  now?: number;
}

export function seedFixture(dbPath: string, options: FixtureOptions = {}): DatabaseSync {
  const now = options.now ?? Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const db = openDatabase(dbPath);

  const sessions = [
    {
      session_id: "sess-root",
      parent_session_id: null,
      parent_run_id: null,
      agent_label: "root",
      depth: 0,
      name: "Root Session",
      cwd: "/tmp/root",
      pi_version: "0.80.10",
      ext_version: "0.1.0",
      start_reason: "startup",
      end_reason: null,
      started_unix_ms: now - 3 * dayMs,
      ended_unix_ms: null,
    },
    {
      session_id: "sess-child",
      parent_session_id: "sess-root",
      parent_run_id: "run-root-1",
      agent_label: "child",
      depth: 1,
      name: "Child Session",
      cwd: "/tmp/child",
      pi_version: "0.80.10",
      ext_version: "0.1.0",
      start_reason: "new",
      end_reason: null,
      started_unix_ms: now - 1 * dayMs,
      ended_unix_ms: null,
    },
  ];

  const runs = [
    {
      run_id: "run-root-1",
      session_id: "sess-root",
      started_unix_ms: now - 2 * dayMs,
      duration_ms: 5000,
      prompt_chars: 100,
      system_prompt_chars: 50,
      message_count: 3,
      outcome: "end",
    },
    {
      run_id: "run-child-1",
      session_id: "sess-child",
      started_unix_ms: now - 0.5 * dayMs,
      duration_ms: 2000,
      prompt_chars: 80,
      system_prompt_chars: 40,
      message_count: 2,
      outcome: "settled",
    },
  ];

  const turns = [
    {
      turn_id: "turn-1",
      run_id: "run-root-1",
      session_id: "sess-root",
      turn_index: 1,
      started_unix_ms: now - 2 * dayMs + 100,
      duration_ms: 1200,
      provider: "anthropic",
      model: "claude-sonnet",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 20,
      cache_write_tokens: 5,
      total_tokens: 175,
      cost_input_usd: 0.0005,
      cost_output_usd: 0.0015,
      cost_cache_read_usd: 0.0001,
      cost_cache_write_usd: 0.00005,
      cost_total_usd: 0.00215,
      stop_reason: "end_turn",
      tool_result_count: 1,
      context_tokens_at_start: 200,
    },
    {
      turn_id: "turn-2",
      run_id: "run-root-1",
      session_id: "sess-root",
      turn_index: 2,
      started_unix_ms: now - 2 * dayMs + 2000,
      duration_ms: 900,
      provider: "anthropic",
      model: "claude-haiku",
      input_tokens: 80,
      output_tokens: 30,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 110,
      cost_input_usd: 0.0001,
      cost_output_usd: 0.0003,
      cost_cache_read_usd: 0,
      cost_cache_write_usd: 0,
      cost_total_usd: 0.0004,
      stop_reason: "end_turn",
      tool_result_count: 0,
      context_tokens_at_start: 300,
    },
    {
      turn_id: "turn-3",
      run_id: "run-child-1",
      session_id: "sess-child",
      turn_index: 1,
      started_unix_ms: now - 0.5 * dayMs + 100,
      duration_ms: 1500,
      provider: "openai",
      model: "gpt-4o",
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 50,
      cache_write_tokens: 10,
      total_tokens: 360,
      cost_input_usd: 0.002,
      cost_output_usd: 0.006,
      cost_cache_read_usd: 0.00025,
      cost_cache_write_usd: 0.0001,
      cost_total_usd: 0.00835,
      stop_reason: "tool_use",
      tool_result_count: 2,
      context_tokens_at_start: 500,
    },
  ];

  const llmRequests = [
    {
      request_id: "req-1",
      turn_id: "turn-1",
      run_id: "run-root-1",
      session_id: "sess-root",
      provider: "anthropic",
      model: "claude-sonnet",
      started_unix_ms: now - 2 * dayMs + 100,
      ttft_ms: 250,
      stream_ms: 800,
      duration_ms: 1050,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 20,
      cache_write_tokens: 5,
      cost_total_usd: 0.00215,
      stop_reason: "end_turn",
      http_status: 200,
      retry_after_ms: null,
    },
    {
      request_id: "req-2",
      turn_id: "turn-2",
      run_id: "run-root-1",
      session_id: "sess-root",
      provider: "anthropic",
      model: "claude-haiku",
      started_unix_ms: now - 2 * dayMs + 2000,
      ttft_ms: 80,
      stream_ms: 600,
      duration_ms: 680,
      input_tokens: 80,
      output_tokens: 30,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_total_usd: 0.0004,
      stop_reason: "end_turn",
      http_status: 429,
      retry_after_ms: 5000,
    },
  ];

  const tools = [
    {
      tool_call_id: "tool-1",
      turn_id: "turn-1",
      run_id: "run-root-1",
      session_id: "sess-root",
      tool_name: "read",
      started_unix_ms: now - 2 * dayMs + 500,
      duration_ms: 200,
      is_error: 0,
      error_class: null,
      args_chars: 20,
      result_chars: 100,
      result_hash: "abc123",
      args_json: null,
      result_text: null,
    },
    {
      tool_call_id: "tool-2",
      turn_id: "turn-3",
      run_id: "run-child-1",
      session_id: "sess-child",
      tool_name: "bash",
      started_unix_ms: now - 0.5 * dayMs + 500,
      duration_ms: 300,
      is_error: 1,
      error_class: "timeout",
      args_chars: 30,
      result_chars: 0,
      result_hash: null,
      args_json: null,
      result_text: null,
    },
  ];

  const bash = [
    {
      bash_id: "bash-1",
      session_id: "sess-root",
      cwd: "/tmp/root",
      started_unix_ms: now - 2 * dayMs + 300,
      duration_ms: 150,
      exit_code: 0,
      cancelled: 0,
      truncated: 0,
      output_chars: 42,
      exclude_from_context: 0,
      command_chars: 12,
      command_hash: "def456",
    },
  ];

  const feedback = [
    {
      feedback_id: "fb-1",
      session_id: "sess-root",
      run_id: "run-root-1",
      turn_index: 2,
      received_unix_ms: now - 1 * dayMs,
      source: "pi",
      kind: "good",
      data: JSON.stringify({ note: "smooth" }),
    },
    {
      feedback_id: "fb-2",
      session_id: "sess-child",
      run_id: "run-child-1",
      turn_index: 1,
      received_unix_ms: now - 0.5 * dayMs,
      source: "plugin",
      kind: "bad",
      data: "raw string feedback",
    },
  ];

  const meta = [
    {
      unix_ms: now - 1000,
      level: "error",
      event: "write_failed",
      detail: "disk full",
      session_id: "sess-root",
    },
  ];

  db.exec("BEGIN");
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      session_id, parent_session_id, parent_run_id, agent_label, depth, name, cwd,
      pi_version, ext_version, start_reason, end_reason, started_unix_ms, ended_unix_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of sessions) {
    insertSession.run(
      s.session_id, s.parent_session_id, s.parent_run_id, s.agent_label, s.depth,
      s.name, s.cwd, s.pi_version, s.ext_version, s.start_reason, s.end_reason,
      s.started_unix_ms, s.ended_unix_ms,
    );
  }

  const insertRun = db.prepare(`
    INSERT INTO agent_runs (
      run_id, session_id, started_unix_ms, duration_ms, prompt_chars,
      system_prompt_chars, message_count, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of runs) {
    insertRun.run(
      r.run_id, r.session_id, r.started_unix_ms, r.duration_ms, r.prompt_chars,
      r.system_prompt_chars, r.message_count, r.outcome,
    );
  }

  const insertTurn = db.prepare(`
    INSERT INTO turns (
      turn_id, run_id, session_id, turn_index, started_unix_ms, duration_ms,
      provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      total_tokens, cost_input_usd, cost_output_usd, cost_cache_read_usd, cost_cache_write_usd,
      cost_total_usd, stop_reason, tool_result_count, context_tokens_at_start
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of turns) {
    insertTurn.run(
      t.turn_id, t.run_id, t.session_id, t.turn_index, t.started_unix_ms, t.duration_ms,
      t.provider, t.model, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens,
      t.total_tokens, t.cost_input_usd, t.cost_output_usd, t.cost_cache_read_usd, t.cost_cache_write_usd,
      t.cost_total_usd, t.stop_reason, t.tool_result_count, t.context_tokens_at_start,
    );
  }

  const insertLlm = db.prepare(`
    INSERT INTO llm_requests (
      request_id, turn_id, run_id, session_id, provider, model, started_unix_ms,
      ttft_ms, stream_ms, duration_ms, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, cost_total_usd, stop_reason, http_status, retry_after_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const l of llmRequests) {
    insertLlm.run(
      l.request_id, l.turn_id, l.run_id, l.session_id, l.provider, l.model, l.started_unix_ms,
      l.ttft_ms, l.stream_ms, l.duration_ms, l.input_tokens, l.output_tokens, l.cache_read_tokens,
      l.cache_write_tokens, l.cost_total_usd, l.stop_reason, l.http_status, l.retry_after_ms,
    );
  }

  const insertTool = db.prepare(`
    INSERT INTO tool_executions (
      tool_call_id, turn_id, run_id, session_id, tool_name, started_unix_ms,
      duration_ms, is_error, error_class, args_chars, result_chars, result_hash,
      args_json, result_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const x of tools) {
    insertTool.run(
      x.tool_call_id, x.turn_id, x.run_id, x.session_id, x.tool_name, x.started_unix_ms,
      x.duration_ms, x.is_error, x.error_class, x.args_chars, x.result_chars, x.result_hash,
      x.args_json, x.result_text,
    );
  }

  const insertBash = db.prepare(`
    INSERT INTO bash_executions (
      bash_id, session_id, cwd, started_unix_ms, duration_ms, exit_code,
      cancelled, truncated, output_chars, exclude_from_context, command_chars, command_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const b of bash) {
    insertBash.run(
      b.bash_id, b.session_id, b.cwd, b.started_unix_ms, b.duration_ms, b.exit_code,
      b.cancelled, b.truncated, b.output_chars, b.exclude_from_context, b.command_chars, b.command_hash,
    );
  }

  const insertFeedback = db.prepare(`
    INSERT INTO feedback (
      feedback_id, session_id, run_id, turn_index, received_unix_ms, source, kind, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const f of feedback) {
    insertFeedback.run(
      f.feedback_id, f.session_id, f.run_id, f.turn_index, f.received_unix_ms, f.source, f.kind, f.data,
    );
  }

  const insertMeta = db.prepare(`
    INSERT INTO telemetry_meta (unix_ms, level, event, detail, session_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const m of meta) {
    insertMeta.run(m.unix_ms, m.level, m.event, m.detail, m.session_id);
  }

  db.exec("COMMIT");
  return db;
}
