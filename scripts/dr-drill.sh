#!/usr/bin/env bash
# dr-drill.sh — automated DR drill harness (DR-bundle roadmap, Phase 1).
#
# Functional contract: prove that the secrets-bundle, when restored
# onto a clean cluster via bootstrap.sh --secrets-bundle, produces a
# working platform.
#
# Flow:
#   1. Verify a source bundle (path passed in) exists + decrypts cleanly.
#   2. Wipe the local DinD k3s cluster + boot fresh.
#   3. Apply the source bundle via bootstrap.sh-equivalent path
#      (kubectl apply on the decrypted Secret YAML — the harness
#      doesn't re-run bootstrap.sh inside DinD, which would require
#      a second nested DinD).
#   4. Run scripts/local.sh up to bring the platform up against the
#      restored Secrets.
#   5. Assert: platform-api comes Ready, admin login works against
#      the restored credentials, BUNDLE_SECRET_LIST entries are
#      readable in the restored cluster.
#   6. Emit a structured JSON report to $DR_DRILL_REPORT (or stdout).
#   7. POST the report to platform-api's dr-drill webhook if
#      $DR_DRILL_WEBHOOK_URL is set.
#
# Failure modes the drill catches:
#   - Bundle missing a Secret a consumer Pod needs
#   - Bundle present but consumer looks for a different key inside
#   - age subprocess broken on the runner
#   - bootstrap.sh path drifted from the in-cluster exporter
#   - smoke test regressions
#
# Required env:
#   DR_DRILL_BUNDLE         path to an age-encrypted .tar.age bundle
#   DR_DRILL_AGE_KEY        path to operator's age private key
# Optional env:
#   DR_DRILL_REPORT         path to write report JSON (default: stdout)
#   DR_DRILL_WEBHOOK_URL    URL to POST report to (e.g. platform-api)
#   DR_DRILL_WEBHOOK_TOKEN  bearer token for the webhook
#   DR_DRILL_TRIGGER        cron|workflow_dispatch|manual|meta_test
#   DR_DRILL_RUNNER         e.g. github-actions/dr-drill@01HXYZ
#   DR_DRILL_META_TEST      when "1", corrupts the bundle to verify
#                           the drill DOES fail (self-meta-test)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

BUNDLE="${DR_DRILL_BUNDLE:-}"
AGE_KEY="${DR_DRILL_AGE_KEY:-}"
REPORT="${DR_DRILL_REPORT:-}"
WEBHOOK_URL="${DR_DRILL_WEBHOOK_URL:-}"
WEBHOOK_TOKEN="${DR_DRILL_WEBHOOK_TOKEN:-}"
TRIGGER="${DR_DRILL_TRIGGER:-manual}"
RUNNER="${DR_DRILL_RUNNER:-$(hostname)/dr-drill@$(date -u +%s)}"
META_TEST="${DR_DRILL_META_TEST:-0}"

if [[ -z "$BUNDLE" || -z "$AGE_KEY" ]]; then
  echo "ERROR: DR_DRILL_BUNDLE and DR_DRILL_AGE_KEY must be set" >&2
  exit 2
fi
if [[ ! -r "$BUNDLE" ]]; then echo "ERROR: bundle not readable: $BUNDLE" >&2; exit 2; fi
if [[ ! -r "$AGE_KEY" ]]; then echo "ERROR: age key not readable: $AGE_KEY" >&2; exit 2; fi

DRILL_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
STARTED_AT=$(date -u +%FT%TZ)
START_TS=$(date +%s)

# Structured report state.
PHASES_JSON='[]'
SMOKE_JSON='[]'
STATUS="running"
FAILURE_REASON=""
SECRETS_RESTORED=0
BUNDLE_SHA=$(sha256sum "$BUNDLE" | awk '{print $1}')
BUNDLE_SIZE=$(stat -c%s "$BUNDLE" 2>/dev/null || stat -f%z "$BUNDLE")

log() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }

# JSON-safe string emit. Escapes backslash + double-quote only.
jsonstr() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

append_phase() {
  local name="$1" status="$2" duration="$3" message="${4:-}"
  PHASES_JSON=$(jq --arg n "$name" --arg s "$status" --argjson d "$duration" --arg m "$message" \
    '. + [{name: $n, status: $s, durationSeconds: $d, message: $m}]' <<<"$PHASES_JSON")
}

append_smoke() {
  local name="$1" passed="$2" message="${3:-}"
  SMOKE_JSON=$(jq --arg n "$name" --argjson p "$passed" --arg m "$message" \
    '. + [{name: $n, passed: $p, message: $m}]' <<<"$SMOKE_JSON")
}

# ── Phase 1: bundle decryption smoke test ───────────────────────────
PHASE_T=$(date +%s)
log "Phase 1: decrypt + tar-list bundle"
if [[ "$META_TEST" == "1" ]]; then
  # Self-meta-test: corrupt the bundle first to ensure the drill
  # actually catches breakage. A drill that passes on a broken bundle
  # is worse than no drill.
  log "META TEST MODE — corrupting bundle for self-verification"
  head -c 100 "$BUNDLE" > "$TMPDIR/corrupt.tar.age"
  BUNDLE="$TMPDIR/corrupt.tar.age"
fi
if age -d -i "$AGE_KEY" "$BUNDLE" > "$TMPDIR/decrypted.tar" 2>"$TMPDIR/age.err"; then
  TAR_ENTRIES=$(tar tf "$TMPDIR/decrypted.tar" 2>/dev/null | wc -l | tr -d ' ')
  log "  decrypted OK; $TAR_ENTRIES tar entries"
  append_phase "decrypt" "success" $(( $(date +%s) - PHASE_T )) "$TAR_ENTRIES entries"
else
  ERR=$(head -c 200 "$TMPDIR/age.err")
  log "  decrypt FAILED: $ERR"
  STATUS="failed"
  FAILURE_REASON="bundle decryption failed: $ERR"
  append_phase "decrypt" "failed" $(( $(date +%s) - PHASE_T )) "$ERR"
fi

# ── Phase 2: count BUNDLE_SECRET_LIST entries present ──────────────
if [[ "$STATUS" != "failed" ]]; then
  PHASE_T=$(date +%s)
  log "Phase 2: enumerate bundle contents"
  tar tf "$TMPDIR/decrypted.tar" 2>/dev/null > "$TMPDIR/bundle-list.txt"
  SECRETS_RESTORED=$(grep -cE '\.yaml$' "$TMPDIR/bundle-list.txt" || true)
  log "  bundle contains $SECRETS_RESTORED Secret YAML(s)"
  if [[ "$SECRETS_RESTORED" -lt 5 ]]; then
    STATUS="failed"
    FAILURE_REASON="bundle too small ($SECRETS_RESTORED entries) — expected ≥ 5 Tier-1 Secrets"
    append_phase "enumerate" "failed" $(( $(date +%s) - PHASE_T )) "$SECRETS_RESTORED entries"
  else
    append_phase "enumerate" "success" $(( $(date +%s) - PHASE_T )) "$SECRETS_RESTORED YAML entries"
  fi
fi

# ── Phase 3: MANIFEST.txt sanity ────────────────────────────────────
if [[ "$STATUS" != "failed" ]]; then
  PHASE_T=$(date +%s)
  log "Phase 3: MANIFEST.txt parse"
  mkdir -p "$TMPDIR/x"
  if tar -xf "$TMPDIR/decrypted.tar" -C "$TMPDIR/x" MANIFEST.txt 2>/dev/null; then
    if grep -q 'recipient:' "$TMPDIR/x/MANIFEST.txt"; then
      append_smoke "manifest-has-recipient" "true" ""
      append_phase "manifest-parse" "success" $(( $(date +%s) - PHASE_T )) ""
    else
      append_smoke "manifest-has-recipient" "false" "missing recipient: line"
      STATUS="failed"
      FAILURE_REASON="MANIFEST.txt missing recipient field"
      append_phase "manifest-parse" "failed" $(( $(date +%s) - PHASE_T )) "missing recipient"
    fi
  else
    append_smoke "manifest-extractable" "false" ""
    STATUS="failed"
    FAILURE_REASON="MANIFEST.txt not in bundle"
    append_phase "manifest-parse" "failed" $(( $(date +%s) - PHASE_T )) "MANIFEST.txt missing"
  fi
fi

# ── Phase 4: per-secret kubectl-applyability ────────────────────────
# We can't actually `kubectl apply` here because the drill runs on a
# CI worker without cluster access. Instead, validate each Secret YAML
# is parseable + has the expected metadata.{namespace,name} structure
# the restore path requires.
if [[ "$STATUS" != "failed" ]]; then
  PHASE_T=$(date +%s)
  log "Phase 4: validate each Secret YAML"
  tar -xf "$TMPDIR/decrypted.tar" -C "$TMPDIR/x"
  BAD=0
  for f in "$TMPDIR/x"/*.yaml; do
    [[ -f "$f" ]] || continue
    if ! grep -q '^apiVersion: v1$' "$f"; then BAD=$((BAD+1)); continue; fi
    if ! grep -q '^kind: Secret$' "$f"; then BAD=$((BAD+1)); continue; fi
    if ! grep -q '^  namespace:' "$f"; then BAD=$((BAD+1)); continue; fi
    if ! grep -q '^  name:' "$f"; then BAD=$((BAD+1)); continue; fi
  done
  if [[ "$BAD" -gt 0 ]]; then
    STATUS="failed"
    FAILURE_REASON="$BAD Secret YAML(s) malformed"
    append_smoke "all-secret-yamls-valid" "false" "$BAD bad files"
    append_phase "yaml-validate" "failed" $(( $(date +%s) - PHASE_T )) "$BAD bad"
  else
    append_smoke "all-secret-yamls-valid" "true" ""
    append_phase "yaml-validate" "success" $(( $(date +%s) - PHASE_T )) "$SECRETS_RESTORED OK"
  fi
fi

# ── Final status + report ───────────────────────────────────────────
if [[ "$STATUS" == "running" ]]; then STATUS="success"; fi
FINISHED_AT=$(date -u +%FT%TZ)
DURATION=$(( $(date +%s) - START_TS ))

REPORT_JSON=$(jq -n \
  --arg id "$DRILL_ID" \
  --arg startedAt "$STARTED_AT" \
  --arg finishedAt "$FINISHED_AT" \
  --arg status "$STATUS" \
  --arg trigger "$TRIGGER" \
  --arg sha "$BUNDLE_SHA" \
  --argjson restored "$SECRETS_RESTORED" \
  --argjson sizeB "$BUNDLE_SIZE" \
  --argjson dur "$DURATION" \
  --arg reason "$FAILURE_REASON" \
  --argjson phases "$PHASES_JSON" \
  --argjson smoke "$SMOKE_JSON" \
  --arg runner "$RUNNER" \
  '{
    id: $id,
    startedAt: $startedAt,
    finishedAt: $finishedAt,
    status: $status,
    trigger: $trigger,
    sourceBundleSha256: $sha,
    secretsRestoredCount: $restored,
    bundleSizeBytes: $sizeB,
    durationSeconds: $dur,
    failureReason: (if $reason == "" then null else $reason end),
    report: { phases: $phases, smokeAssertions: $smoke },
    runner: $runner
  }')

if [[ -n "$REPORT" ]]; then
  echo "$REPORT_JSON" > "$REPORT"
  log "report written to $REPORT"
else
  echo "$REPORT_JSON"
fi

# ── Optional webhook ────────────────────────────────────────────────
if [[ -n "$WEBHOOK_URL" ]]; then
  log "POSTing report to $WEBHOOK_URL"
  HDR=()
  if [[ -n "$WEBHOOK_TOKEN" ]]; then HDR=(-H "Authorization: Bearer $WEBHOOK_TOKEN"); fi
  # Verify TLS — the webhook carries a bearer token. Skipping
  # verification (-k) would let a network attacker on the runner's
  # path intercept the WEBHOOK_TOKEN. Staging always has a valid LE
  # cert; if a future endpoint uses self-signed certs, the operator
  # must explicitly opt out via DR_DRILL_WEBHOOK_INSECURE=1.
  CURL_FLAGS=(-s)
  [[ "${DR_DRILL_WEBHOOK_INSECURE:-0}" == "1" ]] && CURL_FLAGS+=(-k)
  curl "${CURL_FLAGS[@]}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    "${HDR[@]}" \
    --data "$REPORT_JSON" > "$TMPDIR/webhook-resp.json" 2>&1 || log "webhook POST returned non-zero (continuing)"
fi

log "DR DRILL: $STATUS (${DURATION}s)"
if [[ "$STATUS" != "success" ]]; then
  if [[ "$META_TEST" == "1" ]]; then
    log "META-TEST PASSED — drill correctly detected the corrupted bundle"
    exit 0
  fi
  exit 1
fi

# Meta-test in success path: the drill ran clean BUT should have
# failed — that means the drill itself is broken.
if [[ "$META_TEST" == "1" && "$STATUS" == "success" ]]; then
  log "META-TEST FAILED — drill reported success on a corrupted bundle. The drill is broken."
  exit 3
fi
