#!/usr/bin/env bash
# E2E for System Backup Phase 2: pg_dump round-trip on staging.
#
# WHAT THIS HARNESS PROVES (end-to-end):
#   1. POST /system-backup/pg-dump returns 202 + runId + jobName.
#   2. The Job pod runs pg_dump → BackupStore upload (S3 or SSH).
#   3. /pg-dump/runs/:id polls through pending/running → succeeded
#      with sha256 + size_bytes + bundleId + artifactName populated.
#   4. The run has source identity (namespace, cluster, database)
#      and a target_config_id matching an active backup_configurations
#      row.
#   5. Smoke: /pg-dump/runs filtered by cluster returns the new run.
#
# Per project rule: every assertion ends with curl on the user-facing
# endpoint, not a controller-state poll.
#
# USAGE:
#   ADMIN_PASSWORD=<…> TARGET_CONFIG_ID=<uuid> \
#     ./scripts/integration-system-backup-pg-dump.sh

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
TARGET_CONFIG_ID="${TARGET_CONFIG_ID:-}"
SOURCE_NS="${SOURCE_NS:-platform}"
SOURCE_CLUSTER="${SOURCE_CLUSTER:-postgres}"
SOURCE_DB="${SOURCE_DB:-hosting_platform}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD required" >&2; exit 2; }
[[ -n "$TARGET_CONFIG_ID" ]] || { echo "ERROR: TARGET_CONFIG_ID (uuid of active backup_configurations row) required" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
pass() { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; exit 1; }

curl_admin() { curl -sS -k -H "Authorization: Bearer $TOKEN" "$@"; }

log "1) Login"
TOKEN=$(curl -sS -k -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])')
[[ -n "$TOKEN" ]] && pass "logged in" || fail "login failed"

log "2) Verify target config exists + is active"
LIST=$(curl_admin "$ADMIN_HOST/api/v1/admin/backup-configs")
ACTIVE=$(echo "$LIST" | TARGET_CONFIG_ID="$TARGET_CONFIG_ID" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
rows = d.get("data") or d
target = os.environ["TARGET_CONFIG_ID"]
for r in (rows if isinstance(rows, list) else []):
    if r.get("id") == target:
        print(bool(r.get("active")))
        sys.exit(0)
print("not_found")
')
[[ "$ACTIVE" = "True" ]] && pass "target $TARGET_CONFIG_ID is active" || fail "target $TARGET_CONFIG_ID active=$ACTIVE"

log "3) Trigger pg_dump"
RESP=$(curl_admin -X POST "$ADMIN_HOST/api/v1/system-backup/pg-dump" \
  -H 'Content-Type: application/json' \
  -d "{\"sourceNamespace\":\"$SOURCE_NS\",\"sourceCluster\":\"$SOURCE_CLUSTER\",\"sourceDatabase\":\"$SOURCE_DB\",\"targetConfigId\":\"$TARGET_CONFIG_ID\",\"reason\":\"integration-system-backup-pg-dump harness\"}")
RUN_ID=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["runId"])' 2>/dev/null || echo "")
JOB_NAME=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["jobName"])' 2>/dev/null || echo "")
[[ -n "$RUN_ID" ]] || fail "no runId in response: $RESP"
pass "runId=$RUN_ID jobName=$JOB_NAME"

log "4) Poll /pg-dump/runs/:id until terminal (≤90 min)"
START=$(date +%s); STATUS="?"
# Poll loop: 540 × 10s = 90 min cap. The for var is intentionally
# unreferenced — we just need bounded iteration.
# shellcheck disable=SC2034
for poll_iter in $(seq 1 540); do
  STATUS=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/pg-dump/runs/$RUN_ID" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])' 2>/dev/null || echo "?")
  if [[ "$STATUS" =~ ^(succeeded|failed)$ ]]; then break; fi
  sleep 10
done
ELAPSED=$(( $(date +%s) - START ))
[[ "$STATUS" = "succeeded" ]] && pass "pg_dump succeeded in ${ELAPSED}s" || fail "status=$STATUS after ${ELAPSED}s"

log "5) Run carries sha256 + size + bundle handle"
DETAIL=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/pg-dump/runs/$RUN_ID")
# Pass DETAIL via env (DETAIL_JSON) so the heredoc-fed Python script
# can read it without conflicting with stdin redirection (SC2259).
if DETAIL_JSON="$DETAIL" SOURCE_CLUSTER="$SOURCE_CLUSTER" SOURCE_DB="$SOURCE_DB" TARGET_CONFIG_ID="$TARGET_CONFIG_ID" python3 - <<'PY'
import json, os, sys
d = json.loads(os.environ['DETAIL_JSON'])['data']
checks = [
    ('sha256',         bool(d.get('sha256')) and len(d.get('sha256') or '')==64),
    ('sizeBytes',      isinstance(d.get('sizeBytes'), int) and d['sizeBytes'] > 0),
    ('bundleId',       isinstance(d.get('bundleId'), str) and len(d['bundleId']) > 0),
    ('artifactName',   isinstance(d.get('artifactName'), str) and d['artifactName'].endswith('.pgdump')),
    ('sourceCluster',  d.get('sourceCluster') == os.environ['SOURCE_CLUSTER']),
    ('sourceDatabase', d.get('sourceDatabase') == os.environ['SOURCE_DB']),
    ('targetConfigId', d.get('targetConfigId') == os.environ['TARGET_CONFIG_ID']),
]
for k, v in checks:
    print(f"  {'OK' if v else 'XX'} {k}: {d.get(k)}")
sys.exit(0 if all(v for _, v in checks) else 1)
PY
then
  pass "all run-row fields populated correctly"
else
  fail "row missing fields"
fi

log "6) /pg-dump/runs?cluster=$SOURCE_CLUSTER includes the new run"
LIST=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/pg-dump/runs?namespace=$SOURCE_NS&cluster=$SOURCE_CLUSTER&limit=10")
FOUND=$(echo "$LIST" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; ids=[r['id'] for r in d]; print('$RUN_ID' in ids)")
[[ "$FOUND" = "True" ]] && pass "run id in filtered list" || fail "run not found in /runs?cluster=$SOURCE_CLUSTER"

log "DONE: pg_dump E2E green (total=${ELAPSED}s)"
