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
