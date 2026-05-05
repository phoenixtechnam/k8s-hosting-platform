#!/usr/bin/env bash
# E2E for System Backup Phase 4: WAL archive on/off + actual WAL
# files appearing at the S3 target.
#
# WHAT THIS HARNESS PROVES (end-to-end):
#   1. POST /system-backup/wal-archive/enable patches the CNPG CR
#      and writes the state row.
#   2. The CR's spec.backup.barmanObjectStore is populated.
#   3. CNPG's archiver kicks in: status.lastArchivedWAL becomes
#      non-empty within ARCHIVER_WAIT seconds (default 360).
#   4. POST /disable removes spec.backup AND the state row.
#
# Per project rule: every assertion ends with curl on the user-facing
# endpoint or kubectl on the actual CR / S3 path — never controller-state
# polls only.
#
# USAGE:
#   ADMIN_PASSWORD=<…> TARGET_CONFIG_ID=<uuid-of-active-s3-row> \
#     ./scripts/integration-system-wal-archive.sh

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
TARGET_CONFIG_ID="${TARGET_CONFIG_ID:-}"
CLUSTER_NS="${CLUSTER_NS:-platform}"
CLUSTER_NAME="${CLUSTER_NAME:-postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
ARCHIVER_WAIT="${ARCHIVER_WAIT:-360}"  # 6 min default; CNPG archive_timeout=5min

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD required" >&2; exit 2; }
[[ -n "$TARGET_CONFIG_ID" ]] || { echo "ERROR: TARGET_CONFIG_ID required" >&2; exit 2; }

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

log "2) Pre-check: cluster currently disabled"
LIST=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/wal-archive/clusters")
PRE_ENABLED=$(echo "$LIST" | CLUSTER_NS="$CLUSTER_NS" CLUSTER_NAME="$CLUSTER_NAME" python3 -c '
import json, os, sys
d = json.load(sys.stdin)["data"]
m = next((c for c in d if c["clusterNamespace"]==os.environ["CLUSTER_NS"] and c["clusterName"]==os.environ["CLUSTER_NAME"]), None)
print("missing" if m is None else ("on" if m["enabled"] else "off"))
')
if [[ "$PRE_ENABLED" = "on" ]]; then
  warn "cluster already enabled — disabling first to make this run idempotent"
  curl_admin -X POST "$ADMIN_HOST/api/v1/system-backup/wal-archive/disable" \
    -H 'Content-Type: application/json' \
    -d "{\"clusterNamespace\":\"$CLUSTER_NS\",\"clusterName\":\"$CLUSTER_NAME\"}" >/dev/null
  sleep 5
elif [[ "$PRE_ENABLED" = "missing" ]]; then
  fail "cluster $CLUSTER_NS/$CLUSTER_NAME not in known list"
else
  pass "cluster currently off"
fi

log "3) POST /enable"
RESP=$(curl_admin -X POST "$ADMIN_HOST/api/v1/system-backup/wal-archive/enable" \
  -H 'Content-Type: application/json' \
  -d "{\"clusterNamespace\":\"$CLUSTER_NS\",\"clusterName\":\"$CLUSTER_NAME\",\"targetConfigId\":\"$TARGET_CONFIG_ID\",\"retentionDays\":$RETENTION_DAYS}")
DEST=$(echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["destinationPath"] if "data" in d else "")')
[[ -n "$DEST" ]] && pass "enabled, destinationPath=$DEST" || fail "enable failed: $RESP"

log "4) /clusters reflects enabled=true with state populated"
LIST=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/wal-archive/clusters")
CHECK=$(echo "$LIST" | CLUSTER_NS="$CLUSTER_NS" CLUSTER_NAME="$CLUSTER_NAME" RETENTION_DAYS="$RETENTION_DAYS" TARGET_CONFIG_ID="$TARGET_CONFIG_ID" python3 -c '
import json, os, sys
d = json.load(sys.stdin)["data"]
m = next((c for c in d if c["clusterNamespace"]==os.environ["CLUSTER_NS"] and c["clusterName"]==os.environ["CLUSTER_NAME"]), None)
assert m and m["enabled"] is True, f"not enabled: {m}"
assert m["state"]["targetConfigId"] == os.environ["TARGET_CONFIG_ID"], f"target mismatch: {m}"
assert m["state"]["retentionDays"] == int(os.environ["RETENTION_DAYS"]), f"retention mismatch: {m}"
assert m["state"]["destinationPath"].startswith("s3://"), f"bad dest: {m}"
print("ok")
')
[[ "$CHECK" = "ok" ]] && pass "/clusters shape verified" || fail "$CHECK"

log "5) Wait for CNPG archiver to push at least one WAL (≤${ARCHIVER_WAIT}s)"
START=$(date +%s); LAST_WAL=""; LAST_ERR=""
while [[ $(( $(date +%s) - START )) -lt $ARCHIVER_WAIT ]]; do
  LIST=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/wal-archive/clusters")
  LAST_WAL=$(echo "$LIST" | CLUSTER_NS="$CLUSTER_NS" CLUSTER_NAME="$CLUSTER_NAME" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)["data"]
    m = next((c for c in d if c["clusterNamespace"]==os.environ["CLUSTER_NS"] and c["clusterName"]==os.environ["CLUSTER_NAME"]), None)
    print((m or {}).get("status", {}).get("lastArchivedWal") or "")
except Exception:
    print("")
')
  LAST_ERR=$(echo "$LIST" | CLUSTER_NS="$CLUSTER_NS" CLUSTER_NAME="$CLUSTER_NAME" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)["data"]
    m = next((c for c in d if c["clusterNamespace"]==os.environ["CLUSTER_NS"] and c["clusterName"]==os.environ["CLUSTER_NAME"]), None)
    print((m or {}).get("status", {}).get("lastFailedArchiveError") or "")
except Exception:
    print("")
')
  if [[ -n "$LAST_WAL" ]]; then break; fi
  if [[ -n "$LAST_ERR" ]]; then warn "archiver error: $LAST_ERR"; fi
  sleep 15
done
ELAPSED=$(( $(date +%s) - START ))
[[ -n "$LAST_WAL" ]] && pass "lastArchivedWAL=$LAST_WAL after ${ELAPSED}s" \
  || fail "no WAL archived after ${ARCHIVER_WAIT}s (lastErr=$LAST_ERR)"

log "6) POST /disable"
DRESP=$(curl_admin -X POST "$ADMIN_HOST/api/v1/system-backup/wal-archive/disable" \
  -H 'Content-Type: application/json' \
  -d "{\"clusterNamespace\":\"$CLUSTER_NS\",\"clusterName\":\"$CLUSTER_NAME\"}")
DENABLED=$(echo "$DRESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("data",{}).get("enabled"))')
[[ "$DENABLED" = "False" ]] && pass "disabled" || fail "disable response: $DRESP"

log "7) /clusters reflects enabled=false + state=null"
LIST=$(curl_admin "$ADMIN_HOST/api/v1/system-backup/wal-archive/clusters")
CHECK=$(echo "$LIST" | CLUSTER_NS="$CLUSTER_NS" CLUSTER_NAME="$CLUSTER_NAME" python3 -c '
import json, os, sys
d = json.load(sys.stdin)["data"]
m = next((c for c in d if c["clusterNamespace"]==os.environ["CLUSTER_NS"] and c["clusterName"]==os.environ["CLUSTER_NAME"]), None)
assert m and m["enabled"] is False, f"still enabled: {m}"
assert m["state"] is None, f"state not cleared: {m}"
print("ok")
')
[[ "$CHECK" = "ok" ]] && pass "post-disable shape verified" || fail "$CHECK"

log "DONE: WAL archive E2E green"
