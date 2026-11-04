#!/usr/bin/env node
// Release helper: changeset version -> commit -> tag -> push. CI stages the tag.
//
// Usage: npm run release -- [--yes]
//        node scripts/release.mjs [--yes]
//
//   --yes  skip the confirmation prompt (for a non-interactive run)
//
// Runs on Linux, macOS and Windows with Node >= 24 and the standard library
// only. scripts/release.sh remains as a POSIX entry point that execs this file.
//
// Changesets is the source of truth for the version bump and the changelog
// entry: each .changeset/<name>.md declares a level (major/minor/patch) and a
// summary; `changeset version` consumes them, bumps package.json, and writes
// the entry to the repo-root CHANGELOG.md. This script commits that bump and
// changelog, tags vX.Y.Z, and pushes commit and tag. The tag triggers
// .github/workflows/release.yml, which verifies the code and STAGES the
// version on npm. A maintainer then approves it with 2FA; nothing reaches the
// registry from this machine.
//
// Preconditions:
//   - No pending or staged changes in the worktree.
//   - A remote (origin) configured for pushing the commit and tag.
//   - @changesets/cli installed (run `npm ci` if not).
//   - At least one pending changeset under .changeset/ (else nothing to release).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";

const RELEASE_BRANCH = "main";
const CHANGESETS_BIN = join("node_modules", "@changesets", "cli", "bin.js");

function error(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message, code = 1) {
  error(message);
  process.exit(code);
}

/** Run a command and return its trimmed stdout. Throws if it exits non-zero. */
function capture(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

const IS_WINDOWS = process.platform === "win32";

/** Run a command and return its exit status without throwing. */
function status(command, args, options = {}) {
  // npm is a .cmd shim on Windows, and Node refuses to spawn .cmd without a
  // shell there. Git resolves as a normal executable on every platform.
  const shim = IS_WINDOWS && command === "npm" ? "npm.cmd" : command;
  const shell = IS_WINDOWS && shim.endsWith(".cmd");
  return spawnSync(shim, args, { stdio: "ignore", shell, ...options }).status ?? 1;
}

function git(...args) {
  return capture("git", args);
}

function readPackageVersion() {
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

function readPackageName() {
  return JSON.parse(readFileSync("package.json", "utf8")).name;
}

const args = process.argv.slice(2);
let assumeYes = false;
for (const arg of args) {
  if (arg === "-y" || arg === "--yes") {
    assumeYes = true;
  } else {
    fail(`Error: unknown argument '${arg}'. Usage: release.mjs [--yes]`, 2);
  }
}

// --------------------------------------------------------------------------
// 1. Preconditions: the release branch, and a clean worktree
// --------------------------------------------------------------------------
// Always operate from the repository root, regardless of cwd.
process.chdir(git("rev-parse", "--show-toplevel"));

// The tag is cut from the branch that is checked out, so releasing from a
// feature branch tags a commit that main does not have.
const currentBranch = git("rev-parse", "--abbrev-ref", "HEAD");
if (currentBranch !== RELEASE_BRANCH) {
  fail(
    `Error: releases are cut from ${RELEASE_BRANCH}, and this is '${currentBranch}'.\n` +
      `Merge this work into ${RELEASE_BRANCH}, then run the release there.`,
  );
}

// Behind the remote is a real problem: the tag would miss commits that origin
// already has. Ahead is normal, because the release commit is local.
if (status("git", ["rev-parse", "-q", "--verify", `refs/remotes/origin/${RELEASE_BRANCH}`]) === 0) {
  const behind = Number(git("rev-list", "--count", `HEAD..origin/${RELEASE_BRANCH}`));
  if (behind > 0) {
    fail(
      `Error: ${RELEASE_BRANCH} is ${behind} commit(s) behind origin/${RELEASE_BRANCH}.\n` +
        "Pull or merge first, then run the release.",
    );
  }
}

const worktreeClean = status("git", ["diff", "--quiet"]) === 0 && status("git", ["diff", "--cached", "--quiet"]) === 0;
if (!worktreeClean) {
  error("Error: worktree has pending or staged changes. Commit or stash first.\n");
  error(git("status", "--short"));
  process.exit(1);
}

// --------------------------------------------------------------------------
// 2. Guard: @changesets/cli must be installed
// --------------------------------------------------------------------------
// Run the vendored CLI through the current Node binary. That resolves the same
// way on every platform, unlike node_modules/.bin shims, which are shell
// scripts on POSIX and .cmd wrappers on Windows.
if (!existsSync(CHANGESETS_BIN)) {
  fail("Error: @changesets/cli is not installed. Run `npm ci` first.");
}

// --------------------------------------------------------------------------
// 3. Guard: at least one pending changeset (else nothing to release)
// --------------------------------------------------------------------------
const pendingChangesets = readdirSync(".changeset").filter(
  (name) => name.endsWith(".md") && name !== "README.md",
);
if (pendingChangesets.length === 0) {
  error("No pending changesets under .changeset/. Nothing to release.");
  process.exit(0);
}

const currentVersion = readPackageVersion();
console.log(`Current version: ${currentVersion}`);
console.log("Pending changesets:");
for (const name of pendingChangesets) console.log(`  .changeset/${name}`);
console.log();

// --------------------------------------------------------------------------
// 4. Run `changeset version` (consumes the changesets, bumps package.json,
//    writes the changelog entry)
// --------------------------------------------------------------------------
execFileSync(process.execPath, [CHANGESETS_BIN, "version"], { stdio: "inherit" });

// changesets bumps package.json but leaves the lockfile's own root version
// stale, which `npm ci` then reports as a mismatch at release time.
const lockStatus = status("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
if (lockStatus !== 0) {
  fail("Error: updating package-lock.json failed.");
}

const newVersion = readPackageVersion();
if (newVersion === currentVersion) {
  fail("changeset version did not bump the version (no version-level changesets?). Aborting.");
}
console.log();
console.log(`Bumped ${currentVersion} -> ${newVersion}`);

// --------------------------------------------------------------------------
// 5. Confirm the changelog moved, and that the tag is free
// --------------------------------------------------------------------------
// Content, not `git diff`: the first release creates CHANGELOG.md as an
// untracked file, which `git diff` reports as no change at all.
const changelog = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
if (changelog.includes(`## ${newVersion}`)) {
  console.log(`CHANGELOG.md carries the ${newVersion} entry`);
} else {
  fail(`Error: CHANGELOG.md has no ${newVersion} section. Aborting.`);
}

if (status("git", ["rev-parse", "-q", "--verify", `refs/tags/v${newVersion}`]) === 0) {
  fail(`Error: tag v${newVersion} already exists. Aborting.`);
}

// --------------------------------------------------------------------------
// 6. Confirm before committing/tagging/pushing
// --------------------------------------------------------------------------
console.log();
console.log(`Staged for release v${newVersion}:`);
console.log(git("status", "--short"));
console.log();
if (assumeYes) {
  console.log("Proceeding without a prompt (--yes).");
} else {
  if (!process.stdin.isTTY) {
    error("Aborted: stdin is not a terminal. Re-run with --yes to confirm non-interactively.");
    error("The version bump and changelog are in the worktree; reset them manually.");
    process.exit(0);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Proceed with commit, tag v${newVersion}, and push to origin? (y/N) `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    error("Aborted. The version bump and changelog are in the worktree; reset them manually.");
    process.exit(0);
  }
}

// --------------------------------------------------------------------------
// 7. Stage, commit, tag
// --------------------------------------------------------------------------
git("add", "package.json", "package-lock.json", "CHANGELOG.md", ".changeset");
git("commit", "-q", "-m", `chore(release): releasing v${newVersion}`);
git("tag", `v${newVersion}`, "-m", `v${newVersion}`);
console.log(`Tagged v${newVersion}`);

// --------------------------------------------------------------------------
// 8. Push the commit, then the tag
// --------------------------------------------------------------------------
git("push", "origin", RELEASE_BRANCH);
git("push", "origin", `v${newVersion}`);

console.log();
console.log(`Tagged v${newVersion} and pushed.`);
console.log(`The release workflow verifies and STAGES ${newVersion}; it does not go live.`);
console.log("  gh run watch $(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')");
console.log();
console.log("Once it is green, approve the staged version with 2FA:");
console.log(`  npm stage list ${readPackageName()}`);
console.log("  npm stage approve <stage-id>");
console.log("or approve it on the package's Staged Packages tab at npmjs.com.");
