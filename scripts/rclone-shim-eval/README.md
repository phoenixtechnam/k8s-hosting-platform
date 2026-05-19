# rclone-serve-s3 shim evaluation

Empirical evaluator for the `rclone serve s3` shim documented in [ADR-043](../../docs/07-reference/ADR-043-rclone-s3-shim.md). The ADR defers shipping the shim for v1; this harness produces numbers that either confirm that decision or trigger a revisit.

## What it measures

For three configurations -- direct S3, direct SFTP, direct CIFS, the shim sitting in front of SFTP, and the shim sitting in front of CIFS -- the harness captures:

- **Throughput** (upload + download) for 1 MiB / 10 MiB / 100 MiB blobs.
- **Concurrency** (4x and 8x parallel 100 MiB uploads).
- **Small files** (200 files x 16 KiB, `--transfers 8`).
- **Sustained load** (sequential 10 MiB uploads for 3 minutes).
- **Kill + recover** (kill the shim mid-upload, restart, retry).

The shim runs with **`--vfs-cache-mode off --no-checksum`** -- the strictest mode, no local buffering. That's what we'd ship if we shipped this at all; the design constraint is "no extra local disk pressure".

Each measurement is one JSON line in `results.jsonl`, then aggregated into a markdown report.

## Where it runs

- **Driver**: any dev host with SSH access to `testing.phoenix-host.net`.
- **Workload**: `testing.phoenix-host.net` (Debian 13, 4 cores, ~7.6 GiB RAM).
- **Backends**: Hetzner Object Storage + Hetzner Storage Box (SFTP and CIFS). All credentials come from `~/k8s-staging/servers.txt`.

## Usage

```bash
# Full run (~30-45 minutes)
./scripts/rclone-shim-eval/evaluate-rclone-s3-shim.sh

# Short smoke (~5 minutes, smaller sizes + 60s sustained window)
./scripts/rclone-shim-eval/evaluate-rclone-s3-shim.sh --smoke

# Re-aggregate without re-running scenarios
./scripts/rclone-shim-eval/evaluate-rclone-s3-shim.sh --report-only
```

The driver script:

1. Parses `~/k8s-staging/servers.txt` for S3 + SFTP + CIFS credentials.
2. Probes `testing.phoenix-host.net` SSH connectivity.
3. Syncs `remote/runner.sh` + `remote/aggregate.sh` + the SSH key for SFTP auth to the remote host.
4. Runs the evaluation, with all secrets passed via env vars and the SMB password fed via stdin (not argv).
5. Pulls back `docs/04-deployment/RCLONE_SHIM_EVALUATION.md` and `RCLONE_SHIM_EVALUATION.results.jsonl`.

## Outputs

- `docs/04-deployment/RCLONE_SHIM_EVALUATION.md` -- the committed report.
- `docs/04-deployment/RCLONE_SHIM_EVALUATION.results.jsonl` -- raw measurements (committed alongside for reproducibility).
- `/root/rclone-shim-eval/logs/` on the remote host -- per-process rclone logs (not committed).

## Safety

- Each scenario writes under `rclone-shim-eval/<session-tag>/` on the target bucket/share and `purge`s that subtree on completion.
- The shim binds to `127.0.0.1:9990` only (never publicly exposed).
- Test data lives entirely on tmpfs/local disk on the testing host -- not in the repo.
- The harness will not delete anything outside `rclone-shim-eval/`.

## Knobs (env vars on the remote runner)

| Var | Default | Effect |
|-----|---------|--------|
| `LARGE_SIZES` | `1M 10M 100M` | Single-file throughput sizes. |
| `CONCURRENCY_FANOUT` | `4 8` | Parallel-upload counts. |
| `SMALL_COUNT` | `200` | Number of small files. |
| `SMALL_SIZE_BYTES` | `16384` | Small-file size. |
| `SUSTAIN_DURATION` | `180` | Sustained-window seconds. |
| `SUSTAIN_BLOB_SIZE` | `10M` | Blob size for sustained loop. |
| `SHIM_PORT` | `9990` | Shim listen port. |
| `RCLONE_VERSION` | `1.68.2` | Pinned rclone version. |
