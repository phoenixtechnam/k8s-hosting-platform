# ADR-036 — Tenant Backup v2: restic + JMAP + Maildir

**Status:** Proposed (2026-05-09)
**Supersedes:** ADR-032 (BackupStore + bundle orchestration) for the daily-incremental path. ADR-032 remains the description of the legacy bundle format, which is being removed without a coexistence window — see "Backwards compatibility" below.
**Amends:** ADR-034 (restore execution + cart pattern) — extends the cart-item selector with restic-snapshot and JMAP-message kinds.
**Related:** ADR-035 (tenant data coverage contract — unchanged).

## Context

The Phase-4 tenant-bundle stack (ADR-032) treats every nightly backup as a full archive: re-tar the entire `{ns}-storage` PVC, re-pull every mailbox over IMAP via mbsync, dump every config row, encrypt every TLS Secret. This is the right shape for a Plesk-style **GDPR/cold export** but the wrong shape for **daily backups with object-level restore** at 50–500 tenants:

- **Storage**: 100 tenants × 5 GiB PVC × 30 daily snapshots ≈ 15 TiB. Naïvely scaled to 500 tenants this is 75 TiB on object storage — a hard fail against the < $200/month budget.
- **CPU and wall-clock**: mbsync re-pulls every message over IMAPS for every mailbox every run. A 10 000-message mailbox takes ~5–15 min and is single-threaded per account.
- **Memory and tmpfs**: the `mail-backup-tools` Job and intermediate scripts have leaked into host `/tmp` (which is tmpfs) on multiple occasions; full archives buffered on `emptyDir` have caused node disk pressure (see `project_files_streaming_e2e_2026_05_07`).
- **Restore granularity**: today there is no path to "restore just `/var/www/.../foo.jpg`" or "restore one message" without unpacking the full bundle in a side cluster.

Recent platform changes that reframe the design space:

1. **Stalwart 0.16+ uses PostgreSQL as its sole data store** (`k8s/base/stalwart-mail/stalwart/configmap.yaml:45-63`, `"@type": "PostgreSql"`). All mail content, headers, and blob bodies live in the `mail-db` CNPG cluster. There is no Maildir on disk and no separate file/blob store.
2. **`mail-db` already ships continuous WAL via CNPG Barman Cloud Plugin v0.12.0**, providing cluster-level PITR independent of per-tenant tooling.
3. **Tenant application databases live as `databases/<engine>-<suffix>/` subdirs on the same `{ns}-storage` PVC** that the `files` component captures (`backend/src/modules/deployments/db-manager.ts:1856-1858`). They are FS-captured today; the gap is *consistency*, not *coverage*.

## Decision

Replace the daily backup path with two primitives, kept inside the existing `tenant-bundles` module so the orchestrator/scheduler/retention/coverage-audit machinery stays in place.

### Primitive 1 — restic per-tenant repository for files

- One repository per `(clientId, component)` at:
  - `<store>/restic-files/<clientId>/`
  - `<store>/restic-mail/<clientId>/`
- Per-tenant password derived deterministically: `password = HKDF-SHA256(OIDC_ENCRYPTION_KEY, info="restic-tenant-${clientId}")`. No new key material to manage; rotation policy follows ADR-032 §7's KID scheme.
- restic process runs on the **platform-api side**. Tenant Job streams the prepared payload (PVC tar, or Maildir tarball) over the existing HMAC-authenticated `internal-upload-route` endpoint; platform-api pipes the request body straight into a `restic backup --stdin` subprocess. **S3 credentials never enter the tenant namespace.**
- Per-pod concurrency cap `TENANT_BUNDLES_MAX_CONCURRENT_RESTIC` (default 4) enforced by an in-process semaphore in `restic-driver.ts`.
- Optional cluster-wide cap `tenant_backup_global_max_in_flight` (default 0 = unlimited) implemented via numbered Postgres `pg_try_advisory_lock(N)` slots — pure SQL, no Redis.

### Primitive 2 — JMAP-driven mail capture into Maildir-shaped tree

- For each tenant mailbox, the Job runs `jmap-sync.py` (Python stdlib, ~200 lines, no third-party deps) inside the existing `mail-backup-tools` image (rebased on `debian:trixie-slim`).
- The script authenticates as the **Stalwart master user** (same credentials webmail/mbsync use today, mounted from `roundcube-secrets` Secret) and uses the master-user proxy login `<addr>%<masterFQ>` to read each tenant mailbox.
- It reads `lastJmapState` from the `tenant_jmap_state` table per `(clientId, mailboxJmapId)`, calls `Email/changes`, fetches `created`+`updated` bodies via `Blob/get`, writes them into a **Maildir-shaped output tree**:
  ```
  <accountAddress>/<mailboxName>/cur/<unix>.<unique>:2,<flags>
  ```
  where `<flags>` is the [Maildir](https://cr.yp.to/proto/maildir.html) flag suffix (`S`=`$seen`, `F`=`$flagged`, `R`=`$answered`, `T`=`$deleted`, `D`=`$draft`).
- The output tree is `tar -cf -`'d and streamed to platform-api on the same upload route as the files component.
- `lastJmapState` is persisted **only after** the restic snapshot is acknowledged. Re-ingestion on crash is harmless because restic content-dedups.
- A sidecar `index.jsonl` records `{jmapId, mailboxPath, messageId, receivedAt}` per message for fast object-level lookup; it is NOT a portability dependency — every message is restorable from raw RFC 5322 alone.

### Primitive 3 — pre-capture logical dump of tenant application databases

- Before the files-component restic capture runs, a small **platform-api-side helper** (`tenant-bundles/components/database-predump.ts`) iterates `SELECT * FROM databases WHERE client_id = ?` and for each row calls the **existing** SQL Manager primitive `db-manager.ts:exportDatabaseToPvc`.
- `exportDatabaseToPvc` runs `mysqldump`/`mariadb-dump` (with `--routines --triggers`) or `pg_dump` **inside the live tenant DB pod** via `execInPod`, using the credentials already owned by the SQL Manager. The dump file lands on the tenant PVC under `/exports/<filename>.sql` (moved there by the existing file-manager step in that helper).
- The files-component restic capture then snapshots the PVC including the dumps that are now already there. Restore offers two paths: full PVC re-hydrate (raw on-disk files; engine-specific recovery may be needed) OR logical re-import via the existing `db-manager.ts:importSqlFromPvcFile` (replays the SQL through the live DB pod; guaranteed consistent).
- This is **not** a new bundle component. The `databases` table stays under the `config` component (metadata only). The `files` component continues to claim `{ns}-storage` per ADR-035 — its capture content now happens to include guaranteed-consistent dumps as well as raw bytes.
- **Explicit non-goal:** the backup-tool image does NOT carry any DB client binaries. Adding `mariadb-client`/`postgresql-client` to a backup pod would duplicate the tenant DB image's existing tools, require a second credential plane (root password mounted to the backup ns), and open a network path from the backup pod to the live tenant DB. None of that is necessary because `exportDatabaseToPvc` already orchestrates the dump from inside the tenant DB pod itself.

### What stays unchanged

- `config` and `secrets` components remain full each run. They are tens of KiB combined; dedup machinery is not worth the engineering cost. PITR for tenant config rows is already covered by CNPG WAL on the system DB.
- The `meta.json` commit marker pattern remains — the only change is that `BackupComponentArtifact` for `files` and `mailboxes` is now a discriminated `{ kind: 'restic-snapshot', repoUri, snapshotId, parentSnapshotId, fileCount, sizeBytes }` rather than `{ archiveTar, sha256 }`.
- The Tier-1 5-min scheduler with cross-replica CAS continues to drive nightly bundles. It already parallelises across tenants in HA mode without code changes.
- The retention sweeper continues to drive expiry; its `delete()` path now calls `restic forget --keep-daily N --prune` (configurable global setting) for incremental components and the legacy delete path for the `config`/`secrets` artefacts.
- The Plesk-style restore cart (ADR-034) is extended in place. The cart-item selector gains an optional `{ snapshotId, repoUri }` for files-paths and a new `{ snapshotId, mailboxPath, messageId }` selector for mailboxes-by-message-id.
- The GDPR data-export path (`data-export.ts`) is unchanged. If the latest bundle is incremental-only and an operator triggers GDPR export, the route triggers a one-shot full-mode capture before wrapping the `tar.gz.enc` envelope.
- WAL archive on `mail-db` continues independently. It covers cluster-level DR at 5-min RPO; the per-tenant restic-of-JMAP path covers per-tenant point granularity. No double-counting.

### Backwards compatibility

**No coexistence window.** Existing bundles produced by the legacy tar path may be deleted at cutover. The legacy `mailboxes.ts` mbsync flow is removed in the same PR as the JMAP rewrite (no `legacy_mbsync` kill-switch). The legacy `files.ts` tar-only flow is removed in the same PR as the restic switch. Restore-executor branching by `dump.format` is removed; there is one path.

This is the operator's explicit decision: deleting prior staging bundles is acceptable; the simplification is preferred.

### HA + parallelism

- Across tenants: free via existing scheduler CAS. 100 tenants × 3 platform-api replicas → ~3 min nightly window (vs ~8 min single replica).
- Within a tenant: components run sequentially in the orchestrator (~20s total at incremental). No parallelism added.
- Same-tenant double-dispatch: prevented by both the scheduler CAS and restic's per-repo lockfile (defence in depth).
- Cluster-wide concurrency cap: `tenant_backup_global_max_in_flight` (default 0). Recommended value 8 for 3-replica HA at 500 tenants to bound object-store rate-limit pressure.

### Multi-region migration + DR (Phase 1.5)

The tenant-backup repo is designed so a Region B operator can mount a Region A repo **read-only** and restore tenants from it without write access or shared master credentials. This supports two operator scenarios uniformly:

1. **Migration**: tenant moves from Region A to Region B. Region B mounts the bucket read-only, picks the tenant's latest snapshot, restores it under a new (or reused) tenant identity.
2. **Disaster recovery**: Region A is wiped. Region B's operator-owned mirror of the bucket (or the same bucket if it survived) is mounted read-only; tenants are restored one by one.

**Snapshot tag schema (mandatory at write time, frozen as `BUNDLE_SCHEMA_VERSION = 2`):**

```
bundle-version=2          # bumps with breaking restore-side changes
platform-version=<sha>    # source-region platform-api version
region=<source-region-id> # derived from PLATFORM_BASE_DOMAIN, slugified
tenant-id=<clientId>      # source-region clientId
tenant-slug=<slug>        # human-friendly identifier from clients.slug
bundle-id=<backupId>      # links to source-region backup_jobs row
component=files|mailboxes
```

`restic snapshots --tag region=eu-fsn1 --tag tenant-slug=acme-corp --json` is the canonical way for any operator (in any region) to identify portable snapshots.

**Region id**: derived from `PLATFORM_BASE_DOMAIN` (already in `backend/src/config/domains.ts`). Slugified by replacing dots with dashes so tags stay shell-safe in any context. e.g. `staging.success.com.na` → `staging-success-com-na`. Operator-overridable via `tenant_backup_v2_settings.region_id_override` if needed.

**Repo URL portability**: `s3:https://fsn1.your-objectstorage.com/k8s-staging/restic-files/<clientId>` works identically from any cluster that can reach the endpoint. No region-specific transformation. Region B creates a `backup_configurations` row pointing at the same bucket (read-only IAM on its side) and registers it as an `external_backup_repos` row.

**DR key derivation (Option A + C — chosen 2026-05-09)**:

Per-tenant restic password used by the source region remains `HKDF(OIDC_ENCRYPTION_KEY, "restic-tenant-" + clientId)` — only the source region can derive it. After the first successful backup for a (clientId, component), the orchestrator runs `restic key add` to attach a SECOND password derived from a separate `DR_RECOVERY_KEY` held in `tenant_backup_v2_settings.dr_recovery_key_encrypted`:

```
dr_password = HKDF(DR_RECOVERY_KEY, "dr-recovery:" + clientId)
```

`DR_RECOVERY_KEY` is a 32-byte secret generated once per cluster, stored encrypted at rest under `OIDC_ENCRYPTION_KEY`, shared out-of-band with Region B's operator. Region B reproduces `dr_password` deterministically. Rotation = generate new key, run `restic key add new; restic key remove old` cluster-wide via background sweeper.

**Option C (per-migration ad-hoc keys)**: in addition, the admin UI exposes "Generate one-shot migration key" which calls `restic key add` with a freshly random 32-byte password, prints it once, and the operator hands it to Region B for a single migration. Operator's responsibility to revoke after.

Operator may run with **Option A only** (default), **Option B only** (set `dr_recovery_key_encrypted = NULL` so no auto-add happens; use one-shot keys per migration), or **A + C** (both available).

**Read-only restore**: `restic --no-lock` is used for all reads against external repos. Restic's lock model only takes locks for write operations (`backup`, `forget`, `prune`); reads with `--no-lock` skip lock acquisition entirely. Region A backing up while Region B restores from the same repo is safe. Region B's bucket access SHOULD additionally be IAM-restricted to read on its side; documented in the operator runbook.

**Concurrent access safety**:
- Region A `restic backup` takes per-repo lock during write.
- Region B `restic snapshots --no-lock` and `restic restore --no-lock` skip the lock.
- A Region A `restic forget --prune` mid-restore could in theory race a snapshot the Region B reader is materialising. Mitigation: `forget --prune` runs on a separate retention cron, NOT during a backup window; AND the read-only restore uses `--no-lock` so it sees the snapshot list as-of-open and reads packs that match. If a pack is pruned mid-restore, restic surfaces a clear error and the restore can be retried. Documented in the operator runbook.

**Cross-region restore executor**:

```ts
restoreFromExternalRepo({
  sourceTarget,            // resolved BackupTarget (read-only)
  sourceSnapshotId,        // restic snapshot id from sourceTarget
  targetClientId?,         // override: which local clientId receives the data
  targetSlug?,             // override: tenant slug at the destination
  passwordHex,             // either DR password or one-shot key
})
```

If `targetClientId` is omitted, parsed from snapshot tag `tenant-id=…`. If `targetSlug` is omitted, parsed from `tenant-slug=…`. Cross-tenant guard adapted: skips the local `dump.clientId === restoreJob.clientId` invariant (it's intentionally cross-region) but enforces:

1. The source repo URI matches a row in `external_backup_repos` (operator-allowlisted).
2. Every snapshot's `bundle-version` is ≤ the local `BUNDLE_SCHEMA_VERSION` (forward-compatible only).
3. UI requires explicit operator confirmation: "Restore tenant X (region eu-fsn1) INTO this region as tenant Y" with the source region prominently displayed.

### Future open door (NOT in scope)

When Stalwart is configured to use S3 as its blob store, JMAP `Blob/get` becomes a server-side proxy that re-reads from S3. In that configuration there is a path where the backup does not transfer bytes at all — it just records the blob hash and Stalwart's bucket reference. This is documented as a future optimisation in this ADR but is **not implemented now**.

### Resource budget (concrete targets)

Per typical tenant: 5 GiB PVC, 1 GiB mailbox, 5 000 messages, 1 % daily churn.

| Scenario                     | CPU         | RAM      | Network    | Wall-clock | platform-api delta |
|------------------------------|-------------|----------|------------|------------|--------------------|
| files baseline               | 1 c × 60 s  | <256 MiB | ~5 GiB     | ~60 s      | <1 GiB             |
| files incremental            | 0.2 c × 8 s | <64 MiB  | ~50 MiB    | ~10 s      | <200 MiB           |
| mail baseline (5k msgs)      | 0.5c × 90 s | <256 MiB | ~1 GiB     | ~90 s      | <400 MiB           |
| mail incremental (50 new)    | 0.2 c × 5 s | <128 MiB | ~10 MiB    | ~5 s       | <150 MiB           |
| single file restore          | 0.1 c × 1 s | <64 MiB  | ~1 MiB     | ~2 s       | <150 MiB           |
| single message restore       | 0.1 c × 1 s | <64 MiB  | ~50 KiB    | ~2 s       | <150 MiB           |
| GDPR full-bundle import      | 1 c × 120 s | <512 MiB | ~6 GiB     | ~150 s     | <800 MiB           |

Storage at 100 tenants: ~640 GiB total (vs ~18 TiB legacy). At 500 tenants: ~3.2 TiB (~$15/mo at Hetzner Object Storage).

## Consequences

**Positive**

- Daily backups become incremental and dedup'd. Storage cost drops ~28×.
- Object-level restore (single file, single message) becomes a first-class operation, in seconds.
- mbsync removal eliminates the per-message IMAP RTT hot path that today dominates mail-backup CPU.
- The `mail-backup-tools` image base aligns with `peer-firewall-reconciler` (`debian:trixie-slim`), reducing the platform's distinct base-image surface.
- Maildir-shaped output stays operator-portable — any IMAP server can ingest the tarball without `Email/import`.

**Negative**

- New dependency on restic CLI. Pinned in image, version-checked in CI.
- New JMAP client code (`jmap-sync.py`). Pure-stdlib Python keeps the dependency footprint at zero, but it is the first non-trivial JMAP client we own.
- platform-api now runs subprocesses (restic) per backup. Concurrency cap and process lifecycle become operator-visible concerns. Bounded by the in-process semaphore + the optional cluster-wide pg-advisory-lock cap.
- Restore of a mailbox via `Email/import` re-issues UIDs server-side. Threading is preserved by `Message-ID`, but operator-runbook entry is needed so a tenant doesn't expect old UIDs.
- `OIDC_ENCRYPTION_KEY` rotation now requires `restic key add` then `restic key remove` on every per-tenant repo. Documented in the runbook; operator-driven.

## Cross-tenant isolation

Two-layer guard at every restore-executor entry:

1. `dump.clientId === restoreJob.clientId` (ADR-034 invariant, unchanged).
2. `repoUri.startsWith('${storeBase}/restic-{files|mail}/${clientId}/')` (new). Cryptographically reinforced because the repo password is per-tenant; even on misconfiguration, restic refuses to open with the wrong password.

## Coverage contract impact (ADR-035)

`BUNDLE_COMPONENTS[*]` for `files` and `mailboxes` gains `mode: 'incremental' | 'full'` annotation. Schema-audit and resource-audit CI scripts unchanged. The `databases` table stays under the `config` component (metadata-only — accurate). No new top-level component.

## References

- `docs/02-operations/TENANT_BACKUP.md` — operator runbook (replaced section by section as phases ship)
- `docs/02-operations/TENANT_BACKUP_V2_ROADMAP.md` — phase progress tracker
- ADR-032 — legacy bundle format (now historical for the daily path)
- ADR-034 — restore cart, amended
- ADR-035 — coverage contract, unchanged
- `project_pg18_migration_complete` (memory) — mail-db CNPG cluster shape
- `project_pitr_e2e_2026_05_03` (memory) — system-db PITR primitives
- `project_files_streaming_e2e_2026_05_07` (memory) — current files-component streaming pipeline (preserved)
- `project_mailbox_rewrite_2026_05_05` (memory) — mbsync pivot (now reversed)
