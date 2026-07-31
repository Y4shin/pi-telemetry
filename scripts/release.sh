#!/usr/bin/env bash
# Release helper: version bump -> commit -> tag -> push commit -> push tag.
#
# Usage: ./scripts/release.sh
#
# Preconditions:
#   - No pending or staged changes in the worktree.
#   - A remote (origin) configured for pushing the commit and tag.

set -euo pipefail

# Always operate from the repository root, regardless of cwd.
cd "$(git rev-parse --show-toplevel)"

# --------------------------------------------------------------------------
# 1. Clean-worktree guard (pending/staged changes)
# --------------------------------------------------------------------------
# git diff --quiet          -> non-zero if there are unstaged tracked changes
# git diff --cached --quiet -> non-zero if there are staged changes
# Untracked files are intentionally ignored so this script itself (if not yet
# committed) does not block a release.
if ! { git diff --quiet && git diff --cached --quiet; }; then
  echo "Error: worktree has pending or staged changes. Commit or stash first." >&2
  echo >&2
  git status --short >&2
  exit 1
fi

# --------------------------------------------------------------------------
# 2. Read current version and compute the three bump candidates
# --------------------------------------------------------------------------
current_version=$(node -p "require('./package.json').version")

read -r major_v minor_v patch_v < <(node -e "
  const [a, b, c] = require('./package.json').version.split('.').map(Number);
  console.log(\`\${a + 1}.0.0 \${a}.\${b + 1}.0 \${a}.\${b}.\${c + 1}\`);
")

echo "Current version: ${current_version}"
echo

# --------------------------------------------------------------------------
# 3. Offer major / minor / patch
# --------------------------------------------------------------------------
PS3="Select version bump: "
select choice in "major (${major_v})" "minor (${minor_v})" "patch (${patch_v})"; do
  case "$choice" in
    major*) new_version="$major_v"; break ;;
    minor*) new_version="$minor_v"; break ;;
    patch*) new_version="$patch_v"; break ;;
    *) echo "Invalid selection. Please choose 1-3." ;;
  esac
done

# --------------------------------------------------------------------------
# 4. Confirm the new version
# --------------------------------------------------------------------------
echo
echo "Bumping ${current_version} -> ${new_version}"
read -r -p "Proceed? (y/N) " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# --------------------------------------------------------------------------
# 5. Set the new version in package.json
# --------------------------------------------------------------------------
# Surgical replacement of the "version" value only, preserving all other
# formatting (inline arrays, indentation, trailing newline).
sed -i -E 's/^([[:space:]]*"version"[[:space:]]*:[[:space:]]*")[^"]*(")/\1'"$new_version"'\2/' package.json

# --------------------------------------------------------------------------
# 6. Stage, commit, tag
# --------------------------------------------------------------------------
git add package.json
git commit -q -m "chore(release): releasing v${new_version}"
git tag "v${new_version}" -m "v${new_version}"
echo "Tagged v${new_version}"

# --------------------------------------------------------------------------
# 7. Push the commit, then the tag
# --------------------------------------------------------------------------
branch=$(git rev-parse --abbrev-ref HEAD)
git push origin "$branch"
git push origin "v${new_version}"

echo
echo "Released v${new_version} 🎉"
