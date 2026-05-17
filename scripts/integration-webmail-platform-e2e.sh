#!/usr/bin/env bash
# integration-webmail-platform-e2e.sh — platform-driven webmail E2E.
#
# Unlike integration-bulwark-e2e.sh which targets a pre-seeded eval mailbox
# in DinD, this harness exercises the full provisioning flow against ANY
# cluster (local DinD, staging, testing apex, production) by driving the
# platform-api directly:
#
#   1. Admin login → JWT
#   2. POST /api/v1/tenants         → create test client
#   3. POST /api/v1/tenants/:id/domains
#                                   → attach a test domain (no DNS check)
#   4. POST /api/v1/tenants/:id/email/domains/:domainId/enable
#                                   → enable mail for the domain
#   5. POST /api/v1/tenants/:id/email/domains/:emailDomainId/mailboxes
#                                   → create a mailbox + password
#   6. GET  /api/v1/admin/webmail-settings
#                                   → confirm active engine
#   7. POST /api/v1/admin/impersonate/:id
#                                   → mint a tenant_admin JWT
#   8. POST /api/v1/email/webmail-token  (as tenant_admin)
#                                   → engine-shaped URL
#   9. Validate URL shape:
#       roundcube → webmail.<apex>/?_task=login&_jwt=<jwt>  OR
#                   webmail.<clientdomain>/?_task=login&_jwt=<jwt>
#       bulwark   → webmail.<apex>/api/auth/impersonate?token=<jwt>
#  10. GET <webmailUrl>             → expect 303 + jmap_stalwart_ctx
#                                     cookie (bulwark) or 200 (roundcube)
#  11. (Bulwark only) SPA-equivalent JMAP probe — confirms session works
#       end-to-end (cookies + Origin → /api/account/stalwart/jmap → 200
#       with a real Mailbox/get response).
#  12. Cleanup: DELETE /api/v1/tenants/:id (cascades mailboxes + domains)
#
# Modes
#
#   Default: phases 1–11 once against whatever engine is configured.
#
#   `--engine-loop`: phases 8–11 run TWICE, once with default_webmail_engine
#   forced to bulwark, once forced to roundcube. The initial engine is
#   captured and restored on exit (even on failure). Provisioning phases
#   1–7 run once. Useful in CI to exercise BOTH engine paths regardless
#   of which is currently set on the target cluster.
#
#   Engine flips require super_admin auth (the same ADMIN_PASSWORD as
#   the rest of the harness — no extra config). Between flips the
#   harness polls /admin/webmail-settings until the setting flips,
#   then sleeps `ENGINE_FLIP_SETTLE_S` seconds (default 15) so the
#   webmail-router reconciler has time to flip the IngressRoute +
#   scale the pods. On clusters where the reconciler is slow, raise
#   the env to 30 or 60.
#
# Usage:
#   API_BASE=https://admin.testing.phoenix-host.net \
#   ADMIN_EMAIL=admin@testing.phoenix-host.net \
#   ADMIN_PASSWORD=... \
#   TEST_DOMAIN=harness-$(date +%s).success.com.na \
#   ./scripts/integration-webmail-platform-e2e.sh
#
#   # CI loop mode — verify both engine paths in one run:
#   ./scripts/integration-webmail-platform-e2e.sh --engine-loop
#
# Environment:
#   API_BASE              — platform-api base URL (default: https://admin.k8s-platform.test:2011)
#   ADMIN_EMAIL           — platform super_admin email
#   ADMIN_PASSWORD        — platform super_admin password
#   TEST_DOMAIN           — domain to attach (default: harness-$(date +%s).success.com.na)
#   SKIP_WEBMAIL_HIT      — set to 1 to skip phase 10 (cert / connectivity issue)
#   CURL_INSECURE         — set to 1 to pass -k (self-signed certs)
#   ENGINE_FLIP_SETTLE_S  — seconds to wait after a flip for reconciler to apply (default 15)
set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────
ENGINE_LOOP=0
for arg in "$@"; do
  case "$arg" in
    --engine-loop) ENGINE_LOOP=1 ;;
    -h|--help)
      sed -n '1,/^set -eu/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

API_BASE="${API_BASE:-https://admin.k8s-platform.test:2011}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD env var required}"
TEST_DOMAIN="${TEST_DOMAIN:-harness-$(date +%s)-${RANDOM}.success.com.na}"
SKIP_WEBMAIL_HIT="${SKIP_WEBMAIL_HIT:-0}"
ENGINE_FLIP_SETTLE_S="${ENGINE_FLIP_SETTLE_S:-15}"

CURL_OPTS=(-sS -m 30)
[[ "${CURL_INSECURE:-0}" == "1" ]] && CURL_OPTS+=(-k)

PASS=0
FAIL=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
phase() { printf '\n\033[36m── %s ──\033[0m\n' "$*"; }

# Track resources to clean up on exit (even on failure).
TENANT_ID=""
INITIAL_ENGINE=""           # populated in --engine-loop mode for restore
ENGINE_RESTORE_NEEDED=0
trap 'cleanup_on_exit' EXIT

cleanup_on_exit() {
  # Restore initial engine first — it's the operator-visible state.
  if [[ "$ENGINE_RESTORE_NEEDED" == "1" && -n "$INITIAL_ENGINE" && -n "${ADMIN_TOKEN:-}" ]]; then
    local opts=(-sS -m 30)
    [[ "${CURL_INSECURE:-0}" == "1" ]] && opts+=(-k)
    curl "${opts[@]}" -X PATCH "${API_BASE}/api/v1/admin/webmail-settings" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      -H 'content-type: application/json' \
      -d "{\"defaultWebmailEngine\":\"${INITIAL_ENGINE}\"}" \
      -o /dev/null -w 'cleanup: engine restore → %{http_code}\n' || true
  fi
  if [[ -n "$TENANT_ID" && -n "${ADMIN_TOKEN:-}" ]]; then
    # Cleanup is slow — cascade deletes mailboxes, email-domains, DNS
    # records, etc. Give it 60s so a busy cluster doesn't bail mid-way.
    local opts=(-sS -m 60)
    [[ "${CURL_INSECURE:-0}" == "1" ]] && opts+=(-k)
    curl "${opts[@]}" -X DELETE "${API_BASE}/api/v1/tenants/${TENANT_ID}" \
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
# Always pick the Starter plan so the smallest PVC sizes are used and
# capacity-constrained single-node testing installs aren't rejected by
# the storage tier check. Falls back to smallest-storage if Starter is
# missing.
PLAN_ID=$(api GET /api/v1/plans | jq -r '[.data[] | select(.status == "active") | select(.name == "Starter")][0].id // ([.data[] | select(.status == "active")] | sort_by(.storageLimit | tonumber)[0].id) // empty')
REGION_ID=$(api GET /api/v1/regions | jq -r '.data[0].id // empty')
[[ -z "$PLAN_ID"   ]] && { fail "2.0a no plans available"; exit 1; } || pass "2.0a discovered plan=${PLAN_ID}"
[[ -z "$REGION_ID" ]] && { fail "2.0b no regions available"; exit 1; } || pass "2.0b discovered region=${REGION_ID}"

CLIENT_RESP=$(api POST /api/v1/tenants "{
  \"name\":\"Webmail E2E Harness\",
  \"primary_email\":\"e2e-$(date +%s)@${TEST_DOMAIN}\",
  \"plan_id\":\"${PLAN_ID}\",
  \"region_id\":\"${REGION_ID}\"
}")
TENANT_ID=$(echo "$CLIENT_RESP" | jq -r '.data.id // empty')
if [[ -z "$TENANT_ID" ]]; then
  fail "2.1 create tenant failed: $(echo "$CLIENT_RESP" | head -c 300)"
  exit 1
fi
pass "2.1 client created (id=${TENANT_ID})"

# ── Phase 3: attach domain ──────────────────────────────────────────
phase "3. Attach domain"
DOM_RESP=$(api POST "/api/v1/tenants/${TENANT_ID}/domains" "{
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
ENABLE_RESP=$(api POST "/api/v1/tenants/${TENANT_ID}/email/domains/${DOMAIN_ID}/enable" "{}")
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
MBOX_RESP=$(api POST "/api/v1/tenants/${TENANT_ID}/email/domains/${EMAIL_DOMAIN_ID}/mailboxes" "{
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
INITIAL_ENGINE=$(echo "$SETTINGS" | jq -r '.data.defaultWebmailEngine // "roundcube"')
WEBMAIL_DEFAULT_URL=$(echo "$SETTINGS" | jq -r '.data.defaultWebmailUrl // empty')
pass "6.1 active engine = ${INITIAL_ENGINE} (default URL: ${WEBMAIL_DEFAULT_URL})"

# ── Phase 7: impersonate to tenant_admin ────────────────────────────
phase "7. Impersonate as tenant_admin"
IMP_RESP=$(api POST "/api/v1/admin/impersonate/${TENANT_ID}" "{}")
CLIENT_TOKEN=$(echo "$IMP_RESP" | jq -r '.data.token // empty')
if [[ -z "$CLIENT_TOKEN" ]]; then
  fail "7.1 impersonate failed: $(echo "$IMP_RESP" | head -c 300)"
  exit 1
fi
pass "7.1 tenant_admin token issued"

# ─────────────────────────────────────────────────────────────────────
# Helper: poll /admin/webmail-settings until defaultWebmailEngine
# matches $1, up to 30s. Returns 0 on match, 1 on timeout.
wait_engine_setting() {
  local target="$1"
  local end=$(( $(date +%s) + 30 ))
  while [[ $(date +%s) -lt $end ]]; do
    local cur
    cur=$(api GET /api/v1/admin/webmail-settings | jq -r '.data.defaultWebmailEngine // empty')
    [[ "$cur" == "$target" ]] && return 0
    sleep 1
  done
  return 1
}

flip_engine() {
  local target="$1" tag="$2"
  curl "${CURL_OPTS[@]}" -X PATCH "${API_BASE}/api/v1/admin/webmail-settings" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H 'content-type: application/json' \
    -d "{\"defaultWebmailEngine\":\"${target}\"}" >/dev/null
  if wait_engine_setting "$target"; then
    pass "${tag} engine flipped to ${target}"
  else
    fail "${tag} engine flip to ${target} did not stick within 30s"
    return 1
  fi
  # Give the webmail-router reconciler time to flip the IngressRoute +
  # scale pods so subsequent SSO traffic doesn't hit a stale upstream.
  sleep "$ENGINE_FLIP_SETTLE_S"
  return 0
}

# ─────────────────────────────────────────────────────────────────────
# run_sso_flow ENGINE TAG_PREFIX
#
# Phases 8-11 against the given engine, with the engine already flipped
# (caller is responsible for flipping/settle). Uses global CLIENT_TOKEN,
# MAILBOX_ID, ADMIN_TOKEN, API_BASE. Reports tagged assertions so
# --engine-loop mode can disambiguate two runs in the summary.
run_sso_flow() {
  local engine="$1" tag="$2"

  # ── Phase 8: mint webmail token ──────────────────────────────────
  phase "${tag}8. Mint webmail token (engine=${engine})"
  local tok_resp webmail_url resp_engine
  tok_resp=$(curl "${CURL_OPTS[@]}" -X POST "${API_BASE}/api/v1/email/webmail-token" \
    -H "Authorization: Bearer ${CLIENT_TOKEN}" \
    -H 'content-type: application/json' \
    -d "{\"mailbox_id\":\"${MAILBOX_ID}\"}")
  webmail_url=$(echo "$tok_resp" | jq -r '.data.webmailUrl // empty')
  resp_engine=$(echo "$tok_resp" | jq -r '.data.engine // empty')
  if [[ -z "$webmail_url" ]]; then
    fail "${tag}8.1 webmail-token failed: $(echo "$tok_resp" | head -c 300)"
    return 1
  fi
  pass "${tag}8.1 webmail-token returned URL: ${webmail_url}"
  [[ "$resp_engine" == "$engine" ]] \
    && pass "${tag}8.2 response engine matches platform setting (${engine})" \
    || fail "${tag}8.2 engine mismatch: settings=${engine} token=${resp_engine}"

  # ── Phase 9: validate URL shape ──────────────────────────────────
  phase "${tag}9. Validate URL shape (engine=${engine})"
  if [[ "$engine" == "bulwark" ]]; then
    if [[ "$webmail_url" =~ /api/auth/impersonate\?token= ]]; then
      pass "${tag}9.1 bulwark URL contains /api/auth/impersonate?token="
    else
      fail "${tag}9.1 bulwark URL missing /api/auth/impersonate?token= → ${webmail_url}"
    fi
  else
    if [[ "$webmail_url" =~ \?_task=login\&_jwt= ]]; then
      pass "${tag}9.1 roundcube URL contains ?_task=login&_jwt="
    else
      fail "${tag}9.1 roundcube URL missing ?_task=login&_jwt= → ${webmail_url}"
    fi
  fi

  # ── Phase 10: hit the URL ────────────────────────────────────────
  local cookies hit_code
  cookies=$(mktemp)
  if [[ "$SKIP_WEBMAIL_HIT" != "1" ]]; then
    phase "${tag}10. Follow webmail URL (engine=${engine})"
    hit_code=$(curl "${CURL_OPTS[@]}" -i "$webmail_url" \
      -c "$cookies" -o /tmp/webmail-hit.txt -w '%{http_code}')
    if [[ "$engine" == "bulwark" ]]; then
      grep -q "jmap_stalwart_ctx" "$cookies" \
        && pass "${tag}10.1 bulwark — jmap_stalwart_ctx cookie set" \
        || fail "${tag}10.1 bulwark — no jmap cookie (HTTP ${hit_code})"
    else
      [[ "$hit_code" =~ ^(200|302|303)$ ]] \
        && pass "${tag}10.1 roundcube — handshake responded (HTTP ${hit_code})" \
        || fail "${tag}10.1 roundcube — bad code ${hit_code}"
    fi
  fi

  # ── Phase 11: SPA-equivalent session probe (bulwark only) ────────
  if [[ "$SKIP_WEBMAIL_HIT" != "1" && "$engine" == "bulwark" ]]; then
    phase "${tag}11. SPA-equivalent JMAP probe (engine=${engine})"
    local webmail_origin jmap_probe code
    webmail_origin=$(echo "$webmail_url" | sed -E 's#^(https?://[^/]+).*#\1#')
    jmap_probe=$(mktemp)
    curl "${CURL_OPTS[@]}" -X POST "${webmail_origin}/api/account/stalwart/jmap" \
      -b "$cookies" \
      -H 'Content-Type: application/json' \
      -H "Origin: ${webmail_origin}" \
      -d '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Mailbox/get",{"accountId":"b","ids":null},"a"]]}' \
      -o "$jmap_probe" -w '%{http_code}' > /tmp/jmap-code.txt
    code=$(cat /tmp/jmap-code.txt)
    if grep -q '"Not authenticated"' "$jmap_probe"; then
      fail "${tag}11.1 SPA session probe — 'Not authenticated' (HTTP ${code}). Body: $(head -c 200 "$jmap_probe")"
    elif grep -q '"Mailbox/get"' "$jmap_probe" || grep -q '"list":' "$jmap_probe"; then
      pass "${tag}11.1 SPA session probe — Mailbox/get returned a valid JMAP response"
    elif [[ "$code" == "200" ]]; then
      pass "${tag}11.1 SPA session probe — HTTP 200 (Stalwart accepted the cookie)"
    else
      fail "${tag}11.1 SPA session probe — unexpected response (HTTP ${code}): $(head -c 200 "$jmap_probe")"
    fi
    rm -f "$jmap_probe" /tmp/jmap-code.txt
  fi
  rm -f "$cookies"
}

# ── Phases 8-11: SSO flow (single-engine OR loop both) ──────────────
if [[ "$ENGINE_LOOP" == "1" ]]; then
  ENGINE_RESTORE_NEEDED=1
  phase "loop. Engine loop — running SSO twice (bulwark + roundcube)"
  echo "    Initial engine: ${INITIAL_ENGINE} (will be restored on exit)"

  # Order: flip to bulwark first (most-tested path), then roundcube.
  for target in bulwark roundcube; do
    flip_engine "$target" "loop-${target}." || continue
    run_sso_flow "$target" "loop-${target}."
  done
  # cleanup_on_exit will restore $INITIAL_ENGINE
else
  # Single-engine mode — no flip, just exercise whatever is set.
  run_sso_flow "$INITIAL_ENGINE" ""
fi

# ── Phase 12: cleanup is in trap; report ────────────────────────────
phase "12. Cleanup (deferred to trap)"
rm -f /tmp/webmail-hit.txt

echo
echo "════════════════════════════════════════════════"
printf "  PASS: \033[32m%d\033[0m   FAIL: \033[31m%d\033[0m\n" "$PASS" "$FAIL"
echo "════════════════════════════════════════════════"
[[ "$FAIL" -gt 0 ]] && exit 1 || exit 0
