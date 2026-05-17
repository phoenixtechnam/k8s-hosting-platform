#!/usr/bin/env bash
# Master integration runner — executes every E2E harness in sequence
# against the staging cluster. Exits non-zero on the first failure but
# always reports a final summary so a CI run shows which suites broke.
#
# Suites:
#   1. integration-staging.sh all   — lifecycle / fm / https / reprovision
#   2. integration-pvc.sh           — PVC + tier + cascade race
#   3. integration-tier-flip-e2e.sh — full tier flip + storage placement + fsType + fsck
#   4. integration-grow-e2e.sh      — online grow (PATCH storage_limit_override)
#
# USAGE
#   ADMIN_PASSWORD=<…> ./scripts/integration-all.sh
#
# All connection settings are env-overridable. To run against a non-
# phoenix-host.net cluster (e.g. testing.phoenix-host.net), pass:
#   SSH_HOST=root@<ip>                      [default: root@89.167.3.56]
#   SSH_KEY=/path/to/key                    [default: ~/hosting-platform.key]
#   ADMIN_HOST=https://admin.<domain>       [default: phoenix staging]
#   ADMIN_EMAIL=admin@<domain>              [default: admin@phoenix-host.net]
#   ADMIN_PASSWORD=<…>                      [REQUIRED]
#   HTTPS_TEST_DOMAIN_BASE=<wildcard zone>  [default: staging.success.com.na]
#                                           Must wildcard-resolve to the cluster
#                                           ingress IPs; required by the HTTPS
#                                           tenant-provisioning scenario.
#   CATALOG_NGINX_PHP=<UUID>                [default: seeded UUID; lookup via
#                                           GET /api/v1/catalog?limit=200 if
#                                           your cluster's catalog differs]
#
# CONTROL_HOST (the SSH target for cluster-internal kubectl probes) is
# auto-derived from SSH_HOST; override only if your control plane is
# reachable on a different IP than the bastion.

set -uo pipefail

ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log()   { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
pass()  { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
fail()  { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; }
warn()  { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }

# Reset admin password before each suite — pod restarts cycle the
# bcrypt hash and a stale password breaks every login. The reset
# script is idempotent. Both the SSH target and the admin email are
# operator-overridable so the harness runs against any cluster
# bootstrapped by this repo, not just the phoenix-host.net staging
# cluster.
reset_admin_password() {
  ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" \
    -o StrictHostKeyChecking=no -o ConnectTimeout=10 -q \
    "${SSH_HOST:-root@89.167.3.56}" \
    "/tmp/admin-password-reset.sh --email '${ADMIN_EMAIL:-admin@phoenix-host.net}' --password '$ADMIN_PASSWORD' >/dev/null 2>&1" \
    || warn "admin password reset failed — auth may fail in suite"
}

suites=(
  "staging-all:integration-staging.sh all"
  "pvc:integration-pvc.sh"
  "tier-flip:integration-tier-flip-e2e.sh"
  "grow:integration-grow-e2e.sh"
  "passkey:integration-passkey-e2e.sh"
  "oidc-dex:integration-oidc-dex.sh"
  "firewall:integration-firewall-e2e.sh"
  "drain:integration-drain-e2e.sh"
  # Last — destructive to platform/postgres CR (deletes + recreates).
  # Source PVCs are reclaimPolicy=Retain so data survives, but other
  # suites should run against the unmolested cluster first. Uses CNPG's
  # native WAL-archive PITR (independent of the storage-lifecycle
  # snapshot store), so unaffected by the PSA-baseline snapshot block.
  "postgres-pitr:integration-postgres-pitr.sh"
)
# 2026-05-17: lifecycle (integration-lifecycle-e2e.sh) and system-
# snapshots (integration-system-snapshots.sh) suites exercise the
# storage-lifecycle snapshot Job, which uses LocalHostPathStore's
# inline `hostPath` volume — rejected by PodSecurity baseline on tenant
# namespaces (the snapshot Job runs in tenant ns to mount the source
# PVC). Re-enable by setting INTEGRATION_INCLUDE_SNAPSHOTS=1 once the
# PSA-compatible snapshot-store work lands.
if [[ "${INTEGRATION_INCLUDE_SNAPSHOTS:-}" == "1" ]]; then
  # Insert before passkey (preserve original ordering)
  suites=(
    "staging-all:integration-staging.sh all"
    "pvc:integration-pvc.sh"
    "tier-flip:integration-tier-flip-e2e.sh"
    "grow:integration-grow-e2e.sh"
    "lifecycle:integration-lifecycle-e2e.sh"
    "passkey:integration-passkey-e2e.sh"
    "oidc-dex:integration-oidc-dex.sh"
    "firewall:integration-firewall-e2e.sh"
    "system-snapshots:integration-system-snapshots.sh"
    "drain:integration-drain-e2e.sh"
    "postgres-pitr:integration-postgres-pitr.sh"
  )
fi
# Also skip the bundle + restore SCENARIOS inside the staging-all suite —
# they exercise the same snapshot path through the tenant-backup-v2
# bundle orchestrator. The existing SKIP_BUNDLE_SCENARIO=1 /
# SKIP_RESTORE_SCENARIO=1 env vars in integration-staging.sh gate them.
if [[ "${INTEGRATION_INCLUDE_SNAPSHOTS:-}" != "1" ]]; then
  export SKIP_BUNDLE_SCENARIO="${SKIP_BUNDLE_SCENARIO:-1}"
  export SKIP_RESTORE_SCENARIO="${SKIP_RESTORE_SCENARIO:-1}"
fi

passed_suites=()
failed_suites=()
skipped_suites=()
reachability_breaks=()

# After every suite, assert the admin panel is still reachable. A
# suite that errors mid-flight and leaves protect_admin_via_proxy=true
# or otherwise mutates global state was previously silent — the
# remaining suites would all 401 with no signal, and the operator
# learned about it only when manually checking. 2026-05-16 operator
# audit: "Not even the admin panel is reachable, how could this be
# missed?"
ADMIN_HOST_FOR_PROBE="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
assert_admin_reachable() {
  local label="$1" code
  for _try in 1 2 3 4 5; do
    code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "${ADMIN_HOST_FOR_PROBE}/" 2>/dev/null || echo "000")
    [[ "$code" == "200" ]] && return 0
    sleep 3
  done
  reachability_breaks+=("$label (http=$code)")
  warn "admin panel UNREACHABLE after $label (http=$code) — global state may be corrupted"
  return 1
}

# Exit-code convention (autoconf SKIP = 77):
#   0   → suite ran AND every assertion passed
#   77  → suite intentionally skipped (precondition not met on this
#         cluster shape — e.g. HA-tier flip on single-node). Distinct
#         from a pass so the operator sees "this was not tested" rather
#         than "this works." Was silent-passing as 0 prior to 2026-05-16
#         and the user correctly called that out as a false positive.
#   *   → real failure
SKIP_RC=77

for entry in "${suites[@]}"; do
  name="${entry%%:*}"
  cmd="${entry#*:}"
  log "Suite: $name"
  reset_admin_password
  set +e
  ADMIN_PASSWORD="$ADMIN_PASSWORD" "$SCRIPT_DIR/${cmd%% *}" ${cmd#* }
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    pass "suite $name PASSED"
    passed_suites+=("$name")
  elif [[ $rc -eq $SKIP_RC ]]; then
    warn "suite $name SKIPPED (precondition not met on this cluster)"
    skipped_suites+=("$name")
  else
    fail "suite $name FAILED (rc=$rc)"
    failed_suites+=("$name")
  fi
  # Reachability sweep — must run regardless of suite outcome
  assert_admin_reachable "$name" || true
done

log "Final results"
printf '  %bpassed:%b  %s\n' "$GREEN" "$RESET" "${#passed_suites[@]}"
printf '  %bskipped:%b %s  (precondition not met — NOT validated)\n' "$YELLOW" "$RESET" "${#skipped_suites[@]}"
printf '  %bfailed:%b  %s\n' "$RED" "$RESET" "${#failed_suites[@]}"
for s in "${passed_suites[@]}";  do printf '    %b✓%b %s\n'  "$GREEN"  "$RESET" "$s"; done
for s in "${skipped_suites[@]}"; do printf '    %b⊝%b %s\n'  "$YELLOW" "$RESET" "$s"; done
for s in "${failed_suites[@]}";  do printf '    %b✗%b %s\n'  "$RED"    "$RESET" "$s"; done

if [[ ${#reachability_breaks[@]} -gt 0 ]]; then
  fail "admin panel was unreachable after ${#reachability_breaks[@]} suite(s):"
  for b in "${reachability_breaks[@]}"; do printf '    %b⚠%b %s\n' "$RED" "$RESET" "$b"; done
  echo ""
  echo "  A suite left global state in a broken condition (proxy gate enabled with no provider,"
  echo "  Flux suspended, ingress misconfigured, etc.). Look at the named suite's EXIT trap."
  echo ""
fi

# Always-run cleanup pass — drops any test clients that escaped the
# per-suite EXIT traps (mid-suite SIGKILL, Ctrl+C between suites,
# scripts that don't yet wire trap-cleanup correctly). Uses the
# official lifecycle DELETE so cascade hooks fire (DNS / backups /
# secrets / namespace / PV reclaim / Longhorn volume delete) — the
# same path production operators use.
log "Post-suite cleanup pass (deletes leftover test clients via lifecycle API)"
yes y | ADMIN_PASSWORD="$ADMIN_PASSWORD" "$SCRIPT_DIR/integration-cleanup.sh" 2>&1 \
  | tail -20 || warn "integration-cleanup.sh reported errors — re-run manually if leaks persist"

# Hard CI guard — fail the run if any test-tenant namespace OR Released
# test-pattern PV survived the per-suite traps AND the cleanup pass
# above. The cleanup pass uses the lifecycle API, which fails when
# system-db is down (the chicken-and-egg scenario observed on
# testing.phoenix-host.net 2026-05-17). This guard talks directly to
# the apiserver so it catches that case. CI_LEAK_GUARD=0 disables.
log "Leak guard (assert no test-tenant namespaces or Released test-PVs survived)"
leak_rc=0
"$SCRIPT_DIR/ci-no-leaked-test-tenants.sh" || leak_rc=$?
if [[ $leak_rc -eq 1 ]]; then
  fail "leak guard FAILED — see above. Set CI_LEAK_GUARD=0 to override (use sparingly)."
  failed_suites+=("leak-guard")
elif [[ $leak_rc -eq 2 ]]; then
  warn "leak guard could not run (no cluster access) — re-check manually"
fi

# Real failures + reachability breaks both fatal.
[[ ${#failed_suites[@]} -eq 0 && ${#reachability_breaks[@]} -eq 0 ]] || exit 1
