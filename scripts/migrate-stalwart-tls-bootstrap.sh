#!/usr/bin/env bash
#
# migrate-stalwart-tls-bootstrap.sh
#
# One-time migration to add Stalwart-managed TLS bootstrap rows to an
# already-bootstrapped Stalwart 0.16 cluster. Idempotent — re-runs are
# no-ops because each row is checked-then-skipped.
#
# Why a separate script:
#   The bootstrap-job.yaml runs ONCE on fresh installs (suspend:true →
#   bootstrap.sh unsuspends → applies plan → completes). For clusters
#   already past that point (staging cutover, prod after Cut 3), the
#   bootstrap plan will not re-run. This script applies ONLY the new
#   rows (AcmeProvider + AllowedIp + http-acme NetworkListener +
#   Bootstrap.requestTlsCertificate=true) without touching the
#   existing Account / DkimSignature / submission / imap rows that
#   would otherwise collide with "already exists" errors.
#
# Prerequisites:
#   - Stalwart pod is healthy (1/1 Ready)
#   - mail-acme-ingress is applied (Flux reconciled)
#   - Service exposes port 80 (Flux reconciled)
#   - Stalwart's `http-acme` NetworkListener is bound (this script
#     creates that row, so the listener appears after a pod roll)
#
# After running:
#   - Roll the Stalwart pod (kubectl rollout restart deploy
#     stalwart-mail-v016 -n mail) so the new NetworkListener:80 binds
#     and Stalwart picks up requestTlsCertificate=true
#   - Stalwart starts an ACME flow on the next tick; LE issues a cert
#     within ~1min (HTTP-01 challenge over the new Ingress route)
#   - Verify with: openssl s_client -connect <node-ip>:993 -servername
#     mail.${DOMAIN}  → should serve a Let's Encrypt-issued cert
#
# Usage:
#   ./scripts/migrate-stalwart-tls-bootstrap.sh [--namespace NS]

set -euo pipefail

NAMESPACE="mail"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

: "${KUBECTL:=kubectl}"

err() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[migrate-stalwart-tls] %s\n' "$*"; }

# ── Sanity ──────────────────────────────────────────────────────────
$KUBECTL -n "$NAMESPACE" get deploy stalwart-mail-v016 >/dev/null 2>&1 \
  || err "Stalwart deployment not found in namespace $NAMESPACE"

stalwart_pod=$($KUBECTL -n "$NAMESPACE" get pods -l app=stalwart-mail-v016 \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) \
  || err "No Stalwart pod found"

[[ -n "$stalwart_pod" ]] || err "Stalwart pod name empty"

ready=$($KUBECTL -n "$NAMESPACE" get pod "$stalwart_pod" \
  -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)

[[ "$ready" == "true" ]] || err "Stalwart pod $stalwart_pod is not Ready"

log "Stalwart pod $stalwart_pod is Ready in namespace $NAMESPACE"

# ── Read recovery admin password ────────────────────────────────────
recovery_pw=$($KUBECTL -n "$NAMESPACE" get secret stalwart-admin-creds \
  -o jsonpath='{.data.recoveryPassword}' 2>/dev/null | base64 -d) \
  || err "Could not read stalwart-admin-creds Secret"

[[ -n "$recovery_pw" ]] || err "Recovery password is empty"

log "Read recovery password (length=${#recovery_pw})"

# ── Read default domain (for ACME contact email) ────────────────────
default_domain=$($KUBECTL -n "$NAMESPACE" exec "$stalwart_pod" -c stalwart \
  -- /bin/sh -c "cat /etc/stalwart/config.json 2>/dev/null | grep -oE '\"database\":\"[^\"]+' | sed 's/.*\"//'" 2>/dev/null || true)

# Fallback to platform-cluster-config DOMAIN
if [[ -z "${default_domain:-}" ]] || [[ "$default_domain" == "stalwart_app" ]]; then
  default_domain=$($KUBECTL -n flux-system get cm platform-cluster-config \
    -o jsonpath='{.data.DOMAIN}' 2>/dev/null || true)
fi

[[ -n "$default_domain" ]] || err "Could not determine default domain — provide it manually"

log "Using ACME contact: hostmaster@$default_domain"

# ── Run migration via stalwart-cli inside a one-shot pod ────────────
# We deliberately do NOT use the existing bootstrap-job.yaml to avoid
# re-applying Account/DkimSignature/submission/imap rows.

stamp=$(date +%s)
pod_name="stalwart-tls-migrate-$stamp"

log "Spawning migration pod $pod_name..."

# Heredoc-friendly: write the migration body to a tempfile so we can
# pipe it into a long-running pod. The pod self-deletes via --rm.
migration_script=$(cat <<'MIGRATE'
#!/bin/sh
set -eu

CLI_VERSION="v1.0.4"
CLI_URL="https://github.com/stalwartlabs/cli/releases/download/${CLI_VERSION}/stalwart-cli-x86_64-unknown-linux-musl.tar.xz"
CLI_SHA256="01c734752cc44b9e24f753cbacfc2d489dadaaccf72cd229ecb7269e85e0eefa"

echo "Downloading stalwart-cli ${CLI_VERSION}..."
wget -q -O /tmp/stalwart-cli.tar.xz "${CLI_URL}"
actual=$(sha256sum /tmp/stalwart-cli.tar.xz | awk '{print $1}')
if [ "${actual}" != "${CLI_SHA256}" ]; then
  echo "ERROR: stalwart-cli SHA256 mismatch" >&2
  exit 1
fi
tar -xJf /tmp/stalwart-cli.tar.xz -C /tmp/
mv /tmp/stalwart-cli-*/stalwart-cli /tmp/cli
chmod +x /tmp/cli
echo "stalwart-cli ready"

export HOME=/tmp
export STALWART_PASSWORD="${STALWART_RECOVERY_PASSWORD}"
URL="http://stalwart-mgmt-v016.mail.svc.cluster.local:8080"

# Idempotency guard: query each object type. If any row exists with
# the matching identifier shape, skip. Stalwart 0.16's `apply` `create`
# verb auto-generates IDs (the row-key in the plan is ignored), so
# skip-if-any is the cheapest way to make this re-runnable.

probe() {
  /tmp/cli --url "$URL" --user admin query "$1" --json 2>&1 || true
}

contains_id() {
  printf '%s\n' "$1" | grep -qE '"id":"[a-z0-9]+"'
}

# ── 1. AcmeProvider ─────────────────────────────────────────────────
out=$(probe AcmeProvider)
if contains_id "$out"; then
  echo "AcmeProvider row exists — skipping."
else
  echo "Creating AcmeProvider..."
  cat > /tmp/acme.json <<PLAN
{"@type":"create","object":"AcmeProvider","value":{"letsencrypt":{"directory":"https://acme-v02.api.letsencrypt.org/directory","challengeType":"Http01","contact":{"hostmaster@${ACME_CONTACT_DOMAIN}":true}}}}
PLAN
  /tmp/cli --url "$URL" --user admin apply --file /tmp/acme.json
fi

# ── 2. AllowedIp rows for cluster CIDRs ─────────────────────────────
out=$(probe AllowedIp)
if contains_id "$out"; then
  echo "AllowedIp rows exist — skipping cluster-CIDR seeds."
else
  echo "Creating AllowedIp cluster-CIDR rows..."
  cat > /tmp/allowed.json <<PLAN
{"@type":"create","object":"AllowedIp","value":{"cluster-pod":{"address":"10.42.0.0/16","reason":"k8s pod CIDR (kubelet probes + intra-cluster)"}}}
{"@type":"create","object":"AllowedIp","value":{"cluster-svc":{"address":"10.43.0.0/16","reason":"k8s service CIDR"}}}
PLAN
  /tmp/cli --url "$URL" --user admin apply --file /tmp/allowed.json
fi

# ── 3. http-acme NetworkListener on [::]:80 ─────────────────────────
# Probe by name match in the listener output, since the row-id
# conflict here is on the listener `name` field.
out=$(/tmp/cli --url "$URL" --user admin query NetworkListener --json 2>&1 || true)
if printf '%s\n' "$out" | grep -q '"name":"http-acme"'; then
  echo "http-acme NetworkListener exists — skipping."
else
  echo "Creating http-acme NetworkListener on [::]:80..."
  cat > /tmp/listener.json <<PLAN
{"@type":"create","object":"NetworkListener","value":{"http-acme":{"name":"http-acme","bind":{"[::]:80":true},"protocol":"http","tlsImplicit":false,"useTls":false}}}
PLAN
  /tmp/cli --url "$URL" --user admin apply --file /tmp/listener.json
fi

# ── 4. Flip Bootstrap.requestTlsCertificate=true ────────────────────
# This is an UPDATE on the singleton — idempotent across re-runs.
echo "Updating Bootstrap.requestTlsCertificate=true..."
cat > /tmp/bootstrap.json <<PLAN
{"@type":"update","object":"Bootstrap","value":{"requestTlsCertificate":true}}
PLAN
/tmp/cli --url "$URL" --user admin apply --file /tmp/bootstrap.json

echo
echo "=== Final state ==="
/tmp/cli --url "$URL" --user admin query AcmeProvider 2>&1 | head -5
echo "---"
/tmp/cli --url "$URL" --user admin query AllowedIp 2>&1 | head -10
echo "---"
/tmp/cli --url "$URL" --user admin query NetworkListener 2>&1 | head -15
echo
echo "Migration complete. Roll the Stalwart pod for the new listener to bind:"
echo "  kubectl -n mail rollout restart deploy stalwart-mail-v016"
MIGRATE
)

# Drop the migration-pod manifest into kubectl with the password +
# contact domain via env vars.
$KUBECTL run "$pod_name" -n "$NAMESPACE" --rm -i --restart=Never \
  --image=alpine \
  --env="STALWART_RECOVERY_PASSWORD=$recovery_pw" \
  --env="ACME_CONTACT_DOMAIN=$default_domain" \
  --command -- /bin/sh -c "$migration_script" \
  || err "Migration pod failed"

log
log "Migration complete. Next step:"
log "  kubectl -n $NAMESPACE rollout restart deploy stalwart-mail-v016"
log
log "Then verify TLS handshake:"
log "  echo | openssl s_client -connect <NODE_IP>:993 \\"
log "    -servername mail.<YOUR_DOMAIN> 2>&1 | grep -E 'subject=|issuer='"
