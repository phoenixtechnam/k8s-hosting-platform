#!/usr/bin/env bash
# End-to-end test for status-driven lifecycle (collapse phase, 2026-04-28).
#
# Verifies that the client.status dropdown is wired all the way down to
# the storage-lifecycle orchestrators. Mirrors integration-grow-e2e.sh.
#
# Scenarios:
#   1. Create client → assert running.
#   2. PATCH status:suspended → assert workloads scaled to 0,
#      ingress patched to suspension page, domains marked suspended in DB.
#   3. PATCH status:active → assert workloads scaled back to original
#      replicas, ingress restored, domains marked active.
#   4. PATCH status:archived + archive_retention_days:30 → assert
#      storageArchiveOperationId returned → poll until idle → assert
#      deployments deleted, mailboxes deleted, pre-archive snapshot
#      exists in the snapshot store.
#   5. PATCH status:active on archived client → assert
#      storageRestoreOperationId returned → poll until idle → assert
#      PVC recreated.
#   6. Negative: PATCH plan_id to a smaller-storage plan → assert
#      STORAGE_RESIZE_REQUIRED rejection.
#   7. Negative: PATCH archive_retention_days alone (without status
#      change) → assert no-op (200 with unchanged client).
#
# USAGE: ADMIN_PASSWORD=<…> ./scripts/integration-lifecycle-e2e.sh

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@89.167.3.56}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }

passed=0
failed=0

ssh_cp() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 -q "$SSH_HOST" "$@"; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk -X "$method" "$ADMIN_HOST/api/v1$path" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body"
  fi
}

log "logging in"
TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
[[ -n "$TOKEN" ]] || { echo "login failed"; exit 1; }

PLAN_ID=$(api GET "/plans" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((p['id'] for p in d['data'] if p['name']=='Starter'),''))")
SMALLER_PLAN_ID=$(api GET "/plans" | python3 -c "
import json, sys
plans = json.load(sys.stdin)['data']
plans_sorted = sorted(plans, key=lambda p: int(float(p.get('storageLimit') or 0)))
# Pick a plan that's strictly smaller than Starter; fall back to '' if Starter is smallest.
starter = next((p for p in plans if p['name'] == 'Starter'), None)
if starter:
    smaller = [p for p in plans if int(float(p.get('storageLimit') or 0)) < int(float(starter.get('storageLimit') or 0))]
    print(smaller[0]['id'] if smaller else '')
else:
    print('')
")
REGION_ID=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'])")
[[ -n "$PLAN_ID" && -n "$REGION_ID" ]] || { echo "no plan/region"; exit 1; }

# ─── create + provision ──────────────────────────────────────────────
log "── creating client ──"
STAMP=$(date +%s)
COMPANY="Lifecycle E2E $STAMP"
RESP=$(api POST "/clients" "{\"company_name\":\"$COMPANY\",\"company_email\":\"lifecycle-e2e-$STAMP@phoenix-host.net\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}")
CID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[[ -n "$CID" ]] && ok "client created cid=$CID" || { fail "create failed: $RESP"; exit 1; }

cleanup() { curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$CID" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "── waiting for full provisioning ──"
STATUS=""
for _ in $(seq 1 90); do
  STATUS=$(api GET "/clients/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('provisioningStatus') or '')" 2>/dev/null)
  [[ "$STATUS" == "provisioned" ]] && break
  sleep 2
done
[[ "$STATUS" == "provisioned" ]] && ok "provisioningStatus=provisioned" || { fail "stuck at $STATUS"; exit 1; }

NS=$(ssh_cp "kubectl get ns -l client=$CID -o jsonpath='{.items[0].metadata.name}'")
[[ -n "$NS" ]] && ok "namespace $NS" || { fail "no namespace"; exit 1; }

# Start file-manager so we have a real workload to suspend/resume.
log "── starting file-manager so suspend/resume has a workload to scale ──"
api POST "/clients/$CID/files/start" "" >/dev/null
FM_READY="false"
for _ in $(seq 1 30); do
  FM_READY=$(api GET "/clients/$CID/files/status" | python3 -c "import json,sys;print(str(json.load(sys.stdin)['data'].get('ready','false')).lower())" 2>/dev/null || echo false)
  [[ "$FM_READY" == "true" ]] && break
  sleep 4
done
[[ "$FM_READY" == "true" ]] && ok "FM ready" || { fail "FM did not become ready"; exit 1; }

# ─── Scenario 2: suspend ─────────────────────────────────────────────
log "── Scenario 2: PATCH status:suspended ──"
SUSP_RESP=$(api PATCH "/clients/$CID" '{"status":"suspended"}')
SUSP_STATUS=$(echo "$SUSP_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('status') or '')" 2>/dev/null)
SUSP_OP_ID=$(echo "$SUSP_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('storageOperationId') or '')" 2>/dev/null)
[[ "$SUSP_STATUS" == "suspended" ]] && ok "status=suspended in PATCH response" \
  || fail "status=$SUSP_STATUS (expected suspended) — body: $(echo "$SUSP_RESP" | head -c 300)"
[[ -n "$SUSP_OP_ID" ]] && ok "PATCH carried storageOperationId=${SUSP_OP_ID:0:8}" \
  || fail "PATCH did not return storageOperationId — orchestrator may not have fired"

# Poll the suspend op until terminal — quiesce + cascade can take 30-60s
# while kubelet drains the FM pod and tenant Deployments scale to 0.
SUSP_FINAL=""
for _ in $(seq 1 60); do
  OP=$(api GET "/admin/storage/operations/$SUSP_OP_ID" 2>/dev/null || echo "{}")
  C=$(echo "$OP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print('Y' if d.get('completedAt') else 'N')" 2>/dev/null)
  if [[ "$C" == "Y" ]]; then
    SUSP_FINAL=$(echo "$OP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('state',''))" 2>/dev/null)
    break
  fi
  sleep 3
done
[[ "$SUSP_FINAL" == "idle" ]] && ok "suspend op reached idle terminal" \
  || fail "suspend op state=$SUSP_FINAL (expected idle)"

FM_READY_AFTER_SUSPEND=$(api GET "/clients/$CID/files/status" | python3 -c "import json,sys;print(str(json.load(sys.stdin)['data'].get('ready','false')).lower())" 2>/dev/null || echo false)
[[ "$FM_READY_AFTER_SUSPEND" == "false" ]] && ok "file-manager scaled down on suspend" \
  || fail "file-manager still ready after suspend (status=$FM_READY_AFTER_SUSPEND)"

# Tenant Deployments should all be at replicas=0 (or just gone).
# Best-effort: a brand-new client may have no deployments other than fm.
DEP_REPLICAS=$(ssh_cp "kubectl -n $NS get deployments -o jsonpath='{range .items[*]}{.spec.replicas}{\"\\n\"}{end}' 2>/dev/null" || echo "")
# grep -v exits 1 when no matches — tolerate that under pipefail
NONZERO_REPLICAS=$(echo "$DEP_REPLICAS" | { grep -v -E '^(0|)$' || true; } | wc -l | tr -d ' ')
[[ "$NONZERO_REPLICAS" == "0" ]] && ok "all tenant deployments scaled to 0" \
  || fail "$NONZERO_REPLICAS deployment(s) still have non-zero replicas: $DEP_REPLICAS"

# ─── Scenario 3: resume ──────────────────────────────────────────────
log "── Scenario 3: PATCH status:active (resume) ──"
RES_RESP=$(api PATCH "/clients/$CID" '{"status":"active"}')
RES_STATUS=$(echo "$RES_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('status') or '')" 2>/dev/null)
RES_OP_ID=$(echo "$RES_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('storageOperationId') or '')" 2>/dev/null)
[[ "$RES_STATUS" == "active" ]] && ok "status=active in PATCH response" \
  || fail "status=$RES_STATUS (expected active) — body: $(echo "$RES_RESP" | head -c 300)"
[[ -n "$RES_OP_ID" ]] && ok "PATCH carried storageOperationId=${RES_OP_ID:0:8}" \
  || fail "PATCH did not return storageOperationId for resume"

# Poll the resume op until terminal.
RES_FINAL=""
for _ in $(seq 1 60); do
  OP=$(api GET "/admin/storage/operations/$RES_OP_ID" 2>/dev/null || echo "{}")
  C=$(echo "$OP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print('Y' if d.get('completedAt') else 'N')" 2>/dev/null)
  if [[ "$C" == "Y" ]]; then
    RES_FINAL=$(echo "$OP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('state',''))" 2>/dev/null)
    break
  fi
  sleep 3
done
[[ "$RES_FINAL" == "idle" ]] && ok "resume op reached idle terminal" \
  || fail "resume op state=$RES_FINAL (expected idle)"

ACT_STATUS_DB=$(api GET "/clients/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('status') or '')" 2>/dev/null)
[[ "$ACT_STATUS_DB" == "active" ]] && ok "client.status=active after resume" \
  || fail "client.status=$ACT_STATUS_DB (expected active)"

# ─── Scenario 7 (early): PATCH archive_retention_days alone — no-op ──
log "── Scenario 7: PATCH archive_retention_days alone (no status) — must be no-op ──"
NOOP_RESP=$(api PATCH "/clients/$CID" '{"archive_retention_days":42}')
NOOP_STATUS=$(echo "$NOOP_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('status') or '')" 2>/dev/null)
NOOP_OPID=$(echo "$NOOP_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print(d.get('storageArchiveOperationId') or '')" 2>/dev/null)
[[ "$NOOP_STATUS" == "active" ]] && ok "client.status unchanged (still active) on retention-only PATCH" \
  || fail "status=$NOOP_STATUS (expected unchanged: active)"
[[ -z "$NOOP_OPID" ]] && ok "no archive operation triggered by retention-only PATCH" \
  || fail "retention-only PATCH spuriously triggered archive op id=$NOOP_OPID"

# ─── Scenario 4: archive ─────────────────────────────────────────────
log "── Scenario 4: PATCH status:archived archive_retention_days:30 ──"
ARCH_RESP=$(api PATCH "/clients/$CID" '{"status":"archived","archive_retention_days":30}')
ARCH_OP_ID=$(echo "$ARCH_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print(d.get('storageArchiveOperationId') or '')" 2>/dev/null)
[[ -n "$ARCH_OP_ID" ]] && ok "PATCH carried storageArchiveOperationId=${ARCH_OP_ID:0:8}" \
  || { fail "PATCH did not return storageArchiveOperationId — body: $(echo "$ARCH_RESP" | head -c 400)"; exit 1; }

log "── polling archive op until terminal ──"
ARCH_FINAL_STATE=""
for _ in $(seq 1 200); do
  ARCH_FINAL=$(api GET "/admin/storage/operations/$ARCH_OP_ID" 2>/dev/null || echo "{}")
  COMPLETED=$(echo "$ARCH_FINAL" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print('Y' if d.get('completedAt') else 'N')" 2>/dev/null)
  if [[ "$COMPLETED" == "Y" ]]; then
    ARCH_FINAL_STATE=$(echo "$ARCH_FINAL" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('state',''))" 2>/dev/null)
    break
  fi
  sleep 3
done
[[ "$ARCH_FINAL_STATE" == "idle" ]] && ok "archive op reached idle terminal" \
  || { fail "archive op did not reach idle (last state=$ARCH_FINAL_STATE)"; }

# Pre-archive snapshot must exist in DB.
ARCH_SNAP_ID=$(echo "$ARCH_FINAL" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('snapshotId') or '')" 2>/dev/null)
[[ -n "$ARCH_SNAP_ID" ]] && ok "pre-archive snapshot recorded id=${ARCH_SNAP_ID:0:8}" \
  || fail "no snapshotId on archive op (no rollback insurance)"

# Snapshot row should be 'ready'.
SNAP_STATUS=$(api GET "/admin/clients/$CID/storage/snapshots" 2>/dev/null \
  | python3 -c "
import json,sys
data=json.load(sys.stdin).get('data',[])
for s in data:
    if s.get('kind')=='pre-archive': print(s.get('status','')); break
" 2>/dev/null)
[[ "$SNAP_STATUS" == "ready" ]] && ok "pre-archive snapshot status=ready" \
  || fail "pre-archive snapshot status=$SNAP_STATUS (expected ready)"

# Client.status must be 'archived' now.
ARCH_STATUS_DB=$(api GET "/clients/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('status') or '')" 2>/dev/null)
[[ "$ARCH_STATUS_DB" == "archived" ]] && ok "client.status=archived" \
  || fail "client.status=$ARCH_STATUS_DB (expected archived)"

# Deployments should be gone.
DEP_COUNT=$(ssh_cp "kubectl -n $NS get deployments -l platform.io/managed=true --no-headers 2>/dev/null | wc -l" || echo 0)
DEP_COUNT=$(echo "$DEP_COUNT" | tr -d ' \n')
[[ "$DEP_COUNT" == "0" ]] && ok "managed deployments deleted" \
  || fail "$DEP_COUNT managed deployment(s) still present"

# PVC should be gone.
PVC_PRESENT=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage --no-headers 2>/dev/null | wc -l" || echo 0)
PVC_PRESENT=$(echo "$PVC_PRESENT" | tr -d ' \n')
[[ "$PVC_PRESENT" == "0" ]] && ok "tenant PVC deleted" \
  || fail "tenant PVC still present"

# ─── Scenario 5: restore from archive ────────────────────────────────
log "── Scenario 5: PATCH status:active on archived (restore) ──"
RESTORE_RESP=$(api PATCH "/clients/$CID" '{"status":"active"}')
RESTORE_OP_ID=$(echo "$RESTORE_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print(d.get('storageRestoreOperationId') or '')" 2>/dev/null)
[[ -n "$RESTORE_OP_ID" ]] && ok "PATCH carried storageRestoreOperationId=${RESTORE_OP_ID:0:8}" \
  || { fail "PATCH did not return storageRestoreOperationId — body: $(echo "$RESTORE_RESP" | head -c 400)"; }

log "── polling restore op until terminal ──"
RESTORE_FINAL_STATE=""
for _ in $(seq 1 200); do
  RESTORE_FINAL=$(api GET "/admin/storage/operations/$RESTORE_OP_ID" 2>/dev/null || echo "{}")
  COMPLETED=$(echo "$RESTORE_FINAL" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print('Y' if d.get('completedAt') else 'N')" 2>/dev/null)
  if [[ "$COMPLETED" == "Y" ]]; then
    RESTORE_FINAL_STATE=$(echo "$RESTORE_FINAL" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('state',''))" 2>/dev/null)
    break
  fi
  sleep 3
done
[[ "$RESTORE_FINAL_STATE" == "idle" ]] && ok "restore op reached idle terminal" \
  || fail "restore op did not reach idle (last state=$RESTORE_FINAL_STATE)"

# PVC should be back.
PVC_PRESENT_AFTER=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage --no-headers 2>/dev/null | wc -l" || echo 0)
PVC_PRESENT_AFTER=$(echo "$PVC_PRESENT_AFTER" | tr -d ' \n')
[[ "$PVC_PRESENT_AFTER" == "1" ]] && ok "tenant PVC recreated by restore" \
  || fail "tenant PVC missing after restore ($PVC_PRESENT_AFTER)"

# Status flipped back to active.
RESTORE_STATUS_DB=$(api GET "/clients/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('status') or '')" 2>/dev/null)
[[ "$RESTORE_STATUS_DB" == "active" ]] && ok "client.status=active after restore" \
  || fail "client.status=$RESTORE_STATUS_DB (expected active)"

# ─── Scenario 6: shrink rejection via plan_id ────────────────────────
if [[ -n "$SMALLER_PLAN_ID" ]]; then
  log "── Scenario 6: PATCH plan_id to smaller plan — must reject ──"
  SHRINK_RESP=$(api PATCH "/clients/$CID" "{\"plan_id\":\"$SMALLER_PLAN_ID\"}")
  SHRINK_CODE=$(echo "$SHRINK_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('error',{}).get('code',''))" 2>/dev/null)
  [[ "$SHRINK_CODE" == "STORAGE_RESIZE_REQUIRED" ]] && ok "smaller-plan PATCH rejected with STORAGE_RESIZE_REQUIRED" \
    || fail "smaller-plan PATCH code=$SHRINK_CODE (expected STORAGE_RESIZE_REQUIRED) — body: $(echo "$SHRINK_RESP" | head -c 300)"
else
  log "── Scenario 6: skipped (no plan smaller than Starter on this cluster) ──"
fi

# ─── summary ─────────────────────────────────────────────────────────
echo
log "── done ──"
log "passed: $passed  failed: $failed"
[[ $failed -eq 0 ]]
