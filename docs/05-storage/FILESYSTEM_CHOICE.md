# Filesystem Choice for Longhorn Volumes

## TL;DR

| Tier   | Filesystem | Why |
|--------|------------|-----|
| tenant | XFS        | Empty-volume overhead drops from ~228 MiB → ~40 MiB on a 10 GiB volume; we never online-shrink so XFS's missing shrink isn't a constraint. |
| system | ext4       | Volumes fill up quickly (Postgres, Stalwart) so the empty-volume win doesn't apply; keeping ext4 limits the change footprint on platform components. |
| mail   | ext4       | Same reasoning as system — these volumes carry mailbox data that grows continuously. |

The platform is **heterogeneous** today: existing tenant PVCs were
provisioned with ext4 and are kept as-is. Only newly provisioned
tenant PVCs use XFS. There is no migration; staging clients are
expendable. The storage-placement endpoint surfaces `fsType` per PVC
so operators can see which is which.

## Why XFS for tenant volumes

ext4 reserves ~5% for the root user and writes a heavy static inode
table at mkfs time. On a freshly formatted 10 GiB Longhorn volume
this manifests as `Volume.status.actualSize` ≈ 228 MiB before a
single byte of user data has been written. The Storage Lifecycle
table on the client detail page surfaces this as a misleading
"used" figure, and admins burned operational time investigating
"why does the new tenant's volume already have data".

XFS allocates inodes dynamically as files are created. A fresh
empty 10 GiB XFS volume reports ~40 MiB of `actualSize` — a
~190 MiB win, scaled across hundreds of tenant volumes.

### Why this is safe for us

XFS's well-known limitation is that it cannot be shrunk while
online (or at all, in some configurations). For a generic
filesystem this would be a hard constraint, but for this platform:

- **Resize is always destroy+recreate.** See
  `backend/src/modules/storage-lifecycle/service.ts:runResize`.
  The flow is snapshot → quiesce → delete PVC → recreate at new
  size → restore from snapshot. Both shrink AND grow take this
  path. There is currently no online-grow split — a future
  optimization would be to grow with `xfs_growfs` (which IS
  supported), but that's out of scope for the migration PR.
- **Repair tooling is shipped.** `bootstrap.sh` installs
  `xfsprogs` and `e2fsprogs` on every node. The fsck endpoints
  (see Health/Repair section below) require both regardless of the
  per-PVC fsType, so we install both.

## Why ext4 stays on system / mail

System StatefulSets (Postgres, Stalwart) and mail volumes accumulate
data on a different curve than tenant volumes. Postgres preallocates
extents during normal operation; Stalwart writes mailbox metadata
continuously. The empty-volume overhead is paid once and quickly
lost in the noise. Switching these classes to XFS would:

- Force a delete+recreate of the StatefulSet on existing installs.
  ext4 → XFS isn't an in-place migration.
- Change the operational characteristics of these services with no
  user-visible benefit.

The operational cost dominates the small-fixed-overhead benefit,
so we leave them on ext4.

## Health and repair

The platform exposes per-PVC filesystem health on the client detail
page's "Persistent volumes" table:

- **fsType** — sourced from `PV.spec.csi.volumeAttributes.fsType`
  (Longhorn copies the StorageClass parameter through here).
- **State / Robustness** — straight pass-through of the Longhorn
  Volume CR's `status.state` + `status.robustness`.
- **Replicas (healthy/expected)** — running replicas (from the
  Longhorn Replica CR list, filtered to `currentState === 'running'`)
  vs `Volume.spec.numberOfReplicas`. A divergence flags either a
  rebuild in progress or a stuck-pending replica.
- **engineConditions** — abnormal entries (`status === True`) from
  `Volume.status.conditions[]`, filtered to exclude `Scheduled`
  (which is True in the healthy case). Surfaced in the table next
  to the action buttons.
- **lastBackupAt** — RFC3339 timestamp of the most recent recurring
  backup (from `Volume.status.lastBackupAt`).

### Operator runbook: filesystem check

The "Check" button on each PVC row triggers an asynchronous
operation:

1. Quiesce — scale all tenant Deployments (including the file
   manager sidecar) to 0 replicas. xfs_repair / e2fsck refuse to
   operate on a mounted filesystem even with `-n`.
2. Wait until Longhorn detaches the volume from the workload node.
3. Schedule a privileged Pod onto the node where the volume's
   engine pod is currently attached. The Pod hostPath-mounts
   `/dev/longhorn` and runs `xfs_repair -n -v $DEV` (XFS) or
   `e2fsck -n -fv $DEV` (ext4).
4. Capture the tool's stdout+stderr. Up to 64 KiB.
5. Unquiesce — scale the workloads back up to their pre-quiesce
   replica counts.

Output goes into the operation's `progressMessage` (clean) or
`lastError` (errors found). The Storage Lifecycle UI surfaces this
in a modal with the full report.

**Interpreting the report:**

- Exit 0, "no modify needed" / "Pass 5: …" / "clean" — volume is
  healthy. Safe to dismiss.
- Exit 0 but message contains "would have" / "would fix" — the
  filesystem has reparable inconsistencies. Run a snapshot first
  (Storage Lifecycle → Take snapshot), then run Repair.
- Exit ≥ 4, "BAD SUPERBLOCK" / "lost+found" / "I/O error" — the
  filesystem may need a manual `xfs_repair -L` (zero log) or a
  full restore from backup. Don't run automated repair; escalate
  to the on-call DBA / operator.
- Tool failed to start (`exit=65 block device not found`) — the
  fsck Pod was scheduled before Longhorn detached the volume.
  Wait 30s and retry; the orchestrator will re-quiesce.

### Operator runbook: filesystem repair

The "Repair" button is gated by a confirmation modal (the action
writes to disk and may move corrupted files into `lost+found`).
The flow is identical to "Check" except the fsck tool is invoked
without `-n` (`xfs_repair -v`, `e2fsck -y -fv`).

**Before repairing**:

1. Take a snapshot via Storage Lifecycle → Take snapshot. Repair
   can lose data on a badly damaged filesystem; the snapshot is
   your rollback path.
2. Verify there's free space in the snapshot store
   (Settings → Storage Lifecycle → Snapshot Store).

**After repairing**:

- Operation state `idle` + report message "CLEAN" → repair
  succeeded; tenant is back online.
- Operation state `failed` + lastError contains tool output →
  inspect the report. Common issues:
  - "Maybe try with -L" (XFS) — corrupted journal. Manual
    intervention needed; the platform doesn't run `-L`
    automatically because zeroing the log is destructive.
  - "Mandatory checkpoint not reached" — the volume still had
    in-flight writes when quiesce ran. Re-run quiesce by toggling
    suspend/resume, then retry.
  - I/O errors persisting after repair — restore from snapshot.

### When to escalate

- Repeated fsck failures on the same PVC across multiple runs.
- Robustness stays `degraded` after repair completes.
- `engineConditions` shows persistent `OfflineRebuilding` for
  more than 30 min.
- Replica count never recovers to expected after a node reboot.

In all cases, the rollback path is restore-from-snapshot via the
Storage Lifecycle Restore flow.

## See also

- `backend/src/modules/storage-lifecycle/fsck.ts` — Job runner +
  buildFsckScript per fsType.
- `backend/src/modules/storage-lifecycle/service.ts` —
  fsckCheckClient / fsckRepairClient orchestrators (mirror the
  resize quiesce flow).
- `k8s/base/longhorn/storageclasses.yaml` — current
  fsType per tier.
- `scripts/integration-tier-flip-e2e.sh` — e2e harness asserts
  fresh-tenant fsType=xfs and allocatedBytes < 60 MiB.
