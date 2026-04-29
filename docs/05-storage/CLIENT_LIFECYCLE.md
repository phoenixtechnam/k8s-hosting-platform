# Client Lifecycle (status-driven)

> Operator runbook. As of 2026-04-28 the client lifecycle is driven
> directly from the client row — status dropdown, resource limits,
> archive retention. The standalone Suspend / Resume / Archive /
> Restore / Resize buttons in the Storage Lifecycle card are gone;
> the underlying endpoints stay for scripting + tests.

## Mental model

| Operator intent           | UI surface                                                     | Backend dispatch                                            |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Bump storage (online)     | ResourceLimits → Storage Limit ↑                               | PATCH /clients/:id { storage_limit_override } → online grow |
| Shrink storage            | ResourceLimits → Storage Limit ↓ → confirm destructive dialog | POST /admin/clients/:id/storage/resize { newGi }            |
| Suspend                   | Status dropdown → suspended                                    | PATCH /clients/:id { status: 'suspended' }                  |
| Resume                    | Status dropdown → active                                       | PATCH /clients/:id { status: 'active' }                     |
| Archive (with retention)  | Status dropdown → archived (+ retention_days input)            | PATCH /clients/:id { status: 'archived', archive_retention_days } |
| Restore from archive      | Status dropdown → active (with confirm modal)                  | PATCH /clients/:id { status: 'active' }                     |
| Manual snapshot           | Storage Operations → "Take snapshot"                           | POST /admin/clients/:id/storage/snapshot                    |
| Reset stuck failed state  | Storage Operations → "Reset to idle" (visible only on failed)  | POST /admin/clients/:id/storage/clear-failed                |
| Hard delete               | Top-bar → Delete                                               | DELETE /clients/:id                                         |

The status dropdown is the single switch the operator flips. Anything
that needs a backing snapshot (archive / restore / destructive shrink)
runs in the storage-lifecycle orchestrator and surfaces an
`storage_operations` row id on the response so the UI can poll
`/admin/storage/operations/:opId` and show progress live.

## Asymmetric semantics

The flows are intentionally *not* symmetric:

| Direction         | Class         | Reversibility                                                 |
| ----------------- | ------------- | ------------------------------------------------------------- |
| Grow              | Online        | Reversible only via destructive shrink                        |
| Shrink            | Destructive   | Pre-resize snapshot kept (default 7d). Restore via /storage/restore |
| Suspend           | Reversible    | Workloads scaled to 0; resume restores prior replica counts   |
| Resume            | Reversible    | unquiesce reads QuiesceSnapshot from the suspend op row       |
| Archive           | Destructive   | Final pre-archive snapshot kept (default 90d). Workloads + PVC + mailboxes deleted |
| Restore (archived → active) | Destructive | Recreates PVC, restores data. Workloads must be redeployed manually. Mailboxes are NOT recreated. |
| Hard delete       | Irreversible  | Drops namespace, snapshots, DB rows                           |

## Endpoint catalogue

These endpoints stay in the API regardless of the UI collapse — they
are still called by:
1. The status-driven row-edit dispatcher in `clients/service.ts`
2. Operator scripts (`scripts/integration-*.sh`, prod runbooks)
3. Future automated reconcilers

| Endpoint                                            | Trigger from row-edit                            |
| --------------------------------------------------- | ------------------------------------------------ |
| POST /admin/clients/:id/storage/resize/dry-run     | (none — used by ResizeStorageModal directly)     |
| POST /admin/clients/:id/storage/resize             | ResourceLimits shrink confirm                    |
| POST /admin/clients/:id/storage/snapshot           | Storage Operations card "Take snapshot"          |
| POST /admin/clients/:id/storage/suspend            | (script-only; status flip uses cascade path)     |
| POST /admin/clients/:id/storage/resume             | (script-only; status flip uses cascade path)     |
| POST /admin/clients/:id/storage/archive            | PATCH /clients status:archived                   |
| POST /admin/clients/:id/storage/restore            | PATCH /clients status:active (when archived)     |
| POST /admin/clients/:id/storage/clear-failed       | Storage Operations "Reset to idle" (failed only) |
| GET  /admin/storage/operations/:opId               | OperationProgressModal poll                      |

## Status transitions and the orchestrators

```
                                   (status dropdown)
                                          │
            ┌─────────────────────────────┼──────────────────────────────┐
            │                             │                              │
            ▼                             ▼                              ▼
    status: suspended             status: active                  status: archived
       │                            │  │                              │
       │ applySuspended (sync)      │  │ applyActive (sync)           │ archiveClient orchestrator
       │ (cascades.ts)              │  │ (cascades.ts)                │ (storage-lifecycle/service.ts)
       ▼                            │  │                              │   ├─ quiesce
   ingress patched                  │  │                              │   ├─ snapshot (kind=pre-archive)
   workloads scaled to 0            │  │                              │   ├─ delete deployments + PVC
   mailboxes disabled               │  │                              │   └─ applyArchived (cascades)
                                    │  │                              ▼
                                    │  │                         status: archived
                                    │  │                         storage_operations row written
                                    │  │
              from archived ────────┘  └──── from suspended
                     │                           │
                     ▼                           ▼
              restoreArchivedClient           applyActive (sync)
              (storage-lifecycle/service.ts)  (cascades.ts)
                ├─ recreate PVC               ingress restored
                ├─ restore data from snap     workloads scaled back
                └─ status='active'            mailboxes re-enabled
              storage_operations row written
```

### Synchronous cascade vs orchestrator

Suspend / resume run inline as part of the PATCH request. They
complete before the API returns and don't write `storage_operations`
rows when triggered via the row-edit path; the response is just the
updated client. (The standalone POST /storage/suspend and
/storage/resume endpoints DO write op rows — that path is unchanged
for scripting.)

Archive / restore-from-archive return immediately with an op id and
run in the background. The PATCH response carries
`storageArchiveOperationId` or `storageRestoreOperationId`; the UI
opens OperationProgressModal which polls
`/admin/storage/operations/:opId` every 1.5s.

## Idempotence rules

* PATCH status:archived on already-archived client → no-op (no
  orchestrator dispatched, no error).
* PATCH status:active on already-active client → no-op (cascade is
  idempotent: re-runs ingress/mail re-enable).
* PATCH archive_retention_days without status:archived → ignored.
* PATCH storage_limit_override === current → no-op (not a grow).

## Failure modes

| Failure                                | Where to look                                              |
| -------------------------------------- | ---------------------------------------------------------- |
| Archive: snapshot store unreachable    | storage_operations.lastError (OperatorError envelope)      |
| Restore: pre-archive snapshot expired  | NO_ARCHIVE_SNAPSHOT 404 from PATCH                         |
| Shrink: destructive resize stuck       | Storage Operations card → Reset to idle (clear-failed)     |
| Suspend cascade race                   | backend logs "[clients] Lifecycle cascade failed"          |

## Migration note

Pre-collapse code paths still exist and are tested:
* `useStorageSuspend / useStorageResume / useStorageArchive /
  useStorageRestore` hooks remain in `use-storage-lifecycle.ts` for
  any future tooling, but ClientDetail.tsx no longer imports them.
* The /storage/suspend, /storage/resume, /storage/archive,
  /storage/restore, /storage/resize endpoints stay for operator
  scripts and integration tests.

When operator scripts run those endpoints directly they bypass the
status dropdown, so their `storage_operations` rows still appear in
the Storage Operations card progress strip — the card now displays
ANY active op, not just ones started from inside the card.
