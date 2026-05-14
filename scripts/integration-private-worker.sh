#!/usr/bin/env bash
# Private-worker end-to-end integration harness (staging).
#
# Drives the full lifecycle of the private-worker feature against a real
# staging cluster: provision → agent dial-in → user-visible TLS traffic
# through a tenant ingress → revoke → cleanup.
#
# Every phase ends with a USER-VISIBLE assertion (curl/openssl/kubectl
# get-pod-status) per memory `feedback_assert_user_visible_only.md`.
# "Controller reconciled" alone is never sufficient evidence.
#
# ─── REQUIRED ENV ─────────────────────────────────────────────────────
#   ADMIN_PASSWORD          Admin login password (no default — must be set)
#
# ─── OPTIONAL ENV (with sensible defaults) ────────────────────────────
#   ADMIN_HOST              https://admin.staging.phoenix-host.net
#   ADMIN_EMAIL             admin@phoenix-host.net
#   TENANT_BASE             staging.success.com.na
#                             Wildcard apex for client ingress hostnames.
#                             Test creates pw-e2e-<ts>.<slug>.<TENANT_BASE>.
#   TUNNEL_BASE             tunnels.staging.phoenix-host.net
#                             Anchor host the agent dials into.
#   STAGING_SSH_HOST        First IP from ~/k8s-staging/servers.txt, or
#                             46.224.122.58 (staging1) as last fallback.
#   SSH_KEY                 ~/hosting-platform.key
#   AGENT_IMAGE             ghcr.io/phoenixtechnam/hosting-platform/private-worker-agent:latest
#   ECHO_IMAGE              hashicorp/http-echo:latest
#                             Sample local service the agent tunnels.
#   PLAN_NAME               Starter
#
# ─── USAGE ────────────────────────────────────────────────────────────
#   ADMIN_PASSWORD=... ./scripts/integration-private-worker.sh [phase]
#     phase:  phase1 | phase2 | phase3 | phase4 | phase5 | all (default)
#
# Each phase prints OK/FAIL with timings and is independently re-runnable
# only when its prerequisites are satisfied (state is passed via tmpfiles
# under /tmp/pw-e2e.*).
#
# ─── EXIT CODES ───────────────────────────────────────────────────────
#   0  all assertions passed
#   1  one or more assertions failed
#   2  prereq missing (ADMIN_PASSWORD unset, missing tools, DNS broken)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/private-worker-helpers.sh
source "$SCRIPT_DIR/lib/private-worker-helpers.sh"

# ─── config ───────────────────────────────────────────────────────────

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
TENANT_BASE="${TENANT_BASE:-staging.success.com.na}"
TUNNEL_BASE="${TUNNEL_BASE:-tunnels.staging.phoenix-host.net}"

SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"

# Prefer STAGING_SSH_HOST; fall back to first IP in ~/k8s-staging/servers.txt;
# last resort is the historical staging1 IP. Strip user@ prefix if present.
if [[ -z "${STAGING_SSH_HOST:-}" ]]; then
  if [[ -r "$HOME/k8s-staging/servers.txt" ]]; then
    STAGING_SSH_HOST=$(awk '/^staging[0-9]+\.phoenix-host\.net/ {print $2; exit}' \
      "$HOME/k8s-staging/servers.txt" 2>/dev/null || true)
  fi
  STAGING_SSH_HOST="${STAGING_SSH_HOST:-46.224.122.58}"
fi
CONTROL_HOST="${STAGING_SSH_HOST##*@}"

AGENT_IMAGE="${AGENT_IMAGE:-ghcr.io/phoenixtechnam/hosting-platform/private-worker-agent:latest}"
ECHO_IMAGE="${ECHO_IMAGE:-hashicorp/http-echo:latest}"
PLAN_NAME="${PLAN_NAME:-Starter}"

# Local docker fixture names (kept distinct so a leftover from one run
# doesn't collide with the next and so cleanup can target them precisely).
DOCKER_NETWORK="pw-e2e-net"
DOCKER_ECHO_NAME="pw-e2e-echo"
DOCKER_AGENT_NAME="pw-e2e-agent"

# State tmpfiles (allow phaseN to be re-run independently).
STATE_DIR="${STATE_DIR:-/tmp}"
STATE_CID="$STATE_DIR/pw-e2e.cid"
STATE_SLUG="$STATE_DIR/pw-e2e.slug"
STATE_NS="$STATE_DIR/pw-e2e.ns"
STATE_WID="$STATE_DIR/pw-e2e.wid"
STATE_TOKEN="$STATE_DIR/pw-e2e.token"
STATE_DID="$STATE_DIR/pw-e2e.did"
STATE_RID="$STATE_DIR/pw-e2e.rid"
STATE_HOST="$STATE_DIR/pw-e2e.host"
STATE_MARKER="$STATE_DIR/pw-e2e.marker"

# ─── globals ──────────────────────────────────────────────────────────

PHASE="${1:-all}"
PASSED=0
FAILED=0
FAILURES=()
TOKEN=""

# ─── prereqs ──────────────────────────────────────────────────────────

require_env() {
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    echo "ERROR: ADMIN_PASSWORD must be set" >&2
    exit 2
  fi
  for tool in curl jq docker openssl dig; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "ERROR: required tool '$tool' not found on PATH" >&2
      exit 2
    fi
  done
}

prereq_dns() {
  log "── prereq: DNS ──"
  local probe resolved
  probe="probe-$(date +%s).${TENANT_BASE}"
  resolved=$(dig +short "$probe" 2>/dev/null | head -3)
  if echo "$resolved" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|[0-9a-fA-F:]+:[0-9a-fA-F:]+'; then
    ok "wildcard *.${TENANT_BASE} resolves"
  else
    fail "*.${TENANT_BASE} does not resolve. Set TENANT_BASE to a wildcard pointed at the cluster ingress IPs."
    exit 2
  fi

  resolved=$(dig +short "$TUNNEL_BASE" 2>/dev/null | head -3)
  if echo "$resolved" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|[0-9a-fA-F:]+:[0-9a-fA-F:]+'; then
    ok "anchor $TUNNEL_BASE resolves"
  else
    fail "$TUNNEL_BASE does not resolve. Set TUNNEL_BASE to the tunnel anchor host for this cluster."
    exit 2
  fi
}

prereq_login() {
  log "── prereq: login ──"
  TOKEN=$(login_token "$ADMIN_HOST" "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  if [[ -z "$TOKEN" ]]; then
    fail "login as $ADMIN_EMAIL failed"
    exit 2
  fi
  ok "logged in as $ADMIN_EMAIL"
}

# ─── phase 1: provision ───────────────────────────────────────────────

phase1_provision() {
  log "── phase 1: provision client + private worker ──"
  local started_at; started_at=$(date +%s)

  local plan_id region_id
  plan_id=$(api GET "/plans" \
    | jq -r --arg name "$PLAN_NAME" '.data[] | select(.name == $name) | .id' \
    | head -1)
  region_id=$(api GET "/regions" | jq -r '.data[0].id // empty')
  if [[ -z "$plan_id" || -z "$region_id" ]]; then
    fail "could not resolve plan_id ($PLAN_NAME) / region_id"
    return 1
  fi
  ok "resolved plan=${plan_id:0:8} region=${region_id:0:8}"

  local stamp; stamp=$(date +%s)
  local company="Private Worker E2E $stamp"
  local resp cid
  resp=$(api POST "/clients" "$(jq -nc \
    --arg name "$company" \
    --arg email "pw-e2e-$stamp@phoenix-host.net" \
    --arg plan "$plan_id" \
    --arg region "$region_id" \
    '{company_name:$name, company_email:$email, plan_id:$plan, region_id:$region, storage_tier:"local"}')")
  cid=$(echo "$resp" | jq -r '.data.id // empty')
  if [[ -z "$cid" ]]; then
    fail "client create failed: $(echo "$resp" | head -c 300)"
    return 1
  fi
  ok "client created cid=$cid"
  echo "$cid" > "$STATE_CID"

  # Wait for the namespace to exist before polling provisioningStatus —
  # without this the /clients/:id call may race the orchestrator.
  wait_for 90 "namespace exists for cid=$cid" "Active" \
    "ssh_cp 'kubectl get ns -l client=$cid --no-headers 2>/dev/null'" || return 1

  wait_for 180 "client provisioned" '"provisioningStatus":"provisioned"' \
    "api GET '/clients/$cid'" || return 1

  # Resolve the K8s namespace via label (the API returns
  # `kubernetesNamespace` directly, but we use the cluster as
  # source-of-truth so the test catches drift between DB and cluster).
  local ns
  ns=$(ssh_cp "kubectl get ns -l client=$cid -o jsonpath='{.items[0].metadata.name}' 2>/dev/null")
  if [[ -z "$ns" ]]; then
    fail "could not resolve namespace for cid=$cid"
    return 1
  fi
  echo "$ns" > "$STATE_NS"
  ok "namespace=$ns"

  # Mint the private worker. Slug is generated by the backend (or
  # caller-supplied; we let the backend assign one for the test).
  local pw_resp
  pw_resp=$(api POST "/clients/$cid/private-workers" "$(jq -nc \
    '{name:"e2e-test-1", description:"private-worker E2E harness"}')")
  local wid pw_token docker_run docker_compose slug
  wid=$(echo "$pw_resp" | jq -r '.data.workerId // .data.worker.id // empty')
  pw_token=$(echo "$pw_resp" | jq -r '.data.token // empty')
  docker_run=$(echo "$pw_resp" | jq -r '.data.dockerRunCommand // empty')
  docker_compose=$(echo "$pw_resp" | jq -r '.data.dockerComposeYaml // empty')
  slug=$(echo "$pw_resp" | jq -r '.data.worker.slug // empty')
  if [[ -z "$wid" || -z "$pw_token" || -z "$slug" ]]; then
    fail "private-worker create did not return workerId+token+slug: $(echo "$pw_resp" | head -c 400)"
    return 1
  fi
  ok "private worker created workerId=$wid slug=$slug (token captured)"
  echo "$wid" > "$STATE_WID"
  echo "$slug" > "$STATE_SLUG"
  printf '%s' "$pw_token" > "$STATE_TOKEN"
  chmod 0600 "$STATE_TOKEN" || true

  # Verify response shape — API contract regression guard.
  if [[ -n "$docker_run" ]]; then
    ok "response includes dockerRunCommand"
  else
    fail "response missing dockerRunCommand"
  fi
  if [[ -n "$docker_compose" ]]; then
    ok "response includes dockerComposeYaml"
  else
    fail "response missing dockerComposeYaml"
  fi
  local worker_obj
  worker_obj=$(echo "$pw_resp" | jq -r '.data.worker // empty')
  if [[ -n "$worker_obj" && "$worker_obj" != "null" ]]; then
    ok "response includes worker object"
  else
    fail "response missing worker object"
  fi

  # USER-VISIBLE: cluster-side Deployment ready.
  wait_for 120 "private-worker-server has 1 ready replica in $ns" '^1$' \
    "ssh_cp \"kubectl -n $ns get deployment private-worker-server -o jsonpath='{.status.readyReplicas}' 2>/dev/null\"" \
    || return 1

  # USER-VISIBLE: per-client tunnel Ingress in platform-system.
  wait_for 60 "per-client tunnel ingress tunnel-$slug exists in platform-system" "tunnel-$slug" \
    "ssh_cp \"kubectl -n platform-system get ingress tunnel-$slug --no-headers 2>/dev/null\"" \
    || return 1

  # USER-VISIBLE: ExternalName service in platform-system points at the client ns.
  local extname
  extname=$(ssh_cp "kubectl -n platform-system get svc tunnel-$slug -o jsonpath='{.spec.externalName}' 2>/dev/null" || true)
  if [[ "$extname" == *".$ns.svc.cluster.local" ]]; then
    ok "ExternalName tunnel-$slug → $extname"
  else
    fail "ExternalName tunnel-$slug not pointing at client ns (got '$extname')"
  fi

  local elapsed=$(( $(date +%s) - started_at ))
  log "phase 1 finished in ${elapsed}s"
}

# ─── phase 2: agent dial-in ───────────────────────────────────────────

phase2_dial_in() {
  log "── phase 2: agent dial-in (local docker) ──"
  local started_at; started_at=$(date +%s)

  local cid wid pw_token
  cid=$(cat "$STATE_CID" 2>/dev/null || true)
  wid=$(cat "$STATE_WID" 2>/dev/null || true)
  pw_token=$(cat "$STATE_TOKEN" 2>/dev/null || true)
  if [[ -z "$cid" || -z "$wid" || -z "$pw_token" ]]; then
    fail "phase 1 state missing — run phase1 first"
    return 1
  fi

  # Mint a fresh marker for this run (allows phase3 to assert exact byte match).
  local marker
  marker=$(pw_render_marker)
  echo "$marker" > "$STATE_MARKER"
  ok "marker for round-trip = $marker"

  # Defensive cleanup of any leftovers from a previous run.
  pw_docker_cleanup "$DOCKER_AGENT_NAME" "$DOCKER_ECHO_NAME" "$DOCKER_NETWORK"

  # Pull images ahead of run so we can fail fast with a clear error.
  if ! docker pull "$ECHO_IMAGE" >/dev/null 2>&1; then
    fail "docker pull $ECHO_IMAGE failed"
    return 1
  fi
  if ! docker pull "$AGENT_IMAGE" >/dev/null 2>&1; then
    fail "docker pull $AGENT_IMAGE failed"
    return 1
  fi
  ok "pulled $ECHO_IMAGE + $AGENT_IMAGE"

  # v2 token blob has no baked-in local target. The agent reads
  # PRIVATE_WORKER_TARGET at runtime. We put both containers on a
  # custom docker network so the agent can reach the echo by service
  # name (pw-e2e-echo:8080).
  docker network create "$DOCKER_NETWORK" >/dev/null 2>&1 || true

  if ! docker run -d --rm \
      --name "$DOCKER_ECHO_NAME" \
      --network "$DOCKER_NETWORK" \
      "$ECHO_IMAGE" \
      -text="$marker" \
      -listen=:8080 >/dev/null 2>&1; then
    fail "failed to start $DOCKER_ECHO_NAME"
    return 1
  fi
  ok "echo container $DOCKER_ECHO_NAME started"

  # v2 agent: PRIVATE_WORKER_TARGET points at the echo via docker DNS.
  if ! docker run -d --rm \
      --name "$DOCKER_AGENT_NAME" \
      --network "$DOCKER_NETWORK" \
      -e "PRIVATE_WORKER_TOKEN=$pw_token" \
      -e "PRIVATE_WORKER_TARGET=$DOCKER_ECHO_NAME:8080" \
      "$AGENT_IMAGE" >/dev/null 2>&1; then
    fail "failed to start $DOCKER_AGENT_NAME"
    docker logs "$DOCKER_ECHO_NAME" 2>&1 | tail -20 >&2 || true
    return 1
  fi
  ok "tunnel agent $DOCKER_AGENT_NAME started (target=$DOCKER_ECHO_NAME:8080 on $DOCKER_NETWORK)"

  # USER-VISIBLE: agent log shows successful login + proxy registered.
  # frp v0.62 logs "login to server success" on first successful auth, then
  # "[proxy] start proxy success" once the per-worker remote port is bound.
  # The connect-event webhook for last_seen_at is a v2 polish item — the
  # user-visible state of the world is the agent log + the in-cluster
  # traffic flow (verified next).
  local found_login=false
  local found_proxy=false
  for _ in $(seq 1 12); do
    local logs
    logs=$(docker logs "$DOCKER_AGENT_NAME" 2>&1 || true)
    if [[ "$found_login" != true ]] && echo "$logs" | grep -qE 'login to server success|login to the server success|successfully connected'; then
      found_login=true
    fi
    if [[ "$found_proxy" != true ]] && echo "$logs" | grep -qE 'start proxy success'; then
      found_proxy=true
    fi
    if $found_login && $found_proxy; then break; fi
    sleep 5
  done
  if $found_login; then
    ok "agent log shows successful login to server"
  else
    fail "agent log never showed 'login to server success' within 60s"
    docker logs "$DOCKER_AGENT_NAME" 2>&1 | tail -30 >&2 || true
  fi
  if $found_proxy; then
    ok "agent log shows proxy registered ('start proxy success')"
  else
    fail "agent log never showed 'start proxy success' within 60s"
    docker logs "$DOCKER_AGENT_NAME" 2>&1 | tail -30 >&2 || true
  fi

  local elapsed=$(( $(date +%s) - started_at ))
  log "phase 2 finished in ${elapsed}s"
}

# ─── phase 3: user-visible traffic via tenant ingress ─────────────────

phase3_traffic() {
  log "── phase 3: user-visible traffic ──"
  local started_at; started_at=$(date +%s)

  local cid slug wid marker
  cid=$(cat "$STATE_CID" 2>/dev/null || true)
  slug=$(cat "$STATE_SLUG" 2>/dev/null || true)
  wid=$(cat "$STATE_WID" 2>/dev/null || true)
  marker=$(cat "$STATE_MARKER" 2>/dev/null || true)
  if [[ -z "$cid" || -z "$slug" || -z "$wid" ]]; then
    fail "phase 1 state missing — run phase1 first"
    return 1
  fi
  if [[ -z "$marker" ]]; then
    warn "no marker on disk — phase 2 was skipped, body assertion will be relaxed"
  fi

  local stamp; stamp=$(date +%s)
  local host="pw-e2e-${stamp}.${slug}.${TENANT_BASE}"
  echo "$host" > "$STATE_HOST"
  ok "test hostname = $host"

  # Register the domain with the platform first (FQDN on the wildcard apex).
  # The platform DNS layer is external (ADR-022) so we only need to declare
  # ownership; the wildcard CNAME chain handles routing.
  local dom_resp did
  dom_resp=$(api POST "/clients/$cid/domains" "$(jq -nc --arg h "$host" '{domain_name:$h, dns_mode:"cname"}')")
  did=$(echo "$dom_resp" | jq -r '.data.id // empty')
  if [[ -z "$did" ]]; then
    # Some implementations key by the apex; fall back to creating the apex
    # and letting the route hold the FQDN.
    local apex="${slug}.${TENANT_BASE}"
    dom_resp=$(api POST "/clients/$cid/domains" "$(jq -nc --arg h "$apex" '{domain_name:$h, dns_mode:"cname"}')")
    did=$(echo "$dom_resp" | jq -r '.data.id // empty')
  fi
  if [[ -z "$did" ]]; then
    fail "could not create domain (resp=$(echo "$dom_resp" | head -c 300))"
    return 1
  fi
  echo "$did" > "$STATE_DID"
  ok "domain registered did=$did"

  # Create the ingress route targeting the private worker.
  # Routes nest under the domain (per the existing module structure).
  # target_type is implicit from which id is set on the body.
  local route_resp rid
  route_resp=$(api POST "/clients/$cid/domains/$did/routes" "$(jq -nc \
    --arg h "$host" \
    --arg pwid "$wid" \
    '{hostname:$h, private_worker_id:$pwid, path:"/"}')")
  rid=$(echo "$route_resp" | jq -r '.data.id // empty')
  if [[ -z "$rid" ]]; then
    fail "ingress-route create failed: $(echo "$route_resp" | head -c 300)"
    return 1
  fi
  echo "$rid" > "$STATE_RID"
  ok "ingress route created rid=$rid (target=private_worker)"

  # USER-VISIBLE: HTTPS endpoint reaches 200 (ACME issuance + ingress
  # programming + tunnel proxy all green together). 5min budget covers
  # cold HTTP-01 issuance.
  wait_for_http 300 "https://$host/" "200" || return 1

  # USER-VISIBLE: response body must contain the marker the echo server
  # was started with — proves the byte path tenant→ingress→ExternalName→
  # frps→frpc→echo round-tripped correctly.
  if [[ -n "$marker" ]]; then
    local body
    body=$(curl -sk --max-time 15 "https://$host/" || true)
    if echo "$body" | grep -qF "$marker"; then
      ok "response body contains marker '$marker'"
    else
      fail "response body did not contain marker (got: $(echo "$body" | head -c 200))"
    fi
  fi

  # USER-VISIBLE: served TLS cert subject CN matches the host (rules out
  # MITM / wildcard-mismatch / fallback-cert scenarios). HTTP-01 issuance
  # can take a few minutes; poll until the LE cert lands or the budget
  # expires. The intermediate "Kubernetes Ingress Controller Fake
  # Certificate" is the placeholder NGINX serves before issuance.
  local cert_cn=""
  local cert_t=0
  while (( cert_t < 360 )); do
    cert_cn=$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null \
      | sed -E 's/.*CN[ ]*=[ ]*([^,/]+).*/\1/' \
      | tr -d ' ')
    if [[ "$cert_cn" == "$host" ]] || [[ "$cert_cn" == "*."* && "${host#*.}" == "${cert_cn#\*.}" ]]; then
      break
    fi
    sleep 15
    cert_t=$((cert_t + 15))
  done
  if [[ "$cert_cn" == "$host" ]] || [[ "$cert_cn" == "*."* && "${host#*.}" == "${cert_cn#\*.}" ]]; then
    ok "TLS cert CN '$cert_cn' matches host '$host'"
  else
    fail "TLS cert CN mismatch (cn=$cert_cn host=$host)"
  fi

  local elapsed=$(( $(date +%s) - started_at ))
  log "phase 3 finished in ${elapsed}s"
}

# ─── phase 4: revoke ──────────────────────────────────────────────────

phase4_revoke() {
  log "── phase 4: revoke ──"
  local started_at; started_at=$(date +%s)

  local cid wid host
  cid=$(cat "$STATE_CID" 2>/dev/null || true)
  wid=$(cat "$STATE_WID" 2>/dev/null || true)
  host=$(cat "$STATE_HOST" 2>/dev/null || true)
  if [[ -z "$cid" || -z "$wid" ]]; then
    fail "phase 1 state missing — run phase1 first"
    return 1
  fi

  local resp
  resp=$(api POST "/clients/$cid/private-workers/$wid/revoke" "{}")
  local status
  status=$(echo "$resp" | jq -r '.data.status // .data.worker.status // empty')
  if [[ "$status" == "revoked" ]]; then
    ok "revoke endpoint returned status=revoked"
  else
    fail "revoke endpoint did not flip status (resp=$(echo "$resp" | head -c 300))"
  fi

  # USER-VISIBLE: the agent's connection drops. frpc logs an auth fail
  # or "service [...] login failure" message.
  local agent_dropped=false
  for _ in $(seq 1 12); do
    if docker logs "$DOCKER_AGENT_NAME" 2>&1 \
        | grep -qE 'login to server failed|authorization failed|invalid token|connection.*closed.*by server|i/o deadline reached|connect to server error: bad status|allow_ports'; then
      agent_dropped=true
      break
    fi
    sleep 5
  done
  if $agent_dropped; then
    ok "agent log shows disconnect / auth-fail after revoke"
  else
    fail "agent log never showed disconnect within 60s after revoke"
    docker logs "$DOCKER_AGENT_NAME" 2>&1 | tail -30 >&2 || true
  fi

  # USER-VISIBLE: tenant URL now returns 502 (no upstream).
  if [[ -n "$host" ]]; then
    local code last_code="000"
    for _ in $(seq 1 12); do
      code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://$host/" 2>/dev/null || echo "000")
      last_code="$code"
      [[ "$code" == "502" || "$code" == "503" || "$code" == "504" ]] && break
      sleep 5
    done
    if [[ "$last_code" == "502" || "$last_code" == "503" || "$last_code" == "504" ]]; then
      ok "https://$host/ returned $last_code after revoke (upstream gone)"
    else
      fail "https://$host/ still returning $last_code after revoke (expected 5xx)"
    fi
  fi

  local elapsed=$(( $(date +%s) - started_at ))
  log "phase 4 finished in ${elapsed}s"
}

# ─── phase 5: cleanup ─────────────────────────────────────────────────

phase5_cleanup() {
  log "── phase 5: cleanup ──"
  local started_at; started_at=$(date +%s)

  local cid wid slug ns rid did
  cid=$(cat "$STATE_CID" 2>/dev/null || true)
  wid=$(cat "$STATE_WID" 2>/dev/null || true)
  slug=$(cat "$STATE_SLUG" 2>/dev/null || true)
  ns=$(cat "$STATE_NS" 2>/dev/null || true)
  rid=$(cat "$STATE_RID" 2>/dev/null || true)
  did=$(cat "$STATE_DID" 2>/dev/null || true)

  # Delete the ingress route first (FK-safe ordering).
  if [[ -n "$cid" && -n "$rid" ]]; then
    api DELETE "/clients/$cid/ingress-routes/$rid" >/dev/null 2>&1 || true
    ok "deleted ingress-route $rid (best effort)"
  fi
  if [[ -n "$cid" && -n "$did" ]]; then
    api DELETE "/clients/$cid/domains/$did" >/dev/null 2>&1 || true
    ok "deleted domain $did (best effort)"
  fi

  # Delete the private worker.
  if [[ -n "$cid" && -n "$wid" ]]; then
    local del_resp del_code
    del_resp=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 30 \
      -X DELETE "$ADMIN_HOST/api/v1/clients/$cid/private-workers/$wid" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo "000")
    del_code="$del_resp"
    if [[ "$del_code" == "200" || "$del_code" == "204" ]]; then
      ok "DELETE private-worker $wid → HTTP $del_code"
    else
      fail "DELETE private-worker $wid → HTTP $del_code"
    fi
  fi

  # USER-VISIBLE: cluster-side resources gone.
  # Reconciler teardown is fire-and-forget after the DELETE returns —
  # eventual consistency, can take >60s on a busy reconciler.
  if [[ -n "$ns" ]]; then
    local ten=0
    while (( ten < 360 )); do
      if ssh_cp "kubectl -n $ns get deployment private-worker-server 2>&1" \
          | grep -qE 'NotFound|not found'; then
        ok "Deployment private-worker-server in $ns is gone"
        break
      fi
      sleep 5
      ten=$((ten + 5))
    done
    if (( ten >= 360 )); then
      fail "Deployment private-worker-server still exists in $ns after 360s"
    fi
  fi
  if [[ -n "$slug" ]]; then
    local ten=0
    while (( ten < 360 )); do
      if ssh_cp "kubectl -n platform-system get ingress tunnel-$slug 2>&1" \
          | grep -qE 'NotFound|not found'; then
        ok "Ingress tunnel-$slug in platform-system is gone"
        break
      fi
      sleep 5
      ten=$((ten + 5))
    done
    if (( ten >= 360 )); then
      fail "Ingress tunnel-$slug still present in platform-system after 360s"
    fi
  fi

  # Local docker fixtures.
  pw_docker_cleanup "$DOCKER_AGENT_NAME" "$DOCKER_ECHO_NAME" "$DOCKER_NETWORK"
  ok "local docker fixtures torn down"

  # Finally delete the client (cascade handles audit + remaining rows).
  if [[ -n "$cid" ]]; then
    curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$cid" \
      -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
    ok "deleted client $cid (best effort)"
  fi

  # State files.
  rm -f "$STATE_CID" "$STATE_SLUG" "$STATE_NS" "$STATE_WID" "$STATE_TOKEN" \
        "$STATE_DID" "$STATE_RID" "$STATE_HOST" "$STATE_MARKER" 2>/dev/null || true

  local elapsed=$(( $(date +%s) - started_at ))
  log "phase 5 finished in ${elapsed}s"
}

# ─── trap ─────────────────────────────────────────────────────────────

on_exit() {
  # Best-effort docker cleanup so a SIGINT during phase 2/3 doesn't leak
  # a running agent container that holds a port. State files are kept so
  # the operator can re-run phase5 manually if they want to inspect first.
  pw_docker_cleanup "$DOCKER_AGENT_NAME" "$DOCKER_ECHO_NAME" "$DOCKER_NETWORK" 2>/dev/null || true
}
trap on_exit EXIT

# ─── main ─────────────────────────────────────────────────────────────

require_env

case "$PHASE" in
  all)
    prereq_dns
    prereq_login
    phase1_provision
    phase2_dial_in
    phase3_traffic
    phase4_revoke
    phase5_cleanup
    ;;
  phase1)
    prereq_dns
    prereq_login
    phase1_provision
    ;;
  phase2)
    prereq_login
    phase2_dial_in
    ;;
  phase3)
    prereq_dns
    prereq_login
    phase3_traffic
    ;;
  phase4)
    prereq_login
    phase4_revoke
    ;;
  phase5)
    prereq_login
    phase5_cleanup
    ;;
  *)
    echo "Unknown phase '$PHASE'. Use: phase1 | phase2 | phase3 | phase4 | phase5 | all" >&2
    exit 2
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
exit 0
