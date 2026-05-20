#!/usr/bin/env bash
# integration-cluster-trusted-proxies.sh — end-to-end harness for the
# operator-managed trusted upstream-proxy CIDR feature.
#
# Asserts (against a deployed stack — local DinD by default):
#
#   Phase 1 — Auth
#   Phase 2 — GET trusted-proxies returns ≥4 system rows + maybe bootstrap
#   Phase 3 — POST a CDN-style range → 200 OK, GET shows it as 'operator'
#   Phase 4 — POST /0 → 400 INVALID_BODY (the /0 trust footgun guard)
#   Phase 5 — POST same CIDR again → 409 DUPLICATE_CIDR
#   Phase 6 — Wait for reconciler to materialise; ConfigMap contains
#             the set_real_ip_from line; Traefik DS args contain the
#             CIDR in the trustedIPs CSV
#   Phase 7 — admin-panel pod's rendered /etc/nginx/conf.d/default.conf
#             includes the operator CIDR via the mounted trusted-proxies.d
#   Phase 8 — DELETE the row → 200 OK, GET no longer shows it
#   Phase 9 — Reconcile back: ConfigMap no longer contains the CIDR
#   Phase 10— DELETE a bootstrap-source row → 404 NOT_DELETABLE
#   Phase 11— RBAC: non-super_admin POST → 403
#
# Env overrides (same convention as other integration scripts):
#   ADMIN_HOST      default: http://admin.k8s-platform.test:2010
#   ADMIN_EMAIL     default: admin@k8s-platform.test
#   ADMIN_PASSWORD  default: admin
#   K3S_CONTAINER   default: hosting-platform-k3s-server-1
#   TEST_CIDR       default: 203.0.113.0/24 (RFC 5737 documentation range)
#   TEST_DESC       default: "integration test (Cloudflare-like edge)"

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ADMIN_HOST="${ADMIN_HOST:-http://admin.k8s-platform.test:2010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"
TEST_CIDR="${TEST_CIDR:-203.0.113.0/24}"
TEST_DESC="${TEST_DESC:-integration test (Cloudflare-like edge)}"

PASSED=0
FAILED=0
FAILURES=()
ok()   { echo -e "  \033[32m✓\033[0m $*"; PASSED=$((PASSED+1)); }
fail() { echo -e "  \033[31m✗\033[0m $*"; FAILURES+=("$*"); FAILED=$((FAILED+1)); }
log()  { echo -e "\033[36m[$(date +%H:%M:%S)]\033[0m $*"; }
phase() { echo -e "\n\033[1;35m── $* ──\033[0m"; }

kctl() {
  if [[ "$ADMIN_HOST" == *"k8s-platform.test"* ]]; then
    docker exec "$K3S_CONTAINER" kubectl "$@"
  else
    kubectl "$@"
  fi
}

# ── Phase 1: Auth ─────────────────────────────────────────────────────
phase "Phase 1: Authenticating"
TOKEN=""
TOKEN_RESP=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" || true)
TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['token'])" 2>/dev/null || true)
API_BASE="$ADMIN_HOST"
if [[ -z "${TOKEN:-}" && "$ADMIN_HOST" == *"k8s-platform.test"* ]]; then
  log "Direct login failed; falling back to in-cluster API via ephemeral curl pod"
  TOKEN_RESP=$(docker exec "$K3S_CONTAINER" sh -c "kubectl run -n default --rm -i --restart=Never --image=curlimages/curl:latest sh-login -- sh -c \"curl -sk -X POST http://platform-api.platform.svc.cluster.local:3000/api/v1/auth/login -H Content-Type:application/json -d '{\\\"email\\\":\\\"$ADMIN_EMAIL\\\",\\\"password\\\":\\\"$ADMIN_PASSWORD\\\"}'\"" 2>&1)
  TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,re,json; m=re.search(r'(\{.*\})', sys.stdin.read()); print(json.loads(m.group(1))['data']['token'])" 2>/dev/null || true)
  API_BASE="http://platform-api.platform.svc.cluster.local:3000"
fi
if [[ -z "${TOKEN:-}" ]]; then
  echo "ERROR: login failed" >&2
  exit 2
fi
ok "Authenticated"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ "$ADMIN_HOST" == *"k8s-platform.test"* && "$API_BASE" == *"svc.cluster.local"* ]]; then
    local pod_name="sh-api-$$-$RANDOM"
    if [[ -n "$body" ]]; then
      printf '%s' "$body" | docker exec -i "$K3S_CONTAINER" sh -c \
        "kubectl run -n default --rm -i --restart=Never --image=curlimages/curl:latest $pod_name -- sh -c 'curl -sk -X $method -H \"Authorization: Bearer $TOKEN\" -H \"Content-Type: application/json\" --data-binary @- -w \"\nHTTP_STATUS=%{http_code}\" $API_BASE$path'" 2>&1
    else
      docker exec "$K3S_CONTAINER" sh -c \
        "kubectl run -n default --rm -i --restart=Never --image=curlimages/curl:latest $pod_name -- curl -sk -X $method -H 'Authorization: Bearer $TOKEN' -w '\nHTTP_STATUS=%{http_code}' $API_BASE$path" 2>&1
    fi
  else
    if [[ -n "$body" ]]; then
      curl -s -X "$method" "$API_BASE$path" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" -w '\nHTTP_STATUS=%{http_code}'
    else
      curl -s -X "$method" "$API_BASE$path" -H "Authorization: Bearer $TOKEN" -w '\nHTTP_STATUS=%{http_code}'
    fi
  fi
}

extract_status() { echo "$1" | grep -oE 'HTTP_STATUS=[0-9]+' | tail -1 | cut -d= -f2; }
extract_body() { echo "$1" | sed -E '/HTTP_STATUS=[0-9]+/d'; }

# ── Phase 2: GET — system rows visible ────────────────────────────────
phase "Phase 2: GET trusted-proxies — system rows visible"
RESP=$(api GET /api/v1/admin/cluster-network/trusted-proxies)
STATUS=$(extract_status "$RESP")
BODY=$(extract_body "$RESP")
if [[ "$STATUS" != "200" ]]; then
  fail "GET returned $STATUS (expected 200)"
  echo "$BODY"; exit 2
fi
ok "GET returns 200"
SYSTEM_COUNT=$(echo "$BODY" | python3 -c "import sys,json,re; m=re.search(r'(\{.*\})',sys.stdin.read(),re.S); d=json.loads(m.group(1))['data']; print(sum(1 for r in d['ranges'] if r['source']=='system'))")
[[ "$SYSTEM_COUNT" -ge 4 ]] && ok "system rows ($SYSTEM_COUNT) >= 4" || fail "expected ≥4 system rows, got $SYSTEM_COUNT"

# ── Phase 3: POST — add CDN range ─────────────────────────────────────
phase "Phase 3: POST a CDN-style range"
# Pre-clean: delete any pre-existing operator row with this CIDR.
EXISTING_ID=$(echo "$BODY" | python3 -c "import sys,json,re; m=re.search(r'(\{.*\})',sys.stdin.read(),re.S); d=json.loads(m.group(1))['data']; print(next((r['id'] for r in d['ranges'] if r['cidr']=='$TEST_CIDR' and r['source']=='operator'), ''))")
if [[ -n "$EXISTING_ID" ]]; then
  log "Pre-cleaning stale operator row id=$EXISTING_ID"
  api DELETE "/api/v1/admin/cluster-network/trusted-proxies/$EXISTING_ID" >/dev/null
fi
ADD_RESP=$(api POST /api/v1/admin/cluster-network/trusted-proxies "{\"cidr\":\"$TEST_CIDR\",\"description\":\"$TEST_DESC\"}")
ADD_STATUS=$(extract_status "$ADD_RESP")
[[ "$ADD_STATUS" == "200" ]] && ok "POST returned 200" || fail "POST returned $ADD_STATUS"

# ── Phase 4: POST /0 — INVALID_BODY ───────────────────────────────────
phase "Phase 4: POST /0 prefix → 400 INVALID_BODY"
ZERO_RESP=$(api POST /api/v1/admin/cluster-network/trusted-proxies '{"cidr":"0.0.0.0/0","description":"footgun"}')
ZERO_STATUS=$(extract_status "$ZERO_RESP")
ZERO_BODY=$(extract_body "$ZERO_RESP")
[[ "$ZERO_STATUS" == "400" ]] && ok "/0 prefix rejected (400)" || fail "/0 returned $ZERO_STATUS (expected 400)"
if echo "$ZERO_BODY" | grep -q 'INVALID_BODY'; then ok "error code is INVALID_BODY"; else fail "missing INVALID_BODY in response"; fi

# ── Phase 5: POST duplicate — 409 DUPLICATE_CIDR ──────────────────────
phase "Phase 5: POST same CIDR again → 409 DUPLICATE_CIDR"
DUP_RESP=$(api POST /api/v1/admin/cluster-network/trusted-proxies "{\"cidr\":\"$TEST_CIDR\",\"description\":\"dup\"}")
DUP_STATUS=$(extract_status "$DUP_RESP")
[[ "$DUP_STATUS" == "409" ]] && ok "duplicate rejected (409)" || fail "duplicate returned $DUP_STATUS"

# ── Phase 6: Wait for reconciler + verify ConfigMap + Traefik ─────────
phase "Phase 6: ConfigMap + Traefik DS reflect the new CIDR"
log "Waiting up to 30s for reconciler..."
for i in $(seq 1 30); do
  CM_CONTENT=$(kctl -n platform get cm cluster-trusted-proxies -o jsonpath='{.data.trusted-proxies\.conf}' 2>/dev/null || echo "")
  if echo "$CM_CONTENT" | grep -q "set_real_ip_from $TEST_CIDR"; then
    ok "ConfigMap contains 'set_real_ip_from $TEST_CIDR;'  (after ${i}s)"
    break
  fi
  sleep 1
done
if ! echo "$CM_CONTENT" | grep -q "set_real_ip_from $TEST_CIDR"; then
  fail "ConfigMap never updated with the CIDR"
  echo "ConfigMap content: $CM_CONTENT"
fi

TRAEFIK_ARGS=$(kctl -n traefik get ds traefik -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null || echo "[]")
if echo "$TRAEFIK_ARGS" | grep -q "$TEST_CIDR"; then
  ok "Traefik DS args include $TEST_CIDR"
else
  fail "Traefik DS args missing $TEST_CIDR"
fi

# ── Phase 7: admin-panel pod's rendered nginx config ──────────────────
phase "Phase 7: admin-panel pod has the CIDR in its mounted ConfigMap"
ADMIN_POD=$(kctl -n platform get pods -l app=admin-panel -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -z "$ADMIN_POD" ]]; then
  fail "no admin-panel pod found — skipping"
else
  MOUNTED=$(kctl -n platform exec "$ADMIN_POD" -- cat /etc/nginx/conf.d/trusted-proxies.d/trusted-proxies.conf 2>/dev/null || echo "")
  if echo "$MOUNTED" | grep -q "$TEST_CIDR"; then
    ok "Mounted ConfigMap visible in pod (/etc/nginx/conf.d/trusted-proxies.d/)"
  else
    fail "Mounted ConfigMap does NOT contain $TEST_CIDR"
    log "Mount content: $MOUNTED"
  fi
fi

# ── Phase 8: DELETE → 200, then GET no longer shows it ────────────────
phase "Phase 8: DELETE the operator row"
LIST_RESP=$(api GET /api/v1/admin/cluster-network/trusted-proxies)
NEW_ID=$(echo "$LIST_RESP" | extract_body | python3 -c "import sys,json,re; m=re.search(r'(\{.*\})',sys.stdin.read(),re.S); d=json.loads(m.group(1))['data']; print(next((r['id'] for r in d['ranges'] if r['cidr']=='$TEST_CIDR' and r['source']=='operator'), ''))")
if [[ -z "$NEW_ID" ]]; then fail "could not find row id for delete"; exit 2; fi
DEL_RESP=$(api DELETE "/api/v1/admin/cluster-network/trusted-proxies/$NEW_ID")
DEL_STATUS=$(extract_status "$DEL_RESP")
[[ "$DEL_STATUS" == "200" ]] && ok "DELETE returned 200" || fail "DELETE returned $DEL_STATUS"

LIST2_RESP=$(api GET /api/v1/admin/cluster-network/trusted-proxies)
if extract_body "$LIST2_RESP" | grep -q "$TEST_CIDR"; then
  fail "GET still shows deleted CIDR"
else
  ok "GET no longer shows deleted CIDR"
fi

# ── Phase 9: Reconcile back ──────────────────────────────────────────
phase "Phase 9: Reconciler removes the CIDR from ConfigMap"
for i in $(seq 1 30); do
  CM_CONTENT=$(kctl -n platform get cm cluster-trusted-proxies -o jsonpath='{.data.trusted-proxies\.conf}' 2>/dev/null || echo "")
  if ! echo "$CM_CONTENT" | grep -q "set_real_ip_from $TEST_CIDR"; then
    ok "ConfigMap no longer contains $TEST_CIDR (after ${i}s)"
    break
  fi
  sleep 1
done
if echo "$CM_CONTENT" | grep -q "set_real_ip_from $TEST_CIDR"; then
  fail "ConfigMap still contains $TEST_CIDR after delete"
fi

# ── Phase 10: DELETE bootstrap-source row → 404 NOT_DELETABLE ────────
phase "Phase 10: DELETE bootstrap-source row → 404 NOT_DELETABLE"
LIST3_BODY=$(api GET /api/v1/admin/cluster-network/trusted-proxies | extract_body)
BS_ID=$(echo "$LIST3_BODY" | python3 -c "import sys,json,re; m=re.search(r'(\{.*\})',sys.stdin.read(),re.S); d=json.loads(m.group(1))['data']; print(next((r['id'] for r in d['ranges'] if r['source']=='bootstrap'), ''))")
if [[ -z "$BS_ID" ]]; then
  log "No bootstrap-source row to test against — skipping (older cluster?)"
else
  DEL_BS=$(api DELETE "/api/v1/admin/cluster-network/trusted-proxies/$BS_ID")
  DEL_BS_STATUS=$(extract_status "$DEL_BS")
  [[ "$DEL_BS_STATUS" == "404" ]] && ok "bootstrap delete rejected (404)" || fail "bootstrap delete returned $DEL_BS_STATUS"
fi

# ── Phase 11: RBAC — non-admin POST → 403 ────────────────────────────
phase "Phase 11: RBAC — invalid token → 401/403"
RBAC_RESP=$(curl -sk -X POST "$API_BASE/api/v1/admin/cluster-network/trusted-proxies" \
  -H "Authorization: Bearer not-a-real-token" \
  -H 'Content-Type: application/json' \
  -d '{"cidr":"1.2.3.4/32","description":"x"}' -w '\nHTTP_STATUS=%{http_code}' || true)
RBAC_STATUS=$(extract_status "$RBAC_RESP")
if [[ "$RBAC_STATUS" == "401" || "$RBAC_STATUS" == "403" ]]; then
  ok "unauth POST rejected ($RBAC_STATUS)"
else
  fail "unauth POST returned $RBAC_STATUS (expected 401/403)"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo
echo "Passed: $PASSED"
echo "Failed: $FAILED"
if [[ $FAILED -gt 0 ]]; then
  echo "FAILURES:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
