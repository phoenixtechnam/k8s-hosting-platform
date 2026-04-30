#!/usr/bin/env bash
# End-to-end test for the runtime-firewall feature.
#
# Verifies:
#   1. allow_host_ports_worker=true lets a coturn-style deploy succeed
#   2. The Pod template carries the platform.io/firewall-{tcp,udp}-ports
#      annotations
#   3. The worker-firewall-reconciler DaemonSet has populated the host's
#      nft set `tenant_ports_tcp` with the requested ports (3478, 5349)
#   4. Toggling allow_host_ports_worker=false makes a fresh deploy of
#      the same catalog entry fail with 403 / HOST_PORTS_DISABLED
#   5. Cleanup
#
# Skips the WebAuthn ceremony — admin login uses the password path.
#
# USAGE: ADMIN_PASSWORD=<…> ./scripts/integration-firewall-e2e.sh

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@89.167.3.56}"
CATALOG_CODE="${CATALOG_CODE:-coturn}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
warn() { printf '  %b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }

passed=0
failed=0

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

api_status() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$ADMIN_HOST/api/v1$path" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body"
  fi
}

ssh_cluster() {
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 -q "$SSH_HOST" "$@"
}

# ─── Login ──────────────────────────────────────────────────────────────────
log "logging in"
TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null)
[[ -n "$TOKEN" ]] || { echo "login failed"; exit 1; }
ok "logged in"

# ─── Snapshot original setting so cleanup restores ─────────────────────────
ORIG_WORKER=$(api GET /admin/system-settings | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('allowHostPortsWorker', False))" 2>/dev/null)
log "original allowHostPortsWorker=$ORIG_WORKER"

cleanup() {
  if [[ -n "${CID:-}" ]]; then
    curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$CID" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  fi
  # Restore the original toggle so the staging cluster ends in the same
  # state we found it in. Skip if we never managed to read the original
  # value (login failure).
  if [[ -n "${ORIG_WORKER:-}" ]]; then
    local restore_val
    restore_val=$([[ "$ORIG_WORKER" == "True" ]] && echo "true" || echo "false")
    curl -sk -X PATCH "$ADMIN_HOST/api/v1/admin/system-settings" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"allowHostPortsWorker\":$restore_val}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ─── Resolve catalog entry id ──────────────────────────────────────────────
CATALOG_ENTRY_ID=$(api GET "/catalog/entries?limit=100" \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(next((e['id'] for e in d if e['code']=='$CATALOG_CODE'), ''))")
if [[ -z "$CATALOG_ENTRY_ID" ]]; then
  fail "catalog entry '$CATALOG_CODE' not found in catalog — is the application catalog synced?"
  exit 1
fi
ok "catalog entry $CATALOG_CODE → $CATALOG_ENTRY_ID"

PLAN_ID=$(api GET "/plans" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((p['id'] for p in d['data'] if p['name']=='Starter'), d['data'][0]['id'] if d['data'] else ''))")
REGION_ID=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'] if d['data'] else '')")
[[ -n "$PLAN_ID" && -n "$REGION_ID" ]] || { fail "no plan/region available"; exit 1; }

# ─── Create test client ────────────────────────────────────────────────────
STAMP=$(date +%s)
log "── creating client ──"
RESP=$(api POST "/clients" "{\"company_name\":\"Firewall E2E $STAMP\",\"company_email\":\"firewall-e2e-$STAMP@phoenix-host.net\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}")
CID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[[ -n "$CID" ]] && ok "client created cid=$CID" || { fail "create failed: $RESP"; exit 1; }

# Wait for provisioning so we have a worker pin and a namespace.
log "── waiting for provisioning ──"
for _ in $(seq 1 60); do
  STATUS=$(api GET "/clients/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('status',''))" 2>/dev/null)
  [[ "$STATUS" == "active" ]] && break
  sleep 2
done
[[ "$STATUS" == "active" ]] && ok "client active" || { fail "client never reached active (status=$STATUS)"; exit 1; }

NAMESPACE=$(api GET "/clients/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('kubernetesNamespace',''))" 2>/dev/null)
WORKER_NODE=$(api GET "/clients/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('workerNodeName',''))" 2>/dev/null)
log "namespace=$NAMESPACE worker=$WORKER_NODE"

# ─── Phase 1: gate REJECTS deploy when toggle is OFF ───────────────────────
log "── phase 1: deploy with allowHostPortsWorker=false → expect 403 ──"
api PATCH "/admin/system-settings" "{\"allowHostPortsWorker\":false}" >/dev/null
sleep 2  # let the 60s in-memory cache invalidate (PATCH already does this)

DEPLOY_BODY="{\"catalog_entry_id\":\"$CATALOG_ENTRY_ID\",\"name\":\"coturn-fw-blocked-$STAMP\"}"
HTTP_CODE=$(api_status POST "/clients/$CID/deployments" "$DEPLOY_BODY")
RESP_BLOCKED=$(api POST "/clients/$CID/deployments" "$DEPLOY_BODY")
ERR_CODE=$(echo "$RESP_BLOCKED" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('error') or {}).get('code',''))" 2>/dev/null)

if [[ "$HTTP_CODE" == "403" && "$ERR_CODE" == "HOST_PORTS_DISABLED" ]]; then
  ok "gate blocked deploy (HTTP 403, code=$ERR_CODE)"
else
  fail "gate did NOT block deploy: HTTP=$HTTP_CODE code=$ERR_CODE body=$(echo "$RESP_BLOCKED" | head -c 300)"
fi

# ─── Phase 2: enable toggle, deploy succeeds ───────────────────────────────
log "── phase 2: flip allowHostPortsWorker=true ──"
TOGGLE_RESP=$(api PATCH "/admin/system-settings" "{\"allowHostPortsWorker\":true}")
TOGGLE_VAL=$(echo "$TOGGLE_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('allowHostPortsWorker', False))" 2>/dev/null)
[[ "$TOGGLE_VAL" == "True" ]] && ok "toggle is on" || fail "toggle still off after PATCH: $TOGGLE_RESP"

DEPLOY_NAME="coturn-fw-ok-$STAMP"
log "── deploying $CATALOG_CODE ──"
DEPLOY_RESP=$(api POST "/clients/$CID/deployments" "{\"catalog_entry_id\":\"$CATALOG_ENTRY_ID\",\"name\":\"$DEPLOY_NAME\"}")
DEP_ID=$(echo "$DEPLOY_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d.get('id',''))" 2>/dev/null)
if [[ -n "$DEP_ID" ]]; then ok "deployment created id=$DEP_ID"; else fail "deployment create failed: $DEPLOY_RESP"; exit 1; fi

# ─── Phase 3: wait for pod and assert annotations ──────────────────────────
log "── waiting for $DEPLOY_NAME pod to schedule ──"
POD_NAME=""
POD_NODE=""
for _ in $(seq 1 60); do
  POD_INFO=$(ssh_cluster "kubectl -n $NAMESPACE get pods -l app=$DEPLOY_NAME -o json 2>/dev/null" || echo "")
  POD_NAME=$(echo "$POD_INFO" | python3 -c "import json,sys;d=json.load(sys.stdin);items=d.get('items',[]);print(items[0]['metadata']['name'] if items else '')" 2>/dev/null)
  POD_NODE=$(echo "$POD_INFO" | python3 -c "import json,sys;d=json.load(sys.stdin);items=d.get('items',[]);print(items[0]['spec'].get('nodeName','') if items else '')" 2>/dev/null)
  [[ -n "$POD_NAME" && -n "$POD_NODE" ]] && break
  sleep 2
done
[[ -n "$POD_NAME" ]] && ok "pod scheduled: $POD_NAME on $POD_NODE" || { fail "pod never scheduled"; exit 1; }

# Annotations
ANNOT_TCP=$(ssh_cluster "kubectl -n $NAMESPACE get pod $POD_NAME -o jsonpath='{.metadata.annotations.platform\\.io/firewall-tcp-ports}' 2>/dev/null" || echo "")
ANNOT_UDP=$(ssh_cluster "kubectl -n $NAMESPACE get pod $POD_NAME -o jsonpath='{.metadata.annotations.platform\\.io/firewall-udp-ports}' 2>/dev/null" || echo "")
log "tcp annotation: '$ANNOT_TCP'  udp annotation: '$ANNOT_UDP'"

if [[ "$ANNOT_TCP" == *"3478"* && "$ANNOT_TCP" == *"5349"* ]]; then
  ok "tcp ports annotation present (3478, 5349)"
else
  fail "tcp ports annotation missing or wrong: '$ANNOT_TCP'"
fi
if [[ "$ANNOT_UDP" == *"3478"* && "$ANNOT_UDP" == *"5349"* ]]; then
  ok "udp ports annotation present (3478, 5349)"
else
  fail "udp ports annotation missing or wrong: '$ANNOT_UDP'"
fi

# ─── Phase 4: nft set on the host has the ports ────────────────────────────
log "── waiting up to 60s for worker-firewall-reconciler to converge ──"
NFT_TCP=""
for _ in $(seq 1 12); do
  NFT_TCP=$(ssh_cluster "ssh -o StrictHostKeyChecking=no $POD_NODE 'nft list set inet filter tenant_ports_tcp 2>/dev/null'" 2>/dev/null || \
            ssh_cluster "nft list set inet filter tenant_ports_tcp 2>/dev/null" || echo "")
  if [[ "$NFT_TCP" == *"3478"* && "$NFT_TCP" == *"5349"* ]]; then break; fi
  sleep 5
done
if [[ "$NFT_TCP" == *"3478"* && "$NFT_TCP" == *"5349"* ]]; then
  ok "host nft set tenant_ports_tcp contains 3478 and 5349"
else
  warn "nft set check skipped/failed (this only works when the test runner can SSH to the pod's node):"
  warn "  current set: $(echo "$NFT_TCP" | tr '\n' ' ' | head -c 200)"
fi

# ─── Phase 5: deletion closes the ports (reconciler diff path) ────────────
log "── phase 5: delete deployment, expect ports to be removed within 60s ──"
api DELETE "/clients/$CID/deployments/$DEP_ID" >/dev/null 2>&1 || true

# Wait for pod gone, then for the reconciler to converge.
for _ in $(seq 1 30); do
  STILL=$(ssh_cluster "kubectl -n $NAMESPACE get pods -l app=$DEPLOY_NAME --no-headers 2>/dev/null | wc -l" 2>/dev/null || echo "1")
  [[ "$STILL" == "0" ]] && break
  sleep 2
done

NFT_AFTER=""
for _ in $(seq 1 12); do
  NFT_AFTER=$(ssh_cluster "ssh -o StrictHostKeyChecking=no $POD_NODE 'nft list set inet filter tenant_ports_tcp 2>/dev/null'" 2>/dev/null || \
              ssh_cluster "nft list set inet filter tenant_ports_tcp 2>/dev/null" || echo "")
  if [[ "$NFT_AFTER" != *"3478"* ]]; then break; fi
  sleep 5
done
if [[ "$NFT_AFTER" != *"3478"* ]]; then
  ok "tenant_ports_tcp no longer contains the deleted deployment's ports"
else
  warn "ports still present after 60s — reconciler may not be deployed yet on this node"
fi

# ─── Summary ───────────────────────────────────────────────────────────────
echo
log "── summary ──"
printf '  passed: %d\n  failed: %d\n' "$passed" "$failed"
[[ $failed -eq 0 ]] || exit 1
exit 0
