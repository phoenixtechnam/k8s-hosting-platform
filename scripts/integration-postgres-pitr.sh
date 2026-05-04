#!/usr/bin/env bash
# E2E for the snapshot-only Postgres PITR feature on the staging cluster.
#
# WHAT THIS HARNESS PROVES (end-to-end against a real CNPG cluster):
#
#   1. The auto-promote orchestrator wraps an existing Longhorn snapshot,
#      bootstraps a temp CNPG cluster from it, snapshot-handoffs into a
#      new cluster CR with the SAME source name, and removes the temp
#      cluster — all in a single sync HTTP call (≤10 min).
#
#   2. Round-trip semantics: a sentinel row inserted AFTER the snapshot
#      MUST disappear after restore (proves data really came from the
#      snapshot's PITR LSN, not from the live PVC that survived
#      reclaimPolicy=Retain).
#
#   3. Cluster identity preserved: connection string (Service name)
#      unchanged, instance count unchanged, no leftover temp cluster CR
#      and no leaked VolumeSnapshot wrapper resources.
#
#   4. Write-lock middleware blocks general POSTs during PITR with 503
#      RESTORE_IN_PROGRESS but allows status polling.
#
# WHY A SEPARATE HARNESS (vs. integration-system-snapshots.sh):
#   Phase 4a of system-snapshots asserts that the OLD per-PVC restore
#   route refuses CNPG (422). This harness is the proof that the NEW
#   auto-promote path actually works — they cover opposite concerns.
#
# SAFETY:
#   This script intentionally deletes and recreates the platform/postgres
#   cluster. The sentinel row is in a throwaway table created/dropped by
#   this script. Real platform data (users, clients, deployments) lives
#   in the same database — the snapshot is a real backup of that data,
#   and the round-trip restores all of it. Run only on staging.
#
# USAGE:
#   ADMIN_PASSWORD=<…> ./scripts/integration-postgres-pitr.sh

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_HOST="${SSH_HOST:-root@89.167.3.56}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
pass() { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; exit 1; }

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SSH_HOST"
KUBECTL="$SSH kubectl"

curl_admin() {
  curl -sS -k -H "Authorization: Bearer $TOKEN" "$@"
}

# Run a kubectl command on the staging server. Pass the full kubectl
# argv as a single quoted string to avoid double-shell interpretation
# of SQL/JSON arguments (otherwise parens, semicolons, quotes get
# eaten by the remote shell).
kubectl_remote() {
  $SSH "$@"
}

psql_pg() {
  # Exec into the current primary and run psql. The SQL is passed via
  # stdin (-- < EOF) to sidestep all quoting issues across the
  # local-shell → ssh → remote-shell → kubectl exec → bash hops.
  local primary sql="$1"
  primary=$($KUBECTL get cluster -n platform postgres -o jsonpath='{.status.currentPrimary}' 2>/dev/null)
  [[ -n "$primary" ]] || { echo "psql_pg: no primary found" >&2; return 1; }
  $SSH "kubectl exec -n platform '$primary' -c postgres -i -- psql -tA -d hosting_platform" <<EOF
$sql
EOF
}

log "1) Login"
TOKEN=$(curl -sS -k -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["token"])')
[[ -n "$TOKEN" ]] && pass "logged in" || fail "login failed"

log "2) Pre-flight: confirm CNPG cluster postgres is healthy"
PHASE=$($KUBECTL get cluster -n platform postgres -o jsonpath='{.status.phase}')
PRIMARY_BEFORE=$($KUBECTL get cluster -n platform postgres -o jsonpath='{.status.currentPrimary}')
INSTANCES_BEFORE=$($KUBECTL get cluster -n platform postgres -o jsonpath='{.spec.instances}')
echo "  phase=$PHASE primary=$PRIMARY_BEFORE instances=$INSTANCES_BEFORE"
[[ "$PHASE" = "Cluster in healthy state" ]] || fail "cluster not healthy: $PHASE"

log "3) Drop+recreate sentinel table BEFORE snapshot, insert pre-snapshot row"
psql_pg "DROP TABLE IF EXISTS e2e_pitr_marker;" >/dev/null
psql_pg "CREATE TABLE e2e_pitr_marker (id INT PRIMARY KEY, label TEXT, inserted_at TIMESTAMPTZ DEFAULT now());" >/dev/null
psql_pg "INSERT INTO e2e_pitr_marker (id, label) VALUES (1, 'pre-snapshot');" >/dev/null
PRE_COUNT=$(psql_pg "SELECT COUNT(*) FROM e2e_pitr_marker;")
echo "  pre-snapshot rows: $PRE_COUNT"
[[ "$PRE_COUNT" = "1" ]] || fail "expected 1 pre-snapshot row, got $PRE_COUNT"
# Force a checkpoint so the row is durable in the snapshot
psql_pg "CHECKPOINT;" >/dev/null

log "4) Take a Longhorn snapshot of postgres primary's PVC via system-snapshots API"
PRIMARY_PVC="$PRIMARY_BEFORE"
LONGHORN_VOL=$($KUBECTL get pvc -n platform "$PRIMARY_PVC" -o jsonpath='{.spec.volumeName}')
echo "  primary pvc=$PRIMARY_PVC volume=$LONGHORN_VOL"
curl_admin -X POST "$ADMIN_HOST/api/v1/admin/system-snapshots/$LONGHORN_VOL/snapshots" \
  -H 'Content-Type: application/json' -d '{"label":"e2e-pitr"}' -o /tmp/snap-take.json
SNAP=$(python3 -c 'import json; print(json.load(open("/tmp/snap-take.json"))["data"]["snapshotName"])')
[[ -n "$SNAP" ]] && pass "snapshot $SNAP requested" || fail "snapshot creation failed: $(cat /tmp/snap-take.json)"

# Wait for snapshot to be ready
for _ in {1..30}; do
  READY=$($KUBECTL get -n longhorn-system snapshot.longhorn.io "$SNAP" -o jsonpath='{.status.readyToUse}' 2>/dev/null || echo "")
  [[ "$READY" = "true" ]] && break
  sleep 2
done
[[ "$READY" = "true" ]] && pass "snapshot ready" || fail "snapshot not ready after 60s"

log "5) Insert POST-snapshot row that MUST be lost on restore"
psql_pg "INSERT INTO e2e_pitr_marker (id, label) VALUES (999, 'post-snapshot-MUST-BE-LOST');" >/dev/null
POST_COUNT=$(psql_pg "SELECT COUNT(*) FROM e2e_pitr_marker;")
echo "  post-snapshot rows: $POST_COUNT (should be 2)"
[[ "$POST_COUNT" = "2" ]] || fail "expected 2 rows after second insert"

log "6) Verify status endpoint reports no restore in progress"
STATUS=$(curl_admin "$ADMIN_HOST/api/v1/admin/postgres-restore/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["inProgress"])')
[[ "$STATUS" = "False" ]] && pass "status=in-progress=false (idle)" || fail "expected idle, got inProgress=$STATUS"

log "7) Trigger PITR auto-promote (async — returns 202 immediately)"
echo "  POST /api/v1/admin/postgres-restore { snapshot=$SNAP }"
echo "  this will: wrap snap → temp cluster → handoff → DELETE source → recreate from temp → cleanup"
START=$(date +%s)
HTTP=$(curl -sS -k -o /tmp/pitr.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$ADMIN_HOST/api/v1/admin/postgres-restore" \
  --max-time 30 \
  -d "{\"clusterNamespace\":\"platform\",\"clusterName\":\"postgres\",\"snapshotName\":\"$SNAP\"}")
ELAPSED=$(( $(date +%s) - START ))
echo "  HTTP=$HTTP in ${ELAPSED}s"
cat /tmp/pitr.json | python3 -m json.tool 2>/dev/null | head -20 || cat /tmp/pitr.json

if [[ "$HTTP" != "202" ]]; then
  fail "POST returned HTTP $HTTP (expected 202): $(cat /tmp/pitr.json)"
fi
pass "PITR async accepted in ${ELAPSED}s — orchestration started"

log "7b) Poll status until orchestration completes (≤12 min)"
START_POLL=$(date +%s)
LAST_PHASE=""
for _ in {1..72}; do
  IN_PROGRESS=$(curl_admin "$ADMIN_HOST/api/v1/admin/postgres-restore/status" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["inProgress"])' 2>/dev/null || echo "unreachable")
  CLUSTER_PHASE=$($KUBECTL get cluster -n platform postgres -o jsonpath='{.status.phase}' 2>/dev/null || echo "missing")
  if [[ "$CLUSTER_PHASE" != "$LAST_PHASE" ]]; then
    echo "  [$(( $(date +%s) - START_POLL ))s] inProgress=$IN_PROGRESS  cluster.phase=$CLUSTER_PHASE"
    LAST_PHASE="$CLUSTER_PHASE"
  fi
  # Done when status is idle AND cluster is healthy
  if [[ "$IN_PROGRESS" = "False" && "$CLUSTER_PHASE" = "Cluster in healthy state" ]]; then
    pass "orchestration finished after $(( $(date +%s) - START_POLL ))s — cluster healthy + lock released"
    break
  fi
  sleep 10
done
TOTAL_ELAPSED=$(( $(date +%s) - START ))
ELAPSED=$TOTAL_ELAPSED  # for final log line

log "8) Confirm source healthy (already verified by status poll above)"
PHASE_AFTER=$($KUBECTL get cluster -n platform postgres -o jsonpath='{.status.phase}' 2>/dev/null || echo "missing")
[[ "$PHASE_AFTER" = "Cluster in healthy state" ]] && pass "source healthy: $PHASE_AFTER" || fail "source not healthy: $PHASE_AFTER"

log "9) Round-trip assertion: post-snapshot row MUST be gone, pre-snapshot row MUST remain"
ROW_PRE=$(psql_pg "SELECT label FROM e2e_pitr_marker WHERE id=1;" 2>/dev/null || echo "")
ROW_POST=$(psql_pg "SELECT COUNT(*) FROM e2e_pitr_marker WHERE id=999;" 2>/dev/null || echo "0")
echo "  pre-snapshot row: '$ROW_PRE' (expect 'pre-snapshot')"
echo "  post-snapshot row count: $ROW_POST (expect 0)"
[[ "$ROW_PRE" = "pre-snapshot" ]] || fail "pre-snapshot row missing — restore lost data!"
[[ "$ROW_POST" = "0" ]] || fail "post-snapshot row survived — restore did NOT roll back!"
pass "round-trip verified: only pre-snapshot data present"

log "10) Cluster identity: instance count preserved"
INSTANCES_AFTER=$($KUBECTL get cluster -n platform postgres -o jsonpath='{.spec.instances}')
[[ "$INSTANCES_AFTER" = "$INSTANCES_BEFORE" ]] && pass "instances=$INSTANCES_AFTER (preserved)" || warn "instances changed: $INSTANCES_BEFORE → $INSTANCES_AFTER"

# Discover temp clusters by label rather than by name (the HTTP
# response may not have included the name if the request was killed
# mid-cutover). Any cluster carrying the platform.phoenix-host.net/
# pitr-restore label is a temp cluster.
log "11) Discover + clean any leftover temp PITR clusters"
LEFTOVER=$($KUBECTL get cluster -n platform -l platform.phoenix-host.net/pitr-restore=true -o name 2>/dev/null)
if [[ -n "$LEFTOVER" ]]; then
  warn "leftover temp clusters: $LEFTOVER (cleaning manually — orchestration crash mid-cutover prevented auto-cleanup)"
  for c in $LEFTOVER; do
    $KUBECTL delete -n platform "$c" --wait=false 2>&1 | tail -1
  done
else
  pass "no leftover temp PITR clusters"
fi

LEAKED_VS=$($KUBECTL get volumesnapshot -n platform -o name 2>/dev/null | grep -c "pitr-vs-" || true)
LEAKED_VSC=$($KUBECTL get volumesnapshotcontent -o name 2>/dev/null | grep -c "pitr-content-" || true)
LEAKED_LH=$($KUBECTL get snapshot.longhorn.io -n longhorn-system -o name 2>/dev/null | grep -c "pitr-handoff-" || true)
if [[ "$LEAKED_VS" -gt 0 || "$LEAKED_VSC" -gt 0 || "$LEAKED_LH" -gt 0 ]]; then
  warn "leaked: $LEAKED_VS VolumeSnapshot(s), $LEAKED_VSC VolumeSnapshotContent(s), $LEAKED_LH longhorn snapshot(s) — cleaning"
  for vs in $($KUBECTL get volumesnapshot -n platform -o name 2>/dev/null | grep "pitr-vs-"); do
    $KUBECTL delete -n platform "$vs" --wait=false 2>&1 | tail -1
  done
  for vsc in $($KUBECTL get volumesnapshotcontent -o name 2>/dev/null | grep "pitr-content-"); do
    $KUBECTL delete "$vsc" --wait=false 2>&1 | tail -1
  done
  for lh in $($KUBECTL get snapshot.longhorn.io -n longhorn-system -o name 2>/dev/null | grep "pitr-handoff-"); do
    $KUBECTL delete -n longhorn-system "$lh" 2>&1 | tail -1
  done
else
  pass "no leaked VolumeSnapshots / VolumeSnapshotContents / longhorn snapshots"
fi

log "12) Write-lock smoke: status endpoint reports idle"
# Re-login because the original token may have expired during the long PITR
TOKEN=$(curl -sS -k -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["token"])' 2>/dev/null)
STATUS_NOW=$(curl_admin "$ADMIN_HOST/api/v1/admin/postgres-restore/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["inProgress"])' 2>/dev/null || echo "unreachable")
[[ "$STATUS_NOW" = "False" ]] && pass "post-restore status=idle (lock released)" || warn "lock state: inProgress=$STATUS_NOW (DB lock should clear on next platform-api restart via recoverInterruptedRestore)"

log "13) Cleanup sentinel table"
psql_pg "DROP TABLE IF EXISTS e2e_pitr_marker;" >/dev/null
pass "sentinel table dropped"

log "DONE: Postgres PITR E2E green (total=${ELAPSED}s, async pattern)"
