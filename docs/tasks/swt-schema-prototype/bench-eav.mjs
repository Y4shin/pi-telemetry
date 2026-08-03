// THROWAWAY PROTOTYPE — swt-schema-prototype (EAV extension)
// Pure node:sqlite benchmark. NO Pi, NO LLM, NO extension code. Temp DBs only.
//
// Extends bench.mjs with two EAV variants for migration-free arbitrary typed
// metadata, compared against Option A (generated VIRTUAL columns):
//   A)  generated VIRTUAL columns + indexes on session_events (from bench.mjs)
//   C)  typed EAV: session_event_metadata + 4 typed value tables (string/int/float/bool)
//   D)  sparse EAV: one session_event_metadata table with nullable value_* cols
//       + a CHECK constraint (exactly one value col non-null AND it matches `type`)
//
// The pivot compare-versions query selects 3 keys (version=filter, skill=group,
// run_id=join to turns) — the honest multi-key cost EAV exists to serve — and
// joins skill_invoke -> turns (on run_id) -> tools (on turn_id), groups by skill.
// Also measures write cost (inserts per event with 5 keys) and verifies the
// sparse-EAV CHECK constraint rejects malformed rows.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, started_unix_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL, started_unix_ms INTEGER NOT NULL, cost_total_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE TABLE IF NOT EXISTS tool_executions (
  tool_call_id TEXT PRIMARY KEY, turn_id TEXT, session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, is_error INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_turn ON tool_executions(turn_id);
CREATE TABLE IF NOT EXISTS session_events (
  event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, unix_ms INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sev_session ON session_events(session_id);
`;

const SKILLS = ["implement-task", "wayfinder", "finalize-task", "report-bug", "create-task"];
const VERSIONS = ["2.4.0", "2.5.0", "2.5.1"];
const TARGETS = Array.from({ length: 20 }, (_, i) => `task-${i}`);
// 5 metadata keys per event: skill_name(s), skills_package_version(s), target(s), run_id(s), slice_count(i)
const KEYS = ["skill_name", "skills_package_version", "target", "run_id", "slice_count"];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function payloadFor(skill, version, target, runId, sliceCount) {
  return JSON.stringify({
    skill_name: skill, skill_source: "task-workflow", skills_package_version: version,
    args_chars: 12, args_hash: "sha256:deadbeef", input_source: "interactive",
    run_id: runId, turn_id: null, turn_index: null,
    target, map: null, slice: null, slice_count: sliceCount, extra: {},
  });
}

// Populate sessions/turns/tools + session_events (JSON payload). Returns event
// descriptors so each EAV variant can project its metadata rows identically.
function populateBase(db, N, seed) {
  const rng = mulberry32(seed);
  const now = Date.now();
  const sessionCount = Math.ceil(N / 5);
  const insSession = db.prepare("INSERT INTO sessions (session_id, started_unix_ms) VALUES (?, ?)");
  const insTurn = db.prepare("INSERT INTO turns (turn_id, run_id, session_id, turn_index, started_unix_ms, cost_total_usd) VALUES (?, ?, ?, ?, ?, ?)");
  const insTool = db.prepare("INSERT INTO tool_executions (tool_call_id, turn_id, session_id, tool_name, is_error) VALUES (?, ?, ?, ?, ?)");
  const insEvent = db.prepare("INSERT INTO session_events (event_id, session_id, unix_ms, type, payload) VALUES (?, ?, ?, ?, ?)");
  const events = [];
  db.exec("BEGIN");
  try {
    for (let s = 0; s < sessionCount; s++) insSession.run(`sess-${seed}-${s}`, now - (sessionCount - s) * 1000);
    for (let i = 0; i < N; i++) {
      const sid = `sess-${seed}-${Math.floor(rng() * sessionCount)}`;
      const skill = SKILLS[Math.floor(rng() * SKILLS.length)];
      const version = VERSIONS[Math.floor(rng() * VERSIONS.length)];
      const target = TARGETS[Math.floor(rng() * TARGETS.length)];
      const runId = `run-${seed}-${i}`;
      const sliceCount = 1 + Math.floor(rng() * 10);
      for (let t = 0; t < 10; t++) {
        const tid = `turn-${seed}-${i}-${t}`;
        insTurn.run(tid, runId, sid, t, now, 0.01 + rng() * 0.5);
        for (let k = 0; k < 3; k++) insTool.run(`tool-${seed}-${i}-${t}-${k}`, tid, sid, "bash", rng() < 0.1 ? 1 : 0);
      }
      const eid = randomUUID();
      insEvent.run(eid, sid, now - Math.floor(rng() * 100000), "skill_invoke", payloadFor(skill, version, target, runId, sliceCount));
      events.push({ eid, sid, skill, version, target, runId, sliceCount });
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return events;
}

// ── Option A: generated VIRTUAL columns + indexes ──
function applyOptionA(db) {
  db.exec(`ALTER TABLE session_events ADD COLUMN skill_name_gen TEXT GENERATED ALWAYS AS (json_extract(payload, '$.skill_name')) VIRTUAL`);
  db.exec(`ALTER TABLE session_events ADD COLUMN pkg_version_gen TEXT GENERATED ALWAYS AS (json_extract(payload, '$.skills_package_version')) VIRTUAL`);
  db.exec(`ALTER TABLE session_events ADD COLUMN run_id_gen TEXT GENERATED ALWAYS AS (json_extract(payload, '$.run_id')) VIRTUAL`);
  db.exec(`CREATE INDEX idx_sev_skill_ver ON session_events(pkg_version_gen, skill_name_gen)`);
  db.exec(`CREATE INDEX idx_sev_run ON session_events(run_id_gen)`);
  db.exec(`CREATE INDEX idx_turns_run ON turns(run_id)`);
}

// ── Option C: typed EAV (5 tables) ──
const EAV_TYPED_SCHEMA = `
CREATE TABLE session_event_metadata (
  metadata_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES session_events(event_id),
  key         TEXT NOT NULL,
  type        TEXT NOT NULL,
  UNIQUE(event_id, key)
);
CREATE INDEX idx_semt_event ON session_event_metadata(event_id);
CREATE INDEX idx_semt_key   ON session_event_metadata(key);
CREATE TABLE metadata_string (metadata_id INTEGER PRIMARY KEY REFERENCES session_event_metadata(metadata_id), value TEXT NOT NULL);
CREATE INDEX idx_mstr_value ON metadata_string(value);
CREATE TABLE metadata_int    (metadata_id INTEGER PRIMARY KEY REFERENCES session_event_metadata(metadata_id), value INTEGER NOT NULL);
CREATE INDEX idx_mint_value ON metadata_int(value);
CREATE TABLE metadata_float  (metadata_id INTEGER PRIMARY KEY REFERENCES session_event_metadata(metadata_id), value REAL NOT NULL);
CREATE TABLE metadata_bool   (metadata_id INTEGER PRIMARY KEY REFERENCES session_event_metadata(metadata_id), value INTEGER NOT NULL);
`;

function applyOptionC(db, events) {
  db.exec(EAV_TYPED_SCHEMA);
  db.exec(`CREATE INDEX idx_turns_run ON turns(run_id)`);
  const insMeta = db.prepare(`INSERT INTO session_event_metadata (event_id, key, type) VALUES (?, ?, ?)`);
  const insStr = db.prepare(`INSERT INTO metadata_string (metadata_id, value) VALUES (?, ?)`);
  const insInt = db.prepare(`INSERT INTO metadata_int (metadata_id, value) VALUES (?, ?)`);
  db.exec("BEGIN");
  try {
    for (const e of events) {
      const str = (k, v) => { const r = insMeta.run(e.eid, k, "string"); insStr.run(r.lastInsertRowid, v); };
      const int = (k, v) => { const r = insMeta.run(e.eid, k, "int"); insInt.run(r.lastInsertRowid, v); };
      str("skill_name", e.skill);
      str("skills_package_version", e.version);
      str("target", e.target);
      str("run_id", e.runId);
      int("slice_count", e.sliceCount);
    }
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
}

// ── Option D: sparse EAV (1 table + CHECK constraint) ──
// CHECK: exactly one value_* column non-null AND it matches `type`.
const EAV_SPARSE_SCHEMA = `
CREATE TABLE session_event_metadata (
  event_id   TEXT NOT NULL REFERENCES session_events(event_id),
  key        TEXT NOT NULL,
  type        TEXT NOT NULL,
  value_text  TEXT,
  value_int   INTEGER,
  value_real  REAL,
  value_bool  INTEGER,
  PRIMARY KEY (event_id, key),
  CHECK (
       (type = 'string' AND value_text IS NOT NULL AND value_int IS NULL AND value_real IS NULL AND value_bool IS NULL)
    OR (type = 'int'    AND value_int  IS NOT NULL AND value_text IS NULL AND value_real IS NULL AND value_bool IS NULL)
    OR (type = 'float'  AND value_real IS NOT NULL AND value_text IS NULL AND value_int  IS NULL AND value_bool IS NULL)
    OR (type = 'bool'   AND value_bool IS NOT NULL AND value_text IS NULL AND value_int  IS NULL AND value_real IS NULL)
  )
);
CREATE INDEX idx_sems_key_text ON session_event_metadata(key, value_text);
CREATE INDEX idx_sems_key_int  ON session_event_metadata(key, value_int);
`;

function applyOptionD(db, events) {
  db.exec(EAV_SPARSE_SCHEMA);
  db.exec(`CREATE INDEX idx_turns_run ON turns(run_id)`);
  const ins = db.prepare(`INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  try {
    for (const e of events) {
      ins.run(e.eid, "skill_name", "string", e.skill, null, null, null);
      ins.run(e.eid, "skills_package_version", "string", e.version, null, null, null);
      ins.run(e.eid, "target", "string", e.target, null, null, null);
      ins.run(e.eid, "run_id", "string", e.runId, null, null, null);
      ins.run(e.eid, "slice_count", "int", null, e.sliceCount, null, null);
    }
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
}

// ── Pivot compare-versions query (3 keys: version=filter, skill=group, run_id=join) ──
const QUERY_A = `
SELECT se.pkg_version_gen AS ver, se.skill_name_gen AS skill, COUNT(*) AS invocations,
  ROUND(SUM(t.cost_total_usd), 3) AS cost_usd, SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_events se
JOIN turns t ON t.run_id = se.run_id_gen
JOIN tool_executions te ON te.turn_id = t.turn_id
WHERE se.type = 'skill_invoke' AND se.pkg_version_gen = ?
GROUP BY se.pkg_version_gen, se.skill_name_gen ORDER BY se.skill_name_gen`;

const QUERY_C = `
SELECT m_ver_t.value AS ver, m_skill_t.value AS skill, COUNT(*) AS invocations,
  ROUND(SUM(t.cost_total_usd), 3) AS cost_usd, SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_event_metadata m_ver
JOIN metadata_string m_ver_t ON m_ver_t.metadata_id = m_ver.metadata_id
JOIN session_event_metadata m_skill ON m_skill.event_id = m_ver.event_id AND m_skill.key = 'skill_name'
JOIN metadata_string m_skill_t ON m_skill_t.metadata_id = m_skill.metadata_id
JOIN session_event_metadata m_run ON m_run.event_id = m_ver.event_id AND m_run.key = 'run_id'
JOIN metadata_string m_run_t ON m_run_t.metadata_id = m_run.metadata_id
JOIN turns t ON t.run_id = m_run_t.value
JOIN tool_executions te ON te.turn_id = t.turn_id
WHERE m_ver.key = 'skills_package_version' AND m_ver_t.value = ?
GROUP BY m_ver_t.value, m_skill_t.value ORDER BY m_skill_t.value`;

const QUERY_D = `
SELECT m_ver.value_text AS ver, m_skill.value_text AS skill, COUNT(*) AS invocations,
  ROUND(SUM(t.cost_total_usd), 3) AS cost_usd, SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END) AS tool_errors
FROM session_event_metadata m_ver
JOIN session_event_metadata m_skill ON m_skill.event_id = m_ver.event_id AND m_skill.key = 'skill_name'
JOIN session_event_metadata m_run ON m_run.event_id = m_ver.event_id AND m_run.key = 'run_id'
JOIN turns t ON t.run_id = m_run.value_text
JOIN tool_executions te ON te.turn_id = t.turn_id
WHERE m_ver.key = 'skills_package_version' AND m_ver.value_text = ?
GROUP BY m_ver.value_text, m_skill.value_text ORDER BY m_skill.value_text`;

function median(arr) { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function bench(db, q, p, runs = 50) { for (let i = 0; i < 5; i++) db.prepare(q).all(p); const ts = []; for (let i = 0; i < runs; i++) { const a = process.hrtime.bigint(); db.prepare(q).all(p); ts.push(Number(process.hrtime.bigint() - a) / 1e6); } return median(ts); }
function plan(db, q, p) { return db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(p).map((r) => r.detail).join(" | "); }
function freshDb() { const dir = mkdtempSync(join(tmpdir(), "swt-eav-")); const db = new DatabaseSync(join(dir, "bench.db")); db.exec(SCHEMA); return { db, dir }; }

// Verify the sparse-EAV CHECK constraint rejects malformed rows.
function verifyCheckConstraint() {
  const { db, dir } = freshDb();
  db.exec(EAV_SPARSE_SCHEMA);
  // Insert a parent session_event row first so the FK is satisfied; we are
  // testing the CHECK constraint, not the FK.
  db.prepare(`INSERT INTO session_events (event_id, session_id, unix_ms, type, payload) VALUES (?, ?, ?, ?, ?)`).run("e0", "s0", 0, "skill_invoke", "{}");
  const ins = db.prepare(`INSERT INTO session_event_metadata (event_id, key, type, value_text, value_int, value_real, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let failures = [];
  // valid: string
  try { ins.run("e0", "k", "string", "v", null, null, null); } catch (e) { failures.push("valid string rejected: " + e.message); }
  // valid: int
  try { ins.run("e0", "k2", "int", null, 5, null, null); } catch (e) { failures.push("valid int rejected: " + e.message); }
  // invalid: type=string but value_int set
  try { ins.run("e0", "k3", "string", null, 5, null, null); failures.push("type=string+value_int NOT rejected"); } catch (e) { if (!/CHECK/.test(e.message)) failures.push("wrong error (string+int): " + e.message); }
  // invalid: type=int but value_text set
  try { ins.run("e0", "k4", "int", "v", null, null, null); failures.push("type=int+value_text NOT rejected"); } catch (e) { if (!/CHECK/.test(e.message)) failures.push("wrong error (int+text): " + e.message); }
  // invalid: two value cols non-null
  try { ins.run("e0", "k5", "string", "v", 5, null, null); failures.push("two-non-null NOT rejected"); } catch (e) { if (!/CHECK/.test(e.message)) failures.push("wrong error (two-non-null): " + e.message); }
  // invalid: all value cols null
  try { ins.run("e0", "k6", "string", null, null, null, null); failures.push("all-null NOT rejected"); } catch (e) { if (!/CHECK/.test(e.message)) failures.push("wrong error (all-null): " + e.message); }
  db.close(); rmSync(dir, { recursive: true, force: true });
  return failures;
}

function runOne(N) {
  const seed = 42;
  const out = { N };

  // Option A (generated columns) — re-run for same-process fairness
  {
    const { db, dir } = freshDb();
    const events = populateBase(db, N, seed);
    const t0 = process.hrtime.bigint(); applyOptionA(db); const applyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const rows = db.prepare(QUERY_A).all("2.5.1");
    out.optionA = { correct: rows.length > 0 && rows.every((r) => r.ver === "2.5.1"), rowCount: rows.length, applyMs: Math.round(applyMs * 100) / 100, plan: plan(db, QUERY_A, "2.5.1"), ms: bench(db, QUERY_A, "2.5.1") };
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
  // Option C (typed EAV, 5 tables)
  {
    const { db, dir } = freshDb();
    const events = populateBase(db, N, seed);
    const t0 = process.hrtime.bigint(); applyOptionC(db, events); const applyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const rows = db.prepare(QUERY_C).all("2.5.1");
    out.optionC = { correct: rows.length > 0 && rows.every((r) => r.ver === "2.5.1"), rowCount: rows.length, applyMs: Math.round(applyMs * 100) / 100, plan: plan(db, QUERY_C, "2.5.1"), ms: bench(db, QUERY_C, "2.5.1") };
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
  // Option D (sparse EAV, 1 table + CHECK)
  {
    const { db, dir } = freshDb();
    const events = populateBase(db, N, seed);
    const t0 = process.hrtime.bigint(); applyOptionD(db, events); const applyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const rows = db.prepare(QUERY_D).all("2.5.1");
    out.optionD = { correct: rows.length > 0 && rows.every((r) => r.ver === "2.5.1"), rowCount: rows.length, applyMs: Math.round(applyMs * 100) / 100, plan: plan(db, QUERY_D, "2.5.1"), ms: bench(db, QUERY_D, "2.5.1") };
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

console.log("=== swt-schema-prototype EAV extension ===\n");
const chk = verifyCheckConstraint();
console.log("sparse-EAV CHECK constraint verification:");
console.log(chk.length === 0 ? "  PASS — valid rows accepted, malformed rows (wrong-type value, two-non-null, all-null) rejected with CHECK failed" : `  FAIL: ${chk.join("; ")}`);
console.log();

const Ns = [1000, 10000, 100000];
const results = Ns.map((N) => { console.error(`[bench-eav] running N=${N} ...`); return runOne(N); });

console.log("Pivot query: 3 keys (version=filter, skill_name=group, run_id=join to turns).");
console.log("5 metadata keys/event (skill_name, version, target, run_id, slice_count[int]).");
console.log("Each skill_invoke = 1 run of 10 turns, 3 tools/turn (~10% error). Median over 50 warmed runs.\n");
for (const r of results) {
  console.log(`## N = ${r.N} skill_invoke rows (${r.N * 10} turns, ${r.N * 30} tools)`);
  for (const [k, label] of [["optionA", "A (generated VIRTUAL cols)"], ["optionC", "C (typed EAV, 5 tables)"], ["optionD", "D (sparse EAV, 1 table + CHECK)"]]) {
    console.log(`  ${label}: correct=${r[k].correct} rows=${r[k].rowCount} applyMs=${r[k].applyMs} ms=${r[k].ms.toFixed(3)}`);
    console.log(`    plan: ${r[k].plan}`);
  }
  console.log();
}
