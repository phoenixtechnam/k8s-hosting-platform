#!/usr/bin/env bash
# destroy-cluster.sh — DESTRUCTIVE: wipes K8s/Calico/Longhorn state on
# every node listed in $INVENTORY. Preserves NetBird identity (so
# wt0 IPs stay stable across the rebuild) and doesn't touch user
# data outside the cluster (no /etc/passwd, no /home).
#
# Use cases:
#   - Fresh re-bootstrap after debugging session drift
#   - Disaster recovery test (followed by bootstrap.sh on each node)
#
# Inventory format ($INVENTORY, default ~/k8s-staging/servers.txt):
#   <hostname> <public-ipv4> [<public-ipv6>]
# Lines without a public-ipv4 are skipped.
#
# Usage:
#   ./scripts/destroy-cluster.sh                # dry-run (prints what it would do)
#   ./scripts/destroy-cluster.sh --confirm      # actually wipe
#   INVENTORY=/path/to/file ./scripts/destroy-cluster.sh --confirm
set -uo pipefail

SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
INVENTORY="${INVENTORY:-$HOME/k8s-staging/servers.txt}"
CONFIRM=0
SSH_USER="${SSH_USER:-root}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm) CONFIRM=1; shift ;;
    --inventory) INVENTORY="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -25; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -r "$INVENTORY" ]]; then
  echo "inventory not readable: $INVENTORY" >&2
  exit 2
fi
if [[ ! -r "$SSH_KEY" ]]; then
  echo "ssh key not readable: $SSH_KEY" >&2
  exit 2
fi

# parse inventory: hostname <space> ipv4 (skip blank, comments, headers)
NODES=()
while IFS= read -r line; do
  line="${line%%#*}"
  [[ -z "${line// /}" ]] && continue
  read -r host ipv4 _rest <<< "$line"
  # accept only when ipv4 looks like an IPv4 address
  if [[ "$ipv4" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NODES+=("$host=$ipv4")
  fi
done < "$INVENTORY"

if [[ ${#NODES[@]} -eq 0 ]]; then
  echo "no nodes parsed from $INVENTORY" >&2
  exit 2
fi

echo "destroy-cluster.sh — target nodes:"
for n in "${NODES[@]}"; do
  printf '  %s\n' "$n"
done
echo "ssh key: $SSH_KEY"
echo "ssh user: $SSH_USER"
if [[ $CONFIRM -eq 0 ]]; then
  echo
  echo "DRY RUN — re-run with --confirm to actually wipe."
  exit 0
fi

# the wipe payload — runs on each node in parallel
read -r -d '' WIPE_SCRIPT <<'PAYLOAD' || true
set -uo pipefail
echo "[$(hostname)] starting wipe at $(date -u +%FT%TZ)"

# Capture pre-wipe NetBird state for sanity post-wipe
WTBEFORE=$(ip -4 -o addr show wt0 2>/dev/null | awk '{print $4}' | head -1)
echo "[$(hostname)] wt0 before: ${WTBEFORE:-none}"

# Stop k3s services (both server & agent variants)
systemctl stop k3s 2>/dev/null || true
systemctl stop k3s-agent 2>/dev/null || true
sleep 2

# Tear down Calico tunnels + workload veths
ip link delete vxlan.calico 2>/dev/null || true
ip link delete tunl0 2>/dev/null || true
ip link delete wireguard.cali 2>/dev/null || true
for v in $(ip -br link show 2>/dev/null | awk '/^cali[0-9a-f]/ {print $1}' | cut -d@ -f1); do
  ip link delete "$v" 2>/dev/null || true
done

# Flush all iptables rules + nftables fallback + conntrack
iptables -F 2>/dev/null || true
iptables -t nat -F 2>/dev/null || true
iptables -t mangle -F 2>/dev/null || true
iptables -t raw -F 2>/dev/null || true
iptables -X 2>/dev/null || true
ip6tables -F 2>/dev/null || true
ip6tables -t nat -F 2>/dev/null || true
ip6tables -X 2>/dev/null || true
nft flush ruleset 2>/dev/null || true
conntrack -F 2>/dev/null || true

# Wipe K8s + Calico + Longhorn state directories
rm -rf /var/lib/rancher /etc/rancher
rm -rf /var/lib/calico /etc/cni /var/run/calico
rm -rf /var/lib/longhorn /opt/longhorn
rm -rf /var/lib/kubelet /etc/kubernetes

# kill any lingering containerd/k3s processes (defensive)
pkill -9 -f containerd-shim 2>/dev/null || true
pkill -9 -f k3s 2>/dev/null || true

# Confirm NetBird identity survived (its config lives in /var/lib/netbird/, untouched)
systemctl restart netbird 2>/dev/null || systemctl start netbird 2>/dev/null || true
sleep 5
WTAFTER=$(ip -4 -o addr show wt0 2>/dev/null | awk '{print $4}' | head -1)
echo "[$(hostname)] wt0 after: ${WTAFTER:-none}"
if [[ -z "$WTAFTER" ]]; then
  echo "[$(hostname)] WARN: wt0 missing post-wipe — NetBird needs manual recovery"
  exit 3
fi
if [[ "$WTBEFORE" != "$WTAFTER" ]]; then
  echo "[$(hostname)] WARN: wt0 IP changed ${WTBEFORE} → ${WTAFTER} (peers will re-converge)"
fi

echo "[$(hostname)] wipe complete at $(date -u +%FT%TZ)"
PAYLOAD

LOG_DIR="/tmp/destroy-cluster-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$LOG_DIR"
echo "logs: $LOG_DIR"
echo "wiping ${#NODES[@]} nodes in parallel..."
echo

PIDS=()
for nh in "${NODES[@]}"; do
  host="${nh%=*}"
  ip="${nh#*=}"
  (
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      "$SSH_USER@$ip" "bash -s" <<<"$WIPE_SCRIPT" \
      > "$LOG_DIR/${host}.log" 2>&1
    rc=$?
    echo "[$host] exit=$rc"
  ) &
  PIDS+=($!)
done

# Wait for all
fail=0
for p in "${PIDS[@]}"; do
  if ! wait "$p"; then fail=$((fail+1)); fi
done

echo
if [[ $fail -eq 0 ]]; then
  echo "all nodes wiped (logs in $LOG_DIR)"
  exit 0
else
  echo "$fail node(s) failed to wipe cleanly — inspect $LOG_DIR/*.log"
  exit 1
fi
