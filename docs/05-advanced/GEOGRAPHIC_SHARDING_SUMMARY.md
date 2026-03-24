# Geographic Sharding with Centralized Management - Implementation Summary

> **Date:** 2026-02-27
> **Status:** Detailed design added to INFRASTRUCTURE_PLAN.md (Section 5.6)
> **Configuration:** Multi-master replication, app-level conflict resolution, regional independence

---

## What Was Added

A comprehensive new section (5.6) to the infrastructure plan detailing how to deploy independent Kubernetes clusters across multiple geographic regions while maintaining centralized management and complete independence.

---

## Key Design Decisions Implemented

### 1. **Multi-Master Database Replication**
- All regions can write simultaneously
- Real-time logical replication (pglogical/pg_partman)
- Application-level conflict resolution (not database-level)
- Conflict rules per entity type:
  - Plan changes: Take upgrade (premium > business > starter)
  - Resource quotas: Take higher amount
  - Deletes: Delete takes precedence
  - Timestamps: Included for app logic

### 2. **Single Master PowerDNS per Region (with RNDC Replication)**
- **PHASE 1:** One PowerDNS master in Frankfurt (ns1.de.local on control plane)
  - Optional external slave DNS servers (separate VMs, already in place)
  - Admin-configurable via RNDC
  - All zones managed in Frankfurt
  
- **PHASE 2+:** One PowerDNS master per region
  - Frankfurt (ns1.de.local) - master for all Frankfurt customers
  - Strasbourg (ns1.fr.local) - master for all Strasbourg customers
  - Ashburn (ns1.us.local) - master for all Ashburn customers
  - Singapore (ns1.sg.local) - master for all Singapore customers
  - **Bi-directional RNDC replication** between regions (for zone transfer notifications)
  - Each customer's zone is **read-write in their primary region** (where hosted)
  - Other regions pull zones via AXFR (read-only)

### 3. **Per-Region External Backup Storage**
- Each region has dedicated external SFTP server
- Daily backup via SSHFS mount → direct write to external backup server
- **Cross-region backup sync (nightly):**
  - Frankfurt backups synced to Strasbourg, Ashburn, Singapore
  - Each region has copies of all other regions' backups
  - Enables client re-provisioning from any region's backup

### 4. **Full Management API Replication**
- Every region has complete Management API + database replicas
- All regions are read-write capable
- Admin panel can connect to nearest API
- Any region can provision/manage/delete clients
- No dependency on Frankfurt if it's down

### 5. **Complete Regional Independence**
- Each region can operate for weeks without contacting others
- No single point of failure per region
- DNS resilient: Continues with cached zones
- Database resilient: Can accept writes from local clients
- Backup resilient: Own external backup server + cross-region copies

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         CENTRALIZED MANAGEMENT LAYER                            │
│                                                                                 │
│   Admin Panel ──► Management API (any region) ──► PostgreSQL (multi-master)    │
│                         │                              │                        │
│                   PowerDNS API               pglogical replication              │
│                         │                    (real-time, bi-directional)        │
└─────────────────────────┼───────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┬───────────────────────┐
          │               │               │                       │
          ▼               ▼               ▼                       ▼
┌─────────────────┐ ┌─────────────┐ ┌──────────────┐  ┌──────────────────┐
│  Hetzner        │ │  OVH        │ │  Linode       │  │  Hetzner         │
│  Frankfurt      │ │  Strasbourg │ │  Ashburn      │  │  Singapore       │
│  (PHASE 1+)     │ │  (PHASE 2+) │ │  (PHASE 3+)   │  │  (PHASE 4+)      │
│                 │ │             │ │               │  │                  │
│  k3s cluster    │ │  k3s        │ │  k3s          │  │  k3s             │
│  ns1.de.local   │ │  ns1.fr.local│ │  ns1.us.local│  │  ns1.sg.local    │
│  (PowerDNS)     │ │  (PowerDNS) │ │  (PowerDNS)   │  │  (PowerDNS)      │
│                 │ │             │ │               │  │                  │
│  EU Premium     │ │  EU Starter │ │  US clients   │  │  APAC clients    │
│  EU Business    │ │  (20% load) │ │               │  │                  │
│                 │ │  EU failover│ │               │  │                  │
│  SFTP backup ◄──┼─┼─── nightly ─┼───── sync ─────┼──┘                  │
│  server         │ │  SFTP backup│ │  SFTP backup  │  SFTP backup        │
└────────┬────────┘ └──────┬──────┘ └───────┬───────┘  └────────┬─────────┘
         │                 │                │                    │
         └─────────────────┴────────────────┴────────────────────┘
                           AXFR zone transfers + RNDC replication
                           (read-only in non-primary regions)

LEGEND:
  ──►  Management / API traffic
  ───  DNS zone replication (AXFR)
  ◄──  Backup sync (nightly cross-region)
  pglogical = real-time PostgreSQL logical replication
```

**Key relationships:**
- Each region is a fully independent k3s cluster — no shared control plane
- The Management API runs in every region; any region can handle admin operations
- PostgreSQL replicates bi-directionally via pglogical — all regions are read-write
- PowerDNS: each region has one master for its own customers' zones; other regions receive those zones via AXFR (read-only)
- Backup servers: each region has a dedicated SFTP server; nightly cross-region sync ensures every region has copies of all other regions' backups

---

## Client Assignment Strategy

New clients are assigned to a region at onboarding time by the Management API. The assignment is stored in the `clients.region_id` column and does not change without an explicit admin migration.

**Assignment logic (in order of priority):**

```
1. Admin override
   └─ If admin explicitly selects a region during client creation → use that region

2. Client's declared data residency requirement
   └─ If client requires EU data: assign to Frankfurt or Strasbourg
   └─ If client requires US data: assign to Ashburn
   └─ If client requires APAC data: assign to Singapore

3. Geographic proximity (nearest available region)
   └─ Determined by GeoIP lookup on the client's billing address or IP
   └─ Fallback: Frankfurt (primary region)

4. Capacity balancing
   └─ If the nearest region is > 80% capacity (CPU or storage):
      └─ Assign to next-nearest region with capacity
      └─ Admin alerted: "{region} approaching capacity threshold"

5. Plan-based constraints
   └─ Starter clients: may be placed in any region; load-balanced
      across Frankfurt (80%) and Strasbourg (20%) in Phase 2+
   └─ Business / Premium clients: respect proximity + residency only
   └─ Custom plans: admin-assigned region only
```

**Region capacity thresholds:**

| Metric | Warning | Hard limit |
|--------|---------|-----------|
| CPU utilisation | 75% | 85% (no new clients) |
| Memory utilisation | 75% | 85% |
| Storage utilisation | 80% | 90% |
| Client count | 90% of target | 100% (no new clients) |

**Client migration between regions:**

Clients can be migrated to a different region by an admin (Phase 2+). The process:
1. Admin initiates migration in Admin Panel → Clients → {client} → Region → Migrate
2. Target region provisioned (namespace, quotas, network policies)
3. Files synced via rsync, databases imported from dump
4. DNS A records updated to new region's ingress IPs (TTL already low at 300s)
5. Source namespace suspended for 48 hours (rollback window), then deleted
6. Client notified by email with new region and any latency changes

See `INFRASTRUCTURE_PLAN.md §5.6` for the full migration workflow.

---

## Failover Scenario: Hetzner Frankfurt Region Fails

### Detection (< 5 minutes)
- Health check fails: Cluster unreachable
- AlertManager fires: "Region Hetzner EU down"
- Admin notified via email + Slack

### Recovery Workflow
1. **Determine affected clients:** Query Management API in Strasbourg
   - How many clients in Frankfurt? 80-100
   - Where can they move? Strasbourg (OVH EU) has capacity

2. **Retrieve backups:** From Frankfurt's external SFTP server
   - Latest backup: < 24 hours old
   - Contains: DB dumps, file backups, client metadata

3. **Re-provision clients in Strasbourg:**
   - Create new K8s namespaces for each client
   - Restore databases from backup
   - Restore files from backup
   - Create new Ingress rules (OVH IP)
   - Provision new SSL certificates
   - Restore email accounts

4. **Update DNS:** PowerDNS updated by Strasbourg Management API
   - Change client domain A records → OVH Strasbourg ingress IP
   - TTL: 5 minutes (already low for failover)

5. **Communicate:** Notify stakeholders
   - Email clients: "Brief outage, service restored"
   - Admin dashboard: "99 clients migrated to Strasbourg"
   - Status page: "Resolved - Fallback to EU secondary"

### Recovery Time Objectives (RTO)
- **Detection:** < 5 minutes
- **Re-provisioning:** 10-60 minutes (depends on client count + backup size)
- **Total downtime:** 15-60 minutes

### Recovery Point Objective (RPO)
- **Data loss:** < 24 hours (last backup)

---

## What Still Works If...

| Failure Scenario | Impact |
|---|---|
| **Frankfurt K8s cluster down** | Strasbourg continues; Frankfurt clients failover to backup region |
| **ns1.de.local pod crash (PHASE 1)** | Kubernetes restarts pod (< 2 min RTO); external slaves continue serving zones |
| **ns1.de.local node fails (PHASE 1)** | Kubernetes reschedules pod to healthy node; zones restored from database |
| **Frankfurt K8s cluster down (PHASE 2+)** | Strasbourg, Ashburn, Singapore continue independently; Frankfurt customers' zones read-only in other regions until Frankfurt recovers |
| **RNDC replication breaks (PHASE 2+)** | Each region operates independently; zones don't sync between regions until replication restored |
| **Frankfurt external SFTP fails** | Strasbourg SFTP operational; daily sync from Frankfurt stops (other regions unaffected) |
| **Database replication lags** | Regions operate with local data; new zones don't replicate immediately (catch up on recovery) |
| **Strasbourg also fails** | Ashburn or Singapore take over EU clients (higher latency) |
| **All regions fail** | Restore from external SFTP servers (cross-region copies) |

---

## Operational Responsibilities Per Region

### Frankfurt (Primary EU Region)

**PHASE 1 (Single Region):**
- Runs ns1.de.local (PowerDNS master on control plane)
- All customer zones managed here
- Optional external slave DNS servers (admin-configurable)

**PHASE 2+ (Multi-Region):**
- Runs ns1.de.local (PowerDNS master for Frankfurt customers)
- Serves eu-premium and eu-business clients
- Manages DNS for customers hosted in Frankfurt
- Master for catalog images and policy updates
- Backup coordinator (orchestrates cross-region syncs)

### Strasbourg (EU Secondary Region, PHASE 2+)

- Runs ns1.fr.local (PowerDNS master for Strasbourg customers)
- Standby for Frankfurt clients
- Serves 20% of Starter clients (load distribution)
- Can take over EU clients if Frankfurt fails
- Receives AXFR zone transfers from Frankfurt (for Frankfurt zones, read-only)
- Bi-directional RNDC replication with Frankfurt

### Ashburn (US Region, PHASE 3+)

- Runs ns1.us.local (PowerDNS master for Ashburn customers)
- Independent: All US clients
- Receives AXFR zone transfers from Frankfurt (multi-region zones, read-only)
- Bi-directional RNDC replication with Frankfurt
- No dependencies on EU (isolated)

### Singapore (APAC Region, PHASE 4+)

- Runs ns1.sg.local (PowerDNS master for Singapore customers)
- Independent: All APAC clients
- Receives AXFR zone transfers from Frankfurt (multi-region zones, read-only)
- Bi-directional RNDC replication with Frankfurt
- No dependencies on other regions

---

## Monitoring and Alerts

**Every 5 minutes, check:**
- Cluster status (nodes, pods running)
- Database replication lag (should be < 1 second)
- PowerDNS master pod health (ns1.region.local)
- PowerDNS API response time (target: < 100ms)
- RNDC connectivity between regions (PHASE 2+)
- AXFR transfer success to external slaves (PHASE 1)
- Zone freshness on secondary regions (PHASE 2+, should be < 5 min)
- External backup upload success
- Ingress controller health
- Storage usage vs quota

**Alerts fired for:**
- CRITICAL: Region cluster down
- CRITICAL: PowerDNS master pod down
- CRITICAL: Database replication lag > 5 seconds
- WARNING: PowerDNS API latency > 1 second
- WARNING: RNDC connectivity lost (PHASE 2+)
- WARNING: AXFR transfer failed to external slave (PHASE 1)
- WARNING: Zone replication lag > 10 minutes (PHASE 2+)
- WARNING: External backup upload failed
- WARNING: Storage usage > 80%

---

## Conflict Resolution Examples

These examples illustrate how application-level conflict resolution works when two regions write to the same entity within the same replication window (before pglogical propagates the change).

### Plan Upgrade (No Conflict)

**Scenario:** Admin in Frankfurt upgrades client `acme-corp` from Business → Premium at 14:00:01 UTC. Simultaneously, admin in Strasbourg (operating on a 200ms replication lag) reads the client as still on Business and applies a Business-plan quota recalculation at 14:00:01 UTC.

**What happens:**
```
Frankfurt write:  { client_id: "acme", plan: "premium", updated_at: 14:00:01.001 }
Strasbourg write: { client_id: "acme", cpu_quota: 4000m, updated_at: 14:00:01.003 }
                  (Business-plan quota — stale, based on pre-upgrade plan)
```

**Resolution rule:** `Plan changes: take the upgrade (premium > business > starter)`

The Management API conflict resolver, on detecting the concurrent writes:
1. Keeps Frankfurt's `plan: "premium"`
2. **Discards** Strasbourg's quota recalculation (it was computed for the wrong plan)
3. Triggers a fresh quota recalculation in the winning region based on the new Premium plan
4. Emits a `CONFLICT_RESOLVED` audit event: `{ entity: "client", field: "plan", winner: "frankfurt", loser: "strasbourg", reason: "plan_upgrade_wins" }`

**Result:** Client ends up on Premium with correct Premium quotas. No data loss. ✅

---

### Resource Quota Conflict

**Scenario:** Admin in Frankfurt manually overrides `acme-corp`'s storage quota to 150 GB (above Business default of 100 GB). Concurrently, a background quota-sync job in Strasbourg resets the same field to the plan default of 100 GB (working from stale plan data).

**What happens:**
```
Frankfurt write:  { client_id: "acme", storage_quota_gb: 150, updated_at: 14:05:10.010 }
                  (manual admin override — intentional)
Strasbourg write: { client_id: "acme", storage_quota_gb: 100, updated_at: 14:05:10.015 }
                  (background sync — automated, lower timestamp)
```

**Resolution rule:** `Resource quotas: take the higher amount`

The conflict resolver:
1. Keeps Frankfurt's `storage_quota_gb: 150` (higher value wins)
2. Marks the field with `manually_overridden: true` to prevent future background syncs from overwriting it
3. Emits `CONFLICT_RESOLVED` audit event: `{ field: "storage_quota_gb", winner: 150, loser: 100, reason: "higher_quota_wins" }`

**Result:** Client retains the 150 GB override. Background sync is blocked from reverting it. ✅

---

### Delete Conflict

**Scenario:** Admin in Frankfurt deletes client `acme-corp` (account terminated). Concurrently, admin in Strasbourg (operating on stale data, unaware of the deletion) updates the client's subscription expiry date.

**What happens:**
```
Frankfurt write:  { client_id: "acme", status: "deleted", deleted_at: 14:10:00 }
Strasbourg write: { client_id: "acme", subscription_expires_at: "2027-03-08" }
                  (update on a client about to be deleted)
```

**Resolution rule:** `Deletes: delete takes precedence`

The conflict resolver:
1. Applies Frankfurt's deletion — `status: "deleted"`, `deleted_at` set
2. **Discards** Strasbourg's subscription update (no point updating a deleted client)
3. Strasbourg's admin panel shows the client as deleted on next refresh
4. Emits `CONFLICT_RESOLVED` audit event: `{ entity: "client", winner: "delete", loser: "subscription_update", reason: "delete_wins" }`

**Result:** Client is deleted. The stale subscription update is silently dropped. No zombie records created. ✅

**Important:** Delete conflicts are the highest-priority rule. Any concurrent mutation on a deleted entity is always discarded. This prevents ghost data accumulating across regions.

---

## Implementation Roadmap

### Phase 1 (Months 0-3): Single Region
- Deploy to Hetzner Frankfurt only
- Setup external backup server (SFTP)
- Daily backups to external SFTP

### Phase 2 (Months 3-6): Primary + Warm Standby
- Deploy OVH Strasbourg cluster (standby)
- Setup PowerDNS replication
- Nightly cross-region backup sync
- Test failover procedures monthly

### Phase 3 (Months 6-12): Geographic Distribution
- Deploy Linode US (Ashburn)
- Implement geographic routing
- Route US clients to Linode
- Load-balance EU Starter clients 80/20

### Phase 4 (Months 12+): Full Multi-Master
- Implement real-time PostgreSQL replication
- Full Management API replication
- Automated failover procedures
- Add APAC region (Hetzner Singapore)

---

## Cost Impact

| Phase | Regions | Cost | Clients |
|---|---|---|---|
| Phase 1 | Frankfurt only | €50/mo | 0-100 |
| Phase 2 | Frankfurt + Strasbourg | €90/mo | 50-150 |
| Phase 3 | Frankfurt + Strasbourg + Ashburn | €180/mo | 120-300 |
| Phase 4 | All 4 regions | €250-400/mo | 200+ |

**Extra cost of multi-region:** €40-350/mo (depending on phase)
**Worth it when:** 150+ clients, revenue justifies redundancy

---

## Files Modified

### INFRASTRUCTURE_PLAN.md
- **New Section 5.6:** Geographic Sharding with Centralized Management
- **Length:** ~2,000 lines added
- **Includes:**
  - Multi-master database design
  - PowerDNS architecture with regional caching
  - Per-region backup strategy
  - Client assignment logic
  - Failover procedures
  - Conflict resolution rules
  - Monitoring and alerts

---

## Questions Clarified (Your Requirements)

✅ **PowerDNS Architecture:**
- **PHASE 1:** One master (ns1.de.local) on Frankfurt control plane
- **PHASE 2+:** One master per region (ns1.region.local on each control plane)
- **Replication:** AXFR to external slaves (PHASE 1), RNDC bi-directional replication (PHASE 2+)
- **Authority:** Customer's primary region master is DNS authority; other regions read-only

✅ **Single-Region Dual DNS (PHASE 1):**
- One PowerDNS master on control plane (ns1.de.local)
- Optional external slave servers (separate VMs, admin-configurable via RNDC)
- Survives single master pod failure (Kubernetes restarts < 2 min)
- No multi-master replication needed in single region

✅ **Management API Architecture:**
- Multi-master replication
- All regions can write
- Application-level conflict resolution
- Fully independent region operation

✅ **Recovery Objectives (RTO/RPO):**
- **Single Region:** RTO < 2 minutes (pod restart)
- **Multi-Region Failover:** RTO < 15 minutes (failover + restore)
- **RPO:** < 24 hours (last backup)

✅ **Regional Independence:**
- Yes, completely independent
- Can operate for weeks without central connectivity
- No single point of failure per region
- DNS writes only in customer's primary region

✅ **Conflict Resolution:**
- Application-level (not database)
- Per-entity rules
- Example: Plan upgrades take precedence
- DNS is region-specific (no conflicts, only customer's primary region writes)

✅ **DNS Resilience:**
- **PHASE 1:** External slaves continue serving zones; restart master pod
- **PHASE 2+:** Each region independent; zones in secondary regions are read-only (pulled via AXFR)
- Can create new domains only in customer's primary region

✅ **Backup Storage:**
- Each region has external SFTP server
- Nightly cross-region sync
- All regions have copies of all backups

✅ **Management API Routing:**
- Full replication everywhere
- Admin panel routes to nearest healthy API
- All regions can provision/delete clients
- DNS editing restricted to customer's primary region

---

## Clarity Check

Is everything clear about:

1. **Multi-master database conflicts?** How application-level resolution works?
2. **PowerDNS caching?** How it allows DNS to work with just cached zones?
3. **Per-region backup servers?** How nightly syncing provides disaster recovery?
4. **Client re-deployment?** The workflow when a region fails?
5. **Management API independence?** How each region can run completely alone?
6. **Regional failover?** RTO/RPO targets and procedures?

**Please let me know if anything is still unclear or needs clarification!**

---

## Related Documents

**Document Location:** `../INFRASTRUCTURE_PLAN.md` (Section 5.6)
**Updated:** 2026-03-01
**Related Documents:**
- `../01-core/DISPERSED_DNS_ARCHITECTURE.md` - Comprehensive DNS architecture (single + multi-region with RNDC replication)
- `../01-core/POWERDNS_INTEGRATION.md` - PowerDNS implementation details
- `../01-core/DNS_MODE_SELECTION.md` - Customer DNS mode guide
- `MULTI_CLOUD_STRATEGY.md` - Multi-cloud architecture
