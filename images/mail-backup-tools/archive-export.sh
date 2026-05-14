#!/bin/sh
# archive-export.sh — operator-triggered Stalwart-native archive
#                     uploader/downloader.
#
# Runs in the second container of the stalwart-archive-* Job, AFTER
# the initContainer has either:
#   ARCHIVE_MODE=export  — written /export/export.lz4 via `stalwart -e`
#   ARCHIVE_MODE=restore — done nothing (the orchestrator's Job spec for
#                          restore uses TWO initContainers: this script
#                          in restore mode first, then `stalwart -i`).
#
# Stalwart 0.16's `-e <path>` writes a DIRECTORY at <path> with one
# file per subspace (subspace_a, subspace_b, ..., subspace_x). The
# script handles this by always backing up + restoring the directory
# tree rooted at /export/export.lz4, never a single file.
#
# Env (from secret stalwart-snapshot-restic-repo via envFrom):
#   RESTIC_REPOSITORY     e.g. s3:https://s3.example.com/bucket/path
#   RESTIC_PASSWORD       repo encryption password
#   AWS_ACCESS_KEY_ID     S3 creds
#   AWS_SECRET_ACCESS_KEY
#
# Env (from pod spec):
#   ARCHIVE_MODE          export | restore
#   ARCHIVE_RUN_ID        UUID for telemetry
#   RESTIC_SNAPSHOT_ID    (restore only) which past snapshot to extract
#
# Stdout contract:
#   archive-export prints a final JSON line for the orchestrator to
#   parse:
#     archive-result: {"resticSnapshotId":"<id>","exportSizeBytes":<n>,"resticAddedBytes":<n>}
set -eu

MODE="${ARCHIVE_MODE:-export}"
RUN_ID="${ARCHIVE_RUN_ID:-unknown}"
EXPORT_DIR=/export
EXPORT_PATH="${EXPORT_DIR}/export.lz4"  # Stalwart writes this as a DIR.

log() { printf '=== archive-%s [%s] %s ===\n' "$MODE" "$RUN_ID" "$1"; }
die() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  die "RESTIC_REPOSITORY not set — operator must select a backup target before triggering an archive"
fi
if [ -z "${RESTIC_PASSWORD:-}" ]; then
  die "RESTIC_PASSWORD not set"
fi

# Total bytes under a path. Uses GNU du --bytes; falls back to
# awk-summed `find -printf` if --bytes isn't available.
dir_size_bytes() {
  d="$1"
  if du --bytes -s "$d" >/dev/null 2>&1; then
    du --bytes -s "$d" | awk '{print $1}'
  else
    find "$d" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}'
  fi
}

# ── EXPORT path ───────────────────────────────────────────────────────────────
# Initialise repo if absent, snapshot the export tree, prune by
# retention, emit the parse marker.
if [ "$MODE" = "export" ]; then
  if [ ! -d "$EXPORT_PATH" ]; then
    die "expected $EXPORT_PATH (directory) from stalwart-export initContainer; not found"
  fi
  export_size=$(dir_size_bytes "$EXPORT_PATH")
  subspace_count=$(find "$EXPORT_PATH" -maxdepth 1 -type f | wc -l | tr -d ' ')
  log "export tree: ${subspace_count} subspace file(s), ${export_size} bytes total"

  log "initialising or checking restic repo"
  # `restic cat config` is a SINGLE small GET (the repo's config blob).
  # The previous `restic snapshots --quiet` reads + decodes EVERY
  # snapshot in the repo to render the table; on a busy repo with
  # many archives this single liveness probe took >5 minutes against
  # the Hetzner S3 backend and starved the orchestrator's 15-min cap.
  if ! restic cat config >/dev/null 2>&1; then
    log "restic init"
    restic init || die "restic init failed"
  fi

  log "restic backup with --tag mail-archive"
  # `--host stalwart-archive` keeps archive snapshots separate from the
  # continuous-backup ones (which run with `--host` = pod hostname).
  # Operators can list/forget only one tier without touching the other.
  backup_out=$(restic backup "$EXPORT_PATH" \
    --tag mail-archive \
    --tag "run=${RUN_ID}" \
    --host stalwart-archive 2>&1) || die "restic backup failed: ${backup_out}"
  printf '%s\n' "$backup_out"

  # Extract the new snapshot ID from the backup output. Restic prints
  # "snapshot <8hex> saved" on success.
  snap_id=$(printf '%s\n' "$backup_out" | sed -n 's/^snapshot \([0-9a-f]\{8\}\) saved$/\1/p' | tail -1)
  if [ -z "$snap_id" ]; then
    # Fall back to listing the latest archive-tagged snapshot.
    snap_id=$(restic snapshots --tag mail-archive --json 2>/dev/null \
      | python3 -c 'import sys,json; r=json.load(sys.stdin); print(r[-1]["short_id"] if r else "")')
  fi
  log "restic snapshot id: ${snap_id:-<unknown>}"

  # Parse "Added to the repository: ... (N B stored)" → bytes.
  added_bytes=$(printf '%s\n' "$backup_out" \
    | sed -n 's/.*Added to the repository:.*(\([0-9]*\) B stored.*/\1/p' \
    | tail -1)

  log "applying retention (default: --keep-last 12 --keep-monthly 12)"
  restic forget \
    --tag mail-archive \
    --keep-last 12 \
    --keep-monthly 12 \
    --prune 2>&1 || log "restic forget failed (non-fatal)"

  printf 'archive-result: {"resticSnapshotId":"%s","exportSizeBytes":%s,"resticAddedBytes":%s}\n' \
    "${snap_id:-}" \
    "${export_size:-0}" \
    "${added_bytes:-0}"
  exit 0
fi

# ── RESTORE path ──────────────────────────────────────────────────────────────
# Pull the named snapshot from restic into /export, then exit so the
# next initContainer can run `stalwart -i` against /export/export.lz4.
if [ "$MODE" = "restore" ]; then
  if [ -z "${RESTIC_SNAPSHOT_ID:-}" ]; then
    die "RESTIC_SNAPSHOT_ID required for restore mode"
  fi
  log "restic restore ${RESTIC_SNAPSHOT_ID} → ${EXPORT_DIR}"
  # restic restore preserves the source absolute path. The original
  # backup was the directory /export/export.lz4, so restic writes
  # /restic-stage/export/export.lz4/{subspace_a,…}. We want the same
  # tree at /export/export.lz4 for the downstream `stalwart -i` step.
  mkdir -p /restic-stage
  restic restore "${RESTIC_SNAPSHOT_ID}" --target /restic-stage 2>&1 \
    || die "restic restore failed"
  if [ ! -d /restic-stage/export/export.lz4 ]; then
    ls -la /restic-stage /restic-stage/export 2>&1 || true
    die "expected /restic-stage/export/export.lz4 (directory) after restic restore"
  fi
  # Move the restored tree into place. Use rsync semantics via cp -a
  # so symlinks/timestamps survive — though Stalwart's export tree is
  # flat files only.
  rm -rf "$EXPORT_PATH"
  cp -a /restic-stage/export/export.lz4 "$EXPORT_PATH"
  size=$(dir_size_bytes "$EXPORT_PATH")
  count=$(find "$EXPORT_PATH" -maxdepth 1 -type f | wc -l | tr -d ' ')
  log "extracted ${count} subspace file(s), ${size} bytes — handing off to stalwart-import"
  printf 'archive-result: {"resticSnapshotId":"%s","exportSizeBytes":%s,"resticAddedBytes":0}\n' \
    "${RESTIC_SNAPSHOT_ID}" "${size:-0}"
  exit 0
fi

die "unknown ARCHIVE_MODE: ${MODE} (expected export or restore)"
