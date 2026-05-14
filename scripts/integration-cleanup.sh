#!/usr/bin/env bash
# integration-cleanup.sh — nuke leftover test resources via the OFFICIAL
# client-lifecycle API (NOT raw kubectl).
#
# Why this exists:
#   The `client-reaper-test-*`, `client-bundle-test-*`, `client-ingress-
#   test-*` etc. namespaces accumulate when an integration scenario
#   fails partway and the explicit DELETE never runs. Each leaves a
#   PVC + Longhorn replicas committed against the system-node storage
#   budget. Three orphan namespaces accumulated to ~150 GiB of
#   storageScheduled on staging (observed 2026-05-04), enough to
#   block postgres-2 from creating its replica with "insufficient
#   storage" precheck failures.
#
# Why use the lifecycle API + not raw kubectl:
#   The platform's client-lifecycle hook chain handles ordered cleanup
#   (DNS records → backup bundles → secrets → namespace → PV reclaim →
#   Longhorn volume delete). Raw `kubectl delete ns` skips the hook
#   chain and leaves orphan PVs / Longhorn volumes that the reconciler
#   has to mop up later (and may fail to). The lifecycle DELETE is
#   what production operators use, so the test cleanup must too.
#
# Usage:
#   ADMIN_PASSWORD=… ./scripts/integration-cleanup.sh
#   # or for non-interactive (CI):
#   ADMIN_PASSWORD=… DRY_RUN=1 ./scripts/integration-cleanup.sh

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
DRY_RUN="${DRY_RUN:-0}"
[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
ok()   { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; exit 1; }

log "logging in"
TOKEN=$(curl -sS -k -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["token"])')
[[ -n "$TOKEN" ]] || fail "login failed"
ok "logged in"

log "discovering test clients via /api/v1/clients?limit=100"
# Match by company_name pattern. The integration scenarios all use
# names like "Reaper Test 1777905086" / "Bundle Test …" / "Ingress
# Test …" / "Mail Test …". Real customers don't follow that pattern.
curl -sS -k -H "Authorization: Bearer $TOKEN" \
  "$ADMIN_HOST/api/v1/admin/clients?limit=100" \
  > /tmp/cleanup-clients.json

TEST_CIDS=$(python3 <<'EOF'
import json, re
d = json.load(open('/tmp/cleanup-clients.json'))
items = d.get('data', []) or []
patt = re.compile(r'^(Reaper|Bundle|Ingress|Mail|Drain|Tier|Grow|Lifecycle|Pvc|Provision)\s+Test\s+\d+', re.I)
hits = [c for c in items if patt.match(c.get('company_name', '') or '')]
for c in hits:
    print(f"{c['id']}\t{c['company_name']}")
EOF
)

COUNT=$(echo "$TEST_CIDS" | grep -c $'\t' || true)
if [[ "$COUNT" -eq 0 ]]; then
  ok "no test clients matched the integration-cleanup naming pattern"
  exit 0
fi

log "found $COUNT test client(s) matching integration patterns:"
echo "$TEST_CIDS" | sed 's/^/  /'

if [[ "$DRY_RUN" = "1" ]]; then
  warn "DRY_RUN=1 — would DELETE these clients via /api/v1/clients/:id"
  exit 0
fi

read -r -p "Delete these $COUNT test client(s) via the lifecycle DELETE API? [y/N] " confirm
case "$confirm" in
  [yY]|[yY][eE][sS]) ;;
  *) warn "aborted by operator"; exit 0 ;;
esac

log "deleting via official client-lifecycle DELETE — runs the full hook cascade"
DELETED=0
FAILED=0
while IFS=$'\t' read -r cid name; do
  [[ -n "$cid" ]] || continue
  HTTP=$(curl -sS -k -o /tmp/cleanup-resp.json -w '%{http_code}' \
    -X DELETE "$ADMIN_HOST/api/v1/admin/clients/$cid" \
    -H "Authorization: Bearer $TOKEN")
  if [[ "$HTTP" =~ ^2 ]]; then
    ok "deleted $cid ($name)"
    DELETED=$((DELETED+1))
  else
    warn "DELETE $cid → HTTP=$HTTP body=$(head -c 200 /tmp/cleanup-resp.json)"
    FAILED=$((FAILED+1))
  fi
done <<< "$TEST_CIDS"

log "result: $DELETED deleted, $FAILED failed (cascade may still be in progress; re-run if needed)"
[[ "$FAILED" -eq 0 ]]
