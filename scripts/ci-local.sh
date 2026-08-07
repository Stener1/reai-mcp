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
#   ./scripts/ci-local.sh --allow-skips  # tolerate missing Node versions
#
# Exits non-zero if anything the workflow checks would fail, AND if any matrix
# entry could not be checked at all. A skipped Node version is not a pass: the
# exit code is what a wrapper or an `&&` chain reads, and it has to mean "every
# matrix entry was checked and passed" or it means nothing.

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

ALLOW_SKIPS=0
TARGET_REF=""
for arg in "$@"; do
  case "$arg" in
    --allow-skips) ALLOW_SKIPS=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) TARGET_REF="$arg" ;;
  esac
done
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
  # `--abbrev-ref` yields the literal "HEAD" in detached state, and restoring that
  # would leave the repo on the target rather than where it started. Fall back to
  # the commit itself.
  ORIGINAL_REF="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
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
    skipped+=("Node $major")
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

  # The runner's EXIT CODE is authoritative. Parsing output for a summary is only
  # for the human-readable count: a test whose own message happens to look like a
  # summary line ("# fail 0") can be picked up by `head -1` instead of the real
  # aggregate, so a genuinely failing run could have been reported as passing.
  tests="$(PATH="$bin:$PATH" node --test test/*.test.mjs 2>&1)"
  test_status=$?
  # Node 20/22 print "# pass N"; Node 24's reporter prints "ℹ pass N". Take the
  # LAST match, which is the aggregate, not a line from inside a test.
  passed="$(printf '%s\n' "$tests" | grep -E '^(#|ℹ) pass ' | tail -1 | grep -oE '[0-9]+')"

  if [[ "$test_status" -ne 0 ]]; then
    echo "  Node $major ($version): TESTS FAILED (exit $test_status)"
    printf '%s\n' "$tests" | grep -A6 '^not ok' | head -40 | sed 's/^/      /'
    failures=$((failures + 1))
    continue
  fi

  # A clean exit with no readable count is still a pass; say so without inventing
  # a number.
  echo "  Node $major ($version): typecheck ok, build ok, ${passed:-?} tests pass"

  # The workflow's fifth step, which this script previously skipped entirely: the
  # packaged server must refuse to start without credentials, and must name the
  # variable rather than emit a stack trace.
  startup="$(PATH="$bin:$PATH" env -u REAI_USER_API_TOKEN -u REAI_TOKEN node dist/index.js 2>&1)"
  startup_status=$?
  if [[ "$startup_status" -eq 0 ]]; then
    echo "  Node $major: startup check FAILED — server exited 0 with no token set"
    failures=$((failures + 1))
    continue
  fi
  if ! printf '%s\n' "$startup" | grep -q "REAI_USER_API_TOKEN"; then
    echo "  Node $major: startup check FAILED — error does not name REAI_USER_API_TOKEN"
    printf '%s\n' "$startup" | head -5 | sed 's/^/      /'
    failures=$((failures + 1))
    continue
  fi
  echo "  Node $major ($version): startup without a token is actionable"
done

# The audit job. Without this the local harness reported "everything the workflow
# checks passes" while skipping a blocking step — exactly the gap this script exists
# to close, since it is used precisely when Actions cannot run.
echo
if npm audit --omit=dev --audit-level=high >/tmp/reai-audit.log 2>&1; then
  echo "  npm audit (production deps): no high or critical advisories"
else
  echo "  npm audit (production deps): FAILED"
  grep -E "Severity|^[a-z@/-]+ +[0-9<>=]" /tmp/reai-audit.log | head -8 | sed 's/^/      /'
  failures=$((failures + 1))
fi
rm -f /tmp/reai-audit.log

# The fourth job: what would actually ship to npm.
echo
# The workflow pins this job to Node 22, so resolve that rather than using
# whatever `node` happens to be active.
pack_bin="$(resolve_node_bin 22 || true)"
if [[ -z "$pack_bin" ]]; then
  echo "  package: Node 22 not installed — skipping (CI still covers it)"
  skipped+=("package check (needs Node 22)")
  pack_log=""
else
pack_log="$(mktemp)"
if PATH="$pack_bin:$PATH" npm pack --dry-run >"$pack_log" 2>&1; then
  missing=0
  for required in "${REQUIRED_IN_PACKAGE[@]}"; do
    # Anchored: an unanchored match let dist/index.js be "found" on the line for
    # dist/index.js.map, so a genuinely absent entrypoint would have passed.
    grep -qE "[[:space:]]${required}\$" "$pack_log" || { echo "  package: MISSING $required"; missing=1; }
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
fi
[[ -n "$pack_log" ]] && rm -f "$pack_log"

echo
if [[ ${#skipped[@]} -gt 0 ]]; then
  echo "  NOT CHECKED: ${skipped[*]}"
  echo "  Those entries were skipped, so this run does not cover the matrix."
  if [[ "$ALLOW_SKIPS" -eq 0 ]]; then
    echo
    echo "ci-local: INCOMPLETE — install the missing Node versions (nvm install <major>)"
    echo "          or pass --allow-skips to accept partial coverage."
    exit 1
  fi
  echo "  (--allow-skips given, continuing.)"
fi

if [[ "$failures" -eq 0 ]]; then
  echo "ci-local: everything the workflow checks passes."
  echo "This is NOT a CI run: it skips the clean-room \`npm ci\` on Linux. Say which you relied on."
  exit 0
fi

echo "ci-local: $failures job(s) would fail."
exit 1
