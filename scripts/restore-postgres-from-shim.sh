#!/usr/bin/env bash
# restore-postgres-from-shim.sh — R-X11 restore tooling for SYSTEM.postgres.
#
# Restores the platform CNPG cluster `system-db` from the
# backup-rclone-shim's `s3://system/postgres` bucket via the
# plugin-barman-cloud cnpg-i plugin (R-X6).
#
# Two modes:
#   --latest   — newest base backup + replay WALs to the latest LSN
#   --pitr <T> — base backup + replay WALs up to timestamp T
#                (RFC3339, e.g. "2026-05-20T10:00:00Z")
#
# Pre-flight:
#   * SYSTEM target bound (POST /admin/backup-rclone-shim/assignments/system)
#   * backup-rclone-shim DaemonSet up + s3://system bucket accessible
#   * Postgres plugin-barman-cloud deployed in cnpg-system
#   * NOT running on the live system-db pod's node (the new Cluster
#     gets a fresh PVC; the old `system-db` Cluster is left intact
#     for safety — operator must rename/delete the old one before
#     traffic switches)
#
# Usage:
#   ./scripts/restore-postgres-from-shim.sh --latest
#   ./scripts/restore-postgres-from-shim.sh --pitr 2026-05-20T10:00:00Z
#   ./scripts/restore-postgres-from-shim.sh --dry-run --latest
#
# The script creates a NEW Cluster CR `system-db-restore-<ts>` with
# `bootstrap.recovery` pointing at the same ObjectStore. Once the new
# Cluster is Ready, operator manually swaps Services / DNS / app
# connection strings (no automatic cutover — too dangerous).
#
# Exit codes:
#   0   success
#   1   pre-flight failed
#   2   restore Cluster never became Ready (timeout)
#   3   apiserver error (kubectl / kustomize)
#
# This script does NOT delete anything. The new Cluster ships
# WITH ITS OWN PVC. If the operator wants to roll forward by
# replacing system-db, the recipe is in BACKUP_RCLONE_SHIM.md.

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────
MODE=""
PITR_TARGET=""
DRY_RUN=0
TIMEOUT_SECONDS=1800
RESTORE_CLUSTER_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)              MODE="latest"; shift ;;
    --pitr)                MODE="pitr"; PITR_TARGET="${2:?--pitr requires a RFC3339 timestamp}"; shift 2 ;;
    --dry-run)             DRY_RUN=1; shift ;;
    --timeout-seconds)     TIMEOUT_SECONDS="${2:?}"; shift 2 ;;
    --name)                RESTORE_CLUSTER_NAME="${2:?}"; shift 2 ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "ERROR: --latest or --pitr <RFC3339> required" >&2
  exit 1
fi

TS=$(date -u +%Y%m%d-%H%M%S)
RESTORE_CLUSTER_NAME="${RESTORE_CLUSTER_NAME:-system-db-restore-$TS}"
PLATFORM_NS="platform"

# ── Pre-flight ───────────────────────────────────────────────────────
log() { printf '\033[34m[restore-postgres]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[restore-postgres FAIL]\033[0m %s\n' "$1" >&2; exit 1; }

log "Pre-flight: kubectl reachable + plugin-barman-cloud installed"
if ! kubectl version --client=true >/dev/null 2>&1; then
  fail "kubectl not in PATH"
fi
# In dry-run mode, the cluster doesn't need to be fully set up — we
# just print the manifest. Skip the live checks but warn so the
# operator knows they need real state for an actual restore.
if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN: skipping plugin/ObjectStore/Secret pre-flight (target manifest will be rendered without cluster validation)"
else
  if ! kubectl -n cnpg-system get deployment barman-cloud >/dev/null 2>&1; then
    fail "plugin-barman-cloud Deployment not found in cnpg-system. Run apply k8s/base/cnpg-system/ via Flux or manually."
  fi
  if ! kubectl -n "$PLATFORM_NS" get objectstore system-postgres-objectstore >/dev/null 2>&1; then
    fail "ObjectStore CR not present. Operator must bind SYSTEM shim class to a target first (PUT /api/v1/admin/backup-rclone-shim/assignments/system)."
  fi
  if ! kubectl -n "$PLATFORM_NS" get secret backup-rclone-shim-creds >/dev/null 2>&1; then
    fail "backup-rclone-shim-creds Secret missing. Reconciler not yet run; check platform-api logs."
  fi
fi
log "Pre-flight: OK"

# ── Render the recovery Cluster CR ──────────────────────────────────
RECOVERY_SPEC=""
if [[ "$MODE" == "latest" ]]; then
  RECOVERY_SPEC=""
elif [[ "$MODE" == "pitr" ]]; then
  if [[ ! "$PITR_TARGET" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    fail "PITR target must be RFC3339 (e.g. 2026-05-20T10:00:00Z), got: $PITR_TARGET"
  fi
  RECOVERY_SPEC=$(cat <<EOF
    recoveryTarget:
      targetTime: "$PITR_TARGET"
EOF
)
fi

MANIFEST=$(cat <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: $RESTORE_CLUSTER_NAME
  namespace: $PLATFORM_NS
  labels:
    app: postgres-restore
    app.kubernetes.io/part-of: hosting-platform
    app.kubernetes.io/managed-by: restore-postgres-from-shim
  annotations:
    platform.phoenix-host.net/restore-source: system-postgres-objectstore
    platform.phoenix-host.net/restore-mode: "$MODE"
    platform.phoenix-host.net/restore-pitr-target: "$PITR_TARGET"
spec:
  # New cluster — 1 instance is enough to validate the restore.
  # Operator scales out manually after rename + cutover.
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:18.3-minimal-trixie
  storage:
    size: 5Gi
    storageClass: longhorn-system-local
  bootstrap:
    recovery:
      source: source
$RECOVERY_SPEC
  externalClusters:
    - name: source
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: system-postgres-objectstore
EOF
)

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN — manifest that WOULD be applied:"
  echo "---"
  echo "$MANIFEST"
  exit 0
fi

# ── Apply ────────────────────────────────────────────────────────────
log "Applying restore Cluster CR: $RESTORE_CLUSTER_NAME (mode=$MODE${PITR_TARGET:+, pitr=$PITR_TARGET})"
echo "$MANIFEST" | kubectl apply -f -

# ── Wait for Ready ──────────────────────────────────────────────────
log "Waiting up to ${TIMEOUT_SECONDS}s for the restore Cluster to reach Ready (this can take several minutes)..."
DEADLINE=$(($(date +%s) + TIMEOUT_SECONDS))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  status=$(kubectl -n "$PLATFORM_NS" get cluster "$RESTORE_CLUSTER_NAME" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  ready=$(kubectl -n "$PLATFORM_NS" get cluster "$RESTORE_CLUSTER_NAME" -o jsonpath='{.status.readyInstances}' 2>/dev/null || echo "0")
  log "  phase=$status readyInstances=$ready"
  if [[ "$ready" == "1" || "$ready" == "2" || "$ready" == "3" ]]; then
    break
  fi
  if [[ "$status" == "Failed" || "$status" == "Error" ]]; then
    log "Cluster entered failure state — inspect: kubectl -n $PLATFORM_NS describe cluster $RESTORE_CLUSTER_NAME"
    exit 2
  fi
  sleep 15
done
if ! [[ "$ready" == "1" || "$ready" == "2" || "$ready" == "3" ]]; then
  log "Restore Cluster did not become Ready within ${TIMEOUT_SECONDS}s. Last status: phase=$status readyInstances=$ready"
  exit 2
fi

# ── Summary ──────────────────────────────────────────────────────────
log "Restore Cluster $RESTORE_CLUSTER_NAME is Ready."
log ""
log "Next steps (manual — script does NOT cutover automatically):"
log "  1. Validate the restored data:"
log "       kubectl -n $PLATFORM_NS exec -it $RESTORE_CLUSTER_NAME-1 -- psql -c '\\\\l'"
log ""
log "  2. To replace system-db with the restored data, the operator must:"
log "       a) Stop platform-api: kubectl -n $PLATFORM_NS scale deploy/platform-api --replicas=0"
log "       b) Delete system-db: kubectl -n $PLATFORM_NS delete cluster system-db"
log "       c) Rename the restore: kubectl -n $PLATFORM_NS get cluster $RESTORE_CLUSTER_NAME -o yaml | sed 's/$RESTORE_CLUSTER_NAME/system-db/g' | kubectl apply -f -"
log "       d) Restart platform-api: kubectl -n $PLATFORM_NS scale deploy/platform-api --replicas=1"
log ""
log "  3. To keep the restore as a SECOND cluster for inspection (recommended):"
log "       no further action — it stays at $RESTORE_CLUSTER_NAME-rw.$PLATFORM_NS.svc:5432"
log ""
log "Recovery COMPLETE. See docs/02-operations/BACKUP_RCLONE_SHIM.md for the full operator playbook."
