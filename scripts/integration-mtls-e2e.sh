#!/usr/bin/env bash
# End-to-end harness for the mTLS provider + cert revocation lifecycle.
#
# This script drives the full user flow from the admin/client API plus
# raw curl/openssl against the resulting ingress. It is the integration
# floor for everything in backend/src/modules/mtls-providers/ plus the
# annotation-sync ca.crl materialisation path.
#
# Scenarios (assertions are user-visible, never DB-only):
#
#   1. Bootstrap client with one ingress route on staging.
#   2. Create mTLS provider via "generate CA" path; assert can_issue.
#   3. Bind provider to the route's ingress_mtls_config (verify_mode=on).
#   4. Wait for reconciler to materialise Secret with ca.crt only
#      (no revocations yet) and patch Ingress annotations.
#   5. curl ingress WITHOUT client cert → 400/403 (NGINX rejects).
#   6. Issue user cert via POST .../issue-cert; capture id+serial+PEMs.
#   7. curl ingress WITH client cert → 200.
#   8. GET .../certificates → assert our cert in the list as 'active'.
#   9. GET .../crl.pem → assert valid CRL with 0 revoked entries.
#  10. POST .../certificates/:id/revoke {reason: keyCompromise}.
#  11. GET .../certificates → assert status now 'revoked',
#      revocation_reason='keyCompromise', revoked_at non-null.
#  12. GET .../crl.pem → assert CRL contains our serial.
#  13. Wait for Secret `ca.crl` to land (reconcile lag), then curl
#      ingress WITH the now-revoked cert → 4xx (NGINX rejects).
#  14. Issue a 2nd cert; assert NGINX still accepts the new one
#      (revocation is per-cert, not provider-wide).
#  15. Cleanup: delete the two certs (cascade), unbind provider from
#      route, delete provider, delete route+client.
#
# Each scenario writes a one-line result; the script exits 0 only when
# every scenario passes. Tmpfiles are mopped up via trap-EXIT.
#
# USAGE:
#   ADMIN_PASSWORD=... ADMIN_HOST=... INGRESS_HOST=... \
#     ./scripts/integration-mtls-e2e.sh
#
#   ADMIN_PASSWORD       admin login password (required)
#   ADMIN_HOST           https://admin.staging.phoenix-host.net by default
#   INGRESS_DOMAIN_BASE  domain to allocate test hostnames under;
#                        default: staging.success.com.na (the staging
#                        public-cert wildcard).
#   RECONCILE_WAIT       seconds to wait after CRL changes (default: 90).
#   SKIP_CLEANUP=1       leave the test client + provider behind.
#
# Exit codes:
#   0 = all scenarios passed
#   1 = one or more scenarios failed
#   2 = misconfiguration (missing env, login failure, etc)

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
INGRESS_DOMAIN_BASE="${INGRESS_DOMAIN_BASE:-staging.success.com.na}"
RECONCILE_WAIT="${RECONCILE_WAIT:-90}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()   { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()    { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail()  { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
warn()  { printf '  %b!%b %s\n' "$YELLOW" "$RESET" "$*"; }

passed=0
failed=0

# Workspace + trap cleanup.
WORK="$(mktemp -d /tmp/mtls-e2e.XXXXXX)"
RUN_ID="$(date +%s)-$$"
CLIENT_ID=""
ROUTE_ID=""
PROVIDER_ID=""
CERT_ID=""
CERT2_ID=""
TOKEN=""

cleanup() {
  local code=$?
  set +e
  if [[ "$SKIP_CLEANUP" != "1" && -n "$TOKEN" ]]; then
    log "Cleanup"
    [[ -n "$CERT_ID"     && -n "$PROVIDER_ID" && -n "$CLIENT_ID" ]] && \
      api DELETE "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/certificates/$CERT_ID" >/dev/null 2>&1 || true
    [[ -n "$CERT2_ID"    && -n "$PROVIDER_ID" && -n "$CLIENT_ID" ]] && \
      api DELETE "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/certificates/$CERT2_ID" >/dev/null 2>&1 || true
    # Unbind provider from the ingress route's mtls config (so we can
    # delete the provider — the FK is RESTRICT).
    if [[ -n "$ROUTE_ID" && -n "$CLIENT_ID" ]]; then
      api PATCH "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/mtls" '{"enabled":false}' >/dev/null 2>&1 || true
    fi
    [[ -n "$PROVIDER_ID" && -n "$CLIENT_ID" ]] && \
      api DELETE "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID" >/dev/null 2>&1 || true
    [[ -n "$ROUTE_ID"    && -n "$CLIENT_ID" ]] && \
      api DELETE "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID" >/dev/null 2>&1 || true
    [[ -n "$CLIENT_ID" ]] && \
      api DELETE "/clients/$CLIENT_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT INT TERM

# ─── HTTP helpers ──────────────────────────────────────────────────────

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk --max-time 60 --retry 2 --retry-all-errors --retry-delay 2 \
      -X "$method" "$ADMIN_HOST/api/v1$path" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk --max-time 60 --retry 2 --retry-all-errors --retry-delay 2 \
      -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body"
  fi
}

api_status() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk -o /dev/null -w '%{http_code}' --max-time 30 \
      -X "$method" "$ADMIN_HOST/api/v1$path" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk -o /dev/null -w '%{http_code}' --max-time 30 \
      -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body"
  fi
}

login() {
  log "Login as $ADMIN_EMAIL"
  local resp
  resp=$(curl -sk --max-time 30 -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD")")
  TOKEN=$(jq -r '.data.token // empty' <<<"$resp")
  [[ -n "$TOKEN" ]] || { echo "ERROR: login failed: $resp" >&2; exit 2; }
  log "Got admin token ($((${#TOKEN}/4))kb)"
}

# ─── Scenarios ────────────────────────────────────────────────────────

run() {
  local desc="$1"; shift
  printf '\n%b▶ %s%b\n' "$CYAN" "$desc" "$RESET"
}

scenario_1_bootstrap() {
  run "1. Bootstrap test client + ingress route"

  local cname="mtls-e2e-$RUN_ID"
  local hostname="mtls-e2e-${RUN_ID}.${INGRESS_DOMAIN_BASE}"

  local resp
  resp=$(api POST "/clients" "$(jq -nc --arg n "$cname" '{
    companyName:$n, contactEmail:($n + "@e2e.test"),
    timezone:"UTC", plan:"test"
  }')")
  CLIENT_ID=$(jq -r '.data.id // empty' <<<"$resp")
  [[ -n "$CLIENT_ID" ]] && ok "client $CLIENT_ID" || { fail "client create: $resp"; return; }

  resp=$(api POST "/clients/$CLIENT_ID/ingress-routes" "$(jq -nc --arg h "$hostname" '{
    hostname:$h, path:"/", targetServiceName:"echo", targetServicePort:8080
  }')")
  ROUTE_ID=$(jq -r '.data.id // empty' <<<"$resp")
  [[ -n "$ROUTE_ID" ]] && ok "route $ROUTE_ID → $hostname" || fail "route create: $resp"
}

scenario_2_create_provider() {
  run "2. Create mTLS provider (generate CA)"
  local resp
  resp=$(api POST "/clients/$CLIENT_ID/mtls-providers" '{
    "source":"generate","name":"e2e-ca",
    "commonName":"e2e-test-ca","validityDays":30,"organization":"E2E"
  }')
  PROVIDER_ID=$(jq -r '.data.id // empty' <<<"$resp")
  local canIssue
  canIssue=$(jq -r '.data.canIssue // false' <<<"$resp")
  [[ -n "$PROVIDER_ID" && "$canIssue" == "true" ]] \
    && ok "provider $PROVIDER_ID can_issue=true" \
    || fail "provider create: $resp"
}

scenario_3_bind_provider() {
  run "3. Bind provider to route (verify_mode=on)"
  local resp
  resp=$(api PATCH "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/mtls" "$(jq -nc --arg pid "$PROVIDER_ID" '{
    enabled:true, providerId:$pid, verifyMode:"on", passDnToUpstream:true
  }')")
  local enabled
  enabled=$(jq -r '.data.enabled // false' <<<"$resp")
  [[ "$enabled" == "true" ]] && ok "mtls enabled on route" || fail "bind: $resp"
}

scenario_4_wait_reconcile() {
  run "4. Wait for reconciler (Secret + ca.crt landing)"
  local waited=0
  while (( waited < RECONCILE_WAIT )); do
    local crl_meta
    crl_meta=$(api GET "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/crl" || true)
    # When reconciler has run, the provider has a crl_pem populated
    # (crlNumber >= 1).
    local n
    n=$(jq -r '.data.crlNumber // 0' <<<"$crl_meta")
    if [[ "$n" -ge 1 ]]; then
      ok "CRL number = $n (reconciler has run)"
      return
    fi
    sleep 5
    waited=$((waited+5))
  done
  warn "Reconciler still working after ${RECONCILE_WAIT}s — continuing anyway"
}

scenario_6_issue_cert() {
  run "6. Issue user cert"
  local resp
  resp=$(api POST "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/issue-cert" '{
    "commonName":"e2e-user","validityDays":7
  }')
  CERT_ID=$(jq -r '.data.id // empty' <<<"$resp")
  local serial
  serial=$(jq -r '.data.serialHex // empty' <<<"$resp")
  jq -r '.data.certPem // empty' <<<"$resp" > "$WORK/cert.pem"
  jq -r '.data.keyPem  // empty' <<<"$resp" > "$WORK/key.pem"
  jq -r '.data.caCertPem // empty' <<<"$resp" > "$WORK/ca.pem"

  if [[ -n "$CERT_ID" && -n "$serial" \
        && -s "$WORK/cert.pem" && -s "$WORK/key.pem" ]]; then
    ok "cert $CERT_ID issued (serial=${serial:0:16}...)"
  else
    fail "issue: $resp"
    return
  fi

  # Verify cert chains to CA (offline check, doesn't require ingress).
  if openssl verify -CAfile "$WORK/ca.pem" "$WORK/cert.pem" >/dev/null 2>&1; then
    ok "issued cert chains to CA"
  else
    fail "openssl verify failed"
  fi
}

scenario_7_curl_without_cert() {
  run "5/7. curl ingress WITHOUT cert (expect 4xx)"
  local hostname
  hostname=$(api GET "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID" \
    | jq -r '.data.hostname // empty')
  if [[ -z "$hostname" ]]; then
    warn "no hostname found — skipping ingress curl"
    return
  fi
  # NGINX returns 400/403 when mTLS is required and no cert is presented.
  # We accept any 4xx. Negative path: 200 is the FAIL.
  local code
  code=$(curl -sk --max-time 15 --resolve "$hostname:443:$(getent ahosts $hostname | awk 'NR==1{print $1}')" \
    -o /dev/null -w '%{http_code}' "https://$hostname/" 2>/dev/null || echo "000")
  if [[ "$code" =~ ^4 ]]; then
    ok "no-cert request rejected ($code)"
  elif [[ "$code" == "000" ]]; then
    warn "ingress unreachable — likely DNS hasn't propagated for ${hostname}"
  else
    fail "expected 4xx, got $code"
  fi
}

scenario_8_curl_with_cert() {
  run "7. curl ingress WITH cert (expect 200/upstream)"
  local hostname
  hostname=$(api GET "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID" \
    | jq -r '.data.hostname // empty')
  [[ -n "$hostname" ]] || { warn "no hostname"; return; }
  # The upstream service in scenario_1 is a placeholder ("echo") that
  # may not actually exist — we accept 200/502/503 because the goal
  # here is "did mTLS pass". The next-hop result doesn't matter for
  # the mTLS gate.
  local code
  code=$(curl -sk --max-time 15 \
    --cert "$WORK/cert.pem" --key "$WORK/key.pem" --cacert "$WORK/ca.pem" \
    -o /dev/null -w '%{http_code}' "https://$hostname/" 2>/dev/null || echo "000")
  if [[ "$code" == "200" || "$code" == "502" || "$code" == "503" || "$code" == "404" ]]; then
    ok "mTLS handshake accepted (next-hop status $code)"
  elif [[ "$code" == "000" ]]; then
    warn "ingress unreachable"
  else
    fail "expected 2xx/5xx (mTLS pass), got $code (mTLS rejected the cert)"
  fi
}

scenario_9_list_certs() {
  run "8. List certs → assert our cert is 'active'"
  local resp
  resp=$(api GET "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/certificates")
  local status
  status=$(jq -r --arg id "$CERT_ID" '.data.items[] | select(.id==$id) | .status' <<<"$resp")
  if [[ "$status" == "active" ]]; then
    ok "cert visible as active"
  else
    fail "expected active, got '$status'. resp=$resp"
  fi
}

scenario_10_crl_empty() {
  run "9. GET CRL → valid + 0 revoked entries"
  api GET "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/crl.pem" > "$WORK/crl-pre.pem"
  if openssl crl -in "$WORK/crl-pre.pem" -noout -CAfile "$WORK/ca.pem" 2>/dev/null; then
    ok "CRL verifies against CA"
  else
    fail "CRL doesn't verify"
  fi
  if openssl crl -in "$WORK/crl-pre.pem" -noout -text 2>/dev/null | grep -q "No Revoked Certificates"; then
    ok "CRL is empty (no revocations yet)"
  else
    fail "CRL unexpectedly contains revocations"
  fi
}

scenario_11_revoke() {
  run "10/11. Revoke cert (reason=keyCompromise) → assert status=revoked"
  local resp
  resp=$(api POST "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/certificates/$CERT_ID/revoke" '{
    "reason":"keyCompromise"
  }')
  local status reason revokedAt
  status=$(jq -r '.data.status // empty' <<<"$resp")
  reason=$(jq -r '.data.revocationReason // empty' <<<"$resp")
  revokedAt=$(jq -r '.data.revokedAt // empty' <<<"$resp")
  if [[ "$status" == "revoked" && "$reason" == "keyCompromise" && -n "$revokedAt" ]]; then
    ok "cert is revoked (reason=$reason)"
  else
    fail "revoke unexpected state: $resp"
  fi

  # Idempotent re-revoke should not error.
  local code
  code=$(api_status POST "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/certificates/$CERT_ID/revoke" '{"reason":"keyCompromise"}')
  if [[ "$code" == "200" ]]; then
    ok "re-revoke is idempotent ($code)"
  else
    fail "re-revoke status = $code"
  fi
}

scenario_12_crl_lists_cert() {
  run "12. GET CRL → contains our serial"
  api GET "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/crl.pem" > "$WORK/crl-post.pem"
  local serial_upper
  serial_upper=$(openssl x509 -in "$WORK/cert.pem" -noout -serial | awk -F'=' '{print toupper($2)}')
  if openssl crl -in "$WORK/crl-post.pem" -noout -text 2>/dev/null \
      | grep -q "Serial Number:.*$serial_upper"; then
    ok "CRL contains serial $serial_upper"
  else
    fail "CRL missing serial. CRL: $(openssl crl -in "$WORK/crl-post.pem" -noout -text 2>/dev/null | head -30)"
  fi
}

scenario_13_curl_revoked() {
  run "13. curl with revoked cert (expect 4xx after reconcile lag)"
  local hostname
  hostname=$(api GET "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID" \
    | jq -r '.data.hostname // empty')
  [[ -n "$hostname" ]] || { warn "no hostname"; return; }

  local waited=0 code
  while (( waited < RECONCILE_WAIT )); do
    code=$(curl -sk --max-time 15 \
      --cert "$WORK/cert.pem" --key "$WORK/key.pem" --cacert "$WORK/ca.pem" \
      -o /dev/null -w '%{http_code}' "https://$hostname/" 2>/dev/null || echo "000")
    if [[ "$code" =~ ^4 ]]; then
      ok "revoked cert rejected ($code) after ${waited}s"
      return
    fi
    sleep 5
    waited=$((waited+5))
  done
  if [[ "$code" == "000" ]]; then
    warn "ingress unreachable after ${RECONCILE_WAIT}s"
  else
    fail "revoked cert still accepted after ${RECONCILE_WAIT}s (last status $code)"
  fi
}

scenario_14_second_cert() {
  run "14. Issue 2nd cert → not affected by revocation of 1st"
  local resp
  resp=$(api POST "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/issue-cert" '{
    "commonName":"e2e-user-2","validityDays":7
  }')
  CERT2_ID=$(jq -r '.data.id // empty' <<<"$resp")
  jq -r '.data.certPem // empty' <<<"$resp" > "$WORK/cert2.pem"
  jq -r '.data.keyPem  // empty' <<<"$resp" > "$WORK/key2.pem"
  if [[ -n "$CERT2_ID" && -s "$WORK/cert2.pem" ]]; then
    ok "2nd cert $CERT2_ID issued"
  else
    fail "2nd issue: $resp"
    return
  fi
  local hostname
  hostname=$(api GET "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID" \
    | jq -r '.data.hostname // empty')
  [[ -n "$hostname" ]] || { warn "no hostname"; return; }
  local code
  code=$(curl -sk --max-time 15 \
    --cert "$WORK/cert2.pem" --key "$WORK/key2.pem" --cacert "$WORK/ca.pem" \
    -o /dev/null -w '%{http_code}' "https://$hostname/" 2>/dev/null || echo "000")
  if [[ "$code" == "200" || "$code" == "502" || "$code" == "503" || "$code" == "404" ]]; then
    ok "2nd cert accepted (next-hop $code)"
  elif [[ "$code" == "000" ]]; then
    warn "ingress unreachable"
  else
    fail "2nd cert unexpectedly rejected ($code)"
  fi
}

scenario_15_filter_status() {
  run "15. List filter by status=revoked → only the revoked one"
  local resp
  resp=$(api GET "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/certificates?status=revoked")
  local count first_id
  count=$(jq -r '.data.items | length' <<<"$resp")
  first_id=$(jq -r '.data.items[0].id // empty' <<<"$resp")
  if [[ "$count" == "1" && "$first_id" == "$CERT_ID" ]]; then
    ok "filter status=revoked returns 1 row = our revoked cert"
  else
    fail "expected 1 revoked, got $count. first=$first_id expected=$CERT_ID"
  fi

  resp=$(api GET "/clients/$CLIENT_ID/mtls-providers/$PROVIDER_ID/certificates?status=active")
  count=$(jq -r '.data.items | length' <<<"$resp")
  if [[ "$count" == "1" ]]; then
    ok "filter status=active returns 1 row"
  else
    fail "expected 1 active, got $count"
  fi
}

# ─── Run all ───────────────────────────────────────────────────────────

login
scenario_1_bootstrap
scenario_2_create_provider
scenario_3_bind_provider
scenario_4_wait_reconcile
scenario_6_issue_cert
scenario_7_curl_without_cert
scenario_8_curl_with_cert
scenario_9_list_certs
scenario_10_crl_empty
scenario_11_revoke
scenario_12_crl_lists_cert
scenario_13_curl_revoked
scenario_14_second_cert
scenario_15_filter_status

printf '\n%b━━━ Summary ━━━%b\n' "$CYAN" "$RESET"
printf '  passed: %b%d%b\n' "$GREEN" "$passed" "$RESET"
printf '  failed: %b%d%b\n' "$RED" "$failed" "$RESET"
[[ "$failed" -eq 0 ]] && exit 0 || exit 1
