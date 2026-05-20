# RFC: Backup Architecture Simplification (Path D-final)

**Status**: LOCKED — operator-approved 2026-05-20. Ready for implementation in Phase R-X1+.
**Owner**: Phoenix Tech
**Supersedes**: the multi-target / 4-class / restic-only proposals (round 2-3); the round-5 `cnpg-plugin-pgbackrest` path (the plugin does not exist).
**Related ADRs**: ADR-042 (Stalwart logical export, deferred), ADR-043 (rclone-serve-s3 shim, **ACCEPTED — universal backup mediator**).

> **Correction 2026-05-20**: The 2026-05-19 revision asserted `cnpg-plugin-pgbackrest` exists as an official CNPG sub-project. **It does not.** Verified via `gh search repos cloudnative-pg pgbackrest` — the only CNPG backup plugin is `cloudnative-pg/plugin-barman-cloud` (S3/GCS/Azure-only per its source). The "pgBackRest plugin keeps PITR + supports SFTP" claim was unfounded. The R-X0 commit corrects the record.
>
> **Revision 2026-05-20 (round-6, Path D-final)**: The `rclone serve s3` shim (originally proposed in ADR-043) is adopted as the **universal backup mediator**. Every caller — `plugin-barman-cloud` (which IS the supported CNPG plugin), `k3s etcd-snapshot save`, every restic CronJob, every rclone-push job — talks to a per-node shim DaemonSet via S3. The shim's per-class buckets route to the operator-selected upstream backend. **First-class operator-selectable target types: S3, SFTP, CIFS, NFS** (see §13a-ii). **One global `BACKUP_TARGET_KEY`** (Tier-1 in secrets bundle) underpins all encryption: rclone `crypt` + restic `RESTIC_PASSWORD` + shim's local S3 creds via HKDF. `internalTrafficPolicy: Local` keeps the data path on-node. Eval-validated: 173 MiB/s @ 16× SFTP concurrency, 671 MiB peak RSS under CIFS stress.

---

## §1 Goals (locked)

1. **One operator mental model**: 3 backup classes (SYSTEM, TENANT, MAIL); each class is one card with a single target picker; per-subsystem coverage status visible inline.
2. **Two backup layers with distinct vocabulary**: **Fast rollback** (Longhorn snapshots, automatic, opt-in subsystems, retain=6, 1h cadence) and **Disaster recovery** (remote backups, operator-configured, optional).
3. **Remote backup purely optional**: a cluster with no target rows still runs fast-rollback for opted-in subsystems. Strict-gating fires only for remote-upload schedules.
4. ~~**Graceful per-subsystem degradation**: when an operator picks a target that some subsystems can't use…~~ **OBSOLETE per revision 2026-05-20** — the universal shim makes every subsystem work on every target type (S3, SFTP, CIFS, NFS). No degradation states. The class-target validator collapses to "is this target reachable?" (a lightweight probe).
5. **Tenant PVCs are on-demand-only** — no automatic snapshot or DR layer for tenant PVCs; the tenant bundle is the canonical tenant DR artefact.
6. **Dedup/compression by default** wherever the mechanism supports it (restic dedup, barman zstd, rclone tar compression).

---

## §2 The 3-class taxonomy (Path A++)

DB enum collapses from the current 4 (`tenant_snapshot`, `tenant_bundle`, `system_backup`, `system_mail`) → 3 (migration 0012). Free-form `subsystem` column carries granularity within a class.

| Class | Subsystems | Mechanism | Target compatibility |
|---|---|---|---|
| **SYSTEM** | `postgres`, `etcd`, `secrets-bundle`, `bulwark`, `crowdsec`, `monitoring` | mixed (see §4) | **Any target (S3, SFTP, CIFS, NFS)** — pgBackRest + etcd-CronJob support all |
| **TENANT** | `tenant-bundle` | rclone composite | Any target (S3 / SFTP / CIFS / NFS) |
| **MAIL** | `stalwart-rocksdb` | restic (path A) / Longhorn native backup (path B) | path A: any restic-compatible / path B: S3 + NFS only |

Backfill from existing rows:
- `system_backup` → `SYSTEM` (subsystem column carries `bulwark` / `crowdsec` / etc.)
- `system_mail` → `MAIL` (subsystem = `stalwart-rocksdb`)
- `tenant_snapshot` rows → **dropped** (tenant PVC automatic backup removed per §6)
- `tenant_bundle` → `TENANT`

---

## §3 Per-subsystem mechanism + target needs

Compatibility matrix used by the class-target validator:

**Revised 2026-05-20 (Path D-final)**: every caller talks to the local-node `backup-rclone-shim` DaemonSet via the S3 protocol; the shim's per-class buckets route to the operator-selected upstream backend. **Operator-selectable target types: S3, SFTP, CIFS, NFS** (see §13a-ii) — all first-class, all uniformly supported by every backup caller.

| Subsystem | Mechanism | Shim bucket | Target capability |
|---|---|---|---|
| `SYSTEM.postgres` | `plugin-barman-cloud` (CNPG plugin v0.12.0) | `s3://system` (rclone crypt) | **any backend via shim** |
| `SYSTEM.etcd` | `etcd-snap-via-shim` CronJob (`k3s etcd-snapshot save` + rclone S3 client) | `s3://system` (rclone crypt) | **any backend via shim** |
| `SYSTEM.secrets-bundle` | rclone push (age-encrypted file) | `s3://system-raw` (passthrough — already age-encrypted) | any |
| `SYSTEM.bulwark` | restic (`RESTIC_PASSWORD = BACKUP_TARGET_KEY`) | `s3://system-raw` (passthrough — restic encrypts itself) | any |
| `SYSTEM.crowdsec` | restic | `s3://system-raw` | any |
| `SYSTEM.monitoring` | restic (optional) | `s3://system-raw` | any |
| `TENANT.tenant-bundle` | rclone composite | `s3://tenant` (rclone crypt) | any |
| `MAIL.stalwart-rocksdb` | restic (path A) | `s3://mail-raw` | any |
| `MAIL.stalwart-rocksdb` | Longhorn native backup (path B, deferred R11) | n/a (Longhorn writes direct) | S3 + NFS |

**Encryption rules**:
- Callers without their own encryption use `<class>` bucket (rclone crypt wraps upstream).
- Callers with their own native encryption (restic, age-encrypted secrets-bundle) use `<class>-raw` bucket (passthrough — avoids double-encryption).
- One platform-wide `BACKUP_TARGET_KEY` (see §13b) drives ALL encryption — single secret to back up offline.

Every SYSTEM subsystem accepts every target type. No degradation badges. UI per class card:

```
SYSTEM   target: hetzner-sftp         [Change target…]
├─ ✓ postgres      plugin-barman-cloud → shim → SFTP (WAL, PITR)              [Backup | Restore PITR]
├─ ✓ etcd          k3s snapshot → shim → SFTP (hourly)                        [Backup | Restore]
├─ ✓ secrets       rclone push (age-encrypted) → shim raw → SFTP              [Restore]
├─ ✓ bulwark       restic → shim raw → SFTP (nightly)                         [Trigger | Restore]
├─ ✓ crowdsec      restic → shim raw → SFTP (weekly)                          [Trigger | Restore]
└─ ✓ monitoring    restic → shim raw → SFTP (weekly, disabled by default)     [Configure]
```

---

## §4 Fast-rollback layer (Longhorn snapshots)

Applies ONLY to opt-in subsystems on Longhorn-backed PVCs. Default scope:

| Volume | Auto fast-rollback? | Rationale |
|---|---|---|
| `system-db-{1,2,3}` (CNPG, 3-replica) | **YES (always)** | Critical; sub-minute revert of bad migration is high-value |
| `stalwart-rocksdb-data` | **YES (conditional)** — only after R11 migrates Stalwart to `longhorn-local` | Same critical-data argument; depends on Longhorn migration |
| `bulwark-data` | **NO** (opt-in toggle) | Regeneratable from Stalwart on next sync |
| `crowdsec-data` | **NO** (opt-in toggle) | Regeneratable from upstream feed |
| Monitoring PVCs | **NO** | Metrics regeneratable |
| Tenant PVCs | **NO** (on-demand only — §6) | Bundle covers DR; tenant initiates manual snapshots |

**Retention**: `retain=6` (last 6 hours rolling) on a single `RecurringJob` CR `local-thin-1h` with cron `0 * * * *`. Volume opts in via label `recurring-job.longhorn.io/local-thin-1h: enabled`.

**No 4-group jitter needed**: with only 4 volumes participating by default (system-db × 3 + Stalwart × 1), the snapshot stampede problem is irrelevant. We can add jitter later if opt-in count grows.

**Adaptive housekeeper** (CronJob `backup-housekeeper` in `platform`, every 5 min):
1. List Longhorn volumes with the `local-thin-1h` label
2. For each volume, compute `snapshotDelta = status.actualSize - spec.size`
3. If `snapshotDelta > max(10% × spec.size, 500 MiB)`: delete oldest snapshot via Longhorn API; repeat
4. If any host carrying a replica has `DiskPressure=true`: prune that volume's snapshots aggressively to retain=1; emit admin event
5. Never delete the most recent snapshot
6. Never delete a snapshot referenced by an in-flight Backup CR
7. Audit-log every deletion

---

## §5 On-demand snapshots (for tenant PVCs and elsewhere)

Replaces the automatic tenant-snapshot path entirely. Available in **both** admin panel and tenant (client) panel — operator-managed and tenant-self-service.

**Settings location**: NEW page `Admin Settings → Tenant Settings` holds the two global knobs:
- `tenant_on_demand_snapshot_ttl_hours` (default **24**) — TTL clock starts at creation; restoring does NOT extend TTL (operator can re-snapshot to extend)
- `tenant_on_demand_snapshot_max_concurrent` (default **3**) — per-tenant cap; prevents hoarding

Both are global cluster-wide settings, not per-plan. Plan-level overrides are out of scope for v1; reconsider if customer segmentation needs differ.

**UI affordances** (both panels):
- "Take snapshot now" button on the tenant PVC page (per-volume)
- List existing on-demand snapshots with `created_at`, `expires_at`, `size_bytes`, `label`
- Delete (with confirm dialog)
- Restore (with destructive-overwrite confirm dialog — "this overwrites the current PVC content"; Longhorn revert runs after scaling pod to 0; pod scales back to original replica count after revert)

**Backend**: existing `storage-lifecycle/snapshot.ts` paths cover most of the mechanics; on-demand becomes a new explicit endpoint that bypasses the (now-deleted) schedule-driven path. Quota enforcement queries Longhorn for current count + delta vs the global cap.

---

## §6 Tenant data: tenant bundle is the DR path

What goes away:
- Automatic `RecurringJob` snapshots on tenant PVCs (no retain=6 layer for tenants)
- tar+gzip+rclone tenant-snapshot mechanism (entire path retires in R10)
- `tenant_snapshot` class

What stays:
- Tenant bundle (Plesk-style composite export including files + mailboxes + config + secrets) — existing path; retains its scheduling under `TENANT` class
- On-demand "snapshot before risky op" per §5 (manual only, TTL-bounded)
- Per-tenant restore cart flow (unchanged)

The tenant bundle is the canonical tenant DR artefact. Restore-from-snapshot is operator-initiated for narrow "I'm about to do something risky" windows; restore-from-bundle is the production DR action.

---

## §7 Remote backup as optional, strict-gate softened

| Schedule kind | Default | Strict-gate |
|---|---|---|
| Fast-rollback (Longhorn snapshot) | On for opted-in subsystems | None — runs from bootstrap |
| Disaster recovery (remote upload) | Off | Needs class target assigned AND target type compatible with subsystem |
| On-demand snapshot (any subsystem) | Manual | None — fires immediately |
| Manual "Backup now" (DR cards) | n/a | Needs target |

UI per class card: when no target assigned, shows:
> ⚠ **No remote target.** Fast rollback handles in-cluster errors; no protection against volume destruction or cluster loss. Assign a target to enable disaster recovery.

This makes the "snapshots are not backups" distinction (RFC §1) operator-visible at all times.

---

## §8 Longhorn storage class consolidation

Today's four classes (`longhorn`, `longhorn-tenant`, `longhorn-tenant-test`, `longhorn-system-local`) collapse to two:

| New class | numberOfReplicas | dataLocality | Default | Use |
|---|---|---|---|---|
| `longhorn-ha` | 3 in HA mode, 1 in single-server | best-effort | **yes** | Everything except Stalwart |
| `longhorn-local` | always 1 | strict-local | no | Stalwart RocksDB only (path B) |

`local-path` retired except as a host-mount escape hatch (explicit operator opt-in).

CNPG system-db migrates to `longhorn-ha` (3-replica) on next `apply-ha` (existing flow handles PVC recreation).

---

## §9 Single target per class

Today's `backup_target_assignments` (composite PK `(snapshot_class, target_id)` + priority) collapses to one row per class:

```sql
CREATE TABLE backup_class_targets (
  snapshot_class VARCHAR(32) PRIMARY KEY,  -- 'SYSTEM' | 'TENANT' | 'MAIL'
  target_id      VARCHAR(36) NOT NULL REFERENCES backup_configurations(id) ON DELETE RESTRICT,
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by    VARCHAR(36)
);
```

Drops the priority column, replace-set semantics, dup-target/dup-priority validators, ON CONFLICT clauses in the resolver. Cross-region S3 replication at the storage layer (Hetzner, AWS native) covers any "what if target is down" concerns.

Migration 0012: take priority=0 row per class as canonical; audit-log the rest into a forensic table; drop the old table after one release.

---

## §10 Secrets bundle multi-target

The age-encrypted bundle in `/var/lib/hosting-platform/bundles/*.age` is uploadable via the same mechanism as other backups. Wired through `backup_class_targets[SYSTEM]`. Module `secrets-bundle-sync/`:

1. Post-write hook in `bootstrap.sh` triggers async upload via rclone with the SYSTEM target's credentials
2. `make secrets-fetch` 2-step: try remote target first, fall back to direct-SSH host disk
3. Local file stays as canonical "this cluster's own copy" — remote is the DR copy

Works on any target type (rclone supports SFTP/CIFS/S3 uniformly).

---

## §11 Stalwart-on-Longhorn migration (path B, conditional, R11)

Conditional on operator green-light AFTER perf benchmark on staging:

1. New storage class `longhorn-local` (replicas=1, dataLocality=strict-local, fsType=ext4)
2. One-shot migration `Job` in `mail` namespace: scale Stalwart to 0 → rsync from old `local-path` PVC to new `longhorn-local` PVC → patch StatefulSet → scale back to 1
3. **Perf gate**: 1 GiB tar create+extract benchmark must complete within 5% of local-path. Below gate → abort migration.
4. Cleanup: old PVC deleted after 7-day observation window; restic backups continue during window
5. Effect: MAIL DR switches from restic to Longhorn native backup (S3 + NFS only); fast-rollback layer becomes available

Expected outcome: cleaner mechanism story, same DR coverage as today, fast-rollback enabled. Not a step up to logical DB export (see ADR-042 for that).

---

## §12 CNPG postgres backup (SYSTEM.postgres subsystem)

**Revised 2026-05-20 (Path D-final)** — uses the official [`cloudnative-pg/plugin-barman-cloud`](https://github.com/cloudnative-pg/plugin-barman-cloud) v0.12.0; barman-cloud talks S3 to the local-node `backup-rclone-shim` DaemonSet, which translates to whatever upstream the operator's SYSTEM target points at.

```yaml
# CNPG Cluster CR
spec:
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true
      parameters:
        objectStoreName: system-postgres-objectstore   # ObjectStore CR
  backup:
    retentionPolicy: "30d"
    volumeSnapshot:
      className: longhorn
      online: true
---
# ObjectStore CR materialised by platform-api from BACKUP_TARGET_KEY + shim service
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: system-postgres-objectstore
  namespace: cnpg-system
spec:
  configuration:
    destinationPath: "s3://system/postgres"
    endpointURL: "https://backup-rclone-shim.platform.svc:443"
    s3Credentials:
      accessKeyId: { name: backup-rclone-shim-creds, key: access_key }
      secretAccessKey: { name: backup-rclone-shim-creds, key: secret_key }
    wal: { compression: zstd, maxParallel: 8 }
    data: { compression: zstd }
  retentionPolicy: "30d"
```

The shim's `s3://system` bucket is an `rclone crypt` wrapper around the operator-selected upstream (S3 / SFTP / CIFS / NFS). The shim's local S3 access/secret are HKDF-derived from `BACKUP_TARGET_KEY` and live in the `backup-rclone-shim-creds` Secret (read by both CNPG and the shim itself).

A reconciler in `platform-api` (`backend/src/modules/backup-rclone-shim/postgres-objectstore.ts`) maintains the `ObjectStore` CR + ensures the CNPG `Cluster` references it whenever SYSTEM's target changes. **No target-type gating** — the shim handles upstream variability; CNPG always speaks S3 to localhost.

**Both layers kept**: barman-cloud (off-cluster DR + WAL archiving + PITR) + `volumeSnapshot` (in-cluster fast clone).

**Restore**: single wizard at `/backups/system → Restore Postgres`. Operator picks target time T; orchestrator selects fastest path (volumeSnapshot if recent enough, else barman-cloud base + WAL replay); spawns new Cluster with `bootstrap.recovery` referencing the same `ObjectStore`. Mechanism hidden from operator.

**Cold cluster restore** (no shim running yet): `bootstrap.sh` detects "restoring from backup" mode, deploys shim DaemonSet *before* CNPG attempts recovery, restores `BACKUP_TARGET_KEY` from the secrets bundle. Documented in `BACKUP_RESTORE.md`.

---

## §13 k3s etcd (SYSTEM.etcd subsystem)

**Revised 2026-05-20 (Path D-final)** — `--etcd-s3` retired; the new CronJob's rclone client talks S3 to the local-node shim (zero cross-node hop via `internalTrafficPolicy: Local`).

`bootstrap.sh` defaults:
- `--etcd-snapshot-schedule-cron "0 * * * *"` (hourly; local thin snapshots)
- `--etcd-snapshot-retention 24` (local thin layer, always-on)
- Local snapshots in `/var/lib/rancher/k3s/server/db/snapshots/` retained regardless of any operator config
- `--etcd-s3` flags **NOT** rendered (the `etcd-snap-via-shim` CronJob handles remote upload)

Remote backup is handled by a Kubernetes `CronJob` (`platform/etcd-snap-via-shim`):
- `nodeSelector: node-role.kubernetes.io/control-plane`, control-plane tolerations
- Schedule `0 * * * *` (configurable per target)
- Image: `ghcr.io/phoenixtechnam/backup-rclone:<digest>` (same image as the shim; ~25 MiB)
- Steps: pick newest snapshot under `/var/lib/rancher/k3s/server/db/snapshots/` (hostPath ro) → `rclone --s3-endpoint=https://backup-rclone-shim.platform.svc:443 copy <snapshot> s3://system/etcd-<ts>.db.zst` → write `.meta` sidecar (timestamp, sha256, source node) → enforce retention via `rclone delete`
- `envFrom: backup-rclone-shim-creds` Secret
- `restartPolicy: OnFailure`, `backoffLimit: 2`, `ttlSecondsAfterFinished: 3600`

A reconciler in `platform-api` materialises the CronJob whenever the SYSTEM target changes (re-renders the schedule + suspends when SYSTEM has no target). **No target-type gating.**

New `make etcd-snapshot-list` CLI for operators.

**Restore**: `scripts/restore-etcd.sh` brings up shim → pulls snapshot via `s3://system` → runs `k3s etcd-snapshot restore` on a fresh control-plane node. Runbook in `BACKUP_RESTORE.md`.

---

## §13a Universal `backup-rclone-shim` (the mediator)

**New 2026-05-20** — the single component that makes every other backup target-agnostic.

**Topology**: a `DaemonSet` in `platform` namespace (one pod per node), fronted by a `Service` with `internalTrafficPolicy: Local` so every client's S3 request routes to its own node's shim pod (zero cross-node data hops).

**Configuration**: a single ConfigMap (`backup-rclone-shim-config`) renders one rclone config section per assigned class (× two: encrypted bucket + raw bucket alias). Re-rendered by platform-api when:
- Operator adds/removes a `backup_target` row
- Operator changes a class → target assignment
- `BACKUP_TARGET_KEY` is rotated
- Posix-backed target's mount config changes (Pod-spec changes too — triggers DaemonSet roll)

Bucket layout (when all three classes have targets assigned):

| Bucket | Backing |
|---|---|
| `s3://system` | rclone `crypt` (key = BACKUP_TARGET_KEY) → SYSTEM upstream |
| `s3://system-raw` | passthrough → SYSTEM upstream |
| `s3://tenant` | rclone `crypt` → TENANT upstream |
| `s3://tenant-raw` | passthrough → TENANT upstream |
| `s3://mail` | rclone `crypt` → MAIL upstream |
| `s3://mail-raw` | passthrough → MAIL upstream |

An unassigned class has NO buckets — clients fail with S3 `NoSuchBucket` (the documented "no target configured" signal).

**Performance tuning**: `--vfs-cache-mode off`, `--no-checksum`, `--s3-chunk-size 16M`, `--s3-upload-concurrency 4`, crypt cipher XChaCha20-Poly1305 (hardware-fast on x86 + arm64).

**Resource sizing** (validated by R-X14): request 64 MiB / 200m CPU; limit 1 GiB / 1 CPU. HWM observed in eval: 671 MiB (CIFS 16× concurrency).

**Health + observability**: Liveness `pgrep rclone`; Readiness TCP :443; Metrics via rclone `--rc` on :5572 (scraped by ServiceMonitor); alert on `backup_rclone_shim_up == 0` for >60s on any node.

**Drain on target change**: platform-api polls task-center for in-flight backups; waits up to 5 min (configurable per target); on timeout emits admin event banner + force-restarts.

**Security**: ClusterIP-only (never exposed); TLS terminated in-pod via cert-manager; NetworkPolicy allows ingress from `platform`, `cnpg-system`, `kube-system` (etcd CronJob), `mail`, tenant namespaces; deny all else. Shim runs non-root, drops ALL caps, read-only root FS, writes to `emptyDir(memory)` only.

**Failure mode**: local-node shim pod down → that node's callers retry on next schedule. Per-node failure scope only.

---

## §13a-ii Supported target types

The shim sits in front of any rclone-supported backend. R-X4 (config renderer) ships with first-class operator-selectable support for:

| Target type | Mechanism | UI form fields | Notes |
|---|---|---|---|
| **S3 / S3-compatible** | rclone `s3` backend | endpoint URL, region, bucket, access key, secret key | AWS S3, Hetzner Object Storage, Backblaze B2, MinIO, Wasabi |
| **SFTP** | rclone `sftp` backend | host, port, user, auth method (password / ssh-key), key/password Secret | Hetzner Storage Box, self-hosted; eval baseline tested |
| **CIFS / SMB** | k8s `smb.csi.k8s.io` CSI driver mounts the share; rclone `local` backend | host, share, user, password, version (default `vers=3.1.1`) | Hetzner Storage Box CIFS, Windows shares |
| **NFS** | k8s `volumes[].nfs` mounts the share (built-in NFSv3) or `csi.nfs.k8s.io` (NFSv4); rclone `local` backend | server, export path, version (default `nfsvers=4.2`), options whitelist | Standard NFSv4; no Kerberos in v1 |
| Future | rclone native (`webdav`, `gcs`, `azureblob`, `b2`, etc.) | per-backend fields | Renderer architecture is open-ended; adding a new backend type ≈ 20-30 LOC + a UI form |

**CIFS + NFS specifics**: both kernel-mount the share via the Pod's `volumes[]` field. The shim DaemonSet manifest carries one mount per assigned posix-backed class (re-rendered when assignments change). The rclone config for these targets uses `type = local, path = /mnt/backup-<class>-<storage>, copy_links = false, no_check_updated = true`.

**Why kernel-mount for posix backends**: rclone has no native NFS *client* backend (its `nfs` is a server-side feature). For SMB, rclone has a native client, but kernel-mount unifies the operational pattern (one POSIX path per backend, one `type = local` recipe) and offloads protocol negotiation to the battle-tested host kernel. Operator-visible difference: zero. The platform-api abstracts the wiring entirely.

---

## §13b `BACKUP_TARGET_KEY` — the single root of backup encryption

**New 2026-05-20** — one 32-byte key underpins every encryption operation on the backup path.

**Lifecycle**:
1. **First boot**: `bootstrap.sh` generates 32 cryptographically-random bytes (via `openssl rand`); base64-encoded; written to Secret `platform/backup-target-key` (`key` field).
2. **Inclusion in Tier-1 secrets bundle**: extends existing `bundle-everything` mechanism (no separate bundle).
3. **Operator off-cluster custody**: `make secrets-fetch` exports bundle; operator must store offline.
4. **Rotation**: `make backup-target-key-rotate` — 3-step confirmation gate (current key fingerprint + "I have offline backups" checkbox + final confirm). Deletes upstream `s3://*` prefixes per assigned target. Re-renders shim ConfigMap, drains, restarts. **Existing backups become unrecoverable.**

**Consumers** (all derived from the same Secret):
- rclone `crypt` backends — password from `rclone obscure` of base64-encoded key
- restic — `RESTIC_PASSWORD = base64(key)`
- Shim's local S3 access/secret — HKDF-SHA256-derived from key (deterministic)

**HKDF derivation** (in platform-api's config renderer):
```
shim_access_key  = HKDF-SHA256(key, info="shim-s3-access", length=20)
shim_secret_key  = HKDF-SHA256(key, info="shim-s3-secret", length=40)
crypt_password   = rclone-obscure(base64(key))
crypt_salt       = HKDF-SHA256(key, info="rclone-crypt-salt", length=32)
restic_password  = base64(key)
```

Deterministic derivation means the cluster can recreate all derived keys from `BACKUP_TARGET_KEY` alone — the only artefact the operator must guard.

**Rationale for single key vs per-target**: ONE secret to back up offline; ONE rotation workflow; simpler DR ("restore the bundle, all backups become readable"). Trade-off: leaked key compromises all backups across all targets. Mitigated by Tier-1 bundle storage discipline + the platform's existing age-encryption of the bundle itself + offline operator custody.

---

## §14 UI vocabulary (canonical)

Two phrases, two layers, one meaning each:

- **Fast rollback** = Longhorn snapshot, local-thin, retain=6, applies to opted-in subsystems only. Replaces all prior terminology: "filesystem snapshots", "local thin", "block snapshots", etc.
- **Disaster recovery** = remote backup to operator-configured target. Replaces "object backups", "remote", "off-cluster", "DR snapshots", etc.

`/backups/system` UI is a flat per-subsystem table:

| Subsystem | Fast rollback | Disaster recovery | Last DR | Actions |
|---|---|---|---|---|
| Postgres (system-db) | 6/6 snaps, 84 MiB | **`plugin-barman-cloud` → shim → `<target>`** | 2 min ago | Trigger / Restore PITR |
| Stalwart RocksDB | 6/6 snaps, 1.4 GiB (path B) / n/a (path A) | restic → shim raw → `<target>` | 10 min ago | Trigger / Restore |
| Bulwark | (off — toggle on) | restic → shim raw → `<target>` | yesterday | Trigger / Restore |
| Crowdsec | (off — toggle on) | restic → shim raw → `<target>` | last week | Restore |
| Monitoring | (off — toggle on) | (off — toggle on) | — | Configure |
| etcd | k3s local (auto) | **`etcd-snap-via-shim` CronJob → shim → `<target>`** | 1 hour ago | Restore |
| Secrets bundle | local file (canonical) | rclone push → shim raw → `<target>` | on rotation | Restore |
| Tenant bundles | n/a | rclone composite → shim → `<target>` | nightly | Per tenant |

Same flat shape on `/backups/tenants/:id` (per-tenant subsystems: tenant-bundle + on-demand PVC snapshots).

`/settings/backup-infrastructure` renamed to **`/settings/remote-storage-targets`**. Tabs: Targets / Class Routing. Class Routing tab shows 3 cards (SYSTEM, TENANT, MAIL).

---

## §15 Implementation phases (Path D-final, revision 2026-05-20)

| # | Phase | Scope | Hours | Risk |
|---|---|---|---|---|
| R1 | Schema migration 0012: 4→3 class enum + single-target-per-class table + backfill | 4 | L |
| R2 | bootstrap.sh adds 1× `RecurringJob local-thin-1h` (retain=6) default; label opt-in volumes | 3 | L |
| R3 | Adaptive housekeeper CronJob (10% / 500 MiB floor + disk-pressure handling + audit log) | 4 | L |
| R4 | New storage classes `longhorn-ha` + `longhorn-local`; deprecate old four | 6 | M |
| ~~R5~~ | ~~Degradation badges~~ **OBSOLETE** — shim eliminates degradation states | ~~4~~ 0 | n/a |
| R6 | Drop tenant PVC automatic backup; on-demand snapshot endpoint + UI; global quotas | 6 | M |
| **R-X0** | **Correct prior misleading docs commit** — this commit | 2 | L |
| **R-X1** | **`backup-rclone` image** — alpine + rclone + tini, multi-arch, signed, `ghcr.io/phoenixtechnam/backup-rclone:<sha>` pinned by digest | 3 | L |
| **R-X2** | **`BACKUP_TARGET_KEY` lifecycle** — bootstrap generates; Tier-1 in secrets bundle; `make backup-target-key-rotate` with 3-step confirm | 4 | M |
| **R-X3** | **Shim DaemonSet manifests** — DaemonSet + Service (`internalTrafficPolicy: Local`) + cert + NetworkPolicy + PDB; SMB CSI driver install for CIFS support | 5 | L |
| **R-X4** | **Multi-bucket config renderer + target schema** — supports S3 / SFTP / CIFS / NFS; emits rclone.conf per-class crypt + raw buckets; CIFS/NFS via Pod-volume mounts + `type=local` | 7 | M |
| **R-X5** | **Drain orchestration** — task-center polling; 5-min default; force-restart on timeout | 3 | M |
| **R-X6** | **Postgres `plugin-barman-cloud` wiring** — install plugin v0.12.0; `ObjectStore` CR points at shim ClusterIP; ScheduledBackup CR | 4 | M |
| **R-X7** | **`etcd-snap-via-shim` CronJob** — `k3s etcd-snapshot save` + zstd + rclone-to-shim | 3 | L |
| **R-X8** | **Restic callers via shim raw bucket** — bulwark/crowdsec/monitoring/mail-restic; CI guard rejects non-raw | 3 | M |
| **R-X9** | **rclone-push callers via shim** — secrets-bundle (raw), tenant-bundle (encrypted), snapshot-storage streaming-store (encrypted) | 4 | M |
| **R-X10** | **UI updates** — 3-class card preserved; target picker per type (S3/SFTP/CIFS/NFS); drain progress; encryption-key page | 5 | M |
| R8 | Secrets bundle multi-target upload + UI; modify `make secrets-fetch` for any shim raw bucket | 4 | L |
| **R-X11** | **Restore tooling** — `restore-postgres.sh`, `restore-etcd.sh`, `restore-tenant-bundle.sh`, `restore-secrets-bundle.sh`, `restore-mail.sh`; cold-cluster sequence in `BACKUP_RESTORE.md` | 6 | M |
| R10 | Drop tar+gzip+rclone tenant_snapshot path entirely | 4 | L |
| R11 | **DEFERRED** — Stalwart-on-Longhorn migration | n/a | n/a |
| R12 | Flat per-subsystem UI on `/backups/system` + `/backups/tenants/:id`; rename `/settings/backup-infrastructure` → `/settings/remote-storage-targets` | 6 | L |
| **R-X12** | **E2E DR drill** — 3 classes × 3 different upstreams (S3 + SFTP + NFS or CIFS); PITR; key-loss; drain; mid-backup restart | 6 | M |
| **R-X13** | **Archive legacy paths** (NOT delete) — move to `legacy/` subdirectories with deprecation README; CI guard | 3 | L |
| R14 | Mail storage visibility on local-path | 3 | L |
| **R-X14** | **Perf benchmark vs eval baseline** — re-run `rclone-shim-eval/` against production-config shim; verify ≥80% baseline | 3 | L |

**Total: ~75 hours / ~9-10 working days** (R1-R14 baseline + R-X0..R-X14). **R-X-only critical path: ~36 h** (R-X0 → R-X1 → R-X2 → R-X3 → R-X4 → R-X6 → R-X7 → R-X11 → R-X12) delivers functional postgres + etcd + tenant + mail backups on any target type with a DR drill.

**R11 deferred** to a follow-up RFC. Stalwart stays on `local-path` + restic. Operator visibility via R14 covers monitoring disk pressure.

---

## §16 Open questions (none)

All previously open questions resolved during the round-2/3/4 discussion:

| Q | Answer |
|---|---|
| Fast-rollback retention | retain=6 (6 hours rolling) |
| Housekeeper threshold | 10% with 500 MiB floor |
| Jitter for RecurringJobs | not needed at default scope (~4 volumes); add later if opt-in count grows |
| Tenant PVC backup | on-demand only (TTL=24h, 3 concurrent cap); bundles are DR |
| Tenant snapshot quotas | global setting in admin settings → new Tenant Settings page (NOT per-plan) |
| Tenant snapshot UI exposure | admin panel + tenant panel both — create / list / delete / restore |
| Monitoring PVC backup default | include in SYSTEM with default-off opt-in toggle |
| R11 (Stalwart-on-Longhorn) | deferred to follow-up RFC; R14 covers visibility on local-path until then |
| CNPG methods (revision 2026-05-20) | **`plugin-barman-cloud` v0.12.0** speaking S3 to local-node shim (shim translates to any backend); `volumeSnapshot` retained for in-cluster fast clone; PITR preserved via barman WAL archiving |
| etcd backup mechanism (revision 2026-05-20) | **`etcd-snap-via-shim` CronJob** — `k3s etcd-snapshot save` + zstd + `rclone copy --s3-endpoint=<shim>` |
| Multi-target | dropped; single target per class; classes can share or differ |
| rclone-serve-s3 shim | **ACCEPTED-EXTENDED** as universal mediator per ADR-043; DaemonSet, `internalTrafficPolicy: Local` |
| Degradation badges for SYSTEM | **OBSOLETE** — every subsystem works on every target via the shim |
| Supported target types | **S3, SFTP, CIFS, NFS** all first-class (operator-selectable); future-extensible to any rclone backend |
| Backup encryption key | **single platform-wide `BACKUP_TARGET_KEY`** in Tier-1 secrets bundle; drives rclone crypt + restic + shim S3 creds (HKDF-derived) |
| Stalwart logical export | deferred per ADR-042 |
| UI vocabulary | "Fast rollback" + "Disaster recovery" canonical |

---

## §17 Related ADRs

- **ADR-042**: Stalwart logical DB export via `stalwart -e` — deferred follow-up if path B ships (R11) and a corruption-survivable backup ever becomes a requirement
- **ADR-043**: `rclone serve s3` shim — **ACCEPTED-EXTENDED 2026-05-20** as universal backup mediator. Original scope (postgres + etcd escape) extended to ALL backup callers. Eval data ([`RCLONE_SHIM_EVALUATION`](./RCLONE_SHIM_EVALUATION.md)) confirms stability + performance + memory profile; R-X14 validates production-config performance.

---

## §18 Why this isn't the round-5 pgBackRest plan

For anyone reading old commit messages: the 2026-05-19 commit (`6d85c512` on main) referenced "`cnpg-plugin-pgbackrest`" as the postgres mechanism. **That plugin does not exist** (`gh search repos cloudnative-pg pgbackrest` returns only `cloudnative-pg/plugin-barman-cloud`, which is S3/GCS/Azure-only per its `BarmanObjectStoreConfiguration` source). The R-X0 commit corrects that mistake by adopting the rclone shim as the universal mediator — the path the empirical eval already validated. No code was written between the two commits — only docs — so the impact is limited to the doc correction.
