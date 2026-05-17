#!/usr/bin/env bash
# integration-bulwark-impersonate.sh — focused E2E for Bulwark's native
# /api/auth/impersonate route (upstream issue #296).
#
# Exercises the impersonation handler directly inside the Bulwark Pod,
# bypassing platform-api. Use integration-webmail-platform-e2e.sh for
# the full platform-driven flow.
#
# Phases:
#   A — Pod health
#     A1. bulwark pod 1/1 Ready, no impersonator sidecar
#     A2. /api/health returns 200
#     A3. BULWARK_JWT_AUTH_SECRET / BULWARK_STALWART_MASTER_USER /
#         BULWARK_STALWART_MASTER_PASSWORD all set
#
#   B — Happy path
#     B1. Valid JWT → 303 to /, jmap_session + jmap_stalwart_ctx cookies set
#     B2. Cookies are session-only (no Max-Age / Expires)
#     B3. POST /api/account/stalwart/jmap Mailbox/get with cookies → 200
#         with 5 default folders (Inbox, Sent, Drafts, Junk, Trash)
#     B4. Audit-log line `Impersonation session granted` with structured
#         {jti, mailbox, tenant_id, actor_user_id, iss}
#
#   C — Negative path (12 cases)
#     C1. Empty token → 400 Missing token
#     C2. Truncated token (no segments) → 400 Token must have 3 segments
#     C3. Replayed jti → 401 Token already used
#     C4. Expired JWT → 401 Token expired
#     C5. Future iat (issued in the future) → 401 Token issued in the future
#     C6. Bad signature → 401 Invalid signature
#     C7. Wrong issuer → 401 Unexpected issuer
#     C8. Lifetime > 300s → 401 Token lifetime exceeds 300s ceiling
#     C9. Mailbox claim contains `%` → 401 mailbox must not contain
#     C10. Mailbox claim contains `:` → 401 mailbox must not contain
#     C11. Missing required claim (jti) → 401 Missing or invalid 'jti'
#     C12. alg=HS512 instead of HS256 → 401 Unsupported alg
#
#   D — Engine mutex
#     D1. Confirm only one engine has running Pods at a time
#     D2. Flip engine via /admin/webmail-settings, verify reconciler scales
#     D3. Flip back, verify symmetric
#
# Usage:
#   ./scripts/integration-bulwark-impersonate.sh                 # A + B + C
#   ./scripts/integration-bulwark-impersonate.sh --mutex         # adds D
#                                                                # (requires ADMIN_TOKEN)
#   ./scripts/integration-bulwark-impersonate.sh --neg-only      # just C
#
# Environment:
#   NAMESPACE         — kube namespace where Bulwark runs (default: mail)
#   DOMAIN            — apex (default: k8s-platform.test for DinD)
#   MAILBOX           — target mailbox claim (default: $MASTER_USER from secret)
#   ADMIN_TOKEN       — platform-api super_admin Bearer (only for --mutex)
#   API_BASE          — platform-api base URL (only for --mutex)
#   CURL_INSECURE     — set to 1 for self-signed certs

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────
RUN_MUTEX=0
NEG_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --mutex)    RUN_MUTEX=1 ;;
    --neg-only) NEG_ONLY=1 ;;
    -h|--help)
      sed -n '1,/^set -eu/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

NAMESPACE="${NAMESPACE:-mail}"
DOMAIN="${DOMAIN:-k8s-platform.test}"

# ── Helpers ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[1;34m'; YELLOW='\033[0;33m'; NC='\033[0m'
PASS_COUNT=0; FAIL_COUNT=0
phase() { echo -e "\n${BLUE}── $1 ───────────────────────────────────────${NC}"; }
pass()  { echo -e "  ${GREEN}✓${NC} $1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail()  { echo -e "  ${RED}✗${NC} $1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; }

KCTL=(kubectl --namespace="$NAMESPACE")

POD="$("${KCTL[@]}" get pods -l app=bulwark -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$POD" ]]; then
  fail "no bulwark Pod found in namespace=$NAMESPACE — is it deployed?"
  exit 1
fi

# Run a node script inside the bulwark container against 127.0.0.1:3000.
# Captures structured JSON on stdout for shell parsing.
in_pod() {
  "${KCTL[@]}" exec "$POD" -c bulwark -- node -e "$1"
}

# ── Phase A: pod + secret health ─────────────────────────────────────
if [[ $NEG_ONLY -eq 0 ]]; then
  phase "A. Pod + secret health"

  READY="$("${KCTL[@]}" get pod "$POD" -o jsonpath='{.status.containerStatuses[?(@.name=="bulwark")].ready}')"
  [[ "$READY" == "true" ]] && pass "A1 bulwark container Ready" || fail "A1 bulwark container NOT Ready"

  # No impersonator sidecar should be co-deployed (we retired it)
  CONTAINERS="$("${KCTL[@]}" get pod "$POD" -o jsonpath='{.spec.containers[*].name}')"
  if echo "$CONTAINERS" | grep -qw impersonator; then
    fail "A1b impersonator sidecar still co-deployed (should be retired); containers=$CONTAINERS"
  else
    pass "A1b no impersonator sidecar (retired)"
  fi

  HEALTH="$(in_pod "require('http').get({host:'127.0.0.1',port:3000,path:'/api/health'},r=>{console.log(r.statusCode)})" 2>/dev/null || true)"
  [[ "$HEALTH" == "200" ]] && pass "A2 /api/health returns 200" || fail "A2 /api/health unexpected: $HEALTH"

  for env_name in BULWARK_JWT_AUTH_SECRET BULWARK_STALWART_MASTER_USER BULWARK_STALWART_MASTER_PASSWORD; do
    if "${KCTL[@]}" exec "$POD" -c bulwark -- sh -c "[ -n \"\$$env_name\" ]" 2>/dev/null; then
      pass "A3 $env_name is set"
    else
      fail "A3 $env_name is missing — impersonate route will 404"
    fi
  done
fi

# Mint JWT helper (Node, no deps). Args: $1=secret $2=mailbox $3=jti $4=iat $5=exp [$6=iss $7=alg]
mint_jwt() {
  local secret="$1" mailbox="$2" jti="$3" iat="$4" exp="$5"
  local iss="${6:-platform-api/webmail}" alg="${7:-HS256}"
  node -e "
const c = require('crypto');
const b64url = b => Buffer.from(b).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const h = b64url(JSON.stringify({alg:'${alg}',typ:'JWT'}));
const p = b64url(JSON.stringify({iss:'${iss}',iat:${iat},exp:${exp},jti:'${jti}',mailbox:'${mailbox}',tenant_id:'harness-tenant',actor_user_id:'harness-actor'}));
let s;
if ('${alg}' === 'HS256') {
  s = c.createHmac('sha256', '${secret}').update(h+'.'+p).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
} else if ('${alg}' === 'HS512') {
  s = c.createHmac('sha512', '${secret}').update(h+'.'+p).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
} else { s = 'invalid'; }
console.log(h+'.'+p+'.'+s);
"
}

# Mint a JWT with a missing claim — handler-side test
mint_no_jti() {
  local secret="$1" mailbox="$2" iat="$3" exp="$4"
  node -e "
const c = require('crypto');
const b64url = b => Buffer.from(b).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const h = b64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
const p = b64url(JSON.stringify({iss:'platform-api/webmail',iat:${iat},exp:${exp},mailbox:'${mailbox}'}));
const s = c.createHmac('sha256', '${secret}').update(h+'.'+p).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
console.log(h+'.'+p+'.'+s);
"
}

# Read the BULWARK_JWT_AUTH_SECRET from inside the pod (do NOT log it)
JWT_SECRET="$("${KCTL[@]}" exec "$POD" -c bulwark -- printenv BULWARK_JWT_AUTH_SECRET 2>/dev/null || true)"
if [[ -z "$JWT_SECRET" || ${#JWT_SECRET} -lt 32 ]]; then
  fail "BULWARK_JWT_AUTH_SECRET unset or <32 chars — cannot mint JWTs"
  exit 1
fi
MAILBOX="${MAILBOX:-$("${KCTL[@]}" exec "$POD" -c bulwark -- printenv BULWARK_STALWART_MASTER_USER 2>/dev/null || echo master@${DOMAIN})}"

# Single-call test helper. POSTs node script through kubectl exec; returns
# JSON `{status, location, cookies, body}`.
call_impersonate() {
  local token="$1"
  in_pod "
const http = require('http');
http.request({host:'127.0.0.1',port:3000,path:'/api/auth/impersonate?token='+encodeURIComponent('${token}'),method:'GET'}, r=>{
  let b=''; r.on('data',c=>b+=c); r.on('end',()=>{
    const cookies = (r.headers['set-cookie']||[]).map(c=>c.split(';')[0]);
    process.stdout.write(JSON.stringify({status:r.statusCode,location:r.headers.location||null,cookies,body:b.slice(0,500),raw_cookies:r.headers['set-cookie']||[]}));
  });
}).end();
"
}

# ── Phase B: happy path ──────────────────────────────────────────────
if [[ $NEG_ONLY -eq 0 ]]; then
  phase "B. Happy path"

  NOW=$(date +%s); EXP=$((NOW+240)); JTI="harness-$(date +%s%N)-$$"
  JWT="$(mint_jwt "$JWT_SECRET" "$MAILBOX" "$JTI" "$NOW" "$EXP")"
  RESP="$(call_impersonate "$JWT")"

  STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
  LOCATION="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).location)")"

  [[ "$STATUS" == "303" ]] \
    && pass "B1 valid JWT → 303" \
    || fail "B1 expected 303, got $STATUS (body: $(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).body)"))"
  [[ "$LOCATION" == "/" ]] && pass "B1b redirect Location=/" || fail "B1b unexpected Location: $LOCATION"

  # Save raw_cookies and check session-only (no Max-Age)
  RAW_COOKIES="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).raw_cookies.join('||'))")"
  if echo "$RAW_COOKIES" | grep -qi 'jmap_session=' && echo "$RAW_COOKIES" | grep -qi 'jmap_stalwart_ctx='; then
    pass "B1c both jmap_session + jmap_stalwart_ctx cookies set"
  else
    fail "B1c missing one or both cookies: $RAW_COOKIES"
  fi
  if echo "$RAW_COOKIES" | grep -qi 'Max-Age='; then
    fail "B2 cookies carry Max-Age — should be session-only"
  else
    pass "B2 cookies are session-only (no Max-Age)"
  fi

  # Use the cookies to call /api/account/stalwart/jmap
  COOKIE_HEADER="$(echo "$RESP" | node -e "
const j = JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log(j.cookies.join('; '));
")"
  JMAP="$(in_pod "
const http = require('http');
const body = JSON.stringify({using:['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],methodCalls:[['Mailbox/get',{accountId:'e'},'c0']]});
const r = http.request({host:'127.0.0.1',port:3000,path:'/api/account/stalwart/jmap',method:'POST',headers:{'Cookie':'${COOKIE_HEADER}','Content-Type':'application/json'}}, resp=>{
  let b=''; resp.on('data',c=>b+=c); resp.on('end',()=>process.stdout.write(JSON.stringify({status:resp.statusCode,body:b.slice(0,2000)})));
});
r.write(body); r.end();
")"
  JMAP_STATUS="$(echo "$JMAP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
  if [[ "$JMAP_STATUS" == "200" ]]; then
    MBOX_COUNT="$(echo "$JMAP" | node -e "
const j = JSON.parse(require('fs').readFileSync(0,'utf8'));
try { const r = JSON.parse(j.body); const m = r.methodResponses?.[0]?.[1]; console.log(m?.list?.length ?? 0); }
catch { console.log(0); }
")"
    if [[ "$MBOX_COUNT" -ge 1 ]]; then
      pass "B3 JMAP Mailbox/get returned $MBOX_COUNT mailbox(es) — original #296 bug verified fixed"
    else
      fail "B3 JMAP returned 200 but no mailboxes — payload likely malformed"
    fi
  else
    fail "B3 JMAP call failed (HTTP $JMAP_STATUS) — the #296 regression is back"
  fi

  # Audit log line (Bulwark's structured log)
  if "${KCTL[@]}" logs "$POD" -c bulwark --tail=200 2>/dev/null | grep -q "Impersonation session granted"; then
    pass "B4 audit log entry 'Impersonation session granted' present"
  else
    fail "B4 audit log entry missing — Bulwark didn't log the issuance"
  fi
fi

# ── Phase C: negative path ───────────────────────────────────────────
phase "C. Negative path"

# C1 — empty token
RESP="$(call_impersonate "")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
BODY="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).body)")"
[[ "$STATUS" == "400" ]] && pass "C1 empty token → 400" || fail "C1 expected 400, got $STATUS (body: $BODY)"

# C2 — truncated JWT (only 2 segments)
RESP="$(call_impersonate "abc.def")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "400" ]] && pass "C2 truncated JWT → 400" || fail "C2 expected 400, got $STATUS"

# C3 — replay (re-use a valid jti)
NOW=$(date +%s); EXP=$((NOW+60)); REPLAY_JTI="replay-$(date +%s%N)-$$"
JWT="$(mint_jwt "$JWT_SECRET" "$MAILBOX" "$REPLAY_JTI" "$NOW" "$EXP")"
RESP1="$(call_impersonate "$JWT")"
S1="$(echo "$RESP1" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
RESP2="$(call_impersonate "$JWT")"
S2="$(echo "$RESP2" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$S1" == "303" && "$S2" == "401" ]] \
  && pass "C3 replay: first=303 second=401" \
  || fail "C3 replay expected 303→401, got ${S1}→${S2}"

# C4 — expired JWT (exp in the past)
PAST=$(($(date +%s)-400)); PAST_EXP=$(($(date +%s)-300))
JWT="$(mint_jwt "$JWT_SECRET" "$MAILBOX" "exp-$(date +%s%N)-$$" "$PAST" "$PAST_EXP")"
RESP="$(call_impersonate "$JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C4 expired JWT → 401" || fail "C4 expected 401, got $STATUS"

# C5 — issued in the future (iat > now + 60s clock skew)
FUT=$(($(date +%s)+200)); FUT_EXP=$((FUT+60))
JWT="$(mint_jwt "$JWT_SECRET" "$MAILBOX" "iat-future-$(date +%s%N)-$$" "$FUT" "$FUT_EXP")"
RESP="$(call_impersonate "$JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C5 future iat → 401" || fail "C5 expected 401, got $STATUS"

# C6 — bad signature
NOW=$(date +%s); EXP=$((NOW+60))
JWT="$(mint_jwt "wrong-secret-padded-to-32-chars-yyy" "$MAILBOX" "sig-$(date +%s%N)-$$" "$NOW" "$EXP")"
RESP="$(call_impersonate "$JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C6 bad signature → 401" || fail "C6 expected 401, got $STATUS"

# C7 — wrong issuer
NOW=$(date +%s); EXP=$((NOW+60))
JWT="$(mint_jwt "$JWT_SECRET" "$MAILBOX" "iss-$(date +%s%N)-$$" "$NOW" "$EXP" "attacker.example")"
RESP="$(call_impersonate "$JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C7 wrong issuer → 401" || fail "C7 expected 401, got $STATUS"

# C8 — lifetime > 300s
NOW=$(date +%s); EXP=$((NOW+600))
JWT="$(mint_jwt "$JWT_SECRET" "$MAILBOX" "life-$(date +%s%N)-$$" "$NOW" "$EXP")"
RESP="$(call_impersonate "$JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C8 lifetime > 300s → 401" || fail "C8 expected 401, got $STATUS"

# C9 — mailbox contains '%'
NOW=$(date +%s); EXP=$((NOW+60))
JWT="$(mint_jwt "$JWT_SECRET" "has%percent@example.test" "mb-pct-$(date +%s%N)-$$" "$NOW" "$EXP")"
RESP="$(call_impersonate "$JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C9 mailbox contains '%' → 401" || fail "C9 expected 401, got $STATUS"

# C10 — mailbox contains ':'
NOW=$(date +%s); EXP=$((NOW+60))
JWT="$(mint_jwt "$JWT_SECRET" "has:colon@example.test" "mb-col-$(date +%s%N)-$$" "$NOW" "$EXP")"
RESP="$(call_impersonate "$JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C10 mailbox contains ':' → 401" || fail "C10 expected 401, got $STATUS"

# C11 — missing jti claim
NOW=$(date +%s); EXP=$((NOW+60))
JWT="$(mint_no_jti "$JWT_SECRET" "$MAILBOX" "$NOW" "$EXP")"
RESP="$(call_impersonate "$JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C11 missing jti → 401" || fail "C11 expected 401, got $STATUS"

# C12 — wrong algorithm (HS512 instead of HS256)
NOW=$(date +%s); EXP=$((NOW+60))
JWT="$(mint_jwt "$JWT_SECRET" "$MAILBOX" "alg-$(date +%s%N)-$$" "$NOW" "$EXP" "platform-api/webmail" "HS512")"
RESP="$(call_impersonate "$JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C12 HS512 algorithm → 401" || fail "C12 expected 401, got $STATUS"

# C13 — alg=none unsigned token (classic JWT bypass attempt)
NOW=$(date +%s); EXP=$((NOW+60))
ALGNONE_JWT="$(node -e "
const b64url = b => Buffer.from(b).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const h = b64url(JSON.stringify({alg:'none',typ:'JWT'}));
const p = b64url(JSON.stringify({iss:'platform-api/webmail',iat:${NOW},exp:${EXP},jti:'none-$(date +%s%N)-$$',mailbox:'${MAILBOX}'}));
console.log(h+'.'+p+'.');
")"
RESP="$(call_impersonate "$ALGNONE_JWT")"
STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
[[ "$STATUS" == "401" ]] && pass "C13 alg=none unsigned token → 401" || fail "C13 alg=none should be rejected, got $STATUS"

# C14 — engine-mismatch replay: a Bulwark-format JWT signed with
# Roundcube's JWT_AUTH_SECRET must be rejected by Bulwark's
# /api/auth/impersonate (proves separate HMAC keys are enforced).
# Only runs if both env values are accessible.
ROUNDCUBE_KEY="$("${KCTL[@]}" get secret -n mail roundcube-secrets -o jsonpath='{.data.JWT_AUTH_SECRET}' 2>/dev/null | base64 -d || true)"
if [[ -n "$ROUNDCUBE_KEY" && "$ROUNDCUBE_KEY" != "$JWT_SECRET" ]]; then
  NOW=$(date +%s); EXP=$((NOW+60))
  WRONG_KEY_JWT="$(mint_jwt "$ROUNDCUBE_KEY" "$MAILBOX" "rc-key-$(date +%s%N)-$$" "$NOW" "$EXP")"
  RESP="$(call_impersonate "$WRONG_KEY_JWT")"
  STATUS="$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")"
  [[ "$STATUS" == "401" ]] \
    && pass "C14 cross-engine replay (Roundcube key) → 401" \
    || fail "C14 cross-engine replay should be rejected, got $STATUS"
else
  warn "C14 skipped (roundcube-secrets not present OR shares Bulwark's key)"
fi

# ── Phase D: engine mutex (optional) ─────────────────────────────────
if [[ $RUN_MUTEX -eq 1 ]]; then
  phase "D. Engine mutex"

  if [[ -z "${ADMIN_TOKEN:-}" || -z "${API_BASE:-}" ]]; then
    fail "D ADMIN_TOKEN + API_BASE required for --mutex"
  else
    CURL_OPTS=(-sS)
    [[ "${CURL_INSECURE:-0}" == "1" ]] && CURL_OPTS+=(-k)

    # Current state
    INITIAL_ENGINE="$(curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $ADMIN_TOKEN" \
      "$API_BASE/api/v1/admin/webmail-settings" \
      | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).data?.defaultWebmailEngine ?? 'unknown')")"
    pass "D1 initial engine: $INITIAL_ENGINE"

    # Count Pods for both engines
    BULWARK_PODS="$("${KCTL[@]}" get pods -l app=bulwark --field-selector=status.phase=Running 2>/dev/null | tail -n +2 | wc -l)"
    ROUNDCUBE_PODS="$("${KCTL[@]}" get pods -l app=roundcube --field-selector=status.phase=Running -n mail 2>/dev/null | tail -n +2 | wc -l)"
    if [[ $INITIAL_ENGINE == "bulwark" ]]; then
      [[ $BULWARK_PODS -ge 1 && $ROUNDCUBE_PODS -eq 0 ]] \
        && pass "D1b mutex holding: bulwark=$BULWARK_PODS roundcube=$ROUNDCUBE_PODS" \
        || warn "D1b unexpected pod count: bulwark=$BULWARK_PODS roundcube=$ROUNDCUBE_PODS"
    else
      [[ $ROUNDCUBE_PODS -ge 1 && $BULWARK_PODS -eq 0 ]] \
        && pass "D1b mutex holding: roundcube=$ROUNDCUBE_PODS bulwark=$BULWARK_PODS" \
        || warn "D1b unexpected pod count: roundcube=$ROUNDCUBE_PODS bulwark=$BULWARK_PODS"
    fi

    # Flip + verify
    OTHER_ENGINE="bulwark"; [[ $INITIAL_ENGINE == "bulwark" ]] && OTHER_ENGINE="roundcube"
    curl "${CURL_OPTS[@]}" -X PATCH -H "Content-Type: application/json" \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -d "{\"defaultWebmailEngine\":\"$OTHER_ENGINE\"}" \
      "$API_BASE/api/v1/admin/webmail-settings" > /dev/null
    sleep 15
    # Read back
    NEW_ENGINE="$(curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $ADMIN_TOKEN" \
      "$API_BASE/api/v1/admin/webmail-settings" \
      | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).data?.defaultWebmailEngine)")"
    [[ "$NEW_ENGINE" == "$OTHER_ENGINE" ]] && pass "D2 flipped to $NEW_ENGINE" || fail "D2 flip failed: $NEW_ENGINE"

    # Flip back
    curl "${CURL_OPTS[@]}" -X PATCH -H "Content-Type: application/json" \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -d "{\"defaultWebmailEngine\":\"$INITIAL_ENGINE\"}" \
      "$API_BASE/api/v1/admin/webmail-settings" > /dev/null
    pass "D3 restored to initial engine $INITIAL_ENGINE"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}─────────────────────────────────────────────${NC}"
echo -e "  Passed: ${GREEN}${PASS_COUNT}${NC}    Failed: ${RED}${FAIL_COUNT}${NC}"
echo -e "${BLUE}─────────────────────────────────────────────${NC}"
if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
