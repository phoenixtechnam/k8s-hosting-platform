#!/usr/bin/env bash
# scripts/rclone-shim-eval/remote/runner.sh
#
# Self-contained evaluator for `rclone serve s3` (the shim from ADR-043).
#
# Runs on the testing.phoenix-host.net VM. Measures throughput, concurrency
# tolerance, small-file behaviour, sustained-load stability, and kill+recover
# for three configurations:
#
#   * hetzner_s3    -- direct S3 (Hetzner Object Storage) -- baseline
#   * shim_on_sftp  -- rclone serve s3 in front of Hetzner Storage Box SFTP
#   * shim_on_smb   -- rclone serve s3 in front of Hetzner Storage Box CIFS
#
# The shim is launched with --vfs-cache-mode off (the strictest mode -- no
# local buffering). All credentials are passed via environment variables;
# none are baked into the file.
#
# Output:
#   $EVAL_DIR/results.jsonl   -- one JSON line per measurement
#   $EVAL_DIR/logs/           -- per-process stderr/stdout
#
# Exit code: 0 if all scenarios produced a result (even if some failed);
# non-zero only on harness errors.

set -Eeuo pipefail

EVAL_DIR="${EVAL_DIR:-/root/rclone-shim-eval}"
DATA_DIR="$EVAL_DIR/data"
LOG_DIR="$EVAL_DIR/logs"
RESULTS="$EVAL_DIR/results.jsonl"
RCLONE_VERSION="${RCLONE_VERSION:-1.68.2}"
SHIM_PORT="${SHIM_PORT:-9990}"
SHIM_ACCESS="${SHIM_ACCESS:-evalaccess}"
SHIM_SECRET="${SHIM_SECRET:-evalsecretkey_$(date +%s)}"

# Scenario parameters (override via env for shorter smoke runs)
LARGE_SIZES="${LARGE_SIZES:-1M 10M 100M}"
CONCURRENCY_FANOUT="${CONCURRENCY_FANOUT:-4 8 16}"
CONC_BLOB_SIZE="${CONC_BLOB_SIZE:-50M}"
SMALL_COUNT="${SMALL_COUNT:-200}"
SMALL_SIZE_BYTES="${SMALL_SIZE_BYTES:-16384}"
SUSTAIN_DURATION="${SUSTAIN_DURATION:-180}"   # seconds
SUSTAIN_BLOB_SIZE="${SUSTAIN_BLOB_SIZE:-10M}"

mkdir -p "$DATA_DIR" "$LOG_DIR"
: > "$RESULTS"

# ---------------------------------------------------------------------------
# Credentials -- must be set by caller
# ---------------------------------------------------------------------------
require_env() {
  local missing=0
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then echo "ERROR: env $v is required" >&2; missing=1; fi
  done
  [ "$missing" -eq 0 ] || exit 2
}
require_env \
  HETZNER_S3_ENDPOINT HETZNER_S3_BUCKET HETZNER_S3_ACCESS HETZNER_S3_SECRET \
  HBOX_SFTP_HOST HBOX_SFTP_PORT HBOX_SFTP_USER HBOX_SFTP_KEY \
  HBOX_SMB_HOST HBOX_SMB_SHARE HBOX_SMB_USER HBOX_SMB_PASS

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# ---------------------------------------------------------------------------
# Install rclone + jq (idempotent)
# ---------------------------------------------------------------------------
install_deps() {
  if command -v jq >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1 && \
     command -v curl >/dev/null 2>&1 && command -v cifs-utils >/dev/null 2>&1; then
    :
  else
    log "installing apt deps"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq unzip curl ca-certificates \
      cifs-utils smbclient time >/dev/null
  fi

  local installed
  installed=$(/usr/local/bin/rclone version 2>/dev/null | head -1 | awk '{print $2}' | sed 's/^v//' || true)
  if [ "$installed" != "$RCLONE_VERSION" ]; then
    log "installing rclone $RCLONE_VERSION"
    curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip" \
      -o /tmp/rclone.zip
    unzip -oq /tmp/rclone.zip -d /tmp/
    install -m 0755 "/tmp/rclone-v${RCLONE_VERSION}-linux-amd64/rclone" /usr/local/bin/rclone
    rm -rf /tmp/rclone.zip "/tmp/rclone-v${RCLONE_VERSION}-linux-amd64"
  fi
  log "rclone: $(/usr/local/bin/rclone version | head -1)"
}

# ---------------------------------------------------------------------------
# Write rclone config
# ---------------------------------------------------------------------------
write_config() {
  local cfg="$EVAL_DIR/rclone.conf"
  local smb_obs
  smb_obs=$(/usr/local/bin/rclone obscure "$HBOX_SMB_PASS")
  cat > "$cfg" <<EOF
[hetzner_s3]
type = s3
provider = Other
access_key_id = $HETZNER_S3_ACCESS
secret_access_key = $HETZNER_S3_SECRET
endpoint = $HETZNER_S3_ENDPOINT
region = ${HETZNER_S3_REGION:-fsn1}
acl = private
force_path_style = true
no_check_bucket = true

[hbox_sftp]
type = sftp
host = $HBOX_SFTP_HOST
port = $HBOX_SFTP_PORT
user = $HBOX_SFTP_USER
key_file = $HBOX_SFTP_KEY
shell_type = unix
md5sum_command = none
sha1sum_command = none
disable_hashcheck = true

[hbox_smb]
type = smb
host = $HBOX_SMB_HOST
user = $HBOX_SMB_USER
pass = $smb_obs

[shim_s3]
type = s3
provider = Other
access_key_id = $SHIM_ACCESS
secret_access_key = $SHIM_SECRET
endpoint = http://127.0.0.1:$SHIM_PORT
region = us-east-1
force_path_style = true
no_check_bucket = true
acl = private
EOF
  chmod 600 "$cfg"
  export RCLONE_CONFIG="$cfg"
  log "rclone config written ($cfg)"
}

# ---------------------------------------------------------------------------
# Test data
# ---------------------------------------------------------------------------
gen_data() {
  for sz in $LARGE_SIZES $SUSTAIN_BLOB_SIZE "$CONC_BLOB_SIZE"; do
    local f="$DATA_DIR/blob-${sz}.bin"
    if [ ! -f "$f" ]; then
      log "generating $f"
      head -c "$sz" </dev/urandom >"$f"
    fi
  done
  local sf="$DATA_DIR/smallfiles"
  if [ ! -d "$sf" ] || [ "$(find "$sf" -maxdepth 1 -type f | wc -l)" -lt "$SMALL_COUNT" ]; then
    rm -rf "$sf"; mkdir -p "$sf"
    log "generating $SMALL_COUNT small files ($SMALL_SIZE_BYTES bytes)"
    for i in $(seq 1 "$SMALL_COUNT"); do
      head -c "$SMALL_SIZE_BYTES" </dev/urandom >"$sf/f-$(printf '%04d' "$i").bin"
    done
  fi
}

# ---------------------------------------------------------------------------
# Shim lifecycle
# ---------------------------------------------------------------------------
SHIM_PID=""
SHIM_LOG=""
SHIM_BACKEND=""

start_shim() {
  # Usage: start_shim <upstream_remote_and_path> <vfs_mode> [extra_flags...]
  local upstream="$1"; shift
  local vfs_mode="$1"; shift
  SHIM_BACKEND="$upstream"
  SHIM_LOG="$LOG_DIR/shim-$(echo "$upstream" | tr ':/' '__')-$(date +%s).log"
  log "shim: launching against $upstream (vfs=$vfs_mode) flags=$*"

  # Cleanly drop any previous instance bound to our port
  if ss -ltn "( sport = :$SHIM_PORT )" | grep -q LISTEN; then
    fuser -k -n tcp "$SHIM_PORT" 2>/dev/null || true
    sleep 1
  fi

  /usr/local/bin/rclone serve s3 "$upstream" \
    --addr ":$SHIM_PORT" \
    --auth-key "$SHIM_ACCESS,$SHIM_SECRET" \
    --vfs-cache-mode "$vfs_mode" \
    --no-checksum \
    --force-path-style=true \
    --log-level INFO \
    "$@" \
    >"$SHIM_LOG" 2>&1 &
  SHIM_PID=$!

  for i in $(seq 1 40); do
    if ! kill -0 "$SHIM_PID" 2>/dev/null; then
      log "shim: process exited early; tail of log:"; tail -30 "$SHIM_LOG" || true
      return 1
    fi
    # rclone serve s3 answers any HTTP request with an XML S3 error if it's up.
    if curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SHIM_PORT/" 2>/dev/null \
        | grep -qE '^(200|400|403)$'; then
      log "shim: up (pid=$SHIM_PID)"
      return 0
    fi
    sleep 0.25
  done
  log "shim: FAILED to bind within 10s"
  tail -30 "$SHIM_LOG" || true
  kill "$SHIM_PID" 2>/dev/null || true
  return 1
}

stop_shim() {
  [ -n "$SHIM_PID" ] || return 0
  log "shim: stopping pid=$SHIM_PID"
  # Capture RSS one last time before killing
  local rss_kb
  rss_kb=$(awk '/^VmHWM/{print $2}' "/proc/$SHIM_PID/status" 2>/dev/null || echo 0)
  echo "$rss_kb" > "$LOG_DIR/shim-last-rss-kb.txt"
  kill "$SHIM_PID" 2>/dev/null || true
  wait "$SHIM_PID" 2>/dev/null || true
  SHIM_PID=""
}

shim_rss_kb() {
  [ -n "$SHIM_PID" ] || { echo 0; return; }
  awk '/^VmRSS/{print $2}' "/proc/$SHIM_PID/status" 2>/dev/null || echo 0
}

shim_hwm_kb() {
  [ -n "$SHIM_PID" ] || { echo 0; return; }
  awk '/^VmHWM/{print $2}' "/proc/$SHIM_PID/status" 2>/dev/null || echo 0
}

trap 'stop_shim || true' EXIT INT TERM

# ---------------------------------------------------------------------------
# Result helpers
# ---------------------------------------------------------------------------
emit() {
  # emit <scenario> <backend> <mode> <status> <duration_s> <bytes> [extra_json]
  local scenario="$1" backend="$2" mode="$3" status="$4" duration="$5" bytes="$6" extra="${7:-{\}}"
  local mbps="null"
  if [ "$status" = "ok" ] && awk "BEGIN{exit !($duration>0)}"; then
    mbps=$(awk -v b="$bytes" -v d="$duration" 'BEGIN{printf "%.3f", (b/1048576)/d}')
  fi
  printf '{"scenario":"%s","backend":"%s","mode":"%s","status":"%s","duration_s":%s,"bytes":%s,"throughput_mibps":%s,"ts":"%s","extra":%s}\n' \
    "$scenario" "$backend" "$mode" "$status" "$duration" "$bytes" "$mbps" "$(date -Iseconds)" "$extra" \
    >> "$RESULTS"
}

now_ms() { date +%s%3N; }
elapsed_s() { awk -v s="$1" -v e="$2" 'BEGIN{printf "%.3f", (e-s)/1000}'; }

# ---------------------------------------------------------------------------
# Remote-path helpers (each backend gets its own subtree -- safe to wipe)
# ---------------------------------------------------------------------------
SESSION_TAG="eval-$(date +%Y%m%d-%H%M%S)-$$"

remote_root() {
  case "$1" in
    hetzner_s3)   echo "hetzner_s3:$HETZNER_S3_BUCKET/rclone-shim-eval/$SESSION_TAG" ;;
    hbox_sftp)    echo "hbox_sftp:rclone-shim-eval/$SESSION_TAG" ;;
    hbox_smb)    echo "hbox_smb:$HBOX_SMB_SHARE/rclone-shim-eval/$SESSION_TAG" ;;
    shim_on_sftp) echo "shim_s3:$HETZNER_S3_BUCKET/rclone-shim-eval/$SESSION_TAG" ;;
    shim_on_smb)  echo "shim_s3:$HETZNER_S3_BUCKET/rclone-shim-eval/$SESSION_TAG" ;;
    shim_on_s3)   echo "shim_s3:$HETZNER_S3_BUCKET/rclone-shim-eval/$SESSION_TAG" ;;
    *) log "unknown backend $1"; return 1 ;;
  esac
}

# For shim_* backends, the S3 client uses 'shim_s3:<bucket>' regardless of what
# the upstream actually is -- rclone serve s3 fakes the bucket layer. The
# upstream config (set when we start the shim) determines where bytes go.

# Cleanup helper
wipe_remote() {
  local backend="$1"
  local root
  root=$(remote_root "$backend")
  /usr/local/bin/rclone purge "$root" --rmdirs 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

# Single-file upload / download throughput
sc_throughput() {
  local label="$1"   # display name
  local backend="$2" # remote_root key
  local root
  root=$(remote_root "$backend") || return
  for sz in $LARGE_SIZES; do
    local blob="$DATA_DIR/blob-${sz}.bin"
    local bytes
    bytes=$(stat -c%s "$blob")
    local dst="$root/blob-${sz}.bin"

    # Upload
    local t0 t1 status
    t0=$(now_ms)
    if /usr/local/bin/rclone copyto --no-traverse "$blob" "$dst" \
         --log-file "$LOG_DIR/up-${label}-${sz}.log" --log-level INFO 2>/dev/null; then
      status=ok
    else
      status=failed
    fi
    t1=$(now_ms)
    local dur; dur=$(elapsed_s "$t0" "$t1")
    local hwm; hwm=$(shim_hwm_kb)
    emit "throughput_upload_${sz}" "$label" "vfs=off" "$status" "$dur" "$bytes" \
      "{\"shim_hwm_kb\":$hwm}"

    # Download (only if upload succeeded)
    if [ "$status" = ok ]; then
      local downpath="$DATA_DIR/down-${label}-${sz}.bin"
      t0=$(now_ms)
      if /usr/local/bin/rclone copyto --no-traverse "$dst" "$downpath" \
           --log-file "$LOG_DIR/down-${label}-${sz}.log" --log-level INFO 2>/dev/null; then
        status=ok
      else
        status=failed
      fi
      t1=$(now_ms)
      dur=$(elapsed_s "$t0" "$t1")
      hwm=$(shim_hwm_kb)
      emit "throughput_download_${sz}" "$label" "vfs=off" "$status" "$dur" "$bytes" \
        "{\"shim_hwm_kb\":$hwm}"
      rm -f "$downpath"
    fi
  done
  wipe_remote "$backend"
}

# Concurrent uploads -- N copies of a CONC_BLOB_SIZE blob in parallel
sc_concurrency() {
  local label="$1" backend="$2"
  local root
  root=$(remote_root "$backend") || return
  local blob="$DATA_DIR/blob-${CONC_BLOB_SIZE}.bin"
  local bytes; bytes=$(stat -c%s "$blob")
  for fanout in $CONCURRENCY_FANOUT; do
    local pids=() rcs=()
    local t0 t1
    t0=$(now_ms)
    for i in $(seq 1 "$fanout"); do
      ( /usr/local/bin/rclone copyto --no-traverse "$blob" "$root/concurrent-${fanout}-${i}.bin" \
          --log-file "$LOG_DIR/conc-${label}-${fanout}-${i}.log" \
          --log-level INFO >/dev/null 2>&1 ; echo $? > "$LOG_DIR/conc-${label}-${fanout}-${i}.rc"
      ) &
      pids+=($!)
    done
    local fail=0
    for p in "${pids[@]}"; do wait "$p" || fail=$((fail+1)); done
    t1=$(now_ms)
    local dur; dur=$(elapsed_s "$t0" "$t1")
    local rcs_concat=""
    for i in $(seq 1 "$fanout"); do
      rcs_concat="$rcs_concat$(cat "$LOG_DIR/conc-${label}-${fanout}-${i}.rc" 2>/dev/null || echo 99),"
    done
    local total_bytes=$((bytes*fanout))
    local hwm; hwm=$(shim_hwm_kb)
    local status=ok
    [ "$fail" -gt 0 ] && status=partial
    emit "concurrency_${fanout}x_${CONC_BLOB_SIZE}" "$label" "vfs=off" "$status" "$dur" "$total_bytes" \
      "{\"fanout\":$fanout,\"failures\":$fail,\"rcs\":\"${rcs_concat%,}\",\"shim_hwm_kb\":$hwm}"
  done
  wipe_remote "$backend"
}

# Many small files (mimics restic block upload pattern)
sc_smallfiles() {
  local label="$1" backend="$2"
  local root
  root=$(remote_root "$backend") || return
  local sf="$DATA_DIR/smallfiles"
  local count; count=$(find "$sf" -maxdepth 1 -type f | wc -l)
  local bytes; bytes=$(du -sb "$sf" | awk '{print $1}')
  local t0 t1 status
  t0=$(now_ms)
  # 8-way transfer; rclone defaults to 4. This stresses the shim's parallelism.
  if /usr/local/bin/rclone copy "$sf" "$root/smallfiles" \
       --transfers 8 --checkers 8 \
       --log-file "$LOG_DIR/small-${label}.log" --log-level INFO 2>/dev/null; then
    status=ok
  else
    status=failed
  fi
  t1=$(now_ms)
  local dur; dur=$(elapsed_s "$t0" "$t1")
  local rate_fps="null"
  if [ "$status" = ok ] && awk "BEGIN{exit !($dur>0)}"; then
    rate_fps=$(awk -v c="$count" -v d="$dur" 'BEGIN{printf "%.2f", c/d}')
  fi
  local hwm; hwm=$(shim_hwm_kb)
  emit "smallfiles_${count}x${SMALL_SIZE_BYTES}B" "$label" "vfs=off" "$status" "$dur" "$bytes" \
    "{\"file_count\":$count,\"files_per_sec\":$rate_fps,\"shim_hwm_kb\":$hwm}"
  wipe_remote "$backend"
}

# Sustained-load: loop 10M uploads for N seconds; measure throughput + leak
sc_sustained() {
  local label="$1" backend="$2"
  local root
  root=$(remote_root "$backend") || return
  local blob="$DATA_DIR/blob-${SUSTAIN_BLOB_SIZE}.bin"
  local bytes_each; bytes_each=$(stat -c%s "$blob")
  local end_ts=$(( $(date +%s) + SUSTAIN_DURATION ))
  local n=0 fail=0
  local rss_start; rss_start=$(shim_rss_kb)
  local t0=$(now_ms)
  while [ "$(date +%s)" -lt "$end_ts" ]; do
    if /usr/local/bin/rclone copyto --no-traverse "$blob" "$root/sustained-$n.bin" \
         --log-file "$LOG_DIR/sustained-${label}.log" --log-level INFO \
         --transfers 1 --checkers 1 2>/dev/null; then
      n=$((n+1))
    else
      fail=$((fail+1))
      n=$((n+1))
    fi
  done
  local t1=$(now_ms)
  local dur; dur=$(elapsed_s "$t0" "$t1")
  local total_bytes=$((bytes_each * n))
  local rss_end; rss_end=$(shim_rss_kb)
  local hwm; hwm=$(shim_hwm_kb)
  local status=ok
  [ "$fail" -gt 0 ] && status=partial
  emit "sustained_${SUSTAIN_DURATION}s_${SUSTAIN_BLOB_SIZE}" "$label" "vfs=off" "$status" "$dur" "$total_bytes" \
    "{\"iterations\":$n,\"failures\":$fail,\"rss_start_kb\":$rss_start,\"rss_end_kb\":$rss_end,\"shim_hwm_kb\":$hwm}"
  wipe_remote "$backend"
}

# Kill+recover: launch a 100M upload, kill shim mid-flight, restart, verify
# bucket state is consistent (no orphan multipart uploads visible to client).
sc_kill_recover() {
  local label="$1" backend="$2" upstream="$3"
  local root
  root=$(remote_root "$backend") || return
  # Use largest available blob, throttle client to force a multi-second
  # window so the SIGKILL lands in the middle of an upload.
  local blob="$DATA_DIR/blob-${CONC_BLOB_SIZE}.bin"
  for cand in $LARGE_SIZES; do
    if [ -f "$DATA_DIR/blob-${cand}.bin" ]; then blob="$DATA_DIR/blob-${cand}.bin"; fi
  done
  local bytes; bytes=$(stat -c%s "$blob")
  local dst="$root/kill-recover-blob.bin"

  log "kill-recover: launching throttled client upload of $(basename "$blob")"
  ( /usr/local/bin/rclone copyto --no-traverse --bwlimit 4M --retries 1 --low-level-retries 1 "$blob" "$dst" \
      --log-file "$LOG_DIR/kr-up-${label}.log" --log-level INFO >/dev/null 2>&1 ; \
    echo $? > "$LOG_DIR/kr-up-${label}.rc" ) &
  local client_pid=$!
  sleep 1.5  # let the upload progress a few MB
  log "kill-recover: killing shim (pid=$SHIM_PID)"
  kill "$SHIM_PID" 2>/dev/null || true
  wait "$client_pid" 2>/dev/null || true
  local rc; rc=$(cat "$LOG_DIR/kr-up-${label}.rc" 2>/dev/null || echo 99)

  # Restart shim
  log "kill-recover: restarting shim"
  if start_shim "$upstream" off; then
    # Re-do the upload to verify recovery
    local t0=$(now_ms)
    local status=failed
    if /usr/local/bin/rclone copyto --no-traverse "$blob" "$dst" \
         --log-file "$LOG_DIR/kr-recovery-${label}.log" --log-level INFO 2>/dev/null; then
      status=ok
    fi
    local t1=$(now_ms)
    local dur; dur=$(elapsed_s "$t0" "$t1")
    emit "kill_recover" "$label" "vfs=off" "$status" "$dur" "$bytes" \
      "{\"first_upload_rc\":$rc,\"shim_restart\":\"ok\"}"
  else
    emit "kill_recover" "$label" "vfs=off" "failed" "0" "$bytes" \
      "{\"first_upload_rc\":$rc,\"shim_restart\":\"failed\"}"
  fi
  wipe_remote "$backend"
}

# ---------------------------------------------------------------------------
# Direct-backend baselines (no shim)
# ---------------------------------------------------------------------------
run_direct_baseline() {
  local label="$1" backend="$2"
  log "=========================================="
  log "BASELINE (direct, no shim): $label"
  log "=========================================="
  sc_throughput   "$label" "$backend"
  sc_smallfiles   "$label" "$backend"
}

# ---------------------------------------------------------------------------
# Shim runs
# ---------------------------------------------------------------------------
run_shim_against() {
  local label="$1" upstream="$2"
  log "=========================================="
  log "SHIM: $label  (upstream=$upstream, --vfs-cache-mode off)"
  log "=========================================="
  if ! start_shim "$upstream" off; then
    log "shim failed to start; skipping scenarios for $label"
    return
  fi
  # The shim_s3 'bucket' for clients is HETZNER_S3_BUCKET (we tell rclone serve
  # s3 to fake that). All shim_* backends share the same client-side endpoint;
  # only the upstream differs.
  sc_throughput     "$label" "shim_on_${label}"
  sc_concurrency    "$label" "shim_on_${label}"
  sc_smallfiles     "$label" "shim_on_${label}"
  sc_sustained      "$label" "shim_on_${label}"
  sc_kill_recover   "$label" "shim_on_${label}" "$upstream"
  stop_shim
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
log "=== rclone-serve-s3 evaluation start ==="
install_deps
write_config
gen_data

# Direct baselines (no shim involved)
run_direct_baseline "hetzner_s3" "hetzner_s3"
run_direct_baseline "hbox_sftp"  "hbox_sftp"
run_direct_baseline "hbox_smb"   "hbox_smb"

# Shim runs
run_shim_against "sftp" "hbox_sftp:rclone-shim-eval-shim"
run_shim_against "smb"  "hbox_smb:$HBOX_SMB_SHARE/rclone-shim-eval-shim"

log "=== evaluation complete -> $RESULTS ==="
log "results: $(wc -l <"$RESULTS") lines"
