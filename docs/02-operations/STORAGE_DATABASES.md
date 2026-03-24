# Storage & Databases

## Overview

This document covers database strategy, caching layer, persistent storage, and backup systems that support client workloads across all hosting plans.

## Database Strategy — Shared Instances

**Design Principle:** Shared database instances with per-client databases, reducing pod count by ~200-400 and saving significant resources while maintaining isolation at the database and user level.

### Shared MariaDB

| Parameter | Initial (No HA) | HA Upgrade (Optional) |
| --- | --- | --- |
| Deployment | **1 single instance** in `platform` namespace | 1 primary + 1 replica |
| Operator | **Percona Operator for MariaDB** (production-grade, widely used) | Same operator, enable replication |
| Per-client isolation | Separate database + dedicated MariaDB user per client | Same |
| Client credentials | Auto-generated, stored in client namespace Secret | Same |
| Connection | ClusterIP service; client pods connect via service DNS | Same (failover handled by operator) |
| Resource allocation | 1-2 vCPU, 2-4Gi RAM | 2-4 vCPU, 4-8Gi RAM per instance |
| Storage | 50-100Gi PV | 100-200Gi PV (Longhorn replicated) |
| Max connections | **Configure after load testing** (empirical approach) | Same; determine from actual usage patterns |

### Shared PostgreSQL

| Parameter | Initial (No HA) | HA Upgrade (Optional) |
| --- | --- | --- |
| Deployment | **1 single instance** in `platform` namespace | 1 primary + 1 replica |
| Operator | **CloudNativePG** (cloud-native design, excellent HA features) | Same operator, enable replication |
| Per-client isolation | Separate database + dedicated PG role per client | Same |
| Client credentials | Auto-generated, stored in client namespace Secret | Same |
| Connection | **Always connect via the CloudNativePG read-write service** (`postgresql-cluster-rw.platform.svc.cluster.local`) — never by pod IP or individual pod DNS. CloudNativePG updates this service endpoint automatically on failover; pods connecting this way reconnect transparently. | Same — service endpoint is updated by operator on replica promotion |
| Resource allocation | 1-2 vCPU, 2-4Gi RAM | 2-4 vCPU, 4-8Gi RAM per instance |
| Storage | 50-100Gi PV | 100-200Gi PV (Longhorn replicated) |

> **Connection string requirement:** All platform services and client pods connecting to PostgreSQL **must** use the CloudNativePG read-write service DNS name (`postgresql-cluster-rw.platform.svc.cluster.local:5432`), not a pod IP or individual pod hostname. During a failover CloudNativePG promotes a replica and updates the `-rw` service endpoint within seconds; applications using the service DNS name reconnect automatically on their next connection attempt without configuration changes.

### Client-Side Database Access

**NetworkPolicy** explicitly allows client pods to reach the shared DB services in the `platform` namespace on the MariaDB/PG ports only. This provides strong network isolation while allowing necessary database access.

### Upgrade Path to Dedicated DB

For Premium/Custom plan clients who need dedicated databases:

1. Provision a dedicated MariaDB/PG StatefulSet in their client namespace
2. Migrate their data from the shared instance
3. Update their pod's DB connection config

This allows starting cheap and upgrading per-client as needed.

## Caching Layer — Shared Redis

| Parameter | Initial | HA Upgrade (Optional) |
| --- | --- | --- |
| Deployment | **1 Redis instance** in `platform` namespace | Redis Sentinel or Redis Cluster |
| Resource allocation | 0.5 vCPU, 512Mi-1Gi RAM | 1 vCPU, 1-2Gi RAM |
| Per-client isolation | Redis ACLs: each client gets a dedicated user with key prefix restriction (`client-{id}:~*`) | Same |
| Memory quota per client | No hard per-prefix limit (Redis does not support native per-prefix quotas). Soft enforcement via Prometheus alerting: alert fires when any client prefix key count exceeds a configurable threshold (default: 10,000 keys). Admin investigates and contacts client if persistent. | Same |
| Eviction policy | `allkeys-lru` — when Redis hits `maxmemory`, least-recently-used keys across all prefixes are evicted first. This provides graceful degradation (cache misses) rather than OOM crashes. | Same |
| `maxmemory` | Set to 80% of the pod's memory limit (e.g., 410Mi for a 512Mi pod). **Must be configured explicitly** — Redis does not limit itself by default and will OOM the pod without this setting. | Same |
| `maxmemory-policy` | `allkeys-lru` | Same |
| Use cases | WordPress object cache, PHP sessions, app cache | Same |
| Premium plan | Dedicated Redis pod in client namespace (256Mi) | Same |

## Persistent Storage

| Storage Type | Technology | Notes |
| --- | --- | --- |
| Block storage (PVs) | Local path provisioner or Longhorn | Client site files |
| Media/branding storage | Longhorn PV (local persistent volume) | Logos, favicons, branding assets |
| Shared filesystem | NFS (for SFTP gateway access to PVs) | SFTP needs to mount client PVs |

**Longhorn** is recommended as the storage backend for self-managed K8s — it provides:
- Replicated block storage
- Snapshots
- Backup-to-S3 capability
- No external dependencies

## Data Backup Strategy

### Cluster-Managed Backups (Platform Responsibility)

Automated daily backups of all client data, included in all plans.

| Parameter | Value |
| --- | --- |
| Backup frequency (DB) | Daily automated (full dump per client DB from shared instance) |
| Backup frequency (files) | Daily incremental |
| Backup frequency (K8s state) | Daily (Velero snapshots) |
| Retention period | Configurable per plan (global default, per-client override) |
| Backup tool (K8s state) | Velero |
| Backup tool (DB) | CronJob: mysqldump / pg_dump → offsite server (SSHFS mount) |
| Backup tool (files) | rsync --archive → offsite server (SSHFS mount) |
| Backup encryption | **Optional** — AES-256-CBC if an encryption password is set in Admin Panel → Backup Settings. If no password is set, backups are written unencrypted (plain filesystem). Database dumps and site files follow the same setting. |
| Backup archive format | **Configurable** per-customer in Admin Panel: `tar` (uncompressed), `tar.gz` (gzip-compressed), or `zip`. Default: `tar.gz`. |
| Backup storage | Offsite backup server (SSHFS mount via SSH — see transport options below) |
| Cost model | Platform-managed (not charged to customers, included in all plans) |

### Customer-Created Independent Backups

Optional additional backups created by customers for compliance or custom retention.

| Parameter | Value |
| --- | --- |
| Backup creation | Manual triggers OR customer-defined schedules (hourly/daily/weekly/monthly) |
| Backup types supported | Full / Incremental / Differential |
| Backup tool | On-demand CronJob: mysqldump / pg_dump / file snapshots |
| Retention | Customer-configured (7 / 14 / 30 / 90 / 365+ days) |
| Backup storage | Offsite server (`customer-backups/` directory) — within customer's disk quota |
| Quota impact | **Fully counted** against customer's overall storage limit |
| Cost model | Included in storage tier (customer pays for quota they use) |
| Use cases | Before major updates, before migrations, compliance requirements, custom retention |

### Offsite Backup — Mount-Based Direct Write

All **cluster-managed backups** are written directly to an **external backup server** mounted via SSHFS during the backup window. This avoids storing a second copy locally, conserving cluster disk space.

**Note:** Customer-created backups are stored on the offsite backup server (`customer-backups/` directory) within customer quota. Customers can request backup exports for external archival.

| Parameter | Value |
| --- | --- |
| Offsite transport | **SSHFS** (SSH filesystem mount over plain SSH — see transport options below) |
| Offsite destination | External server (different provider / location). Hetzner StorageBox and any SSH-accessible server are supported. |
| Mount schedule | Mount at start of backup window (2 AM UTC), unmount when done |
| What gets written | DB dumps, file archives, Velero snapshots, DNS zones, email data — directly to mount |
| Mount method | CronJob: `sshfs` mount via FUSE device plugin → backup scripts write to mount path → `fusermount -u` unmount |
| Authentication | SSH key-based (no passwords). Dedicated keypair per platform instance, stored as Sealed Secret. |
| Encryption in transit | SSH transport encrypts data in transit regardless of backup encryption setting |
| Encryption at rest | Optional — AES-256-CBC applied if encryption password configured in Admin Panel |
| Archive format | `tar`, `tar.gz`, or `zip` — configurable per customer |
| Retention (offsite) | Mirror per-plan retention policy per client |
| Local disk impact | **Near zero** — no local backup copy stored; only temporary working files during backup |
| Verification | SHA-256 checksum written alongside each backup archive |
| Alert on failure | Alertmanager notification if mount fails or backup write fails |

### Offsite Backup Transport

The backup server is accessed via **plain SSH** (SSHFS). The backup server does **not** need to be on the NetBird WireGuard mesh — it connects over public SSH using a dedicated keypair. This makes Hetzner StorageBox, Backblaze B2 SFTP, rsync.net, and any standard SSH server directly compatible.

| Transport option | NetBird mesh required | Notes |
|---|---|---|
| **SSH direct (public internet)** | No | Default. Works with Hetzner StorageBox. SSH encrypts data in transit. Public SSH port (22 or custom) must be open on backup server. |
| **SSH via NetBird mesh** | Yes (backup server must run NetBird agent) | Use if backup server is a self-managed VPS already in the mesh. Avoids exposing SSH on the public internet. |

**Hetzner StorageBox configuration:**

```bash
# StorageBox SSH access uses a sub-account with SFTP/SSH enabled
# Host: <your-id>.your-storagebox.de  Port: 23  User: <your-id>

# Generate a dedicated keypair for the backup service
ssh-keygen -t ed25519 -f backup_storagebox_key -C "platform-backup"

# Install public key on StorageBox (via Hetzner Robot panel or SSH)
ssh -p 23 <your-id>@<your-id>.your-storagebox.de \
  "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys" < backup_storagebox_key.pub

# Store private key as Sealed Secret in the cluster
kubectl create secret generic backup-ssh-key \
  --from-file=id_ed25519=backup_storagebox_key \
  --dry-run=client -o yaml | kubeseal > backup-ssh-key-sealed.yaml
kubectl apply -f backup-ssh-key-sealed.yaml

# SSHFS mount command used by CronJob
sshfs <your-id>@<your-id>.your-storagebox.de:/backups /mnt/offsite \
  -p 23 \
  -o IdentityFile=/secrets/backup-ssh-key/id_ed25519 \
  -o StrictHostKeyChecking=no \
  -o ServerAliveInterval=15 \
  -o reconnect
```

**Admin configuration:** Admin Panel → Settings → Backup → Offsite Server. Fields: hostname, port, username, SSH private key (paste or upload), remote base path, encryption password (optional), archive format (`tar` / `tar.gz` / `zip`). All stored as Sealed Secrets. The backup CronJob reads these at runtime from the mounted Secret.

## Backup Storage Quota & Accounting

Customer-created backups consume space within each customer's **overall disk quota**. This ensures backup storage doesn't consume unlimited platform resources and encourages customers to manage retention policies.

### Storage Accounting Model

| Backup Type | Storage Count | Cost Model |
| --- | --- | --- |
| **Cluster-managed backups** | NO | Free to customers; charged to platform operations |
| **Customer-created backups** | **YES** | Fully counted toward customer storage quota |

### Quota Tracking & Display

**In Customer Panel:**
- Storage usage breakdown: "Site files: 25GB, Databases: 10GB, Customer backups: 15GB (of 100GB total)"
- Per-backup size visible in backup list: "Backup from 2026-02-27: 8.5GB"
- Warnings: "You are using 87% of storage. Customer backups consume 15GB."
- Warning threshold: Alert when customer backups exceed 50% of remaining available quota

**In Admin Panel:**
- Bulk storage quota updates: "Add 50GB storage to 100 Starter plan clients"
- Per-client breakdown: "Client ABC using 95GB (94 MB in backups), 2 backups total"
- Storage trend chart: Shows growth of backup storage vs site files month-over-month

### Quota Enforcement

| Scenario | Behavior |
| --- | --- |
| Customer at quota | Cannot create new backups; must delete old backups or upgrade plan |
| Customer approaching quota (90%+) | Alert in panel: "Limited backup storage remaining" |
| Backup would exceed quota | Backup creation fails; error message: "Backup would exceed storage limit. Delete backups or upgrade plan." |
| Manual backup trigger | Check quota **before** creating backup; fail gracefully if insufficient space |
| Scheduled backup trigger | Skip backup if quota exceeded; log error and send customer alert |

### Retention & Cleanup

| Action | Details |
| --- | --- |
| **Automatic cleanup** | Retention cleanup script (`find` + `rm`) auto-deletes expired customer backups per retention setting (customer-configurable) |
| **Manual deletion** | Customers can manually delete backups to free quota space |
| **Bulk cleanup** | Admin can force-delete old customer backups (with warning) to reclaim space |
| **Billing notification** | If customer deletes backups to avoid quota overages, no refund (backup consumption was during paid period) |

### Upgrade Path

If customer exceeds quota with backups:

1. Customer receives alert: "Storage quota exceeded. Upgrade your plan to continue creating backups."
2. Customer can upgrade: Starter → Business (e.g., 100GB → 500GB)
3. New quota applied immediately; customer can resume backups
4. Billing prorated if upgrade happens mid-cycle

## Storage Cost Optimization

| Strategy | Impact |
| --- | --- |
| Shared DB storage vs. per-client PVs | ~200 fewer PVs, ~90% less DB storage overhead |
| Longhorn thin provisioning | Storage allocated on write, not on claim |
| Retention cleanup script (`find` + `rm`) | Auto-delete old backups per client retention setting |
| Compress backups (gzip/zstd) | 50-80% backup size reduction |
| rsync --archive with hardlinks | Incremental = unchanged files linked, not copied |
| Offsite SFTP retention mirroring | Offsite mirrors local retention — no excess storage cost |

## Per-Plan Database Allocations

### Starter Plan
- Shared MariaDB instance
- Shared PostgreSQL instance
- Shared Redis (with per-client ACL/key prefix)
- 7-day backup retention (cluster-managed)

### Business Plan
- Shared MariaDB instance
- Shared PostgreSQL instance
- Shared Redis (with per-client ACL/key prefix)
- 14-day backup retention (cluster-managed)
- Optional: Dedicated database upgrade available

### Premium Plan
- Shared MariaDB instance (default)
- Shared PostgreSQL instance (default)
- Dedicated Redis pod (256Mi) in client namespace
- 30-day backup retention (cluster-managed)
- Optional: Dedicated MariaDB/PostgreSQL instance

### Custom Plan
- Any combination of shared/dedicated databases
- Customizable retention periods
- Advanced backup features per agreement

## Related Documentation

- **INFRASTRUCTURE_SIZING.md**: Resource allocation and sizing by plan
- **BACKUP_STRATEGY.md**: Detailed backup procedures and recovery
- **HOSTING_PLANS.md**: Plan definitions and storage quotas
- **MONITORING_OBSERVABILITY.md**: Monitoring backup health and storage usage
- **DISASTER_RECOVERY.md**: Disaster recovery procedures and failover strategies
