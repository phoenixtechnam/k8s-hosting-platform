#!/usr/bin/env bash
# integration-cleanup.sh — nuke leftover test resources via the OFFICIAL
# tenant-lifecycle API (NOT raw kubectl).
#
# Why this exists:
#   The `tenant-reaper-test-*`, `tenant-bundle-test-*`, `tenant-ingress-
#   test-*` etc. namespaces accumulate when an integration scenario
#   fails partway and the explicit DELETE never runs. Each leaves a
#   PVC + Longhorn replicas committed against the system-node storage
#   budget. Three orphan namespaces accumulated to ~150 GiB of
#   storageScheduled on staging (observed 2026-05-04), enough to
#   block postgres-2 from creating its replica with "insufficient
#   storage" precheck failures.
#
# Why use the lifecycle API + not raw kubectl:
#   The platform's tenant-lifecycle hook chain handles ordered cleanup
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

log "discovering test clients via /api/v1/tenants?limit=100"
# Match by name pattern. The integration scenarios all use
# names like "Reaper Test 1777905086" / "Bundle Test …" / "Ingress
# Test …" / "Mail Test …". Real customers don't follow that pattern.
curl -sS -k -H "Authorization: Bearer $TOKEN" \
  "$ADMIN_HOST/api/v1/admin/tenants?limit=100" \
  > /tmp/cleanup-clients.json

TEST_CIDS=$(python3 <<'EOF'
import json, re
d = json.load(open('/tmp/cleanup-clients.json'))
items = d.get('data', []) or []
patt = re.compile(r'^(Reaper|Bundle|Ingress|Mail|Drain|Tier|Grow|Lifecycle|Pvc|Provision)\s+Test\s+\d+', re.I)
hits = [c for c in items if patt.match(c.get('name', '') or '')]
for c in hits:
    print(f"{c['id']}\t{c['name']}")
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
  warn "DRY_RUN=1 — would DELETE these clients via /api/v1/tenants/:id"
  exit 0
fi

read -r -p "Delete these $COUNT test client(s) via the lifecycle DELETE API? [y/N] " confirm
case "$confirm" in
  [yY]|[yY][eE][sS]) ;;
  *) warn "aborted by operator"; exit 0 ;;
esac

log "deleting via official tenant-lifecycle DELETE — runs the full hook cascade"
DELETED=0
FAILED=0
while IFS=$'\t' read -r cid name; do
  [[ -n "$cid" ]] || continue
  HTTP=$(curl -sS -k -o /tmp/cleanup-resp.json -w '%{http_code}' \
    -X DELETE "$ADMIN_HOST/api/v1/admin/tenants/$cid" \
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

# ─── Global-state sanity sweep ───────────────────────────────────────
# Suites that mutate global toggles (OIDC proxy gate, Flux suspend
# during PITR, oauth2-proxy provider config) must restore them in
# their EXIT trap. If a trap fires too late or never fires, the next
# suite locks operators out. Catch it here and reset.
log "global-state sanity sweep"

SETTINGS=$(curl -sS -k -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/admin/oidc/settings" 2>/dev/null || echo '{}')
PROTECT_ADMIN=$(echo "$SETTINGS" | python3 -c "import json,sys;
try: print(json.load(sys.stdin).get('data',{}).get('protectAdminViaProxy', False))
except: print('?')" 2>/dev/null)
PROTECT_TENANT=$(echo "$SETTINGS" | python3 -c "import json,sys;
try: print(json.load(sys.stdin).get('data',{}).get('protectTenantViaProxy', False))
except: print('?')" 2>/dev/null)
PROVIDERS=$(curl -sS -k -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/admin/oidc/providers" 2>/dev/null \
  | python3 -c "import json,sys;
try:
  d=json.load(sys.stdin).get('data',[]) or []
  print(len([p for p in d if p.get('enabled')]))
except: print(0)" 2>/dev/null)

if [[ "$PROTECT_ADMIN" == "True" && "${PROVIDERS:-0}" -eq 0 ]]; then
  warn "OIDC proxy ON for admin but ZERO enabled providers → admin panel locked out; clearing"
  curl -sS -k -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"protect_admin_via_proxy":false,"protect_tenant_via_proxy":false,"disable_local_auth_admin":false,"disable_local_auth_tenant":false}' \
    "$ADMIN_HOST/api/v1/admin/oidc/settings" >/dev/null 2>&1 || true
  ok "reset admin proxy gate"
elif [[ "$PROTECT_TENANT" == "True" && "${PROVIDERS:-0}" -eq 0 ]]; then
  warn "OIDC proxy ON for tenant but ZERO enabled providers → tenant panel locked out; clearing"
  curl -sS -k -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"protect_admin_via_proxy":false,"protect_tenant_via_proxy":false,"disable_local_auth_admin":false,"disable_local_auth_tenant":false}' \
    "$ADMIN_HOST/api/v1/admin/oidc/settings" >/dev/null 2>&1 || true
  ok "reset tenant proxy gate"
else
  ok "OIDC proxy gates consistent: admin=${PROTECT_ADMIN} tenant=${PROTECT_TENANT} enabled-providers=${PROVIDERS}"
fi

PANEL=$(curl -sk -m 10 -o /dev/null -w '%{http_code}' "${ADMIN_HOST}/" 2>/dev/null || echo "000")
if [[ "$PANEL" == "200" ]]; then
  ok "admin panel reachable (200)"
else
  warn "admin panel returned ${PANEL} after cleanup — manual intervention may be needed"
fi

[[ "$FAILED" -eq 0 ]]
