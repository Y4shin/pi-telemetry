#!/usr/bin/env bash
# Release helper: changeset version -> commit -> tag -> push. CI stages the tag.
#
# Usage: ./scripts/release.sh
#
# Changesets is the source of truth for the version bump and the changelog
# entry: each .changeset/<name>.md declares a level (major/minor/patch) and a
# summary; `changeset version` consumes them, bumps package.json, and writes
# the entry to the repo-root CHANGELOG.md. This script commits that bump and
# changelog, tags vX.Y.Z, and pushes commit and tag. The tag triggers
# .github/workflows/release.yml, which verifies the code and STAGES the
# version on npm. A maintainer then approves it with 2FA; nothing reaches the
# registry from this machine.
#
# Preconditions:
#   - No pending or staged changes in the worktree.
#   - A remote (origin) configured for pushing the commit and tag.
#   - @changesets/cli installed (run `npm ci` if not).
#   - At least one pending changeset under .changeset/ (else nothing to release).

set -euo pipefail

# Always operate from the repository root, regardless of cwd.
cd "$(git rev-parse --show-toplevel)"

# --------------------------------------------------------------------------
# 1. Clean-worktree guard (pending/staged changes)
# --------------------------------------------------------------------------
if ! { git diff --quiet && git diff --cached --quiet; }; then
  echo "Error: worktree has pending or staged changes. Commit or stash first." >&2
  echo >&2
  git status --short >&2
  exit 1
fi

# --------------------------------------------------------------------------
# 2. Guard: @changesets/cli must be installed
# --------------------------------------------------------------------------
if ! command -v changeset >/dev/null 2>&1 && ! [ -x node_modules/.bin/changeset ]; then
  echo "Error: @changesets/cli is not installed. Run \`npm ci\` first." >&2
  exit 1
fi
CHANGESET_BIN="$(command -v changeset >/dev/null 2>&1 && echo changeset || echo "$(pwd)/node_modules/.bin/changeset")"

# --------------------------------------------------------------------------
# 3. Guard: at least one pending changeset (else nothing to release)
# --------------------------------------------------------------------------
pending_changesets="$(find .changeset -maxdepth 1 -type f -name '*.md' ! -name 'README.md' 2>/dev/null || true)"
if [ -z "$pending_changesets" ]; then
  echo "No pending changesets under .changeset/. Nothing to release." >&2
  exit 0
fi

current_version="$(node -p "require('./package.json').version")"
echo "Current version: ${current_version}"
echo "Pending changesets:"
echo "$pending_changesets" | sed 's/^/  /'
echo

# --------------------------------------------------------------------------
# 4. Run `changeset version` (consumes the changesets, bumps package.json,
#    writes the changelog entry)
# --------------------------------------------------------------------------
"$CHANGESET_BIN" version

new_version="$(node -p "require('./package.json').version")"

if [ "$new_version" = "$current_version" ]; then
  echo "changeset version did not bump the version (no version-level changesets?). Aborting." >&2
  exit 1
fi
echo
echo "Bumped ${current_version} -> ${new_version}"

# --------------------------------------------------------------------------
# 5. Confirm the changelog moved, and that the tag is free
# --------------------------------------------------------------------------
# Content, not `git diff`: the first release creates CHANGELOG.md as an
# untracked file, which `git diff` reports as no change at all.
if [ -f CHANGELOG.md ] && grep -qF "## ${new_version}" CHANGELOG.md; then
  echo "CHANGELOG.md carries the ${new_version} entry"
else
  echo "Error: CHANGELOG.md has no ${new_version} section. Aborting." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/v${new_version}" >/dev/null; then
  echo "Error: tag v${new_version} already exists. Aborting." >&2
  exit 1
fi

# --------------------------------------------------------------------------
# 6. Confirm before committing/tagging/pushing
# --------------------------------------------------------------------------
echo
echo "Staged for release v${new_version}:"
git status --short
echo
read -r -p "Proceed with commit, tag v${new_version}, and push to origin? (y/N) " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted. The version bump and changelog are in the worktree; reset them manually." >&2
  exit 0
fi

# --------------------------------------------------------------------------
# 7. Stage, commit, tag
# --------------------------------------------------------------------------
git add package.json package-lock.json CHANGELOG.md .changeset
git commit -q -m "chore(release): releasing v${new_version}"
git tag "v${new_version}" -m "v${new_version}"
echo "Tagged v${new_version}"

# --------------------------------------------------------------------------
# 8. Push the commit, then the tag
# --------------------------------------------------------------------------
branch="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$branch"
git push origin "v${new_version}"

echo
echo "Tagged v${new_version} and pushed."
echo "The release workflow verifies and STAGES ${new_version}; it does not go live."
echo "  gh run watch \$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
echo
echo "Once it is green, approve the staged version with 2FA:"
echo "  npm stage list $(node -p "require('./package.json').name")"
echo "  npm stage approve <stage-id>"
echo "or approve it on the package's Staged Packages tab at npmjs.com."
