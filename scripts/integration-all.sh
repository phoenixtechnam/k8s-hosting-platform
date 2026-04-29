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
# script is idempotent and lives on staging1.
reset_admin_password() {
  ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" \
    -o StrictHostKeyChecking=no -o ConnectTimeout=10 -q \
    "${SSH_HOST:-root@89.167.3.56}" \
    "/tmp/admin-password-reset.sh --email admin@phoenix-host.net --password '$ADMIN_PASSWORD' >/dev/null 2>&1" \
    || warn "admin password reset failed — auth may fail in suite"
}

suites=(
  "staging-all:integration-staging.sh all"
  "pvc:integration-pvc.sh"
  "tier-flip:integration-tier-flip-e2e.sh"
  "grow:integration-grow-e2e.sh"
  "lifecycle:integration-lifecycle-e2e.sh"
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
