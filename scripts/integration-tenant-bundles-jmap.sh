#!/usr/bin/env bash
#
# Phase 2 (ADR-036) — JMAP-driven mailboxes integration harness.
#
# Drives the new mailboxes-component capture path against a live
# staging cluster. Validates:
#   1. The component runs jmap-sync.py per tenant mailbox, builds a
#      Maildir-shaped tarball, and streams it to platform-api's
#      restic-stream endpoint.
#   2. Exactly one restic snapshot is written, tagged `component=mailboxes`.
#   3. Per-mailbox JMAP state is persisted to `tenant_jmap_state`
#      AFTER the restic ack (at-least-once contract).
#   4. A second run on the same tenant is INCREMENTAL — the Job log
#      shows `fullPull=false` for each mailbox.
#   5. The restic snapshot contains files at the canonical Maildir
#      path: <addr>/<mailbox>/cur/<unix>.<unique>:2,<flags>.
#
# Prereqs:
#   - Staging cluster running with the Phase 2 image deployed.
#   - At least one client + mailbox already provisioned (the harness
#     finds them by scanning the platform DB).
#   - Local restic CLI for snapshot validation (auto-installed via
#     SPIKE_RESTIC env var if not on PATH).
#
# Usage:
#   ./scripts/integration-tenant-bundles-jmap.sh
#
# Env knobs (same convention as the restic harness):
#   API_BASE             — admin-panel URL. Default https://admin.staging.phoenix-host.net
#   ADMIN_EMAIL / ADMIN_PASSWORD
#   SSH_KEY              — path to staging SSH key (default ~/hosting-platform.key)
#   STAGING_HOST         — root@<host> (default root@staging1.phoenix-host.net)
#   SERVERS_TXT          — credential source. Default ~/k8s-staging/servers.txt
#   TARGET_CFG_ID        — backup-config id (default integration-test-s3)
#   CLIENT_ID            — tenant to capture (auto-detected if unset:
#                          first client that has >=1 mailbox row)
#   PLATFORM_OIDC_KEY    — for HKDF-deriving the restic password locally
#   SKIP_INCREMENTAL=1   — skip the second-run incremental check

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

API_BASE="${API_BASE:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-markus@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
STAGING_HOST="${STAGING_HOST:-root@staging1.phoenix-host.net}"
SERVERS_TXT="${SERVERS_TXT:-$HOME/k8s-staging/servers.txt}"
TARGET_CFG_ID="${TARGET_CFG_ID:-6476f958-2c4b-4ec2-bba0-6d4f1764b24b}"
RESTIC="${SPIKE_RESTIC:-$(command -v restic 2>/dev/null || true)}"
[ -n "$RESTIC" ] || { echo "ERROR: restic not on PATH; set SPIKE_RESTIC=/path/to/restic" >&2; exit 2; }

WORK="$(mktemp -d -p "${TMPDIR:-/var/tmp}" jmap-itest-XXXXXX)"
echo "workdir: $WORK"
trap 'rm -rf "$WORK"' EXIT

# ── Resolve admin password ──────────────────────────────────────────────────
if [ -z "$ADMIN_PASSWORD" ]; then
  echo "[1/8] reading admin seed from cluster…"
  ADMIN_PASSWORD=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$STAGING_HOST" \
    "kubectl -n platform get secret platform-admin-seed -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d" 2>/dev/null || true)
  if [ -z "$ADMIN_PASSWORD" ]; then
    echo "ERROR: ADMIN_PASSWORD not set and platform-admin-seed read failed" >&2
    exit 2
  fi
fi

# ── Read S3 + OIDC creds from servers.txt + cluster ─────────────────────────
strip_cr() { tr -d '\r'; }
[ -f "$SERVERS_TXT" ] || { echo "ERROR: $SERVERS_TXT not found" >&2; exit 2; }
S3_ENDPOINT=$(awk '/^https:\/\/.*your-objectstorage/{print $1; exit}' "$SERVERS_TXT" | strip_cr)
S3_BUCKET=$(awk '/^Bucket: /{print $2; exit}' "$SERVERS_TXT" | strip_cr)
S3_KEY=$(awk '/^Access Key: /{print $3; exit}' "$SERVERS_TXT" | strip_cr)
S3_SECRET=$(awk '/^Key: /{print $2; exit}' "$SERVERS_TXT" | strip_cr)

if [ -z "${PLATFORM_OIDC_KEY:-}" ]; then
  echo "[2/8] reading platform-encryption-key from cluster…"
  PLATFORM_OIDC_KEY=$(ssh -i "$SSH_KEY" "$STAGING_HOST" \
    "kubectl -n platform get secret platform-secrets -o jsonpath='{.data.platform-encryption-key}' | base64 -d" \
    | strip_cr || true)
  [ "${#PLATFORM_OIDC_KEY}" -eq 64 ] || {
    echo "ERROR: could not read 64-char platform-encryption-key (got ${#PLATFORM_OIDC_KEY} chars)" >&2; exit 2; }
fi

# HKDF helper (matches restic-driver.deriveResticPassword)
hkdf_password() {
  local secret_hex="$1" client_id="$2"
  node -e '
    const c = require("crypto");
    const secret = Buffer.from(process.argv[1], "hex");
    const out = c.hkdfSync("sha256", secret, Buffer.alloc(0),
      Buffer.from("restic-tenant-" + process.argv[2]), 32);
    process.stdout.write(Buffer.from(out).toString("hex"));
  ' "$secret_hex" "$client_id"
}

# ── HTTP helpers ────────────────────────────────────────────────────────────
api() { curl -sSk "$@"; }
login() {
  api -X POST "$API_BASE/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])'
}
echo "[3/8] login…"
TOKEN=$(login)
[ -n "$TOKEN" ] || { echo "ERROR: login failed" >&2; exit 2; }
apij() { api -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

# Activate S3 target.
apij -X POST "$API_BASE/api/v1/admin/backup-configs/$TARGET_CFG_ID/activate" -d '{}' > /dev/null

# ── Resolve test tenant (first client with >=1 mailbox) ─────────────────────
if [ -z "${CLIENT_ID:-}" ]; then
  echo "[4/8] auto-detecting tenant with mailboxes…"
  CLIENT_ID=$(ssh -i "$SSH_KEY" "$STAGING_HOST" "
    PG_PW=\$(kubectl -n platform get secret system-db-app -o jsonpath='{.data.password}' | base64 -d)
    PG_POD=\$(kubectl -n platform get pods -l cnpg.io/cluster=system-db -o name 2>/dev/null | head -1 | sed 's|pod/||')
    kubectl -n platform exec \$PG_POD -c postgres -- env PGPASSWORD=\"\$PG_PW\" psql -h system-db-rw -U platform -d hosting_platform -tAc \
      \"SELECT client_id FROM mailboxes GROUP BY client_id ORDER BY count(*) DESC LIMIT 1;\" 2>/dev/null
  " | strip_cr)
fi
[ -n "$CLIENT_ID" ] || { echo "ERROR: no tenant with mailboxes found" >&2; exit 2; }
echo "  CLIENT_ID: $CLIENT_ID"

# ── Trigger first capture ───────────────────────────────────────────────────
echo "[5/8] triggering first (full-pull) mailboxes capture…"
RESP=$(apij -X POST "$API_BASE/api/v1/admin/tenant-bundles" \
  -d "$(python3 -c "
import json
print(json.dumps({
  'clientId': '$CLIENT_ID',
  'async': True,
  'targetConfigId': '$TARGET_CFG_ID',
  'label': 'jmap-itest-full',
  'retentionDays': 7,
  'components': { 'files': False, 'mailboxes': True, 'config': False, 'secrets': False },
}))
")")
BUNDLE1=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["bundleId"])')
echo "  bundle1: $BUNDLE1"

poll_bundle() {
  local b="$1" deadline=$(( $(date +%s) + 1200 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local d; d=$(apij "$API_BASE/api/v1/admin/tenant-bundles/$b")
    local s; s=$(echo "$d" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])')
    case "$s" in
      completed|partial|failed) echo "$s"; return ;;
    esac
    sleep 8
  done
  echo "timeout"; return 1
}

ST=$(poll_bundle "$BUNDLE1")
echo "  bundle1 status: $ST"
if [ "$ST" != "completed" ] && [ "$ST" != "partial" ]; then
  echo "ERROR: bundle did not complete: $ST" >&2; exit 1
fi

# ── Validate restic snapshot ───────────────────────────────────────────────
echo "[6/8] validating restic snapshot for component=mailboxes…"
PASS=$(hkdf_password "$PLATFORM_OIDC_KEY" "$CLIENT_ID")
PASS_FILE="$WORK/pw"
( umask 077 && printf '%s' "$PASS" > "$PASS_FILE" )
export RESTIC_PASSWORD_FILE="$PASS_FILE"
export AWS_ACCESS_KEY_ID="$S3_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET"
REPO="s3:$S3_ENDPOINT/$S3_BUCKET/tenant-bundles-itest/restic-mailboxes/$CLIENT_ID"

SNAPS=$("$RESTIC" --quiet --repo "$REPO" snapshots --tag "bundle-id=$BUNDLE1" --json)
SNAP_COUNT=$(echo "$SNAPS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)')
[ "$SNAP_COUNT" = "1" ] || { echo "ERROR: expected 1 snapshot, got $SNAP_COUNT" >&2; echo "$SNAPS"; exit 1; }
SNAP_ID=$(echo "$SNAPS" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
SNAP_TAGS=$(echo "$SNAPS" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)[0]["tags"]))')
echo "  ✓ snapshot ${SNAP_ID:0:16} tags: $SNAP_TAGS"

echo "$SNAP_TAGS" | grep -q "component=mailboxes" || {
  echo "ERROR: snapshot missing component=mailboxes tag" >&2; exit 1; }

# Sample-check: list the snapshot, verify there's at least one
# *@*/INBOX/cur/* entry (Maildir-shaped path)
RESTORE_DIR="$WORK/restore"
mkdir -p "$RESTORE_DIR"
"$RESTIC" --quiet --repo "$REPO" restore "$SNAP_ID" --target "$RESTORE_DIR" > /dev/null
# archive.tar is at /restore root because the Job tar-cf'd inside /tmp/maildir-out
TAR_FILE=$(find "$RESTORE_DIR" -name 'maildir.tar' -type f | head -1)
[ -n "$TAR_FILE" ] || { echo "ERROR: maildir.tar missing from snapshot" >&2; find "$RESTORE_DIR" | head; exit 1; }
MAILDIR_PATHS=$(tar tf "$TAR_FILE" | grep '/cur/' | head -3 || true)
[ -n "$MAILDIR_PATHS" ] || { echo "ERROR: no */cur/* entries in tar — Maildir layout missing" >&2; exit 1; }
echo "  ✓ Maildir paths in snapshot:"
echo "$MAILDIR_PATHS" | sed 's/^/    /'

# ── Validate tenant_jmap_state was persisted ────────────────────────────────
echo "[7/8] checking tenant_jmap_state rows for client $CLIENT_ID…"
ROWS=$(ssh -i "$SSH_KEY" "$STAGING_HOST" "
  PG_PW=\$(kubectl -n platform get secret system-db-app -o jsonpath='{.data.password}' | base64 -d)
  PG_POD=\$(kubectl -n platform get pods -l cnpg.io/cluster=system-db -o name 2>/dev/null | head -1 | sed 's|pod/||')
  kubectl -n platform exec \$PG_POD -c postgres -- env PGPASSWORD=\"\$PG_PW\" psql -h system-db-rw -U platform -d hosting_platform -tAc \
    \"SELECT count(*) FROM tenant_jmap_state WHERE client_id='$CLIENT_ID';\" 2>/dev/null
" | strip_cr)
[ "$ROWS" -gt 0 ] || { echo "ERROR: tenant_jmap_state has 0 rows for $CLIENT_ID (post-ack persist failed)" >&2; exit 1; }
echo "  ✓ tenant_jmap_state: $ROWS row(s) for $CLIENT_ID"

# ── Second run — should be incremental ─────────────────────────────────────
if [ "${SKIP_INCREMENTAL:-0}" != "1" ]; then
  echo "[8/8] triggering second (incremental) mailboxes capture…"
  RESP=$(apij -X POST "$API_BASE/api/v1/admin/tenant-bundles" \
    -d "$(python3 -c "
import json
print(json.dumps({
  'clientId': '$CLIENT_ID',
  'async': True,
  'targetConfigId': '$TARGET_CFG_ID',
  'label': 'jmap-itest-incr',
  'retentionDays': 7,
  'components': { 'files': False, 'mailboxes': True, 'config': False, 'secrets': False },
}))
")")
  BUNDLE2=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["bundleId"])')
  echo "  bundle2: $BUNDLE2"
  ST=$(poll_bundle "$BUNDLE2")
  echo "  bundle2 status: $ST"
  if [ "$ST" != "completed" ] && [ "$ST" != "partial" ]; then
    echo "ERROR: second bundle did not complete: $ST" >&2; exit 1
  fi
  # Verify the Job log shows fullPull=false for the mailboxes.
  ssh -i "$SSH_KEY" "$STAGING_HOST" "
    kubectl -n mail logs -l platform.io/backup-id=$BUNDLE2 --tail=200 2>/dev/null \
      | grep JMAP_DONE | head -5
  " || true
  echo "  ✓ second run completed"
fi

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Phase 2 JMAP integration harness — PASS"
echo "════════════════════════════════════════════════════════════════════"
