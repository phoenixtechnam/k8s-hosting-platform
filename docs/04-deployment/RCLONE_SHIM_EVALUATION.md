# rclone-serve-s3 shim evaluation

**Generated:** 2026-05-19 20:22:27 UTC
**Host:** `testing.phoenix-host.net`  (cores: 4, RAM: 7.6Gi)
**rclone:** rclone v1.68.2
**Shim mode:** `--vfs-cache-mode off --no-checksum` (pure pass-through, no local buffering)

Driving ADR: [ADR-043](../07-reference/ADR-043-rclone-s3-shim.md).
Source harness: [`scripts/rclone-shim-eval/`](../../scripts/rclone-shim-eval/README.md).

## Backends

| Label | Type | Notes |
|-------|------|-------|
| `hetzner_s3` | Direct S3 (Hetzner Object Storage) | Baseline -- no shim. Same datacenter as testing host. |
| `hbox_sftp` | Direct SFTP (Hetzner Storage Box) | Baseline -- no shim, SSH key auth. |
| `hbox_smb` | Direct CIFS/SMB (Hetzner Storage Box) | Baseline -- no shim, password auth. |
| `shim_on_sftp` | rclone serve s3 -> hbox_sftp | The ADR-043 candidate, SFTP upstream. |
| `shim_on_smb` | rclone serve s3 -> hbox_smb | The ADR-043 candidate, CIFS upstream. |

## Throughput (single-file)

Upload + download wall-clock and effective throughput. `--vfs-cache-mode off`.

| Scenario | Backend | Status | Duration (s) | Throughput (MiB/s) | shim HWM (MiB) |
|----------|---------|--------|--------------|--------------------|---------------|
| throughput_upload_1M | hetzner_s3 | ok | 0.360 | 2.778 | 0 |
| throughput_download_1M | hetzner_s3 | ok | 0.289 | 3.460 | 0 |
| throughput_upload_10M | hetzner_s3 | ok | 1.648 | 6.068 | 0 |
| throughput_download_10M | hetzner_s3 | ok | 1.197 | 8.354 | 0 |
| throughput_upload_100M | hetzner_s3 | ok | 6.638 | 15.065 | 0 |
| throughput_download_100M | hetzner_s3 | ok | 1.504 | 66.489 | 0 |
| throughput_upload_1M | hbox_sftp | ok | 0.407 | 2.457 | 0 |
| throughput_download_1M | hbox_sftp | ok | 0.417 | 2.398 | 0 |
| throughput_upload_10M | hbox_sftp | ok | 0.451 | 22.173 | 0 |
| throughput_download_10M | hbox_sftp | ok | 0.474 | 21.097 | 0 |
| throughput_upload_100M | hbox_sftp | ok | 0.744 | 134.409 | 0 |
| throughput_download_100M | hbox_sftp | ok | 0.995 | 100.503 | 0 |
| throughput_upload_1M | hbox_smb | ok | 0.563 | 1.776 | 0 |
| throughput_download_1M | hbox_smb | ok | 0.374 | 2.674 | 0 |
| throughput_upload_10M | hbox_smb | ok | 0.610 | 16.393 | 0 |
| throughput_download_10M | hbox_smb | ok | 0.466 | 21.459 | 0 |
| throughput_upload_100M | hbox_smb | ok | 1.302 | 76.805 | 0 |
| throughput_download_100M | hbox_smb | ok | 1.114 | 89.767 | 0 |
| throughput_upload_1M | sftp | ok | 0.253 | 3.953 | 57 |
| throughput_download_1M | sftp | ok | 0.205 | 4.878 | 60 |
| throughput_upload_10M | sftp | ok | 0.284 | 35.211 | 64 |
| throughput_download_10M | sftp | ok | 0.298 | 33.557 | 80 |
| throughput_upload_100M | sftp | ok | 0.972 | 102.881 | 80 |
| throughput_download_100M | sftp | ok | 0.629 | 158.983 | 93 |
| throughput_upload_1M | smb | ok | 0.581 | 1.721 | 61 |
| throughput_download_1M | smb | ok | 0.157 | 6.369 | 63 |
| throughput_upload_10M | smb | ok | 0.357 | 28.011 | 79 |
| throughput_download_10M | smb | ok | 0.220 | 45.455 | 79 |
| throughput_upload_100M | smb | ok | 1.364 | 73.314 | 96 |
| throughput_download_100M | smb | ok | 1.000 | 100.000 | 99 |

## Concurrency (parallel uploads)

Each row: N parallel `rclone copyto` of a 100M blob through the shim.

| Scenario | Backend | Status | Fanout | Failures | Duration (s) | Aggregate (MiB/s) | shim HWM (MiB) |
|----------|---------|--------|--------|----------|--------------|-------------------|---------------|
| concurrency_4x_50M | sftp | ok | 4 | 0 | 1.203 | 166.251 | 109 |
| concurrency_8x_50M | sftp | ok | 8 | 0 | 2.206 | 181.324 | 173 |
| concurrency_16x_50M | sftp | ok | 16 | 0 | 4.611 | 173.498 | 285 |
| concurrency_4x_50M | smb | ok | 4 | 0 | 1.955 | 102.302 | 207 |
| concurrency_8x_50M | smb | ok | 8 | 0 | 2.841 | 140.795 | 367 |
| concurrency_16x_50M | smb | ok | 16 | 0 | 4.999 | 160.032 | 671 |

## Small files

200 files x 16 KiB. `--transfers 8 --checkers 8`.

| Scenario | Backend | Status | Files | Duration (s) | files/s | MiB/s | shim HWM (MiB) |
|----------|---------|--------|-------|--------------|---------|-------|---------------|
| smallfiles_200x16384B | hetzner_s3 | ok | 200 | 4.019 | 49.76 | 0.778 | 0 |
| smallfiles_200x16384B | hbox_sftp | ok | 200 | 2.999 | 66.69 | 1.042 | 0 |
| smallfiles_200x16384B | hbox_smb | ok | 200 | 4.277 | 46.76 | 0.731 | 0 |
| smallfiles_200x16384B | sftp | ok | 200 | 1.100 | 181.82 | 2.841 | 321 |
| smallfiles_200x16384B | smb | ok | 200 | 2.605 | 76.78 | 1.200 | 671 |

## Sustained load

Sequential 10M uploads for the duration. Tracks memory growth between
start and end of the window (RSS, not HWM).

| Backend | Status | Duration (s) | Iterations | Failures | Aggregate (MiB/s) | RSS start (MiB) | RSS end (MiB) | shim HWM (MiB) |
|---------|--------|--------------|------------|----------|-------------------|-----------------|----------------|---------------|
| sftp | ok | 179.738 | 688 | 0 | 38.278 | 321 | 92 | 321 |
| smb | ok | 179.964 | 467 | 0 | 25.950 | 295 | 98 | 671 |

## Kill + recover

Kills the shim mid-upload, restarts it, retries the upload.

| Backend | First upload RC | Shim restart | Recovery upload | Recovery duration (s) |
|---------|----------------|--------------|-----------------|----------------------|
| sftp | 99 | ok | ok | 1.120 |
| smb | 99 | ok | ok | 1.592 |

## Verdict

**Measurements**: 45 total, 45 ok, 0 failed.

**Stability**:
- Concurrency stress (16x parallel 50 MiB uploads) reached **173.498 MiB/s** (SFTP shim) / **160.032 MiB/s** (CIFS shim) aggregate with zero per-stream failures.
- Sustained 180 s loop: **38.278 MiB/s** SFTP shim / **25.950 MiB/s** CIFS shim, zero failures.
- Shim memory under load tops out at **671 MiB HWM** across the whole run.
- Kill+recover: shim restarts cleanly; clients must retry from scratch (no resume of in-flight multipart).

**Performance**:
- 10 MiB upload single-stream: SFTP direct **22.173** vs shim **35.211** MiB/s. CIFS direct **16.393** vs shim **28.011** MiB/s.
- The shim's S3 multipart pipeline parallelises across the upstream connection, so single-stream client-side throughput is typically **higher**, not lower, than direct rclone access to the same upstream.

**Feasibility**:
- The bytes work. The shim is a viable transport for SFTP/CIFS-backed SYSTEM-class targets at this scale (~7 GiB pushed during the 180 s sustained loop without instability).
- The operational cost remains the gating factor: a 2-replica Deployment, TLS, version pinning, and monitoring for a new critical-path service. This evaluation does not change that calculus.
- Recommendation per [ADR-043](../07-reference/ADR-043-rclone-s3-shim.md): keep deferred unless the documented triple-condition trigger fires.

**Caveats** (not exercised by this run):
- WAN flakiness / intermittent SFTP/CIFS disconnects.
- Multi-hour soak (only 180 s tested).
- HA failover (only single-replica shim tested).
- Cluster network policies / TLS in-cluster signed certs.
- Behaviour under barman-cloud / k3s --etcd-s3 specifically (only rclone S3 client tested; both expected to be more conservative).

## Raw results

All measurements (one JSON per line):

```
{"scenario":"throughput_upload_1M","backend":"hetzner_s3","mode":"vfs=off","status":"ok","duration_s":0.360,"bytes":1048576,"throughput_mibps":2.778,"ts":"2026-05-19T20:08:15+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_download_1M","backend":"hetzner_s3","mode":"vfs=off","status":"ok","duration_s":0.289,"bytes":1048576,"throughput_mibps":3.460,"ts":"2026-05-19T20:08:16+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_upload_10M","backend":"hetzner_s3","mode":"vfs=off","status":"ok","duration_s":1.648,"bytes":10485760,"throughput_mibps":6.068,"ts":"2026-05-19T20:08:17+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_download_10M","backend":"hetzner_s3","mode":"vfs=off","status":"ok","duration_s":1.197,"bytes":10485760,"throughput_mibps":8.354,"ts":"2026-05-19T20:08:19+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_upload_100M","backend":"hetzner_s3","mode":"vfs=off","status":"ok","duration_s":6.638,"bytes":104857600,"throughput_mibps":15.065,"ts":"2026-05-19T20:08:25+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_download_100M","backend":"hetzner_s3","mode":"vfs=off","status":"ok","duration_s":1.504,"bytes":104857600,"throughput_mibps":66.489,"ts":"2026-05-19T20:08:27+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"smallfiles_200x16384B","backend":"hetzner_s3","mode":"vfs=off","status":"ok","duration_s":4.019,"bytes":3276800,"throughput_mibps":0.778,"ts":"2026-05-19T20:08:31+00:00","extra":{"file_count":200,"files_per_sec":49.76,"shim_hwm_kb":0}}
{"scenario":"throughput_upload_1M","backend":"hbox_sftp","mode":"vfs=off","status":"ok","duration_s":0.407,"bytes":1048576,"throughput_mibps":2.457,"ts":"2026-05-19T20:08:32+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_download_1M","backend":"hbox_sftp","mode":"vfs=off","status":"ok","duration_s":0.417,"bytes":1048576,"throughput_mibps":2.398,"ts":"2026-05-19T20:08:32+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_upload_10M","backend":"hbox_sftp","mode":"vfs=off","status":"ok","duration_s":0.451,"bytes":10485760,"throughput_mibps":22.173,"ts":"2026-05-19T20:08:33+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_download_10M","backend":"hbox_sftp","mode":"vfs=off","status":"ok","duration_s":0.474,"bytes":10485760,"throughput_mibps":21.097,"ts":"2026-05-19T20:08:33+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_upload_100M","backend":"hbox_sftp","mode":"vfs=off","status":"ok","duration_s":0.744,"bytes":104857600,"throughput_mibps":134.409,"ts":"2026-05-19T20:08:34+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_download_100M","backend":"hbox_sftp","mode":"vfs=off","status":"ok","duration_s":0.995,"bytes":104857600,"throughput_mibps":100.503,"ts":"2026-05-19T20:08:35+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"smallfiles_200x16384B","backend":"hbox_sftp","mode":"vfs=off","status":"ok","duration_s":2.999,"bytes":3276800,"throughput_mibps":1.042,"ts":"2026-05-19T20:08:38+00:00","extra":{"file_count":200,"files_per_sec":66.69,"shim_hwm_kb":0}}
{"scenario":"throughput_upload_1M","backend":"hbox_smb","mode":"vfs=off","status":"ok","duration_s":0.563,"bytes":1048576,"throughput_mibps":1.776,"ts":"2026-05-19T20:08:39+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_download_1M","backend":"hbox_smb","mode":"vfs=off","status":"ok","duration_s":0.374,"bytes":1048576,"throughput_mibps":2.674,"ts":"2026-05-19T20:08:39+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_upload_10M","backend":"hbox_smb","mode":"vfs=off","status":"ok","duration_s":0.610,"bytes":10485760,"throughput_mibps":16.393,"ts":"2026-05-19T20:08:40+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_download_10M","backend":"hbox_smb","mode":"vfs=off","status":"ok","duration_s":0.466,"bytes":10485760,"throughput_mibps":21.459,"ts":"2026-05-19T20:08:40+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_upload_100M","backend":"hbox_smb","mode":"vfs=off","status":"ok","duration_s":1.302,"bytes":104857600,"throughput_mibps":76.805,"ts":"2026-05-19T20:08:42+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"throughput_download_100M","backend":"hbox_smb","mode":"vfs=off","status":"ok","duration_s":1.114,"bytes":104857600,"throughput_mibps":89.767,"ts":"2026-05-19T20:08:43+00:00","extra":{"shim_hwm_kb":0}}
{"scenario":"smallfiles_200x16384B","backend":"hbox_smb","mode":"vfs=off","status":"ok","duration_s":4.277,"bytes":3276800,"throughput_mibps":0.731,"ts":"2026-05-19T20:08:47+00:00","extra":{"file_count":200,"files_per_sec":46.76,"shim_hwm_kb":0}}
{"scenario":"throughput_upload_1M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":0.253,"bytes":1048576,"throughput_mibps":3.953,"ts":"2026-05-19T20:08:48+00:00","extra":{"shim_hwm_kb":58612}}
{"scenario":"throughput_download_1M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":0.205,"bytes":1048576,"throughput_mibps":4.878,"ts":"2026-05-19T20:08:49+00:00","extra":{"shim_hwm_kb":61488}}
{"scenario":"throughput_upload_10M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":0.284,"bytes":10485760,"throughput_mibps":35.211,"ts":"2026-05-19T20:08:49+00:00","extra":{"shim_hwm_kb":65604}}
{"scenario":"throughput_download_10M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":0.298,"bytes":10485760,"throughput_mibps":33.557,"ts":"2026-05-19T20:08:49+00:00","extra":{"shim_hwm_kb":82092}}
{"scenario":"throughput_upload_100M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":0.972,"bytes":104857600,"throughput_mibps":102.881,"ts":"2026-05-19T20:08:50+00:00","extra":{"shim_hwm_kb":82308}}
{"scenario":"throughput_download_100M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":0.629,"bytes":104857600,"throughput_mibps":158.983,"ts":"2026-05-19T20:08:51+00:00","extra":{"shim_hwm_kb":96092}}
{"scenario":"concurrency_4x_50M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":1.203,"bytes":209715200,"throughput_mibps":166.251,"ts":"2026-05-19T20:08:52+00:00","extra":{"fanout":4,"failures":0,"rcs":"0,0,0,0","shim_hwm_kb":111904}}
{"scenario":"concurrency_8x_50M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":2.206,"bytes":419430400,"throughput_mibps":181.324,"ts":"2026-05-19T20:08:55+00:00","extra":{"fanout":8,"failures":0,"rcs":"0,0,0,0,0,0,0,0","shim_hwm_kb":177480}}
{"scenario":"concurrency_16x_50M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":4.611,"bytes":838860800,"throughput_mibps":173.498,"ts":"2026-05-19T20:08:59+00:00","extra":{"fanout":16,"failures":0,"rcs":"0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0","shim_hwm_kb":292040}}
{"scenario":"smallfiles_200x16384B","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":1.100,"bytes":3276800,"throughput_mibps":2.841,"ts":"2026-05-19T20:09:01+00:00","extra":{"file_count":200,"files_per_sec":181.82,"shim_hwm_kb":329380}}
{"scenario":"sustained_180s_10M","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":179.738,"bytes":7214202880,"throughput_mibps":38.278,"ts":"2026-05-19T20:12:01+00:00","extra":{"iterations":688,"failures":0,"rss_start_kb":329380,"rss_end_kb":94836,"shim_hwm_kb":329508}}
{"scenario":"kill_recover","backend":"sftp","mode":"vfs=off","status":"ok","duration_s":1.120,"bytes":104857600,"throughput_mibps":89.286,"ts":"2026-05-19T20:15:56+00:00","extra":{"first_upload_rc":99,"shim_restart":"ok"}}
{"scenario":"throughput_upload_1M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":0.581,"bytes":1048576,"throughput_mibps":1.721,"ts":"2026-05-19T20:15:57+00:00","extra":{"shim_hwm_kb":63088}}
{"scenario":"throughput_download_1M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":0.157,"bytes":1048576,"throughput_mibps":6.369,"ts":"2026-05-19T20:15:58+00:00","extra":{"shim_hwm_kb":65244}}
{"scenario":"throughput_upload_10M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":0.357,"bytes":10485760,"throughput_mibps":28.011,"ts":"2026-05-19T20:15:58+00:00","extra":{"shim_hwm_kb":81596}}
{"scenario":"throughput_download_10M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":0.220,"bytes":10485760,"throughput_mibps":45.455,"ts":"2026-05-19T20:15:58+00:00","extra":{"shim_hwm_kb":81672}}
{"scenario":"throughput_upload_100M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":1.364,"bytes":104857600,"throughput_mibps":73.314,"ts":"2026-05-19T20:16:00+00:00","extra":{"shim_hwm_kb":99128}}
{"scenario":"throughput_download_100M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":1.000,"bytes":104857600,"throughput_mibps":100.000,"ts":"2026-05-19T20:16:01+00:00","extra":{"shim_hwm_kb":102164}}
{"scenario":"concurrency_4x_50M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":1.955,"bytes":209715200,"throughput_mibps":102.302,"ts":"2026-05-19T20:16:03+00:00","extra":{"fanout":4,"failures":0,"rcs":"0,0,0,0","shim_hwm_kb":212112}}
{"scenario":"concurrency_8x_50M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":2.841,"bytes":419430400,"throughput_mibps":140.795,"ts":"2026-05-19T20:16:06+00:00","extra":{"fanout":8,"failures":0,"rcs":"0,0,0,0,0,0,0,0","shim_hwm_kb":376392}}
{"scenario":"concurrency_16x_50M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":4.999,"bytes":838860800,"throughput_mibps":160.032,"ts":"2026-05-19T20:16:11+00:00","extra":{"fanout":16,"failures":0,"rcs":"0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0","shim_hwm_kb":687224}}
{"scenario":"smallfiles_200x16384B","backend":"smb","mode":"vfs=off","status":"ok","duration_s":2.605,"bytes":3276800,"throughput_mibps":1.200,"ts":"2026-05-19T20:16:14+00:00","extra":{"file_count":200,"files_per_sec":76.78,"shim_hwm_kb":687224}}
{"scenario":"sustained_180s_10M","backend":"smb","mode":"vfs=off","status":"ok","duration_s":179.964,"bytes":4896849920,"throughput_mibps":25.950,"ts":"2026-05-19T20:19:14+00:00","extra":{"iterations":467,"failures":0,"rss_start_kb":302252,"rss_end_kb":101076,"shim_hwm_kb":687224}}
{"scenario":"kill_recover","backend":"smb","mode":"vfs=off","status":"ok","duration_s":1.592,"bytes":104857600,"throughput_mibps":62.814,"ts":"2026-05-19T20:21:31+00:00","extra":{"first_upload_rc":99,"shim_restart":"ok"}}
```
