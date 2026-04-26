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
#   --secret-replace-mode <mode> force (default) | apply. Controls Phase 6
#                                behaviour: force deletes existing Secrets
#                                before applying the restored bundle, so
#                                a fresh-bootstrap cluster's random values
#                                don't conflict with the restored ones.
#   --restore-db-credentials     Also restore platform-db-credentials
#                                (default: SKIP — postgres init password
#                                won't match, breaking DB auth).
#   --smoke-host <hostname>      Target for Phase 9 smoke-test. Default:
#                                auto-derive from platform-config
#                                ConfigMap's ingress-base-domain.
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
# Phase 6 behaviour controls:
#   SECRET_REPLACE_MODE=force  — delete pre-existing Secrets before apply
#                                 (default: resolves kubectl apply conflicts
#                                  against fresh-bootstrap Secrets)
#                       apply  — `kubectl apply` only; fails on conflict
SECRET_REPLACE_MODE=force
# Restore platform-db-credentials from the backup bundle? Default NO
# because postgres was initialised by bootstrap with a fresh random
# password; the old password from the bundle won't match. Opt in only
# if you're also going to ALTER USER.
RESTORE_DB_CREDS=false
# Phase 9 smoke-test target — plumbed into scripts/smoke-test.sh via
# env vars (API_URL, ADMIN_EMAIL). Default: discover from cluster's
# platform-config ConfigMap. Override with --smoke-host.
SMOKE_HOST=""

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
    --secret-replace-mode) SECRET_REPLACE_MODE="$2"; shift 2 ;;
    --restore-db-credentials) RESTORE_DB_CREDS=true; shift ;;
    --smoke-host)      SMOKE_HOST="$2"; shift 2 ;;
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

  # Match both the secrets-backup CronJob's output (pg-<ts>.dump) and
  # legacy/manual dump names. Sorted lexicographically — the timestamp
  # format is ISO-8601 so lexicographic order == chronological.
  local dump
  # Two candidate paths: db/platform/ (new layout, matches pg-backup
  # CronJob's S3 key) and postgres/ (legacy). Silence find's own stderr
  # on missing dirs; rely on the sort+tail to pick the newest.
  dump=$({ find "$WORK_DIR/raw/db/platform" -type f \( -name 'pg-*.dump' -o -name '*.dump' \) 2>/dev/null; \
           find "$WORK_DIR/raw/postgres" -type f \( -name '*.dump' -o -name '*.sql.gz' \) 2>/dev/null; } \
         | sort | tail -1 || true)
  if [[ -z "$dump" ]]; then
    warn "No Postgres dump found. Looked under $WORK_DIR/raw/db/platform/ and .../postgres/. Skipping."
    return 0
  fi
  log "  Dump: $dump"

  # Resolve the current Postgres primary. CNPG cluster pods carry
  # `cnpg.io/cluster=postgres,role=primary`. Pre-CNPG StatefulSet
  # pods carry `app=postgres` (single instance, postgres-0). Try
  # CNPG first; fall back to the legacy label.
  local POD
  POD=$(kubectl -n platform get pods \
    -l cnpg.io/cluster=postgres,role=primary \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -z "$POD" ]]; then
    POD=$(kubectl -n platform get pods -l app=postgres \
      --field-selector=status.phase=Running \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  fi
  if [[ -z "$POD" ]]; then
    error "No Running postgres pod found in platform namespace."
  fi
  log "  Restoring into pod: $POD"
  run kubectl -n platform cp "$dump" "${POD}:/tmp/restore.dump"
  run kubectl -n platform exec "$POD" -- \
    bash -c 'pg_restore --clean --if-exists --no-owner --no-privileges \
             -U platform -d hosting_platform /tmp/restore.dump' || {
    warn "pg_restore exited non-zero. Most 'already exists' / 'does not exist' noise on --clean --if-exists is harmless; check logs."
  }
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

  # Create tenant namespaces FIRST — the bundle has tenants/<ns>/*.yaml
  # layout, but the target cluster may not yet have those namespaces (on
  # a fresh cold-restore they've all been wiped). Without this, the
  # kubectl apply below fails with "namespaces ... not found" on every
  # tenant Secret. Caught during the 2026-04-23 staging rebootstrap.
  if [[ -d "$WORK_DIR/secrets/tenants" ]]; then
    local tenants_count=0
    for ns_dir in "$WORK_DIR/secrets/tenants"/*/; do
      [[ -d "$ns_dir" ]] || continue
      local NS
      NS="$(basename "$ns_dir")"
      # Idempotent create — already-exists is a non-error.
      run kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
      tenants_count=$((tenants_count+1))
    done
    log "  ✓ ensured $tenants_count tenant namespaces exist"
  fi

  # Each Secret YAML in the bundle is `kubectl get secret -o yaml` output.
  # PROBLEM on a fresh cold-restore: bootstrap.sh has already created some
  # of these Secrets (platform-jwt-secret, platform-admin-seed, platform-
  # secrets, platform-db-credentials, oauth2-proxy-config) with fresh
  # random values. `kubectl apply` on an existing Secret hits a
  # resourceVersion conflict. Solution: delete-then-apply for non-system-
  # managed Secrets, via the SECRET_REPLACE_MODE=force|apply flag.
  #
  # IMPORTANT: we intentionally SKIP platform-db-credentials by default.
  # Postgres was initialised by bootstrap with a fresh random password;
  # the restored Secret has the pre-wipe password which won't match.
  # Operator can opt into restoring it via --restore-db-credentials if
  # they plan to also ALTER USER platform WITH PASSWORD '<restored>'.
  local count=0
  local skipped=0
  while IFS= read -r f; do
    # Skip empty files — the secrets-backup CronJob can write zero-byte
    # placeholders for Secrets that were absent at backup time (e.g.
    # platform-dev-tls on a staging cluster). kubectl apply -f on an
    # empty file fails with "no objects passed to apply" which only adds
    # noise to the log.
    if [[ ! -s "$f" ]]; then
      skipped=$((skipped+1))
      continue
    fi
    local name
    name="$(grep -E '^  name:' "$f" | head -1 | awk '{print $2}')"
    if [[ "$name" == "platform-db-credentials" && "$RESTORE_DB_CREDS" != true ]]; then
      log "    SKIP $name (keep bootstrap's value — matches postgres init pw). Use --restore-db-credentials to force."
      skipped=$((skipped+1))
      continue
    fi
    if [[ "$SECRET_REPLACE_MODE" == "force" ]]; then
      # Pull ns + name from the YAML. Fallback to 'platform' if unset.
      local ns
      ns="$(grep -E '^  namespace:' "$f" | head -1 | awk '{print $2}')"
      ns="${ns:-platform}"
      run kubectl -n "$ns" delete secret "$name" --ignore-not-found >/dev/null 2>&1 || true
    fi
    if run kubectl apply -f "$f" >/dev/null 2>&1; then
      count=$((count+1))
    else
      warn "    failed to apply $f — continuing"
    fi
  done < <(find "$WORK_DIR/secrets" -name '*.yaml' -type f 2>/dev/null)
  log "  ✓ applied $count secrets, skipped $skipped"
}

# ─── Phase 7: Longhorn BackupTarget reactivate ────────────────────────────────

phase_longhorn_reactivate() {
  if $SKIP_LONGHORN; then log "Phase 7/9: SKIPPED (--skip-longhorn)"; return 0; fi
  log "Phase 7/9: Reactivate Longhorn BackupTarget"

  # Two paths:
  #   (a) Postgres was restored (not --skip-postgres) → platform-api's
  #       reconciler will see the active=true backup_configurations row
  #       on startup and wire the BackupTarget CR automatically. Wait
  #       and verify.
  #   (b) --skip-postgres was passed → platform-api has no config to
  #       read, so we patch the CR directly from the restored secrets
  #       bundle (longhorn-backup-credentials Secret has AWS_*). This
  #       closes the reviewer-found gap where --skip-postgres left the
  #       BackupTarget permanently Available=false without manual kubectl
  #       patch. Caught during the 2026-04-23 drill.
  if $SKIP_POSTGRES; then
    log "  --skip-postgres is set; manually wiring BackupTarget from restored longhorn-backup-credentials..."
    # Read creds from the in-cluster Secret (restored by Phase 6). The
    # `endpoint` value is used by Longhorn via the Secret, not by this
    # script directly — we decode it only to verify presence and log.
    local bucket region path_prefix endpoint
    endpoint="$(kubectl -n longhorn-system get secret longhorn-backup-credentials -o jsonpath='{.data.AWS_ENDPOINTS}' 2>/dev/null | base64 -d || true)"
    bucket="$(kubectl -n longhorn-system get secret longhorn-backup-credentials -o jsonpath='{.data.S3_BUCKET}' 2>/dev/null | base64 -d || true)"
    region="$(kubectl -n longhorn-system get secret longhorn-backup-credentials -o jsonpath='{.data.S3_REGION}' 2>/dev/null | base64 -d || true)"
    path_prefix="$(kubectl -n longhorn-system get secret longhorn-backup-credentials -o jsonpath='{.data.S3_PATH_PREFIX}' 2>/dev/null | base64 -d || true)"
    log "    endpoint=${endpoint:-<unset>} bucket=$bucket region=$region prefix=${path_prefix:-<none>}"
    if [[ -z "$bucket" || -z "$region" ]]; then
      warn "longhorn-backup-credentials Secret is missing S3_BUCKET/S3_REGION — cannot auto-wire. Investigate:"
      warn "  kubectl -n longhorn-system get secret longhorn-backup-credentials -o yaml"
      return 1
    fi
    local url="s3://${bucket}@${region}/"
    [[ -n "$path_prefix" ]] && url="s3://${bucket}@${region}/${path_prefix}"
    run kubectl -n longhorn-system patch backuptarget default --type=merge \
      -p "{\"spec\":{\"backupTargetURL\":\"${url}\",\"credentialSecret\":\"longhorn-backup-credentials\",\"pollInterval\":\"5m\"}}"
  fi

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
  # Derive the smoke-test host from the running cluster's platform-config
  # ConfigMap unless --smoke-host was passed. This replaces the old
  # hard-coded dev hostname inside smoke-test.sh. Resolves the Phase 9
  # regression found in the 2026-04-23 drill where the smoke-test tried
  # to reach admin.k8s-platform.test:2010 against a staging cluster.
  local host="$SMOKE_HOST"
  if [[ -z "$host" ]]; then
    host=$(kubectl -n platform get configmap platform-config \
      -o jsonpath='{.data.ingress-base-domain}' 2>/dev/null || true)
    if [[ -n "$host" ]]; then
      host="admin.$host"
    fi
  fi
  if [[ -z "$host" ]]; then
    warn "Could not derive smoke-test host (platform-config.ingress-base-domain unset, no --smoke-host). Skipping."
    return 0
  fi

  local admin_email="admin@${host#admin.}"
  local admin_pw
  admin_pw=$(kubectl -n platform get secret platform-admin-seed \
    -o jsonpath='{.data.admin_password}' 2>/dev/null | base64 -d 2>/dev/null || true)

  log "  Target: https://${host}/  (admin: ${admin_email})"
  if [[ -x ./scripts/smoke-test.sh ]]; then
    API_URL="https://${host}" \
    ADMIN_EMAIL="$admin_email" \
    ADMIN_PASSWORD="$admin_pw" \
    MAIL_TESTS_ENABLED=0 \
      run ./scripts/smoke-test.sh
  else
    # Fallback: minimal curl-based probe.
    log "  smoke-test.sh not present — falling back to curl probe"
    local code
    code=$(curl -sSk -o /dev/null -w '%{http_code}' "https://${host}/api/v1/healthz" || echo "FAIL")
    if [[ "$code" == "200" ]]; then
      log "  ✓ /api/v1/healthz returned HTTP 200"
    else
      warn "  /api/v1/healthz returned $code — investigate"
    fi
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
