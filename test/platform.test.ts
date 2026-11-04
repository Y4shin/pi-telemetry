import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { FIXTURE_CWD, FIXTURE_ROOT, FIXTURE_TOOL_PATH } from "./helpers/fixture-paths.ts";

/**
 * Guards for the platform-coupled surfaces that no unit test can reach by
 * calling code: the instruction text inside the shipped skills, the test
 * fixtures themselves, the npm scripts and the CI matrix. These run on every
 * platform; the OS-specific assertions live in test/config.test.ts.
 */

const REPO_ROOT = join(import.meta.dirname, "..");
const SKILLS_DIR = join(REPO_ROOT, "skills");
const SKILL_WINDOW = 6;

interface ShippedSkill {
  name: string;
  lines: string[];
}

function shippedSkills(): ShippedSkill[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      lines: readFileSync(join(SKILLS_DIR, entry.name, "SKILL.md"), "utf8").split("\n"),
    }));
}

/** The nearest line at or above `index` that names a POSIX platform. */
function platformLabel(lines: string[], index: number): string | null {
  for (let i = Math.max(0, index - SKILL_WINDOW); i <= index; i++) {
    if (/\b(linux|macos|posix)\b/i.test(lines[i])) return lines[i].trim();
  }
  return null;
}

/**
 * The markdown heading that owns the line at `index`, or "" above the first
 * one. Fenced blocks are skipped: a `# comment` inside a bash fence is not a
 * heading.
 */
function sectionHeading(lines: string[], index: number): string {
  let heading = "";
  let inFence = false;
  for (let i = 0; i <= index; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,6}\s/.test(lines[i])) heading = lines[i].trim();
  }
  return heading;
}

describe("fixture paths", () => {
  it("are absolute and live under the OS temp directory", () => {
    for (const path of [FIXTURE_ROOT, FIXTURE_CWD, FIXTURE_TOOL_PATH]) {
      assert.ok(isAbsolute(path), `${path} should be absolute`);
      assert.ok(path.startsWith(tmpdir()), `${path} should live under ${tmpdir()}`);
    }
  });
});

describe("shipped skill instructions", () => {
  const POSIX_VENV = /\.venv\/bin\//;

  it("label every POSIX venv path with a platform", () => {
    for (const skill of shippedSkills()) {
      skill.lines.forEach((line, index) => {
        if (!POSIX_VENV.test(line)) return;
        assert.ok(
          platformLabel(skill.lines, index) !== null,
          `${skill.name}/SKILL.md:${index + 1}: POSIX venv path without a Linux/macOS label within ${SKILL_WINDOW} lines: ${line.trim()}`,
        );
      });
    }
  });

  it("pair every POSIX venv path with the Windows Scripts layout in the same section", () => {
    for (const skill of shippedSkills()) {
      const perSection = new Map<string, { posix: boolean; windows: boolean }>();
      skill.lines.forEach((line, index) => {
        const heading = sectionHeading(skill.lines, index);
        const entry = perSection.get(heading) ?? { posix: false, windows: false };
        if (POSIX_VENV.test(line)) entry.posix = true;
        if (line.includes(".venv\\Scripts")) entry.windows = true;
        perSection.set(heading, entry);
      });
      for (const [heading, entry] of perSection) {
        if (!entry.posix) continue;
        assert.ok(
          entry.windows,
          `${skill.name}/SKILL.md: section "${heading}" gives a .venv/bin command but no .venv\\Scripts form`,
        );
      }
    }
  });

  it("keep Linux-only environment advice under a Linux heading", () => {
    for (const skill of shippedSkills()) {
      skill.lines.forEach((line, index) => {
        if (!line.includes("LD_LIBRARY_PATH")) return;
        const heading = sectionHeading(skill.lines, index);
        assert.ok(
          /(nixos|linux)/i.test(heading),
          `${skill.name}/SKILL.md:${index + 1}: LD_LIBRARY_PATH sits under "${heading}", which does not scope it to Linux`,
        );
      });
    }
  });
});

describe("package manifest", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    engines?: { node?: string };
  };

  it("quotes the test glob so cmd.exe passes it through", () => {
    const script = pkg.scripts.test;
    assert.ok(
      script.includes('"test/**/*.test.ts"'),
      `expected a double-quoted glob, got: ${script}`,
    );
    assert.ok(
      !script.includes("'test/**/*.test.ts'"),
      "single quotes reach cmd.exe as literal characters, so the glob matches nothing",
    );
  });

  it("declares the Node version the suite needs", () => {
    assert.strictEqual(pkg.engines?.node, ">=24");
  });
});

describe("continuous integration", () => {
  const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");

  it("runs install, typecheck and tests on Windows and Linux", () => {
    for (const expected of [
      "windows-latest",
      "ubuntu-latest",
      "npm ci",
      "npm run check",
      "npm test",
    ]) {
      assert.ok(ci.includes(expected), `.github/workflows/ci.yml should contain: ${expected}`);
    }
  });
});
