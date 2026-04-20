# Storage & Databases

## Overview

This document covers database strategy, caching layer, persistent storage, and backup systems that support client workloads across all hosting plans.

## Database Strategy — Dedicated Per-Client (ADR-024)

**Design Principle:** Every client gets their own dedicated database instance in their `client-{id}` namespace. Database is a **premium add-on** — not included in base plans. This aligns with the dedicated-pod-per-client model where all isolation is at the namespace level.

### Database Provisioning

When the database add-on is enabled for a client:

1. A dedicated MariaDB StatefulSet is provisioned in the client's namespace
2. Auto-generated credentials stored as a Kubernetes Secret in the same namespace
3. The client's application pod connects via in-namespace service DNS (`mariadb.client-{id}.svc.cluster.local:3306`)
4. NetworkPolicy already restricts traffic to the namespace — no cross-client access possible

| Parameter | Value |
| --- | --- |
| Deployment | MariaDB StatefulSet in `client-{id}` namespace |
| Image | MariaDB 10.6 (platform-managed catalog image) |
| Per-client isolation | Full namespace isolation — dedicated instance, not shared |
| Credentials | Auto-generated, stored in namespace Secret |
| Connection | In-namespace ClusterIP service |
| Default resources | 0.25 vCPU, 512Mi RAM (configurable per plan) |
| Storage | 5Gi PVC default (configurable per plan) |

### PostgreSQL Support (Phase 2)

PostgreSQL 16 will be available as an alternative database type in Phase 2, using the same dedicated-per-client model.

### Database as Add-On

| Plan | Database Included | Add-On Available |
| --- | --- | --- |
| Starter | No | Yes (1 database) |
| Business | No | Yes (up to 3 databases) |
| Premium | Yes (1 included) | Yes (up to 10 databases) |

## Caching Layer — Shared Redis

| Parameter | Initial | HA Upgrade (Optional) |
| --- | --- | --- |
| Deployment | **1 Redis instance** in `platform` namespace | Redis Sentinel or Redis Cluster |
| Resource allocation | 0.5 vCPU, 512Mi-1Gi RAM | 1 vCPU, 1-2Gi RAM |
| Per-client isolation | Redis ACLs: each client gets a dedicated user with key prefix restriction (`client-{id}:~*`) | Same |
| Eviction policy | `allkeys-lru` — graceful degradation via cache misses | Same |
| `maxmemory` | Set to 80% of pod memory limit | Same |
| Use cases | WordPress object cache, PHP sessions, app cache | Same |

## Persistent Storage

| Storage Type | Technology | Notes |
| --- | --- | --- |
| Block storage (PVs) | Local path provisioner or Longhorn | Client site files |
| Media/branding storage | Longhorn PV | Logos, favicons, branding assets |
| Shared filesystem | NFS (for SFTP gateway access to PVs) | SFTP needs to mount client PVs |

## Data Backup Strategy

> **Authoritative backup docs:**
> - [../06-features/BACKUP_COMPONENT_MODEL.md](../06-features/BACKUP_COMPONENT_MODEL.md) — bundle format
> - [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md) — tiered initiators, destinations
> - [../07-reference/ADR-028-backup-architecture.md](../07-reference/ADR-028-backup-architecture.md) — architectural decisions
>
> The table below is a quick reference. Where it conflicts with the docs above, those take precedence.

### System-Initiated Backups (Tier 1 — Platform responsibility)

Automated daily captures of all client data, included in all plans, not counted against customer quota.

| Parameter | Value |
|---|---|
| Capture frequency (files component) | Daily (PVC tar — includes DB datadirs, no separate mysqldump) |
| Capture frequency (mailboxes component) | Daily (per-mailbox Stalwart CLI export) |
| Capture frequency (config + secrets components) | Daily (inline in backend) |
| Cluster DR (Tier 4) | Velero (future) — separate from per-tenant pipeline |
| Retention period | Configurable per plan (global default + per-client override) |
| Capture tool (files) | Short-lived Kubernetes Job — `tar cf - . \| gzip > archive.tar.gz` + `tree.jsonl.gz` sidecar |
| Capture tool (mailboxes) | Job running `stalwart-cli account export` per mailbox |
| Storage backend | One of `hostpath`, `s3`, `ssh` (all mandatory, operator-configured) |
| Encryption | `secrets` component AES-256-GCM with `OIDC_ENCRYPTION_KEY` (`k1:` KID prefix). Other components rely on backend transport (S3 SSE, SSH) + filesystem permissions (hostpath `0700`). |

### Customer-Created Independent Backups

| Parameter | Value |
| --- | --- |
| Backup creation | Manual triggers OR customer-defined schedules |
| Retention | Customer-configured (7 / 14 / 30 / 90 / 365+ days) |
| Quota impact | **Fully counted** against customer's overall storage limit |

### Offsite Backup — Mount-Based Direct Write

All cluster-managed backups are written directly to an external backup server mounted via SSHFS.

| Parameter | Value |
| --- | --- |
| Offsite transport | **SSHFS** (SSH filesystem mount) |
| Mount schedule | Mount at backup window (2 AM UTC), unmount when done |
| Authentication | SSH key-based (Sealed Secret) |
| Verification | SHA-256 checksum per archive |

## Per-Plan Storage & Database Allocations

### Starter Plan
- No database included (available as add-on)
- Shared Redis (with per-client ACL/key prefix)
- 7-day backup retention

### Business Plan
- No database included (up to 3 as add-on)
- Shared Redis
- 14-day backup retention

### Premium Plan
- 1 dedicated MariaDB included
- Shared Redis
- 30-day backup retention
- Up to 10 databases total

## Related Documentation

- **INFRASTRUCTURE_SIZING.md**: Resource allocation and sizing by plan
- **BACKUP_STRATEGY.md**: Detailed backup procedures and recovery
- **HOSTING_PLANS.md**: Plan definitions and storage quotas
