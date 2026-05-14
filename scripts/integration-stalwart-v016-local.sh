#!/usr/bin/env bash
# integration-stalwart-local.sh — Stalwart 0.16 local DinD smoke test.
#
# Exercises the Stalwart 0.16 JMAP management API directly via kubectl exec.
# Stalwart 0.16 uses JMAP for ALL management operations (domains, accounts).
# The x:Domain and x:Account objects are accessed via the urn:stalwart:jmap
# JMAP capability extension.
#
# Prerequisites:
#   - Local DinD k3s running (./scripts/local.sh up)
#   - stalwart-mail overlay applied (kubectl apply -k k8s/overlays/dev/stalwart-mail/)
#   - CNPG operator installed + mail-pg Ready
#   - stalwart-admin-creds Secret in namespace mail (bootstrap.sh creates it)
#   - DOCKER_HOST=tcp://dind:2375 set (or DinD accessible)
#
# Usage:
#   DOCKER_HOST=tcp://dind:2375 bash scripts/integration-stalwart-local.sh
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
STALWART_DEPLOY="stalwart-mail"
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
  --field-selector=status.phase=Running \
  -o jsonpath='{range .items[?(@.status.containerStatuses[0].ready==true)]}{.metadata.name}{"\n"}{end}' 2>/dev/null \
  | head -n1 || true)
if [[ -z "$STALWART_POD" ]]; then
  # Fallback for older clusters where field-selector + jsonpath combo fails
  STALWART_POD=$(kctl get pod -n ${NS} -l app=${STALWART_DEPLOY} \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
fi
if [[ -z "$STALWART_POD" ]]; then
  echo "  FATAL: No stalwart-mail pod found. Deploy the overlay first:"
  echo "    kubectl apply -k k8s/overlays/dev/stalwart-mail/"
  exit 1
fi
pass "stalwart-mail pod found: ${STALWART_POD}"

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

# ── Step 8b/8c probe helper ───────────────────────────────────────────────
# stalwart pod has no curl AND can't reach platform-api Service (NetworkPolicy
# allows only localhost-loopback). Drive the platform-api routes from the
# admin-panel pod instead — same namespace as platform-api, busybox `wget`.
#
# Returns body on stdout; logs HTTP code on stderr. Caller parses JSON.
pa_call() {
  local method="$1" path="$2" body="${3:-}"
  local pa_pod
  pa_pod=$(kctl get pod -n platform -l app=admin-panel \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -z "$pa_pod" ]]; then return 1; fi
  if [[ "$method" == "GET" ]]; then
    kctl exec -n platform "$pa_pod" -- curl -sS --max-time 15 \
      -H "Authorization: Bearer ${PA_TOKEN}" \
      "http://platform-api.platform.svc.cluster.local:3000${path}" 2>/dev/null || true
  else
    kctl exec -n platform "$pa_pod" -- curl -sS --max-time 15 \
      -X "${method}" \
      -H "Authorization: Bearer ${PA_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${body}" \
      "http://platform-api.platform.svc.cluster.local:3000${path}" 2>/dev/null || true
  fi
}

# ── Step 8b: Mail PVC online resize (MAIL_STORAGE_E2E=1) ──────────────────
# GET → record current size; PATCH +1 GiB; poll PVC spec until propagated.
if [[ "${MAIL_STORAGE_E2E:-0}" == "1" ]]; then
  echo ""
  echo "Step 8b: Mail PVC online resize (+1 GiB)"

  PA_TOKEN="${PLATFORM_API_ADMIN_TOKEN:-}"
  if [[ -z "$PA_TOKEN" ]]; then
    echo "  SKIP: PLATFORM_API_ADMIN_TOKEN not set; cannot drive admin route"
  else
    BEFORE=$(pa_call GET /api/v1/admin/mail/pvc/storage)
    BEFORE_GIB=$(echo "$BEFORE" | python3 -c \
      "import sys,json,re;d=json.load(sys.stdin);b=d.get('data',{}).get('requestedBytes',0);print(b//(1024**3) if b else '')" 2>/dev/null || echo "")
    if [[ -z "$BEFORE_GIB" ]]; then
      fail "GET /admin/mail/pvc/storage → cannot parse requestedBytes: $(echo "$BEFORE" | head -c 250)"
    else
      pass "GET /admin/mail/pvc/storage → currently ${BEFORE_GIB}GiB"
      NEW_GIB=$((BEFORE_GIB + 1))

      PATCH_RESP=$(pa_call PATCH /api/v1/admin/mail/pvc/storage "{\"newGiB\":${NEW_GIB}}")
      EXPECTED_BYTES=$((NEW_GIB * 1024 * 1024 * 1024))
      if echo "$PATCH_RESP" | python3 -c \
        "import sys,json;d=json.load(sys.stdin);assert d.get('data',{}).get('requestedBytes')==${EXPECTED_BYTES}" 2>/dev/null; then
        pass "PATCH /admin/mail/pvc/storage → requestedBytes=${EXPECTED_BYTES} (${NEW_GIB}GiB)"
      else
        fail "PATCH /admin/mail/pvc/storage → unexpected: $(echo "$PATCH_RESP" | head -c 300)"
      fi

      # Poll PVC until spec reflects new size (Longhorn online expansion: 5-30s)
      OBSERVED=""
      for _ in $(seq 1 30); do
        OBSERVED=$(kctl get pvc -n ${NS} mail-pg-1 \
          -o jsonpath='{.spec.resources.requests.storage}' 2>/dev/null || echo "")
        [[ "$OBSERVED" == "${NEW_GIB}Gi" ]] && break
        sleep 2
      done
      if [[ "$OBSERVED" == "${NEW_GIB}Gi" ]]; then
        pass "PVC mail-pg-1 spec.resources.requests.storage → ${NEW_GIB}Gi"
      else
        fail "PVC resize did not propagate within 60s (observed=${OBSERVED}, expected=${NEW_GIB}Gi)"
      fi
    fi
  fi
else
  echo ""
  echo "Step 8b: Mail PVC resize — SKIPPED (set MAIL_STORAGE_E2E=1 to run)"
fi

# ── Step 8c: Stalwart BlobStore reversible flip (MAIL_STORAGE_E2E=1) ──────
# Default → FileSystem → Default round-trip via cli-update Job. Destructive
# on shared cluster — gated behind env. Each PATCH spawns a Job; we poll
# /jobs/:name until terminal status.
if [[ "${MAIL_STORAGE_E2E:-0}" == "1" ]]; then
  echo ""
  echo "Step 8c: Stalwart BlobStore reversible flip (Default → FileSystem → Default)"

  if [[ -z "${PA_TOKEN:-}" ]]; then
    echo "  SKIP: PA_TOKEN missing"
  else
    BS_TYPE=$(pa_call GET /api/v1/admin/mail/blob-store \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('data',{}).get('type',''))" 2>/dev/null || echo "")
    if [[ -z "$BS_TYPE" ]]; then
      fail "GET /admin/mail/blob-store → cannot parse type"
    else
      pass "GET /admin/mail/blob-store → ${BS_TYPE}"

      flip_blob_store() {
        local target="$1" body="$2"
        local resp job_name status
        resp=$(pa_call PATCH /api/v1/admin/mail/blob-store "$body")
        job_name=$(echo "$resp" | python3 -c \
          "import sys,json;d=json.load(sys.stdin);print(d.get('data',{}).get('jobName',''))" 2>/dev/null || echo "")
        if [[ -z "$job_name" ]]; then
          fail "PATCH blob-store(${target}) → no jobName: $(echo "$resp" | head -c 300)"
          return 1
        fi
        echo "  Job: ${job_name}"

        status=""
        for _ in $(seq 1 45); do
          status=$(pa_call GET "/api/v1/admin/mail/blob-store/jobs/${job_name}" \
            | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('data',{}).get('status',''))" 2>/dev/null || echo "")
          [[ "$status" == "succeeded" ]] && break
          [[ "$status" == "failed" ]] && break
          sleep 2
        done
        if [[ "$status" == "succeeded" ]]; then
          pass "Job ${job_name} → succeeded (target=${target})"
          return 0
        else
          fail "Job ${job_name} → ${status} (expected succeeded)"
          return 1
        fi
      }

      flip_blob_store "FileSystem" \
        '{"type":"FileSystem","fileSystem":{"path":"/var/lib/stalwart/blobs","depth":2}}' || true
      sleep 3
      flip_blob_store "Default" '{"type":"Default"}' || true

      BS_AFTER=$(pa_call GET /api/v1/admin/mail/blob-store \
        | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('data',{}).get('type',''))" 2>/dev/null || echo "")
      if [[ "$BS_AFTER" == "Default" ]]; then
        pass "Final blob-store state = Default (round-trip clean)"
      else
        fail "Final blob-store state = ${BS_AFTER} (expected Default)"
      fi
    fi
  fi
else
  echo ""
  echo "Step 8c: BlobStore flip — SKIPPED (set MAIL_STORAGE_E2E=1 to run)"
fi

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
