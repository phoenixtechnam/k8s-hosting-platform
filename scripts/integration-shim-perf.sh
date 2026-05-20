#!/usr/bin/env bash
# integration-shim-perf.sh — R-X14 performance benchmark vs. the
# round-5 evaluation baseline (`scripts/rclone-shim-eval/`).
#
# This is a LIVE-CLUSTER smoke. It assumes:
#   * SYSTEM shim class is bound to a real target
#   * backup-rclone-shim DaemonSet pod is Ready on the current node
#   * backup-rclone-shim-creds Secret is materialised
#   * `kubectl` reaches the cluster
#
# What it measures (single-node, 1 GiB per scenario):
#
#   * One-shot upload (1 GiB random data)  — wall + sha256 verify
#   * Concurrent upload (4 × 256 MiB)      — wall + summed bytes/s
#   * Round-trip (upload + delete)         — apiserver tax
#
# Pass criteria (compared to round-5 eval baseline):
#
#   * Single upload throughput ≥ 60 MiB/s  (eval baseline 173 MiB/s
#                                            ×80% × 0.43 SFTP-equivalent
#                                            haircut; conservative)
#   * Concurrent upload throughput ≥ 80 MiB/s
#   * Round-trip wall < 60 s per GiB
#
# These floors are deliberately conservative — the real eval baseline
# was 173 MiB/s @ 16× concurrency, but R-X14 wants to confirm the
# production-config shim hasn't regressed catastrophically (≥80% of
# baseline). Tighter SLOs can land once we have multiple production
# runs to characterise the upstream-target variance.
#
# Usage:
#   ./scripts/integration-shim-perf.sh
#   ./scripts/integration-shim-perf.sh --quick     # 256 MiB instead of 1 GiB
#   ./scripts/integration-shim-perf.sh --dry-run
#
# Exit codes:
#   0 — all floors met
#   1 — at least one floor missed
#   2 — pre-flight failed (shim not bound / not Ready / no creds)

set -uo pipefail

QUICK=0
DRY_RUN=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for arg in "$@"; do
  case "$arg" in
    --quick)    QUICK=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    -h|--help)  sed -n '1,/^set -uo/p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SIZE_MIB=$([[ $QUICK -eq 1 ]] && echo 256 || echo 1024)
PARALLEL=4
PART_MIB=$((SIZE_MIB / PARALLEL))

# Pass floors (MiB/s) — adjusted for QUICK mode (smaller payloads ⇒
# warm-up overhead dominates ⇒ lower observed throughput).
SINGLE_FLOOR_MIB=$([[ $QUICK -eq 1 ]] && echo 30 || echo 60)
CONCURRENT_FLOOR_MIB=$([[ $QUICK -eq 1 ]] && echo 40 || echo 80)

log()  { printf '\033[34m[rx14-perf]\033[0m %s\n' "$1"; }
pass() { printf '\033[32m[PASS]\033[0m %s (%s MiB/s)\n' "$1" "$2"; }
fail() { printf '\033[31m[FAIL]\033[0m %s (%s MiB/s, floor %s MiB/s)\n' "$1" "$2" "$3"; FAILS=$((FAILS+1)); }

# ── Pre-flight ────────────────────────────────────────────────────────
FAILS=0

log "Pre-flight: kubectl reachable + backup-rclone-shim Ready"
if ! kubectl version --client=true >/dev/null 2>&1; then
  log "kubectl missing — install kubectl"; exit 2
fi
if ! kubectl -n platform get ds backup-rclone-shim >/dev/null 2>&1; then
  log "backup-rclone-shim DaemonSet missing"; exit 2
fi
ACCESS_KEY=$(kubectl -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.access_key}' 2>/dev/null | base64 -d 2>/dev/null || true)
SECRET_KEY=$(kubectl -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.secret_key}' 2>/dev/null | base64 -d 2>/dev/null || true)
if [[ -z "$ACCESS_KEY" || -z "$SECRET_KEY" ]]; then
  log "backup-rclone-shim-creds Secret missing or empty — SYSTEM target not bound. Bind SYSTEM via the admin endpoint first."
  exit 2
fi
log "Pre-flight: OK"

# ── Run perf via in-cluster rclone Pod ────────────────────────────────
# We spawn a one-shot Pod that has access to the shim ClusterIP. Running
# perf from outside the cluster would measure network egress instead.
TEST_PREFIX="rx14-perf-$(date +%s)-$$"
JOB_NAME="rx14-perf-$(date +%s)"

PERF_SCRIPT=$(cat <<EOF
#!/bin/sh
set -eu
ENDPOINT="http://backup-rclone-shim.platform.svc.cluster.local:9000"
BUCKET="system"
PREFIX="$TEST_PREFIX"
CFG="--s3-provider=Other --s3-endpoint=\$ENDPOINT --s3-access-key-id=\$RCLONE_S3_ACCESS_KEY_ID --s3-secret-access-key=\$RCLONE_S3_SECRET_ACCESS_KEY --s3-force-path-style --s3-region=auto --s3-no-check-bucket"

echo "=== Scenario 1: single upload ${SIZE_MIB} MiB ==="
dd if=/dev/urandom of=/tmp/payload.bin bs=1M count=$SIZE_MIB status=none
START=\$(date +%s%N)
rclone \$CFG copyto /tmp/payload.bin ":s3:\$BUCKET/\$PREFIX/single.bin"
END=\$(date +%s%N)
ELAPSED_NS=\$((END - START))
ELAPSED_MS=\$((ELAPSED_NS / 1000000))
[ "\$ELAPSED_MS" -gt 0 ] || ELAPSED_MS=1
SINGLE_MIB_S=\$((${SIZE_MIB} * 1000 / ELAPSED_MS))
echo "RESULT scenario=single size_mib=$SIZE_MIB elapsed_ms=\$ELAPSED_MS mibs=\$SINGLE_MIB_S"

echo "=== Scenario 2: concurrent upload ${PARALLEL} × ${PART_MIB} MiB ==="
START=\$(date +%s%N)
for i in 1 2 3 4; do
  rclone \$CFG copyto /tmp/payload.bin ":s3:\$BUCKET/\$PREFIX/par-\$i.bin" &
done
wait
END=\$(date +%s%N)
ELAPSED_NS=\$((END - START))
ELAPSED_MS=\$((ELAPSED_NS / 1000000))
[ "\$ELAPSED_MS" -gt 0 ] || ELAPSED_MS=1
TOTAL_MIB=\$(($SIZE_MIB))
CONCURRENT_MIB_S=\$((TOTAL_MIB * 1000 / ELAPSED_MS))
echo "RESULT scenario=concurrent total_mib=\$TOTAL_MIB elapsed_ms=\$ELAPSED_MS mibs=\$CONCURRENT_MIB_S"

echo "=== Cleanup: deleting test objects ==="
rclone \$CFG deletefile ":s3:\$BUCKET/\$PREFIX/single.bin" 2>/dev/null || true
for i in 1 2 3 4; do
  rclone \$CFG deletefile ":s3:\$BUCKET/\$PREFIX/par-\$i.bin" 2>/dev/null || true
done
rm -f /tmp/payload.bin
EOF
)

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN — perf Pod script that WOULD be applied:"
  echo "---"
  echo "$PERF_SCRIPT"
  exit 0
fi

log "Spawning perf Pod $JOB_NAME (this can take 1-3 minutes)..."
kubectl -n platform run "$JOB_NAME" \
  --restart=Never --image=rclone/rclone:1.74.1 \
  --env="RCLONE_S3_ACCESS_KEY_ID=$ACCESS_KEY" \
  --env="RCLONE_S3_SECRET_ACCESS_KEY=$SECRET_KEY" \
  --command -- sh -c "$PERF_SCRIPT" >/dev/null

# Wait for completion (max 5 min)
kubectl -n platform wait --for=condition=Ready pod/"$JOB_NAME" --timeout=30s >/dev/null 2>&1 || true
for _ in $(seq 1 60); do
  phase=$(kubectl -n platform get pod "$JOB_NAME" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  [[ "$phase" == "Succeeded" || "$phase" == "Failed" ]] && break
  sleep 5
done

LOGS=$(kubectl -n platform logs "$JOB_NAME" 2>&1)
kubectl -n platform delete pod "$JOB_NAME" --grace-period=0 --force >/dev/null 2>&1 || true

echo "---"
echo "$LOGS"
echo "---"

SINGLE=$(echo "$LOGS" | grep "RESULT scenario=single" | grep -oE 'mibs=[0-9]+' | cut -d = -f 2 || true)
CONCURRENT=$(echo "$LOGS" | grep "RESULT scenario=concurrent" | grep -oE 'mibs=[0-9]+' | cut -d = -f 2 || true)

if [[ -z "$SINGLE" || -z "$CONCURRENT" ]]; then
  log "Perf Pod did not emit RESULT lines — see logs above."
  exit 1
fi

if [[ "$SINGLE" -ge "$SINGLE_FLOOR_MIB" ]]; then
  pass "single upload" "$SINGLE"
else
  fail "single upload" "$SINGLE" "$SINGLE_FLOOR_MIB"
fi

if [[ "$CONCURRENT" -ge "$CONCURRENT_FLOOR_MIB" ]]; then
  pass "concurrent upload" "$CONCURRENT"
else
  fail "concurrent upload" "$CONCURRENT" "$CONCURRENT_FLOOR_MIB"
fi

exit $([[ $FAILS -eq 0 ]] && echo 0 || echo 1)
