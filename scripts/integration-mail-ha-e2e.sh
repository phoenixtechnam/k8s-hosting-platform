#!/usr/bin/env bash
# End-to-end harness for Stalwart mail server HA + CIFS BlobStore features.
#
# Drives the full admin-API surface for:
#   - BlobStore singleton read + switch
#   - Node selector read + update
#   - Manual snapshot trigger + Job poll
#   - CIFS validation guards
#   - CronJob infrastructure existence check
#
# Scenarios:
#   1. blob-store-read         — GET /admin/mail/blob-store → 200 + valid shape
#   2. node-selector-read      — GET /admin/mail/node-selector → 200 + valid shape
#   3. node-selector-preferred — PATCH preferred mode → 200 + assert mode; cleanup to 'any'
#   4. node-selector-invalid   — PATCH required + nonexistent node → 4xx MAIL_NODE_NOT_FOUND
#   5. snapshot-trigger        — POST trigger → Job created; poll to succeeded/warn-on-fail
#   6. cifs-reject-localhost   — PATCH CIFS with host=localhost → 4xx
#   7. blobstore-switch-default — PATCH Default → Job; poll; re-read asserts Default
#   8. snapshot-cronjob-exists  — kubectl assert CronJob schedule + concurrencyPolicy
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

  # Stash for use in later scenarios
  INITIAL_BLOB_TYPE="$type"
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
# Main
# ─────────────────────────────────────────────────────────────────────────────

# State carried between scenarios
INITIAL_BLOB_TYPE=""
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

printf '\n%b━━━ Summary ━━━%b\n' "$CYAN" "$RESET"
printf '  passed: %b%d%b\n' "$GREEN" "$passed" "$RESET"
printf '  failed: %b%d%b\n' "$RED"   "$failed" "$RESET"

[[ "$failed" -eq 0 ]] && exit 0 || exit 1
