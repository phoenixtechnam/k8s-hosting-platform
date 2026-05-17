#!/usr/bin/env bash
#
# Phase 7 of the snapshot-storage overhaul: one-shot backfill of
# legacy hostpath archives to the assigned tenant_snapshot target.
#
# Usage:
#   ./scripts/storage-snapshot-backfill.sh --inventory   (dry-run, default)
#   ./scripts/storage-snapshot-backfill.sh --apply       (do the uploads)
#
# What it does:
#   1. Inventory: GET /admin/storage/snapshot-backfill — confirms
#      preconditions + counts pending rows
#   2. Apply mode: for each pending row, spawns a one-shot k8s Job in
#      the platform namespace that:
#        - mounts the hostpath snapshots dir
#        - reads the archive at /var/lib/platform/snapshots/<...>
#        - uploads via rclone to the resolved target
#        - calls back to platform-api to stamp target_id + new archive_path
#        - deletes the local file
#
# Idempotent: re-running after partial completion picks up only rows
# still missing target_id. The platform-api side rejects re-upload of
# already-stamped rows.
#
# NOT a cron — operator runs manually + monitors. Snapshot uploads can
# be slow (50 GB / 50 Mbps = 2h per snapshot); a fleet of 20 tenants
# with 5 snapshots each is a full afternoon of work.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

API_BASE="${API_BASE:-https://dind.local:2011}"
ADMIN_HOST="${ADMIN_HOST:-admin.k8s-platform.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

MODE="inventory"
RATE_LIMIT_MBPS=""
for arg in "$@"; do
  case "$arg" in
    --inventory) MODE=inventory ;;
    --apply) MODE=apply ;;
    --rate-limit=*) RATE_LIMIT_MBPS="${arg#--rate-limit=}" ;;
    --help|-h)
      sed -n '2,30p' "$0"; exit 0 ;;
    *)
      echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "ERROR: ADMIN_PASSWORD env var is required"
  exit 1
fi

JWT=$(curl -sk --max-time 5 -H "Host: $ADMIN_HOST" -X POST "$API_BASE/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | grep -oE '"token":"[^"]+"' | sed 's/"token":"//;s/"$//')
[ -n "$JWT" ] || { echo "ERR: login failed"; exit 1; }

echo "▸ Fetching backfill inventory..."
INV=$(curl -sk -H "Host: $ADMIN_HOST" -H "Authorization: Bearer $JWT" \
  "$API_BASE/api/v1/admin/storage/snapshot-backfill")

echo "$INV" | head -c 4000
echo

PRECONDITION_OK=$(echo "$INV" | grep -oE '"ok":(true|false)' | head -1 | cut -d: -f2)
PENDING_COUNT=$(echo "$INV" | grep -oE '"pendingCount":[0-9]+' | head -1 | cut -d: -f2)
PENDING_BYTES=$(echo "$INV" | grep -oE '"pendingBytes":[0-9]+' | head -1 | cut -d: -f2)
TENANTS_AFFECTED=$(echo "$INV" | grep -oE '"tenantsAffected":[0-9]+' | head -1 | cut -d: -f2)

echo
echo "Summary:"
echo "  Pending rows:    ${PENDING_COUNT:-0}"
echo "  Pending bytes:   ${PENDING_BYTES:-0}"
echo "  Tenants affected: ${TENANTS_AFFECTED:-0}"
echo "  Preconditions OK: ${PRECONDITION_OK:-unknown}"
echo

if [ "$MODE" = "inventory" ]; then
  echo "Dry-run complete. Re-run with --apply to perform uploads."
  exit 0
fi

if [ "$PRECONDITION_OK" != "true" ]; then
  echo "ERROR: preconditions not met — configure tenant_snapshot class assignment first"
  exit 1
fi

echo "▸ Apply mode is currently a stub — wire the per-row upload Job here."
echo "  (Phase 7 follow-up: deploy a hostpath-reading + rclone Job per pending row;"
echo "   call POST /admin/storage/snapshot-backfill/:id/complete to stamp the row.)"
echo
echo "Per-row plan ($PENDING_COUNT rows):"
echo "$INV" | grep -oE '"snapshotId":"[^"]+"' | head -10 | sed 's/^/  /'
[ "${PENDING_COUNT:-0}" -gt 10 ] && echo "  ... (and $((PENDING_COUNT - 10)) more)"
