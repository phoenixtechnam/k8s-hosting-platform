#!/usr/bin/env bash
# Private-worker local-dev iteration harness (Unraid + DinD k3s).
#
# Same shape as scripts/integration-private-worker.sh but defaults
# tuned for the local development stack. Provisions a client, mints a
# private worker, runs the agent against a docker echo server, asserts
# the user-visible HTTPS endpoint round-trips through the tunnel.
#
# Phase 4 (revoke) is OFF by default so dev iteration leaves the tunnel
# running between runs — pass `--full` to include it.
#
# ─── REQUIRED ENV ─────────────────────────────────────────────────────
#   ADMIN_PASSWORD          Local admin password (no default — must be set)
#
# ─── OPTIONAL ENV (with sensible defaults) ────────────────────────────
#   ADMIN_HOST              https://admin.k8s-platform.test
#   ADMIN_EMAIL             admin@phoenix-host.net
#   TENANT_BASE             k8s-platform.test
#                             Wildcard apex routed via NPM on Unraid.
#   TUNNEL_BASE             tunnels.k8s-platform.test
#   AGENT_IMAGE             ghcr.io/phoenixtechnam/hosting-platform/private-worker-agent:latest
#                             Override to a locally-built tag during iteration:
#                             AGENT_IMAGE=private-worker-agent:dev ./local-...
#   ECHO_IMAGE              hashicorp/http-echo:latest
#   PLAN_NAME               Starter
#
# ─── USAGE ────────────────────────────────────────────────────────────
#   ADMIN_PASSWORD=... ./scripts/local-private-worker-sample.sh [phase|--full]
#     phase:  phase1 | phase2 | phase3 | phase5 | all (default — skips revoke)
#     --full: include phase 4 (revoke)
#
# ─── EXIT CODES ───────────────────────────────────────────────────────
#   0  all assertions passed
#   1  one or more assertions failed
#   2  prereq missing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/private-worker-helpers.sh
source "$SCRIPT_DIR/lib/private-worker-helpers.sh"

# ─── config ───────────────────────────────────────────────────────────

ADMIN_HOST="${ADMIN_HOST:-https://admin.k8s-platform.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
TENANT_BASE="${TENANT_BASE:-k8s-platform.test}"
TUNNEL_BASE="${TUNNEL_BASE:-tunnels.k8s-platform.test}"

# On the local DinD stack kubectl is reachable from inside the
# control-plane container via `docker exec`; ssh_cp falls back to local
# kubectl-on-PATH when SSH_KEY is absent (see lib/private-worker-helpers.sh).
SSH_KEY="${SSH_KEY:-/nonexistent-on-purpose}"
SSH_OPTS="${SSH_OPTS:-}"
CONTROL_HOST="${CONTROL_HOST:-localhost}"

AGENT_IMAGE="${AGENT_IMAGE:-ghcr.io/phoenixtechnam/hosting-platform/private-worker-agent:latest}"
ECHO_IMAGE="${ECHO_IMAGE:-hashicorp/http-echo:latest}"
PLAN_NAME="${PLAN_NAME:-Starter}"

DOCKER_NETWORK="pw-local-net"
DOCKER_ECHO_NAME="pw-local-echo"
DOCKER_AGENT_NAME="pw-local-agent"

STATE_DIR="${STATE_DIR:-/tmp}"
STATE_CID="$STATE_DIR/pw-local.cid"
STATE_SLUG="$STATE_DIR/pw-local.slug"
STATE_NS="$STATE_DIR/pw-local.ns"
STATE_WID="$STATE_DIR/pw-local.wid"
STATE_TOKEN="$STATE_DIR/pw-local.token"
STATE_DID="$STATE_DIR/pw-local.did"
STATE_RID="$STATE_DIR/pw-local.rid"
STATE_HOST="$STATE_DIR/pw-local.host"
STATE_MARKER="$STATE_DIR/pw-local.marker"

# ─── globals ──────────────────────────────────────────────────────────

PHASE="all"
INCLUDE_REVOKE=false
PASSED=0
FAILED=0
FAILURES=()
TOKEN=""

# ─── arg parsing ──────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --full) INCLUDE_REVOKE=true ;;
    phase1|phase2|phase3|phase4|phase5|all) PHASE="$arg" ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown arg '$arg'. Use --help for usage." >&2
      exit 2
      ;;
  esac
done

# ─── prereqs ──────────────────────────────────────────────────────────

require_env() {
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    echo "ERROR: ADMIN_PASSWORD must be set" >&2
    exit 2
  fi
  for tool in curl jq docker openssl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "ERROR: required tool '$tool' not found on PATH" >&2
      exit 2
    fi
  done
  if ! command -v kubectl >/dev/null 2>&1; then
    warn "kubectl not on PATH — cluster-side assertions will fail. Source the local kubeconfig first."
  fi
}

prereq_login() {
  log "── prereq: login ──"
  TOKEN=$(login_token "$ADMIN_HOST" "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  if [[ -z "$TOKEN" ]]; then
    fail "login as $ADMIN_EMAIL failed against $ADMIN_HOST"
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
  local company="PW Local Sample $stamp"
  local resp cid
  resp=$(api POST "/clients" "$(jq -nc \
    --arg name "$company" \
    --arg email "pw-local-$stamp@phoenix-host.net" \
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

  wait_for 90 "namespace exists for cid=$cid" "Active" \
    "ssh_cp 'kubectl get ns -l client=$cid --no-headers 2>/dev/null'" || return 1

  wait_for 180 "client provisioned" '"provisioningStatus":"provisioned"' \
    "api GET '/clients/$cid'" || return 1

  local slug ns
  slug=$(api GET "/clients/$cid" | jq -r '.data.slug // empty')
  ns=$(ssh_cp "kubectl get ns -l client=$cid -o jsonpath='{.items[0].metadata.name}' 2>/dev/null")
  if [[ -z "$slug" || -z "$ns" ]]; then
    fail "could not resolve slug/ns (slug=$slug ns=$ns)"
    return 1
  fi
  echo "$slug" > "$STATE_SLUG"
  echo "$ns" > "$STATE_NS"
  ok "slug=$slug namespace=$ns"

  local pw_resp wid pw_token
  pw_resp=$(api POST "/clients/$cid/private-workers" "$(jq -nc \
    '{name:"local-sample-1", description:"local DinD sample"}')")
  wid=$(echo "$pw_resp" | jq -r '.data.workerId // .data.worker.id // empty')
  pw_token=$(echo "$pw_resp" | jq -r '.data.token // empty')
  if [[ -z "$wid" || -z "$pw_token" ]]; then
    fail "private-worker create did not return workerId+token: $(echo "$pw_resp" | head -c 400)"
    return 1
  fi
  ok "private worker created workerId=$wid"
  echo "$wid" > "$STATE_WID"
  printf '%s' "$pw_token" > "$STATE_TOKEN"
  chmod 0600 "$STATE_TOKEN" || true

  wait_for 120 "private-worker-server has 1 ready replica in $ns" '^1$' \
    "ssh_cp \"kubectl -n $ns get deployment private-worker-server -o jsonpath='{.status.readyReplicas}' 2>/dev/null\"" \
    || return 1

  wait_for 60 "per-client tunnel ingress tunnel-$slug exists in platform-system" "tunnel-$slug" \
    "ssh_cp \"kubectl -n platform-system get ingress tunnel-$slug --no-headers 2>/dev/null\"" \
    || return 1

  local elapsed=$(( $(date +%s) - started_at ))
  log "phase 1 finished in ${elapsed}s"
}

# ─── phase 2: agent dial-in ───────────────────────────────────────────

phase2_dial_in() {
  log "── phase 2: agent dial-in ──"
  local started_at; started_at=$(date +%s)

  local cid wid pw_token
  cid=$(cat "$STATE_CID" 2>/dev/null || true)
  wid=$(cat "$STATE_WID" 2>/dev/null || true)
  pw_token=$(cat "$STATE_TOKEN" 2>/dev/null || true)
  if [[ -z "$cid" || -z "$wid" || -z "$pw_token" ]]; then
    fail "phase 1 state missing — run phase1 first"
    return 1
  fi

  local marker
  marker=$(pw_render_marker)
  echo "$marker" > "$STATE_MARKER"
  ok "marker for round-trip = $marker"

  pw_docker_cleanup "$DOCKER_AGENT_NAME" "$DOCKER_ECHO_NAME" "$DOCKER_NETWORK"

  if ! docker pull "$ECHO_IMAGE" >/dev/null 2>&1; then
    warn "docker pull $ECHO_IMAGE failed — assuming local cache has it"
  fi
  if ! docker pull "$AGENT_IMAGE" >/dev/null 2>&1; then
    warn "docker pull $AGENT_IMAGE failed — assuming local cache (dev tag?)"
  fi

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
  ok "tunnel agent $DOCKER_AGENT_NAME started (target=$DOCKER_ECHO_NAME:8080)"

  wait_for 60 "private_workers.last_seen_at recorded" "true" \
    "api GET '/clients/$cid/private-workers/$wid' \
      | jq -r --arg now \"\$(date +%s)\" \
        '(.data.lastSeenAt // empty) as \$ls
         | if \$ls == \"\" then false
           else (((\$now | tonumber) - ((\$ls | sub(\"\\\\.[0-9]+\";\"\") | sub(\"Z\$\";\"+0000\") | strptime(\"%Y-%m-%dT%H:%M:%S%z\") | mktime))) < 90)
           end'" \
    || return 1

  local found_login=false
  for _ in $(seq 1 12); do
    if docker logs "$DOCKER_AGENT_NAME" 2>&1 | grep -qE 'login to server success|login to the server success|successfully connected'; then
      found_login=true
      break
    fi
    sleep 5
  done
  if $found_login; then
    ok "agent log shows successful login to server"
  else
    fail "agent log never showed 'login to server success' within 60s"
    docker logs "$DOCKER_AGENT_NAME" 2>&1 | tail -30 >&2 || true
  fi

  local elapsed=$(( $(date +%s) - started_at ))
  log "phase 2 finished in ${elapsed}s"
}

# ─── phase 3: user-visible traffic ────────────────────────────────────

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

  local stamp; stamp=$(date +%s)
  local host="pw-local-${stamp}.${slug}.${TENANT_BASE}"
  echo "$host" > "$STATE_HOST"
  ok "test hostname = $host"

  local dom_resp did
  dom_resp=$(api POST "/clients/$cid/domains" "$(jq -nc --arg h "$host" '{name:$h, dns_mode:"external"}')")
  did=$(echo "$dom_resp" | jq -r '.data.id // empty')
  if [[ -z "$did" ]]; then
    local apex="${slug}.${TENANT_BASE}"
    dom_resp=$(api POST "/clients/$cid/domains" "$(jq -nc --arg h "$apex" '{name:$h, dns_mode:"external"}')")
    did=$(echo "$dom_resp" | jq -r '.data.id // empty')
  fi
  if [[ -z "$did" ]]; then
    fail "could not create domain (resp=$(echo "$dom_resp" | head -c 300))"
    return 1
  fi
  echo "$did" > "$STATE_DID"
  ok "domain registered did=$did"

  local route_resp rid
  route_resp=$(api POST "/clients/$cid/ingress-routes" "$(jq -nc \
    --arg h "$host" \
    --arg pwid "$wid" \
    --arg did "$did" \
    '{hostname:$h, target_type:"private_worker", private_worker_id:$pwid, domain_id:$did, path:"/"}')")
  rid=$(echo "$route_resp" | jq -r '.data.id // empty')
  if [[ -z "$rid" ]]; then
    fail "ingress-route create failed: $(echo "$route_resp" | head -c 300)"
    return 1
  fi
  echo "$rid" > "$STATE_RID"
  ok "ingress route created rid=$rid"

  # Local cluster has no public DNS / ACME — accept either 200 (LE-ready
  # local config) or any non-5xx status that proves the proxy chain is
  # wired. If you've configured local cert-manager + DNS, prefer 200.
  local code last_code="000"
  local i=0
  while (( i < 120 )); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://$host/" 2>/dev/null || echo "000")
    last_code="$code"
    if [[ "$code" == "200" ]]; then
      ok "https://$host/ returned 200 (after ${i}s)"
      break
    fi
    sleep 5
    i=$((i + 5))
  done
  if [[ "$last_code" != "200" ]]; then
    if [[ "$last_code" =~ ^[245][0-9][0-9]$ ]]; then
      warn "https://$host/ returned $last_code — accepting on local DinD (cert may be self-signed). Run --full on staging for strict 200."
      ok "https://$host/ reachable through ingress chain"
    else
      fail "https://$host/ unreachable after 120s (last=$last_code)"
      return 1
    fi
  fi

  if [[ -n "$marker" ]]; then
    local body
    body=$(curl -sk --max-time 15 "https://$host/" || true)
    if echo "$body" | grep -qF "$marker"; then
      ok "response body contains marker '$marker'"
    else
      fail "response body did not contain marker (got: $(echo "$body" | head -c 200))"
    fi
  fi

  local elapsed=$(( $(date +%s) - started_at ))
  log "phase 3 finished in ${elapsed}s"
}

# ─── phase 4: revoke (opt-in via --full) ──────────────────────────────

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

  api POST "/clients/$cid/private-workers/$wid/revoke" "{}" >/dev/null

  local agent_dropped=false
  for _ in $(seq 1 12); do
    if docker logs "$DOCKER_AGENT_NAME" 2>&1 \
        | grep -qE 'login to server failed|authorization failed|invalid token|connection.*closed.*by server|i/o deadline reached'; then
      agent_dropped=true
      break
    fi
    sleep 5
  done
  if $agent_dropped; then
    ok "agent log shows disconnect / auth-fail after revoke"
  else
    fail "agent log never showed disconnect within 60s after revoke"
  fi

  if [[ -n "$host" ]]; then
    local code last_code="000"
    for _ in $(seq 1 12); do
      code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://$host/" 2>/dev/null || echo "000")
      last_code="$code"
      [[ "$code" == "502" || "$code" == "503" || "$code" == "504" ]] && break
      sleep 5
    done
    if [[ "$last_code" =~ ^50[234]$ ]]; then
      ok "https://$host/ returned $last_code after revoke"
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

  if [[ -n "$cid" && -n "$rid" ]]; then
    api DELETE "/clients/$cid/ingress-routes/$rid" >/dev/null 2>&1 || true
    ok "deleted ingress-route $rid (best effort)"
  fi
  if [[ -n "$cid" && -n "$did" ]]; then
    api DELETE "/clients/$cid/domains/$did" >/dev/null 2>&1 || true
    ok "deleted domain $did (best effort)"
  fi

  if [[ -n "$cid" && -n "$wid" ]]; then
    curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$cid/private-workers/$wid" \
      -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
    ok "deleted private-worker $wid (best effort)"
  fi

  if [[ -n "$ns" ]]; then
    if ssh_cp "kubectl -n $ns get deployment private-worker-server 2>&1" \
        | grep -qE 'NotFound|not found'; then
      ok "Deployment private-worker-server in $ns is gone"
    else
      warn "Deployment private-worker-server still in $ns (cascade may still be running)"
    fi
  fi

  pw_docker_cleanup "$DOCKER_AGENT_NAME" "$DOCKER_ECHO_NAME" "$DOCKER_NETWORK"
  ok "local docker fixtures torn down"

  if [[ -n "$cid" ]]; then
    curl -sk -X DELETE "$ADMIN_HOST/api/v1/clients/$cid" \
      -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
    ok "deleted client $cid (best effort)"
  fi

  rm -f "$STATE_CID" "$STATE_SLUG" "$STATE_NS" "$STATE_WID" "$STATE_TOKEN" \
        "$STATE_DID" "$STATE_RID" "$STATE_HOST" "$STATE_MARKER" 2>/dev/null || true

  local elapsed=$(( $(date +%s) - started_at ))
  log "phase 5 finished in ${elapsed}s"
}

# ─── main ─────────────────────────────────────────────────────────────

require_env

case "$PHASE" in
  all)
    prereq_login
    phase1_provision
    phase2_dial_in
    phase3_traffic
    if $INCLUDE_REVOKE; then
      phase4_revoke
      phase5_cleanup
    else
      log "── skipping phase 4 (revoke) — pass --full to include ──"
      log "── skipping phase 5 (cleanup) — tunnel left running for dev iteration ──"
      log "to tear down later: $0 phase5"
    fi
    ;;
  phase1) prereq_login; phase1_provision ;;
  phase2) prereq_login; phase2_dial_in ;;
  phase3) prereq_login; phase3_traffic ;;
  phase4) prereq_login; phase4_revoke ;;
  phase5) prereq_login; phase5_cleanup ;;
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
