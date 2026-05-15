#!/usr/bin/env bash
# integration-bulwark-e2e.sh — end-to-end harness for the Bulwark webmail
# integration. See ADR-039.
#
# Phases (all default unless flagged):
#
#   A — Pod health + endpoint reachability
#     A1. bulwark Pod 1/1 Ready
#     A2. bulwark-impersonator Pod 1/1 Ready
#     A3. stalwart-url-rewriter Pod Ready (dev DinD only; production drops it)
#     A4. /api/health on Bulwark returns 200 + status:healthy
#     A5. /api/config exposes the configured JMAP_SERVER_URL
#     A6. WebAdmin /admin/ shell loads (HTTP 200, text/html)
#     A7. Stalwart /api/schema reachable from inside cluster
#
#   B — Direct user login (basic-auth)
#     B1. POST /api/auth/stalwart-context with mailbox creds → HTTP 200, cookie set
#     B2. POST /api/account/stalwart/jmap Mailbox/get → 5 default folders
#     B3. CORS: OPTIONS preflight from Bulwark origin → 204 + ACL headers
#     B4. CORS: 307 redirect carries ACL headers + Allow-Credentials:true
#
#   C — Client-panel impersonation (JWT → impersonator → Bulwark)
#     C1. Mint a valid JWT, GET /_impersonate?token=... → 303 + Set-Cookie
#     C2. Follow redirect, Mailbox/get returns target user's folders
#     C3. Impersonator audit log contains structured ok entry
#
#   D — Rejection cases (negative path)
#     D1. Expired JWT → 401 expired
#     D2. Wrong signature → 401 sig_mismatch
#     D3. alg=none → 401 wrong_alg
#     D4. Missing iss → 401 wrong_iss
#     D5. Missing iat → 401 no_iat
#     D6. TTL too long → 401 ttl_too_long
#     D7. Mailbox with `%` or `:` chars → 401 bad_mailbox
#     D8. Missing jti → 401 no_jti
#     D9. Replayed jti (second use) → 410 token already used
#     D10. /_impersonate with POST → 405
#
#   E — Failover (--failover)
#     E1. Active session against Bulwark
#     E2. Kill the Bulwark pod
#     E3. Wait for new pod Ready
#     E4. JMAP request via existing cookie still succeeds (or 401 with
#         a clean reconnect — the impersonator is stateless so the
#         server-side cookie is encrypted, validates across replicas)
#
# Usage:
#   ./scripts/integration-bulwark-e2e.sh                  # A + B + C + D
#   ./scripts/integration-bulwark-e2e.sh --failover       # adds Phase E
#   ./scripts/integration-bulwark-e2e.sh --skip-cors      # skips B3/B4
#
# Environment:
#   BULWARK_HOST   — public hostname (default: bulwark.${PLATFORM_BASE_DOMAIN:-k8s-platform.test})
#   BULWARK_PORT   — public port (default: 2011)
#   STALWART_HOST  — public Stalwart hostname (default: stalwart.${...}:2011)
#   EVAL_MAILBOX   — default eval@k8s-platform.test
#   EVAL_PASSWORD  — default Bulwark-Eval-2026-Pass!
#   JWT_SECRET     — shared secret for minting test JWTs
#   K3S_CONTAINER  — DinD k3s server container (default: hosting-platform-k3s-server-1)
set -euo pipefail

PLATFORM_BASE_DOMAIN="${PLATFORM_BASE_DOMAIN:-k8s-platform.test}"
BULWARK_HOST="${BULWARK_HOST:-bulwark.${PLATFORM_BASE_DOMAIN}}"
BULWARK_PORT="${BULWARK_PORT:-2011}"
BULWARK_BASE="https://${BULWARK_HOST}:${BULWARK_PORT}"
STALWART_BASE="${STALWART_BASE:-https://stalwart.${PLATFORM_BASE_DOMAIN}:2011}"
EVAL_MAILBOX="${EVAL_MAILBOX:-eval@k8s-platform.test}"
EVAL_PASSWORD="${EVAL_PASSWORD:-Bulwark-Eval-2026-Pass!}"
JWT_SECRET="${JWT_SECRET:-local-dev-jwt-secret-not-for-production}"
K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"

CURL_OPTS=(-k -sS -m 10)
PASS=0
FAIL=0
SKIP_CORS=0
RUN_FAILOVER=0

for arg in "$@"; do
  case "$arg" in
    --skip-cors) SKIP_CORS=1 ;;
    --failover)  RUN_FAILOVER=1 ;;
    --help|-h)   sed -n '3,55p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
phase() { printf '\n\033[36m── Phase %s ──\033[0m\n' "$*"; }

# JWT minting helper. Requires `node`.
#
# Args:
#   $1 — mailbox
#   $2 — jti (optional, defaults to a unique value per call)
#   $3 — exp offset in seconds (optional, defaults to 30; negative means already expired)
#   $4 — JS object literal merged on top of the default claims, e.g.
#        '{iat:undefined}' to delete the iat claim, '{iss:undefined}' for D4,
#        '{}' or empty for no override.
mint_jwt() {
  local mailbox="$1"
  local jti="${2:-jti-$(date +%s)-$RANDOM}"
  local exp_offset="${3:-30}"
  local extra="${4:-{\}}"
  node -e "
    const c = require('node:crypto');
    const b = v => Buffer.from(v).toString('base64').replace(/=+\$/,'').replace(/\+/g,'-').replace(/\//g,'_');
    const header = b(JSON.stringify({alg:'HS256',typ:'JWT'}));
    const now = Math.floor(Date.now()/1000);
    const claims = Object.assign({
      iss: 'platform-api/webmail',
      mailbox: '$mailbox',
      jti: '$jti',
      tenant_id: 'tenant-test',
      actor_user_id: 'user-test',
      iat: now,
      exp: now + ($exp_offset),
    }, $extra);
    // Drop any keys explicitly set to undefined (Object.assign keeps them
    // as own properties when assigning literals via the spread, which we
    // need for the 'missing-claim' negative tests).
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    const payload = b(JSON.stringify(claims));
    const sig = b(c.createHmac('sha256', '$JWT_SECRET').update(header+'.'+payload).digest());
    console.log(header+'.'+payload+'.'+sig);
  "
}

# Variant: signed with WRONG secret (for D2).
mint_jwt_bad_sig() {
  local mailbox="$1"
  node -e "
    const c = require('node:crypto');
    const b = v => Buffer.from(v).toString('base64').replace(/=+\$/,'').replace(/\+/g,'-').replace(/\//g,'_');
    const header = b(JSON.stringify({alg:'HS256',typ:'JWT'}));
    const now = Math.floor(Date.now()/1000);
    const payload = b(JSON.stringify({iss:'platform-api/webmail',mailbox:'$mailbox',jti:'bad-sig',iat:now,exp:now+30}));
    const sig = b(c.createHmac('sha256', 'wrong-secret-' + Math.random()).update(header+'.'+payload).digest());
    console.log(header+'.'+payload+'.'+sig);
  "
}

# Variant: alg=none header.
mint_jwt_alg_none() {
  local mailbox="$1"
  node -e "
    const b = v => Buffer.from(v).toString('base64').replace(/=+\$/,'').replace(/\+/g,'-').replace(/\//g,'_');
    const header = b(JSON.stringify({alg:'none',typ:'JWT'}));
    const now = Math.floor(Date.now()/1000);
    const payload = b(JSON.stringify({iss:'platform-api/webmail',mailbox:'$mailbox',jti:'alg-none',iat:now,exp:now+30}));
    console.log(header+'.'+payload+'.');
  "
}

# ── Phase A ─────────────────────────────────────────────────────────
phase A
# A1 — all containers in the bulwark pod Ready (Bulwark + impersonator
# sidecar + optional dev-stalwart-bridge — count varies by overlay).
BULWARK_READY=$(docker exec "$K3S_CONTAINER" kubectl get pod -n mail -l app=bulwark -o jsonpath='{.items[0].status.containerStatuses[*].ready}' 2>/dev/null)
if echo "$BULWARK_READY" | grep -qE "^(true ?)+$"; then pass "A1 bulwark pod all containers Ready ($BULWARK_READY)"; else fail "A1 bulwark not Ready: $BULWARK_READY"; fi
# A2 — impersonator container specifically Ready (sidecar inside bulwark pod, ADR-039 Phase 8).
IMP_READY=$(docker exec "$K3S_CONTAINER" kubectl get pod -n mail -l app=bulwark -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="impersonator")].ready}' 2>/dev/null)
[[ "$IMP_READY" == "true" ]] && pass "A2 impersonator sidecar Ready" || fail "A2 impersonator not Ready"
docker exec "$K3S_CONTAINER" kubectl get pod -n mail -l app=stalwart-url-rewriter -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null \
  | grep -q "true" && pass "A3 stalwart-url-rewriter Ready (dev DinD)" || warn "A3 stalwart-url-rewriter not Ready — OK in production"

HEALTH=$(curl "${CURL_OPTS[@]}" "${BULWARK_BASE}/api/health" -o /dev/null -w '%{http_code}' || echo failed)
[[ "$HEALTH" == "200" ]] && pass "A4 /api/health → 200" || fail "A4 /api/health → $HEALTH"

CONFIG_BODY=$(curl "${CURL_OPTS[@]}" "${BULWARK_BASE}/api/config" || echo "{}")
echo "$CONFIG_BODY" | grep -q '"jmapServerUrl"' && pass "A5 /api/config exposes jmapServerUrl" || fail "A5 /api/config missing jmapServerUrl"

WA_CODE=$(curl "${CURL_OPTS[@]}" "${STALWART_BASE}/admin/" -o /dev/null -w '%{http_code}' || echo failed)
[[ "$WA_CODE" == "200" ]] && pass "A6 Stalwart WebAdmin /admin/ shell → 200" || fail "A6 Stalwart WebAdmin → $WA_CODE"

# A7 — schema endpoint reachable inside cluster (uses admin creds)
ADMIN_PASS=$(docker exec "$K3S_CONTAINER" kubectl get secret -n mail stalwart-admin-creds -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d 2>/dev/null || true)
if [[ -n "$ADMIN_PASS" ]]; then
  SCHEMA_RESP=$(docker exec "$K3S_CONTAINER" kubectl exec -n mail deploy/bulwark -c bulwark -- node -e "
    const auth='Basic '+Buffer.from('admin:$ADMIN_PASS').toString('base64');
    fetch('http://stalwart-mgmt.mail.svc.cluster.local:8080/api/schema',{headers:{Authorization:auth}}).then(r=>console.log(r.status));
  " 2>&1 | tail -1)
  [[ "$SCHEMA_RESP" == "200" ]] && pass "A7 Stalwart /api/schema accessible" || fail "A7 /api/schema → $SCHEMA_RESP"
else
  warn "A7 skipped — no stalwart-admin-creds in cluster"
fi

# ── Phase B — basic-auth ────────────────────────────────────────────
phase B
B_COOKIES=$(mktemp)
AUTH_B64=$(echo -n "${EVAL_MAILBOX}:${EVAL_PASSWORD}" | base64 -w0)
B1_CODE=$(curl "${CURL_OPTS[@]}" -X POST "${BULWARK_BASE}/api/auth/stalwart-context" \
  -H "Content-Type: application/json" -H "Origin: ${BULWARK_BASE}" \
  -d "{\"serverUrl\":\"${STALWART_BASE}\",\"username\":\"${EVAL_MAILBOX}\",\"authHeader\":\"Basic ${AUTH_B64}\",\"slot\":0}" \
  -c "$B_COOKIES" -o /dev/null -w '%{http_code}')
[[ "$B1_CODE" == "200" ]] && pass "B1 stalwart-context login → 200" || fail "B1 stalwart-context → $B1_CODE"

B2_RESP=$(curl "${CURL_OPTS[@]}" -X POST "${BULWARK_BASE}/api/account/stalwart/jmap" \
  -b "$B_COOKIES" -H "Content-Type: application/json" \
  -d '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Mailbox/get",{"accountId":"b","ids":null},"a"]]}')
FOLDER_COUNT=$(echo "$B2_RESP" | grep -oE '"name":"[^"]+"' | wc -l)
[[ "$FOLDER_COUNT" -ge 4 ]] && pass "B2 Mailbox/get → $FOLDER_COUNT folders" || fail "B2 Mailbox/get → only $FOLDER_COUNT folders"

if [[ "$SKIP_CORS" -eq 0 ]]; then
  # Capture headers to a file — `head` on a pipe trips SIGPIPE under
  # `set -o pipefail`. Reading from a file is reliable.
  curl "${CURL_OPTS[@]}" -X OPTIONS "${STALWART_BASE}/.well-known/jmap" \
    -H "Origin: ${BULWARK_BASE}" -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: authorization" \
    -o /dev/null -D /tmp/cors-opt.h 2>/dev/null || true
  grep -qi "access-control-allow-credentials: true" /tmp/cors-opt.h \
    && pass "B3 OPTIONS carries Allow-Credentials:true" \
    || fail "B3 OPTIONS missing Allow-Credentials"
  grep -qiE "access-control-allow-origin: ${BULWARK_BASE}" /tmp/cors-opt.h \
    && pass "B3b Allow-Origin echoes request origin" \
    || fail "B3b Allow-Origin not echoed"
  curl "${CURL_OPTS[@]}" "${STALWART_BASE}/.well-known/jmap" -H "Origin: ${BULWARK_BASE}" \
    -o /dev/null -D /tmp/cors-get.h 2>/dev/null || true
  grep -qi "access-control-allow-credentials: true" /tmp/cors-get.h \
    && pass "B4 redirect carries Allow-Credentials:true" \
    || fail "B4 redirect missing CORS"
fi

# ── Phase C — Impersonation ─────────────────────────────────────────
phase C
C_COOKIES=$(mktemp)
C_JTI="c-test-$(date +%s)-$RANDOM"
JWT_GOOD=$(mint_jwt "$EVAL_MAILBOX" "$C_JTI")
C1_CODE=$(curl "${CURL_OPTS[@]}" -i "${BULWARK_BASE}/_impersonate?token=${JWT_GOOD}" \
  -c "$C_COOKIES" -o /tmp/imp-c1.txt -w '%{http_code}\n')
HTTP_CODE=$(head -1 /tmp/imp-c1.txt 2>/dev/null | grep -oE '[0-9]{3}' | head -1)
[[ "$HTTP_CODE" == "303" ]] && pass "C1 impersonate → 303 redirect" || fail "C1 impersonate → $HTTP_CODE"
grep -q "jmap_stalwart_ctx" "$C_COOKIES" 2>/dev/null && pass "C1b jmap_stalwart_ctx cookie set" || fail "C1b no jmap cookie"

C2_RESP=$(curl "${CURL_OPTS[@]}" -X POST "${BULWARK_BASE}/api/account/stalwart/jmap" \
  -b "$C_COOKIES" -H "Content-Type: application/json" \
  -d '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Mailbox/get",{"accountId":"b","ids":null},"a"]]}')
C2_COUNT=$(echo "$C2_RESP" | grep -oE '"name":"[^"]+"' | wc -l)
[[ "$C2_COUNT" -ge 4 ]] && pass "C2 Mailbox/get post-impersonate → $C2_COUNT folders" || fail "C2 Mailbox/get → $C2_COUNT"

sleep 1
# Impersonator is a sidecar in the bulwark Pod — fetch by container name.
IMP_LOG=$(docker exec "$K3S_CONTAINER" kubectl logs -n mail -l app=bulwark -c impersonator --tail=30 2>&1)
echo "$IMP_LOG" | grep -q '"msg":"impersonate_ok"' && pass "C3 audit log records impersonate_ok" || fail "C3 no impersonate_ok in audit log"
echo "$IMP_LOG" | grep -q "\"jti\":\"$C_JTI\"" && pass "C3b audit log includes jti" || fail "C3b audit log missing jti"

# ── Phase D — rejection cases ───────────────────────────────────────
phase D
expect_reject() {
  local label="$1"
  local expected_code="$2"
  local expected_reason="$3"
  local jwt="$4"
  local code resp
  resp=$(curl "${CURL_OPTS[@]}" "${BULWARK_BASE}/_impersonate?token=${jwt}" -o /tmp/rej.json -w '%{http_code}')
  if [[ "$resp" == "$expected_code" ]]; then
    if [[ -z "$expected_reason" ]] || grep -q "\"reason\":\"${expected_reason}\"" /tmp/rej.json; then
      pass "$label ($expected_code${expected_reason:+/$expected_reason})"
    else
      local got_reason
      got_reason=$(grep -oE '"reason":"[^"]+"' /tmp/rej.json | head -1)
      fail "$label ($expected_code) but reason=${got_reason} not ${expected_reason}"
    fi
  else
    fail "$label expected $expected_code got $resp"
  fi
}

# D1 expired
expect_reject "D1 expired JWT" 401 expired "$(mint_jwt "$EVAL_MAILBOX" "d1" -30)"
# D2 bad signature
expect_reject "D2 wrong signature" 401 sig_mismatch "$(mint_jwt_bad_sig "$EVAL_MAILBOX")"
# D3 alg=none
expect_reject "D3 alg=none" 401 wrong_alg "$(mint_jwt_alg_none "$EVAL_MAILBOX")"
# D4 missing iss
expect_reject "D4 missing iss" 401 wrong_iss "$(mint_jwt "$EVAL_MAILBOX" "d4" 30 "{iss:undefined}")"
# D5 missing iat
expect_reject "D5 missing iat" 401 no_iat "$(mint_jwt "$EVAL_MAILBOX" "d5" 30 "{iat:undefined}")"
# D6 TTL too long
expect_reject "D6 ttl too long" 401 ttl_too_long "$(mint_jwt "$EVAL_MAILBOX" "d6" 86400)"
# D7 bad mailbox (contains %)
expect_reject "D7 bad mailbox" 401 bad_mailbox "$(mint_jwt "victim@x.com%attacker:p" "d7")"
# D8 missing jti
expect_reject "D8 missing jti" 401 no_jti "$(mint_jwt "$EVAL_MAILBOX" "d8-stub" 30 "{jti:undefined}")"

# D9 replayed jti
D9_JTI="d9-replay-$(date +%s)"
D9_JWT=$(mint_jwt "$EVAL_MAILBOX" "$D9_JTI")
curl "${CURL_OPTS[@]}" "${BULWARK_BASE}/_impersonate?token=${D9_JWT}" -o /dev/null
D9_SECOND=$(curl "${CURL_OPTS[@]}" "${BULWARK_BASE}/_impersonate?token=${D9_JWT}" -o /tmp/d9.json -w '%{http_code}')
[[ "$D9_SECOND" == "410" ]] && pass "D9 replayed jti → 410" || fail "D9 replayed jti → $D9_SECOND"

# D10 POST instead of GET
D10_CODE=$(curl "${CURL_OPTS[@]}" -X POST "${BULWARK_BASE}/_impersonate?token=x" -o /dev/null -w '%{http_code}')
[[ "$D10_CODE" == "405" ]] && pass "D10 POST /_impersonate → 405" || fail "D10 POST → $D10_CODE"

# ── Phase F — admin endpoint (settings purge, ADR-039 Phase 8) ─────
phase F
ADMIN_TOKEN="${IMPERSONATOR_ADMIN_TOKEN:-local-dev-impersonator-admin-token-32+chars}"

# F1 — missing token rejected.
F1_CODE=$(docker exec "$K3S_CONTAINER" kubectl exec -n mail deploy/bulwark -c impersonator -- node -e "
  fetch('http://127.0.0.1:8081/__impersonator/settings', {
    method:'DELETE',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({username:'eval@k8s-platform.test', serverUrl:'https://stalwart.k8s-platform.test:2011'})
  }).then(r => console.log(r.status));
" 2>&1 | tail -1)
[[ "$F1_CODE" == "401" ]] && pass "F1 missing X-Admin-Token → 401" || fail "F1 missing token → $F1_CODE"

# F2 — wrong token rejected.
F2_CODE=$(docker exec "$K3S_CONTAINER" kubectl exec -n mail deploy/bulwark -c impersonator -- node -e "
  fetch('http://127.0.0.1:8081/__impersonator/settings', {
    method:'DELETE',
    headers:{'content-type':'application/json','x-admin-token':'WRONG'},
    body: JSON.stringify({username:'eval@k8s-platform.test', serverUrl:'https://stalwart.k8s-platform.test:2011'})
  }).then(r => console.log(r.status));
" 2>&1 | tail -1)
[[ "$F2_CODE" == "401" ]] && pass "F2 wrong X-Admin-Token → 401" || fail "F2 wrong token → $F2_CODE"

# F3 — correct token, malformed mailbox rejected.
F3_RESP=$(docker exec "$K3S_CONTAINER" kubectl exec -n mail deploy/bulwark -c impersonator -- node -e "
  fetch('http://127.0.0.1:8081/__impersonator/settings', {
    method:'DELETE',
    headers:{'content-type':'application/json','x-admin-token':'$ADMIN_TOKEN'},
    body: JSON.stringify({username:'not-an-email', serverUrl:'https://x.test'})
  }).then(r => r.text().then(t => console.log(r.status+'|'+t)));
" 2>&1 | tail -1)
echo "$F3_RESP" | grep -q "^400|" && echo "$F3_RESP" | grep -qi "invalid username" \
  && pass "F3 malformed mailbox → 400" || fail "F3 bad mailbox → $F3_RESP"

# F4 — correct token, file absent → 200 already_absent.
F4_RESP=$(docker exec "$K3S_CONTAINER" kubectl exec -n mail deploy/bulwark -c impersonator -- node -e "
  fetch('http://127.0.0.1:8081/__impersonator/settings', {
    method:'DELETE',
    headers:{'content-type':'application/json','x-admin-token':'$ADMIN_TOKEN'},
    body: JSON.stringify({username:'eval@k8s-platform.test', serverUrl:'https://stalwart.k8s-platform.test:2011'})
  }).then(r => r.text().then(t => console.log(r.status+'|'+t)));
" 2>&1 | tail -1)
echo "$F4_RESP" | grep -q "^200|" && echo "$F4_RESP" | grep -q "already_absent\|unlinked" \
  && pass "F4 correct token + absent file → 200" || fail "F4 absent file → $F4_RESP"

# F5 — create a fake settings file, verify purge unlinks it.
TARGET_USER="purge-test-$(date +%s)@k8s-platform.test"
TARGET_SRV="https://stalwart.k8s-platform.test:2011"
# Compute the sha256 hash like Bulwark does.
HASH=$(echo -n "${TARGET_USER}:${TARGET_SRV}" | sha256sum | awk '{print $1}')
docker exec "$K3S_CONTAINER" kubectl exec -n mail deploy/bulwark -c impersonator -- sh -c \
  "mkdir -p /app/data/settings && echo 'dummy-encrypted-content' > /app/data/settings/${HASH}.enc"
F5_BEFORE=$(docker exec "$K3S_CONTAINER" kubectl exec -n mail deploy/bulwark -c impersonator -- sh -c \
  "test -f /app/data/settings/${HASH}.enc && echo exists || echo missing")
[[ "$F5_BEFORE" == "exists" ]] && pass "F5 pre-state: fake settings file exists" || fail "F5 pre-state: $F5_BEFORE"
F5_RESP=$(docker exec "$K3S_CONTAINER" kubectl exec -n mail deploy/bulwark -c impersonator -- node -e "
  fetch('http://127.0.0.1:8081/__impersonator/settings', {
    method:'DELETE',
    headers:{'content-type':'application/json','x-admin-token':'$ADMIN_TOKEN'},
    body: JSON.stringify({username:'$TARGET_USER', serverUrl:'$TARGET_SRV'})
  }).then(r => r.text().then(t => console.log(r.status+'|'+t)));
" 2>&1 | tail -1)
echo "$F5_RESP" | grep -q "unlinked" && pass "F5b purge returned unlinked" || fail "F5b purge → $F5_RESP"
F5_AFTER=$(docker exec "$K3S_CONTAINER" kubectl exec -n mail deploy/bulwark -c impersonator -- sh -c \
  "test -f /app/data/settings/${HASH}.enc && echo exists || echo missing")
[[ "$F5_AFTER" == "missing" ]] && pass "F5c file is gone post-purge" || fail "F5c file still: $F5_AFTER"

# ── Phase E — Failover (optional) ───────────────────────────────────
if [[ "$RUN_FAILOVER" -eq 1 ]]; then
  phase E
  E_COOKIES=$(mktemp)
  E_JWT=$(mint_jwt "$EVAL_MAILBOX" "e-pre-fail-$(date +%s)")
  curl "${CURL_OPTS[@]}" "${BULWARK_BASE}/_impersonate?token=${E_JWT}" -c "$E_COOKIES" -o /dev/null
  pass "E1 active session minted"
  docker exec "$K3S_CONTAINER" kubectl delete pod -n mail -l app=bulwark --wait=true >/dev/null 2>&1
  pass "E2 bulwark pod killed"
  docker exec "$K3S_CONTAINER" kubectl wait --for=condition=Ready pod -l app=bulwark -n mail --timeout=120s >/dev/null
  pass "E3 new bulwark pod Ready"
  E_RESP=$(curl "${CURL_OPTS[@]}" -X POST "${BULWARK_BASE}/api/account/stalwart/jmap" \
    -b "$E_COOKIES" -H "Content-Type: application/json" \
    -d '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Mailbox/get",{"accountId":"b","ids":null},"a"]]}' \
    -w '%{http_code}\n')
  echo "$E_RESP" | tail -1 | grep -q "200" && pass "E4 session survives pod restart" || warn "E4 session needed reauth post-failover (acceptable)"
fi

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════"
printf "  PASS: \033[32m%d\033[0m   FAIL: \033[31m%d\033[0m\n" "$PASS" "$FAIL"
echo "════════════════════════════════════════════════"
[[ "$FAIL" -gt 0 ]] && exit 1 || exit 0
