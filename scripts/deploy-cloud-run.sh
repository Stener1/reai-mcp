#!/usr/bin/env bash
#
# Deploy reai-mcp to Google Cloud Run as a self-hosted MCP connector.
#
# Usage:
#   ./scripts/deploy-cloud-run.sh --project my-gcp-project [options]
#
# Options:
#   --project P                 GCP project id (required)
#   --region R                  Default: europe-north1
#   --service S                 Cloud Run service name. Default: reai-mcp
#   --write-mode M              read-only | reversible | full. Default: reversible
#   --allowed-redirect-hosts H  Comma-separated OAuth callback hosts. Default: claude.ai
#   --service-account SA        Runtime identity. Default: a dedicated
#                               reai-mcp-runtime SA, created if absent
#   --secret-name N             Secret Manager name for the encryption key
#   --allow-external-send       Permit EHF/Peppol, invoice email, reminders and
#                               invoice issuance. Off by default. Enable this for
#                               a real business doing its own invoicing
#   --env KEY=VALUE             Extra env var; repeatable
#
# Prerequisites:
#   gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
#     artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com
#   You need roughly: roles/run.admin, roles/secretmanager.admin,
#   roles/cloudbuild.builds.editor, roles/iam.serviceAccountAdmin,
#   roles/iam.serviceAccountUser.
#   Also: node (to generate the encryption key) and curl.
#
# Teardown:
#   gcloud run services delete SERVICE --region R --project P
#   gcloud secrets delete SECRET --project P     # invalidates ALL authorizations
#
# Redeploying is safe: the encryption key is reused, so existing connector
# authorizations keep working. Deleting the secret breaks all of them.
set -euo pipefail

# --source is relative to the CALLER's cwd. Without this, running the script by
# absolute path from elsewhere tars up that directory and uploads it to GCS
# before failing -- which could mean uploading a home directory.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROJECT=""
REGION="europe-north1"
SERVICE="reai-mcp"
WRITE_MODE="reversible"
ALLOWED_REDIRECT_HOSTS="claude.ai"
SECRET_NAME="reai-mcp-encryption-key"
SERVICE_ACCOUNT=""
ALLOW_EXTERNAL_SEND="false"
EXTRA_ENV=()

usage() {
  # Print the header comment block, stopping at the first non-comment line so
  # this cannot drift out of sync with a hardcoded line range.
  sed -n '2,/^[^#]/p' "$0" | sed '$d' | sed 's/^#\{1,\} \{0,1\}//'
}

need_value() {
  # $1 = flag name, $2 = remaining arg count
  if [[ "$2" -lt 2 ]]; then
    echo "$1 requires a value." >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) need_value "$1" $#; PROJECT="$2"; shift 2 ;;
    --region) need_value "$1" $#; REGION="$2"; shift 2 ;;
    --service) need_value "$1" $#; SERVICE="$2"; shift 2 ;;
    --write-mode) need_value "$1" $#; WRITE_MODE="$2"; shift 2 ;;
    --allowed-redirect-hosts) need_value "$1" $#; ALLOWED_REDIRECT_HOSTS="$2"; shift 2 ;;
    --service-account) need_value "$1" $#; SERVICE_ACCOUNT="$2"; shift 2 ;;
    --secret-name) need_value "$1" $#; SECRET_NAME="$2"; shift 2 ;;
    --allow-external-send) ALLOW_EXTERNAL_SEND="true"; shift ;;
    --env) need_value "$1" $#; EXTRA_ENV+=("$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1  (try --help)" >&2; exit 2 ;;
  esac
done

[[ -n "$PROJECT" ]] || { echo "--project is required. Try --help." >&2; exit 2; }

case "$WRITE_MODE" in
  read-only|reversible|full) ;;
  *) echo "--write-mode must be read-only, reversible or full (got '$WRITE_MODE')." >&2; exit 2 ;;
esac

for tool in gcloud node curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required but not on PATH." >&2; exit 2; }
done

# On a fresh project these are disabled, and the first failure would otherwise be
# a swallowed `secrets describe` error misread as "the secret does not exist yet",
# followed by an opaque failure in `secrets create`.
REQUIRED_APIS=(
  run.googleapis.com
  cloudbuild.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
  iam.googleapis.com
)
echo "==> Checking required APIs"
enabled="$(gcloud services list --enabled --project="$PROJECT" --format='value(config.name)' 2>/dev/null || true)"
missing=()
for api in "${REQUIRED_APIS[@]}"; do
  grep -qx "$api" <<<"$enabled" || missing+=("$api")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "    Not enabled: ${missing[*]}" >&2
  echo "    Enable them, then re-run:" >&2
  echo "      gcloud services enable ${missing[*]} --project=${PROJECT}" >&2
  exit 2
fi
echo "    all present"

if [[ "$WRITE_MODE" == "full" ]]; then
  echo "WARNING: REAI_WRITE_MODE=full permits ledger postings, invoices, payments" >&2
  echo "         and VAT filings. None of those can be cleanly undone." >&2
  if [[ -t 0 ]]; then
    read -r -p "         Type 'full' to confirm: " confirm
    [[ "$confirm" == "full" ]] || { echo "Aborted." >&2; exit 1; }
  else
    echo "         Refusing to deploy 'full' non-interactively. Set it afterwards with" >&2
    echo "         gcloud run services update --update-env-vars REAI_WRITE_MODE=full" >&2
    exit 1
  fi
fi

echo "==> Project $PROJECT, region $REGION, service $SERVICE, write mode $WRITE_MODE"

# --- 1. The encryption key -------------------------------------------------
# Seals access tokens, which is how a user's ReAI token is carried without a
# server-side session store. It must be stable across revisions and instances.
if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" >/dev/null 2>&1; then
  # A secret container can exist with zero versions -- e.g. if a previous run
  # died between creating it and adding one. Reusing that deploys a service that
  # cannot start, with an error that points nowhere near the cause.
  if [[ -z "$(gcloud secrets versions list "$SECRET_NAME" --project="$PROJECT" \
        --filter="state=enabled" --limit=1 --format='value(name)' 2>/dev/null)" ]]; then
    echo "==> Secret $SECRET_NAME exists but has no enabled version; adding one"
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" \
      | gcloud secrets versions add "$SECRET_NAME" --project="$PROJECT" --data-file=- >/dev/null
  else
    echo "==> Reusing existing secret $SECRET_NAME"
    echo "    (rotating it would invalidate every existing connector authorization)"
  fi
else
  echo "==> Creating secret $SECRET_NAME"
  # Piped, never written to disk and never in argv or shell history.
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" \
    | gcloud secrets create "$SECRET_NAME" \
        --project="$PROJECT" --replication-policy=automatic --data-file=- >/dev/null
fi

# --- 2. A dedicated runtime identity ---------------------------------------
# Deliberately NOT the default compute service account. That account is shared by
# every other service in the project and in a default GCP project it holds
# roles/editor -- so running an intentionally --allow-unauthenticated service as
# it would wire the most exposed surface in the project to its most privileged
# identity. This service needs exactly one permission: read its own secret.
if [[ -z "$SERVICE_ACCOUNT" ]]; then
  SA_ID="${SERVICE}-runtime"
  # Service account ids are capped at 30 characters.
  SA_ID="${SA_ID:0:30}"
  SERVICE_ACCOUNT="${SA_ID}@${PROJECT}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project="$PROJECT" >/dev/null 2>&1; then
    echo "==> Reusing runtime service account $SERVICE_ACCOUNT"
  else
    echo "==> Creating runtime service account $SERVICE_ACCOUNT"
    gcloud iam service-accounts create "$SA_ID" \
      --project="$PROJECT" \
      --display-name="reai-mcp runtime" \
      --description="Runtime identity for the reai-mcp connector. Needs only secretAccessor on its encryption key." \
      >/dev/null
  fi
fi

echo "==> Granting $SERVICE_ACCOUNT read access to $SECRET_NAME"
# A freshly created service account is not immediately visible to the IAM policy
# API, which rejects the binding with "does not exist". This is only ever a
# first-run problem, but it is a guaranteed one, so retry rather than telling the
# user to run the script twice.
granted=0
for attempt in 1 2 3 4 5 6; do
  if gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
      --project="$PROJECT" \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role=roles/secretmanager.secretAccessor >/dev/null 2>&1; then
    granted=1
    break
  fi
  echo "    IAM not converged yet (attempt ${attempt}); retrying in $((attempt * 5))s"
  sleep $((attempt * 5))
done
if [[ "$granted" -ne 1 ]]; then
  echo "    Could not grant secretAccessor to ${SERVICE_ACCOUNT}." >&2
  echo "    Re-run the script, or grant it by hand:" >&2
  echo "      gcloud secrets add-iam-policy-binding ${SECRET_NAME} --project=${PROJECT} \\" >&2
  echo "        --member=serviceAccount:${SERVICE_ACCOUNT} --role=roles/secretmanager.secretAccessor" >&2
  exit 1
fi

# --- 3. Deploy -------------------------------------------------------------
# gcloud splits env-var values on commas by default, which breaks any value that
# legitimately contains one (a multi-host allowlist). "^;^" switches the
# delimiter to a semicolon for this argument.
build_env_arg() {
  local pairs="REAI_WRITE_MODE=${WRITE_MODE};REAI_ALLOWED_REDIRECT_HOSTS=${ALLOWED_REDIRECT_HOSTS}"
  if [[ "$ALLOW_EXTERNAL_SEND" == "true" ]]; then pairs="${pairs};REAI_ALLOW_EXTERNAL_SEND=1"; fi
  if [[ -n "${1:-}" ]]; then pairs="${pairs};PUBLIC_URL=${1}"; fi
  if [[ -n "${2:-}" ]]; then pairs="${pairs};REAI_ALLOWED_HOSTS=${2}"; fi
  local kv
  for kv in ${EXTRA_ENV+"${EXTRA_ENV[@]}"}; do pairs="${pairs};${kv}"; done
  printf '^;^%s' "$pairs"
}

# --update-env-vars, not --set-env-vars: --set REPLACES the whole map, so on a
# redeploy the first pass would strip the PUBLIC_URL and REAI_ALLOWED_HOSTS that
# the second pass installed last time. Traffic moves to the new revision as soon
# as it is ready, so that would leave a window in which the host allowlist is
# absent and a spoofed Host header decides what the deployment advertises.
echo "==> Deploying"
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --source=. \
  --service-account="$SERVICE_ACCOUNT" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300 \
  --update-env-vars="$(build_env_arg)" \
  --set-secrets="REAI_ENCRYPTION_KEY=${SECRET_NAME}:latest" \
  --quiet

# --- 4. Pin every hostname -------------------------------------------------
# Cloud Run can serve one service on several hostnames. PUBLIC_URL fixes the
# advertised OAuth issuer, and REAI_ALLOWED_HOSTS must list EVERY hostname the
# service answers on: the MCP transport rejects a Host it does not recognise with
# "Invalid Host header", and it does so AFTER the OAuth flow has already
# succeeded -- so omitting an alias produces a connector that authorizes fine and
# then fails every call.
URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format='value(status.url)')"

ALL_HOSTS="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --format="value(metadata.annotations['run.googleapis.com/urls'])" 2>/dev/null \
  | tr -d '[]"' | tr ',' '\n' | sed 's|https://||' | grep -v '^$' | paste -sd, -)"
[[ -n "$ALL_HOSTS" ]] || ALL_HOSTS="${URL#https://}"

echo "==> Pinning PUBLIC_URL=$URL"
echo "    accepted hosts: $ALL_HOSTS"
gcloud run services update "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --update-env-vars="$(build_env_arg "$URL" "$ALL_HOSTS")" \
  --quiet >/dev/null

# --- 5. Verify -------------------------------------------------------------
# Failures here exit non-zero. A deploy can "succeed" while the service is
# unreachable -- an org policy blocking the allUsers binding is the common case --
# and a script that prints connector instructions anyway is worse than useless.
echo "==> Verifying"
fail=0

if health="$(curl -fsS --max-time 30 "${URL}/health" 2>/dev/null)"; then
  echo "    /health -> ${health}"
else
  echo "    /health -> UNREACHABLE" >&2
  echo "    The deploy reported success but the service does not answer. The usual cause is an" >&2
  echo "    org policy (constraints/iam.allowedPolicyMemberDomains) blocking the allUsers" >&2
  echo "    invoker binding, which gcloud only warns about." >&2
  fail=1
fi

if issuer="$(curl -fsS --max-time 30 "${URL}/.well-known/oauth-authorization-server" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).issuer)}catch{console.log('')}})")"; then
  if [[ "$issuer" == "$URL" ]]; then
    echo "    advertised issuer matches the deployed URL"
  else
    echo "    advertised issuer '${issuer}' does not match ${URL}" >&2
    fail=1
  fi
else
  echo "    could not read the authorization server metadata" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo >&2
  echo "Deployment is NOT verified. Fix the above before adding it as a connector." >&2
  exit 1
fi

cat <<EOF

Deployed and verified.

  MCP endpoint:  ${URL}/mcp
  Write mode:    ${WRITE_MODE}
  External send: ${ALLOW_EXTERNAL_SEND} (EHF/Peppol, invoice email, reminders, invoice issuance)
  Runs as:       ${SERVICE_ACCOUNT}
  Callbacks:     ${ALLOWED_REDIRECT_HOSTS} (plus loopback, for local clients)

Use exactly that URL in your MCP client. Cloud Run may also answer on an alias
hostname, and while the OAuth flow works on either, only the hosts listed in
REAI_ALLOWED_HOSTS are accepted by the MCP endpoint itself.

You will be asked for a ReAI API token on the consent page. It is encrypted into
your access token and never stored server-side.

Verify the whole OAuth flow end to end:
  REAI_USER_API_TOKEN=<a-token> node scripts/smoke-http.mjs --url ${URL}

This scales to zero, so it is close to free at idle. It is still YOUR deployment:
anyone who reaches the URL can authorize with their own ReAI token and use your
compute against their own books. --max-instances caps the spend; keeping the URL
unadvertised is the practical control.
EOF
