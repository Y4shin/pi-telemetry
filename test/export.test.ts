import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { seedFixture } from "./helpers/fixture-db.ts";
import { toCsv, exportDatabase, exportTable } from "../src/query/export.ts";

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trimEnd().split("\n");
  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").replace(/""/g, '"'));
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const row: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of lines[i]) {
      if (ch === '"') {
        if (inQuotes && lines[i][lines[i].indexOf(ch) + 1] === '"') {
          // handled below by doubling? Simpler: just append quote and toggle handled via peek is hard.
        }
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        row.push(current.replace(/^"|"$/g, "").replace(/""/g, '"'));
        current = "";
      } else {
        current += ch;
      }
    }
    row.push(current.replace(/^"|"$/g, "").replace(/""/g, '"'));
    rows.push(row);
  }
  return { headers, rows };
}

describe("export", () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseSync;
  const now = Date.now();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
    dbPath = join(tmp, "telemetry.db");
    db = seedFixture(dbPath, { now });
  });

  afterEach(() => {
    try {
      db.close();
    } catch { /* ignore */ }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("renders header and rows as CSV", () => {
    const csv = toCsv({
      columns: ["a", "b"],
      rows: [
        [1, 2],
        [3, 4],
      ],
      truncated: false,
    });
    assert.strictEqual(csv, "a,b\n1,2\n3,4\n");
  });

  it("escapes commas, quotes, and newlines", () => {
    const csv = toCsv({
      columns: ["x"],
      rows: [['a,b'], ['a"b'], ["a\nb"]],
      truncated: false,
    });
    assert.strictEqual(csv, 'x\n"a,b"\n"a""b"\n"a\nb"\n');
  });

  it("round-trips a table through CSV", async () => {
    const result = await exportTable(dbPath, "sessions");
    const csv = toCsv(result);
    const parsed = parseCsv(csv);
    assert.ok(parsed.headers.includes("session_id"));
    assert.strictEqual(parsed.rows.length, 2);
  });

  it("exports a single table to a file", async () => {
    const out = join(tmp, "sessions.csv");
    const written = await exportDatabase(dbPath, { table: "sessions", out });
    assert.deepStrictEqual(written, [out]);
    const text = readFileSync(out, "utf8");
    assert.ok(text.startsWith("session_id"));
    assert.ok(text.includes("sess-root"));
  });

  it("exports all tables when no table is specified", async () => {
    const written = await exportDatabase(dbPath, { out: join(tmp, "dump") });
    assert.strictEqual(written.length, 8);
    for (const path of written) {
      const text = readFileSync(path, "utf8");
      assert.ok(text.includes("\n"));
    }
  });

  it("honors time filters", async () => {
    const out = join(tmp, "turns.csv");
    await exportDatabase(dbPath, {
      table: "turns",
      from: now + 1,
      to: now + 1000,
      out,
    });
    const text = readFileSync(out, "utf8");
    const parsed = parseCsv(text);
    // All fixture turns are in the past, so filter should exclude them.
    assert.strictEqual(parsed.rows.length, 0);
  });
});
