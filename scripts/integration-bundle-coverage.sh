#!/usr/bin/env bash
# integration-bundle-coverage.sh — assert that every CONFIG_DUMP_TABLE
# with rows for the test client is actually captured in the bundle's
# config component, AND that the files + secrets dimensions land too.
#
# This is the safety net for the BundleComponent registry refactor
# (Phase B): if a new dimension is added without wiring into a
# component, this script's assertions fail loudly.
#
# Why a separate scenario: the existing integration-staging.sh
# `restore` scenario verifies the capture+restore Job-level path on
# one specific component. This one walks the whole capture matrix.
#
# Required env (same as integration-staging.sh):
#   ADMIN_PASSWORD            admin@phoenix-host.net password
#
# Optional env:
#   ADMIN_HOST                https://admin.staging.phoenix-host.net
#   TENANT_BASE               staging.success.com.na
#   STAGING_SSH_HOST          first IP from ~/k8s-staging/servers.txt
#   SSH_KEY                   ~/hosting-platform.key
#
# Exit codes:
#   0  every CONFIG_DUMP_TABLE with rows is in the bundle
#   1  one or more assertions failed
#   2  prereq missing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
TENANT_BASE="${TENANT_BASE:-staging.success.com.na}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

# Resolve a control host for kubectl. Prefer running on staging1
# directly so kubectl is local — see integration-staging.sh ssh_cp
# for the same convention.
CONTROL_HOST="${STAGING_SSH_HOST:-46.224.122.58}"
CONTROL_HOST="${CONTROL_HOST##*@}"

PASSED=0
FAILED=0
FAILURES=()

ok()   { echo -e "  \033[32m✓\033[0m $*"; PASSED=$((PASSED+1)); }
fail() { echo -e "  \033[31m✗\033[0m $*"; FAILURES+=("$*"); FAILED=$((FAILED+1)); }
log()  { echo -e "\033[36m[$(date +%H:%M:%S)]\033[0m $*"; }

ssh_cp() {
  if [[ ! -r "$SSH_KEY" ]] && command -v kubectl >/dev/null 2>&1; then
    bash -c "$*"
    return
  fi
  ssh -i "$SSH_KEY" $SSH_OPTS "root@$CONTROL_HOST" "$@"
}

# ─── Login ─────────────────────────────────────────────────────────

log "logging in as $ADMIN_EMAIL"
TOKEN=$(curl -sS -k -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  "$ADMIN_HOST/api/v1/auth/login" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("token",""))' 2>/dev/null)
if [[ -z "$TOKEN" ]]; then
  fail "auth: login failed"
  exit 2
fi

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -k -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
         -d "$body" "$ADMIN_HOST/api/v1$path"
  else
    curl -sS -k -X "$method" -H "Authorization: Bearer $TOKEN" \
         "$ADMIN_HOST/api/v1$path"
  fi
}

# ─── Resolve a target ────────────────────────────────────────────

target_id=$(api GET "/admin/backup-configs" \
  | python3 -c 'import json,sys
d = json.load(sys.stdin).get("data", [])
active = next((c for c in d if c.get("active")), None)
print(active.get("id","") if active else "")' 2>/dev/null)
if [[ -z "$target_id" ]]; then
  fail "target: no active backup config — run /tenant-backup → Off-site Targets first"
  exit 2
fi
ok "using target $target_id"

# ─── Pick (or create) a tenant with non-trivial state ────────────

stamp=$(date +%s)
# Match the integration-staging.sh convention: prefer the Starter plan
# so we don't create unnecessarily-expensive coverage tenants.
plan_id=$(api GET "/plans" | python3 -c '
import json,sys
d = json.load(sys.stdin).get("data") or []
starter = next((p for p in d if p.get("name") == "Starter"), None)
print((starter or (d[0] if d else {})).get("id",""))' 2>/dev/null)
region_id=$(api GET "/regions" | python3 -c '
import json,sys
d = json.load(sys.stdin).get("data") or []
print(d[0].get("id","") if d else "")' 2>/dev/null)
# Catalog endpoint is /catalog (paginated). Resolve by code=nginx-php.
catalog_id=$(api GET "/catalog?limit=200" | python3 -c '
import json,sys
body = json.load(sys.stdin)
items = body.get("data", body) if isinstance(body, dict) else body
items = items if isinstance(items, list) else items.get("items", [])
nginx = next((x for x in items if (x.get("code") or "") == "nginx-php"), None)
print(nginx.get("id","") if nginx else "")' 2>/dev/null)

[[ -n "$plan_id" ]] || { fail "plans: no plan available"; exit 1; }
[[ -n "$region_id" ]] || { fail "regions: no region available"; exit 1; }
[[ -n "$catalog_id" ]] || { fail "catalog: nginx-php entry not found"; exit 1; }

create_resp=$(api POST "/clients" "{
  \"company_name\": \"coverage-$stamp\",
  \"company_email\": \"coverage-$stamp@phoenix-host.net\",
  \"plan_id\": \"$plan_id\",
  \"region_id\": \"$region_id\",
  \"storage_tier\": \"local\"
}")
cid=$(echo "$create_resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null)
[[ -n "$cid" ]] || { fail "client: create failed: $(echo "$create_resp" | head -c 300)"; exit 1; }
ok "client created cid=$cid"

# Wait for provision.
for _ in $(seq 1 30); do
  status=$(api GET "/clients/$cid" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin).get("data",{}); print(d.get("provisioningStatus",""))' 2>/dev/null)
  [[ "$status" == "provisioned" || "$status" == "ready" || "$status" == "active" ]] && break
  sleep 4
done

# Add cross-table state — domain, then a deployment that the domain
# can attach to (matches the integration-staging.sh restore scenario
# convention of creating a bare domain first, then bundling).
hostname="cov-${stamp}.${TENANT_BASE}"
dom_resp=$(api POST "/clients/$cid/domains" "{\"domain_name\":\"$hostname\"}")
domain_id=$(echo "$dom_resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null)
[[ -n "$domain_id" ]] || { fail "domain: create failed: $(echo "$dom_resp" | head -c 300)"; api DELETE "/clients/$cid" >/dev/null 2>&1; exit 1; }
ok "domain created hostname=$hostname"

# ─── Capture full bundle ────────────────────────────────────────

log "capturing bundle (all components)…"
body="{\"clientId\":\"$cid\",\"initiator\":\"admin\",\"label\":\"coverage-$stamp\",\"retentionDays\":1,\"targetConfigId\":\"$target_id\",\"components\":{\"files\":true,\"mailboxes\":false,\"config\":true,\"secrets\":true}}"
b_resp=$(api POST "/admin/tenant-bundles" "$body")
bundle_id=$(echo "$b_resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("bundleId",""))' 2>/dev/null)
b_status=$(echo "$b_resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("status",""))' 2>/dev/null)

cleanup() {
  [[ -n "$bundle_id" ]] && api DELETE "/admin/tenant-bundles/$bundle_id" >/dev/null 2>&1 || true
  api DELETE "/clients/$cid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ "$b_status" != "completed" && "$b_status" != "partial" ]]; then
  fail "capture: status=$b_status — resp: $(echo "$b_resp" | head -c 400)"
  exit 1
fi
ok "bundle $bundle_id captured (status=$b_status)"

# ─── Verify round-trip integrity ────────────────────────────────

log "verifying round-trip…"
v_resp=$(api POST "/admin/tenant-bundles/$bundle_id/verify" "{}")
# Save the verify response to a temp file so the python heredoc can
# `open()` it. Heredoc consumes stdin, so we can't pipe.
echo "$v_resp" > /tmp/cov-verify.json
python3 - <<'PYEOF' > /tmp/cov-verify.out
import json
with open("/tmp/cov-verify.json") as f:
    d = json.load(f).get("data", {})
comps = d.get("components", {})
gaps = []
for name in ("files", "config", "secrets"):
    c = comps.get(name)
    if not c:
        gaps.append(f"{name}: missing")
        continue
    if name == "files" and not c.get("reachable"):
        gaps.append(f"{name}: not reachable")
    if name == "config" and c.get("parseError"):
        gaps.append(f'config: parseError={c["parseError"]}')
    if name == "secrets" and c.get("decryptError"):
        gaps.append(f'secrets: decryptError={c["decryptError"]}')
if gaps:
    print("GAPS")
    for g in gaps:
        print(" ", g)
else:
    cfg = comps.get("config", {}) or {}
    rc = cfg.get("rowCounts") or {}
    print("CLEAN")
    print(f"  config rows: {sum(rc.values())} across {len(rc)} tables")
    print(f"  secrets count: {(comps.get('secrets', {}) or {}).get('secretCount', 0)}")
    print(f"  files reachable: yes")
PYEOF
if grep -q '^CLEAN' /tmp/cov-verify.out; then
  ok "verify: round-trip clean"
  cat /tmp/cov-verify.out | grep -v '^CLEAN' | sed 's/^/    /'
else
  fail "verify: gaps detected"
  cat /tmp/cov-verify.out | sed 's/^/    /'
fi

# ─── Coverage assertion: every CONFIG_DUMP_TABLE has a SELECT case ─
#
# This static check needs the source tree. When the harness runs on a
# staging server (no checkout), skip — the CI schema-audit already
# enforces it on every PR.

DUMP_FILE="$ROOT/backend/src/modules/tenant-bundles/components/config.ts"
if [[ -f "$DUMP_FILE" ]]; then
  log "asserting CONFIG_DUMP_TABLES contract…"
  declared=$(awk '/^export const CONFIG_DUMP_TABLES = \[/,/^\] as const;/' "$DUMP_FILE" \
    | grep -oE "'[a-zA-Z]+'" | tr -d "'")
  declared_count=$(echo "$declared" | wc -l | tr -d ' ')

  missing_cases=()
  for t in $declared; do
    if ! grep -q "case '$t':" "$DUMP_FILE"; then
      missing_cases+=("$t")
    fi
  done

  if [[ ${#missing_cases[@]} -eq 0 ]]; then
    ok "every declared CONFIG_DUMP_TABLE ($declared_count) has a SELECT case"
  else
    fail "tables declared but with no SELECT case: ${missing_cases[*]}"
  fi
else
  log "skipping static contract check — no source tree at $ROOT (CI schema-audit covers this)"
fi

# ─── Coverage assertion: rowCounts contains every captured table ─

log "asserting verify.rowCounts ⊇ tables-with-rows…"
rc_json=$(echo "$v_resp" | python3 -c '
import json,sys
d = json.load(sys.stdin).get("data", {})
print(json.dumps(d.get("components", {}).get("config", {}).get("rowCounts", {})))')
captured_tables=$(echo "$rc_json" | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin).keys()))' 2>/dev/null | sort -u)

# Tables we deliberately populated above — these MUST be in rowCounts.
expected_with_rows=("clients" "domains")
for t in "${expected_with_rows[@]}"; do
  if echo "$captured_tables" | grep -qx "$t"; then
    ok "rowCounts has $t"
  else
    fail "rowCounts missing $t (we populated it; capture is dropping rows)"
  fi
done

# ─── Result ─────────────────────────────────────────────────────

echo
log "── coverage results ──"
echo "  passed: $PASSED"
echo "  failed: $FAILED"
if [[ $FAILED -gt 0 ]]; then
  echo "  failures:"
  for f in "${FAILURES[@]}"; do echo "    - $f"; done
  exit 1
fi
exit 0
