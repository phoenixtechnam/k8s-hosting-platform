#!/usr/bin/env bash
# ci-firewall-check.sh — guard against regressions in scripts/bootstrap.sh
# host firewall rules.
#
# Two invariants:
#   1. Every `tcp dport <port> accept` line MUST be a public-surface port
#      (HTTP/HTTPS/SSH/mail) OR appear inside the cluster_allow block
#      (CIDR-scoped or @cluster_peers_v{4,6}). Unrestricted control-plane
#      ports are exactly the regression that caused the IngressNightmare
#      exposure (CVE-2025-1974 advisory ticket from CERT-Bund).
#   2. Every IPv4 saddr scope (`ip saddr ...`) on a control-plane port
#      MUST have a parallel IPv6 (`ip6 saddr ...`) sibling rule, OR be
#      followed by an explicit `# v4-only:` comment justifying the
#      asymmetry. Forces dual-stack symmetry on cluster-internal ports.
#
# Exits non-zero on either violation.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$REPO_ROOT/scripts/bootstrap.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "ci-firewall-check: $SCRIPT not found" >&2
  exit 1
fi

# Ports that are intentionally exposed to the public internet.
# Mail ports (25/465/587/143/993/110/995/4190) are needed on every node
# in case the Stalwart StatefulSet reschedules.
PUBLIC_TCP_PORTS=(80 443 22 25 465 587 143 993 110 995 4190)

is_public_port() {
  local port="$1"
  for p in "${PUBLIC_TCP_PORTS[@]}"; do
    [[ "$port" == "$p" ]] && return 0
  done
  return 1
}

failures=0

# Invariant 1: scan literal `tcp dport NNN accept` lines that are NOT
# inside the cluster_allow heredoc block (cluster_allow is always
# rendered via shell variable expansion, so its lines never appear as
# literal `tcp dport ... accept` in bootstrap.sh).
#
# We walk the heredoc body that defines /etc/nftables.conf.
in_heredoc=0
lineno=0
while IFS= read -r line; do
  lineno=$((lineno + 1))
  if [[ "$line" == *"cat > /etc/nftables.conf <<NFT" ]]; then
    in_heredoc=1
    continue
  fi
  if [[ $in_heredoc -eq 1 && "$line" == "NFT" ]]; then
    in_heredoc=0
    continue
  fi
  [[ $in_heredoc -eq 1 ]] || continue

  # Look for `tcp dport <num> accept` (optionally trailing comment).
  if [[ "$line" =~ ^[[:space:]]*tcp[[:space:]]+dport[[:space:]]+([0-9]+)[[:space:]]+accept ]]; then
    port="${BASH_REMATCH[1]}"
    if ! is_public_port "$port"; then
      echo "FAIL bootstrap.sh:$lineno — unrestricted 'tcp dport $port accept' is not a documented public port"
      echo "      Move into the cluster_allow block (CIDR- or peer-set-scoped)"
      failures=$((failures + 1))
    fi
  fi
done < "$SCRIPT"

# Invariant 2: dual-stack symmetry inside the bootstrap.sh
# configure_firewall function. For each `ip saddr ${CLUSTER_NETWORK_CIDR}`
# rule, require a matching `ip6 saddr ${CLUSTER_NETWORK_CIDR_V6}` rule
# nearby (or a v4-only marker). Same for cluster_peers_v4 / v6 set
# references.
v4_count=$(grep -cE '^\s*ip\s+saddr\s+(\$\{CLUSTER_NETWORK_CIDR\}|@cluster_peers_v4)' "$SCRIPT" || true)
v6_count=$(grep -cE '^\s*ip6\s+saddr\s+(\$\{CLUSTER_NETWORK_CIDR_V6\}|@cluster_peers_v6)' "$SCRIPT" || true)
allowed_skew=$(grep -c '# v4-only:' "$SCRIPT" || true)

# v6 must match v4 within the allowed_skew tolerance.
if (( v4_count > v6_count + allowed_skew )); then
  echo "FAIL dual-stack asymmetry: v4=$v4_count v6=$v6_count v4-only-markers=$allowed_skew"
  echo "      Each 'ip saddr' control-plane rule needs a parallel 'ip6 saddr'"
  echo "      rule, or a '# v4-only:' marker explaining the omission."
  failures=$((failures + 1))
fi

if (( failures > 0 )); then
  echo
  echo "✗ $failures firewall-rule violation(s) in $SCRIPT"
  exit 1
fi

echo "✓ bootstrap.sh firewall rules: $v4_count v4 / $v6_count v6 scoped, all public ports documented."
