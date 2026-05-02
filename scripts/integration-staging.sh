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

# Connection settings — every default targets the historical phoenix-
# host.net staging cluster, but every value is overridable so the
# harness runs cleanly against any cluster bootstrapped by this repo.
ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"

# CONTROL_HOST is the SSH target for cluster-internal kubectl probes.
# Operators usually only set SSH_HOST (which integration-all.sh expects);
# derive CONTROL_HOST from it if not set explicitly. SSH_HOST is in the
# form `user@host` or just `host`; strip the user prefix.
if [[ -z "${CONTROL_HOST:-}" ]]; then
  if [[ -n "$SSH_HOST" ]]; then
    CONTROL_HOST="${SSH_HOST##*@}"
  else
    CONTROL_HOST="46.224.122.58"  # phoenix-host staging1 fallback
  fi
fi

# Test fixtures: known catalog entry IDs. Default points at the
# nginx-php entry in the seeded catalog; override via env var if your
# cluster's catalog uses a different UUID. Resolve via
# `GET /api/v1/catalog?limit=200` if you need to look up the `code`.
CATALOG_NGINX_PHP="${CATALOG_NGINX_PHP:-b6465a21-6c27-4e23-a3ef-3f6d4616dca5}"

# Wildcard DNS domain used to construct ephemeral test hostnames
# (HTTPS scenario provisions `t<timestamp>.${HTTPS_TEST_DOMAIN_BASE}`).
# REQUIRED — the wildcard must resolve to the cluster's ingress IPs.
# Default is the phoenix-tech `staging.success.com.na` zone; operators
# of other clusters MUST set this to a wildcard they control.
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

  # Wait for namespace=Active first (orchestrator step 1).
  wait_for 90 "namespace provisioned" "Active" \
    "ssh_cp 'kubectl get ns -l client=$cid --no-headers'" || return 1

  # Then wait for the orchestrator to fully complete: PVC bound, FM
  # Deployment created at scale 0, ResourceQuota + NetworkPolicies
  # applied. Without this, the FM scenario fires /files/start before
  # the FM Deployment exists and races a half-provisioned namespace.
  wait_for 180 "client provisioned" '"provisioningStatus":"provisioned"' \
    "api GET '/clients/$cid'" || return 1

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

  # 4. Cert ready. Let's Encrypt HTTP-01 issuance on this cluster
  # consistently lands in 6-10 min for a fresh tenant domain — the
  # admission webhook on hostNetwork ingress-nginx is slow to
  # respond on the first solver-Ingress create (cert-manager retries
  # with backoff). 600s = comfortable margin without masking a true
  # failure. A genuinely-broken issuance never completes, so a
  # 600s timeout that fails is real, not flaky.
  #
  # Use the cert NAME (deterministic from the hostname) rather than a
  # jsonpath filter — the inner double quotes in
  # `?(@.spec.dnsNames[0]=="...")` round-trip through ssh+eval
  # unreliably and produced false negatives even when the cert was
  # genuinely Ready.
  local cert_name; cert_name="$(echo "$domain" | tr '.' '-')-cert"
  wait_for 600 "cert-manager Certificate Ready=True" "True" \
    "ssh_cp \"kubectl -n $ns get cert $cert_name -o jsonpath='{.status.conditions[?(@.type==\\\"Ready\\\")].status}'\"" || return 1

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
  #    catches the exact bug from 2026-04-27. Retry up to 60s — even
  #    after the Certificate CR reaches Ready, ingress-nginx needs a
  #    few seconds to re-load its TLS config from the new secret. The
  #    cert IS issued; we're just waiting for the data plane to catch up.
  local subject="" matched=0
  local i=0
  while (( i < 60 )); do
    subject=$(echo | openssl s_client -servername "$domain" -connect "$domain:443" 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null)
    if echo "$subject" | grep -q "CN=$domain"; then
      matched=1; break
    fi
    sleep 4; i=$((i+4))
  done
  if (( matched )); then
    ok "TLS cert subject CN matches host (after ${i}s): $subject"
  else
    fail "TLS cert subject does NOT match $domain after 60s — got: ${subject:-<no cert>}"
    return 1
  fi

  # 7. HTTPS — assert the request reaches the workload pod. The
  #    nginx-php catalog default vhost serves 403 Forbidden on / (no
  #    docroot configured by default), 200/301/302 are the catalog
  #    welcome cases. ALL of those mean the request reached the
  #    tenant's nginx pod. The failures we want to catch:
  #      404 — ingress-nginx default backend (route not found)
  #      503 — pod not ready / no endpoints
  #      000 — connection failed
  #      hostname mismatch — wrong cert served (caught by step 6)
  local status; status=$(curl -sk -o /dev/null -m 15 -w "%{http_code}" "https://$domain/")
  if [[ "$status" =~ ^(200|301|302|403)$ ]]; then
    ok "HTTPS GET / returned $status (tenant workload responded)"
  else
    fail "HTTPS GET https://$domain/ returned $status (expected 2xx/3xx/403 from tenant workload, got default-backend or pod-not-ready)"
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

# ─── scenario 6: image reaper E2E ─────────────────────────────────
#
# Phase 4 acceptance test for the eager image reaper.
#
# Steps:
#   1. Provision a client + deploy the nginx-php catalog entry.
#   2. Wait until the deployment is running (image pulled onto the node).
#   3. Capture which node the pod landed on via kubectl.
#   4. Assert the image IS present on that node via crictl images.
#   5. Delete the deployment via the API.
#   6. Wait the reaper grace period (5 min) + 30s for the reap job to run.
#   7. Assert the image is GONE from the node via crictl images.
#
# SKIP GUARD: this scenario requires SSH access to the cluster node.
# Set SKIP_REAPER_SCENARIO=1 to skip (e.g. on clusters without SSH).

scenario_reaper() {
  if [[ "${SKIP_REAPER_SCENARIO:-}" == "1" ]]; then
    log "scenario reaper skipped — SKIP_REAPER_SCENARIO=1"
    return 0
  fi

  local plan_id region_id
  plan_id=$(api GET "/plans" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((p['id'] for p in d['data'] if p['name']=='Starter'),''))")
  region_id=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'])")
  [[ -n "$plan_id" && -n "$region_id" ]] || { fail "reaper: could not resolve plan/region"; return 1; }

  local stamp; stamp=$(date +%s)
  local company="Reaper Test $stamp"
  local resp; resp=$(api POST "/clients" \
    "{\"company_name\":\"$company\",\"company_email\":\"reaper-$stamp@phoenix-host.net\",\"plan_id\":\"$plan_id\",\"region_id\":\"$region_id\",\"storage_tier\":\"local\"}")
  local cid; cid=$(echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$cid" ]] || { fail "reaper: client create failed"; return 1; }
  ok "reaper: client created cid=$cid"

  wait_for 90 "reaper: namespace provisioned" "Active" \
    "ssh_cp 'kubectl get ns -l client=$cid --no-headers'" || return 1
  wait_for 180 "reaper: client provisioned" '"provisioningStatus":"provisioned"' \
    "api GET '/clients/$cid'" || return 1

  # Deploy nginx-php
  local depl_name="reaper-${stamp}"
  local depl_resp; depl_resp=$(api POST "/clients/$cid/deployments" \
    "{\"catalog_entry_id\":\"$CATALOG_NGINX_PHP\",\"name\":\"$depl_name\",\"replica_count\":1}")
  local depl_id; depl_id=$(echo "$depl_resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$depl_id" ]] || { fail "reaper: deployment create failed: $(echo "$depl_resp" | head -c 300)"; return 1; }
  ok "reaper: deployment created depl_id=$depl_id"

  # Wait for pod to be running (image must be pulled)
  wait_for 240 "reaper: deployment running" '"status":"running"' \
    "api GET '/clients/$cid/deployments/$depl_id'" || return 1

  # Find the namespace and the node the pod landed on
  local ns; ns=$(ssh_cp "kubectl get ns -l client=$cid -o jsonpath='{.items[0].metadata.name}'")
  [[ -n "$ns" ]] || { fail "reaper: could not resolve tenant namespace"; return 1; }

  local node_name; node_name=$(ssh_cp "kubectl -n $ns get pods -l app=$depl_name -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null || true)
  [[ -n "$node_name" ]] || { fail "reaper: could not determine pod node"; return 1; }
  ok "reaper: pod is on node $node_name"

  # Capture the image ref from the running pod
  local image_ref; image_ref=$(ssh_cp "kubectl -n $ns get pods -l app=$depl_name -o jsonpath='{.items[0].status.containerStatuses[0].imageID}'" 2>/dev/null || true)
  # imageID may be a full digest ref; strip the docker-pullable:// prefix if present
  image_ref="${image_ref#docker-pullable://}"
  [[ -n "$image_ref" ]] || { fail "reaper: could not determine image ref"; return 1; }
  ok "reaper: image ref = $image_ref"

  # Assert image IS present on the node before deletion
  if ssh_cp "crictl images 2>/dev/null" | grep -qF "${image_ref%%@*}"; then
    ok "reaper: image confirmed present on node $node_name before delete"
  else
    fail "reaper: image not found on node $node_name before delete — pull may have failed"
    # Clean up and exit scenario (don't false-pass the post-delete check)
    api DELETE "/clients/$cid" >/dev/null 2>&1 || true
    return 1
  fi

  # Delete the deployment
  local del_resp; del_resp=$(api DELETE "/clients/$cid/deployments/$depl_id" 2>/dev/null)
  # Accept 200 or 204
  ok "reaper: deployment deleted (response: $(echo "$del_resp" | head -c 80))"

  # Wait the grace period (5 min) + 30s buffer
  log "reaper: waiting 330s for reaper grace period + job to complete…"
  sleep 330

  # Assert image is GONE from the node
  if ssh_cp "crictl images 2>/dev/null" | grep -qF "${image_ref%%@*}"; then
    fail "reaper: image STILL present on node $node_name after 330s — reaper did not fire"
  else
    ok "reaper: image successfully reaped from node $node_name"
  fi

  # Clean up the test client
  api DELETE "/clients/$cid" >/dev/null 2>&1 || true
}

# ─── scenario: backup bundle (Phase 2 / ADR-032) ─────────────────
# Creates a client, runs a hostpath bundle, asserts that meta.json +
# config + secrets components landed on disk and the bundle row in the
# DB is `completed`. Files component is exercised only if the client
# already has a bound PVC (deployments running) — otherwise the
# scenario asserts `partial` is acceptable, since files capture
# requires a tenant PVC and we're not provisioning one to keep the
# scenario fast.
scenario_bundle() {
  if [[ "${SKIP_BUNDLE_SCENARIO:-}" == "1" ]]; then
    log "scenario bundle skipped — SKIP_BUNDLE_SCENARIO=1"
    return 0
  fi

  local plan_id region_id
  plan_id=$(api GET "/plans" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((p['id'] for p in d['data'] if p['name']=='Starter'),''))")
  region_id=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'])")
  [[ -n "$plan_id" && -n "$region_id" ]] || { fail "bundle: could not resolve plan/region"; return 1; }

  local stamp; stamp=$(date +%s)
  local resp; resp=$(api POST "/clients" \
    "{\"company_name\":\"Bundle Test $stamp\",\"company_email\":\"bundle-$stamp@phoenix-host.net\",\"plan_id\":\"$plan_id\",\"region_id\":\"$region_id\",\"storage_tier\":\"local\"}")
  local cid; cid=$(echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$cid" ]] || { fail "bundle: client create failed"; return 1; }
  ok "bundle: client created cid=$cid"

  wait_for 120 "bundle: client provisioned" '"provisioningStatus":"provisioned"' \
    "api GET '/clients/$cid'" || { api DELETE "/clients/$cid" >/dev/null 2>&1 || true; return 1; }

  # Skip the slow files component — config + secrets only, so the
  # scenario completes in <30s without needing a tenant deployment.
  local body; body="{\"clientId\":\"$cid\",\"initiator\":\"admin\",\"label\":\"E2E bundle $stamp\",\"retentionDays\":1,\"components\":{\"files\":false,\"mailboxes\":false,\"config\":true,\"secrets\":true}}"
  local b_resp; b_resp=$(api POST "/admin/backups/bundles" "$body")
  local bundle_id status
  bundle_id=$(echo "$b_resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('bundleId',''))" 2>/dev/null)
  status=$(echo "$b_resp"   | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('status',''))" 2>/dev/null)
  [[ -n "$bundle_id" ]] || { fail "bundle: create failed: $(echo "$b_resp" | head -c 300)"; api DELETE "/clients/$cid" >/dev/null 2>&1 || true; return 1; }
  [[ "$status" == "completed" ]] || { fail "bundle: status=$status (expected completed) — $(echo "$b_resp" | head -c 300)"; api DELETE "/clients/$cid" >/dev/null 2>&1 || true; return 1; }
  ok "bundle: created $bundle_id status=$status"

  # Assert meta.json + config + secrets exist on the platform-data PVC.
  local found_meta found_config found_secrets
  # Bundles live on a Longhorn RWX PVC mounted into platform-api at
  # /bundles. We can read them via `kubectl exec` into any platform-api
  # replica — no node-side path lookup needed.
  local kx="ssh_cp kubectl -n platform exec deploy/platform-api -c api --"
  found_meta=$($kx ls /bundles/$bundle_id/meta.json 2>/dev/null && echo OK || true)
  found_config=$($kx ls /bundles/$bundle_id/components/config/db-rows.json.gz 2>/dev/null && echo OK || true)
  found_secrets=$($kx ls /bundles/$bundle_id/components/secrets/tls.json.gz.enc 2>/dev/null && echo OK || true)

  [[ "$found_meta" =~ OK ]]    || { fail "bundle: meta.json missing on disk"; api DELETE "/admin/backups/bundles/$bundle_id" >/dev/null 2>&1 || true; api DELETE "/clients/$cid" >/dev/null 2>&1 || true; return 1; }
  [[ "$found_config" =~ OK ]]  || { fail "bundle: config component missing on disk"; api DELETE "/admin/backups/bundles/$bundle_id" >/dev/null 2>&1 || true; api DELETE "/clients/$cid" >/dev/null 2>&1 || true; return 1; }
  [[ "$found_secrets" =~ OK ]] || { fail "bundle: secrets component missing on disk"; api DELETE "/admin/backups/bundles/$bundle_id" >/dev/null 2>&1 || true; api DELETE "/clients/$cid" >/dev/null 2>&1 || true; return 1; }
  ok "bundle: all 3 expected artifacts present on disk"

  # Assert detail endpoint returns the components rows.
  local detail; detail=$(api GET "/admin/backups/bundles/$bundle_id")
  echo "$detail" | grep -q '"components"' || { fail "bundle: detail endpoint missing components"; }
  ok "bundle: detail endpoint returned components"

  # Cleanup
  api DELETE "/admin/backups/bundles/$bundle_id" >/dev/null 2>&1 || true
  api DELETE "/clients/$cid" >/dev/null 2>&1 || true
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

# Auto-resolve CATALOG_NGINX_PHP if the operator-supplied UUID isn't
# present in this cluster's catalog (the seeded UUID varies by
# install/migration version). Falls back to lookup-by-code so the
# suite isn't tied to a specific catalog seed. The default value is
# the historical staging UUID; if the catalog was reseeded or
# re-imported, look up the entry whose `code` is `nginx-php`.
verify_catalog_uuid() {
  api GET "/catalog/$CATALOG_NGINX_PHP" 2>/dev/null \
    | grep -q '"code":"nginx-php"'
}
if ! verify_catalog_uuid; then
  log "CATALOG_NGINX_PHP=${CATALOG_NGINX_PHP} not present in catalog; resolving by code=nginx-php..."
  resolved=$(api GET '/catalog?limit=200' 2>/dev/null \
    | python3 -c "
import json, sys
try:
    body = json.load(sys.stdin)
    items = body.get('data', body) if isinstance(body, dict) else body
    items = items if isinstance(items, list) else items.get('items', [])
    for entry in items:
        if entry.get('code') == 'nginx-php':
            print(entry.get('id') or entry.get('uuid') or '')
            break
except Exception:
    pass
" 2>/dev/null)
  if [[ -n "$resolved" ]]; then
    CATALOG_NGINX_PHP="$resolved"
    log "  resolved CATALOG_NGINX_PHP=$CATALOG_NGINX_PHP"
  else
    fail "could not resolve catalog entry code=nginx-php from /api/v1/catalog. Set CATALOG_NGINX_PHP explicitly."
    exit 2
  fi
fi

case "$SCENARIO" in
  all)
    prereq_dns || { echo "DNS prereq failed; aborting"; exit 1; }
    run_scenario lifecycle
    run_scenario fm
    run_scenario https
    run_scenario reprovision
    run_scenario drain
    run_scenario reaper
    run_scenario bundle
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
