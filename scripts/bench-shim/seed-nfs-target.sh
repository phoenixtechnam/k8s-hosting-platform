#!/usr/bin/env bash
# Seed an NFS backup target row pointing at the staging nfs-test-server
# Service, and bind the `system` shim class to it. Used by run.sh to
# bring up the NFS bench upstream.
#
# Why direct DB INSERT instead of POST /api/v1/admin/backup-configs:
# the create-backup-config schema (api-contracts/src/backup-config.ts)
# only enumerates s3/ssh/cifs — NFS is supported by the renderer +
# DB schema but isn't operator-exposed in the form UI. Until there's
# operator demand for production NFS targets, the bench harness
# bypasses the API and writes directly.
#
# STAGING-ONLY. Refuses to run if the target server isn't
# nfs-test-server.platform.svc.cluster.local.
set -euo pipefail

SSH="ssh -i $HOME/hosting-platform.key -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@staging1.phoenix-host.net"
NFS_SERVER="nfs-test-server.platform.svc.cluster.local"
NFS_EXPORT="/nfsshare"
NFS_VERSION="4.2"

log() { printf '[seed-nfs-target] %s\n' "$*" >&2; }

# ── 0. Refuse to touch a non-staging cluster ─────────────────────────
# Defence in depth: the SSH target above is hardcoded to staging1,
# but if this script is ever templated or run from a different host,
# verify the kubeconfig context still points at staging before any
# DB writes hit. The platform.phoenix-host.net/environment label is
# applied to the platform namespace by the staging overlay.
CLUSTER_CONTEXT=$($SSH "kubectl config current-context" || echo "")
CLUSTER_LABEL=$($SSH "kubectl get ns platform -o jsonpath='{.metadata.labels.platform\\.phoenix-host\\.net/environment}'" 2>/dev/null || echo "")
if [[ "$CLUSTER_CONTEXT" != *staging* && "$CLUSTER_LABEL" != "staging" ]]; then
  log "FATAL: cluster context '$CLUSTER_CONTEXT' / label '$CLUSTER_LABEL' is not staging — refusing to seed NFS test target"
  exit 2
fi

# Wait for the nfs-test-server pod to be Ready (NFS exports take a
# few seconds to come up after the pod starts).
log "waiting for nfs-test-server Deployment to be Ready..."
$SSH "kubectl -n platform rollout status deployment/nfs-test-server --timeout=120s"

# Generate a UUID for the backup_configurations row.
TARGET_ID=$(uuidgen)
log "target id: $TARGET_ID"

# Direct DB INSERT via the cnpg postgres primary pod. Uses the
# platform's PG credentials Secret (mounted in the pod's env).
$SSH "kubectl -n platform exec -i system-db-1 -- psql -U platform -d platform <<SQL
DELETE FROM backup_target_assignments WHERE class_name = 'system';
DELETE FROM backup_configurations WHERE name = 'nfs-test-bench';

INSERT INTO backup_configurations (
  id, name, storage_type,
  nfs_server, nfs_export, nfs_version,
  retention_days, schedule_expression, enabled,
  active, drain_timeout_seconds,
  created_at, updated_at
) VALUES (
  '${TARGET_ID}',
  'nfs-test-bench',
  'nfs',
  '${NFS_SERVER}',
  '${NFS_EXPORT}',
  '${NFS_VERSION}',
  30,
  '0 2 * * *',
  1,
  false,
  300,
  NOW(),
  NOW()
);

INSERT INTO backup_target_assignments (class_name, target_id, drain_status, created_at, updated_at)
VALUES ('system', '${TARGET_ID}', 'idle', NOW(), NOW());
SQL
"

log "DB rows seeded. Triggering shim reconciler..."
# Force an immediate reconcile (the 5-min tick is too slow for bench
# iteration). Skip the curl call entirely when no token is configured —
# otherwise we'd send a bare `Authorization: Bearer ` header and get a
# silent 401 that the operator would mistake for a working bounce.
if [[ -n "${PLATFORM_API_BENCH_TOKEN:-}" ]]; then
  $SSH "kubectl -n platform exec deploy/platform-api -- curl -s -X POST http://localhost:3000/admin/backup-rclone-shim/reconcile-now -H 'Authorization: Bearer ${PLATFORM_API_BENCH_TOKEN}'" \
    || log "reconcile-now failed; falling back to natural 5-min tick"
else
  log "PLATFORM_API_BENCH_TOKEN not set — skipping reconcile-now (5-min tick will pick up)"
fi

log "waiting for shim DaemonSet to roll with NFS config..."
$SSH "kubectl -n platform rollout status daemonset/backup-rclone-shim --timeout=180s"

# Verify the new config landed.
$SSH "kubectl -n platform get cm backup-rclone-shim-config -o jsonpath='{.data.classes\\.txt}'"
log "system class bound to NFS target $TARGET_ID"
