#!/usr/bin/env bash
# CI guard — rejects regressions on the universal backup-rclone-shim
# architecture (R-X1 through R-X14). Wire into Infrastructure CI.
#
# What this catches:
#   1. backup-rclone-shim routes regressing from super_admin-only to
#      any wider role gate (a misassignment could leak data to a
#      wrong upstream).
#   2. SHIM_CLASSES drift between service.ts and api-contracts
#      (must be 'system' | 'tenant' | 'mail' — three entries, locked).
#   3. The reconciler STATE_ERROR codepath persisting a non-empty
#      inputHash (would lock the reconciler into permanent ERROR;
#      self-heal requires inputHash='' on STATE_ERROR).
#   4. The drain primitive forgetting one of the documented shim
#      consumer task kinds (drains would short-circuit, in-flight
#      backups could be cut off by a target switch).
#   5. backup_target_assignments CHECK constraint losing the three
#      shim classes ('system','tenant','mail').
#   6. SHIM_CONSUMER_TASK_KINDS containing a kind not in the
#      TASK_KIND_REGISTRY (would never match any inflight task).
#   7. drain_timeout_seconds column losing its 30..1800 CHECK guard.
#   8. The routes file losing the "buildK8sClients" lazy factory
#      (eager construction would crash unit-test boot without kube
#      config available).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOD_DIR="$ROOT/backend/src/modules/backup-rclone-shim"
SERVICE="$MOD_DIR/service.ts"
RECONCILER="$MOD_DIR/reconciler.ts"
DRAIN="$MOD_DIR/drain.ts"
ROUTES="$MOD_DIR/routes.ts"
APPLY="$MOD_DIR/apply-assignment.ts"
CONTRACTS="$ROOT/packages/api-contracts/src/backup-rclone-shim.ts"
TASK_CENTER="$ROOT/packages/api-contracts/src/task-center.ts"
MIG_0016="$ROOT/backend/src/db/migrations/0016_backup_rclone_shim_classes.sql"
MIG_0018="$ROOT/backend/src/db/migrations/0019_backup_drain_timeout.sql"

fail() {
  echo "[ci-backup-rclone-shim] FAIL: $1" >&2
  exit 1
}
pass() {
  echo "[ci-backup-rclone-shim] PASS: $1"
}

for f in "$SERVICE" "$RECONCILER" "$DRAIN" "$ROUTES" "$APPLY" "$CONTRACTS" \
         "$TASK_CENTER" "$MIG_0016" "$MIG_0018"; do
  if [[ ! -f "$f" ]]; then
    fail "Cannot find $f"
  fi
done

# Strip // comments + /* ... */ blocks before grepping load-bearing
# invariants so doc comments mentioning forbidden patterns don't trip
# the guard.
strip_comments() {
  sed -e 's://.*$::' -e '/\/\*/,/\*\//d' "$1"
}

# ─── 1. Routes super_admin only ─────────────────────────────────────
ROUTES_CODE=$(strip_comments "$ROUTES")
if echo "$ROUTES_CODE" | grep -qE "requireRole\('super_admin',\s*'admin'"; then
  fail "Invariant 1: routes.ts must use requireRole('super_admin') ONLY — found 'admin' on the gate"
fi
if echo "$ROUTES_CODE" | grep -qE "requireRole\('admin'"; then
  fail "Invariant 1: routes.ts must use requireRole('super_admin') ONLY — found 'admin' on the gate"
fi
if ! echo "$ROUTES_CODE" | grep -qE "requireRole\('super_admin'\)"; then
  fail "Invariant 1: routes.ts must call requireRole('super_admin')"
fi
pass "Invariant 1: routes super_admin-only"

# ─── 2. SHIM_CLASSES locked to 3 entries ────────────────────────────
SERVICE_CODE=$(strip_comments "$SERVICE")
if ! echo "$SERVICE_CODE" | grep -qE "SHIM_CLASSES.*=.*\[.*'system'.*'tenant'.*'mail'"; then
  fail "Invariant 2: SHIM_CLASSES must be ['system','tenant','mail'] in service.ts"
fi
CONTRACTS_CODE=$(strip_comments "$CONTRACTS")
if ! echo "$CONTRACTS_CODE" | grep -qE "backupShimClassEnum.*=.*\['system',\s*'tenant',\s*'mail'\]"; then
  fail "Invariant 2: backupShimClassEnum must be exactly ['system','tenant','mail'] in api-contracts"
fi
pass "Invariant 2: SHIM_CLASSES locked"

# ─── 3. STATE_ERROR writes empty inputHash (self-heal) ──────────────
RECONCILER_CODE=$(strip_comments "$RECONCILER")
# The materializeAndWriteStatus failure path must explicitly write
# inputHash: '' to the status CM. Detect the literal write — comment
# at the callsite is the canonical doc string.
if ! echo "$RECONCILER_CODE" | grep -qE "state:\s*'STATE_ERROR',\s*$"; then
  fail "Invariant 3: reconciler must emit STATE_ERROR on materialise failure"
fi
# Two occurrences of inputHash: '' (the early-failure paths AND the
# materialise-failure path). Lower bound 2 — anything fewer means a
# code path was dropped.
INPUT_HASH_EMPTY_COUNT=$(echo "$RECONCILER_CODE" | grep -cE "inputHash:\s*''" || true)
if [[ "$INPUT_HASH_EMPTY_COUNT" -lt 2 ]]; then
  fail "Invariant 3: reconciler must write inputHash: '' on every STATE_ERROR / STATE_MISSING_KEY path (found ${INPUT_HASH_EMPTY_COUNT}, expected >= 2)"
fi
pass "Invariant 3: STATE_ERROR self-heal"

# ─── 4. SHIM_CONSUMER_TASK_KINDS coverage ──────────────────────────
DRAIN_CODE=$(strip_comments "$DRAIN")
# Every documented class must have at least one kind. Detect minimally
# via grep — a more rigorous check is the unit test.
for k in 'backup.run' 'backup.bundle' 'mail.snapshot.trigger' 'storage.snapshot' 'postgres.pitr'; do
  if ! echo "$DRAIN_CODE" | grep -qF "'$k'"; then
    fail "Invariant 4: SHIM_CONSUMER_TASK_KINDS missing '$k' in drain.ts"
  fi
done
pass "Invariant 4: shim consumer task kinds covered"

# ─── 5. backup_target_assignments allows shim classes ──────────────
if ! grep -qE "'system',[[:space:]]*$|'system'$" "$MIG_0016"; then
  fail "Invariant 5: 0016 migration must allow 'system' class in CHECK"
fi
if ! grep -qE "'tenant',[[:space:]]*$|'tenant'$" "$MIG_0016"; then
  fail "Invariant 5: 0016 migration must allow 'tenant' class in CHECK"
fi
if ! grep -qE "'mail'\s*$|'mail',\s*$" "$MIG_0016"; then
  fail "Invariant 5: 0016 migration must allow 'mail' class in CHECK"
fi
pass "Invariant 5: migration 0016 CHECK constraint covers shim classes"

# ─── 6. SHIM_CONSUMER_TASK_KINDS members exist in TASK_KIND_REGISTRY ─
# Parse the kinds out of drain.ts (string literals between quotes
# inside the array), then verify each appears as a registry entry.
TASK_CENTER_CODE=$(strip_comments "$TASK_CENTER")
# Extract single-quoted kinds from the SHIM_CONSUMER_TASK_KINDS block.
KIND_BLOCK=$(awk '/^export const SHIM_CONSUMER_TASK_KINDS/,/^\] as const;/' "$DRAIN")
KINDS=$(echo "$KIND_BLOCK" | grep -oE "'[a-z][a-z0-9._-]+'" | sort -u)
if [[ -z "$KINDS" ]]; then
  fail "Invariant 6: could not parse SHIM_CONSUMER_TASK_KINDS from drain.ts"
fi
while IFS= read -r kind_quoted; do
  kind=${kind_quoted//\'/}
  if ! echo "$TASK_CENTER_CODE" | grep -qF "'$kind'"; then
    fail "Invariant 6: SHIM_CONSUMER_TASK_KINDS contains '$kind' but task-center registry doesn't list it"
  fi
done <<< "$KINDS"
pass "Invariant 6: every shim-consumer kind exists in TASK_KIND_REGISTRY"

# ─── 7. drain_timeout_seconds CHECK constraint ─────────────────────
if ! grep -qE "drain_timeout_seconds.*BETWEEN\s+30\s+AND\s+1800" "$MIG_0018"; then
  fail "Invariant 7: migration 0018 must CHECK drain_timeout_seconds BETWEEN 30 AND 1800"
fi
pass "Invariant 7: drain_timeout_seconds CHECK constraint present"

# ─── 8. Lazy buildK8sClients factory ───────────────────────────────
if ! echo "$ROUTES_CODE" | grep -qE "buildK8sClients\(\)\.[a-z]+"; then
  fail "Invariant 8: routes.ts must invoke buildK8sClients() lazily per-request, not eagerly at registration"
fi
pass "Invariant 8: buildK8sClients factory is lazy"

# ─── 9. Postgres ObjectStore reconciler exists + wired ────────────
POSTGRES_OBJECTSTORE="$ROOT/backend/src/modules/backup-rclone-shim/postgres-objectstore.ts"
POSTGRES_SCHEDULER="$ROOT/backend/src/modules/backup-rclone-shim/postgres-objectstore-scheduler.ts"
APP_TS="$ROOT/backend/src/app.ts"
DATABASE_YAML="$ROOT/k8s/base/database.yaml"
CNPG_KUSTOMIZATION="$ROOT/k8s/base/cnpg-system/kustomization.yaml"

if [[ ! -f "$POSTGRES_OBJECTSTORE" ]]; then
  fail "Invariant 9: postgres-objectstore reconciler missing"
fi
if [[ ! -f "$POSTGRES_SCHEDULER" ]]; then
  fail "Invariant 9: postgres-objectstore scheduler missing"
fi
if ! grep -q "startPostgresObjectStoreReconciler" "$APP_TS"; then
  fail "Invariant 9: postgres-objectstore scheduler not wired into app.ts"
fi
pass "Invariant 9: postgres-objectstore reconciler wired"

# ─── 10. CNPG Cluster CR references barman-cloud plugin ───────────
if ! grep -q "name: barman-cloud.cloudnative-pg.io" "$DATABASE_YAML"; then
  fail "Invariant 10: CNPG Cluster system-db must reference barman-cloud plugin"
fi
if ! grep -q "objectStoreName: system-postgres-objectstore" "$DATABASE_YAML"; then
  fail "Invariant 10: CNPG Cluster system-db must point at the system-postgres-objectstore CR"
fi
pass "Invariant 10: CNPG Cluster references barman-cloud plugin"

# ─── 11. plugin-barman-cloud manifest is registered with Flux ─────
if [[ ! -f "$CNPG_KUSTOMIZATION" ]]; then
  fail "Invariant 11: k8s/base/cnpg-system/kustomization.yaml missing"
fi
if ! grep -q "plugin-barman-cloud" "$CNPG_KUSTOMIZATION"; then
  fail "Invariant 11: cnpg-system kustomization missing plugin-barman-cloud entry"
fi
if ! grep -q "cnpg-system/" "$ROOT/k8s/base/kustomization.yaml"; then
  fail "Invariant 11: base kustomization.yaml missing cnpg-system/ resource"
fi
pass "Invariant 11: plugin-barman-cloud applied via Flux"

# ─── 12. database.yaml does NOT statically set isWALArchiver ──────
# The reconciler owns this field — static `isWALArchiver: true` in
# the manifest would cause pg_wal accumulation when SYSTEM is
# unassigned (review HIGH #1). The reconciler patches it on/off based
# on the SYSTEM target binding.
if grep -E "^\s*isWALArchiver:\s*true" "$DATABASE_YAML" >/dev/null 2>&1; then
  fail "Invariant 12: database.yaml must NOT set isWALArchiver: true statically — the reconciler owns this field (see postgres-objectstore.ts patchClusterWalArchiver). Remove the static line; it will be patched on at runtime when SYSTEM is bound."
fi
# The reconciler MUST call patchClusterWalArchiver.
if ! grep -q "patchClusterWalArchiver" "$POSTGRES_OBJECTSTORE"; then
  fail "Invariant 12: postgres-objectstore.ts must call patchClusterWalArchiver to toggle WAL archiving"
fi
pass "Invariant 12: isWALArchiver is reconciler-owned (no static true)"

# ─── 13. etcd-snap-via-shim CronJob present + reconciler wired ────
ETCD_CRONJOB_MANIFEST="$ROOT/k8s/base/backup/etcd-snap-via-shim-cronjob.yaml"
ETCD_RECONCILER="$ROOT/backend/src/modules/backup-rclone-shim/etcd-cronjob.ts"
BACKUP_KUSTOMIZATION="$ROOT/k8s/base/backup/kustomization.yaml"

if [[ ! -f "$ETCD_CRONJOB_MANIFEST" ]]; then
  fail "Invariant 13: k8s/base/backup/etcd-snap-via-shim-cronjob.yaml missing"
fi
if [[ ! -f "$ETCD_RECONCILER" ]]; then
  fail "Invariant 13: etcd-cronjob reconciler missing"
fi
if ! grep -q "etcd-snap-via-shim-cronjob.yaml" "$BACKUP_KUSTOMIZATION"; then
  fail "Invariant 13: k8s/base/backup/kustomization.yaml does not include etcd-snap-via-shim-cronjob.yaml"
fi
if ! grep -q "startEtcdCronJobReconciler" "$APP_TS"; then
  fail "Invariant 13: etcd-cronjob scheduler not wired into app.ts"
fi
if ! grep -qE "^\s*suspend:\s*true" "$ETCD_CRONJOB_MANIFEST"; then
  fail "Invariant 13: etcd-snap-via-shim CronJob must ship with suspend: true (reconciler flips it on)"
fi
if ! grep -q "backup-rclone-shim.platform.svc.cluster.local:9000" "$ETCD_CRONJOB_MANIFEST"; then
  fail "Invariant 13: etcd CronJob must route through the shim ClusterIP, not a direct upstream endpoint"
fi
if ! grep -q "backup-rclone-shim-creds" "$ETCD_CRONJOB_MANIFEST"; then
  fail "Invariant 13: etcd CronJob must reference the backup-rclone-shim-creds Secret"
fi
if grep -qE "name:\s*backup-credentials" "$ETCD_CRONJOB_MANIFEST"; then
  fail "Invariant 13: etcd-snap-via-shim CronJob must NOT use the legacy backup-credentials Secret"
fi
pass "Invariant 13: etcd-snap-via-shim CronJob via shim"

# ─── 14. mail-restic via shim reconciler wired ────────────────────
MAIL_RESTIC="$ROOT/backend/src/modules/backup-rclone-shim/mail-restic.ts"
if [[ ! -f "$MAIL_RESTIC" ]]; then
  fail "Invariant 14: mail-restic via shim reconciler missing"
fi
if ! grep -q "startMailResticShimReconciler" "$APP_TS"; then
  fail "Invariant 14: mail-restic-shim scheduler not wired into app.ts"
fi
# Must use the raw bucket (restic encrypts; -raw avoids double crypt).
if ! grep -q "mail-raw" "$MAIL_RESTIC"; then
  fail "Invariant 14: mail-restic must route through the mail-raw passthrough bucket (not mail-crypt)"
fi
# Coexistence with legacy mail-target-sync must be explicit.
if ! grep -q "STATE_LEGACY_TAKING_OVER" "$MAIL_RESTIC"; then
  fail "Invariant 14: mail-restic must surface STATE_LEGACY_TAKING_OVER when system_mail (legacy class) is bound"
fi
pass "Invariant 14: mail-restic via shim wired"

# ─── 15. rclone-push via shim ─────────────────────────────────────
RCLONE_PUSH="$ROOT/backend/src/modules/backup-rclone-shim/rclone-push.ts"
SNAPSHOT_STORE="$ROOT/backend/src/modules/storage-lifecycle/snapshot-store.ts"
if [[ ! -f "$RCLONE_PUSH" ]]; then
  fail "Invariant 15: rclone-push helper module missing"
fi
# Class mapping must cover the documented translations.
for legacy in 'tenant_snapshot' 'tenant_bundle' 'system_backup' 'system_mail'; do
  if ! grep -qF "'$legacy'" "$RCLONE_PUSH"; then
    fail "Invariant 15: rclone-push.ts shimClassFor missing legacy class '$legacy'"
  fi
done
# storage-lifecycle/snapshot-store.ts must call isShimModeActive
# BEFORE the legacy resolveTargetFor.
if ! grep -q "isShimModeActive" "$SNAPSHOT_STORE"; then
  fail "Invariant 15: snapshot-store.ts must check isShimModeActive before falling back to legacy resolver"
fi
pass "Invariant 15: rclone-push via shim wired"

echo "[ci-backup-rclone-shim] All 15 invariants pass."
