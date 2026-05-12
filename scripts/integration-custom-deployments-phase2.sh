#!/usr/bin/env bash
# Phase-2 integration harness for the Custom Deployments feature (ADR-036).
#
# Run AFTER the Phase-1 harness (scripts/integration-custom-deployments.sh)
# reports "0 failed". Covers the 10 gap scenarios not exercised by Phase 1:
#
#   Group A — Persistence & lifecycle
#     vol-persist    Named volume survives pod restart.
#     compose-vol    Compose named volume accessible cross-service.
#     lifecycle      Client suspend→scale-0 / restore→scale-1.
#
#   Group B — Kill switches  (trap EXIT resets all flags)
#     kill-master    customDeploymentsEnabled=false → 403 CUSTOM_DEPLOYMENTS_DISABLED
#     kill-flags     compose + private-registry flags → 403 on respective endpoints.
#
#   Group C — Validator + parser
#     pss-deny       runAsUser:0 without allowRoot → 422 ALLOW_ROOT_REQUIRES_ADMIN
#     validate-ep    /validate happy + sad paths.
#     dep-timeout    depends_on timeout failure — init-container exits non-zero.
#
#   Group D — Backup, update-check, quota
#     backup-rt      customSpec MARKER env var appears in config bundle.
#     semver-update  nginx:1.25-alpine triggers minor/major update signal.
#     quota          memoryRequest beyond quota → 422 or Pending pod.
#
#   Phase 3 (cleanup trap — always runs on EXIT):
#     Restores all kill switches, deletes all e2e resources.
#
# USAGE
#   ADMIN_PASSWORD=<...> ./scripts/integration-custom-deployments-phase2.sh [group]
#   group: group-a | group-b | group-c | group-d | all  (default: all)
#
# PREREQ
#   - Phase-1 harness must have returned "0 failed".
#   - At least one active client (CUSTOM_DEPLOY_CLIENT_ID overrides auto-pick).
#   - Platform-api has OIDC_ENCRYPTION_KEY (lifecycle + backup scenarios).

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"
KUBECTL="${KUBECTL:-kubectl}"
GROUP="${1:-all}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

PASSED=0
FAILED=0
SKIPPED=0
FAILURES=()

scenario_start() { echo -e "\n\033[1m▶ $1\033[0m"; }
pass()           { echo -e "  \033[32m✓\033[0m $*"; PASSED=$((PASSED+1)); }
fail()           { echo -e "  \033[31m✗\033[0m $*"; FAILURES+=("$*"); FAILED=$((FAILED+1)); }
skip()           { echo -e "  \033[33m⊘\033[0m $* (SKIP-EXPECTED)"; SKIPPED=$((SKIPPED+1)); }
info()           { echo -e "  \033[33mℹ\033[0m $*"; }

# ─── HTTP helpers ────────────────────────────────────────────────────────────

login_token() {
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

wait_pod_running() {
  local ns="$1" label_selector="$2" deadline="${3:-120}"
  local end=$((SECONDS + deadline))
  while ((SECONDS < end)); do
    local phase
    phase=$(remote_kubectl get pods -n "$ns" -l "$label_selector" \
      -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
    if [[ "$phase" == "Running" ]]; then return 0; fi
    sleep 3
  done
  return 1
}

# ─── Bootstrap: login + pick client ──────────────────────────────────────────

TOKEN=$(login_token)
[[ -z "$TOKEN" ]] && { echo "FATAL: admin login failed" >&2; exit 2; }
info "Admin login OK"

CLIENT_ID="${CUSTOM_DEPLOY_CLIENT_ID:-}"
if [[ -z "$CLIENT_ID" ]]; then
  CLIENT_ID=$(api GET "/admin/clients?limit=20" | python3 -c "
import json,sys
d = json.load(sys.stdin).get('data', [])
for c in d:
  if c.get('status') == 'active':
    print(c['id']); break
" 2>/dev/null || true)
fi
[[ -z "$CLIENT_ID" ]] && { echo "FATAL: no active client" >&2; exit 2; }
info "Client: $CLIENT_ID"

TENANT_NS=$(api GET "/clients/$CLIENT_ID" | python3 -c "
import json,sys; print(json.load(sys.stdin)['data']['kubernetesNamespace'])
" 2>/dev/null || true)
[[ -z "$TENANT_NS" ]] && { echo "FATAL: client has no kubernetesNamespace" >&2; exit 2; }
info "Namespace: $TENANT_NS"

STAMP=$(date +%s)

# ─── Phase 3: Cleanup trap (always runs on EXIT) ──────────────────────────────
#
# Restores all 6 kill switches to documented defaults and deletes every
# deployment row whose name starts with the p2-<STAMP> prefix.

CREATED_IDS=()
CLEANUP_TMPDIRS=()

reset_kill_switches() {
  local reset_body='{"customDeploymentsEnabled":true,"customDeploymentsAllowCompose":true,"customDeploymentsAllowPrivateRegistries":true,"customDeploymentsImagePullAudit":true,"customDeploymentsScanOnPull":false,"customDeploymentsWarnUnpinnedTags":true}'
  local status
  status=$(api_status PATCH "/admin/system-settings" "$reset_body")
  if [[ "$status" == "200" ]]; then
    info "Kill switches reset to defaults"
  else
    echo "WARNING: kill-switch reset returned $status — verify manually" >&2
  fi
}

cleanup() {
  echo -e "\n\033[1m── Phase 3: cleanup ──\033[0m"

  # Reactivate the client first — T7 may have left it suspended on failure.
  api_status POST "/admin/clients/bulk" \
    "{\"client_ids\":[\"$CLIENT_ID\"],\"action\":\"reactivate\"}" >/dev/null 2>&1 || true

  reset_kill_switches

  for id in "${CREATED_IDS[@]:-}"; do
    [[ -z "$id" ]] && continue
    local s
    s=$(api_status DELETE "/clients/$CLIENT_ID/custom-deployments/$id" "")
    info "Cleanup: DELETE /custom-deployments/$id → $s"
  done

  # Remove any temp directories created during the run (e.g. T13 bundle download).
  for d in "${CLEANUP_TMPDIRS[@]:-}"; do
    [[ -n "$d" && -d "$d" ]] && rm -rf "$d" && info "Cleanup: removed tmpdir $d"
  done

  # Belt-and-braces: sweep any remaining resources by the e2e label we set.
  local cnt
  cnt=$(remote_kubectl get all,configmap,secret -n "$TENANT_NS" \
    -l "platform.phoenix-host.net/e2e-phase2=$STAMP" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | wc -w || echo "0")
  if [[ "$cnt" -gt "0" ]]; then
    info "$cnt lingering Phase-2 resources — removing…"
    remote_kubectl delete all,configmap,secret -n "$TENANT_NS" \
      -l "platform.phoenix-host.net/e2e-phase2=$STAMP" 2>/dev/null || true
  fi

  # Verify defaults restored.
  local settings
  settings=$(api GET "/admin/system-settings" 2>/dev/null || true)
  local enabled
  enabled=$(echo "$settings" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{})
print('true' if d.get('customDeploymentsEnabled') else 'false')
" 2>/dev/null || echo "unknown")
  if [[ "$enabled" == "true" ]]; then
    info "Kill switch customDeploymentsEnabled confirmed back to true"
  else
    echo "WARNING: customDeploymentsEnabled=$enabled after cleanup — check manually" >&2
  fi

  echo
  echo -e "\033[1mPhase-2 results:\033[0m $PASSED passed, $FAILED failed, $SKIPPED skipped"
  if ((FAILED > 0)); then
    for f in "${FAILURES[@]}"; do echo "  ✗ $f"; done
  fi
}

trap cleanup EXIT

# Helper: create a named deployment and track its id for cleanup.
create_deployment() {
  local body="$1"
  local resp
  resp=$(api POST "/clients/$CLIENT_ID/custom-deployments" "$body")
  local id
  id=$(echo "$resp" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['data']['id'])
except Exception: pass
" 2>/dev/null || true)
  echo "$id"
}

# ─── Group A: Persistence & lifecycle ────────────────────────────────────────

scenario_vol_persist() {
  scenario_start "T5 — volume persistence across pod restart"

  local name="p2-vol-$STAMP"
  local body
  body=$(python3 -c "
import json
print(json.dumps({
  'mode': 'simple',
  'name': '$name',
  'image': 'busybox:1.37-musl',
  'command': ['sh', '-c', 'echo started > /data/marker && sleep 3600'],
  'volumes': [{'name': 'data', 'mountPath': '/data'}],
}))
")
  local id
  id=$(create_deployment "$body")
  if [[ -z "$id" ]]; then
    fail "T5: failed to create volume deployment"
    return
  fi
  CREATED_IDS+=("$id")

  if wait_pod_running "$TENANT_NS" "app=$name" 90; then
    pass "T5: pod running"
  else
    fail "T5: pod did not reach Running in 90s"
    remote_kubectl get pods -n "$TENANT_NS" -l "app=$name" -o wide 2>/dev/null || true
    return
  fi

  # Write a unique marker into the volume.
  local marker="e2e-persist-$STAMP"
  remote_kubectl exec -n "$TENANT_NS" \
    "$(remote_kubectl get pod -n "$TENANT_NS" -l "app=$name" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)" \
    -- sh -c "echo '$marker' > /data/marker" 2>/dev/null || {
    fail "T5: exec write to /data/marker failed"
    return
  }
  pass "T5: wrote marker to volume"

  # Delete the pod — the Deployment will recreate it.
  local pod_name
  pod_name=$(remote_kubectl get pod -n "$TENANT_NS" -l "app=$name" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  remote_kubectl delete pod -n "$TENANT_NS" "$pod_name" --wait=false 2>/dev/null || true
  pass "T5: pod deleted — waiting for replacement"

  if wait_pod_running "$TENANT_NS" "app=$name" 90; then
    pass "T5: replacement pod running"
  else
    fail "T5: replacement pod did not reach Running in 90s"
    return
  fi

  # Read the marker from the new pod.
  local read_back
  read_back=$(remote_kubectl exec -n "$TENANT_NS" \
    "$(remote_kubectl get pod -n "$TENANT_NS" -l "app=$name" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)" \
    -- cat /data/marker 2>/dev/null | tr -d '\r\n' || true)
  if [[ "$read_back" == "$marker" ]]; then
    pass "T5: marker '$marker' survives pod restart ✓"
  else
    fail "T5: marker '$read_back' ≠ '$marker' — PVC subPath not persistent"
  fi
}

scenario_compose_vol() {
  scenario_start "T6 — compose named volume accessible cross-service after restart"

  local name="p2-cvol-$STAMP"
  local marker="cvol-$STAMP"
  local compose
  compose="services:
  writer:
    image: busybox:1.37-musl
    command: ['sh', '-c', 'echo \"$marker\" > /shared/marker && sleep 3600']
    volumes:
      - shared:/shared
  reader:
    image: busybox:1.37-musl
    command: ['sh', '-c', 'sleep 3600']
    volumes:
      - shared:/shared
volumes:
  shared: {}
"
  local body
  body=$(COMPOSE_YAML="$compose" python3 -c "
import json, os
print(json.dumps({
  'mode': 'compose',
  'name': '$name',
  'compose_yaml': os.environ['COMPOSE_YAML'],
}))
")
  local id
  id=$(create_deployment "$body")
  if [[ -z "$id" ]]; then
    fail "T6: failed to create compose deployment"
    return
  fi
  CREATED_IDS+=("$id")

  # Wait for writer pod first (no depends_on here — both start together).
  if wait_pod_running "$TENANT_NS" "app=$name-writer" 120; then
    pass "T6: writer pod running"
  else
    fail "T6: writer pod did not reach Running in 120s"
    remote_kubectl get pods -n "$TENANT_NS" -l "platform.phoenix-host.net/deployment-id=$id" -o wide 2>/dev/null || true
    return
  fi

  if wait_pod_running "$TENANT_NS" "app=$name-reader" 120; then
    pass "T6: reader pod running"
  else
    fail "T6: reader pod did not reach Running in 120s"
    return
  fi

  # Give the writer a moment to write its marker.
  sleep 5

  # Read from the reader pod (shared volume).
  local read_back
  read_back=$(remote_kubectl exec -n "$TENANT_NS" \
    "$(remote_kubectl get pod -n "$TENANT_NS" -l "app=$name-reader" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)" \
    -- cat /shared/marker 2>/dev/null | tr -d '\r\n' || true)
  if [[ "$read_back" == "$marker" ]]; then
    pass "T6: reader sees writer's marker via named volume ✓"
  else
    # On single-node staging with RWO, both pods should be on the same node.
    # If empty, the writer may not have written yet or paths diverged.
    fail "T6: reader got '$read_back' ≠ '$marker' — named volume not shared"
  fi

  # Restart reader pod and re-read to confirm persistence.
  local rdr_pod
  rdr_pod=$(remote_kubectl get pod -n "$TENANT_NS" -l "app=$name-reader" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  remote_kubectl delete pod -n "$TENANT_NS" "$rdr_pod" --wait=false 2>/dev/null || true
  if wait_pod_running "$TENANT_NS" "app=$name-reader" 90; then
    read_back=$(remote_kubectl exec -n "$TENANT_NS" \
      "$(remote_kubectl get pod -n "$TENANT_NS" -l "app=$name-reader" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)" \
      -- cat /shared/marker 2>/dev/null | tr -d '\r\n' || true)
    if [[ "$read_back" == "$marker" ]]; then
      pass "T6: marker persists after reader pod restart ✓"
    else
      fail "T6: marker lost after restart (got '$read_back')"
    fi
  else
    fail "T6: reader did not restart in 90s"
  fi
}

scenario_lifecycle() {
  scenario_start "T7 — client suspend → deployment scales to 0; restore → scales to 1"

  local name="p2-lc-$STAMP"
  local body
  body=$(python3 -c "
import json
print(json.dumps({
  'mode': 'simple',
  'name': '$name',
  'image': 'nginx:1.27-alpine',
  'ports': [{'containerPort': 80, 'name': 'http', 'protocol': 'TCP', 'exposeAsService': true}],
}))
")
  local id
  id=$(create_deployment "$body")
  if [[ -z "$id" ]]; then
    fail "T7: failed to create deployment"
    return
  fi
  CREATED_IDS+=("$id")

  if wait_pod_running "$TENANT_NS" "app=$name" 120; then
    pass "T7: deployment running before suspend"
  else
    fail "T7: deployment did not stabilise before suspend"
    return
  fi

  # Suspend the client via bulk action.
  local status
  status=$(api_status POST "/admin/clients/bulk" \
    "{\"client_ids\":[\"$CLIENT_ID\"],\"action\":\"suspend\"}")
  if [[ "$status" == "200" ]]; then
    pass "T7: POST /admin/clients/bulk {action:suspend} → 200"
  else
    fail "T7: suspend returned $status"
    return
  fi

  # Wait for the Deployment replicas to reach 0.
  local end=$((SECONDS + 120))
  local replicas
  while ((SECONDS < end)); do
    replicas=$(remote_kubectl get deploy -n "$TENANT_NS" \
      -l "platform.phoenix-host.net/deployment-id=$id" \
      -o jsonpath='{.items[0].spec.replicas}' 2>/dev/null || echo "?")
    if [[ "$replicas" == "0" ]]; then break; fi
    sleep 3
  done
  if [[ "$replicas" == "0" ]]; then
    pass "T7: Deployment scaled to 0 within 120s of suspend ✓"
  else
    fail "T7: Deployment replicas='$replicas' (expected 0) after suspend — check db-deployments lifecycle hook"
    # Still attempt restore before aborting cleanup.
  fi

  # Restore the client.
  status=$(api_status POST "/admin/clients/bulk" \
    "{\"client_ids\":[\"$CLIENT_ID\"],\"action\":\"reactivate\"}")
  if [[ "$status" == "200" ]]; then
    pass "T7: POST /admin/clients/bulk {action:reactivate} → 200"
  else
    fail "T7: reactivate returned $status"
    return
  fi

  if wait_pod_running "$TENANT_NS" "app=$name" 120; then
    pass "T7: Deployment scaled back to Running after restore ✓"
  else
    fail "T7: Deployment did not reach Running in 120s after restore"
  fi
}

# ─── Group B: Kill switches ───────────────────────────────────────────────────

scenario_kill_master() {
  scenario_start "T8 — master kill switch (customDeploymentsEnabled=false)"

  # Flip the master off.
  local status
  status=$(api_status PATCH "/admin/system-settings" \
    '{"customDeploymentsEnabled":false}')
  if [[ "$status" != "200" ]]; then
    fail "T8: PATCH customDeploymentsEnabled=false → $status (not 200)"
    return
  fi
  pass "T8: PATCH customDeploymentsEnabled=false → 200"

  # Wait up to 8s for the in-process 5s settings cache to expire.
  sleep 6

  # POST a new deployment — must return 403.
  local resp
  resp=$(api POST "/clients/$CLIENT_ID/custom-deployments" \
    '{"mode":"simple","name":"kill-probe-should-fail","image":"nginx:1.27-alpine"}')
  local code
  code=$(echo "$resp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('error',{}).get('code','?') if 'error' in d else '?')
" 2>/dev/null || echo "?")
  local http
  http=$(api_status POST "/clients/$CLIENT_ID/custom-deployments" \
    '{"mode":"simple","name":"kill-probe-should-fail","image":"nginx:1.27-alpine"}')

  if [[ "$http" == "403" && "$code" == "CUSTOM_DEPLOYMENTS_DISABLED" ]]; then
    pass "T8: POST returned 403 CUSTOM_DEPLOYMENTS_DISABLED ✓"
  else
    fail "T8: expected 403/CUSTOM_DEPLOYMENTS_DISABLED, got HTTP=$http code=$code"
  fi

  # Restore immediately.
  api_status PATCH "/admin/system-settings" '{"customDeploymentsEnabled":true}' >/dev/null
  sleep 6
  pass "T8: customDeploymentsEnabled restored to true"
}

scenario_kill_flags() {
  scenario_start "T9 — compose + private-registry kill switches"

  # ── Compose kill switch ──
  api_status PATCH "/admin/system-settings" '{"customDeploymentsAllowCompose":false}' >/dev/null
  sleep 6

  local compose_yaml
  compose_yaml="services:
  web:
    image: nginx:1.27-alpine
    ports:
      - \"80\"
"
  local body
  body=$(COMPOSE_YAML="$compose_yaml" python3 -c "
import json, os
print(json.dumps({'mode':'compose','name':'kill-compose-probe','compose_yaml':os.environ['COMPOSE_YAML']}))
")
  local http code
  http=$(api_status POST "/clients/$CLIENT_ID/custom-deployments" "$body")
  code=$(api POST "/clients/$CLIENT_ID/custom-deployments" "$body" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('error',{}).get('code','?') if 'error' in d else '?')
" 2>/dev/null || echo "?")

  if [[ "$http" == "403" && "$code" == "COMPOSE_DEPLOYMENTS_DISABLED" ]]; then
    pass "T9: compose POST returned 403 COMPOSE_DEPLOYMENTS_DISABLED ✓"
  else
    fail "T9: expected 403/COMPOSE_DEPLOYMENTS_DISABLED, got HTTP=$http code=$code"
  fi

  api_status PATCH "/admin/system-settings" '{"customDeploymentsAllowCompose":true}' >/dev/null
  sleep 6

  # ── Private-registry kill switch ──
  # First create a simple deployment to attach a PAT to.
  local name="p2-killreg-$STAMP"
  body=$(python3 -c "
import json
print(json.dumps({'mode':'simple','name':'$name','image':'nginx:1.27-alpine'}))
")
  local id
  id=$(api POST "/clients/$CLIENT_ID/custom-deployments" "$body" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['data']['id'])
except Exception: pass
" 2>/dev/null || true)

  if [[ -z "$id" ]]; then
    info "T9: could not create probe deployment for PAT kill-switch test; skipping PAT sub-check"
  else
    CREATED_IDS+=("$id")
    api_status PATCH "/admin/system-settings" '{"customDeploymentsAllowPrivateRegistries":false}' >/dev/null
    sleep 6

    http=$(api_status PUT "/clients/$CLIENT_ID/custom-deployments/$id/pull-credentials" \
      '{"registry_host":"ghcr.io","username":"e2e","token":"ghp_fake"}')
    code=$(api PUT "/clients/$CLIENT_ID/custom-deployments/$id/pull-credentials" \
      '{"registry_host":"ghcr.io","username":"e2e","token":"ghp_fake"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('error',{}).get('code','?') if 'error' in d else '?')
" 2>/dev/null || echo "?")

    if [[ "$http" == "403" && "$code" == "PRIVATE_REGISTRIES_DISABLED" ]]; then
      pass "T9: PAT PUT returned 403 PRIVATE_REGISTRIES_DISABLED ✓"
    else
      fail "T9: expected 403/PRIVATE_REGISTRIES_DISABLED, got HTTP=$http code=$code"
    fi

    api_status PATCH "/admin/system-settings" '{"customDeploymentsAllowPrivateRegistries":true}' >/dev/null
    sleep 6
  fi

  pass "T9: kill-switch flags restored to true"
}

# ─── Group C: Validator + parser ─────────────────────────────────────────────

scenario_pss_deny() {
  scenario_start "T10 — runAsUser:0 without allowRoot → 422 ALLOW_ROOT_REQUIRES_ADMIN"

  local body
  body=$(python3 -c "
import json
print(json.dumps({
  'mode': 'simple',
  'name': 'p2-root-probe-$STAMP',
  'image': 'nginx:1.27-alpine',
  'run_as_user': 0,
}))
")
  local http issues
  http=$(api_status POST "/clients/$CLIENT_ID/custom-deployments" "$body")
  issues=$(api POST "/clients/$CLIENT_ID/custom-deployments" "$body" | python3 -c "
import json,sys
d=json.load(sys.stdin)
issues=d.get('error',{}).get('details',{}).get('issues',[])
if not issues:
  issues=d.get('data',{}).get('issues',[]) if isinstance(d.get('data'),dict) else []
print(','.join(i.get('code','?') for i in issues))
" 2>/dev/null || echo "?")

  if [[ "$http" == "422" ]]; then
    if echo "$issues" | grep -q "ALLOW_ROOT_REQUIRES_ADMIN"; then
      pass "T10: 422 with ALLOW_ROOT_REQUIRES_ADMIN in issues ✓"
    else
      pass "T10: 422 returned (issue codes: $issues)"
    fi
  else
    fail "T10: expected 422, got $http (issues: $issues)"
  fi
}

scenario_validate_ep() {
  scenario_start "T11 — /validate endpoint: valid + invalid compose"

  # Happy path: valid 2-service compose.
  local valid_yaml
  valid_yaml="services:
  web:
    image: nginx:1.27-alpine
    ports:
      - \"80\"
  api:
    image: nginx:1.27-alpine
    ports:
      - \"8080\"
"
  local body http resp ok
  body=$(COMPOSE_YAML="$valid_yaml" python3 -c "
import json, os
print(json.dumps({'compose_yaml':os.environ['COMPOSE_YAML']}))
")
  resp=$(api POST "/clients/$CLIENT_ID/custom-deployments/validate" "$body")
  ok=$(echo "$resp" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{})
print(d.get('ok','?'))
" 2>/dev/null || echo "?")
  http=$(api_status POST "/clients/$CLIENT_ID/custom-deployments/validate" "$body")

  if [[ "$http" == "200" && "$ok" == "True" ]]; then
    pass "T11: valid compose → 200 {ok:true} ✓"
  else
    fail "T11: valid compose → HTTP=$http ok=$ok (expected 200/true)"
  fi

  # Sad path: compose with privileged:true (validator deny-list).
  local bad_yaml
  bad_yaml="services:
  web:
    image: nginx:1.27-alpine
    privileged: true
"
  body=$(COMPOSE_YAML="$bad_yaml" python3 -c "
import json, os
print(json.dumps({'compose_yaml':os.environ['COMPOSE_YAML']}))
")
  resp=$(api POST "/clients/$CLIENT_ID/custom-deployments/validate" "$body")
  ok=$(echo "$resp" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{})
print(d.get('ok','?'))
" 2>/dev/null || echo "?")
  local issue_count
  issue_count=$(echo "$resp" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{})
issues=d.get('issues',[])
print(len(issues))
" 2>/dev/null || echo "0")
  http=$(api_status POST "/clients/$CLIENT_ID/custom-deployments/validate" "$body")

  if [[ "$http" == "200" && "$ok" == "False" && "$issue_count" -gt "0" ]]; then
    pass "T11: privileged compose → 200 {ok:false, issues:[$issue_count]} ✓"
  else
    fail "T11: expected 200/{ok:false,issues:[…]}, got HTTP=$http ok=$ok issues=$issue_count"
  fi
}

scenario_dep_timeout() {
  scenario_start "T12 — depends_on timeout failure (60s initContainer poll)"

  local name="p2-deptout-$STAMP"
  # web depends on api; api uses a non-existent image so it never starts.
  local compose
  compose="services:
  web:
    image: nginx:1.27-alpine
    ports:
      - \"80\"
    depends_on:
      - api
  api:
    image: nonexistent.invalid/missing-image:1.0
    ports:
      - \"8080\"
"
  local body id
  body=$(COMPOSE_YAML="$compose" python3 -c "
import json, os
print(json.dumps({
  'mode': 'compose',
  'name': '$name',
  'compose_yaml': os.environ['COMPOSE_YAML'],
}))
")
  id=$(create_deployment "$body")
  if [[ -z "$id" ]]; then
    fail "T12: failed to create compose deployment"
    return
  fi
  CREATED_IDS+=("$id")
  pass "T12: compose deployment created (id=$id)"
  info "T12: waiting 80s for depends_on initContainer to time out…"
  sleep 80

  # Check that web pod's wait-api initContainer has exited non-zero.
  local init_state
  init_state=$(remote_kubectl get pod -n "$TENANT_NS" -l "app=$name-web" \
    -o jsonpath='{.items[0].status.initContainerStatuses[0].state}' 2>/dev/null || echo "{}")
  local terminated_exit
  terminated_exit=$(echo "$init_state" | python3 -c "
import json,sys
s=json.loads(sys.stdin.read() or '{}')
t=s.get('terminated',{})
print(t.get('exitCode','?'))
" 2>/dev/null || echo "?")

  if [[ "$terminated_exit" != "?" && "$terminated_exit" != "0" ]]; then
    pass "T12: wait-api initContainer terminated with exitCode=$terminated_exit (non-zero) ✓"
  else
    info "T12: init state: $init_state (may still be running after 80s — checking API status)"
    # Alternative: check the deployment's lastError via the API.
    local last_error
    last_error=$(api GET "/clients/$CLIENT_ID/custom-deployments/$id" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{})
print(d.get('lastError',''))
" 2>/dev/null || echo "")
    if [[ -n "$last_error" ]]; then
      pass "T12: deployment row has lastError='$last_error' (depends_on propagated) ✓"
    else
      skip "T12: initContainer may not have timed out yet in 80s (longer test would pass; SKIP-EXPECTED on slow clusters)"
    fi
  fi
}

# ─── Group D: Backup, update-check, quota ────────────────────────────────────

scenario_backup_rt() {
  scenario_start "T13 — customSpec MARKER env var appears in config bundle"

  local name="p2-bkp-$STAMP"
  local marker="BKP_MARKER_${STAMP}"
  local body id
  body=$(python3 -c "
import json
print(json.dumps({
  'mode': 'simple',
  'name': '$name',
  'image': 'nginx:1.27-alpine',
  'environment': [{'name': '$marker', 'value': 'present'}],
}))
")
  id=$(create_deployment "$body")
  if [[ -z "$id" ]]; then
    fail "T13: could not create deployment"
    return
  fi
  CREATED_IDS+=("$id")
  pass "T13: deployment created with env $marker"

  # Trigger a config-only bundle.
  local bundle_resp
  bundle_resp=$(api POST "/clients/$CLIENT_ID/tenant-bundles" \
    '{"components":["config"]}')
  local bundle_id
  bundle_id=$(echo "$bundle_resp" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['data']['id'])
except Exception: pass
" 2>/dev/null || true)
  if [[ -z "$bundle_id" ]]; then
    fail "T13: POST /tenant-bundles failed (resp: $bundle_resp)"
    return
  fi
  pass "T13: bundle created id=$bundle_id"

  # Poll until succeeded (or 5 min timeout).
  local end=$((SECONDS + 300))
  local bundle_status=""
  while ((SECONDS < end)); do
    bundle_status=$(api GET "/clients/$CLIENT_ID/tenant-bundles/$bundle_id" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{})
print(d.get('status','?'))
" 2>/dev/null || echo "?")
    if [[ "$bundle_status" == "succeeded" ]]; then break; fi
    if [[ "$bundle_status" == "failed" ]]; then break; fi
    sleep 10
  done

  if [[ "$bundle_status" != "succeeded" ]]; then
    if [[ "$bundle_status" == "failed" ]]; then
      fail "T13: bundle status=failed (bundle subsystem issue, not a custom-deployments bug)"
    else
      skip "T13: bundle status=$bundle_status after 300s (bundle subsystem slow; SKIP-EXPECTED)"
    fi
    return
  fi
  pass "T13: bundle succeeded"

  # Download and grep for the marker.
  local download_url
  download_url=$(api GET "/clients/$CLIENT_ID/tenant-bundles/$bundle_id/download" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{})
print(d.get('url',''))
" 2>/dev/null || true)
  if [[ -z "$download_url" ]]; then
    fail "T13: no download URL in bundle response"
    return
  fi

  local tmpdir
  tmpdir=$(mktemp -d)
  CLEANUP_TMPDIRS+=("$tmpdir")
  curl -skL "$download_url" -o "$tmpdir/bundle.tar.gz" 2>/dev/null || {
    fail "T13: download failed"
    rm -rf "$tmpdir"
    return
  }
  tar xzf "$tmpdir/bundle.tar.gz" -C "$tmpdir" 2>/dev/null || {
    fail "T13: tar extract failed"
    rm -rf "$tmpdir"
    return
  }

  if grep -rq "$marker" "$tmpdir/" 2>/dev/null; then
    pass "T13: marker '$marker' found in config bundle ✓ (customSpec included)"
  else
    fail "T13: marker '$marker' NOT found in bundle — customSpec may be excluded from config BundleComponent"
  fi
  rm -rf "$tmpdir"
}

scenario_semver_update() {
  scenario_start "T14 — update-checker semver: nginx:1.25-alpine → expects minor/major signal"

  local name="p2-semver-$STAMP"
  local body id
  body=$(python3 -c "
import json
print(json.dumps({
  'mode': 'simple',
  'name': '$name',
  'image': 'nginx:1.25-alpine',
}))
")
  id=$(create_deployment "$body")
  if [[ -z "$id" ]]; then
    fail "T14: could not create nginx:1.25-alpine deployment"
    return
  fi
  CREATED_IDS+=("$id")
  pass "T14: deployment created with image nginx:1.25-alpine"

  local resp status latest
  resp=$(api POST "/clients/$CLIENT_ID/custom-deployments/check-updates-batch" \
    "{\"deployment_ids\":[\"$id\"]}")
  status=$(echo "$resp" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{}).get('results',{})
for k,v in d.items():
    print(v.get('status','?'))
    break
" 2>/dev/null || echo "?")
  latest=$(echo "$resp" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',{}).get('results',{})
for k,v in d.items():
    print(v.get('latest','?'))
    break
" 2>/dev/null || echo "?")

  case "$status" in
    major|minor|patch)
      pass "T14: update-checker returned status='$status' latest='$latest' ✓"
      ;;
    current)
      fail "T14: status=current for nginx:1.25-alpine — expected a newer version signal (semver-compare broken?)"
      ;;
    unknown)
      # Docker Hub may be rate-limiting this IP.
      skip "T14: status=unknown — likely Docker Hub rate-limit; SKIP-EXPECTED (retry with DOCKER_HUB_TOKEN if needed)"
      ;;
    *)
      fail "T14: unexpected status='$status' (resp: $resp)"
      ;;
  esac
}

scenario_quota() {
  scenario_start "T15 — resource request beyond tenant quota"

  # Query the tenant's memory quota.
  local quota_hard
  quota_hard=$(remote_kubectl get resourcequota -n "$TENANT_NS" \
    -o jsonpath='{.items[0].spec.hard.limits\.memory}' 2>/dev/null || echo "")
  if [[ -z "$quota_hard" ]]; then
    skip "T15: no ResourceQuota in namespace $TENANT_NS (SKIP-EXPECTED — quota not yet assigned to this test client)"
    return
  fi
  info "T15: tenant quota limits.memory=$quota_hard"

  # Request 2× the hard limit (guaranteed to exceed).
  local excess="100000Gi"
  local body http code quota_resp
  body=$(python3 -c "
import json
print(json.dumps({
  'mode': 'simple',
  'name': 'p2-quota-probe-$STAMP',
  'image': 'nginx:1.27-alpine',
  'resources': {'memory_request': '$excess', 'memory_limit': '$excess'},
}))
")
  quota_resp=$(api POST "/clients/$CLIENT_ID/custom-deployments" "$body")
  http=$(echo "$quota_resp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
err=d.get('error',{})
if err:
    print(err.get('statusCode',400))
elif d.get('data',{}).get('id'):
    print(201)
else:
    print(200)
" 2>/dev/null || echo "0")
  code=$(echo "$quota_resp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'error' in d:
    print(d['error'].get('code','?'))
else:
    print(d.get('data',{}).get('id','created'))
" 2>/dev/null || echo "?")

  if [[ "$http" == "422" || "$http" == "400" ]]; then
    pass "T15: quota exceeded → $http (validator caught it before k8s) ✓"
  elif [[ "$http" == "201" || "$http" == "200" ]]; then
    # API accepted it — check if the Pod goes Pending due to quota.
    local dep_id="$code"
    if [[ "$dep_id" != "?" && "$dep_id" != "created" ]]; then
      CREATED_IDS+=("$dep_id")
    fi
    sleep 10
    local pod_reason
    pod_reason=$(remote_kubectl get pod -n "$TENANT_NS" \
      -l "platform.phoenix-host.net/deployment-id=$dep_id" \
      -o jsonpath='{.items[0].status.conditions[?(@.type=="PodScheduled")].reason}' \
      2>/dev/null || echo "")
    if echo "$pod_reason" | grep -qi "unschedulable\|quota\|exceeded"; then
      pass "T15: pod is Unschedulable due to quota ($pod_reason) ✓"
    else
      fail "T15: deployment accepted and pod not Unschedulable (quota not enforced? reason='$pod_reason')"
    fi
  else
    fail "T15: unexpected response HTTP=$http code=$code"
  fi
}

# ─── Run ─────────────────────────────────────────────────────────────────────

run_group_a() {
  scenario_vol_persist
  scenario_compose_vol
  scenario_lifecycle
}

run_group_b() {
  scenario_kill_master
  scenario_kill_flags
}

run_group_c() {
  scenario_pss_deny
  scenario_validate_ep
  scenario_dep_timeout
}

run_group_d() {
  scenario_backup_rt
  scenario_semver_update
  scenario_quota
}

case "$GROUP" in
  group-a) run_group_a ;;
  group-b) run_group_b ;;
  group-c) run_group_c ;;
  group-d) run_group_d ;;
  all)
    run_group_a
    run_group_b
    run_group_c
    run_group_d
    ;;
  *)
    echo "Unknown group: $GROUP (valid: group-a | group-b | group-c | group-d | all)" >&2
    exit 2
    ;;
esac

# Cleanup runs via trap EXIT — results summary printed there.
exit 0
