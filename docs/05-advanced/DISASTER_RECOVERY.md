# Disaster Recovery & High Availability

> **Related HA/DR documentation:**
> - [../02-operations/CLUSTER_MAINTENANCE_AND_UPGRADES.md](../02-operations/CLUSTER_MAINTENANCE_AND_UPGRADES.md) — Cluster maintenance procedures
> - [../02-operations/HA_MIGRATION_RUNBOOK.md](../02-operations/HA_MIGRATION_RUNBOOK.md) — HA migration runbook
> - [../02-operations/BACKUP_STRATEGY.md](../02-operations/BACKUP_STRATEGY.md) — Backup strategy (required for DR)
> - [../04-deployment/INCIDENT_RESPONSE_RUNBOOK.md](../04-deployment/INCIDENT_RESPONSE_RUNBOOK.md) — Incident response procedures

## Overview

**Design Principle:** All HA features are **optional upgrades**. The initial deployment runs on minimal infrastructure with single instances. HA is enabled incrementally as the business grows, budget allows, or uptime requirements demand it. **Backups are always required** regardless of HA level.

## Availability Targets

| Parameter | Initial (No HA) | With HA Enabled |
| --- | --- | --- |
| Recovery Time Objective (RTO) | < 4 hours (manual restore) | < 30 minutes (automatic failover) |
| Recovery Point Objective (RPO) | < 24 hours (daily backups) | < 1 hour (replication + backups) |
| Target availability | ~99.5% (allows for maintenance windows) | 99.9%+ |

## High Availability Strategy — All Optional

Every HA feature below is an **opt-in upgrade**. The "Initial" column shows what ships on day one; the "HA Upgrade" column shows what can be enabled later.

| HA Feature | Initial (Day 1) | HA Upgrade (Optional) | Trigger to Enable |
| --- | --- | --- | --- |
| **Control plane** | 1 node | 3 nodes (etcd quorum) | When unplanned CP downtime is unacceptable |
| **Worker nodes** | 1-2 nodes | 3+ nodes (N+1 redundancy) | When single-node capacity is exceeded |
| **Shared MariaDB** | 1 instance (no replica) | Primary + replica (auto-failover) | When DB downtime risk is too high |
| **Shared PostgreSQL** | 1 instance (no replica) | Primary + replica (auto-failover) | Same as MariaDB |
| **Shared Redis** | 1 instance | Redis Sentinel (auto-failover) | When cache downtime affects clients |
| **Ingress controller** | DaemonSet (1 per worker, auto) | Scales automatically with workers | Automatic — DaemonSet adds pod per new worker |
| **Client web pods** | 1 dedicated pod per client | Spread across nodes via anti-affinity | Automatic with node scaling |
| **Storage (Longhorn)** | Replication factor 1 | Replication factor 2-3 | When adding storage capacity |
| **Pod disruption budgets** | None | Set for platform services (min 1 avail) | When running multi-node |
| **Anti-affinity rules** | None | Spread platform services across nodes | When running 3+ nodes |
| **Multi-region / multi-cluster** | No | Active-passive or active-active | At enterprise scale or compliance req |

> **The only non-optional requirement is backups.** Even on the minimal deployment, daily backups to the offsite server must be running. Everything else is an upgrade.

### Single-Node Reality Check (Phase 1)

On a single-node k3s cluster, **there is no automatic failover**. If admin1 dies:

| Scenario | Actual RTO | Actual RPO | Recovery Path |
|----------|-----------|-----------|---------------|
| **Node unresponsive (reboot fixes)** | 5-15 min | 0 | Reboot via Hetzner Cloud Console |
| **OS/kernel issue (rescue mode)** | 30-60 min | 0 | Boot rescue, fix filesystem, reboot |
| **Disk corruption** | 4-8 hours | Up to 24h | Re-image server, run Ansible, restore from backup |
| **Hardware failure** | 4-8 hours | Up to 24h | Provision new CX32, run Ansible, restore from backup |
| **Bad k3s upgrade** | 15-30 min | 0 | Restore from Hetzner server snapshot (take before every upgrade) |

**Mitigation for Phase 1:**
1. **Take a Hetzner server snapshot before every upgrade or major change** — fastest rollback path (5-10 min restore)
2. **Test backup restoration before accepting any paying customer** — untested backups are not backups
3. **Schedule a timed DR drill quarterly** — spin up a throwaway CX32, restore everything, verify all services, time the process, tear down
4. **Accept the SLA** — ~99.5% availability means ~4 hours downtime/month is within target; communicate maintenance windows to customers
5. **Ensure offsite backups run daily and are verified** — `Restore Tested: Yes` for every backup category before go-live

**What is lost during a full restore:**
- In-flight Postfix email queue (undelivered emails)
- Data written since the last backup (up to 24 hours)
- Active user sessions (all users must re-authenticate)
- Prometheus/Loki metrics from the last retention period

## Backup & Restore Strategy

### What Gets Backed Up

| Component | Backup Method | Offsite (SSHFS mount) | Restore Tested? |
| --- | --- | --- | --- |
| Kubernetes state | Velero (etcd + resource snapshots) | Daily (direct write) | No |
| Shared MariaDB | mysqldump per client DB | Daily (direct write) | No |
| Shared PostgreSQL | pg_dump per client DB | Daily (direct write) | No |
| Client site files | rsync --archive (plain filesystem) | Daily (direct write) | No |
| Platform secrets | Sealed Secrets in Git | On change (direct write) | No |
| DNS zone data | Zone file export | Daily (direct write) | No |
| Email data | Docker-Mailserver volume backup | Daily (direct write) | No |
| App password DB | Included in shared DB dump | Daily (direct write) | No |
| Roundcube DB | Included in shared DB dump | Daily (direct write) | No |
| Catalog images | Stored in Harbor | Daily (direct write) | No |

All backups are written directly to the **external backup server** via SSHFS mount during the daily backup window (mount on demand, unmount when done — zero local disk consumed). Customer-created backups are stored on the offsite server (`customer-backups/` directory).

## Failover Procedures

Procedures differ based on whether HA is enabled.

| Scenario | Without HA (Initial) | With HA Enabled | Runbook Status |
| --- | --- | --- | --- |
| **Worker node failure** | Manual: restart node or rebuild + restore from backup | Automatic: K8s reschedules pods to healthy nodes | See CLUSTER_MAINTENANCE_AND_UPGRADES.md |
| **Control plane failure** | Manual: restart node or rebuild cluster from backup | Automatic: etcd quorum maintains cluster | See CLUSTER_MAINTENANCE_AND_UPGRADES.md |
| **Full cluster failure** | Rebuild cluster + restore from Velero backup | Same (but less likely with HA) | See CLUSTER_MAINTENANCE_AND_UPGRADES.md Part 5 |
| **Shared DB failure** | Manual: restart pod, restore from backup if corrupt | Automatic: replica promotes to primary | See DATABASE_ACCESS_CONTROL.md |
| **Worker node disk full** | Manual: purge old data or expand storage | Automatic: Longhorn rebalances data | See INFRASTRUCTURE_SIZING.md |
| **Ingress controller down** | Manual: restart pod, traffic briefly interrupted | Automatic: DNS removes dead worker IP; other DaemonSet instances handle traffic | See CLUSTER_MAINTENANCE_AND_UPGRADES.md |
| **Network partition** | Manual: isolate affected node, investigate network | Automatic: Kubernetes detects and handles | See CLUSTER_MAINTENANCE_AND_UPGRADES.md |

---

## Planned Maintenance Procedures

For scheduled maintenance (OS upgrades, k3s updates, security patches), see [`../02-operations/CLUSTER_MAINTENANCE_AND_UPGRADES.md`](../02-operations/CLUSTER_MAINTENANCE_AND_UPGRADES.md) which includes:

- **k3s version upgrades** — patch, minor, major version upgrades
- **Control plane OS upgrades** — when Debian EOL approaches
- **Worker node rolling upgrades** — zero-downtime procedures
- **Security patching** — critical, high, medium, low priority patches
- **Backup & restore** — full cluster state backup/restoration
- **Upgrade testing** — staging cluster validation before production
- **Failure scenarios** — recovery procedures for common issues
- **Operational runbooks** — step-by-step procedures for each scenario

## Disaster Recovery Procedures

### Scenario: Full Cluster Failure

If the cluster becomes unrecoverable:

1. **Stand up new cluster** with same Kubernetes version (k3s same release)
2. **Install platform services** (Flux, cert-manager, monitoring, etc.) — use same manifests as original
3. **Restore Velero snapshot** from offsite backup
4. **Verify all namespaces present** (kubectl get ns)
5. **Verify all PVCs restored** (kubectl get pvc -A)
6. **Verify all deployments healthy** (kubectl get deploy -A)
7. **Restore DNS zones** (if not synced already)
8. **Update external DNS** (if platform instance moved to new IP)
9. **Verify email queue** (Docker-Mailserver recovering)
10. **Resume operations** — clients can log in and manage their sites
11. **Run sanity checks** — test SFTP, web access, email delivery
12. **Post-mortem** — analyze failure, document lessons learned

### Scenario: Shared Database Failure

If shared MariaDB or PostgreSQL becomes corrupt:

**Without HA:**
1. **Stop client workloads** (prevent writes during recovery)
2. **Restore from latest backup** (mysqldump or pg_dump)
3. **Verify data integrity** (spot-check client databases)
4. **Resume operations** — downtime: 30-60 minutes

**With HA:**
1. **Automatic failover** — replica promotes to primary (< 5 seconds)
2. **Minimal downtime** — connections briefly interrupted
3. **No manual intervention** — operator notified, can investigate later
4. **Data protected** — replication ensures no data loss

### Scenario: Node Failure

If a worker node becomes unavailable:

**Without HA:**
1. **Detect failure** — Kubernetes marks node NotReady
2. **Manual remediation** — restart node or rebuild
3. **Pods evicted manually** or wait for timeout (5 minutes default)
4. **Downtime for affected pods** — clients experience brief interruption

**With HA:**
1. **Automatic detection** — Kubernetes detects node failure
2. **Pod rescheduling** — pods automatically moved to healthy nodes
3. **No manual intervention** — Kubernetes handles automatically
4. **Minimal client impact** — mostly transparent

## Regional Failover (Multi-Region Setup)

For enterprise deployments requiring geographic redundancy:

### Active-Passive Failover

- **Primary cluster** in primary region (active)
- **Standby cluster** in secondary region (idle, synced daily)
- **Manual activation** of standby cluster in disaster
- **DNS update** to point to standby cluster

### Active-Active Failover

- **Multiple clusters** in different regions
- **Load balancer** distributes traffic across clusters
- **Data replication** between clusters (complex setup)
- **Automatic failover** if cluster becomes unhealthy
- **Eventual consistency** for data across regions

**Note:** Multi-region setup deferred to Phase 2 — evaluate based on customer demand and SLA requirements.

## Testing & Validation

### Regular Restore Testing

- **Monthly:** Test restore of 10 random customer backups to verify integrity
- **Quarterly:** Full cluster restore test to new environment
- **On-demand:** Customer can request restore test (with warning)

### Failover Testing

- **Semi-annual:** Test failover procedures in staging environment
- **Document runbooks:** Step-by-step procedures for each failure scenario
- **Update runbooks:** Based on lessons learned from tests

### Monitoring & Alerting

**What's monitored for disaster recovery:**

| Metric | Alert Threshold |
| --- | --- |
| **Last successful backup** | Alert if > 26 hours since backup |
| **Offsite backup success** | Alert immediately if SSHFS mount or offsite write fails |
| **Database replication lag** | Alert if lag > 5 minutes (with HA enabled) |
| **Cluster health** | Alert if node NotReady for > 5 minutes |
| **Storage utilization** | Alert if local storage > 85% (backup may fail) |
| **Backup corruption** | Alert if integrity check fails (SHA-256 mismatch) |

## Runbooks (To Document)

Create detailed runbooks for each failure scenario. Example structure:

```
# Runbook: Full Cluster Failure Recovery

## Prerequisites
- Access to offsite backup server
- New cluster provisioned (or access to cloud provider console)
- Git repository with original manifests

## Recovery Steps
1. Identify point of failure
2. [steps 2-N]
...
## Rollback
If recovery unsuccessful, rollback to [procedure]

## Verification Checklist
- [ ] DNS points to new cluster
- [ ] Client panel accessible
- [ ] Backups running
- ...
```

## Cost of HA

### Initial Deployment (No HA): ~$35-60/month

| Component | Cost |
| --- | --- |
| 1 control plane (2vCPU/4Gi) | $8-12 |
| 1 worker (4vCPU/8Gi) | $12-18 |
| Storage (200Gi) | $5-10 |
| Backup storage (100Gi) | $3-5 |
| Bandwidth | $5-10 |

### HA Deployment: ~$90-140/month

| Component | Cost |
| --- | --- |
| 3 control planes (2vCPU/4Gi each) | $24-36 |
| 3 workers (8vCPU/16Gi each) | $36-54 |
| Storage (500Gi, replicated) | $10-15 |
| Backup storage (200Gi) | $6-10 |
| Bandwidth | $10-20 |

> **Recommendation:** Start with minimal deployment, enable HA when business scale justifies the cost (~$50-100/month incremental).

## Related Documentation

- **BACKUP_STRATEGY.md**: Detailed backup procedures and granular restore
- **INFRASTRUCTURE_SIZING.md**: HA upgrade options and when to enable
- **STORAGE_DATABASES.md**: Database replication and failover configuration
- **MONITORING_OBSERVABILITY.md**: Monitoring failover and recovery procedures
- **SECURITY_ARCHITECTURE.md**: Securing backups and disaster recovery
