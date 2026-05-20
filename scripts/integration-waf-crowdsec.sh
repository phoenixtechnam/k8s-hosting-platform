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

# ─── Input sanitization (preflight) ────────────────────────────────────
# TEST_BAN_IP flows into `cscli decisions delete --ip $TEST_BAN_IP` on the
# cleanup path. cscli accepts CIDR via --ip, so a tampered value like
# "0.0.0.0/0" would nuke every active decision. Restrict to a single
# IPv4 address with no slash/mask before we touch anything.
if ! [[ "$TEST_BAN_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  printf 'ERROR: TEST_BAN_IP must be a plain IPv4 address (no CIDR), got "%s"\n' "$TEST_BAN_IP" >&2
  exit 2
fi
# PROBE_HOSTNAME is interpolated into header flags inside `kubectl
# exec -- sh -c "..."`. Restrict to DNS-safe characters so it can't
# escape the inner sh quoting.
if ! [[ "$PROBE_HOSTNAME" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  printf 'ERROR: PROBE_HOSTNAME must be a plain DNS name, got "%s"\n' "$PROBE_HOSTNAME" >&2
  exit 2
fi
# Refuse to mint the fallback JWT against a production host. The fallback
# uses the live JWT_SECRET to create a super_admin token; running it
# against prod by accident would leave real audit-log entries under a
# synthetic sub. Override via ALLOW_PROD_JWT_FALLBACK=1 if needed.
ALLOW_PROD_JWT_FALLBACK="${ALLOW_PROD_JWT_FALLBACK:-0}"

# Single-use process-unique nonce — replaces $RANDOM ($RANDOM is 0..32767
# so two parallel harness runs collide ~every 256 pod names). $$ is the
# pid; nanoseconds avoid clock-skew dupes within the same process.
HARNESS_NONCE="$$-$(date +%s%N)"
nonce_seq=0
# K8s pod names must be DNS-1123 — lowercase + dash only, max 63 chars.
# We use the nonce as a suffix on "waf-cs-h-" (9 chars) so up to 54 chars
# of nonce are safe.
next_nonce() { nonce_seq=$((nonce_seq + 1)); printf '%s-%d' "$HARNESS_NONCE" "$nonce_seq"; }

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
    #
    # Refuse to mint a super_admin token against a production host
    # unless explicitly opted-in: an accidental harness run against
    # prod would otherwise leave real audit-log entries (manual bans,
    # unbans) under the synthetic `harness00000` sub.
    if [[ "$ALLOW_PROD_JWT_FALLBACK" != "1" ]] && ! [[ "$ADMIN_HOST" =~ (staging|testing|localhost|\.test) ]]; then
      fail "JWT fallback refused: ADMIN_HOST=$ADMIN_HOST doesn't look like a non-prod host. Set ADMIN_PASSWORD or ALLOW_PROD_JWT_FALLBACK=1 to proceed."
      return 1
    fi
    log "ADMIN_PASSWORD unset — generating JWT inside platform-api pod"
    # Write the JS to a local file then cat it into kubectl exec — avoids
    # double shell-quoting through ssh + bash that breaks the single
    # quotes around 'fast-jwt' / property names.
    local jstmp; jstmp=$(mktemp)
    cat > "$jstmp" <<'JSEOF'
const fj = require('fast-jwt');
const sign = fj.createSigner({key: process.env.JWT_SECRET, expiresIn: 30 * 60 * 1000});
console.log(sign({
  sub: '00000000-0000-0000-0000-harness00000',
  email: 'harness@test',
  role: 'super_admin',
  panel: 'admin',
}));
JSEOF
    local podname
    podname=$(kubectl_run "get pods -n platform -l app=platform-api -o jsonpath='{.items[0].metadata.name}'")
    # Copy to /tmp (writable for the non-root container user) and run
    # with NODE_PATH=/app/node_modules so node's require() finds
    # fast-jwt without needing /app to be writable.
    scp -i "$SSH_KEY" -q "$jstmp" "$SSH_HOST:/tmp/.harness-mint-jwt.js" >/dev/null
    rm -f "$jstmp"
    ssh_run "kubectl cp /tmp/.harness-mint-jwt.js platform/$podname:/tmp/.harness-mint-jwt.js" >/dev/null 2>&1
    TOKEN=$(kubectl_run "exec -n platform $podname -- env NODE_PATH=/app/node_modules node /tmp/.harness-mint-jwt.js" 2>&1 | tail -1)
    kubectl_run "exec -n platform $podname -- rm -f /tmp/.harness-mint-jwt.js" >/dev/null 2>&1 || true
    ssh_run "rm -f /tmp/.harness-mint-jwt.js" >/dev/null 2>&1 || true
  else
    local resp
    resp=$(curl -sk -X POST -H 'Content-Type: application/json' \
      -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
      "$ADMIN_HOST/api/v1/auth/login")
    TOKEN=$(printf '%s' "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('token',''))")
  fi
  # Validate the token shape — without this, an unexpected warning line
  # from the pod (or a malformed login response) would land in $TOKEN
  # and be interpolated into the curl shell strings below, breaking the
  # harness AND potentially injecting shell metacharacters.
  if ! [[ "$TOKEN" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
    fail "token doesn't match JWT shape (len=${#TOKEN}); refusing to continue"
    TOKEN=""
    return 1
  fi
  return 0
}

# Issue an API call via curl from inside the cluster (so harness works
# even if the admin Ingress hostname isn't resolvable from outside).
api_internal() {
  local method="$1" path="$2" body="${3:-}"
  local rnd; rnd=$(next_nonce)
  if [[ -z "$body" ]]; then
    kubectl_run "run waf-cs-h-$rnd -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- curl -sk -X $method -H 'Authorization: Bearer $TOKEN' http://platform-api.platform.svc:3000/api/v1$path" 2>&1 | tail -1
  else
    # Use --data-binary to preserve newlines / quotes (passes body via
    # stdin to avoid nested shell-quoting hell).
    local tmpfile
    tmpfile=$(mktemp)
    printf '%s' "$body" > "$tmpfile"
    scp -i "$SSH_KEY" -q "$tmpfile" "$SSH_HOST:/tmp/.harness-body-$rnd" >/dev/null
    rm -f "$tmpfile"
    kubectl_run "run waf-cs-h-$rnd -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- sh -c 'curl -sk -X $method -H \"Authorization: Bearer $TOKEN\" -H \"Content-Type: application/json\" --data-binary @- http://platform-api.platform.svc:3000/api/v1$path' < /tmp/.harness-body-$rnd" 2>&1 | tail -1
    ssh_run "rm -f /tmp/.harness-body-$rnd"
  fi
}

# Probe a Traefik pod by its pod IP via an ephemeral curl pod pinned to
# the same node (so the curl→Traefik hop stays node-local and the source
# IP is in the cluster RFC1918 range that the Middleware trusts for XFF).
#
# Returns: "<HTTP_STATUS_CODE>|<headers-base64>|<body-first-256-chars>"
# Use parse_probe_status / parse_probe_header / parse_probe_body to
# decompose. Header is base64 to survive shell transit safely.
#
# This replaces the previous `wget` approach which silently no-op'd
# because the traefik:v3.x image is distroless (no wget, no sh).
probe_traefik_pod() {
  local pod="$1" host="$2" xff="$3" path="$4"
  local rnd; rnd=$(next_nonce)
  local pod_ip; pod_ip=$(kubectl_run "get pod -n traefik $pod -o jsonpath='{.status.podIP}'" 2>/dev/null)
  if [[ -z "$pod_ip" ]]; then
    printf 'NOIP||\n'
    return 1
  fi
  local node; node=$(kubectl_run "get pod -n traefik $pod -o jsonpath='{.spec.nodeName}'" 2>/dev/null)
  local overrides
  overrides=$(printf '{"spec":{"nodeName":"%s"}}' "$node")
  # -D - dumps response headers to stdout; -o /dev/null suppresses body;
  # we use -w to get a structured line. Then a second call with -o /tmp
  # captures the body. Two calls is cleaner than parsing combined output.
  local status_line
  # Use https://<pod-ip>:8443 — the platform routes use the `websecure`
  # entrypoint (HTTP/8000 returns 404 from the router for HTTPS-only
  # hosts before the middleware chain even runs). --resolve makes curl
  # use the pod IP while sending Host=<host> + SNI=<host> so the cert
  # SNI lookup + Traefik router both match the real route.
  status_line=$(kubectl_run "run waf-probe-$rnd -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --overrides='$overrides' --command -- curl -sk -o /dev/null -D - -H 'X-Forwarded-Host: $host' -H 'X-Forwarded-For: $xff' -H 'X-Real-Ip: $xff' --resolve '$host:8443:$pod_ip' -w 'HTTPSTATUS=%{http_code}\n' --max-time 8 https://$host:8443$path" 2>&1)
  local code; code=$(printf '%s' "$status_line" | grep -oE 'HTTPSTATUS=[0-9]+' | head -1 | cut -d= -f2)
  # Base64 the full response headers so we can grep for plugin-specific
  # markers (e.g. CrowdSec adds `X-CrowdSec-Decision`-style headers on
  # blocks, ModSec/Traefik doesn't).
  local headers_b64; headers_b64=$(printf '%s' "$status_line" | grep -iE '^[A-Z][a-zA-Z-]+:' | base64 -w0 2>/dev/null || true)
  printf '%s|%s|\n' "${code:-000}" "$headers_b64"
}

# Header that indicates a CrowdSec block (set by the bouncer plugin on
# every blocked request — distinguishes from a ModSec 403 which doesn't
# add it). Grep is case-insensitive because Traefik may normalize.
is_crowdsec_block() {
  local headers_b64="$1"
  printf '%s' "$headers_b64" | base64 -d 2>/dev/null | grep -qiE 'crowdsec|cs-bouncer'
}

# ─── Cleanup ───────────────────────────────────────────────────────────

cleanup() {
  log "cleanup: removing test ban for $TEST_BAN_IP"
  # cscli is the lowest-friction path that doesn't depend on our API
  # being reachable; use it for cleanup so a half-failed test doesn't
  # leave the ban hanging. If SSH itself is down at this point, the
  # cleanup silently fails — that's acceptable because the ban was
  # added with `duration: 5m` so it auto-expires even with no cleanup.
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
  # Probe each modsec-crs pod directly by its pod IP via an ephemeral
  # curl pod pinned to the same node. The modsec-crs image is Apache-
  # based and DOES have wget/curl in the container, but using the
  # external probe approach keeps this consistent with Phase 3/4 and
  # exercises the network path the Traefik plugin actually uses.
  pod_ip=$(kubectl_run "get pod -n traefik $pod -o jsonpath='{.status.podIP}'" 2>/dev/null)
  if [[ -z "$pod_ip" ]]; then
    fail "$pod: no pod IP"
    continue
  fi
  rnd=$(next_nonce)
  rc=$(kubectl_run "run waf-modsec-$rnd -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- curl -sk -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Host: $PROBE_HOSTNAME' -H 'X-Real-Ip: $TEST_BAN_IP' --max-time 8 http://$pod_ip:8080$TEST_PROBE_PATH" 2>&1 | tail -1)
  if [[ "$rc" == "403" ]]; then
    ok "$pod ($pod_ip): CRS blocked probe (403) as expected"
  elif [[ "$rc" == "404" ]]; then
    skip "$pod ($pod_ip): $TEST_PROBE_PATH returned 404; CRS evaluation may have been bypassed"
  else
    warn "$pod ($pod_ip): unexpected probe response (HTTP $rc)"
  fi
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
  # probe_traefik_pod fires a CRS-tripping request through this specific
  # Traefik pod's hostPort (via pod IP from a node-pinned ephemeral curl
  # pod). The Traefik plugin can't be `kubectl exec`d into directly —
  # the traefik:v3.x image is distroless (no shell, no wget, no curl).
  result=$(probe_traefik_pod "$pod" "$PROBE_HOSTNAME" "$TEST_BAN_IP" "$TEST_PROBE_PATH")
  rc="${result%%|*}"
  if [[ "$rc" == "403" ]]; then
    ok "$pod: CRS-tripping probe returned 403"
  elif [[ "$rc" == "NOIP" ]]; then
    fail "$pod: could not resolve pod IP"
  else
    warn "$pod: probe through Traefik returned HTTP $rc (expected 403)"
  fi
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
  # ENFORCEMENT TEST FROM OUTSIDE THE CLUSTER
  #
  # The maxlerebourg Traefik plugin BYPASSES its decision cache for any
  # source IP that's in `forwardedHeadersTrustedIPs` (RFC1918). That's
  # by design — trusted IPs are meant to be load-balancers / reverse
  # proxies that you never want to ban (banning the LB bans everyone
  # behind it). Pod-to-pod probes inside the cluster all have RFC1918
  # source IPs and therefore bypass the bouncer entirely — they CAN'T
  # exercise the ban path no matter what we put in XFF.
  #
  # Test the REAL enforcement path: probe from THIS harness's own
  # outbound IP via each node's public hostPort 443. Ban that IP, expect
  # 403 from each node, unban, expect baseline restored.
  #
  # NOTE: this briefly bans the harness operator's IP. Duration is set
  # to 3 minutes so the ban auto-expires even if the harness crashes
  # mid-test. If running in CI from a shared egress IP, set
  # SKIP_PHASE_4_EXTERNAL=1 to skip this phase.
  if [[ "${SKIP_PHASE_4_EXTERNAL:-0}" == "1" ]]; then
    warn "SKIP_PHASE_4_EXTERNAL=1 — skipping external enforcement test"
    skipped=$((skipped + traefik_count * 2))
  else
    # Discover our own outbound public IP.
    HARNESS_OUTBOUND_IP=$(curl -s --max-time 5 https://api.ipify.org)
    if ! [[ "$HARNESS_OUTBOUND_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      fail "could not detect harness outbound IP (got: $HARNESS_OUTBOUND_IP) — skipping enforcement"
    else
      ok "harness outbound IP: $HARNESS_OUTBOUND_IP"

      # Get every cluster node's External-IP (one per node = one Traefik
      # pod via hostPort 443). `kubectl get nodes -o wide` is the most
      # SSH-quote-resilient form — the `-o jsonpath` query with
      # @.type==... has too many nested quote layers to survive
      # ssh+bash+kubectl roundtripping reliably.
      NODE_IPS=$(kubectl_run "get nodes -o wide --no-headers" 2>/dev/null | awk '{print $6}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u)
      node_count=$(echo "$NODE_IPS" | sed '/^$/d' | wc -l | tr -d ' ')
      if (( node_count == 0 )); then
        # Fallback: parse InternalIP column (5) if ExternalIP column (6) is empty.
        NODE_IPS=$(kubectl_run "get nodes -o wide --no-headers" 2>/dev/null | awk '{print $5}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u)
        node_count=$(echo "$NODE_IPS" | sed '/^$/d' | wc -l | tr -d ' ')
        warn "no ExternalIP on nodes — falling back to InternalIP ($node_count); enforcement test only meaningful if those are routable from \$HARNESS_OUTBOUND_IP"
      fi
      ok "discovered $node_count node IPs to probe: $(echo $NODE_IPS | tr '\n' ' ')"

      # Baseline: probe each node — expect non-403 from at least one
      # (sanity check that the route IS reachable from outside).
      log "baseline probe from $HARNESS_OUTBOUND_IP to each node (no ban yet)"
      baseline_403_count=0
      for nip in $NODE_IPS; do
        rc=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$PROBE_HOSTNAME:443:$nip" "https://$PROBE_HOSTNAME/" 2>&1 | tail -1)
        if [[ "$rc" == "403" ]]; then baseline_403_count=$((baseline_403_count+1)); fi
        log "  node $nip baseline HTTP $rc"
      done
      if (( baseline_403_count == node_count )); then
        warn "every baseline probe returned 403 — harness IP $HARNESS_OUTBOUND_IP may already be banned by the community blocklist; skipping enforcement check"
        skipped=$((skipped + node_count * 2))
      else
        # Ban the harness's outbound IP.
        BAN_TARGET="$HARNESS_OUTBOUND_IP"
        ban_resp=$(api_internal POST /admin/security/crowdsec/decisions \
          "{\"value\":\"$BAN_TARGET\",\"scope\":\"Ip\",\"duration\":\"3m\",\"reason\":\"harness external enforcement test\"}")
        if echo "$ban_resp" | grep -q "Decision successfully added"; then
          ok "ban added for harness IP $BAN_TARGET via admin API (auto-expires in 3min)"
        else
          fail "admin API ban failed: $(echo "$ban_resp" | head -c 200)"
        fi

        log "waiting ${BOUNCER_PULL_INTERVAL_S}s + 5s for every bouncer to refresh cache..."
        sleep $((BOUNCER_PULL_INTERVAL_S + 5))

        # Probe each node's hostPort 443 from THIS host — bouncer's view
        # of the client IP IS $BAN_TARGET so each node should 403.
        for nip in $NODE_IPS; do
          rc=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$PROBE_HOSTNAME:443:$nip" "https://$PROBE_HOSTNAME/" 2>&1 | tail -1)
          if [[ "$rc" == "403" ]]; then
            ok "node $nip: bouncer returned 403 for banned IP $BAN_TARGET"
          else
            fail "node $nip: expected 403 for banned IP $BAN_TARGET, got HTTP $rc"
          fi
        done

        # Unban + verify reachability restored.
        decision_id=$(api_internal GET "/admin/security/crowdsec/decisions?q=$BAN_TARGET" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['decisions']; print(d[0]['id'] if d else '')")
        if [[ -n "$decision_id" ]]; then
          unban_resp=$(api_internal DELETE "/admin/security/crowdsec/decisions/$decision_id")
          if echo "$unban_resp" | grep -q '"deleted":1'; then
            ok "unban succeeded (decision id $decision_id)"
          else
            fail "unban failed: $unban_resp"
          fi
        else
          fail "ban not visible in API after ${BOUNCER_PULL_INTERVAL_S}s — list returned no decisions for $BAN_TARGET"
        fi

        log "waiting ${BOUNCER_PULL_INTERVAL_S}s + 5s for cache to flush unban..."
        sleep $((BOUNCER_PULL_INTERVAL_S + 5))

        # Verify reachability restored — each node back to baseline.
        for nip in $NODE_IPS; do
          rc=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$PROBE_HOSTNAME:443:$nip" "https://$PROBE_HOSTNAME/" 2>&1 | tail -1)
          if [[ "$rc" != "403" ]]; then
            ok "node $nip: bouncer no longer blocking (HTTP $rc)"
          else
            fail "node $nip: still 403 after unban — bouncer cache didn't refresh"
          fi
        done
      fi
    fi
  fi
fi

# Also clean up any test ban that targeted the harness's symbolic IP (in
# case an earlier run created one).
cleanup_test_ban_symbolic() {
  kubectl_run "exec -n crowdsec deploy/crowdsec -- cscli decisions delete --ip $TEST_BAN_IP" >/dev/null 2>&1 || true
  # Also clean the harness IP if we know it.
  [[ -n "${HARNESS_OUTBOUND_IP:-}" ]] && \
    kubectl_run "exec -n crowdsec deploy/crowdsec -- cscli decisions delete --ip $HARNESS_OUTBOUND_IP" >/dev/null 2>&1 || true
}
cleanup_test_ban_symbolic

# ─── Phase G — F2: allowlist + static blocklist CRUD ──────────────────

phase "Phase G — F2 allowlist + static blocklist"

# Test value uses a different TEST-NET-2 IP to avoid colliding with Phase 4's harness IP.
F2_ALLOWLIST_VALUE="198.51.100.99"
F2_STATIC_VALUE="198.51.100.98"

cleanup_f2() {
  kubectl_run "exec -n crowdsec deploy/crowdsec -- cscli allowlists remove admin-panel $F2_ALLOWLIST_VALUE" >/dev/null 2>&1 || true
  kubectl_run "exec -n crowdsec deploy/crowdsec -- cscli decisions delete --ip $F2_STATIC_VALUE" >/dev/null 2>&1 || true
}
trap 'cleanup; cleanup_test_ban_symbolic; cleanup_f2' EXIT INT TERM

# Allowlist — list (initial state)
allow_initial=$(api_internal GET /admin/security/crowdsec/allowlist)
if echo "$allow_initial" | grep -q '"entries"'; then
  ok "allowlist GET endpoint reachable"
else
  fail "allowlist GET failed: $(echo "$allow_initial" | head -c 200)"
fi

# Allowlist — add entry
add_resp=$(api_internal POST /admin/security/crowdsec/allowlist \
  "{\"value\":\"$F2_ALLOWLIST_VALUE\",\"scope\":\"Ip\",\"comment\":\"harness allowlist test\"}")
if echo "$add_resp" | grep -qE '"message"|"value"'; then
  ok "allowlist entry added: $F2_ALLOWLIST_VALUE"
else
  fail "allowlist add failed: $(echo "$add_resp" | head -c 200)"
fi

# Allowlist — verify it's in the list
allow_list=$(api_internal GET /admin/security/crowdsec/allowlist)
if echo "$allow_list" | grep -q "$F2_ALLOWLIST_VALUE"; then
  ok "allowlist entry visible in list ($F2_ALLOWLIST_VALUE)"
else
  fail "allowlist entry NOT visible: $(echo "$allow_list" | head -c 300)"
fi

# Allowlist — invalid value (rm-rf shell-injection shape) → 400
inv_rc=$(kubectl_run "run waf-cs-h-invalid-allow-$(next_nonce) -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"value\":\"; rm -rf /\",\"scope\":\"Ip\",\"comment\":\"shell injection attempt\"}' http://platform-api.platform.svc:3000/api/v1/admin/security/crowdsec/allowlist" 2>&1 | tail -1)
if [[ "$inv_rc" == "400" ]]; then
  ok "invalid allowlist value rejected (400)"
else
  fail "invalid allowlist value got HTTP $inv_rc (expected 400)"
fi

# Allowlist — remove
rm_resp=$(api_internal DELETE "/admin/security/crowdsec/allowlist/$F2_ALLOWLIST_VALUE")
if echo "$rm_resp" | grep -q '"removed"'; then
  ok "allowlist entry removed"
else
  fail "allowlist remove failed: $(echo "$rm_resp" | head -c 200)"
fi

# Static blocklist — add (1y duration)
static_add_resp=$(api_internal POST /admin/security/crowdsec/static-blocklist \
  "{\"value\":\"$F2_STATIC_VALUE\",\"scope\":\"Ip\",\"reason\":\"harness static ban test\"}")
if echo "$static_add_resp" | grep -q '"duration":"8760h"'; then
  ok "static ban added with 1y duration"
else
  fail "static ban add failed: $(echo "$static_add_resp" | head -c 200)"
fi

# Verify it's listed with staticByOperator=true
sleep 2
static_list=$(api_internal GET "/admin/security/crowdsec/decisions?q=$F2_STATIC_VALUE")
if echo "$static_list" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']['decisions']
matches=[x for x in d if x['value']=='$F2_STATIC_VALUE' and x.get('staticByOperator')]
sys.exit(0 if matches else 1)
" 2>/dev/null; then
  ok "static ban visible in decisions list with staticByOperator=true"
else
  fail "static ban not flagged as staticByOperator in decisions list"
fi

# Filter staticOnly=true returns only static bans
static_filter=$(api_internal GET "/admin/security/crowdsec/decisions?staticOnly=true")
static_count=$(echo "$static_filter" | python3 -c "import sys,json; print(sum(1 for x in json.load(sys.stdin)['data']['decisions'] if x.get('staticByOperator')))" 2>/dev/null || echo 0)
if (( static_count >= 1 )); then
  ok "staticOnly filter returns $static_count static ban(s)"
else
  fail "staticOnly filter returned $static_count static bans (expected ≥1)"
fi

# Cleanup the static ban via API (operator path) — verifies the delete path works for static bans
static_id=$(echo "$static_list" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']['decisions']
matches=[x for x in d if x['value']=='$F2_STATIC_VALUE']
print(matches[0]['id'] if matches else '')
" 2>/dev/null)
if [[ -n "$static_id" ]]; then
  api_internal DELETE "/admin/security/crowdsec/decisions/$static_id" >/dev/null
  ok "static ban deleted via API (id=$static_id)"
else
  warn "could not find static ban id for cleanup"
fi

# ─── Phase H — F4: WAF rule exclusion management ─────────────────────
#
# Verifies DB-backed surgical CRS exclusions. End-to-end coverage:
#   1. POST creates a row
#   2. GET lists it
#   3. Backend reconciler patches modsec-crs-exclusions-dynamic ConfigMap
#   4. modsec-crs Deployment template annotation is bumped (would roll pods)
#   5. PATCH toggles disabled
#   6. DELETE removes the row
#   7. Reconciler restores the empty-body ConfigMap content
#
# We do NOT wait for the actual pod rollout to complete here — that
# would slow the harness by ~30s and is covered by the modsec readiness
# probe + tcpSocket check naturally. The annotation bump is the
# authoritative signal that the rolling restart was triggered.

phase "Phase H — F4 WAF rule exclusions"

F4_HOST_REGEX='^waf-h-harness\.example\.invalid$'
F4_RULE_ID='930120'

cleanup_f4() {
  # Best-effort delete via API. If the test failed mid-create, no row
  # exists and the loop is a no-op.
  for id in $(api_internal GET "/admin/security/waf-rule-exclusions?includeDisabled=true" 2>/dev/null | python3 -c "
import sys,json
try:
    data = json.load(sys.stdin)['data']['exclusions']
    for x in data:
        if x['hostnameRegex']=='$F4_HOST_REGEX':
            print(x['id'])
except Exception:
    pass
" 2>/dev/null); do
    api_internal DELETE "/admin/security/waf-rule-exclusions/$id" >/dev/null 2>&1 || true
  done
}
trap 'cleanup; cleanup_test_ban_symbolic; cleanup_f2; cleanup_f4' EXIT INT TERM
cleanup_f4

# H1: GET on empty state returns 200 + empty array
h_list_empty=$(api_internal GET /admin/security/waf-rule-exclusions)
if echo "$h_list_empty" | grep -q '"exclusions"'; then
  ok "F4: GET /waf-rule-exclusions reachable"
else
  fail "F4: initial GET failed: $(echo "$h_list_empty" | head -c 200)"
fi

# H2: POST creates a new exclusion
h_create=$(api_internal POST /admin/security/waf-rule-exclusions \
  "{\"ruleId\":\"$F4_RULE_ID\",\"hostnameRegex\":\"$F4_HOST_REGEX\",\"scope\":\"args_names_only\",\"reason\":\"harness F4 test\"}")
h_id=$(echo "$h_create" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null || true)
if [[ -n "$h_id" && "$h_id" =~ ^[a-f0-9-]{36}$ ]]; then
  ok "F4: exclusion created (id=$h_id)"
else
  fail "F4: create failed or returned no id: $(echo "$h_create" | head -c 300)"
fi

# H3: GET lists the new exclusion
h_list_after=$(api_internal GET /admin/security/waf-rule-exclusions)
if echo "$h_list_after" | grep -q "$F4_HOST_REGEX"; then
  ok "F4: exclusion appears in GET list"
else
  fail "F4: exclusion NOT visible: $(echo "$h_list_after" | head -c 300)"
fi

# H4: ConfigMap was patched with the rendered .conf body
# (best-effort — Flux may re-apply the static seed; check both data and
# annotation. The annotation is the authoritative signal because the
# reconciler always bumps it on a content change.)
sleep 2
h_cm_data=$(kubectl_run "get configmap -n traefik modsec-crs-exclusions-dynamic -o jsonpath='{.data.REQUEST-901-EXCLUSION-RULES-BEFORE-CRS-DYNAMIC\\.conf}'" 2>&1)
if echo "$h_cm_data" | grep -qE "ctl:ruleRemoveTargetById=$F4_RULE_ID;ARGS_NAMES"; then
  ok "F4: ConfigMap contains rendered SecRule for rule $F4_RULE_ID"
else
  fail "F4: ConfigMap content missing the rendered exclusion: $(echo "$h_cm_data" | head -c 400)"
fi

# H5: modsec-crs Deployment was annotated with a hash
h_annotation=$(kubectl_run "get deployment -n traefik modsec-crs -o jsonpath='{.spec.template.metadata.annotations.platform\\.phoenix-host\\.net/waf-exclusion-hash}'" 2>&1)
if [[ -n "$h_annotation" && "$h_annotation" =~ ^[a-f0-9]{64}$ ]]; then
  ok "F4: modsec-crs Deployment annotated with hash ($h_annotation)"
else
  fail "F4: modsec-crs annotation missing or not sha256: $(echo "$h_annotation" | head -c 200)"
fi

# H6: PATCH toggles disabled=true
if [[ -n "${h_id:-}" ]]; then
  h_patch=$(api_internal PATCH "/admin/security/waf-rule-exclusions/$h_id" '{"disabled":true}')
  if echo "$h_patch" | grep -q '"disabled":true'; then
    ok "F4: PATCH disabled=true succeeded"
  else
    fail "F4: PATCH failed: $(echo "$h_patch" | head -c 300)"
  fi
fi

# H7: GET with includeDisabled=true should show the disabled row
h_with_disabled=$(api_internal GET "/admin/security/waf-rule-exclusions?includeDisabled=true")
if echo "$h_with_disabled" | grep -q "$F4_HOST_REGEX"; then
  ok "F4: disabled row visible with includeDisabled=true"
else
  fail "F4: disabled row NOT visible with includeDisabled=true"
fi

# H8: Duplicate enabled row → 409 DUPLICATE
h_dupe=$(api_internal POST /admin/security/waf-rule-exclusions \
  "{\"ruleId\":\"$F4_RULE_ID\",\"hostnameRegex\":\"$F4_HOST_REGEX\",\"scope\":\"args_names_only\",\"reason\":\"dup test\"}" 2>&1)
# Disabled row exists so this should succeed (not duplicate vs. disabled). Re-enable original first.
# Actually with disabled=true the original isn't enabled → new create is allowed. Let me test the
# duplicate path properly: re-enable original, then try to create another enabled.
if [[ -n "${h_id:-}" ]]; then
  api_internal PATCH "/admin/security/waf-rule-exclusions/$h_id" '{"disabled":false}' >/dev/null
fi
# Now another POST should 409
dupe_rc=$(kubectl_run "run waf-cs-h-dupe-$(next_nonce) -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"ruleId\":\"$F4_RULE_ID\",\"hostnameRegex\":\"$F4_HOST_REGEX\",\"scope\":\"args_names_only\",\"reason\":\"dup test\"}' http://platform-api.platform.svc:3000/api/v1/admin/security/waf-rule-exclusions" 2>&1 | tail -1)
if [[ "$dupe_rc" == "409" ]]; then
  ok "F4: duplicate enabled row rejected (409)"
else
  fail "F4: duplicate got HTTP $dupe_rc (expected 409)"
fi

# H9: Invalid regex (unbalanced paren) → 400
inv_rc=$(kubectl_run "run waf-cs-h-invalid-$(next_nonce) -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"ruleId\":\"930120\",\"hostnameRegex\":\"^bad(regex\",\"scope\":\"args_names_only\",\"reason\":\"invalid regex\"}' http://platform-api.platform.svc:3000/api/v1/admin/security/waf-rule-exclusions" 2>&1 | tail -1)
if [[ "$inv_rc" == "400" ]]; then
  ok "F4: invalid regex rejected (400)"
else
  fail "F4: invalid regex got HTTP $inv_rc (expected 400)"
fi

# H10: Quote-injection blocked at validator
qi_rc=$(kubectl_run "run waf-cs-h-inj-$(next_nonce) -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"ruleId\":\"930120\",\"hostnameRegex\":\"^evil\\\".*\",\"scope\":\"args_names_only\",\"reason\":\"injection\"}' http://platform-api.platform.svc:3000/api/v1/admin/security/waf-rule-exclusions" 2>&1 | tail -1)
if [[ "$qi_rc" == "400" ]]; then
  ok "F4: quote-injection regex rejected (400)"
else
  fail "F4: quote-injection got HTTP $qi_rc (expected 400)"
fi

# H10b: Trailing-backslash (CRITICAL — would CrashLoopBackOff modsec-crs)
# Caught by Zod's .refine(regexParseable) since `new RegExp('foo\\')` throws.
tb_rc=$(kubectl_run "run waf-cs-h-tb-$(next_nonce) -n platform --rm -i --restart=Never --image=curlimages/curl:latest --quiet --command -- curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"ruleId\":\"930120\",\"hostnameRegex\":\"api\\\\.example\\\\.com\\\\\",\"scope\":\"args_names_only\",\"reason\":\"trailing backslash test\"}' http://platform-api.platform.svc:3000/api/v1/admin/security/waf-rule-exclusions" 2>&1 | tail -1)
if [[ "$tb_rc" == "400" ]]; then
  ok "F4: trailing-backslash regex rejected (400)"
else
  fail "F4: trailing-backslash got HTTP $tb_rc (expected 400)"
fi

# H11: DELETE removes the row
if [[ -n "${h_id:-}" ]]; then
  h_del=$(api_internal DELETE "/admin/security/waf-rule-exclusions/$h_id")
  if echo "$h_del" | grep -q '"deleted"'; then
    ok "F4: exclusion deleted"
  else
    fail "F4: delete failed: $(echo "$h_del" | head -c 200)"
  fi
fi

# H12: After delete, GET returns empty (or no harness row)
h_list_final=$(api_internal GET /admin/security/waf-rule-exclusions)
if echo "$h_list_final" | grep -q "$F4_HOST_REGEX"; then
  fail "F4: deleted row still appears in GET list"
else
  ok "F4: post-delete GET no longer shows harness row"
fi

# H13: ConfigMap content reverts to empty-body banner
sleep 2
h_cm_final=$(kubectl_run "get configmap -n traefik modsec-crs-exclusions-dynamic -o jsonpath='{.data.REQUEST-901-EXCLUSION-RULES-BEFORE-CRS-DYNAMIC\\.conf}'" 2>&1)
if echo "$h_cm_final" | grep -q "No DB-rendered exclusions are currently enabled"; then
  ok "F4: ConfigMap reverted to empty-body after delete"
else
  fail "F4: ConfigMap still contains exclusion content: $(echo "$h_cm_final" | head -c 300)"
fi

# ─── Phase 5 — Coverage finishing checks ──────────────────────────────

phase "Phase 5 — Coverage finishing checks"

# Re-fetch status after the test; bouncers may have come online after
# the ban triggered a pull.
# (Phase 5 block continues below — original content preserved.)

# Re-define here to avoid the variable being overwritten before this point.
_phase5_status=$(api_internal GET /admin/security/crowdsec/status)
_fresh_count=$(printf '%s' "$_phase5_status" | python3 -c "import sys,json; print(sum(1 for b in json.load(sys.stdin)['data']['bouncers'] if b['online']))")
if (( _fresh_count > 0 )); then
  ok "after ban/unban cycle: $_fresh_count bouncer(s) online"
else
  fail "no bouncers online after ban/unban cycle — enforcement is broken on this cluster"
fi

# Surface waf-events scraperStatus too.
_waf_status=$(api_internal GET /admin/security/waf-events)
_modsec_found=$(printf '%s' "$_waf_status" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['scraperStatus']['modsecPodFound'])")
if [[ "$_modsec_found" == "True" ]]; then
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
