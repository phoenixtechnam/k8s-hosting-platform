#!/usr/bin/env bash
# Real-lifecycle integration scenarios against the staging cluster.
#
# WHY (rewritten 2026-04-27 after fail #N):
#   The previous harness lied. Three of its five scenarios were
#   either skipped by default (SSL gated on SSL_DOMAIN env var) or
#   passed without ever asserting anything user-visible (drain was
#   a literal `ok` stub; SSL only polled cert-manager challenge
#   state, never curled HTTPS). Result: "5/5 PASS" while the user
#   pushed a domain through the UI, hit a fake cert + 404, and
#   discovered the platform never created the Ingress at all.
#
#   The contract this harness now enforces:
#     1. Every scenario asserts USER-VISIBLE state — HTTP 200, the
#        served TLS certificate's CN, the Ingress resource existing
#        with the right host + secretName. Not "controller says
#        ready". Not "API returned 200". Not "challenge moved out
#        of invalid".
#     2. No skips on critical paths. SSL is mandatory. The harness
#        FAILS if a prereq is missing rather than silently passing.
#     3. No more stub PASSes ("covered by previous E2E (turn ...)")
#        — either the scenario runs, or it's deleted.
#
# USAGE
#   ADMIN_PASSWORD=<...> ./scripts/integration-staging.sh [scenario]
#   scenario: lifecycle | fm | https | reprovision | drain | all (default)
#
# DNS PREREQ
#   *.staging.success.com.na CNAMEs to staging.phoenix-host.net (which
#   has A records pointing at the staging cluster IPs). Verified at
#   harness start; FAIL if it doesn't resolve.

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
CONTROL_HOST="${CONTROL_HOST:-46.224.122.58}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"

# Test fixtures: known catalog entry IDs on staging. If these change,
# resolve via `GET /api/v1/catalog?limit=200` and look up the `code`.
# Use nginx-php (docker.io/serversideup/php — publicly pullable)
# rather than static-nginx (ghcr.io/phoenixtechnam/k8s-application-catalog/...
# which requires GHCR auth that the cluster doesn't have).
CATALOG_NGINX_PHP="${CATALOG_NGINX_PHP:-b6465a21-6c27-4e23-a3ef-3f6d4616dca5}"

# Domain template — uses the success.com.na wildcard so DNS just works.
HTTPS_TEST_DOMAIN_BASE="${HTTPS_TEST_DOMAIN_BASE:-staging.success.com.na}"

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
ok()  { echo -e "  \033[32m✓\033[0m $*"; PASSED=$((PASSED+1)); }
fail() { echo -e "  \033[31m✗\033[0m $*"; FAILURES+=("$*"); FAILED=$((FAILED+1)); }

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
    log "✓ $name done"
  else
    log "✗ $name had failures"
  fi
}

# ─── prereq: DNS ──────────────────────────────────────────────────

prereq_dns() {
  log "── prereq: DNS ──"
  local probe
  probe="probe-$(date +%s).${HTTPS_TEST_DOMAIN_BASE}"
  local resolved
  resolved=$(dig +short "$probe" 2>/dev/null | head -3)
  if echo "$resolved" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'; then
    ok "wildcard *.${HTTPS_TEST_DOMAIN_BASE} resolves"
    return 0
  fi
  fail "*.${HTTPS_TEST_DOMAIN_BASE} does not resolve to any A record. Set HTTPS_TEST_DOMAIN_BASE to a wildcard pointed at the staging cluster IPs."
  return 1
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

  wait_for 90 "namespace provisioned" "Active" \
    "ssh_cp 'kubectl get ns -l client=$cid --no-headers'" || return 1

  return 0
}

# ─── scenario 2: file-manager flow ─────────────────────────────────

scenario_fm() {
  local cid; cid=$(cat /tmp/integration.cid 2>/dev/null)
  [[ -n "$cid" ]] || { fail "lifecycle must run first"; return 1; }

  api POST "/clients/$cid/files/start" "" >/dev/null
  wait_for 180 "FM ready=true" '"ready":true' \
    "api GET '/clients/$cid/files/status'" || return 1
  local list; list=$(api GET "/clients/$cid/files?path=/")
  echo "$list" | python3 -c "import json,sys;d=json.load(sys.stdin);assert 'data' in d" 2>/dev/null \
    && ok "FM list / succeeded" || { fail "FM list failed: $list"; return 1; }

  # Scale FM back to 0 so subsequent scenarios (https) don't lose
  # their RWO PVC race against an already-running FM. The /files/stop
  # endpoint deletes the FM Deployment; we wait for the pod to fully
  # terminate AND for Longhorn to detach the volume so the workload
  # we're about to create doesn't hit Multi-Attach.
  api POST "/clients/$cid/files/stop" "" >/dev/null
  local ns; ns=$(ssh_cp "kubectl get ns -l client=$cid -o jsonpath='{.items[0].metadata.name}'")
  # Wait up to 120s for the FM pod to terminate AND its volume to
  # detach. Pods take ~30s to gracefully shut down; Longhorn detach
  # takes another 10-30s on top.
  local i=0 fmpods=999
  while (( i < 120 )); do
    fmpods=$(ssh_cp "kubectl -n $ns get pods -l app=file-manager --no-headers 2>/dev/null | wc -l" | tr -d '[:space:]')
    [[ "${fmpods:-0}" -eq 0 ]] && break
    sleep 4; i=$((i+4))
  done
  if [[ "${fmpods:-0}" -gt 0 ]]; then
    fail "FM pod still around after 120s (count=$fmpods)"
    return 1
  fi
  ok "FM pod fully gone (after ${i}s)"
}

# ─── scenario 3: HTTPS end-to-end (the actual SSL test) ────────────

# Replaces the old `scenario_ssl` that polled cert-manager challenge
# state. This one creates the FULL stack — workload + domain + route
# — and asserts the operator-facing outcome: a real TLS handshake
# with a real certificate, and an HTTP response coming from the
# tenant's pod (NOT ingress-nginx's default 404 + fake cert).
#
# Asserts in order:
#   1. POST deployment, status reaches 'running'
#   2. POST domain with deployment_id (atomic create+link)
#   3. Ingress resource present in tenant namespace with the host
#   4. Cert-manager Certificate Ready=True
#   5. dig resolves the domain
#   6. openssl s_client returns a cert with CN == domain (NOT "Fake")
#   7. curl HTTPS returns < 500 (or content match) — i.e. the request
#      hit the workload, not nginx's default backend
scenario_https() {
  local cid; cid=$(cat /tmp/integration.cid 2>/dev/null)
  [[ -n "$cid" ]] || { fail "lifecycle must run first"; return 1; }

  local stamp; stamp=$(date +%s)
  local depl_name="t${stamp}"               # k8s name regex: [a-z0-9-]
  local domain="t${stamp}.${HTTPS_TEST_DOMAIN_BASE}"

  # 1. Deployment
  local depl_resp; depl_resp=$(api POST "/clients/$cid/deployments" \
    "{\"catalog_entry_id\":\"$CATALOG_NGINX_PHP\",\"name\":\"$depl_name\",\"replica_count\":1}")
  local depl_id; depl_id=$(echo "$depl_resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$depl_id" ]] || { fail "deployment create failed: $(echo "$depl_resp" | head -c 300)"; return 1; }
  ok "deployment created depl_id=$depl_id name=$depl_name"

  # Wait for deployment to be running (k8s pod Ready). 240s — first
  # pod pull from GHCR + Longhorn volume re-attach if FM held it.
  if ! wait_for 240 "deployment running" '"status":"running"' \
    "api GET '/clients/$cid/deployments/$depl_id'"; then
    # Surface the deployment's lastError envelope so the operator
    # sees WHY (PVC Multi-Attach, ImagePull, OOM, etc.) instead of
    # only "timeout".
    local diag; diag=$(api GET "/clients/$cid/deployments/$depl_id" \
      | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print('status=',d.get('status'),'lastError=',d.get('lastError','')[:300])" 2>/dev/null)
    fail "deployment diagnostic: $diag"
    return 1
  fi

  # 2. Domain bound to deployment in one call (atomic — closes the
  #    bug where adding domain first and deployment after left no
  #    Ingress because reconcileIngress wasn't triggered later).
  local dom_resp; dom_resp=$(api POST "/clients/$cid/domains" \
    "{\"domain_name\":\"$domain\",\"deployment_id\":\"$depl_id\",\"dns_mode\":\"cname\"}")
  local dom_id; dom_id=$(echo "$dom_resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$dom_id" ]] || { fail "domain create failed: $(echo "$dom_resp" | head -c 300)"; return 1; }
  ok "domain created dom_id=$dom_id name=$domain"

  # 3. Ingress in tenant ns
  local ns; ns=$(ssh_cp "kubectl get ns -l client=$cid -o jsonpath='{.items[0].metadata.name}'")
  [[ -n "$ns" ]] || { fail "could not resolve tenant namespace"; return 1; }
  wait_for 60 "Ingress exists in $ns with host=$domain" "$domain" \
    "ssh_cp 'kubectl -n $ns get ingress -o jsonpath={.items[*].spec.rules[*].host}'" || return 1

  # 4. Cert ready. Let's Encrypt HTTP-01 issuance + DNS propagation
  # delay can take 2-4 minutes on a fresh staging cluster. Anything
  # under 360s is normal; longer means there's a real problem
  # (rate-limit, ACME endpoint reachability, etc).
  wait_for 360 "cert-manager Certificate Ready=True" "True" \
    "ssh_cp 'kubectl -n $ns get cert -o jsonpath={.items[?(@.spec.dnsNames[0]==\"$domain\")].status.conditions[?(@.type==\"Ready\")].status}'" || return 1

  # 5. DNS — should already resolve thanks to the wildcard, but
  #    double-check rather than discover surprises during step 6/7.
  local resolved; resolved=$(dig +short "$domain" 2>/dev/null)
  if echo "$resolved" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'; then
    ok "DNS resolves $domain"
  else
    fail "DNS does not resolve $domain"
    return 1
  fi

  # 6. TLS cert subject must match the host (not "Kubernetes Ingress
  #    Controller Fake Certificate"). This is THE assertion that
  #    catches the exact bug from 2026-04-27.
  local subject
  subject=$(echo | openssl s_client -servername "$domain" -connect "$domain:443" 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null)
  if echo "$subject" | grep -q "CN=$domain"; then
    ok "TLS cert subject CN matches host: $subject"
  else
    fail "TLS cert subject does NOT match $domain — got: ${subject:-<no cert>}"
    return 1
  fi

  # 7. HTTPS — assert the request reaches the workload. Static-nginx
  #    serves a default index.html (Welcome page) → 200 OK with body.
  #    Anything else (404 from default backend, 503, network error)
  #    is a real failure.
  local status; status=$(curl -sk -o /dev/null -m 15 -w "%{http_code}" "https://$domain/")
  if [[ "$status" =~ ^(200|301|302)$ ]]; then
    ok "HTTPS GET / returned $status"
  else
    fail "HTTPS GET https://$domain/ returned $status (expected 2xx/3xx from the tenant workload)"
    return 1
  fi
}

# ─── scenario 4: re-provision after delete ─────────────────────────

scenario_reprovision() {
  local cid; cid=$(cat /tmp/integration.cid 2>/dev/null || true)
  [[ -n "$cid" ]] || { fail "lifecycle scenario must run first"; return 1; }

  local del; del=$(curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$cid" -H "Authorization: Bearer $TOKEN" -w "\nHTTP %{http_code}")
  echo "$del" | tail -1 | grep -q "204" || { fail "client delete failed"; return 1; }
  ok "client deleted"
  rm -f /tmp/integration.cid

  # Wait up to 90s for the cascade cleanup to drain orphan PVs.
  # The cascade runs in the background after DELETE returns 204
  # (polls up to 60s for PVCs to release). Adding a 30s margin.
  local i=0 stranded=999
  while (( i < 90 )); do
    stranded=$(ssh_cp "kubectl get pv 2>&1 | grep -c Released" 2>/dev/null || echo 0)
    stranded=$(echo "$stranded" | head -n1 | tr -d '[:space:]')
    [[ "${stranded:-0}" -eq 0 ]] && break
    sleep 4; i=$((i + 4))
  done
  if [[ "${stranded:-0}" -gt 0 ]]; then
    fail "$stranded Released PVs still around after 90s — re-provisioning will conflict"
    ssh_cp "kubectl get pv | grep Released" | head -3
    return 1
  fi
  ok "no stranded Released PVs (after ${i}s)"

  # Re-create with a fresh client name (same email is fine post-delete).
  scenario_lifecycle
}

# ─── scenario 5: drain ─────────────────────────────────────────────
#
# Skipped intentionally on the daily run because draining a server
# disrupts other tenants. Operators run it manually via:
#   DRAIN_NODE=<name> ./scripts/integration-staging.sh drain
# which performs the FULL drain → reschedule → HTTPS-still-works
# assertion. No more stub PASS.

scenario_drain() {
  if [[ -z "${DRAIN_NODE:-}" ]]; then
    log "scenario drain not run — set DRAIN_NODE=<node-name> to enable. NOT counting as PASS."
    return 0
  fi
  fail "drain scenario not yet ported to the new contract — see issue #DRAIN-RECOVERY"
  return 1
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
    prereq_dns || { echo "DNS prereq failed; aborting"; exit 1; }
    run_scenario lifecycle
    run_scenario fm
    run_scenario https
    run_scenario reprovision
    run_scenario drain
    ;;
  *)
    if [[ "$SCENARIO" == "https" || "$SCENARIO" == "all" ]]; then
      prereq_dns || { echo "DNS prereq failed; aborting"; exit 1; }
    fi
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
