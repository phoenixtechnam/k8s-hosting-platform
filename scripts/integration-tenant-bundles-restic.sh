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
#   PLATFORM_OIDC_KEY — PLATFORM_ENCRYPTION_KEY hex (64 chars). If unset,
#                       the script reads it from the testing cluster via
#                       SSH (kubectl -n platform get secret platform-secrets).
#                       Required so we can derive the per-tenant restic
#                       password locally.
#   INTEGRATE_SFTP=1  — also exercise the SFTP target.
#   INTEGRATE_FORGET=1 — restic forget+prune the test snapshots at end.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034  # ROOT used for path construction by future variants of this script
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
# SFTP key path (override SFTP_KEY env if a different identity is used
# for the storage-box vs the cluster). Defaults to the same key as SSH_KEY.
SFTP_KEY="${SFTP_KEY:-$SSH_KEY}"

[ -n "$S3_ENDPOINT" ] && [ -n "$S3_BUCKET" ] && [ -n "$S3_KEY" ] && [ -n "$S3_SECRET" ] || {
  echo "ERROR: S3 creds missing from $SERVERS_TXT" >&2; exit 2; }

# ── PLATFORM_ENCRYPTION_KEY (for HKDF deriving the per-tenant restic password) ──
if [ -z "${PLATFORM_OIDC_KEY:-}" ]; then
  echo "[1/9] reading PLATFORM_ENCRYPTION_KEY from testing cluster…"
  PLATFORM_OIDC_KEY=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$TESTING_HOST" \
    "kubectl -n platform get secret platform-secrets -o jsonpath='{.data.PLATFORM_ENCRYPTION_KEY}' 2>/dev/null | base64 -d" \
    | strip_cr || true)
  if [ -z "$PLATFORM_OIDC_KEY" ] || [ "${#PLATFORM_OIDC_KEY}" -ne 64 ]; then
    echo "ERROR: could not retrieve PLATFORM_ENCRYPTION_KEY (got ${#PLATFORM_OIDC_KEY} chars; expected 64 hex)" >&2
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
# Operator can override with BACKUP_CONFIG_OVERRIDE=<uuid> to drive a
# pre-configured target (e.g. SFTP). When unset, find-or-create the
# default S3 config.
echo
echo "[2/9] ensuring backup config exists…"
if [ -n "${BACKUP_CONFIG_OVERRIDE:-}" ]; then
  EXISTING_CFG="$BACKUP_CONFIG_OVERRIDE"
  echo "  using operator-supplied BACKUP_CONFIG_OVERRIDE: $EXISTING_CFG"
else
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
  # Schema is snake_case (createBackupConfigSchema in
  # packages/api-contracts/src/backup-config.ts). The `active` flag is
  # named `enabled` in create input; cluster-side it becomes the
  # is_active bool on backup_configurations.
  EXISTING_CFG=$(apij -X POST "$API_BASE/api/v1/admin/backup-configs" \
    -d "$(python3 -c "
import json
print(json.dumps({
  'name': 'integration-test-s3',
  'storage_type': 's3',
  's3_endpoint': '$S3_ENDPOINT',
  's3_bucket': '$S3_BUCKET',
  's3_region': 'fsn1',
  's3_prefix': 'tenant-bundles-itest',
  's3_access_key': '$S3_KEY',
  's3_secret_key': '$S3_SECRET',
  'retention_days': 7,
  'enabled': True,
}))
")" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["data"]["id"]) if "data" in r else print(json.dumps(r))')
  fi
fi
echo "  config id: $EXISTING_CFG"

# Ensure the target is active (separate flag from `enabled`; only one
# target may be is_active=true at a time per the partial unique
# index). Idempotent — POST /activate on an already-active config is
# a no-op success.
# /activate accepts no body but Fastify rejects empty body when
# Content-Type is application/json. Send an explicit empty object.
ACTIVATE_RESP=$(apij -X POST "$API_BASE/api/v1/admin/backup-configs/$EXISTING_CFG/activate" -d '{}')
echo "  activate: $(echo "$ACTIVATE_RESP" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("OK" if "data" in r else json.dumps(r))')"

# ── Step 3: ensure test client exists ───────────────────────────────────────
echo
echo "[3/9] ensuring test client exists…"
TEST_EMAIL="${TEST_EMAIL:-itest-restic@phoenix-host.net}"
if [ -n "${CLIENT_ID_OVERRIDE:-}" ]; then
  CID="$CLIENT_ID_OVERRIDE"
  echo "  reusing operator-supplied CLIENT_ID_OVERRIDE: $CID"
else
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
    # Pick the smallest plan that fits cluster capacity. Premium (200 GiB) tends
    # to fail PROVISION_OVER_CAPACITY on lab clusters. Prefer 'starter'.
    PLAN_ID=$(apij "$API_BASE/api/v1/plans?limit=10" | python3 -c "
import json, sys
plans = json.load(sys.stdin)['data']
for p in sorted(plans, key=lambda x: float(x['storageLimit'])):
    print(p['id']); break
")
    REGION_ID=$(apij "$API_BASE/api/v1/regions?limit=1" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])')
    echo "    plan=$PLAN_ID region=$REGION_ID"
    CREATE_RESP=$(apij -X POST "$API_BASE/api/v1/clients" \
      -d "$(python3 -c "
import json
print(json.dumps({
  'company_name': 'itest-restic',
  'company_email': '$TEST_EMAIL',
  'plan_id': '$PLAN_ID',
  'region_id': '$REGION_ID',
}))
")")
    CID=$(echo "$CREATE_RESP" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["data"]["id"]) if "data" in r else None')
    if [ -z "$CID" ]; then
      echo "FAIL: could not create client. Response was:"; echo "$CREATE_RESP" | python3 -m json.tool | head -20
      echo "Hint: pass CLIENT_ID_OVERRIDE=<existing-active-client-id> to reuse a tenant."
      exit 1
    fi
  fi
fi
echo "  client id: $CID"

# Resolve the namespace from the API.
NS=$(apij "$API_BASE/api/v1/clients/$CID" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["kubernetesNamespace"])')
echo "  namespace: $NS"

# ── Step 4: wait for namespace + PVC ready, find a writer pod ──────────────
# Prefer file-manager (purpose-built for PVC writes); fall back to any
# pod that has the tenant PVC mounted. Writer must already be Running.
echo
echo "[4/9] waiting for namespace + PVC + writer pod…"
# Use a here-doc with NO substitutions at the bash level — instead
# pass NS via env. This sidesteps the shell-quoting trap that broke
# the Python f-string literal in earlier rev.
WRITER_INFO=$(ssh -i "$SSH_KEY" "$TESTING_HOST" "NS=$NS bash -s" <<'REMOTE'
set -e
PVC_NAME="${NS}-storage"
for i in $(seq 1 60); do
  NS_OK=$(kubectl get ns "$NS" --no-headers 2>/dev/null | awk '{print $2}')
  PVC_OK=$(kubectl -n "$NS" get pvc "$PVC_NAME" --no-headers 2>/dev/null | awk '{print $2}')
  if [ "$NS_OK" = 'Active' ] && [ "$PVC_OK" = 'Bound' ]; then
    # 1. Prefer a Running file-manager pod (purpose-built; mount=/data)
    FM=$(kubectl -n "$NS" get pods -l app=file-manager --field-selector status.phase=Running -o name 2>/dev/null | head -1 | sed 's|pod/||')
    if [ -n "$FM" ]; then
      echo "POD=$FM"
      echo "MOUNT=/data"
      echo "CONTAINER=file-manager"
      exit 0
    fi
    # 2. Fall back: scan Running pods, look for one whose volumes list
    # contains a persistentVolumeClaim with claimName=$PVC_NAME, then
    # find the matching volumeMount under any container.
    while IFS= read -r POD; do
      [ -z "$POD" ] && continue
      VOL_NAMES=$(kubectl -n "$NS" get pod "$POD" -o jsonpath='{range .spec.volumes[?(@.persistentVolumeClaim.claimName=="'"$PVC_NAME"'")]}{.name}{"\n"}{end}' 2>/dev/null | head -3)
      [ -z "$VOL_NAMES" ] && continue
      for VOL in $VOL_NAMES; do
        # Walk every container's volumeMounts looking for this volume.
        MAPPING=$(kubectl -n "$NS" get pod "$POD" -o jsonpath='{range .spec.containers[*]}{.name}{"|"}{range .volumeMounts[?(@.name=="'"$VOL"'")]}{.mountPath}{"\n"}{end}{end}' 2>/dev/null | grep -v '|$' | head -1)
        if [ -n "$MAPPING" ]; then
          CONT=$(echo "$MAPPING" | cut -d'|' -f1)
          MNT=$(echo "$MAPPING" | cut -d'|' -f2)
          echo "POD=$POD"
          echo "MOUNT=$MNT"
          echo "CONTAINER=$CONT"
          exit 0
        fi
      done
    done < <(kubectl -n "$NS" get pods --field-selector status.phase=Running -o name 2>/dev/null | sed 's|pod/||')
  fi
  sleep 2
done
echo "TIMEOUT" >&2
kubectl -n "$NS" get pods 2>&1 | head -10 >&2
exit 1
REMOTE
)
WRITER_POD=$(echo "$WRITER_INFO" | grep "^POD=" | cut -d'=' -f2)
WRITER_MOUNT=$(echo "$WRITER_INFO" | grep "^MOUNT=" | cut -d'=' -f2)
WRITER_CONTAINER=$(echo "$WRITER_INFO" | grep "^CONTAINER=" | cut -d'=' -f2)
[ -n "$WRITER_POD" ] || { echo "FAIL: no writer pod found"; exit 1; }
echo "  writer pod: $WRITER_POD container: $WRITER_CONTAINER mount: $WRITER_MOUNT"

# ── Step 5: seed the PVC with a known-content fixture ───────────────────────
echo
echo "[5/9] seeding PVC with fixture data…"
FIXTURE_REL="itest-restic/photo-$(date +%s).bin"   # path relative to PVC root
FIXTURE_PATH="${WRITER_MOUNT}/${FIXTURE_REL}"
FIXTURE_SHA=$(ssh -i "$SSH_KEY" "$TESTING_HOST" "
  kubectl -n $NS exec $WRITER_POD -c $WRITER_CONTAINER -- sh -c 'mkdir -p \$(dirname $FIXTURE_PATH) && head -c 102400 /dev/urandom > $FIXTURE_PATH && sha256sum $FIXTURE_PATH | awk \"{print \\\$1}\"'
")
echo "  fixture in-pod path: $FIXTURE_PATH"
echo "  fixture rel-to-PVC:  $FIXTURE_REL"
echo "  fixture sha256:      $FIXTURE_SHA"

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
# shellcheck disable=SC2034  # i is loop counter only; we use ELAPSED for time
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
export RESTIC_PASSWORD_FILE="$PASS_FILE"

# Resolve the actual storage target from the bundle target_kind so
# the local restic CLI knows whether to read S3 or SFTP. Both repo
# layouts use restic-files/<clientId> per ADR-036 §"repo URI portability".
# No GET-by-id endpoint exists; read storageType from the list response.
TARGET_KIND=$(apij "$API_BASE/api/v1/admin/backup-configs" \
  | python3 -c "
import json, sys
for c in json.load(sys.stdin)['data']:
    if c.get('id') == '$EXISTING_CFG':
        print(c.get('storageType', 's3')); break
" 2>/dev/null || echo s3)
echo "  target kind: $TARGET_KIND"

if [ "$TARGET_KIND" = "s3" ]; then
  REPO="s3:$S3_ENDPOINT/$S3_BUCKET/tenant-bundles-itest/restic-files/$CID"
  export AWS_ACCESS_KEY_ID="$S3_KEY"
  export AWS_SECRET_ACCESS_KEY="$S3_SECRET"
  RESTIC_OPTS=()
elif [ "$TARGET_KIND" = "ssh" ]; then
  REPO="sftp:$SFTP_USER@$SFTP_HOST:tenant-bundles-itest/restic-files/$CID"
  key_q=$(printf '%q' "$SFTP_KEY")
  port_q=$(printf '%q' "$SFTP_PORT")
  dest_q=$(printf '%q' "$SFTP_USER@$SFTP_HOST")
  SFTP_CMD="ssh -i $key_q -p $port_q -o StrictHostKeyChecking=accept-new -o BatchMode=yes -s $dest_q sftp"
  RESTIC_OPTS=(-o "sftp.command=$SFTP_CMD")
else
  echo "FAIL: unknown target kind '$TARGET_KIND'"; exit 1
fi

SNAP_LIST=$("$RESTIC" --quiet --repo "$REPO" "${RESTIC_OPTS[@]}" snapshots --tag "bundle-id=$BUNDLE_ID" --json 2>&1)
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

# Restore the streamed archive.tar then extract the fixture.
# `restic backup --stdin --stdin-filename archive.tar` stores the
# entire stream as a single restic file. Per-file restore is a
# two-step extract (restore the tar, then untar the entry).
RESTORE="$WORK/restore"
mkdir -p "$RESTORE"
"$RESTIC" --quiet --repo "$REPO" "${RESTIC_OPTS[@]}" restore "$SNAP_ID" --target "$RESTORE" >/dev/null
RESTORED_TAR=$(find "$RESTORE" -name archive.tar -type f | head -1)
[ -n "$RESTORED_TAR" ] || { echo "FAIL: archive.tar missing from restore output"; ls -la "$RESTORE"; "$RESTIC" --repo "$REPO" "${RESTIC_OPTS[@]}" ls "$SNAP_ID" 2>&1 | head -10; exit 1; }
echo "  ✓ archive.tar restored ($(stat -c%s "$RESTORED_TAR") bytes)"
mkdir -p "$WORK/extract"
tar xf "$RESTORED_TAR" -C "$WORK/extract" "./$FIXTURE_REL" 2>/dev/null \
  || tar xf "$RESTORED_TAR" -C "$WORK/extract" "$FIXTURE_REL" 2>/dev/null \
  || { echo "FAIL: fixture not present in archive.tar at ./$FIXTURE_REL"; tar tf "$RESTORED_TAR" | head -20; exit 1; }
RESTORED_FIXTURE=$(find "$WORK/extract" -name "$(basename "$FIXTURE_REL")" -type f | head -1)
RESTORED_SHA=$(sha256sum "$RESTORED_FIXTURE" | awk '{print $1}')
[ "$RESTORED_SHA" = "$FIXTURE_SHA" ] || { echo "FAIL: restored sha mismatch (orig=$FIXTURE_SHA restored=$RESTORED_SHA)"; exit 1; }
echo "  ✓ fixture round-trip byte-identical (sha256 ${FIXTURE_SHA:0:16}…)"

# ── Step 9: optional cleanup + SFTP repeat ──────────────────────────────────
if [ "${INTEGRATE_FORGET:-0}" = "1" ]; then
  echo
  echo "[9/9] forget+prune the test snapshot…"
  "$RESTIC" --quiet --repo "$REPO" "${RESTIC_OPTS[@]}" forget "$SNAP_ID" --prune >/dev/null
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
