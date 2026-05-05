# Tenant Backup — Operator Runbook

This doc is the single authoritative reference for the Phase-4
**Tenant Backup** stack (per-client off-site bundles + Plesk-style
restore cart). It supersedes the legacy [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md)
and [BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md](BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md)
which describe the deprecated SSHFS architecture.

> **Tenant Backup** ≠ **System Backup**. System Backup (cluster
> state, etcd, Postgres, secrets bundles) lives separately under
> `backend/src/modules/system-backup/`. This doc covers tenant
> data: per-client files, mailboxes, config rows, secrets.

## Concept

A **bundle** is one snapshot of one client's data, stored
off-cluster on an S3 or SSH target. Bundles are split into four
**components**:

| Component | What | Source |
|---|---|---|
| `files`     | Tenant data PVC (`<namespace>-storage`) | Tar.gz produced by capture Job in tenant ns |
| `mailboxes` | Per-mailbox `stalwart-cli account export` tarballs | Job in `mail` ns using Stalwart image |
| `config`    | DB rows the client owns (19 tables: clients, users, domains, deployments, etc.) | `SELECT *` via `buildConfigDump` |
| `secrets`   | TLS Secrets in the tenant ns | AES-256-GCM encrypted with `OIDC_ENCRYPTION_KEY` (KID `k1:`) |

`meta.json` is the **commit marker** — written last, only when every
enabled component succeeded. Operators recognise a bundle as restorable
by the presence of `meta.json` on the off-site target.

Architecture: [ADR-032 — BackupStore + bundle orchestration](../07-reference/ADR-032-backupstore-interface-and-bundle-orchestration.md).
Restore model: [ADR-034 — restore execution + cart pattern](../07-reference/ADR-034-restore-execution-model-and-cart-pattern.md).

## Off-site targets

Bundles are written via `BackupStore` to one of:

- **S3** (`@aws-sdk/client-s3` + multipart). Default for production.
- **SSH** (`ssh2` library + SFTP). For self-hosted offsite.
- **Hostpath** (test-only — refused by the route layer in production).

Configure via Settings → Backups → Add target. At most one target may
be `active=true` at a time (enforced by partial unique index). The
active target is what schedules + admin "Create bundle" actions write
to.

## Triggers (who creates bundles)

| Initiator | When | Code path |
|---|---|---|
| `admin` | Operator clicks "Create bundle" in Backup Settings | `POST /admin/backups/bundles` |
| `client` | Tenant requests GDPR data export from client panel | same route, `initiator='client'`, `exportMode='data_export'` |
| `system` | Tier-1 scheduler tick fires per `client_backup_schedules` row | `runScheduleTick()` in `backups-v2/schedule.ts` |

The Tier-1 scheduler runs every 5 min on every platform-api replica
with a cross-replica CAS (`UPDATE ... WHERE last_run_at = $previous`)
so only one replica runs each due client. Frequencies: `daily`,
`weekly`, `monthly` (with 1-h slack to absorb tick-interval drift).

## Retention

- `backup_jobs.expires_at` is set at create time from `retentionDays`.
- The **retention sweeper** (`backups-v2/retention.ts`, 5-min tick)
  deletes expired bundles via `BackupStore.delete()` and flips
  `status='expired'`.
- Stuck `running` bundles >24h are GC'd to `failed` so they don't
  hang forever.
- Plan-bound retention: `hosting_plans.max_backup_retention_days`
  caps both ad-hoc creates and per-client schedule retention. The
  client panel + admin API both reject `retentionDays > plan_cap`
  with `VALIDATION_ERROR`.

## Restore (Plesk-style cart)

Restores are NOT immediate — they're a **cart**. ADR-034 motivates
the cart pattern; the model is one cart of typed items, executed
sequentially. Per-item idempotency means re-execute resumes from the
failed item.

Item types:

| Type | Selector | Executor |
|---|---|---|
| `config-tables` | `{ kind: 'all' | 'tables', tables: ['<camelCase>'] }` | In-process INSERT…ON CONFLICT (id) DO UPDATE per row, per allow-listed table |
| `deployments-by-id` | `{ kind: 'all' | 'ids', deploymentIds }` | In-process upsert filtered by id |
| `domains-by-id` | `{ kind: 'all' | 'ids', domainIds }` | In-process upsert filtered by id |
| `files-paths` | `{ kind: 'full' | 'paths', paths }` | Tenant-ns Job: download archive via internal-download endpoint, tar-extract paths into PVC |
| `mailboxes-by-address` | `{ kind: 'all' | 'addresses', addresses }` | Mail-ns Job: download per-mailbox tarball, run `stalwart-cli account import` per address |

Cross-tenant guard: every executor asserts `dump.clientId === restoreJob.clientId`
before applying anything.

### Pre-restore snapshot

Carts that include a `files-paths` item create a pre-restore PVC
snapshot before the items loop. The snapshot id is recorded on
`restore_jobs.pre_restore_snapshot_id`. On failure, an operator can
roll back via the cart's "Rollback to snapshot" button (admin UI
amber callout) or the storage-lifecycle page directly. Mail/DB
restores have no rollback today (no PVC to revert).

### Operator surfaces

| Surface | Purpose | Route |
|---|---|---|
| Settings → Backups | List bundles, create, verify, delete, GDPR export download | `/settings/backups` |
| Bundle row → Restore | Open restore cart picker for one bundle | `/restore?bundleId=…&clientId=…` |
| `/restores` | Recent-carts list with status filter + Resume button on failed/paused | `/restores` |
| Client → Backups tab | Per-client schedule editor (daily/weekly/monthly + retention) | `/clients/:id` (Backups tab) |
| Client panel → Backups | Customer self-service: bundles list, schedule editor, GDPR export download | `/backups` (client panel) |

## GDPR data export

When a bundle is created with `exportMode='data_export' + exportPassphrase`,
the orchestrator wraps every component artefact + meta.json into a
single `data-export-<bundleId>.tar.gz.enc` artifact:

- KDF: PBKDF2(passphrase, salt, 100k rounds, sha256) → 48 bytes
- Cipher: AES-256-CBC, OpenSSL `Salted__` envelope
- The platform never stores the passphrase; consumed once and discarded

Customer decrypts locally:

```sh
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -in data-export-<bundleId>.tar.gz.enc -out bundle.tar.gz \
  -pass stdin <<< "$PASSPHRASE"
```

Download: GET `/admin/backups/bundles/:id/data-export` (admin) or
`/client/backups/bundles/:id/data-export` (client panel).

## Operations

### Verify a bundle

`POST /admin/backups/bundles/:id/verify` reads every component back,
decrypts secrets with `k1:` KID, decompresses the config dump, returns
parse-error / decrypt-error / per-component sizes. Use after a
suspicious capture or before relying on a bundle for a recovery.

### Diagnose a failed bundle

```bash
# Status + lastError
curl -H "Authorization: Bearer $TOKEN" \
  $ADMIN_HOST/api/v1/admin/backups/bundles/$BUNDLE_ID

# Per-component breakdown
curl -H "Authorization: Bearer $TOKEN" \
  $ADMIN_HOST/api/v1/admin/backups/bundles/$BUNDLE_ID | jq .data.components
```

Look at `backupComponents[*].status` — anything except `completed` is
the failing one. `lastError` on the row carries a sanitised message;
full diagnostics are in `kubectl -n platform logs -l app=platform-api`.

### Diagnose a failed restore cart

```bash
curl -H "Authorization: Bearer $TOKEN" \
  $ADMIN_HOST/api/v1/admin/restores/carts/$CART_ID
```

The response shows each item's status + `lastError`. Operators get a
notification on cart failure (admin role recipients) so a stuck cart
won't go unnoticed.

To resume after fixing the underlying issue: re-invoke `POST /execute`.
Already-`done` items are skipped; the loop picks up at the failed item.

### Rollback

If a `files-paths` item already wrote bad content:

1. Open the cart at `/restore?cartId=…`.
2. The right-side "Safety net" panel shows the pre-restore snapshot id.
3. Click "Roll back to snapshot" → confirm modal → execute.
4. Storage-lifecycle quiesces tenant workloads, restores PVC contents
   from the snapshot, unquiesces. Progress visible in the Storage
   Operations card.

DB-only restores (config-tables, deployments-by-id, domains-by-id)
have no automatic rollback — the operator's safety net is a
just-before-restore manual bundle.

## Known limitations

### Mailboxes component (capture + restore)
**Status: disabled by default — opt-in via `components.mailboxes:true`**

The Stalwart 0.16.3 image (`docker.io/stalwartlabs/stalwart:v0.16.3`)
ships only the `stalwart` server binary, which supports `-e <path>`
**whole-store** export and `-i <path>` whole-store import — no
per-account export. The legacy `stalwart-cli` binary that the
mailbox capture component invokes (`stalwart-cli account export
<addr> <path>`) is not in the image.

Whole-store export is unsafe on a multi-tenant Stalwart deployment
because the dump contains every tenant's mail. Until the per-account
path is rewritten (likely via JMAP `Email/query` + `Email/get` or a
Stalwart admin HTTP endpoint), bundles default `components.mailboxes
= false` so an operator doesn't accidentally produce a `partial`
bundle whose mailboxes-component failed.

The restore-cart `mailboxes-by-address` executor follows the same
constraint — it'll spawn a Job that errors with "stalwart-cli not on
PATH" until the mirror rewrite ships. Filed as a Phase-4.x
follow-up.

## Schema reference

- `backup_jobs` — one row per bundle (id, clientId, initiator, status, target, retentionDays, expiresAt, sizeBytes, exportMode, exportArtifact, …)
- `backup_components` — one row per component artefact within a bundle
- `backup_configurations` — backup target rows (S3/SSH credentials, encrypted)
- `client_backup_schedules` — per-client schedule (frequency, hourOfDayUtc, retentionDays, last_run_at, last_run_status)
- `restore_jobs` — one row per cart
- `restore_items` — items within a cart (seq, type, selector, status, progressMessage, lastError)
- `storage_snapshots` (kind=`pre-restore`) — pre-restore PVC snapshots

## CI guards

- `scripts/ci-backups-v2-schema-audit.sh` — fails if a new client-FK'd
  table lands in `schema.ts` without being added to `CONFIG_DUMP_TABLES`
  or the exclusion allowlist.
- Backend `vitest` coverage thresholds — exercises 88+ unit tests
  across orchestrator, components, executors, retention, data-export.
- `scripts/integration-staging.sh restore` — E2E scenario:
    - Domains-by-id round-trip (always runs)
    - `RESTORE_INCLUDE_FILES=1` — files-paths Job round-trip
    - `RESTORE_INCLUDE_MAILBOXES=1` — mailboxes-by-address Job round-trip

## Where things live

```
backend/src/modules/backups-v2/
  bundle-store.ts                 BackupStore interface
  s3-backup-store.ts              S3 implementation (multipart, presigned URL)
  ssh-backup-store.ts             SFTP implementation (ssh2)
  local-hostpath-backup-store.ts  test-only
  meta.ts                         meta.json schema + helpers
  orchestrator.ts                 runBundle — drives the per-component capture
  routes.ts                       admin endpoints (bundles, configs, schedule)
  client-routes.ts                client-panel endpoints (self-service)
  internal-upload-route.ts        HMAC-token upload from tenant Jobs
  internal-download-route.ts      HMAC-token download to tenant Jobs (restore)
  retention.ts                    expired-bundle sweeper + stuck-running GC
  schedule.ts                     Tier-1 scheduler tick
  data-export.ts                  GDPR wrap (PBKDF2 + AES-256-CBC, OpenSSL envelope)
  components/
    files.ts                      tenant-ns Job: tar PVC → upload to platform-api
    mailboxes.ts                  mail-ns Job: stalwart-cli export → upload
    config.ts                     in-process: dump CONFIG_DUMP_TABLES rows
    secrets.ts                    in-process: read TLS Secrets, AES-256-GCM
    config.real-db.test.ts        pg-mem real-DB schema-mismatch guard

backend/src/modules/backup-restore/
  routes.ts                       cart CRUD + bundle browse + execute + rollback
  executors/
    _shared.ts                    upsertRow + readAndAuthorizeConfigDump
    config-tables.ts
    deployments-by-id.ts
    domains-by-id.ts
    files-paths.ts                tenant-ns Job: download archive → tar-extract
    mailboxes-by-address.ts       mail-ns Job: download per-addr → stalwart import
    in-process.real-db.test.ts    pg-mem round-trip

frontend/admin-panel/src/
  pages/RestoreCart.tsx           Plesk-style cart picker
  pages/RestoreCartsList.tsx      Recent-carts list with Resume buttons
  components/BackupBundlesSection.tsx  bundle list + create + GDPR export
  components/BackupScheduleEditor.tsx  per-client schedule UI (Backups tab)

frontend/client-panel/src/
  pages/Backups.tsx               customer self-service (list + schedule + GDPR)
  hooks/use-tenant-backups.ts     client-panel hooks
```
