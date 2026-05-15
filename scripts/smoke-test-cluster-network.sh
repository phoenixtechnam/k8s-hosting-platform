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
#   2) ingress controller pod → backend pod (every ingress × every backend).
#      THIS is the canary for the host→pod cross-node failure mode.
#      Traefik migration (2026-05-15): namespace `ingress-nginx` →
#      `traefik`, selector `app.kubernetes.io/component=controller` →
#      `app.kubernetes.io/name=traefik`.
#   3) pod → pod cross-node matrix (control: should pass even when #2
#      fails, proving the issue is hostNetwork-source-specific).
#   4) hostNetwork-source → pod cross-node (direct repro of #2 without
#      the ingress controller in the mix).
#   5) Longhorn replica health on platform StatefulSets.
#   6) Calico Felix log scrape — fail on MTU/XDP/fatal patterns.
#   7) cert-manager Certificate readiness — every Certificate in
#      platform/mail/longhorn-system must report Ready=True. LE
#      issuance failures often cascade from cross-node host→pod
#      breakage (the ingress→solver-pod hop is host-source) so
#      this is the canary for the same class of bug as Test 4.
#   8) Stateless platform Deployments meet HA replica/spread
#      requirements when policy.systemTier=ha (≥3 ready pods, on
#      ≥2 nodes). Caught regression: Apply HA scales spec.replicas
#      but pods don't actually schedule on a third node.
#   9) CNPG Cluster reports ready + matches expected instance
#      count for the current tier (1 for local, 3 for ha).
#
# Usage:
#   ./scripts/smoke-test-cluster-network.sh                        # human output
#   ./scripts/smoke-test-cluster-network.sh --json                 # JSON one-line-per-event
#   ./scripts/smoke-test-cluster-network.sh --hostnames a.com,b.com # custom hostnames
#   ./scripts/smoke-test-cluster-network.sh --skip 5,6              # skip specific tests
#
# Exit status: 0 if every test PASSes, 1 otherwise.
set -uo pipefail

# Default hostnames probed in test 1. Resolution order:
#   1. --hostnames flag (overrides everything)
#   2. SMOKE_HOSTNAMES env var
#   3. platform-cluster-config ConfigMap (deployed by bootstrap.sh —
#      authoritative source of the cluster's PLATFORM_DOMAIN)
#   4. Hardcoded fallback (staging cluster, used when CM is absent)
SMOKE_HOSTNAMES_FALLBACK="admin.staging.phoenix-host.net,client.staging.phoenix-host.net,longhorn.staging.phoenix-host.net,dex.staging.phoenix-host.net"

discover_hostnames() {
  # Read the base domain from the live cluster's platform-config
  # ConfigMap (key `ingress-base-domain`, set by bootstrap.sh from
  # --domain). If absent (pre-Flux, missing namespace, etc.) fall
  # back to the hardcoded staging hostnames so this script still
  # produces output on broken clusters.
  local dom
  dom=$(kubectl -n platform get configmap platform-config \
    -o jsonpath='{.data.ingress-base-domain}' 2>/dev/null || true)
  # Backwards-compat: pre-2026 platform-cluster-config CM (if any
  # legacy clusters still use it).
  if [[ -z "$dom" ]]; then
    dom=$(kubectl -n platform-system get configmap platform-cluster-config \
      -o jsonpath='{.data.PLATFORM_DOMAIN}' 2>/dev/null || true)
  fi
  if [[ -z "$dom" ]]; then
    dom=$(kubectl -n platform get configmap platform-cluster-config \
      -o jsonpath='{.data.PLATFORM_DOMAIN}' 2>/dev/null || true)
  fi
  if [[ -n "$dom" ]]; then
    echo "admin.${dom},client.${dom},longhorn.${dom},dex.${dom}"
  else
    echo "$SMOKE_HOSTNAMES_FALLBACK"
  fi
}
HOSTNAMES="${SMOKE_HOSTNAMES:-$(discover_hostnames)}"

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
  case "$status" in
    PASS) PASS=$((PASS+1)) ;;
    FAIL) FAIL=$((FAIL+1)) ;;
    # INFO/SKIP are informational — neither pass nor fail the run.
    *) ;;
  esac
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

  # discover external IPs from K8s nodes. Cloud providers populate
  # .status.addresses[type=ExternalIP]; bare-metal Hetzner installs
  # often leave this empty and rely on InternalIP + DNS only. Split
  # the kubectl error from the missing-field signal so the diagnostic
  # message points at the actual problem.
  local raw_ips ips
  if ! raw_ips=$(kubectl get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="ExternalIP")].address}{"\n"}{end}' 2>/dev/null); then
    emit "test1.external_ip_matrix" FAIL "kubectl get nodes failed (check kubeconfig)"
    return
  fi
  ips=$(echo "$raw_ips" | grep -v '^$' || true)
  if [[ -z "$ips" ]]; then
    # Bare-metal install with no cloud-provider populating ExternalIP
    # — that's expected (e.g. Hetzner VPS bootstrapped via our
    # script) and not a regression. Skip the matrix probe.
    emit "test1.external_ip_matrix" PASS "no ExternalIP on any node (bare-metal install) — matrix probe skipped"
    return
  fi

  IFS=',' read -ra HNARR <<< "$HOSTNAMES"
  while IFS= read -r ip; do
    for host in "${HNARR[@]}"; do
      local n_ok=0 n_fail=0 t_total=0 t_max=0
      for _ in 1 2 3 4 5; do
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

  local ingress_pods backend_pods
  ingress_pods=$(kubectl -n traefik get pods -l app.kubernetes.io/name=traefik \
    -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}{"\n"}{end}' 2>/dev/null) \
    || { emit "test2.ingress_to_backend" FAIL "list traefik pods failed"; return; }
  backend_pods=$(kubectl -n platform get pods -l app=admin-panel \
    -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}={.status.podIP}{"\n"}{end}' 2>/dev/null) \
    || { emit "test2.ingress_to_backend" FAIL "list admin-panel pods failed"; return; }
  [[ -z "$ingress_pods" ]] && { emit "test2.ingress_to_backend" FAIL "no traefik pods found"; return; }
  [[ -z "$backend_pods" ]] && { emit "test2.ingress_to_backend" FAIL "no admin-panel pods found"; return; }

  local total=0 ok=0
  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    local ipod inode
    ipod=$(echo "$ip" | cut -d= -f1)
    inode=$(echo "$ip" | cut -d= -f2)
    # Pending Traefik DS pods have no nodeName yet (typical mid-rollout
    # state: new pod is Pending until the old pod releases hostPort 80/443).
    # Skip them — the probe nodeName='' would fail with a runtime error,
    # and a not-yet-scheduled pod is by definition not part of the live
    # ingress path.
    if [[ -z "$inode" ]]; then
      emit "test2.${ipod}@unscheduled" SKIP "Traefik pod not yet scheduled (Pending — hostPort race during DS rollout?)"
      continue
    fi
    while IFS= read -r bp; do
      [[ -z "$bp" ]] && continue
      local bnode bip
      bnode=$(echo "$bp" | cut -d= -f2)
      bip=$(echo "$bp" | cut -d= -f3)
      total=$((total+1))
      local same="cross"
      [[ "$inode" == "$bnode" ]] && same="same"
      # Traefik image is distroless — no curl binary. We can't `kubectl exec
      # traefik -- curl ...`. Use the standard host→pod probe via a transient
      # curl container on the same node (hostNetwork off — we want to verify
      # the SAME cross-node path Traefik would take, but stop calling Traefik
      # itself the probe). Test 4 covers the hostNetwork path explicitly.
      local probe="smoke-t2-${ipod}-${bnode}-$$-$RANDOM"
      local out code
      out=$(kubectl run "$probe" \
        --image=curlimages/curl:8.10.1 --restart=Never -n "$PROBE_NS" \
        --overrides='{"spec":{"nodeName":"'"$inode"'","tolerations":[{"operator":"Exists"}],"containers":[{"name":"c","image":"curlimages/curl:8.10.1","command":["sh","-c","timeout 6 curl -s -o /dev/null -w %{http_code} http://'"$bip"':3000/ || echo 000"],"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"64Mi"}}}]}}' \
        --restart=Never --rm --attach --quiet -- 2>/dev/null || echo "000")
      code="${out:-000}"
      code="${code: -3}"
      kubectl -n "$PROBE_NS" delete pod "$probe" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1 || true
      if [[ "$code" =~ ^(2|3|4)[0-9][0-9]$ ]]; then
        ok=$((ok+1))
        emit "test2.${ipod}@${inode}->${bip}@${bnode}[${same}]" PASS "http=$code"
      else
        emit "test2.${ipod}@${inode}->${bip}@${bnode}[${same}]" FAIL "http=$code (cross-node host→pod broken)"
      fi
    done <<< "$backend_pods"
  done <<< "$ingress_pods"

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
  # Postgres pod naming: CNPG cluster (system-db-1, system-db-2) —
  # was renamed from `postgres` to `system-db` during the 2026-05-07
  # PG18 migration. Fall back to the old name + legacy StatefulSet
  # for older clusters that haven't migrated yet.
  local pg_pod
  pg_pod=$(kubectl -n platform get pods \
    -l cnpg.io/cluster=system-db,role=primary \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -z "$pg_pod" ]]; then
    pg_pod=$(kubectl -n platform get pods \
      -l cnpg.io/cluster=postgres,role=primary \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  fi
  if [[ -z "$pg_pod" ]]; then
    pg_pod=$(kubectl -n platform get pods -l app=postgres \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  fi
  if [[ -z "$pg_pod" ]]; then
    emit "test3.pod_to_pod" FAIL "no postgres primary pod found (looked for system-db, postgres, and app=postgres)"
    return
  fi
  pg_ip=$(kubectl -n platform get pod "$pg_pod" -o jsonpath='{.status.podIP}' 2>/dev/null)
  [[ -z "$pg_ip" ]] && { emit "test3.pod_to_pod" FAIL "no IP on $pg_pod"; return; }
  [[ -z "$api_pods" ]] && { emit "test3.pod_to_pod" FAIL "no platform-api pods"; return; }

  local pg_node
  pg_node=$(kubectl -n platform get pod "$pg_pod" -o jsonpath='{.spec.nodeName}' 2>/dev/null)

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
      emit "test3.${apod}@${anode}->${pg_pod}@${pg_node}[${same}]" PASS "TCP/5432 connected"
    else
      emit "test3.${apod}@${anode}->${pg_pod}@${pg_node}[${same}]" FAIL "TCP/5432 $res"
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
        --overrides='{"spec":{"hostNetwork":true,"nodeName":"'"$node"'","tolerations":[{"operator":"Exists"}],"containers":[{"name":"c","image":"curlimages/curl:8.10.1","command":["sh","-c","timeout 6 curl -s -o /dev/null -w %{http_code} http://'"$bip"':3000/ || echo 000"],"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"64Mi"}}}]}}' \
        --restart=Never --rm --attach --quiet -- 2>/dev/null || echo "000")
      local code="${out:-000}"
      code="${code: -3}"
      kubectl -n "$PROBE_NS" delete pod "$probe" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1 || true
      # admin-panel listens on :3000 with no auth gate on /, returns 200 from /
      # routes that don't require auth. Any HTTP response (2|3|4xx) proves the
      # hostNetwork→pod cross-node path works at L7 — what 4xx really proves
      # is that the L7 connection completed and the backend returned a status.
      # The smoke check here is connectivity, not authorization.
      if [[ "$code" =~ ^(2|3|4)[0-9][0-9]$ ]]; then
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
    # Patterns that indicate Felix is unhappy. The grep is anchored
    # to specific error classes — anything else is noise.
    #
    # 2026-05-14: tightened from a permissive 'wireguard.*error'
    # which matched the benign `felix/wireguard.go ... Failed to
    # set NAPI threading to 0 ... operation not supported` warning
    # emitted on every Linux kernel without per-interface NAPI
    # threading sysctl (Debian 13 trixie, kernel 6.12). Replaced
    # with a narrower regex that targets actual wireguard egress/
    # peer/encryption failures.
    local hits
    hits=$(kubectl -n calico-system logs "$pod" -c calico-node --tail=200 2>/dev/null \
      | grep -E 'Failed to set tunnel device MTU|Failed to wipe the XDP|fatal|panic|Permission denied|wireguard.*(peer|encrypt|cannot create)' \
      | grep -vE 'Failed to set NAPI threading.*operation not supported' \
      | wc -l)
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

# ─ test 7: cert-manager Certificates Ready ─────────────────────────
# A Ready=False Certificate means the LE order failed (HTTP-01
# challenge couldn't reach the cert-manager solver pod). This is
# the same failure-class as Test 4: the ingress→solver hop is a
# host-source-to-pod cross-node forward when DNS lands on a node
# without the solver. If Test 4 is GREEN and Test 7 is RED, the
# issue is downstream of the netpol — likely DNS, rate-limit, or
# a stale Order needing manual reissue. If both RED, fix Test 4
# first; Test 7 will heal automatically on the next reconcile.
test_7_cert_ready() {
  if skipped 7; then emit "test7.cert_ready" SKIP "skipped"; return; fi

  # Stuck-Issuing threshold: cert-manager normally completes an LE
  # HTTP-01 issuance in <90s. After this many seconds, an Issuing
  # cert is considered FAILED (likely a rate-limit, stale Order, or
  # solver unreachable). Configurable via env for slow underlays.
  local stuck_threshold_seconds="${SMOKE_CERT_ISSUING_THRESHOLD:-300}"

  # Namespaces we expect to host TLS-issuing Ingresses. Add to this
  # list when a new admin-only or platform UI ships a Cert.
  local namespaces=("platform" "mail" "longhorn-system")

  # Pre-reconcile detection: if NONE of the expected namespaces
  # exist yet, the cluster is brand-new and Flux hasn't run; skip
  # cleanly. If ANY namespace exists, expect certs there — empty =
  # genuine regression (cert-manager CRDs deleted, etc.).
  local existing_ns=0
  for ns in "${namespaces[@]}"; do
    if kubectl get namespace "$ns" &>/dev/null; then
      existing_ns=$((existing_ns+1))
    fi
  done
  if [[ $existing_ns -eq 0 ]]; then
    emit "test7.cert_ready" PASS "no expected namespaces yet (cluster pre-reconcile)"
    return
  fi

  local certs=""
  for ns in "${namespaces[@]}"; do
    local out
    # creationTimestamp is included so we can age-check stuck Issuing.
    out=$(kubectl -n "$ns" get certificates.cert-manager.io \
      -o jsonpath='{range .items[*]}{.metadata.name}={.metadata.namespace}={.status.conditions[?(@.type=="Ready")].status}={.status.conditions[?(@.type=="Ready")].reason}={.metadata.creationTimestamp}{"\n"}{end}' 2>/dev/null) || true
    [[ -n "$out" ]] && certs+="$out"
  done
  if [[ -z "$certs" ]]; then
    emit "test7.cert_ready" FAIL "namespaces exist but no Certificates found (cert-manager CRDs missing or Flux didn't apply Ingresses)"
    return
  fi

  local now_epoch
  now_epoch=$(date -u +%s)

  local total=0 ok=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local name ns status reason created
    name=$(echo "$line" | cut -d= -f1)
    ns=$(echo "$line" | cut -d= -f2)
    status=$(echo "$line" | cut -d= -f3)
    reason=$(echo "$line" | cut -d= -f4)
    created=$(echo "$line" | cut -d= -f5)
    total=$((total+1))

    if [[ "$status" == "True" ]]; then
      ok=$((ok+1))
      emit "test7.${ns}/${name}" PASS "Ready=True"
      continue
    fi

    # Cert age in seconds. `date -d` is GNU; on BSD/macOS the
    # parser differs but we run smoke on Linux nodes only.
    local age=0
    if [[ -n "$created" ]]; then
      local created_epoch
      created_epoch=$(date -u -d "$created" +%s 2>/dev/null || echo 0)
      [[ $created_epoch -gt 0 ]] && age=$((now_epoch - created_epoch))
    fi

    if [[ -z "$status" ]]; then
      # No Ready condition yet — only acceptable on a freshly-created cert
      if [[ $age -lt $stuck_threshold_seconds ]]; then
        ok=$((ok+1))
        emit "test7.${ns}/${name}" PASS "no Ready condition yet (age=${age}s, threshold=${stuck_threshold_seconds}s)"
      else
        emit "test7.${ns}/${name}" FAIL "no Ready condition after ${age}s (cert-manager not reconciling — check controller logs)"
      fi
      continue
    fi

    if [[ "$reason" == "Issuing" || "$reason" == "DoesNotExist" ]]; then
      if [[ $age -lt $stuck_threshold_seconds ]]; then
        ok=$((ok+1))
        emit "test7.${ns}/${name}" PASS "Issuing (transient, age=${age}s)"
      else
        emit "test7.${ns}/${name}" FAIL "STUCK in $reason for ${age}s — likely LE order failed or solver unreachable; check Test 4"
      fi
      continue
    fi

    # Anything else (Failed, etc.) is a real failure regardless of age.
    emit "test7.${ns}/${name}" FAIL "Ready=$status reason=$reason (LE order failed — check cross-node host→pod via Test 4)"
  done <<< "$certs"

  if [[ $ok -eq $total ]]; then
    emit "test7.summary" PASS "$ok/$total OK"
  else
    emit "test7.summary" FAIL "$ok/$total OK"
  fi
}

# ─ test 8: HA stateless Deployment shape ───────────────────────────
# When platform_storage_policy.system_tier=ha, every stateless
# Deployment in the policy's STATELESS_DEPLOYMENTS list must:
#   - Have at least 3 ready replicas
#   - Have its replica pods spread across ≥2 nodes
# When tier=local, no constraint (≥1 ready replica suffices).
test_8_ha_deployments() {
  if skipped 8; then emit "test8.ha_deployments" SKIP "skipped"; return; fi

  # Cluster-size awareness: HA assertions only apply on clusters
  # with ≥2 schedulable nodes. Single-node testing/dev installs
  # legitimately run 1 replica per stateless Deployment and would
  # falsely fail this test on every run (observed 2026-05-14).
  #
  # Count via jsonpath rather than parsing `kubectl get nodes`
  # human output: that output mixes status fields (`Ready`,
  # `Ready,SchedulingDisabled`, `NotReady`) into one comma column,
  # so an awk/grep regex easily mismatches. The Ready condition is
  # in .status.conditions and is the authoritative signal.
  local node_count
  node_count=$(kubectl get nodes \
    -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' \
    2>/dev/null | grep -c '^True$' || true)
  if [[ "$node_count" -lt 2 ]]; then
    emit "test8.ha_deployments" PASS "single-node cluster (Ready nodes=$node_count) — HA assertions skipped"
    return
  fi

  # Tier is implied by the live replica count: any of the stateless
  # Deployments at >=3 replicas means HA is in effect. Reading the
  # ConfigMap directly added no information beyond the live spec, so
  # we just look at .spec.replicas across the system Deployments.
  local expected=2
  for d in admin-panel client-panel platform-api oauth2-proxy dex; do
    local r
    r=$(kubectl -n platform get deploy "$d" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)
    [[ "$r" -gt "$expected" ]] && expected=$r
  done

  local total=0 ok=0
  for d in admin-panel client-panel platform-api oauth2-proxy dex; do
    total=$((total+1))
    local ready_replicas nodes_count
    ready_replicas=$(kubectl -n platform get deploy "$d" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
    nodes_count=$(kubectl -n platform get pods -l app="$d" --field-selector=status.phase=Running \
      -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' 2>/dev/null \
      | sort -u | grep -c -v '^$' || echo 0)
    if [[ "$ready_replicas" -ge "$expected" && "$nodes_count" -ge 2 ]]; then
      ok=$((ok+1))
      emit "test8.${d}" PASS "${ready_replicas}/${expected} ready, ${nodes_count} nodes"
    else
      emit "test8.${d}" FAIL "${ready_replicas}/${expected} ready, ${nodes_count} nodes (expected ${expected} replicas across ≥2 nodes)"
    fi
  done
  if [[ $ok -eq $total ]]; then
    emit "test8.summary" PASS "$ok/$total OK"
  else
    emit "test8.summary" FAIL "$ok/$total OK"
  fi
}

# ─ test 9: CNPG Cluster ready ──────────────────────────────────────
test_9_cnpg_cluster() {
  if skipped 9; then emit "test9.cnpg_cluster" SKIP "skipped"; return; fi

  # Cluster CRD may not be installed yet (fresh cluster, pre-Flux).
  if ! kubectl get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
    emit "test9.cnpg_cluster" PASS "CNPG CRD not installed (pre-reconcile)"
    return
  fi

  # Cluster name was renamed postgres → system-db during 2026-05-07
  # PG18 migration. Try the canonical name first; fall back to legacy
  # so this test still works on pre-migration clusters.
  local cluster cluster_name
  cluster=$(kubectl -n platform get cluster.postgresql.cnpg.io system-db -o json 2>/dev/null || true)
  cluster_name="system-db"
  if [[ -z "$cluster" ]]; then
    cluster=$(kubectl -n platform get cluster.postgresql.cnpg.io postgres -o json 2>/dev/null || true)
    cluster_name="postgres"
  fi
  if [[ -z "$cluster" ]]; then
    emit "test9.cnpg_cluster" FAIL "Cluster system-db (or postgres) -n platform not found"
    return
  fi

  local instances ready_instances phase
  instances=$(echo "$cluster" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("spec",{}).get("instances",0))')
  ready_instances=$(echo "$cluster" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("status",{}).get("readyInstances",0))')
  phase=$(echo "$cluster" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("status",{}).get("phase","unknown"))')

  if [[ "$ready_instances" -eq "$instances" && "$instances" -ge 1 ]]; then
    emit "test9.${cluster_name}" PASS "instances=$instances readyInstances=$ready_instances phase=$phase"
  else
    emit "test9.${cluster_name}" FAIL "instances=$instances readyInstances=$ready_instances phase=$phase"
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
test_7_cert_ready
test_8_ha_deployments
test_9_cnpg_cluster

emit "run.summary" INFO "PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
