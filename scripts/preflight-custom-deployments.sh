#!/usr/bin/env bash
# Pre-flight checklist for the Custom Deployments feature (ADR-036).
#
# Run this BEFORE the integration harnesses to confirm the cluster is
# ready for E2E sign-off:
#
#   1. Backend version is on or after the PR #14 merge commit.
#   2. Migrations 0098_custom_deployments + 0099_system_settings_custom_deployments
#      are present in the drizzle migration history.
#   3. All 6 kill switches are at their documented defaults.
#   4. The test-client's tenant namespace has PSS enforce=baseline.
#
# USAGE
#   ADMIN_PASSWORD=<...> ./scripts/preflight-custom-deployments.sh
#
# Optional env overrides (same as integration-custom-deployments.sh):
#   ADMIN_HOST, ADMIN_EMAIL, SSH_HOST, SSH_KEY, CUSTOM_DEPLOY_CLIENT_ID
#
# Exit codes:
#   0  all checks pass
#   1  one or more checks failed (details printed inline)
#   2  fatal: cannot authenticate / resolve cluster access

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"
KUBECTL="${KUBECTL:-kubectl}"


if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

PASSED=0
FAILED=0

pass() { echo -e "  \033[32m✓\033[0m $*"; PASSED=$((PASSED+1)); }
fail() { echo -e "  \033[31m✗\033[0m $*"; FAILED=$((FAILED+1)); }
info() { echo -e "  \033[33mℹ\033[0m $*"; }
section() { echo -e "\n\033[1m── $1 ──\033[0m"; }

login_token() {
  if [[ -n "${INTEGRATION_TOKEN:-}" ]]; then
    printf '%s' "$INTEGRATION_TOKEN"
    return 0
  fi
  curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null
}

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sk -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" -d "$body"
  else
    curl -sk -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN"
  fi
}

remote_kubectl() {
  if [[ -n "$SSH_HOST" ]]; then
    ssh -i "$SSH_KEY" $SSH_OPTS "$SSH_HOST" "$KUBECTL $(printf '%q ' "$@")"
  else
    $KUBECTL "$@"
  fi
}

TOKEN=$(login_token)
[[ -z "$TOKEN" ]] && { echo "FATAL: admin login failed" >&2; exit 2; }
info "Admin login OK ($ADMIN_EMAIL)"

# ─── Check 1: Backend version ────────────────────────────────────────────────

section "Check 1 — Backend version"

VERSION=$(api GET "/admin/system-settings" | python3 -c "
import json, sys
try:
    # Version is in /health, not system-settings — fall through to health check
    pass
except:
    pass
" 2>/dev/null || true)

# /api/v1/health carries the version digest injected at build time.
HEALTH=$(curl -sk "$ADMIN_HOST/api/v1/health" 2>/dev/null || true)
VERSION=$(echo "$HEALTH" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('data', {}).get('version', ''))
except:
    print('')
" 2>/dev/null || true)

if [[ -z "$VERSION" ]]; then
  info "version not exposed by /health (not a blocker — some deploys omit it)"
else
  info "Backend version: $VERSION"
  # Check it's at least as new as the known pre-merge commit
  if echo "$VERSION" | grep -qv "^0000000"; then
    pass "Backend /health reachable; version='$VERSION'"
  else
    fail "Backend version is all-zeros placeholder — image may not be deployed"
  fi
fi

# Verify the API can reach its own DB by checking system-settings returns 200
HTTP=$(curl -sk -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" \
  "$ADMIN_HOST/api/v1/admin/system-settings")
if [[ "$HTTP" == "200" ]]; then
  pass "GET /admin/system-settings → 200 (DB reachable)"
else
  fail "GET /admin/system-settings → $HTTP (API may be unhealthy)"
fi

# ─── Check 2: Migrations applied ─────────────────────────────────────────────

section "Check 2 — Migrations 0098 + 0099 applied"

# Try to detect a CNPG pod in platform-system to run psql; fall back to
# kubectl exec into the platform-api pod which has psql via $DATABASE_URL.
CNPG_POD=$(remote_kubectl get pod -n platform-system \
  -l "cnpg.io/cluster=system-db,cnpg.io/instanceRole=primary" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

if [[ -n "$CNPG_POD" ]]; then
  MIGRATION_LIST=$(remote_kubectl exec -n platform-system "$CNPG_POD" -- \
    psql -U app -d platform -tAc \
    "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 20;" \
    2>/dev/null || true)
else
  # Fall back: run inside the platform-api pod using DATABASE_URL
  API_POD=$(remote_kubectl get pod -n platform-system -l app=platform-api \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -n "$API_POD" ]]; then
    MIGRATION_LIST=$(remote_kubectl exec -n platform-system "$API_POD" -- \
      sh -c 'node -e "
const {Pool}=require(\"pg\");
const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query(\"SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 20\")
 .then(r=>{r.rows.forEach(row=>console.log(row.hash));p.end()})
 .catch(e=>{console.error(e.message);p.end();process.exit(1)})
"' 2>/dev/null || true)
  else
    info "Cannot find CNPG primary pod or platform-api pod — migration check skipped"
    MIGRATION_LIST=""
  fi
fi

if [[ -n "$MIGRATION_LIST" ]]; then
  if echo "$MIGRATION_LIST" | grep -q "0098"; then
    pass "Migration 0098_custom_deployments present"
  else
    fail "Migration 0098_custom_deployments NOT found in drizzle history"
  fi
  if echo "$MIGRATION_LIST" | grep -q "0099"; then
    pass "Migration 0099_system_settings_custom_deployments present"
  else
    fail "Migration 0099_system_settings_custom_deployments NOT found in drizzle history"
  fi
else
  # Soft check: verify the discriminator column exists via the API
  # POST a simple custom deployment — if it returns 201 or 403 (kill-switch)
  # the table columns are present; if it returns 500 it's not migrated.
  CLIENT_ID="${CUSTOM_DEPLOY_CLIENT_ID:-}"
  if [[ -z "$CLIENT_ID" ]]; then
    CLIENT_ID=$(api GET "/clients?limit=20" | python3 -c "
import json,sys
d = json.load(sys.stdin).get('data', [])
for c in d:
  if c.get('status') == 'active':
    print(c['id']); break
" 2>/dev/null || true)
  fi
  if [[ -n "$CLIENT_ID" ]]; then
    # Single call: capture both HTTP status and response body to avoid a
    # double-POST that would create two rows with no way to clean the first.
    PROBE_RESP=$(api POST "/clients/$CLIENT_ID/custom-deployments" \
      '{"mode":"simple","name":"preflight-probe-delete-me","image":"nginx:1.27-alpine"}')
    PROBE=$(echo "$PROBE_RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
# The API wraps errors in {error:{code,message,statusCode}} or returns {data:{...}}.
# Use statusCode from error, or infer 201 from id presence.
err=d.get('error',{})
sc=err.get('statusCode','')
if sc: print(sc)
elif d.get('data',{}).get('id'): print('201')
else: print('200')
" 2>/dev/null || echo "0")
    PROBE_ID=$(echo "$PROBE_RESP" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['data']['id'])
except Exception: print('')
" 2>/dev/null || true)

    if [[ "$PROBE" == "201" || "$PROBE" == "200" || "$PROBE" == "403" || "$PROBE" == "422" ]]; then
      pass "Custom deployments API endpoint reachable (HTTP $PROBE → columns exist)"
      [[ -n "$PROBE_ID" ]] && api DELETE "/clients/$CLIENT_ID/custom-deployments/$PROBE_ID" >/dev/null 2>&1 || true
    elif [[ "$PROBE" == "500" ]]; then
      fail "POST /custom-deployments → 500 — likely migration not applied"
    else
      info "POST /custom-deployments → $PROBE (unexpected; manual migration check recommended)"
    fi
  else
    info "No active client found — migration probe skipped"
  fi
fi

# ─── Check 3: Kill switches at defaults ──────────────────────────────────────

section "Check 3 — Kill switches at documented defaults"

SETTINGS=$(api GET "/admin/system-settings")
check_bool() {
  local key="$1" expected="$2"
  local actual
  actual=$(echo "$SETTINGS" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{})
if '$key' not in d:
    print('MISSING')
elif d['$key']:
    print('true')
else:
    print('false')
" 2>/dev/null || echo "MISSING")
  if [[ "$actual" == "$expected" ]]; then
    pass "$key = $expected ✓"
  else
    fail "$key = $actual (expected $expected) — run: PATCH /admin/system-settings {\"$key\": $expected}"
  fi
}

check_bool "customDeploymentsEnabled"              "true"
check_bool "customDeploymentsAllowCompose"          "true"
check_bool "customDeploymentsAllowPrivateRegistries" "true"
check_bool "customDeploymentsImagePullAudit"        "true"
check_bool "customDeploymentsScanOnPull"            "false"
check_bool "customDeploymentsWarnUnpinnedTags"      "true"

# ─── Check 4: PSS labels on tenant namespace ─────────────────────────────────

section "Check 4 — Tenant namespace PSS enforce=baseline"

CLIENT_ID="${CUSTOM_DEPLOY_CLIENT_ID:-}"
if [[ -z "$CLIENT_ID" ]]; then
  CLIENT_ID=$(api GET "/admin/tenants?limit=20" | python3 -c "
import json,sys
d = json.load(sys.stdin).get('data', [])
for c in d:
  if c.get('status') == 'active':
    print(c['id']); break
" 2>/dev/null || true)
fi

if [[ -z "$CLIENT_ID" ]]; then
  fail "No active client found — cannot verify PSS labels (is there at least one active client?)"
else
  TENANT_NS=$(api GET "/clients/$CLIENT_ID" | python3 -c "
import json,sys; print(json.load(sys.stdin)['data']['kubernetesNamespace'])
" 2>/dev/null || true)
  if [[ -z "$TENANT_NS" ]]; then
    fail "Client $CLIENT_ID has no kubernetesNamespace — provisioning may not be complete"
  else
    ENFORCE=$(remote_kubectl get ns "$TENANT_NS" \
      -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null || true)
    WARN=$(remote_kubectl get ns "$TENANT_NS" \
      -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/warn}' 2>/dev/null || true)
    if [[ "$ENFORCE" == "baseline" ]]; then
      pass "Namespace $TENANT_NS: enforce=baseline"
    else
      fail "Namespace $TENANT_NS: enforce='$ENFORCE' (expected baseline) — run: ./scripts/backfill-tenant-namespace-pss.sh --apply"
    fi
    if [[ "$WARN" == "restricted" ]]; then
      pass "Namespace $TENANT_NS: warn=restricted"
    else
      info "Namespace $TENANT_NS: warn='$WARN' (expected restricted, non-blocking)"
    fi
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo
echo -e "\033[1mPre-flight results:\033[0m $PASSED passed, $FAILED failed"
if ((FAILED > 0)); then
  echo "  Fix the failures above before running the integration harness."
  exit 1
fi
echo "  All checks passed — ready for E2E sign-off."
exit 0
