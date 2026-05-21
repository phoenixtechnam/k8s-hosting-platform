#!/usr/bin/env bash
# Driver: build a backup target on staging, bind a class to it, wait
# for the shim DaemonSet to roll, run bench.py from a probe pod,
# capture shim RSS+CPU samples, tear down.
#
# Usage: run.sh <backend> [<config-args...>]
#   backend ∈ {s3, sftp, cifs, nfs}
set -euo pipefail

BACKEND="${1:?backend required}"
shift || true

case "$BACKEND" in
  s3|sftp|cifs|nfs) ;;
  *) echo "unsupported backend '$BACKEND'; expected one of s3|sftp|cifs|nfs" >&2; exit 2 ;;
esac

SSH="ssh -i $HOME/hosting-platform.key -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@staging1.phoenix-host.net"
RESULTS=/tmp/bench-shim-results
mkdir -p "$RESULTS"
OUT="$RESULTS/${BACKEND}-$(date +%Y%m%dT%H%M%S).jsonl"

log() { printf '[bench-driver %s] %s\n' "$BACKEND" "$*" >&2; }

# ── 0. NFS: seed the staging in-cluster test target (idempotent) ──────
# Other backends require the operator to have already configured the
# target via the admin panel; NFS bench targets nfs-test-server in
# the platform namespace so we seed it here.
if [[ "$BACKEND" == "nfs" ]]; then
  HERE="$(cd "$(dirname "$0")" && pwd)"
  "$HERE/seed-nfs-target.sh"
fi

# ── 1. shim ready? class bound to backend? ────────────────────────────
log "checking shim DaemonSet state…"
$SSH "kubectl -n platform get ds backup-rclone-shim -o jsonpath='{.status.numberReady}/{.status.desiredNumberScheduled} ready'"
$SSH "kubectl -n platform get cm backup-rclone-shim-status -o jsonpath='{.data.state}'"

# ── 2. RSS sampler in background ──────────────────────────────────────
SHIM_POD=$($SSH "kubectl -n platform get pod -l app=backup-rclone-shim --field-selector status.phase=Running -o jsonpath='{.items[0].metadata.name}'")
log "shim pod: $SHIM_POD"
SAMPLER_PID=""
(
  while :; do
    rss=$($SSH "kubectl -n platform exec $SHIM_POD -- cat /proc/1/status 2>/dev/null | awk '/VmRSS/{print \$2}'" 2>/dev/null || echo "")
    [ -n "$rss" ] && printf '{"sample":"rss","epoch":%d,"rss_kb":%s,"pod":"%s"}\n' "$(date +%s)" "$rss" "$SHIM_POD"
    sleep 2
  done
) > "${OUT%.jsonl}-rss.jsonl" &
SAMPLER_PID=$!
trap 'kill $SAMPLER_PID 2>/dev/null || true' EXIT

# ── 3. Spawn benchmark pod ────────────────────────────────────────────
log "spawning benchmark pod…"
SHIM_AK=$($SSH "kubectl -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.access_key}' | base64 -d")
SHIM_SK=$($SSH "kubectl -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.secret_key}' | base64 -d")

scp -i $HOME/hosting-platform.key -o StrictHostKeyChecking=no \
  /workspace/k8s-hosting-platform/scripts/bench-shim/bench.py \
  root@staging1.phoenix-host.net:/tmp/bench.py >/dev/null

$SSH "kubectl -n platform delete pod bench-shim --ignore-not-found --force --grace-period=0 >/dev/null 2>&1; cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: bench-shim
  labels: { app: bench-shim }
spec:
  restartPolicy: Never
  containers:
  - name: bench
    image: python:3-slim
    resources: { limits: { cpu: '1', memory: 256Mi }, requests: { cpu: 100m, memory: 64Mi } }
    env:
    - name: SHIM_ENDPOINT
      value: http://backup-rclone-shim.platform.svc.cluster.local:9000
    - name: SHIM_ACCESS_KEY
      value: $SHIM_AK
    - name: SHIM_SECRET_KEY
      value: $SHIM_SK
    - name: BACKEND_LABEL
      value: $BACKEND
    - name: BENCH_BUCKET
      value: system
    command: [sh, -c, 'sleep 7200']
EOF
"

# Wait for pod Ready
for _ in $(seq 1 30); do
  ready=$($SSH "kubectl -n platform get pod bench-shim -o jsonpath='{.status.containerStatuses[0].ready}'" 2>/dev/null || echo "false")
  [ "$ready" = "true" ] && break
  sleep 2
done

# ── 4. NetworkPolicy unblock for bench pod ───────────────────────────
$SSH "cat <<EOF | kubectl -n platform apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: bench-shim-allow }
spec:
  podSelector: { matchLabels: { app: bench-shim } }
  policyTypes: [Ingress, Egress]
  ingress: [{}]
  egress: [{}]
EOF
" >/dev/null

# ── 5. Install boto3 + run bench ─────────────────────────────────────
$SSH "kubectl -n platform cp /tmp/bench.py bench-shim:/tmp/bench.py" >/dev/null
$SSH "kubectl -n platform exec bench-shim -- sh -c 'pip install boto3 -q 2>&1 | tail -1; python3 /tmp/bench.py'" \
  | tee "$OUT"

# ── 6. Teardown ──────────────────────────────────────────────────────
$SSH "kubectl -n platform delete pod bench-shim --force --grace-period=0 >/dev/null 2>&1; kubectl -n platform delete networkpolicy bench-shim-allow --ignore-not-found >/dev/null 2>&1"

kill $SAMPLER_PID 2>/dev/null || true
log "done — results: $OUT  rss-samples: ${OUT%.jsonl}-rss.jsonl"
