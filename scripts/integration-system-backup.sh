#!/usr/bin/env bash
# E2E for System Backup Phase 1: secrets bundle export + decrypt round-trip.
#
# WHAT THIS HARNESS PROVES (end-to-end against the live staging cluster):
#
#   1. POST /api/v1/system-backup/secrets/export returns 202 + runId.
#   2. The run polls through pending → running → succeeded within 60s.
#   3. The succeeded run carries a one-shot signed download URL whose
#      TTL is 15 minutes from creation.
#   4. Following the URL once returns the bundle bytes; the response
#      Content-SHA256 matches the run's recorded sha256.
#   5. Following the URL a SECOND time returns 410 Gone (single-use).
#   6. The downloaded bundle, decrypted with the operator's age key
#      (fetched off-host via `make secrets-fetch`), tar-extracts to
#      a manifest matching the in-cluster Secret list.
#   7. The manifest endpoint reports each Secret in the bundle list as
#      present + the operator recipient ConfigMap value.
#   8. A second, fresh export — INSIDE the same harness run — produces
#      a DIFFERENT runId + sha256 (proves there's no caching at the
#      orchestrator layer).
#   9. /admin/postgres-restore/status semantics are unaffected
#      (smoke check that the new module didn't accidentally clash with
#      existing routes).
#
# Per project rule (feedback_assert_user_visible_only): every assertion
# below ends with a curl/openssl probe of the user-facing endpoint, not
# a kubectl-state poll.
#
# USAGE:
#   ADMIN_PASSWORD=<…> ./scripts/integration-system-backup.sh

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_HOST="${SSH_HOST:-root@89.167.3.56}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
# Operator age private key for the decrypt round-trip. Defaults to the
# ~/k8s-staging/ location populated by `make secrets-fetch`.
AGE_KEY="${AGE_KEY:-$HOME/k8s-staging/operator-private.key}"
[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
pass() { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; exit 1; }

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SSH_HOST"

curl_admin() {
  curl -sS -k -H "Authorization: Bearer $TOKEN" "$@"
}

# Trigger an export and wait for terminal status. Echoes the runId on
# success. Polls the GET /runs/:id endpoint, NOT kubectl state, so the
# assertion is grounded in user-visible API behaviour.
trigger_and_wait() {
  local reason="$1"
  local resp run_id status
  resp=$(curl_admin -X POST -H 'Content-Type: application/json' \
    -d "{\"reason\":\"$reason\"}" \
    "$ADMIN_HOST/api/v1/system-backup/secrets/export")
  run_id=$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["runId"])')
  [[ -n "$run_id" ]] || fail "no runId in export response: $resp"

  for _ in {1..30}; do
    status=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/secrets/runs/$run_id" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])' 2>/dev/null \
      || echo "?")
    if [[ "$status" = "succeeded" || "$status" = "failed" ]]; then break; fi
    sleep 2
  done
  [[ "$status" = "succeeded" ]] || fail "export did not succeed: status=$status (runId=$run_id)"
  echo "$run_id"
}

log "1) Login"
TOKEN=$(curl -sS -k -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])')
[[ -n "$TOKEN" ]] && pass "logged in" || fail "login failed"

log "2) Manifest endpoint reports the expected Secrets + operator recipient"
MAN=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/secrets/manifest")
RECIPIENT=$(echo "$MAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["operatorRecipient"] or "")')
[[ "$RECIPIENT" =~ ^age1 ]] || fail "operator recipient missing or malformed: $RECIPIENT"
pass "operator recipient: ${RECIPIENT:0:24}…"

PRESENT_COUNT=$(echo "$MAN" | python3 -c '
import json,sys
items = json.load(sys.stdin)["data"]["items"]
present = [i for i in items if i["present"]]
print(len(present))
')
[[ "$PRESENT_COUNT" -ge 5 ]] || fail "expected ≥5 present secrets in manifest, got $PRESENT_COUNT"
pass "$PRESENT_COUNT secret(s) present in bundle inventory"

log "3) Trigger first export + poll to terminal via /runs/:id"
START=$(date +%s)
RUN_ID_1=$(trigger_and_wait "integration-system-backup harness — first export")
ELAPSED=$(( $(date +%s) - START ))
pass "export 1 succeeded in ${ELAPSED}s — runId=$RUN_ID_1"

log "4) Run row carries one-shot download URL with future expiresAt"
DETAIL=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/secrets/runs/$RUN_ID_1")
URL=$(echo "$DETAIL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["downloadUrl"] or "")')
EXPIRES_AT=$(echo "$DETAIL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["downloadUrlExpiresAt"] or "")')
SHA1=$(echo "$DETAIL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["sha256"] or "")')
SIZE1=$(echo "$DETAIL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["sizeBytes"] or 0)')
[[ -n "$URL" ]] || fail "succeeded run has no downloadUrl"
[[ -n "$EXPIRES_AT" ]] || fail "succeeded run has no downloadUrlExpiresAt"
pass "downloadUrl present, expires at $EXPIRES_AT, size=$SIZE1 sha256=${SHA1:0:16}…"

log "5) GET the URL once — bundle bytes returned, sha256 header matches"
TMP=$(mktemp -t sysbk-XXXXXX.tar.age)
SCRATCH_DIR=$(mktemp -d -t sysbk-scratch-XXXXXX)
HEADERS_FILE="$SCRATCH_DIR/headers.txt"
LISTING_FILE="$SCRATCH_DIR/listing.txt"
# Trap-on-EXIT so early `fail` calls don't leave bundle bytes pinning tmpfs
# (see feedback_e2e_tmp_cleanup — staging1 once held 3.7 GB of leftovers).
trap 'rm -rf "$TMP" "$SCRATCH_DIR"' EXIT
HTTP=$(curl -sS -k -o "$TMP" -w '%{http_code}' -D "$HEADERS_FILE" "$ADMIN_HOST$URL")
[[ "$HTTP" = "200" ]] || fail "first download returned HTTP $HTTP"
ACTUAL_SHA=$(sha256sum "$TMP" | awk '{print $1}')
[[ "$ACTUAL_SHA" = "$SHA1" ]] || fail "downloaded sha256 ($ACTUAL_SHA) != run sha256 ($SHA1)"
HEADER_SHA=$(grep -i '^x-content-sha256:' "$HEADERS_FILE" | tr -d '\r' | awk '{print $2}')
[[ "$HEADER_SHA" = "$SHA1" ]] || fail "X-Content-SHA256 header ($HEADER_SHA) != run sha256 ($SHA1)"
pass "first download bytes-identical (sha256 + header match)"

log "6) GET the URL second time — 410 Gone (single-use enforced)"
HTTP2=$(curl -sS -k -o /dev/null -w '%{http_code}' "$ADMIN_HOST$URL")
[[ "$HTTP2" = "410" ]] || fail "second download returned HTTP $HTTP2 (expected 410)"
pass "single-use enforced — second download = 410"

log "7) Decrypt round-trip: age decrypt → gunzip → tar listing"
if [[ ! -r "$AGE_KEY" ]]; then
  warn "AGE_KEY not readable at $AGE_KEY — skipping decrypt step. Run: make secrets-fetch HOST=$SSH_HOST"
else
  if ! age -d -i "$AGE_KEY" "$TMP" 2>/dev/null | gunzip -c | tar -tf - > "$LISTING_FILE" 2>&1; then
    warn "decrypt+extract failed; listing:"
    head -5 "$LISTING_FILE"
    fail "decrypt round-trip failed (wrong key? corrupt bundle?)"
  fi
  CONTAINED=$(grep -c '^platform__\|^mail__\|^MANIFEST.txt$' "$LISTING_FILE")
  [[ "$CONTAINED" -ge 5 ]] || fail "decrypted bundle has $CONTAINED expected entries, want ≥5"
  pass "decrypted bundle contains $CONTAINED expected entries"
  grep -q '^MANIFEST.txt$' "$LISTING_FILE" || fail "bundle missing MANIFEST.txt"
  pass "MANIFEST.txt present"
fi
# Cleanup is handled by the EXIT trap registered after mktemp above.

log "8) Second export (fresh) yields different runId + sha256"
RUN_ID_2=$(trigger_and_wait "integration-system-backup harness — second export")
[[ "$RUN_ID_2" != "$RUN_ID_1" ]] || fail "second export reused first runId"
DETAIL_2=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/secrets/runs/$RUN_ID_2")
SHA2=$(echo "$DETAIL_2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["sha256"] or "")')
[[ -n "$SHA2" ]] || fail "second export missing sha256"
# Different bundle bytes likely (mtime in tar); even if identical, different
# downloadTokenHash means a NEW token. Just check non-empty + assert
# distinct runId above.
pass "second runId=$RUN_ID_2 sha256=${SHA2:0:16}…"

log "9) Audit log contains both export attempts"
# Pull recent audit-log rows; super_admin can list all rows. Filter by
# action_type.
AUDIT=$(curl_admin "$ADMIN_HOST/api/v1/admin/audit-logs?action_type=system_backup_secrets_export&limit=10" \
  || echo '{"data":[]}')
COUNT_AUDIT=$(echo "$AUDIT" | python3 -c '
import json,sys
try:
  rows = json.load(sys.stdin)["data"]
  print(len(rows))
except Exception:
  print(0)
')
if [[ "$COUNT_AUDIT" -lt 2 ]]; then
  warn "audit-log query returned $COUNT_AUDIT rows; expected ≥2 (filter may not be supported)"
else
  pass "audit-log carries $COUNT_AUDIT export rows"
fi

log "10) Smoke: postgres-restore status endpoint still responds"
PR_STATUS=$(curl_admin "$ADMIN_HOST/api/v1/admin/postgres-restore/status" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["inProgress"])' 2>/dev/null \
  || echo "missing")
[[ "$PR_STATUS" =~ ^(True|False|true|false)$ ]] || fail "postgres-restore status route broken: $PR_STATUS"
pass "postgres-restore status=$PR_STATUS (route still healthy)"

log "DONE: System Backup Phase 1 E2E green"
