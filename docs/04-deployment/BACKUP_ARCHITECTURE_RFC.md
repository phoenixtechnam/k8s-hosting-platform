# RFC: Backup Architecture Simplification (Path A++)

**Status**: LOCKED — operator-approved 2026-05-19. Ready for implementation in Phase R1+.
**Owner**: Phoenix Tech
**Supersedes**: the multi-target / 4-class / restic-only proposals explored during round 2-3 of the design discussion.
**Related ADRs**: ADR-042 (Stalwart logical export, deferred), ADR-043 (rclone-serve-s3 shim, **WITHDRAWN — superseded by pgBackRest + etcd CronJob, see §12/§13**).

> **Revision 2026-05-19 (late round-5)**: `SYSTEM.postgres` swaps from barman-cloud to the **`cnpg-plugin-pgbackrest`** plugin; `SYSTEM.etcd` swaps from k3s `--etcd-s3` to a small **`backup-rclone-etcd` CronJob** (`k3s etcd-snapshot save` + rclone upload). Both mechanisms now natively support S3, SFTP, CIFS, and NFS (via in-pod kernel mount for posix-backed paths). **The "graceful per-subsystem degradation badges" concept becomes obsolete** — SYSTEM is now universal across all target types. PITR + incremental backups are preserved (pgBackRest is the v2 storage path the CNPG project itself is moving toward). The empirical eval in [`RCLONE_SHIM_EVALUATION`](./RCLONE_SHIM_EVALUATION.md) showed the rclone-serve-s3 shim *could* work; we chose pgBackRest anyway because it eliminates the always-on shim component AND keeps PITR. Net effort impact: roughly neutral (+12 h pgBackRest/CronJob, -10 h degradation-badge UI).

---

## §1 Goals (locked)

1. **One operator mental model**: 3 backup classes (SYSTEM, TENANT, MAIL); each class is one card with a single target picker; per-subsystem coverage status visible inline.
2. **Two backup layers with distinct vocabulary**: **Fast rollback** (Longhorn snapshots, automatic, opt-in subsystems, retain=6, 1h cadence) and **Disaster recovery** (remote backups, operator-configured, optional).
3. **Remote backup purely optional**: a cluster with no target rows still runs fast-rollback for opted-in subsystems. Strict-gating fires only for remote-upload schedules.
4. ~~**Graceful per-subsystem degradation**: when an operator picks a target that some subsystems can't use (e.g. SFTP for SYSTEM which contains postgres), the unsupported subsystems show as disabled-with-reason. No partial enablement is hidden.~~ **OBSOLETE per revision 2026-05-19** — pgBackRest + etcd-CronJob make SYSTEM universal across S3/SFTP/CIFS/NFS, no degradation states needed. The class-target compatibility validator still exists but its job collapses to "is this target reachable?" rather than per-subsystem capability matching.
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

| Subsystem | Mechanism | Required target capability |
|---|---|---|
| `SYSTEM.postgres` | **`cnpg-plugin-pgbackrest`** (CNPG plugin) | **S3 / SFTP / posix (CIFS/NFS via in-pod kernel mount)** |
| `SYSTEM.etcd` | **`backup-rclone-etcd` CronJob** (k3s `etcd-snapshot save` + rclone) | **any rclone backend** |
| `SYSTEM.secrets-bundle` | rclone push (age-encrypted file) | any |
| `SYSTEM.bulwark` | restic | any |
| `SYSTEM.crowdsec` | restic | any |
| `SYSTEM.monitoring` | restic (optional) | any |
| `TENANT.tenant-bundle` | rclone composite | any |
| `MAIL.stalwart-rocksdb` | restic (path A) | any |
| `MAIL.stalwart-rocksdb` | Longhorn native backup (path B) | S3 + NFS |

Every SYSTEM subsystem now accepts every target type. No degradation badges. UI per class card:

```
SYSTEM   target: hetzner-sftp         [Change target…]
├─ ✓ postgres      pgBackRest plugin → SFTP (full + WAL archiving, PITR on)  [Backup | Restore PITR]
├─ ✓ etcd          k3s snapshot + rclone → SFTP (hourly)                     [Backup | Restore]
├─ ✓ secrets       rclone push on rotation                                   [Restore]
├─ ✓ bulwark       restic backup nightly                                     [Trigger | Restore]
├─ ✓ crowdsec      restic backup weekly                                      [Trigger | Restore]
└─ ✓ monitoring    restic backup weekly (disabled by default)                [Configure]
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

**Revised 2026-05-19** — barman-cloud retired; uses the official [`cnpg-plugin-pgbackrest`](https://github.com/cloudnative-pg/plugin-pgbackrest) plugin.

The plugin is installed cluster-wide once (Flux manifest). The CNPG `Cluster` CR declares pgBackRest as the backup engine via the plugin CR; barman-cloud lines are removed from `spec.backup`:

```yaml
# CNPG Cluster CR
spec:
  plugins:
    - name: barman-cloud.cloudnative-pg.io   # leave for migration; remove after first new full
      isWALArchiver: false
    - name: pgbackrest.cloudnative-pg.io
      isWALArchiver: true
      parameters:
        configurationRef: system-postgres-backup   # PluginConfiguration CR (per-target)
  backup:
    retentionPolicy: "30d"
    volumeSnapshot:
      className: longhorn
      online: true
---
# PluginConfiguration CR materialised by platform-api from the SYSTEM target
apiVersion: pgbackrest.cloudnative-pg.io/v1
kind: PluginConfiguration
metadata:
  name: system-postgres-backup
  namespace: cnpg-system
spec:
  repo:
    type: s3        # or "sftp" or "posix" depending on target
    s3:             # populated only when target.storage_type == s3
      endpoint: "<from SYSTEM target>"
      bucket: "<from SYSTEM target>"
      region: "<from SYSTEM target>"
    sftp:           # populated only when target.storage_type == sftp
      host: "<from SYSTEM target>"
      user: "<from SYSTEM target>"
      keySecret: { name: system-backup-target, key: ssh_key }
    posix:          # populated when target.storage_type == cifs|nfs (initContainer mounts the share)
      path: "/mnt/backup-target"
  compression: zst
  retention: { full: 4, diff: 7, archive: 7d }
```

For CIFS / NFS targets, the CNPG instance pods get an `initContainer` that mounts the share to `/mnt/backup-target` (kernel `mount.cifs` / `mount.nfs4`, no privileged caps required on modern kernels).

A reconciler in `platform-api` maintains the `system-backup-target` Secret + the `PluginConfiguration` CR + the CNPG `Cluster` patch whenever the SYSTEM target changes. **No target-type gating** — works the same for S3, SFTP, CIFS, NFS.

**Both layers kept**: pgBackRest (off-cluster DR + WAL archiving + PITR) and `volumeSnapshot` (in-cluster fast clone).

**Restore**: single wizard at `/backups/system → Restore Postgres`. Operator picks target time T; orchestrator selects fastest path (volumeSnapshot if recent enough, else pgBackRest base + WAL replay via the plugin's restore flow); spawns new Cluster with `bootstrap.recovery` pointing at the plugin's repo. Mechanism hidden from operator.

**Migration** (existing clusters running barman-cloud): plugin and barman-cloud co-exist for one full pgBackRest cycle, then barman-cloud is removed and its bucket aged out. Operator runbook covers the migration step-by-step.

---

## §13 k3s etcd (SYSTEM.etcd subsystem)

**Revised 2026-05-19** — `--etcd-s3` retired in favor of a small CronJob that runs `k3s etcd-snapshot save` (always available, target-agnostic) and uploads the file via rclone (any backend).

`bootstrap.sh` defaults:
- `--etcd-snapshot-schedule-cron "0 * * * *"` (hourly; local snapshots only)
- `--etcd-snapshot-retention 24` (local thin layer)
- Local snapshots in `/var/lib/rancher/k3s/server/db/snapshots/` retained always (independent of any operator config)
- `--etcd-s3` flags are **NOT** rendered (the `backup-rclone-etcd` CronJob handles remote upload)

Remote backup is handled by a Kubernetes `CronJob` (`platform/backup-rclone-etcd`):
- `nodeSelector: node-role.kubernetes.io/control-plane`, `tolerations` to land on a control-plane node
- Schedule `0 * * * *` (configurable from `/settings/remote-storage-targets?tab=classes`)
- Image: `backup-rclone-etcd:<digest>` (alpine + rclone + k3s-binary; ~30 MiB)
- Steps: discover newest local snapshot under `/var/lib/rancher/k3s/server/db/snapshots/` (mounted via hostPath, read-only) → `rclone copy <snapshot> <target>:/etcd/` → write a per-snapshot `.meta` sidecar (timestamp + sha256) → enforce retention via `rclone delete` on entries older than the policy
- Reads upstream creds from the SYSTEM target's Secret (envFrom)
- `restartPolicy: OnFailure`, `backoffLimit: 2`, `ttlSecondsAfterFinished: 3600`

A reconciler in `platform-api` materialises the CronJob whenever the SYSTEM target changes. **No target-type gating** — works the same for S3, SFTP, CIFS, NFS, B2, GCS, etc.

New `make etcd-snapshot-list` CLI for operators.

**Restore**: download the snapshot via rclone (using the same creds), run `k3s etcd-snapshot restore <file>` on a fresh control-plane node. Runbook in `BACKUP_RESTORE.md`.

---

## §14 UI vocabulary (canonical)

Two phrases, two layers, one meaning each:

- **Fast rollback** = Longhorn snapshot, local-thin, retain=6, applies to opted-in subsystems only. Replaces all prior terminology: "filesystem snapshots", "local thin", "block snapshots", etc.
- **Disaster recovery** = remote backup to operator-configured target. Replaces "object backups", "remote", "off-cluster", "DR snapshots", etc.

`/backups/system` UI is a flat per-subsystem table:

| Subsystem | Fast rollback | Disaster recovery | Last DR | Actions |
|---|---|---|---|---|
| Postgres (system-db) | 6/6 snaps, 84 MiB | **pgBackRest + CSI snap** → `<target>` | 2 min ago | Trigger / Restore PITR |
| Stalwart RocksDB | 6/6 snaps, 1.4 GiB (path B) / n/a (path A) | restic → `<target>` | 10 min ago | Trigger / Restore |
| Bulwark | (off — toggle on) | restic → `<target>` | yesterday | Trigger / Restore |
| Crowdsec | (off — toggle on) | restic → `<target>` | last week | Restore |
| Monitoring | (off — toggle on) | (off — toggle on) | — | Configure |
| etcd | k3s local (auto) | **`backup-rclone-etcd` CronJob** → `<target>` | 1 hour ago | Restore |
| Secrets bundle | local file (canonical) | rclone push → `<target>` | on rotation | Restore |
| Tenant bundles | n/a | rclone composite → `<target>` | nightly | Per tenant |

Same flat shape on `/backups/tenants/:id` (per-tenant subsystems: tenant-bundle + on-demand PVC snapshots).

`/settings/backup-infrastructure` renamed to **`/settings/remote-storage-targets`**. Tabs: Targets / Class Routing. Class Routing tab shows 3 cards (SYSTEM, TENANT, MAIL).

---

## §15 Implementation phases (revised — Path A++, late round-5 revision 2026-05-19)

| # | Phase | Scope | Hours | Risk |
|---|---|---|---|---|
| R1 | Schema migration 0012: 4→3 class enum + single-target table + backfill | 4 | L |
| R2 | bootstrap.sh adds 1× `RecurringJob local-thin-1h` (retain=6) default; label opt-in volumes (system-db + Stalwart-conditional) | 3 | L |
| R3 | Adaptive housekeeper CronJob (10% cap with 500 MiB floor + disk-pressure handling + audit log) | 4 | L |
| R4 | New storage classes `longhorn-ha` + `longhorn-local`; deprecate old four | 6 | M |
| ~~R5~~ | ~~Soften strict-gate: per-subsystem graceful degradation; UI status badges; class-target compatibility validator~~ **OBSOLETE** — no degradation states post-pgBackRest. Collapses to a trivial "is target reachable?" validator (~1h, folded into R-S2). | ~~4~~ 0 | n/a |
| R6 | Drop tenant PVC automatic backup; on-demand snapshot endpoint + UI affordance (admin + tenant panel); TTL housekeeper; per-tenant quota | 6 | M |
| **R-S1** | **NEW** — Install `cnpg-plugin-pgbackrest` (Flux manifest, pinned by digest); verify against pinned CNPG version; smoke-test default S3 path | 2 | L |
| **R-S2** | **NEW** — platform-api wiring: SYSTEM target picker → materialise `PluginConfiguration` CR + target Secret + CNPG `Cluster` plugin block patch; handles S3/SFTP/CIFS/NFS paths; CIFS/NFS injects initContainer kernel mount | 5 | M |
| ~~R7~~ | ~~CNPG `spec.backup` reconciler (gated on SYSTEM target = S3) + Postgres restore wizard~~ **SUPERSEDED by R-S1 + R-S2**; restore wizard work moves to R-S3 | ~~9~~ 0 | n/a |
| R8 | Secrets bundle multi-target upload + UI card; modify `make secrets-fetch` | 4 | L |
| **R-S3** | **NEW** — `backup-rclone-etcd` CronJob: build image (alpine + rclone + k3s-binary, ~30 MiB, pinned digest); CronJob manifest with `nodeSelector: control-plane`, hourly upload + retention; platform-api reconciler materialises CronJob from SYSTEM target | 3 | L |
| ~~R9~~ | ~~k3s `--etcd-s3` defaults in bootstrap.sh (gated on SYSTEM target = S3) + UI surfacing~~ **SUPERSEDED by R-S3** | ~~3~~ 0 | n/a |
| **R-S4** | **NEW** — Restore procedures: `BACKUP_RESTORE.md` operator runbook + `scripts/restore-postgres.sh` (drives pgBackRest plugin restore CR) + `scripts/restore-etcd.sh` (rclone download + `k3s etcd-snapshot restore`); unified restore wizard at `/backups/system` | 5 | M |
| R10 | Drop tar+gzip+rclone tenant_snapshot path entirely (now unused — tenant DR is bundles only) | 4 | L |
| R11 | **DEFERRED** — Stalwart-on-Longhorn migration. Not in initial scope; will be a follow-up RFC once v1 is soaking. See "Mail storage visibility on local-path" below. | n/a | n/a |
| R12 | Flat per-subsystem UI on `/backups/system` and `/backups/tenants/:id`; rename `/settings/backup-infrastructure` → `/settings/remote-storage-targets` | 6 | L |
| R13 | Drop dead code (legacy WalArchiveTab, multi-target paths, tenant_snapshot scheduler, barman-cloud reconciler after migration window) | 3 | L |
| R14 | **Mail storage visibility on local-path**: surface Stalwart RocksDB usage (bytes used / available, growth rate, last-restic-run size) on `/backups/system` MAIL subsystem card. Required because R11 is deferred and operator must monitor disk pressure on the local-path PVC. | 3 | L |
| **R-S5** | **NEW** — Migration runbook for existing clusters running barman-cloud: keep both engines for one full pgBackRest cycle, then strip barman-cloud + age out its bucket. Smoke against staging before merging. | 3 | M |
| **R-S6** | **NEW** — E2E DR drill: backup → simulated cluster loss → restore from each of (S3, SFTP, CIFS, NFS) targets; PITR test (restore to specific timestamp); etcd restore on fresh control-plane node | 4 | M |

**Total: ~58 hours / ~7-8 working days.** Critical path: R1 → R2 → R3 → R-S1 → R-S2 → R-S3 → R-S4 → R12 (~32 h, the user-visible simplification + working S3-free backups — can ship as v1 baseline before the deeper polish work).

**Net effort change vs prior locked plan**: was 56 h with R5+R7+R9 totaling 16 h of degradation-badge / barman-cloud reconciler / etcd-s3 plumbing; now those are 0 h, replaced by R-S1..R-S6 totaling 22 h of pgBackRest + etcd-CronJob + restore + migration + DR-drill work. Net **+6 h** for a meaningfully simpler operator model (universal target compatibility, PITR preserved, S3 dependency eliminated).

**R11 deferred** to a follow-up RFC. Until that RFC ships, Stalwart stays on `local-path` and uses restic for DR. Mail data has no fast-rollback layer (no CSI snapshot capability on local-path). Operator visibility via R14 covers monitoring disk pressure.

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
| CNPG methods (revision 2026-05-19) | **`cnpg-plugin-pgbackrest`** (PITR + universal target support) + `volumeSnapshot` (in-cluster fast clone) |
| etcd backup mechanism (revision 2026-05-19) | **`backup-rclone-etcd` CronJob** — `k3s etcd-snapshot save` + rclone upload, any rclone backend |
| Multi-target | dropped; single target per class |
| rclone-serve-s3 shim | **WITHDRAWN** per ADR-043 — pgBackRest + etcd CronJob make it unnecessary |
| Degradation badges for SYSTEM | **OBSOLETE** — SYSTEM is now universal across target types |
| Stalwart logical export | deferred per ADR-042 |
| UI vocabulary | "Fast rollback" + "Disaster recovery" canonical |

---

## §17 Related ADRs

- **ADR-042**: Stalwart logical DB export via `stalwart -e` — deferred follow-up if path B ships (R11) and a corruption-survivable backup ever becomes a requirement
- **ADR-043**: `rclone serve s3` shim for non-S3 SYSTEM-class backends — **WITHDRAWN 2026-05-19**, superseded by §12 (`cnpg-plugin-pgbackrest`) + §13 (`backup-rclone-etcd` CronJob). The empirical eval ([`RCLONE_SHIM_EVALUATION`](./RCLONE_SHIM_EVALUATION.md)) showed the shim *could* work; pgBackRest was chosen anyway because it eliminates the always-on shim component while keeping PITR + incremental backups.
