# Multi-Region Administration & Customer Co-hosting Architecture

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** FINAL — Ready for implementation  
**Audience:** Platform architects, DevOps engineers, admin panel developers

---

## Overview

This document specifies how the multi-region platform enables:
1. **Full admin panel in each region** — Manage own region + view/manage other regions
2. **Seamless customer migration** — Between regions with data preservation
3. **Optional customer co-hosting** — Active-passive hot standby in secondary region with hourly sync
4. **Region health monitoring** — Detect degraded/failed regions and enable easy failover
5. **Volume ownership transfer** — Primary owns during normal operation, secondary takes ownership on failure

---

## PHASE 2+: Multi-Region Admin Panel Architecture

### Admin Panel in Each Region

```
Frankfurt Admin Panel          Strasbourg Admin Panel          Ashburn Admin Panel
├── Manage Frankfurt customers ├── Manage Strasbourg customers ├── Manage Ashburn customers
├── View Strasbourg customers  ├── View Frankfurt customers    ├── View Frankfurt customers
├── View Ashburn customers     ├── View Ashburn customers      ├── View Strasbourg customers
├── Migrate customers          ├── Migrate customers           ├── Migrate customers
├── Enable co-hosting          ├── Enable co-hosting           ├── Enable co-hosting
├── Monitor region health      ├── Monitor region health       ├── Monitor region health
└── Failover dashboard         └── Failover dashboard          └── Failover dashboard
```

### Key Features per Admin Panel

**1. Manage Own Region (Full Control)**
```
Customer Management:
├── Create new customers
├── Edit customer details (plan, storage quota, email accounts)
├── Delete customers
├── View customer namespaces (Kubernetes)
├── Manage persistent volumes
├── Monitor resource usage
├── Manage SSL certificates
└── Full admin access (read-write)
```

**2. Cross-Region Visibility (Read-Only)**
```
View Other Regions:
├── List all customers in other regions
├── View customer details (read-only)
├── Check region health status
├── View co-hosted customer setup
├── See migration history
└── Cannot edit other regions directly
```

**3. Customer Migration (Primary Control)**
```
Migration Operations:
├── Initiate live migration (if source region healthy)
├── Initiate backup-based migration (if source degraded/down)
├── Select target region
├── Enable co-hosting during migration
├── Monitor migration progress
├── Verify data integrity after migration
└── Switch DNS to new region
```

**4. Co-hosting Management**
```
Co-hosting Setup:
├── Enable per-customer co-hosting add-on
├── Select primary region (required)
├── Select secondary region (for hot standby)
├── Configure hourly sync
├── Monitor sync status
├── View primary/secondary volume status
└── Trigger manual failover if needed
```

**5. Region Health Dashboard**
```
Health Monitoring:
├── Region status (healthy/degraded/down)
├── Pod count, node status
├── Database replication lag
├── DNS sync status
├── Backup upload status
├── Affected customers (if degraded)
├── Quick migrate button (one-click migration)
└── Failover procedures (documented)
```

---

## Customer Co-hosting: Active-Passive Hot Standby

### Architecture

```
Normal Operation (Both Regions Healthy):
┌──────────────────────────┐
│ Primary Region: Frankfurt │
├──────────────────────────┤
│ Customer: acme.com       │
│ ├─ Website Files        │
│ ├─ Database             │
│ ├─ Email Mailboxes      │
│ ├─ SSL Certs            │
│ └─ DNS (Primary master) │
│    (ACTIVE)             │
└──────────────────────────┘
           │ Hourly Sync
           ├─ File sync (rsync/S3)
           ├─ Database sync (pg_dump → restore)
           ├─ Email sync (IMAP export)
           └─ SSL certs sync
           │
           ▼
┌──────────────────────────┐
│ Secondary: Strasbourg    │
├──────────────────────────┤
│ Customer: acme.com       │
│ ├─ Website Files (copy) │
│ ├─ Database (copy)      │
│ ├─ Email Mailboxes (cp) │
│ ├─ SSL Certs (copy)     │
│ └─ DNS (read-only slave)│
│    (STANDBY)            │
└──────────────────────────┘
```

### Co-hosting Configuration

**Per-Customer Setting:**
```json
{
  "customerId": "customer_001",
  "name": "acme.com",
  "cohosting": {
    "enabled": false,         // Enable/disable co-hosting
    "addon_purchased": true,  // Co-hosting add-on purchased
    "primary_region": "frankfurt",
    "secondary_region": "strasbourg",
    "sync_schedule": "hourly",  // Every hour
    "last_sync": "2026-03-01T10:00:00Z",
    "sync_status": "healthy",   // or "delayed", "failed"
    "sync_lag_minutes": 5,      // How behind secondary is
    "primary_volume_id": "pvc-frankfurt-001",
    "secondary_volume_id": "pvc-strasbourg-001"
  }
}
```

### Data Sync Mechanism (Hourly)

**Sync Process (Primary → Secondary):**

```
1. Trigger (every hour, or on-demand)
2. Snapshot & Lock
   ├─ Snapshot primary persistent volume
   ├─ Lock database (brief, < 1 second for consistency)
   ├─ Backup snapshot to external storage
   └─ Release database lock

3. File Sync
   ├─ rsync primary volume → secondary (incremental)
   ├─ Only changed files transferred
   └─ Network: ~100 MB/min, typical sync < 5 minutes

4. Database Sync
   ├─ pg_dump primary database (hot backup, no locks)
   ├─ Transfer to secondary region
   ├─ Restore to secondary database
   └─ Verify data integrity (checksum)

5. Email Sync
   ├─ IMAP export primary mailboxes
   ├─ IMAP import to secondary
   ├─ Verify message count matches
   └─ Continue receiving new mail on primary

6. SSL Certificate Sync
   ├─ Copy primary certificates → secondary
   ├─ Private keys encrypted in transit (Vault)
   └─ Verify cert validity

7. Report
   ├─ Log sync completion
   ├─ Report sync lag (in minutes/seconds)
   ├─ Alert if sync > 10 minutes (warning)
   └─ Alert if sync failed (critical)
```

**Sync Performance:**
- **Typical sync duration:** 5-15 minutes (small sites)
- **Large sites (> 1 GB files):** 15-60 minutes
- **Small sites (< 100 MB):** 2-5 minutes
- **Database size doesn't matter:** Same time (hot backup, streamed)
- **Email sync:** Incremental, only new messages
- **Retry on failure:** 3 attempts within hour, alert if all fail

**Network Requirements:**
- Minimum **50 Mbps** bandwidth between regions (typical: 1+ Gbps)
- Secondary region can read-only serve while syncing
- No downtime on primary during sync

---

## Customer Migration Workflows

### Scenario 1: Live Migration (Source Region Healthy)

**Conditions:**
- Primary region is healthy and reachable
- Customer's persistent volume accessible
- Data can be transferred live

**Workflow:**

```
Step 1: Initiate Migration (Admin Panel)
├─ Select customer
├─ Select target region
├─ Choose migration type:
│  ├─ "Move" (remove from Frankfurt, move to Strasbourg)
│  ├─ "Copy" (keep in Frankfurt, add Strasbourg as co-hosted)
│  └─ "Replace" (disable Frankfurt, enable Strasbourg only)
└─ Confirm (cannot be undone during migration)

Step 2: Pre-migration Checks
├─ Verify source region health
├─ Check target region capacity
├─ Verify persistent volume accessible
├─ Check customer's backup status
└─ Verify DNS can be updated

Step 3: Live Volume Transfer
├─ Create snapshot of primary volume
├─ Transfer snapshot to target region (network)
├─ Restore snapshot to target persistent volume
├─ Sync any in-flight changes (live delta sync)
└─ Verify data integrity (checksum)

Step 4: Database Transfer
├─ pg_dump primary database (hot, streaming)
├─ Transfer to target region database
├─ Restore database
├─ Verify row counts match
└─ Replication can resume immediately

Step 5: DNS Switch
├─ Update A record to point to new region IP
├─ TTL already low (5 minutes)
├─ Wait for cache invalidation (~5 minutes)
└─ Old region DNS becomes read-only slave

Step 6: Verification
├─ Test website from new region
├─ Test email routing
├─ Test database connectivity
├─ Check disk usage
└─ Verify customer can access panel

Step 7: Cleanup (if "Move" type)
├─ Remove customer namespace from old region
├─ Decommission persistent volume in old region
├─ Archive backups (for audit trail)
└─ Update customer's primary_region

Total Time: 30-120 minutes (depends on data size)
RTO: < 30 minutes (DNS switch is instant)
RPO: 0 (live transfer, no data loss)
```

### Scenario 2: Backup-Based Migration (Source Region Down/Degraded)

**Conditions:**
- Primary region is down or severely degraded
- Persistent volumes not accessible
- Must restore from external backups

**Workflow:**

```
Step 1: Detect Degradation (Automated Alert)
├─ Region health check fails
├─ Management API unreachable
├─ AlertManager fires "Region Down" alert
└─ Admin notified immediately

Step 2: Determine Scope
├─ Query healthy region's database
├─ Count customers in failed region
├─ Check backup freshness (< 24 hours)
├─ Identify critical vs non-critical customers
└─ Display to admin with risk assessment

Step 3: Initiate Backup Restore
├─ Admin selects customers to migrate
├─ Select target region
├─ System retrieves latest backup from external SFTP
├─ Verify backup integrity
└─ Start restore process

Step 4: Restore Customer Data
├─ Create new Kubernetes namespace in target region
├─ Restore persistent volume from backup
├─ Restore database from backup
├─ Restore email accounts from backup
├─ Restore SSL certificates
└─ Generate new ingress IP for target region

Step 5: DNS Update
├─ Update A record to new region IP
├─ TTL 5 minutes (cache invalidation)
├─ Validate DNS propagation
└─ Verify customer domains resolve to new IP

Step 6: Verification
├─ Test customer website
├─ Test customer email (may need POP3 resync)
├─ Notify customer (optional, show in Control Panel)
└─ Document in audit log

Step 7: Original Region Recovery
├─ If original region comes back:
│  ├─ Operator can manually restore old region
│  ├─ Or decommission (depends on recovery plan)
│  └─ Document timeline for audit
└─ If permanently failed:
   ├─ Archive backup for compliance
   └─ Update customer subscription (may offer discount)

Total Time: 60-180 minutes (depends on backup size, network)
RTO: 60-180 minutes (network speed dependent)
RPO: < 24 hours (daily backups)
Data Loss: Possible (since last backup), customers notified
```

### Scenario 3: Proactive Migration (Before Failure)

**Conditions:**
- Region is healthy but showing degradation signs
- Admin wants to prevent future outages
- Proactive maintenance window

**Workflow:**

```
Step 1: Identify Degradation Signs
├─ High latency (> 100ms for DNS queries)
├─ High CPU/memory on some nodes
├─ Slow database replication lag (> 5 seconds)
├─ Low disk space (< 20% free)
└─ Hardware failures in cluster (nodes unreachable)

Step 2: Plan Migration (with Customer Notification)
├─ Identify affected customers
├─ Determine target region (where customer is already co-hosted, if applicable)
├─ Plan migration schedule (low-traffic window if possible)
├─ Notify customers via email/Control Panel
└─ Allow 48-72 hours notice

Step 3: Live Migration (Same as Scenario 1)
├─ Transfer volumes live (no downtime)
├─ Switch DNS
├─ Verify functionality
└─ Document in audit log

Benefits:
├─ No data loss (live transfer)
├─ No customer data loss (proactive)
├─ Reduces risk of cascading failures
└─ Demonstrates reliability to customers
```

---

## Region Degradation Detection & Admin Actions

### Health Check System

**Automated Monitoring (Every 5 minutes):**

```
Per-Region Checks:
├─ Kubernetes cluster health
│  ├─ Node count (are all nodes up?)
│  ├─ Pod status (are critical pods running?)
│  ├─ Persistent volume claims (any stuck?)
│  └─ Ingress controller health
│
├─ Database health
│  ├─ Can query local database?
│  ├─ Replication lag from primary (< 1 second?)
│  ├─ Disk space (> 20% free?)
│  └─ Backup uploads (completed in last 24 hours?)
│
├─ DNS health (ns1.region.local)
│  ├─ Can resolve zones?
│  ├─ Zone count correct?
│  ├─ AXFR working to external slaves?
│  └─ API response time (< 100ms?)
│
├─ External backups
│  ├─ Can reach external SFTP server?
│  ├─ Can upload files?
│  ├─ Disk space available?
│  └─ Last successful backup timestamp
│
└─ Inter-region links
   ├─ Can reach other regions' APIs?
   ├─ RNDC replication working?
   ├─ Database replication lag
   └─ Backup sync status
```

### Health Status Levels

```
GREEN (Healthy):
├─ All checks passing
├─ All metrics normal
├─ Can handle full customer load
└─ No action needed

YELLOW (Degraded):
├─ Some non-critical checks failing (e.g., slow DNS, high latency)
├─ Region can still serve customers
├─ Warning displayed to admin
├─ Recommend proactive migration (non-critical customers)
└─ Auto-migrate co-hosted customers if secondary region healthy

RED (Failed/Critical):
├─ Region unreachable or most services down
├─ Cannot accept new requests
├─ Manual intervention required
├─ Admin should migrate all customers
└─ Dashboard shows "Emergency Failover" options
```

### Admin Control Panel: Region Health Dashboard

**When Primary Region is Degraded/Failed:**

```
┌─────────────────────────────────────────────────────┐
│ Region Health Dashboard - FRANKFURT                 │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Status: ⚠️ DEGRADED (Yellow)                       │
│                                                     │
│ Last Check: 2 minutes ago                           │
│ Issues:                                             │
│ ├─ High API latency (450ms, threshold: 100ms)     │
│ ├─ Database replication lag: 8 seconds (high)      │
│ └─ 3 pods pending (memory pressure on 2 nodes)     │
│                                                     │
│ Affected Customers: 47                             │
│ ├─ Critical: 5 (e-commerce)                        │
│ ├─ Standard: 32                                    │
│ └─ Starter: 10                                     │
│                                                     │
│ Actions:                                            │
│ ┌──────────────────────────────────┐               │
│ │ [Migrate All Customers]          │               │
│ │ [Migrate Critical Only]           │               │
│ │ [Migrate Specific Customers]      │               │
│ │ [Restart Pods]                    │               │
│ │ [Scale Up Resources]              │               │
│ └──────────────────────────────────┘               │
│                                                     │
│ Recommended Action:                                 │
│ └─ Migrate critical customers to Strasbourg ASAP   │
│                                                     │
│ Failover Status:                                    │
│ ├─ 5 customers have co-hosting enabled             │
│ ├─ Can fail over to Strasbourg                     │
│ └─ [Auto-failover Co-hosted Customers]             │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Migration Options (One-Click):**

```
┌─────────────────────────────────────────────────────┐
│ Migrate Customers - Frankfurt → ?                  │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Migration Type:                                     │
│ ○ Live Migration (source region healthy)           │
│ ● Backup Restore (source region down)              │
│                                                     │
│ Select Target Region:                              │
│ ○ Strasbourg (OVH EU) - Capacity: 80%              │
│ ○ Ashburn (Linode US) - Capacity: 60%              │
│ ○ Singapore (Hetzner APAC) - Capacity: 40%         │
│                                                     │
│ Customers to Migrate:                              │
│ ☑ acme.com (Premium, 5 GB, Email)                  │
│ ☑ corp.fr (Business, 500 MB)                       │
│ ☑ startup.ai (Starter, 100 MB)                     │
│ ☐ test.local (Starter, 50 MB) [optional]           │
│                                                     │
│ Options:                                            │
│ ☑ Enable co-hosting on secondary region            │
│ ☐ Keep original region as read-only backup         │
│ ☐ Notify customers via email                       │
│                                                     │
│ Estimated Time: 45-90 minutes                      │
│ Backup Status: All current (< 2 hours old)         │
│                                                     │
│              [Start Migration]  [Cancel]            │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Migration Progress Monitoring:**

```
┌─────────────────────────────────────────────────────┐
│ Migration In Progress (47 customers)                │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Overall Progress: [████████░░░░░░░░░░] 40%         │
│ ETA: 35 minutes                                     │
│                                                     │
│ Details:                                            │
│ acme.com:                                           │
│ ├─ Volume transfer: [██████████████░░] 80%         │
│ ├─ Database: [██████████░░░░░░░░░░] 50%            │
│ ├─ Email: [████████████████░░░░░░] 85%             │
│ ├─ SSL certs: [████████████████████] 100% ✓        │
│ └─ Status: Transferring database...                │
│                                                     │
│ corp.fr:                                            │
│ ├─ Volume transfer: [████████████████░░] 95%       │
│ ├─ Database: [██████████░░░░░░░░░░] 50%            │
│ ├─ Status: Waiting for next phase...               │
│                                                     │
│ startup.ai:                                         │
│ ├─ Queued (will start after corp.fr)               │
│                                                     │
│ [Pause Migration] [Cancel Migration]                │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## Volume Ownership & Transfer

### Normal Operation: Primary Owns

```
Frankfurt (Primary Region):
├─ Persistent Volume: pvc-frankfurt-acme-001
│  ├─ Owner: Customer acme.com
│  ├─ Status: Read-Write (active)
│  ├─ Mounted: Website pod (read-write)
│  └─ Backed up: Daily to external SFTP
│
└─ Database Volume: pvc-frankfurt-db-001
   ├─ Owner: Customer acme.com
   ├─ Status: Read-Write (active)
   ├─ Size: 50 GB
   └─ Replicated: Via pglogical to Strasbourg (read-only)

Strasbourg (Secondary Region - if co-hosted):
├─ Persistent Volume: pvc-strasbourg-acme-001
│  ├─ Owner: None (secondary, read-only)
│  ├─ Status: Read-Only (standby)
│  ├─ Mounted: Website pod (read-only, if active)
│  ├─ Updated: Hourly via rsync from Frankfurt
│  └─ Last sync: 2026-03-01T10:00:00Z
│
└─ Database Volume: pvc-strasbourg-db-001
   ├─ Owner: None (secondary, read-only)
   ├─ Status: Read-Only (standby)
   ├─ Replicated: From Frankfurt (hot standby)
   └─ Last sync: 2026-03-01T10:00:00Z (lag: 3 minutes)
```

### Failover: Ownership Transfer (Primary Down)

```
Step 1: Detect Primary Failure
├─ Frankfurt region goes down
├─ AlertManager fires critical alert
├─ Admin notified

Step 2: Admin Initiates Failover
├─ Admin clicks [Promote Strasbourg] in Control Panel
├─ Confirmation required (one-click, but confirmable)
├─ Migration type: "Failover" (not normal migration)

Step 3: Volume Ownership Transfer
Frankfurt (Now Down/Read-Only):
├─ Persistent Volume: pvc-frankfurt-acme-001 → Archived
│  └─ No longer actively mounted
└─ Database: Archived snapshots in external SFTP

Strasbourg (Now Primary):
├─ Persistent Volume: pvc-strasbourg-acme-001 → Owner NOW
│  ├─ Status: Read-Write (promoted to primary)
│  ├─ Mounted: Website pod (read-write, now active)
│  └─ Backed up: Daily to external SFTP
│
└─ Database: pvc-strasbourg-db-001 → Owner NOW
   ├─ Status: Read-Write (promoted to primary)
   ├─ Replication: Can resume from any healthy region
   └─ New primary region: Strasbourg
```

### Recovery: Frankfurt Comes Back Online

```
Option 1: Restore Frankfurt as Secondary (to Strasbourg)
├─ Restore Frankfurt from latest Strasbourg backup
├─ Frankfurt becomes read-only slave
├─ Hourly sync from Strasbourg → Frankfurt
└─ Can promote back to primary if needed

Option 2: Keep Strasbourg as Primary (Recommended)
├─ Frankfurt remains down (or offline)
├─ Wait for capacity/resources to recover
├─ Once ready: Restore Frankfurt fresh from backup
├─ Update customer's primary_region to Strasbourg
└─ Decommission Frankfurt volumes (archive for audit)

Option 3: Manual Review Required
├─ Data diverged significantly (unlikely with hourly sync)
├─ Admin manually merges/reconciles
├─ Document for compliance/audit
```

---

## API Endpoints (Multi-Region Management)

### Customer Migration

```bash
# Initiate customer migration
POST /api/v1/customers/{customerId}/migrate-region
{
  "target_region": "strasbourg",
  "migration_type": "move",  // or "copy", "replace"
  "enable_cohosting": false,
  "reason": "admin_request",  // or "region_failure", "proactive"
  "notify_customer": true
}

Response:
{
  "migration_id": "migration_001",
  "status": "in_progress",
  "from_region": "frankfurt",
  "to_region": "strasbourg",
  "type": "move",
  "progress": 0,
  "estimated_completion": "2026-03-01T11:30:00Z",
  "phases": {
    "volume_transfer": {"status": "in_progress", "progress": 30},
    "database_transfer": {"status": "pending"},
    "email_sync": {"status": "pending"},
    "dns_update": {"status": "pending"},
    "verification": {"status": "pending"}
  }
}

# Get migration status
GET /api/v1/customers/{customerId}/migration/{migrationId}

# Cancel migration (if in_progress)
POST /api/v1/customers/{customerId}/migration/{migrationId}/cancel

# List all migrations (admin)
GET /api/v1/admin/migrations?region=frankfurt&status=in_progress
```

### Co-hosting Management

```bash
# Enable co-hosting for customer
POST /api/v1/customers/{customerId}/cohosting/enable
{
  "primary_region": "frankfurt",
  "secondary_region": "strasbourg",
  "sync_schedule": "hourly"
}

Response:
{
  "customerId": "customer_001",
  "cohosting_enabled": true,
  "primary_region": "frankfurt",
  "secondary_region": "strasbourg",
  "sync_schedule": "hourly",
  "next_sync": "2026-03-01T11:00:00Z",
  "volume_ids": {
    "primary": "pvc-frankfurt-001",
    "secondary": "pvc-strasbourg-001"
  }
}

# Get co-hosting status
GET /api/v1/customers/{customerId}/cohosting

Response:
{
  "cohosting_enabled": true,
  "primary_region": "frankfurt",
  "secondary_region": "strasbourg",
  "last_sync": "2026-03-01T10:00:00Z",
  "sync_lag_minutes": 5,
  "sync_status": "healthy",  // or "delayed", "failed"
  "sync_details": {
    "files": {"status": "synced", "size_mb": 2500},
    "database": {"status": "synced", "rows": 150000},
    "email": {"status": "synced", "messages": 5000},
    "ssl_certs": {"status": "synced"}
  }
}

# Trigger manual sync (if not on schedule)
POST /api/v1/customers/{customerId}/cohosting/sync-now

# Disable co-hosting
POST /api/v1/customers/{customerId}/cohosting/disable
```

### Region Health & Failover

```bash
# Get region health status
GET /api/v1/admin/regions/{region}/health

Response:
{
  "region": "frankfurt",
  "status": "degraded",  // or "healthy", "down"
  "last_check": "2026-03-01T10:05:00Z",
  "issues": [
    {"type": "high_latency", "details": "API response: 450ms (threshold: 100ms)"},
    {"type": "db_replication_lag", "details": "Lag: 8 seconds"}
  ],
  "affected_customers": 47,
  "affected_by_severity": {
    "critical": 5,
    "standard": 32,
    "starter": 10
  }
}

# List customers in region (for failover)
GET /api/v1/admin/customers?region=frankfurt&status=active

# Initiate failover (for co-hosted customers)
POST /api/v1/admin/regions/{region}/failover
{
  "failed_region": "frankfurt",
  "target_region": "strasbourg",
  "customer_filter": "cohosted_only",  // or "all", "critical"
  "auto_dns_switch": true
}

Response:
{
  "failover_id": "failover_001",
  "status": "in_progress",
  "failed_region": "frankfurt",
  "target_region": "strasbourg",
  "customers_affected": 47,
  "failover_type": "co_hosted_only",
  "progress": 0,
  "estimated_completion": "2026-03-01T11:15:00Z"
}
```

### Region Metrics & Monitoring

```bash
# Get region metrics
GET /api/v1/admin/regions/{region}/metrics

Response:
{
  "region": "frankfurt",
  "timestamp": "2026-03-01T10:05:00Z",
  "kubernetes": {
    "nodes_total": 5,
    "nodes_healthy": 5,
    "pods_running": 247,
    "pods_pending": 0,
    "pods_failed": 0
  },
  "database": {
    "connection_pool": "95%",
    "replication_lag_seconds": 0.5,
    "backup_success_rate": "100%",
    "disk_usage_percent": 65
  },
  "dns": {
    "zones_total": 1200,
    "queries_per_second": 5000,
    "api_latency_ms": 45,
    "axfr_success_rate": "99.9%"
  },
  "backups": {
    "last_upload": "2026-03-01T09:30:00Z",
    "upload_success": true,
    "backups_on_sftp": 45
  }
}
```

---

## Billing & Licensing: Co-hosting Add-on

### Co-hosting Add-on Model

**Cost Structure:**
```
Base Plan (per customer, per month):
├─ Starter: €5
├─ Business: €20
└─ Premium: €50

Co-hosting Add-on (per customer, per month):
├─ Starter + Co-hosting: €5 + €5 (50% of base price)
├─ Business + Co-hosting: €20 + €10 (50% of base price)
└─ Premium + Co-hosting: €50 + €25 (50% of base price)

Example:
├─ acme.com: Premium plan = €50/month
├─ Enable co-hosting: +€25/month
├─ Total: €75/month

Justification:
├─ No double infrastructure cost (shared regional resources)
├─ Only hourly sync + storage overhead (~10-20% per customer)
└─ 50% discount reflects actual cost difference
```

**Billing Implementation:**

```
Plan Subscription Table:
├─ customer_id: customer_001
├─ plan: premium
├─ base_price: €50.00/month
├─ cohosting_enabled: true
├─ cohosting_price: €25.00/month
├─ total_price: €75.00/month
├─ billing_date: 2026-03-01
└─ next_billing: 2026-04-01

Invoice Line Items:
├─ acme.com (Premium): €50.00
├─ Co-hosting Add-on (Frankfurt + Strasbourg): €25.00
└─ Total: €75.00
```

**API for Billing Integration:**

```bash
# Get customer's billing details
GET /api/v1/customers/{customerId}/billing

Response:
{
  "customerId": "customer_001",
  "plan": "premium",
  "base_price": 50.00,
  "cohosting_enabled": true,
  "cohosting_addon_price": 25.00,
  "total_monthly_price": 75.00,
  "next_billing_date": "2026-04-01",
  "payment_method": "credit_card",
  "payment_status": "active"
}

# Enable/disable co-hosting (affects billing)
POST /api/v1/customers/{customerId}/cohosting/enable
{
  "primary_region": "frankfurt",
  "secondary_region": "strasbourg"
}

# Billing system auto-updates:
# ├─ Detects co-hosting enablement
# ├─ Calculates co-hosting addon price
# ├─ Updates next invoice
# └─ Notifies customer of price change
```

---

## Admin Panel UI Components (Multi-Region)

### Dashboard: Region Selector

```
┌───────────────────────────────────────────────────────┐
│ Admin Panel - Regions                                 │
├───────────────────────────────────────────────────────┤
│                                                       │
│ Primary Region: [Frankfurt ▼]                         │
│ [Strasbourg] [Ashburn] [Singapore]                    │
│                                                       │
│ Frankfurt Status: ✓ Healthy                           │
│ Strasbourg Status: ✓ Healthy                          │
│ Ashburn Status: ✓ Healthy                             │
│ Singapore Status: ✓ Healthy                           │
│                                                       │
│ Customers in Frankfurt: 47                            │
│ Customers in Strasbourg: 32                           │
│ Customers in Ashburn: 25                              │
│ Customers in Singapore: 18                            │
│                                                       │
└───────────────────────────────────────────────────────┘
```

### Customer View: Co-hosting Status

```
Customer: acme.com
├─ Plan: Premium
├─ Primary Region: Frankfurt ✓ Healthy
├─ Data Volume: 2.5 GB
├─ Email Accounts: 5
│
├─ Co-hosting: ✓ Enabled
│  ├─ Secondary Region: Strasbourg ✓ Healthy
│  ├─ Sync Schedule: Hourly
│  ├─ Last Sync: 2026-03-01 10:00 (5 minutes ago)
│  ├─ Sync Lag: 5 minutes
│  ├─ Status: Healthy
│  └─ Cost: €25/month additional
│
├─ Actions:
│  ├─ [Edit Co-hosting]
│  ├─ [Sync Now]
│  └─ [Disable Co-hosting]
│
└─ Volumes:
   ├─ Primary: pvc-frankfurt-acme-001 (Read-Write)
   └─ Secondary: pvc-strasbourg-acme-001 (Read-Only)
```

---

## Summary

| Aspect | Feature |
|--------|---------|
| **Admin Panels** | One per region, manage own + view others |
| **Customer Management** | Create, edit, delete, migrate between regions |
| **Co-hosting** | Optional per-customer, active-passive hot standby |
| **Data Sync** | Hourly for files, databases, email, SSL certs |
| **Traffic Model** | Active-passive (primary is active, secondary standby) |
| **Failover** | Manual admin action (not automatic), one-click in Control Panel |
| **Migration** | Live (if source healthy) or from backup (if source down) |
| **Volume Ownership** | Primary owns during normal op, secondary takes over on failure |
| **DNS Management** | Primary region is DNS authority, secondary read-only |
| **Cost Model** | Co-hosting is add-on (50% of base plan price) |
| **RTO** | Live migration: < 30 min; Backup restore: 1-3 hours |
| **RPO** | Live: 0; Backup-based: < 24 hours |

---

**Status:** Ready for implementation  
**Next Phase:** Update INFRASTRUCTURE_PLAN.md Section 5.6 with co-hosting strategy  
**Related Documents:**
- `GEOGRAPHIC_SHARDING_SUMMARY.md` — Multi-region deployment phases
- `DISPERSED_DNS_ARCHITECTURE.md` — DNS per region (primary/secondary)
- `/04-deployment/MANAGEMENT_API_SPEC.md` — Customer/Region management APIs
