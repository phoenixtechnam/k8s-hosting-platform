# Backup Component Model

**Status:** Specification · 2026-04-20
**Supersedes:** Implicit ad-hoc structure in `storage_snapshots` tarballs.
**Relates to:**
- `docs/02-operations/BACKUP_STRATEGY.md` — three-tier strategy
- `docs/02-operations/BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md` — capture mechanics
- `docs/06-features/RESTORE_SPECIFICATION.md` — restore API + granularity
- `docs/07-reference/ADR-028-backup-architecture.md` — decision record

---

## Purpose

This document is the **single source of truth** for what a backup contains,
how it is structured on the storage target, and what restore scopes it
supports. All other backup/restore docs reference this file.

The four backup initiators (`client`, `admin`, `system`, `cluster`) share
one bundle format — their differences are ACL, quota, retention, and
which components are enabled, not the on-disk layout.

---

## Bundle layout

A backup is a directory-structured artifact on the storage target:

```
<backup-id>/
  ├── meta.json                     — canonical manifest (required)
  ├── components/files/
  │   ├── archive.tar.gz            — tar of the tenant PVC contents
  │   ├── archive.tar.gz.sha256     — SHA-256 of the tarball
  │   └── tree.jsonl.gz             — per-file path/size/mode/mtime index
  ├── components/mailboxes/
  │   ├── <address-1>.mbox.tar.gz   — per-mailbox export (Stalwart CLI)
  │   ├── <address-1>.mbox.tar.gz.sha256
  │   └── <address-2>.mbox.tar.gz
  ├── components/config/
  │   └── db-rows.json.gz           — client-scoped platform-DB rows
  └── components/secrets/
      └── tls.json.gz.enc           — encrypted TLS Secrets payload
```

The storage target may be a local hostpath directory, an S3 prefix,
or an SSH-accessible remote path (see [Storage targets](#storage-targets)).
The layout above is backend-agnostic — each backend exposes a
`SnapshotStore` / `BackupStore` interface that reads and writes this
structure identically.

---

## `meta.json` schema

```jsonc
{
  "schemaVersion": 1,
  "backupId": "bkp-8f59ec16-...",
  "clientId": "4ec7436d-6159-4bf0-9282-d7e4cc19410b",
  "capturedAt": "2026-04-20T18:00:00Z",
  "platformVersion": "0.3.1",

  // Who asked for this backup — drives ACL + visibility.
  "initiator": "client | admin | system | cluster",

  // If `system`, what triggered it.
  "systemTrigger": "pre-resize | pre-archive | scheduled | null",

  // Used by the UI to show a human-readable name.
  "label": "Manual 2026-04-20",

  // Components included. Omitted components = not captured.
  "components": {
    "files":     { "sizeBytes": 42137984, "fileCount": 1283, "sha256": "..." },
    "mailboxes": { "sizeBytes": 1024000,  "mailboxCount": 3,  "addresses": ["a@x.com", "b@x.com"] },
    "config":    { "sizeBytes": 28192,    "rowCount": 57 },
    "secrets":   { "sizeBytes": 4096,     "secretCount": 1, "encryptionKeyId": "k1" }
  },

  // Placement hint — used at restore time when the client row doesn't exist.
  "nodePlacement": {
    "preferredNode": "k8s-local",
    "preferredRegion": "dev-eu-1"
  },

  // Retention fields.
  "expiresAt": "2026-05-20T18:00:00Z",
  "retentionDays": 30,

  // Optional client-provided note.
  "description": null
}
```

A non-breaking schema change is expected to bump `schemaVersion`. Restore
code must reject bundles with an unknown `schemaVersion` rather than guess.

---

## Components

### `files` — tenant PVC contents

**Capture.** A short-lived Kubernetes Job (see
`backend/src/modules/storage-lifecycle/snapshot.ts`) mounts the tenant PVC
read-only, runs `tar cf - . | gzip -1 > $ARCHIVE`, and writes both the
tarball and a SHA-256 sidecar. For backups (not just snapshots) the same
Job also emits a **tree index** (`tree.jsonl.gz`) — one JSON-Lines record
per path:

```jsonl
{"path": "/wp-config.php", "size": 5922, "mode": 33188, "mtime": "2026-04-20T17:49:00Z", "digest": "sha256:..."}
{"path": "/wp-content/themes/twentytwentyfour/style.css", "size": 184321, ...}
```

The tree index powers file-browser UI (admin + client) so operators can
select individual files/folders to restore **without extracting the
whole archive first**.

**Restore scopes.**
- `full` — extract the entire tarball back into a freshly-created tenant PVC
- `selected` — extract only specified paths (`tar -xzf archive.tar.gz -- <path1> <path2> ...`) into the existing PVC via a scratch Job

**What's in it.** WordPress files, MariaDB/PostgreSQL datadirs, Redis dumps,
`/etc/nginx` config inside the web pod's volume, file-manager home, etc.
Everything the tenant container writes to its PVC.

**What's not in it.** Application databases are **not** dumped
separately — they live on this same PVC as datadirs, and are restored
along with the files. See ADR-028 for rationale.

### `mailboxes` — per-mailbox Stalwart exports

**Capture.** For each `mailboxes` row owned by the client, a short-lived
Job runs `stalwart-cli account export --address <address> --out
/tmp/<address>.mbox.tar.gz` against the Stalwart admin API. The artifact
is written to `components/mailboxes/<address>.mbox.tar.gz`.

**Restore scopes.**
- `full` per-mailbox — **replace** semantics. The target mailbox is wiped
  and re-imported via `stalwart-cli account import`. A warning is surfaced
  in the UI; merging existing + imported messages is not supported.
- Multi-select is supported — operator/customer picks N mailboxes from
  the backup, each is replaced independently.

**What's explicitly out of scope.** Per-folder, per-message, and date-range
restore are **not** supported. The minimum restoration unit is one whole
mailbox. Operators who need per-message recovery should use IMAP-level
tooling against the pre-restore snapshot (left as a pre-restore
rollback safety net, see RESTORE_SPECIFICATION.md).

### `config` — platform-DB rows scoped to the client

**Capture.** A SELECT across every table with a `client_id` foreign key,
emitted as a single gzipped JSON document:

```jsonc
{
  "schemaVersion": 1,
  "capturedAt": "2026-04-20T18:00:00Z",
  "tables": {
    "clients":        [ { "id": "...", "companyName": "...", ... } ],
    "users":          [ ... ],
    "domains":        [ ... ],
    "dns_records":    [ ... ],
    "deployments":    [ ... ],
    "ingress_routes": [ ... ],
    "mailboxes":      [ ... ],
    "email_aliases":  [ ... ],
    "email_dkim_keys":[ ... ],
    "sftp_users":     [ ... ],
    "sftp_user_ssh_keys": [ ... ],
    "ssh_keys":       [ ... ],
    "cron_jobs":      [ ... ],
    "resource_quotas":[ ... ],
    "ssl_certificates":[ ... ]
    // ...every table with client_id FK
  }
}
```

**Restore scopes.** The config component is a **dependency of any other
component restore**: to restore files into a deleted client, the
`clients` row must be recreated first so the namespace can be provisioned
and the PVC bound. There is no "restore only config" operator action.

**What's in it.** Every row scoped to the client across ~29 tables.
See `backend/src/db/schema.ts` for the authoritative list.

**What's not in it.** Audit logs (kept as tombstones for compliance
even after client deletion), usage metrics (time-series, regenerated),
provisioning task history (operational, transient).

### `secrets` — encrypted TLS Secrets

**Capture.** List all `type=kubernetes.io/tls` Secrets in the tenant
namespace. For each, serialize `{name, namespace, labels, data}`, encrypt
the entire JSON blob with AES-256-GCM using `OIDC_ENCRYPTION_KEY`, and
write to `components/secrets/tls.json.gz.enc`.

**Ciphertext format.** `<kid>:<iv-hex>:<tag-hex>:<ciphertext-hex>`. The
`<kid>` prefix (`k1` today) allows future key rotation without
invalidating existing backups. See ADR-028 for the key-rotation plan.

**Restore scopes.**
- `full` — decrypt, re-apply every Secret in the tenant namespace before
  the ingress reconciler re-attaches TLS routes.
- `skip` — admin can opt out of restoring secrets and let cert-manager
  re-issue from scratch (adds 30–60 s delay on first request; tolerable
  for most restores and zero-risk of key leakage).

**Why encrypt.** TLS private keys are irreproducible state — losing them
means cert reissue, but having them in plaintext on an S3 bucket is a
credentialed-attacker escalation path. Encrypting at bundle time with a
platform-held key adds a meaningful defense layer.

---

## Initiators and ACL

`meta.json.initiator` is the authoritative ACL driver:

| Initiator | Visible to | Creatable by | Deletable by | Counts against |
|---|---|---|---|---|
| `client` | Owning client + admin | Client (via client panel) | Owning client + admin | Plan quota on that client |
| `admin` | Admin only | Admin (via admin panel) | Admin | Platform-wide storage |
| `system` | Admin only | Platform (cron, pre-op) | Admin + reaper cron | Platform-wide storage |
| `cluster` | Operator only | Velero (external) | Velero (external) | Separate DR budget |

Client-initiated backups are the foundation of the GDPR Article 20 "right
to data portability" export: the client can download the bundle (with
the `secrets` component omitted) via the client panel.

---

## Storage targets

A backup bundle is written through a `BackupStore` abstraction. Three
first-class backends are mandatory:

### 1. `hostpath` (default, single-node / dev)

Bundle lives at `${HOSTPATH_ROOT}/<backup-id>/...`. Today's
`LocalHostPathStore` in `backend/src/modules/storage-lifecycle/snapshot-store.ts`
is the reference implementation — backups extend it with subdirectories
per component.

### 2. `s3` (multi-region / cloud)

Bundle lives at `s3://<bucket>/<prefix>/<backup-id>/...`. Uses
server-side encryption (SSE-S3 or SSE-KMS); the `secrets` component
is *additionally* encrypted with the platform key for defense in depth.
Presigned GET URLs allow the client panel to offer direct download
for customer-initiated backups.

### 3. `ssh` (remote server / on-premises)

Bundle lives at `ssh://<user>@<host>:<path>/<backup-id>/...`. The
platform maintains an SSH key pair per storage destination; the private
key is stored encrypted in `platform_settings` under
`storage.backup.ssh_private_key` (AES-256-GCM with `OIDC_ENCRYPTION_KEY`).
Uploads use `ssh` + `tar` piping or `sftp` batch mode; no SSHFS mount is
required (the legacy SSHFS approach is dropped).

Each storage backend implements the same `BackupStore` interface:

```typescript
interface BackupStore {
  reserveBundle(clientId: string, backupId: string): string;  // returns backup URI
  writeComponent(uri: string, componentName: string, artifactName: string, data: Readable): Promise<void>;
  readComponent(uri: string, componentName: string, artifactName: string): Promise<Readable>;
  listArtifacts(uri: string, componentName: string): Promise<string[]>;
  stat(uri: string): Promise<{ sizeBytes: number; createdAt: Date } | null>;
  delete(uri: string): Promise<boolean>;
  putMeta(uri: string, meta: object): Promise<void>;
  getMeta(uri: string): Promise<object | null>;
}
```

A client or admin can select any configured target at backup-creation
time. Targets are defined in `platform_settings` under the `storage.backup.*`
key namespace; see BACKUP_STRATEGY.md for the settings schema.

---

## Multi-node placement

Tenant workloads are pinned to a specific Kubernetes node via the node
assignment recorded at provisioning time (see the upcoming multi-node
work). Restore behavior depends on whether the client row still exists:

- **Existing client** → restore onto the client's currently-assigned
  node. The ingress, PVC, and pods must come back on the same node so
  the local-path (or equivalent) volume lives in the expected location.
- **Deleted client** → admin is prompted at restore time to pick a target
  node from the registered-nodes list. The selection is written to
  `clients.assigned_node` on the recreated row and feeds into all
  subsequent provisioning steps.

The `meta.json.nodePlacement.preferredNode` hint is a **suggestion**, not
a constraint — it records where the client originally lived so the
admin UI can preselect the same node. If that node is decommissioned,
the admin picks a live replacement.

---

## Retention

Retention is stored in two places and enforced by the
`storage-lifecycle` scheduler (every 6 h):

1. `meta.json.expiresAt` — wall-clock deadline on the bundle
2. `storage_snapshots.expires_at` — DB mirror for quick cron queries

Defaults come from `platform_settings`:

| Setting | Default |
|---|---|
| `storage.retention.manual_days` | 30 |
| `storage.retention.pre_resize_days` | 7 |
| `storage.retention.pre_archive_days` | 90 |
| `storage.retention.client_initiated_days` | 30 (counts against plan's max-backups) |
| `storage.retention.admin_initiated_days` | 90 |

When a bundle passes `expiresAt`, the scheduler (`scheduler.ts
runExpiry`) calls `BackupStore.delete(uri)` and marks the DB row as
`status='expired'`.

---

## Encryption contract

The `secrets` component is encrypted at write time; every other
component is written unencrypted (relying on transport-level encryption
for S3 and SSH, and filesystem permissions for hostpath).

- **At-rest key:** `OIDC_ENCRYPTION_KEY` env var, 32-byte random
  (`openssl rand -hex 32`). Today platform-wide and single-purpose; the
  near-term roadmap (post-External-Secrets-Operator) moves this key
  into Vault and emits per-component subkeys.
- **KID prefix:** All ciphertexts start with `<kid>:` (currently `k1:`)
  so a future rotation can decrypt old bundles with a fallback key.
- **Bundle-level encryption:** For customer-downloadable bundles
  (GDPR export), the entire bundle is additionally encrypted with a
  one-time passphrase shown only to the requesting client. Lost
  passphrases are lost bundles.

---

## Versioning policy

- `schemaVersion: 1` — current.
- Adding optional fields to `meta.json` or optional components is a
  minor change; does not bump version.
- Removing or renaming fields bumps to `schemaVersion: 2`; restore
  code handles both explicitly for at least one platform-version
  window before dropping support.
- Any change to ciphertext format bumps the KID prefix.

---

## Related docs

- `docs/02-operations/BACKUP_STRATEGY.md` — policy and tiered strategy
- `docs/02-operations/BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md` — capture pipelines
- `docs/06-features/RESTORE_SPECIFICATION.md` — restore API + UI
- `docs/02-operations/BACKUP_EXPORT_MIGRATION_GUIDE.md` — off-platform migration
- `docs/02-operations/CLIENT_PANEL_FEATURES.md` § Backups — customer UI
- `docs/02-operations/ADMIN_PANEL_REQUIREMENTS.md` § SD.2 — operator UI
- `docs/07-reference/ADR-028-backup-architecture.md` — decision record
