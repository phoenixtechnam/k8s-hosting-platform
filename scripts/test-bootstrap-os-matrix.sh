#!/usr/bin/env bash
# test-bootstrap-os-matrix.sh — DinD harness that runs `bootstrap.sh
# --dry-run` inside disposable Docker containers across the supported
# Tier-1 + Tier-2 OS matrix and confirms the rejected ones abort.
#
# What this catches:
#   - check_os classification regressions (new release shipped in
#     /etc/os-release breaking the version parse)
#   - install_packages_apt / install_packages_dnf package-name drift
#     (e.g. EPEL renames a package, Debian drops one we relied on)
#   - shell-syntax bugs in the Phase-1 path on any specific distro
#
# What this does NOT catch:
#   - Anything past Phase 1 (firewall, k3s, Calico, Helm, Flux) —
#     containers don't have systemd, can't apply nft, can't run k3s
#   - Kernel-version-specific behaviour (Longhorn iSCSI, WG module)
#   - Cross-node networking
#
# Use the local Hetzner staging cluster + scripts/integration-staging.sh
# for end-to-end coverage.

set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)

# Tier-1 + Tier-2 — must succeed.
TIER_OK=(
  "debian:12"
  "debian:13"
  "ubuntu:22.04"
  "ubuntu:24.04"
  "rockylinux:9"
  "almalinux:9"
  "amazonlinux:2023"
)

# Rejected — bootstrap.sh::check_os MUST abort with a clear error.
# amazonlinux:2 is rejected because AL2 EOLs 2026-06-30 and check_os
# requires VERSION_ID=2023.
TIER_REJECT=(
  "ubuntu:20.04"
  "alpine:3.20"
  "centos:7"
  "amazonlinux:2"
)

# Common dry-run args. Domain/email values are placeholders — dry-run
# exits before they're validated against ACME/DNS.
#
# --allow-source exercises Phase 1 trust-seed validation (regex + python
# ipaddress). Includes IPv4 single, IPv4 CIDR, comma-tolerant form, and
# IPv6 to cover the full parser surface in every supported distro. If
# any token fails validation, parse_args errors out before --dry-run
# returns, which surfaces as a non-zero exit on the matrix run.
DRY_ARGS=(
  --dry-run
  --join-as server
  --domain test.invalid
  --acme-email t@t.invalid
  --allow-source 198.51.100.7
  --allow-source 10.0.0.0/16
  --allow-source fd00::/8
  --allow-source 2001:db8::1
)

# CentOS 8 stock image: removed from Docker Hub after EOL. We assert
# that bootstrap rejects classic CentOS via the centos:7 case; that's
# enough to prove the EOL guard. (CentOS Stream 9 is a separate test
# we'll add when an ID=centos NAME="CentOS Stream" image is available
# on Docker Hub — quay.io/centos/centos:stream9 works but adds registry
# auth complexity. Skipped for now.)

run_dry() {
  local img=$1
  # --rm: ephemeral container.
  # -v REPO:/repo:ro: bootstrap.sh + helpers read-only mount.
  # Pull silently on first use; subsequent runs hit the local cache.
  #
  # Alpine has no bash by default — install it via apk so bootstrap.sh
  # can actually launch and reach check_os. Without this the docker run
  # itself fails with "bash: not found" and we can't tell whether the
  # test caught the unsupported-OS case or just exec'd the wrong shell.
  case "$img" in
    alpine:*)
      docker run --rm -v "$REPO:/repo:ro" "$img" \
        sh -c "apk add --no-cache bash >/dev/null 2>&1 && /repo/scripts/bootstrap.sh ${DRY_ARGS[*]}" 2>&1
      ;;
    *)
      docker run --rm -v "$REPO:/repo:ro" "$img" \
        bash -c "/repo/scripts/bootstrap.sh ${DRY_ARGS[*]}" 2>&1
      ;;
  esac
}

PASS=0
FAIL=0
FAILED_IMAGES=()

echo "════════════════════════════════════════════════"
echo "  Tier 1 + 2 — must SUCCEED (dry-run exit 0)"
echo "════════════════════════════════════════════════"
for img in "${TIER_OK[@]}"; do
  echo
  echo "── $img ──"
  if run_dry "$img" > "/tmp/os-matrix.${img//[:\/]/_}.log" 2>&1; then
    tail -3 "/tmp/os-matrix.${img//[:\/]/_}.log" | sed 's/^/    /'
    echo "  ✓ $img"
    PASS=$((PASS + 1))
  else
    rc=$?
    tail -10 "/tmp/os-matrix.${img//[:\/]/_}.log" | sed 's/^/    /'
    echo "  ✗ $img — exit $rc"
    FAIL=$((FAIL + 1))
    FAILED_IMAGES+=("$img")
  fi
done

echo
echo "════════════════════════════════════════════════"
echo "  Rejected — must FAIL with check_os error"
echo "════════════════════════════════════════════════"
for img in "${TIER_REJECT[@]}"; do
  echo
  echo "── $img ──"
  if run_dry "$img" > "/tmp/os-matrix.${img//[:\/]/_}.log" 2>&1; then
    echo "  ✗ $img should have been rejected but bootstrap returned 0"
    tail -3 "/tmp/os-matrix.${img//[:\/]/_}.log" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
    FAILED_IMAGES+=("$img (UNEXPECTED PASS)")
  else
    # Confirm the abort came from check_os, not from a missing /repo
    # mount or some other accident.
    if grep -qiE "unsupported|end-of-life|EOL" "/tmp/os-matrix.${img//[:\/]/_}.log"; then
      grep -iE "unsupported|end-of-life|EOL" "/tmp/os-matrix.${img//[:\/]/_}.log" | head -2 | sed 's/^/    /'
      echo "  ✓ $img correctly rejected by check_os"
      PASS=$((PASS + 1))
    else
      tail -5 "/tmp/os-matrix.${img//[:\/]/_}.log" | sed 's/^/    /'
      echo "  ✗ $img exited non-zero but NOT via check_os — investigate"
      FAIL=$((FAIL + 1))
      FAILED_IMAGES+=("$img (wrong-error)")
    fi
  fi
done

echo
echo "════════════════════════════════════════════════"
echo "  RESULT: PASS=$PASS  FAIL=$FAIL"
if (( FAIL > 0 )); then
  echo "  Failed: ${FAILED_IMAGES[*]}"
  echo "  Logs in /tmp/os-matrix.*.log"
fi
echo "════════════════════════════════════════════════"
exit $FAIL
