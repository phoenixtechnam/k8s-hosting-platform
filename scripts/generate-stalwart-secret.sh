#!/bin/bash
# generate-stalwart-secret.sh — create the initial Stalwart admin + master
# credentials as k8s Secrets.
#
# Idempotent: if the mail-namespace Secret already exists and --force is
# not set, the script exits 0 without touching anything.
#
# Creates two Secrets:
#   mail/<secret>          — Stalwart's own (ADMIN_SECRET hash +
#                            ADMIN_SECRET_PLAIN cleartext, MASTER_SECRET,
#                            STALWART_HOSTNAME, STALWART_DB_*)
#   platform/<mirror>      — platform-api mirror (ADMIN_SECRET_PLAIN only)
#                            for cross-namespace env injection.
#
# Usage:
#   generate-stalwart-secret.sh \
#     --hostname=mail.example.com \
#     --db-password=... [--db-host=...] [--db-name=...] [--db-user=...] \
#     [--mail-namespace=mail] [--platform-namespace=platform] \
#     [--secret-name=stalwart-secrets] [--mirror-name=platform-stalwart-creds] \
#     [--force] [--quiet]
#
# Environment overrides:
#   KUBECTL   — kubectl command (default "kubectl"). Callers running against
#               a sibling DinD-hosted k3s set this to something like
#               "docker exec -i hosting-platform-k3s-server-1 kubectl".
#
# Hashing requires either htpasswd (apache2-utils) on PATH, or Docker
# available to run httpd:2.4-alpine.

set -euo pipefail
# With pipefail, `htpasswd | cut | tr` propagates any non-zero exit from
# htpasswd instead of silently producing an empty hash. Without it, a bad
# hash would be written to the Secret and every login would fail.

MAIL_NS=${MAIL_NS:-mail}
PLATFORM_NS=${PLATFORM_NS:-platform}
SECRET_NAME=${SECRET_NAME:-stalwart-secrets}
MIRROR_NAME=${MIRROR_NAME:-platform-stalwart-creds}
STALWART_HOSTNAME=${STALWART_HOSTNAME:-}
DB_HOST=${DB_HOST:-platform-postgres.mail.svc.cluster.local}
DB_NAME=${DB_NAME:-hosting_platform}
DB_USER=${DB_USER:-stalwart_reader}
DB_PASSWORD=${DB_PASSWORD:-}
FORCE=${FORCE:-0}
QUIET=${QUIET:-0}
KUBECTL=${KUBECTL:-kubectl}

while [ $# -gt 0 ]; do
  case "$1" in
    --mail-namespace=*) MAIL_NS="${1#*=}" ;;
    --platform-namespace=*) PLATFORM_NS="${1#*=}" ;;
    --secret-name=*) SECRET_NAME="${1#*=}" ;;
    --mirror-name=*) MIRROR_NAME="${1#*=}" ;;
    --hostname=*) STALWART_HOSTNAME="${1#*=}" ;;
    --db-host=*) DB_HOST="${1#*=}" ;;
    --db-name=*) DB_NAME="${1#*=}" ;;
    --db-user=*) DB_USER="${1#*=}" ;;
    --db-password=*) DB_PASSWORD="${1#*=}" ;;
    --force) FORCE=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help)
      sed -n '2,34p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$STALWART_HOSTNAME" ] || { echo "ERROR: --hostname is required" >&2; exit 2; }
[ -n "$DB_PASSWORD" ] || { echo "ERROR: --db-password is required" >&2; exit 2; }

log() { [ "$QUIET" = "1" ] || echo "[generate-stalwart-secret] $*" >&2; }

# Idempotency check — skip if Secret already exists.
if $KUBECTL get secret "$SECRET_NAME" -n "$MAIL_NS" >/dev/null 2>&1; then
  if [ "$FORCE" != "1" ]; then
    log "$MAIL_NS/$SECRET_NAME already exists — skipping. Use --force to overwrite."
    log "Retrieve creds via the admin panel's 'Show Stalwart Credentials' button."
    exit 0
  fi
  log "$MAIL_NS/$SECRET_NAME exists; --force set → overwriting."
fi

# ─── Generate random passwords (URL-safe, 32 bytes) ──────────────────────
ADMIN_PW=$(openssl rand -base64 32 | tr -d '\n=+/' | cut -c 1-43)
MASTER_PW=$(openssl rand -base64 32 | tr -d '\n=+/' | cut -c 1-43)

# ─── Hash via htpasswd (bcrypt cost 12) ───────────────────────────────────
hash_password() {
  plain=$1
  if command -v htpasswd >/dev/null 2>&1; then
    printf '%s' "$(htpasswd -bnBC 12 '' "$plain" 2>/dev/null | cut -d: -f2 | tr -d '\n')"
    return
  fi
  if command -v docker >/dev/null 2>&1; then
    printf '%s' "$(docker run --rm httpd:2.4-alpine htpasswd -bnBC 12 '' "$plain" 2>/dev/null | cut -d: -f2 | tr -d '\n')"
    return
  fi
  echo "ERROR: need 'htpasswd' (apache2-utils) on PATH or 'docker' available to run httpd:2.4-alpine" >&2
  exit 1
}

log "Generating admin + master passwords and bcrypt hashes (this takes a few seconds)..."
ADMIN_HASH=$(hash_password "$ADMIN_PW")
MASTER_HASH=$(hash_password "$MASTER_PW")

# Belt + suspenders on top of pipefail: explicit non-empty check to catch
# any silent-empty path we haven't foreseen. An empty hash would write a
# broken Secret that's hard to diagnose later.
[ -n "$ADMIN_HASH" ]  || { echo "ERROR: admin password hash is empty"  >&2; exit 1; }
[ -n "$MASTER_HASH" ] || { echo "ERROR: master password hash is empty" >&2; exit 1; }
case "$ADMIN_HASH" in
  '$2'*) ;;  # valid bcrypt
  *) echo "ERROR: admin hash does not look like bcrypt ($ADMIN_HASH)" >&2; exit 1 ;;
esac

# ─── Ensure namespaces exist ─────────────────────────────────────────────
$KUBECTL get namespace "$MAIL_NS"    >/dev/null 2>&1 || $KUBECTL create namespace "$MAIL_NS" >/dev/null
$KUBECTL get namespace "$PLATFORM_NS" >/dev/null 2>&1 || $KUBECTL create namespace "$PLATFORM_NS" >/dev/null

# ─── Write mail/stalwart-secrets (create-or-replace via apply) ───────────
$KUBECTL create secret generic "$SECRET_NAME" -n "$MAIL_NS" \
  --from-literal=ADMIN_SECRET="$ADMIN_HASH" \
  --from-literal=ADMIN_SECRET_PLAIN="$ADMIN_PW" \
  --from-literal=MASTER_SECRET="$MASTER_HASH" \
  --from-literal=STALWART_HOSTNAME="$STALWART_HOSTNAME" \
  --from-literal=STALWART_DB_HOST="$DB_HOST" \
  --from-literal=STALWART_DB_NAME="$DB_NAME" \
  --from-literal=STALWART_DB_USER="$DB_USER" \
  --from-literal=STALWART_DB_PASSWORD="$DB_PASSWORD" \
  --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null

# ─── Write platform/platform-stalwart-creds mirror ───────────────────────
$KUBECTL create secret generic "$MIRROR_NAME" -n "$PLATFORM_NS" \
  --from-literal=ADMIN_SECRET_PLAIN="$ADMIN_PW" \
  --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null

# ─── Print once (stderr) so operators can save the creds ─────────────────
if [ "$QUIET" != "1" ]; then
  cat >&2 <<EOF

════════════════════════════════════════════════════════════════
  STALWART CREDENTIALS  ·  SAVE NOW — shown only once
════════════════════════════════════════════════════════════════
  k8s Secret: $MAIL_NS/$SECRET_NAME
  Hostname:   $STALWART_HOSTNAME

  Admin user:   admin
  Admin pass:   $ADMIN_PW

  Master user:  master      (used by Roundcube for SSO)
  Master pass:  $MASTER_PW
════════════════════════════════════════════════════════════════
  You can always retrieve the admin password later via the admin
  panel's "Show Stalwart Credentials" button on Email Management,
  or by reading the k8s Secret directly.
════════════════════════════════════════════════════════════════

EOF
fi
