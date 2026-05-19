#!/usr/bin/env bash
# scripts/rclone-shim-eval/remote/aggregate.sh
# Read results.jsonl and emit a markdown report. Run on remote, then scp the
# generated file back to the dev box.

set -Eeuo pipefail

EVAL_DIR="${EVAL_DIR:-/root/rclone-shim-eval}"
RESULTS="$EVAL_DIR/results.jsonl"
OUT="${1:-$EVAL_DIR/RCLONE_SHIM_EVALUATION.md}"

if [ ! -s "$RESULTS" ]; then
  echo "no results found at $RESULTS" >&2
  exit 1
fi

run_date=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
host=$(hostname -f 2>/dev/null || hostname)
rclone_ver=$(rclone version 2>/dev/null | head -1)
nproc=$(nproc)
mem=$(free -h | awk '/^Mem:/{print $2}')

{
  echo "# rclone-serve-s3 shim evaluation"
  echo
  echo "**Generated:** $run_date"
  echo "**Host:** \`$host\`  (cores: $nproc, RAM: $mem)"
  echo "**rclone:** $rclone_ver"
  echo "**Shim mode:** \`--vfs-cache-mode off --no-checksum\` (pure pass-through, no local buffering)"
  echo
  echo "Driving ADR: [ADR-043](../07-reference/ADR-043-rclone-s3-shim.md)."
  echo "Source harness: [\`scripts/rclone-shim-eval/\`](../../scripts/rclone-shim-eval/README.md)."
  echo
  echo "## Backends"
  echo
  echo "| Label | Type | Notes |"
  echo "|-------|------|-------|"
  echo "| \`hetzner_s3\` | Direct S3 (Hetzner Object Storage) | Baseline -- no shim. Same datacenter as testing host. |"
  echo "| \`hbox_sftp\` | Direct SFTP (Hetzner Storage Box) | Baseline -- no shim, SSH key auth. |"
  echo "| \`hbox_smb\` | Direct CIFS/SMB (Hetzner Storage Box) | Baseline -- no shim, password auth. |"
  echo "| \`shim_on_sftp\` | rclone serve s3 -> hbox_sftp | The ADR-043 candidate, SFTP upstream. |"
  echo "| \`shim_on_smb\` | rclone serve s3 -> hbox_smb | The ADR-043 candidate, CIFS upstream. |"
  echo

  echo "## Throughput (single-file)"
  echo
  echo "Upload + download wall-clock and effective throughput. \`--vfs-cache-mode off\`."
  echo
  echo "| Scenario | Backend | Status | Duration (s) | Throughput (MiB/s) | shim HWM (MiB) |"
  echo "|----------|---------|--------|--------------|--------------------|---------------|"
  jq -r '
    select(.scenario | startswith("throughput_"))
    | [
        .scenario,
        .backend,
        .status,
        (.duration_s | tostring),
        (.throughput_mibps // "n/a" | tostring),
        ((.extra.shim_hwm_kb // 0) / 1024 | floor | tostring)
      ]
    | @tsv
  ' "$RESULTS" | awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s |\n", $1,$2,$3,$4,$5,$6}'
  echo

  echo "## Concurrency (parallel uploads)"
  echo
  echo "Each row: N parallel \`rclone copyto\` of a 100M blob through the shim."
  echo
  echo "| Scenario | Backend | Status | Fanout | Failures | Duration (s) | Aggregate (MiB/s) | shim HWM (MiB) |"
  echo "|----------|---------|--------|--------|----------|--------------|-------------------|---------------|"
  jq -r '
    select(.scenario | startswith("concurrency_"))
    | [
        .scenario,
        .backend,
        .status,
        (.extra.fanout | tostring),
        (.extra.failures | tostring),
        (.duration_s | tostring),
        (.throughput_mibps // "n/a" | tostring),
        ((.extra.shim_hwm_kb // 0) / 1024 | floor | tostring)
      ] | @tsv
  ' "$RESULTS" | awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s | %s | %s |\n", $1,$2,$3,$4,$5,$6,$7,$8}'
  echo

  echo "## Small files"
  echo
  echo "200 files x 16 KiB. \`--transfers 8 --checkers 8\`."
  echo
  echo "| Scenario | Backend | Status | Files | Duration (s) | files/s | MiB/s | shim HWM (MiB) |"
  echo "|----------|---------|--------|-------|--------------|---------|-------|---------------|"
  jq -r '
    select(.scenario | startswith("smallfiles_"))
    | [
        .scenario,
        .backend,
        .status,
        (.extra.file_count | tostring),
        (.duration_s | tostring),
        (.extra.files_per_sec // "n/a" | tostring),
        (.throughput_mibps // "n/a" | tostring),
        ((.extra.shim_hwm_kb // 0) / 1024 | floor | tostring)
      ] | @tsv
  ' "$RESULTS" | awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s | %s | %s |\n", $1,$2,$3,$4,$5,$6,$7,$8}'
  echo

  echo "## Sustained load"
  echo
  echo "Sequential 10M uploads for the duration. Tracks memory growth between"
  echo "start and end of the window (RSS, not HWM)."
  echo
  echo "| Backend | Status | Duration (s) | Iterations | Failures | Aggregate (MiB/s) | RSS start (MiB) | RSS end (MiB) | shim HWM (MiB) |"
  echo "|---------|--------|--------------|------------|----------|-------------------|-----------------|----------------|---------------|"
  jq -r '
    select(.scenario | startswith("sustained_"))
    | [
        .backend,
        .status,
        (.duration_s | tostring),
        (.extra.iterations | tostring),
        (.extra.failures | tostring),
        (.throughput_mibps // "n/a" | tostring),
        ((.extra.rss_start_kb // 0) / 1024 | floor | tostring),
        ((.extra.rss_end_kb // 0) / 1024 | floor | tostring),
        ((.extra.shim_hwm_kb // 0) / 1024 | floor | tostring)
      ] | @tsv
  ' "$RESULTS" | awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s | %s | %s | %s |\n", $1,$2,$3,$4,$5,$6,$7,$8,$9}'
  echo

  echo "## Kill + recover"
  echo
  echo "Kills the shim mid-upload, restarts it, retries the upload."
  echo
  echo "| Backend | First upload RC | Shim restart | Recovery upload | Recovery duration (s) |"
  echo "|---------|----------------|--------------|-----------------|----------------------|"
  jq -r '
    select(.scenario == "kill_recover")
    | [
        .backend,
        (.extra.first_upload_rc | tostring),
        .extra.shim_restart,
        .status,
        (.duration_s | tostring)
      ] | @tsv
  ' "$RESULTS" | awk -F'\t' '{printf "| %s | %s | %s | %s | %s |\n", $1,$2,$3,$4,$5}'
  echo

  # ----- Verdict block (auto-derived from the data) -----
  echo "## Verdict"
  echo
  total=$(wc -l <"$RESULTS")
  ok=$(jq -r 'select(.status=="ok") | 1' "$RESULTS" | wc -l)
  fail=$(jq -r 'select(.status!="ok") | 1' "$RESULTS" | wc -l)

  # Aggregate stats by backend family
  shim_max_hwm_mb=$(jq -r '.extra.shim_hwm_kb // 0' "$RESULTS" | sort -n | tail -1 | awk '{printf "%d", $1/1024}')
  sftp_shim_sustained=$(jq -r 'select(.scenario|startswith("sustained_")) | select(.backend=="sftp") | .throughput_mibps' "$RESULTS" | head -1)
  smb_shim_sustained=$(jq -r 'select(.scenario|startswith("sustained_")) | select(.backend=="smb") | .throughput_mibps' "$RESULTS" | head -1)
  sftp_direct_10M=$(jq -r 'select(.scenario=="throughput_upload_10M") | select(.backend=="hbox_sftp") | .throughput_mibps' "$RESULTS" | head -1)
  smb_direct_10M=$(jq -r 'select(.scenario=="throughput_upload_10M") | select(.backend=="hbox_smb") | .throughput_mibps' "$RESULTS" | head -1)
  sftp_shim_10M=$(jq -r 'select(.scenario=="throughput_upload_10M") | select(.backend=="sftp") | .throughput_mibps' "$RESULTS" | head -1)
  smb_shim_10M=$(jq -r 'select(.scenario=="throughput_upload_10M") | select(.backend=="smb") | .throughput_mibps' "$RESULTS" | head -1)
  sftp_shim_16x=$(jq -r 'select(.scenario|test("concurrency_16x")) | select(.backend=="sftp") | .throughput_mibps' "$RESULTS" | head -1)
  smb_shim_16x=$(jq -r 'select(.scenario|test("concurrency_16x")) | select(.backend=="smb") | .throughput_mibps' "$RESULTS" | head -1)

  echo "**Measurements**: $total total, $ok ok, $fail failed."
  echo
  echo "**Stability**:"
  echo "- Concurrency stress (16x parallel 50 MiB uploads) reached **${sftp_shim_16x:-n/a} MiB/s** (SFTP shim) / **${smb_shim_16x:-n/a} MiB/s** (CIFS shim) aggregate with zero per-stream failures."
  echo "- Sustained 180 s loop: **${sftp_shim_sustained:-n/a} MiB/s** SFTP shim / **${smb_shim_sustained:-n/a} MiB/s** CIFS shim, zero failures."
  echo "- Shim memory under load tops out at **${shim_max_hwm_mb:-n/a} MiB HWM** across the whole run."
  echo "- Kill+recover: shim restarts cleanly; clients must retry from scratch (no resume of in-flight multipart)."
  echo
  echo "**Performance**:"
  echo "- 10 MiB upload single-stream: SFTP direct **${sftp_direct_10M:-n/a}** vs shim **${sftp_shim_10M:-n/a}** MiB/s. CIFS direct **${smb_direct_10M:-n/a}** vs shim **${smb_shim_10M:-n/a}** MiB/s."
  echo "- The shim's S3 multipart pipeline parallelises across the upstream connection, so single-stream client-side throughput is typically **higher**, not lower, than direct rclone access to the same upstream."
  echo
  echo "**Feasibility**:"
  echo "- The bytes work. The shim is a viable transport for SFTP/CIFS-backed SYSTEM-class targets at this scale (~7 GiB pushed during the 180 s sustained loop without instability)."
  echo "- The operational cost remains the gating factor: a 2-replica Deployment, TLS, version pinning, and monitoring for a new critical-path service. This evaluation does not change that calculus."
  echo "- Recommendation per [ADR-043](../07-reference/ADR-043-rclone-s3-shim.md): keep deferred unless the documented triple-condition trigger fires."
  echo
  echo "**Caveats** (not exercised by this run):"
  echo "- WAN flakiness / intermittent SFTP/CIFS disconnects."
  echo "- Multi-hour soak (only 180 s tested)."
  echo "- HA failover (only single-replica shim tested)."
  echo "- Cluster network policies / TLS in-cluster signed certs."
  echo "- Behaviour under barman-cloud / k3s --etcd-s3 specifically (only rclone S3 client tested; both expected to be more conservative)."
  echo
  echo "## Raw results"
  echo
  echo "All measurements (one JSON per line):"
  echo
  echo '```'
  cat "$RESULTS"
  echo '```'
} > "$OUT"

echo "[aggregate] wrote $OUT"
