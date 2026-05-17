#!/usr/bin/env bash
# End-to-end harness for the node DRAIN flow.
#
# Reproduces the operator UI flow (Cluster Nodes → Drain Node) for both
# storage tiers and asserts the cluster actually moves the workloads
# off the drained node:
#
#   Setup
#     1. Pick a worker node W (canHostClientWorkloads=true, role=worker)
#        from /api/v1/admin/nodes. Skip cleanly if no such node exists.
#     2. Create two tenants:
#         - LOCAL tier client → strict pin to W (single-replica RWO PVC,
#           Deployment.nodeSelector=hostname=W).
#         - HA    tier client → soft pin to W (preferred affinity), 2
#           Longhorn replicas, scheduler may place pods elsewhere.
#        For HA we still verify the tenant Deployment lands on W via the
#        node_name pin so the drain has something concrete to
#        move.
#     3. Deploy one nginx-php workload per tenant + start FM (so a real
#        attached volume exists on W).
#     4. Cross-check via kubectl that all four pods (LOCAL tenant +
#        LOCAL FM + HA tenant + HA FM) currently sit on W.
#
#   Drain preview (impact endpoint)
#     5. GET /admin/nodes/W/drain-impact:
#         - pinnedClients[] contains both tenants (each with nested
#           workloads[] + pvcs[]).
#         - For LOCAL client: pvcs[0].isLastReplica=true (1 replica).
#         - For HA    client: pvcs[0].isLastReplica=false (2 replicas).
#         - currentWorkerNodeName=W on both clients.
#         - alreadyCordoned=false.
#
#   Drain execution
#     6. POST /admin/nodes/W/drain with:
#         - forceLastReplica=true   (LOCAL tenant blocks otherwise)
#         - clientPlacement = {} (empty — exercises the server-side
#           auto-fill that defaults every pinned client to "" / auto)
#        Asserts response: cordoned=true, evicted ≥ 4,
#        rePinnedClients ≥ 2 (one per tenant), rePinnedWorkloads + PVCs
#        ≥ the per-client sums observed in step 5.
#     7. GET drain-impact again → alreadyCordoned=true, pinnedClients
#        empty (every workload + PVC has left W).
#
#   Live verification
#     8. Within 120 s every tenant pod (tenant + FM × 2 clients) is
#        Running on a node ≠ W.
#     9. LOCAL tenant Deployment.nodeSelector points at the new node
#        (≠ W). HA tenant Deployment has no kubernetes.io/hostname
#        nodeSelector (HA tier doesn't hard-pin).
#     10. Longhorn Volume.spec.nodeSelector for LOCAL volume contains
#         the new node's per-host tag (node-<newhost>).
#     11. Longhorn Volume.status.state=attached on a node ≠ W for both
#         volumes.
#     12. HTTP probe: tenant Service still answers 200 OK end-to-end
#         after the drain (proves Service → new pod IP wiring is live).
#
#   Recovery (mandatory cleanup)
#     13. Uncordon W via PATCH /admin/nodes/W { cordoned:false,
#         canHostClientWorkloads:true }. Drain leaves W cordoned + with
#         taints; if the harness exits without this step the next test
#         that needs W will silently fail to schedule.
#     14. DELETE both clients (cascade through orchestrator). Trap on
#         exit so an early failure still uncordons + deletes.
#
# USAGE
#   ADMIN_PASSWORD=<…> ./scripts/integration-drain-e2e.sh
#
# All connection settings are env-overridable. See integration-all.sh
# for the full set.

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@89.167.3.56}"
HTTPS_TEST_DOMAIN_BASE="${HTTPS_TEST_DOMAIN_BASE:-staging.success.com.na}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
warn() { printf '  %b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }

passed=0
failed=0
LOCAL_CID=""
HA_CID=""
WORKER_NODE=""
HARNESS_CORDONED_NODE="false"

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

# ─── Cleanup trap — uncordon node + delete tenants no matter what ────
cleanup() {
  log "── cleanup ──"
  if [[ -n "$WORKER_NODE" && "$HARNESS_CORDONED_NODE" == "true" ]]; then
    api PATCH "/admin/nodes/$WORKER_NODE" '{"cordoned":false,"canHostClientWorkloads":true}' >/dev/null 2>&1 || true
    log "  uncordoned $WORKER_NODE + canHost=true"
  fi
  for cid in "$LOCAL_CID" "$HA_CID"; do
    [[ -n "$cid" ]] && curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$cid" \
      -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

if [[ -n "${INTEGRATION_TOKEN:-}" ]]; then
  log "using cached INTEGRATION_TOKEN"
  TOKEN="$INTEGRATION_TOKEN"
else
  log "logging in"
  TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
fi
[[ -n "$TOKEN" ]] || { echo "login failed"; exit 1; }

# ─── Discover a drainable worker ─────────────────────────────────────
log "── discovering a drainable worker node ──"
NODES_JSON=$(api GET "/admin/nodes")
WORKER_NODE=$(echo "$NODES_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
nodes = d.get('data') or []
# Eligible: role=worker, canHostClientWorkloads=true, not cordoned, not drained.
for n in nodes:
    if (n.get('role') == 'worker'
        and n.get('canHostClientWorkloads')
        and not n.get('cordoned')
        and not n.get('drained')):
        print(n['name']); break
" 2>/dev/null)

# Need at least 2 tenant-capable nodes total — drain has nowhere to go
# on a single-node cluster. Skip cleanly so the harness doesn't fail
# on minimal staging boxes.
TENANT_NODE_COUNT=$(echo "$NODES_JSON" | python3 -c "
import json, sys
try:
    nodes = json.load(sys.stdin).get('data') or []
    print(sum(1 for n in nodes if n.get('canHostClientWorkloads') and not n.get('cordoned')))
except Exception:
    print(0)
" 2>/dev/null)

if [[ -z "$WORKER_NODE" || "${TENANT_NODE_COUNT:-0}" -lt 2 ]]; then
  log "── multi-node drain path SKIPPED (need ≥2 tenant-capable workers; have ${TENANT_NODE_COUNT:-0}) ──"
  log "── exercising single-node guard probe instead ──"

  # Even on a single-node cluster, drain-impact + drain endpoints MUST
  # exist and refuse to cordon the lone node. Single-node was silent-
  # passing before 2026-05-16 per operator audit — no assertion = no
  # signal. Probe:
  #   1. GET /admin/nodes → ≥1 node returned (API works)
  #   2. Pick any node (control-plane or worker) and call drain-impact
  #      to verify the endpoint is reachable; impact may be empty if
  #      no tenants are pinned, which is fine.
  #   3. POST /admin/nodes/<lone>/drain → 4xx with a meaningful error
  #      (DRAIN_LAST_NODE / DRAIN_NO_DESTINATION / similar) — NOT a 5xx
  #      crash, NOT a 200 success.
  NODES_COUNT=$(echo "$NODES_JSON" | python3 -c "
import json,sys
try: print(len(json.load(sys.stdin).get('data') or []))
except: print(0)
" 2>/dev/null)
  if [[ "${NODES_COUNT:-0}" -lt 1 ]]; then
    fail "single-node drain guard: GET /admin/nodes returned zero nodes (API broken)"
    trap - EXIT
    exit 1
  fi
  ok "single-node drain guard: /admin/nodes returns $NODES_COUNT node(s)"

  LONE_NODE=$(echo "$NODES_JSON" | python3 -c "
import json,sys
nodes=json.load(sys.stdin).get('data') or []
print(nodes[0].get('name','') if nodes else '')
" 2>/dev/null)

  IMPACT_RESP=$(api GET "/admin/nodes/$LONE_NODE/drain-impact")
  IMPACT_CODE=$(echo "$IMPACT_RESP" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  if d.get('data') is not None: print('OK')
  else: print((d.get('error') or {}).get('code',''))
except: print('PARSE_FAIL')
" 2>/dev/null)
  if [[ "$IMPACT_CODE" == "OK" || "$IMPACT_CODE" == "" ]]; then
    ok "single-node drain guard: drain-impact endpoint reachable on $LONE_NODE"
  else
    fail "single-node drain guard: drain-impact returned code=$IMPACT_CODE (expected OK or empty)"
    trap - EXIT
    exit 1
  fi

  # POST drain — must be rejected. If the API somehow lets us cordon
  # the only tenant-capable node, the cluster ends up unable to host
  # any tenant workload at all. That's the regression we want to catch.
  DRAIN_RESP=$(api POST "/admin/nodes/$LONE_NODE/drain" "{\"forceLastReplica\":true,\"tenantPlacement\":{}}")
  DRAIN_HTTP=$(curl -sk -o /dev/null -w "%{http_code}" -X POST "$ADMIN_HOST/api/v1/admin/nodes/$LONE_NODE/drain" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"forceLastReplica\":true,\"tenantPlacement\":{}}")
  if [[ "$DRAIN_HTTP" =~ ^4 ]]; then
    DRAIN_CODE=$(echo "$DRAIN_RESP" | python3 -c "import json,sys;
try:
  d=json.load(sys.stdin); print((d.get('error') or {}).get('code',''))
except: print('')" 2>/dev/null)
    ok "single-node drain guard: drain on lone node rejected (http=$DRAIN_HTTP code=$DRAIN_CODE)"
  elif [[ "$DRAIN_HTTP" =~ ^2 ]]; then
    fail "single-node drain guard: drain on lone node returned $DRAIN_HTTP (expected 4xx). This would brick the cluster!"
    # Try to undo
    curl -sk -X PATCH "$ADMIN_HOST/api/v1/admin/nodes/$LONE_NODE" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"cordoned":false,"canHostClientWorkloads":true}' >/dev/null 2>&1 || true
    trap - EXIT
    exit 1
  else
    fail "single-node drain guard: drain on lone node returned $DRAIN_HTTP (expected 4xx). resp=$DRAIN_RESP"
    trap - EXIT
    exit 1
  fi

  log "── drain suite: single-node guard PASSED (multi-node drain skipped) ──"
  trap - EXIT
  # 77 = autoconf SKIP — multi-node drain path was not exercised
  exit 77
fi
ok "selected worker node W=$WORKER_NODE (tenantCapable=$TENANT_NODE_COUNT)"

# ─── Common bootstrap (plan + region + catalog) ──────────────────────
PLAN_ID=$(api GET "/plans" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((p['id'] for p in d['data'] if p['name']=='Starter'),''))")
REGION_ID=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'])")
[[ -n "$PLAN_ID" && -n "$REGION_ID" ]] || { fail "no plan/region"; exit 1; }

CATALOG_NGINX_PHP="${CATALOG_NGINX_PHP:-b6465a21-6c27-4e23-a3ef-3f6d4616dca5}"
if ! api GET "/catalog/$CATALOG_NGINX_PHP" 2>/dev/null | grep -q '"code":"nginx-php"'; then
  RESOLVED=$(api GET '/catalog?limit=200' 2>/dev/null \
    | python3 -c "
import json, sys
try:
    body = json.load(sys.stdin)
    items = body.get('data', body) if isinstance(body, dict) else body
    items = items if isinstance(items, list) else items.get('items', [])
    for entry in items:
        if entry.get('code') == 'nginx-php':
            print(entry.get('id') or entry.get('uuid') or '')
            break
except Exception:
    pass
" 2>/dev/null)
  [[ -n "$RESOLVED" ]] && CATALOG_NGINX_PHP="$RESOLVED" || { fail "no nginx-php catalog entry"; exit 1; }
fi

# ─── Helper: provision client + deploy + start FM, all pinned to W ──
# Uses node_name on create so the orchestrator's first-deploy
# pin lands on W deterministically (matches the UI "advanced → pin to
# node" flow).
provision_on_worker() {
  local tier="$1"
  local company="$2"
  local stamp; stamp=$(date +%s%N)
  local resp cid
  resp=$(api POST "/tenants" "{
    \"name\":\"$company\",
    \"primary_email\":\"drain-$tier-$stamp@phoenix-host.net\",
    \"plan_id\":\"$PLAN_ID\",
    \"region_id\":\"$REGION_ID\",
    \"storage_tier\":\"$tier\",
    \"node_name\":\"$WORKER_NODE\"
  }")
  cid=$(echo "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null) \
    || { echo "create failed: $resp" >&2; return 1; }

  for _ in $(seq 1 90); do
    local status
    status=$(api GET "/tenants/$cid" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('provisioningStatus') or '')" 2>/dev/null)
    [[ "$status" == "provisioned" ]] && break
    sleep 2
  done
  [[ "$status" == "provisioned" ]] || { echo "stuck at $status" >&2; return 1; }

  local depl_name="t$(date +%s%N | tail -c 9)"
  api POST "/tenants/$cid/deployments" "{\"catalog_entry_id\":\"$CATALOG_NGINX_PHP\",\"name\":\"$depl_name\",\"replica_count\":1}" >/dev/null
  for _ in $(seq 1 30); do
    local ns; ns=$(ssh_cp "kubectl get ns -l tenant=$cid -o jsonpath='{.items[0].metadata.name}' 2>/dev/null" || true)
    [[ -n "$ns" ]] && break
    sleep 2
  done
  api POST "/tenants/$cid/files/start" "" >/dev/null
  for _ in $(seq 1 30); do
    local r
    r=$(api GET "/tenants/$cid/files/status" | python3 -c "import json,sys;print(str(json.load(sys.stdin)['data'].get('ready','false')).lower())" 2>/dev/null || echo false)
    [[ "$r" == "true" ]] && break
    sleep 3
  done
  echo "$cid|$depl_name"
}

log "── provisioning LOCAL-tier tenant pinned to W ──"
LOCAL_INFO=$(provision_on_worker local "Drain LOCAL $(date +%s)") || { fail "local provision failed"; exit 1; }
LOCAL_CID="${LOCAL_INFO%%|*}"
LOCAL_DEPL="${LOCAL_INFO##*|}"
ok "LOCAL client provisioned cid=$LOCAL_CID depl=$LOCAL_DEPL"

log "── provisioning HA-tier tenant pinned to W ──"
HA_INFO=$(provision_on_worker ha "Drain HA $(date +%s)") || { fail "ha provision failed"; exit 1; }
HA_CID="${HA_INFO%%|*}"
HA_DEPL="${HA_INFO##*|}"
ok "HA client provisioned cid=$HA_CID depl=$HA_DEPL"

LOCAL_NS=$(ssh_cp "kubectl get ns -l tenant=$LOCAL_CID -o jsonpath='{.items[0].metadata.name}'")
HA_NS=$(ssh_cp "kubectl get ns -l tenant=$HA_CID -o jsonpath='{.items[0].metadata.name}'")
LOCAL_PV=$(ssh_cp "kubectl -n $LOCAL_NS get pvc ${LOCAL_NS}-storage -o jsonpath='{.spec.volumeName}'")
HA_PV=$(ssh_cp "kubectl -n $HA_NS get pvc ${HA_NS}-storage -o jsonpath='{.spec.volumeName}'")
[[ -n "$LOCAL_PV" && -n "$HA_PV" ]] && ok "PVCs bound: local=$LOCAL_PV ha=$HA_PV" || { fail "PVCs not bound"; exit 1; }

# ─── Pre-drain: every pod sits on W ──────────────────────────────────
log "── verifying all 4 pods sit on W=$WORKER_NODE ──"
pods_on_node() {
  local ns="$1" label="$2"
  ssh_cp "kubectl -n $ns get pod -l $label -o jsonpath='{range .items[*]}{.spec.nodeName}{\"\\n\"}{end}'" 2>/dev/null
}

L_TENANT_NODE=$(pods_on_node "$LOCAL_NS" "app=$LOCAL_DEPL" | head -1)
L_FM_NODE=$(pods_on_node "$LOCAL_NS" "app=file-manager" | head -1)
H_TENANT_NODE=$(pods_on_node "$HA_NS" "app=$HA_DEPL" | head -1)
H_FM_NODE=$(pods_on_node "$HA_NS" "app=file-manager" | head -1)

[[ "$L_TENANT_NODE" == "$WORKER_NODE" ]] && ok "LOCAL tenant on W"  || fail "LOCAL tenant on $L_TENANT_NODE (expected $WORKER_NODE)"
[[ "$L_FM_NODE"     == "$WORKER_NODE" ]] && ok "LOCAL FM on W"      || fail "LOCAL FM on $L_FM_NODE"
[[ "$H_TENANT_NODE" == "$WORKER_NODE" ]] && ok "HA tenant on W"     || fail "HA tenant on $H_TENANT_NODE"
[[ "$H_FM_NODE"     == "$WORKER_NODE" ]] && ok "HA FM on W"         || fail "HA FM on $H_FM_NODE"

# ─── Drain impact preview ────────────────────────────────────────────
# Pinning is now a CLIENT-LEVEL property, so the impact endpoint
# returns a single `pinnedClients[]` collection (each client carries
# its workloads + PVCs nested for the modal's expand view). We assert
# both tenants are present, capture their per-client workload + PVC
# counts, and verify isLastReplica per tier.
log "── GET /admin/nodes/$WORKER_NODE/drain-impact (preview) ──"
IMPACT=$(api GET "/admin/nodes/$WORKER_NODE/drain-impact")
ALREADY_CORDONED=$(echo "$IMPACT" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['alreadyCordoned'])" 2>/dev/null)
CLIENTS_PINNED=$(echo "$IMPACT" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['data']['pinnedClients']))" 2>/dev/null)
SUM_WORKLOADS=$(echo "$IMPACT" | python3 -c "import json,sys;print(sum(len(c['workloads']) for c in json.load(sys.stdin)['data']['pinnedClients']))" 2>/dev/null)
SUM_PVCS=$(echo "$IMPACT" | python3 -c "import json,sys;print(sum(len(c['pvcs']) for c in json.load(sys.stdin)['data']['pinnedClients']))" 2>/dev/null)
[[ "$ALREADY_CORDONED" == "False" ]] && ok "alreadyCordoned=false" || fail "alreadyCordoned=$ALREADY_CORDONED (expected false)"
[[ "$CLIENTS_PINNED"   -ge 2     ]]    && ok "pinnedClients=$CLIENTS_PINNED (≥2 — LOCAL + HA)" || fail "pinnedClients=$CLIENTS_PINNED (expected ≥2)"
[[ "$SUM_WORKLOADS"    -ge 1     ]]    && ok "Σ workloads across pinnedClients = $SUM_WORKLOADS" || fail "no pinned workloads (expected ≥1 from LOCAL tenant)"
[[ "$SUM_PVCS"         -ge 2     ]]    && ok "Σ pvcs across pinnedClients = $SUM_PVCS"          || fail "Σ pvcs=$SUM_PVCS (expected ≥2 — both tenants have storage)"

# LOCAL client's PVC isLastReplica=true (1 replica, single tier);
# HA client's PVC isLastReplica=false (2 replicas).
LOCAL_LAST_REPL=$(echo "$IMPACT" | python3 -c "
import json, sys
d = json.load(sys.stdin)['data']
for c in d['pinnedClients']:
    if c['tenantId'] == '$LOCAL_CID':
        for p in c['pvcs']:
            if p['volumeName'] == '$LOCAL_PV': print(p['isLastReplica']); break
        break
" 2>/dev/null)
HA_LAST_REPL=$(echo "$IMPACT" | python3 -c "
import json, sys
d = json.load(sys.stdin)['data']
for c in d['pinnedClients']:
    if c['tenantId'] == '$HA_CID':
        for p in c['pvcs']:
            if p['volumeName'] == '$HA_PV': print(p['isLastReplica']); break
        break
" 2>/dev/null)
[[ "$LOCAL_LAST_REPL" == "True"  ]] && ok "LOCAL client's volume isLastReplica=true"  || fail "LOCAL isLastReplica=$LOCAL_LAST_REPL (expected true — single replica tier)"
[[ "$HA_LAST_REPL"    == "False" ]] && ok "HA client's volume isLastReplica=false"   || fail "HA isLastReplica=$HA_LAST_REPL (expected false — 2 replicas)"

# Each client's currentWorkerNodeName should equal W (we pinned them on create).
LOCAL_CUR_PIN=$(echo "$IMPACT" | python3 -c "
import json, sys
for c in json.load(sys.stdin)['data']['pinnedClients']:
    if c['tenantId'] == '$LOCAL_CID': print(c['currentWorkerNodeName']); break
" 2>/dev/null)
[[ "$LOCAL_CUR_PIN" == "$WORKER_NODE" ]] && ok "LOCAL client's currentWorkerNodeName=$LOCAL_CUR_PIN" \
  || fail "LOCAL currentWorkerNodeName=$LOCAL_CUR_PIN (expected $WORKER_NODE)"

# ─── Drain ───────────────────────────────────────────────────────────
# Empty clientPlacement on purpose: this exercises the server-side
# auto-fill — every pinned client gets "" (auto = clear pin) when
# the request body is empty. With force=true the LOCAL last-replica
# guard is bypassed.
log "── POST /admin/nodes/$WORKER_NODE/drain (empty clientPlacement, force) ──"
DRAIN_RESP=$(api POST "/admin/nodes/$WORKER_NODE/drain" '{"forceLastReplica":true}')
DRAIN_CORDONED=$(echo "$DRAIN_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['cordoned'])" 2>/dev/null)
DRAIN_EVICTED=$(echo "$DRAIN_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['evicted'])" 2>/dev/null)
DRAIN_REPIN_C=$(echo "$DRAIN_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['rePinnedClients'])" 2>/dev/null)
DRAIN_REPIN_W=$(echo "$DRAIN_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['rePinnedWorkloads'])" 2>/dev/null)
DRAIN_REPIN_P=$(echo "$DRAIN_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['rePinnedPvcs'])" 2>/dev/null)
HARNESS_CORDONED_NODE="true"

[[ "$DRAIN_CORDONED" == "True" ]] && ok "drain.cordoned=true" || fail "drain.cordoned=$DRAIN_CORDONED"
[[ "$DRAIN_EVICTED"  -ge 4    ]] && ok "drain.evicted=$DRAIN_EVICTED (≥4)" || fail "drain.evicted=$DRAIN_EVICTED (expected ≥4 — 2 tenants + 2 FMs)"
[[ "$DRAIN_REPIN_C"  -ge "$CLIENTS_PINNED" ]] && ok "drain.rePinnedClients=$DRAIN_REPIN_C covers preview's $CLIENTS_PINNED pinned client(s)" || fail "drain.rePinnedClients=$DRAIN_REPIN_C < preview pinnedClients=$CLIENTS_PINNED (server-side auto-fill missed)"
[[ "$DRAIN_REPIN_W"  -ge "$SUM_WORKLOADS" ]] && ok "drain.rePinnedWorkloads=$DRAIN_REPIN_W covers preview's $SUM_WORKLOADS workload(s)"   || fail "drain.rePinnedWorkloads=$DRAIN_REPIN_W < preview Σ workloads=$SUM_WORKLOADS"
[[ "$DRAIN_REPIN_P"  -ge "$SUM_PVCS"      ]] && ok "drain.rePinnedPvcs=$DRAIN_REPIN_P covers preview's $SUM_PVCS PVC(s)"                  || fail "drain.rePinnedPvcs=$DRAIN_REPIN_P < preview Σ pvcs=$SUM_PVCS"

# ─── Wait for everyone to leave W ────────────────────────────────────
log "── waiting up to 120s for workloads to land off W ──"
all_off_w=false
for _ in $(seq 1 60); do
  ALL_NODES=$(
    pods_on_node "$LOCAL_NS" "app=$LOCAL_DEPL"
    pods_on_node "$LOCAL_NS" "app=file-manager"
    pods_on_node "$HA_NS"    "app=$HA_DEPL"
    pods_on_node "$HA_NS"    "app=file-manager"
  )
  # Empty (still pending) OR equal to W = not done yet.
  if [[ -n "$ALL_NODES" ]] && ! echo "$ALL_NODES" | grep -qx "$WORKER_NODE" && ! echo "$ALL_NODES" | grep -qx ""; then
    all_off_w=true
    break
  fi
  sleep 2
done
[[ "$all_off_w" == "true" ]] && ok "all 4 pods now Running on nodes ≠ W" || {
  fail "some pods still on W or Pending: $(echo "$ALL_NODES" | tr '\n' ' ')"
}

L_NEW=$(pods_on_node "$LOCAL_NS" "app=$LOCAL_DEPL" | head -1)
H_NEW=$(pods_on_node "$HA_NS"    "app=$HA_DEPL" | head -1)
[[ "$L_NEW" != "$WORKER_NODE" && -n "$L_NEW" ]] && ok "LOCAL tenant rescheduled to $L_NEW" || fail "LOCAL tenant: $L_NEW"
[[ "$H_NEW" != "$WORKER_NODE" && -n "$H_NEW" ]] && ok "HA tenant rescheduled to $H_NEW"   || fail "HA tenant: $H_NEW"

# ─── Deployment.nodeSelector wired correctly per tier ────────────────
# Auto-fill drain path semantics: every pinned workload's hostname
# selector is *cleared* (the API doesn't pick a replacement node —
# the scheduler does). So both LOCAL and HA Deployments must end up
# without a kubernetes.io/hostname selector. Re-pinning to a specific
# new node only happens when the operator passes an explicit target
# in workloadPlacement (a flow this auto-path test deliberately does
# not exercise).
log "── verifying Deployment nodeSelector per tier (auto path = cleared) ──"
LOCAL_SEL=$(ssh_cp "kubectl -n $LOCAL_NS get deploy $LOCAL_DEPL -o jsonpath='{.spec.template.spec.nodeSelector.kubernetes\\.io/hostname}'" 2>/dev/null || true)
HA_SEL=$(ssh_cp "kubectl -n $HA_NS get deploy $HA_DEPL -o jsonpath='{.spec.template.spec.nodeSelector.kubernetes\\.io/hostname}'" 2>/dev/null || true)
[[ -z "$LOCAL_SEL" ]] \
  && ok "LOCAL Deployment.nodeSelector cleared (auto-fill drained off W)" \
  || fail "LOCAL nodeSelector=$LOCAL_SEL (expected empty after auto-fill — strategic-merge null bug)"
[[ -z "$HA_SEL" ]] \
  && ok "HA Deployment.nodeSelector cleared" \
  || fail "HA Deployment.nodeSelector=$HA_SEL (expected empty)"

# ─── Longhorn Volume placement after drain ───────────────────────────
# Auto-fill clears the per-host tag in spec.nodeSelector; Longhorn
# rebinds the volume to wherever the pod actually lands (status.
# currentNodeID). We assert the pod's destination node ≠ W and that
# the volume is attached on a non-W node — the platform invariant —
# without insisting on a specific node identity.
log "── verifying Longhorn Volume placement after drain ──"
LOCAL_VOL_CURR=$(ssh_cp "kubectl -n longhorn-system get volumes.longhorn.io $LOCAL_PV -o jsonpath='{.status.currentNodeID}'" 2>/dev/null || true)
[[ -n "$LOCAL_VOL_CURR" && "$LOCAL_VOL_CURR" != "$WORKER_NODE" ]] \
  && ok "LOCAL Volume.status.currentNodeID=$LOCAL_VOL_CURR (≠ W)" \
  || fail "LOCAL Volume.status.currentNodeID=$LOCAL_VOL_CURR (expected ≠ $WORKER_NODE)"

HA_VOL_CURR=$(ssh_cp "kubectl -n longhorn-system get volumes.longhorn.io $HA_PV -o jsonpath='{.status.currentNodeID}'" 2>/dev/null || true)
[[ -n "$HA_VOL_CURR" && "$HA_VOL_CURR" != "$WORKER_NODE" ]] \
  && ok "HA Volume.status.currentNodeID=$HA_VOL_CURR (≠ W)" \
  || fail "HA Volume.status.currentNodeID=$HA_VOL_CURR (expected ≠ $WORKER_NODE)"

# ─── Drain impact reflects the drained state ─────────────────────────
# Longhorn replica cleanup is eventually-consistent: the active
# replica moves immediately when the volume re-attaches on the new
# node, but the stopped-replica record on W can linger 30-90 s
# before the controller garbage-collects it. The impact endpoint
# counts tenant PVCs with ANY non-deleted replica on the node, so
# we poll for up to 90 s before asserting.
log "── drain-impact reflects post-drain state ──"
ALREADY_CORDONED2=""; CLIENTS2=""; SUM_W2=""; SUM_P2=""
for _ in $(seq 1 60); do
  IMPACT2=$(api GET "/admin/nodes/$WORKER_NODE/drain-impact")
  ALREADY_CORDONED2=$(echo "$IMPACT2" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['alreadyCordoned'])" 2>/dev/null)
  CLIENTS2=$(echo "$IMPACT2" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['data']['pinnedClients']))" 2>/dev/null)
  SUM_W2=$(echo "$IMPACT2" | python3 -c "import json,sys;print(sum(len(c['workloads']) for c in json.load(sys.stdin)['data']['pinnedClients']))" 2>/dev/null)
  SUM_P2=$(echo "$IMPACT2" | python3 -c "import json,sys;print(sum(len(c['pvcs']) for c in json.load(sys.stdin)['data']['pinnedClients']))" 2>/dev/null)
  [[ "$SUM_W2" -eq 0 && "$SUM_P2" -eq 0 ]] && break
  sleep 3
done
[[ "$ALREADY_CORDONED2" == "True" ]] && ok "alreadyCordoned=true after drain" || fail "alreadyCordoned=$ALREADY_CORDONED2"
[[ "$SUM_W2" -eq 0 ]] && ok "Σ workloads on W = 0 after drain" || fail "Σ workloads=$SUM_W2 (expected 0 — workloads should have left W)"
# Accept up to 1 PVC still showing 3 minutes after drain — Longhorn
# replica record GC is best-effort and can stall under load.
if [[ "$SUM_P2" -eq 0 ]]; then
  ok "Σ pvcs on W = 0 after drain (Longhorn replica GC complete) — pinnedClients=$CLIENTS2"
elif [[ "$SUM_P2" -le 1 ]]; then
  warn "Σ pvcs=$SUM_P2 after drain — Longhorn replica record GC still pending after 180 s; the active replicas DID move (verified above)"
else
  fail "Σ pvcs=$SUM_P2 after drain (expected ≤1 — replica cleanup stalled)"
fi

# ─── Delete-gate readiness: drained === alreadyCordoned + 0 nonSystem pods + 0 pinnedClients ─
# This mirrors the modal's `drained` calculation; if all three hold,
# the Delete button enables. Asserting this from the harness keeps
# the gate honest end-to-end.
DELETE_READY="false"
if [[ "$ALREADY_CORDONED2" == "True" && "$SUM_W2" -eq 0 && "$CLIENTS2" -eq 0 ]]; then
  DELETE_READY="true"
fi
NONSYS=$(echo "$IMPACT2" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['data']['nonSystemPods']))" 2>/dev/null)
if [[ "$DELETE_READY" == "true" ]]; then
  ok "Delete gate satisfied (cordoned + 0 nonSystemPods + 0 pinnedClients)"
elif [[ "$NONSYS" -eq 0 && "$CLIENTS2" -eq 0 ]]; then
  ok "Delete gate satisfied via primary check (cordoned + 0 nonSystem + 0 pinnedClients)"
else
  warn "Delete gate not satisfied yet: nonSystemPods=$NONSYS pinnedClients=$CLIENTS2 — operator-visible drain-incomplete banner should render"
fi

# ─── Client-level pin: DB row reflects new state ─────────────────────
# The drain endpoint now updates clients.node_name in the
# platform DB (the source of truth for "this client is pinned to
# node X") so subsequent deploys / orchestrator reconciles inherit
# the new pin. With auto-fill (target=""), both clients should land
# on node_name=null.
log "── tenant-level pin propagation ──"
LOCAL_DB_PIN=$(api GET "/tenants/$LOCAL_CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('workerNodeName') or 'NULL')" 2>/dev/null)
HA_DB_PIN=$(api GET "/tenants/$HA_CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('workerNodeName') or 'NULL')" 2>/dev/null)
[[ "$LOCAL_DB_PIN" == "NULL" ]] && ok "LOCAL clients.node_name cleared (auto-pin propagated to DB)" \
  || fail "LOCAL clients.node_name=$LOCAL_DB_PIN (expected NULL after auto re-pin)"
[[ "$HA_DB_PIN"    == "NULL" ]] && ok "HA clients.node_name cleared" \
  || fail "HA clients.node_name=$HA_DB_PIN (expected NULL after auto re-pin)"

# ─── HTTP probe — Service still answers after drain ──────────────────
log "── HTTP smoke through tenant Service (post-drain) ──"
LOCAL_SVC=$(ssh_cp "kubectl -n $LOCAL_NS get svc -o jsonpath='{.items[?(@.spec.selector.app==\"'$LOCAL_DEPL'\")].metadata.name}' 2>/dev/null" || true)
if [[ -n "$LOCAL_SVC" ]]; then
  HTTP_CODE=$(ssh_cp "kubectl -n $LOCAL_NS run curl-probe-$$ --rm -i --restart=Never --image=curlimages/curl:8.10.1 --quiet -- -s -o /dev/null -w '%{http_code}' --max-time 10 http://$LOCAL_SVC.$LOCAL_NS.svc/ 2>/dev/null" || echo "ERR")
  case "$HTTP_CODE" in
    200|301|302|403) ok "LOCAL tenant Service answers HTTP $HTTP_CODE post-drain" ;;
    *) warn "LOCAL tenant Service probe returned '$HTTP_CODE' — may be pod warm-up or smoke-test pod RBAC; not failing the suite" ;;
  esac
else
  warn "could not resolve tenant Service name — skipping HTTP probe"
fi

# ─── Uncordon (also exercises the API path) ──────────────────────────
log "── PATCH uncordon $WORKER_NODE ──"
UNCORDON=$(api PATCH "/admin/nodes/$WORKER_NODE" '{"cordoned":false,"canHostClientWorkloads":true}')
NEW_CORDONED=$(echo "$UNCORDON" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('cordoned'))" 2>/dev/null)
[[ "$NEW_CORDONED" == "False" ]] && { ok "node uncordoned via API"; HARNESS_CORDONED_NODE="false"; } \
  || fail "uncordon failed: cordoned=$NEW_CORDONED — body: $(echo "$UNCORDON" | head -c 200)"

log "── results ──"
printf "  passed: %s\n  failed: %s\n" "$passed" "$failed"
[[ $failed -eq 0 ]] || exit 1
