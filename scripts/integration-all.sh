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
ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"

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

# Reset admin password ONCE up front (was: per-suite). Pod restarts can
# cycle the bcrypt hash; a stale password kills login. We reset once
# because the cached INTEGRATION_TOKEN we issue below survives the
# whole run — sub-scripts inherit it, no per-suite re-login.
reset_admin_password() {
  ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" \
    -o StrictHostKeyChecking=no -o ConnectTimeout=10 -q \
    "${SSH_HOST:-root@89.167.3.56}" \
    "/tmp/admin-password-reset.sh --email '${ADMIN_EMAIL}' --password '$ADMIN_PASSWORD' >/dev/null 2>&1" \
    || warn "admin password reset failed — auth may fail in suite"
}

# Single login → INTEGRATION_TOKEN. Sub-scripts inherit via export
# and skip their own /auth/login round-trip (see
# `lib/integration-token.sh` and individual scripts' login_token()).
# Default access token TTL is 30 minutes; we refresh between major
# parallel groups (~midway through a full run) to stay well within
# that window. Sub-scripts that get a 401 fall back to fresh login
# (their existing curl path is the else-branch of the cache check).
mint_token() {
  curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null
}
reset_admin_password
INTEGRATION_TOKEN="$(mint_token)"
[[ -n "$INTEGRATION_TOKEN" ]] || { echo "ERROR: initial login failed" >&2; exit 2; }
export INTEGRATION_TOKEN
log "Cached INTEGRATION_TOKEN (sub-scripts will skip per-suite login)"

# Suite layout: SERIAL groups + PARALLEL groups. Layout chosen to keep
# global-state-mutating suites (staging-all, oidc-dex, postgres-pitr)
# off the parallel path, where their effects on the shared cluster
# would corrupt sibling suites' assertions.
#
# SERIAL_PRE  — must run first, sequentially, against an unmolested
#               cluster. staging-all owns the global integration
#               fixture (admin/billing/support users, backup target,
#               canonical plan/region IDs); oidc-dex toggles Dex
#               static-providers + proxy-gate cluster state.
# PARALLEL    — operate on independent tenant namespaces with no
#               cross-suite state sharing. Race-safe to run all at
#               once. Output is captured per-suite and replayed on
#               completion so the operator can scroll through one
#               cohesive log per suite.
# SERIAL_POST — destructive / terminal. postgres-pitr deletes and
#               recreates the platform/postgres CR — must be the last
#               thing the cluster sees.
#
# 2026-05-17 baseline: a full serial run was ~45 min on staging.
# Switching the PARALLEL bucket to background+wait drops typical
# wall time by ~50% (most parallel suites are 4-8 min apiece and
# converge close to the slowest one's wall time).

SERIAL_PRE=(
  "staging-all:integration-staging.sh all"
  "oidc-dex:integration-oidc-dex.sh"
)
PARALLEL=(
  "pvc:integration-pvc.sh"
  "tier-flip:integration-tier-flip-e2e.sh"
  "grow:integration-grow-e2e.sh"
  "passkey:integration-passkey-e2e.sh"
  "firewall:integration-firewall-e2e.sh"
  "drain:integration-drain-e2e.sh"
  # WAF + CrowdSec IP-blocking coverage on every Traefik DS pod.
  # Each phase 4 round takes ~70s for bouncer cache refresh, so the
  # whole suite is ~3 min; safely parallel with everything else.
  "waf-crowdsec:integration-waf-crowdsec.sh"
  # Admin node-terminal: full A→E flow + F (HA replica handoff) + G
  # (reconnect contract). Requires NODE_TERMINAL_ENABLED=true on the
  # target platform-api and step-up freshness — pass --bump-freshness
  # via env or pre-bump via INTEGRATION_TOKEN. ~90s.
  "node-terminal:integration-node-terminal.sh"
  # R-X5: universal backup-rclone-shim drain orchestration. Exercises
  # list / status / assign / drain-now plus 4 negative paths. Uses a
  # disposable backup_configurations row pointing at dev minio (or a
  # pre-existing S3 target on staging); CREATEs and DELETEs cleanly.
  # ~30s when the shim has no inflight tasks.
  "backup-rclone-shim:integration-backup-rclone-shim.sh"
  # R-X12: full DR drill — exercises the SYSTEM + MAIL shim round-trip
  # (assignment → ObjectStore → ScheduledBackup → CNPG plugin → etcd
  # CronJob → restic Secret) plus dry-run of all three restore scripts.
  # Cleans up after itself via trap. ~2 minutes on a healthy cluster.
  "dr-drill-shim:integration-dr-drill-shim.sh"
  # Operator-managed trusted upstream proxy CIDRs (Nodes & Storage →
  # Trusted Proxies). Adds + verifies + deletes a test CIDR; checks
  # ConfigMap, Traefik DS args, and admin-panel pod mount. ~30s.
  "trusted-proxies:integration-cluster-trusted-proxies.sh"
)
SERIAL_POST=(
  # Destructive to platform/postgres CR (deletes + recreates).
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
# PSA-compatible snapshot-store work lands. Lifecycle goes to
# PARALLEL (operates on its own tenants); system-snapshots stays
# SERIAL_PRE because it mutates the system-db cluster.
if [[ "${INTEGRATION_INCLUDE_SNAPSHOTS:-}" == "1" ]]; then
  SERIAL_PRE+=("system-snapshots:integration-system-snapshots.sh")
  PARALLEL+=("lifecycle:integration-lifecycle-e2e.sh")
fi
# Also skip the bundle + restore SCENARIOS inside the staging-all suite —
# they exercise the same snapshot path through the tenant-backup-v2
# bundle orchestrator. The existing SKIP_BUNDLE_SCENARIO=1 /
# SKIP_RESTORE_SCENARIO=1 env vars in integration-staging.sh gate them.
if [[ "${INTEGRATION_INCLUDE_SNAPSHOTS:-}" != "1" ]]; then
  export SKIP_BUNDLE_SCENARIO="${SKIP_BUNDLE_SCENARIO:-1}"
  export SKIP_RESTORE_SCENARIO="${SKIP_RESTORE_SCENARIO:-1}"
fi
# Operator opt-out: INTEGRATION_PARALLEL=0 forces serial execution
# (useful when debugging a flake — easier to read sequential logs).
INTEGRATION_PARALLEL="${INTEGRATION_PARALLEL:-1}"
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

# run_serial_group GROUP_LABEL SUITE_ENTRY...
# Runs each suite sequentially; output streams live. Reachability
# probe between every suite catches global-state breakage.
run_serial_group() {
  local group_label="$1"; shift
  log "Group [$group_label] (serial, ${#@} suite(s))"
  for entry in "$@"; do
    local name="${entry%%:*}" cmd="${entry#*:}"
    log "Suite: $name"
    set +e
    ADMIN_PASSWORD="$ADMIN_PASSWORD" "$SCRIPT_DIR/${cmd%% *}" ${cmd#* }
    local rc=$?
    set -e
    classify_rc "$name" "$rc"
    assert_admin_reachable "$name" || true
  done
}

# run_parallel_group GROUP_LABEL SUITE_ENTRY...
# Background-launches every suite, captures stdout+stderr to a per-
# suite log, then waits for all and replays each log in order
# (so the operator sees one coherent stream per suite rather than
# interleaved chaos). Failed suites' logs print FIRST so the failure
# is in plain view at the bottom of the operator's terminal scroll.
run_parallel_group() {
  local group_label="$1"; shift
  local n=$#
  log "Group [$group_label] (parallel, $n suite(s))"
  local tmpdir
  tmpdir=$(mktemp -d)
  local -a pids=() names=() rcfiles=() logfiles=()
  for entry in "$@"; do
    local name="${entry%%:*}" cmd="${entry#*:}"
    local logf="$tmpdir/$name.log" rcf="$tmpdir/$name.rc"
    (
      ADMIN_PASSWORD="$ADMIN_PASSWORD" "$SCRIPT_DIR/${cmd%% *}" ${cmd#* } >"$logf" 2>&1
      echo $? > "$rcf"
    ) &
    pids+=("$!")
    names+=("$name")
    rcfiles+=("$rcf")
    logfiles+=("$logf")
    log "  launched: $name (pid=$!)"
  done
  log "  waiting for $n parallel suite(s) to finish…"
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  # Replay outputs: failures first, then passes (so the operator sees
  # the failure at the bottom of their scrollback).
  local i
  # Sort indices: failures first
  local -a order=()
  for i in "${!names[@]}"; do
    local rc; rc=$(cat "${rcfiles[$i]}" 2>/dev/null || echo 1)
    [[ $rc -ne 0 && $rc -ne $SKIP_RC ]] && order+=("$i")
  done
  for i in "${!names[@]}"; do
    local rc; rc=$(cat "${rcfiles[$i]}" 2>/dev/null || echo 1)
    [[ $rc -eq 0 || $rc -eq $SKIP_RC ]] && order+=("$i")
  done
  for i in "${order[@]}"; do
    local name="${names[$i]}" rc; rc=$(cat "${rcfiles[$i]}" 2>/dev/null || echo 1)
    log "── output: $name (rc=$rc) ──"
    cat "${logfiles[$i]}" 2>/dev/null || echo "  (no output captured)"
    classify_rc "$name" "$rc"
  done
  # One reachability probe per group (not per suite) — running it
  # between concurrent suites is meaningless. Run after they all
  # finish, with each suite's name attributed.
  for name in "${names[@]}"; do
    assert_admin_reachable "parallel:$name" || true
  done
  rm -rf "$tmpdir"
}

classify_rc() {
  local name="$1" rc="$2"
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
}

# ─── Execute ──────────────────────────────────────────────────────
run_serial_group "PRE (sequential, mutates global state)" "${SERIAL_PRE[@]}"

# Refresh the cached token before the parallel batch — group PRE
# can run 10-15 min on a slow cluster, and the parallel batch then
# runs another 10-15 min. With JWT default TTL of 30 min, we'd cut
# it close. Cheap insurance.
log "Refreshing INTEGRATION_TOKEN before parallel group"
INTEGRATION_TOKEN="$(mint_token)"
[[ -n "$INTEGRATION_TOKEN" ]] || { fail "mid-run re-login failed — aborting"; exit 1; }
export INTEGRATION_TOKEN

if [[ "$INTEGRATION_PARALLEL" == "1" ]]; then
  run_parallel_group "PARALLEL (independent tenants)" "${PARALLEL[@]}"
else
  warn "INTEGRATION_PARALLEL=0 — running parallel group sequentially"
  run_serial_group "PARALLEL→serial (override)" "${PARALLEL[@]}"
fi

# Final refresh + serial post-group.
INTEGRATION_TOKEN="$(mint_token)" && export INTEGRATION_TOKEN || warn "post-group re-login failed"
run_serial_group "POST (destructive, terminal)" "${SERIAL_POST[@]}"

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
