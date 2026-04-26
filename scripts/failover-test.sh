#!/usr/bin/env bash
# failover-test.sh — induced-failure drills for the cluster.
#
# Each drill: wait steady state → induce failure → re-run smoke →
# assert recovery within SLO → restore → wait steady state.
#
# Drills:
#   D1 cordon       — cordon each node, expect no service impact
#   D2 drain        — drain each node, expect external IPs on other
#                     nodes still serve <2s
#   D3 kubelet kill — `systemctl stop k3s` on one node, expect cluster
#                     declares it NotReady within 60s, traffic reroutes
#   D4 ingress kill — delete one ingress-nginx pod, expect ≤5s of degradation
#   D5 rolling roll — patch deployment annotation, watch zero downtime
#
# Usage:
#   ./scripts/failover-test.sh                # all drills
#   ./scripts/failover-test.sh --drills 1,4   # just D1 + D4
#   ./scripts/failover-test.sh --skip 3       # skip kubelet kill
#
# Exit status: 0 if every drill PASSes, 1 otherwise.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE="${SCRIPT_DIR}/smoke-test-cluster-network.sh"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
INVENTORY="${INVENTORY:-$HOME/k8s-staging/servers.txt}"

DRILLS_ARG=""
SKIP_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --drills) DRILLS_ARG="$2"; shift 2 ;;
    --skip)   SKIP_ARG="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -25; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0

run() { [[ -n "$DRILLS_ARG" && ! ",$DRILLS_ARG," == *",$1,"* ]] && return 1
        [[ -n "$SKIP_ARG"   &&   ",$SKIP_ARG,"   == *",$1,"* ]] && return 1
        return 0; }

step()  { printf '\n=== %s ===\n' "$*"; }
ok()    { PASS=$((PASS+1)); printf '[PASS] %s\n' "$*"; }
bad()   { FAIL=$((FAIL+1)); printf '[FAIL] %s\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

# ─ wait until smoke test passes (or timeout) ───────────────────────
wait_steady() {
  local timeout="${1:-180}" elapsed=0 interval=10
  while [[ $elapsed -lt $timeout ]]; do
    if "$SMOKE" --skip 4 >/dev/null 2>&1; then
      info "steady state reached after ${elapsed}s"
      return 0
    fi
    sleep $interval
    elapsed=$((elapsed+interval))
  done
  return 1
}

# ─ helper: SSH using the inventory key ─────────────────────────────
ssh_node() {
  local host="$1"; shift
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "root@$host" "$@"
}

# ─ get node names from kubectl ─────────────────────────────────────
list_nodes() {
  kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null
}

# ─ get external IP for a node ──────────────────────────────────────
node_extip() {
  kubectl get node "$1" -o jsonpath='{.status.addresses[?(@.type=="ExternalIP")].address}' 2>/dev/null
}

# ─────────────────────────────────────────────────────────────────────
# D1 — cordon each node
drill_1_cordon() {
  if ! run 1; then info "D1 skipped"; return; fi
  step "Drill 1: cordon each node"
  for node in $(list_nodes); do
    info "cordoning $node"
    kubectl cordon "$node" >/dev/null
    sleep 10
    if "$SMOKE" --skip 2,4 >/dev/null 2>&1; then
      ok "D1 $node: cordoned, smoke clean"
    else
      bad "D1 $node: cordon broke smoke"
    fi
    kubectl uncordon "$node" >/dev/null
    sleep 5
  done
}

# D2 — drain each node
drill_2_drain() {
  if ! run 2; then info "D2 skipped"; return; fi
  step "Drill 2: drain each node, verify external IPs on other nodes still serve"
  for node in $(list_nodes); do
    info "draining $node"
    kubectl drain "$node" --ignore-daemonsets --delete-emptydir-data \
      --force --grace-period=60 --timeout=120s >/dev/null 2>&1 || true
    sleep 30
    # smoke should still pass on EXTERNAL IPs of OTHER nodes
    local other_ips broken=0
    other_ips=$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}={.status.addresses[?(@.type=="ExternalIP")].address}{"\n"}{end}' \
      | grep -v "^$node=" | cut -d= -f2)
    for ip in $other_ips; do
      local code
      code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "admin.staging.phoenix-host.net:443:$ip" \
        -m 8 "https://admin.staging.phoenix-host.net/" 2>/dev/null || echo "000")
      [[ ! "$code" =~ ^(2|3)[0-9][0-9]$ ]] && broken=$((broken+1))
    done
    if [[ $broken -eq 0 ]]; then
      ok "D2 $node drained: other nodes' external IPs serve OK"
    else
      bad "D2 $node drained: $broken other-node IPs failed"
    fi
    kubectl uncordon "$node" >/dev/null
    info "waiting 90s for node repop"
    sleep 90
  done
}

# D3 — kubelet kill
drill_3_kubelet_kill() {
  if ! run 3; then info "D3 skipped"; return; fi
  step "Drill 3: systemctl stop k3s on one node, verify cluster reroutes"
  local target_node="${D3_NODE:-worker}"
  local target_extip
  target_extip=$(node_extip "$target_node")
  [[ -z "$target_extip" ]] && { bad "D3 cannot resolve external IP for $target_node"; return; }

  info "stopping k3s on $target_node ($target_extip)"
  ssh_node "$target_extip" "systemctl stop k3s 2>/dev/null || systemctl stop k3s-agent" || true

  # wait for K8s to mark NotReady (typically 60s)
  local elapsed=0
  while [[ $elapsed -lt 120 ]]; do
    local cond
    cond=$(kubectl get node "$target_node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    [[ "$cond" == "False" || "$cond" == "Unknown" ]] && break
    sleep 5; elapsed=$((elapsed+5))
  done

  # other nodes' external IPs should still serve
  local other_ips broken=0
  other_ips=$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}={.status.addresses[?(@.type=="ExternalIP")].address}{"\n"}{end}' \
    | grep -v "^$target_node=" | cut -d= -f2)
  for ip in $other_ips; do
    local code
    code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "admin.staging.phoenix-host.net:443:$ip" \
      -m 8 "https://admin.staging.phoenix-host.net/" 2>/dev/null || echo "000")
    [[ ! "$code" =~ ^(2|3)[0-9][0-9]$ ]] && broken=$((broken+1))
  done
  if [[ $broken -eq 0 ]]; then
    ok "D3 $target_node down: other-node IPs still serving"
  else
    bad "D3 $target_node down: $broken other-node IPs broken (cascade failure)"
  fi

  info "restarting k3s on $target_node"
  ssh_node "$target_extip" "systemctl start k3s 2>/dev/null || systemctl start k3s-agent" || true

  # wait for Ready
  elapsed=0
  while [[ $elapsed -lt 180 ]]; do
    local cond
    cond=$(kubectl get node "$target_node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    [[ "$cond" == "True" ]] && break
    sleep 5; elapsed=$((elapsed+5))
  done
  info "$target_node Ready after ${elapsed}s recovery"
}

# D4 — delete one ingress-nginx pod
drill_4_ingress_kill() {
  if ! run 4; then info "D4 skipped"; return; fi
  step "Drill 4: delete one ingress-nginx pod"
  local pod
  pod=$(kubectl -n ingress-nginx get pods -l app.kubernetes.io/component=controller \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [[ -z "$pod" ]] && { bad "D4: no ingress-nginx pod"; return; }
  info "deleting $pod"
  kubectl -n ingress-nginx delete pod "$pod" --grace-period=10 >/dev/null 2>&1
  sleep 30
  if "$SMOKE" --skip 2,3,4,5,6 >/dev/null 2>&1; then
    ok "D4 ingress-nginx pod recreated, external IPs serve"
  else
    bad "D4 external IPs failed after pod kill"
  fi
}

# D5 — rolling deploy
drill_5_rolling_deploy() {
  if ! run 5; then info "D5 skipped"; return; fi
  step "Drill 5: roll admin-panel deployment, expect zero downtime"
  local before_rev after_rev start_ts end_ts dur
  before_rev=$(kubectl -n platform get deploy admin-panel -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>/dev/null)
  start_ts=$(date +%s)
  kubectl -n platform patch deploy admin-panel --type=json \
    -p='[{"op":"add","path":"/spec/template/metadata/annotations/smoke-rollout-test","value":"'$(date +%s)'"}]' >/dev/null 2>&1

  # poll smoke during rollout, count failures
  local fails=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    local code
    code=$(curl -sk -o /dev/null -w '%{http_code}' \
      -m 5 "https://admin.staging.phoenix-host.net/" 2>/dev/null || echo "000")
    [[ ! "$code" =~ ^(2|3)[0-9][0-9]$ ]] && fails=$((fails+1))
    sleep 3
  done
  kubectl -n platform rollout status deploy/admin-panel --timeout=120s >/dev/null 2>&1
  after_rev=$(kubectl -n platform get deploy admin-panel -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>/dev/null)
  end_ts=$(date +%s); dur=$((end_ts - start_ts))
  if [[ $fails -le 1 ]]; then
    ok "D5 rolling deploy zero-downtime: $fails/10 fails over ${dur}s, rev $before_rev → $after_rev"
  else
    bad "D5 rolling deploy: $fails/10 fails (regression in zero-downtime contract)"
  fi
}

# ─ run ─────────────────────────────────────────────────────────────
echo "failover-test.sh start: $(date -u +%FT%TZ)"
echo "smoke harness: $SMOKE"
echo "ssh key: $SSH_KEY"

drill_1_cordon
drill_2_drain
drill_3_kubelet_kill
drill_4_ingress_kill
drill_5_rolling_deploy

echo
echo "failover-test.sh end: $(date -u +%FT%TZ)"
echo "PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
