#!/usr/bin/env bash
# ci-no-leaked-test-tenants.sh — CI guard that fails when test-tenant
# namespaces survived the integration suite's per-script trap-cleanups
# AND the post-run integration-cleanup.sh pass.
#
# Why this exists:
#   integration-all.sh already runs integration-cleanup.sh after the
#   suite to mop up tenants that escaped per-script EXIT traps. But
#   integration-cleanup.sh calls the lifecycle API — when system-db is
#   down (e.g. because the leaked tenants exhausted Longhorn's storage
#   budget — observed 2026-05-17 on testing.phoenix-host.net), the
#   cleanup API call ALSO fails and 16 Released PVs accumulate. This
#   script is the second-line backstop: it directly inspects the
#   cluster (no API), surfaces the leak count + sizes, and fails CI so
#   the operator has to fix the test that didn't clean up before merging.
#
#   It is intentionally NOT remediation — it ONLY reports. Cleanup is
#   the responsibility of either (a) the offending integration script
#   (fix its trap), (b) integration-cleanup.sh (extend its pattern
#   matching), or (c) the operator running the suite manually.
#
# USAGE
#   SSH_HOST=root@<ip> SSH_KEY=<path> ./scripts/ci-no-leaked-test-tenants.sh
#   # or, when run on a node directly:
#   LOCAL_KUBECTL=1 ./scripts/ci-no-leaked-test-tenants.sh
#
# EXIT CODES
#   0 — clean: no leaked test-tenant namespaces, no Released test-pattern PVs
#   1 — leak detected; output names + counts; CI fails the run
#   2 — couldn't run (no kubectl access, no SSH key); CI WARN
#
# OPT-OUT
#   CI_LEAK_GUARD=0 disables the assertion (still prints the report)
#   so an operator can land an emergency patch without first chasing
#   a leak from an unrelated suite.

set -uo pipefail

SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@89.167.3.56}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o ConnectTimeout=10 -q}"
LOCAL_KUBECTL="${LOCAL_KUBECTL:-0}"
CI_LEAK_GUARD="${CI_LEAK_GUARD:-1}"

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
ok()   { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; }

# The namespace patterns produced by every integration-*.sh script that
# creates tenants. Must stay in sync with
# backend/src/modules/k8s-provisioner/service.ts:TENANT_TEST_NAMESPACE_PATTERN
# — a Bats-style regression test for that file lives next door.
TEST_NAMESPACE_REGEX='^tenant-(integration-test|lifecycle-e2e|passkey-e2e|pvc-test|reaper-test|bundle-test|ingress-test|drain-test|tier-test|grow-test|mail-test|provision-test|mtls-test|firewall-test)-'

# kubectl wrapper that runs locally when LOCAL_KUBECTL=1, else over SSH.
kc() {
  if [[ "$LOCAL_KUBECTL" == "1" ]]; then
    kubectl "$@"
  else
    ssh -i "$SSH_KEY" $SSH_OPTS "$SSH_HOST" "kubectl $*"
  fi
}

log "Integration-test tenant leak guard"

# Confirm we can reach the cluster at all. SSH failure / no creds → exit
# 2 (CI WARN, not FAIL) so a broken bastion doesn't block legitimate PRs.
if ! kc version --client >/dev/null 2>&1; then
  warn "kubectl unreachable (LOCAL_KUBECTL=$LOCAL_KUBECTL, SSH_HOST=$SSH_HOST) — skipping leak guard"
  exit 2
fi

# ── Check 1: leftover tenant namespaces matching test patterns ─────
leftover_ns=$(kc get ns -o jsonpath='{.items[*].metadata.name}' 2>/dev/null \
  | tr ' ' '\n' \
  | grep -E "$TEST_NAMESPACE_REGEX" || true)

ns_count=0
[[ -n "$leftover_ns" ]] && ns_count=$(echo "$leftover_ns" | grep -c .)

# ── Check 2: Released PVs in those test-pattern namespaces ─────────
# (When reclaimPolicy=Retain leaked a PV before the longhorn-tenant-test
# SC fix landed; or when a tenant deletion succeeded but the PV finalizer
# stuck for some reason.)
leftover_pv=$(kc get pv -o json 2>/dev/null \
  | python3 -c "
import json, sys, re
patt = re.compile(r'$TEST_NAMESPACE_REGEX', re.I)
d = json.load(sys.stdin)
for pv in d.get('items', []):
    if pv.get('status', {}).get('phase') != 'Released': continue
    ns = (pv.get('spec', {}).get('claimRef', {}) or {}).get('namespace', '')
    if patt.match(ns):
        print(f\"  {pv['metadata']['name']}\\tns={ns}\\tcapacity={pv['spec']['capacity']['storage']}\")
" 2>/dev/null || true)

pv_count=0
[[ -n "$leftover_pv" ]] && pv_count=$(echo "$leftover_pv" | grep -c .)

# ── Report ─────────────────────────────────────────────────────────
if [[ $ns_count -eq 0 && $pv_count -eq 0 ]]; then
  ok "no leaked test-tenant namespaces or Released test-PVs"
  exit 0
fi

fail "LEAK DETECTED — integration suite left orphan resources behind"
echo
if [[ $ns_count -gt 0 ]]; then
  printf '  %d leftover namespace(s):\n' "$ns_count"
  echo "$leftover_ns" | sed 's/^/    - /'
  echo
fi
if [[ $pv_count -gt 0 ]]; then
  printf '  %d Released PV(s) in test namespaces:\n' "$pv_count"
  echo "$leftover_pv" | sed 's/^/  /'
  echo
fi

echo "Fix path:"
echo "  1. Identify which integration-*.sh script owns the leftover tenants by"
echo "     matching the namespace prefix against the script name (e.g."
echo "     tenant-passkey-e2e-* → integration-passkey-e2e.sh)."
echo "  2. Verify that script has a 'trap cleanup EXIT' that runs the"
echo "     lifecycle DELETE for every tenant it creates."
echo "  3. Run 'ADMIN_PASSWORD=... ./scripts/integration-cleanup.sh' manually"
echo "     to drop the leftovers from the test cluster, then re-run CI."
echo
echo "Override (use sparingly): CI_LEAK_GUARD=0 ./scripts/ci-no-leaked-test-tenants.sh"

if [[ "$CI_LEAK_GUARD" == "0" ]]; then
  warn "CI_LEAK_GUARD=0 set — failing soft (exit 0)"
  exit 0
fi
exit 1
