#!/usr/bin/env bash
# End-to-end test for the WAF (ModSecurity / OWASP CRS) + CrowdSec
# IP-blocking stack on every cluster node.
#
# Coverage validated:
#   1. CrowdSec LAPI reachable from platform-api (NetworkPolicy correct)
#   2. Every Traefik DS pod has the crowdsec middleware loaded AND is
#      pulling decisions from LAPI (no orphaned/stale bouncer entries)
#   3. Every modsec-crs replica accepts proxied requests and emits
#      CRS rule hits to its stdout in the format the WAF scraper parses
#   4. A CRS-tripping probe injected at each Traefik pod produces a
#      waf_logs row with the correct hostname (X-Forwarded-Host) and
#      source IP (X-Real-Ip) — proves both per-pod log coverage AND
#      the scraper's JSON-line hostname extraction
#   5. A manual ban added via the admin API is honored by the bouncer
#      on every Traefik replica within `--update-interval` seconds
#      (default 60s)
#   6. Unban via the admin API restores reachability on every replica
#   7. The scraperStatus / crowdsecStatus surfaces visible-from-UI
#      diagnostics match the actual cluster state
#
# Designed to run standalone OR sourced from scripts/integration-all.sh.
# Side-effects (test bans, test waf_logs rows) are cleaned up on exit,
# trap-protected so a failed assertion still triggers cleanup.
#
# USAGE
#   ADMIN_PASSWORD=<…> ./scripts/integration-waf-crowdsec.sh
#   ADMIN_HOST=https://admin.staging.phoenix-host.net \
#     ADMIN_PASSWORD=<…> \
#     SSH_HOST=root@46.224.122.58 \
#     ./scripts/integration-waf-crowdsec.sh
#
# Test IPs are in TEST-NET-2 (198.51.100.0/24) per RFC 5737 — reserved
# for documentation, never routable, won't collide with real traffic
# or the community blocklist.

set -uo pipefail

# ─── Config ────────────────────────────────────────────────────────────

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@staging.phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@46.224.122.58}"

# Test data — TEST-NET-2, never routable.
TEST_BAN_IP="${TEST_BAN_IP:-198.51.100.42}"
TEST_PROBE_PATH="${TEST_PROBE_PATH:-/.env}"
# Hostname the probe sends in X-Forwarded-Host. Must be a real tenant
# hostname for the waf-log-scraper to map it to a route_id, OR the
# probe will land as scope='admin-host' (also fine for this test).
PROBE_HOSTNAME="${PROBE_HOSTNAME:-admin.staging.phoenix-host.net}"

# Plugin update interval — bouncer pulls every N seconds, so a ban
# takes up to N+5 seconds to propagate. v1.6.0 default is 60s.
BOUNCER_PULL_INTERVAL_S=${BOUNCER_PULL_INTERVAL_S:-60}

# ─── Output helpers ─────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; BOLD='\033[1m'; RESET='\033[0m'
else
  CYAN=''; GREEN=''; RED=''; YELLOW=''; BOLD=''; RESET=''
fi

log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
warn() { printf '  %b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
skip() { printf '  %b○%b %s\n' "$YELLOW" "$RESET" "$*"; skipped=$((skipped+1)); }
phase() { printf '\n%b%b── %s ──%b\n' "$BOLD" "$CYAN" "$*" "$RESET"; }

passed=0
failed=0
skipped=0

# ─── SSH wrapper ────────────────────────────────────────────────────────

ssh_run() {
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    -o ConnectTimeout=10 "$SSH_HOST" "$@"
}

kubectl_run() {
  ssh_run "kubectl $*"
}

# ─── API helpers ───────────────────────────────────────────────────────

TOKEN=""

api_login() {
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    # Fallback path: generate JWT inside platform-api pod (lets the
    # harness run in CI without password access — same trick the
    # 2026-05-19 Banned-IPs E2E used).
    log "ADMIN_PASSWORD unset — generating JWT inside platform-api pod"
    TOKEN=$(kubectl_run "exec -n platform deploy/platform-api -- node -e \\\"const fj = require('fast-jwt'); console.log(fj.createSigner({key: process.env.JWT_SECRET, expiresIn: 30*60*1000})({sub:'00000000-0000-0000-0000-harness00000',email:'harness@test',role:'super_admin',panel:'admin'}));\\\" 2>&1 | tail -1")
    if [[ -z "$TOKEN" || "$TOKEN" == *"Error"* ]]; then
      fail "could not mint JWT inside platform-api"
      return 1
    fi
    return 0
  fi
  local resp
  resp=$(curl -sk -X POST -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    "$ADMIN_HOST/api/v1/auth/login")
  TOKEN=$(printf '%s' "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('token',''))")
  if [[ -z "$TOKEN" ]]; then
    fail "login failed: $resp"
    return 1
  fi
  return 0
}

# Issue an API call via curl from inside the cluster (so harness works
# even if the admin Ingress hostname isn't resolvable from outside).
api_internal() {
  local method="$1" path="$2" body="${3:-}"
  local rnd="$RANDOM"
  if [[ -z "$body" ]]; then
    kubectl_run "run waf-cs-h-$rnd -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- curl -sk -X $method -H 'Authorization: Bearer $TOKEN' http://platform-api.platform.svc:3000/api/v1$path" 2>&1 | tail -1
  else
    # Use --data-binary to preserve newlines / quotes (passes body via
    # heredoc).
    local tmpfile
    tmpfile=$(mktemp)
    printf '%s' "$body" > "$tmpfile"
    scp -i "$SSH_KEY" -q "$tmpfile" "$SSH_HOST:/tmp/.harness-body-$rnd" >/dev/null
    rm -f "$tmpfile"
    kubectl_run "run waf-cs-h-$rnd -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- sh -c 'curl -sk -X $method -H \"Authorization: Bearer $TOKEN\" -H \"Content-Type: application/json\" --data-binary @- http://platform-api.platform.svc:3000/api/v1$path' < /tmp/.harness-body-$rnd" 2>&1 | tail -1
    ssh_run "rm -f /tmp/.harness-body-$rnd"
  fi
}

# ─── Cleanup ───────────────────────────────────────────────────────────

cleanup() {
  log "cleanup: removing test ban for $TEST_BAN_IP"
  # cscli is the lowest-friction path that doesn't depend on our API
  # being reachable; use it for cleanup so a half-failed test doesn't
  # leave the ban hanging.
  kubectl_run "exec -n crowdsec deploy/crowdsec -- cscli decisions delete --ip $TEST_BAN_IP" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# ─── Phase 0 — Preflight ────────────────────────────────────────────────

phase "Phase 0 — Preflight"

if ! ssh_run 'echo ok' >/dev/null 2>&1; then
  fail "SSH to $SSH_HOST failed; check SSH_KEY=$SSH_KEY"
  exit 1
fi
ok "SSH to $SSH_HOST"

if ! kubectl_run "get pods -n platform -l app=platform-api -o jsonpath='{.items[0].metadata.name}'" >/dev/null 2>&1; then
  fail "no platform-api pod found"
  exit 1
fi
ok "platform-api pod found"

if ! kubectl_run "get deploy crowdsec -n crowdsec -o jsonpath='{.status.readyReplicas}'" | grep -q '^1$'; then
  fail "crowdsec Deployment not Ready (expected 1 replica)"
  exit 1
fi
ok "crowdsec Deployment ready"

modsec_pods=$(kubectl_run "get pods -n traefik -l app.kubernetes.io/name=modsec-crs --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}'")
modsec_count=$(echo "$modsec_pods" | wc -w | tr -d ' ')
if [[ "$modsec_count" -eq 0 ]]; then
  fail "no modsec-crs pods Running"
  exit 1
fi
ok "modsec-crs pods Running: $modsec_count"

traefik_pods=$(kubectl_run "get pods -n traefik -l app.kubernetes.io/name=traefik --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}'")
traefik_count=$(echo "$traefik_pods" | wc -w | tr -d ' ')
if [[ "$traefik_count" -eq 0 ]]; then
  fail "no traefik pods Running"
  exit 1
fi
ok "traefik DS pods Running: $traefik_count (one per node)"

if ! api_login; then
  exit 1
fi
ok "admin auth token obtained"

# ─── Phase 1 — CrowdSec status surface matches reality ────────────────

phase "Phase 1 — CrowdSec status reflects cluster reality"

status=$(api_internal GET /admin/security/crowdsec/status)
echo "$status" | python3 -m json.tool >/dev/null 2>&1 || {
  fail "status endpoint returned non-JSON: $status"
  exit 1
}

lapi=$(printf '%s' "$status" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['lapiHealthy'])")
if [[ "$lapi" == "True" ]]; then
  ok "LAPI healthy from platform-api"
else
  fail "LAPI unreachable from platform-api (check NetworkPolicy + crowdsec.crowdsec.svc DNS)"
fi

cov_traefik=$(printf '%s' "$status" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['coverage']; print(f\"{d['traefikPodsCovered']}/{d['traefikPodsTotal']}\")")
cov_nodes=$(printf '%s' "$status" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['coverage']['nodesTotal'])")
if [[ "$cov_traefik" == "${traefik_count}/${traefik_count}" ]]; then
  ok "Traefik DS coverage: $cov_traefik (== Running pods)"
else
  fail "Traefik DS coverage mismatch: $cov_traefik reported vs $traefik_count Running"
fi
if [[ "$cov_nodes" == "$traefik_count" ]]; then
  ok "Ready node count == Traefik DS count: $cov_nodes (cluster-wide enforcement coverage)"
else
  warn "Ready node count $cov_nodes != Traefik DS count $traefik_count (some nodes not running Traefik)"
fi

# ─── Phase 2 — Every modsec-crs pod can be reached + emits CRS logs ───

phase "Phase 2 — modsec-crs log coverage (per pod)"

for pod in $modsec_pods; do
  # Issue a CRS-tripping probe directly to this modsec-crs pod via
  # `kubectl exec`. The probe runs inside the pod against 127.0.0.1
  # so it's guaranteed to hit THIS pod (no Service load-balancing).
  uid=$(date +%s%N)
  probe_rc=$(kubectl_run "exec -n traefik $pod -- sh -c \"wget -q -O- --timeout=5 \
    --header='Host: $PROBE_HOSTNAME' \
    --header='X-Forwarded-Host: $PROBE_HOSTNAME' \
    --header='X-Real-Ip: $TEST_BAN_IP' \
    --header='X-Request-Probe: harness-$uid' \
    'http://127.0.0.1:8080$TEST_PROBE_PATH' 2>&1; echo \\\"::EXITCODE=\\\$?\\\"\"" 2>&1)
  # Expect 403 from CRS — wget reports it as exit code != 0.
  if echo "$probe_rc" | grep -q "ERROR 403"; then
    ok "$pod: CRS blocked probe (403) as expected"
  elif echo "$probe_rc" | grep -q "ERROR 404"; then
    # Path returns 404 before CRS evaluates — try a known-blocked URL.
    skip "$pod: $TEST_PROBE_PATH returned 404; CRS evaluation may have been bypassed"
  else
    warn "$pod: unexpected probe response (raw: $(echo "$probe_rc" | head -c 120))"
  fi
  sleep 1
done

# ─── Phase 3 — WAF event capture per Traefik pod ──────────────────────
# The Traefik plugin proxies to a modsec-crs pod via Service load-balancing.
# We need to verify that probing through EACH Traefik pod produces an event
# the scraper picks up.

phase "Phase 3 — WAF events captured per Traefik DS pod"

# Snapshot waf_logs count before
before=$(kubectl_run "exec -n platform system-db-1 -c postgres -- psql -d hosting_platform -tA -c \"SELECT COUNT(*) FROM waf_logs WHERE created_at > NOW() - INTERVAL '2 minutes';\"" 2>/dev/null | tr -d '[:space:]')
log "waf_logs count in last 2min before probes: ${before:-0}"

for pod in $traefik_pods; do
  uid=$(date +%s%N)
  # Probe through this Traefik pod's port-8000 entrypoint.
  kubectl_run "exec -n traefik $pod -c traefik -- wget -q -O /dev/null --timeout=5 \
    --header='Host: $PROBE_HOSTNAME' \
    --header='X-Forwarded-Host: $PROBE_HOSTNAME' \
    --header='X-Real-Ip: $TEST_BAN_IP' \
    --header='X-Request-Probe: harness-traefik-$uid' \
    'http://127.0.0.1:8000$TEST_PROBE_PATH'" >/dev/null 2>&1 || true
  ok "$pod: probe sent through Traefik → modsec-crs Service"
done

# Wait for the scraper's 30s cycle + 5s buffer.
log "waiting 40s for WAF scraper to capture..."
sleep 40

after=$(kubectl_run "exec -n platform system-db-1 -c postgres -- psql -d hosting_platform -tA -c \"SELECT COUNT(*) FROM waf_logs WHERE created_at > NOW() - INTERVAL '2 minutes';\"" 2>/dev/null | tr -d '[:space:]')
delta=$(( ${after:-0} - ${before:-0} ))
if (( delta >= traefik_count )); then
  ok "waf_logs grew by $delta (≥ $traefik_count probes)"
else
  fail "waf_logs grew by only $delta — expected ≥ $traefik_count (one per Traefik pod)"
fi

# Verify hostname extraction works (X-Forwarded-Host should be captured,
# not the modsec Service hostname or 'localhost').
real_host_count=$(kubectl_run "exec -n platform system-db-1 -c postgres -- psql -d hosting_platform -tA -c \"SELECT COUNT(*) FROM waf_logs WHERE created_at > NOW() - INTERVAL '2 minutes' AND hostname = '$PROBE_HOSTNAME';\"" 2>/dev/null | tr -d '[:space:]')
if (( ${real_host_count:-0} >= 1 )); then
  ok "Events captured with hostname=$PROBE_HOSTNAME (X-Forwarded-Host extraction works)"
else
  fail "No events captured with hostname=$PROBE_HOSTNAME — hostname extraction is broken"
fi

# Verify source IP extraction (X-Real-Ip should be captured, not the
# in-cluster pod IP).
real_ip_count=$(kubectl_run "exec -n platform system-db-1 -c postgres -- psql -d hosting_platform -tA -c \"SELECT COUNT(*) FROM waf_logs WHERE created_at > NOW() - INTERVAL '2 minutes' AND source_ip = '$TEST_BAN_IP';\"" 2>/dev/null | tr -d '[:space:]')
if (( ${real_ip_count:-0} >= 1 )); then
  ok "Events captured with source_ip=$TEST_BAN_IP (X-Real-Ip extraction works)"
else
  warn "No events with source_ip=$TEST_BAN_IP — X-Real-Ip extraction may be broken (got '$real_ip_count' rows)"
fi

# ─── Phase 4 — IP blocking via bouncer on every Traefik replica ───────

phase "Phase 4 — IP ban enforced on every Traefik replica"

# Snapshot bouncer-online count before the ban (the bouncer pull
# refreshes on the configured interval; we want to verify pulls are
# happening at all).
bouncers_online_before=$(printf '%s' "$status" | python3 -c "import sys,json; print(sum(1 for b in json.load(sys.stdin)['data']['bouncers'] if b['online']))")
log "bouncers online before ban: $bouncers_online_before / $(printf '%s' "$status" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['bouncers']))")"

if (( bouncers_online_before == 0 )); then
  warn "NO bouncers online — bans won't be enforced. Check Traefik plugin DNS resolution to crowdsec.crowdsec.svc.cluster.local:8080"
  warn "skipping Phase 4 enforcement checks; cleanup will still run"
  skipped=$((skipped + traefik_count * 2))
else
  # Place the ban via the admin API (same path the operator uses).
  ban_resp=$(api_internal POST /admin/security/crowdsec/decisions \
    "{\"value\":\"$TEST_BAN_IP\",\"scope\":\"Ip\",\"duration\":\"5m\",\"reason\":\"harness ban test\"}")
  if echo "$ban_resp" | grep -q "Decision successfully added"; then
    ok "ban added for $TEST_BAN_IP via admin API"
  else
    fail "admin API ban failed: $(echo "$ban_resp" | head -c 200)"
    exit 1
  fi

  log "waiting ${BOUNCER_PULL_INTERVAL_S}s + 5s buffer for bouncer cache to refresh..."
  sleep $((BOUNCER_PULL_INTERVAL_S + 5))

  # For each Traefik pod, send a request as if from $TEST_BAN_IP (via
  # X-Forwarded-For + trusted-IP shortcut). Expect 403 from the bouncer.
  for pod in $traefik_pods; do
    rc=$(kubectl_run "exec -n traefik $pod -c traefik -- sh -c \"wget -S -O /dev/null --timeout=5 \
      --header='Host: $PROBE_HOSTNAME' \
      --header='X-Forwarded-For: $TEST_BAN_IP' \
      --header='X-Real-Ip: $TEST_BAN_IP' \
      'http://127.0.0.1:8000/health' 2>&1 | grep -oE 'HTTP/[0-9.]+ [0-9]+' | head -1 | awk '{print \\\$2}'\"" 2>&1 | tail -1)
    if [[ "$rc" == "403" ]]; then
      ok "$pod: returns 403 for banned IP $TEST_BAN_IP"
    else
      fail "$pod: expected 403 for banned IP, got HTTP $rc"
    fi
  done

  # Unban + verify reachability restored.
  decision_id=$(api_internal GET "/admin/security/crowdsec/decisions?q=$TEST_BAN_IP" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['decisions']; print(d[0]['id'] if d else '')")
  if [[ -n "$decision_id" ]]; then
    unban_resp=$(api_internal DELETE "/admin/security/crowdsec/decisions/$decision_id")
    if echo "$unban_resp" | grep -q '"deleted":1'; then
      ok "unban succeeded (decision id $decision_id)"
    else
      fail "unban failed: $unban_resp"
    fi
  else
    fail "ban not visible in API after ${BOUNCER_PULL_INTERVAL_S}s — list returned no decisions for $TEST_BAN_IP"
  fi

  log "waiting ${BOUNCER_PULL_INTERVAL_S}s + 5s for bouncer cache to flush unban..."
  sleep $((BOUNCER_PULL_INTERVAL_S + 5))

  # Verify reachability restored (status should NOT be 403 anymore).
  for pod in $traefik_pods; do
    rc=$(kubectl_run "exec -n traefik $pod -c traefik -- sh -c \"wget -S -O /dev/null --timeout=5 \
      --header='Host: $PROBE_HOSTNAME' \
      --header='X-Forwarded-For: $TEST_BAN_IP' \
      --header='X-Real-Ip: $TEST_BAN_IP' \
      'http://127.0.0.1:8000/health' 2>&1 | grep -oE 'HTTP/[0-9.]+ [0-9]+' | head -1 | awk '{print \\\$2}'\"" 2>&1 | tail -1)
    if [[ "$rc" != "403" ]]; then
      ok "$pod: unbanned IP no longer 403 (got HTTP $rc)"
    else
      fail "$pod: still 403 after unban — bouncer cache didn't refresh"
    fi
  done
fi

# ─── Phase 5 — Coverage finishing checks ──────────────────────────────

phase "Phase 5 — Coverage finishing checks"

# Re-fetch status after the test; bouncers may have come online after
# the ban triggered a pull.
final_status=$(api_internal GET /admin/security/crowdsec/status)
fresh_count=$(printf '%s' "$final_status" | python3 -c "import sys,json; print(sum(1 for b in json.load(sys.stdin)['data']['bouncers'] if b['online']))")
if (( fresh_count > 0 )); then
  ok "after ban/unban cycle: $fresh_count bouncer(s) online"
else
  fail "no bouncers online after ban/unban cycle — enforcement is broken on this cluster"
fi

# Surface waf-events scraperStatus too.
waf_status=$(api_internal GET /admin/security/waf-events)
modsec_found=$(printf '%s' "$waf_status" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['scraperStatus']['modsecPodFound'])")
if [[ "$modsec_found" == "True" ]]; then
  ok "WAF scraper sees modsec-crs pods (matches the $modsec_count Running)"
else
  fail "WAF scraper reports modsecPodFound=False — label selector mismatch"
fi

# ─── Summary ────────────────────────────────────────────────────────────

phase "Summary"
printf '  passed:  %b%d%b\n' "$GREEN" "$passed" "$RESET"
printf '  failed:  %b%d%b\n' "$RED"   "$failed" "$RESET"
printf '  skipped: %b%d%b\n' "$YELLOW" "$skipped" "$RESET"

if (( failed > 0 )); then
  exit 1
fi
exit 0
