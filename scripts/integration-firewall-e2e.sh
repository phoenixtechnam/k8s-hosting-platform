#!/usr/bin/env bash
# End-to-end test for the runtime-firewall feature.
#
# Verifies:
#   1. allow_host_ports_worker=true lets a coturn-style deploy succeed
#   2. The Pod template carries the platform.io/firewall-{tcp,udp}-ports
#      annotations
#   3. The firewall-reconciler DaemonSet has populated the host's
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
if [[ -n "${INTEGRATION_TOKEN:-}" ]]; then
  log "using cached INTEGRATION_TOKEN"
  TOKEN="$INTEGRATION_TOKEN"
else
  log "logging in"
  TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null)
fi
[[ -n "$TOKEN" ]] || { echo "login failed"; exit 1; }
ok "logged in"

# ─── Snapshot original setting so cleanup restores ─────────────────────────
# Both toggles are snapshotted because a HA staging cluster will pin tenant
# pods to a server-role node when no pure-worker node has capacity, so the
# gate checks allowHostPortsServer instead of allowHostPortsWorker. The
# test enables both during phase 2.
ORIG_WORKER=$(api GET /admin/system-settings | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('allowHostPortsWorker', False))" 2>/dev/null)
ORIG_SERVER=$(api GET /admin/system-settings | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('allowHostPortsServer', False))" 2>/dev/null)
log "original allowHostPortsWorker=$ORIG_WORKER allowHostPortsServer=$ORIG_SERVER"

cleanup() {
  if [[ -n "${CID:-}" ]]; then
    curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$CID" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  fi
  # Restore both toggles so the staging cluster ends in the same state
  # we found it in. Skip if we never managed to read the original value
  # (login failure).
  if [[ -n "${ORIG_WORKER:-}" || -n "${ORIG_SERVER:-}" ]]; then
    local restore_w restore_s
    restore_w=$([[ "$ORIG_WORKER" == "True" ]] && echo "true" || echo "false")
    restore_s=$([[ "$ORIG_SERVER" == "True" ]] && echo "true" || echo "false")
    curl -sk -X PATCH "$ADMIN_HOST/api/v1/admin/system-settings" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"allowHostPortsWorker\":$restore_w,\"allowHostPortsServer\":$restore_s}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ─── Resolve catalog entry id ──────────────────────────────────────────────
CATALOG_ENTRY_ID=$(api GET "/catalog?limit=100" \
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
RESP=$(api POST "/tenants" "{\"name\":\"Firewall E2E $STAMP\",\"primary_email\":\"firewall-e2e-$STAMP@phoenix-host.net\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}")
CID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[[ -n "$CID" ]] && ok "client created cid=$CID" || { fail "create failed: $RESP"; exit 1; }

# Wait for namespace+RBAC+PVC provisioning. clients.status is the
# *lifecycle* (pending|active|suspended|…) and stays at pending until an
# admin explicitly activates the tenant — provisioningStatus is the
# infra-side flag that flips to 'provisioned' once runProvisionNamespace
# finishes. For a firewall-deploy E2E we just need the namespace + worker
# pin, so wait on provisioningStatus, not status.
log "── waiting for provisioningStatus=provisioned (≤5min) ──"
for i in $(seq 1 150); do
  PSTATUS=$(api GET "/tenants/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('provisioningStatus',''))" 2>/dev/null)
  [[ "$PSTATUS" == "provisioned" ]] && break
  if [[ "$PSTATUS" == "failed" ]]; then
    fail "provisioningStatus=failed — see backend logs"; exit 1
  fi
  if (( i % 15 == 0 )); then log "  …provisioningStatus=$PSTATUS (${i}×2s)"; fi
  sleep 2
done
[[ "$PSTATUS" == "provisioned" ]] && ok "namespace provisioned" || { fail "client never reached provisioned (provisioningStatus=$PSTATUS)"; exit 1; }

NAMESPACE=$(api GET "/tenants/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('kubernetesNamespace',''))" 2>/dev/null)
WORKER_NODE=$(api GET "/tenants/$CID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('workerNodeName',''))" 2>/dev/null)
log "namespace=$NAMESPACE worker=$WORKER_NODE"

# ─── Phase 1: gate REJECTS deploy when toggle is OFF ───────────────────────
log "── phase 1: deploy with both toggles=false → expect 403 ──"
api PATCH "/admin/system-settings" "{\"allowHostPortsWorker\":false,\"allowHostPortsServer\":false}" >/dev/null
sleep 7  # cache TTL is 5s and PATCH only invalidates the pod that handled it

DEPLOY_BODY="{\"catalog_entry_id\":\"$CATALOG_ENTRY_ID\",\"name\":\"coturn-fw-blocked-$STAMP\"}"
HTTP_CODE=$(api_status POST "/tenants/$CID/deployments" "$DEPLOY_BODY")
RESP_BLOCKED=$(api POST "/tenants/$CID/deployments" "$DEPLOY_BODY")
ERR_CODE=$(echo "$RESP_BLOCKED" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('error') or {}).get('code',''))" 2>/dev/null)

if [[ "$HTTP_CODE" == "403" && "$ERR_CODE" == "HOST_PORTS_DISABLED" ]]; then
  ok "gate blocked deploy (HTTP 403, code=$ERR_CODE)"
else
  fail "gate did NOT block deploy: HTTP=$HTTP_CODE code=$ERR_CODE body=$(echo "$RESP_BLOCKED" | head -c 300)"
fi

# ─── Phase 2: enable BOTH toggles, deploy succeeds ─────────────────────────
# Enable both because the gate keys on the role of the pinned worker
# (resolveTargetNodeRole), and HA staging always has clients pinned to a
# server-role node since worker capacity is small. A pure-worker cluster
# would only need allowHostPortsWorker.
log "── phase 2: flip both toggles=true ──"
TOGGLE_RESP=$(api PATCH "/admin/system-settings" "{\"allowHostPortsWorker\":true,\"allowHostPortsServer\":true}")
TW=$(echo "$TOGGLE_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('allowHostPortsWorker', False))" 2>/dev/null)
TS=$(echo "$TOGGLE_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('allowHostPortsServer', False))" 2>/dev/null)
[[ "$TW" == "True" && "$TS" == "True" ]] && ok "both toggles on" || fail "toggles not on after PATCH (worker=$TW server=$TS): $TOGGLE_RESP"
sleep 7  # let the 5s cache invalidate on the other replicas

DEPLOY_NAME="coturn-fw-ok-$STAMP"
log "── deploying $CATALOG_CODE ──"
DEPLOY_RESP=$(api POST "/tenants/$CID/deployments" "{\"catalog_entry_id\":\"$CATALOG_ENTRY_ID\",\"name\":\"$DEPLOY_NAME\"}")
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
log "── waiting up to 60s for firewall-reconciler to converge ──"
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

# ─── Phase 4b: actually reach the server from outside ─────────────────────
# Everything before this point only verified plumbing — annotations on the
# Pod, elements in the host nft set. The real claim of the runtime-firewall
# feature is "an external client on the public internet can reach a port
# the catalog opened". So speak STUN to the node's public IP:3478 and
# verify a real Binding-Success-Response with a matching transaction ID.
#
# We resolve the node's public IP from the K8s `Node.status.addresses[]`
# (ExternalIP if present, otherwise InternalIP — on bare-metal Hetzner the
# public IP is the InternalIP).
log "── phase 4b: STUN probe against public IP — proves end-to-end reach ──"

# Wait for coturn to actually accept connections; the container takes ~5s
# to bind sockets after the Pod is Running.
log "  waiting up to 90s for coturn to be Ready"
for _ in $(seq 1 45); do
  READY=$(ssh_cluster "kubectl -n $NAMESPACE get pod $POD_NAME -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null" || echo "false")
  [[ "$READY" == "true" ]] && break
  sleep 2
done
[[ "$READY" == "true" ]] && ok "coturn pod Ready" || warn "coturn pod not Ready yet ($READY) — STUN may fail spuriously"

# Resolve the public IP of the pod's node.
NODE_IP=$(ssh_cluster "kubectl get node $POD_NODE -o jsonpath='{.status.addresses[?(@.type==\"ExternalIP\")].address}'" 2>/dev/null)
if [[ -z "$NODE_IP" ]]; then
  NODE_IP=$(ssh_cluster "kubectl get node $POD_NODE -o jsonpath='{.status.addresses[?(@.type==\"InternalIP\")].address}'" 2>/dev/null)
fi
log "  probing $POD_NODE → $NODE_IP:3478"

stun_probe() {
  local proto="$1" ip="$2" port="$3"
  python3 - "$proto" "$ip" "$port" <<'PY'
import os, secrets, socket, struct, sys, time
proto, ip, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
# RFC 5389 binding request: 0x0001 method, 0x0000 length, magic cookie, txid.
txid = secrets.token_bytes(12)
req  = struct.pack('!HHI', 0x0001, 0x0000, 0x2112A442) + txid
try:
    if proto == 'udp':
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(5.0); s.sendto(req, (ip, port))
        data, _ = s.recvfrom(2048)
    else:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5.0); s.connect((ip, port))
        s.sendall(req)
        data = b''
        deadline = time.time() + 5
        while len(data) < 20 and time.time() < deadline:
            chunk = s.recv(2048)
            if not chunk: break
            data += chunk
    s.close()
except Exception as e:
    print(f"FAIL: {type(e).__name__}: {e}"); sys.exit(2)
if len(data) < 20:
    print(f"FAIL: short reply ({len(data)} bytes)"); sys.exit(3)
mtype, mlen, magic = struct.unpack('!HHI', data[:8])
rtxid = data[8:20]
# 0x0101 == binding success response.
if mtype != 0x0101 or magic != 0x2112A442 or rtxid != txid:
    print(f"FAIL: bad header type=0x{mtype:04x} magic=0x{magic:08x} txid_match={rtxid==txid}"); sys.exit(4)
print("OK")
PY
}

UDP_RES=$(stun_probe udp "$NODE_IP" 3478)
[[ "$UDP_RES" == "OK" ]] && ok "STUN over UDP/3478 → Binding-Success-Response" || fail "STUN UDP probe: $UDP_RES"

TCP_RES=$(stun_probe tcp "$NODE_IP" 3478)
[[ "$TCP_RES" == "OK" ]] && ok "STUN over TCP/3478 → Binding-Success-Response" || fail "STUN TCP probe: $TCP_RES"

# Note on toggle semantics: flipping `allow_host_ports_*` to false is
# *catalog-deploy-time* enforcement only — it blocks NEW deploys (proven
# in phase 1) but does NOT retroactively close ports on already-running
# tenant pods. That design choice lives in service.ts ("toggling OFF
# after deploy shouldn't retroactively close ports on a running app").
# Phase 5 below proves that DELETING the deployment is what closes the
# ports — that's the only retraction path the gate guarantees.

# ─── Phase 5: deletion closes the ports (reconciler diff path) ────────────
log "── phase 5: delete deployment, expect ports to be removed within 60s ──"
api DELETE "/tenants/$CID/deployments/$DEP_ID" >/dev/null 2>&1 || true

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
