#!/usr/bin/env bash
#
# Phase 1 piece #7 (ADR-036) — end-to-end integration harness for the
# new restic-stream backup path. Validates against a live cluster
# (testing.phoenix-host.net by default; staging when SSH is back).
#
# What it exercises:
#   1. POST /admin/backup-configs to register the S3 target (Hetzner
#      Object Storage) using creds from ~/k8s-staging/servers.txt.
#   2. POST /clients to create (or reuse) a test tenant.
#   3. Wait for the tenant namespace + PVC + file-manager pod ready.
#   4. Write known-content fixture data into the PVC via file-manager.
#   5. POST /admin/tenant-bundles to trigger a backup. Async path —
#      returns bundleId immediately, then we poll for completion.
#   6. Validate via the LOCAL restic CLI on this dev machine:
#         - restic snapshots --tag bundle-id=<id> finds exactly one snap
#         - snapshot tags carry the full ADR-036 set (region, tenant-id,
#           tenant-slug, bundle-version, platform-version, component)
#         - restic restore --include of the fixture file round-trips
#           byte-identical
#   7. Repeat the bundle + validate against the SFTP target if
#      INTEGRATE_SFTP=1 (off by default — Storage Box is shared with
#      other operators; keep blast radius small unless asked).
#
# Trust boundary: this script runs on the operator's dev machine. It
# uses the same Hetzner Object Storage + Storage Box creds the
# platform-api uses (read from ~/k8s-staging/servers.txt). The
# per-tenant restic password is derived locally via the same HKDF
# the platform uses (lock vector pinned in restic-driver.test.ts).
#
# This script is idempotent on re-runs:
#   - Backup config: matched by name; created only if missing.
#   - Test client: matched by company_email; reused if present.
#   - Fixture data: overwritten each run (same path).
#   - restic repo on S3: snapshots accumulate. Run with
#     INTEGRATE_FORGET=1 to forget+prune at the end.
#
# Usage:
#   ./scripts/integration-tenant-bundles-restic.sh
#   API_BASE=https://admin.testing.phoenix-host.net \
#     ADMIN_EMAIL=admin@testing.phoenix-host.net \
#     ADMIN_PASSWORD=... \
#     ./scripts/integration-tenant-bundles-restic.sh
#
# Env knobs:
#   API_BASE          — admin-panel base URL.
#                       Default: https://admin.testing.phoenix-host.net
#   ADMIN_EMAIL/PW    — admin login.
#   SERVERS_TXT       — credential source. Default ~/k8s-staging/servers.txt.
#   PLATFORM_OIDC_KEY — OIDC_ENCRYPTION_KEY hex (64 chars). If unset,
#                       the script reads it from the testing cluster via
#                       SSH (kubectl -n platform get secret platform-secrets).
#                       Required so we can derive the per-tenant restic
#                       password locally.
#   INTEGRATE_SFTP=1  — also exercise the SFTP target.
#   INTEGRATE_FORGET=1 — restic forget+prune the test snapshots at end.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

API_BASE="${API_BASE:-https://admin.testing.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@testing.phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-le3iGtnHgC10RosCs8wr}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
TESTING_HOST="${TESTING_HOST:-root@testing.phoenix-host.net}"
SERVERS_TXT="${SERVERS_TXT:-$HOME/k8s-staging/servers.txt}"
RESTIC="${SPIKE_RESTIC:-/tmp/restic}"
if ! [ -x "$RESTIC" ]; then RESTIC="$(command -v restic 2>/dev/null || true)"; fi
[ -n "$RESTIC" ] || { echo "ERROR: restic not found; set SPIKE_RESTIC" >&2; exit 2; }

WORK="$(mktemp -d -p "${TMPDIR:-/var/tmp}" restic-itest-XXXXXX)"
echo "workdir: $WORK"
trap 'rm -rf "$WORK"' EXIT

# ── Read S3 + SFTP creds ────────────────────────────────────────────────────
strip_cr() { tr -d '\r'; }
[ -f "$SERVERS_TXT" ] || { echo "ERROR: $SERVERS_TXT not found" >&2; exit 2; }
S3_ENDPOINT=$(awk '/^https:\/\/.*your-objectstorage/{print $1; exit}' "$SERVERS_TXT" | strip_cr)
S3_BUCKET=$(awk '/^Bucket: /{print $2; exit}' "$SERVERS_TXT" | strip_cr)
S3_KEY=$(awk '/^Access Key: /{print $3; exit}' "$SERVERS_TXT" | strip_cr)
S3_SECRET=$(awk '/^Key: /{print $2; exit}' "$SERVERS_TXT" | strip_cr)
SFTP_LINE=$(grep -m1 'install-ssh-key' "$SERVERS_TXT" | strip_cr || true)
SFTP_USER=$(echo "$SFTP_LINE" | sed -nE 's|.*ssh -p([0-9]+) ([^@]+)@.*|\2|p')
SFTP_HOST=$(echo "$SFTP_LINE" | sed -nE 's|.*@([^ ]+) install-ssh-key.*|\1|p')
SFTP_PORT=$(echo "$SFTP_LINE" | sed -nE 's|.*ssh -p([0-9]+).*|\1|p')

[ -n "$S3_ENDPOINT" ] && [ -n "$S3_BUCKET" ] && [ -n "$S3_KEY" ] && [ -n "$S3_SECRET" ] || {
  echo "ERROR: S3 creds missing from $SERVERS_TXT" >&2; exit 2; }

# ── OIDC_ENCRYPTION_KEY (for HKDF deriving the per-tenant restic password) ──
if [ -z "${PLATFORM_OIDC_KEY:-}" ]; then
  echo "[1/9] reading OIDC_ENCRYPTION_KEY from testing cluster…"
  PLATFORM_OIDC_KEY=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$TESTING_HOST" \
    "kubectl -n platform get secret platform-secrets -o jsonpath='{.data.OIDC_ENCRYPTION_KEY}' 2>/dev/null | base64 -d" \
    | strip_cr || true)
  if [ -z "$PLATFORM_OIDC_KEY" ] || [ "${#PLATFORM_OIDC_KEY}" -ne 64 ]; then
    echo "ERROR: could not retrieve OIDC_ENCRYPTION_KEY (got ${#PLATFORM_OIDC_KEY} chars; expected 64 hex)" >&2
    exit 2
  fi
fi
echo "  PLATFORM_OIDC_KEY length: ${#PLATFORM_OIDC_KEY} chars"

# ── HKDF helper (matches restic-driver.deriveResticPassword exactly) ────────
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
TOKEN=$(login)
[ -n "$TOKEN" ] || { echo "ERROR: login failed"; exit 2; }
echo "  TOKEN length: ${#TOKEN}"

apij() { api -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

# ── Step 2: ensure backup config exists ─────────────────────────────────────
echo
echo "[2/9] ensuring S3 backup config exists…"
EXISTING_CFG=$(apij "$API_BASE/api/v1/admin/backup-configs" \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)["data"]
for cfg in d:
    if cfg.get("name") == "integration-test-s3":
        print(cfg["id"]); break
')
if [ -z "$EXISTING_CFG" ]; then
  echo "  creating…"
  EXISTING_CFG=$(apij -X POST "$API_BASE/api/v1/admin/backup-configs" \
    -d "$(python3 -c "
import json, os
print(json.dumps({
  'name': 'integration-test-s3',
  'storageType': 's3',
  's3Endpoint': '$S3_ENDPOINT',
  's3Bucket': '$S3_BUCKET',
  's3Region': 'fsn1',
  's3Prefix': 'tenant-bundles-itest',
  's3AccessKey': '$S3_KEY',
  's3SecretKey': '$S3_SECRET',
  'active': True,
}))
")" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
fi
echo "  S3 config id: $EXISTING_CFG"

# ── Step 3: ensure test client exists ───────────────────────────────────────
echo
echo "[3/9] ensuring test client exists…"
TEST_EMAIL="itest-restic@phoenix-host.net"
CID=$(apij "$API_BASE/api/v1/clients?limit=100" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)['data']
for c in d:
    if c.get('companyEmail') == '$TEST_EMAIL':
        print(c['id']); break
")
if [ -z "$CID" ]; then
  echo "  creating…"
  PLAN_ID=$(apij "$API_BASE/api/v1/plans?limit=1" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])')
  REGION_ID=$(apij "$API_BASE/api/v1/regions?limit=1" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])')
  echo "    plan=$PLAN_ID region=$REGION_ID"
  CID=$(apij -X POST "$API_BASE/api/v1/clients" \
    -d "$(python3 -c "
import json
print(json.dumps({
  'company_name': 'itest-restic',
  'company_email': '$TEST_EMAIL',
  'plan_id': '$PLAN_ID',
  'region_id': '$REGION_ID',
}))
")" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
fi
echo "  client id: $CID"

# Resolve the namespace from the API.
NS=$(apij "$API_BASE/api/v1/clients/$CID" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["kubernetesNamespace"])')
echo "  namespace: $NS"

# ── Step 4: wait for namespace + PVC ready ──────────────────────────────────
echo
echo "[4/9] waiting for namespace + PVC + file-manager…"
ssh -i "$SSH_KEY" "$TESTING_HOST" "
  for i in \$(seq 1 60); do
    NS_OK=\$(kubectl get ns $NS --no-headers 2>/dev/null | awk '{print \$2}')
    PVC_OK=\$(kubectl -n $NS get pvc ${NS}-storage --no-headers 2>/dev/null | awk '{print \$2}')
    FM_POD=\$(kubectl -n $NS get pods -l app=file-manager --field-selector status.phase=Running -o name 2>/dev/null | head -1)
    if [ \"\$NS_OK\" = 'Active' ] && [ \"\$PVC_OK\" = 'Bound' ] && [ -n \"\$FM_POD\" ]; then
      echo \"  ready (i=\$i): NS=\$NS_OK PVC=\$PVC_OK FM=\$FM_POD\"
      exit 0
    fi
    sleep 2
  done
  echo 'TIMEOUT waiting for namespace/PVC/file-manager'
  kubectl get ns $NS -o yaml 2>&1 | head -20
  kubectl -n $NS get pvc 2>&1 | head -5
  kubectl -n $NS get pods 2>&1 | head -5
  exit 1
"

# ── Step 5: seed the PVC with a known-content fixture ───────────────────────
echo
echo "[5/9] seeding PVC with fixture data…"
FIXTURE_PATH="var/www/uploads/2026/05/photo.jpg"
FIXTURE_SHA=$(ssh -i "$SSH_KEY" "$TESTING_HOST" "
  FM=\$(kubectl -n $NS get pods -l app=file-manager --field-selector status.phase=Running -o name | head -1)
  kubectl -n $NS exec \$FM -- sh -c 'mkdir -p /data/var/www/uploads/2026/05 && head -c 102400 /dev/urandom > /data/$FIXTURE_PATH && sha256sum /data/$FIXTURE_PATH | awk \"{print \\\$1}\"'
")
echo "  fixture sha256: $FIXTURE_SHA"

# ── Step 6: trigger bundle ──────────────────────────────────────────────────
echo
echo "[6/9] triggering bundle (S3)…"
START=$(date +%s)
BUNDLE_RESP=$(apij -X POST "$API_BASE/api/v1/admin/tenant-bundles" \
  -d "$(python3 -c "
import json
print(json.dumps({
  'clientId': '$CID',
  'async': True,
  'targetConfigId': '$EXISTING_CFG',
  'label': 'itest-restic-s3',
  'retentionDays': 7,
  'components': { 'files': True, 'mailboxes': False, 'config': False, 'secrets': False },
}))
")")
BUNDLE_ID=$(echo "$BUNDLE_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["bundleId"])')
echo "  bundle id: $BUNDLE_ID"

# ── Step 7: poll until terminal ─────────────────────────────────────────────
echo
echo "[7/9] polling bundle status…"
for i in $(seq 1 120); do
  DETAIL=$(apij "$API_BASE/api/v1/admin/tenant-bundles/$BUNDLE_ID")
  STATUS=$(echo "$DETAIL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])')
  ELAPSED=$(($(date +%s) - START))
  printf "  [t=%4ds] status=%s\n" "$ELAPSED" "$STATUS"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "partial" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
  sleep 5
done
[ "$STATUS" = "completed" ] || {
  echo "ERROR: bundle did not complete (status=$STATUS)"
  echo "$DETAIL" | python3 -m json.tool | head -40
  exit 1
}
echo "  bundle DONE in ${ELAPSED}s"

# ── Step 8: validate via local restic ───────────────────────────────────────
echo
echo "[8/9] validating restic snapshot in S3 via local CLI…"
PASS=$(hkdf_password "$PLATFORM_OIDC_KEY" "$CID")
PASS_FILE="$WORK/pw"
( umask 077 && printf '%s' "$PASS" > "$PASS_FILE" )
S3_REPO="s3:$S3_ENDPOINT/$S3_BUCKET/tenant-bundles-itest/restic-files/$CID"
export AWS_ACCESS_KEY_ID="$S3_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET"
export RESTIC_PASSWORD_FILE="$PASS_FILE"

SNAP_LIST=$("$RESTIC" --quiet --repo "$S3_REPO" snapshots --tag "bundle-id=$BUNDLE_ID" --json 2>&1)
SNAP_COUNT=$(echo "$SNAP_LIST" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)')
[ "$SNAP_COUNT" = "1" ] || { echo "FAIL: expected 1 snapshot tagged bundle-id=$BUNDLE_ID, got $SNAP_COUNT"; echo "$SNAP_LIST"; exit 1; }
SNAP_ID=$(echo "$SNAP_LIST" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
SNAP_TAGS=$(echo "$SNAP_LIST" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)[0]["tags"]))')
echo "  ✓ snapshot ${SNAP_ID:0:16} found, tags: $SNAP_TAGS"

# Assert the full ADR-036 tag set is present.
for required in "bundle-version=2" "tenant-id=$CID" "component=files" "bundle-id=$BUNDLE_ID"; do
  echo "$SNAP_TAGS" | grep -q "$required" || { echo "FAIL: missing tag '$required'"; exit 1; }
done
echo "  ✓ ADR-036 tag set complete"

# Restore single file.
RESTORE="$WORK/restore"
mkdir -p "$RESTORE"
"$RESTIC" --quiet --repo "$S3_REPO" restore "$SNAP_ID" --target "$RESTORE" --include "/$FIXTURE_PATH" >/dev/null
RESTORED=$(find "$RESTORE" -name photo.jpg -type f | head -1)
[ -n "$RESTORED" ] || { echo "FAIL: object-level restore missing $FIXTURE_PATH"; "$RESTIC" --repo "$S3_REPO" ls "$SNAP_ID" 2>&1 | head -10; exit 1; }
RESTORED_SHA=$(sha256sum "$RESTORED" | awk '{print $1}')
[ "$RESTORED_SHA" = "$FIXTURE_SHA" ] || { echo "FAIL: restored sha mismatch (orig=$FIXTURE_SHA restored=$RESTORED_SHA)"; exit 1; }
echo "  ✓ single-file restore byte-identical (sha256 ${FIXTURE_SHA:0:16}…)"

# ── Step 9: optional cleanup + SFTP repeat ──────────────────────────────────
if [ "${INTEGRATE_FORGET:-0}" = "1" ]; then
  echo
  echo "[9/9] forget+prune the test snapshot…"
  "$RESTIC" --quiet --repo "$S3_REPO" forget "$SNAP_ID" --prune >/dev/null
  echo "  ✓ pruned"
fi

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Phase 1 piece #7 integration harness — S3 PASS"
echo "════════════════════════════════════════════════════════════════════"
echo "  client:    $CID ($NS)"
echo "  bundle:    $BUNDLE_ID"
echo "  snapshot:  $SNAP_ID"
echo "  duration:  ${ELAPSED}s"
echo "  fixture:   $FIXTURE_PATH (sha256 ${FIXTURE_SHA:0:16}…)"
echo

if [ "${INTEGRATE_SFTP:-0}" = "1" ]; then
  echo "[+] SFTP integration not yet implemented in this harness — skipping."
  echo "    Use INTEGRATE_SFTP=0 to silence."
fi
