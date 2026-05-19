# ADR-042: Stalwart logical DB export via `stalwart -e`

**Status**: DEFERRED — captured for future work, not currently scheduled.
**Decision date**: 2026-05-19
**Trigger to ship**: explicit operator request, OR a confirmed RocksDB-corruption incident on a production cluster, OR a customer compliance requirement for portable mail export.

## Context

The Stalwart mail server uses RocksDB as its data store. Today we have two backup mechanisms (and the [BACKUP_ARCHITECTURE_RFC](../04-deployment/BACKUP_ARCHITECTURE_RFC.md) Phase R11 may introduce a third):

| Mechanism                    | Layer       | Captures                       | Survives                                        |
| ---------------------------- | ----------- | ------------------------------ | ----------------------------------------------- |
| Longhorn native backup       | Block       | RocksDB SST + WAL at rest      | Host failure; FS corruption above block layer   |
| restic                       | File        | Same SST + WAL files           | Host failure; FS corruption above filesystem    |
| `stalwart -e` (this ADR)     | **Logical** | DB content semantics (JSONL)   | **SST corruption; RocksDB format changes; bit-rot in WAL** |

The first two are **crash-consistent** — RocksDB's WAL replay handles partial-write state on restore, so both work for "the server crashed mid-write" scenarios. **Neither survives logical-level corruption** (e.g. an SST file gets bit-rotted on disk and the corruption is replicated to the backup before being noticed).

Logical export via `stalwart -e` writes the DB content to portable JSON-Lines files — bytes that are inherently independent of the RocksDB format. Restore via `stalwart -i` reads those files into a fresh DB.

## Why we're not shipping it now

1. **Live-DB constraint.** `stalwart -e` requires DB-open access, which conflicts with the LOCK file held by the running Stalwart process. Either:
   - Pause the live Stalwart pod (mail downtime), run the export, resume — operationally invasive.
   - Run a sidecar with read-only RocksDB open — RocksDB's read-only mode bypasses LOCK in most builds but not all. Stalwart binary support uncertain.
   - Run the export against a Longhorn snapshot clone — requires Stalwart-on-Longhorn (RFC Phase R11) to be live + a workflow that clones a snapshot to a side PVC, runs `stalwart -e` against that, then deletes the clone.
2. **Operationally complex.** Each of the above paths adds moving parts (pause/resume orchestration, sidecar variant, snapshot-clone workflow). All three are non-trivial.
3. **Real risk model is small.** RocksDB-format corruption that defeats both Longhorn block-level + restic file-level capture is theoretically possible but very rare in practice. We've never observed it across the platform. The simpler mechanisms cover 99% of realistic disasters.
4. **Tenant export is partly covered already.** The tenant-bundle (Plesk-style) export at `tenant-bundles/` includes the tenant's mailboxes as a JSON-derived export already — covers per-tenant scenarios (data takeout, GDPR, migration). The gap is platform-wide DB-level export, which is what ADR-042 covers.

## Decision

Defer. Keep Longhorn backup + restic as the operational backup paths.

## When we'd revisit

- Operator filed a feature request explicitly for "I need a corruption-survivable mail backup"
- A production cluster experiences RocksDB-format corruption (any kind, not necessarily catastrophic)
- A customer asks for "mail data takeout" at the *platform* level (vs. per-tenant takeout, which already exists)
- A compliance audit cites "logical-export capability" as a requirement

## Design sketch (for whoever picks this up)

Pick path 3 — snapshot-clone — as the least operationally invasive. Requires RFC Phase R11 (Stalwart-on-Longhorn) to be shipped first.

Flow:
1. New CronJob `stalwart-logical-export` in `mail` namespace, daily at low-traffic hour
2. Take a fresh Longhorn snapshot of `stalwart-rocksdb-data` (cheap, atomic)
3. Clone that snapshot to a side PVC `stalwart-export-clone` (`numberOfReplicas: 1`, ephemeral)
4. Spawn a Job using the `stalwart-mail` image, mount the clone read-only, run `stalwart -e --target /export`
5. tar+rclone the export directory to the MAIL-class target (or a separate `system_mail_export` target)
6. Delete the snapshot clone
7. Report to platform-api `/internal/mail/logical-export/last-run`

Restore: separate operator-initiated flow that downloads the export, spawns a fresh Stalwart pod with `stalwart -i` against the downloaded directory.

Estimated effort: 18-24h (matches the path β from the round-2 plan).

## Trade-offs vs current backup paths

| Property                 | Block (Longhorn) | File (restic) | Logical (`stalwart -e`) |
| ------------------------ | ---------------- | ------------- | ----------------------- |
| Survives DB-format change | No               | No            | Yes                     |
| Survives SST corruption   | If corruption post-snap | If corruption post-restic | Yes (re-reads via DB engine) |
| Backup size              | Block-level (vol size) | Dedup-compressed | Smaller (JSON, but verbose for tiny rows) |
| Backup time              | Fast (block CoW) | Medium (file walk) | Slow (full DB scan) |
| Restore time             | Fast (clone)     | Medium (download + extract) | Slowest (re-import every record) |
| Cluster portability      | No (Longhorn-specific) | Yes      | Yes                     |
| Cross-version restore    | No               | No            | Yes (Stalwart can `-i` from older `-e`) |
