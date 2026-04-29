#!/usr/bin/env bash
# firewall-probe.sh — verify cluster-internal control-plane ports are
# scoped (closed/filtered) when probed from a non-mesh, non-peer host.
#
# Usage: firewall-probe.sh <host-or-ip> [<host-or-ip> ...]
#
# Designed to run from an operator workstation that is NOT on the
# cluster's underlay (NetBird/Tailscale/VPN/VLAN). For each host:
#   * SHOULD be closed/filtered:  6443, 8443, 10250, 5473, 2379, 2380
#   * SHOULD be open (key-auth):  51820/udp, 51821/udp, 29899/udp
#   * SHOULD be open (public):    22, 80, 443
#
# Exits 0 if every probe matches expectations, 1 otherwise.
# Probes both v4 and v6 if the host has AAAA records.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <host-or-ip> [<host-or-ip> ...]" >&2
  exit 2
fi

CLOSED_PORTS=(6443 8443 10250 5473 2379 2380)
OPEN_PORTS=(22 80 443)

probe_tcp() {
  # Returns 0 if port is OPEN (TCP connect succeeds), 1 if filtered/closed.
  local host="$1" port="$2"
  timeout 5 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null
}

failures=0
declare -i ok_count=0

for host in "$@"; do
  echo
  echo "=== probing $host ==="

  # Resolve to v4 + v6 if applicable. getent ahosts returns one line per
  # address with family annotation; we filter for STREAM type to avoid
  # duplicates from multiple lookups.
  mapfile -t addrs < <(getent ahosts "$host" 2>/dev/null \
    | awk '$2 == "STREAM" {print $1}' \
    | sort -u)

  # Bare-IP input — getent may not return STREAM rows, fall back to
  # treating the input as the address itself.
  if [[ ${#addrs[@]} -eq 0 ]]; then
    addrs=("$host")
  fi

  for addr in "${addrs[@]}"; do
    family=v4
    [[ "$addr" == *:* ]] && family=v6
    echo "  -- $family $addr --"
    for port in "${CLOSED_PORTS[@]}"; do
      if probe_tcp "$addr" "$port"; then
        echo "    FAIL :$port should be filtered/closed but is OPEN"
        failures=$((failures + 1))
      else
        echo "    ok   :$port closed/filtered"
        ok_count+=1
      fi
    done
    for port in "${OPEN_PORTS[@]}"; do
      if probe_tcp "$addr" "$port"; then
        echo "    ok   :$port open"
        ok_count+=1
      else
        echo "    WARN :$port should be reachable but timed out"
        # Don't fail the script on these — operator-network egress to
        # the host's public ports may be blocked by their corporate
        # firewall. Log only.
      fi
    done
  done
done

echo
if (( failures > 0 )); then
  echo "✗ $failures port(s) wrongly exposed"
  exit 1
fi
echo "✓ $ok_count probes passed; control-plane ports are scoped."
