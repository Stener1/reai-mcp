#!/usr/bin/env bash
#
# Run everything .github/workflows/ci.yml runs, locally, across every Node version
# the matrix targets.
#
# This exists because GitHub Actions had a multi-hour major outage while this
# project was being built, during which no workflow could start — and "wait for a
# green tick" stops being a quality gate when the service producing the tick is
# down. Reproducing the jobs locally keeps the gate real: the same commands, the
# same Node versions, the same packaging check.
#
# It is not a replacement for CI. CI also tests on Linux with a clean `npm ci`
# install, which this cannot do faithfully on a developer machine. Use it when CI
# is unavailable, or to get an answer in seconds rather than minutes; and say
# plainly which of the two you relied on.
#
# Usage:
#   ./scripts/ci-local.sh                # current working tree
#   ./scripts/ci-local.sh main           # a specific ref (checked out, then restored)
#
# Exits non-zero if anything the workflow checks would fail.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Keep this list in step with the matrix in .github/workflows/ci.yml.
NODE_MAJORS=(20 22 24)

# Keep this list in step with the "Verify published package contents" job.
REQUIRED_IN_PACKAGE=(
  dist/index.js
  dist/http.js
  spec/index.json
  spec/reai-openapi.json
  LICENSE
  README.md
)

TARGET_REF="${1:-}"
ORIGINAL_REF=""
restore() {
  if [[ -n "$ORIGINAL_REF" ]]; then
    git checkout -q "$ORIGINAL_REF" || echo "WARNING: could not return to $ORIGINAL_REF" >&2
  fi
}
trap restore EXIT

if [[ -n "$TARGET_REF" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Refusing to switch to '$TARGET_REF' with a dirty working tree." >&2
    echo "Commit or stash first, or run with no argument to check the tree as it is." >&2
    exit 2
  fi
  ORIGINAL_REF="$(git rev-parse --abbrev-ref HEAD)"
  git checkout -q "$TARGET_REF" || { echo "No such ref: $TARGET_REF" >&2; exit 2; }
fi

echo "ci-local: $(git rev-parse --abbrev-ref HEAD) ($(git rev-parse --short HEAD))"
echo

# Resolve a `node` binary for a major version. Prefers nvm's install tree, then
# falls back to whatever `node` is on PATH if its major happens to match — so this
# still does something useful on a machine without nvm.
resolve_node_bin() {
  local major="$1" candidate
  candidate="$(ls -d "$HOME/.nvm/versions/node/v${major}."* 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$candidate" && -x "$candidate/bin/node" ]]; then
    echo "$candidate/bin"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    local current
    current="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
    [[ "$current" == "$major" ]] && { dirname "$(command -v node)"; return 0; }
  fi
  return 1
}

failures=0
skipped=()

for major in "${NODE_MAJORS[@]}"; do
  bin="$(resolve_node_bin "$major")" || {
    echo "  Node $major: NOT INSTALLED — skipping (CI still covers it)"
    skipped+=("$major")
    continue
  }
  version="$(PATH="$bin:$PATH" node --version)"

  if ! out="$(PATH="$bin:$PATH" npm run typecheck 2>&1)"; then
    echo "  Node $major ($version): typecheck FAILED"
    echo "$out" | grep -Ei "error TS" | head -10 | sed 's/^/      /'
    failures=$((failures + 1))
    continue
  fi

  if ! PATH="$bin:$PATH" npm run build >/dev/null 2>&1; then
    echo "  Node $major ($version): build FAILED"
    failures=$((failures + 1))
    continue
  fi

  # Node 20/22 print "# pass N"; Node 24's reporter prints "ℹ pass N".
  tests="$(PATH="$bin:$PATH" node --test test/*.test.mjs 2>&1)"
  passed="$(printf '%s\n' "$tests" | grep -E '^(#|ℹ) pass' | head -1 | grep -oE '[0-9]+')"
  failed="$(printf '%s\n' "$tests" | grep -E '^(#|ℹ) fail' | head -1 | grep -oE '[0-9]+')"

  if [[ -z "$passed" || -z "$failed" ]]; then
    echo "  Node $major ($version): could not read a test summary — treating as failure"
    printf '%s\n' "$tests" | tail -15 | sed 's/^/      /'
    failures=$((failures + 1))
    continue
  fi

  if [[ "$failed" != "0" ]]; then
    echo "  Node $major ($version): $failed TEST FAILURE(S) ($passed passed)"
    printf '%s\n' "$tests" | grep -A6 '^not ok' | head -40 | sed 's/^/      /'
    failures=$((failures + 1))
    continue
  fi

  echo "  Node $major ($version): typecheck ok, build ok, $passed tests pass"
done

# The fourth job: what would actually ship to npm.
echo
pack_log="$(mktemp)"
if npm pack --dry-run >"$pack_log" 2>&1; then
  missing=0
  for required in "${REQUIRED_IN_PACKAGE[@]}"; do
    grep -q "$required" "$pack_log" || { echo "  package: MISSING $required"; missing=1; }
  done
  if [[ "$missing" -eq 0 ]]; then
    echo "  package contents: all $((${#REQUIRED_IN_PACKAGE[@]})) required paths present"
  else
    failures=$((failures + 1))
  fi
else
  echo "  package: npm pack FAILED"
  tail -15 "$pack_log" | sed 's/^/      /'
  failures=$((failures + 1))
fi
rm -f "$pack_log"

echo
if [[ ${#skipped[@]} -gt 0 ]]; then
  echo "  NOTE: Node ${skipped[*]} not installed locally, so ${#skipped[@]} of ${#NODE_MAJORS[@]} matrix"
  echo "        entries were not checked. Do not report this run as equivalent to CI."
fi

if [[ "$failures" -eq 0 ]]; then
  echo "ci-local: everything the workflow checks passes."
  echo "This is NOT a CI run: it skips the clean-room \`npm ci\` on Linux. Say which you relied on."
  exit 0
fi

echo "ci-local: $failures job(s) would fail."
exit 1
