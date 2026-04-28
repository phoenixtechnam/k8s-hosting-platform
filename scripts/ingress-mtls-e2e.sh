#!/usr/bin/env bash
# Per-ingress mTLS integration test harness.
#
# Mirrors scripts/ingress-auth-e2e.sh: scenario-based, ok/fail counters,
# exit code from FAILED, optional scenario filter. Auto-provisions a
# throwaway tenant + ingress route when ROUTE_ID isn't set.
#
# Required env (or use defaults):
#   ADMIN_PASSWORD    — staff password (mandatory)
#   ADMIN_HOST        — admin panel API base URL
#   CONTROL_HOST      — staging1 SSH host for in-cluster checks
#   SSH_KEY           — path to private key for CONTROL_HOST
#   HTTPS_TEST_DOMAIN_BASE — wildcard apex used to find tenant ingress
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

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

SCENARIO="${1:-all}"
PASSED=0
FAILED=0
FAILURES=()
ROUTE_ID="${ROUTE_ID:-}"
HOSTNAME=""
CLIENT_ID=""
NAMESPACE=""
TMP_CA_DIR=""

log() { echo -e "\033[36m[$(date +%H:%M:%S)]\033[0m $*"; }
ok()  { echo -e "  \033[32m✓\033[0m $*"; PASSED=$((PASSED+1)); }
fail(){ echo -e "  \033[31m✗\033[0m $*"; FAILURES+=("$*"); FAILED=$((FAILED+1)); }

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
    curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" -d "$body"
  else
    curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN"
  fi
}

ssh_run() {
  ssh -i "$SSH_KEY" $SSH_OPTS "root@$CONTROL_HOST" "$@" 2>&1
}

run_scenario() {
  local name="$1"
  if [[ "$SCENARIO" != "all" && "$SCENARIO" != "$name" ]]; then return 0; fi
  log "── scenario: $name ──"
  if "scenario_$name"; then
    log "✓ $name done"
  else
    log "✗ $name FAILED"
  fi
}

prereq_resolve_target() {
  log "── prereq: discover target ingress ──"
  if [[ -n "$ROUTE_ID" ]]; then
    ok "ROUTE_ID provided: $ROUTE_ID"
  else
    local rows
    rows=$(api GET '/ingress-routes?limit=1' | python3 -c "
import json, sys
data = json.load(sys.stdin).get('data', [])
for r in data:
    if r.get('hostname','').endswith('.${HTTPS_TEST_DOMAIN_BASE}'):
        print(f\"{r['id']}|{r['hostname']}\")
        break
" 2>/dev/null)
    if [[ -z "$rows" ]]; then
      fail "no ingress route under .${HTTPS_TEST_DOMAIN_BASE} found — run ingress-auth-e2e.sh first to provision one"
      return 1
    fi
    ROUTE_ID="${rows%%|*}"
    HOSTNAME="${rows#*|}"
  fi
  # Resolve hostname + clientId via the API
  local route
  route=$(api GET "/ingress-routes/$ROUTE_ID")
  HOSTNAME=$(echo "$route" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['hostname'])" 2>/dev/null)
  local domain_id
  domain_id=$(echo "$route" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['domainId'])" 2>/dev/null)
  CLIENT_ID=$(api GET "/domains/$domain_id" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['clientId'])" 2>/dev/null)
  NAMESPACE="client-$(echo "$CLIENT_ID" | tr -d '-' | cut -c1-15)"
  # Resolve real namespace via API
  NAMESPACE=$(api GET "/clients/$CLIENT_ID" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['kubernetesNamespace'])" 2>/dev/null)
  ok "discovered route=$ROUTE_ID host=$HOSTNAME ns=$NAMESPACE"
}

prereq_clean_state() {
  log "── prereq: clean baseline ──"
  api DELETE "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/mtls" >/dev/null
  ok "any prior mTLS config cleared"
}

prereq_generate_ca() {
  TMP_CA_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_CA_DIR"' EXIT
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$TMP_CA_DIR/ca-key.pem" \
    -out "$TMP_CA_DIR/ca.pem" \
    -days 30 -subj '/CN=mtls-e2e-ca/O=E2E Test' >/dev/null 2>&1
}

scenario_invalid_ca_rejected() {
  local payload='{"enabled":false,"caCertPem":"not a valid pem"}'
  local code
  code=$(api_status PATCH "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/mtls" "$payload")
  [[ "$code" == "422" ]] && ok "invalid CA returns 422" \
    || { fail "invalid CA expected 422, got $code"; return 1; }
  return 0
}

scenario_enable_without_ca_rejected() {
  local code
  code=$(api_status PATCH "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/mtls" '{"enabled":true}')
  [[ "$code" == "422" ]] && ok "enable-without-CA returns 422" \
    || { fail "enable-without-CA expected 422, got $code"; return 1; }
  return 0
}

scenario_upload_valid_ca() {
  prereq_generate_ca
  local pem
  pem=$(python3 -c "import json,sys;print(json.dumps(sys.stdin.read()))" < "$TMP_CA_DIR/ca.pem")
  local payload="{\"enabled\":false,\"caCertPem\":${pem}}"
  local resp
  resp=$(api PATCH "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/mtls" "$payload")
  echo "$resp" | grep -q '"caCertSet":true' && ok "CA uploaded, caCertSet=true" \
    || { fail "CA upload didn't flip caCertSet: $resp"; return 1; }
  echo "$resp" | grep -q '"caCertSubject"' && ok "Subject DN extracted" \
    || { fail "no Subject DN in response: $resp"; return 1; }
  echo "$resp" | grep -q '"caCertFingerprint":"[a-f0-9]\{64\}"' && ok "fingerprint computed" \
    || { fail "no fingerprint in response"; return 1; }
  return 0
}

scenario_enable_renders_annotations() {
  local code
  code=$(api_status PATCH "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/mtls" '{"enabled":true}')
  [[ "$code" == "200" ]] && ok "enable returned 200" \
    || { fail "enable expected 200, got $code"; return 1; }
  sleep 4
  local secret_count
  secret_count=$(ssh_run "kubectl -n $NAMESPACE get secrets -l hosting-platform/purpose=mtls-ca --no-headers 2>/dev/null | wc -l" | tr -d '\r' | tail -1)
  [[ "$secret_count" -ge 1 ]] && ok "CA Secret materialised ($secret_count)" \
    || { fail "no CA Secret in $NAMESPACE"; return 1; }
  local auth_tls
  auth_tls=$(ssh_run "kubectl -n $NAMESPACE get ing -o jsonpath='{.items[?(@.metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-tls-secret)].metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-tls-secret}'" 2>/dev/null)
  [[ -n "$auth_tls" ]] && ok "auth-tls-secret annotation rendered ($auth_tls)" \
    || { fail "no auth-tls-secret annotation found"; return 1; }
  local verify_mode
  verify_mode=$(ssh_run "kubectl -n $NAMESPACE get ing -o jsonpath='{.items[?(@.metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-tls-verify-client)].metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-tls-verify-client}'" 2>/dev/null)
  [[ "$verify_mode" == "on" ]] && ok "verify-client=on rendered" \
    || { fail "verify-client annotation wrong: $verify_mode"; return 1; }
  return 0
}

scenario_acme_path_still_open() {
  local probe_token
  probe_token="acme-mtls-$(date +%s)"
  local manifest
  manifest=$(cat <<YAML
apiVersion: v1
kind: Service
metadata:
  name: acme-probe-mtls-stub
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
  name: acme-probe-mtls
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
                name: acme-probe-mtls-stub
                port:
                  number: 8089
YAML
)
  ssh_run "cat <<'EOF' | kubectl apply -f -
${manifest}
EOF" >/dev/null 2>&1
  sleep 5
  local status
  status=$(curl -sk -o /dev/null -w '%{http_code}' \
    "http://${HOSTNAME}/.well-known/acme-challenge/${probe_token}")
  ssh_run "kubectl -n ${NAMESPACE} delete ingress acme-probe-mtls service acme-probe-mtls-stub --ignore-not-found" >/dev/null 2>&1 || true
  if [[ "$status" == "400" ]] || [[ "$status" == "401" ]] || [[ "$status" == "403" ]]; then
    fail "acme-challenge path was gated by mTLS (got $status) — LE renewal would fail"
    return 1
  fi
  ok "acme-challenge path bypasses mTLS gate (HTTP $status, not 4xx)"
  return 0
}

scenario_disable_clears_secret() {
  local code
  code=$(api_status DELETE "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/mtls")
  [[ "$code" == "200" ]] && ok "disable returned 200" \
    || { fail "disable expected 200, got $code"; return 1; }
  sleep 4
  local secret_count
  secret_count=$(ssh_run "kubectl -n $NAMESPACE get secrets -l hosting-platform/purpose=mtls-ca --no-headers 2>/dev/null | wc -l" | tr -d '\r' | tail -1)
  [[ "$secret_count" == "0" ]] && ok "CA Secret torn down" \
    || { fail "$secret_count CA Secret(s) still present after disable"; return 1; }
  local auth_tls
  auth_tls=$(ssh_run "kubectl -n $NAMESPACE get ing -o jsonpath='{.items[?(@.metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-tls-secret)].metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-tls-secret}'" 2>/dev/null)
  [[ -z "$auth_tls" ]] && ok "auth-tls-secret annotation removed" \
    || { fail "auth-tls-secret still present after disable: $auth_tls"; return 1; }
  return 0
}

# ─── main ──────────────────────────────────────────────────────────

log "Logging in as ${ADMIN_EMAIL}…"
TOKEN=$(login_token)
[[ -z "$TOKEN" ]] && { echo "Login failed — admin password mismatch?" >&2; exit 2; }
ok "got bearer token (${#TOKEN} chars)"

prereq_resolve_target || exit 1
prereq_clean_state

run_scenario invalid_ca_rejected
run_scenario enable_without_ca_rejected
run_scenario upload_valid_ca
run_scenario enable_renders_annotations
run_scenario acme_path_still_open
run_scenario disable_clears_secret

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
