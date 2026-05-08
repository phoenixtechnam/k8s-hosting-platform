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

# probe_http_ingress NAMESPACE PATH MIN_CODE MAX_CODE TIMEOUT_S [ENTRY_CODE]
# Curls the deployed Service from inside the tenant namespace using a
# transient pod, asserting the response code is in [MIN_CODE, MAX_CODE].
# ENTRY_CODE (optional) is the catalog entry's code — when given, the
# probe prefers the Service labelled `component=<ENTRY_CODE>`. For
# multi-component apps (nextcloud, jitsi, immich, ...) the entry-code
# component is the ingress target by convention; without this hint the
# probe sometimes lands on a sidecar (collabora, redis, etc.).
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
  local ns="$1" path="$2" min_code="$3" max_code="$4" timeout="$5" code="${6:-}"
  # Wait for any pod in the namespace to be Ready first — without this,
  # a fresh tenant has Service-with-no-endpoints which curl reads as 000.
  if ! kctl -n "$ns" wait --for=condition=Ready pod \
       -l "platform.io/managed=true" --timeout="${timeout}s" >/dev/null 2>&1; then
    fail "no pods Ready in ${ns} after ${timeout}s"
    return 1
  fi
  # Discover the ingress-target Service. The deployer creates one Service
  # per component, including DB/cache/object-store sidecars (mariadb,
  # postgresql, redis, mongodb, collabora, etc.) — none of which serve
  # HTTP on the port the catalog declares as the ingress target.
  #
  # Selection priority:
  #   1) Service labelled `component=<entry_code>` (exact — primary for
  #      most multi-component apps)
  #   2) Service labelled `component=<entry_code>-server` or starting with
  #      `<entry_code>-` (covers immich → immich-server, etc.)
  #   3) Otherwise, first non-file-manager Service whose port is NOT in
  #      the known DB/cache backend allowlist
  local svc port
  svc=$(kctl -n "$ns" get svc -o json \
    | CODE="$code" python3 -c "
import json, os, sys
code = os.environ.get('CODE') or ''
DB_PORTS = {3306, 5432, 27017, 6379, 11211, 5984, 9092, 9980, 25, 53, 9001}
items = json.load(sys.stdin).get('items', [])
def get_comp(s): return s.get('metadata', {}).get('labels', {}).get('component') or ''
def first_port(s):
    ports = s.get('spec', {}).get('ports', [])
    return ports[0]['port'] if ports else None
# pass 1: exact component=<code>
if code:
    for s in items:
        if get_comp(s) == code and first_port(s):
            print(s['metadata']['name'], first_port(s)); sys.exit(0)
# pass 2: component=<code>-server or component starting with <code>-
if code:
    candidates = [s for s in items if get_comp(s).startswith(code + '-') and first_port(s)]
    # Prefer -server suffix when present
    for s in candidates:
        if get_comp(s) == code + '-server':
            print(s['metadata']['name'], first_port(s)); sys.exit(0)
    if candidates:
        s = candidates[0]
        print(s['metadata']['name'], first_port(s)); sys.exit(0)
# pass 3: first non-file-manager non-backend Service
for s in items:
    n = s['metadata']['name']
    if n == 'file-manager': continue
    ports = s.get('spec', {}).get('ports', [])
    if not ports: continue
    if all(p.get('port') in DB_PORTS for p in ports): continue
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
  # Retry the protocol ping for up to 90s — kubectl wait Ready returns as
  # soon as the container is alive, but the DB needs another 5-30s to
  # initialize its data directory + bind to the network port on first run.
  # A single-shot probe races that startup window.
  local i=0
  while (( i < 90 )); do
    case "$engine" in
      mariadb|mysql)
        if kctl -n "$ns" exec "$pod" -c "$engine" -- sh -c \
           'mariadb-admin --protocol=tcp -h 127.0.0.1 -uroot -p"$MARIADB_ROOT_PASSWORD" ping 2>/dev/null \
            || mysqladmin --protocol=tcp -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" ping 2>/dev/null' \
           2>/dev/null | grep -qi "alive\|mysqld is alive"; then
          ok "${engine} responding (pod=${pod}, after ${i}s)"; return 0
        fi
        ;;
      postgresql)
        if kctl -n "$ns" exec "$pod" -c postgresql -- sh -c \
           'pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}"' >/dev/null 2>&1; then
          ok "postgresql accepting connections (pod=${pod}, after ${i}s)"; return 0
        fi
        ;;
      mongodb)
        # mongosh inside kubectl exec hangs reliably on the mongo:7 image.
        # bash /dev/tcp is the simplest "is the port accepting?" probe —
        # the mongo container has bash (not dash), so explicitly invoke
        # bash, not sh.
        if kctl -n "$ns" exec "$pod" -c mongodb-7 --request-timeout=15s -- bash -c \
           'timeout 5 bash -c "echo > /dev/tcp/127.0.0.1/27017" 2>/dev/null && echo OK' \
           | grep -q '^OK$'; then
          ok "mongodb listening on 27017 (pod=${pod}, after ${i}s)"; return 0
        fi
        ;;
      *)
        fail "Unknown DB engine: ${engine}"; return 1 ;;
    esac
    sleep 5
    i=$((i + 5))
  done
  fail "${engine} probe failed in ${pod} after ${i}s"
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
      # minio image (RELEASE.*) has no wget/curl/nc. Use bash /dev/tcp.
      if kctl -n "$ns" exec "$pod" -c minio --request-timeout=15s -- bash -c \
         'timeout 5 bash -c "echo > /dev/tcp/127.0.0.1/9000" 2>/dev/null && echo OK' \
         | grep -q '^OK$'; then
        ok "minio listening on 9000 (pod=${pod})"; return 0
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
