# ADR-043: `rclone serve s3` shim for SYSTEM-class non-S3 backends

**Status**: **WITHDRAWN 2026-05-19** — superseded by [BACKUP_ARCHITECTURE_RFC §12](../04-deployment/BACKUP_ARCHITECTURE_RFC.md) (`cnpg-plugin-pgbackrest` for postgres) + [§13](../04-deployment/BACKUP_ARCHITECTURE_RFC.md) (`backup-rclone-etcd` CronJob for etcd). Both eliminate S3 dependency from SYSTEM-class backups *without* the shim's always-on overhead, and the pgBackRest path additionally preserves PITR + incremental backups (which the shim path did not).
**Original decision date (DEFERRED)**: 2026-05-19
**Withdrawal date**: 2026-05-19 (same day; subsequent design round adopted pgBackRest instead)

**Empirical validation**: [RCLONE_SHIM_EVALUATION](../04-deployment/RCLONE_SHIM_EVALUATION.md) — 45/45 measurements ok across throughput / 16× concurrency / 200 small files / 180 s sustained / kill+recover, against real Hetzner Storage Box SFTP+CIFS backends, with `--vfs-cache-mode off`. The shim is **technically viable** (no data-path defects, no memory leaks, 100+ MiB/s aggregate at 16× fanout, sub-second restart). **We chose pgBackRest anyway** because:

1. pgBackRest natively supports S3 + SFTP + GCS + Azure + posix (CIFS/NFS via in-pod kernel mount) — no shim required.
2. pgBackRest keeps PITR + incremental backups; the shim path required dropping barman-cloud or wrapping it (and in the planned scope we'd have dropped it).
3. No always-on cluster component to operate, monitor, patch, or fail over.
4. The official CNPG project is moving its v2 storage backend to pgBackRest, so adopting it now is forward-aligned.

The shim design below remains documented for the historical record. The trigger conditions (operator on SFTP/CIFS-only AND explicit postgres + etcd remote requirement AND willing to accept a new always-on critical-path service) are now strictly weaker than "switch to pgBackRest" — there is no realistic scenario in which the shim is preferable.

**If you are reading this trying to decide between the shim and pgBackRest, pick pgBackRest.**

## Context

[BACKUP_ARCHITECTURE_RFC](../04-deployment/BACKUP_ARCHITECTURE_RFC.md) §7 documents the hard constraint that some backup mechanisms only support S3-compatible APIs:

| Mechanism              | S3 | SFTP | CIFS | NFS |
| ---------------------- | -- | ---- | ---- | --- |
| barman-cloud (CNPG)    | ✅ | ❌   | ❌   | ❌  |
| k3s `--etcd-s3`        | ✅ | ❌   | ❌   | ❌  |
| Longhorn native backup | ✅ | ❌   | ❌   | ✅  |
| restic                 | ✅ | ✅   | ✅   | ✅  |
| rclone (generic)       | ✅ | ✅   | ✅   | ✅  |

Effect: SYSTEM class can only be assigned an S3-compatible target. Operators with only SFTP (Hetzner Storage Box) or CIFS (self-hosted) targets either need a separate S3 setup OR can't back up postgres + etcd at all.

`rclone serve s3` exposes any rclone backend (SFTP, CIFS, local fs, etc.) as an S3-compatible HTTP API. This unlocks SYSTEM coverage on non-S3 backends.

## Why we're not shipping it in v1

1. **Operator economics in target band**. Hetzner Storage Box (the de facto target for cost-conscious operators) now offers an S3 API on newer accounts. Most operators on the platform's price band already have S3.
2. **New long-running service**. rclone-serve-s3 becomes a critical-path component: if it dies, every SYSTEM backup fails. Needs HA (2-replica Deployment), TLS termination, secrets, monitoring, version pinning.
3. **v1 scope**. The current RFC is already 8-9 working days. Adding rclone-serve-s3 pushes it past 10. v1's "SYSTEM needs S3" constraint is a clear, documented limitation rather than a blocker.
4. **Performance overhead**. Every backup byte transits an extra HTTP hop + rclone process. Acceptable for low-frequency backups, but adds latency.

## Decision

Defer. The Path A++ design in the main RFC (graceful per-subsystem degradation badges) addresses the same operator pain — operators with only SFTP/CIFS see honest "postgres + etcd: needs S3" status on the SYSTEM class card and can run with partial coverage. Adding a new long-running service to "fix" this is over-engineering until a real operator hits the wall.

Document the design here so it's not lost.

## When we'd revisit

- Operator on a self-hosted CIFS/SFTP-only setup asks for full SYSTEM coverage
- Customer in an air-gapped environment with no S3 access
- The platform onboards a customer segment where SFTP/CIFS is the standard (e.g. some EU government clouds)

## Design (for whoever picks this up)

### Architecture

```
                ┌─────────────────────────────────────┐
                │  platform namespace                  │
                │                                       │
  CNPG postgres ─→─┐                                   │
  k3s etcd ──────→─┤   rclone-serve-s3 Deployment      │
  Longhorn ─────→─┘   (2 replicas, ClusterIP service)  │──→  operator's actual backend
                │   ↑                                  │     (SFTP / CIFS / NFS)
                │   │                                  │
                │   └─── reads creds from              │
                │        Secret(rclone-shim-config)    │
                └─────────────────────────────────────┘
```

### Components

1. **`Deployment` `rclone-serve-s3`** in `platform` namespace:
   - 2 replicas, anti-affinity across nodes
   - Image: `rclone/rclone` pinned by digest, command: `rclone serve s3 --addr :9000 --vfs-cache-mode writes`
   - Backend config mounted from `Secret`: `[upstream]` block pointing at SFTP/CIFS/whatever
   - Access-key / secret-key generated at install time, stored in `Secret rclone-shim-creds`
   - PVC for vfs-cache (writes buffer): `longhorn-ha`, sized 10% of total backup volume (e.g. 5 GiB default)
2. **`Service` `rclone-serve-s3.platform.svc.cluster.local:9000`** (ClusterIP only — never exposed outside cluster)
3. **`Certificate`** via cert-manager Issuer for in-cluster TLS (cluster-issuer signing for `*.platform.svc`)
4. **New `backup_configurations.storageType` value**: `s3_via_rclone_shim`
   - Stores both the shim endpoint AND the backing storage credentials
   - When operator creates this kind of target via UI, platform-api updates the `Secret rclone-shim-config` with a new backend block + restarts the Deployment
5. **UI integration**: target picker shows "S3 (via rclone shim — backed by `<your SFTP host>`)" entries alongside native S3 targets

### Operator UX

Configure target → UI shows:
- Target type: `S3 (via rclone shim)`
- Backing storage type: SFTP / CIFS / NFS / local
- Backing storage credentials (operator inputs once)
- Generated S3 endpoint: `http://rclone-serve-s3.platform.svc.cluster.local:9000` (auto)
- Generated access-key/secret-key (auto, stored in cluster Secret)

barman-cloud, k3s etcd, Longhorn native backup all use the auto-generated S3 endpoint + creds. Operator never sees the internal shim plumbing.

### Operational concerns

- **HA**: 2 replicas behind ClusterIP. Active-active is fine for read; for write, rclone's vfs-cache mode prevents concurrent-write races (writes serialise through the cache). Single-active-writer pattern via leader election is overkill for our load.
- **Failure modes**: shim Pods crash → backups fail → platform-api admin event → operator manually investigates. No automatic failover to "skip the shim" because the upstream isn't S3.
- **Version pinning**: pin rclone by digest in Flux. Major-version upgrades require operator opt-in (UI button + soak window).
- **TLS rotation**: cert-manager auto-rotates. Re-issue happens transparently to the consumers (in-cluster only, no public exposure).
- **Monitoring**: emit Prometheus metrics for rclone process (already supported via `--metrics-addr`). Alert on `up{job="rclone-serve-s3"} == 0` for >5 min.

### Estimated effort

12-16h:
- 2h: Deployment + Service + Secret + Issuer manifests
- 3h: Platform-api integration (target CRUD + Secret materialisation)
- 3h: UI changes (target picker, target type metadata)
- 2h: Bootstrap.sh integration (cert auto-creation, leader-elect plumbing)
- 2h: E2E test (backup roundtrip via shim against a fake SFTP target in DinD)
- 2-4h: Operator runbook + ADR finalisation

### What's NOT in scope

- Multi-backend chaining (use SFTP for cold, S3 for hot — not solving for that)
- rclone-serve-s3 across clusters (single per-cluster instance only)
- Public S3 endpoint exposure (always ClusterIP — no need to expose outside)

## Trade-offs vs alternatives

| Approach | Lift | Operational complexity | Operator UX |
|---|---|---|---|
| **rclone-serve-s3** (this ADR) | One new service; bidirectional uplift | HA + TLS + version mgmt | Single target type works for everything |
| **Path A++ degradation badges (v1)** | Tiny — just UI status logic | Zero | Operator picks SFTP for SYSTEM, sees postgres + etcd as "needs S3" badges; they know what's covered and what's not |
| Document constraint, push operator to S3 | Zero engineering | Zero | Operator must procure S3 — most operators already have it; friction is low |
| Per-mechanism S3 emulators (postgres → MinIO Gateway, etcd → its own…) | Many small services | Many small services to operate | Operator sees N target types — worse than the shim |
| Drop barman/etcd-s3 mechanisms entirely | Re-implement postgres + etcd backup via rclone | Loss of upstream-supported mechanisms | Backup tooling drifts from upstream best-practice |

**Path A++ wins for v1.** rclone-serve-s3 is the cleanest path when the trigger fires (real SFTP-only operator who explicitly demands postgres coverage), not before.
