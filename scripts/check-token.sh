#!/usr/bin/env bash
#
# Paste a ReAI API token and find out what it can actually reach.
#
# Answers the question that decides how useful this server is: is the token scoped to
# ONE company, or to the whole user account? The API behaves differently for each — the
# tenant header is ignored in the first case and load-bearing in the second — and
# nothing in the token itself says which you have.
#
# Usage:
#   ./scripts/check-token.sh                 # prompt for a token, report what it reaches
#   ./scripts/check-token.sh --save          # ...and store it in this repo's own secret
#
# --save writes to REAI_MCP_USER_TOKEN in sales-moitoring. Override with
# REAI_MCP_SECRET / REAI_MCP_SECRET_PROJECT. It will not write to a secret it does not
# own by default, and it only ever ADDS a version.
#
# The token is read with echo off, passed to node through the environment rather than
# argv (so it does not appear in `ps`), never written to disk, and never printed. Nothing
# here writes to ReAI: it is one GET /api/me, plus optional read-only probes.

set -uo pipefail

# This repo's OWN secret. It must never default to a secret another project owns:
# an earlier version of this script hardcoded KLAUS_REAI_API_KEY, so --save added a
# version there and `latest` silently changed underneath the Klaus project. Worse,
# Secret Manager resolves `latest` to the highest version NUMBER regardless of state,
# so disabling the bad version did not fall back — it made every read fail outright.
SECRET_NAME="${REAI_MCP_SECRET:-REAI_MCP_USER_TOKEN}"
PROJECT="${REAI_MCP_SECRET_PROJECT:-sales-moitoring}"

# Tenants this repo may touch AT ALL, including reads. The token reaches four companies
# and only two of them are ours to poke:
#   2634 Torstensen Digital  — Stener's real business. Reads only, never a write.
#   2783 Bedre Standard      — the agreed test company, the only writable one.
#   1581 Torstensen Handel   — his parents' company. Leave alone.
#   2613 Brando As           — his employer, mid-evaluation of ReAI. Leave alone.
# The probe below used to compare the FIRST TWO tenants returned, which is exactly the
# two that are off limits.
TOUCHABLE_TENANTS="${REAI_MCP_TOUCHABLE_TENANTS:-2634,2783}"
BASE_URL="${REAI_BASE_URL:-https://app.reai.no}"
SAVE=0

for arg in "$@"; do
  case "$arg" in
    --save) SAVE=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node is required." >&2; exit 2; }

# Read with echo off when there is a terminal to read from; otherwise take it on stdin,
# which is how another script or a pipeline would call this.
REAI_PROBE_TOKEN=""
if [[ -t 0 ]]; then
  printf 'Paste the ReAI API token (input hidden, then press Enter): ' >&2
  IFS= read -rs REAI_PROBE_TOKEN || true
  printf '\n' >&2
else
  IFS= read -r REAI_PROBE_TOKEN || true
fi

REAI_PROBE_TOKEN="$(printf '%s' "${REAI_PROBE_TOKEN:-}" | tr -d '[:space:]')"
export REAI_PROBE_TOKEN
if [[ -z "$REAI_PROBE_TOKEN" ]]; then
  echo "No token given." >&2
  exit 2
fi

echo "==> GET ${BASE_URL}/api/me"
REAI_PROBE_BASE="$BASE_URL" node --input-type=module -e '
const base = process.env.REAI_PROBE_BASE;
const token = process.env.REAI_PROBE_TOKEN;
const res = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) {
  const body = await res.text();
  console.error(`    HTTP ${res.status}. ${body.slice(0, 300)}`);
  console.error(
    res.status === 401
      ? "    The token is not accepted. Check it was copied whole, and that it has not been revoked."
      : "    Unexpected status — the token may be valid but lack access.",
  );
  process.exit(1);
}
const me = await res.json();
const tenants = me.tenants ?? [];
console.log(`    user: ${me.name ?? "(no name)"} <${me.email ?? "?"}>`);
console.log(`    companies reachable: ${tenants.length}`);
for (const t of tenants) {
  console.log(`      ${String(t.id).padEnd(8)} ${(t.companyName ?? t.slug ?? "unnamed").padEnd(28)} ${t.currencyCode ?? ""}`);
}
console.log("");
if (tenants.length === 0) {
  console.log("    This token reaches NO company. Nothing tenant-scoped will work with it, and this");
  console.log("    server refuses an authorization with no bound company outright.");
  process.exit(4);
}
if (tenants.length === 1) {
  console.log("    One company only. Two possibilities, and /api/me cannot tell them apart:");
  console.log("      - the token is scoped to this company, or");
  console.log("      - it covers the whole user account and the user can open only this one.");
  console.log("    So the header behaviour here is UNKNOWN, not merely irrelevant. A tenant-scoped");
  console.log("    token ignores X-Tenant-Id, and any id returns this company data; a user-scoped");
  console.log("    one requires it. Do not assume either. The probe below settles it.");
  process.exit(3);
}
console.log(`    USER-SCOPED: ${tenants.length} companies, so the tenant header selects between them`);
console.log("    and is required on every tenant-scoped call.");
process.exit(0);
'
STATUS=$?

if [[ "$STATUS" -eq 1 ]]; then
  exit 1
fi

if [[ "$STATUS" -eq 0 ]]; then
  echo "==> Checking that the tenant header actually selects between companies"
  # The probe this project has wanted from the start: read the same endpoint under two
  # different tenant ids and see whether the answers differ. With a tenant-scoped token
  # they are identical, which is what made every earlier attempt inconclusive.
  #
  # Restricted to TOUCHABLE_TENANTS. The first version compared whichever two tenants
  # came back first and so read from two companies that are not ours to read.
  REAI_PROBE_BASE="$BASE_URL" REAI_PROBE_TOUCHABLE="$TOUCHABLE_TENANTS" node --input-type=module -e '
const base = process.env.REAI_PROBE_BASE;
const token = process.env.REAI_PROBE_TOKEN;
const touchable = new Set((process.env.REAI_PROBE_TOUCHABLE ?? "").split(",").map((s) => s.trim()));
const me = await (await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
const all = (me.tenants ?? []).map((t) => t.id);
const ids = all.filter((id) => touchable.has(String(id)));
const skipped = all.filter((id) => !touchable.has(String(id)));
if (skipped.length) {
  console.log(`    not touching ${skipped.join(", ")} — outside the allowlist for this repo, not even to read`);
}
if (ids.length < 2) {
  console.log(`    need two allowed companies to compare and have ${ids.length} (${ids.join(", ") || "none"}).`);
  console.log("    Cross-tenant isolation stays unverified. Widen REAI_MCP_TOUCHABLE_TENANTS only for");
  console.log("    companies you are willing to read from.");
  process.exit(0);
}
// A read-only endpoint that differs between companies if anything does.
const read = async (tenantId) => {
  const res = await fetch(`${base}/api/chart-of-accounts`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": String(tenantId) },
  });
  const text = await res.text();
  return { status: res.status, length: text.length, body: text };
};
const [a, b] = await Promise.all([read(ids[0]), read(ids[1])]);
console.log(`    tenant ${ids[0]}: HTTP ${a.status}, ${a.length} bytes`);
console.log(`    tenant ${ids[1]}: HTTP ${b.status}, ${b.length} bytes`);
if (a.status >= 400 || b.status >= 400) {
  console.log("    At least one read failed, so this proves nothing either way. An earlier version of");
  console.log("    this probe called /api/accounts, which does not exist: it compared two identical");
  console.log("    404s and reported them as evidence.");
  process.exit(0);
}
if (a.body === b.body) {
  console.log("    IDENTICAL responses. Either the header did not select, or both companies genuinely");
  console.log("    have the same chart of accounts — a fresh test company plausibly does. Inconclusive.");
} else {
  console.log("    SELECTION works: different payloads, so X-Tenant-Id chooses the company.");
}

// Selection is not isolation. Comparing two companies the token is ALLOWED to reach
// proves only that the header affects routing; it says nothing about whether the API
// refuses one the token may not reach. That needs an id outside the token list — an
// implausible one, so the probe never touches anybody real.
const outside = [99999999, 1];
const denied = [];
for (const id of outside) {
  const res = await fetch(`${base}/api/chart-of-accounts`, {
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": String(id) },
  });
  denied.push({ id, status: res.status });
}
for (const d of denied) console.log(`    tenant ${d.id} (not on this token): HTTP ${d.status}`);
if (denied.every((d) => d.status === 403 || d.status === 404)) {
  console.log("    ISOLATION works: the API refuses a tenant this token may not reach.");
} else {
  console.log("    WARNING: a tenant outside this token list did not come back 403/404. Isolation");
  console.log("    between companies cannot be assumed from here.");
}
console.log("");
console.log("    Note what this does NOT show. The per-authorization binding in the remote connector");
console.log("    is enforced by THIS SERVER only: ReAI sees the underlying user token, which");
console.log("    legitimately reaches every company above, so it cannot tell that a given");
console.log("    authorization was scoped to one of them.");
'
fi

if [[ "$SAVE" -eq 1 ]]; then
  echo
  # A token reaching no company cannot support this server at all, and storing it would
  # replace a working `latest` with something unusable. Not a question worth asking.
  if [[ "$STATUS" -eq 4 ]]; then
    echo "Refusing to store a token that reaches no company." >&2
    exit 4
  fi
  if [[ "$STATUS" -ne 0 ]]; then
    reply=""
    if [[ -t 0 ]]; then
      printf 'This token does not reach more than one company. Store it anyway? [y/N] ' >&2
      IFS= read -r reply || true
    else
      echo "Refusing to store a token that reaches one company without confirmation." >&2
      echo "Re-run interactively if that is what you want." >&2
      exit "$STATUS"
    fi
    [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Not stored."; exit "$STATUS"; }
  fi
  command -v gcloud >/dev/null 2>&1 || { echo "gcloud is required to store the token." >&2; exit 2; }
  echo "==> Adding a new version of ${SECRET_NAME} in ${PROJECT}"
  # Piped, so the token is never an argument and never touches disk.
  if printf '%s' "$REAI_PROBE_TOKEN" | gcloud secrets versions add "$SECRET_NAME" \
    --project="$PROJECT" --data-file=- >/dev/null 2>&1; then
    echo "    stored as version $(gcloud secrets versions list "$SECRET_NAME" --project="$PROJECT" \
      --limit=1 --format='value(name)' 2>/dev/null)"
    echo "    Previous versions are left enabled; disable them yourself if you want them gone."
  else
    echo "    FAILED to add a secret version. Check gcloud auth and permissions." >&2
    exit 1
  fi
fi

exit "$STATUS"
