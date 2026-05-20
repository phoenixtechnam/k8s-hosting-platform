#!/usr/bin/env bash
# restore-mail-from-shim.sh — R-X11 restore tooling for MAIL.stalwart-rocksdb.
#
# Runs `restic restore` from the shim's `s3://mail/mail-snapshots/` (R-X16:
# bucket into the live Stalwart RocksDB PVC.
#
# DESTRUCTIVE: the restore overwrites the running mail server's
# /var/lib/stalwart/data. The script:
#   1. Scales Stalwart Deployment to 0 (no writes during restore)
#   2. Spawns a temp restic Pod that mounts the same PVC
#   3. `restic restore` from the shim bucket
#   4. Scales Stalwart back up
#
# Pre-flight:
#   * MAIL shim class bound (3-class)
#   * backup-rclone-shim-creds Secret present in `mail` namespace
#     (R-X8 reconciler materialises it; if missing, run the R-X8
#     reconciler manually or check platform-api logs)
#   * mail-restic Secret (stalwart-snapshot-restic-repo) present
#   * Stalwart Deployment exists
#
# Usage:
#   ./scripts/restore-mail-from-shim.sh --latest
#   ./scripts/restore-mail-from-shim.sh --snapshot <restic-id>
#   ./scripts/restore-mail-from-shim.sh --list
#   ./scripts/restore-mail-from-shim.sh --dry-run --latest

set -euo pipefail

MODE=""
SNAP_ID=""
DRY_RUN=0
KUBECTL=${KUBECTL:-kubectl}
MAIL_NS=${MAIL_NS:-mail}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)        MODE="latest"; shift ;;
    --list)          MODE="list"; shift ;;
    --snapshot)      MODE="snapshot"; SNAP_ID="${2:?--snapshot requires a restic snapshot id}"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$MODE" ]] && { echo "ERROR: --latest, --list, or --snapshot <id> required" >&2; exit 1; }

log() { printf '\033[34m[restore-mail]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[restore-mail FAIL]\033[0m %s\n' "$1" >&2; exit 1; }

# ── Pre-flight ───────────────────────────────────────────────────────
if ! $KUBECTL -n "$MAIL_NS" get secret stalwart-snapshot-restic-repo >/dev/null 2>&1; then
  fail "stalwart-snapshot-restic-repo Secret missing in $MAIL_NS. Bind MAIL shim class (PUT /api/v1/admin/backup-rclone-shim/assignments/mail) and wait for the mail-restic reconciler tick."
fi

# Resolve restic env from the live Secret (the reconciler keeps it in sync).
RESTIC_PASSWORD=$($KUBECTL -n "$MAIL_NS" get secret stalwart-snapshot-restic-repo -o jsonpath='{.data.RESTIC_PASSWORD}' | base64 -d)
RESTIC_REPOSITORY=$($KUBECTL -n "$MAIL_NS" get secret stalwart-snapshot-restic-repo -o jsonpath='{.data.RESTIC_REPOSITORY}' | base64 -d)
AWS_ACCESS_KEY_ID=$($KUBECTL -n "$MAIL_NS" get secret stalwart-snapshot-restic-repo -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)
AWS_SECRET_ACCESS_KEY=$($KUBECTL -n "$MAIL_NS" get secret stalwart-snapshot-restic-repo -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' | base64 -d)

if [[ -z "$RESTIC_REPOSITORY" ]]; then
  fail "RESTIC_REPOSITORY is empty in the Secret. MAIL class is not bound to a shim target."
fi

if [[ ! "$RESTIC_REPOSITORY" =~ backup-rclone-shim ]]; then
  log "WARNING: RESTIC_REPOSITORY does not point at the shim — this script is for shim-mode restores."
  log "         Repository: $RESTIC_REPOSITORY"
  log "         For legacy direct-S3 restores, use the existing mail-restic flow."
  fail "Refusing to proceed."
fi

# ── List ─────────────────────────────────────────────────────────────
if [[ "$MODE" == "list" ]]; then
  log "Listing restic snapshots in $RESTIC_REPOSITORY"
  $KUBECTL -n "$MAIL_NS" run restore-mail-list-$(date +%s) \
    --rm -i --restart=Never --image=restic/restic:0.18 \
    --env="RESTIC_REPOSITORY=$RESTIC_REPOSITORY" \
    --env="RESTIC_PASSWORD=$RESTIC_PASSWORD" \
    --env="AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID" \
    --env="AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY" \
    --command -- restic snapshots
  exit 0
fi

# ── Resolve snapshot id ─────────────────────────────────────────────
if [[ "$MODE" == "latest" ]]; then
  SNAP_ID="latest"
  log "Using --latest (restic resolves to the newest snapshot)"
fi

# ── Confirmation ─────────────────────────────────────────────────────
log ""
log "About to RESTORE Stalwart RocksDB from snapshot: $SNAP_ID"
log "  This is DESTRUCTIVE — the running mail server's data WILL be overwritten."
log "  Stalwart will be scaled to 0 for the duration of the restore."
log ""
if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN — exiting before any cluster mutation"
  exit 0
fi
log "Type 'restore-mail' to confirm:"
read -r CONFIRM
if [[ "$CONFIRM" != "restore-mail" ]]; then
  fail "Aborted by operator."
fi

# ── Scale Stalwart to 0 ──────────────────────────────────────────────
log "Scaling stalwart-mail StatefulSet to 0..."
ORIGINAL_REPLICAS=$($KUBECTL -n "$MAIL_NS" get statefulset stalwart-mail -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
$KUBECTL -n "$MAIL_NS" scale statefulset stalwart-mail --replicas=0
$KUBECTL -n "$MAIL_NS" wait --for=delete pod -l app=stalwart-mail --timeout=120s || true

# ── Spawn restic restore Pod ────────────────────────────────────────
RESTORE_POD_NAME=mail-restore-$(date +%s)
log "Spawning restore Pod: $RESTORE_POD_NAME"
$KUBECTL -n "$MAIL_NS" run "$RESTORE_POD_NAME" \
  --restart=Never --image=restic/restic:0.18 \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "restic",
        "image": "restic/restic:0.18",
        "command": ["sh", "-c", "restic restore '"$SNAP_ID"' --target / && echo RESTIC_RESTORE_OK"],
        "env": [
          {"name":"RESTIC_REPOSITORY","value":"'"$RESTIC_REPOSITORY"'"},
          {"name":"RESTIC_PASSWORD","value":"'"$RESTIC_PASSWORD"'"},
          {"name":"AWS_ACCESS_KEY_ID","value":"'"$AWS_ACCESS_KEY_ID"'"},
          {"name":"AWS_SECRET_ACCESS_KEY","value":"'"$AWS_SECRET_ACCESS_KEY"'"}
        ],
        "volumeMounts": [{"name":"data","mountPath":"/var/lib/stalwart/data"}]
      }],
      "volumes": [{
        "name": "data",
        "persistentVolumeClaim": {"claimName": "stalwart-rocksdb-data-stalwart-mail-0"}
      }]
    }
  }'

$KUBECTL -n "$MAIL_NS" wait --for=condition=Ready pod/"$RESTORE_POD_NAME" --timeout=60s || true
$KUBECTL -n "$MAIL_NS" logs -f "$RESTORE_POD_NAME"
RC=$($KUBECTL -n "$MAIL_NS" get pod "$RESTORE_POD_NAME" -o jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}')
$KUBECTL -n "$MAIL_NS" delete pod "$RESTORE_POD_NAME" --grace-period=0 --force >/dev/null 2>&1 || true

if [[ "$RC" != "0" ]]; then
  fail "restic restore exited with code $RC. Stalwart remains scaled to 0 — investigate before restarting."
fi

# ── Scale Stalwart back up ───────────────────────────────────────────
log "Scaling stalwart-mail back to $ORIGINAL_REPLICAS replica(s)..."
$KUBECTL -n "$MAIL_NS" scale statefulset stalwart-mail --replicas="$ORIGINAL_REPLICAS"
$KUBECTL -n "$MAIL_NS" wait --for=condition=Ready pod -l app=stalwart-mail --timeout=180s || true

log "Mail restore COMPLETE. Verify with:"
log "  kubectl -n $MAIL_NS get pods -l app=stalwart-mail"
log "  kubectl -n $MAIL_NS exec stalwart-mail-0 -- ls /var/lib/stalwart/data"
