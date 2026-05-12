#!/bin/sh
# snapshot-upload.sh — restic backup sidecar for the stalwart-snapshot CronJob.
#
# Waits for /snapshot/done (written by the stalwart export container), then
# runs `restic backup /snapshot/snap/` to upload the snapshot directory to
# the configured restic repository.
#
# If RESTIC_REPOSITORY is empty or not set (Secret missing / not configured),
# exits 0 with an informational log — upload is optional.
#
# After a successful backup, reports stats to the platform API so the
# snapshot-status card can display total repo size.
#
# Env vars (from stalwart-snapshot-restic-repo Secret — all optional):
#   RESTIC_REPOSITORY   e.g. s3:https://s3.hetzner.com/bucket/mail-snapshots
#   RESTIC_PASSWORD     repo encryption password
#   AWS_ACCESS_KEY_ID   S3 access key (when using S3 backend)
#   AWS_SECRET_ACCESS_KEY S3 secret key
#
# Env vars (from pod spec):
#   PLATFORM_API_URL    internal platform API URL (default: http://platform-api.platform.svc.cluster.local:3000)
#   PLATFORM_API_TOKEN  SA token for platform API internal endpoints (optional)

set -e

SNAP_DIR=/snapshot/snap
DONE_FILE=/snapshot/done
PLATFORM_API_URL="${PLATFORM_API_URL:-http://platform-api.platform.svc.cluster.local:3000}"

# ── Wait for export to complete ──────────────────────────────────────────────

echo "=== snapshot-upload: waiting for /snapshot/done ==="
WAIT_MAX=300   # 5 minutes max
WAITED=0
while [ ! -f "$DONE_FILE" ]; do
  if [ "$WAITED" -ge "$WAIT_MAX" ]; then
    echo "ERROR: timed out waiting for $DONE_FILE after ${WAIT_MAX}s" >&2
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done
echo "=== snapshot-upload: export complete (waited ${WAITED}s) ==="

# ── Check if upload is configured ───────────────────────────────────────────

if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  echo "=== snapshot-upload: RESTIC_REPOSITORY not set — skipping upload ==="
  echo "    Configure a BackupStore for mail snapshots via the admin panel."
  exit 0
fi

if [ ! -d "$SNAP_DIR" ]; then
  echo "ERROR: snapshot directory $SNAP_DIR not found" >&2
  exit 1
fi

# ── Initialize repo if it doesn't exist yet ──────────────────────────────────

echo "=== snapshot-upload: initialising or checking restic repo ==="
if ! restic snapshots --quiet > /dev/null 2>&1; then
  echo "=== snapshot-upload: repo not found, running restic init ==="
  restic init
fi

# ── Run restic backup ────────────────────────────────────────────────────────

echo "=== snapshot-upload: backing up $SNAP_DIR ==="
restic backup \
  --tag "stalwart-snapshot" \
  --tag "auto" \
  --hostname "stalwart-mail" \
  "$SNAP_DIR"

echo "=== snapshot-upload: backup complete — running restic forget/prune ==="
# Keep last 48 snapshots (covers ~4 days at 2-min schedule).
restic forget \
  --keep-last 48 \
  --prune \
  --tag "stalwart-snapshot" \
  --quiet

# ── Collect stats and report to platform API ─────────────────────────────────

echo "=== snapshot-upload: collecting repo stats ==="
STATS_JSON=$(restic stats --json --mode raw-data 2>/dev/null || echo '{}')
TOTAL_SIZE=$(printf '%s' "$STATS_JSON" | grep -o '"total_size":[0-9]*' | grep -o '[0-9]*' || echo '0')
SNAP_COUNT=$(restic snapshots --json --tag stalwart-snapshot 2>/dev/null | grep -c '"time"' || echo '0')

echo "=== snapshot-upload: totalSizeBytes=$TOTAL_SIZE snapshotCount=$SNAP_COUNT ==="

# Report to platform API (best-effort — do not fail the Job if API is down).
if [ -n "${PLATFORM_API_TOKEN:-}" ]; then
  PAYLOAD=$(printf '{"totalSnapshotSizeBytes":%s,"snapshotCount":%s}' "$TOTAL_SIZE" "$SNAP_COUNT")
  HTTP_CODE=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${PLATFORM_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "${PLATFORM_API_URL}/api/v1/internal/mail/snapshot-last-run" 2>/dev/null || echo "000")
  echo "=== snapshot-upload: reported stats to platform-api (HTTP $HTTP_CODE) ==="
else
  echo "=== snapshot-upload: no PLATFORM_API_TOKEN — skipping stats report ==="
fi

echo "=== snapshot-upload: done ==="
