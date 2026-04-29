#!/usr/bin/env bash
# End-to-end test for the user-reported tier-flip silent revert.
#
# Reproduces the manual UI flow:
#   1. Create a client (mirrors POST /clients from the admin panel)
#   2. Wait for full provisioning (orchestrator complete)
#   3. PATCH storage_tier=ha (mirrors the Save button in PlacementCard)
#   4. Assert the API RESPONSE body has storageTier="ha"
#   5. Re-fetch GET /clients/:id (mirrors UI page reload)
#   6. Assert the persisted storageTier is STILL "ha"
#   7. Assert Longhorn Volume.spec.numberOfReplicas == 2
#   8. Assert /clients/:id/storage-placement returns sizeBytes > 0 AND has usedBytes field
#
# This catches the regression the user found: the PATCH returned 200
# but the DB write was skipped, so reload showed local again.
#
# USAGE: ADMIN_PASSWORD=<…> ./scripts/integration-tier-flip-e2e.sh

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

# ─── reproduce the user's flow ───────────────────────────────────────
log "── creating client (mirrors UI: New Client) ──"
STAMP=$(date +%s)
COMPANY="Tier Flip E2E $STAMP"
RESP=$(api POST "/clients" "{\"company_name\":\"$COMPANY\",\"company_email\":\"tier-e2e-$STAMP@phoenix-host.net\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"storage_tier\":\"local\"}")
CID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[[ -n "$CID" ]] && ok "client created cid=$CID" || { fail "create failed: $RESP"; exit 1; }

cleanup() { curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$CID" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "── waiting for full provisioning ──"
for _ in $(seq 1 60); do
  STATUS=$(api GET "/clients/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('provisioningStatus') or '')" 2>/dev/null)
  [[ "$STATUS" == "provisioned" ]] && break
  sleep 2
done
[[ "$STATUS" == "provisioned" ]] && ok "provisioningStatus=provisioned" || { fail "stuck at $STATUS"; exit 1; }

NS=$(ssh_cp "kubectl get ns -l client=$CID -o jsonpath='{.items[0].metadata.name}'")
PVNAME=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.spec.volumeName}'")
[[ -n "$PVNAME" ]] && ok "PV bound: $PVNAME" || { fail "PV not bound"; exit 1; }

# ─── PATCH storage_tier (mirrors UI: Save in PlacementCard) ──────────
log "── PATCH storage_tier=ha (UI Save click) ──"
FLIP=$(api PATCH "/clients/$CID" '{"storage_tier":"ha"}')
RESPONSE_TIER=$(echo "$FLIP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('storageTier') or 'MISSING')" 2>/dev/null)
[[ "$RESPONSE_TIER" == "ha" ]] && ok "PATCH response storageTier=ha" || fail "PATCH response storageTier=$RESPONSE_TIER (expected ha) — body: $(echo "$FLIP" | head -c 300)"

# ─── reload page (GET /clients/:id again) ────────────────────────────
log "── GET /clients/:id (UI reload) ──"
RELOAD=$(api GET "/clients/$CID")
PERSISTED_TIER=$(echo "$RELOAD" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('storageTier') or 'MISSING')" 2>/dev/null)
[[ "$PERSISTED_TIER" == "ha" ]] && ok "GET after reload: storageTier=ha (THIS IS THE BUG THE USER REPORTED)" || fail "GET after reload: storageTier=$PERSISTED_TIER (regression — silent revert)"

# ─── Volume CR replicas patched live ─────────────────────────────────
log "── Volume CR live patch ──"
REPL=""
for _ in $(seq 1 20); do
  REPL=$(ssh_cp "kubectl -n longhorn-system get volumes.longhorn.io $PVNAME -o jsonpath='{.spec.numberOfReplicas}' 2>/dev/null" || echo "")
  [[ "$REPL" == "2" ]] && break
  sleep 2
done
[[ "$REPL" == "2" ]] && ok "Volume.spec.numberOfReplicas=2 (live)" || fail "Volume replicas=$REPL (expected 2)"

# ─── storage-placement endpoint returns size + used ──────────────────
log "── GET /storage-placement (storage table data) ──"
PLACEMENT=$(api GET "/clients/$CID/storage-placement")
HAS_SIZE=$(echo "$PLACEMENT" | python3 -c "import json,sys;d=json.load(sys.stdin)['data']['pvcs'];print('Y' if d and d[0].get('sizeBytes',0) > 0 else 'N')" 2>/dev/null)
HAS_USED_FIELD=$(echo "$PLACEMENT" | python3 -c "import json,sys;d=json.load(sys.stdin)['data']['pvcs'];print('Y' if d and 'usedBytes' in d[0] else 'N')" 2>/dev/null)
HAS_ALLOC_FIELD=$(echo "$PLACEMENT" | python3 -c "import json,sys;d=json.load(sys.stdin)['data']['pvcs'];print('Y' if d and 'allocatedBytes' in d[0] else 'N')" 2>/dev/null)
USED_OK=$(echo "$PLACEMENT" | python3 -c "import json,sys;d=json.load(sys.stdin)['data']['pvcs'][0];u=d['usedBytes'];a=d.get('allocatedBytes',0);print('Y' if u < 100*1024*1024 and (u==0 or u <= a) else 'N')" 2>/dev/null)
[[ "$HAS_SIZE" == "Y" ]] && ok "storage-placement.sizeBytes > 0" || fail "sizeBytes missing/0 — body: $(echo "$PLACEMENT" | head -c 300)"
[[ "$HAS_USED_FIELD" == "Y" ]] && ok "storage-placement.usedBytes field present" || fail "usedBytes field missing in API response"
[[ "$HAS_ALLOC_FIELD" == "Y" ]] && ok "storage-placement.allocatedBytes field present" || fail "allocatedBytes field missing"
[[ "$USED_OK" == "Y" ]] && ok "usedBytes is filesystem-level (not block-allocation overhead)" || fail "usedBytes looks like Longhorn allocation not kubelet — body: $(echo "$PLACEMENT" | head -c 400)"

# ─── XFS migration assertions (2026-04-28) ───────────────────────────
# longhorn-tenant SC was switched to fsType=xfs. Fresh tenants should
# now report fsType=xfs in the placement endpoint AND a much smaller
# empty-volume allocatedBytes (~40 MiB vs ~228 MiB on ext4).
log "── XFS tenant filesystem assertions ──"
FS_TYPE=$(echo "$PLACEMENT" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['pvcs'][0].get('fsType') or 'MISSING')" 2>/dev/null)
[[ "$FS_TYPE" == "xfs" ]] && ok "fresh tenant PVC formatted as xfs" || fail "fsType=$FS_TYPE (expected xfs after SC migration)"

ALLOC_BYTES=$(echo "$PLACEMENT" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['pvcs'][0].get('allocatedBytes') or 0)" 2>/dev/null)
ALLOC_MIB=$(( ALLOC_BYTES / (1024*1024) ))
# Threshold 60 MiB — XFS typical empty volume reports ~40 MiB. ext4
# would report ~228 MiB so this firmly distinguishes the two. Cap at
# 60 to leave headroom for filesystem variants.
if [[ $ALLOC_BYTES -lt $((60*1024*1024)) ]]; then
  ok "empty XFS volume allocatedBytes=${ALLOC_MIB} MiB < 60 MiB target"
else
  fail "allocatedBytes=${ALLOC_MIB} MiB — too high for empty XFS (suggests ext4)"
fi

# Health-metric fields (Phase 3 of the storage-health PR).
HAS_REPL_HEALTHY=$(echo "$PLACEMENT" | python3 -c "import json,sys;print('Y' if 'replicasHealthy' in json.load(sys.stdin)['data']['pvcs'][0] else 'N')" 2>/dev/null)
HAS_REPL_EXPECTED=$(echo "$PLACEMENT" | python3 -c "import json,sys;print('Y' if 'replicasExpected' in json.load(sys.stdin)['data']['pvcs'][0] else 'N')" 2>/dev/null)
HAS_ENGINE_CONDS=$(echo "$PLACEMENT" | python3 -c "import json,sys;print('Y' if 'engineConditions' in json.load(sys.stdin)['data']['pvcs'][0] else 'N')" 2>/dev/null)
[[ "$HAS_REPL_HEALTHY" == "Y" ]] && ok "storage-placement exposes replicasHealthy" || fail "replicasHealthy field missing"
[[ "$HAS_REPL_EXPECTED" == "Y" ]] && ok "storage-placement exposes replicasExpected" || fail "replicasExpected field missing"
[[ "$HAS_ENGINE_CONDS" == "Y" ]] && ok "storage-placement exposes engineConditions" || fail "engineConditions field missing"

# Replica counts — this client was flipped to ha-tier above so we
# expect 2 replicas desired and (eventually) 2 healthy.
REPL_HEALTHY=$(echo "$PLACEMENT" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['pvcs'][0].get('replicasHealthy',0))" 2>/dev/null)
REPL_EXPECTED=$(echo "$PLACEMENT" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['pvcs'][0].get('replicasExpected',0))" 2>/dev/null)
[[ "$REPL_EXPECTED" == "2" ]] && ok "ha-tier replicasExpected=2" || fail "replicasExpected=$REPL_EXPECTED (expected 2 for ha)"
# replicasHealthy may be 0 (no pod attached yet — volume hasn't been
# read/written), 1 (rebuilding), or 2 (steady-state). All three are
# valid — what we're asserting is that the field is numeric and
# bounded by replicasExpected, not that a specific count is reached.
if [[ "$REPL_HEALTHY" =~ ^[0-2]$ ]]; then
  ok "ha-tier replicasHealthy=$REPL_HEALTHY (≤ replicasExpected=$REPL_EXPECTED)"
else
  fail "replicasHealthy=$REPL_HEALTHY (expected 0, 1, or 2)"
fi

# ─── fsck dry-run on a healthy fresh volume returns clean ──────────
# The endpoint quiesces tenant + FM, runs xfs_repair -n, restores.
# Total time ~30-60 s for a small volume on staging.
# Longhorn requires currentNodeID set on the Volume CR for fsck to
# locate it — that's only populated when something attaches the
# volume. Start FM briefly so the volume gets attached, then run
# fsck (which will quiesce/attach again with its own pod).
api POST "/clients/$CID/files/start" "" >/dev/null
for _ in $(seq 1 30); do
  R=$(api GET "/clients/$CID/files/status" | python3 -c "import json,sys;print(str(json.load(sys.stdin)['data'].get('ready','false')).lower())" 2>/dev/null || echo false)
  [[ "$R" == "true" ]] && break
  sleep 3
done
log "── POST /storage/fsck (dry-run on healthy XFS volume) ──"
FSCK_RESP=$(api POST "/admin/clients/$CID/storage/fsck" "")
FSCK_OP_ID=$(echo "$FSCK_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('operationId',''))" 2>/dev/null)
if [[ -n "$FSCK_OP_ID" ]]; then
  ok "fsck operation queued opId=${FSCK_OP_ID:0:8}"
  # End-to-end fsck on staging takes 5-15 min because the orchestrator
  # has to: quiesce FM + tenant pods, wait for volume detach, schedule
  # a privileged Job, pull the busybox/xfsprogs image cold on the host,
  # mount /dev/longhorn/<pv>, run xfs_repair -n, unquiesce. We don't
  # block the suite for that long — assert the orchestrator is
  # observably PROGRESSING (state advanced past 'queued' and progress
  # has moved). Terminal states (idle/failed) are also accepted as
  # green if they happen within the 5-min poll window.
  FSCK_STATE=""
  FSCK_PCT=0
  for _ in $(seq 1 100); do
    OP=$(api GET "/admin/storage/operations/$FSCK_OP_ID" 2>/dev/null || echo "{}")
    FSCK_STATE=$(echo "$OP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print(d.get('state',''))" 2>/dev/null)
    FSCK_PCT=$(echo "$OP" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print(int(d.get('progressPct') or 0))" 2>/dev/null)
    case "$FSCK_STATE" in idle|failed) break ;; esac
    sleep 3
  done
  case "$FSCK_STATE" in
    idle) ok "fsck dry-run completed CLEAN on fresh XFS volume" ;;
    failed)
      FSCK_ERR=$(echo "$OP" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data',{}).get('lastError') or '')[:300])" 2>/dev/null)
      fail "fsck dry-run completed with errors: $FSCK_ERR"
      ;;
    *)
      # Not terminal yet — accept if orchestrator is progressing past
      # the queue (state changed AND progressPct moved off zero).
      if [[ "$FSCK_STATE" != "" && "$FSCK_STATE" != "queued" && "$FSCK_PCT" -gt 0 ]]; then
        ok "fsck orchestrator progressing (state=$FSCK_STATE pct=${FSCK_PCT}%) — full run takes >5 min on staging, not blocking"
      else
        fail "fsck stuck — state=$FSCK_STATE pct=$FSCK_PCT (orchestrator not progressing)"
      fi
      ;;
  esac
else
  fail "fsck endpoint did not return an operationId — body: $(echo "$FSCK_RESP" | head -c 300)"
fi

# ─── deploy a tenant workload, verify affinity patch on tier flip ────
log "── deploy tenant workload + verify affinity flip ──"
CATALOG_NGINX_PHP="${CATALOG_NGINX_PHP:-b6465a21-6c27-4e23-a3ef-3f6d4616dca5}"
DEPL_NAME="t$(date +%s)"
DEPL_RESP=$(api POST "/clients/$CID/deployments" "{\"catalog_entry_id\":\"$CATALOG_NGINX_PHP\",\"name\":\"$DEPL_NAME\",\"replica_count\":1}")
DEPL_ID=$(echo "$DEPL_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
[[ -n "$DEPL_ID" ]] && ok "deployment created $DEPL_NAME" || { fail "deploy create failed: $(echo "$DEPL_RESP" | head -c 200)"; }

# Wait for deploy + record current affinity (still HA tier)
for _ in $(seq 1 30); do
  STATE=$(ssh_cp "kubectl -n $NS get deploy $DEPL_NAME -o jsonpath='{.spec.template.spec.nodeSelector.kubernetes\\.io/hostname}{\"|\"}{.spec.template.spec.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution[0].preference.matchExpressions[0].values[0]}' 2>/dev/null" || true)
  [[ -n "$STATE" ]] && break
  sleep 2
done

# After ha-tier deploy on a fresh tier=ha client, expect:
#   nodeSelector empty (HA = soft preferred, no hard pin)
#   affinity preferred to workerNodeName
HA_NS=$(echo "$STATE" | cut -d'|' -f1)
[[ -z "$HA_NS" ]] && ok "HA tier: nodeSelector cleared" || fail "HA tier: nodeSelector still set ($HA_NS) — strategic-merge null bug"

# ─── flip back to local + verify nodeSelector reapplied ──────────────
log "── flip back to local (round-trip) ──"
api PATCH "/clients/$CID" '{"storage_tier":"local"}' >/dev/null
RELOAD2=$(api GET "/clients/$CID")
TIER2=$(echo "$RELOAD2" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('storageTier'))" 2>/dev/null)
[[ "$TIER2" == "local" ]] && ok "round-trip ha→local persists" || fail "round-trip failed: tier=$TIER2"

# After local-tier flip, deployment should have:
#   nodeSelector = workerNodeName (hard pin)
#   affinity cleared
sleep 3
LOCAL_STATE=$(ssh_cp "kubectl -n $NS get deploy $DEPL_NAME -o jsonpath='{.spec.template.spec.nodeSelector.kubernetes\\.io/hostname}{\"|\"}{.spec.template.spec.affinity}' 2>/dev/null" || true)
LOCAL_NS=$(echo "$LOCAL_STATE" | cut -d'|' -f1)
LOCAL_AFF=$(echo "$LOCAL_STATE" | cut -d'|' -f2)
[[ -n "$LOCAL_NS" ]] && ok "local tier: nodeSelector set to $LOCAL_NS" || fail "local tier: nodeSelector not applied"
[[ -z "$LOCAL_AFF" ]] && ok "local tier: affinity cleared" || fail "local tier: affinity still set ($LOCAL_AFF) — null-doesnt-clear bug"

# ─── deployment uses Recreate strategy (RWO PVC requires it) ─────────
log "── tenant deploy uses Recreate strategy ──"
STRATEGY=$(ssh_cp "kubectl -n $NS get deploy $DEPL_NAME -o jsonpath='{.spec.strategy.type}'" 2>/dev/null || true)
[[ "$STRATEGY" == "Recreate" ]] && ok "Deployment.spec.strategy.type=Recreate" || fail "strategy=$STRATEGY (expected Recreate — RollingUpdate causes Multi-Attach on tier flip)"

# ─── FM colocation: same node as the tenant workload ────────────────
log "── FM colocates with tenant workload (RWO sharing) ──"
api POST "/clients/$CID/files/start" "" >/dev/null
for _ in $(seq 1 30); do
  R=$(api GET "/clients/$CID/files/status" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('ready'))" 2>/dev/null)
  [[ "$R" == "True" ]] && break
  sleep 4
done
[[ "$R" == "True" ]] && ok "FM ready" || fail "FM did not become ready"
TENANT_NODE=$(ssh_cp "kubectl -n $NS get pod -l app=$DEPL_NAME -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null || true)
FM_NODE=$(ssh_cp "kubectl -n $NS get pod -l app=file-manager -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null || true)
[[ -n "$TENANT_NODE" && "$TENANT_NODE" == "$FM_NODE" ]] && ok "FM on $FM_NODE = tenant on $TENANT_NODE (no Multi-Attach risk)" || fail "FM on $FM_NODE, tenant on $TENANT_NODE — affinity bug"

REPL2=""
for _ in $(seq 1 15); do
  REPL2=$(ssh_cp "kubectl -n longhorn-system get volumes.longhorn.io $PVNAME -o jsonpath='{.spec.numberOfReplicas}' 2>/dev/null" || echo "")
  [[ "$REPL2" == "1" ]] && break
  sleep 2
done
[[ "$REPL2" == "1" ]] && ok "Volume replicas back to 1" || fail "Volume replicas=$REPL2 (expected 1)"

log "── results ──"
printf "  passed: %s\n  failed: %s\n" "$passed" "$failed"
[[ $failed -eq 0 ]] || exit 1
