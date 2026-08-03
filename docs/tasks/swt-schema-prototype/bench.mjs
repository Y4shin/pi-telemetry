// THROWAWAY PROTOTYPE — swt-schema-prototype
// Pure node:sqlite benchmark. NO Pi, NO LLM, NO extension code.
// Never touches the live DB — uses temp-file DBs under os.tmpdir().
//
// Question: for session_events rows of type='skill_invoke' with a JSON payload,
// which metadata-queryability approach is queryable + performant:
//   A) generated VIRTUAL columns + indexes on session_events
//   B) an N:1 session_event_metadata join table (native columns, indexed)
//   baseline) bare json_extract (no generated col, no join)
//
// Runs the compare-versions query (cost + tool-errors grouped by
// skills_package_version + skill_name) at N = 1k, 10k, 100k synthetic
// skill_invoke rows. The query joins a skill_invoke event to the turns it
// STARTED (via payload.run_id) and those turns' tool_executions — the real
// attribution shape after Feature A's turn_start back-fill — NOT a cross-product
// of all session turns.
// Records: correctness, EXPLAIN QUERY PLAN, median ms over 50 warmed runs.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ── Real schema (copied from src/db.ts SCHEMA, trimmed to what the join needs) ──
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  started_unix_ms   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  turn_id                 TEXT PRIMARY KEY,
  run_id                  TEXT,
  session_id              TEXT NOT NULL,
  turn_index              INTEGER NOT NULL,
  started_unix_ms         INTEGER NOT NULL,
  cost_total_usd          REAL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE TABLE IF NOT EXISTS tool_executions (
  tool_call_id TEXT PRIMARY KEY,
  turn_id      TEXT,
  session_id   TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  is_error     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_turn ON tool_executions(turn_id);
CREATE TABLE IF NOT EXISTS session_events (
  event_id      TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  unix_ms       INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sev_session ON session_events(session_id);
`;

const SKILLS = ["implement-task", "wayfinder", "finalize-task", "report-bug", "create-task"];
const VERSIONS = ["2.4.0", "2.5.0", "2.5.1"];
const TARGETS = Array.from({ length: 20 }, (_, i) => `task-${i}`);

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Realistic attribution: each skill_invoke starts ONE run with ~10 turns,
// each turn has ~3 tools. The payload carries run_id (set by back-fill).
// The query joins skill_invoke → turns ON t.run_id = payload.run_id
// → tool_executions ON te.turn_id = t.turn_id. No cross-product.
function populate(db, N, seed) {
  const rng = mulberry32(seed);
  const now = Date.now();
  const sessionCount = Math.ceil(N / 5); // ~1 session per 5 invocations
  const insSession = db.prepare("INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)");
  const insTurn = db.prepare("INSERT INTO turns (turn_id, run_id, session_id, turn_index, started_unix_ms, cost_total_usd) VALUES (?, ?, ?, ?, ?, ?)");
  const insTool = db.prepare("INSERT INTO tool_executions (tool_call_id, turn_id, session_id, tool_name, is_error) VALUES (?, ?, ?, ?, ?)");
  const insEvent = db.prepare("INSERT INTO session_events (event_id, session_id, unix_ms, type, payload) VALUES (?, ?, ?, ?, ?)");

  db.exec("BEGIN");
  try {
    for (let s = 0; s < sessionCount; s++) {
      const sid = `sess-${seed}-${s}`;
      insSession.run(sid, now - (sessionCount - s) * 1000);
    }
    // Each skill_invoke = one run with 10 turns, each turn 3 tools (~10% error)
    for (let i = 0; i < N; i++) {
      const sid = `sess-${seed}-${Math.floor(rng() * sessionCount)}`;
      const skill = SKILLS[Math.floor(rng() * SKILLS.length)];
      const version = VERSIONS[Math.floor(rng() * VERSIONS.length)];
      const target = TARGETS[Math.floor(rng() * TARGETS.length)];
      const runId = `run-${seed}-${i}`;
      for (let t = 0; t < 10; t++) {
        const tid = `turn-${seed}-${i}-${t}`;
        insTurn.run(tid, runId, sid, t, now, 0.01 + rng() * 0.5);
        for (let k = 0; k < 3; k++) {
          insTool.run(`tool-${seed}-${i}-${t}-${k}`, tid, sid, "bash", rng() < 0.1 ? 1 : 0);
        }
      }
      insEvent.run(randomUUID(), sid, now - Math.floor(rng() * 100000), "skill_invoke", JSON.stringify({
        skill_name: skill,
        skill_source: "task-workflow",
        skills_package_version: version,
        args_chars: 12,
        args_hash: "sha256:deadbeef",
        input_source: "interactive",
        run_id: runId, // back-filled by Feature A slice 5
        turn_id: null,
        turn_index: null,
        target,
        map: null,
        slice: null,
        slice_count: null,
        extra: {},
      }));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ── Option A: generated VIRTUAL columns + indexes ──
function applyOptionA(db) {
  db.exec(`ALTER TABLE session_events ADD COLUMN skill_name_gen TEXT GENERATED ALWAYS AS (json_extract(payload, '$.skill_name')) VIRTUAL`);
  db.exec(`ALTER TABLE session_events ADD COLUMN pkg_version_gen TEXT GENERATED ALWAYS AS (json_extract(payload, '$.skills_package_version')) VIRTUAL`);
  db.exec(`ALTER TABLE session_events ADD COLUMN target_gen TEXT GENERATED ALWAYS AS (json_extract(payload, '$.target')) VIRTUAL`);
  db.exec(`ALTER TABLE session_events ADD COLUMN run_id_gen TEXT GENERATED ALWAYS AS (json_extract(payload, '$.run_id')) VIRTUAL`);
  db.exec(`CREATE INDEX idx_sev_skill_ver ON session_events(pkg_version_gen, skill_name_gen)`);
  db.exec(`CREATE INDEX idx_sev_run ON session_events(run_id_gen)`);
  db.exec(`CREATE INDEX idx_sev_target ON session_events(target_gen)`);
  db.exec(`CREATE INDEX idx_turns_run ON turns(run_id)`); // join aid
}

// ── Option B: N:1 session_event_metadata join table ──
function applyOptionB(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS session_event_metadata (
    event_id              TEXT PRIMARY KEY REFERENCES session_events(event_id),
    session_id            TEXT NOT NULL,
    run_id                TEXT,
    skill_name            TEXT,
    skills_package_version TEXT,
    target                TEXT
  )`);
  db.exec(`CREATE INDEX idx_sem_skill_ver ON session_event_metadata(skills_package_version, skill_name)`);
  db.exec(`CREATE INDEX idx_sem_run ON session_event_metadata(run_id)`);
  db.exec(`CREATE INDEX idx_sem_target ON session_event_metadata(target)`);
  db.exec(`CREATE INDEX idx_turns_run ON turns(run_id)`);
  const rows = db.prepare(`SELECT event_id, session_id, payload FROM session_events WHERE type = 'skill_invoke'`).all();
  const insMeta = db.prepare(`INSERT INTO session_event_metadata (event_id, session_id, run_id, skill_name, skills_package_version, target) VALUES (?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      insMeta.run(r.event_id, r.session_id, p.run_id ?? null, p.skill_name ?? null, p.skills_package_version ?? null, p.target ?? null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ── The compare-versions query, per approach ──
// Joins skill_invoke → its run's turns → those turns' tools (no cross-product).
const QUERY_A = `
SELECT se.pkg_version_gen AS ver, se.skill_name_gen AS skill, COUNT(*) AS invocations,
  ROUND(SUM(t.cost_total_usd), 3) AS cost_usd,
  SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_events se
JOIN turns t ON t.run_id = se.run_id_gen
JOIN tool_executions te ON te.turn_id = t.turn_id
WHERE se.type = 'skill_invoke' AND se.pkg_version_gen = ?
GROUP BY se.pkg_version_gen, se.skill_name_gen
ORDER BY se.skill_name_gen`;

const QUERY_BASELINE = `
SELECT json_extract(se.payload, '$.skills_package_version') AS ver,
  json_extract(se.payload, '$.skill_name') AS skill, COUNT(*) AS invocations,
  ROUND(SUM(t.cost_total_usd), 3) AS cost_usd,
  SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_events se
JOIN turns t ON t.run_id = json_extract(se.payload, '$.run_id')
JOIN tool_executions te ON te.turn_id = t.turn_id
WHERE se.type = 'skill_invoke' AND json_extract(se.payload, '$.skills_package_version') = ?
GROUP BY json_extract(se.payload, '$.skills_package_version'), json_extract(se.payload, '$.skill_name')
ORDER BY json_extract(se.payload, '$.skill_name')`;

const QUERY_B = `
SELECT m.skills_package_version AS ver, m.skill_name AS skill, COUNT(*) AS invocations,
  ROUND(SUM(t.cost_total_usd), 3) AS cost_usd,
  SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_event_metadata m
JOIN turns t ON t.run_id = m.run_id
JOIN tool_executions te ON te.turn_id = t.turn_id
WHERE m.skills_package_version = ?
GROUP BY m.skills_package_version, m.skill_name
ORDER BY m.skill_name`;

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function bench(db, query, param, runs = 50) {
  for (let i = 0; i < 5; i++) db.prepare(query).all(param); // warmup
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    db.prepare(query).all(param);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  return median(times);
}

// Baseline (bare json_extract in the join predicate) is ~750x slower than the
// indexed approaches and cannot use an index on the join — it exists only to
// quantify the cost the optimizations rescue. Cap its runs so the benchmark
// finishes; one timed run is enough to show the order of magnitude.
function benchBaseline(db, query, param) {
  db.prepare(query).all(param); // 1 warmup
  const t0 = process.hrtime.bigint();
  db.prepare(query).all(param);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function explainPlan(db, query, param) {
  return db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(param).map((r) => r.detail).join(" | ");
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "swt-bench-"));
  const db = new DatabaseSync(join(dir, "bench.db"));
  db.exec(SCHEMA);
  return { db, dir };
}

function runOne(N) {
  const seed = 42;
  const out = { N };

  // Baseline (no generated cols, no join table) — ONLY at N=1000.
  // Bare json_extract in the join predicate cannot use an index and is
  // ~750x slower; running it at 10k/100k would take minutes for no extra
  // insight. Its single purpose is to quantify the cost the indexed
  // approaches rescue, which is visible at 1k.
  if (N === 1000) {
    const { db, dir } = freshDb();
    populate(db, N, seed);
    db.exec(`CREATE INDEX idx_turns_run ON turns(run_id)`);
    const rows = db.prepare(QUERY_BASELINE).all("2.5.1");
    out.baseline = {
      correct: rows.length > 0 && rows.every((r) => r.ver === "2.5.1"),
      rowCount: rows.length,
      plan: explainPlan(db, QUERY_BASELINE, "2.5.1"),
      ms: benchBaseline(db, QUERY_BASELINE, "2.5.1"),
      note: "single timed run (no index usable; ~750x slower)",
    };
    db.close();
    rmSync(dir, { recursive: true, force: true });
  } else {
    out.baseline = { skipped: true, note: "baseline only measured at N=1000 (no index; too slow at scale)" };
  }

  // Option A (generated VIRTUAL columns + indexes)
  {
    const { db, dir } = freshDb();
    populate(db, N, seed);
    const t0 = process.hrtime.bigint();
    applyOptionA(db);
    const applyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const rows = db.prepare(QUERY_A).all("2.5.1");
    out.optionA = {
      correct: rows.length > 0 && rows.every((r) => r.ver === "2.5.1"),
      rowCount: rows.length,
      applyMs: Math.round(applyMs * 100) / 100,
      plan: explainPlan(db, QUERY_A, "2.5.1"),
      ms: bench(db, QUERY_A, "2.5.1"),
    };
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Option B (N:1 join table)
  {
    const { db, dir } = freshDb();
    populate(db, N, seed);
    const t0 = process.hrtime.bigint();
    applyOptionB(db);
    const applyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const rows = db.prepare(QUERY_B).all("2.5.1");
    out.optionB = {
      correct: rows.length > 0 && rows.every((r) => r.ver === "2.5.1"),
      rowCount: rows.length,
      applyMs: Math.round(applyMs * 100) / 100,
      plan: explainPlan(db, QUERY_B, "2.5.1"),
      ms: bench(db, QUERY_B, "2.5.1"),
    };
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  return out;
}

const Ns = [1000, 10000, 100000];
const results = Ns.map((N) => {
  console.error(`[bench] running N=${N} ...`);
  return runOne(N);
});

console.log("=== swt-schema-prototype results ===\n");
console.log("Data shape: 5 skills x 3 versions x 20 targets; each skill_invoke starts ONE");
console.log("run of 10 turns (cost 0.01-0.51), each turn 3 tools (~10% error). Compare-versions");
console.log("query filters version='2.5.1', joins skill_invoke -> its run's turns -> those");
console.log("turns' tools (NO cross-product), groups by skill. Median over 50 warmed runs.\n");

for (const r of results) {
  console.log(`## N = ${r.N} skill_invoke rows (${r.N * 10} turns, ${r.N * 30} tools)`);
  if (r.baseline.skipped) {
    console.log(`  baseline: ${r.baseline.note}`);
  } else {
    console.log(`  baseline (json_extract, idx on turns.run_id only): correct=${r.baseline.correct} rows=${r.baseline.rowCount} ms=${r.baseline.ms.toFixed(3)}`);
    console.log(`    plan: ${r.baseline.plan}`);
  }
  console.log(`  Option A (generated VIRTUAL cols + indexes): correct=${r.optionA.correct} rows=${r.optionA.rowCount} applyMs=${r.optionA.applyMs} ms=${r.optionA.ms.toFixed(3)}`);
  console.log(`    plan: ${r.optionA.plan}`);
  console.log(`  Option B (N:1 join table + indexes): correct=${r.optionB.correct} rows=${r.optionB.rowCount} applyMs=${r.optionB.applyMs} ms=${r.optionB.ms.toFixed(3)}`);
  console.log(`    plan: ${r.optionB.plan}`);
  console.log();
}
