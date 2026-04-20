# Granular Backup Restore Specification

> **Authoritative bundle format:** [`BACKUP_COMPONENT_MODEL.md`](BACKUP_COMPONENT_MODEL.md).
> **Architectural decisions:** [`ADR-028`](../07-reference/ADR-028-backup-architecture.md).
> Both docs take precedence over this spec if anything conflicts.

## Overview

This document defines the **granular backup restore** feature for both Admin and Client panels. Operators and customers can restore a whole client, individual files/folders from the files component, or individual mailboxes from the mailboxes component — from any retained backup version.

## Design Principles

1. **Component-scoped restore:** Restore operates on one or more bundle components (`files`, `mailboxes`, `config`, `secrets`), or a subset of entries inside them.
2. **Replace semantics by default:** Selected files / mailboxes overwrite existing ones. A pre-restore snapshot is always taken automatically so "whoops" rolls back cleanly.
3. **Backup version history:** Users see every retained bundle for the client (client-initiated, admin-initiated, and relevant system-initiated entries per ACL).
4. **Async processing:** Restores run in background with real-time progress tracking (WebSocket / polling), sharing the `OperationProgressModal` component.
5. **Audit trail:** All restore operations are logged to `audit_logs` with initiator, scope, and outcome.
6. **Access control:** Admins can restore any client's data; clients can only restore their own. `system`-initiated backups are admin-only. `cluster` backups are operator-only (not in these APIs).

---

## Part 1: Restore Objects & Scope

### 1.1 Restorable Object Types

| Object Type | Component | Scope values | Restore behavior |
|---|---|---|---|
| **Whole client** | All (`files` + `mailboxes` + `config` + `secrets`) | `full` | Re-create / replace the whole tenant. Existing client → same node. Deleted client → admin picks a target node from the registered-nodes list. |
| **Files / folders** | `files` | `full` (whole PVC) or `selected` (specific paths from the tree index) | Extract chosen paths from `components/files/archive.tar.gz` into the existing PVC. Replace-on-conflict unless `onConflict=skip`. |
| **Mailboxes** | `mailboxes` | `full` for each selected address | Per mailbox: existing contents are **replaced** via Stalwart `account import`. Multi-select supported — N mailboxes, each replaced independently. |

### 1.2 Object types deliberately not supported

Consolidated here from earlier drafts — see [ADR-028](../07-reference/ADR-028-backup-architecture.md) for rationale.

| Earlier scope | Replaced by | Why dropped |
|---|---|---|
| **Per-database restore** (`database_only` / `data_only`) | Whole-files restore or selective file restore | Each client's DB runs in their own pod with datadir on the tenant PVC. Capture is file-level (the `files` component). Restoring the DB = restoring its datadir files + restarting the DB pod. |
| **Per-message mail restore** (`messages_only`) | Whole-mailbox restore | Stalwart's API operates at account level. Per-message restore needs an IMAP-diff tool that doesn't exist and isn't planned. |
| **Date-range mail restore** | Whole-mailbox restore + pre-restore snapshot for rollback | Same reason as per-message. Operators who need date-range recovery roll back via the pre-restore snapshot. |

### 1.3 Platform-level scopes (out of scope for these APIs)

- Kubernetes secrets shared across the platform (sealed secrets in Git / ESO)
- Harbor registry images
- Platform-wide TLS certificates (`*.<apex>` wildcards)
- System DNS zones shared across tenants
- Full-platform disaster recovery — owned by operator tooling (Velero). See [BACKUP_STRATEGY.md Tier 4](../02-operations/BACKUP_STRATEGY.md).

---

## Part 2: Backup Version Discovery

### 2.1 Available Backup Versions

Each restorable object has a **complete history of all snapshots**:

### 2.2 Backup Version Listing API

**Endpoint:** `GET /api/v1/backups/versions`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `object_type` | string | Yes | `whole_client` / `website` / `mail_account` / `files` |
| `object_id` | string | Yes | Client UUID (for `whole_client`), workload ID (for `website` / `files`), or full mailbox address (for `mail_account`) |
| `from` | ISO 8601 date | No | Filter snapshots on or after this date |
| `to` | ISO 8601 date | No | Filter snapshots on or before this date |
| `limit` | integer | No | Max results to return (default 30, max 90) |

**Response Example:**

```json
{
  "object_type": "website",
  "object_id": "workload-web-prod",
  "versions": [
    {
      "backup_id": "bkp-20260308-acme-web",
      "snapshot_date": "2026-03-08",
      "timestamp": "2026-03-08T03:14:22Z",
      "type": "auto",
      "tier": 1,
      "size_bytes": 4831838208,
      "size_human": "4.5 GB",
      "checksum": "sha256:a1b2c3d4...",
      "checksum_verified": true,
      "storage_path": "/backups/daily/2026-03-08/client-acme-corp/workload-web-prod/",
      "encrypted": true,
      "retention_expires_at": "2026-04-07T00:00:00Z",
      "includes": {
        "files": true,
        "mailboxes": ["admin@acme.com", "sales@acme.com"],
        "config": true,
        "secrets": true
      }
    },
    {
      "backup_id": "bkp-20260307-acme-web",
      "snapshot_date": "2026-03-07",
      "timestamp": "2026-03-07T03:12:55Z",
      "type": "auto",
      "tier": 1,
      "size_bytes": 4819001344,
      "size_human": "4.5 GB",
      "checksum": "sha256:e5f6a7b8...",
      "checksum_verified": true,
      "storage_path": "/backups/daily/2026-03-07/client-acme-corp/workload-web-prod/",
      "encrypted": true,
      "retention_expires_at": "2026-04-06T00:00:00Z",
      "includes": {
        "files": true,
        "mailboxes": ["admin@acme.com", "sales@acme.com"],
        "config": true,
        "secrets": true
      }
    }
  ],
  "total": 14,
  "oldest_available": "2026-02-23",
  "newest_available": "2026-03-08"
}
```

---

## Part 3: Website Restore

### 3.1 Website Restore Flow (UI)

**Client Panel → Backups → Global Backups → [select website] → Restore**

1. **Select object** — User chooses the domain/workload to restore (e.g. `acme.com / WordPress`).
2. **Choose backup version** — `BackupVersionSelector` modal shows list of all available snapshots (date, size, type). User selects one.
3. **Preview** — System loads `metadata.json` from the selected backup and shows:
   - File count and total size of the workload directory tree
   - Database(s) included and their sizes
   - Last modified timestamp of the backup
4. **Choose restore scope** — Radio buttons:
   - `Full restore` — files + all databases + config
   - `Files only` — workload file tree, skip database
   - `Database only` — import DB dump(s) only, skip files
5. **Choose restore target** — Radio buttons:
   - `Overwrite current installation` (requires typing `CONFIRM` in a text field)
   - `Restore to new location` — prompts for a new subdomain or temporary path (non-destructive)
6. **Confirm & start** — Confirmation modal shows restore summary (scope, target, backup date). User clicks "Start Restore".
7. **Progress screen** — `RestoreProgressScreen` component opens, showing real-time step progress via WebSocket (see §3.3).
8. **Completion** — Success: green banner with summary, link to restored site. Failure: error message with specific failure reason and rollback confirmation.

> **Non-destructive safeguard:** If "Overwrite current installation" is selected, the system automatically takes a pre-restore snapshot before any modifications. If the restore fails, the pre-restore snapshot is applied automatically (see §9.2).

---

### 3.2 Website Restore API

**Endpoint:** `POST /api/v1/restores/start`

**Payload:**

```json
{
  "object_type": "website",
  "object_id": "workload-web-prod",
  "backup_id": "bkp-20260308-acme-web",
  "scope": "full",
  "target": {
    "mode": "overwrite",
    "confirm": "CONFIRM"
  },
  "notify_on_complete": true,
  "reason": "Accidental file deletion by client"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `object_type` | string | Yes | `website` |
| `object_id` | string | Yes | Workload ID |
| `backup_id` | string | Yes | From `GET /api/v1/backups/versions` |
| `scope` | string | Yes | `full` / `files_only` / `database_only` |
| `target.mode` | string | Yes | `overwrite` / `new_location` |
| `target.confirm` | string | If overwrite | Must equal `"CONFIRM"` (exact string) |
| `target.new_path` | string | If new_location | Subdomain or temp path to restore into |
| `notify_on_complete` | boolean | No | Default `true` — email client on completion |
| `reason` | string | Admin only | Written to audit trail |

**Response:** `202 Accepted`

```json
{
  "restore_id": "rst-a1b2c3d4",
  "status": "queued",
  "object_type": "website",
  "object_id": "workload-web-prod",
  "backup_id": "bkp-20260308-acme-web",
  "scope": "full",
  "target_mode": "overwrite",
  "pre_restore_snapshot_id": "snap-pre-rst-a1b2c3d4",
  "created_at": "2026-03-08T09:15:00Z",
  "websocket_url": "/ws/restores/rst-a1b2c3d4"
}
```

---

### 3.3 Website Restore Progress (WebSocket)

**WebSocket URL:** `wss://api.platform.com/ws/restores/{restore_id}`

**Connection:** Standard WebSocket upgrade. Authentication via `?token={session_token}` query parameter. Connection closes automatically when restore reaches `completed` or `failed` state.

**Progress Stream:**

Each message is a JSON object:

```json
{
  "restore_id": "rst-a1b2c3d4",
  "event": "progress",
  "step": "extracting_files",
  "step_index": 3,
  "total_steps": 7,
  "percent": 42,
  "message": "Copying workload files from backup snapshot (3.1 GB / 4.5 GB)",
  "timestamp": "2026-03-08T09:15:44Z"
}
```

**Possible Steps for Website Restore:**

| Step | `step` value | Description |
|------|-------------|-------------|
| 1 | `validating_backup` | Verify backup integrity — SHA-256 checksum match |
| 2 | `mounting_offsite` | Mount offsite SSHFS (`/mnt/offsite`) via NetBird mesh |
| 3 | `downloading_backup` | Stage backup archive into temporary local path |
| 4 | `extracting_files` | Copy workload file tree from backup into Longhorn PV |
| 5 | `importing_database` | Load database dump into MariaDB/PostgreSQL (transaction-wrapped) |
| 6 | `rebuilding_cache` | Clear and regenerate application cache (e.g. WordPress object cache, OPcache flush) |
| 7 | `verifying_integrity` | Confirm all files present, database accessible, workload pod restarts clean |

**Terminal events:**

```json
{ "event": "completed", "restore_id": "rst-a1b2c3d4", "duration_seconds": 84, "files_restored": 14820, "db_tables_restored": 42 }
{ "event": "failed", "restore_id": "rst-a1b2c3d4", "step": "importing_database", "error_code": "DB_IMPORT_FAILED", "error": "Foreign key constraint violation on table `wp_postmeta`", "rolled_back": true }
```

---

### 3.4 Website Restore Completion

**Endpoint:** `GET /api/v1/restores/{restore_id}`

**Response (Success):**

```json
{
  "restore_id": "rst-a1b2c3d4",
  "status": "completed",
  "object_type": "website",
  "object_id": "workload-web-prod",
  "backup_id": "bkp-20260308-acme-web",
  "scope": "full",
  "target_mode": "overwrite",
  "started_at": "2026-03-08T09:15:01Z",
  "completed_at": "2026-03-08T09:16:25Z",
  "duration_seconds": 84,
  "files_restored": 14820,
  "bytes_restored": 4831838208,
  "pre_restore_snapshot_id": "snap-pre-rst-a1b2c3d4",
  "actor": { "type": "user", "id": "usr-admin-001", "name": "Platform Admin" },
  "audit_log_id": "audit-99271"
}
```

**Response (Failed):**

```json
{
  "restore_id": "rst-a1b2c3d4",
  "status": "failed",
  "object_type": "website",
  "object_id": "workload-web-prod",
  "backup_id": "bkp-20260308-acme-web",
  "scope": "full",
  "failed_at_step": "importing_database",
  "error_code": "DB_IMPORT_FAILED",
  "error_message": "Foreign key constraint violation on table `wp_postmeta`",
  "rolled_back": true,
  "rollback_snapshot_id": "snap-pre-rst-a1b2c3d4",
  "rollback_completed_at": "2026-03-08T09:16:30Z",
  "started_at": "2026-03-08T09:15:01Z",
  "failed_at": "2026-03-08T09:16:20Z",
  "audit_log_id": "audit-99272"
}
```

---

## Part 4: Whole-Client Restore

Restoring a whole client applies every component in the bundle: `files` (PVC contents), `mailboxes` (per-mailbox imports), `config` (platform-DB rows), and `secrets` (TLS certs). This is the correct scope for "I need my deleted client back" and for "my cluster ate itself, roll this tenant back to yesterday."

### 4.1 Flow (Admin Panel)

1. **Pick backup** — Admin opens Backups view, filters by client (or finds deleted client via the `backup_jobs.client_id` history), clicks a backup row.
2. **Choose restore mode:**
   - `Existing client, same node` (default when the client row still exists). No node prompt.
   - `Recreate deleted client` (shown only when the client row is absent). Admin picks the target node from the registered-nodes dropdown; `meta.json.nodePlacement.preferredNode` preselects the original node if it's still in the list.
3. **Confirm** — Summary modal shows: files size, mailbox count, config row count, secrets key-version. Admin types `CONFIRM` to start (only required for the "recreate deleted client" path).
4. **Progress** — Shared `OperationProgressModal` polls `GET /api/v1/restores/{restore_id}` every 1.5 s until terminal state.
5. **Completion** — On success, admin is redirected to the client detail page. On failure, the pre-restore snapshot is retained and a "Roll back to pre-restore" action is offered.

### 4.2 API

**Endpoint:** `POST /api/v1/admin/restores/start`

**Payload (existing client):**
```json
{
  "object_type": "whole_client",
  "object_id": "4ec7436d-6159-4bf0-9282-d7e4cc19410b",
  "backup_id": "bkp-8f59ec16-a7c3-...",
  "scope": "full",
  "skip_secrets": false,
  "notify_on_complete": true
}
```

**Payload (recreate deleted client):**
```json
{
  "object_type": "whole_client",
  "backup_id": "bkp-8f59ec16-a7c3-...",
  "scope": "full",
  "recreate": {
    "target_node": "k8s-local",
    "confirm": "CONFIRM"
  },
  "skip_secrets": false
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `object_type` | string | Yes | `whole_client` |
| `object_id` | string | Only for existing clients | Client UUID |
| `backup_id` | string | Yes | From `GET /api/v1/admin/backups/versions` |
| `scope` | string | Yes | `full` — only scope for this object type |
| `recreate.target_node` | string | For deleted clients | Kubernetes node name from `GET /api/v1/admin/nodes` |
| `recreate.confirm` | string | For deleted clients | Must equal `"CONFIRM"` |
| `skip_secrets` | boolean | No | When true, TLS Secrets are not restored; cert-manager re-issues (30–60 s delay on first request). Default false. |

**Response:** `202 Accepted` — same envelope as §3.2.

**Whole-client restore steps (WebSocket):**

| Step | `step` value | Description |
|---|---|---|
| 1 | `validating_bundle` | Check `meta.json` schema + component SHA-256s |
| 2 | `taking_pre_restore_snapshot` | Capture current state (existing-client mode only) |
| 3 | `recreating_client` | INSERT client row + users (deleted-client mode) |
| 4 | `provisioning_namespace` | Create namespace on `target_node`, apply ResourceQuota + NetworkPolicies |
| 5 | `restoring_config` | Apply `components/config/db-rows.json.gz` into platform DB |
| 6 | `restoring_files` | Extract `components/files/archive.tar.gz` into freshly-created PVC |
| 7 | `restoring_secrets` | Decrypt + apply `components/secrets/tls.json.gz.enc` (unless `skip_secrets`) |
| 8 | `restoring_mailboxes` | For each mailbox in the bundle, call Stalwart `account import` (replace) |
| 9 | `reconciling` | Trigger ingress reconciler + cert-manager; wait for workloads to go Ready |

### 4.3 Rollback

Every whole-client restore takes a pre-restore snapshot in step 2 (existing-client mode). On failure at any step, the platform rolls back automatically. The pre-restore snapshot is retained for 7 days so an admin can also manually roll back after a successful-but-wrong restore.

---

## Part 5: Mail Account Restore (per mailbox, whole)

### 5.1 Mail Account Restore Flow (UI)

**Client Panel → Email → [select mailbox] → Restore from backup**
**Admin Panel → Clients → [select client] → Backups → [select backup] → Mailboxes → pick N mailboxes → Restore**

1. **Select mailbox(es)** — Either from the Email page (single mailbox) or from a backup's mailbox list (multi-select).
2. **Choose backup version** — `BackupVersionSelector` shows available bundles, filtered to those that contain a `mailboxes` component for the selected address(es). Each entry shows: captured-at, message count, mailbox size.
3. **Confirm replace** — Only one scope is supported: **full mailbox, replace semantics**. The UI shows a prominent red warning:
   > "Restoring will REPLACE the current contents of `<address>`. All messages currently in this mailbox will be deleted. A pre-restore snapshot of the mailbox is taken automatically and retained for 7 days — you can roll back from there if needed."
   User types `CONFIRM` (case-sensitive) to enable the Restore button.
4. **Progress screen** — WebSocket progress per mailbox (step `restoring_mailbox <address>`).
5. **Completion** — Summary: addresses restored, message count per mailbox, rollback snapshot id. Failure: error, automatic rollback confirmation, manual-rollback button.

**Per-message, per-folder, and date-range restore are explicitly not supported** — see §1.2 and [ADR-028](../07-reference/ADR-028-backup-architecture.md). Operators needing targeted recovery use the pre-restore snapshot retained from step 3.

---

### 5.2 Mail Account Restore API

**Endpoint:** `POST /api/v1/restores/start` (client panel) or `POST /api/v1/admin/restores/start` (admin panel)

**Payload:**

```json
{
  "object_type": "mail_account",
  "object_ids": ["admin@acme.com", "sales@acme.com"],
  "backup_id": "bkp-20260308-acme-mail",
  "scope": "full",
  "confirm": "CONFIRM",
  "notify_on_complete": true
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `object_type` | string | Yes | `mail_account` |
| `object_ids` | string[] | Yes | One or more full email addresses. Each must exist in the backup's `components/mailboxes/` index. |
| `backup_id` | string | Yes | From `GET /api/v1/backups/versions` |
| `scope` | string | Yes | `full` — only supported value |
| `confirm` | string | Yes | Must equal `"CONFIRM"` (replace semantics are always destructive) |
| `notify_on_complete` | boolean | No | Default false |

**Response:** `202 Accepted` — same structure as §3.2, with `object_type: "mail_account"` and an array of per-mailbox sub-restore ids so the progress UI can track each mailbox independently.

**Mail-specific restore steps (WebSocket, per mailbox):**

| Step | `step` value | Description |
|---|---|---|
| 1 | `validating_artifact` | Verify `<address>.mbox.tar.gz` SHA-256 from `meta.json` |
| 2 | `pre_restore_snapshot` | Export current mailbox contents to a pre-restore snapshot (retained 7 days) |
| 3 | `staging_artifact` | Download the per-mailbox artifact from the storage target to a temp Job volume |
| 4 | `wiping_current` | `stalwart-cli account delete-messages <address>` — replace semantics |
| 5 | `importing` | `stalwart-cli account import <address> --from <staging>` |
| 6 | `reconciling_quota` | Recompute mailbox quota usage and update `mailboxes.quota_used_mb` |
| 7 | `done` | Success event emitted per mailbox; the outer job completes once all mailboxes reach `done` |

---

## Part 6: File & Folder Restore

### 6.1 File Restore Flow (UI)

**Most Important Feature for Users** — Files are constantly modified and accidentally deleted.

**Client Panel → Files → Restore from backup** or **Client Panel → Backups → [select snapshot] → Browse files**

1. **Choose backup version** — `BackupVersionSelector` shows all available file backup snapshots (date, total file count, total size).
2. **Browse or search** — User lands on the `FileTreeBrowser` component (see §7.2):
   - **Browse mode:** Expandable folder tree — starting at the workload root (`/var/www/html/`). Each node shows name, size, last modified, and file type icon.
   - **Search mode:** `FileSearchBox` (see §7.2) — type filename or pattern; results show relative path, size, last modified.
3. **Select items** — Checkbox selection of files and/or folders. Multi-select supported. "Select all" at any folder level.
4. **Choose restore target** — Radio buttons:
   - `Restore to original path` — overwrites file(s) in place (requires `CONFIRM` if any existing file would be overwritten)
   - `Restore to alternate path` — specify a different directory within the workload volume (non-destructive, **default for single files**)
5. **Conflict resolution** (if restoring to original path) — Dropdown: `Overwrite` / `Skip existing` / `Rename restored file (add .restored suffix)`.
6. **Exclude patterns** (optional advanced field) — Glob patterns to exclude from the restore (e.g. `*.log`, `cache/`).
7. **Confirm & start** — Shows: selected items count and total size, target path, conflict resolution mode. User clicks "Restore X files".
8. **Progress screen** — WebSocket progress per file batch (see §6.4 steps).
9. **Completion** — Success: file count restored, list of any skipped files. Failure: error and rollback state.

---

### 6.2 File Restore Tree API

**Endpoint:** `GET /api/v1/backups/{backup_version_id}/files/tree`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No | Directory path to list (default: `/` — workload root). URL-encoded. |
| `depth` | integer | No | How many levels to expand (default `1`; max `3`). |

**Response:**

```json
{
  "backup_version_id": "bkp-20260308-acme-web",
  "path": "/var/www/html",
  "children": [
    {
      "name": "wp-content",
      "type": "directory",
      "path": "/var/www/html/wp-content",
      "size_bytes": 1073741824,
      "size_human": "1.0 GB",
      "children_count": 3,
      "last_modified": "2026-03-07T18:44:12Z"
    },
    {
      "name": "wp-config.php",
      "type": "file",
      "path": "/var/www/html/wp-config.php",
      "size_bytes": 3145,
      "size_human": "3.1 KB",
      "last_modified": "2026-01-15T09:22:00Z",
      "mime_type": "text/x-php"
    },
    {
      "name": "index.php",
      "type": "file",
      "path": "/var/www/html/index.php",
      "size_bytes": 420,
      "size_human": "420 B",
      "last_modified": "2025-12-01T00:00:00Z",
      "mime_type": "text/x-php"
    }
  ],
  "total_children": 12,
  "path_size_bytes": 4194304000,
  "path_size_human": "3.9 GB"
}
```

---

### 6.3 File Search API

**Endpoint:** `GET /api/v1/backups/{backup_version_id}/files/search`

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Filename or glob pattern (e.g. `*.jpg`, `config.php`, `uploads/2026-02*`) |
| `path` | string | No | Restrict search to this path prefix |
| `type` | string | No | `file` / `directory` (default: both) |
| `page` | integer | No | Page number (default `1`) |
| `limit` | integer | No | Results per page (default `50`, max `200`) |

**Response:**

```json
{
  "backup_version_id": "bkp-20260308-acme-web",
  "query": "*.jpg",
  "total": 843,
  "page": 1,
  "limit": 50,
  "results": [
    {
      "name": "hero-banner.jpg",
      "type": "file",
      "path": "/var/www/html/wp-content/uploads/2026/02/hero-banner.jpg",
      "size_bytes": 245760,
      "size_human": "240 KB",
      "last_modified": "2026-02-14T12:00:00Z",
      "mime_type": "image/jpeg"
    },
    {
      "name": "team-photo.jpg",
      "type": "file",
      "path": "/var/www/html/wp-content/uploads/2026/01/team-photo.jpg",
      "size_bytes": 512000,
      "size_human": "500 KB",
      "last_modified": "2026-01-20T09:30:00Z",
      "mime_type": "image/jpeg"
    }
  ]
}
```

---

### 6.4 File Restore API

**Endpoint:** `POST /api/v1/restores/start`

**Payload:**

```json
{
  "object_type": "files",
  "object_id": "workload-web-prod",
  "backup_id": "bkp-20260308-acme-web",
  "scope": "selected",
  "items": [
    "/var/www/html/wp-content/uploads/2026/02/hero-banner.jpg",
    "/var/www/html/wp-content/uploads/2026/02/"
  ],
  "exclude_patterns": ["*.log", "cache/"],
  "target": {
    "mode": "original_path",
    "conflict_resolution": "rename",
    "confirm": "CONFIRM"
  },
  "notify_on_complete": true
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `object_type` | string | Yes | `files` |
| `object_id` | string | Yes | Workload ID |
| `backup_id` | string | Yes | From `GET /api/v1/backups/versions` |
| `scope` | string | Yes | `selected` (specific items) / `full` (entire workload tree) |
| `items` | array | If selected | List of file/folder paths to restore |
| `exclude_patterns` | array | No | Glob patterns to skip during restore |
| `target.mode` | string | Yes | `original_path` / `alternate_path` |
| `target.path` | string | If alternate_path | Destination directory within workload volume |
| `target.conflict_resolution` | string | Yes | `overwrite` / `skip` / `rename` |
| `target.confirm` | string | If overwrite | Must equal `"CONFIRM"` |

**Response:** `202 Accepted` — same structure as §3.2, with `object_type: "files"`.

**File-specific restore steps (WebSocket):**

| Step | `step` value | Description |
|------|-------------|-------------|
| 1 | `validating_backup` | Verify backup snapshot integrity |
| 2 | `mounting_offsite` | Mount SSHFS offsite server |
| 3 | `resolving_items` | Expand any selected directories into individual file lists; apply exclude patterns |
| 4 | `restoring_files` | Copy selected files from offsite snapshot to Longhorn PV (batched, progress by file count) |
| 5 | `setting_permissions` | Apply correct ownership and permissions (`644` files / `755` directories) |
| 6 | `verifying_files` | Confirm all restored files are present and non-zero size |

**WebSocket progress during `restoring_files` step:**

```json
{
  "event": "progress",
  "step": "restoring_files",
  "step_index": 4,
  "total_steps": 6,
  "files_done": 420,
  "files_total": 843,
  "bytes_done": 104857600,
  "bytes_total": 245760000,
  "percent": 43,
  "current_file": "/var/www/html/wp-content/uploads/2026/02/gallery-12.jpg"
}
```

---

## Part 7: UI Components

### 7.1 Backup Version Selector (Shared)

**Component:** `BackupVersionSelector`

Reused across website, database, mail, and file restores. Rendered as a full-page modal or inline panel.

**Layout:**

- **Header:** `Select a backup version to restore from`
- **Object identifier:** `Restoring: acme.com (WordPress)` — non-editable label
- **Date range filter:** Date picker (from / to) — defaults to last 30 days
- **Version list:** Scrollable table:

| Column | Notes |
|--------|-------|
| Date | `Mar 8, 2026 · 03:14 UTC` |
| Age | `Today` / `Yesterday` / `3 days ago` |
| Type | `Auto (platform)` / `Manual` / `Customer-created` |
| Size | `4.5 GB` |
| Checksum | `✓ Verified` / `⚠ Not verified` / `✗ Mismatch` |
| Includes | Icon badges for: `Files`, `DB`, `Mail`, `Config` |

- **Selected state:** Clicking a row highlights it and enables the "Use this version" button.
- **Empty state:** "No backup versions found in this date range." with a "Expand date range" link.
- **Footer:** `Cancel` / `Use this version →` buttons.

---

### 7.2 File Browser Component

**Component:** `FileTreeBrowser` + `FileSearchBox`

Used exclusively in file restore (§6.1). Renders within the restore flow after a backup version is selected.

**`FileTreeBrowser` layout:**

- **Breadcrumb nav:** `/ var / www / html / wp-content` — each segment is clickable
- **Toolbar:** `Browse` tab | `Search` tab | Column selector | `Select all` checkbox
- **Tree pane:** Two-column layout:
  - Left: expandable folder tree (lazy-loads children via `GET .../files/tree?path=...`)
  - Right: contents of selected folder — files + subfolders as a table

| Column | Notes |
|--------|-------|
| ☐ | Multi-select checkbox |
| Name | File/folder name with icon |
| Size | Human-readable |
| Modified | Date from backup snapshot |
| Type | Extension or `Folder` |

- **Selection counter:** Sticky footer bar: `843 files selected · 4.5 GB`  `Clear selection` link.

**`FileSearchBox` layout:**

- Text input with glob hint: `Search by filename or pattern (e.g. *.jpg, config.php)`
- Results stream in as user types (debounced 400ms, min 2 chars)
- Results list: path, size, last modified — each row has checkbox
- "Search within path" toggle to restrict to currently browsed directory

---

### 7.3 Restore Progress Screen

**Component:** `RestoreProgressScreen`

Displayed after restore is confirmed. Subscribes to WebSocket at `/ws/restores/{restore_id}`.

**Layout:**

- **Header:** `Restore in progress` with spinning indicator
- **Object summary:** `Restoring: acme.com (WordPress) · Backup: Mar 8, 2026`
- **Steps list:** Vertical stepper — each step shows:
  - `● pending` (grey) / `↻ in_progress` (blue, animated) / `✓ done` (green) / `✗ failed` (red)
  - Step label (e.g. "Importing database")
  - Duration when completed (e.g. `12s`)
- **Progress bar:** Overall percent complete (driven by WebSocket `percent` field)
- **Live message:** Scrolling status text from WebSocket `message` field (e.g. "Copying workload files 3.1 GB / 4.5 GB")
- **Cancel button:** Visible only while restore is `queued` or during `validating_backup` / `mounting_offsite` steps. Disabled once file operations begin.

**Completed state:**

- All steps shown green
- Summary card: `✓ Restore complete · 14,820 files · 42 DB tables · 84 seconds`
- Actions: `View restored site →` / `Close`

**Failed state:**

- Failed step shown in red with error message
- Rollback status: `Automatic rollback completed` or `Manual recovery required` (per §9.2)
- Actions: `Retry restore` / `Contact support` / `Close`

---

### 7.4 Restore History List (Audit Trail)

**Component:** `RestoreHistoryTable`

Available at: **Client Panel → Backups → Restore history** and **Admin Panel → Backup → Restores** (admin sees all clients).

**Columns:**

| Column | Notes |
|--------|-------|
| Date | Restore initiated timestamp |
| Object | Type + name (e.g. `Website · acme.com`) |
| Backup version | Backup date used |
| Scope | `Full` / `Database only` / `Files only` / `Selected files (N)` |
| Status | `✓ Completed` / `✗ Failed` / `↻ In progress` / `⊘ Cancelled` |
| Duration | Wall-clock time |
| Initiated by | `You` (client view) / User name + type badge (admin view) |
| Actions | View detail |

**Detail modal:** Shows full restore result payload (from `GET /api/v1/restores/{id}`), including rollback info if failed. Admin view additionally shows `reason`, `pre_restore_snapshot_id`, and the raw `audit_log_id` link.

**Filter:** By status, object type, date range. Admin view additionally filters by client.

---

## Part 8: Admin-Only Restore Features

### 8.1 Admin Restore Differences

When an **admin** initiates a restore on a **client's data**, additional controls are available:

### 8.2 Admin-Only Capabilities

- Restore **any client's** data
- **Skip integrity checks** (for heavily corrupted backups with explicit admin override)
- **Notify client** via email when restore completes
- Specify **custom reason** for audit trail
- View **all restores** across all clients (filtered/searchable)
- **Bulk operations** (not in initial release, but planned):
  - Restore multiple databases at once
  - Schedule mass restores during maintenance window

---

## Part 9: Error Handling & Recovery

### 9.1 Common Failures & Resolutions

| Scenario | Error Code | User Message | Auto-Recovery | Admin Action |
|---|---|---|---|---|
| Backup file corrupted | `BACKUP_CORRUPTED` | "Backup file is damaged. Try an older version." | No | Check backup integrity; use SFTP version |
| Database import failed | `DB_IMPORT_FAILED` | "Database import failed (constraint violation). Try data-only mode." | No | Review database schema changes |
| Insufficient disk space | `INSUFFICIENT_DISK` | "Not enough disk space. Free up storage and retry." | No | Delete old backups; add storage |
| Network timeout | `NETWORK_TIMEOUT` | "Connection lost. Restore paused; you can retry." | Yes (auto-retry) | Check network; try alternate SFTP |
| File permissions error | `PERMISSION_DENIED` | "Cannot write to destination. Check file permissions." | No | Fix directory ownership |
| Restore already in progress | `RESTORE_IN_PROGRESS` | "Another restore is running. Wait or cancel it." | No | Cancel previous restore |

### 9.2 Automatic Rollback

If a restore fails **after modifications**:

**Rollback happens automatically for:**
- Database import failures (transaction rollback)
- File extraction errors (files not committed yet)
- Configuration validation failures

**Manual recovery needed for:**
- Network failures mid-transfer (incomplete data)
- Disk space exhaustion (manual cleanup required)

---

## Part 10: API Reference Summary

### Restore Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v1/backups/versions` | List all backup versions for an object |
| GET | `/api/v1/backups/{id}/files/tree` | Browse file tree in backup |
| GET | `/api/v1/backups/{id}/files/search` | Search for files in backup |
| POST | `/api/v1/restores/start` | Initiate a restore operation |
| GET | `/api/v1/restores/{id}` | Get restore status/result |
| GET | `/api/v1/restores?client_id=X` | List all restores for a client (admin) |
| DELETE | `/api/v1/restores/{id}` | Cancel a restore (if in_progress) |
| WS | `/ws/restores/{id}` | WebSocket for real-time progress |

### Request/Response Structures

**All requests include:**

| Header / Field | Value |
|---------------|-------|
| `Authorization` | `Bearer {session_token}` |
| `Content-Type` | `application/json` |
| `X-Client-ID` | Client namespace ID (injected server-side from token for client users; explicit for admin calls on behalf of a client) |

**All `POST /api/v1/restores/start` requests share these top-level fields:**

```json
{
  "object_type": "whole_client | website | mail_account | files",
  "object_id": "<id>",
  "object_ids": ["<id1>", "<id2>"],
  "backup_id": "<backup_id>",
  "scope": "<scope>",
  "target": { "mode": "overwrite | new_location | ...", "confirm": "CONFIRM" },
  "recreate": { "target_node": "<node>", "confirm": "CONFIRM" },
  "skip_secrets": false,
  "notify_on_complete": true,
  "reason": "<admin-only audit note>"
}
```

`object_id` is used for single-target object types (`website`, `files`, `whole_client`). `object_ids` is used when the object type is multi-select (`mail_account`). `recreate` is required only for `whole_client` restores of deleted clients.

**All success responses include:**

```json
{
  "restore_id": "rst-<uuid>",
  "status": "queued | in_progress | completed | failed | cancelled",
  "object_type": "<type>",
  "object_id": "<id>",
  "backup_id": "<backup_id>",
  "scope": "<scope>",
  "target_mode": "<mode>",
  "pre_restore_snapshot_id": "snap-pre-rst-<uuid>",
  "created_at": "<ISO 8601>",
  "websocket_url": "/ws/restores/<restore_id>"
}
```

**All error responses use standard platform error format:**

```json
{
  "error": {
    "code": "RESTORE_IN_PROGRESS",
    "message": "Another restore is already running for this object.",
    "details": { "existing_restore_id": "rst-xyz" }
  }
}
```

HTTP status codes:
- `202 Accepted` — restore queued successfully
- `400 Bad Request` — invalid payload (missing fields, bad scope)
- `403 Forbidden` — client attempting to restore another client's data
- `409 Conflict` — restore already in progress for this object
- `422 Unprocessable Entity` — business rule violation (e.g. missing `CONFIRM` for overwrite)

---

## Part 11: Security & Compliance

### 11.1 Access Control

| Role | Can Restore | Can Restore Others | Can Skip Checks | Rate Limit |
|---|---|---|---|---|
| **Client** | Own data only | No | No | 10 restores/day |
| **Admin** | Any data | Yes | Yes (with override) | Unlimited |
| **Support** | Any data (read-only, can initiate) | Yes | No | 20 restores/day |

### 11.2 Audit Logging

Every restore operation logs the following fields to `audit_logs` (using `action_type = RESTORE_START`, `RESTORE_COMPLETE`, or `RESTORE_FAILED`):

| Field | Value |
|-------|-------|
| `client_id` | Client namespace being restored |
| `action_type` | `RESTORE_START` / `RESTORE_COMPLETE` / `RESTORE_FAILED` |
| `resource_type` | `website` / `database` / `mail_account` / `files` |
| `resource_id` | Object ID being restored (workload ID, DB ID, mailbox address) |
| `actor_id` | User ID who initiated the restore |
| `actor_type` | `user` (client or admin) |
| `actor_name` | Display name of the user at time of action |
| `changes.before` | Snapshot ID of pre-restore state (`pre_restore_snapshot_id`) |
| `changes.after` | `restore_id` of the operation |
| `metadata.backup_id` | Backup version used |
| `metadata.scope` | `full` / `files_only` / `selected` |
| `metadata.target_mode` | `overwrite` / `new_location` / `merge` |
| `metadata.reason` | Admin-supplied reason (if provided) |
| `metadata.duration_seconds` | Wall-clock duration (on RESTORE_COMPLETE) |
| `metadata.rolled_back` | `true` / `false` (on RESTORE_FAILED) |
| `status` | `success` / `failure` |
| `error_message` | Failure reason (on RESTORE_FAILED) |
| `ip_address` | Requester IP |
| `timestamp` | UTC timestamp of the event |

Logs stored in:
- PostgreSQL audit table (queryable, searchable)
- Loki logs (long-term retention, searchable)
- Separate immutable audit log (for compliance)

### 11.3 Data Privacy

- Admins can see **what was restored** (object type, size, duration)
- Admins **cannot read** client data (files, databases, emails) directly
- Backups encrypted at rest (AES-256)
- Restore streams use TLS 1.3 (encrypted in transit)
- Audit logs exclude sensitive data (passwords, email content, etc.)

---

## Part 12: Implementation Checklist

### Database Schema

The `restore_jobs` and related tables are **not yet present in `DATABASE_SCHEMA.md`** and must be added as part of implementation.

- [ ] Add `restore_jobs` table to `DATABASE_SCHEMA.md` DDL:

```sql
CREATE TABLE restore_jobs (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  client_id VARCHAR(36) NOT NULL,
  object_type ENUM('whole_client', 'website', 'mail_account', 'files') NOT NULL,
  object_id VARCHAR(255) NOT NULL,
  backup_id VARCHAR(36) NOT NULL,
  scope ENUM('full', 'files_only', 'selected') NOT NULL,
  target_mode ENUM('overwrite', 'new_location', 'new_database', 'merge', 'alternate_path') NOT NULL,
  status ENUM('queued', 'in_progress', 'completed', 'failed', 'cancelled') DEFAULT 'queued',
  pre_restore_snapshot_id VARCHAR(36) COMMENT 'Snapshot taken before overwrite restores',
  actor_id VARCHAR(36) NOT NULL,
  actor_type ENUM('user', 'admin') DEFAULT 'user',
  reason TEXT COMMENT 'Admin-supplied reason for audit trail',
  progress_percent TINYINT UNSIGNED DEFAULT 0,
  current_step VARCHAR(50),
  error_code VARCHAR(100),
  error_message TEXT,
  rolled_back TINYINT(1) DEFAULT 0,
  files_restored INT DEFAULT 0,
  bytes_restored BIGINT DEFAULT 0,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  failed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_client_id (client_id),
  KEY idx_object (object_type, object_id),
  KEY idx_status (status),
  KEY idx_created_at (created_at),

  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] Restore audit events use the existing `audit_logs` table (no separate `restore_audit_log` table required — action_types `RESTORE_START`, `RESTORE_COMPLETE`, `RESTORE_FAILED` are sufficient)
- [ ] Add indexes on `restore_jobs`: `client_id`, `object_type + object_id`, `status`, `created_at`

### Backend APIs

- [ ] GET `/api/v1/backups/versions`
- [ ] GET `/api/v1/backups/{id}/files/tree`
- [ ] GET `/api/v1/backups/{id}/files/search`
- [ ] POST `/api/v1/restores/start`
- [ ] GET `/api/v1/restores/{id}`
- [ ] GET `/api/v1/restores` (list all, with filtering)
- [ ] DELETE `/api/v1/restores/{id}` (cancel)
- [ ] WebSocket `/ws/restores/{id}` (real-time progress)

### Frontend Components

- [ ] `BackupVersionSelector` (shared modal)
- [ ] `FileTreeBrowser` (file restore)
- [ ] `FileSearchBox` (file restore)
- [ ] `RestoreProgressScreen` (real-time updates)
- [ ] `RestoreHistoryTable` (audit trail)
- [ ] `RestoreConfirmationModal` (summary before executing)

### Integration Points

- [ ] `BackupStore` abstraction (hostpath / S3 / SSH) reading from the component-oriented bundle
- [ ] PVC restore Job — `tar -xzf archive.tar.gz` (full) or `tar -xzf archive.tar.gz -- <paths>` (selected) into a freshly-created tenant PVC
- [ ] Stalwart `account import` Job — per-mailbox replace-semantics importer
- [ ] Platform DB row importer (FK-safe INSERT order: clients → users → domains → ...)
- [ ] TLS Secret applier (decrypt + `kubectl apply` before ingress reconciler re-attaches)
- [ ] Node selector for deleted-client restore — reads `GET /api/v1/admin/nodes`
- [ ] WebSocket / polling progress (shared `OperationProgressModal` component)
- [ ] Audit log sink (already wired via `audit_logs`)

---

## Part 13: Future Enhancements

### Phase 2 (Not in initial release)

- [ ] **Scheduled restores** (e.g., "Restore daily 2:00 AM UTC")
- [ ] **Differential restore** (restore only changes since date X)
- [ ] **Cross-region restore** (restore from backup in different region)
- [ ] **Bulk operations** (restore multiple databases/sites at once)
- [ ] **Restore templates** (save common restore configs)
- [ ] **Email-triggered restores** (send file list via email, click to restore)
- [ ] **Application-aware restore** (WordPress plugins auto-configure after restore)
- [ ] **S3 compatibility mode** (direct S3 restore, not via API)

### Phase 3 (Nice to have)

- [ ] **Incremental restore** (restore only delta from point A to B)
- [ ] **Streaming restore** (start using restored data before fully extracted)
- [ ] **Instant clone** (restore to new domain/database instantly using snapshots)
- [ ] **Restore verification** (automated testing: load test page, check DB health, etc.)
- [ ] **Restore analytics** (which objects are restored most often?)

---

## Summary

This specification enables **granular, user-friendly restore functionality** with:

✅ Full backup version history visible to users  
✅ Individual object selection (not "restore everything")  
✅ Support for websites, databases, email, and files  
✅ Non-destructive by default (rename/alternate location)  
✅ Async processing with real-time progress  
✅ Comprehensive audit trail for compliance  
✅ Both admin and client access with appropriate controls  
✅ Automatic rollback on failure  
✅ Clear error messages and recovery steps  

**Next Steps:**

1. Update `INFRASTRUCTURE_PLAN.md` Section 9.5.7 with this granular restore design
2. Create API implementation guide with endpoint details
3. Begin frontend component development (Backup Selector, File Browser, Progress Screen)
4. Implement backend restore orchestration service
