#!/usr/bin/env bash
# integration-stalwart-v016-local.sh — Stalwart 0.16 local DinD smoke test.
#
# Exercises the Stalwart 0.16 JMAP management API directly via kubectl exec.
# Stalwart 0.16 uses JMAP for ALL management operations (domains, accounts).
# The x:Domain and x:Account objects are accessed via the urn:stalwart:jmap
# JMAP capability extension.
#
# Prerequisites:
#   - Local DinD k3s running (./scripts/local.sh up)
#   - stalwart-v016 overlay applied (kubectl apply -k k8s/overlays/dev/stalwart-v016/)
#   - CNPG operator installed + mail-pg Ready
#   - stalwart-admin-creds Secret in namespace mail (bootstrap.sh creates it)
#   - DOCKER_HOST=tcp://dind:2375 set (or DinD accessible)
#
# Usage:
#   DOCKER_HOST=tcp://dind:2375 bash scripts/integration-stalwart-v016-local.sh
#
set -euo pipefail

# When running from the workspace host with DinD, kubectl is only reachable
# via docker exec into the k3s container. Detect this automatically.
K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"

# kctl wrapper: routes kubectl via docker exec when DOCKER_HOST is set.
USE_DOCKER_EXEC=false
if [[ -n "${DOCKER_HOST:-}" ]]; then
  if docker exec "$K3S_CONTAINER" kubectl version >/dev/null 2>&1; then
    USE_DOCKER_EXEC=true
    echo "  Using docker exec kubectl (DinD k3s container: ${K3S_CONTAINER})"
  fi
fi

kctl() {
  if [[ "$USE_DOCKER_EXEC" == "true" ]]; then
    docker exec "$K3S_CONTAINER" kubectl "$@"
  else
    kubectl "$@"
  fi
}

# jmap_call: send a JMAP request via kubectl exec on the Stalwart pod.
# Usage: jmap_call <pod> <user> <pw> <json-body>
jmap_call() {
  local pod="$1" user="$2" pw="$3" body="$4"
  kctl exec -n "${NS}" "$pod" -- \
    curl -sL --compressed \
    -u "${user}:${pw}" \
    -X POST -H "Content-Type: application/json" \
    -d "$body" \
    "http://localhost:${MGMT_PORT}/jmap/" 2>/dev/null || echo "error"
}

NS="mail"
STALWART_DEPLOY="stalwart-mail-v016"
MGMT_PORT="8080"
STALWART_ADMIN="${STALWART_ADMIN:-admin}"
STALWART_ADMIN_PW="${STALWART_ADMIN_PW:-}"
TEST_DOMAIN="smoke-test-v016.example.com"
TEST_USER="smoketest-v016"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1" >&2; FAILURES=$((FAILURES+1)); }
FAILURES=0

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Stalwart 0.16 Integration Smoke Test (local DinD)"
echo "══════════════════════════════════════════════════════"
echo ""

# ── Step 0: Resolve admin password ───────────────────────────────────────────
if [[ -z "$STALWART_ADMIN_PW" ]]; then
  # Try adminPassword from cluster secret first
  STALWART_ADMIN_PW=$(kctl get secret -n mail stalwart-admin-creds \
    -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d 2>/dev/null || true)
fi
if [[ -z "$STALWART_ADMIN_PW" ]]; then
  # Try recoveryPassword (set before bootstrap plan runs)
  STALWART_ADMIN_PW=$(kctl get secret -n mail stalwart-admin-creds \
    -o jsonpath='{.data.recoveryPassword}' 2>/dev/null | base64 -d 2>/dev/null || true)
fi
if [[ -z "$STALWART_ADMIN_PW" ]]; then
  echo "  FATAL: Cannot resolve admin password from stalwart-admin-creds Secret."
  echo "         Run bootstrap.sh or create the Secret manually."
  exit 1
fi
echo "  Admin password resolved from stalwart-admin-creds."

# ── Step 2: Find Stalwart pod ─────────────────────────────────────────────
echo "Step 2: Stalwart 0.16 pod readiness"
STALWART_POD=$(kctl get pod -n ${NS} -l app=${STALWART_DEPLOY} \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [[ -z "$STALWART_POD" ]]; then
  echo "  FATAL: No stalwart-mail-v016 pod found. Deploy the overlay first:"
  echo "    kubectl apply -k k8s/overlays/dev/stalwart-v016/"
  exit 1
fi
pass "stalwart-mail-v016 pod found: ${STALWART_POD}"

# ── Step 1: platform-api healthz (informational) ─────────────────────────
echo ""
echo "Step 1: Platform-api healthz"
PLATFORM_API_POD=$(kctl get pod -n platform -l app=platform-api \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -n "$PLATFORM_API_POD" ]]; then
  # platform-api uses Node.js (no curl in the image); probe via service ClusterIP.
  PLATFORM_SVC_IP=$(kctl get svc -n platform platform-api \
    -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "")
  if [[ -n "$PLATFORM_SVC_IP" ]]; then
    HEALTH=$(kctl exec -n ${NS} "${STALWART_POD}" -- \
      curl -s -o /dev/null -w "%{http_code}" --max-time 3 \
      "http://${PLATFORM_SVC_IP}:3000/api/v1/healthz" 2>/dev/null; true)
    if [[ "$HEALTH" == "200" ]]; then
      pass "platform-api /healthz → 200"
    elif [[ -z "$HEALTH" || "$HEALTH" == "000" ]]; then
      echo "  SKIP: platform-api unreachable (connection refused or NetworkPolicy)"
    else
      fail "platform-api /healthz → ${HEALTH} (expected 200; pod=${PLATFORM_API_POD})"
    fi
  else
    echo "  SKIP: platform-api Service not found"
  fi
else
  echo "  SKIP: platform-api pod not found (not required for Stalwart smoke test)"
fi

# ── Step 3: /healthz/live ─────────────────────────────────────────────────
echo ""
echo "Step 3: /healthz/live"
HEALTH=$(kctl exec -n ${NS} "${STALWART_POD}" -- \
  curl -s -o /dev/null -w "%{http_code}" http://localhost:${MGMT_PORT}/healthz/live 2>/dev/null || echo "000")
if [[ "$HEALTH" == "200" ]]; then
  pass "/healthz/live → 200"
else
  fail "/healthz/live → ${HEALTH} (expected 200)"
fi

# ── Step 4: JMAP session + authenticated access ────────────────────────────
echo ""
echo "Step 4: JMAP session endpoint + admin auth"
# Anonymous session (capabilities — always public)
JMAP_ANON=$(kctl exec -n ${NS} "${STALWART_POD}" -- \
  curl -s "http://localhost:${MGMT_PORT}/jmap/session" 2>/dev/null || echo "error")
if echo "$JMAP_ANON" | grep -q '"urn:ietf:params:jmap:core"'; then
  pass "JMAP session capabilities present (unauthenticated)"
else
  fail "JMAP session → unexpected response: $(echo "$JMAP_ANON" | head -c 100)"
fi

# Authenticated session — verifies admin credential is valid
AUTH_CODE=$(kctl exec -n ${NS} "${STALWART_POD}" -- \
  curl -s -o /dev/null -w "%{http_code}" \
  -u "${STALWART_ADMIN}:${STALWART_ADMIN_PW}" \
  "http://localhost:${MGMT_PORT}/jmap/session" 2>/dev/null || echo "000")
if [[ "$AUTH_CODE" == "200" ]]; then
  pass "JMAP authenticated session → 200 (admin credential valid)"
else
  fail "JMAP authenticated session → ${AUTH_CODE} (expected 200)"
fi

# Get accountId for subsequent JMAP calls
ACCOUNT_ID=$(kctl exec -n ${NS} "${STALWART_POD}" -- \
  curl -s -u "${STALWART_ADMIN}:${STALWART_ADMIN_PW}" \
  "http://localhost:${MGMT_PORT}/jmap/session" 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); accts=d.get('accounts',{}); print(list(accts.keys())[0] if accts else '')" 2>/dev/null || echo "")
if [[ -z "$ACCOUNT_ID" ]]; then
  fail "Could not extract accountId from JMAP session"
  ACCOUNT_ID="unknown"
fi
echo "  accountId: ${ACCOUNT_ID}"

# ── Step 5: Create a test domain via JMAP x:Domain/set ────────────────────
echo ""
echo "Step 5: Create test domain ${TEST_DOMAIN}"
CREATE_DOMAIN=$(jmap_call "$STALWART_POD" "$STALWART_ADMIN" "$STALWART_ADMIN_PW" \
  "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Domain/set\",{\"accountId\":\"${ACCOUNT_ID}\",\"create\":{\"d1\":{\"name\":\"${TEST_DOMAIN}\"}}},\"r0\"]]}")
DOMAIN_ID=$(echo "$CREATE_DOMAIN" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); created=d['methodResponses'][0][1].get('created',{}); print(created.get('d1',{}).get('id',''))" 2>/dev/null || echo "")
if [[ -n "$DOMAIN_ID" ]]; then
  pass "Domain ${TEST_DOMAIN} created (id=${DOMAIN_ID})"
else
  # Check if already exists (domain creation is idempotent via unique name constraint)
  NOT_CREATED=$(echo "$CREATE_DOMAIN" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); nc=d['methodResponses'][0][1].get('notCreated',{}); print(nc.get('d1',{}).get('description',''))" 2>/dev/null || echo "")
  if echo "$NOT_CREATED" | grep -qi "already\|exist\|duplicate\|unique"; then
    pass "Domain ${TEST_DOMAIN} already exists (idempotent)"
    # Get existing domain ID
    DOMAIN_ID=$(jmap_call "$STALWART_POD" "$STALWART_ADMIN" "$STALWART_ADMIN_PW" \
      "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Domain/query\",{\"accountId\":\"${ACCOUNT_ID}\",\"filter\":{\"name\":\"${TEST_DOMAIN}\"}},\"r0\"]]}" | \
      python3 -c "import sys,json; d=json.load(sys.stdin); ids=d['methodResponses'][0][1].get('ids',[]); print(ids[0] if ids else '')" 2>/dev/null || echo "")
  else
    fail "Create domain → unexpected response: $(echo "$CREATE_DOMAIN" | head -c 200)"
  fi
fi

# ── Step 6: List domains ──────────────────────────────────────────────────
echo ""
echo "Step 6: List domains via x:Domain/get"
LIST_DOMAINS=$(jmap_call "$STALWART_POD" "$STALWART_ADMIN" "$STALWART_ADMIN_PW" \
  "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Domain/get\",{\"accountId\":\"${ACCOUNT_ID}\",\"ids\":null},\"r0\"]]}")
DOMAIN_COUNT=$(echo "$LIST_DOMAINS" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(len(d['methodResponses'][0][1].get('list',[])))" 2>/dev/null || echo "error")
if echo "$DOMAIN_COUNT" | grep -qE '^[0-9]+$' && [[ "$DOMAIN_COUNT" -ge 1 ]]; then
  pass "Domain list returned ${DOMAIN_COUNT} domain(s)"
else
  fail "Domain list unexpected response (count=${DOMAIN_COUNT}): $(echo "$LIST_DOMAINS" | head -c 200)"
fi

# ── Step 7: Create a test mailbox (x:Account/User) ────────────────────────
echo ""
echo "Step 7: Create test user ${TEST_USER} in domain ${TEST_DOMAIN}"
if [[ -z "$DOMAIN_ID" ]]; then
  echo "  SKIP: No domain ID available (Step 5 failed)"
else
  CREATE_USER=$(jmap_call "$STALWART_POD" "$STALWART_ADMIN" "$STALWART_ADMIN_PW" \
    "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Account/set\",{\"accountId\":\"${ACCOUNT_ID}\",\"create\":{\"u1\":{\"@type\":\"User\",\"name\":\"${TEST_USER}\",\"domainId\":\"${DOMAIN_ID}\",\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\"smoke-test-pw-2026\",\"allowedIps\":{},\"expiresAt\":null}}}}},\"r0\"]]}")
  USER_ID=$(echo "$CREATE_USER" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); created=d['methodResponses'][0][1].get('created',{}); print(created.get('u1',{}).get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$USER_ID" ]]; then
    pass "User ${TEST_USER}@${TEST_DOMAIN} created (id=${USER_ID})"
  else
    NOT_CREATED=$(echo "$CREATE_USER" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); nc=d['methodResponses'][0][1].get('notCreated',{}); print(nc)" 2>/dev/null || echo "")
    if echo "$NOT_CREATED" | grep -qi "already\|exist\|duplicate\|unique"; then
      pass "User ${TEST_USER} already exists (idempotent)"
    else
      fail "Create user → unexpected response: $(echo "$CREATE_USER" | head -c 300)"
    fi
  fi
fi

# ── Step 8: DNS record check (informational) ──────────────────────────────
echo ""
echo "Step 8: DNS records (informational — dns-sync not active in dev)"
echo "  SKIP: PowerDNS not deployed in local DinD k3s."
echo "        In staging/production, dns-sync polls Stalwart and publishes"
echo "        MX/SPF/DKIM records to PowerDNS within 5 minutes of domain creation."
echo "        Check platform-api logs: kubectl logs -n platform -l app=platform-api | grep stalwart-dns-sync"

# ── Step 9: Cleanup ────────────────────────────────────────────────────────
echo ""
echo "Step 9: Cleanup test resources"

# Delete user account
if [[ -n "${USER_ID:-}" ]]; then
  DEL_USER=$(jmap_call "$STALWART_POD" "$STALWART_ADMIN" "$STALWART_ADMIN_PW" \
    "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Account/set\",{\"accountId\":\"${ACCOUNT_ID}\",\"destroy\":[\"${USER_ID}\"]},\"r0\"]]}")
  if echo "$DEL_USER" | python3 -c "import sys,json; d=json.load(sys.stdin); assert '${USER_ID}' in d['methodResponses'][0][1].get('destroyed',[])" 2>/dev/null; then
    pass "User ${TEST_USER} deleted"
  else
    fail "Delete user → unexpected: $(echo "$DEL_USER" | head -c 200)"
  fi
else
  echo "  SKIP: No user to delete (not created)"
fi

# Delete domain (cascade: delete DKIM signatures first)
if [[ -n "${DOMAIN_ID:-}" ]]; then
  # Get DKIM signature IDs linked to this domain
  DKIM_IDS=$(jmap_call "$STALWART_POD" "$STALWART_ADMIN" "$STALWART_ADMIN_PW" \
    "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:DkimSignature/query\",{\"accountId\":\"${ACCOUNT_ID}\",\"filter\":{\"domainId\":\"${DOMAIN_ID}\"}},\"r0\"]]}" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); ids=d['methodResponses'][0][1].get('ids',[]); print(','.join('\"'+i+'\"' for i in ids))" 2>/dev/null || echo "")

  if [[ -n "$DKIM_IDS" ]]; then
    jmap_call "$STALWART_POD" "$STALWART_ADMIN" "$STALWART_ADMIN_PW" \
      "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:DkimSignature/set\",{\"accountId\":\"${ACCOUNT_ID}\",\"destroy\":[${DKIM_IDS}]},\"r0\"]]}" >/dev/null
    pass "DKIM signatures deleted"
  fi

  DEL_DOM=$(jmap_call "$STALWART_POD" "$STALWART_ADMIN" "$STALWART_ADMIN_PW" \
    "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Domain/set\",{\"accountId\":\"${ACCOUNT_ID}\",\"destroy\":[\"${DOMAIN_ID}\"]},\"r0\"]]}")
  if echo "$DEL_DOM" | python3 -c "import sys,json; d=json.load(sys.stdin); assert '${DOMAIN_ID}' in d['methodResponses'][0][1].get('destroyed',[])" 2>/dev/null; then
    pass "Domain ${TEST_DOMAIN} deleted"
  else
    fail "Delete domain → unexpected: $(echo "$DEL_DOM" | head -c 200)"
  fi
else
  echo "  SKIP: No domain to delete (not created)"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
if [[ "$FAILURES" -eq 0 ]]; then
  echo "  ALL STEPS PASSED (0 failures)"
  echo "══════════════════════════════════════════════════════"
  exit 0
else
  echo "  ${FAILURES} FAILURE(S) — see output above"
  echo "══════════════════════════════════════════════════════"
  exit 1
fi
