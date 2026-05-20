#!/usr/bin/env bash
# restore-etcd-from-shim.sh — R-X11 restore tooling for SYSTEM.etcd.
#
# Pulls the newest (or operator-named) etcd snapshot from the
# shim's `s3://system/etcd/` bucket and runs `k3s etcd-snapshot
# restore` on the control-plane node.
#
# RUN THIS ON A CONTROL-PLANE NODE — k3s etcd snapshot restore
# is local: it stops the local k3s, replaces the local etcd
# database, then restarts. For a multi-node cluster this is the
# canonical "rebuild from disaster" flow per k3s docs.
#
# Pre-flight:
#   * MUST run as root on the target control-plane node
#   * backup-rclone-shim DaemonSet pod must be Ready on this node
#     (internalTrafficPolicy=Local; the local shim is what we read)
#   * `rclone` CLI must be installed on the node (we use it via the
#     shim's S3 endpoint with HKDF-derived creds read from the
#     backup-rclone-shim-creds Secret)
#
# Usage:
#   sudo ./scripts/restore-etcd-from-shim.sh --latest
#   sudo ./scripts/restore-etcd-from-shim.sh --name <host>-<ts>.db
#   sudo ./scripts/restore-etcd-from-shim.sh --list
#   sudo ./scripts/restore-etcd-from-shim.sh --dry-run --latest
#
# Exit codes:
#   0   success
#   1   pre-flight failed
#   2   rclone copy failed
#   3   k3s etcd-snapshot restore failed

set -euo pipefail

MODE=""
SNAP_NAME=""
DRY_RUN=0
KUBECTL=${KUBECTL:-kubectl}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)   MODE="latest"; shift ;;
    --list)     MODE="list"; shift ;;
    --name)     MODE="name"; SNAP_NAME="${2:?--name requires a snapshot filename}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "ERROR: --latest, --list, or --name <snap> required" >&2
  exit 1
fi

log() { printf '\033[34m[restore-etcd]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[restore-etcd FAIL]\033[0m %s\n' "$1" >&2; exit 1; }

# ── Pre-flight ───────────────────────────────────────────────────────
if [[ "$MODE" == "name" || "$MODE" == "latest" ]] && [[ "$DRY_RUN" -eq 0 && "$(id -u)" -ne 0 ]]; then
  fail "Must run as root for k3s etcd-snapshot restore. Re-run with sudo."
fi
if ! command -v rclone >/dev/null 2>&1; then
  fail "rclone CLI not installed. apt install rclone (or download from rclone.org)"
fi

# Resolve shim creds from the cluster Secret. We use kubectl to
# pull them — the script runs on a control-plane node so kubectl
# reaches the local apiserver.
log "Reading backup-rclone-shim-creds Secret for shim S3 creds"
ACCESS_KEY=$($KUBECTL -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.access_key}' 2>/dev/null | base64 -d || true)
SECRET_KEY=$($KUBECTL -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.secret_key}' 2>/dev/null | base64 -d || true)
if [[ -z "$ACCESS_KEY" || -z "$SECRET_KEY" ]]; then
  fail "backup-rclone-shim-creds Secret missing or empty. Bind SYSTEM shim class first (PUT /api/v1/admin/backup-rclone-shim/assignments/system)."
fi

RCLONE_FLAGS=(
  --s3-provider=Other
  --s3-endpoint=http://backup-rclone-shim.platform.svc.cluster.local:9000
  --s3-access-key-id="$ACCESS_KEY"
  --s3-secret-access-key="$SECRET_KEY"
  --s3-force-path-style
  --s3-region=auto
  --s3-no-check-bucket
)

# ── List ─────────────────────────────────────────────────────────────
if [[ "$MODE" == "list" ]]; then
  log "Available etcd snapshots in the shim bucket:"
  rclone "${RCLONE_FLAGS[@]}" lsf ':s3:system/etcd/' \
    | grep '\.db$' \
    | sort
  exit 0
fi

# ── Resolve target snapshot ──────────────────────────────────────────
if [[ "$MODE" == "latest" ]]; then
  SNAP_NAME=$(rclone "${RCLONE_FLAGS[@]}" lsf ':s3:system/etcd/' \
    | grep '\.db$' \
    | sort -r | head -1)
  if [[ -z "$SNAP_NAME" ]]; then
    fail "No etcd snapshots found in :s3:system/etcd/. Has the etcd-snap-via-shim CronJob run yet? Check kubectl -n platform get cronjob etcd-snap-via-shim"
  fi
  log "Resolved --latest → $SNAP_NAME"
fi

DEST=/var/lib/rancher/k3s/server/db/snapshots/restore-from-shim-$(date -u +%Y%m%d-%H%M%S).db
log "Will download :s3:system/etcd/$SNAP_NAME → $DEST"

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN — skipping download + restore"
  exit 0
fi

# ── Download ────────────────────────────────────────────────────────
log "Downloading snapshot..."
if ! rclone "${RCLONE_FLAGS[@]}" copyto ":s3:system/etcd/$SNAP_NAME" "$DEST"; then
  fail "rclone download failed"
fi
log "Downloaded $(du -h "$DEST" | cut -f1) to $DEST"

# Optional: download + verify .meta sidecar
META_DEST="$DEST.meta"
if rclone "${RCLONE_FLAGS[@]}" copyto ":s3:system/etcd/$SNAP_NAME.meta" "$META_DEST" 2>/dev/null; then
  log "Snapshot metadata: $(cat "$META_DEST")"
  EXPECTED_SHA=$(grep -oE '"sha256":"[a-f0-9]+"' "$META_DEST" | cut -d '"' -f 4 || true)
  if [[ -n "$EXPECTED_SHA" ]]; then
    ACTUAL_SHA=$(sha256sum "$DEST" | cut -d ' ' -f 1)
    if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
      fail "sha256 mismatch: expected $EXPECTED_SHA, got $ACTUAL_SHA. Aborting restore."
    fi
    log "sha256 verified: $ACTUAL_SHA"
  fi
fi

# ── Restore ──────────────────────────────────────────────────────────
log "Stopping k3s..."
systemctl stop k3s

log "Restoring etcd snapshot via k3s..."
if ! k3s etcd-snapshot restore --name "$(basename "$DEST")"; then
  fail "k3s etcd-snapshot restore failed. The on-disk snapshot is at $DEST — operator can retry manually."
fi

log "Starting k3s..."
systemctl start k3s

log "etcd restore COMPLETE. The cluster is now in the post-restore state."
log "Verify with: kubectl get nodes; kubectl -n platform get pods"
log ""
log "If the restored cluster is missing recent changes (last few hours),"
log "verify the snapshot timestamp matches your RPO target. List with:"
log "  ./scripts/restore-etcd-from-shim.sh --list"
