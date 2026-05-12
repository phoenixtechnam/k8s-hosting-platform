#!/usr/bin/env bash
# End-to-end harness for Stalwart mail server HA + CIFS BlobStore + restic snapshot features.
#
# Drives the full admin-API surface for:
#   - BlobStore singleton read + switch
#   - Node selector read + update
#   - Manual snapshot trigger + Job poll
#   - CIFS validation guards
#   - CronJob infrastructure existence check
#   - Snapshot schedule read + update
#   - Snapshot backup target read
#   - Snapshot status shape (totalSnapshotSizeBytes field)
#   - CronJob restic sidecar + snap-directory path validation
#
# Scenarios:
#   1.  blob-store-read             — GET /admin/mail/blob-store → 200 + valid shape
#   2.  node-selector-read          — GET /admin/mail/node-selector → 200 + valid shape
#   3.  node-selector-preferred     — PATCH preferred mode → 200 + assert mode; cleanup to 'any'
#   4.  node-selector-invalid       — PATCH required + nonexistent node → 4xx MAIL_NODE_NOT_FOUND
#   5.  snapshot-trigger            — POST trigger → Job created; poll to succeeded/warn-on-fail
#   6.  cifs-reject-localhost       — PATCH CIFS with host=localhost → 4xx
#   7.  blobstore-switch-default    — PATCH Default → Job; poll; re-read asserts Default
#   8.  snapshot-cronjob-exists     — kubectl assert CronJob schedule + concurrencyPolicy
#   9.  snapshot-schedule-read      — GET /admin/mail/snapshot-schedule → 200 + valid cron expr
#   10. snapshot-schedule-update    — PATCH schedule → 200 + updated; restore original
#   11. snapshot-backup-target-read — GET /admin/mail/snapshot-backup-target → 200 + valid shape
#   12. snapshot-status-shape       — GET /admin/mail/snapshot-status includes totalSnapshotSizeBytes
#   13. cronjob-restic-sidecar      — kubectl assert upload sidecar + snap dir path
#
# Each scenario writes a one-line PASS/FAIL result.  Script exits 0 only
# when every scenario passes.
#
# USAGE:
#   ADMIN_PASSWORD=... ./scripts/integration-mail-ha-e2e.sh
#
#   ADMIN_HOST          base URL of the admin API
#                       default: https://admin.staging.phoenix-host.net
#   ADMIN_EMAIL         admin login email
#                       default: admin@phoenix-host.net
#   ADMIN_PASSWORD      admin login password (required)
#   KUBECONFIG          path to kubeconfig; falls back to ~/.kube/config
#   SNAPSHOT_TIMEOUT    max seconds to wait for a snapshot Job (default: 180)
#   BLOBSTORE_TIMEOUT   max seconds to wait for a blob-store Job (default: 300)
#   SKIP_CLEANUP=1      skip any teardown (useful during debugging)
#   SSH_KEY             private key for kubectl-via-SSH tunnels (optional)
#   SSH_HOST            SSH host for kubectl proxy, e.g. root@89.167.3.56
#                       When set, kubectl commands run via SSH.
#
# Exit codes:
#   0 = all scenarios passed
#   1 = one or more scenarios failed
#   2 = misconfiguration (missing required env, login failure, etc.)

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SNAPSHOT_TIMEOUT="${SNAPSHOT_TIMEOUT:-180}"
BLOBSTORE_TIMEOUT="${BLOBSTORE_TIMEOUT:-300}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@89.167.3.56}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

# ── Colour + logging helpers ───────────────────────────────────────────────────

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'

log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
warn() { printf '  %b!%b %s\n' "$YELLOW" "$RESET" "$*"; }

passed=0
failed=0

# ── kubectl helper — runs on staging node via SSH if SSH_HOST is set ──────────

kube() {
  if [[ -n "${SSH_HOST:-}" ]]; then
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 -q "$SSH_HOST" "kubectl $*"
  else
    kubectl "$@"
  fi
}

# ── HTTP helpers ──────────────────────────────────────────────────────────────

TOKEN=""

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk --max-time 60 --retry 2 --retry-all-errors --retry-delay 2 \
      -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN"
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
      -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN"
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
  resp=$(curl -sk --max-time 30 \
    -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD")")
  TOKEN=$(jq -r '.data.token // empty' <<<"$resp")
  [[ -n "$TOKEN" ]] || { echo "ERROR: login failed: $resp" >&2; exit 2; }
  log "Got admin token (length=${#TOKEN})"
}

# ── Section header ─────────────────────────────────────────────────────────────

run() {
  local desc="$1"
  printf '\n%b▶ %s%b\n' "$CYAN" "$desc" "$RESET"
}

# ── Helper: poll a blob-store or snapshot Job until terminal ──────────────────
# Usage: poll_job <api_path_to_job_status> <max_seconds> <job_name>
# Returns 0 when job succeeds, 1 on failure/timeout.

poll_job() {
  local path="$1" timeout_s="$2" name="$3"
  local waited=0 status=""
  while (( waited < timeout_s )); do
    local resp
    resp=$(api GET "$path" 2>/dev/null || echo "{}")
    status=$(jq -r '.data.status // "unknown"' <<<"$resp")
    case "$status" in
      succeeded)
        ok "Job $name succeeded (after ${waited}s)"
        return 0
        ;;
      failed)
        local reason
        reason=$(jq -r '.data.failureReason // "(no reason)"' <<<"$resp")
        fail "Job $name failed: $reason"
        return 1
        ;;
      queued|running|unknown)
        ;;
      *)
        warn "Unexpected job status '$status' — treating as running"
        ;;
    esac
    sleep 5
    waited=$((waited+5))
  done
  warn "Job $name did not complete within ${timeout_s}s (last status: $status)"
  fail "Job $name timed out"
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 1: blob-store-read
# GET /admin/mail/blob-store → 200, data.type in {Default,S3,FileSystem,CIFS},
# data.id == 'singleton'.
# ─────────────────────────────────────────────────────────────────────────────

scenario_1_blob_store_read() {
  run "1. blob-store-read — GET /admin/mail/blob-store"

  local resp
  resp=$(api GET "/admin/mail/blob-store")
  local http_code
  http_code=$(api_status GET "/admin/mail/blob-store")

  if [[ "$http_code" == "200" ]]; then
    ok "HTTP 200"
  else
    fail "Expected 200, got $http_code (resp: $(echo "$resp" | head -c 200))"
    return
  fi

  local id type
  id=$(jq -r '.data.id // empty' <<<"$resp")
  type=$(jq -r '.data.type // empty' <<<"$resp")

  if [[ "$id" == "singleton" ]]; then
    ok "data.id = 'singleton'"
  else
    fail "data.id = '$id' (expected 'singleton')"
  fi

  case "$type" in
    Default|S3|FileSystem|CIFS)
      ok "data.type = '$type' (valid)"
      ;;
    "")
      fail "data.type is missing from response"
      ;;
    *)
      fail "data.type = '$type' (unexpected; want Default|S3|FileSystem|CIFS)"
      ;;
  esac

}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 2: node-selector-read
# GET /admin/mail/node-selector → 200, mode in {any,preferred,required},
# nodeName + currentNode present (may be null).
# ─────────────────────────────────────────────────────────────────────────────

scenario_2_node_selector_read() {
  run "2. node-selector-read — GET /admin/mail/node-selector"

  local resp
  resp=$(api GET "/admin/mail/node-selector")
  local http_code
  http_code=$(api_status GET "/admin/mail/node-selector")

  if [[ "$http_code" == "200" ]]; then
    ok "HTTP 200"
  else
    fail "Expected 200, got $http_code (resp: $(echo "$resp" | head -c 200))"
    return
  fi

  local mode
  mode=$(jq -r '.data.mode // empty' <<<"$resp")

  case "$mode" in
    any|preferred|required)
      ok "data.mode = '$mode' (valid)"
      ;;
    "")
      fail "data.mode is missing"
      return
      ;;
    *)
      fail "data.mode = '$mode' (unexpected; want any|preferred|required)"
      ;;
  esac

  # nodeName and currentNode are present as keys (may be JSON null)
  if jq -e '.data | has("nodeName")' <<<"$resp" >/dev/null 2>&1; then
    ok "data.nodeName key present"
  else
    fail "data.nodeName key missing"
  fi
  if jq -e '.data | has("currentNode")' <<<"$resp" >/dev/null 2>&1; then
    ok "data.currentNode key present"
  else
    fail "data.currentNode key missing"
  fi

  # Stash current node for use in Scenario 3
  CURRENT_NODE=$(jq -r '.data.currentNode // empty' <<<"$resp")
  INITIAL_NODE_MODE="$mode"
  INITIAL_NODE_NAME=$(jq -r '.data.nodeName // empty' <<<"$resp")
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 3: node-selector-preferred
# PATCH { mode: 'preferred', nodeName: <currentNode> } → 200 + mode=preferred
# Cleanup: PATCH { mode: 'any', nodeName: null } to restore.
# Skip gracefully when currentNode is not known.
# ─────────────────────────────────────────────────────────────────────────────

scenario_3_node_selector_preferred() {
  run "3. node-selector-preferred — PATCH preferred to current node"

  if [[ -z "$CURRENT_NODE" ]]; then
    warn "No running Stalwart pod found (currentNode=null) — using a placeholder"
    # Attempt with a node name from kubectl; fall back to skip if also unavailable
    local first_node
    first_node=$(kube get nodes -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
    if [[ -z "$first_node" ]]; then
      warn "Cannot determine a valid node name — skipping preferred-mode test"
      return
    fi
    CURRENT_NODE="$first_node"
    warn "Using first cluster node: $CURRENT_NODE"
  fi

  local body
  body=$(jq -nc --arg mode "preferred" --arg node "$CURRENT_NODE" \
    '{"mode":$mode,"nodeName":$node}')

  local resp
  resp=$(api PATCH "/admin/mail/node-selector" "$body")
  local http_code
  http_code=$(api_status PATCH "/admin/mail/node-selector" "$body")

  if [[ "$http_code" == "200" ]]; then
    ok "PATCH returned 200"
  else
    fail "PATCH returned $http_code (resp: $(echo "$resp" | head -c 300))"
    # Still attempt cleanup
    api PATCH "/admin/mail/node-selector" '{"mode":"any","nodeName":null}' >/dev/null 2>&1 || true
    return
  fi

  local mode node_name
  mode=$(jq -r '.data.mode // empty' <<<"$resp")
  node_name=$(jq -r '.data.nodeName // empty' <<<"$resp")

  if [[ "$mode" == "preferred" ]]; then
    ok "data.mode = 'preferred'"
  else
    fail "data.mode = '$mode' (expected 'preferred')"
  fi

  if [[ "$node_name" == "$CURRENT_NODE" ]]; then
    ok "data.nodeName = '$CURRENT_NODE'"
  else
    fail "data.nodeName = '$node_name' (expected '$CURRENT_NODE')"
  fi

  # Cleanup: reset to original state
  if [[ "$SKIP_CLEANUP" != "1" ]]; then
    log "Cleanup: reset node-selector to original state (mode=$INITIAL_NODE_MODE)"
    local cleanup_body
    if [[ -n "$INITIAL_NODE_NAME" && "$INITIAL_NODE_MODE" != "any" ]]; then
      cleanup_body=$(jq -nc --arg m "$INITIAL_NODE_MODE" --arg n "$INITIAL_NODE_NAME" \
        '{"mode":$m,"nodeName":$n}')
    else
      cleanup_body='{"mode":"any","nodeName":null}'
    fi
    local cleanup_code
    cleanup_code=$(api_status PATCH "/admin/mail/node-selector" "$cleanup_body")
    if [[ "$cleanup_code" == "200" ]]; then
      ok "node-selector reset to original state"
    else
      warn "node-selector cleanup returned $cleanup_code (non-fatal)"
    fi
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 4: node-selector-invalid-node
# PATCH required + nonexistent node → 4xx, error code MAIL_NODE_NOT_FOUND.
# ─────────────────────────────────────────────────────────────────────────────

scenario_4_node_selector_invalid() {
  run "4. node-selector-invalid-node — PATCH required + nonexistent node"

  local body
  body='{"mode":"required","nodeName":"nonexistent-node-xyz-e2e-test"}'

  local resp
  resp=$(api PATCH "/admin/mail/node-selector" "$body")
  local http_code
  http_code=$(api_status PATCH "/admin/mail/node-selector" "$body")

  if [[ "$http_code" =~ ^4 ]]; then
    ok "PATCH returned $http_code (expected 4xx)"
  else
    fail "PATCH returned $http_code (expected 4xx)"
    return
  fi

  local error_code
  error_code=$(jq -r '.error.code // .error // empty' <<<"$resp")
  if echo "$error_code" | grep -q "MAIL_NODE_NOT_FOUND"; then
    ok "error code contains MAIL_NODE_NOT_FOUND (got: $error_code)"
  else
    fail "error code = '$error_code' (expected MAIL_NODE_NOT_FOUND) — resp: $(echo "$resp" | head -c 200)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 5: snapshot-trigger
# GET snapshot-status (note enabled state)
# POST trigger → 200, jobName = stalwart-snapshot-manual-*
# Poll GET snapshot/jobs/:name → succeeded (up to SNAPSHOT_TIMEOUT)
# After success: GET snapshot-status → lastSnapshotAt set
# ─────────────────────────────────────────────────────────────────────────────

scenario_5_snapshot_trigger() {
  run "5. snapshot-trigger — POST /admin/mail/snapshot/trigger"

  # Pre-check: is the CronJob enabled?
  local status_resp
  status_resp=$(api GET "/admin/mail/snapshot-status")
  local enabled
  enabled=$(jq -r '.data.enabled // false' <<<"$status_resp")
  if [[ "$enabled" == "true" ]]; then
    ok "CronJob enabled = true"
  else
    warn "CronJob enabled = false (CronJob may not be deployed on this cluster)"
    # We can still try to trigger a manual Job from the CronJob template.
    # The trigger endpoint returns SNAPSHOT_CRONJOB_NOT_FOUND if missing.
  fi

  # Trigger the snapshot
  local trigger_resp
  trigger_resp=$(api POST "/admin/mail/snapshot/trigger")
  local trigger_code
  trigger_code=$(api_status POST "/admin/mail/snapshot/trigger")

  if [[ "$trigger_code" == "200" ]]; then
    ok "POST /snapshot/trigger returned 200"
  elif [[ "$trigger_code" == "404" ]]; then
    local err_code
    err_code=$(jq -r '.error.code // .error // empty' <<<"$trigger_resp")
    warn "CronJob not found ($err_code) — snapshot-trigger scenario skipped"
    warn "Deploy k8s/base/stalwart-mail/stalwart/snapshot-cronjob.yaml first"
    return
  else
    fail "POST /snapshot/trigger returned $trigger_code (resp: $(echo "$trigger_resp" | head -c 300))"
    return
  fi

  local job_name
  job_name=$(jq -r '.data.jobName // empty' <<<"$trigger_resp")
  local started_at
  started_at=$(jq -r '.data.startedAt // empty' <<<"$trigger_resp")

  if [[ "$job_name" =~ ^stalwart-snapshot-manual- ]]; then
    ok "data.jobName = '$job_name' (matches stalwart-snapshot-manual-*)"
  else
    fail "data.jobName = '$job_name' (expected stalwart-snapshot-manual-*)"
    return
  fi
  if [[ -n "$started_at" ]]; then
    ok "data.startedAt = '$started_at'"
  else
    fail "data.startedAt is missing"
  fi

  # Poll Job status
  log "Polling snapshot Job $job_name (timeout: ${SNAPSHOT_TIMEOUT}s)"
  local job_succeeded=0
  if poll_job "/admin/mail/snapshot/jobs/$job_name" "$SNAPSHOT_TIMEOUT" "$job_name"; then
    job_succeeded=1
  fi

  # After success: assert lastSnapshotAt is now set and recent
  if [[ "$job_succeeded" == "1" ]]; then
    local post_status_resp
    post_status_resp=$(api GET "/admin/mail/snapshot-status")
    local last_at secs_since
    last_at=$(jq -r '.data.lastSnapshotAt // empty' <<<"$post_status_resp")
    secs_since=$(jq -r '.data.secondsSinceLastSnapshot // empty' <<<"$post_status_resp")

    if [[ -n "$last_at" ]]; then
      ok "lastSnapshotAt = '$last_at'"
    else
      fail "lastSnapshotAt is null after successful snapshot"
    fi

    if [[ -n "$secs_since" ]]; then
      if (( secs_since < 300 )); then
        ok "secondsSinceLastSnapshot = $secs_since (< 300 — fresh)"
      else
        warn "secondsSinceLastSnapshot = $secs_since (stale; may be a timing issue)"
      fi
    else
      warn "secondsSinceLastSnapshot is null"
    fi
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 6: cifs-blobstore-reject-localhost
# PATCH { type: 'CIFS', cifs: { host: 'localhost', ... } } → 4xx
# error code CIFS_HOST_INVALID or VALIDATION_ERROR
# ─────────────────────────────────────────────────────────────────────────────

scenario_6_cifs_reject_localhost() {
  run "6. cifs-blobstore-reject-localhost — PATCH CIFS host=localhost must be rejected"

  local body
  body=$(jq -nc '{
    "type": "CIFS",
    "cifs": {
      "host": "localhost",
      "share": "test-share",
      "path": "/blobs",
      "depth": 2,
      "username": "e2e-test-user",
      "password": "e2e-test-pass-not-real"
    }
  }')

  local resp
  resp=$(api PATCH "/admin/mail/blob-store" "$body")
  local http_code
  http_code=$(api_status PATCH "/admin/mail/blob-store" "$body")

  if [[ "$http_code" =~ ^4 ]]; then
    ok "PATCH returned $http_code (expected 4xx)"
  else
    fail "Expected 4xx for localhost host, got $http_code"
    return
  fi

  local error_code
  error_code=$(jq -r '.error.code // .error // empty' <<<"$resp")
  if echo "$error_code" | grep -qE "CIFS_HOST_INVALID|VALIDATION_ERROR"; then
    ok "error code = '$error_code' (CIFS_HOST_INVALID or VALIDATION_ERROR)"
  else
    fail "error code = '$error_code' (expected CIFS_HOST_INVALID or VALIDATION_ERROR)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 7: blobstore-switch-default
# PATCH { type: 'Default' } → 200, jobName present
# Poll /admin/mail/blob-store/jobs/:name → succeeded
# GET /admin/mail/blob-store → type = 'Default'
# This is idempotent whether or not the store is already Default.
# ─────────────────────────────────────────────────────────────────────────────

scenario_7_blobstore_switch_default() {
  run "7. blobstore-switch-default — PATCH { type: 'Default' } + poll Job"

  local body='{"type":"Default"}'

  local resp
  resp=$(api PATCH "/admin/mail/blob-store" "$body")
  local http_code
  http_code=$(api_status PATCH "/admin/mail/blob-store" "$body")

  if [[ "$http_code" == "200" ]]; then
    ok "PATCH returned 200"
  else
    fail "PATCH returned $http_code (resp: $(echo "$resp" | head -c 300))"
    return
  fi

  local job_name type_in_resp
  job_name=$(jq -r '.data.jobName // empty' <<<"$resp")
  type_in_resp=$(jq -r '.data.type // empty' <<<"$resp")

  if [[ -n "$job_name" ]]; then
    ok "data.jobName = '$job_name'"
  else
    fail "data.jobName is missing from PATCH response"
    return
  fi

  if [[ "$type_in_resp" == "Default" ]]; then
    ok "data.type = 'Default' in PATCH response"
  else
    fail "data.type = '$type_in_resp' (expected 'Default')"
  fi

  # Poll Job until terminal
  log "Polling blob-store Job $job_name (timeout: ${BLOBSTORE_TIMEOUT}s)"
  local job_succeeded=0
  if poll_job "/admin/mail/blob-store/jobs/$job_name" "$BLOBSTORE_TIMEOUT" "$job_name"; then
    job_succeeded=1
  fi

  # Re-read and confirm type is Default
  if [[ "$job_succeeded" == "1" ]]; then
    local read_resp read_type
    read_resp=$(api GET "/admin/mail/blob-store")
    read_type=$(jq -r '.data.type // empty' <<<"$read_resp")
    if [[ "$read_type" == "Default" ]]; then
      ok "GET blob-store after Job: type = 'Default'"
    else
      fail "GET blob-store after Job: type = '$read_type' (expected 'Default')"
    fi
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 8: snapshot-cronjob-exists
# kubectl get cronjob stalwart-snapshot -n mail
# Assert: schedule '*/2 * * * *', concurrencyPolicy 'Forbid'
# ─────────────────────────────────────────────────────────────────────────────

scenario_8_cronjob_exists() {
  run "8. snapshot-cronjob-exists — kubectl check stalwart-snapshot CronJob"

  local cj_json
  if ! cj_json=$(kube get cronjob stalwart-snapshot -n mail -o json 2>/dev/null); then
    fail "CronJob stalwart-snapshot not found in namespace mail"
    warn "Deploy k8s/base/stalwart-mail/stalwart/snapshot-cronjob.yaml to fix"
    return
  fi

  ok "CronJob stalwart-snapshot exists in namespace mail"

  local schedule
  schedule=$(echo "$cj_json" | jq -r '.spec.schedule // empty')
  if [[ "$schedule" == "*/2 * * * *" ]]; then
    ok "spec.schedule = '*/2 * * * *'"
  else
    fail "spec.schedule = '$schedule' (expected '*/2 * * * *')"
  fi

  local concurrency_policy
  concurrency_policy=$(echo "$cj_json" | jq -r '.spec.concurrencyPolicy // empty')
  if [[ "$concurrency_policy" == "Forbid" ]]; then
    ok "spec.concurrencyPolicy = 'Forbid'"
  else
    fail "spec.concurrencyPolicy = '$concurrency_policy' (expected 'Forbid')"
  fi

  # Bonus: check backoffLimit=0 on the jobTemplate (no silent retries)
  local backoff_limit
  backoff_limit=$(echo "$cj_json" | jq -r '.spec.jobTemplate.spec.backoffLimit // empty')
  if [[ "$backoff_limit" == "0" ]]; then
    ok "jobTemplate.spec.backoffLimit = 0 (no silent retries)"
  else
    warn "jobTemplate.spec.backoffLimit = '$backoff_limit' (expected 0)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 9: snapshot-schedule-read
# GET /admin/mail/snapshot-schedule → 200 + scheduleExpression is a non-empty string
# ─────────────────────────────────────────────────────────────────────────────

scenario_9_snapshot_schedule_read() {
  run "9. snapshot-schedule-read — GET /admin/mail/snapshot-schedule → valid cron expression"

  local resp
  resp=$(api GET "/admin/mail/snapshot-schedule")
  local http_code
  http_code=$(api_status GET "/admin/mail/snapshot-schedule")

  if [[ "$http_code" == "200" ]]; then
    ok "GET /admin/mail/snapshot-schedule returned 200"
  else
    fail "GET /admin/mail/snapshot-schedule returned $http_code (resp: $(echo "$resp" | head -c 300))"
    return
  fi

  local schedule_expr
  schedule_expr=$(jq -r '.data.scheduleExpression // empty' <<<"$resp")

  if [[ -n "$schedule_expr" ]]; then
    ok "data.scheduleExpression = '$schedule_expr'"
  else
    fail "data.scheduleExpression is missing or empty"
  fi

  # A basic cron expression has 5 space-separated parts
  local part_count
  part_count=$(echo "$schedule_expr" | awk '{print NF}')
  if [[ "$part_count" == "5" ]]; then
    ok "scheduleExpression has 5 parts (valid 5-part cron)"
  else
    warn "scheduleExpression has $part_count parts (expected 5 — may be non-standard)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 10: snapshot-schedule-update
# PATCH { scheduleExpression: "0 */6 * * *" } → 200 + updated value
# Then restore the original schedule.
# ─────────────────────────────────────────────────────────────────────────────

scenario_10_snapshot_schedule_update() {
  run "10. snapshot-schedule-update — PATCH schedule → 200; restore original"

  # Read current schedule first so we can restore it.
  local original_resp original_schedule
  original_resp=$(api GET "/admin/mail/snapshot-schedule")
  original_schedule=$(jq -r '.data.scheduleExpression // "*/2 * * * *"' <<<"$original_resp")

  local new_schedule='0 */6 * * *'
  local patch_body
  patch_body=$(jq -nc --arg s "$new_schedule" '{"scheduleExpression": $s}')

  local resp
  resp=$(api PATCH "/admin/mail/snapshot-schedule" "$patch_body")
  local http_code
  http_code=$(api_status PATCH "/admin/mail/snapshot-schedule" "$patch_body")

  if [[ "$http_code" == "200" ]]; then
    ok "PATCH /admin/mail/snapshot-schedule returned 200"
  else
    fail "PATCH /admin/mail/snapshot-schedule returned $http_code (resp: $(echo "$resp" | head -c 300))"
    return
  fi

  local returned_schedule
  returned_schedule=$(jq -r '.data.scheduleExpression // empty' <<<"$resp")

  if [[ "$returned_schedule" == "$new_schedule" ]]; then
    ok "data.scheduleExpression = '$returned_schedule' (matches sent value)"
  else
    fail "data.scheduleExpression = '$returned_schedule' (expected '$new_schedule')"
  fi

  # Restore original
  if [[ "${SKIP_CLEANUP:-0}" != "1" ]]; then
    local restore_body restore_code
    restore_body=$(jq -nc --arg s "$original_schedule" '{"scheduleExpression": $s}')
    restore_code=$(api_status PATCH "/admin/mail/snapshot-schedule" "$restore_body")
    if [[ "$restore_code" == "200" ]]; then
      ok "Schedule restored to '$original_schedule'"
    else
      warn "Failed to restore schedule (HTTP $restore_code)"
    fi
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 11: snapshot-backup-target-read
# GET /admin/mail/snapshot-backup-target → 200 + shape has all required fields
# ─────────────────────────────────────────────────────────────────────────────

scenario_11_snapshot_backup_target_read() {
  run "11. snapshot-backup-target-read — GET /admin/mail/snapshot-backup-target → valid shape"

  local resp
  resp=$(api GET "/admin/mail/snapshot-backup-target")
  local http_code
  http_code=$(api_status GET "/admin/mail/snapshot-backup-target")

  if [[ "$http_code" == "200" ]]; then
    ok "GET /admin/mail/snapshot-backup-target returned 200"
  else
    fail "GET /admin/mail/snapshot-backup-target returned $http_code (resp: $(echo "$resp" | head -c 300))"
    return
  fi

  # backupStoreId may be null (no target configured) — but the key must be present.
  local has_backup_store_id has_backup_store_name has_storage_type
  has_backup_store_id=$(jq 'if .data | has("backupStoreId") then "yes" else "no" end' <<<"$resp")
  has_backup_store_name=$(jq 'if .data | has("backupStoreName") then "yes" else "no" end' <<<"$resp")
  has_storage_type=$(jq 'if .data | has("storageType") then "yes" else "no" end' <<<"$resp")

  if [[ "$has_backup_store_id" == '"yes"' ]]; then
    local store_id
    store_id=$(jq -r '.data.backupStoreId // "null"' <<<"$resp")
    ok "data.backupStoreId present (value: $store_id)"
  else
    fail "data.backupStoreId key is missing from response"
  fi

  if [[ "$has_backup_store_name" == '"yes"' ]]; then
    local store_name
    store_name=$(jq -r '.data.backupStoreName // "null"' <<<"$resp")
    ok "data.backupStoreName present (value: $store_name)"
  else
    fail "data.backupStoreName key is missing from response"
  fi

  if [[ "$has_storage_type" == '"yes"' ]]; then
    local storage_type
    storage_type=$(jq -r '.data.storageType // "null"' <<<"$resp")
    ok "data.storageType present (value: $storage_type)"
  else
    fail "data.storageType key is missing from response"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 12: snapshot-status-shape
# GET /admin/mail/snapshot-status → 200 + totalSnapshotSizeBytes key present
# ─────────────────────────────────────────────────────────────────────────────

scenario_12_snapshot_status_shape() {
  run "12. snapshot-status-shape — GET /admin/mail/snapshot-status includes totalSnapshotSizeBytes"

  local resp
  resp=$(api GET "/admin/mail/snapshot-status")
  local http_code
  http_code=$(api_status GET "/admin/mail/snapshot-status")

  if [[ "$http_code" == "200" ]]; then
    ok "GET /admin/mail/snapshot-status returned 200"
  else
    fail "GET /admin/mail/snapshot-status returned $http_code (resp: $(echo "$resp" | head -c 300))"
    return
  fi

  # totalSnapshotSizeBytes may be null before any restic upload — key must exist.
  local has_total has_backup_store
  has_total=$(jq 'if .data | has("totalSnapshotSizeBytes") then "yes" else "no" end' <<<"$resp")
  has_backup_store=$(jq 'if .data | has("backupStoreId") then "yes" else "no" end' <<<"$resp")

  if [[ "$has_total" == '"yes"' ]]; then
    local total_bytes
    total_bytes=$(jq -r '.data.totalSnapshotSizeBytes // "null"' <<<"$resp")
    ok "data.totalSnapshotSizeBytes present (value: $total_bytes)"
  else
    fail "data.totalSnapshotSizeBytes key is missing from snapshot-status response"
  fi

  if [[ "$has_backup_store" == '"yes"' ]]; then
    local store_id
    store_id=$(jq -r '.data.backupStoreId // "null"' <<<"$resp")
    ok "data.backupStoreId present (value: $store_id)"
  else
    fail "data.backupStoreId key is missing from snapshot-status response"
  fi

  # Spot-check other required fields are still present.
  local enabled schedule_expr
  enabled=$(jq -r '.data.enabled // empty' <<<"$resp")
  schedule_expr=$(jq -r '.data.scheduleExpression // empty' <<<"$resp")

  if [[ -n "$enabled" ]]; then
    ok "data.enabled = $enabled"
  else
    fail "data.enabled is missing"
  fi
  if [[ -n "$schedule_expr" ]]; then
    ok "data.scheduleExpression = '$schedule_expr'"
  else
    fail "data.scheduleExpression is missing"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 13: cronjob-restic-sidecar
# kubectl assert:
#   - initContainers OR containers named 'upload' (restic sidecar) is present
#   - SNAP_PATH env var on the stalwart container = '/snapshot/snap' (no .lz4)
# ─────────────────────────────────────────────────────────────────────────────

scenario_13_cronjob_restic_sidecar() {
  run "13. cronjob-restic-sidecar — kubectl assert upload sidecar + snap dir path"

  local cj_json
  if ! cj_json=$(kube get cronjob stalwart-snapshot -n mail -o json 2>/dev/null); then
    fail "CronJob stalwart-snapshot not found in namespace mail"
    warn "Deploy k8s/base/stalwart-mail/stalwart/snapshot-cronjob.yaml to fix"
    return
  fi

  # The upload sidecar must appear as a container named 'upload'.
  local upload_container_count
  upload_container_count=$(echo "$cj_json" | jq '[
    .spec.jobTemplate.spec.template.spec.containers[]?,
    .spec.jobTemplate.spec.template.spec.initContainers[]?
  ] | map(select(.name == "upload")) | length')

  if [[ "$upload_container_count" -ge 1 ]]; then
    ok "Container 'upload' (restic sidecar) found in CronJob pod template"
  else
    fail "No container named 'upload' found in stalwart-snapshot CronJob (restic sidecar missing)"
  fi

  # The snapshot container must use /snapshot/snap (directory), not /snapshot/snap.lz4 (file).
  # We look for SNAP_PATH env var on the 'snapshot' container.
  local snap_path
  snap_path=$(echo "$cj_json" | jq -r '
    .spec.jobTemplate.spec.template.spec.containers[]
    | select(.name == "snapshot")
    | .env[]?
    | select(.name == "SNAP_PATH")
    | .value // empty
  ' 2>/dev/null || echo "")

  if [[ -z "$snap_path" ]]; then
    # SNAP_PATH may be hardcoded in the shell command rather than an env var.
    # Fall back to grepping the command string.
    local cmd_string
    cmd_string=$(echo "$cj_json" | jq -r '
      .spec.jobTemplate.spec.template.spec.containers[]
      | select(.name == "snapshot")
      | (.command // []) + (.args // [])
      | join(" ")
    ' 2>/dev/null || echo "")

    if echo "$cmd_string" | grep -q 'snap\.lz4'; then
      fail "snapshot container still references snap.lz4 in command/args (should be /snapshot/snap dir)"
    elif echo "$cmd_string" | grep -q '/snapshot/snap'; then
      ok "snapshot container uses /snapshot/snap (directory, not .lz4 file)"
    else
      warn "Could not determine SNAP_PATH from container spec — inspect manually"
    fi
  elif [[ "$snap_path" == *".lz4"* ]]; then
    fail "SNAP_PATH = '$snap_path' still references .lz4 (should be /snapshot/snap directory)"
  else
    ok "SNAP_PATH = '$snap_path' (directory path, not .lz4 file)"
  fi

  # The upload sidecar should have envFrom referencing stalwart-snapshot-restic-repo.
  local restic_secret_ref
  restic_secret_ref=$(echo "$cj_json" | jq -r '
    .spec.jobTemplate.spec.template.spec.containers[]
    | select(.name == "upload")
    | .envFrom[]?
    | select(.secretRef.name == "stalwart-snapshot-restic-repo")
    | .secretRef.name
  ' 2>/dev/null || echo "")

  if [[ "$restic_secret_ref" == "stalwart-snapshot-restic-repo" ]]; then
    ok "upload sidecar has envFrom.secretRef = stalwart-snapshot-restic-repo"
  else
    warn "upload sidecar envFrom.secretRef stalwart-snapshot-restic-repo not found (may be absent until a backup target is set)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

# State carried between scenarios
CURRENT_NODE=""
INITIAL_NODE_MODE=""
INITIAL_NODE_NAME=""

login

scenario_1_blob_store_read
scenario_2_node_selector_read
scenario_3_node_selector_preferred
scenario_4_node_selector_invalid
scenario_5_snapshot_trigger
scenario_6_cifs_reject_localhost
scenario_7_blobstore_switch_default
scenario_8_cronjob_exists
scenario_9_snapshot_schedule_read
scenario_10_snapshot_schedule_update
scenario_11_snapshot_backup_target_read
scenario_12_snapshot_status_shape
scenario_13_cronjob_restic_sidecar

printf '\n%b━━━ Summary ━━━%b\n' "$CYAN" "$RESET"
printf '  passed: %b%d%b\n' "$GREEN" "$passed" "$RESET"
printf '  failed: %b%d%b\n' "$RED"   "$failed" "$RESET"

[[ "$failed" -eq 0 ]] && exit 0 || exit 1
