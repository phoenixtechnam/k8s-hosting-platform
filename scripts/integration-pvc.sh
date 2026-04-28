#!/usr/bin/env bash
# PVC-focused integration tests for the unified tenant StorageClass +
# live tier patch + auto worker pick. Runs against staging.
#
# Asserts behavior introduced in commits 0f6e40c / 8a9a5c3:
#   1. autoPickWorkerNode populates clients.workerNodeName when the
#      operator creates a Local-tier client without a pin.
#   2. Initial PVC binds to longhorn-tenant SC (not the legacy -local
#      / -ha pair) and Volume.spec.numberOfReplicas matches the tier
#      (1 for local, 2 for ha) — verifying patchTenantVolumeReplicas
#      polls past the bind race.
#   3. Tier flip local→ha is LIVE: Volume.spec.numberOfReplicas
#      switches without recreating the StatefulSet / namespace.
#   4. Cascade cleanup catches late-binding PVs when a fast
#      create+delete races against Longhorn provisioning.
#
# USAGE
#   ADMIN_PASSWORD=<…> ./scripts/integration-pvc.sh

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@89.167.3.56}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o ConnectTimeout=10 -q}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }

passed=0
failed=0

ssh_cp() { ssh -i "$SSH_KEY" $SSH_OPTS "$SSH_HOST" "$@"; }

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

log "logging in as $ADMIN_EMAIL"
TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
[[ -n "$TOKEN" ]] || { echo "login failed"; exit 1; }

PLAN_ID=$(api GET "/plans" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((p['id'] for p in d['data'] if p['name']=='Starter'),''))")
REGION_ID=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'])")
[[ -n "$PLAN_ID" && -n "$REGION_ID" ]] || { echo "no plan/region"; exit 1; }

# ─── scenario 1: storage_tier=local + Auto worker pick ───────────────
log "── scenario: local tier + auto worker pick ──"
STAMP=$(date +%s)
COMPANY="PVC Test L $STAMP"
RESP=$(api POST "/clients" "{\"company_name\":\"$COMPANY\",\"company_email\":\"pvc-l-$STAMP@phoenix-host.net\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"storage_tier\":\"local\"}")
CID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[[ -n "$CID" ]] && ok "client created cid=$CID" || { fail "create failed: $RESP"; exit 1; }

# Wait for provisioning to settle (PVC bound, Volume CR present).
NS=""
for i in $(seq 1 30); do
  NS=$(ssh_cp "kubectl get ns -l client=$CID -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null || true)
  [[ -n "$NS" ]] && break
  sleep 2
done
[[ -n "$NS" ]] && ok "namespace=$NS" || { fail "no namespace within 60s"; exit 1; }

# Wait for PVC bind + Longhorn Volume creation.
for i in $(seq 1 60); do
  PVNAME=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.spec.volumeName}'" 2>/dev/null || true)
  [[ -n "$PVNAME" ]] && break
  sleep 2
done
[[ -n "$PVNAME" ]] && ok "PVC bound pv=$PVNAME" || { fail "PVC not bound after 120s"; exit 1; }

# Assert SC is the unified longhorn-tenant.
SC=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.spec.storageClassName}'")
[[ "$SC" == "longhorn-tenant" ]] && ok "SC=longhorn-tenant" || fail "SC=$SC (expected longhorn-tenant)"

# Auto-pick: clients.workerNodeName should be populated for Local tier.
WORKER=$(api GET "/clients/$CID" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d.get('workerNodeName') or '')")
[[ -n "$WORKER" ]] && ok "auto-picked workerNodeName=$WORKER" || fail "workerNodeName empty (autoPickWorkerNode didn't fire)"

# Volume.spec.numberOfReplicas should be 1 for local tier.
REPL=$(ssh_cp "kubectl -n longhorn-system get volumes.longhorn.io $PVNAME -o jsonpath='{.spec.numberOfReplicas}'" 2>/dev/null || echo "")
[[ "$REPL" == "1" ]] && ok "Volume replicas=1 (local tier)" || fail "Volume replicas=$REPL (expected 1)"

# ─── scenario 2: tier flip local → ha live ───────────────────────────
log "── scenario: tier flip local→ha live ──"
FLIP=$(api PATCH "/clients/$CID" '{"storage_tier":"ha"}')
echo "$FLIP" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('data',{}).get('storageTier')=='ha'" 2>/dev/null \
  && ok "client storageTier flipped to ha" || fail "tier flip failed: $(echo $FLIP | head -c 200)"

# Volume.spec.numberOfReplicas should reach 2 within ~30s (live patch).
REPL=""
for i in $(seq 1 30); do
  REPL=$(ssh_cp "kubectl -n longhorn-system get volumes.longhorn.io $PVNAME -o jsonpath='{.spec.numberOfReplicas}'" 2>/dev/null || echo "")
  [[ "$REPL" == "2" ]] && break
  sleep 2
done
[[ "$REPL" == "2" ]] && ok "Volume replicas=2 after live flip" || fail "Volume replicas=$REPL after 60s (expected 2)"

# ─── scenario 3: client delete cascade fires ─────────────────────────
log "── scenario: cascade cleans tenant PV ──"
DEL=$(curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$CID" -H "Authorization: Bearer $TOKEN" -w "\nHTTP %{http_code}")
echo "$DEL" | tail -1 | grep -q "204" && ok "client deleted (204)" || { fail "delete failed: $DEL"; exit 1; }

# Wait up to 90s for the orphan PV to disappear.
GONE=0
for i in $(seq 1 45); do
  PV_PHASE=$(ssh_cp "kubectl get pv $PVNAME -o jsonpath='{.status.phase}' 2>&1" || true)
  if [[ "$PV_PHASE" == *"NotFound"* || "$PV_PHASE" == *"not found"* ]]; then
    GONE=1; break
  fi
  sleep 2
done
[[ $GONE -eq 1 ]] && ok "PV $PVNAME cleaned by cascade" || fail "PV still present after 90s (cascade didn't fire)"

# ─── scenario 4: fast create+delete (cascade race) ───────────────────
log "── scenario: fast create+delete (cascade race) ──"
STAMP=$(date +%s)
COMPANY="PVC Race $STAMP"
RESP=$(api POST "/clients" "{\"company_name\":\"$COMPANY\",\"company_email\":\"pvc-race-$STAMP@phoenix-host.net\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"storage_tier\":\"local\"}")
CID2=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[[ -n "$CID2" ]] && ok "race client created cid=$CID2" || { fail "race create failed"; exit 1; }

# Capture the namespace immediately so we can identify the PV later.
NS2=""
for i in $(seq 1 10); do
  NS2=$(ssh_cp "kubectl get ns -l client=$CID2 -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null || true)
  [[ -n "$NS2" ]] && break
  sleep 1
done
[[ -n "$NS2" ]] && ok "race ns=$NS2" || { fail "no race ns"; exit 1; }

# DELETE within ~3s — Longhorn won't have bound the PV yet, exercising
# the late-binding tracking in cleanupReleasedPvs.
sleep 1
DEL2=$(curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$CID2" -H "Authorization: Bearer $TOKEN" -w "\nHTTP %{http_code}")
echo "$DEL2" | tail -1 | grep -q "204" && ok "race delete 204" || fail "race delete failed: $DEL2"

# After 90s, no PV should reference this namespace.
sleep 3
ORPHAN=0
for i in $(seq 1 45); do
  ORPHAN=$(ssh_cp "kubectl get pv -o jsonpath='{range .items[*]}{.spec.claimRef.namespace}{\"\\n\"}{end}' 2>/dev/null | grep -c \"^$NS2\$\" || true")
  ORPHAN="${ORPHAN:-0}"
  [[ "$ORPHAN" -eq 0 ]] && break
  sleep 2
done
[[ "$ORPHAN" -eq 0 ]] && ok "no orphan PV for race ns (cascade fix works)" || fail "$ORPHAN orphan PV(s) for $NS2 after 90s"

# ─── results ─────────────────────────────────────────────────────────
log "── results ──"
printf "  passed: %s\n  failed: %s\n" "$passed" "$failed"
[[ $failed -eq 0 ]] || exit 1
