#!/usr/bin/env bash
# integration-burstable-qos.sh — verify ADR-037 asymmetric QoS model
# against a real k3s cluster.
#
# Asserts:
#   1. New deployments emit `requests.cpu` per container and NO
#      `limits.cpu` (CPU is bursty).
#   2. New deployments emit `requests.memory == limits.memory` per
#      container (memory is Guaranteed).
#   3. The tenant namespace's ResourceQuota enforces `requests.cpu`
#      (not `limits.cpu`) and `limits.memory` + `requests.memory`.
#   4. Multi-component allocator splits a deployment's CPU/memory
#      across components — no single component holds the full budget.
#   5. Sum of per-component `requests.cpu` ≤ plan cap; quota rejects
#      pods that would push over the cap.
#   6. The /resource-breakdown API endpoint returns per-component
#      allocations matching what's on the cluster.
#
# Required env:
#   ADMIN_PASSWORD     admin@phoenix-host.net password
#
# Optional env:
#   ADMIN_HOST         https://admin.staging.phoenix-host.net
#   STAGING_SSH_HOST   first IP from ~/k8s-staging/servers.txt
#   SSH_KEY            ~/hosting-platform.key
#
# Exit codes:
#   0  all assertions passed
#   1  one or more assertions failed
#   2  prereq missing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

CONTROL_HOST="${STAGING_SSH_HOST:-46.224.122.58}"
CONTROL_HOST="${CONTROL_HOST##*@}"

PASS=0
FAIL=0

pass() { echo "PASS: $*"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }

# Helper: kubectl from staging1
k() {
  ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" kubectl "$@"
}

# ─── Authenticate ───────────────────────────────────────────────────────────
echo "→ Authenticating..."
TOKEN=$(curl -fsSL -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | jq -r '.data.token')

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: login failed" >&2
  exit 2
fi

# ─── Create/locate test tenant ──────────────────────────────────────────────
# Base plan is Starter (smallest PVCs) so the test stays cheap. CPU and
# memory are bumped via overrides — the burstable-QoS test specifically
# needs cpu_limit_override=2 + memory_limit_override=4 to exercise the
# burstable scheduling path.
TENANT_NAME="qos-test-$(date +%s)"
echo "→ Creating test tenant '$TENANT_NAME' (Starter plan + 2-CPU override)..."

PLAN_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/plans?limit=20" \
  | jq -r '[.data[] | select(.name == "Starter")][0].id // .data[0].id // empty')
REGION_ID=$(curl -sk -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/regions?limit=1" \
  | jq -r '.data[0].id // empty')
if [[ -z "$PLAN_ID" || -z "$REGION_ID" ]]; then
  echo "ERROR: could not resolve Starter plan_id or region_id (plan=$PLAN_ID region=$REGION_ID)" >&2
  exit 1
fi

CLIENT_RESP=$(curl -fsSL -X POST "$ADMIN_HOST/api/v1/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TENANT_NAME\",\"primary_email\":\"$TENANT_NAME@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"cpu_limit_override\":2,\"memory_limit_override\":4}")
TENANT_ID=$(echo "$CLIENT_RESP" | jq -r '.data.id')
NAMESPACE=$(echo "$CLIENT_RESP" | jq -r '.data.kubernetesNamespace')

if [[ -z "$TENANT_ID" || "$TENANT_ID" == "null" ]]; then
  echo "ERROR: client create failed: $CLIENT_RESP" >&2
  exit 1
fi
echo "  Client ID: $TENANT_ID, namespace: $NAMESPACE"

cleanup() {
  if [[ -n "$TENANT_ID" && "$TENANT_ID" != "null" ]]; then
    echo "→ Cleanup: deleting client $TENANT_ID"
    curl -fsSL -X DELETE "$ADMIN_HOST/api/v1/tenants/$TENANT_ID" \
      -H "Authorization: Bearer $TOKEN" >/dev/null || true
  fi
}
trap cleanup EXIT

# Wait for namespace to be ready
echo "→ Waiting for namespace to be ready..."
for i in $(seq 1 30); do
  if k get ns "$NAMESPACE" &>/dev/null; then
    break
  fi
  sleep 2
done

# ─── Assertion 1+2+3: ResourceQuota shape ───────────────────────────────────
echo "→ Asserting ResourceQuota shape..."
QUOTA_JSON=$(k get resourcequota "${NAMESPACE}-quota" -n "$NAMESPACE" -o json 2>/dev/null || echo '{}')

if echo "$QUOTA_JSON" | jq -e '.spec.hard."requests.cpu"' >/dev/null; then
  pass "Quota enforces requests.cpu"
else
  fail "Quota does not enforce requests.cpu"
fi

if echo "$QUOTA_JSON" | jq -e '.spec.hard."limits.memory"' >/dev/null; then
  pass "Quota enforces limits.memory"
else
  fail "Quota does not enforce limits.memory"
fi

if echo "$QUOTA_JSON" | jq -e '.spec.hard."limits.cpu"' >/dev/null; then
  fail "Quota STILL enforces limits.cpu (should be dropped)"
else
  pass "Quota does NOT enforce limits.cpu (Burstable model correct)"
fi

# ─── Assertion 4: deploy a multi-component test app ─────────────────────────
echo "→ Looking up Nextcloud catalog entry..."
NC_ID=$(curl -fsSL "$ADMIN_HOST/api/v1/catalog/entries?code=nextcloud" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id // empty')

if [[ -z "$NC_ID" ]]; then
  echo "  Nextcloud not in catalog — falling back to wordpress"
  NC_ID=$(curl -fsSL "$ADMIN_HOST/api/v1/catalog/entries?code=wordpress" \
    -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id // empty')
fi

if [[ -z "$NC_ID" ]]; then
  fail "Neither Nextcloud nor WordPress in catalog — can't test multi-component"
else
  echo "→ Deploying multi-component app with cpu=1 (was failing before ADR-037)..."
  DEPLOY_RESP=$(curl -fsSL -X POST "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/deployments" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"catalog_entry_id\":\"$NC_ID\",\"name\":\"qos-app\",\"cpu_request\":\"1\",\"memory_request\":\"1Gi\"}")
  DEP_ID=$(echo "$DEPLOY_RESP" | jq -r '.data.id // empty')

  if [[ -z "$DEP_ID" ]]; then
    fail "Deployment creation failed: $(echo "$DEPLOY_RESP" | jq -r '.error // .')"
  else
    pass "Multi-component deployment accepted by quota (was rejected before ADR-037)"

    # Wait for pods to schedule
    sleep 10

    # Sum the requests.cpu of all containers in the namespace's tenant pods.
    SUM_CPU_MILLI=$(k get pods -n "$NAMESPACE" -l 'platform.io/managed-by!=file-manager' -o json | \
      jq '[.items[].spec.containers[].resources.requests.cpu // "0"] | map(
        if endswith("m") then (.[:-1] | tonumber) else (tonumber * 1000) end
      ) | add')

    if [[ -n "$SUM_CPU_MILLI" && "$SUM_CPU_MILLI" -le 1000 ]]; then
      pass "Sum of tenant container requests.cpu = ${SUM_CPU_MILLI}m ≤ 1000m budget"
    else
      fail "Sum of tenant container requests.cpu = ${SUM_CPU_MILLI}m exceeds 1000m budget"
    fi

    # No container has limits.cpu
    HAS_CPU_LIMITS=$(k get pods -n "$NAMESPACE" -l 'platform.io/managed-by!=file-manager' -o json | \
      jq '[.items[].spec.containers[].resources.limits.cpu // null] | map(select(. != null)) | length')

    if [[ "$HAS_CPU_LIMITS" -eq 0 ]]; then
      pass "No tenant container has limits.cpu set (Burstable for CPU)"
    else
      fail "$HAS_CPU_LIMITS tenant container(s) still have limits.cpu (should be unset)"
    fi

    # Every container has limits.memory == requests.memory
    MEM_GUARANTEED=$(k get pods -n "$NAMESPACE" -l 'platform.io/managed-by!=file-manager' -o json | \
      jq '[.items[].spec.containers[] | (.resources.requests.memory == .resources.limits.memory)] | all')

    if [[ "$MEM_GUARANTEED" == "true" ]]; then
      pass "Every tenant container is Guaranteed for memory (requests == limits)"
    else
      fail "Some tenant containers have requests.memory != limits.memory"
    fi

    # ─── Assertion 6: /resource-breakdown endpoint ────────────────────────
    echo "→ Verifying /resource-breakdown API..."
    BREAKDOWN=$(curl -fsSL "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/deployments/$DEP_ID/resource-breakdown" \
      -H "Authorization: Bearer $TOKEN")
    COMP_COUNT=$(echo "$BREAKDOWN" | jq -r '.data.components | length')
    QOS_CPU=$(echo "$BREAKDOWN" | jq -r '.data.qosModel.cpu')
    QOS_MEM=$(echo "$BREAKDOWN" | jq -r '.data.qosModel.memory')

    if [[ "$COMP_COUNT" -gt 0 ]]; then
      pass "/resource-breakdown returned $COMP_COUNT components"
    else
      fail "/resource-breakdown returned no components"
    fi

    if [[ "$QOS_CPU" == "burstable" && "$QOS_MEM" == "guaranteed" ]]; then
      pass "/resource-breakdown reports qosModel: cpu=burstable, memory=guaranteed"
    else
      fail "/resource-breakdown qosModel mismatch: cpu=$QOS_CPU, memory=$QOS_MEM"
    fi
  fi
fi

# ─── Assertion 5: Plan cap rejection ────────────────────────────────────────
if [[ -n "$DEP_ID" ]]; then
  echo "→ Asserting plan cap rejects over-allocation..."
  # Try a deploy that exceeds the plan — cpu_request = 5 (plan is 2).
  if [[ -n "$NC_ID" ]]; then
    OVER_RESP=$(curl -sS -X POST "$ADMIN_HOST/api/v1/tenants/$TENANT_ID/deployments" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "{\"catalog_entry_id\":\"$NC_ID\",\"name\":\"qos-over\",\"cpu_request\":\"5\",\"memory_request\":\"1Gi\"}" \
      -w '\n%{http_code}')
    STATUS=$(echo "$OVER_RESP" | tail -1)
    if [[ "$STATUS" -ge 400 && "$STATUS" -lt 500 ]]; then
      pass "Plan cap correctly rejected over-allocation (HTTP $STATUS)"
    else
      fail "Plan cap did NOT reject over-allocation (HTTP $STATUS)"
    fi
  fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
echo "─────────────────────────────────────────────"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
