#!/usr/bin/env bash
# Per-ingress OAuth2 / OIDC integration test harness.
#
# Mirrors scripts/integration-staging.sh in shape: scenario-based,
# ok/fail counters, exit code from FAILED, optional scenario filter.
#
# Required env (or use defaults):
#   ADMIN_HOST        — admin panel API base URL
#   ADMIN_EMAIL       — staff login (super_admin / admin)
#   ADMIN_PASSWORD    — staff password (mandatory; no fallback)
#   CONTROL_HOST      — staging1 SSH host for in-cluster checks
#   SSH_KEY           — path to private key for CONTROL_HOST
#   OIDC_ISSUER       — IdP issuer URL (must match Allowed Redirects)
#   OIDC_CLIENT_ID    — registered OAuth client at the IdP
#   OIDC_CLIENT_SECRET— matching secret (encrypted server-side)
#   ROUTE_ID          — optional pin (else discovers an ingress under
#                        HTTPS_TEST_DOMAIN_BASE; if none, provisions one)
#   HTTPS_TEST_DOMAIN_BASE — wildcard apex used to find tenant ingress
#
# Usage:
#   ADMIN_PASSWORD=… ./scripts/ingress-auth-e2e.sh                 # all scenarios
#   ADMIN_PASSWORD=… ./scripts/ingress-auth-e2e.sh discovery       # one scenario
#
# Exit code 0 only when all scenarios pass; otherwise 1.

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
CONTROL_HOST="${CONTROL_HOST:-46.224.122.58}"
SSH_KEY="${SSH_KEY:-/home/dev/hosting-platform.key}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10}"
HTTPS_TEST_DOMAIN_BASE="${HTTPS_TEST_DOMAIN_BASE:-staging.success.com.na}"

OIDC_ISSUER="${OIDC_ISSUER:-https://auth.phoenix-host.net/}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-370577540479254534}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-6ecIC8ggfzras5QwakRtkbCN5bqCrGnGtUh8naHgNN5yjbf1C1zTZ8X3voTPw3XT}"
CATALOG_NGINX_PHP="${CATALOG_NGINX_PHP:-b6465a21-6c27-4e23-a3ef-3f6d4616dca5}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

SCENARIO="${1:-all}"
PASSED=0
FAILED=0
FAILURES=()
PROVISIONED_CID=""
ROUTE_ID="${ROUTE_ID:-}"
HOSTNAME=""
CLIENT_ID=""
NAMESPACE=""

# ─── helpers (match scripts/integration-staging.sh shape) ──────────

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

ssh_run() { ssh -i "$SSH_KEY" $SSH_OPTS "root@$CONTROL_HOST" "$@"; }

psql_q() {
  ssh_run "kubectl -n platform exec -i postgres-1 -c postgres -- psql -U postgres -d hosting_platform -t -A -c \"$1\""
}

run_scenario() {
  local name="$1"
  if [[ "$SCENARIO" != "all" && "$SCENARIO" != "$name" ]]; then return 0; fi
  log "── scenario: $name ──"
  if "scenario_$name"; then
    log "✓ $name done"
  else
    log "✗ $name had failures"
  fi
}

# ─── prereqs ──────────────────────────────────────────────────────

prereq_resolve_target() {
  log "── prereq: resolve target ingress ──"
  if [[ -n "$ROUTE_ID" ]]; then
    local row
    row=$(psql_q "SELECT ir.id, ir.hostname, d.client_id, c.kubernetes_namespace
                  FROM ingress_routes ir
                  JOIN domains d ON d.id = ir.domain_id
                  JOIN clients c ON c.id = d.client_id
                  WHERE ir.id='${ROUTE_ID}';" 2>/dev/null | head -1)
    [[ -z "$row" ]] && { fail "ROUTE_ID=$ROUTE_ID not found"; return 1; }
    ROUTE_ID=$(echo "$row" | cut -d'|' -f1)
    HOSTNAME=$(echo "$row" | cut -d'|' -f2)
    CLIENT_ID=$(echo "$row" | cut -d'|' -f3)
    NAMESPACE=$(echo "$row" | cut -d'|' -f4)
    ok "using pinned route=$ROUTE_ID host=$HOSTNAME ns=${NAMESPACE}"
    return 0
  fi
  local row
  row=$(psql_q "SELECT ir.id, ir.hostname, d.client_id, c.kubernetes_namespace
                FROM ingress_routes ir
                JOIN domains d ON d.id = ir.domain_id
                JOIN clients c ON c.id = d.client_id
                WHERE ir.hostname LIKE '%${HTTPS_TEST_DOMAIN_BASE}'
                  AND ir.status = 'active'
                ORDER BY ir.created_at DESC
                LIMIT 1;" 2>/dev/null | head -1)
  if [[ -n "$row" ]]; then
    ROUTE_ID=$(echo "$row" | cut -d'|' -f1)
    HOSTNAME=$(echo "$row" | cut -d'|' -f2)
    CLIENT_ID=$(echo "$row" | cut -d'|' -f3)
    NAMESPACE=$(echo "$row" | cut -d'|' -f4)
    ok "discovered route=$ROUTE_ID host=$HOSTNAME ns=${NAMESPACE}"
    return 0
  fi
  prereq_provision_tenant
}

prereq_provision_tenant() {
  log "── prereq: provisioning throwaway tenant ──"
  local plan_id region_id
  plan_id=$(api GET "/plans" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((p['id'] for p in d['data'] if p['name']=='Starter'),''))" 2>/dev/null)
  region_id=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'])" 2>/dev/null)
  [[ -n "$plan_id" && -n "$region_id" ]] || { fail "could not resolve plan/region"; return 1; }

  local stamp; stamp=$(date +%s)
  local company="oauth2-e2e-$stamp"
  local resp
  resp=$(api POST "/clients" "{\"company_name\":\"$company\",\"company_email\":\"oauth2e2e-$stamp@phoenix-host.net\",\"plan_id\":\"$plan_id\",\"region_id\":\"$region_id\",\"storage_tier\":\"local\"}")
  CLIENT_ID=$(echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$CLIENT_ID" ]] || { fail "client create failed: $resp"; return 1; }
  PROVISIONED_CID="$CLIENT_ID"
  ok "client created cid=${CLIENT_ID:0:8}…"

  local i=0
  while (( i < 90 )); do
    NAMESPACE=$(ssh_run "kubectl get ns -l client=$CLIENT_ID -o jsonpath='{.items[0].metadata.name}' 2>/dev/null" 2>/dev/null)
    [[ -n "$NAMESPACE" ]] && break
    sleep 4; i=$((i+4))
  done
  [[ -n "$NAMESPACE" ]] || { fail "namespace not provisioned in 90s"; return 1; }
  ok "namespace=$NAMESPACE"

  local depl_name="oauth2e2e${stamp}"
  local depl_resp
  depl_resp=$(api POST "/clients/$CLIENT_ID/deployments" \
    "{\"catalog_entry_id\":\"$CATALOG_NGINX_PHP\",\"name\":\"$depl_name\",\"replica_count\":1}")
  local depl_id
  depl_id=$(echo "$depl_resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$depl_id" ]] || { fail "deployment create failed: $depl_resp"; return 1; }
  ok "deployment $depl_name created"

  i=0
  local st=""
  while (( i < 240 )); do
    st=$(api GET "/clients/$CLIENT_ID/deployments/$depl_id" \
      | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('status',''))" 2>/dev/null)
    [[ "$st" == "running" ]] && break
    sleep 6; i=$((i+6))
  done
  [[ "$st" == "running" ]] || { fail "deployment never reached running"; return 1; }
  ok "deployment running"

  HOSTNAME="oauth2e2e${stamp}.${HTTPS_TEST_DOMAIN_BASE}"
  local dom_resp
  dom_resp=$(api POST "/clients/$CLIENT_ID/domains" \
    "{\"domain_name\":\"$HOSTNAME\",\"deployment_id\":\"$depl_id\",\"dns_mode\":\"cname\"}")
  local dom_id
  dom_id=$(echo "$dom_resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))" 2>/dev/null)
  [[ -n "$dom_id" ]] || { fail "domain create failed: $dom_resp"; return 1; }
  ok "domain $HOSTNAME bound to deployment"

  i=0
  while (( i < 30 )); do
    ROUTE_ID=$(psql_q "SELECT id FROM ingress_routes WHERE domain_id='$dom_id' LIMIT 1;" 2>/dev/null | head -1)
    [[ -n "$ROUTE_ID" ]] && break
    sleep 2; i=$((i+2))
  done
  [[ -n "$ROUTE_ID" ]] || { fail "ingress route not auto-created"; return 1; }
  ok "ingress route $ROUTE_ID resolved"
  return 0
}

prereq_clean_state() {
  log "── prereq: clean baseline ──"
  api DELETE "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/auth" >/dev/null 2>&1 || true
  sleep 3
  ok "any prior auth config cleared"
}

cleanup_provisioned_tenant() {
  [[ -z "$PROVISIONED_CID" ]] && return 0
  log "── cleanup: tearing down provisioned tenant ──"
  api DELETE "/clients/$PROVISIONED_CID/ingress-routes/$ROUTE_ID/auth" >/dev/null 2>&1 || true
  api DELETE "/clients/$PROVISIONED_CID" >/dev/null 2>&1 || true
  ok "DELETE /clients/$PROVISIONED_CID issued"
}
trap cleanup_provisioned_tenant EXIT

# ─── scenarios ────────────────────────────────────────────────────

scenario_discovery() {
  local resp
  resp=$(api POST "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/auth/test" \
    "{\"issuerUrl\":\"$OIDC_ISSUER\"}")
  local ok_flag
  ok_flag=$(echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('ok',False))" 2>/dev/null)
  if [[ "$ok_flag" == "True" ]]; then
    local auth_ep
    auth_ep=$(echo "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['authorizationEndpoint'])")
    ok "discovery succeeded — authorization_endpoint=$auth_ep"
    return 0
  fi
  fail "discovery failed: $resp"
  return 1
}

scenario_discovery_bad_issuer() {
  local resp
  resp=$(api POST "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/auth/test" \
    "{\"issuerUrl\":\"https://nonexistent-idp-${RANDOM}.invalid/\"}")
  local ok_flag
  ok_flag=$(echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('ok',False))" 2>/dev/null)
  if [[ "$ok_flag" == "False" ]]; then
    ok "bogus issuer correctly rejected"
    return 0
  fi
  fail "bogus issuer was accepted (wrong)"
  return 1
}

scenario_enable() {
  local payload
  payload=$(cat <<EOF
{
  "enabled": true,
  "issuerUrl": "$OIDC_ISSUER",
  "clientId": "$OIDC_CLIENT_ID",
  "clientSecret": "$OIDC_CLIENT_SECRET",
  "authMethod": "client_secret_basic",
  "responseType": "code",
  "usePkce": true,
  "scopes": "openid profile email",
  "claimRules": [{"claim": "membership", "operator": "contains", "value": "paid"}],
  "passAuthorizationHeader": true,
  "passAccessToken": true,
  "passIdToken": true,
  "passUserHeaders": true,
  "setXauthrequest": true,
  "cookieRefreshSeconds": 3600,
  "cookieExpireSeconds": 86400
}
EOF
)
  local resp
  resp=$(api PATCH "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/auth" "$payload")
  if echo "$resp" | grep -q '"enabled":true'; then
    ok "PATCH /auth returned enabled=true"
  else
    fail "PATCH /auth failed: $resp"
    return 1
  fi
  local row
  row=$(psql_q "SELECT enabled FROM ingress_auth_configs WHERE ingress_route_id='${ROUTE_ID}';" 2>/dev/null)
  [[ "$row" == "t" ]] && ok "ingress_auth_configs.enabled = true in DB" \
    || { fail "DB enabled flag mismatch: $row"; return 1; }
  return 0
}

scenario_proxy_ready() {
  ssh_run "kubectl -n $NAMESPACE rollout status deploy/oauth2-proxy --timeout=120s" >/dev/null 2>&1 \
    && ok "oauth2-proxy Deployment Ready" \
    || { fail "oauth2-proxy not Ready in 120s"; return 1; }
  local ready
  ready=$(ssh_run "kubectl -n $NAMESPACE get pods -l app.kubernetes.io/name=oauth2-proxy -o jsonpath='{.items[0].status.containerStatuses[*].ready}'" 2>/dev/null)
  [[ "$ready" == "true true" ]] && ok "both containers (oauth2-proxy + claim-validator) Ready" \
    || { fail "containers not both Ready: $ready"; return 1; }
  return 0
}

scenario_configmap_shape() {
  local cfg
  cfg=$(ssh_run "kubectl -n $NAMESPACE get cm oauth2-proxy-config -o jsonpath='{.data.oauth2_proxy\\.cfg}'" 2>/dev/null)
  echo "$cfg" | grep -q '^pass_authorization_header=true$' && ok "TOML booleans unquoted" \
    || { fail "boolean still quoted"; return 1; }
  echo "$cfg" | grep -q '^oidc_issuer_url="https://auth.phoenix-host.net"$' && ok "issuer trailing slash stripped" \
    || { fail "issuer URL not normalised"; return 1; }
  echo "$cfg" | grep -q '^code_challenge_method="S256"$' && ok "PKCE S256 active" \
    || { fail "PKCE missing"; return 1; }
  local rules
  rules=$(ssh_run "kubectl -n $NAMESPACE get cm oauth2-proxy-config -o jsonpath='{.data.rules\\.json}'" 2>/dev/null)
  echo "$rules" | grep -q '"membership"' && ok "claim rules serialised into rules.json" \
    || { fail "claim rules missing in ConfigMap"; return 1; }
  return 0
}

scenario_ingress_annotations() {
  local auth_url
  auth_url=$(ssh_run "kubectl -n $NAMESPACE get ing -o jsonpath='{.items[?(@.metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-url)].metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-url}'" 2>/dev/null)
  echo "$auth_url" | grep -q "oauth2-proxy.${NAMESPACE}.svc" \
    && ok "auth-url points at per-client validator" \
    || { fail "auth-url annotation missing/wrong: $auth_url"; return 1; }
  local auth_signin
  auth_signin=$(ssh_run "kubectl -n $NAMESPACE get ing -o jsonpath='{.items[?(@.metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-signin)].metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-signin}'" 2>/dev/null)
  echo "$auth_signin" | grep -q "${HOSTNAME}/oauth2/start" && ok "auth-signin pointed at /oauth2/start" \
    || { fail "auth-signin missing"; return 1; }
  local auth_resp_hdrs
  auth_resp_hdrs=$(ssh_run "kubectl -n $NAMESPACE get ing -o jsonpath='{.items[?(@.metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-response-headers)].metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-response-headers}'" 2>/dev/null)
  echo "$auth_resp_hdrs" | grep -q 'X-Auth-Request-User' && ok "identity-pass-through headers present" \
    || { fail "auth-response-headers missing identity headers"; return 1; }
  return 0
}

scenario_redirect_to_idp() {
  local code
  code=$(curl -sk -o /dev/null -w '%{http_code}' "https://${HOSTNAME}/")
  [[ "$code" == "302" ]] && ok "unauthenticated GET → 302" \
    || { fail "expected 302, got $code"; return 1; }
  local final
  final=$(curl -sk -o /dev/null -w '%{url_effective}' -L --max-redirs 3 "https://${HOSTNAME}/" 2>/dev/null)
  echo "$final" | grep -q "auth.phoenix-host.net" && ok "redirect chain lands at IdP" \
    || fail "redirect chain did not reach IdP: $final"
  return 0
}

scenario_validator_ping() {
  local out
  out=$(ssh_run "kubectl -n $NAMESPACE exec deploy/oauth2-proxy -c claim-validator -- wget -qO- http://127.0.0.1:4181/ping" 2>/dev/null)
  [[ "$out" == "ok" ]] && ok "claim-validator /ping returns ok" \
    || { fail "claim-validator ping failed: $out"; return 1; }
  return 0
}

scenario_rotate_config() {
  local payload='{
    "enabled": true,
    "issuerUrl": "'$OIDC_ISSUER'",
    "clientId": "'$OIDC_CLIENT_ID'",
    "clientSecret": "'$OIDC_CLIENT_SECRET'",
    "authMethod": "client_secret_basic",
    "responseType": "code",
    "usePkce": true,
    "scopes": "openid profile email groups",
    "passAuthorizationHeader": true,
    "passAccessToken": true,
    "passIdToken": true,
    "passUserHeaders": true,
    "setXauthrequest": true,
    "cookieRefreshSeconds": 3600,
    "cookieExpireSeconds": 86400
  }'
  api PATCH "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/auth" "$payload" >/dev/null
  sleep 5
  local cfg_scope
  cfg_scope=$(ssh_run "kubectl -n $NAMESPACE get cm oauth2-proxy-config -o jsonpath='{.data.oauth2_proxy\\.cfg}'" 2>/dev/null | grep '^scope=')
  echo "$cfg_scope" | grep -q 'groups' && ok "ConfigMap re-rendered with new scopes" \
    || { fail "ConfigMap not updated: $cfg_scope"; return 1; }
  local i=0
  while (( i < 30 )); do
    local ready
    ready=$(ssh_run "kubectl -n $NAMESPACE get deploy oauth2-proxy -o jsonpath='{.status.readyReplicas}/{.spec.replicas}'" 2>/dev/null)
    [[ "$ready" == "1/1" ]] && { ok "oauth2-proxy still Ready after rotation"; return 0; }
    sleep 3; i=$((i+3))
  done
  fail "oauth2-proxy not Ready after rotation"
  return 1
}

scenario_acme_challenge_unblocked() {
  # cert-manager provisions a sibling Ingress carrying path=/.well-known
  # /acme-challenge/<token> with NO auth-* annotations. NGINX merges
  # that Ingress with the gated tenant Ingress into per-path location
  # blocks — the challenge path must remain reachable so LE can renew
  # certificates while OAuth2 is enabled.
  #
  # Strategy: simulate the HTTP-01 solver by creating a one-shot Ingress
  # in the client namespace with a fake challenge path, send an HTTP
  # GET against the host, and assert the response is NOT a 302 to the
  # IdP. Cleanup deletes the test Ingress whether the assertion passes
  # or fails.
  local probe_token
  probe_token="acme-probe-$(date +%s)"
  local manifest
  manifest=$(cat <<YAML
apiVersion: v1
kind: Service
metadata:
  name: acme-probe-stub
  namespace: ${NAMESPACE}
spec:
  selector:
    app.kubernetes.io/name: oauth2-proxy
  ports:
    - port: 8089
      targetPort: 4180
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: acme-probe
  namespace: ${NAMESPACE}
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
spec:
  ingressClassName: nginx
  rules:
    - host: ${HOSTNAME}
      http:
        paths:
          - path: /.well-known/acme-challenge/${probe_token}
            pathType: Exact
            backend:
              service:
                name: acme-probe-stub
                port:
                  number: 8089
YAML
)
  local apply_out
  apply_out=$(ssh_run "cat <<'EOF' | kubectl apply -f -
${manifest}
EOF" 2>&1)
  if ! echo "$apply_out" | grep -qiE 'created|configured|unchanged'; then
    fail "could not apply solver-stub Ingress: $apply_out"
    return 1
  fi

  # Allow nginx-ingress to reload (~3-5s).
  sleep 6

  local status
  status=$(curl -sk -o /dev/null -w '%{http_code}' \
    "http://${HOSTNAME}/.well-known/acme-challenge/${probe_token}")
  # The stub backend is the oauth2-proxy Service, so we expect 4xx
  # (oauth2-proxy doesn't know the path) — but critically NOT a 302
  # redirect to the IdP, which would prove the gate is intercepting.
  if [[ "$status" == "302" ]]; then
    fail "acme-challenge path was gated (got 302 to IdP) — LE renewal would fail"
    ssh_run "kubectl -n ${NAMESPACE} delete ingress acme-probe service acme-probe-stub --ignore-not-found" >/dev/null 2>&1 || true
    return 1
  fi
  ok "acme-challenge path bypasses auth gate (HTTP ${status}, not 302)"

  # Ensure NGINX picked our solver Ingress, not the tenant Ingress.
  # An auth-required tenant location would set an X-Auth-Request-Redirect
  # response header — its absence here proves location-level isolation.
  local resp_headers
  resp_headers=$(curl -sk -D - -o /dev/null \
    "http://${HOSTNAME}/.well-known/acme-challenge/${probe_token}" 2>/dev/null)
  if echo "$resp_headers" | grep -qi '^x-auth-request-redirect:'; then
    fail "auth-request response header leaked into acme-challenge location"
    ssh_run "kubectl -n ${NAMESPACE} delete ingress acme-probe service acme-probe-stub --ignore-not-found" >/dev/null 2>&1 || true
    return 1
  fi
  ok "no auth_request leak into /.well-known/acme-challenge/* location"

  # Cleanup.
  ssh_run "kubectl -n ${NAMESPACE} delete ingress acme-probe service acme-probe-stub --ignore-not-found" >/dev/null 2>&1 || true
  return 0
}

scenario_disable_teardown() {
  api DELETE "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/auth" >/dev/null
  ok "DELETE /auth returned"
  sleep 5
  local exists
  exists=$(ssh_run "kubectl -n $NAMESPACE get deploy oauth2-proxy --ignore-not-found -o name 2>&1")
  if [[ -z "$exists" ]]; then
    ok "oauth2-proxy Deployment torn down"
  else
    fail "oauth2-proxy still present after disable: $exists"
    return 1
  fi
  local auth_url
  auth_url=$(ssh_run "kubectl -n $NAMESPACE get ing -o jsonpath='{.items[?(@.metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-url)].metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-url}'" 2>/dev/null)
  [[ -z "$auth_url" ]] && ok "auth-url annotation removed from Ingress" \
    || { fail "auth-url annotation still present after disable: $auth_url"; return 1; }
  return 0
}

# ─── main ──────────────────────────────────────────────────────────

log "Logging in as ${ADMIN_EMAIL}…"
TOKEN=$(login_token)
[[ -z "$TOKEN" ]] && { echo "Login failed — admin password mismatch?" >&2; exit 2; }
ok "got bearer token (${#TOKEN} chars)"

prereq_resolve_target || exit 1
prereq_clean_state

run_scenario discovery
run_scenario discovery_bad_issuer
run_scenario enable
run_scenario proxy_ready
run_scenario configmap_shape
run_scenario ingress_annotations
run_scenario redirect_to_idp
run_scenario validator_ping
run_scenario rotate_config
run_scenario acme_challenge_unblocked
run_scenario disable_teardown

echo
echo "═══════════════════════════════════════════"
echo "  PASSED: $PASSED   FAILED: $FAILED"
if (( FAILED > 0 )); then
  echo
  echo "  Failures:"
  for f in "${FAILURES[@]}"; do echo "    - $f"; done
  echo "═══════════════════════════════════════════"
  exit 1
fi
echo "═══════════════════════════════════════════"
exit 0
