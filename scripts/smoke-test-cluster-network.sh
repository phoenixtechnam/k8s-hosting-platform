#!/usr/bin/env bash
# smoke-test-cluster-network.sh — cluster-level network smoke suite.
#
# Six tests, run in sequence. Each prints PASS or FAIL + diagnostic.
# Designed for forensic comparison: same input → same output ordering →
# trivial diffability across runs (PRE-wipe vs POST-wipe).
#
# Coverage:
#   1) External IP × hostname matrix (round-robin DNS hides ingress
#      issues; this probes each IP individually).
#   2) ingress-nginx pod → backend pod (every nginx × every backend).
#      THIS is the canary for the host→pod cross-node failure mode.
#   3) pod → pod cross-node matrix (control: should pass even when #2
#      fails, proving the issue is hostNetwork-source-specific).
#   4) hostNetwork-source → pod cross-node (direct repro of #2 without
#      ingress-nginx in the mix).
#   5) Longhorn replica health on platform StatefulSets.
#   6) Calico Felix log scrape — fail on MTU/XDP/fatal patterns.
#
# Usage:
#   ./scripts/smoke-test-cluster-network.sh                        # human output
#   ./scripts/smoke-test-cluster-network.sh --json                 # JSON one-line-per-event
#   ./scripts/smoke-test-cluster-network.sh --hostnames a.com,b.com # custom hostnames
#   ./scripts/smoke-test-cluster-network.sh --skip 5,6              # skip specific tests
#
# Exit status: 0 if every test PASSes, 1 otherwise.
set -uo pipefail

# Default hostnames probed in test 1. Override with --hostnames or env.
SMOKE_HOSTNAMES_DEFAULT="admin.staging.phoenix-host.net,client.staging.phoenix-host.net,longhorn.staging.phoenix-host.net,dex.staging.phoenix-host.net"
HOSTNAMES="${SMOKE_HOSTNAMES:-$SMOKE_HOSTNAMES_DEFAULT}"

# Test selection
SKIP=""
JSON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostnames) HOSTNAMES="$2"; shift 2 ;;
    --skip)      SKIP="$2"; shift 2 ;;
    --json)      JSON=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -40
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
PROBE_NS="${SMOKE_PROBE_NS:-default}"
RUN_ID="smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$"

# ─ output helpers ──────────────────────────────────────────────────
emit() {
  # emit <test> <status> <message>
  local test="$1" status="$2" msg="$3"
  if [[ "$status" == "PASS" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  if [[ $JSON -eq 1 ]]; then
    # one JSON object per line — escape quotes/backslashes in msg
    local esc
    esc=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"test":"%s","status":"%s","message":"%s"}\n' "$test" "$status" "$esc"
  else
    printf '[%s] %s — %s\n' "$status" "$test" "$msg"
  fi
}

skipped() { [[ ",$SKIP," == *",$1,"* ]]; }

# ─ test 1: external IP × hostname matrix ───────────────────────────
test_1_external_ips() {
  if skipped 1; then emit "test1.external_ip_matrix" SKIP "skipped"; return; fi

  # discover external IPs from K8s nodes — authoritative
  local ips
  if ! ips=$(kubectl get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="ExternalIP")].address}{"\n"}{end}' 2>/dev/null | grep -v '^$'); then
    emit "test1.external_ip_matrix" FAIL "kubectl get nodes failed"
    return
  fi
  if [[ -z "$ips" ]]; then
    emit "test1.external_ip_matrix" FAIL "no ExternalIP found on any node"
    return
  fi

  IFS=',' read -ra HNARR <<< "$HOSTNAMES"
  while IFS= read -r ip; do
    for host in "${HNARR[@]}"; do
      local n_ok=0 n_fail=0 t_total=0 t_max=0
      for i in 1 2 3 4 5; do
        local res
        res=$(curl -sk -o /dev/null -w '%{http_code} %{time_total}' \
          --resolve "$host:443:$ip" -m 12 "https://$host/" 2>/dev/null || echo "000 12.000")
        local code time_ms
        code=$(echo "$res" | awk '{print $1}')
        time_ms=$(echo "$res" | awk '{printf "%d", $2*1000}')
        if [[ "$code" =~ ^(2|3)[0-9][0-9]$ ]]; then
          n_ok=$((n_ok+1))
          t_total=$((t_total+time_ms))
          [[ $time_ms -gt $t_max ]] && t_max=$time_ms
        else
          n_fail=$((n_fail+1))
        fi
      done
      local avg=0
      [[ $n_ok -gt 0 ]] && avg=$((t_total/n_ok))
      if [[ $n_ok -ge 5 && $t_max -le 2000 ]]; then
        emit "test1.${host}@${ip}" PASS "5/5 OK avg=${avg}ms max=${t_max}ms"
      elif [[ $n_ok -ge 3 ]]; then
        emit "test1.${host}@${ip}" FAIL "${n_ok}/5 OK ${n_fail}/5 fail avg=${avg}ms max=${t_max}ms (intermittent OR slow)"
      else
        emit "test1.${host}@${ip}" FAIL "${n_ok}/5 OK ${n_fail}/5 fail (mostly broken)"
      fi
    done
  done <<< "$ips"
}

# ─ test 2: ingress→pod cross-node matrix ──────────────────────────
test_2_ingress_to_backend() {
  if skipped 2; then emit "test2.ingress_to_backend" SKIP "skipped"; return; fi

  local nginx_pods backend_pods
  nginx_pods=$(kubectl -n ingress-nginx get pods -l app.kubernetes.io/component=controller \
    -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}{"\n"}{end}' 2>/dev/null) \
    || { emit "test2.ingress_to_backend" FAIL "list ingress-nginx pods failed"; return; }
  backend_pods=$(kubectl -n platform get pods -l app=admin-panel \
    -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}={.status.podIP}{"\n"}{end}' 2>/dev/null) \
    || { emit "test2.ingress_to_backend" FAIL "list admin-panel pods failed"; return; }
  [[ -z "$nginx_pods" ]] && { emit "test2.ingress_to_backend" FAIL "no nginx pods found"; return; }
  [[ -z "$backend_pods" ]] && { emit "test2.ingress_to_backend" FAIL "no admin-panel pods found"; return; }

  local total=0 ok=0
  while IFS= read -r np; do
    [[ -z "$np" ]] && continue
    local npod nnode
    npod=$(echo "$np" | cut -d= -f1)
    nnode=$(echo "$np" | cut -d= -f2)
    while IFS= read -r bp; do
      [[ -z "$bp" ]] && continue
      local bnode bip
      bnode=$(echo "$bp" | cut -d= -f2)
      bip=$(echo "$bp" | cut -d= -f3)
      total=$((total+1))
      local same="cross"
      [[ "$nnode" == "$bnode" ]] && same="same"
      local code
      code=$(kubectl -n ingress-nginx exec "$npod" -- timeout 6 curl -s -o /dev/null -w '%{http_code}' "http://$bip:80/" 2>/dev/null || echo "000")
      if [[ "$code" =~ ^(2|3)[0-9][0-9]$ ]]; then
        ok=$((ok+1))
        emit "test2.${npod}@${nnode}->${bip}@${bnode}[${same}]" PASS "http=$code"
      else
        emit "test2.${npod}@${nnode}->${bip}@${bnode}[${same}]" FAIL "http=$code (cross-node host→pod broken)"
      fi
    done <<< "$backend_pods"
  done <<< "$nginx_pods"

  if [[ $ok -eq $total ]]; then
    emit "test2.summary" PASS "$ok/$total OK"
  else
    emit "test2.summary" FAIL "$ok/$total OK (every cross-node combination should also pass)"
  fi
}

# ─ test 3: pod→pod cross-node matrix (using platform-api → postgres) ─
test_3_pod_to_pod() {
  if skipped 3; then emit "test3.pod_to_pod" SKIP "skipped"; return; fi

  local api_pods pg_ip
  api_pods=$(kubectl -n platform get pods -l app=platform-api \
    -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}{"\n"}{end}' 2>/dev/null) \
    || { emit "test3.pod_to_pod" FAIL "list platform-api failed"; return; }
  pg_ip=$(kubectl -n platform get pod postgres-0 -o jsonpath='{.status.podIP}' 2>/dev/null) \
    || { emit "test3.pod_to_pod" FAIL "no postgres-0"; return; }
  [[ -z "$api_pods" ]] && { emit "test3.pod_to_pod" FAIL "no platform-api pods"; return; }

  local pg_node
  pg_node=$(kubectl -n platform get pod postgres-0 -o jsonpath='{.spec.nodeName}' 2>/dev/null)

  local total=0 ok=0
  while IFS= read -r ap; do
    [[ -z "$ap" ]] && continue
    local apod anode
    apod=$(echo "$ap" | cut -d= -f1)
    anode=$(echo "$ap" | cut -d= -f2)
    total=$((total+1))
    local same="cross"
    [[ "$anode" == "$pg_node" ]] && same="same"
    # use node's net.createConnection — guaranteed available in the platform-api image
    local res
    res=$(kubectl -n platform exec "$apod" -- node -e "
      const net = require('net');
      const s = net.createConnection({host: '$pg_ip', port: 5432, timeout: 4000});
      s.on('connect', () => { console.log('CONNECTED'); s.end(); });
      s.on('timeout', () => { console.log('TIMEOUT'); s.destroy(); });
      s.on('error', e => console.log('ERR ' + e.code));
    " 2>/dev/null | tail -1)
    if [[ "$res" == "CONNECTED" ]]; then
      ok=$((ok+1))
      emit "test3.${apod}@${anode}->postgres-0@${pg_node}[${same}]" PASS "TCP/5432 connected"
    else
      emit "test3.${apod}@${anode}->postgres-0@${pg_node}[${same}]" FAIL "TCP/5432 $res"
    fi
  done <<< "$api_pods"

  if [[ $ok -eq $total ]]; then
    emit "test3.summary" PASS "$ok/$total OK (pod→pod cross-node working)"
  else
    emit "test3.summary" FAIL "$ok/$total OK (cluster networking broken below the host-source layer)"
  fi
}

# ─ test 4: hostNetwork-source → pod cross-node ─────────────────────
test_4_hostnetwork_to_pod() {
  if skipped 4; then emit "test4.hostnetwork_to_pod" SKIP "skipped"; return; fi

  local backend_pods nodes
  backend_pods=$(kubectl -n platform get pods -l app=admin-panel \
    -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}={.status.podIP}{"\n"}{end}' 2>/dev/null)
  nodes=$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null)
  [[ -z "$backend_pods" ]] && { emit "test4.hostnetwork_to_pod" FAIL "no admin-panel pods"; return; }
  [[ -z "$nodes" ]] && { emit "test4.hostnetwork_to_pod" FAIL "no nodes"; return; }

  local total=0 ok=0
  while IFS= read -r node; do
    [[ -z "$node" ]] && continue
    while IFS= read -r bp; do
      [[ -z "$bp" ]] && continue
      local bnode bip
      bnode=$(echo "$bp" | cut -d= -f2)
      bip=$(echo "$bp" | cut -d= -f3)
      total=$((total+1))
      local same="cross"
      [[ "$node" == "$bnode" ]] && same="same"
      # spawn a transient hostNetwork pod on $node, curl pod IP
      local probe="smoke-hn-${node}-${bnode}-$$-$RANDOM"
      local out
      out=$(kubectl run "$probe" \
        --image=curlimages/curl:8.10.1 --restart=Never -n "$PROBE_NS" \
        --overrides='{"spec":{"hostNetwork":true,"nodeName":"'"$node"'","tolerations":[{"operator":"Exists"}],"containers":[{"name":"c","image":"curlimages/curl:8.10.1","command":["sh","-c","timeout 6 curl -s -o /dev/null -w %{http_code} http://'"$bip"':80/ || echo 000"],"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"64Mi"}}}]}}' \
        --restart=Never --rm --attach --quiet -- 2>/dev/null || echo "000")
      local code="${out:-000}"
      code="${code: -3}"
      kubectl -n "$PROBE_NS" delete pod "$probe" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1 || true
      if [[ "$code" =~ ^(2|3)[0-9][0-9]$ ]]; then
        ok=$((ok+1))
        emit "test4.host@${node}->${bip}@${bnode}[${same}]" PASS "http=$code"
      else
        emit "test4.host@${node}->${bip}@${bnode}[${same}]" FAIL "http=$code (canary: hostNetwork→pod cross-node broken)"
      fi
    done <<< "$backend_pods"
  done <<< "$nodes"

  if [[ $ok -eq $total ]]; then
    emit "test4.summary" PASS "$ok/$total OK"
  else
    emit "test4.summary" FAIL "$ok/$total OK"
  fi
}

# ─ test 5: Longhorn replica health ─────────────────────────────────
test_5_longhorn_replicas() {
  if skipped 5; then emit "test5.longhorn_replicas" SKIP "skipped"; return; fi

  local volumes
  volumes=$(kubectl -n longhorn-system get volumes.longhorn.io \
    -o jsonpath='{range .items[*]}{.metadata.name}={.spec.numberOfReplicas}={.status.robustness}={.status.state}{"\n"}{end}' 2>/dev/null) \
    || { emit "test5.longhorn_replicas" FAIL "list volumes failed (longhorn-system not ready?)"; return; }
  if [[ -z "$volumes" ]]; then
    emit "test5.longhorn_replicas" PASS "no volumes (fresh cluster)"
    return
  fi
  local total=0 ok=0
  while IFS= read -r v; do
    [[ -z "$v" ]] && continue
    local name desired robustness state
    name=$(echo "$v" | cut -d= -f1)
    desired=$(echo "$v" | cut -d= -f2)
    robustness=$(echo "$v" | cut -d= -f3)
    state=$(echo "$v" | cut -d= -f4)
    total=$((total+1))
    if [[ "$robustness" == "healthy" && "$state" == "attached" ]]; then
      ok=$((ok+1))
      emit "test5.${name}" PASS "replicas=$desired robustness=$robustness state=$state"
    elif [[ "$state" == "detached" ]]; then
      ok=$((ok+1))
      emit "test5.${name}" PASS "replicas=$desired (detached: not in use)"
    else
      emit "test5.${name}" FAIL "replicas=$desired robustness=$robustness state=$state"
    fi
  done <<< "$volumes"
  if [[ $ok -eq $total ]]; then
    emit "test5.summary" PASS "$ok/$total OK"
  else
    emit "test5.summary" FAIL "$ok/$total OK"
  fi
}

# ─ test 6: Felix log scrape ─────────────────────────────────────────
test_6_felix_logs() {
  if skipped 6; then emit "test6.felix_logs" SKIP "skipped"; return; fi

  local pods
  pods=$(kubectl -n calico-system get pods -l k8s-app=calico-node \
    -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}{"\n"}{end}' 2>/dev/null) \
    || { emit "test6.felix_logs" FAIL "list calico-node pods failed"; return; }
  [[ -z "$pods" ]] && { emit "test6.felix_logs" FAIL "no calico-node pods"; return; }

  local total=0 ok=0
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    local pod node
    pod=$(echo "$p" | cut -d= -f1)
    node=$(echo "$p" | cut -d= -f2)
    total=$((total+1))
    # patterns that indicate Felix is unhappy
    local hits
    hits=$(kubectl -n calico-system logs "$pod" -c calico-node --tail=200 2>/dev/null \
      | grep -cE 'Failed to set tunnel device MTU|Failed to wipe the XDP|fatal|panic|Permission denied|wireguard.*error' || true)
    if [[ "$hits" -eq 0 ]]; then
      ok=$((ok+1))
      emit "test6.${node}" PASS "felix log clean (last 200 lines)"
    else
      emit "test6.${node}" FAIL "felix log has $hits warning/error matches"
    fi
  done <<< "$pods"
  if [[ $ok -eq $total ]]; then
    emit "test6.summary" PASS "$ok/$total OK"
  else
    emit "test6.summary" FAIL "$ok/$total OK"
  fi
}

# ─ run ──────────────────────────────────────────────────────────────
emit "run.start" INFO "run_id=$RUN_ID hostnames=$HOSTNAMES skip=${SKIP:-none}"
test_1_external_ips
test_2_ingress_to_backend
test_3_pod_to_pod
test_4_hostnetwork_to_pod
test_5_longhorn_replicas
test_6_felix_logs

emit "run.summary" INFO "PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
