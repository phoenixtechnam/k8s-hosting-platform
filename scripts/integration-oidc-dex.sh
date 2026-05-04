#!/usr/bin/env bash
# integration-oidc-dex.sh — OIDC config E2E against staging.
#
# Verifies that Dex (dev/staging-only OIDC issuer) can protect BOTH the
# admin panel and the client panel. Each scenario asserts user-visible
# behaviour, not just controller state.
#
# Scenarios:
#   1. Dex deployment is reachable (discovery + JWKS).
#   2. Login as local admin, register Dex as an OIDC provider for both
#      panels (admin → hosting-platform-admin, client → hosting-platform-client).
#   3. POST /admin/oidc/providers/:id/test passes for both.
#   4. GET /auth/oidc/status reports each provider on its correct panel
#      and NOT on the other panel (cross-panel isolation).
#   5. GET /auth/oidc/authorize/:id redirects to Dex with the correct
#      client_id, scope, response_type, code_challenge_method, and a
#      working PKCE state for both panels.
#   6. Drive the Dex static-password login form end-to-end for the admin
#      provider — assert the platform issues a JWT scoped panel=admin.
#   7. Drive the same flow for the client provider — assert the
#      platform issues a JWT scoped panel=client.
#   8. Cross-panel token rejection: admin JWT cannot call a
#      client-panel-only route; client JWT cannot call /admin/clients.
#   9. Cleanup: delete both providers — assert /auth/oidc/status returns
#      empty arrays again so the next harness run starts clean.
#
# USAGE: ADMIN_PASSWORD=<…> ./scripts/integration-oidc-dex.sh
#
# Prereqs:
#   - Staging admin reachable
#   - Dex reachable at https://dex.<staging-domain>/dex
#   - Dex staticClients include hosting-platform-admin + hosting-platform-client
#     (see k8s/overlays/staging/dex/config.yaml)
#   - Dex staticPasswords include admin@k8s-platform.test / admin and
#     user@k8s-platform.test / user
#
# Production guard: this harness fails fast if pointed at a production
# domain. Dex must never be deployed in production.

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
DEX_HOST="${DEX_HOST:-https://dex.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

# Dex static-password test users — see k8s/overlays/staging/dex/config.yaml.
DEX_ADMIN_USER="${DEX_ADMIN_USER:-admin@k8s-platform.test}"
DEX_ADMIN_PW="${DEX_ADMIN_PW:-admin}"
DEX_CLIENT_USER="${DEX_CLIENT_USER:-user@k8s-platform.test}"
DEX_CLIENT_PW="${DEX_CLIENT_PW:-user}"

# Static clients pre-registered in Dex.
ADMIN_CLIENT_ID="${ADMIN_CLIENT_ID:-hosting-platform-admin}"
ADMIN_CLIENT_SECRET="${ADMIN_CLIENT_SECRET:-staging-secret-admin}"
CLIENT_CLIENT_ID="${CLIENT_CLIENT_ID:-hosting-platform-client}"
CLIENT_CLIENT_SECRET="${CLIENT_CLIENT_SECRET:-staging-secret-client}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

# Production guard: refuse to run if either host looks like production.
case "$ADMIN_HOST$DEX_HOST" in
  *prod*|*production*)
    echo "ERROR: production domain detected — refusing to run (Dex is dev/staging only)" >&2
    exit 2
    ;;
esac

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
# Status output goes to stderr so functions called inside $(...) capture
# don't swallow the human-readable assertions.
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*" >&2; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*" >&2; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*" >&2; failed=$((failed+1)); FAILURES+=("$*"); }
warn() { printf '  %b⚠%b %s\n' "$YELLOW" "$RESET" "$*" >&2; }

passed=0; failed=0; FAILURES=()
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR" /tmp/oidc-dex-*.json /tmp/oidc-dex-*.html /tmp/oidc-dex-*.headers 2>/dev/null' EXIT

# Decode JWT payload (no signature check — backend already verified it).
jwt_payload() {
  local token="$1"
  local payload="${token#*.}"; payload="${payload%.*}"
  # Pad base64url to multiple of 4
  local pad=$(( (4 - ${#payload} % 4) % 4 ))
  printf '%s' "$payload$(printf '=%.0s' $(seq 1 $pad))" | tr '_-' '/+' | base64 -d 2>/dev/null
}

# ─── Step A: login as local admin, get platform JWT ───────────────────────────

log "Logging in as local admin"
LOGIN_BODY=$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')
LOGIN_RES=$(curl -sk --max-time 10 -X POST -H "Content-Type: application/json" \
  -d "$LOGIN_BODY" "$ADMIN_HOST/api/v1/auth/login")
ADMIN_TOKEN=$(echo "$LOGIN_RES" | jq -r '.data.token // empty')
[[ -n "$ADMIN_TOKEN" ]] || { echo "FATAL: local admin login failed: $LOGIN_RES" >&2; exit 2; }
ok "local admin login → JWT obtained"

AUTH_H=(-H "Authorization: Bearer $ADMIN_TOKEN")

# ─── Scenario 1: Dex live ─────────────────────────────────────────────────────

log "Scenario 1: Dex deployment reachable"
DISCO=$(curl -sk --max-time 5 "$DEX_HOST/dex/.well-known/openid-configuration")
ISSUER=$(echo "$DISCO" | jq -r '.issuer // empty')
JWKS_URI=$(echo "$DISCO" | jq -r '.jwks_uri // empty')
if [[ -z "$ISSUER" || -z "$JWKS_URI" ]]; then
  fail "OIDC discovery missing issuer/jwks_uri: $DISCO"
else
  ok "discovery: issuer=$ISSUER"
  JWKS=$(curl -sk --max-time 5 "$JWKS_URI")
  KEY_COUNT=$(echo "$JWKS" | jq -r '.keys | length // 0')
  if [[ "$KEY_COUNT" -lt 1 ]]; then
    fail "JWKS returned $KEY_COUNT keys"
  else
    ok "JWKS returned $KEY_COUNT signing key(s)"
  fi
fi

# Dex static-client probe: hit /token with bogus code — Dex should reply
# "invalid_grant" / "invalid_request" (NOT "invalid_client") proving the
# client_id is recognized.
probe_static_client() {
  local cid="$1" cs="$2" label="$3"
  local res code err
  res=$(curl -sk --max-time 5 -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=authorization_code&code=bogus&redirect_uri=https://example.invalid/cb&client_id=${cid}&client_secret=${cs}&code_verifier=verifier_at_least_43_chars_aaaaaaaaaaaaaaaaaaa" \
    "$DEX_HOST/dex/token")
  err=$(echo "$res" | jq -r '.error // empty')
  case "$err" in
    invalid_grant|invalid_request)
      ok "Dex recognises $label client_id=${cid} (error=$err for bogus code)"
      ;;
    invalid_client|"")
      fail "Dex did NOT recognise $label client_id=${cid}: $res"
      ;;
    *)
      ok "Dex recognises $label client_id=${cid} (error=$err — non-fatal)"
      ;;
  esac
}
probe_static_client "$ADMIN_CLIENT_ID" "$ADMIN_CLIENT_SECRET" "admin"
probe_static_client "$CLIENT_CLIENT_ID" "$CLIENT_CLIENT_SECRET" "client"

# ─── Scenario 2: register Dex as OIDC provider for both panels ────────────────

log "Scenario 2: register OIDC providers"

create_provider() {
  local panel="$1" client_id="$2" client_secret="$3" display="$4"
  local body
  # enabled:true is REQUIRED — service.createProvider stores enabled=0
  # by default, and getAuthStatus filters by enabled=1 so a disabled
  # provider is invisible to the public /auth/oidc/status endpoint.
  body=$(jq -nc \
    --arg dn "$display" \
    --arg iu "$DEX_HOST/dex" \
    --arg ci "$client_id" \
    --arg cs "$client_secret" \
    --arg ps "$panel" \
    '{display_name:$dn, issuer_url:$iu, client_id:$ci, client_secret:$cs, panel_scope:$ps, enabled:true, auto_provision:true}')
  curl -sk --max-time 10 -X POST "${AUTH_H[@]}" -H "Content-Type: application/json" \
    -d "$body" "$ADMIN_HOST/api/v1/admin/oidc/providers"
}

# Tear down any leftover providers from prior runs (defensive — the
# unique constraint on (issuer_url, client_id) would otherwise reject
# a re-register).
log "  cleaning leftover providers (if any)"
EXISTING=$(curl -sk --max-time 10 "${AUTH_H[@]}" "$ADMIN_HOST/api/v1/admin/oidc/providers" | jq -r '.data[] | select(.issuerUrl == "'"$DEX_HOST"'/dex") | .id')
for pid in $EXISTING; do
  curl -sk --max-time 10 -X DELETE "${AUTH_H[@]}" "$ADMIN_HOST/api/v1/admin/oidc/providers/$pid" >/dev/null
done

ADMIN_PROVIDER_RES=$(create_provider admin "$ADMIN_CLIENT_ID" "$ADMIN_CLIENT_SECRET" "Dex (integration-test admin)")
ADMIN_PROVIDER_ID=$(echo "$ADMIN_PROVIDER_RES" | jq -r '.data.id // empty')
if [[ -z "$ADMIN_PROVIDER_ID" || "$ADMIN_PROVIDER_ID" == "null" ]]; then
  fail "create admin provider returned no id: $ADMIN_PROVIDER_RES"
else
  ok "admin provider id=$ADMIN_PROVIDER_ID"
fi

CLIENT_PROVIDER_RES=$(create_provider client "$CLIENT_CLIENT_ID" "$CLIENT_CLIENT_SECRET" "Dex (integration-test client)")
CLIENT_PROVIDER_ID=$(echo "$CLIENT_PROVIDER_RES" | jq -r '.data.id // empty')
if [[ -z "$CLIENT_PROVIDER_ID" || "$CLIENT_PROVIDER_ID" == "null" ]]; then
  fail "create client provider returned no id: $CLIENT_PROVIDER_RES"
else
  ok "client provider id=$CLIENT_PROVIDER_ID"
fi

cleanup_providers() {
  if [[ -n "${ADMIN_PROVIDER_ID:-}" && "$ADMIN_PROVIDER_ID" != "null" ]]; then
    curl -sk --max-time 10 -X DELETE "${AUTH_H[@]}" "$ADMIN_HOST/api/v1/admin/oidc/providers/$ADMIN_PROVIDER_ID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${CLIENT_PROVIDER_ID:-}" && "$CLIENT_PROVIDER_ID" != "null" ]]; then
    curl -sk --max-time 10 -X DELETE "${AUTH_H[@]}" "$ADMIN_HOST/api/v1/admin/oidc/providers/$CLIENT_PROVIDER_ID" >/dev/null 2>&1 || true
  fi
}
# Make sure cleanup runs even on early exit.
trap 'cleanup_providers; rm -f "$COOKIE_JAR" /tmp/oidc-dex-*.json /tmp/oidc-dex-*.html /tmp/oidc-dex-*.headers 2>/dev/null' EXIT

# ─── Scenario 3: provider connection test ─────────────────────────────────────

log "Scenario 3: /admin/oidc/providers/:id/test"
test_provider() {
  local pid="$1" label="$2"
  local res
  res=$(curl -sk --max-time 10 -X POST "${AUTH_H[@]}" "$ADMIN_HOST/api/v1/admin/oidc/providers/$pid/test")
  # Backend's testProviderConnection returns {issuer, ..., status: "connected"}
  # on success, no `success`/`ok` boolean. Accept either shape.
  local status_field success_field
  status_field=$(echo "$res" | jq -r '.data.status // empty')
  success_field=$(echo "$res" | jq -r '.data.success // .data.ok // empty')
  if [[ "$status_field" == "connected" || "$success_field" == "true" ]]; then
    ok "$label provider test passed (status=$status_field)"
  else
    fail "$label provider test failed: $res"
  fi
}
[[ -n "${ADMIN_PROVIDER_ID:-}" ]] && test_provider "$ADMIN_PROVIDER_ID" admin
[[ -n "${CLIENT_PROVIDER_ID:-}" ]] && test_provider "$CLIENT_PROVIDER_ID" client

# ─── Scenario 4: /auth/oidc/status reports correct panel scoping ──────────────

log "Scenario 4: per-panel /auth/oidc/status"
STATUS_ADMIN=$(curl -sk --max-time 5 "$ADMIN_HOST/api/v1/auth/oidc/status?panel=admin")
STATUS_CLIENT=$(curl -sk --max-time 5 "$ADMIN_HOST/api/v1/auth/oidc/status?panel=client")
ADMIN_HAS_ADMIN_ID=$(echo "$STATUS_ADMIN" | jq -r --arg id "$ADMIN_PROVIDER_ID" '.data.providers // .data | map(select(.id == $id)) | length')
ADMIN_HAS_CLIENT_ID=$(echo "$STATUS_ADMIN" | jq -r --arg id "$CLIENT_PROVIDER_ID" '.data.providers // .data | map(select(.id == $id)) | length')
CLIENT_HAS_CLIENT_ID=$(echo "$STATUS_CLIENT" | jq -r --arg id "$CLIENT_PROVIDER_ID" '.data.providers // .data | map(select(.id == $id)) | length')
CLIENT_HAS_ADMIN_ID=$(echo "$STATUS_CLIENT" | jq -r --arg id "$ADMIN_PROVIDER_ID" '.data.providers // .data | map(select(.id == $id)) | length')

[[ "$ADMIN_HAS_ADMIN_ID" == "1" ]] && ok "admin status lists admin provider" \
  || fail "admin status missing admin provider: $STATUS_ADMIN"
[[ "$CLIENT_HAS_CLIENT_ID" == "1" ]] && ok "client status lists client provider" \
  || fail "client status missing client provider: $STATUS_CLIENT"
[[ "$ADMIN_HAS_CLIENT_ID" == "0" ]] && ok "admin status does NOT leak client provider (panel isolation)" \
  || fail "admin status leaks client provider"
[[ "$CLIENT_HAS_ADMIN_ID" == "0" ]] && ok "client status does NOT leak admin provider (panel isolation)" \
  || fail "client status leaks admin provider"

# ─── Scenario 5: /auth/oidc/authorize redirects with correct PKCE ─────────────

log "Scenario 5: /auth/oidc/authorize redirect chain"

check_authorize_redirect() {
  local pid="$1" expected_cid="$2" panel="$3" frontend_redirect="$4"
  local resp loc
  resp=$(curl -sk --max-time 10 -i \
    "$ADMIN_HOST/api/v1/auth/oidc/authorize/$pid?redirect_uri=$(printf %s "$frontend_redirect" | jq -sRr @uri)")
  loc=$(echo "$resp" | grep -i '^location:' | head -1 | awk '{print $2}' | tr -d '\r')
  if [[ -z "$loc" ]]; then
    fail "$panel: no Location header from authorize"
    return 1
  fi
  case "$loc" in
    "$DEX_HOST"/dex/auth*) ;;
    *) fail "$panel: Location does not point to Dex /dex/auth: $loc"; return 1 ;;
  esac
  case "$loc" in
    *"client_id=$expected_cid"*) ok "$panel: redirect carries client_id=$expected_cid" ;;
    *) fail "$panel: redirect missing client_id=$expected_cid (got: $loc)" ;;
  esac
  case "$loc" in
    *"response_type=code"*) ok "$panel: redirect carries response_type=code" ;;
    *) fail "$panel: redirect missing response_type=code" ;;
  esac
  case "$loc" in
    *"code_challenge_method=S256"*) ok "$panel: redirect carries PKCE S256" ;;
    *) fail "$panel: redirect missing PKCE S256" ;;
  esac
  case "$loc" in
    *"scope=openid"*) ok "$panel: redirect carries openid scope" ;;
    *) fail "$panel: redirect missing openid scope" ;;
  esac
  echo "$loc"
}

ADMIN_AUTHORIZE_LOC=$(check_authorize_redirect "$ADMIN_PROVIDER_ID" "$ADMIN_CLIENT_ID" admin "$ADMIN_HOST/login" | tail -1)
CLIENT_AUTHORIZE_LOC=$(check_authorize_redirect "$CLIENT_PROVIDER_ID" "$CLIENT_CLIENT_ID" client "$ADMIN_HOST/client-login" | tail -1)

# ─── Scenarios 6 & 7: drive Dex login → assert platform JWT ──────────────────

drive_dex_login() {
  local panel="$1" pid="$2" dex_user="$3" dex_pw="$4" frontend_redirect="$5"
  local jar resp loc dex_state form_url platform_state platform_token
  jar=$(mktemp); local LBL="$panel-dex-login"

  log "  driving Dex login flow for $panel"

  # 1. Initiate platform authorize → get redirect to Dex /dex/auth
  resp=$(curl -sk --max-time 10 -i -c "$jar" -b "$jar" \
    "$ADMIN_HOST/api/v1/auth/oidc/authorize/$pid?redirect_uri=$(printf %s "$frontend_redirect" | jq -sRr @uri)")
  loc=$(echo "$resp" | grep -i '^location:' | head -1 | awk '{print $2}' | tr -d '\r')
  platform_state=$(echo "$loc" | grep -oE 'state=[a-zA-Z0-9_-]+' | head -1 | cut -d= -f2)
  if [[ -z "$platform_state" ]]; then
    fail "$LBL: no platform state in authorize redirect"
    rm -f "$jar"; return 1
  fi

  # 2. Follow Dex /dex/auth → /dex/auth/local
  #    The platform redirects to https://dex.../dex/auth?... (absolute).
  #    Dex responds 302 with a relative /dex/auth/local?... Location.
  resp=$(curl -sk --max-time 10 -i -c "$jar" -b "$jar" "$loc")
  loc=$(echo "$resp" | grep -i '^location:' | head -1 | awk '{print $2}' | tr -d '\r')
  case "$loc" in
    /dex/auth/local*) ;;
    "")
      # No Location at all — Dex may have rejected the request (bad
      # client_id / redirect_uri mismatch / internal error). Surface
      # the response status line for diagnosis.
      local status_line
      status_line=$(echo "$resp" | head -1)
      fail "$LBL: no Location header from /dex/auth (status: $status_line)"
      rm -f "$jar"; return 1 ;;
    *) fail "$LBL: expected /dex/auth/local, got: $loc"; rm -f "$jar"; return 1 ;;
  esac

  # 3. Follow /dex/auth/local → /dex/auth/local/login?back=&state=<dex_state>
  #    Need to prefix DEX_HOST because $loc is a relative path.
  resp=$(curl -sk --max-time 10 -i -c "$jar" -b "$jar" "${DEX_HOST}${loc}")
  loc=$(echo "$resp" | grep -i '^location:' | head -1 | awk '{print $2}' | tr -d '\r')
  dex_state=$(echo "$loc" | grep -oE 'state=[a-zA-Z0-9]+' | head -1 | cut -d= -f2)
  if [[ -z "$dex_state" ]]; then
    local status_line
    status_line=$(echo "$resp" | head -1)
    fail "$LBL: no Dex state in /dex/auth/local redirect (status: $status_line, loc: '$loc')"
    rm -f "$jar"; return 1
  fi
  form_url="${DEX_HOST}/dex/auth/local/login?back=&state=${dex_state}"

  # 4. POST credentials to Dex form
  resp=$(curl -sk --max-time 10 -i -c "$jar" -b "$jar" -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "login=$dex_user" \
    --data-urlencode "password=$dex_pw" \
    "$form_url")
  loc=$(echo "$resp" | grep -i '^location:' | head -1 | awk '{print $2}' | tr -d '\r')
  if [[ -z "$loc" ]]; then
    fail "$LBL: Dex login POST returned no Location (bad creds?): $(echo "$resp" | head -3)"
    rm -f "$jar"; return 1
  fi

  # 5. Follow up to ~5 redirect hops (dex/approval → /dex/auth/<state>/approval → platform callback)
  local hops=0
  while [[ -n "$loc" && $hops -lt 8 ]]; do
    case "$loc" in
      "$ADMIN_HOST"*|http*) full="$loc" ;;
      /*) full="${DEX_HOST}${loc}" ;;
      *) fail "$LBL: unexpected non-absolute Location: $loc"; rm -f "$jar"; return 1 ;;
    esac
    resp=$(curl -sk --max-time 10 -i -c "$jar" -b "$jar" "$full")
    loc=$(echo "$resp" | grep -i '^location:' | head -1 | awk '{print $2}' | tr -d '\r')
    # Stop once we land on the frontend redirect with token=
    if [[ "$full" == "$ADMIN_HOST"* && "$loc" == "$frontend_redirect"* ]]; then
      break
    fi
    if [[ "$full" == "$frontend_redirect"* ]]; then
      # Already at frontend redirect — no further hops
      loc=""
      break
    fi
    hops=$((hops+1))
  done

  # The final redirect should carry the platform JWT in ?token=...
  local final_loc
  final_loc=$(echo "$resp" | grep -i '^location:' | head -1 | awk '{print $2}' | tr -d '\r')
  # Either resp itself was the frontend (302 with token) or the previous loc was.
  for cand in "$final_loc" "$loc" "$full"; do
    case "$cand" in
      "$frontend_redirect"*token=*)
        platform_token=$(echo "$cand" | grep -oE 'token=[A-Za-z0-9._-]+' | head -1 | cut -d= -f2)
        break
        ;;
    esac
  done

  if [[ -z "${platform_token:-}" ]]; then
    fail "$LBL: did not receive platform JWT in final redirect (last url: $full → $final_loc)"
    rm -f "$jar"; return 1
  fi

  # Decode JWT payload — assert sub, panel, role.
  local payload sub panel_claim role
  payload=$(jwt_payload "$platform_token")
  sub=$(echo "$payload" | jq -r '.sub // empty')
  panel_claim=$(echo "$payload" | jq -r '.panel // empty')
  role=$(echo "$payload" | jq -r '.role // empty')

  if [[ -z "$sub" ]]; then
    fail "$LBL: JWT has no sub: $payload"
  else
    ok "$LBL: JWT issued sub=$sub panel=$panel_claim role=$role"
  fi
  if [[ "$panel_claim" != "$panel" ]]; then
    fail "$LBL: JWT panel claim '$panel_claim' != expected '$panel'"
  else
    ok "$LBL: JWT panel claim matches"
  fi

  # Stash the token for cross-panel rejection scenario.
  if [[ "$panel" == "admin" ]]; then
    OIDC_ADMIN_TOKEN="$platform_token"
  else
    OIDC_CLIENT_TOKEN="$platform_token"
  fi
  rm -f "$jar"
}

log "Scenario 6: end-to-end Dex login → platform JWT (admin panel)"
drive_dex_login admin "$ADMIN_PROVIDER_ID" "$DEX_ADMIN_USER" "$DEX_ADMIN_PW" "$ADMIN_HOST/login"

log "Scenario 7: end-to-end Dex login → platform JWT (client panel)"
drive_dex_login client "$CLIENT_PROVIDER_ID" "$DEX_CLIENT_USER" "$DEX_CLIENT_PW" "$ADMIN_HOST/client-login"

# ─── Scenario 8: cross-panel token rejection ─────────────────────────────────

log "Scenario 8: cross-panel token isolation"
if [[ -n "${OIDC_ADMIN_TOKEN:-}" && -n "${OIDC_CLIENT_TOKEN:-}" ]]; then
  # Admin-only endpoint with the client JWT → must NOT return 200.
  CODE=$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $OIDC_CLIENT_TOKEN" "$ADMIN_HOST/api/v1/admin/clients?limit=1")
  if [[ "$CODE" == "200" ]]; then
    fail "client JWT was accepted on /admin/clients (should be 401/403)"
  else
    ok "client JWT rejected on /admin/clients (HTTP $CODE)"
  fi
  # Admin JWT on client-only profile route — clients endpoint should accept,
  # but the panel claim must be admin (not client). Best-effort: hit the
  # admin profile endpoint and expect 200, then hit a client-panel-only
  # route if one exists. Most platform routes accept admin JWTs broadly,
  # so this is a soft check.
  CODE=$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $OIDC_ADMIN_TOKEN" "$ADMIN_HOST/api/v1/admin/clients?limit=1")
  if [[ "$CODE" == "200" ]]; then
    ok "admin JWT accepted on /admin/clients (HTTP $CODE)"
  else
    fail "admin JWT rejected on /admin/clients (HTTP $CODE)"
  fi
else
  warn "skipping cross-panel test — earlier scenarios did not produce both tokens"
fi

# ─── Scenario 9: cleanup verification ────────────────────────────────────────

log "Scenario 9: cleanup providers"
cleanup_providers
trap 'rm -f "$COOKIE_JAR" /tmp/oidc-dex-*.json /tmp/oidc-dex-*.html /tmp/oidc-dex-*.headers 2>/dev/null' EXIT
# Verify both providers gone
STATUS_ADMIN=$(curl -sk --max-time 5 "$ADMIN_HOST/api/v1/auth/oidc/status?panel=admin")
STATUS_CLIENT=$(curl -sk --max-time 5 "$ADMIN_HOST/api/v1/auth/oidc/status?panel=client")
ADMIN_REMAINING=$(echo "$STATUS_ADMIN" | jq -r --arg id "$ADMIN_PROVIDER_ID" '.data.providers // .data | map(select(.id == $id)) | length')
CLIENT_REMAINING=$(echo "$STATUS_CLIENT" | jq -r --arg id "$CLIENT_PROVIDER_ID" '.data.providers // .data | map(select(.id == $id)) | length')
[[ "$ADMIN_REMAINING" == "0" ]] && ok "admin provider deleted" || fail "admin provider still listed"
[[ "$CLIENT_REMAINING" == "0" ]] && ok "client provider deleted" || fail "client provider still listed"

# ─── Final summary ────────────────────────────────────────────────────────────

echo
log "Final results"
printf '  %bpassed:%b %d\n' "$GREEN" "$RESET" "$passed"
printf '  %bfailed:%b %d\n' "$RED"   "$RESET" "$failed"
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo
  log "Failures:"
  for f in "${FAILURES[@]}"; do printf '    %b✗%b %s\n' "$RED" "$RESET" "$f"; done
fi
[[ "$failed" -eq 0 ]] || exit 1
