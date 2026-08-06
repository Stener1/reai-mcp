#!/usr/bin/env bash
#
# Deploy reai-mcp to Google Cloud Run as a self-hosted MCP connector.
#
# Usage:
#   ./scripts/deploy-cloud-run.sh --project my-gcp-project [--region europe-north1] [--service reai-mcp]
#
# What this does that a bare `gcloud run deploy` does not:
#
#   1. Creates REAI_ENCRYPTION_KEY in Secret Manager if it is missing, and grants
#      the runtime service account access to it. Without a stable key, every
#      connector authorization breaks on each cold start and separate instances
#      reject each other's tokens.
#   2. Deploys, then sets PUBLIC_URL in a SECOND step. The URL is not knowable
#      before the first deploy, and PUBLIC_URL must match it or the OAuth
#      metadata advertises the wrong issuer.
#   3. Pins REAI_ALLOWED_HOSTS to the deployed host, so a client-supplied Host
#      header cannot decide what this deployment claims to be.
#
# It does NOT set REAI_USER_API_TOKEN: in remote mode each user supplies their
# own ReAI token during authorization, and baking one in would make the whole
# deployment act as a single user.
set -euo pipefail

PROJECT=""
REGION="europe-north1"
SERVICE="reai-mcp"
WRITE_MODE="reversible"
ALLOWED_REDIRECT_HOSTS="claude.ai"
SECRET_NAME="reai-mcp-encryption-key"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --write-mode) WRITE_MODE="$2"; shift 2 ;;
    --allowed-redirect-hosts) ALLOWED_REDIRECT_HOSTS="$2"; shift 2 ;;
    --secret-name) SECRET_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PROJECT" ]]; then
  echo "--project is required. Try --help." >&2
  exit 2
fi

case "$WRITE_MODE" in
  read-only|reversible|full) ;;
  *) echo "--write-mode must be read-only, reversible or full (got '$WRITE_MODE')." >&2; exit 2 ;;
esac

if [[ "$WRITE_MODE" == "full" ]]; then
  echo "WARNING: deploying with REAI_WRITE_MODE=full. Ledger postings, invoices," >&2
  echo "         payments and VAT filings will be permitted, and none of those can be" >&2
  echo "         cleanly undone. Ctrl-C now if that is not what you want." >&2
  sleep 5
fi

echo "==> Project $PROJECT, region $REGION, service $SERVICE, write mode $WRITE_MODE"

# --- 1. The encryption key -------------------------------------------------
if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" >/dev/null 2>&1; then
  echo "==> Secret $SECRET_NAME already exists; reusing it"
  echo "    (rotating it would invalidate every existing connector authorization)"
else
  echo "==> Creating secret $SECRET_NAME"
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" \
    | gcloud secrets create "$SECRET_NAME" \
        --project="$PROJECT" --replication-policy=automatic --data-file=- >/dev/null
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "==> Granting $RUNTIME_SA read access to the secret"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --project="$PROJECT" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/secretmanager.secretAccessor >/dev/null

# --- 2. Deploy -------------------------------------------------------------
# --allow-unauthenticated is required: the MCP client must be able to reach the
# OAuth endpoints unauthenticated. The server does its own auth -- every /mcp
# request needs a valid token, and anonymous ones get a 401 challenge.
echo "==> Deploying (first pass, PUBLIC_URL not yet known)"
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --source=. \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300 \
  --set-env-vars="REAI_WRITE_MODE=${WRITE_MODE},REAI_ALLOWED_REDIRECT_HOSTS=${ALLOWED_REDIRECT_HOSTS}" \
  --set-secrets="REAI_ENCRYPTION_KEY=${SECRET_NAME}:latest" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
HOST="${URL#https://}"

# --- 3. Pin the public URL -------------------------------------------------
# Cloud Run may serve a service on more than one hostname. Pinning PUBLIC_URL
# means every hostname advertises the SAME issuer, so a client that connects via
# an alias still follows the metadata to the canonical URL instead of seeing the
# issuer change per request.
echo "==> Pinning PUBLIC_URL=$URL"
gcloud run services update "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --set-env-vars="REAI_WRITE_MODE=${WRITE_MODE},REAI_ALLOWED_REDIRECT_HOSTS=${ALLOWED_REDIRECT_HOSTS},PUBLIC_URL=${URL},REAI_ALLOWED_HOSTS=${HOST}" \
  --set-secrets="REAI_ENCRYPTION_KEY=${SECRET_NAME}:latest" \
  --quiet >/dev/null

# --- 4. Verify -------------------------------------------------------------
echo "==> Verifying"
health="$(curl -fsS "${URL}/health" || echo 'FAILED')"
echo "    /health -> ${health}"

issuer="$(curl -fsS "${URL}/.well-known/oauth-authorization-server" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).issuer))" \
  || echo 'FAILED')"
if [[ "$issuer" != "$URL" ]]; then
  echo "    WARNING: advertised issuer ($issuer) does not match $URL" >&2
else
  echo "    advertised issuer matches the deployed URL"
fi

cat <<EOF

Deployed.

  MCP endpoint:  ${URL}/mcp
  Write mode:    ${WRITE_MODE}
  Callbacks:     ${ALLOWED_REDIRECT_HOSTS} (plus loopback, for local clients)

Add ${URL}/mcp as a custom connector in your MCP client. You will be asked for a
ReAI API token on the consent page; it is encrypted into your access token and is
never stored server-side.

Verify the whole OAuth flow end to end with:
  REAI_USER_API_TOKEN=<a-token> node scripts/smoke-http.mjs --url ${URL}

This deployment scales to zero, so it costs essentially nothing at idle. Remember
it is YOUR deployment: anyone who reaches the URL can authorize with their own
ReAI token and reach their own books using your compute. Keep the URL private, or
put Cloud Armor / IAP in front of it.
EOF
