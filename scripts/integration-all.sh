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
  "lifecycle:integration-lifecycle-e2e.sh"
  "passkey:integration-passkey-e2e.sh"
  "firewall:integration-firewall-e2e.sh"
  "system-snapshots:integration-system-snapshots.sh"
  "drain:integration-drain-e2e.sh"
  # Last — destructive to platform/postgres CR (deletes + recreates).
  # Source PVCs are reclaimPolicy=Retain so data survives, but other
  # suites should run against the unmolested cluster first.
  "postgres-pitr:integration-postgres-pitr.sh"
)

passed_suites=()
failed_suites=()

for entry in "${suites[@]}"; do
  name="${entry%%:*}"
  cmd="${entry#*:}"
  log "Suite: $name"
  reset_admin_password
  if ADMIN_PASSWORD="$ADMIN_PASSWORD" "$SCRIPT_DIR/${cmd%% *}" ${cmd#* }; then
    pass "suite $name PASSED"
    passed_suites+=("$name")
  else
    fail "suite $name FAILED"
    failed_suites+=("$name")
  fi
done

log "Final results"
printf '  %bpassed:%b %s\n' "$GREEN" "$RESET" "${#passed_suites[@]}"
printf '  %bfailed:%b %s\n' "$RED" "$RESET" "${#failed_suites[@]}"
for s in "${passed_suites[@]}"; do printf '    %b✓%b %s\n' "$GREEN" "$RESET" "$s"; done
for s in "${failed_suites[@]}"; do printf '    %b✗%b %s\n' "$RED" "$RESET" "$s"; done
[[ ${#failed_suites[@]} -eq 0 ]] || exit 1
