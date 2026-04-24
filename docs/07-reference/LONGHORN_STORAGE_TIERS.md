# Longhorn Storage Tiers (M2)

Five platform-managed StorageClasses that map the role + tier taxonomy
from ADR-031 onto Longhorn provisioning. Additive to the default
`longhorn` class installed by the Longhorn chart — the existing class
is untouched, so no in-place migration is required on upgrade.

## Class matrix

| Class                  | Replicas | Data locality | Use                                                 |
|------------------------|----------|---------------|-----------------------------------------------------|
| `longhorn-system-ha`   | 3        | disabled      | Postgres, Redis, platform-api PVCs                  |
| `longhorn-tenant-local`| 1        | best-effort   | Default tenant PVC (cheap, node-local)              |
| `longhorn-tenant-ha`   | 2        | disabled      | Tenant HA opt-in (M7)                               |
| `longhorn-mail-local`  | 1        | best-effort   | Default mail PVC                                    |
| `longhorn-mail-ha`     | 2        | disabled      | Mail HA opt-in                                      |

`dataLocality=best-effort` prefers placing a replica on the node
hosting the pod so reads stay node-local; `disabled` spreads replicas
freely for fault tolerance. `strict-local` is deliberately unused —
it would block pod rescheduling when a node drains.

`reclaimPolicy=Retain` on every class protects against accidental PVC
deletion cascading to data loss. Operators restore via the storage-
lifecycle module's restore path, not via PVC recreate.

## Behavior on a single-node cluster

`numberOfReplicas > 1` on a single-node cluster produces **degraded
but functional** volumes. Longhorn schedules min(replicas, nodes) and
keeps the remaining replicas in `Pending` state. Reads/writes work
against the healthy replica; the degraded state is visible in the
Longhorn UI as a yellow warning.

When nodes join (M8), Longhorn provisions the missing replicas
automatically — no operator action needed.

## Wiring

Currently shipped:

- **Staging:** included via `../../base/longhorn` (already in overlay).
- **Production:** NOT included — production overlay doesn't wire
  `base/longhorn` (it keeps the Longhorn UI ingress out of prod for
  access-pattern reasons; the StorageClasses ride alongside). Add the
  `base/longhorn` resource + an admin-auth-gate component when
  production moves to Longhorn-backed storage.
- **Dev:** intentionally excluded. DinD k3s has no Longhorn; using
  local-path. The StorageClasses would be inert here.

## Migration cost

StatefulSet `.spec.volumeClaimTemplates` is **immutable** after
creation. Changing the `storageClassName` on postgres, Redis,
Stalwart-mail, etc. does NOT move the existing PVC. Migration
requires:

1. Scale StatefulSet to 0
2. Backup data (pg_dump for Postgres; stalwart-cli export for mail;
   Longhorn snapshot for Redis).
3. Delete the StatefulSet (retaining PVC since reclaimPolicy=Retain,
   or delete both if migrating to a new SC).
4. Apply the new manifest with updated `storageClassName`.
5. Restore data into the newly-provisioned PVC.

Planned migration moments:

- **postgres → longhorn-system-ha:** M8 (3-server control plane) —
  pairs with CNPG activation (M10) so the cut-over happens once.
- **stalwart-mail → longhorn-mail-ha:** on operator opt-in once a 2nd
  mail-capable node exists; M7 follow-up.
- **Tenant PVCs:** M5 provisioner update selects `longhorn-tenant-local`
  for new tenants; M7 adds the "upgrade to HA" flow.

## How to pick a tier in future code

- New system component → `longhorn-system-ha`. No exceptions; system
  data is replicated.
- Tenant PVC with plan tier "basic" or unset → `longhorn-tenant-local`.
- Tenant PVC with plan tier "HA" (M7 flag) → `longhorn-tenant-ha`.
- Mail workload default → `longhorn-mail-local`.
- Mail workload with HA opt-in → `longhorn-mail-ha`.

The backend's k8s-provisioner (`backend/src/modules/k8s-provisioner/`)
is the source of truth for tenant PVC SC selection. Changes land
there during M5/M7.

## Recurring jobs

Every new class includes
`recurringJobSelector: '[{"name":"default","isGroup":true}]'`, so
PVCs provisioned against these classes auto-enroll in the three
RecurringJobs defined in `recurring-jobs.yaml`:

- `hourly-snap` — hourly in-volume snapshots (24 kept)
- `daily-backup` — daily S3 backup (14 kept)
- `weekly-backup` — weekly S3 backup (4 kept)

Legacy PVCs provisioned against the chart default `longhorn` class
rely on the direct label (`recurring-job-group.longhorn.io/default:
enabled`) — see the comment in `recurring-jobs.yaml` for the
opt-in mechanics.
