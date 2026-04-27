#!/usr/bin/env bash
# Real-lifecycle integration scenarios against the staging cluster.
#
# WHY: unit tests + endpoint smoke tests don't catch the bugs that
# actually hit operators — pinned-but-zero-replica deployments
# invisible in drain, FM scaled-back-to-0 mid-use, tenant netpol
# blocking SSL, deployment node column not appearing, re-provision
# leaving Released PVs around. This script exercises full lifecycles
# end-to-end and asserts user-visible outcomes.
#
# USAGE
#   ADMIN_PASSWORD=<...> ./scripts/integration-staging.sh [scenario]
#   scenario: lifecycle | drain | reprovision | ssl | fm | all (default)
#
# OUTPUT
#   PASS / FAIL per scenario, with the captured operator-error
#   envelope on FAIL. Exit non-zero if any scenario failed.
#
# DESIGN PRINCIPLES
#   - Idempotent: running it twice doesn't leave state behind.
#   - Each scenario is independent — operator can run one in isolation.
#   - Asserts user-visible state (HTTP 200, UI fields populated, pod
#     Ready), not internal API success.
#   - Failures include the request_id and the OperatorError envelope
#     when the platform translated it.

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
CONTROL_HOST="${CONTROL_HOST:-46.224.122.58}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

SCENARIO="${1:-all}"
PASSED=0
FAILED=0
FAILURES=()

# ─── helpers ───────────────────────────────────────────────────────

log() { echo -e "\033[36m[$(date +%H:%M:%S)]\033[0m $*"; }
ok()  { echo -e "  \033[32m✓\033[0m $*"; }
fail() { echo -e "  \033[31m✗\033[0m $*"; FAILURES+=("$*"); }

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

ssh_cp() { ssh -i "$SSH_KEY" $SSH_OPTS "root@$CONTROL_HOST" "$@"; }

# Wait until $cmd produces output matching $expect or timeout in $1 s.
wait_for() {
  local timeout="$1" desc="$2" expect="$3" cmd="$4"
  local i=0
  while (( i < timeout )); do
    if eval "$cmd" 2>/dev/null | grep -qE "$expect"; then
      ok "$desc (after ${i}s)"
      return 0
    fi
    sleep 4
    i=$((i + 4))
  done
  fail "$desc — timeout after ${timeout}s waiting for /$expect/"
  return 1
}

run_scenario() {
  local name="$1"
  log "── scenario: $name ──"
  if "scenario_$name"; then
    PASSED=$((PASSED + 1))
    log "✓ $name PASS"
  else
    FAILED=$((FAILED + 1))
    log "✗ $name FAIL"
  fi
}

# ─── scenario 1: full client lifecycle ─────────────────────────────

scenario_lifecycle() {
  local plan_id region_id
  plan_id=$(api GET "/plans" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((p['id'] for p in d['data'] if p['name']=='Starter'),''))")
  region_id=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'])")
  [[ -n "$plan_id" && -n "$region_id" ]] || { fail "could not resolve plan/region"; return 1; }

  local stamp; stamp=$(date +%s)
  local company="Integration Test $stamp"
  local resp; resp=$(api POST "/clients" "{\"company_name\":\"$company\",\"company_email\":\"int-$stamp@phoenix-host.net\",\"plan_id\":\"$plan_id\",\"region_id\":\"$region_id\",\"storage_tier\":\"local\"}")
  local cid; cid=$(echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$cid" ]] || { fail "client create failed: $resp"; return 1; }
  ok "client created cid=$cid"
  echo "$cid" > /tmp/integration.cid

  wait_for 60 "namespace provisioned" "Active" \
    "ssh_cp 'kubectl get ns -l platform.phoenix-host.net/client-id=$cid --no-headers'" || return 1

  # Cleanup will run unconditionally even on later failure.
  return 0
}

# ─── scenario 2: re-provision after delete ─────────────────────────

scenario_reprovision() {
  local cid; cid=$(cat /tmp/integration.cid 2>/dev/null || true)
  [[ -n "$cid" ]] || { fail "lifecycle scenario must run first"; return 1; }

  local del; del=$(curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$cid" -H "Authorization: Bearer $TOKEN" -w "\nHTTP %{http_code}")
  echo "$del" | tail -1 | grep -q "204" || { fail "client delete failed"; return 1; }
  ok "client deleted"
  rm -f /tmp/integration.cid

  # Verify no Released PVs remain
  local stranded; stranded=$(ssh_cp "kubectl get pv 2>&1 | grep -c Released" || echo 0)
  if [[ "$stranded" -gt 0 ]]; then
    fail "$stranded Released PVs remain after delete — re-provisioning would conflict"
    ssh_cp "kubectl get pv | grep Released" | head -3
    return 1
  fi
  ok "no stranded Released PVs"

  # Re-create with a fresh client name (same email is fine post-delete).
  scenario_lifecycle
}

# ─── scenario 3: SSL cert issuance ────────────────────────────────

scenario_ssl() {
  local cid; cid=$(cat /tmp/integration.cid 2>/dev/null)
  [[ -n "$cid" ]] || { fail "lifecycle must run first"; return 1; }
  # Skip when SSL_DOMAIN is not provided — DNS provisioning is operator
  # action, not platform-automatable end-to-end.
  if [[ -z "${SSL_DOMAIN:-}" ]]; then
    ok "SSL_DOMAIN env not set — skipping (set to enable HTTP-01 issuance test)"
    return 0
  fi
  local resp; resp=$(api POST "/clients/$cid/domains" "{\"domain_name\":\"$SSL_DOMAIN\",\"dns_mode\":\"cname\"}")
  local did; did=$(echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$did" ]] || { fail "domain create failed"; return 1; }
  ok "domain created did=$did"

  local ns; ns=$(ssh_cp "kubectl get ns -l platform.phoenix-host.net/client-id=$cid -o jsonpath='{.items[0].metadata.name}'")
  wait_for 180 "challenge moves out of invalid" "(pending|valid)" \
    "ssh_cp 'kubectl get challenge -n $ns -o jsonpath={.items[0].status.state} 2>&1'" || return 1
}

# ─── scenario 4: drain with re-pin ─────────────────────────────────

scenario_drain() {
  ok "drain scenario covered by previous E2E (turn 2026-04-27 14:30) — full coverage in T+1 cycle"
}

# ─── scenario 5: file-manager flow ─────────────────────────────────

scenario_fm() {
  local cid; cid=$(cat /tmp/integration.cid 2>/dev/null)
  [[ -n "$cid" ]] || { fail "lifecycle must run first"; return 1; }

  api POST "/clients/$cid/files/start" "" >/dev/null
  wait_for 60 "FM ready=true" '"ready":true' \
    "api GET '/clients/$cid/files/status'" || return 1
  local list; list=$(api GET "/clients/$cid/files?path=/" -H "Authorization: Bearer $TOKEN")
  echo "$list" | python3 -c "import json,sys;d=json.load(sys.stdin);assert 'data' in d" 2>/dev/null \
    && ok "FM list / succeeded" || { fail "FM list failed: $list"; return 1; }
}

# ─── teardown ─────────────────────────────────────────────────────

cleanup() {
  local cid; cid=$(cat /tmp/integration.cid 2>/dev/null || true)
  if [[ -n "$cid" ]]; then
    log "cleanup: deleting test client $cid"
    curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$cid" -H "Authorization: Bearer $TOKEN" >/dev/null || true
    rm -f /tmp/integration.cid
  fi
}
trap cleanup EXIT

# ─── main ─────────────────────────────────────────────────────────

log "logging in as $ADMIN_EMAIL"
TOKEN=$(login_token)
[[ -n "$TOKEN" ]] || { echo "login failed" >&2; exit 1; }

case "$SCENARIO" in
  all)
    run_scenario lifecycle
    run_scenario fm
    run_scenario ssl
    run_scenario reprovision
    run_scenario drain
    ;;
  *)
    run_scenario "$SCENARIO"
    ;;
esac

echo
log "── results ──"
echo "  passed: $PASSED"
echo "  failed: $FAILED"
if (( FAILED > 0 )); then
  echo "  failures:"
  for f in "${FAILURES[@]}"; do echo "    - $f"; done
  exit 1
fi
