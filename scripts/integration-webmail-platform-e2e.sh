#!/usr/bin/env bash
# integration-webmail-platform-e2e.sh — platform-driven webmail E2E.
#
# Unlike integration-bulwark-e2e.sh which targets a pre-seeded eval mailbox
# in DinD, this harness exercises the full provisioning flow against ANY
# cluster (local DinD, staging, testing apex, production) by driving the
# platform-api directly:
#
#   1. Admin login → JWT
#   2. POST /api/v1/clients         → create test client
#   3. POST /api/v1/clients/:id/domains
#                                   → attach a test domain (no DNS check)
#   4. POST /api/v1/clients/:id/email/domains/:domainId/enable
#                                   → enable mail for the domain
#   5. POST /api/v1/clients/:id/email/domains/:emailDomainId/mailboxes
#                                   → create a mailbox + password
#   6. GET  /api/v1/admin/webmail-settings
#                                   → confirm active engine
#   7. POST /api/v1/admin/impersonate/:id
#                                   → mint a client_admin JWT
#   8. POST /api/v1/email/webmail-token  (as client_admin)
#                                   → engine-shaped URL
#   9. Validate URL shape:
#       roundcube → webmail.<apex>/?_task=login&_jwt=<jwt>  OR
#                   webmail.<clientdomain>/?_task=login&_jwt=<jwt>
#       bulwark   → webmail.<apex>/_impersonate?token=<jwt>
#  10. GET <webmailUrl>             → expect 303 + jmap_stalwart_ctx
#                                     cookie (bulwark) or 200 (roundcube)
#  11. Cleanup: DELETE /api/v1/clients/:id (cascades mailboxes + domains)
#
# Engine is read from the platform setting — flip ahead of time via
# PATCH /admin/webmail-settings {"defaultWebmailEngine":"bulwark"} or
# through the admin panel UI.
#
# Usage:
#   API_BASE=https://admin.testing.phoenix-host.net \
#   ADMIN_EMAIL=admin@testing.phoenix-host.net \
#   ADMIN_PASSWORD=... \
#   TEST_DOMAIN=harness-$(date +%s).success.com.na \
#   ./scripts/integration-webmail-platform-e2e.sh
#
# Environment:
#   API_BASE         — platform-api base URL (default: https://admin.k8s-platform.test:2011)
#   ADMIN_EMAIL      — platform super_admin email
#   ADMIN_PASSWORD   — platform super_admin password
#   TEST_DOMAIN      — domain to attach (default: harness-$(date +%s).success.com.na)
#   SKIP_WEBMAIL_HIT — set to 1 to skip phase 10 (cert / connectivity issue)
#   CURL_INSECURE    — set to 1 to pass -k (self-signed certs)
set -euo pipefail

API_BASE="${API_BASE:-https://admin.k8s-platform.test:2011}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD env var required}"
TEST_DOMAIN="${TEST_DOMAIN:-harness-$(date +%s)-${RANDOM}.success.com.na}"
SKIP_WEBMAIL_HIT="${SKIP_WEBMAIL_HIT:-0}"

CURL_OPTS=(-sS -m 30)
[[ "${CURL_INSECURE:-0}" == "1" ]] && CURL_OPTS+=(-k)

PASS=0
FAIL=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
phase() { printf '\n\033[36m── %s ──\033[0m\n' "$*"; }

# Track resources to clean up on exit (even on failure).
CLIENT_ID=""
trap 'cleanup_on_exit' EXIT

cleanup_on_exit() {
  if [[ -n "$CLIENT_ID" && -n "${ADMIN_TOKEN:-}" ]]; then
    # Cleanup is slow — cascade deletes mailboxes, email-domains, DNS
    # records, etc. Give it 60s so a busy cluster doesn't bail mid-way.
    local opts=(-sS -m 60)
    [[ "${CURL_INSECURE:-0}" == "1" ]] && opts+=(-k)
    curl "${opts[@]}" -X DELETE "${API_BASE}/api/v1/clients/${CLIENT_ID}" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      -o /dev/null -w 'cleanup: client delete %{http_code}\n' || true
  fi
}

require_jq() { command -v jq >/dev/null || { echo 'jq is required'; exit 2; }; }
require_jq

# ── Phase 1: admin login ────────────────────────────────────────────
phase "1. Admin login"
LOGIN_RESP=$(curl "${CURL_OPTS[@]}" -X POST "${API_BASE}/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")
ADMIN_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.data.token // empty')
if [[ -z "$ADMIN_TOKEN" ]]; then
  fail "1.1 admin login — no token in response: $(echo "$LOGIN_RESP" | head -c 200)"
  exit 1
fi
pass "1.1 admin login → token issued"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl "${CURL_OPTS[@]}" -X "$method" "${API_BASE}${path}" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      -H 'content-type: application/json' \
      -d "$body"
  else
    curl "${CURL_OPTS[@]}" -X "$method" "${API_BASE}${path}" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}"
  fi
}

# ── Phase 2: create test client ─────────────────────────────────────
phase "2. Create client"
# Discover a plan + region. The API requires both as UUIDs at create time.
PLAN_ID=$(api GET /api/v1/plans | jq -r '.data[0].id // empty')
REGION_ID=$(api GET /api/v1/regions | jq -r '.data[0].id // empty')
[[ -z "$PLAN_ID"   ]] && { fail "2.0a no plans available"; exit 1; } || pass "2.0a discovered plan=${PLAN_ID}"
[[ -z "$REGION_ID" ]] && { fail "2.0b no regions available"; exit 1; } || pass "2.0b discovered region=${REGION_ID}"

CLIENT_RESP=$(api POST /api/v1/clients "{
  \"company_name\":\"Webmail E2E Harness\",
  \"company_email\":\"e2e-$(date +%s)@${TEST_DOMAIN}\",
  \"plan_id\":\"${PLAN_ID}\",
  \"region_id\":\"${REGION_ID}\"
}")
CLIENT_ID=$(echo "$CLIENT_RESP" | jq -r '.data.id // empty')
if [[ -z "$CLIENT_ID" ]]; then
  fail "2.1 create client failed: $(echo "$CLIENT_RESP" | head -c 300)"
  exit 1
fi
pass "2.1 client created (id=${CLIENT_ID})"

# ── Phase 3: attach domain ──────────────────────────────────────────
phase "3. Attach domain"
DOM_RESP=$(api POST "/api/v1/clients/${CLIENT_ID}/domains" "{
  \"domain_name\":\"${TEST_DOMAIN}\"
}")
DOMAIN_ID=$(echo "$DOM_RESP" | jq -r '.data.id // empty')
if [[ -z "$DOMAIN_ID" ]]; then
  fail "3.1 attach domain failed: $(echo "$DOM_RESP" | head -c 300)"
  exit 1
fi
pass "3.1 domain attached (${TEST_DOMAIN} id=${DOMAIN_ID})"

# ── Phase 4: enable email on domain ─────────────────────────────────
phase "4. Enable email on domain"
ENABLE_RESP=$(api POST "/api/v1/clients/${CLIENT_ID}/email/domains/${DOMAIN_ID}/enable" "{}")
EMAIL_DOMAIN_ID=$(echo "$ENABLE_RESP" | jq -r '.data.id // empty')
if [[ -z "$EMAIL_DOMAIN_ID" ]]; then
  fail "4.1 enable email failed: $(echo "$ENABLE_RESP" | head -c 300)"
  exit 1
fi
pass "4.1 email enabled (email_domain_id=${EMAIL_DOMAIN_ID})"

# ── Phase 5: create mailbox ─────────────────────────────────────────
phase "5. Create mailbox"
MBOX_LOCAL="e2e-$(date +%s)"
MBOX_PASSWORD="Harness-Pass-$(openssl rand -hex 8)"
MBOX_RESP=$(api POST "/api/v1/clients/${CLIENT_ID}/email/domains/${EMAIL_DOMAIN_ID}/mailboxes" "{
  \"local_part\":\"${MBOX_LOCAL}\",
  \"password\":\"${MBOX_PASSWORD}\",
  \"display_name\":\"E2E Test\"
}")
MAILBOX_ID=$(echo "$MBOX_RESP" | jq -r '.data.id // empty')
# Response uses camelCase (Drizzle convention per CLAUDE.md).
MAILBOX_ADDR=$(echo "$MBOX_RESP" | jq -r '.data.fullAddress // .data.full_address // empty')
if [[ -z "$MAILBOX_ID" || -z "$MAILBOX_ADDR" ]]; then
  fail "5.1 create mailbox failed: $(echo "$MBOX_RESP" | head -c 300)"
  exit 1
fi
pass "5.1 mailbox created (${MAILBOX_ADDR})"

# ── Phase 6: read active engine ─────────────────────────────────────
phase "6. Read active webmail engine"
SETTINGS=$(api GET /api/v1/admin/webmail-settings)
ENGINE=$(echo "$SETTINGS" | jq -r '.data.defaultWebmailEngine // "roundcube"')
WEBMAIL_DEFAULT_URL=$(echo "$SETTINGS" | jq -r '.data.defaultWebmailUrl // empty')
pass "6.1 active engine = ${ENGINE} (default URL: ${WEBMAIL_DEFAULT_URL})"

# ── Phase 7: impersonate to client_admin ────────────────────────────
phase "7. Impersonate as client_admin"
IMP_RESP=$(api POST "/api/v1/admin/impersonate/${CLIENT_ID}" "{}")
CLIENT_TOKEN=$(echo "$IMP_RESP" | jq -r '.data.token // empty')
if [[ -z "$CLIENT_TOKEN" ]]; then
  fail "7.1 impersonate failed: $(echo "$IMP_RESP" | head -c 300)"
  exit 1
fi
pass "7.1 client_admin token issued"

# ── Phase 8: mint webmail token ─────────────────────────────────────
phase "8. Mint webmail token"
TOK_RESP=$(curl "${CURL_OPTS[@]}" -X POST "${API_BASE}/api/v1/email/webmail-token" \
  -H "Authorization: Bearer ${CLIENT_TOKEN}" \
  -H 'content-type: application/json' \
  -d "{\"mailbox_id\":\"${MAILBOX_ID}\"}")
WEBMAIL_URL=$(echo "$TOK_RESP" | jq -r '.data.webmailUrl // empty')
RESP_ENGINE=$(echo "$TOK_RESP" | jq -r '.data.engine // empty')
if [[ -z "$WEBMAIL_URL" ]]; then
  fail "8.1 webmail-token failed: $(echo "$TOK_RESP" | head -c 300)"
  exit 1
fi
pass "8.1 webmail-token returned URL: ${WEBMAIL_URL}"
[[ "$RESP_ENGINE" == "$ENGINE" ]] \
  && pass "8.2 response engine matches platform setting (${ENGINE})" \
  || fail "8.2 engine mismatch: settings=${ENGINE} token=${RESP_ENGINE}"

# ── Phase 9: validate URL shape ─────────────────────────────────────
phase "9. Validate URL shape"
if [[ "$ENGINE" == "bulwark" ]]; then
  if [[ "$WEBMAIL_URL" =~ /_impersonate\?token= ]]; then
    pass "9.1 bulwark URL contains /_impersonate?token="
  else
    fail "9.1 bulwark URL missing /_impersonate?token= → ${WEBMAIL_URL}"
  fi
else
  if [[ "$WEBMAIL_URL" =~ \?_task=login\&_jwt= ]]; then
    pass "9.1 roundcube URL contains ?_task=login&_jwt="
  else
    fail "9.1 roundcube URL missing ?_task=login&_jwt= → ${WEBMAIL_URL}"
  fi
fi

# ── Phase 10: hit the URL ───────────────────────────────────────────
if [[ "$SKIP_WEBMAIL_HIT" != "1" ]]; then
  phase "10. Follow webmail URL"
  COOKIES=$(mktemp)
  HIT_CODE=$(curl "${CURL_OPTS[@]}" -i "$WEBMAIL_URL" \
    -c "$COOKIES" -o /tmp/webmail-hit.txt -w '%{http_code}')
  if [[ "$ENGINE" == "bulwark" ]]; then
    # Bulwark impersonator returns 303 + jmap_stalwart_ctx cookie.
    grep -q "jmap_stalwart_ctx" "$COOKIES" \
      && pass "10.1 bulwark — jmap_stalwart_ctx cookie set" \
      || fail "10.1 bulwark — no jmap cookie (HTTP ${HIT_CODE})"
  else
    # Roundcube returns 302 to its session-bootstrap or 200 with login form.
    [[ "$HIT_CODE" =~ ^(200|302|303)$ ]] \
      && pass "10.1 roundcube — handshake responded (HTTP ${HIT_CODE})" \
      || fail "10.1 roundcube — bad code ${HIT_CODE}"
  fi
  rm -f "$COOKIES" /tmp/webmail-hit.txt
fi

# ── Phase 11: cleanup is in trap; report ────────────────────────────
phase "11. Cleanup (deferred to trap)"

echo
echo "════════════════════════════════════════════════"
printf "  PASS: \033[32m%d\033[0m   FAIL: \033[31m%d\033[0m\n" "$PASS" "$FAIL"
echo "════════════════════════════════════════════════"
[[ "$FAIL" -gt 0 ]] && exit 1 || exit 0
