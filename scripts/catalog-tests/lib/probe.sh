#!/usr/bin/env bash
# Library: per-type readiness probes.
# Sourced by scripts/integration-catalog-local.sh — needs api.sh sourced first.
#
# Each probe returns 0 on success (deployment serves correctly) or non-zero
# on failure. Probes print user-facing pass/fail lines via ok()/fail().

# pod_ready_only NAMESPACE LABEL_SELECTOR TIMEOUT_S
# Just wait for all pods matching the selector to reach Ready.
probe_pod_ready_only() {
  local ns="$1" sel="$2" timeout="$3"
  if kctl -n "$ns" wait --for=condition=Ready pod -l "$sel" --timeout="${timeout}s" >/dev/null 2>&1; then
    ok "pods Ready (selector=${sel})"
    return 0
  fi
  fail "pods not Ready after ${timeout}s (selector=${sel})"
  return 1
}

# probe_http_ingress NAMESPACE PATH MIN_CODE MAX_CODE TIMEOUT_S
# Curls the deployed Service from inside the tenant namespace using a
# transient pod, asserting the response code is in [MIN_CODE, MAX_CODE].
#
# We deliberately bypass the external ingress + cert-manager + DNS chain
# here — those are platform concerns covered by integration-staging.sh's
# scenario_https. This harness verifies "the catalog manifest produces a
# pod that serves HTTP on its declared port." We hit the Service directly
# (in-cluster), which is the deployer's contract for the workload.
#
# The deployed Service is named the same as the deployment (via
# k8sResourceName in the deployer); we discover it by label selector
# `platform.io/managed=true=<deplname>` so we don't hard-code the name.
probe_http_ingress() {
  local ns="$1" path="$2" min_code="$3" max_code="$4" timeout="$5"
  # Wait for any pod in the namespace to be Ready first — without this,
  # a fresh tenant has Service-with-no-endpoints which curl reads as 000.
  if ! kctl -n "$ns" wait --for=condition=Ready pod \
       -l "platform.io/managed=true" --timeout="${timeout}s" >/dev/null 2>&1; then
    fail "no pods Ready in ${ns} after ${timeout}s"
    return 1
  fi
  # Discover the ingress-target Service: prefer the one with port 80, fall
  # back to the first Service that isn't `file-manager` (which the deployer
  # always provisions alongside the workload).
  local svc port
  svc=$(kctl -n "$ns" get svc -o json \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
for s in d.get('items', []):
    n = s['metadata']['name']
    if n == 'file-manager': continue
    ports = s.get('spec', {}).get('ports', [])
    if any(p.get('port') in (80, 8080, 443, 8443, 3000, 8000, 5000, 9000) for p in ports):
        print(n, ports[0]['port']); break
" 2>/dev/null)
  if [[ -z "$svc" ]]; then
    fail "no service found in ${ns}"
    return 1
  fi
  port="${svc##* }"; svc="${svc%% *}"
  info "probing http://${svc}.${ns}.svc:${port}${path}"

  # Probe FROM the platform-api pod via kubectl exec. Justification:
  # tenant namespaces have a ResourceQuota that demands limits.cpu /
  # limits.memory on every pod (kubectl run --image=curl... fails this),
  # plus a default-deny-ingress NetworkPolicy with `allow-platform-api`
  # carve-out — using platform-api both side-steps the quota and uses an
  # already-allowed source. wget is preinstalled in the node:22-alpine
  # image; we parse the response status from --server-response output.
  local i=0 last_code=''
  while (( i < timeout )); do
    last_code=$(kctl -n platform exec deploy/platform-api -- \
      wget -q -S -O /dev/null --timeout=10 \
      "http://${svc}.${ns}.svc.cluster.local:${port}${path}" 2>&1 \
      | grep -oE 'HTTP/[0-9.]+ [0-9]+' | head -1 | awk '{print $2}' || true)
    if [[ "${last_code}" =~ ^[0-9]+$ ]] \
       && (( last_code >= min_code )) \
       && (( last_code <= max_code )); then
      ok "HTTP ${last_code} from ${svc}.${ns}.svc:${port}${path} (after ${i}s)"
      return 0
    fi
    sleep 5
    i=$((i + 5))
  done
  fail "HTTP probe ${svc}.${ns}.svc:${port}${path} timed out after ${timeout}s (last code=${last_code:-none})"
  return 1
}

# probe_db_protocol NAMESPACE DEPL_NAME ENGINE TIMEOUT_S
# Engine: mariadb | mysql | postgresql | mongodb. Each engine ships its
# own client in the image; we exec into the deployed pod and run a one-shot
# ping. Credentials are pulled from env vars the deployer set on the pod.
probe_db_protocol() {
  local ns="$1" depl_name="$2" engine="$3" timeout="$4"
  local pod
  # The deployer labels pods with `app=<depl_name>` (component label is
  # the catalog component code, not the deployment name).
  if ! kctl -n "$ns" wait --for=condition=Ready pod \
       -l "platform.io/managed=true" --timeout="${timeout}s" >/dev/null 2>&1; then
    fail "DB pods never reached Ready in ${ns}"
    return 1
  fi
  pod=$(kctl -n "$ns" get pods -l "platform.io/managed=true" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  if [[ -z "$pod" ]]; then
    fail "DB component '${component}' has no pod"
    return 1
  fi
  case "$engine" in
    mariadb|mysql)
      if kctl -n "$ns" exec "$pod" -- sh -c \
         'mariadb-admin --protocol=tcp -h 127.0.0.1 -uroot -p"$MARIADB_ROOT_PASSWORD" ping 2>/dev/null \
          || mysqladmin --protocol=tcp -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" ping 2>/dev/null' \
         | grep -qi "alive\|mysqld is alive"; then
        ok "${engine} responding (pod=${pod})"; return 0
      fi
      ;;
    postgresql)
      if kctl -n "$ns" exec "$pod" -- sh -c \
         'pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}"' >/dev/null 2>&1; then
        ok "postgresql accepting connections (pod=${pod})"; return 0
      fi
      ;;
    mongodb)
      if kctl -n "$ns" exec "$pod" -- sh -c \
         'mongosh --quiet --eval "db.runCommand({ ping: 1 }).ok" 2>/dev/null' \
         | grep -q '^1$'; then
        ok "mongodb responding (pod=${pod})"; return 0
      fi
      ;;
    *)
      fail "Unknown DB engine: ${engine}"; return 1 ;;
  esac
  fail "${engine} probe failed in ${pod}"
  return 1
}

# probe_service_protocol NAMESPACE ENTRY_CODE TIMEOUT_S
# Service-specific protocol pings (redis, memcached, minio).
probe_service_protocol() {
  local ns="$1" code="$2" timeout="$3"
  local pod
  if ! kctl -n "$ns" wait --for=condition=Ready pod \
       -l "platform.io/managed=true" --timeout="${timeout}s" >/dev/null 2>&1; then
    fail "${code}: no pods Ready in ${timeout}s"
    return 1
  fi
  pod=$(kctl -n "$ns" get pods -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  case "$code" in
    redis-7)
      if kctl -n "$ns" exec "$pod" -- redis-cli PING 2>/dev/null | grep -q '^PONG$'; then
        ok "redis PONG (pod=${pod})"; return 0
      fi
      ;;
    memcached-alpine)
      # Memcached has no built-in CLI client in the alpine image. Use
      # a one-line netcat against 127.0.0.1:11211 with `version` cmd.
      if kctl -n "$ns" exec "$pod" -- sh -c \
         'echo "version" | nc -w2 127.0.0.1 11211 2>/dev/null' \
         | grep -qi '^VERSION '; then
        ok "memcached responding VERSION (pod=${pod})"; return 0
      fi
      ;;
    minio)
      # MinIO ships /minio/health/ready on port 9000.
      if kctl -n "$ns" exec "$pod" -- sh -c \
         'wget -q -O /dev/null --spider http://127.0.0.1:9000/minio/health/ready' >/dev/null 2>&1; then
        ok "minio /minio/health/ready 200 (pod=${pod})"; return 0
      fi
      ;;
    *)
      fail "No service protocol probe for code=${code}"; return 1 ;;
  esac
  fail "${code} service probe failed in ${pod}"
  return 1
}

# probe_stun_probe NAMESPACE TIMEOUT_S TCP_PORTS_CSV UDP_PORTS_CSV
# Sends a STUN binding request to coturn's host port. We inline a tiny
# Python script — no stun-client dep needed.
probe_stun_probe() {
  local ns="$1" timeout="$2" tcp_csv="$3" udp_csv="$4"
  if ! kctl -n "$ns" wait --for=condition=Ready pod --all --timeout="${timeout}s" >/dev/null 2>&1; then
    fail "coturn: pods not Ready"
    return 1
  fi
  # The DinD node IP from the workspace's perspective.
  local node_ip
  node_ip=$(kctl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
  [[ -n "$node_ip" ]] || { fail "coturn: cannot resolve node InternalIP"; return 1; }

  local probe_port
  probe_port="${tcp_csv%%,*}"  # take the first TCP port (3478 typically)
  python3 - "$node_ip" "$probe_port" <<'PY'
import os, socket, struct, sys
host, port = sys.argv[1], int(sys.argv[2])
# Minimal STUN Binding Request (RFC 5389): type=0x0001 length=0
# magic-cookie=0x2112A442 transaction-id=12 random bytes
tx = os.urandom(12)
msg = struct.pack('!HHI', 0x0001, 0, 0x2112A442) + tx
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(10)
    s.connect((host, port))
    s.send(msg)
    data = s.recv(64)
    s.close()
except Exception as e:
    print(f"FAIL connect/send: {e}", file=sys.stderr); sys.exit(2)
if len(data) < 8:
    print(f"FAIL short response: {len(data)} bytes", file=sys.stderr); sys.exit(3)
mtype = struct.unpack('!H', data[0:2])[0]
# 0x0101 = Binding Success Response
if mtype != 0x0101:
    print(f"FAIL bad msg type: 0x{mtype:04x}", file=sys.stderr); sys.exit(4)
print("STUN binding OK")
PY
  if [[ $? -eq 0 ]]; then
    ok "coturn STUN binding response on ${node_ip}:${probe_port}"
    return 0
  fi
  fail "coturn STUN binding failed on ${node_ip}:${probe_port}"
  return 1
}
