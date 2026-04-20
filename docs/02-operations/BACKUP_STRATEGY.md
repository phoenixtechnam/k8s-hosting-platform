# Backup Strategy: Component-Oriented Backups with Tiered Initiators

**Status:** Specification · 2026-04-20
**Owner:** Infrastructure & Operations Team

> **Authoritative docs:**
> - [../06-features/BACKUP_COMPONENT_MODEL.md](../06-features/BACKUP_COMPONENT_MODEL.md) — canonical bundle format (takes precedence)
> - [../07-reference/ADR-028-backup-architecture.md](../07-reference/ADR-028-backup-architecture.md) — architectural decisions
> - [BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md](BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md) — capture pipelines
> - [BACKUP_EXPORT_MIGRATION_GUIDE.md](BACKUP_EXPORT_MIGRATION_GUIDE.md) — off-platform migration
> - [../06-features/RESTORE_SPECIFICATION.md](../06-features/RESTORE_SPECIFICATION.md) — restore API + UI

## Overview

A backup is a **component-oriented directory** (files, mailboxes, config, secrets — see [BACKUP_COMPONENT_MODEL.md](../06-features/BACKUP_COMPONENT_MODEL.md)) written to one of three first-class storage backends (`hostpath`, `s3`, `ssh`).

Four initiators share that single bundle format:

1. **System (cluster-managed, automated)** — daily + pre-destructive-op captures of active clients, for disaster recovery and rollback
2. **Admin (operator-initiated)** — ad-hoc captures before planned changes, bulk pre-upgrade runs, migration support
3. **Client (customer-initiated)** — self-service from the client panel, counts against plan quota, supports GDPR Art. 20 data-portability export
4. **Cluster DR (Velero)** — separate pipeline for the entire platform (platform DB, Stalwart PVC, cert-manager, Flux, Harbor); not discussed in this doc beyond [Tier 4](#tier-4-cluster-disaster-recovery-velero) below

Everything in tiers 1–3 uses the same bundle format, the same restore orchestrator, and the same on-disk layout on whichever storage target is configured. The difference is **access control** (ACL driven by `meta.json.initiator`), **quota** (counts against the plan only for tier 3), and **retention windows**.

Bundles are organized by client, containing:
- Every file on the tenant PVC (including application database datadirs — see note below)
- Every mailbox owned by the client (one Stalwart export per address)
- Every platform-DB row scoped to the client (domains, deployments, ingress routes, mailbox metadata, DKIM keys, SFTP users, etc.)
- Encrypted TLS Secrets from the tenant namespace

**Per-database logical dumps are NOT produced** — each client runs their own MariaDB/PostgreSQL pod with its datadir on the tenant PVC, so the files component already captures the database as data files. Restoration re-extracts those files and restarts the DB pod. See [ADR-028](../07-reference/ADR-028-backup-architecture.md) decision 3.

---

## Tier 1: System-Initiated (Cluster-Managed) Backups

**Fully automated captures of all active customer data, included in all plans, free to customers.**

### Backup schedule & content

| Component | Frequency | What's captured |
| --- | --- | --- |
| `files`    | Daily (03:00 UTC) | Full tenant PVC contents (includes WordPress files, DB datadirs, uploads, file-manager home) |
| `mailboxes`| Daily (04:00 UTC) | Per-mailbox exports via `stalwart-cli account export` — one `.mbox.tar.gz` per address |
| `config`   | Daily (03:00 UTC) | All platform-DB rows with `client_id` FK (~29 tables) |
| `secrets`  | Daily (03:00 UTC) | TLS Secrets in tenant namespace, encrypted at bundle time with `OIDC_ENCRYPTION_KEY` |

Every daily run produces **one bundle per active client**, directory-structured on the configured backup target. Retention + expiry are enforced by the storage-lifecycle scheduler.

### Backup tools & storage

| Role | Tool |
| --- | --- |
| **PVC capture** | Short-lived Kubernetes Job (`snapshotTenantPVC` — see BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md) |
| **Mailbox capture** | Job running `stalwart-cli account export` against Stalwart admin API |
| **Platform-DB export** | `client-lifecycle/backup-db.ts` SELECT → gzipped JSON |
| **TLS capture** | List Secrets in tenant namespace → AES-256-GCM encrypt → write sidecar |
| **Storage backends** | `hostpath` (default local), `s3` (S3 / S3-compatible), `ssh` (remote via SSH + `tar`/`sftp`) — all three are first-class |

Stalwart DKIM keys live on the Stalwart PVC AND as rows in `email_dkim_keys`. The `config` component captures the DB rows; the cluster-DR Velero pipeline (Tier 4) captures the Stalwart PVC. A per-tenant `files` backup alone does NOT preserve DKIM — restore relies on the `config` component to re-import the key into Stalwart.

### Retention Periods (Cluster Backups)

Configurable per plan with per-client overrides:

| Plan | Default Retention | Maximum | Notes |
| --- | --- | --- | --- |
| **Starter** | 7 days | 14 days | Can be extended per client |
| **Business** | 14 days | 30 days | Can be extended per client |
| **Premium** | 30 days | 90 days | Can be extended per client |
| **Custom** | Negotiated | Unlimited | Enterprise SLA option |

### Storage Accounting

**Cluster-managed backups:**
- **NO quota impact** — not charged to customers
- Charged to platform operations budget
- Included in all plans at no additional cost
- Stored on offsite backup server without consuming customer storage quota

**Purpose:** Compliance, disaster recovery, accidental deletion protection

---

## Tier 2: Admin-Initiated Backups

**Operator-driven captures for pre-change safety, migration support, and bulk pre-upgrade runs.**

### Characteristics

| Dimension | Value |
|---|---|
| Actor | `super_admin` / `admin` |
| Scope | Any single client, or bulk-select N clients |
| Storage | Platform snapshot store (hostpath / S3 / SSH) |
| Quota | Platform-wide budget — does NOT count against client plan quota |
| Retention | Platform-global default (90 days) + per-bundle override |
| Visibility | Admin only — `client` initiator hides this bundle from the client panel |
| Triggers | Manual from admin panel; automatic pre-archive (`system` sub-type); planned: pre-deployment-upgrade, pre-plan-migration |

### Bundle composition

Same four components as Tier 1 (files, mailboxes, config, secrets). Admin can omit a component at backup time (e.g. skip `mailboxes` for a large mail client to save space) but every component omitted reduces restore fidelity — see RESTORE_SPECIFICATION.md.

---

## Tier 3: Client-Initiated Backups

**Self-service captures from the client panel — bound by plan quota, support GDPR Art. 20 data portability.**

### Characteristics

| Dimension | Value |
|---|---|
| Actor | Client user (panel: client-panel) |
| Scope | The client's own data only |
| Storage | Platform snapshot store, plus optional client-supplied S3 or SSH destination (config in client panel Settings → Backups) |
| Quota | **Counts against plan** — `max_backups` (number) and `max_backup_size_gb` (bytes) on hosting plan |
| Retention | Plan-driven default (30 days) + per-bundle override up to the plan's max |
| Visibility | Client-visible (in their panel); admin also sees the metadata |
| Triggers | Manual from client panel (immediate) or scheduled (daily/weekly) |

### Supported backup modes

| Mode | Components included | Use case |
|---|---|---|
| **Full** | files + mailboxes + config + secrets | Default. Full restorable bundle. |
| **Files-only** | files | Cheap, frequent snapshot of the PVC contents. No mail/config capture. |
| **Data export** (GDPR) | files + mailboxes + config (secrets omitted) | Downloadable archive for customer portability. Offered via Settings → Data Export. |

Incremental / differential backup modes are **not** currently supported. See [ADR-028 "Deferred"](../07-reference/ADR-028-backup-architecture.md) — requires block-level capture (Longhorn or CSI snapshots), which will land with the multi-node transition.

### Creation Methods

**Manual (on-demand):**
```
Client Panel: Backups → Create Now
├─ Choose mode (full / files-only / data export)
├─ Optional: custom label
├─ Optional: destination (platform default / client-configured S3 / SSH)
└─ Start
```

**Scheduled:**
```
Client Panel: Backups → Schedule
├─ Frequency: daily / weekly / monthly
├─ Mode: full / files-only
├─ Retention: days, bounded by plan maximum
└─ Enable/disable
```

### Storage & Quota

**Storage location:** Offsite backup server (`customer-backups/` directory)

**Quota impact:**
- **Fully counted** against customer's overall storage limit
- Example: If customer has 100GB quota:
  - 50GB workload files + 20GB databases = 70GB used
  - Available for customer-created backups: 30GB
  - Creating 35GB backup → **QUOTA_EXCEEDED error**

**Quota display in customer panel:**
```
Storage Breakdown (100GB plan):
┌─ Workload Files:     45 GB (45%)
├─ Databases:          20 GB (20%)
├─ Backups (custom):   15 GB (15%)
├─ System/temp:         2 GB (2%)
└─ Available:          18 GB (18%)

Per-Backup Listing:
• backup-2026-03-01-full.tar.gz.enc  [8.2 GB]
• backup-2026-02-28-daily.tar.gz.enc [6.8 GB]
```

### Retention Management

**Customer-defined retention:**

| Retention Period | Use Case | Example |
| --- | --- | --- |
| **7 days** | Testing, quick recovery | Test backup before migration |
| **30 days** | Standard compliance | Default for most customers |
| **90 days** | Extended compliance | PCI-DSS, HIPAA requirements |
| **Custom** | Long-term archive | Never auto-delete, manual only |
| **Never (unlimited)** | Legal holds | Backup kept indefinitely |

**Auto-deletion:**
- Backups older than retention period are deleted automatically
- Notifications sent 7 days before deletion
- No charge for manual deletion before expiry

---

## Backup Destinations (Storage Backends)

All three initiators (system, admin, client) write to the same bundle format on any of three first-class storage backends. Destinations are configured per-initiator or per-client in `platform_settings`. See [BACKUP_COMPONENT_MODEL.md § Storage targets](../06-features/BACKUP_COMPONENT_MODEL.md#storage-targets) for the `BackupStore` interface.

| Backend | Use case | Path shape |
|---|---|---|
| `hostpath` | Single-node dev / single-cluster prod | `${HOSTPATH_ROOT}/<backup-id>/` |
| `s3` | S3-compatible (AWS, MinIO, Wasabi, Backblaze) | `s3://<bucket>/<prefix>/<backup-id>/` |
| `ssh` | Remote server via SSH (replaces the legacy SSHFS-mount approach) | `ssh://<user>@<host>:<path>/<backup-id>/` |

**SSH backend (new).** Uses direct `ssh` + `tar` piping or `sftp` batch mode. No filesystem mount is required — the platform's old SSHFS-based approach is removed. The SSH private key is stored encrypted in `platform_settings` under `storage.backup.ssh_private_key` (AES-256-GCM with `OIDC_ENCRYPTION_KEY`). Upload and download work via short-lived platform Jobs, not a persistent mount.

Each initiator + destination combination is configured separately:

| Initiator | Default destination | Override |
|---|---|---|
| System (Tier 1) | Platform-configured S3 or SSH | `storage.backup.system_default_target` |
| Admin (Tier 2) | Same as system default | Per-run override at API call |
| Client (Tier 3) | Platform-configured hostpath (with quota) | Client can configure their own S3/SSH in client panel Settings → Backups |

### Encryption

The `secrets` component is encrypted at bundle time with `OIDC_ENCRYPTION_KEY` (AES-256-GCM, `k1:` KID prefix for future rotation). Other components rely on transport (S3 SSE, SSH) and filesystem permissions (hostpath 0700) for at-rest confidentiality.

For **customer-downloadable bundles** (GDPR Art. 20 export), the entire bundle is additionally encrypted with a one-time passphrase that the client provides at export request time. Lost passphrases mean lost bundles — the platform stores no copy.

---

## Tier 4: Cluster Disaster Recovery (Velero)

**Not per-client. Operator-facing full-platform DR for rebuilding a cluster from zero.**

Tier 4 runs a fundamentally different pipeline and is **not** accessible through the admin or client panel. It captures:

- Platform PostgreSQL via `pg_dump` (Velero pre-backup hook)
- Stalwart's `data` PVC in the `mail` namespace (Velero restic volume backup)
- Roundcube, Dex, Harbor, cert-manager, Flux state — all k8s resources cluster-wide
- Cluster-level secrets (`OIDC_ENCRYPTION_KEY` in Vault / External Secrets, `JWT_SECRET`, etc.)

Per-client bundles (Tiers 1-3) are sufficient for single-client recovery. Tier 4 is reserved for "the cluster itself is gone" scenarios. See [ADR-028 decision 9](../07-reference/ADR-028-backup-architecture.md).

> **Status:** Tier 4 is future work — Velero integration is not in-tree. For now the operator-facing DR pattern is:
> 1. Snapshot platform-postgres + Stalwart PVC out-of-band
> 2. Per-client bundles cover everything else
> 3. Rebuild the cluster, restore platform-postgres, restore Stalwart, then selectively re-apply tenant bundles

---

## Legacy offsite-backup architecture (deprecated)

The sections below describe a previous architecture that shipped before the
component-oriented model locked in 2026-04-20. They are kept for historical
context while implementation catches up. Treat **[BACKUP_COMPONENT_MODEL.md](../06-features/BACKUP_COMPONENT_MODEL.md)** and this file's Tier 1–4 sections as authoritative.

### Architecture

```
External SFTP/SSH Server (Customer-provided or platform-hosted)
└── mariadb-platform-backups/
    ├── client-acme-corp/
    │   ├── metadata.json                  (system & workload config)
    │   ├── acme-prod-workload/
    │   │   ├── files/
    │   │   │   ├── index.html
    │   │   │   ├── css/
    │   │   │   ├── js/
    │   │   │   └── uploads/
    │   │   └── databases/
    │   │       ├── wordpress_db.sql.gz
    │   │       └── users_db.sql.gz
    │   ├── acme-staging-workload/
    │   │   ├── files/
    │   │   └── databases/
    │   └── backups.tar.gz.enc             (full encrypted archive)
    │
    ├── client-beta-industries/
    │   ├── metadata.json
    │   ├── api-service-workload/
    │   ├── database-workload/
    │   └── backups.tar.gz.enc
    │
    └── ...
```

### Backup Contents per Customer

Each customer folder contains:

#### 1. Metadata File (metadata.json)

```json
{
  "backup_timestamp": "2026-03-03T02:00:00Z",
  "customer": {
    "id": "client-acme-corp",
    "name": "Acme Corporation",
    "plan": "business",
    "region": "us-east-1"
  },
  "workloads": [
    {
      "id": "workload-web-prod",
      "name": "Web Application (Production)",
      "container_image": "php-8.1",
      "container_image_version": "php-8.1:latest",
      "replicas": 3,
      "cpu_request": 1.0,
      "memory_request_mb": 512,
      "environment_variables": {
        "APP_ENV": "production",
        "LOG_LEVEL": "error"
      },
      "volumes": [
        {
          "name": "app-data",
          "mount_path": "/var/www/html",
          "size_gb": 25,
          "used_gb": 12.5
        }
      ]
    }
  ],
  "databases": [
    {
      "id": "db-wordpress",
      "name": "WordPress Database",
      "type": "mariadb",
      "version": "10.6",
      "size_mb": 2048,
      "backup_file": "databases/wordpress_db.sql.gz",
      "tables_count": 42,
      "last_modified": "2026-03-02T18:00:00Z"
    }
  ],
  "domains": [
    {
      "domain_name": "acme.com",
      "status": "active",
      "dns_records_count": 8
    }
  ],
  "settings": {
    "subscription_plan": "business",
    "cpu_quota_cores": 4,
    "memory_quota_gb": 8,
    "storage_quota_gb": 100,
    "backup_retention_days": 30,
    "timezone": "America/New_York",
    "language": "en"
  },
  "rbac_and_users": [
    {
      "email": "admin@acme.com",
      "name": "John Doe",
      "roles": ["client_admin"]
    }
  ],
  "backup_info": {
    "total_size_gb": 45.3,
    "compressed_size_gb": 12.8,
    "encryption": "AES-256-CBC",
    "password_hash": "bcrypt_hash_of_configured_password",
    "checksum_sha256": "abc123...",
    "version": "1.0"
  }
}
```

#### 2. Workload Files (Organized by Workload)

```
acme-prod-workload/files/
├── index.html
├── css/
│   ├── style.css
│   └── responsive.css
├── js/
│   ├── main.js
│   └── utils.js
├── uploads/
│   ├── image-001.jpg
│   └── document-001.pdf
└── config/
    ├── settings.ini
    └── database.yml
```

**Directory structure preserved exactly as deployed in workload.**

#### 3. Database Dumps (if Databases Exist)

```
acme-prod-workload/databases/
├── wordpress_db.sql.gz
├── users_db.sql.gz
└── README.md (schema info)
```

**Each database dumped as:**
- SQL dump file (gzip compressed)
- Full schema + data
- Includes stored procedures, triggers, views
- MariaDB: `mysqldump --single-transaction --routines --triggers`
- PostgreSQL: `pg_dump --include-foreign-keys`

#### 4. Settings & Configuration

All system and user-relevant settings included:

```json
{
  "workload_settings": {
    "autoscaling_enabled": true,
    "min_replicas": 1,
    "max_replicas": 5,
    "health_check_enabled": true,
    "health_check_interval": 30,
    "environment_variables": {...}
  },
  "networking": {
    "domains": ["acme.com", "www.acme.com"],
    "tls_certificates": ["cert_id_123"],
    "ingress_rules": [...]
  },
  "backup": {
    "retention_days": 30,
    "auto_backup_enabled": true,
    "backup_schedule": "0 2 * * *"
  },
  "monitoring": {
    "alerts_enabled": true,
    "alert_email": "admin@acme.com",
    "sla_level": "99.5%"
  }
}
```

### Encryption & Password Protection

#### Encryption Method

**Algorithm:** AES-256-CBC (Advanced Encryption Standard)  
**Key derivation:** PBKDF2 with 10,000 iterations  
**Password format:** Customer-provided or auto-generated  

#### Password Configuration

**Option 1: Customer-Provided Password**
```
UI: Settings → Offsite Backup → Set Encryption Password
├─ Enter password (min 16 characters)
├─ Confirm password
├─ Store securely in Sealed Secrets
└─ Use for all future backups
```

**Option 2: Auto-Generated Password**
```
UI: Settings → Offsite Backup → Generate Secure Password
├─ System generates random 32-char password
├─ Display once (copy to password manager)
├─ Store securely in Sealed Secrets
└─ Use for all future backups
```

#### Creating Encrypted Archive

```bash
#!/bin/bash
# backup-encrypt.sh

CUSTOMER_ID="client-acme-corp"
BACKUP_DIR="/tmp/backups/${CUSTOMER_ID}"
BACKUP_PASSWORD=$(retrieve_from_sealed_secrets $CUSTOMER_ID)
ENCRYPTION_PASSWORD_HASH=$(bcrypt_hash $BACKUP_PASSWORD)

# Create encrypted tar.gz
tar -czf - "${BACKUP_DIR}" | \
  openssl enc -aes-256-cbc \
    -S $(openssl rand -hex 8) \
    -pass pass:"${BACKUP_PASSWORD}" \
    -out "${BACKUP_DIR}.tar.gz.enc"

# Store metadata with password hash
update_metadata "${CUSTOMER_ID}" \
  "encryption_password_hash=${ENCRYPTION_PASSWORD_HASH}"
```

#### Decrypting Archive (Customer Self-Service)

```bash
#!/bin/bash
# restore-decrypt.sh

# Download: backups.tar.gz.enc

# Decrypt
openssl enc -aes-256-cbc -d \
  -in backups.tar.gz.enc \
  -pass pass:"YOUR_PASSWORD" | \
  tar -xz

# Now have full backup structure
ls -la
# metadata.json
# acme-prod-workload/
# acme-staging-workload/
```

### Offsite Sync Schedule

| Component | Frequency | Bandwidth |
| --- | --- | --- |
| **Daily sync** | 2:00 AM UTC | Incremental (only changes) |
| **Weekly verification** | Sunday 3:00 AM UTC | Full checksum verification |
| **Monthly full copy** | 1st of month, 4:00 AM | Ensure consistency |

### Offsite Storage Configuration

#### Option 1: Customer-Provided SFTP/SSH Server

```yaml
Settings:
  Offsite Backup Destination: SFTP
  SFTP Host: backup.example.com
  SFTP Port: 22
  SFTP Username: mariadb_platform_backup
  SFTP Password/Key: Sealed Secrets (not visible)
  SFTP Base Path: /backups/mariadb/
  Encryption Password: Sealed Secrets (not visible)
```

**Benefits:**
- Customer controls backup location
- Full privacy (backups on customer's server)
- No external dependencies

#### Option 2: Platform-Hosted Offsite Server

```yaml
Settings:
  Offsite Backup Destination: Platform offsite server
  Encryption Password: Sealed Secrets (not visible)
```

**Benefits:**
- Simplest setup (platform-managed, no customer config needed)
- Automatic redundancy (offsite server on different provider)
- Easier to manage at scale

### Mount-Based Backup Implementation

```bash
#!/bin/bash
# offsite-backup-mount.sh
# Mounts external backup server via SSHFS, writes backups directly, unmounts when done.
# Backup server is accessed via NetBird WireGuard mesh (not public internet).

set -euo pipefail

OFFSITE_HOST="backup.example.com"  # NetBird mesh hostname/IP
OFFSITE_PATH="/backups"
OFFSITE_USER="backup"
MOUNT_POINT="/mnt/offsite"
DATE=$(date +%Y-%m-%d)
BACKUP_PATH="${MOUNT_POINT}/daily/${DATE}"

# Always unmount on exit (success or failure)
cleanup() {
  echo "[$(date)] Unmounting SSHFS..."
  fusermount -u "${MOUNT_POINT}" 2>/dev/null || true
}
trap cleanup EXIT

# 1. Mount offsite server via SSHFS
echo "[$(date)] Mounting offsite backup server..."
mkdir -p "${MOUNT_POINT}"
sshfs "${OFFSITE_USER}@${OFFSITE_HOST}:${OFFSITE_PATH}" "${MOUNT_POINT}" \
  -o IdentityFile=/tmp/id_rsa \
  -o StrictHostKeyChecking=no \
  -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3

mkdir -p "${BACKUP_PATH}"
echo "[$(date)] ✓ Mounted"

# 2. Get all customers with offsite backup enabled
CUSTOMERS=$(kubectl get configmap backup-config \
  -n platform -o json | \
  jq -r '.data | keys[] | select(. | startswith("client-"))')

for CUSTOMER_ID in $CUSTOMERS; do
  echo "[$(date)] Backing up ${CUSTOMER_ID}..."
  CUST_PATH="${BACKUP_PATH}/${CUSTOMER_ID}"
  mkdir -p "${CUST_PATH}"/{files,databases}
  
  # 2a. Export metadata (direct to mount)
  export_customer_metadata "${CUSTOMER_ID}" > "${CUST_PATH}/metadata.json"
  
  # 2b. Export workload files (direct to mount)
  for WORKLOAD_ID in $(list_customer_workloads "${CUSTOMER_ID}"); do
    export_workload_files "${CUSTOMER_ID}" "${WORKLOAD_ID}" \
      "${CUST_PATH}/files/${WORKLOAD_ID}"
  done
  
  # 2c. Database dumps (direct to mount)
  for DATABASE_ID in $(list_customer_databases "${CUSTOMER_ID}"); do
    export_database_dump "${CUSTOMER_ID}" "${DATABASE_ID}" \
      "${CUST_PATH}/databases/${DATABASE_ID}"
  done
  
  # 3. Encrypt in-place on mount
  ENCRYPTION_PASSWORD=$(get_customer_encryption_password "${CUSTOMER_ID}")
  tar -czf - -C "${CUST_PATH}" . | \
    openssl enc -aes-256-cbc -salt -pbkdf2 \
      -pass pass:"${ENCRYPTION_PASSWORD}" \
      -out "${CUST_PATH}/backup.tar.gz.enc"
  
  echo "  ✓ ${CUSTOMER_ID} backed up and encrypted"
done

# 4. Retention cleanup (on the remote filesystem)
RETENTION_DAYS=${RETENTION_DAYS:-30}
find "${MOUNT_POINT}/daily" -maxdepth 1 -type d \
  -mtime "+${RETENTION_DAYS}" -exec rm -rf {} \; 2>/dev/null || true

echo "[$(date)] ✓ All offsite backups complete (unmount via trap)"
# Unmount happens automatically via trap cleanup
```

---

## Customer-Initiated Export & Migration

### Export Backup (Self-Service)

**UI Path:** Backups → Offsite Backups → Export

```
┌─ Select backup date
├─ Download encrypted archive (backups.tar.gz.enc)
├─ Display password hint / recovery instructions
└─ Email backup access key
```

**Download:**
```bash
# Customer downloads from UI
# File: backups-acme-corp-2026-03-03.tar.gz.enc
# Size: 12.8 GB (compressed)
```

### Manual Migration to External Hosting

**Step 1: Decrypt Archive**

```bash
# Customer has password from backup UI or email
openssl enc -aes-256-cbc -d \
  -in backups-acme-corp-2026-03-03.tar.gz.enc \
  -pass pass:"YOUR_PASSWORD" | \
  tar -xz

# Result: Full directory structure
├── metadata.json                  (all settings)
├── acme-prod-workload/
│   ├── files/                     (all workload files)
│   └── databases/                 (SQL dumps)
└── acme-staging-workload/
    ├── files/
    └── databases/
```

**Step 2: Import to New Hosting**

Customer can now:

**Option A: Manual Setup**
```bash
# 1. Create databases using SQL dumps
mysql -u root -p < acme-prod-workload/databases/wordpress_db.sql

# 2. Restore files to web root
cp -r acme-prod-workload/files/* /var/www/html/

# 3. Review metadata.json for settings
cat metadata.json | jq '.workload_settings'

# 4. Apply configuration settings
# (database connection strings, API keys, etc.)
```

**Option B: Automated Import Script (Future)**

```bash
# Platform provides import script
./mariadb-platform-restore.sh \
  --backup-path ./backups \
  --target-host new-hosting.example.com \
  --target-user root \
  --target-password SECRET \
  --auto-configure true
```

### What Gets Exported (Complete)

✅ **All workload files** - Exact directory structure  
✅ **All databases** - Complete SQL dumps with schema  
✅ **All settings** - Workload config, networking, monitoring  
✅ **All user data** - Uploaded files, media, documents  
✅ **System configuration** - Backup settings, domain config, SSL certs  
✅ **RBAC & users** - User accounts and their roles  
✅ **Metadata** - Timestamps, version info, checksums  

---

## Backup Operations

### Creating Backups via CronJobs

> **Timeout policy:** All backup CronJobs must set `activeDeadlineSeconds: 3600` (1 hour max) to prevent hung SSHFS mounts from blocking indefinitely. A backup verification job runs daily after the backup window and alerts if the latest backup is missing or undersized.

```yaml
# kubernetes/backup-jobs/database-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: mariadb-backup
  namespace: platform
spec:
  schedule: "0 2 * * *"  # 2 AM UTC daily
  jobTemplate:
    spec:
      activeDeadlineSeconds: 3600
      template:
        spec:
          serviceAccountName: backup-sa
          containers:
          - name: backup
            image: mariadb:10.6
            command:
            - /bin/sh
            - -c
            - |
              for DB in $(kubectl get clients -o jsonpath='{.items[*].spec.databases[*]}'); do
                mysqldump -h mariadb.platform.svc \
                  -u backup_user -p$DB_PASSWORD \
                  --single-transaction --routines --triggers \
                  "$DB" | gzip > /backups/$DB-$(date +%Y%m%d).sql.gz
              done
              # Write directly to offsite mount
              rsync --archive /backups/ /mnt/offsite/daily/$(date +%Y-%m-%d)/databases/
          restartPolicy: OnFailure
```

### Restoration Process

**Restore from cluster backup (automatic):**

```
UI: Backups → Restore
├─ Select backup date/time
├─ Choose restore scope (full/database only/files only)
├─ Confirm (WARNING: will overwrite current data)
└─ Monitor restoration progress
```

**Restore from offsite backup (manual):**

```
1. Download encrypted archive from offsite
2. Decrypt locally (using your password)
3. Extract files/database dumps
4. Import databases: mysql < dump.sql
5. Copy files to workload directory
6. Restart workload if needed
```

---

## Disaster Recovery

### RTO & RPO

| Scenario | RTO | RPO | Recovery Method |
| --- | --- | --- | --- |
| **File loss** | < 1 hour | < 24 hours | Restore from cluster backup |
| **Database corruption** | < 2 hours | < 24 hours | Restore from cluster backup |
| **Workload failure** | < 4 hours | < 24 hours | Redeploy from workload definition + restore files/DB |
| **Node failure** | < 10 min | 0 hours | Kubernetes auto-reschedules pods |
| **Cluster failure** | < 1 hour | < 24 hours | Restore from Velero cluster backup |
| **Site-wide failure** | < 6 hours | < 24 hours | Restore from encrypted offsite backup |

### Testing Backups

**Monthly restoration test:**

```bash
#!/bin/bash
# test-backup-restore.sh (run 1st of every month)

# 1. Restore to test cluster
kubectl --context=test-cluster apply -f /backup-restore-manifests/

# 2. Verify data integrity
for CUSTOMER in $(list_all_customers); do
  # Check file count matches
  SOURCE_COUNT=$(find $CUSTOMER -type f | wc -l)
  RESTORED_COUNT=$(find test-cluster/$CUSTOMER -type f | wc -l)
  
  if [ "$SOURCE_COUNT" != "$RESTORED_COUNT" ]; then
    echo "ALERT: File count mismatch for $CUSTOMER"
  fi
done

# 3. Test database imports
for DB_DUMP in /backups/databases/*.sql.gz; do
  if ! gunzip -c "$DB_DUMP" | mysql -u test -p test; then
    echo "ALERT: Database restore failed for $DB_DUMP"
  fi
done

echo "✓ Backup restoration test complete"
```

---

## Monitoring & Alerting

### Backup Metrics

```yaml
# Prometheus metrics
mariadb_backup_duration_seconds
mariadb_backup_size_bytes
mariadb_backup_success{customer_id}
mariadb_backup_compression_ratio
offsite_backup_write_duration_seconds
offsite_backup_write_success
offsite_backup_mount_failures_total
encryption_password_changes_total
```

### Alerts

| Alert | Condition | Action |
| --- | --- | --- |
| **Backup Failed** | Backup job failed for 24h | Page on-call engineer |
| **Offsite Backup Failed** | No successful SSHFS write in 48h | Page ops team |
| **Backup Size Alert** | Backup > 80% of storage quota | Notify customer |
| **Encryption Mismatch** | Backup encryption hash invalid | Page security team |
| **Low Storage** | Backup storage < 10% free | Alert ops team |

---

## Security Considerations

### Encryption Key Management

- **Password storage:** Sealed Secrets (Kubernetes native)
- **Password rotation:** Customer can change anytime
- **Password recovery:** Email recovery code (one-time use)
- **Backup:** Encryption password never logged in plaintext

### Access Control

- **Offsite backup download:** Requires authenticated user
- **Offsite configuration:** Only client admin can change
- **Encryption password:** Only client admin can view/set
- **Audit log:** All backup operations logged

### Compliance

✅ **GDPR:** Data subject access export in standard format  
✅ **PCI-DSS:** Encryption at rest (AES-256)  
✅ **SOC 2:** Backup integrity verification  
✅ **HIPAA:** Encrypted transport + audit logs  

---

## Backup Restore Checklist

### Pre-Restore

- [ ] Verify backup integrity (checksum)
- [ ] Confirm encryption password
- [ ] Check disk space available
- [ ] Document current state (in case of rollback)
- [ ] Notify customer of downtime window

### During Restore

- [ ] Stop active workloads
- [ ] Restore database (if applicable)
- [ ] Restore files (if applicable)
- [ ] Verify file permissions
- [ ] Verify database integrity
- [ ] Update connection strings if needed

### Post-Restore

- [ ] Start workloads
- [ ] Verify health checks passing
- [ ] Test application functionality
- [ ] Confirm user data accessible
- [ ] Document restore completion
- [ ] Notify customer

---

## Troubleshooting

### Backup Encryption Issues

| Problem | Cause | Solution |
| --- | --- | --- |
| "Invalid password" | Wrong password used | Verify password in UI or use recovery code |
| "Corrupted archive" | Incomplete upload | Re-download backup from UI |
| "File not found" | Old backup deleted per retention | Check retention policy, restore older backup |

### Offsite Sync Issues

| Problem | Cause | Solution |
| --- | --- | --- |
| "Connection refused" | SFTP server down | Verify server is reachable, check credentials |
| "Disk quota exceeded" | Offsite storage full | Contact platform ops to increase allocation |
| "Sync timeout" | Network latency | Retry sync, check bandwidth |

### Restoration Issues

| Problem | Cause | Solution |
| --- | --- | --- |
| "Database import failed" | Schema incompatibility | Check database version matches |
| "File permissions error" | UID/GID mismatch | Adjust permissions after restore |
| "Disk space exceeded" | Not enough room for restore | Delete old files, expand storage |

---

## Cost & Billing

### Cluster Backup Costs

| Type | Cost | Included In |
| --- | --- | --- |
| **Automated backups** | Included in plan | All plans |
| **Backup storage (offsite)** | Included in plan | All plans |
| **Retention > 30 days** | +$0.10/GB/month | Premium plans |

### Offsite Backup Costs

| Component | Cost | Notes |
| --- | --- | --- |
| **Encryption/compression** | Included | No additional cost |
| **Offsite storage (customer-provided)** | Customer pays | To their SFTP server |
| **Offsite storage (platform)** | Included | Platform offsite server |
| **Network transfer** | Included | Daily sync included |

---

## Checklist

- [ ] Implement backup directory structure (per-customer folders)
- [ ] Add encryption password configuration in UI
- [ ] Implement offsite backup CronJob (SSHFS mount → write → unmount)
- [ ] Create decryption/export scripts for customers
- [ ] Add metadata.json export for all settings
- [ ] Document database dump procedures
- [ ] Set up offsite backup server (SSH access via NetBird mesh, SSHFS mount target)
- [ ] Create migration guide for customers
- [ ] Set up monitoring & alerting
- [ ] Test monthly backup restoration
- [ ] Document disaster recovery procedure
- [ ] Train support team on backup operations

---

## References

- DATABASE_SCHEMA.md - Database backup structure
- DISASTER_RECOVERY.md - Full disaster recovery plan
- COMPLIANCE_MATRIX.md - Regulatory requirements
- DEPENDENCIES_AND_RISKS.md - Backup system risks
- OpenSSL encryption documentation: https://www.openssl.org/
- rsync over SSH: https://linux.die.net/man/1/rsync
- Velero documentation: https://velero.io/
