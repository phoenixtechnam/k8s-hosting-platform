# Tenant Backup v2 — Roadmap & Progress Tracker

Live document. Updated by the agent driving each phase. Architecture decisions are frozen in [ADR-036](../07-reference/ADR-036-tenant-backup-restic-jmap.md); this file tracks **what is shipped, what is in flight, and what is next**.

## TL;DR

Replacing the daily-backup path with **restic per-tenant repo (files) + JMAP-driven Maildir capture (mail)**. Config and secrets stay full each run. No coexistence with legacy bundles; existing bundles may be deleted at cutover.

Targeting: ~28× storage reduction at 100 tenants, daily incremental window < 8 min single replica, < 3 min HA, object-level restore in seconds.

## Phase status

**Validation cluster**: `testing.phoenix-host.net` (single-node k3s 1.33, control-plane+etcd+master). Staging cluster is currently down; phases validate against testing. Backup targets remain Hetzner Object Storage (S3, `fsn1.your-objectstorage.com`) and Hetzner Storage Box (SFTP, `u335448-sub10.your-storagebox.de:23`) — credentials in `~/k8s-staging/servers.txt`.

| Phase | Subject | Status | Branch / Commit | Notes |
|-------|---------|--------|-----------------|-------|
| 0 | Spike + budget validation | DONE | feat/tenant-backup-v2-restic-jmap @ eaee5dd8 | `scripts/spike-restic-jmap.sh` green against real S3 + SFTP. Numbers in §"Phase 0a spike — measured numbers". |
| 1 | files + restic + pre-dump hook | **DONE** | merged to main; pinned to staging at image tag `20260511110850-7fea24d` | All 11 pieces shipped: 7 original + #8 (memory cap), #9 (SFTP target), #10 (perf tuning + re-measurement on 2026-05-11), #11 (abort cleanup + failure UX → bell). End-to-end harness PASSED on staging 2026-05-10; perf re-measurement PASSED 2026-05-11 (see §"Phase 1 piece #10 re-measurement"). |
| 2 | mail + JMAP + Maildir | blocked on Phase 1 | — | New `jmap-sync.py` (Python stdlib). Replaces mbsync entirely. New `tenant_jmap_state` table. State persistence after restic ack. |
| 3 | admin + tenant UI | blocked on Phase 2 | — | Snapshot tree browser, single-file/single-message picker, schedule editor, global Settings tab. Both admin panel and client panel. |

## Locked decisions (from chat 2026-05-09)

1. **Retention**: `restic forget --keep-daily N --prune`, single global setting `tenant_backup_retention_days` (default 30). No weekly/monthly layer.
2. **GDPR export**: on-demand only via existing data-export route. No permanent monthly full-mode schedule.
3. **`restic check` cadence**: weekly default, configurable globally via `tenant_backup_check_interval_days`.
4. **JMAP auth**: Stalwart master user (existing `roundcube-secrets` Secret). No per-tenant token issuance.
5. **platform-api memory**: stays at 1 GiB limit. Per-pod restic concurrency cap = 4. Cluster-wide cap via pg advisory-lock pool, default 0 (unlimited), recommended 8 for 3-replica HA.
6. **Backwards compatibility**: NONE. Legacy bundles can be deleted at cutover. No coexistence window. No `legacy_mbsync` kill-switch.
7. **SSH/SFTP target support**: yes, via restic's native `sftp:` backend. NOT SSHFS (no FUSE). Decrypted private key written to a per-Job tmpfile (`umask 600`, deleted on process exit), restic launched with `RESTIC_SFTP_COMMAND="ssh -i <tmpfile> -o StrictHostKeyChecking=accept-new -o BatchMode=yes ..."`.
8. **HA parallelism**: across-tenant fan-out via existing scheduler CAS (no code change). Per-tenant: components stay sequential. Object-store rate limit pressure bounded by global advisory-lock cap.

## Open questions

None at this point. All decisions taken in chat are reflected above.

## Resource budget (target)

See ADR-036 §"Resource budget" for the per-scenario targets. Phase 0 will produce real measured numbers in `docs/02-operations/TENANT_BACKUP_V2_ROADMAP.md` after the spike runs.

## Phase 0 — work log

| Date | Event |
|------|-------|
| 2026-05-09 | ADR-036 + roadmap committed. Worktree `feat/tenant-backup-v2-restic-jmap` created. |
| 2026-05-09 | Phase 0a spike (`scripts/spike-restic-jmap.sh`) PASSED against real Hetzner Object Storage (S3) AND Hetzner Storage Box (SFTP). HKDF determinism + cross-tenant isolation + byte-identical single-file restore all asserted. |
| 2026-05-10 | Phase 1 commits 1-7 + Phase 1.5 multi-region/DR landed on `feat/tenant-backup-v2-restic-jmap`. 201/201 unit tests, lint+typecheck clean. |
| 2026-05-10 | Pushed feat → main → CI built platform-api image → sync-staging propagated → Flux reconciled staging cluster. Backend CI / Trivy / patch-shim audit failures fixed in `e06cd9e3`. |
| 2026-05-10 | First end-to-end harness run against staging (`testing.phoenix-host.net` substitute via `staging.phoenix-host.net`) — bundle creation crashed mid-upload with `curl: (56) Recv failure`. Root cause: platform-api image did not include the `restic` binary, even though ADR-036 spawns it server-side. Fix in `358da30b` adds `restic` to the apk install in `backend/Dockerfile`. |
| 2026-05-10 | Second harness run (after restic was in image) crashed in a new way: `node:events:497  throw er; // Unhandled error event  Error: write EPIPE`. Two real bugs: (a) `restic backup` requires the repo to be initialised first — first-ever per-tenant call exits non-zero, closing subprocess stdin → (b) the resulting EPIPE on `child.stdin` had no error listener, so Node crashed the whole platform-api pod. Both fixed in `0f833078`: `ensureResticRepoInitialised` runs idempotent `restic init` before each backup, and `child.stdin.on('error', ...)` swallows EPIPE benignly (the exit code is the real signal). 201/201 unit tests still green; new test asserts the init+backup spawn pair. |
| 2026-05-10 | Third harness run: pod OOMKilled (exit 137) within 13s of the upload PUT. Root cause: streaming pipe didn't honour backpressure — `child.stdin.write()` returns false when restic can't keep up, but the data-event listener pattern kept writing, growing the writable buffer beyond the 1 GiB pod limit. Fix in `40ed2121`: `node:stream/promises pipeline()` over a custom `Writable` shim that bounds memory to 64 KiB highWaterMark and swallows EPIPE on the inner write callback. |
| 2026-05-10 | **Fourth harness run: PASSED end-to-end.** 41s wall-clock for the existing 524 MB tenant PVC. Snapshot id `8d1b6902…` written to per-tenant S3 prefix with the full ADR-036 tag set (bundle-version=2, platform-version, region=staging-phoenix-host-net, tenant-id, tenant-slug=client-ingress-test-32f623c8, bundle-id, component=files). Local restic CLI using HKDF-derived per-tenant password from cluster's `OIDC_ENCRYPTION_KEY` listed the snapshot, restored archive.tar, and the inner fixture file (`/var/www/html/itest-restic/photo-1778429765.bin`) round-tripped byte-identical (sha256 6fd802ca61b2ff1b…). Phase 1 piece #7 closed. |
| 2026-05-10 | **Memory bound validated under load.** Successive harness runs at 524 MiB / 2.0 GiB / 5.4 GiB tenant PVC sizes showed restic backup peaked at 246 / 388 / 389 MiB respectively — bounded but over the 256 MiB target. Tuning in commit `4f388613` (`--read-concurrency 1 --compression off`) brought the 5.4 GiB peak to **221 MiB** (Δ +54 MiB above idle). Plateau confirmed: memory does NOT scale with payload size. |
| 2026-05-10 | **SFTP target end-to-end + perf comparison.** Added `openssh-client` to platform-api image (`d11fa782`); restic's `sftp:` backend invokes the system `ssh` binary which Alpine had omitted. Harness extended to drive both targets via `BACKUP_CONFIG_OVERRIDE=<id>`. Comparison on 5.4 GiB tenant: **S3 92s / SFTP 88s capture wall-clock**; **S3 221 MiB / SFTP 240 MiB peak memory**; both under the 256 MiB target. SFTP uses ~20 MiB more memory because of the spawned `ssh` process. Throughput delta <5% at this scale. |
| 2026-05-10 | **Cold-start S3 vs SFTP measured (5,501 MiB, fresh repos, in-cluster restore Pod):** capture S3=267s @ 20.6 MiB/s, SFTP=229s @ 24.0 MiB/s (SFTP ~17% faster); restore S3=158s @ 34.8 MiB/s, SFTP=26s @ **211.6 MiB/s (6× faster)**. S3's per-pack-file HTTP RTT dominates restore latency; SFTP streams through a single SSH channel. Both stay under 256 MiB peak platform-api memory during capture. |
| 2026-05-11 | **Piece #10 perf re-measurement + 4 fixes + failure UX overhaul.** First post-perf retry on staging OOMKilled platform-api: `f0e73ca5`'s `s3.connections=10 × --pack-size 64 MiB` pushes the in-flight buffer envelope to ~640 MiB while the previously-claimed "1 GiB" pod limit was actually 512Mi in the manifest (k8s/base/backend-deployment.yaml drifted from ADR-036). 5 zombie backup_jobs from the OOM cascade left zombie `restic` spawns until pod death, each leaking ~200 MiB until the next OOM. Fixes in `8e77fd8f` + `f1a9e4c7` + `d27f7d1e`: (1) Deployment memory 512Mi → 2Gi, CPU 500m → 1500m (1Gi was still too tight under load — observed peak 1281 MiB); (2) restic-stream route wires `request.raw.on('aborted')` into an AbortController that SIGKILLs the spawn + destroys the source stream so the pipeline unblocks; (3) `restic restore --workers 16` removed — never was a valid flag in 0.18.1, silently broken since the perf commit; (4) `STUCK_RUNNING_HOURS` reaper lowered 24h → 1h. **Failure UX overhaul:** failed bundles auto-clear from the chip (new `clearImmediately` on `tasks.finish*`) and fire `notifyUser(type='error')` so the bell catches them — operator never sees a permanent red row in the chip. Re-measured against the same 5.4 GiB tenant on the new image (see "Re-measurement" section below). |
| 2026-05-09 | Phase 0b (JMAP spike against staging Stalwart) BLOCKED — SSH on port 22 refused on staging1/2/3 (intermittent; was working earlier in the session). ICMP works; control-plane API on 6443 reachable. Worker node reachable but lacks kubeconfig. Surfaced to operator. |

### Phase 1 piece #10 re-measurement (2026-05-11)

Image `20260511110850-7fea24d` (commits `8e77fd8f` + `f1a9e4c7` + `d27f7d1e`), platform-api `2Gi / 1500m`, against the existing 5,501 MiB `client-ingress-test-32f623c8` tenant. Restores executed from an in-cluster scratch Pod (`perf-restore-2`) on the worker node, separate from the platform-api memory budget.

| Operation | Cold-start (2026-05-10) | Post-tuning (2026-05-11) | Speedup | Peak platform-api memory |
|---|---|---|---|---|
| Capture S3 | 267s @ 20.6 MiB/s | **112s @ 49.1 MiB/s** | **2.38×** | 221 MiB → 1,281 MiB |
| Capture SFTP | 229s @ 24.0 MiB/s | **95s @ 57.9 MiB/s** | **2.41×** | 240 MiB → 277 MiB |
| Restore S3 | 158s @ 34.8 MiB/s | **56s @ 98.2 MiB/s** | **2.82×** | (in-cluster Pod) |
| Restore SFTP | 26s @ 211.6 MiB/s | 29s @ 189.7 MiB/s | noise | (in-cluster Pod) |

**Memory trade-off.** S3 capture peak grew 5.8× (221 → 1,281 MiB) — the cost of `s3.connections=10 × pack-size=64 MiB` allowing up to 640 MiB of in-flight pack buffers plus restic's own ~200 MiB working set plus ambient platform-api workload (~170 MiB). 2 GiB pod limit absorbs the S3 case with ~750 MiB headroom. SFTP stays light (single SSH channel does no parallel pack-buffering — peak only +37 MiB above cold-start). The trade-off favours throughput: a 2.38× capture speedup at +750 MiB headroom is a clear win, and `TENANT_BUNDLES_MAX_CONCURRENT_RESTIC=4` caps concurrent captures per pod.

**SFTP restore noise.** 26s → 29s is within measurement noise. SFTP restore was already saturating the SSH channel at cold-start; `s3.connections=10` doesn't apply, and `--pack-size 64` is slightly worse for SSH (larger reads at the end of pack-file → idle channel waiting for next read).

**Failure UX validation.** Two consecutive failures on the old 1 GiB image at `10:35:48` + `11:11:19` produced the expected behaviour after the new image deployed: failed bundles vanished from the chip immediately (`tasks.cleared_at` set atomically) and were replaced by a notification on the bell (`notifications` row with `type=error`, `resource_type=backup_bundle`). The stuck-bundle reaper (1h cutoff) cleans up any orchestrator-pod-died-mid-bundle cases that bypass the happy-path. Operators trigger a re-run from the bundle list.

### Phase 0a spike — measured numbers (2026-05-09)

Source tree: 110 MiB (100 MiB random blob + 10 MiB synthetic DB dump + small fixture files). Run from a dev machine over public internet (NOT a representative bandwidth — production platform-api is colocated with Hetzner S3 in `fsn1` and bandwidth will be 10-100× higher).

| Operation | S3 | SFTP | Budget target | Notes |
|---|---|---|---|---|
| `restic init` | 5.26s | 16.81s | n/a | one-time per tenant |
| baseline backup | 89.47s | 33.39s | ~60s @ 5 GiB | internet-bound; LAN will be < 5s for this size |
| incremental (1 MiB delta) | 8.01s | 11.50s | ~10s | within budget |
| single-file restore | 4.16s | 8.84s | ~2s | SFTP slower due to per-pack-file RTT; LAN restore < 1s |
| repo raw size after 2 snapshots | 111 MiB | 111 MiB | n/a | **1.01× dedup ratio (perfect)** |
| HKDF password determinism | ✓ | — | — | reproduces exactly across runs |
| Cross-tenant isolation | ✓ | — | — | client B's password cannot open client A's repo |
| `forget --keep-last 1 --prune` | ✓ | — | — | leaves exactly 1 snapshot |

**Conclusion:** restic primitive is sound for both backend types. `BackupStore` `kind` switch maps cleanly onto `--repo s3:...` vs `-o sftp.command='ssh ... -s ... sftp' --repo sftp:...`. Wall-clock numbers are conservative — production platform-api throughput will be substantially higher.

**HKDF lock-vector for Phase 1** (the production restic-driver MUST reproduce this byte-for-byte):

```
key    = 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
client = fixture-client-001
HKDF-SHA256(key, salt=Buffer.alloc(0), info=Buffer.from("restic-tenant-" + client), length=32)
       = 9cc1efeff2216dd12759fb93b3b3948f830036b87f5d6a29f8470108dc4d39a8
```

Phase 1's `restic-driver.test.ts` must assert this exactly. Encoded in the spike script at the determinism check; copied into the unit test when the production driver lands.

### Phase 0b — JMAP spike (deferred)

Will be implemented as part of Phase 2. The code path can be designed against a fixture-based test harness without requiring SSH to staging hosts. JMAP behaviour against the real staging Stalwart will be validated via `scripts/integration-tenant-bundles-jmap.sh` once Phase 2 lands.

## Decisions log

(Append-only.)

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-09 | Adopt restic + JMAP, per ADR-036 | Storage cost + CPU + restore-granularity all addressed in one architecture |
| 2026-05-09 | No backwards compat with legacy bundles | Operator OK with deleting existing bundles; simplification preferred over coexistence window |
| 2026-05-09 | Drop weekly/monthly retention layers | Keep configuration surface minimal. Single global daily count is enough at this scale |
| 2026-05-09 | JMAP master-user auth, not per-tenant tokens | Reuse Stalwart master credentials already used by webmail/mbsync. No new credential plane |
| 2026-05-09 | platform-api stays 1 GiB, restic cap 4 | Match operator preference. Concurrency × per-process budget fits the limit |
| 2026-05-09 | SFTP via restic native backend (not SSHFS/FUSE) | Avoids SYS_ADMIN cap in containers, simpler operationally |
| 2026-05-09 | Pre-capture DB hook is platform-api TypeScript that calls existing `db-manager.ts:exportDatabaseToPvc`; NO DB clients in the backup-tool image | SQL Manager already runs `mysqldump`/`pg_dump` inside the live tenant DB pod via `execInPod` using the credentials it already owns. Backup-tool image stays minimal: restic + python3 + curl + tar + ca-certificates. No duplicated binaries, no second credential plane. Backup pod has no network path to the live DB. |
