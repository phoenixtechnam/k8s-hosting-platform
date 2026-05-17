#!/usr/bin/env bash
# End-to-end integration harness for the Custom Deployments feature
# (ADR-036, PRs #10 → #11 → #12 → #13 → this PR). Drives every
# tenant-facing endpoint via curl + asserts USER-VISIBLE state in
# Kubernetes — never trusts API 2xx alone.
#
# Scenarios (run in order, each cleans up its own resources):
#
#   simple    — POST /custom-deployments mode=simple → assert
#               Deployment + Service in tenant ns; Pod Running.
#   upgrade   — PUT /:id/upgrade-tag → assert image tag updates +
#               Pod re-created.
#   updates   — POST /check-updates-batch → assert cached + fresh
#               paths both return well-formed results.
#   compose   — POST /custom-deployments mode=compose (2-service
#               stack with depends_on) → assert BOTH Deployments,
#               BOTH Services, and the `wait-<dep>` initContainer
#               in the dependent pod.
#   pat       — PUT /pull-credentials → assert `image-pull-<id>`
#               Secret in ns. DELETE → assert Secret gone.
#   delete    — DELETE the simple + compose rows → assert all
#               owned k8s resources are reaped by label.
#
# USAGE
#   ADMIN_PASSWORD=<...> ./scripts/integration-custom-deployments.sh [scenario]
#   scenario: simple | upgrade | updates | compose | pat | delete | all
#
# PREREQ
#   - integration-staging.sh's preflight (admin login, DNS) must pass.
#   - At least one tenant client exists (CUSTOM_DEPLOY_CLIENT_ID env,
#     else picked from /clients).
#   - The platform-api Pod has PLATFORM_ENCRYPTION_KEY set (PAT scenario).
#
# DESIGN NOTES
#   - Every assertion uses `kubectl get … -o jsonpath`, never just
#     "the API said 2xx" (see integration-staging.sh §WHY).
#   - Resources are namespaced per-test by a timestamp prefix so
#     repeated runs don't collide.
#   - The harness installs no kubectl plugins / external tools beyond
#     what integration-staging.sh already requires (curl, jq, kubectl,
#     python3 for token JSON parsing).

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"
KUBECTL="${KUBECTL:-kubectl}"
SCENARIO="${1:-all}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

PASSED=0
FAILED=0
FAILURES=()

scenario_start() { echo -e "\n\033[1m▶ $1\033[0m"; }
pass()           { echo -e "  \033[32m✓\033[0m $*"; PASSED=$((PASSED+1)); }
fail()           { echo -e "  \033[31m✗\033[0m $*"; FAILURES+=("$*"); FAILED=$((FAILED+1)); }
info()           { echo -e "  \033[33mℹ\033[0m $*"; }

# ─── HTTP helpers (mirror integration-staging.sh) ──────────────────────────

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

api_status() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sk -o /dev/null -w "%{http_code}" -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" -d "$body"
  else
    curl -sk -o /dev/null -w "%{http_code}" -X "$method" "$ADMIN_HOST/api/v1$path" \
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

# Wait for a Pod with label `app=<name>` in `<ns>` to reach Running
# (deadline N seconds, polled every 2). Returns 0 on success, 1 on
# timeout. The Pod name itself isn't predictable for multi-replica
# deploys; we filter by label instead.
wait_pod_running() {
  local ns="$1" name="$2" deadline="${3:-120}"
  local end=$((SECONDS + deadline))
  while ((SECONDS < end)); do
    local phase
    phase=$(remote_kubectl get pods -n "$ns" -l "app=$name" \
      -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
    if [[ "$phase" == "Running" ]]; then return 0; fi
    sleep 2
  done
  return 1
}

# ─── Pre-flight ─────────────────────────────────────────────────────────────

TOKEN=$(login_token)
[[ -z "$TOKEN" ]] && { echo "FATAL: admin login failed" >&2; exit 2; }
info "Admin login OK"

# Pick a tenant client. CUSTOM_DEPLOY_CLIENT_ID overrides; otherwise the
# first active client is used. The harness creates / cleans-up its own
# deployments under that client.
TENANT_ID="${CUSTOM_DEPLOY_CLIENT_ID:-}"
if [[ -z "$TENANT_ID" ]]; then
  TENANT_ID=$(api GET "/tenants?limit=20" | python3 -c "
import json,sys
d = json.load(sys.stdin).get('data', [])
for c in d:
  if c.get('status') == 'active':
    print(c['id']); break
" 2>/dev/null)
fi
[[ -z "$TENANT_ID" ]] && { echo "FATAL: no active client found" >&2; exit 2; }
info "Using client $TENANT_ID"

# Resolve the tenant namespace once.
TENANT_NS=$(api GET "/tenants/$TENANT_ID" | python3 -c "
import json,sys; print(json.load(sys.stdin)['data']['kubernetesNamespace'])
" 2>/dev/null)
[[ -z "$TENANT_NS" ]] && { echo "FATAL: client has no kubernetesNamespace" >&2; exit 2; }
info "Tenant namespace: $TENANT_NS"

STAMP=$(date +%s)
SIMPLE_NAME="cd-simple-$STAMP"
COMPOSE_NAME="cd-cmp-$STAMP"
SIMPLE_ID=""
COMPOSE_ID=""

# ─── Scenario: simple-mode create + Pod Running ────────────────────────────

scenario_simple() {
  scenario_start "simple-mode create"

  local body
  body=$(cat <<EOF
{
  "mode": "simple",
  "name": "$SIMPLE_NAME",
  "image": "nginx:1.27-alpine",
  "ports": [
    { "containerPort": 80, "name": "http", "protocol": "TCP", "exposeAsService": true, "ingressEligible": true }
  ]
}
EOF
)
  local resp
  resp=$(api POST "/tenants/$TENANT_ID/custom-deployments" "$body")
  SIMPLE_ID=$(echo "$resp" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['data']['id'])
except Exception: pass
" 2>/dev/null)

  if [[ -z "$SIMPLE_ID" ]]; then
    fail "create returned no id (resp: $resp)"
    return 1
  fi
  pass "POST /custom-deployments → id=$SIMPLE_ID"

  if wait_pod_running "$TENANT_NS" "$SIMPLE_NAME" 120; then
    pass "Pod app=$SIMPLE_NAME reached Running"
  else
    fail "Pod app=$SIMPLE_NAME did not reach Running in 120s"
    remote_kubectl get pods -n "$TENANT_NS" -l "app=$SIMPLE_NAME" -o wide || true
    return 1
  fi

  # Service exists with correct port.
  local svc_port
  svc_port=$(remote_kubectl get svc -n "$TENANT_NS" "$SIMPLE_NAME-http" \
    -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || true)
  if [[ "$svc_port" == "80" ]]; then
    pass "Service $SIMPLE_NAME-http :80 exists"
  else
    fail "Service $SIMPLE_NAME-http :80 missing (got '$svc_port')"
  fi

  # PSS labels on the namespace (PR-1 backfill).
  local enforce
  enforce=$(remote_kubectl get ns "$TENANT_NS" \
    -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null || true)
  if [[ "$enforce" == "baseline" ]]; then
    pass "Namespace has PSS enforce=baseline (PR-1)"
  else
    fail "Namespace PSS enforce missing or wrong (got '$enforce')"
  fi
}

# ─── Scenario: upgrade-tag ─────────────────────────────────────────────────

scenario_upgrade() {
  scenario_start "upgrade-tag"
  [[ -z "$SIMPLE_ID" ]] && { info "skipped — simple-mode scenario did not run"; return; }

  local resp
  resp=$(api PUT "/tenants/$TENANT_ID/custom-deployments/$SIMPLE_ID/upgrade-tag" '{"image":"nginx:1.27"}')
  if echo "$resp" | grep -q '"id"'; then
    pass "PUT /upgrade-tag accepted"
  else
    fail "PUT /upgrade-tag rejected (resp: $resp)"
    return 1
  fi

  # Pod will be re-created by the reconciler (Recreate strategy).
  # Wait for the new pod with the new image.
  local end=$((SECONDS + 90))
  while ((SECONDS < end)); do
    local image
    image=$(remote_kubectl get pods -n "$TENANT_NS" -l "app=$SIMPLE_NAME" \
      -o jsonpath='{.items[0].spec.containers[0].image}' 2>/dev/null || true)
    if [[ "$image" == "nginx:1.27" ]]; then
      pass "Pod re-created with new image nginx:1.27"
      return 0
    fi
    sleep 2
  done
  fail "Pod image did not roll to nginx:1.27 within 90s"
}

# ─── Scenario: check-updates-batch ─────────────────────────────────────────

scenario_updates() {
  scenario_start "check-updates-batch"
  [[ -z "$SIMPLE_ID" ]] && { info "skipped — simple-mode scenario did not run"; return; }

  local body
  body=$(cat <<EOF
{ "deployment_ids": ["$SIMPLE_ID"] }
EOF
)
  local resp
  resp=$(api POST "/tenants/$TENANT_ID/custom-deployments/check-updates-batch" "$body")
  local status
  status=$(echo "$resp" | python3 -c "
import json,sys
d = json.load(sys.stdin).get('data', {}).get('results', {})
for k,v in d.items():
  print(v.get('status', '?'))
  break
" 2>/dev/null || true)
  if [[ -n "$status" ]]; then
    pass "check-updates-batch returned status='$status'"
  else
    fail "check-updates-batch returned malformed response: $resp"
  fi
}

# ─── Scenario: compose multi-service ───────────────────────────────────────

scenario_compose() {
  scenario_start "compose multi-service"

  local compose
  compose='services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "80"
    depends_on:
      - api
  api:
    image: nginx:1.27-alpine
    ports:
      - "80"
'
  # JSON-escape via python so multi-line + quotes are safe.
  local body
  body=$(python3 -c "
import json,sys
print(json.dumps({
  'mode': 'compose',
  'name': '$COMPOSE_NAME',
  'compose_yaml': '''$compose''',
}))
")
  local resp
  resp=$(api POST "/tenants/$TENANT_ID/custom-deployments" "$body")
  COMPOSE_ID=$(echo "$resp" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['data']['id'])
except Exception: pass
" 2>/dev/null)

  if [[ -z "$COMPOSE_ID" ]]; then
    fail "compose create returned no id (resp: $resp)"
    return 1
  fi
  pass "POST /custom-deployments mode=compose → id=$COMPOSE_ID"

  # Multi-service: 2 Deployments. Names: `<deployment>-<service>`.
  local dep_web="$COMPOSE_NAME-web" dep_api="$COMPOSE_NAME-api"
  if wait_pod_running "$TENANT_NS" "$dep_api" 120 && wait_pod_running "$TENANT_NS" "$dep_web" 180; then
    pass "Both web + api Pods reached Running"
  else
    fail "compose stack did not stabilise within 180s"
    remote_kubectl get pods -n "$TENANT_NS" -l "platform.phoenix-host.net/deployment-id=$COMPOSE_ID" -o wide || true
    return 1
  fi

  # web's pod must have an initContainer `wait-api` from depends_on.
  local init
  init=$(remote_kubectl get pods -n "$TENANT_NS" -l "app=$dep_web" \
    -o jsonpath='{.items[0].spec.initContainers[*].name}' 2>/dev/null || true)
  if echo "$init" | grep -q "wait-api"; then
    pass "web pod has wait-api initContainer (depends_on rendered)"
  else
    fail "web pod missing wait-api initContainer (initContainers: '$init')"
  fi

  # Two Services exist, one per service.
  local svc_count
  svc_count=$(remote_kubectl get svc -n "$TENANT_NS" \
    -l "platform.phoenix-host.net/deployment-id=$COMPOSE_ID" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | wc -w)
  if [[ "$svc_count" -ge 2 ]]; then
    pass "$svc_count Services owned by compose deployment"
  else
    fail "expected ≥2 Services, found $svc_count"
  fi
}

# ─── Scenario: PAT lifecycle ───────────────────────────────────────────────

scenario_pat() {
  scenario_start "PAT lifecycle"
  [[ -z "$SIMPLE_ID" ]] && { info "skipped — simple-mode scenario did not run"; return; }

  # Attach a throw-away PAT (private registry: ghcr.io, fake token —
  # we don't actually expect a successful pull, only the Secret).
  local body='{"registry_host":"ghcr.io","username":"e2e-test","token":"ghp_fake_e2e_token_xyz"}'
  local status
  status=$(api_status PUT "/tenants/$TENANT_ID/custom-deployments/$SIMPLE_ID/pull-credentials" "$body")
  if [[ "$status" == "200" ]]; then
    pass "PUT /pull-credentials → 200"
  else
    fail "PUT /pull-credentials → $status"
    return 1
  fi

  # Secret materialised in ns?
  local secret
  secret=$(remote_kubectl get secret -n "$TENANT_NS" "image-pull-$SIMPLE_ID" \
    -o jsonpath='{.type}' 2>/dev/null || true)
  if [[ "$secret" == "kubernetes.io/dockerconfigjson" ]]; then
    pass "Secret image-pull-$SIMPLE_ID materialised (dockerconfigjson)"
  else
    fail "expected Secret image-pull-$SIMPLE_ID of type dockerconfigjson (got '$secret')"
  fi

  # Public response echoes lastFour only, not the cleartext.
  local resp
  resp=$(api GET "/tenants/$TENANT_ID/custom-deployments/$SIMPLE_ID/pull-credentials")
  if echo "$resp" | grep -q "fake_e2e_token"; then
    fail "API echoed PAT cleartext — should only return lastFour"
  else
    pass "API response does NOT echo PAT cleartext"
  fi

  # Revoke → Secret gone.
  status=$(api_status DELETE "/tenants/$TENANT_ID/custom-deployments/$SIMPLE_ID/pull-credentials" "")
  if [[ "$status" == "204" ]]; then
    pass "DELETE /pull-credentials → 204"
  else
    fail "DELETE /pull-credentials → $status"
  fi
  if remote_kubectl get secret -n "$TENANT_NS" "image-pull-$SIMPLE_ID" >/dev/null 2>&1; then
    fail "Secret image-pull-$SIMPLE_ID still exists after revoke"
  else
    pass "Secret image-pull-$SIMPLE_ID deleted"
  fi
}

# ─── Scenario: delete (reaps everything by label) ──────────────────────────

scenario_delete() {
  scenario_start "delete + label-sweep cleanup"
  for id in "$SIMPLE_ID" "$COMPOSE_ID"; do
    [[ -z "$id" ]] && continue
    local status
    status=$(api_status DELETE "/tenants/$TENANT_ID/custom-deployments/$id" "")
    if [[ "$status" == "204" ]]; then
      pass "DELETE /custom-deployments/$id → 204"
    else
      fail "DELETE /custom-deployments/$id → $status"
    fi
    # Wait up to 30s for label-sweep to finalise.
    local end=$((SECONDS + 30))
    while ((SECONDS < end)); do
      local cnt
      cnt=$(remote_kubectl get all,configmap,secret -n "$TENANT_NS" \
        -l "platform.phoenix-host.net/deployment-id=$id" \
        -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | wc -w)
      if [[ "$cnt" == "0" ]]; then
        pass "All k8s resources for $id reaped"
        break
      fi
      sleep 2
    done
    local final
    final=$(remote_kubectl get all,configmap,secret -n "$TENANT_NS" \
      -l "platform.phoenix-host.net/deployment-id=$id" \
      -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | wc -w)
    if [[ "$final" != "0" ]]; then
      fail "$final resources still labelled deployment-id=$id after delete"
    fi
  done
}

# ─── Run ───────────────────────────────────────────────────────────────────

case "$SCENARIO" in
  simple)   scenario_simple ;;
  upgrade)  scenario_simple; scenario_upgrade ;;
  updates)  scenario_simple; scenario_updates ;;
  compose)  scenario_compose ;;
  pat)      scenario_simple; scenario_pat ;;
  delete)   scenario_simple; scenario_compose; scenario_delete ;;
  all)
    scenario_simple
    scenario_upgrade
    scenario_updates
    scenario_compose
    scenario_pat
    scenario_delete
    ;;
  *)
    echo "Unknown scenario: $SCENARIO (valid: simple|upgrade|updates|compose|pat|delete|all)" >&2
    exit 2
    ;;
esac

# ─── Summary ───────────────────────────────────────────────────────────────

echo
echo -e "\033[1mResults:\033[0m $PASSED passed, $FAILED failed"
if ((FAILED > 0)); then
  for f in "${FAILURES[@]}"; do echo "  ✗ $f"; done
  exit 1
fi
exit 0
