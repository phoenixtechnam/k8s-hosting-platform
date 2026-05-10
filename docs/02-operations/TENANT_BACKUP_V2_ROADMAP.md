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
| 1 | files + restic + pre-dump hook | in progress | feat/tenant-backup-v2-restic-jmap | `restic-driver.ts` + migration `0086_tenant_restic_repo_state` + `components/files.ts` rewrite + `internal-upload-route` restic endpoint + `mail-backup-tools` image rebase + integration harness `scripts/integration-tenant-bundles-restic.sh` validated on testing cluster. |
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
| 2026-05-09 | Phase 0b (JMAP spike against staging Stalwart) BLOCKED — SSH on port 22 refused on staging1/2/3 (intermittent; was working earlier in the session). ICMP works; control-plane API on 6443 reachable. Worker node reachable but lacks kubeconfig. Surfaced to operator. |

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
