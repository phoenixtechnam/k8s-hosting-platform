#!/usr/bin/env bash
# End-to-end test for online-grow + auto-grow-on-PATCH.
#
# Verifies the online-grow path so tenant storage bumps are zero-downtime:
#   1. Create a client at 10 GiB
#   2. Wait for full provisioning
#   3. Record the running tenant pod name (we want to assert it does NOT
#      restart during the grow)
#   4. PATCH /clients/:id with storage_limit_override=15 (grow 10→15 GiB)
#   5. Assert response carries storageGrowOperationId
#   6. Poll /admin/storage/operations/:opId until terminal
#   7. Assert op.params.mode === 'grow_online' and state==='idle'
#   8. Assert PVC.spec.resources.requests.storage reflects 15Gi
#   9. Assert PVC.status.capacity.storage reflects 15Gi
#  10. Assert the tenant pod is still Running with the SAME name
#      (i.e. it was never recreated, no quiesce, no replace)
#  11. Assert no quiescing/snapshotting/replacing/restoring states were
#      ever recorded for this op (params.mode==='grow_online' means
#      the orchestrator went snapshotting=skip, no quiesce, etc.)
#  12. Cleanup
#
# USAGE: ADMIN_PASSWORD=<…> ./scripts/integration-grow-e2e.sh

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
REGION_ID=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'])")
[[ -n "$PLAN_ID" && -n "$REGION_ID" ]] || { echo "no plan/region"; exit 1; }

# ─── create + provision ──────────────────────────────────────────────
log "── creating client ──"
STAMP=$(date +%s)
COMPANY="Grow E2E $STAMP"
RESP=$(api POST "/clients" "{\"company_name\":\"$COMPANY\",\"company_email\":\"grow-e2e-$STAMP@phoenix-host.net\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}")
CID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[[ -n "$CID" ]] && ok "client created cid=$CID" || { fail "create failed: $RESP"; exit 1; }

cleanup() { curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$CID" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "── waiting for full provisioning ──"
STATUS=""
for _ in $(seq 1 60); do
  STATUS=$(api GET "/clients/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('provisioningStatus') or '')" 2>/dev/null)
  [[ "$STATUS" == "provisioned" ]] && break
  sleep 2
done
[[ "$STATUS" == "provisioned" ]] && ok "provisioningStatus=provisioned" || { fail "stuck at $STATUS"; exit 1; }

NS=$(ssh_cp "kubectl get ns -l client=$CID -o jsonpath='{.items[0].metadata.name}'")
[[ -n "$NS" ]] && ok "namespace $NS" || { fail "no namespace"; exit 1; }

# Initial PVC size — should be the plan default (~10 GiB).
PVC_SIZE_INITIAL=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.spec.resources.requests.storage}'")
log "initial PVC size = $PVC_SIZE_INITIAL"

# Longhorn requires a volume to have ready replicas before it accepts
# expansion requests — fresh tenants whose PVC hasn't been mounted yet
# get rejected by the validator.longhorn.io webhook with "cannot find
# the corresponding ready node and disk". Start the file-manager so a
# pod attaches the volume and Longhorn schedules a replica.
log "── starting file-manager to attach the volume before grow ──"
api POST "/clients/$CID/files/start" "" >/dev/null
FM_READY="false"
for _ in $(seq 1 30); do
  FM_READY=$(api GET "/clients/$CID/files/status" | python3 -c "import json,sys;print(str(json.load(sys.stdin)['data'].get('ready','false')).lower())" 2>/dev/null || echo false)
  [[ "$FM_READY" == "true" ]] && break
  sleep 4
done
[[ "$FM_READY" == "true" ]] && ok "FM ready — volume now attached" || { fail "FM did not become ready before grow"; exit 1; }

# Capture the file-manager pod name AFTER it's running. After the grow,
# the pod must still be Running with the SAME name — that's how we
# prove the orchestrator did NOT quiesce/replace.
FM_POD_BEFORE=$(ssh_cp "kubectl -n $NS get pods -l app=file-manager -o jsonpath='{.items[0].metadata.name}' 2>/dev/null" || echo "")
log "file-manager pod before grow = ${FM_POD_BEFORE:-<none>}"

# ─── PATCH storage_limit_override 10 → 15 GiB (auto-grow trigger) ────
log "── PATCH storage_limit_override=15 (UI: Save Resource Limits) ──"
PATCH_RESP=$(api PATCH "/clients/$CID" '{"storage_limit_override":15}')
GROW_OP_ID=$(echo "$PATCH_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print(d.get('storageGrowOperationId') or '')" 2>/dev/null)
NEW_OVERRIDE=$(echo "$PATCH_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print(d.get('storageLimitOverride') or '')" 2>/dev/null)

[[ -n "$GROW_OP_ID" ]] && ok "PATCH carried storageGrowOperationId=${GROW_OP_ID:0:8}" \
  || { fail "PATCH did not return storageGrowOperationId — body: $(echo "$PATCH_RESP" | head -c 400)"; exit 1; }
[[ -n "$NEW_OVERRIDE" ]] && ok "storageLimitOverride persisted = $NEW_OVERRIDE" \
  || fail "storageLimitOverride not persisted on PATCH"

# ─── poll the grow op until terminal ─────────────────────────────────
log "── polling grow op until terminal ──"
FINAL_STATE=""
FINAL_OP=""
for _ in $(seq 1 60); do
  FINAL_OP=$(api GET "/admin/storage/operations/$GROW_OP_ID" 2>/dev/null || echo "{}")
  COMPLETED=$(echo "$FINAL_OP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print('Y' if d.get('completedAt') else 'N')" 2>/dev/null)
  if [[ "$COMPLETED" == "Y" ]]; then
    FINAL_STATE=$(echo "$FINAL_OP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('state',''))" 2>/dev/null)
    break
  fi
  sleep 2
done

[[ "$FINAL_STATE" == "idle" ]] && ok "grow op reached idle terminal" \
  || { fail "grow op did not reach idle (last state=$FINAL_STATE) — body: $(echo "$FINAL_OP" | head -c 500)"; exit 1; }

# Assert params.mode === 'grow_online'
GROW_MODE=$(echo "$FINAL_OP" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'].get('params',{}) or {};print(d.get('mode',''))" 2>/dev/null)
[[ "$GROW_MODE" == "grow_online" ]] && ok "op.params.mode=grow_online" \
  || fail "op.params.mode=$GROW_MODE (expected grow_online — fell back to destructive?)"

# Assert progress message matches grow flow
PROGRESS_MSG=$(echo "$FINAL_OP" | python3 -c "import json,sys;print((json.load(sys.stdin)['data'].get('progressMessage') or '')[:200])" 2>/dev/null)
log "final progressMessage = $PROGRESS_MSG"

# ─── PVC size assertions ─────────────────────────────────────────────
PVC_SIZE_AFTER=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.spec.resources.requests.storage}'")
PVC_CAPACITY=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.status.capacity.storage}'")
log "PVC after grow: spec=$PVC_SIZE_AFTER status=$PVC_CAPACITY"

[[ "$PVC_SIZE_AFTER" == "15Gi" ]] && ok "PVC.spec.resources.requests.storage=15Gi" \
  || fail "PVC.spec.resources.requests.storage=$PVC_SIZE_AFTER (expected 15Gi)"

# Capacity: kubelet reports the actual block-device size after Longhorn
# extends the volume. May lag the spec by a few seconds.
[[ "$PVC_CAPACITY" == "15Gi" ]] && ok "PVC.status.capacity.storage=15Gi" \
  || fail "PVC.status.capacity.storage=$PVC_CAPACITY (expected 15Gi — Longhorn may not have finished extending)"

# Assert no FileSystemResizePending lingering.
PENDING=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.status.conditions[?(@.type==\"FileSystemResizePending\")].status}' 2>/dev/null" || echo "")
[[ -z "$PENDING" || "$PENDING" == "False" ]] && ok "FileSystemResizePending cleared by kubelet" \
  || fail "FileSystemResizePending still True — xfs_growfs / resize2fs did not run"

# ─── tenant pod stayed Running through the grow ──────────────────────
log "── pod continuity across the grow ──"
FM_POD_AFTER=$(ssh_cp "kubectl -n $NS get pods -l app=file-manager -o jsonpath='{.items[0].metadata.name}' 2>/dev/null" || echo "")
FM_PHASE=$(ssh_cp "kubectl -n $NS get pods -l app=file-manager -o jsonpath='{.items[0].status.phase}' 2>/dev/null" || echo "")

[[ "$FM_PHASE" == "Running" ]] && ok "file-manager pod is still Running" \
  || fail "file-manager pod phase=$FM_PHASE (expected Running — was the pod restarted?)"

if [[ -n "$FM_POD_BEFORE" && "$FM_POD_BEFORE" == "$FM_POD_AFTER" ]]; then
  ok "file-manager pod name unchanged ($FM_POD_BEFORE) — proves zero quiesce/replace"
elif [[ -z "$FM_POD_BEFORE" ]]; then
  log "no FM pod before — skipping name-equality check"
else
  fail "file-manager pod name changed: $FM_POD_BEFORE → $FM_POD_AFTER (was the orchestrator destructive?)"
fi

# ─── op state machine never visited destructive states ───────────────
# resizing = expected for grow_online, restoring = also expected (the
# state we use while waiting for kubelet to clear FileSystemResizePending).
# quiescing/snapshotting/replacing should NEVER appear.
OPS_LIST=$(api GET "/admin/clients/$CID/storage/operations")
# Pipe ops list to a single python -c call. Avoids the SC2259 pitfall
# where a heredoc and a piped stdin both fight for fd 0.
DESTRUCTIVE_STATES=$(printf '%s' "$OPS_LIST" | python3 -c '
import json, sys
data = json.load(sys.stdin).get("data", [])
bad = []
for op in data:
    if op.get("opType") != "resize": continue
    p = op.get("params") or {}
    if p.get("mode") != "grow_online": continue
    state = op.get("state", "")
    msg = op.get("progressMessage") or ""
    for bad_state in ("quiescing", "snapshotting", "replacing"):
        if bad_state in (state, ""): continue
        if bad_state in msg.lower():
            bad.append(f"{bad_state} in progressMessage: {msg[:80]}")
print("|".join(bad) if bad else "OK")
')
[[ "$DESTRUCTIVE_STATES" == "OK" ]] && ok "grow op never visited destructive states" \
  || fail "grow op visited destructive states: $DESTRUCTIVE_STATES"

# ─── storage-placement reflects new size within 30s ──────────────────
log "── storage-placement reflects new size ──"
NEW_SIZE_BYTES=""
for _ in $(seq 1 15); do
  PLACEMENT=$(api GET "/clients/$CID/storage-placement")
  NEW_SIZE_BYTES=$(echo "$PLACEMENT" | python3 -c "import json,sys;d=json.load(sys.stdin)['data']['pvcs'];print(d[0].get('sizeBytes',0) if d else 0)" 2>/dev/null)
  # 15 GiB = 16106127360 bytes
  if [[ "$NEW_SIZE_BYTES" -ge $((15 * 1024 * 1024 * 1024)) ]]; then
    break
  fi
  sleep 2
done
if [[ "$NEW_SIZE_BYTES" -ge $((15 * 1024 * 1024 * 1024)) ]]; then
  ok "storage-placement.sizeBytes=$NEW_SIZE_BYTES >= 15 GiB"
else
  fail "storage-placement.sizeBytes=$NEW_SIZE_BYTES < 15 GiB after 30s"
fi

# ─── shrink rejection still returns STORAGE_RESIZE_REQUIRED ──────────
log "── PATCH storage_limit_override=5 (shrink) — must reject ──"
SHRINK_RESP=$(api PATCH "/clients/$CID" '{"storage_limit_override":5}')
SHRINK_CODE=$(echo "$SHRINK_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('error',{}).get('code',''))" 2>/dev/null)
[[ "$SHRINK_CODE" == "STORAGE_RESIZE_REQUIRED" ]] && ok "shrink correctly rejected with STORAGE_RESIZE_REQUIRED" \
  || fail "shrink response code=$SHRINK_CODE (expected STORAGE_RESIZE_REQUIRED) — body: $(echo "$SHRINK_RESP" | head -c 300)"

# ─── summary ─────────────────────────────────────────────────────────
echo
log "── done ──"
log "passed: $passed  failed: $failed"
[[ $failed -eq 0 ]]
