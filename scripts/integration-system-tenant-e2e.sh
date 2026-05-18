#!/usr/bin/env bash
#
# ADR-040 SYSTEM tenant E2E harness.
#
# Prerequisites:
#   - DinD cluster running (./scripts/local.sh up)
#   - platform-api healthy on admin.<dev-apex>:2011
#   - default admin login available
#
# What this exercises:
#   A. SYSTEM tenant exists and is_system=TRUE in the DB
#   B. GET /tenants/:id returns isSystem=true on the response
#   C. SYSTEM appears in GET /tenants list
#   D. The platform apex is registered as a domain owned by SYSTEM
#   E. Destructive transitions are blocked:
#      E1. PATCH status:suspended → 409 SYSTEM_TENANT_PROTECTED
#      E2. PATCH status:archived → 409 SYSTEM_TENANT_PROTECTED
#      E3. PATCH subscription_expires_at → 409 SYSTEM_TENANT_PROTECTED
#      E4. DELETE → 409 SYSTEM_TENANT_PROTECTED
#   F. Bulk delete excludes SYSTEM from succeeded[] and includes it in failed[]
#   G. Reserved-subdomain enforcement:
#      G1. Create domain `admin.<apex>` under any tenant → 409 RESERVED_PLATFORM_HOSTNAME
#      G2. Create domain on the apex root → 409 RESERVED_PLATFORM_HOSTNAME
#      G3. Customer hostname OUTSIDE the apex passes (e.g. admin.acme.com)
#   H. Re-running the bootstrap endpoint is idempotent (alreadyExisted=true)
#
# Idempotent: cleans up customer test fixtures before/after; SYSTEM
# is not touched (by design).

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

API_BASE="${API_BASE:-https://dind.local:2011}"
ADMIN_HOST="${ADMIN_HOST:-admin.k8s-platform.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"

FIXTURE_PREFIX="e2e-system-tenant"
CUSTOMER_TENANT_ID=""

# ─── helpers ───────────────────────────────────────────────────────────

c_red()    { printf "\033[31m%s\033[0m" "$*"; }
c_green()  { printf "\033[32m%s\033[0m" "$*"; }
c_yellow() { printf "\033[33m%s\033[0m" "$*"; }
c_bold()   { printf "\033[1m%s\033[0m" "$*"; }

PASS=0
FAIL=0

pass() { echo "  $(c_green "✓") $1"; PASS=$((PASS+1)); }
fail() { echo "  $(c_red "✗") $1"; FAIL=$((FAIL+1)); }
note() { echo "  $(c_yellow "·") $1"; }
step() { echo; echo "$(c_bold "▸ $*")"; }

JWT=""
acquire_jwt() {
  JWT=$(curl -sk --max-time 5 -H "Host: $ADMIN_HOST" -X POST "$API_BASE/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | grep -oE '"token":"[^"]+"' | sed 's/"token":"//;s/"$//')
  [ -n "$JWT" ] || { echo "ERR: login failed"; exit 1; }
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

api() {
  local out
  out=$(api_with_status "$@")
  echo "$out" | sed '$d'
}

status_of() {
  api_with_status "$@" | tail -1
}

psql_exec() {
  docker exec -i hosting-platform-k3s-server-1 kubectl exec -n platform system-db-1 -c postgres -- \
    psql -U postgres -d hosting_platform -tA -c "$1"
}

cleanup() {
  step "Cleanup"
  if [ -n "$CUSTOMER_TENANT_ID" ]; then
    api DELETE "/api/v1/tenants/$CUSTOMER_TENANT_ID" >/dev/null 2>&1 || true
    note "deleted customer fixture $CUSTOMER_TENANT_ID"
  fi
}
trap cleanup EXIT

# ─── tests ─────────────────────────────────────────────────────────────

acquire_jwt
note "JWT acquired"

step "A. SYSTEM tenant exists in DB"
sys_row=$(psql_exec "SELECT id || '|' || name || '|' || status || '|' || is_system FROM tenants WHERE is_system = TRUE;")
if [ -n "$sys_row" ]; then
  pass "SYSTEM row present: $sys_row"
  SYSTEM_TENANT_ID=$(echo "$sys_row" | cut -d'|' -f1)
else
  fail "SYSTEM row missing — bootstrap did not run"
  exit 1
fi

step "B. GET /tenants/:id returns isSystem=true"
resp=$(api GET "/api/v1/tenants/$SYSTEM_TENANT_ID")
if echo "$resp" | grep -q '"isSystem":true'; then
  pass "isSystem=true on the response"
else
  fail "isSystem flag missing from response: $resp"
fi

step "C. SYSTEM appears in GET /tenants list"
list=$(api GET "/api/v1/tenants?limit=100")
if echo "$list" | grep -q "\"id\":\"$SYSTEM_TENANT_ID\""; then
  pass "SYSTEM visible in /tenants list"
else
  fail "SYSTEM not in list response"
fi

step "D. Apex domain owned by SYSTEM"
apex_row=$(psql_exec "SELECT d.domain_name FROM domains d JOIN tenants t ON t.id = d.tenant_id WHERE t.is_system = TRUE;")
if [ -n "$apex_row" ]; then
  pass "apex '$apex_row' owned by SYSTEM"
  APEX="$apex_row"
else
  fail "no apex domain row found for SYSTEM"
  APEX=""
fi

step "E. Destructive transitions are blocked"

# E1
status=$(status_of PATCH "/api/v1/tenants/$SYSTEM_TENANT_ID" '{"status":"suspended"}')
[ "$status" = "409" ] && pass "E1 PATCH status:suspended → 409" || fail "E1 expected 409, got $status"

# E2
status=$(status_of PATCH "/api/v1/tenants/$SYSTEM_TENANT_ID" '{"status":"archived"}')
[ "$status" = "409" ] && pass "E2 PATCH status:archived → 409" || fail "E2 expected 409, got $status"

# E3
status=$(status_of PATCH "/api/v1/tenants/$SYSTEM_TENANT_ID" '{"subscription_expires_at":"2027-01-01T00:00:00Z"}')
[ "$status" = "409" ] && pass "E3 PATCH subscription_expires_at → 409" || fail "E3 expected 409, got $status"

# E4
status=$(status_of DELETE "/api/v1/tenants/$SYSTEM_TENANT_ID")
[ "$status" = "409" ] && pass "E4 DELETE SYSTEM → 409" || fail "E4 expected 409, got $status"

step "F. Bulk delete includes SYSTEM in failed[]"
# Create a customer fixture to mix with SYSTEM in a bulk request.
PLAN_ID=$(psql_exec "SELECT id FROM hosting_plans ORDER BY monthly_price_usd ASC LIMIT 1;")
REGION_ID=$(psql_exec "SELECT id FROM regions LIMIT 1;")
create_body=$(cat <<EOF
{"name":"$FIXTURE_PREFIX-cust","primary_email":"$FIXTURE_PREFIX@example.com","plan_id":"$PLAN_ID","region_id":"$REGION_ID"}
EOF
)
cust_resp=$(api POST "/api/v1/tenants" "$create_body")
CUSTOMER_TENANT_ID=$(echo "$cust_resp" | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
[ -n "$CUSTOMER_TENANT_ID" ] && pass "customer fixture created: $CUSTOMER_TENANT_ID" || fail "customer create failed: $cust_resp"

bulk_body=$(cat <<EOF
{"tenant_ids":["$SYSTEM_TENANT_ID","$CUSTOMER_TENANT_ID"]}
EOF
)
bulk_resp=$(api POST "/api/v1/tenants/bulk/delete" "$bulk_body")
if echo "$bulk_resp" | grep -q "platform-protected"; then
  pass "F bulk delete: SYSTEM lands in failed[] with platform-protected reason"
else
  fail "F bulk delete: expected platform-protected in failed[], got: $bulk_resp"
fi

step "G. Reserved-subdomain enforcement"
if [ -z "$APEX" ]; then
  fail "skipping G — apex unknown"
else
  # G1: register `admin.<apex>` under the SYSTEM tenant (impossible),
  # but the create-domain check happens BEFORE the tenant check, so
  # we test via the customer tenant.
  # First recreate the customer (it was deleted by the bulk in F's
  # successful path — but F was supposed to FAIL for SYSTEM and SUCCEED
  # for customer, so customer is gone).
  if ! psql_exec "SELECT 1 FROM tenants WHERE id='$CUSTOMER_TENANT_ID';" | grep -q 1; then
    cust_resp=$(api POST "/api/v1/tenants" "$create_body")
    CUSTOMER_TENANT_ID=$(echo "$cust_resp" | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')
    note "re-created customer fixture: $CUSTOMER_TENANT_ID"
  fi

  status=$(status_of POST "/api/v1/tenants/$CUSTOMER_TENANT_ID/domains" \
    "{\"domain_name\":\"admin.$APEX\",\"dns_mode\":\"cname\"}")
  [ "$status" = "409" ] && pass "G1 admin.<apex> → 409 RESERVED_PLATFORM_HOSTNAME" || fail "G1 expected 409, got $status"

  status=$(status_of POST "/api/v1/tenants/$CUSTOMER_TENANT_ID/domains" \
    "{\"domain_name\":\"$APEX\",\"dns_mode\":\"cname\"}")
  [ "$status" = "409" ] && pass "G2 apex root → 409 RESERVED_PLATFORM_HOSTNAME" || fail "G2 expected 409, got $status"

  status=$(status_of POST "/api/v1/tenants/$CUSTOMER_TENANT_ID/domains" \
    '{"domain_name":"admin.acme-customer.example","dns_mode":"cname"}')
  if [ "$status" = "201" ] || [ "$status" = "200" ]; then
    pass "G3 admin.acme-customer.example (outside platform apex) → $status (allowed)"
  else
    fail "G3 expected 201/200, got $status"
  fi
fi

step "H. Idempotency of bootstrap endpoint"
if [ -n "${PLATFORM_INTERNAL_TOKEN:-}" ]; then
  ensure_resp=$(curl -sk --max-time 10 -H "Host: $ADMIN_HOST" \
    -H "Authorization: Bearer $PLATFORM_INTERNAL_TOKEN" \
    -X POST "$API_BASE/api/v1/internal/system-tenant/ensure")
  if echo "$ensure_resp" | grep -q '"alreadyExisted":true'; then
    pass "H second-call returns alreadyExisted=true"
  else
    fail "H expected alreadyExisted:true, got: $ensure_resp"
  fi
else
  note "H skipped — PLATFORM_INTERNAL_TOKEN not set"
fi

# ─── summary ───────────────────────────────────────────────────────────
echo
echo "$(c_bold "Summary"): $(c_green "$PASS PASS") / $(c_red "$FAIL FAIL")"
[ "$FAIL" -eq 0 ]
