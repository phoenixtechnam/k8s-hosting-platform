#!/usr/bin/env bash
# migrate-mail-pg.sh — major-version upgrade of the mail-pg CNPG cluster
# via `bootstrap.initdb.import` (declarative pg_dump+restore between
# clusters on different major versions).
#
# WHY a script: Phase 2 (16→17) and Phase 4 (17→18) of the PG-bump
# project both follow the same shape — create a new Cluster CR with
# imageName at the new version, import via initdb.import from the live
# source, validate row counts, then cut over Stalwart. This script
# parameterises the source cluster name + target version so the same
# tool covers both bumps and any future ones.
#
# WHY NOT a Flux-applied manifest: the new Cluster CR is migration
# scaffolding — it lives only as long as the cutover takes, then we
# decommission the old cluster and update k8s/base manifests to point
# at the new name. Putting it in base would confuse Flux (two clusters
# competing for the same data) and leave dead resources after cutover.
#
# WHAT THIS SCRIPT DOES (read-only by default — needs --apply for
# destructive ops):
#   1. Probes source cluster size + table row counts
#   2. Generates the target Cluster CR YAML (initdb.import +
#      externalClusters with the source's app credentials)
#   3. With --apply: kubectl applies the manifest, polls for Ready,
#      then prints target row counts so operator can verify parity
#
# WHAT THIS SCRIPT DOES NOT DO (intentionally — irreversible ops
# need operator confirmation per the runbook):
#   - Stop / cut over Stalwart Deployment
#   - Delete the old mail-pg cluster
#   - Update k8s/base manifests
#
# See docs/02-operations/MAIL_PG_PG_MAJOR_UPGRADE.md for the full
# runbook including the cutover gates and rollback path.
#
# USAGE:
#   ./scripts/migrate-mail-pg.sh \
#     --source mail-pg \
#     --target mail-pg-17 \
#     --target-image ghcr.io/cloudnative-pg/postgresql:17.5 \
#     [--namespace mail] \
#     [--database stalwart_app] \
#     [--storage-class longhorn-system-local] \
#     [--storage-size 5Gi] \
#     [--apply] \
#     [--kubeconfig PATH] \
#     [--remote root@HOST]
set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────────────────
NAMESPACE="mail"
SOURCE_CLUSTER=""
TARGET_CLUSTER=""
TARGET_IMAGE=""
DATABASE="stalwart_app"
SOURCE_SECRET=""             # auto-detected: prefer <source>-app, fall back to mail-pg-app-credentials
STORAGE_CLASS="longhorn-system-local"
STORAGE_SIZE="5Gi"
APPLY=false
KUBECONFIG_PATH="${KUBECONFIG:-$HOME/.kube/config}"
REMOTE_HOST=""

usage() {
  sed -n '2,55p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)        SOURCE_CLUSTER="$2"; shift 2 ;;
    --target)        TARGET_CLUSTER="$2"; shift 2 ;;
    --target-image)  TARGET_IMAGE="$2";   shift 2 ;;
    --namespace|-n)  NAMESPACE="$2";      shift 2 ;;
    --database)      DATABASE="$2";       shift 2 ;;
    --storage-class) STORAGE_CLASS="$2";  shift 2 ;;
    --storage-size)  STORAGE_SIZE="$2";   shift 2 ;;
    --source-secret) SOURCE_SECRET="$2";  shift 2 ;;
    --apply)         APPLY=true;          shift ;;
    --kubeconfig)    KUBECONFIG_PATH="$2"; shift 2 ;;
    --remote)        REMOTE_HOST="$2";    shift 2 ;;
    -h|--help)       usage 0 ;;
    *) echo "Unknown arg: $1" >&2; usage 2 ;;
  esac
done

[[ -z "$SOURCE_CLUSTER" || -z "$TARGET_CLUSTER" || -z "$TARGET_IMAGE" ]] && {
  echo "ERROR: --source, --target, and --target-image are required" >&2
  usage 2
}

[[ "$SOURCE_CLUSTER" == "$TARGET_CLUSTER" ]] && {
  echo "ERROR: --source and --target must differ (CNPG cluster names are immutable)." >&2
  exit 2
}

log() { printf '[migrate-mail-pg] %s\n' "$*"; }

# ─── Remote pass-through ─────────────────────────────────────────────────────
if [[ -n "$REMOTE_HOST" ]]; then
  log "Re-executing on $REMOTE_HOST..."
  scp -q "$0" "${REMOTE_HOST}:/tmp/migrate-mail-pg.sh"
  remote_args=()
  [[ -n "$NAMESPACE"     ]] && remote_args+=(--namespace "$NAMESPACE")
  remote_args+=(--source "$SOURCE_CLUSTER")
  remote_args+=(--target "$TARGET_CLUSTER")
  remote_args+=(--target-image "$TARGET_IMAGE")
  [[ -n "$DATABASE"      ]] && remote_args+=(--database "$DATABASE")
  [[ -n "$SOURCE_SECRET" ]] && remote_args+=(--source-secret "$SOURCE_SECRET")
  [[ -n "$STORAGE_CLASS" ]] && remote_args+=(--storage-class "$STORAGE_CLASS")
  [[ -n "$STORAGE_SIZE"  ]] && remote_args+=(--storage-size "$STORAGE_SIZE")
  [[ "$APPLY" == true    ]] && remote_args+=(--apply)
  # Quote each arg with %q so values containing spaces/special chars
  # don't misparse when re-tokenised on the remote shell.
  exec ssh -t "$REMOTE_HOST" \
    "sudo bash /tmp/migrate-mail-pg.sh --kubeconfig /etc/rancher/k3s/k3s.yaml $(printf '%q ' "${remote_args[@]}")"
fi

kctl() { kubectl --kubeconfig="$KUBECONFIG_PATH" "$@"; }

# ─── Sanity checks ───────────────────────────────────────────────────────────
log "Verifying source cluster ${NAMESPACE}/${SOURCE_CLUSTER} is healthy..."
src_phase=$(kctl get cluster.postgresql.cnpg.io -n "$NAMESPACE" "$SOURCE_CLUSTER" \
  -o jsonpath='{.status.phase}' 2>/dev/null || echo "MISSING")
if [[ "$src_phase" != "Cluster in healthy state" ]]; then
  echo "ERROR: source ${SOURCE_CLUSTER} phase is '${src_phase}', expected 'Cluster in healthy state'." >&2
  echo "  Refusing to import from an unhealthy cluster — fix that first." >&2
  exit 1
fi
log "  source phase: $src_phase ✓"

log "Verifying target cluster ${NAMESPACE}/${TARGET_CLUSTER} does NOT exist..."
if kctl get cluster.postgresql.cnpg.io -n "$NAMESPACE" "$TARGET_CLUSTER" >/dev/null 2>&1; then
  echo "ERROR: target ${TARGET_CLUSTER} already exists." >&2
  echo "  To re-run the migration, delete it first:" >&2
  echo "    kubectl delete cluster.postgresql.cnpg.io -n ${NAMESPACE} ${TARGET_CLUSTER}" >&2
  exit 1
fi
log "  target does not exist ✓"

# Auto-detect source credentials secret. Two Secrets typically exist:
#   - <cluster>-app: CNPG-managed kubernetes.io/basic-auth Secret. The
#     password here is auto-rotated by the operator on cluster events.
#     This is NOT necessarily what the running application uses — when
#     the cluster was bootstrapped via .bootstrap.recovery (DR drill,
#     PITR, etc.) the in-DB password reflects the recovered backup,
#     not the operator's current Secret value, and the CNPG-managed
#     Secret can drift out of sync. Verified empirically on staging
#     2026-05-06: the auto-detected mail-pg-app password failed
#     `pg_dump` auth while mail-pg-app-credentials succeeded.
#   - <cluster>-app-credentials (or mail-pg-app-credentials): operator-
#     supplied Opaque Secret referenced by the source manifest's
#     bootstrap.initdb.secret. This IS what the application connects
#     with — the source-of-truth password.
# Prefer the operator-supplied one. --source-secret forces a name.
if [[ -z "$SOURCE_SECRET" ]]; then
  for candidate in "${SOURCE_CLUSTER}-app-credentials" "mail-pg-app-credentials" "${SOURCE_CLUSTER}-app"; do
    if kctl get secret -n "$NAMESPACE" "$candidate" >/dev/null 2>&1; then
      SOURCE_SECRET="$candidate"
      break
    fi
  done
fi
if [[ -z "$SOURCE_SECRET" ]] || ! kctl get secret -n "$NAMESPACE" "$SOURCE_SECRET" >/dev/null 2>&1; then
  echo "ERROR: source credentials Secret not found in namespace ${NAMESPACE}." >&2
  echo "  Tried: ${SOURCE_CLUSTER}-app-credentials, mail-pg-app-credentials, ${SOURCE_CLUSTER}-app." >&2
  echo "  Pass --source-secret <name> to override." >&2
  exit 1
fi

# Verify the chosen Secret can actually authenticate before kicking off
# the import (catches drift between the CNPG-managed Secret and the
# in-DB password). Spin up a transient pg client pod that runs SELECT 1.
log "  source credentials Secret: ${SOURCE_SECRET}"
log "  Probing auth from a transient pod (catches stale-Secret drift early)..."
src_pw=$(kctl get secret -n "$NAMESPACE" "$SOURCE_SECRET" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || true)
if [[ -z "$src_pw" ]]; then
  echo "ERROR: ${SOURCE_SECRET} has no .data.password key." >&2
  exit 1
fi
# Use detached pod + kubectl logs instead of `kubectl run --rm -i`. The
# latter raced with the kubelet output stream — `kubectl run --rm` deletes
# the pod as soon as it terminates and the psql output was sometimes lost
# before kubectl could read it (verified empirically on staging
# 2026-05-07: probe falsely reported FATAL even though the same psql
# command via separate kubectl run worked). Detached pod + logs is
# deterministic.
probe_name="auth-probe-$$-$RANDOM"
kctl run "$probe_name" --restart=Never \
  -n "$NAMESPACE" --image=postgres:16-alpine \
  --env="PGPASSWORD=$src_pw" --command \
  -- psql -h "${SOURCE_CLUSTER}-rw.${NAMESPACE}.svc.cluster.local" \
  -U "${DATABASE}" -d "${DATABASE}" -c "SELECT 1" >/dev/null 2>&1 || true
# Wait up to 120s for pod to reach terminal phase before reading logs.
# 20s was too short for clusters with image pulls or scheduling delays.
pod_phase=""
for _ in $(seq 1 60); do
  pod_phase=$(kctl get pod -n "$NAMESPACE" "$probe_name" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  [[ "$pod_phase" == "Succeeded" || "$pod_phase" == "Failed" ]] && break
  sleep 2
done
if [[ "$pod_phase" != "Succeeded" && "$pod_phase" != "Failed" ]]; then
  echo "ERROR: auth probe pod ${probe_name} did not reach terminal state in 120s." >&2
  echo "  Last phase: ${pod_phase:-unknown}" >&2
  kctl describe pod -n "$NAMESPACE" "$probe_name" 2>&1 | tail -20 >&2
  kctl delete pod -n "$NAMESPACE" "$probe_name" --wait=false >/dev/null 2>&1 || true
  exit 1
fi
auth_probe=$(kctl logs -n "$NAMESPACE" "$probe_name" 2>&1 || true)
kctl delete pod -n "$NAMESPACE" "$probe_name" --wait=false >/dev/null 2>&1 || true
if ! printf '%s' "$auth_probe" | grep -q "(1 row)"; then
  echo "ERROR: auth probe to ${SOURCE_CLUSTER}-rw failed using Secret ${SOURCE_SECRET}." >&2
  echo "  This means the Secret's password is stale relative to the in-DB" >&2
  echo "  password. Fix it before retrying — either:" >&2
  echo "    (a) Update the Secret to match the in-DB password, OR" >&2
  echo "    (b) Pass --source-secret <other-name> to use a Secret that works." >&2
  echo "  Probe output:" >&2
  printf '%s\n' "$auth_probe" | sed 's/^/    /' >&2
  exit 1
fi
log "  auth probe SELECT 1 → (1 row) ✓"

# ─── Probe source row counts ─────────────────────────────────────────────────
src_pod=$(kctl get pod -n "$NAMESPACE" -l "cnpg.io/cluster=${SOURCE_CLUSTER},role=primary" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
[[ -z "$src_pod" ]] && {
  # Some CNPG versions use cnpg.io/instanceRole instead of role
  src_pod=$(kctl get pod -n "$NAMESPACE" -l "cnpg.io/cluster=${SOURCE_CLUSTER},cnpg.io/instanceRole=primary" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
}
[[ -z "$src_pod" ]] && {
  echo "ERROR: could not find primary pod for ${SOURCE_CLUSTER}." >&2
  exit 1
}
log "Source primary pod: $src_pod"

probe_rowcounts() {
  local pod="$1" db="$2"
  kctl exec -n "$NAMESPACE" "$pod" -c postgres -- \
    psql -U postgres -d "$db" -At -F $'\t' \
    -c "SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
                (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') AS public_tables,
                (SELECT coalesce(sum(n_live_tup),0) FROM pg_stat_user_tables) AS live_rows" \
    2>/dev/null | head -1
}

log "Probing ${DATABASE} on source..."
src_stats=$(probe_rowcounts "$src_pod" "$DATABASE")
src_size=$(printf '%s' "$src_stats" | cut -f1)
src_tables=$(printf '%s' "$src_stats" | cut -f2)
src_rows=$(printf '%s' "$src_stats" | cut -f3)
log "  source: size=${src_size} tables=${src_tables} live_rows=${src_rows}"

# ─── Generate target Cluster CR ──────────────────────────────────────────────
manifest_path="/tmp/${TARGET_CLUSTER}.yaml"
cat > "$manifest_path" <<EOF
# AUTO-GENERATED by migrate-mail-pg.sh on $(date -u +%FT%TZ)
# Source: ${SOURCE_CLUSTER} → Target: ${TARGET_CLUSTER} (${TARGET_IMAGE})
# This manifest is migration scaffolding — once Stalwart has been cut over to
# ${TARGET_CLUSTER} and the old cluster decommissioned, the canonical
# manifest at k8s/base/stalwart-v016/mail-pg/cluster.yaml should be updated
# to use ${TARGET_CLUSTER} as the cluster name + ${TARGET_IMAGE} as imageName.
---
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${TARGET_CLUSTER}
  namespace: ${NAMESPACE}
  labels:
    app: ${TARGET_CLUSTER}
    app.kubernetes.io/part-of: hosting-platform
    app.kubernetes.io/component: mail-database
    platform.phoenix-host.net/migration-from: ${SOURCE_CLUSTER}
spec:
  inheritedMetadata:
    labels:
      app: ${TARGET_CLUSTER}
      app.kubernetes.io/part-of: hosting-platform

  # Single instance during migration; HA reconciler will scale up after
  # cutover (matching the source cluster's instance count).
  instances: 1

  imageName: ${TARGET_IMAGE}

  bootstrap:
    initdb:
      database: ${DATABASE}
      owner: ${DATABASE}
      # CNPG generates an app secret for the target named
      # ${TARGET_CLUSTER}-app. After migration we update Stalwart's
      # config to use ${TARGET_CLUSTER}-rw (a CNPG-managed Service)
      # and the new app credentials.
      postInitApplicationSQL:
        - "GRANT ALL PRIVILEGES ON DATABASE ${DATABASE} TO ${DATABASE}"
        - "ALTER USER ${DATABASE} CREATEDB"
      import:
        # microservice = single database, app-style. CNPG runs
        # pg_dump on source then pg_restore into target. The connecting
        # user is the source app user (full rights on its own DB).
        type: microservice
        databases:
          - ${DATABASE}
        source:
          externalCluster: ${SOURCE_CLUSTER}-source
        # ANALYZE post-import so the planner has fresh stats.
        postImportApplicationSQL:
          - "ANALYZE VERBOSE"

  externalClusters:
    # NOTE on connecting user: app-user (${DATABASE}) is sufficient for
    # microservice-type pg_dump on CNPG 1.25+ (the operator falls back
    # gracefully when --globals-only role dump hits permission errors).
    # If a future CNPG version requires pg_read_all_settings, grant it
    # temporarily for the import window or pass a superuser credential
    # via --source-secret.
    #
    # NetworkPolicy assumption: the source-cluster Service must be
    # reachable from the new target pod. mail/ namespace currently has
    # no default-deny-egress; if one is added, this import would fail.
    - name: ${SOURCE_CLUSTER}-source
      connectionParameters:
        host: ${SOURCE_CLUSTER}-rw.${NAMESPACE}.svc.cluster.local
        user: ${DATABASE}
        dbname: ${DATABASE}
        sslmode: require
      password:
        name: ${SOURCE_SECRET}
        key: password

  storage:
    size: ${STORAGE_SIZE}
    storageClass: ${STORAGE_CLASS}

  resources:
    requests:
      cpu: 50m
      memory: 256Mi
    limits:
      cpu: 200m
      memory: 512Mi

  # Same node-affinity contract as the source cluster — system server
  # nodes only, never tenant workers.
  affinity:
    nodeSelector:
      platform.phoenix-host.net/node-role: server
    tolerations:
      - key: platform.phoenix-host.net/server-only
        operator: Exists
        effect: NoSchedule
    podAntiAffinityType: preferred
    topologyKey: kubernetes.io/hostname

  monitoring:
    enablePodMonitor: false
EOF

log "Generated manifest at $manifest_path:"
sed 's/^/  /' "$manifest_path"
echo

if [[ "$APPLY" != true ]]; then
  log "DRY-RUN — pass --apply to create the cluster + run the import."
  log "Once applied, this script will poll for Ready and print row counts."
  exit 0
fi

# ─── Apply + wait ────────────────────────────────────────────────────────────
log "Applying ${TARGET_CLUSTER} (initdb.import begins)..."
kctl apply -f "$manifest_path"

log "Polling for ${TARGET_CLUSTER} Ready (this includes pg_dump+restore + initial bootstrap)..."
phase=""
for i in $(seq 1 60); do
  phase=$(kctl get cluster.postgresql.cnpg.io -n "$NAMESPACE" "$TARGET_CLUSTER" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  ready=$(kctl get cluster.postgresql.cnpg.io -n "$NAMESPACE" "$TARGET_CLUSTER" \
    -o jsonpath='{.status.readyInstances}' 2>/dev/null || echo "0")
  printf '\r[migrate-mail-pg]   [%02d/60] phase=%-50s ready=%s' "$i" "${phase:-?}" "$ready"
  if [[ "$phase" == "Cluster in healthy state" && "$ready" -ge 1 ]]; then
    echo; break
  fi
  sleep 10
done
echo

if [[ "$phase" != "Cluster in healthy state" ]]; then
  [[ -z "$phase" ]] && phase="(unknown — last poll failed)"
  echo "ERROR: ${TARGET_CLUSTER} did not reach healthy state in 10 minutes (last phase: ${phase})." >&2
  echo "  Inspect:  kubectl describe cluster.postgresql.cnpg.io -n ${NAMESPACE} ${TARGET_CLUSTER}" >&2
  echo "  Logs:     kubectl logs -n ${NAMESPACE} ${TARGET_CLUSTER}-1 -c postgres --tail=50" >&2
  exit 1
fi
log "  target ${TARGET_CLUSTER} healthy ✓"

# ─── Probe target + compare ──────────────────────────────────────────────────
tgt_pod=$(kctl get pod -n "$NAMESPACE" -l "cnpg.io/cluster=${TARGET_CLUSTER}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
log "Target primary pod: $tgt_pod"

log "Probing ${DATABASE} on target..."
tgt_stats=$(probe_rowcounts "$tgt_pod" "$DATABASE")
tgt_size=$(printf '%s' "$tgt_stats" | cut -f1)
tgt_tables=$(printf '%s' "$tgt_stats" | cut -f2)
tgt_rows=$(printf '%s' "$tgt_stats" | cut -f3)

echo
echo "════════════════════════════════════════════════════════"
echo "  IMPORT COMPLETE — verify parity before cutover"
echo "════════════════════════════════════════════════════════"
printf "  %-15s %-20s %-20s\n" "" "$SOURCE_CLUSTER" "$TARGET_CLUSTER"
printf "  %-15s %-20s %-20s\n" "size" "$src_size" "$tgt_size"
printf "  %-15s %-20s %-20s\n" "public_tables" "$src_tables" "$tgt_tables"
printf "  %-15s %-20s %-20s\n" "live_rows" "$src_rows" "$tgt_rows"
echo "════════════════════════════════════════════════════════"
echo

if [[ "$src_tables" != "$tgt_tables" ]]; then
  echo "WARNING: table counts differ ($src_tables vs $tgt_tables)." >&2
  echo "  Inspect both clusters before cutover." >&2
fi
if [[ "$src_rows" != "$tgt_rows" ]]; then
  echo "WARNING: live_rows differ ($src_rows vs $tgt_rows)." >&2
  echo "  This is expected if Stalwart wrote during the import. The cutover" >&2
  echo "  step in the runbook stops Stalwart so the final state is consistent." >&2
fi

# Save a snapshot of the operator-supplied credentials Secret BEFORE
# the operator runs the cutover (which patches it in place). Without
# this, rollback to the old cluster requires reconstructing the old
# password from somewhere — and you can't get it back from the source
# cluster's app secret because both clusters' password fields are
# typically rotated when CNPG generates new credentials.
backup_path="/tmp/${SOURCE_CLUSTER}-app-credentials.before-${TARGET_CLUSTER}.yaml"
if kctl get secret -n "$NAMESPACE" "$SOURCE_SECRET" -o yaml > "$backup_path" 2>/dev/null; then
  log "Pre-cutover Secret backup saved: $backup_path"
  log "  Keep this file off-cluster (scp it to your workstation if running via --remote)."
  log "  Rollback: kubectl apply -f $backup_path"
else
  echo "WARNING: failed to back up source Secret to $backup_path." >&2
  echo "  Take a manual copy before running cutover step 4d in the runbook." >&2
fi

echo "Next: see docs/02-operations/MAIL_PG_PG_MAJOR_UPGRADE.md → 'Cutover' for the"
echo "      Stalwart switchover steps. This script does NOT cut over — that's"
echo "      a deliberate gate so the operator confirms parity first."
