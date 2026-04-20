# ADR-028: Backup Architecture — Component Model, Tiered Initiators, Multi-Target Storage

**Status:** Accepted · 2026-04-20
**Supersedes:** earlier ad-hoc references to per-database `mysqldump`/`pg_dump`
CronJobs in `docs/02-operations/BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md`, and
the implicit assumption that a PVC tarball alone suffices as a client backup.
**Follow-ups:** See "Deferred / out of scope" section.

---

## Context

The platform has a working PVC snapshot primitive (`storage_snapshots` table
+ tar.gz artifacts) used by storage-lifecycle ops (resize, archive, restore).
That primitive captures the tenant PVC as an opaque tarball — which is
sufficient for in-place rollback but insufficient as a "full client backup"
because:

1. A deleted client cannot be restored from a tarball alone — the platform
   DB rows (domains, deployments, ingress routes, mailbox metadata, DKIM
   keys, SFTP users, etc.) are not captured.
2. The tarball is not browseable — operators cannot pick individual files
   for restore without extracting the whole archive.
3. Mailbox data lives outside the tenant PVC (on a separate Stalwart PVC in
   the `mail` namespace), so it is not in the snapshot at all.
4. TLS private keys are irreproducible state but are in k8s Secrets, not
   on the PVC.

Simultaneously, `docs/06-features/RESTORE_SPECIFICATION.md` already specified
fine-grained restore scopes (per-database, per-mailbox with date range, per
file). Those scopes were not supported by the existing implementation and
some of them were architecturally over-scoped given today's design (see
decisions below).

A series of discussions on 2026-04-20 resolved both the architecture
questions and the scope trim. This ADR captures the decisions so future
doc edits and implementation work remain aligned.

---

## Decisions

### 1. Component-oriented bundle, not a single tarball

A backup is a directory on the storage target containing one subdirectory
per component (`files`, `mailboxes`, `config`, `secrets`) plus a canonical
`meta.json` manifest. See `docs/06-features/BACKUP_COMPONENT_MODEL.md`.

**Rationale.** A single tarball couples capture to restore granularity —
you either restore everything or extract the whole archive to get one
file. Component-oriented layout lets each restore scope operate on exactly
the artifact it needs (browse the file tree, re-import one mailbox, apply
the config rows) without touching unrelated data.

**Trade-off.** More complex capture orchestration (multiple Jobs per
backup) in exchange for dramatically better restore UX and smaller
operational blast radius per restore.

### 2. Four backup initiators share one bundle format

`client`, `admin`, `system`, and `cluster` initiators all produce the
same on-disk layout. What differs is ACL, quota, retention window, which
components are enabled, and where the bundle is stored. A `meta.json
.initiator` field drives ACL at every API boundary.

**Rationale.** Avoids three parallel bundle formats and three parallel
restore paths. Same orchestrator, same store abstraction, same restore
UI — the initiator is just metadata.

### 3. No per-database logical dumps

Each client runs their own MariaDB/PostgreSQL pod with its datadir on the
tenant PVC. The `files` component's PVC archive **is** the database
backup. Restore = extract PVC contents, restart the DB pod.

**Rationale.** The shared-global-database concept that would have required
per-database `mysqldump` was dropped earlier in the platform's evolution.
With per-client DB pods, logical dumps add no capability and several
problems: datadir consistency races, extra Job latency, surface area
for bugs when DB version changes. File-level capture is both simpler
and more faithful to what's actually running.

**Consequence.** `database_only` / `data_only` restore scopes in the
earlier RESTORE_SPECIFICATION.md are removed. Restoring a database ≡
restoring its files. Single-database restore is not supported; operators
who need to roll back one DB while keeping another untouched must use
application-level tooling (WP-CLI, `mysqldump` in a one-shot Job)
against a pre-restore snapshot.

### 4. Mailbox restore granularity: whole mailbox, replace semantics

The minimum restoration unit for email is **one whole mailbox**. Per-folder,
per-message, and date-range restore are not supported. When a mailbox is
restored, existing contents are **replaced** (not merged).

**Rationale.** Stalwart's account export/import API operates at the
account level. Per-message restore would require an IMAP-diff tool we
don't have and don't want to build. Merging imported + existing messages
produces duplicates, unclear UX, and IMAP UID ordering issues. Replace
semantics with a clear "this will overwrite" warning in the UI is the
predictable answer.

**Consequence.** RESTORE_SPECIFICATION.md's `messages_only` + `date_range`
scopes are removed. Multi-select is still supported — an operator picks
N mailboxes from the backup, each is replaced independently.

### 5. Keep per-file restore from the PVC archive

Individual file and folder selection stays as a first-class restore
scope. A `tree.jsonl.gz` sidecar is written at backup time (one record
per path with size, mode, mtime) so the admin and client panels can
browse the backup contents without extracting the tarball.

**Rationale.** "I deleted `wp-config.php`, restore just that file" is a
very common operator ask. The sidecar costs a few KB at capture time;
extraction uses `tar -xzf archive.tar.gz -- <paths>` against the
archive, which is cheap for targeted restore.

### 6. Mandatory storage backends: `hostpath`, `s3`, `ssh`

All three are first-class. Any configured backup target must be reachable
from at least one of them. There is no SSHFS mount — SSH uploads use
direct `ssh` + `tar` piping / `sftp` batch mode.

**Rationale.** Self-hosters want S3-compatible (MinIO, Backblaze, Wasabi);
enterprise deployments want SSH to an on-prem backup server; dev and
single-node production want hostpath. Having three makes the platform
usable across all three deployment patterns without vendor lock-in.

### 7. Multi-node placement via node selector at restore time

A client is pinned to one node at provisioning. Restore behavior:

- **Existing client** — restore to the currently-assigned node.
- **Deleted client** — admin is prompted at restore time to pick a target
  node from the registered-nodes list (dropdown). `meta.json` records
  the original node as a preselection hint only.

**Rationale.** Multi-node support hinges on node assignment + local-path-
equivalent storage semantics. Restore should not introduce federation
complexity — pick a node, provision there, move on. No PVC move, no
cross-node data migration at restore time.

### 8. Encrypt the `secrets` component; leave other components unencrypted at rest

TLS Secrets are encrypted with AES-256-GCM using `OIDC_ENCRYPTION_KEY`.
Ciphertexts carry a `k1:` KID prefix so a future key rotation can decrypt
old bundles via a fallback key. Other components rely on transport
(S3 SSE, SSH) and filesystem permission (hostpath 0700 dirs) for at-rest
confidentiality.

**Rationale.** TLS private keys are the only irreproducible, high-value
secret in the bundle. Encrypting them specifically keeps the sensitive
material safe if a bundle file is accidentally leaked to a less-trusted
location. Encrypting the file tree or mailbox data doubles capture cost
for data that is already encrypted in transit and restricted at rest.

### 9. Cluster-wide DR is a separate concern

A full platform backup (platform DB via `pg_dump`, Stalwart PVC, Dex,
Roundcube, Harbor, cert-manager, Flux state) is operator-initiated DR
and is implemented via **Velero** (or an equivalent k8s-native tool), not
the per-client bundle pipeline. It does not appear in the admin or
client panel.

**Rationale.** Cluster DR is about bootstrapping a fresh cluster from
zero, not about moving individual clients. Velero is the standard tool
for this problem; writing a custom implementation is wasted effort.
Per-client bundles and cluster DR have different failure modes,
different restore sequences, and different operators.

**Status for this ADR:** specified as deferred work, no implementation
commitment. See `docs/02-operations/BACKUP_STRATEGY.md` Tier 4 for the
future shape.

---

## Deferred / out of scope

These were explicitly considered and punted:

- **Date-range mail restore.** Needs per-message indexing at capture time
  or an IMAP-level diff tool. Dropped in favor of whole-mailbox replace.
- **Incremental backup.** Requires block-level capture (Longhorn / CSI
  snapshots). Will be revisited when a CSI backend replaces local-path.
- **External Secrets Operator integration.** `OIDC_ENCRYPTION_KEY` stays
  in env vars for now. KID-prefixed ciphertexts make the future migration
  to Vault non-breaking: add `k2:` keys and a fallback lookup.
- **Cross-cluster migration.** Backup bundles are portable by format, but
  the platform doesn't yet have a federation story for DNS/IP/TLS.
- **Backup diff / dedup.** Each bundle is full-fat. Bundle size is
  bounded by tenant PVC size (typically GB-scale per backup). Dedup is a
  future optimization after Longhorn or Velero's incremental features
  take over.

---

## Consequences

- **Docs.** `BACKUP_STRATEGY.md`, `BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md`,
  `RESTORE_SPECIFICATION.md`, `BACKUP_EXPORT_MIGRATION_GUIDE.md`,
  `CLIENT_PANEL_FEATURES.md`, `ADMIN_PANEL_REQUIREMENTS.md` all updated
  2026-04-20 to reference `BACKUP_COMPONENT_MODEL.md` as the canonical
  contract.
- **Code.** `storage_snapshots` stays for in-lifecycle-op artifacts
  (pre-resize, pre-archive). A sibling `backup_jobs` + `backup_components`
  schema will be added when implementation begins. `backups` and
  `backup_configurations` tables are placeholder CRUD shells; they will
  be replaced (or repurposed) during implementation.
- **Compliance.** Client-initiated backups satisfy GDPR Art. 20 (right to
  data portability) — client can download the bundle minus the
  `secrets` component, optionally with a client-provided passphrase.
- **Operational.** Admins get component-aware backups + fine-grained
  restore without having to wait for multi-node. The multi-node transition
  only changes the `files` component capture backend (local-path → CSI
  snapshot) — the rest of the pipeline is unaffected.

---

## Rejected alternatives

- **Single tarball with manifest** — simpler to build but blocks per-file
  browsing and single-mailbox restore. See decision 1.
- **Full-featured cluster backup via custom code** — Velero does this
  better. See decision 9.
- **Per-database `mysqldump` CronJobs** — vestigial from the shared-DB
  era. File-level capture subsumes it. See decision 3.
- **SSHFS mount for remote targets** — extra moving part vs direct
  `ssh`/`sftp` batch upload. Decision 6.
- **Date-range mail restore** — user experience complexity + Stalwart
  API gap. Decision 4.
