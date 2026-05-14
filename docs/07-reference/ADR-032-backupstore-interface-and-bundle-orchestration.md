# ADR-032: BackupStore Interface and Bundle Orchestration

**Status:** Accepted · 2026-05-02
**Amended:** 2026-05-02 — bundle storage is **off-cluster only**. Cluster
disk is reserved for live tenant data; backups always stream to S3 or
SSH. The hostpath store is dev/test-only (`mkdtemp` in unit tests). No
production code path constructs a `LocalHostPathBackupStore`.
**Relates to:**
- ADR-028 — backup architecture (component model, tiered initiators, multi-target storage)
- `docs/06-features/BACKUP_COMPONENT_MODEL.md` — bundle layout + `meta.json` schema
- `docs/06-features/RESTORE_SPECIFICATION.md` — restore API + granularity (downstream consumer)
- `docs/02-operations/BACKUP_STRATEGY.md` — tier policy + retention defaults

**Supersedes:** the placeholder `backups` table schema in `backend/src/db/schema.ts`
(read-only after migration 0066; new code targets `backup_jobs` + `backup_components`).

---

## Context

ADR-028 decided **what** a backup looks like (component-oriented bundle, four
initiators sharing one format, three storage backends). It did **not** specify:

- The exact TypeScript interface that backend code calls to read/write bundles.
- How a single bundle capture is orchestrated across multiple components when
  any one component can fail independently.
- How `meta.json` is written atomically alongside its components.
- How the database tracks in-flight bundles vs. completed bundles.
- Where SSH credentials live for the SSH backend, and how they are scoped.

This ADR locks those interfaces so subsequent migrations + module work do not
diverge. Phases 3-5 (scheduling, retention, granular restore, GDPR export) all
depend on the interface decided here.

---

## Decisions

### 1. `BackupStore` is the only abstraction backend code calls

All bundle I/O goes through one interface. Component capture code never opens
sockets, files, or S3 clients directly.

```typescript
export interface BackupStore {
  readonly kind: 'hostpath' | 's3' | 'ssh';

  /** Reserve a new bundle directory; returns a handle for component writes. */
  reserveBundle(input: { backupId: string; clientId: string }): Promise<BundleHandle>;

  /** Stream a component artifact into the bundle. Idempotent on (bundleId, name). */
  writeComponent(handle: BundleHandle, component: ComponentName, name: string,
                 body: NodeJS.ReadableStream, opts?: { sha256?: string }): Promise<ArtifactRef>;

  /** Fetch a component artifact for restore. */
  readComponent(handle: BundleHandle, component: ComponentName, name: string): Promise<NodeJS.ReadableStream>;

  /** Enumerate artifacts under a component (used by restore to list mailboxes). */
  listArtifacts(handle: BundleHandle, component: ComponentName): Promise<ArtifactRef[]>;

  /** Stat one artifact without fetching its body. */
  stat(handle: BundleHandle, component: ComponentName, name: string): Promise<ArtifactStat | null>;

  /** Write the canonical meta.json — must be the LAST step of capture. */
  putMeta(handle: BundleHandle, meta: BackupMetaV1): Promise<void>;

  /** Read meta.json. Throws on schemaVersion mismatch. */
  getMeta(handle: BundleHandle): Promise<BackupMetaV1>;

  /** Delete the entire bundle (retention enforcement). */
  delete(handle: BundleHandle): Promise<void>;

  /** Resolve a stored bundle by id. Returns null if absent. */
  open(backupId: string): Promise<BundleHandle | null>;
}

export type ComponentName = 'files' | 'mailboxes' | 'config' | 'secrets';
```

`BundleHandle` is opaque to callers; backends embed their own URI / prefix /
SSH connection ref inside it. Callers never inspect the path.

**Rationale.** A single seam for retention sweeps, integrity audits, presigned
downloads (Phase 5), and re-keying. Three backends, one contract.

### 2. `meta.json` is written last and is the commit marker

A bundle without `meta.json` is treated as in-progress or aborted by every
reader (restore, retention, audit). Components are written first; `putMeta`
flips the bundle from "in-flight" to "complete" atomically (single PUT for S3,
`rename(.tmp, meta.json)` for hostpath, atomic mv on the remote for SSH).

**Rationale.** Crash safety without two-phase commit. A torn bundle is invisible
and retention will GC it after the in-flight TTL.

### 3. Database = `backup_jobs` + `backup_components`; legacy `backups` retired

| Table | Role |
|---|---|
| `backup_jobs` | One row per bundle. Status (`pending`/`running`/`completed`/`failed`/`expired`), initiator, system_trigger, target_id, expires_at. Source of truth for the admin UI list. |
| `backup_components` | One row per component-artifact. Status, sha256, sizeBytes, started_at, finished_at, error. Lets the orchestrator retry a single component without redoing the bundle. |
| `backups` | **Read-only.** Existing rows preserved for the placeholder client-panel page; no new writes. Removed in a future migration. |
| `client_backup_schedules` | Per-client cron + retention bounded by `hosting_plans.max_backup_retention_days`. |

**Rationale.** Component-level rows let Phase 3 retry stuck mailbox exports
without losing the file archive. Without per-component rows, the orchestrator
has to re-derive state from the store on every retry.

### 4. Three backends, all built behind the same interface

| Backend | Bundle handle | Auth | Notes |
|---|---|---|---|
| `LocalHostPathBackupStore` | absolute path under `${hostpath}/<backupId>/` | filesystem permissions on the platform-data PVC | Reuses patterns from `storage-lifecycle/snapshot-store.ts`. |
| `S3BackupStore` | `s3://<bucket>/<prefix>/<backupId>/` | `backup_configurations` row (KMS-encrypted access key) | `@aws-sdk/client-s3` + multipart upload streaming. Presigned URLs for client downloads (Phase 5). |
| `SshBackupStore` | `ssh://<user>@<host>:<port>/<base>/<backupId>/` | encrypted private key in `platform_settings.storage_backup_ssh_private_key` (`PLATFORM_ENCRYPTION_KEY`) | **Job-based** (see decision 5). |

### 5. SSH backend: in-process SFTP for Phase 2; Job-based for Phase 3 files

**Phase 2 (config + secrets components).** The `SshBackupStore` opens
SFTP connections from the platform-api pod and streams components
directly. Reasons:
- The component data already lives in the platform-api pod (DB rows,
  k8s Secret API). Routing it through a Job sidecar adds latency for
  no security benefit — the OIDC encryption key + DB credentials are
  already in this pod, so the SSH key is no incremental risk.
- Per-call connect/teardown (~hundreds of ms) is acceptable for the
  ~tens-of-KB Phase 2 components.
- Off-site upload is non-negotiable (cluster disk is for live tenant
  data); in-process streaming is the simplest correct path.

**Phase 3 (files component).** When the `files` component lights up,
the source data is the **tenant** PVC, not the platform-api pod. At
that point the capture moves to a k8s Job that mounts the tenant PVC
read-only and streams the tar via SFTP from inside the Job. Reasons
to use a Job at that point:
- The Job already needs to mount the tenant PVC, so it's already
  short-lived.
- Keeps long-lived platform-api credentials separate from
  tenant-data-handling code paths.

`readComponent` (restore path) similarly uses an in-process SFTP read
stream for Phase 2 components.

### 6. The orchestrator runs components in a fixed pipeline with isolated failure

```
reserveBundle
  → write files component (Job, may take minutes)
  → write mailboxes component (Job per mailbox, sequential, capped concurrency)
  → write config component (in-process SELECT + gzip)
  → write secrets component (in-process list + AES-256-GCM)
  → putMeta
```

Any single component failure marks that `backup_components` row `failed`
and the bundle `partial`. The orchestrator can resume by re-running only
the failed components. `meta.json` is written only when all enabled
components are `completed`. Bundles stuck in `running` for >24h are GC'd
by the retention sweeper.

**Rationale.** Files capture is the slow component (PVC tar). Re-running the
whole bundle on a transient mailbox-export failure wastes the most expensive
work. Per-component idempotency is the cheapest way to get retries right.

### 7. Encryption key identifier

`secrets` component ciphertext is prefixed with `k1:` followed by the
AES-256-GCM ciphertext (per `BACKUP_COMPONENT_MODEL.md`). The platform
maintains exactly one active key (`PLATFORM_ENCRYPTION_KEY` env var). KID
prefix exists so a future ADR can introduce key rotation without breaking
old bundles.

Key rotation, ESO/Vault integration, and per-tenant keys are **out of scope**
for this ADR.

### 8. The `client` initiator can request a `mode=data-export` bundle

For GDPR Art. 20 the client panel can issue a bundle with:
- `secrets` component **omitted** entirely (TLS keys never leave the platform)
- entire bundle wrapped with a client-supplied passphrase using AES-256-CBC
  over a final tarball (envelope, not per-component)
- bundle stored short-term (24h) with a presigned download URL

The wrapper is applied **outside** the BackupStore interface — the store sees a
normal bundle, then a one-shot Job tarballs the bundle dir and encrypts the
tarball with the passphrase. The encrypted tarball is what the client downloads.

**Rationale.** Keeps `BackupStore` agnostic to client-facing concerns. Wrapping
is composition, not a new component type.

---

## Out of scope (deferred to later ADRs)

- ADR for restore execution model + WebSocket vs polling (planned ADR-033).
- ADR for key rotation (`k2:`, `k3:`, …) and per-tenant keys.
- Velero (or equivalent) integration for cross-platform DR — Tier 4 stays
  scripted (`scripts/dr-restore.sh`) for now.
- Cross-store migration tooling (move bundles from hostpath to S3).

---

## Consequences

**Positive.**
- Phase 3 (Tier-1 scheduler) and Phase 4 (granular restore) can be built in
  parallel against a stable interface.
- Retention enforcement becomes one loop over `backup_jobs` calling
  `BackupStore.delete`. No backend-specific code in the scheduler.
- Adding a fourth backend (e.g. Backblaze B2 S3-compat, or a future GCS
  backend) is one new file implementing `BackupStore`.

**Negative.**
- The Job-per-component pattern means more pod churn during a Tier-1 sweep.
  Phase 3 must throttle concurrency to keep the platform-system namespace
  under quota.
- `meta.json` as the commit marker means a bundle that crashed mid-capture
  is invisible to the UI until the GC sweep removes it. Operators must
  trust the GC, not poke at the storage target manually.
- Adding `backup_jobs` + `backup_components` while keeping legacy `backups`
  read-only doubles the schema surface temporarily. A follow-up migration
  drops `backups` once the client panel has been repointed.

---

## Implementation order

1. Migration 0066 — schema + plan-quota columns.
2. `packages/api-contracts/src/tenant-bundles.ts` — Zod schemas (this ADR's interfaces).
3. `backend/src/modules/tenant-bundles/{bundle-store,meta}.ts` — interface + meta I/O.
4. Three backend implementations (`local-hostpath`, `s3`, `ssh`).
5. Four component emitters (`files`, `config`, `secrets`, `mailboxes`).
6. Bundle orchestrator + admin route.
7. Integration scenario in `scripts/integration-staging.sh`.

Each step is mergeable independently and unit-testable in isolation.
