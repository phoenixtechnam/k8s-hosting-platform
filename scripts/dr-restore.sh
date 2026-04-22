#!/usr/bin/env bash
# Disaster-recovery restore driver.
#
# Expects:
#   - A freshly-bootstrapped k3s cluster (./scripts/bootstrap.sh ran first).
#   - Operator age private key file available locally.
#   - Access to the backup target (S3 credentials OR SSH key).
#
# Does NOT re-run bootstrap. Bootstrap is prerequisite, not scope.
#
# Flow (each step is idempotent — re-running picks up where it failed):
#   1. Prerequisites check   — binaries, cluster reachable, key readable
#   2. Decrypt smoke-test    — pulls the newest encrypted artefact and
#                               verifies it decrypts with the provided key
#                               BEFORE doing anything destructive
#   3. Pull artefacts        — from --from-s3 or --from-ssh
#   4. Restore etcd          — k3s etcd snapshot restore
#   5. Restore Postgres      — pg_restore from the decrypted dump
#   6. Apply cluster-state   — kubectl apply on the decrypted Secret bundle
#   7. Reactivate Longhorn   — wait for BackupTarget to go "Available"
#   8. Restore Longhorn vols — kubectl create BackupTarget restore for each
#   9. Smoke-test            — ./scripts/smoke-test.sh
#
# Usage:
#   dr-restore.sh --from-s3 s3://bucket/prefix --age-key-file ~/op.key [opts]
#   dr-restore.sh --from-ssh user@host:/srv/backups/... --age-key-file ~/op.key --ssh-key ~/.ssh/restore [opts]
#
# Options:
#   --from-s3 <s3-url>           S3 source (bucket + prefix)
#   --from-ssh <user@host:path>  SSH source
#   --age-key-file <path>        Operator age private key (required)
#   --ssh-key <path>             SSH private key for --from-ssh (default ~/.ssh/id_rsa)
#   --work-dir <path>            Scratch dir (default: /var/lib/dr-restore/<timestamp>)
#   --s3-endpoint <url>          Override S3 endpoint (e.g. Hetzner ObjectStorage)
#   --s3-region <name>           S3 region (default: eu-central)
#   --kubeconfig <path>          kubectl config (default: /etc/rancher/k3s/k3s.yaml)
#   --skip-etcd                  Skip the etcd restore step (advanced)
#   --skip-postgres              Skip the Postgres restore step
#   --skip-longhorn              Skip the Longhorn volume restores
#   --dry-run                    Print the plan without making changes
#   --help                       This message

set -uo pipefail

# ─── Defaults & argument parsing ──────────────────────────────────────────────

FROM_S3=""
FROM_SSH=""
AGE_KEY_FILE=""
SSH_KEY="${HOME}/.ssh/id_rsa"
WORK_DIR=""
S3_ENDPOINT=""
S3_REGION="eu-central"
KUBECONFIG_FILE="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
SKIP_ETCD=false
SKIP_POSTGRES=false
SKIP_LONGHORN=false
DRY_RUN=false

log()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
warn() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WARN: $*" >&2; }
die()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] FATAL: $*" >&2; exit 1; }

usage() { sed -n '2,34p' "$0" | sed 's/^# \?//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-s3)         FROM_S3="$2"; shift 2 ;;
    --from-ssh)        FROM_SSH="$2"; shift 2 ;;
    --age-key-file)    AGE_KEY_FILE="$2"; shift 2 ;;
    --ssh-key)         SSH_KEY="$2"; shift 2 ;;
    --work-dir)        WORK_DIR="$2"; shift 2 ;;
    --s3-endpoint)     S3_ENDPOINT="$2"; shift 2 ;;
    --s3-region)       S3_REGION="$2"; shift 2 ;;
    --kubeconfig)      KUBECONFIG_FILE="$2"; shift 2 ;;
    --skip-etcd)       SKIP_ETCD=true; shift ;;
    --skip-postgres)   SKIP_POSTGRES=true; shift ;;
    --skip-longhorn)   SKIP_LONGHORN=true; shift ;;
    --dry-run)         DRY_RUN=true; shift ;;
    --help|-h)         usage ;;
    *)                 die "Unknown arg: $1" ;;
  esac
done

[[ -z "$FROM_S3" && -z "$FROM_SSH" ]] && die "One of --from-s3 or --from-ssh is required."
[[ -n "$FROM_S3" && -n "$FROM_SSH" ]] && die "Pass only one of --from-s3 / --from-ssh."
[[ -z "$AGE_KEY_FILE" ]] && die "--age-key-file is required."
[[ ! -r "$AGE_KEY_FILE" ]] && die "Cannot read age key at $AGE_KEY_FILE."

WORK_DIR="${WORK_DIR:-/var/lib/dr-restore/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"

export KUBECONFIG="$KUBECONFIG_FILE"

# Shorthand: dryable command — when --dry-run, echo instead of run.
run() {
  if $DRY_RUN; then echo "  [dry-run] $*"; else "$@"; fi
}

# ─── Phase 1: Prerequisites check ─────────────────────────────────────────────

phase_prereqs() {
  log "Phase 1/9: Prerequisites check"

  local binaries=(age kubectl tar gzip)
  if [[ -n "$FROM_S3" ]]; then binaries+=(aws); fi
  if [[ -n "$FROM_SSH" ]]; then binaries+=(scp ssh rsync); fi
  if ! $SKIP_POSTGRES; then binaries+=(pg_restore); fi

  local missing=()
  for bin in "${binaries[@]}"; do
    command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
  done
  if (( ${#missing[@]} )); then
    die "Missing required binaries on PATH: ${missing[*]}. Install them and retry."
  fi

  # Sanity: the key file must be a real age identity, not a YAML recipient.
  if ! head -1 "$AGE_KEY_FILE" | grep -qE '^(AGE-SECRET-KEY-1|# created:|-----BEGIN)' ; then
    die "Age key file $AGE_KEY_FILE does not look like an age identity. Expected AGE-SECRET-KEY-1 or age-keygen output."
  fi

  # Cluster must be reachable — the later phases all talk to it.
  if ! kubectl get nodes >/dev/null 2>&1; then
    die "kubectl cannot reach the cluster using KUBECONFIG=$KUBECONFIG_FILE. Run bootstrap.sh first."
  fi

  # The platform namespace should exist already (bootstrap creates it).
  if ! kubectl get namespace platform >/dev/null 2>&1; then
    die "platform namespace missing — bootstrap.sh didn't complete, or you're pointing at the wrong cluster."
  fi

  log "  ✓ binaries present"
  log "  ✓ age key looks valid"
  log "  ✓ cluster reachable ($(kubectl get nodes --no-headers | wc -l) node(s))"
  log "  ✓ platform namespace exists"
}

# ─── Phase 2: Decrypt smoke-test ──────────────────────────────────────────────
# Pull the NEWEST encrypted artefact from the backup target and attempt to
# decrypt it with the supplied key. This catches:
#   - wrong key file (different cluster's operator key)
#   - corrupted / truncated artefacts
#   - backup-target credentials don't work
# BEFORE we do anything destructive. This is the single most important gate
# in the entire script.

phase_smoke_decrypt() {
  log "Phase 2/9: Decrypt smoke-test (non-destructive)"

  local newest_age_path
  if [[ -n "$FROM_S3" ]]; then
    # List secrets/*.tar.age and pick the newest by name (timestamps are in
    # the filename per secrets-backup-cronjob.yaml).
    local s3_prefix="${FROM_S3%/}/secrets/"
    newest_age_path=$(aws_s3_cmd s3 ls "$s3_prefix" \
      | awk '{print $NF}' \
      | grep -E '^secrets-.+\.tar\.age$' \
      | sort | tail -1 || true)
    [[ -z "$newest_age_path" ]] && die "No secrets-*.tar.age artefacts found at ${s3_prefix}. Check --from-s3 URL and credentials."
    log "  Pulling ${s3_prefix}${newest_age_path} for smoke-test..."
    run aws_s3_cmd s3 cp "${s3_prefix}${newest_age_path}" "$WORK_DIR/smoke.tar.age" --quiet
  else
    local ssh_dir="${FROM_SSH%/}/secrets/"
    newest_age_path=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
      "${FROM_SSH%%:*}" "ls -1 ${FROM_SSH#*:}/secrets/secrets-*.tar.age 2>/dev/null | sort | tail -1" || true)
    [[ -z "$newest_age_path" ]] && die "No secrets-*.tar.age artefacts found at ${ssh_dir}."
    log "  Pulling ${newest_age_path} for smoke-test..."
    run scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
      "${FROM_SSH%%:*}:${newest_age_path}" "$WORK_DIR/smoke.tar.age"
  fi

  if ! $DRY_RUN; then
    if ! age -d -i "$AGE_KEY_FILE" "$WORK_DIR/smoke.tar.age" > "$WORK_DIR/smoke.tar" 2>"$WORK_DIR/smoke.err"; then
      die "Decrypt smoke-test FAILED. See $WORK_DIR/smoke.err. WRONG KEY or corrupted artefact — ABORT."
    fi
    # Also validate tar integrity — age decrypts random bytes too, which
    # would pass the decrypt step but fail on tar.
    if ! tar tzf "$WORK_DIR/smoke.tar" >/dev/null 2>&1 && ! tar tf "$WORK_DIR/smoke.tar" >/dev/null 2>&1; then
      die "Decrypt succeeded but tar listing failed — artefact likely corrupted."
    fi
    log "  ✓ decrypt + tar integrity OK"
  else
    log "  (dry-run) skipped actual decrypt"
  fi
}

# ─── Phase 3: Pull all artefacts ──────────────────────────────────────────────

phase_pull() {
  log "Phase 3/9: Pulling all backup artefacts to $WORK_DIR"
  mkdir -p "$WORK_DIR/raw"

  if [[ -n "$FROM_S3" ]]; then
    # Pull the entire prefix — small compared to tenant PVC sizes and
    # keeps the restore self-contained. Exclude Longhorn volume data
    # (that stays in S3, Longhorn pulls it directly).
    log "  aws s3 sync ${FROM_S3%/}/ $WORK_DIR/raw/ (excluding longhorn-backups)..."
    run aws_s3_cmd s3 sync "${FROM_S3%/}/" "$WORK_DIR/raw/" \
      --exclude 'longhorn-backups/*' \
      --exclude 'backupstore/*' \
      --quiet
  else
    log "  rsync from ${FROM_SSH%/}/ to $WORK_DIR/raw/..."
    run rsync -az -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
      --exclude='longhorn-backups/' \
      --exclude='backupstore/' \
      "${FROM_SSH%/}/" "$WORK_DIR/raw/"
  fi

  if ! $DRY_RUN; then
    log "  ✓ pulled $(find "$WORK_DIR/raw" -type f 2>/dev/null | wc -l) files"
  fi
}

# ─── Phase 4: Restore etcd ────────────────────────────────────────────────────

phase_etcd_restore() {
  if $SKIP_ETCD; then log "Phase 4/9: SKIPPED (--skip-etcd)"; return 0; fi
  log "Phase 4/9: Restore etcd snapshot"

  # Find the newest etcd snapshot uploaded by etcd-snapshot-cronjob.
  local snap
  snap=$(find "$WORK_DIR/raw/etcd" -name '*.db' -o -name '*.tar.gz' 2>/dev/null | sort | tail -1 || true)
  if [[ -z "$snap" ]]; then
    warn "No etcd snapshot found under $WORK_DIR/raw/etcd. Skipping etcd restore."
    return 0
  fi

  log "  Snapshot: $snap"
  warn "  About to RESTORE etcd — this stops k3s and wipes the current cluster state."
  warn "  You have 10 seconds to abort with Ctrl-C."
  if ! $DRY_RUN; then sleep 10; fi

  # k3s --cluster-reset restores from a local file; ensure the snapshot is
  # in the expected location.
  local k3s_snap_dir="/var/lib/rancher/k3s/server/db/snapshots"
  run mkdir -p "$k3s_snap_dir"
  run cp "$snap" "$k3s_snap_dir/$(basename "$snap")"

  run systemctl stop k3s
  run k3s server --cluster-reset --cluster-reset-restore-path="$k3s_snap_dir/$(basename "$snap")"
  run systemctl start k3s

  # Wait for kube-apiserver to come back.
  log "  Waiting for cluster to come back..."
  for i in $(seq 1 60); do
    if kubectl get nodes >/dev/null 2>&1; then
      log "  ✓ cluster reachable after etcd restore (${i}s)"
      return 0
    fi
    sleep 2
  done
  die "Cluster didn't recover within 120s after etcd restore."
}

# ─── Phase 5: Restore Postgres ────────────────────────────────────────────────

phase_postgres_restore() {
  if $SKIP_POSTGRES; then log "Phase 5/9: SKIPPED (--skip-postgres)"; return 0; fi
  log "Phase 5/9: Restore Postgres dump"

  local dump
  dump=$(find "$WORK_DIR/raw/postgres" -name '*.dump' -o -name '*.sql.gz' 2>/dev/null | sort | tail -1 || true)
  if [[ -z "$dump" ]]; then
    warn "No Postgres dump found under $WORK_DIR/raw/postgres. Skipping."
    return 0
  fi
  log "  Dump: $dump"

  # Copy the dump into the platform-postgres-0 pod and run pg_restore there.
  # The pod already has pg_restore + the DB is running by the time we hit
  # this phase (etcd restore brought it back via StatefulSet replay).
  run kubectl -n platform cp "$dump" platform-postgres-0:/tmp/restore.dump
  run kubectl -n platform exec platform-postgres-0 -- \
    bash -c 'pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges \
             -d "$POSTGRES_DB" -U "$POSTGRES_USER" /tmp/restore.dump'
  log "  ✓ Postgres restore complete"
}

# ─── Phase 6: Apply secrets from age-decrypted bundle ─────────────────────────

phase_secrets_apply() {
  log "Phase 6/9: Decrypt + apply secrets bundle"

  local newest
  newest=$(find "$WORK_DIR/raw/secrets" -name 'secrets-*.tar.age' 2>/dev/null | sort | tail -1 || true)
  if [[ -z "$newest" ]]; then
    warn "No secrets-*.tar.age found. Skipping."
    return 0
  fi
  log "  Decrypting $newest ..."
  run age -d -i "$AGE_KEY_FILE" "$newest" > "$WORK_DIR/secrets.tar"
  run mkdir -p "$WORK_DIR/secrets"
  run tar xf "$WORK_DIR/secrets.tar" -C "$WORK_DIR/secrets"

  # Each Secret YAML in the bundle is `kubectl get secret -o yaml` output.
  # Re-apply preserving the original namespace.
  local count=0
  while IFS= read -r f; do
    run kubectl apply -f "$f"
    count=$((count+1))
  done < <(find "$WORK_DIR/secrets" -name '*.yaml' -type f 2>/dev/null)
  log "  ✓ applied $count secrets"
}

# ─── Phase 7: Longhorn BackupTarget reactivate ────────────────────────────────

phase_longhorn_reactivate() {
  if $SKIP_LONGHORN; then log "Phase 7/9: SKIPPED (--skip-longhorn)"; return 0; fi
  log "Phase 7/9: Reactivate Longhorn BackupTarget"

  # The platform-api pod will re-reconcile BackupTarget/default when it
  # starts up and reads the `active` row. Wait until the CR reports
  # Available=true (Longhorn's own check that the URL + creds work).
  log "  Waiting up to 2m for BackupTarget/default to reach Available=true..."
  for i in $(seq 1 60); do
    local avail
    avail=$(kubectl get backuptarget default -n longhorn-system \
      -o jsonpath='{.status.available}' 2>/dev/null || echo "")
    if [[ "$avail" == "true" ]]; then
      log "  ✓ BackupTarget Available (after ${i}s)"
      return 0
    fi
    sleep 2
  done
  warn "BackupTarget did not go Available within 2m. Longhorn volume restore (next phase) will likely fail."
  warn "Investigate: kubectl describe backuptarget default -n longhorn-system"
}

# ─── Phase 8: Restore Longhorn volumes ────────────────────────────────────────

phase_longhorn_volumes() {
  if $SKIP_LONGHORN; then log "Phase 8/9: SKIPPED (--skip-longhorn)"; return 0; fi
  log "Phase 8/9: Restore Longhorn volumes"

  # List available backups (Longhorn's BackupVolume CRs). Each represents
  # a PVC that has backups in the current BackupTarget.
  mapfile -t volumes < <(kubectl get backupvolume -n longhorn-system \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)

  if (( ${#volumes[@]} == 0 )); then
    warn "No BackupVolume CRs visible — Longhorn hasn't yet enumerated the bucket."
    warn "Try: kubectl -n longhorn-system annotate backuptarget/default reconcile=$(date +%s) --overwrite"
    return 0
  fi

  log "  Found ${#volumes[@]} backup volumes; restoring newest backup of each:"
  for vol in "${volumes[@]}"; do
    # Newest backup per volume = highest createdAt.
    local bkp
    bkp=$(kubectl get backup -n longhorn-system -l "longhornvolume=${vol}" \
      -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}{"\t"}{.metadata.name}{"\n"}{end}' \
      | sort | tail -1 | awk '{print $2}' || true)
    if [[ -z "$bkp" ]]; then
      warn "    $vol: no backup CR materialised yet, skip."
      continue
    fi
    log "    $vol → restore from $bkp"
    # Trigger Longhorn restore by creating a fresh Volume CR with
    # fromBackup set. The existing PVC binding is a separate step
    # (operators typically use the Longhorn UI for the final binding,
    # or kubectl apply the PV/PVC YAMLs in $WORK_DIR/raw/cluster-state/).
    run kubectl apply -f - <<VOLCR
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: ${vol}-restored
  namespace: longhorn-system
spec:
  fromBackup: "bs://${vol}?backup=${bkp}"
  size: "$(kubectl get backupvolume "$vol" -n longhorn-system -o jsonpath='{.status.size}' 2>/dev/null || echo 10Gi)"
  numberOfReplicas: 3
VOLCR
  done
  log "  Issued restore requests for ${#volumes[@]} volumes — Longhorn async job list:"
  run kubectl -n longhorn-system get volumes -l 'longhornvolume' -o name | head -20 || true
}

# ─── Phase 9: Smoke test ──────────────────────────────────────────────────────

phase_smoke() {
  log "Phase 9/9: Smoke test"
  if [[ -x ./scripts/smoke-test.sh ]]; then
    run ./scripts/smoke-test.sh
  else
    warn "./scripts/smoke-test.sh not present — skipping programmatic check. Verify manually."
  fi
}

# ─── S3 helpers ───────────────────────────────────────────────────────────────

aws_s3_cmd() {
  # Thin wrapper so we can inject --endpoint-url for non-AWS providers
  # like Hetzner Object Storage without plumbing it through every call.
  local args=()
  if [[ -n "$S3_ENDPOINT" ]]; then
    args+=(--endpoint-url "$S3_ENDPOINT")
  fi
  args+=(--region "$S3_REGION")
  aws "${args[@]}" "$@"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

log "════════════════════════════════════════════════════════════════"
log "  DR RESTORE — work dir: $WORK_DIR"
log "  source: ${FROM_S3:-$FROM_SSH}"
log "  dry-run: $DRY_RUN"
log "════════════════════════════════════════════════════════════════"

phase_prereqs
phase_smoke_decrypt
phase_pull
phase_etcd_restore
phase_postgres_restore
phase_secrets_apply
phase_longhorn_reactivate
phase_longhorn_volumes
phase_smoke

log "════════════════════════════════════════════════════════════════"
log "  DR RESTORE COMPLETE"
log "  Work dir (decrypted artefacts): $WORK_DIR"
log "  Review: kubectl get pods -A, kubectl get pvc -A"
log "  Shred work dir when done: rm -rf $WORK_DIR"
log "════════════════════════════════════════════════════════════════"
