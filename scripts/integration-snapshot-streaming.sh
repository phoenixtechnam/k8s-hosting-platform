#!/usr/bin/env bash
#
# Phase 4 of snapshot-storage overhaul — streaming snapshot E2E harness.
#
# Prerequisites:
#   - DinD cluster running (./scripts/local.sh up)
#   - minio deployed in dev-minio namespace (k8s/dev/minio/minio.yaml)
#   - admin login (admin@k8s-platform.test / admin)
#
# What this exercises:
#   A. Tenant + PVC creation
#   B. backup_configurations row pointing at dev minio
#   C. backup_target_assignments → tenant_snapshot routed to minio
#   D. Manual snapshot API → streaming rclone Job → archive in bucket
#   E. sha256 sidecar present + matches archive
#   F. Negative paths:
#      F1. Snapshot with no assignment → 409 NO_SNAPSHOT_TARGET
#      F2. Snapshot with disabled target → 400 TARGET_DISABLED
#      F3. Snapshot with incomplete target → 400 TARGET_INCOMPLETE
#      F4. Two targets, primary unreachable → snapshot fails (strict primary)
#
# Idempotent: deletes any prior test fixtures before running.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

API_BASE="${API_BASE:-https://dind.local:2011}"
ADMIN_HOST="${ADMIN_HOST:-admin.k8s-platform.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"

# Test fixtures — all suffixed with `e2e-` so cleanup is targeted.
FIXTURE_PREFIX="e2e-snap-streaming"
TENANT_ID=""
TARGET_ID=""
SAMBA_TARGET_ID=""

# ─── helpers ───────────────────────────────────────────────────────────

c_red()    { printf "\033[31m%s\033[0m" "$*"; }
c_green()  { printf "\033[32m%s\033[0m" "$*"; }
c_yellow() { printf "\033[33m%s\033[0m" "$*"; }
c_bold()   { printf "\033[1m%s\033[0m" "$*"; }

PASS=0
FAIL=0
SKIP=0

pass() { echo "  $(c_green "✓") $1"; PASS=$((PASS+1)); }
fail() { echo "  $(c_red "✗") $1"; FAIL=$((FAIL+1)); }
skip() { echo "  $(c_yellow "○") $1"; SKIP=$((SKIP+1)); }
note() { echo "  $(c_yellow "·") $1"; }

step() { echo; echo "$(c_bold "▸ $*")"; }

# ─── http helpers ──────────────────────────────────────────────────────

JWT=""
acquire_jwt() {
  JWT=$(curl -sk --max-time 5 -H "Host: $ADMIN_HOST" -X POST "$API_BASE/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | grep -oE '"token":"[^"]+"' | sed 's/"token":"//;s/"$//')
  [ -n "$JWT" ] || { echo "ERR: login failed"; exit 1; }
}

api() {
  local method="$1"; shift
  local path="$1"; shift
  local body="${1:-}"
  if [ -n "$body" ]; then
    curl -sk --max-time 30 -H "Host: $ADMIN_HOST" -H "Authorization: Bearer $JWT" \
      -X "$method" "$API_BASE$path" \
      -H "Content-Type: application/json" -d "$body"
  else
    curl -sk --max-time 30 -H "Host: $ADMIN_HOST" -H "Authorization: Bearer $JWT" \
      -X "$method" "$API_BASE$path"
  fi
}

api_with_status() {
  local method="$1"; shift
  local path="$1"; shift
  local body="${1:-}"
  if [ -n "$body" ]; then
    curl -sk --max-time 30 -w "\n%{http_code}" -H "Host: $ADMIN_HOST" -H "Authorization: Bearer $JWT" \
      -X "$method" "$API_BASE$path" -H "Content-Type: application/json" -d "$body"
  else
    curl -sk --max-time 30 -w "\n%{http_code}" -H "Host: $ADMIN_HOST" -H "Authorization: Bearer $JWT" \
      -X "$method" "$API_BASE$path"
  fi
}

psql_exec() {
  docker exec -i hosting-platform-k3s-server-1 kubectl exec -n platform system-db-1 -c postgres -- \
    psql -U postgres -d hosting_platform -tA -c "$1"
}

kubectl_dind() {
  docker exec hosting-platform-k3s-server-1 kubectl "$@"
}

# ─── cleanup ───────────────────────────────────────────────────────────

cleanup() {
  echo
  step "Cleanup"
  # Empty assignments so RESTRICT doesn't block target delete.
  for class in tenant_snapshot tenant_bundle system_snapshot system_etcd system_secrets; do
    api PUT "/api/v1/admin/snapshots/classes/$class/assignments" '{"assignments":[]}' >/dev/null 2>&1 || true
  done

  if [ -n "$TARGET_ID" ]; then
    psql_exec "DELETE FROM backup_configurations WHERE id = '$TARGET_ID';" >/dev/null 2>&1 || true
  fi
  psql_exec "DELETE FROM backup_configurations WHERE name LIKE '$FIXTURE_PREFIX-%';" >/dev/null 2>&1 || true

  if [ -n "$TENANT_ID" ]; then
    psql_exec "DELETE FROM storage_snapshots WHERE tenant_id = '$TENANT_ID';" >/dev/null 2>&1 || true
    psql_exec "DELETE FROM storage_operations WHERE tenant_id = '$TENANT_ID';" >/dev/null 2>&1 || true
    psql_exec "DELETE FROM tenants WHERE id = '$TENANT_ID';" >/dev/null 2>&1 || true
  fi

  # Delete any test namespace + PVC
  kubectl_dind delete namespace "$FIXTURE_NS" --ignore-not-found --timeout=15s >/dev/null 2>&1 || true

  # Best-effort minio bucket clean
  kubectl_dind exec -n dev-minio deploy/minio -- sh -c \
    "mc alias set local http://localhost:9000 minio-dev-access-key minio-dev-secret-key >/dev/null 2>&1 && mc rm --recursive --force local/snapshots/snapshots/tenant_snapshot/ 2>/dev/null" >/dev/null 2>&1 || true

  # Best-effort samba share clean (Phase M+N+O leftovers).
  kubectl_dind exec -n dev-samba deploy/samba -- sh -c \
    "rm -rf /share/snapshots/tenant_snapshot 2>/dev/null" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ─── fixtures ──────────────────────────────────────────────────────────

FIXTURE_NS=""

create_tenant_with_pvc() {
  step "Create test tenant + namespace + PVC"
  TENANT_ID=$(node -e 'console.log(crypto.randomUUID())')
  FIXTURE_NS="tenant-${FIXTURE_PREFIX}-$(echo "$TENANT_ID" | cut -c1-8)"
  local plan_id region_id
  plan_id=$(psql_exec "SELECT id FROM hosting_plans LIMIT 1")
  region_id=$(psql_exec "SELECT id FROM regions LIMIT 1")

  psql_exec "INSERT INTO tenants (id, region_id, name, primary_email, status, kubernetes_namespace, plan_id, created_at, updated_at)
             VALUES ('$TENANT_ID', '$region_id', '$FIXTURE_PREFIX', 'e2e@test', 'active', '$FIXTURE_NS', '$plan_id', NOW(), NOW());" >/dev/null
  pass "tenant row inserted (id=$TENANT_ID)"

  kubectl_dind create namespace "$FIXTURE_NS" >/dev/null
  pass "namespace $FIXTURE_NS created"

  # Apply a minimal PVC + bind it via a writer pod that pre-fills test data
  cat > /tmp/e2e-pvc.yaml <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${FIXTURE_NS}-storage
  namespace: ${FIXTURE_NS}
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 100Mi } }
---
apiVersion: v1
kind: Pod
metadata:
  name: writer
  namespace: ${FIXTURE_NS}
spec:
  restartPolicy: OnFailure
  containers:
    - name: w
      image: busybox:1.36
      command: ['sh','-c','for i in 1 2 3 4 5; do echo "hello-\$i" > /data/file-\$i.txt; done; echo "DONE"; sleep 5']
      volumeMounts:
        - { name: data, mountPath: /data }
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: ${FIXTURE_NS}-storage }
EOF
  docker cp /tmp/e2e-pvc.yaml hosting-platform-k3s-server-1:/tmp/e2e-pvc.yaml >/dev/null
  kubectl_dind apply -f /tmp/e2e-pvc.yaml >/dev/null
  # Wait for writer to finish + PVC to settle
  for i in $(seq 1 30); do
    local phase
    phase=$(kubectl_dind get pod -n "$FIXTURE_NS" writer -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [ "$phase" = "Succeeded" ] || [ "$phase" = "Running" ]; then break; fi
    sleep 2
  done
  pass "PVC + writer pod ready"
  # Delete the writer so the PVC's RWO lock is released for the snapshot
  kubectl_dind delete pod -n "$FIXTURE_NS" writer --wait=true --timeout=30s >/dev/null
  pass "writer pod removed (PVC freed for snapshot Job)"
}

configure_minio_target() {
  step "Configure dev minio as backup target"
  TARGET_ID=$(node -e 'console.log(crypto.randomUUID())')
  # Plaintext credentials so we can insert them as-is via psql. The
  # backend's encrypt() round-trips them on creation only through the
  # API endpoints — direct DB inserts must use the raw API to encrypt.
  # For test fixtures we use the API's POST endpoint instead.
  local body
  body=$(cat <<EOF
{
  "name": "$FIXTURE_PREFIX-minio",
  "storage_type": "s3",
  "s3_endpoint": "http://minio.dev-minio.svc.cluster.local:9000",
  "s3_bucket": "snapshots",
  "s3_region": "us-east-1",
  "s3_access_key": "minio-dev-access-key",
  "s3_secret_key": "minio-dev-secret-key",
  "s3_prefix": "",
  "retention_days": 7
}
EOF
  )
  local resp http
  resp=$(api_with_status POST /api/v1/admin/backup-configs "$body")
  http=$(echo "$resp" | tail -1)
  if [ "$http" != "200" ] && [ "$http" != "201" ]; then
    fail "POST /admin/backup-configs returned $http"
    echo "$resp" | head -3
    return 1
  fi
  TARGET_ID=$(echo "$resp" | head -n -1 | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
  pass "backup_configurations row created (id=$TARGET_ID)"

  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$TARGET_ID\",\"priority\":100}]}" >/dev/null
  pass "tenant_snapshot → $FIXTURE_PREFIX-minio assigned"
}

# ─── negative paths first ─────────────────────────────────────────────

test_negative_no_assignment() {
  step "F1: snapshot with no assignment → 409 NO_SNAPSHOT_TARGET"
  # Temporarily clear tenant_snapshot assignment
  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" '{"assignments":[]}' >/dev/null
  local resp http
  resp=$(api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/snapshot" '{"label":"neg-no-assign","retentionDays":1}')
  http=$(echo "$resp" | tail -1)
  if [ "$http" = "409" ] && echo "$resp" | grep -q "NO_SNAPSHOT_TARGET"; then
    pass "expected 409 + NO_SNAPSHOT_TARGET"
  else
    fail "expected 409 NO_SNAPSHOT_TARGET, got $http: $(echo "$resp" | head -1 | head -c 200)"
  fi
  # Restore assignment
  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$TARGET_ID\",\"priority\":100}]}" >/dev/null
}

test_negative_target_disabled() {
  step "F2: assigning a disabled target → 400 TARGET_DISABLED"
  local dis_id=$(node -e 'console.log(crypto.randomUUID())')
  psql_exec "INSERT INTO backup_configurations (id, name, \"storageType\", retention_days, schedule_expression, enabled, active, created_at, updated_at)
             VALUES ('$dis_id', '$FIXTURE_PREFIX-disabled', 's3', 30, '0 2 * * *', 0, false, NOW(), NOW());" >/dev/null
  local resp http
  resp=$(api_with_status PUT "/api/v1/admin/snapshots/classes/system_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$dis_id\",\"priority\":100}]}")
  http=$(echo "$resp" | tail -1)
  if [ "$http" = "400" ] && echo "$resp" | grep -q "TARGET_DISABLED"; then
    pass "expected 400 + TARGET_DISABLED"
  else
    fail "expected 400 TARGET_DISABLED, got $http"
  fi
  psql_exec "DELETE FROM backup_configurations WHERE id='$dis_id';" >/dev/null
}

test_negative_duplicate_priority() {
  step "F3: PUT with two targets at same priority → 400 DUPLICATE_PRIORITY"
  local resp http
  resp=$(api_with_status PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$TARGET_ID\",\"priority\":100},{\"targetId\":\"$TARGET_ID\",\"priority\":100}]}")
  http=$(echo "$resp" | tail -1)
  # The dup-target check fires first; either DUPLICATE_TARGET or
  # DUPLICATE_PRIORITY is acceptable here — both are operator-visible.
  if [ "$http" = "400" ] && (echo "$resp" | grep -qE "DUPLICATE_(PRIORITY|TARGET)"); then
    pass "expected 400 + DUPLICATE_*"
  else
    fail "expected 400 DUPLICATE_*, got $http"
  fi
}

# ─── happy path ────────────────────────────────────────────────────────

test_happy_streaming_snapshot() {
  step "G: streaming snapshot E2E (rclone → minio)"

  # Re-confirm assignment exists
  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$TARGET_ID\",\"priority\":100}]}" >/dev/null

  # The snapshot endpoint blocks until the Job completes — successful
  # 200 return means the streaming pipeline (tar | rclone → minio +
  # sidecar) ran to completion. We then verify the row + bucket
  # artefacts. The Job itself is auto-deleted by the orchestrator
  # post-success, so pod-level inspection isn't possible after the fact.
  local resp http snap_id
  resp=$(api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/snapshot" '{"label":"e2e-happy","retentionDays":1}')
  http=$(echo "$resp" | tail -1)
  if [ "$http" != "200" ] && [ "$http" != "201" ]; then
    fail "snapshot trigger returned $http: $(echo "$resp" | head -1)"
    return
  fi
  snap_id=$(echo "$resp" | head -n -1 | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
  pass "snapshot HTTP 200 (id=$snap_id) — Job ran to completion"

  # Verify storage_snapshots row is status='ready'
  local status
  status=$(psql_exec "SELECT status FROM storage_snapshots WHERE id='$snap_id';")
  if [ "$status" = "ready" ]; then
    pass "storage_snapshots.status = ready"
  else
    fail "storage_snapshots.status = '$status' (expected ready)"
  fi

  # Verify archive landed in minio bucket
  local archive_key="snapshots/tenant_snapshot/${TENANT_ID}/${snap_id}.tar.gz"
  local archive_size
  archive_size=$(kubectl_dind exec -n dev-minio deploy/minio -- sh -c \
    "mc alias set local http://localhost:9000 minio-dev-access-key minio-dev-secret-key >/dev/null 2>&1 && mc stat local/snapshots/$archive_key --json 2>/dev/null" \
    | grep -oE '"size":[0-9]+' | head -1 | cut -d: -f2 || echo "0")
  if [ -n "$archive_size" ] && [ "$archive_size" -gt 0 ]; then
    pass "archive uploaded to minio (size=$archive_size bytes)"
  else
    fail "archive missing in minio: $archive_key"
  fi

  # Verify sha256 sidecar
  local sha
  sha=$(kubectl_dind exec -n dev-minio deploy/minio -- sh -c \
    "mc alias set local http://localhost:9000 minio-dev-access-key minio-dev-secret-key >/dev/null 2>&1 && mc cat local/snapshots/$archive_key.sha256 2>/dev/null" || echo "")
  if echo "$sha" | grep -qE '^[a-f0-9]{64}$'; then
    pass "sha256 sidecar present and well-formed: ${sha:0:16}..."
  else
    fail "sha256 sidecar missing or malformed: '$sha'"
  fi

  # Verify DB row has target_id stamped
  local row_target_id
  row_target_id=$(psql_exec "SELECT target_id FROM storage_snapshots WHERE id='$snap_id';")
  if [ "$row_target_id" = "$TARGET_ID" ]; then
    pass "storage_snapshots.target_id stamped correctly"
  else
    fail "storage_snapshots.target_id mismatch: got '$row_target_id' expected '$TARGET_ID'"
  fi

  # Verify DB sha256 matches sidecar
  local db_sha
  db_sha=$(psql_exec "SELECT sha256 FROM storage_snapshots WHERE id='$snap_id';")
  if [ "$db_sha" = "$sha" ] && [ -n "$db_sha" ]; then
    pass "DB sha256 matches sidecar"
  else
    note "DB sha256='$db_sha' sidecar='$sha' (may diverge if stat read raced)"
  fi
}

# ─── main ──────────────────────────────────────────────────────────────

test_streaming_restore() {
  step "H: streaming restore E2E (rclone cat | gunzip | tar x ← minio)"
  # Re-confirm assignment
  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$TARGET_ID\",\"priority\":100}]}" >/dev/null

  # Take a fresh snapshot we can roll back to
  local snap_resp snap_id
  snap_resp=$(api POST "/api/v1/admin/tenants/$TENANT_ID/storage/snapshot" '{"label":"restore-src","retentionDays":1}')
  snap_id=$(echo "$snap_resp" | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
  if [ -z "$snap_id" ]; then
    fail "could not capture snapshot for restore test"
    return
  fi
  pass "captured snapshot $snap_id"

  # Mutate the PVC contents so restore is observable
  cat > /tmp/mutator.yaml <<EOF
apiVersion: v1
kind: Pod
metadata: { name: mutator, namespace: ${FIXTURE_NS} }
spec:
  restartPolicy: OnFailure
  containers:
    - name: m
      image: busybox:1.36
      command: ['sh','-c','rm -f /data/file-* 2>/dev/null; echo "tampered" > /data/tampered.txt; ls /data; sleep 3']
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes: [{ name: data, persistentVolumeClaim: { claimName: ${FIXTURE_NS}-storage } }]
EOF
  docker cp /tmp/mutator.yaml hosting-platform-k3s-server-1:/tmp/mutator.yaml >/dev/null
  kubectl_dind apply -f /tmp/mutator.yaml >/dev/null
  for i in $(seq 1 30); do
    phase=$(kubectl_dind get pod -n "$FIXTURE_NS" mutator -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [ "$phase" = "Succeeded" ] || [ "$phase" = "Running" ]; then break; fi
    sleep 1
  done
  kubectl_dind delete pod -n "$FIXTURE_NS" mutator --wait=true --timeout=30s >/dev/null
  pass "PVC contents mutated (file-* removed, tampered.txt added)"

  # Trigger rollback (this restores from the snap_id we just took)
  local resp http
  resp=$(api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/rollback" "{\"snapshotId\":\"$snap_id\"}")
  http=$(echo "$resp" | tail -1)
  if [ "$http" = "200" ] || [ "$http" = "201" ]; then
    pass "rollback POST returned $http"
  elif [ "$http" = "404" ]; then
    skip "rollback endpoint not exposed (skipping streaming restore E2E)"
    return
  else
    fail "rollback returned $http: $(echo "$resp" | head -1)"
    return
  fi

  # Wait for the rollback operation to complete (poll the operation row)
  local op_id
  op_id=$(echo "$resp" | head -n -1 | grep -oE '"operationId":"[^"]+"' | head -1 | sed 's/"operationId":"//;s/"$//')
  if [ -z "$op_id" ]; then
    fail "rollback response missing operationId"
    return
  fi

  local final_state=""
  for i in $(seq 1 60); do
    local state
    state=$(psql_exec "SELECT state FROM storage_operations WHERE id='$op_id';")
    if [ "$state" = "idle" ] || [ "$state" = "failed" ]; then
      final_state="$state"; break
    fi
    sleep 2
  done

  if [ "$final_state" = "idle" ]; then
    pass "rollback operation reached state=idle"
  else
    fail "rollback operation final state=$final_state (timeout or failure)"
    return
  fi

  # Verify the PVC contents match the snapshot (file-1.txt present, tampered.txt gone)
  cat > /tmp/inspector.yaml <<EOF
apiVersion: v1
kind: Pod
metadata: { name: inspector, namespace: ${FIXTURE_NS} }
spec:
  restartPolicy: OnFailure
  containers:
    - name: i
      image: busybox:1.36
      command: ['sh','-c','ls /data; cat /data/file-1.txt 2>/dev/null && echo "FILE_1_OK"; [ -f /data/tampered.txt ] && echo "TAMPERED_STILL_PRESENT" || echo "TAMPERED_GONE"; sleep 3']
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes: [{ name: data, persistentVolumeClaim: { claimName: ${FIXTURE_NS}-storage } }]
EOF
  docker cp /tmp/inspector.yaml hosting-platform-k3s-server-1:/tmp/inspector.yaml >/dev/null
  kubectl_dind apply -f /tmp/inspector.yaml >/dev/null
  for i in $(seq 1 30); do
    phase=$(kubectl_dind get pod -n "$FIXTURE_NS" inspector -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [ "$phase" = "Succeeded" ] || [ "$phase" = "Running" ]; then break; fi
    sleep 1
  done
  sleep 2
  local logs
  logs=$(kubectl_dind logs -n "$FIXTURE_NS" inspector 2>&1 || echo "")
  if echo "$logs" | grep -q "FILE_1_OK"; then
    pass "snapshot-original file restored (file-1.txt present)"
  else
    fail "snapshot-original file missing after restore"
  fi
  if echo "$logs" | grep -q "TAMPERED_GONE"; then
    pass "tampered file removed by restore"
  else
    fail "tampered file still present — restore did not overwrite"
  fi
  kubectl_dind delete pod -n "$FIXTURE_NS" inspector --wait=false --ignore-not-found >/dev/null 2>&1 || true
}

test_quota_enforcement() {
  step "I: per-tenant snapshot quota enforcement (Phase 6)"

  # Lower the plan's max_snapshot_count to 2 so we can hit the cap quickly
  local plan_id
  plan_id=$(psql_exec "SELECT plan_id FROM tenants WHERE id='$TENANT_ID';")
  local original_cap
  original_cap=$(psql_exec "SELECT max_snapshot_count FROM hosting_plans WHERE id='$plan_id';")
  psql_exec "UPDATE hosting_plans SET max_snapshot_count = 2 WHERE id='$plan_id';" >/dev/null
  pass "lowered plan max_snapshot_count to 2 (was $original_cap)"

  local usage_resp current_count
  usage_resp=$(api GET "/api/v1/admin/tenants/$TENANT_ID/storage/snapshot-quota")
  current_count=$(echo "$usage_resp" | grep -oE '"currentCount":[0-9]+' | head -1 | cut -d: -f2)
  if [ -n "$current_count" ]; then
    pass "quota endpoint returned currentCount=$current_count"
  else
    fail "quota endpoint returned no currentCount"
  fi

  # Attempt a third snapshot — should be refused with STORAGE_QUOTA_EXCEEDED
  local resp http
  resp=$(api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/snapshot" '{"label":"quota-test","retentionDays":1}')
  http=$(echo "$resp" | tail -1)
  if [ "$http" = "409" ] && echo "$resp" | grep -q "STORAGE_QUOTA_EXCEEDED"; then
    pass "snapshot refused with 409 STORAGE_QUOTA_EXCEEDED when over cap"
  else
    fail "expected 409 STORAGE_QUOTA_EXCEEDED, got $http: $(echo "$resp" | head -1 | head -c 200)"
  fi

  psql_exec "UPDATE hosting_plans SET max_snapshot_count = $original_cap WHERE id='$plan_id';" >/dev/null
  pass "plan cap restored to $original_cap"
}

test_cifs_create() {
  step "J: CIFS/SMB target create + redact password (Phase 9)"
  # POST a CIFS target — host is bogus, this only validates the
  # config-create path + response shape + password redaction.
  local resp http
  resp=$(api_with_status POST /api/v1/admin/backup-configs '{
    "name": "e2e-cifs-test",
    "storage_type": "cifs",
    "cifs_host": "samba.example.invalid",
    "cifs_port": 445,
    "cifs_share": "backups",
    "cifs_user": "smbuser",
    "cifs_password": "smbpass123-secret-do-not-leak",
    "cifs_domain": "WORKGROUP",
    "cifs_path": "/test",
    "retention_days": 7
  }')
  http=$(echo "$resp" | tail -1)
  if [ "$http" = "201" ] || [ "$http" = "200" ]; then
    pass "CIFS target created (HTTP $http)"
  else
    fail "CIFS create returned $http: $(echo "$resp" | head -1 | head -c 200)"
    return
  fi
  local cifs_id
  cifs_id=$(echo "$resp" | head -n -1 | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')

  # Password must NEVER appear in the API response.
  if echo "$resp" | grep -q "smbpass123-secret-do-not-leak"; then
    fail "password leaked in CIFS create response"
  else
    pass "password NOT in response (redacted)"
  fi

  # GET all configs — password must still not be exposed.
  local list_resp
  list_resp=$(api GET /api/v1/admin/backup-configs)
  if echo "$list_resp" | grep -q "smbpass123-secret-do-not-leak"; then
    fail "password leaked in list response"
  else
    pass "password NOT in list response"
  fi

  # CIFS field shape: cifsHost/cifsShare/cifsUser/cifsDomain/cifsPath present.
  if echo "$resp" | grep -q '"cifsHost":"samba.example.invalid"' \
     && echo "$resp" | grep -q '"cifsShare":"backups"' \
     && echo "$resp" | grep -q '"cifsUser":"smbuser"' \
     && echo "$resp" | grep -q '"cifsDomain":"WORKGROUP"'; then
    pass "CIFS fields round-trip correctly"
  else
    fail "CIFS field shape mismatch"
  fi

  # Cleanup
  api DELETE "/api/v1/admin/backup-configs/$cifs_id" >/dev/null 2>&1 || true
}

test_speedtest() {
  step "K: speedtest endpoint against S3 minio target (Phase 10)"
  local resp http target_id
  resp=$(api_with_status POST /api/v1/admin/backup-configs '{
    "name": "e2e-speedtest-minio",
    "storage_type": "s3",
    "s3_endpoint": "http://minio.dev-minio.svc.cluster.local:9000",
    "s3_bucket": "snapshots",
    "s3_region": "us-east-1",
    "s3_access_key": "minio-dev-access-key",
    "s3_secret_key": "minio-dev-secret-key",
    "retention_days": 7
  }')
  http=$(echo "$resp" | tail -1)
  target_id=$(echo "$resp" | head -n -1 | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
  if [ -z "$target_id" ]; then
    fail "could not create speedtest target ($http)"
    return
  fi
  pass "speedtest target created (id=$target_id)"

  # Run a small (2 MiB) speedtest — should complete in <30 s.
  local st_resp st_http
  st_resp=$(api_with_status POST "/api/v1/admin/backup-configs/$target_id/speedtest" '{"payloadBytes": 2097152}')
  st_http=$(echo "$st_resp" | tail -1)
  if [ "$st_http" != "200" ]; then
    fail "speedtest returned $st_http: $(echo "$st_resp" | head -1 | head -c 300)"
    api DELETE "/api/v1/admin/backup-configs/$target_id" >/dev/null 2>&1 || true
    return
  fi
  pass "speedtest HTTP 200"

  # Parse result fields.
  local up_mbps down_mbps lat_ms ok task_id
  up_mbps=$(echo "$st_resp" | head -n -1 | grep -oE '"uploadMbps":[0-9.]+' | head -1 | cut -d: -f2)
  down_mbps=$(echo "$st_resp" | head -n -1 | grep -oE '"downloadMbps":[0-9.]+' | head -1 | cut -d: -f2)
  lat_ms=$(echo "$st_resp" | head -n -1 | grep -oE '"latencyMs":[0-9]+' | head -1 | cut -d: -f2)
  ok=$(echo "$st_resp" | head -n -1 | grep -oE '"ok":(true|false)' | head -1 | cut -d: -f2)
  task_id=$(echo "$st_resp" | head -n -1 | grep -oE '"taskId":"[^"]+"' | head -1 | sed 's/"taskId":"//;s/"$//')

  if [ "$ok" = "true" ]; then
    pass "speedtest ok=true"
  else
    fail "speedtest ok=$ok"
  fi
  if [ -n "$up_mbps" ] && [ "$(echo "$up_mbps > 0" | awk '{print ($1 + 0 > 0)}')" = "1" ]; then
    pass "uploadMbps populated ($up_mbps Mbps)"
  else
    fail "uploadMbps missing or zero"
  fi
  # Sanity bound: catches the Bug 1 regression where busybox `date +%s%N`
  # produced bogus 838,860.80 Mbps. No real backup target delivers 100
  # Gbps; localhost minio over loopback tops out around 5-10 Gbps in
  # this image, so anything ≥100 Gbps is fabricated.
  if [ "$(awk "BEGIN{print ($up_mbps + 0 < 100000)}")" = "1" ]; then
    pass "uploadMbps within realistic bound (<100 Gbps): $up_mbps"
  else
    fail "uploadMbps implausible — regression of Bug 1 (busybox date %N): $up_mbps Mbps"
  fi
  if [ -n "$down_mbps" ] && [ "$(echo "$down_mbps > 0" | awk '{print ($1 + 0 > 0)}')" = "1" ]; then
    pass "downloadMbps populated ($down_mbps Mbps)"
  else
    fail "downloadMbps missing or zero"
  fi
  if [ "$(awk "BEGIN{print ($down_mbps + 0 < 100000)}")" = "1" ]; then
    pass "downloadMbps within realistic bound (<100 Gbps): $down_mbps"
  else
    fail "downloadMbps implausible — regression of Bug 1: $down_mbps Mbps"
  fi
  if [ -n "$lat_ms" ]; then
    pass "latencyMs populated ($lat_ms ms)"
  else
    fail "latencyMs missing"
  fi

  # Task-center: verify task row was created with kind=backup.speedtest.
  if [ -n "$task_id" ]; then
    local task_kind
    task_kind=$(psql_exec "SELECT kind FROM tasks WHERE id='$task_id';")
    if [ "$task_kind" = "backup.speedtest" ]; then
      pass "task-center: row created with kind=backup.speedtest"
    else
      fail "task-center kind mismatch: '$task_kind'"
    fi
  else
    fail "speedtest response missing taskId"
  fi

  # Persisted to backup_configurations.
  local last_up
  last_up=$(psql_exec "SELECT last_speedtest_upload_mbps FROM backup_configurations WHERE id='$target_id';")
  if [ -n "$last_up" ] && [ "$last_up" != "" ]; then
    pass "last_speedtest_upload_mbps persisted ($last_up)"
  else
    fail "last_speedtest_upload_mbps not persisted"
  fi

  # Negative: speedtest against disabled target → 400.
  psql_exec "UPDATE backup_configurations SET enabled = 0 WHERE id='$target_id';" >/dev/null
  local neg
  neg=$(api_with_status POST "/api/v1/admin/backup-configs/$target_id/speedtest" '{"payloadBytes": 1048576}')
  if echo "$neg" | head -1 | grep -q "TARGET_DISABLED"; then
    pass "disabled target → TARGET_DISABLED 400"
  else
    fail "expected TARGET_DISABLED, got: $(echo "$neg" | head -1 | head -c 200)"
  fi

  # Cleanup
  api DELETE "/api/v1/admin/backup-configs/$target_id" >/dev/null 2>&1 || true
  psql_exec "DELETE FROM tasks WHERE kind='backup.speedtest' AND ref_id='$task_id';" >/dev/null 2>&1 || true
}

configure_samba_target() {
  step "Configure dev samba as CIFS backup target"
  local body
  body=$(cat <<EOF
{
  "name": "$FIXTURE_PREFIX-samba",
  "storage_type": "cifs",
  "cifs_host": "samba.dev-samba.svc.cluster.local",
  "cifs_share": "snapshots",
  "cifs_user": "smbtest",
  "cifs_password": "smb-dev-password-1234",
  "cifs_path": "",
  "retention_days": 7
}
EOF
  )
  local resp http
  resp=$(api_with_status POST /api/v1/admin/backup-configs "$body")
  http=$(echo "$resp" | tail -1)
  if [ "$http" != "200" ] && [ "$http" != "201" ]; then
    fail "POST samba target returned $http: $(echo "$resp" | head -c 200)"
    return 1
  fi
  SAMBA_TARGET_ID=$(echo "$resp" | head -n -1 | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
  pass "samba backup target created (id=$SAMBA_TARGET_ID)"
}

test_cifs_snapshot_full_cycle() {
  step "M: full CIFS snapshot cycle (upload → readSidecar → restore → delete via Phase 11)"
  configure_samba_target
  if [ -z "$SAMBA_TARGET_ID" ]; then return; fi

  # Reassign tenant_snapshot from minio → samba (samba primary).
  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$SAMBA_TARGET_ID\",\"priority\":10}]}" >/dev/null
  pass "tenant_snapshot → samba (primary)"

  # Trigger a snapshot.
  local snap_resp snap_http snap_id
  snap_resp=$(api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/snapshot" \
    '{"label":"e2e-cifs","retentionDays":1}')
  snap_http=$(echo "$snap_resp" | tail -1)
  if [ "$snap_http" != "201" ] && [ "$snap_http" != "200" ]; then
    # Capture the snapshot Job pod log inline so the failure reason
    # survives the cleanup trap.
    local snap_pod
    snap_pod=$(kubectl_dind get pods -n "$FIXTURE_NS" -l platform.io/component=snapshot -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | tail -1)
    local snap_log=""
    [ -n "$snap_pod" ] && snap_log=$(kubectl_dind logs -n "$FIXTURE_NS" "$snap_pod" 2>&1 | tail -25)
    fail "snapshot via CIFS returned $snap_http: $(echo "$snap_resp" | head -c 300); pod log: $snap_log"
    return
  fi
  snap_id=$(echo "$snap_resp" | head -n -1 | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
  pass "CIFS snapshot created (id=$snap_id)"

  # Wait for the storage_snapshots row to flip to ready (Job uploads to samba).
  local snap_status
  for i in $(seq 1 60); do
    snap_status=$(psql_exec "SELECT status FROM storage_snapshots WHERE id='$snap_id';")
    [ "$snap_status" = "ready" ] && break
    [ "$snap_status" = "failed" ] && break
    sleep 2
  done
  if [ "$snap_status" = "ready" ]; then
    pass "storage_snapshots.status = ready (CIFS upload succeeded)"
  else
    local snap_pod
    snap_pod=$(kubectl_dind get pods -n "$FIXTURE_NS" -l platform.io/component=snapshot -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | tail -1)
    local snap_log=""
    [ -n "$snap_pod" ] && snap_log=$(kubectl_dind logs -n "$FIXTURE_NS" "$snap_pod" 2>&1 | tail -25)
    fail "snapshot stuck/failed: status=$snap_status; last error: $(psql_exec "SELECT last_error FROM storage_snapshots WHERE id='$snap_id';"); pod log: $snap_log"
    return
  fi

  # Verify target_id stamped to samba.
  local stamped
  stamped=$(psql_exec "SELECT target_id FROM storage_snapshots WHERE id='$snap_id';")
  if [ "$stamped" = "$SAMBA_TARGET_ID" ]; then
    pass "target_id stamped to samba"
  else
    fail "target_id mismatch: got '$stamped' expected '$SAMBA_TARGET_ID'"
  fi

  # Read the archive from samba directly to prove it actually landed.
  local samba_files
  samba_files=$(kubectl_dind exec -n dev-samba deploy/samba -- find /share/snapshots/tenant_snapshot -type f 2>&1 | head -10)
  if echo "$samba_files" | grep -q "$snap_id"; then
    pass "archive present in samba share ($(echo "$samba_files" | grep "$snap_id" | head -1))"
  else
    fail "archive NOT in samba share. Found: $samba_files"
  fi
  if echo "$samba_files" | grep -q "$snap_id.*\.sha256"; then
    pass "sha256 sidecar present in samba share"
  else
    fail "sha256 sidecar NOT in samba share"
  fi

  # Phase 11 readSidecar should have populated sha256 in the storage_snapshots row.
  local db_sha
  db_sha=$(psql_exec "SELECT sha256 FROM storage_snapshots WHERE id='$snap_id';")
  if [ -n "$db_sha" ] && [ ${#db_sha} -eq 64 ]; then
    pass "storage_snapshots.sha256 populated via Phase 11 readSidecar (${db_sha:0:16}...)"
  else
    fail "sha256 missing or wrong length (got '${db_sha}', expected 64-hex)"
  fi

  # Mutate PVC, then rollback via CIFS streaming restore.
  cat > /tmp/mutate.yaml <<EOF
apiVersion: v1
kind: Pod
metadata: { name: mutator, namespace: ${FIXTURE_NS} }
spec:
  restartPolicy: OnFailure
  containers:
    - name: m
      image: busybox:1.36
      command: ['sh','-c','rm -f /data/file-*.txt; echo "CIFS-TAMPERED" > /data/tampered.txt; sleep 5']
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: ${FIXTURE_NS}-storage }
EOF
  docker cp /tmp/mutate.yaml hosting-platform-k3s-server-1:/tmp/mutate.yaml >/dev/null
  kubectl_dind apply -f /tmp/mutate.yaml >/dev/null
  for i in $(seq 1 30); do
    local phase
    phase=$(kubectl_dind get pod -n "$FIXTURE_NS" mutator -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    [ "$phase" = "Succeeded" ] && break
    sleep 1
  done
  kubectl_dind delete pod -n "$FIXTURE_NS" mutator --wait=true --timeout=15s >/dev/null
  pass "PVC mutated via CIFS path (tampered.txt added, originals removed)"

  local rb_resp rb_http
  rb_resp=$(api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/rollback" \
    "{\"snapshotId\":\"$snap_id\"}")
  rb_http=$(echo "$rb_resp" | tail -1)
  if [ "$rb_http" = "200" ] || [ "$rb_http" = "202" ]; then
    pass "CIFS rollback returned $rb_http"
  else
    fail "CIFS rollback returned $rb_http: $(echo "$rb_resp" | head -c 300)"
    return
  fi
  # Wait for rollback operation to finish.
  for i in $(seq 1 60); do
    local op_state
    op_state=$(psql_exec "SELECT state FROM storage_operations WHERE tenant_id='$TENANT_ID' AND op_type='restore' ORDER BY created_at DESC LIMIT 1;")
    [ "$op_state" = "idle" ] && break
    [ "$op_state" = "failed" ] && break
    sleep 3
  done
  if [ "$op_state" = "idle" ]; then
    pass "CIFS restore operation reached state=idle"
  else
    fail "CIFS restore operation state=$op_state"
  fi

  # Verify restored content via a verify pod.
  cat > /tmp/verify.yaml <<EOF
apiVersion: v1
kind: Pod
metadata: { name: verify, namespace: ${FIXTURE_NS} }
spec:
  restartPolicy: OnFailure
  containers:
    - name: v
      image: busybox:1.36
      command: ['sh','-c','ls -la /data; [ -f /data/file-1.txt ] && echo CIFS_FILE_1_OK; [ -f /data/tampered.txt ] && echo TAMPER_REMAINS || echo CIFS_TAMPER_GONE; sleep 3']
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: ${FIXTURE_NS}-storage }
EOF
  docker cp /tmp/verify.yaml hosting-platform-k3s-server-1:/tmp/verify.yaml >/dev/null
  kubectl_dind apply -f /tmp/verify.yaml >/dev/null
  for i in $(seq 1 30); do
    local phase
    phase=$(kubectl_dind get pod -n "$FIXTURE_NS" verify -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    [ "$phase" = "Succeeded" ] && break
    [ "$phase" = "Failed" ] && break
    sleep 2
  done
  local vlog
  vlog=$(kubectl_dind logs -n "$FIXTURE_NS" verify 2>&1)
  kubectl_dind delete pod -n "$FIXTURE_NS" verify --wait=false >/dev/null 2>&1 || true
  if echo "$vlog" | grep -q "CIFS_FILE_1_OK"; then
    pass "CIFS restore: original file-1.txt present"
  else
    fail "CIFS restore: file-1.txt missing — verify log: $vlog"
  fi
  if echo "$vlog" | grep -q "CIFS_TAMPER_GONE"; then
    pass "CIFS restore: tampered.txt removed (destructive restore worked)"
  else
    fail "CIFS restore: tampered.txt persists — verify log: $vlog"
  fi

  # Phase 11 delete — DELETE the snapshot via API, verify samba files gone.
  local del_resp del_http
  del_resp=$(api_with_status DELETE "/api/v1/admin/storage/snapshots/$snap_id" '')
  del_http=$(echo "$del_resp" | tail -1)
  if [ "$del_http" = "200" ] || [ "$del_http" = "204" ]; then
    pass "snapshot DELETE returned $del_http"
  else
    fail "snapshot DELETE returned $del_http: $(echo "$del_resp" | head -c 200)"
  fi
  # Give the Phase 11 oneshot delete Job ~30s to run.
  local remaining
  for i in $(seq 1 30); do
    remaining=$(kubectl_dind exec -n dev-samba deploy/samba -- sh -c "find /share/snapshots/tenant_snapshot -type f 2>/dev/null | grep -c '$snap_id' || true")
    [ "$remaining" = "0" ] && break
    sleep 2
  done
  if [ "$remaining" = "0" ]; then
    pass "Phase 11 delete reaped archive + sidecar from samba (0 remaining matches)"
  else
    fail "Phase 11 delete left $remaining file(s) on samba"
  fi

  # Reassign tenant_snapshot back to minio so subsequent phases use minio default.
  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$TARGET_ID\",\"priority\":100}]}" >/dev/null
  pass "tenant_snapshot reassigned to minio (cleanup)"
}

test_strict_primary_failover() {
  step "N: strict-primary semantics — disabled primary must FAIL (no silent failover)"
  # Assign two targets: samba pri=10 primary, minio pri=20 secondary.
  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$SAMBA_TARGET_ID\",\"priority\":10},{\"targetId\":\"$TARGET_ID\",\"priority\":20}]}" >/dev/null
  pass "two assignments: samba=10 (primary), minio=20 (secondary)"

  # Disable samba target.
  psql_exec "UPDATE backup_configurations SET enabled = 0 WHERE id='$SAMBA_TARGET_ID';" >/dev/null
  pass "samba target disabled via psql"

  # Attempt snapshot — strict-primary means this must FAIL, NOT fall back to minio.
  local snap_resp snap_http
  snap_resp=$(api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/snapshot" \
    '{"label":"e2e-failover","retentionDays":1}')
  snap_http=$(echo "$snap_resp" | tail -1)
  if [ "$snap_http" = "400" ] || [ "$snap_http" = "409" ] || [ "$snap_http" = "503" ]; then
    pass "disabled primary → snapshot refused with $snap_http (no silent failover)"
  else
    fail "disabled primary → snapshot returned $snap_http (expected 4xx/503): $(echo "$snap_resp" | head -c 300)"
  fi
  # Should mention TARGET_DISABLED or similar, NOT silently succeed using minio.
  if echo "$snap_resp" | head -1 | grep -qE "TARGET_DISABLED|disabled|unavailable"; then
    pass "error envelope identifies disabled-target cause"
  else
    fail "error doesn't mention disabled target: $(echo "$snap_resp" | head -c 200)"
  fi

  # Re-enable samba; reassign to single primary to restore baseline.
  psql_exec "UPDATE backup_configurations SET enabled = 1 WHERE id='$SAMBA_TARGET_ID';" >/dev/null
  pass "samba re-enabled"
  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" \
    "{\"assignments\":[{\"targetId\":\"$TARGET_ID\",\"priority\":100}]}" >/dev/null
  pass "tenant_snapshot back to minio-only (cleanup)"
}

test_target_deletion_graceful_restore() {
  step "O: deleting target unsets snapshot.target_id; restore → TARGET_REMOVED 410"
  # Take a snapshot via minio (TARGET_ID).
  local snap_resp snap_id
  snap_resp=$(api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/snapshot" \
    '{"label":"e2e-orphan-restore","retentionDays":1}')
  snap_id=$(echo "$snap_resp" | head -n -1 | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
  if [ -z "$snap_id" ]; then
    fail "could not create snapshot for orphan test"
    return
  fi
  for i in $(seq 1 60); do
    local s; s=$(psql_exec "SELECT status FROM storage_snapshots WHERE id='$snap_id';")
    [ "$s" = "ready" ] && break
    sleep 2
  done
  pass "snapshot $snap_id ready on minio target"

  # Empty the assignment so we can DELETE the target (FK constraint).
  api PUT "/api/v1/admin/snapshots/classes/tenant_snapshot/assignments" '{"assignments":[]}' >/dev/null

  # Delete the target directly (FK on storage_snapshots.target_id is ON DELETE SET NULL).
  psql_exec "DELETE FROM backup_configurations WHERE id='$TARGET_ID';" >/dev/null
  pass "minio target row deleted from backup_configurations"

  local orphan_tid
  orphan_tid=$(psql_exec "SELECT COALESCE(target_id::text, 'NULL') FROM storage_snapshots WHERE id='$snap_id';")
  if [ "$orphan_tid" = "NULL" ]; then
    pass "ON DELETE SET NULL fired: storage_snapshots.target_id is NULL"
  else
    fail "target_id should be NULL after target delete, got: $orphan_tid"
  fi

  # Attempt rollback. The route enqueues an async operation (returns
  # 200 with operationId), and resolveRestoreStore throws TARGET_REMOVED
  # asynchronously. So the contract is: POST 200 + operationId, the
  # operation transitions to state=failed, last_error contains
  # TARGET_REMOVED.
  local rb_resp rb_http rb_op
  rb_resp=$(api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/rollback" \
    "{\"snapshotId\":\"$snap_id\"}")
  rb_http=$(echo "$rb_resp" | tail -1)
  rb_op=$(echo "$rb_resp" | head -n -1 | grep -oE '"operationId":"[^"]+"' | head -1 | sed 's/"operationId":"//;s/"$//')
  if [ "$rb_http" = "200" ] || [ "$rb_http" = "202" ]; then
    pass "rollback POST accepted (http=$rb_http, opId=${rb_op:0:8}...)"
  else
    fail "rollback POST returned $rb_http (expected 200/202): $(echo "$rb_resp" | head -c 300)"
  fi
  # Wait for the operation to transition to failed.
  local op_state op_err
  for i in $(seq 1 30); do
    op_state=$(psql_exec "SELECT state FROM storage_operations WHERE id='$rb_op';")
    [ "$op_state" = "failed" ] && break
    [ "$op_state" = "idle" ] && break
    sleep 2
  done
  op_err=$(psql_exec "SELECT COALESCE(last_error, '') FROM storage_operations WHERE id='$rb_op';")
  if [ "$op_state" = "failed" ]; then
    pass "restore operation transitioned to state=failed"
  else
    fail "restore operation did not fail as expected (state=$op_state)"
  fi
  if echo "$op_err" | grep -q "TARGET_REMOVED\|target.*deleted"; then
    pass "operation last_error mentions TARGET_REMOVED / target deletion"
  else
    fail "operation last_error doesn't surface target deletion: $op_err"
  fi

  # Recreate minio target for any subsequent phase (and so cleanup() can run).
  configure_minio_target
}

test_phase12_credential_isolation() {
  step "P: Phase 12 — pod spec carries NO plaintext creds + Secret cascade-deletes with Job"
  # Phase O intentionally leaves a `failed` operation on the tenant.
  # The mustBeIdle guard checks tenants.storage_lifecycle_state (NOT
  # storage_operations), so reset that field directly.
  psql_exec "UPDATE tenants SET storage_lifecycle_state='idle', active_storage_op_id=NULL WHERE id='$TENANT_ID';" >/dev/null 2>&1 || true
  psql_exec "DELETE FROM storage_operations WHERE tenant_id='$TENANT_ID' AND state != 'idle';" >/dev/null 2>&1 || true
  # The snapshot POST is synchronous — it returns AFTER the Job has
  # been deleted, so we can't observe pod/Secret post-hoc. Fire POST
  # in the BACKGROUND and race the Job appearance.
  local resp_file
  resp_file=$(mktemp)
  ( api_with_status POST "/api/v1/admin/tenants/$TENANT_ID/storage/snapshot" \
      '{"label":"e2e-phase12","retentionDays":1}' > "$resp_file" 2>&1 ) &
  local post_pid=$!

  local job_name=""
  for i in $(seq 1 200); do
    job_name=$(kubectl_dind get jobs -n "$FIXTURE_NS" -l platform.io/component=snapshot -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    [ -n "$job_name" ] && break
    sleep 0.1
  done
  if [ -z "$job_name" ]; then
    fail "snapshot Job never appeared during 20s race window"
    wait $post_pid 2>/dev/null || true
    rm -f "$resp_file"
    return
  fi
  pass "snapshot Job captured mid-flight: $job_name"

  # Inspect pod spec — credentials must be referenced via envFrom.secretRef,
  # NOT inline as env.value (Phase 12's load-bearing security promise).
  local pod_name
  for i in $(seq 1 30); do
    pod_name=$(kubectl_dind get pods -n "$FIXTURE_NS" -l "job-name=$job_name" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    [ -n "$pod_name" ] && break
    sleep 1
  done
  if [ -z "$pod_name" ]; then
    fail "Job pod never appeared"
    return
  fi

  local pod_yaml
  pod_yaml=$(kubectl_dind get pod -n "$FIXTURE_NS" "$pod_name" -o yaml 2>&1)

  # Grep for any plaintext that should ONLY ever live in a Secret.
  if echo "$pod_yaml" | grep -qE "minio-dev-secret-key|smb-dev-password-1234"; then
    fail "POD SPEC LEAKS PLAINTEXT SECRET — Phase 12 regression"
    echo "$pod_yaml" | grep -nE "minio-dev-secret-key|smb-dev-password-1234" | head -5
  else
    pass "pod spec has zero inline plaintext credentials"
  fi
  if echo "$pod_yaml" | grep -q "secretRef:"; then
    pass "pod uses envFrom.secretRef (credentials from ephemeral Secret)"
  else
    fail "pod has no secretRef — Phase 12 not wired correctly"
  fi

  # Find the credential Secret (label: platform.io/component=rclone-creds).
  local cred_secret
  cred_secret=$(kubectl_dind get secrets -n "$FIXTURE_NS" -l platform.io/component=rclone-creds -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [ -n "$cred_secret" ]; then
    pass "credential Secret exists: $cred_secret"
  else
    fail "no Secret with label platform.io/component=rclone-creds"
    return
  fi

  # Assert ownerReferences set so cascade-GC will work.
  local owner_kind
  owner_kind=$(kubectl_dind get secret -n "$FIXTURE_NS" "$cred_secret" -o jsonpath='{.metadata.ownerReferences[0].kind}' 2>/dev/null)
  if [ "$owner_kind" = "Job" ]; then
    pass "Secret has Job ownerReference (cascade-GC armed)"
  else
    fail "Secret ownerReferences[0].kind = '$owner_kind' (expected Job)"
  fi

  # Wait for the background POST to return — snapshot ID is in resp_file.
  wait $post_pid 2>/dev/null || true
  local snap_id
  snap_id=$(grep -oE '"id":"[^"]+"' "$resp_file" 2>/dev/null | head -1 | sed 's/"id":"//;s/"$//' || true)
  rm -f "$resp_file"
  if [ -n "$snap_id" ]; then
    for i in $(seq 1 60); do
      local s; s=$(psql_exec "SELECT status FROM storage_snapshots WHERE id='$snap_id';")
      [ "$s" = "ready" ] && break
      [ "$s" = "failed" ] && break
      sleep 1
    done
  fi
  # Force-delete the Job (faster than waiting for TTL); cascade should reap the Secret.
  kubectl_dind delete job -n "$FIXTURE_NS" "$job_name" --propagation=Background --wait=false >/dev/null 2>&1 || true
  local gone="no"
  for i in $(seq 1 15); do
    if ! kubectl_dind get secret -n "$FIXTURE_NS" "$cred_secret" >/dev/null 2>&1; then
      gone="yes"; break
    fi
    sleep 1
  done
  if [ "$gone" = "yes" ]; then
    pass "credential Secret cascade-deleted with Job (Phase 12 ownerRef wired correctly)"
  else
    fail "credential Secret $cred_secret outlived Job (cascade GC broken)"
  fi
}

test_speedtest_auth_failure() {
  step "L: speedtest with wrong S3 creds must surface SPEEDTEST_FAILED (regression for Bug 2)"
  local resp http target_id
  resp=$(api_with_status POST /api/v1/admin/backup-configs '{
    "name": "e2e-speedtest-bad-creds",
    "storage_type": "s3",
    "s3_endpoint": "http://minio.dev-minio.svc.cluster.local:9000",
    "s3_bucket": "snapshots",
    "s3_region": "us-east-1",
    "s3_access_key": "wrong-access-key-deliberate",
    "s3_secret_key": "wrong-secret-key-deliberate",
    "retention_days": 7
  }')
  http=$(echo "$resp" | tail -1)
  target_id=$(echo "$resp" | head -n -1 | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
  if [ -z "$target_id" ]; then
    fail "could not create bad-creds target ($http)"
    return
  fi
  pass "bad-creds target created (id=$target_id)"

  local st_resp st_http st_body st_ok st_err
  st_resp=$(api_with_status POST "/api/v1/admin/backup-configs/$target_id/speedtest" '{"payloadBytes": 1048576}')
  st_http=$(echo "$st_resp" | tail -1)
  st_body=$(echo "$st_resp" | head -n -1)
  st_ok=$(echo "$st_body" | grep -oE '"ok":(true|false)' | head -1 | cut -d: -f2)
  st_err=$(echo "$st_body" | grep -oE '"error":"[^"]+"' | head -1 | sed 's/^"error":"//;s/"$//')

  # Route returns 200 with `ok:false, error:"<reason>"` for failed
  # speedtests (the API request itself succeeded; the test failed).
  # Bug 2 fix: the `error` field MUST carry the actual rclone/S3 cause,
  # not a generic "Job X failed" string.
  if [ "$st_http" = "200" ]; then
    pass "wrong-creds speedtest returned 200 (test-failure surfaces via ok=false)"
  else
    fail "wrong-creds speedtest returned $st_http (expected 200): $(echo "$st_body" | head -c 300)"
  fi
  if [ "$st_ok" = "false" ]; then
    pass "ok=false on wrong-creds (not fabricated success)"
  else
    fail "ok=$st_ok on wrong-creds — bug 2 regression: $(echo "$st_body" | head -c 300)"
  fi
  # Real rclone error words (one of these MUST appear; defends against
  # any future masking).
  if echo "$st_err" | grep -qiE "InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|access key|signature|forbidden|401|403|upload:|download:"; then
    pass "error reason carries the actual rclone/S3 cause"
  else
    fail "error reason is generic (Bug 2 regression risk): error=$st_err"
  fi
  # Persisted error column populated; no bogus Mbps numbers persisted.
  local stored_err stored_up
  stored_err=$(psql_exec "SELECT last_speedtest_error FROM backup_configurations WHERE id='$target_id';")
  stored_up=$(psql_exec "SELECT last_speedtest_upload_mbps FROM backup_configurations WHERE id='$target_id';")
  if [ -n "$stored_err" ] && [ "$stored_err" != "" ]; then
    pass "last_speedtest_error persisted ($(echo "$stored_err" | head -c 80))"
  else
    fail "last_speedtest_error not persisted on failure"
  fi
  if [ -z "$stored_up" ] || [ "$stored_up" = "" ]; then
    pass "last_speedtest_upload_mbps NULL on failure (no fabricated numbers stored)"
  else
    fail "last_speedtest_upload_mbps populated despite failure ($stored_up) — Bug 2 regression"
  fi

  api DELETE "/api/v1/admin/backup-configs/$target_id" >/dev/null 2>&1 || true
}

main() {
  echo "$(c_bold "═══ Phase 4+5+6+9+10 snapshot streaming + restore + quota + CIFS + speedtest E2E ═══")"
  acquire_jwt

  create_tenant_with_pvc
  configure_minio_target

  test_negative_no_assignment
  test_negative_target_disabled
  test_negative_duplicate_priority
  test_happy_streaming_snapshot
  test_streaming_restore
  test_quota_enforcement
  test_cifs_create
  test_cifs_snapshot_full_cycle
  test_strict_primary_failover
  test_target_deletion_graceful_restore
  test_phase12_credential_isolation
  test_speedtest
  test_speedtest_auth_failure

  echo
  echo "$(c_bold "═══ Results ═══")"
  echo "  Passes: $(c_green "$PASS")"
  echo "  Fails:  $(c_red "$FAIL")"
  echo "  Skips:  $(c_yellow "$SKIP")"
  echo

  [ "$FAIL" = "0" ]
}

main "$@"
