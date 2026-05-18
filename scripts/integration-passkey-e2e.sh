#!/usr/bin/env bash
# End-to-end test for the passkey API surface (admin + client panels).
#
# We exercise everything that doesn't require a real WebAuthn ceremony:
#   1. GET /auth/passkey on a fresh user → empty list, mode=NULL
#   2. PATCH /auth/passkey-mode mode=second_factor with no creds → 409 PASSKEY_REQUIRED_FIRST
#   3. POST /auth/passkey/registration/options without Bearer token → 401
#   4. POST /auth/passkey/registration/options with cookie-only auth → 401 (CSRF defense)
#   5. POST /auth/passkey/login/options userless (no body) → 200 + opaque options
#   6. PATCH /auth/passkey-mode mode=null → 200 (no-op when no passkeys)
#   7. PATCH /auth/passkey-mode invalid mode → 400
#   8. Verify no regression in normal password login
#   9. Same surface on the client panel for tenant_admin user
#
# The full register+authenticate ceremony requires a software authenticator
# and is deferred to the Playwright E2E suite (per Phase 6 of the plan).
#
# USAGE: ADMIN_PASSWORD=<…> ./scripts/integration-passkey-e2e.sh

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
# Derive CLIENT_HOST from ADMIN_HOST by swapping the `admin.` prefix
# for `client.` — these two hostnames are always paired in this
# platform's ingress (see k8s/base/platform/platform-ingress.yaml).
# An explicit CLIENT_HOST env var still wins.
CLIENT_HOST="${CLIENT_HOST:-${ADMIN_HOST/admin./client.}}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }

passed=0
failed=0

api() {
  local host="$1" method="$2" path="$3" body="${4:-}" auth="${5:-}"
  local h_auth=()
  if [[ -n "$auth" ]]; then h_auth=(-H "Authorization: Bearer $auth"); fi
  if [[ -z "$body" ]]; then
    curl -sk -X "$method" "$host/api/v1$path" "${h_auth[@]}"
  else
    curl -sk -X "$method" "$host/api/v1$path" "${h_auth[@]}" \
      -H "Content-Type: application/json" -d "$body"
  fi
}

api_status() {
  local host="$1" method="$2" path="$3" body="${4:-}" auth="${5:-}" cookies="${6:-}"
  local h_auth=()
  if [[ -n "$auth" ]]; then h_auth=(-H "Authorization: Bearer $auth"); fi
  if [[ -n "$cookies" ]]; then h_auth+=(-H "Cookie: $cookies"); fi
  if [[ -z "$body" ]]; then
    curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$host/api/v1$path" "${h_auth[@]}"
  else
    curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$host/api/v1$path" "${h_auth[@]}" \
      -H "Content-Type: application/json" -d "$body"
  fi
}

run_panel_suite() {
  local PANEL="$1" HOST="$2" EMAIL="$3" PASSWORD="$4"
  log "── ${PANEL} panel: passkey API surface ──"

  # Login first to obtain a Bearer token + the platform_session cookie.
  local LOGIN_BODY
  LOGIN_BODY=$(curl -sk -X POST "$HOST/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"panel\":\"$PANEL\"}" \
    -c /tmp/passkey-cookies-$$.txt)
  local TOKEN
  TOKEN=$(echo "$LOGIN_BODY" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d.get('token',''))" 2>/dev/null || echo "")
  if [[ -z "$TOKEN" ]]; then
    fail "${PANEL} login failed: $(echo "$LOGIN_BODY" | head -c 300)"
    return
  fi
  ok "${PANEL} login → access token"

  # Pre-test cleanup: a previous run / manual probe / parallel session
  # may have left passkeys on this user. The suite assumes "fresh user"
  # state. Drop mode first (so we don't trip the LAST_PASSKEY_IN_2FA_MODE
  # guard), then iterate every credential.
  api "$HOST" PATCH "/auth/passkey-mode" '{"mode":null}' "$TOKEN" >/dev/null
  local STALE_IDS
  STALE_IDS=$(api "$HOST" GET "/auth/passkey" "" "$TOKEN" | python3 -c "
import json, sys
try:
    pks = json.load(sys.stdin)['data'].get('passkeys') or []
    print(' '.join(p['id'] for p in pks))
except Exception:
    print('')
" 2>/dev/null || echo "")
  if [[ -n "$STALE_IDS" ]]; then
    for pkid in $STALE_IDS; do
      api "$HOST" DELETE "/auth/passkey/$pkid" "" "$TOKEN" >/dev/null
    done
    log "  cleared $(echo "$STALE_IDS" | wc -w) stale passkey(s) before test"
  fi

  # 1. GET /auth/passkey on fresh user
  local LIST_RESP
  LIST_RESP=$(api "$HOST" GET "/auth/passkey" "" "$TOKEN")
  local LIST_MODE LIST_COUNT
  LIST_MODE=$(echo "$LIST_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d.get('mode') if d.get('mode') is not None else 'NULL')" 2>/dev/null || echo "?")
  LIST_COUNT=$(echo "$LIST_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(len(d.get('passkeys') or []))" 2>/dev/null || echo "?")
  if [[ "$LIST_MODE" == "NULL" && "$LIST_COUNT" == "0" ]]; then
    ok "GET /auth/passkey → mode=NULL, 0 passkeys (fresh user)"
  else
    fail "GET /auth/passkey unexpected: mode=$LIST_MODE count=$LIST_COUNT — body: $(echo "$LIST_RESP" | head -c 200)"
  fi

  # 2. PATCH /auth/passkey-mode mode=second_factor (without registered creds)
  local MODE_RESP
  MODE_RESP=$(api "$HOST" PATCH "/auth/passkey-mode" '{"mode":"second_factor"}' "$TOKEN")
  local MODE_CODE
  MODE_CODE=$(echo "$MODE_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('error',{}).get('code',''))" 2>/dev/null || echo "")
  if [[ "$MODE_CODE" == "PASSKEY_REQUIRED_FIRST" ]]; then
    ok "PATCH passkey-mode=second_factor without passkeys → PASSKEY_REQUIRED_FIRST"
  else
    fail "expected PASSKEY_REQUIRED_FIRST, got code=$MODE_CODE"
  fi

  # 3. Unauthenticated registration options
  local STATUS_NOAUTH
  STATUS_NOAUTH=$(api_status "$HOST" POST "/auth/passkey/registration/options" '{}' "")
  if [[ "$STATUS_NOAUTH" == "401" ]]; then
    ok "POST registration/options without Bearer → 401"
  else
    fail "expected 401 unauthenticated registration/options, got $STATUS_NOAUTH"
  fi

  # 4. Cookie-only request (no Bearer) — CSRF defense
  local COOKIE_LINE
  COOKIE_LINE=$(awk '$6=="platform_session"{printf "%s=%s",$6,$7}' /tmp/passkey-cookies-$$.txt 2>/dev/null || true)
  if [[ -n "$COOKIE_LINE" ]]; then
    local STATUS_COOKIE
    STATUS_COOKIE=$(api_status "$HOST" POST "/auth/passkey/registration/options" '{}' "" "$COOKIE_LINE")
    if [[ "$STATUS_COOKIE" == "401" ]]; then
      ok "POST registration/options with cookie-only (no Bearer) → 401 (CSRF defense)"
    else
      fail "expected 401 cookie-only registration/options, got $STATUS_COOKIE"
    fi
  else
    log "  skip CSRF check — no platform_session cookie was set in login"
  fi

  # 5. Userless login options (no body)
  local USERLESS_RESP
  USERLESS_RESP=$(api "$HOST" POST "/auth/passkey/login/options" "{\"panel\":\"$PANEL\"}" "")
  local USERLESS_HAS_CHALLENGE
  USERLESS_HAS_CHALLENGE=$(echo "$USERLESS_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print('yes' if d.get('challenge') else 'no')" 2>/dev/null || echo "no")
  if [[ "$USERLESS_HAS_CHALLENGE" == "yes" ]]; then
    ok "POST login/options (userless) → returned challenge"
  else
    fail "expected challenge in userless options, got: $(echo "$USERLESS_RESP" | head -c 200)"
  fi

  # 6. PATCH passkey-mode → null (allowed, no-op)
  local MODE_NULL_RESP
  MODE_NULL_RESP=$(api "$HOST" PATCH "/auth/passkey-mode" '{"mode":null}' "$TOKEN")
  local MODE_NULL_CODE
  MODE_NULL_CODE=$(echo "$MODE_NULL_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('error',{}).get('code','OK') if 'error' in d else 'OK')" 2>/dev/null || echo "?")
  if [[ "$MODE_NULL_CODE" == "OK" ]]; then
    ok "PATCH passkey-mode=null accepted"
  else
    fail "PATCH passkey-mode=null failed: $MODE_NULL_CODE"
  fi

  # 7. PATCH with invalid mode
  local BAD_MODE_RESP
  BAD_MODE_RESP=$(api "$HOST" PATCH "/auth/passkey-mode" '{"mode":"bogus"}' "$TOKEN")
  local BAD_MODE_CODE
  BAD_MODE_CODE=$(echo "$BAD_MODE_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('error',{}).get('code',''))" 2>/dev/null || echo "")
  if [[ "$BAD_MODE_CODE" == "VALIDATION_ERROR" ]]; then
    ok "PATCH passkey-mode=bogus → VALIDATION_ERROR"
  else
    fail "expected VALIDATION_ERROR for invalid mode, got code=$BAD_MODE_CODE"
  fi

  # 8. Sanity: password login flow still issues tokens (no regression)
  local SANITY_BODY
  SANITY_BODY=$(curl -sk -X POST "$HOST/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"panel\":\"$PANEL\"}")
  local SANITY_TOKEN
  SANITY_TOKEN=$(echo "$SANITY_BODY" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d.get('token',''))" 2>/dev/null || echo "")
  if [[ -n "$SANITY_TOKEN" ]]; then
    ok "password login still issues tokens (no regression)"
  else
    fail "password login regressed: $(echo "$SANITY_BODY" | head -c 200)"
  fi

  rm -f /tmp/passkey-cookies-$$.txt 2>/dev/null || true
}

# ─── Admin panel ─────────────────────────────────────────────────────
run_panel_suite "admin" "$ADMIN_HOST" "$ADMIN_EMAIL" "$ADMIN_PASSWORD"

# ─── Client panel ────────────────────────────────────────────────────
# Find the most recently created provisioned client and use its
# auto-generated tenant_admin user. This mirrors the harness's pattern
# of "use whatever's already there, don't fabricate test fixtures".
log "── locating a tenant_admin user for tenant-panel suite ──"

# Login as admin to query clients.
ADMIN_TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"panel\":\"admin\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null)

if [[ -z "$ADMIN_TOKEN" ]]; then
  fail "could not obtain admin token; skipping tenant-panel suite"
else
  # Create a fresh client just for this test so we know the credentials.
  STAMP=$(date +%s)
  # Always pick the Starter plan so the smallest PVC sizes are used.
  # Falls back to the smallest-storage plan if Starter is missing — keeps
  # the test runnable on operators who renamed their seed plans.
  PLAN_ID=$(curl -sk -H "Authorization: Bearer $ADMIN_TOKEN" "$ADMIN_HOST/api/v1/plans?limit=20" \
    | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];s=next((p for p in d if p.get('name')=='Starter'),None);print((s or sorted(d,key=lambda x:float(x.get('storageLimit') or 0))[0])['id'])" 2>/dev/null)
  REGION_ID=$(curl -sk -H "Authorization: Bearer $ADMIN_TOKEN" "$ADMIN_HOST/api/v1/regions" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['data'][0]['id'])" 2>/dev/null)
  CREATE_RESP=$(curl -sk -X POST "$ADMIN_HOST/api/v1/tenants" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"Passkey E2E $STAMP\",\"primary_email\":\"passkey-e2e-$STAMP@phoenix-host.net\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}")
  CID=$(echo "$CREATE_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null || echo "")
  # Field was renamed `clientUser` → `tenantUser` in api-contracts; the
  # old name in this script returned empty and tripped the guard at L235.
  CLIENT_USER_PWD=$(echo "$CREATE_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['tenantUser']['generatedPassword'])" 2>/dev/null || echo "")
  CLIENT_USER_EMAIL="passkey-e2e-$STAMP@phoenix-host.net"

  if [[ -n "$CID" && -n "$CLIENT_USER_PWD" ]]; then
    ok "created test client + auto-generated tenant_admin (cid=${CID:0:8})"
    cleanup_client() {
      curl -sk -X DELETE "$ADMIN_HOST/api/v1/tenants/$CID" \
        -H "Authorization: Bearer $ADMIN_TOKEN" >/dev/null 2>&1 || true
    }
    trap cleanup_client EXIT

    run_panel_suite "client" "$CLIENT_HOST" "$CLIENT_USER_EMAIL" "$CLIENT_USER_PWD"
  else
    fail "client provisioning failed for passkey suite; skipping tenant-panel checks. body: $(echo "$CREATE_RESP" | head -c 300)"
  fi
fi

echo
log "── done ──"
log "passed: $passed  failed: $failed"
[[ $failed -eq 0 ]]
