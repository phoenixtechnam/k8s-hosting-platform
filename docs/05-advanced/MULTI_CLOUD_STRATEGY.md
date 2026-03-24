# Multi-Cloud Strategy for Kubernetes Web Hosting Platform

> **Date:** 2026-02-27
> **Motivation:** Geographic distribution + disaster recovery + compliance
> **Strategy:** Client-type segmentation (critical/premium on best provider, standard on cost-optimized)
> **Complexity:** Moderate (2-3 providers, manageable operational overhead)

---

## Executive Summary

**Yes, you can mix cloud providers effectively.** A multi-cloud strategy provides:

✅ **Geographic distribution** - Serve clients globally with low latency
✅ **Disaster recovery** - If one provider fails, others continue
✅ **Cost optimization** - Use best provider for each region
✅ **Compliance flexibility** - EU data in EU, US data in US
✅ **Vendor negotiation power** - Leverage competition for better pricing
✅ **Reduced lock-in risk** - No single provider dependency

---

## Architecture Overview

### Recommended Multi-Cloud Setup

---

## Multi-Cloud Topology Decision

### Option 1: Geographic Sharding (RECOMMENDED for you)

**Strategy:** Different providers per region

**Advantages:**
- ✅ Minimal operational overhead (separate clusters per region)
- ✅ Compliance easy (data stays in region)
- ✅ Latency optimized (clients connect to nearest cluster)
- ✅ Risk contained (provider failure affects only one region)
- ✅ Cost-optimized per region (use cheapest provider per geography)

**Disadvantages:**
- ❌ No global load balancing between providers
- ❌ If one region has provider outage, clients need manual rerouting
- ❌ Requires DNS management across providers

### Option 2: Active-Active Across Providers

**Strategy:** Same region, multiple providers, load-balanced

**Advantages:**
- ✅ Provider failure = automatic failover to other provider
- ✅ Load distribution reduces cost per provider
- ✅ Easier client migration (no latency change)

**Disadvantages:**
- ❌ Complex DNS management (traffic steering rules)
- ❌ Cross-provider replication overhead
- ❌ Higher operational complexity
- ❌ Cost per provider higher (don't get deep discounts)

### Option 3: Active-Passive (Cold Standby)

**Strategy:** Primary on Hetzner, full backup on OVH, only activate if needed

**Advantages:**
- ✅ Minimal ongoing cost (standby cluster can be smaller/paused)
- ✅ Simple architecture (one provider active at a time)
- ✅ Compliance simplicity

**Disadvantages:**
- ❌ Slower failover (need to activate standby cluster)
- ❌ Data sync overhead
- ❌ Less cost-effective (paying for unused capacity)

---

## RECOMMENDED ARCHITECTURE: Geographic Sharding + Disaster Recovery

Combining best of both worlds:

---

## Detailed Multi-Cloud Implementation

### Phase 1: Single Primary + Warm Standby (Months 0-6)

**Setup:**

| Component | Provider | Spec | Role |
|-----------|----------|------|------|
| Control plane | Hetzner Frankfurt (`nbg1`) | cx21 (2 vCPU / 4 GB) | k3s server |
| Worker node | Hetzner Frankfurt (`nbg1`) | cx31 (2 vCPU / 8 GB) | k3s agent, NGINX Ingress |
| Block storage | Hetzner Volume | 200 GB | Longhorn PVs |
| SFTP backup | Hetzner StorageBox | 1 TB | Nightly backup target |
| Standby node (idle) | OVH Strasbourg (`GRA11`) | B2-7 (2 vCPU / 7 GB) | Cold standby — only activated on Frankfurt failure |
| Standby SFTP | OVH Object Storage | 500 GB | Cross-region backup copy |

Nightly at 02:00 UTC: `rsync --archive` from Frankfurt StorageBox → OVH standby storage. PowerDNS AXFR replicates zone data to standby ns. Standby k3s agent joins Frankfurt cluster with taint `node-role.kubernetes.io/standby:NoSchedule` so no workloads run on it until failover is triggered.

**How it works:**
1. All clients live on Hetzner Frankfurt
2. Every night, critical data synced to OVH (backups, DB, DNS zones)
3. If Hetzner fails, manually activate OVH cluster
4. DNS updated to point clients to OVH
5. Restore from last backup (15 minutes to 1 hour)

**Cost:** €65-80/mo (primary + minimal standby)
**Downtime on Hetzner failure:** 15-60 minutes
**Data loss:** Less than 24 hours (nightly sync)

### Phase 2: Geographic Distribution (Months 6-12)

**Setup:**

| Component | Provider | Spec | Role |
|-----------|----------|------|------|
| EU primary cluster | Hetzner Frankfurt (`nbg1`) | 1× cx21 control + 2× cx41 workers | Active — all Business/Premium EU clients |
| EU secondary cluster | OVH Strasbourg (`GRA11`) | 1× B2-7 control + 1× B2-15 worker | Active — Starter EU clients (50% load share) |
| US cluster | Linode Ashburn (`us-east`) | 1× Linode 4GB control + 1× Linode 8GB worker | Active — all US-based clients |
| Backup (EU) | Hetzner StorageBox | 2 TB | Primary EU backup target |
| Backup (US) | Linode Object Storage | 1 TB | US backup target |
| Cross-region sync | rsync via SSHFS | — | Nightly Frankfurt → OVH → Linode |
| DNS routing | PowerDNS GeoIP module | — | Route clients by source IP to nearest region |
| Image registry | Harbor (Frankfurt) + replication | — | Push-on-publish to OVH + Linode Harbor instances |

Each region runs a full independent k3s cluster with NGINX Ingress DaemonSet, PowerDNS, cert-manager, and Flux v2. The management API (running in Frankfurt) retains a `region` column per client record and proxies admin commands to the correct regional API.

**How it works:**
1. DNS routes EU clients to nearest cluster (Hetzner → Frankfurt latency 2ms)
2. OVH receives 50% of Starter clients (geographic distribution)
3. US clients route to Linode (geographic distribution)
4. Each region is independent; if one fails, others continue
5. Global backup: All regions write backups to external server via SSHFS mount (direct write)

**Cost:** €200-250/mo + $75/mo = ~€380/mo
**Downtime on provider failure:** 0 minutes (automatic failover within region)
**Data loss:** Minutes (continuous sync where applicable)

### Phase 3: Full Disaster Recovery (Months 12+)

**Setup:**

| Component | Provider | Spec | Role |
|-----------|----------|------|------|
| EU primary cluster | Hetzner Frankfurt | 3× cx41 workers | Active — EU primary |
| EU secondary cluster | OVH Strasbourg | 2× B2-15 workers | Active — EU hot standby (real-time replica) |
| US cluster | Linode Ashburn | 2× Linode 8GB workers | Active — US primary |
| APAC cluster | Hetzner Singapore | 2× cx31 workers | Active — APAC clients |
| PostgreSQL replication | pglogical multi-master | Frankfurt ↔ OVH (real-time) | 0 data loss EU failover |
| GeoDNS | Cloudflare Load Balancing or self-hosted (`gdnsd`) | Health-check-based steering | Automatic failover in < 30s |
| Global backup mesh | 4× StorageBox/Object Storage instances | 4 TB total | Each region backs up locally + cross-region nightly |
| Management API | Frankfurt (primary) + OVH (replica) | Active/passive | OVH replica promoted on Frankfurt loss |

Flux v2 GitOps manages all 4 clusters from a single `hosting-platform` Git repository using Kustomize overlays per region (`k8s/overlays/eu-frankfurt`, `eu-strasbourg`, `us-ashburn`, `apac-singapore`). Terraform workspace per region with shared backend in Hetzner S3-compatible Object Storage.

**How it works:**
1. EU: Hetzner + OVH active-active with real-time sync
2. US: Linode with internal HA
3. APAC: Hetzner Singapore independent
4. Global: Clients automatically route to nearest healthy cluster
5. Hetzner failure: OVH seamlessly takes over EU clients
6. Multi-region: No single point of failure

**Cost:** €300-400/mo EU + $150/mo US + €50/mo APAC = ~€700/mo global
**Downtime:** 0 minutes (automatic failover)
**Data loss:** 0 (real-time sync)
**Clients:** 300+ globally

---

## Implementation Details: Geographic Sharding

### How to Assign Clients to Providers

**Decision Logic:**

New client region assignment follows this priority order:

1. **Explicit admin override** — admin specifies `region` at account creation time (highest priority).
2. **Client billing address country** — map country ISO code to nearest active region:
   - `DE`, `AT`, `CH`, `FR`, `BE`, `NL`, `PL`, `CZ`, `IT`, `ES`, `PT`, … → `eu-frankfurt`
   - `GB`, `IE`, `DK`, `SE`, `NO`, `FI` → `eu-frankfurt` (fallback) or `eu-strasbourg` if capacity-balanced
   - `US`, `CA`, `MX` → `us-ashburn`
   - `SG`, `AU`, `NZ`, `JP`, `KR`, `IN`, `HK`, `TW` → `apac-singapore`
   - All other countries → nearest region with available capacity
3. **Capacity balancing** — if the primary region for a country is at > 80% worker CPU utilisation, route to the next-nearest region instead.
4. **Plan tier** — Business and Premium clients always go to the highest-spec cluster in their geography; Starter clients can go to the secondary cluster in the region.
5. **Compliance flag** — if `data_residency = "EU"` is set on the client record, never assign to `us-ashburn` or `apac-singapore`.

| Field | Column | Possible Values |
|-------|--------|----------------|
| Assigned region | `customers.region` | `eu-frankfurt`, `eu-strasbourg`, `us-ashburn`, `apac-singapore` |
| Data residency flag | `customers.data_residency` | `EU`, `US`, `APAC`, `none` |
| Region override | `customers.region_locked` | boolean — if true, ignore capacity rebalancing |

**Implementation in Management API:**

```typescript
// backend/src/services/regionAssignment.ts

const COUNTRY_TO_REGION: Record<string, string> = {
  DE: 'eu-frankfurt', AT: 'eu-frankfurt', CH: 'eu-frankfurt',
  FR: 'eu-frankfurt', BE: 'eu-frankfurt', NL: 'eu-frankfurt',
  IT: 'eu-frankfurt', ES: 'eu-frankfurt', PL: 'eu-frankfurt',
  GB: 'eu-frankfurt', IE: 'eu-frankfurt', DK: 'eu-frankfurt',
  SE: 'eu-frankfurt', NO: 'eu-frankfurt', FI: 'eu-frankfurt',
  US: 'us-ashburn',   CA: 'us-ashburn',   MX: 'us-ashburn',
  SG: 'apac-singapore', AU: 'apac-singapore', JP: 'apac-singapore',
  KR: 'apac-singapore', IN: 'apac-singapore', HK: 'apac-singapore',
};
const FALLBACK_REGION = 'eu-frankfurt';
const CAPACITY_THRESHOLD = 0.80; // 80% CPU utilisation

export async function assignRegion(
  countryCode: string,
  plan: string,
  dataResidency: string | null,
  adminOverride: string | null,
): Promise<string> {
  // 1. Admin override
  if (adminOverride) return adminOverride;

  // 2. Country → preferred region
  let preferred = COUNTRY_TO_REGION[countryCode] ?? FALLBACK_REGION;

  // 3. Data residency constraint
  if (dataResidency === 'EU' && !preferred.startsWith('eu-')) {
    preferred = 'eu-frankfurt';
  }

  // 4. Capacity check — fall back to next-nearest if overloaded
  const utilisation = await getRegionCpuUtilisation(preferred);
  if (utilisation > CAPACITY_THRESHOLD) {
    preferred = await getNearestAvailableRegion(preferred, dataResidency);
  }

  return preferred;
}
```

The region is stored on the `customers` row at creation time. The management API reads `customers.region` on every provisioning request and routes the Kubernetes API call to the correct cluster's kubeconfig (stored in Sealed Secrets, keyed by region slug).

### DNS Management Across Providers

**Challenge:** Each provider hosts client domains on different ingress IPs

**Solution:**

A single authoritative PowerDNS instance runs in the Frankfurt cluster and is the **sole source of truth** for all client DNS zones, regardless of which regional cluster the client lives on. Secondary PowerDNS instances in each additional region receive zone data via AXFR (zone transfer) from Frankfurt.

When a client is assigned to a non-Frankfurt region, the management API creates the DNS A record pointing to that region's ingress IP — not Frankfurt's. GeoDNS (Phase 3) is layered on top to steer queries to the nearest healthy region without clients needing to change DNS settings.

**Recommended: Centralized PowerDNS**

```
Frankfurt (ns1.platform.example.com) — primary/master
  │
  ├─ AXFR ──► OVH Strasbourg (ns2.platform.example.com) — secondary
  ├─ AXFR ──► Linode Ashburn  (ns3.platform.example.com) — secondary (Phase 2+)
  └─ AXFR ──► Hetzner Singapore (ns4.platform.example.com) — secondary (Phase 3+)

Client domain NS delegation: example-client.com NS → ns1 + ns2 (+ ns3/ns4 as added)

A record for a Frankfurt client:  example-client.com A 65.21.x.x   (Frankfurt ingress)
A record for a Strasbourg client: example-client.com A 51.89.x.x   (OVH Strasbourg ingress)
A record for an Ashburn client:   example-client.com A 172.105.x.x (Linode ingress)
```

DNS-01 ACME challenges are answered by Frankfurt PowerDNS for all clients regardless of region, since all zones are authoritative there. HTTP-01 (CNAME mode) is answered by the client's ingress pod in whichever region they're on.

**API for domain creation:**

```http
POST /api/v1/admin/customers/{id}/domains
Content-Type: application/json
Authorization: Bearer <admin-token>

{
  "domain": "example-client.com",
  "dns_mode": "primary",
  "region": "eu-strasbourg"
}
```

The management API resolves the target ingress IP from the region's node pool and calls the PowerDNS REST API (`POST /api/v1/servers/localhost/zones`) to create the zone with the correct A record. The response includes the assigned nameservers the client must delegate to:

```json
{
  "domain": "example-client.com",
  "zone_id": "example-client.com.",
  "nameservers": ["ns1.platform.example.com", "ns2.platform.example.com"],
  "a_record": "51.89.45.12",
  "region": "eu-strasbourg",
  "dns_mode": "primary"
}
```

On client migration between regions (e.g. Strasbourg → Frankfurt), the management API issues a `PATCH /api/v1/servers/localhost/zones/{zone}/records` call to update the A record and observes the 60-second TTL drain before completing the migration (per ADR-014).

---

## Data Synchronization Between Providers

### What Needs to Sync

| Data Type | Frequency | Method | Priority |
|-----------|-----------|--------|----------|
| **Client metadata** | Real-time | Central DB + replication | High |
| **Database backups** | Daily | mysqldump/pg_dump → external SFTP | High |
| **File backups** | Daily | rsync --archive → offsite server (SSHFS) | High |
| **DNS zones** | Nightly | Zone file export → sync to all | Medium |
| **Configuration** | On-change | Git + push to all clusters | Medium |
| **Secrets** | Real-time | Sealed Secrets sync or external Vault | High |

### Synchronization Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    DATA SYNC OVERVIEW                            │
│                                                                  │
│  Hetzner Frankfurt (primary)                                     │
│  ├── PostgreSQL master ──pglogical──► OVH Strasbourg replica     │
│  │                      (real-time, Phase 2+)                    │
│  ├── Sealed Secrets ──Git push──► All clusters (on-change)       │
│  ├── k8s manifests  ──Flux v2──► All clusters (5-min poll)       │
│  └── SFTP backup server                                          │
│       └── nightly rsync ──────────► OVH SFTP backup             │
│                           └────────► Linode SFTP backup          │
│                                └────► Singapore SFTP backup      │
│                                                                  │
│  Phase 1 (single region): no cross-region sync                   │
│  Phase 2 (warm standby):  nightly backup sync only               │
│  Phase 3+ (multi-region): pglogical real-time + nightly backups  │
└──────────────────────────────────────────────────────────────────┘
```

| Layer | Tool | Direction | Frequency | Phase |
|-------|------|-----------|-----------|-------|
| Client metadata (PostgreSQL) | pglogical | Bi-directional | Real-time | 2+ |
| Platform config (k8s manifests) | Flux v2 + Git | Push to all | On-change (5-min poll) | 1+ |
| Secrets (Sealed Secrets) | Git push | Push to all | On-change | 1+ |
| Database backups | rsync via SSHFS | Primary → all | Nightly 02:00 UTC | 2+ |
| File backups | rsync via SSHFS | Primary → all | Nightly 03:00 UTC | 2+ |
| DNS zones | PowerDNS AXFR | Primary → secondaries | On-change + nightly | 1+ |
| Container images | Harbor replication | Push to all Harbor instances | On publish | 2+ |

### Handling Provider Outages

**Scenario: Hetzner Frankfurt goes down**

```
T+0:00   Prometheus health check fails (all Frankfurt nodes unreachable)
T+0:05   AlertManager fires: "CRITICAL: Region hetzner-eu down"
         Admin notified via email + Slack + PagerDuty
T+0:10   Admin assesses: estimated downtime > 30 minutes → trigger failover

Phase 2 (manual failover):
T+0:15   Admin activates OVH Strasbourg cluster via Admin Panel → C.4 Region Failover
T+0:20   Management API updates client DNS A records to OVH Strasbourg ingress IPs
         (TTL 300s → full propagation within 5 minutes)
T+0:25   New client requests served from Strasbourg
         Data state: up to 24 hours behind (last nightly backup)
T+0:45   All clients restored from most recent Strasbourg backup copies

Phase 3 (automated failover):
T+0:05   GeoDNS health check detects Frankfurt down → routes EU traffic to Strasbourg
T+0:05   PostgreSQL pglogical: Strasbourg already has real-time replica → 0 data loss
T+0:05   All EU clients seamlessly served from Strasbourg — no manual intervention
```

**Cost of manual failover (Phase 2):** 15–45 minutes downtime, up to 24 hours data loss
**Cost of automated failover (Phase 3):** ~0 minutes downtime, 0 data loss (requires real-time replication)

---

## Cost Analysis: Single Cloud vs Multi-Cloud

### Single Cloud (Hetzner Only)

| Component | Spec | Cost/mo |
|-----------|------|---------|
| 1× control plane (cx21: 2vCPU / 4 GB) | Hetzner Frankfurt | ~€6 |
| 1× worker node (cx31: 2vCPU / 8 GB) | Hetzner Frankfurt | ~€11 |
| 200 GB block storage (Longhorn) | Hetzner Volume | ~€10 |
| External SFTP backup server | Hetzner StorageBox 1 TB | ~€4 |
| Bandwidth (included) | Hetzner | €0 |
| **Total** | | **~€31/mo** |

Scales to: ~€50/mo with a larger worker (cx41: 4vCPU / 16 GB). Supports 0–100 clients.

### Multi-Cloud with Warm Standby (Recommended Phase 1-2)

| Component | Spec | Cost/mo |
|-----------|------|---------|
| Hetzner Frankfurt cluster (as above) | Primary | ~€31 |
| OVH Strasbourg — 1× VPS (B2-7: 2vCPU / 7 GB) | Standby | ~€18 |
| OVH Strasbourg — 100 GB block storage | Standby storage | ~€5 |
| OVH Strasbourg SFTP backup | Standby backup | ~€4 |
| Extra bandwidth (cross-region backup sync ~50 GB/night) | ~€2 |
| **Total** | | **~€60/mo** |

Extra cost over single cloud: **~€29/mo**. Supports 50–300 clients with 15–60 min RTO on Hetzner failure.

### Full Disaster Recovery (Phase 3+)

| Component | Provider | Spec | Cost/mo |
|-----------|----------|------|---------|
| EU primary cluster | Hetzner Frankfurt | 3× cx41 workers | ~€90 |
| EU secondary cluster | OVH Strasbourg | 2× B2-15 workers | ~€60 |
| US cluster | Linode Ashburn | 2× Linode 8GB | ~$60 (~€55) |
| APAC cluster | Hetzner Singapore | 2× cx31 workers | ~€22 |
| Cross-region SFTP backup servers (×4) | Mix | StorageBox equiv. | ~€20 |
| GeoDNS service | Cloudflare or self-hosted | — | ~€10 |
| Cross-provider bandwidth (replication) | — | ~200 GB/day | ~€20 |
| **Total** | | | **~€277/mo** |

Supports 300+ clients globally with 0 min automated failover (Phase 3). Real-time replication required.

### Cost Comparison: When Multi-Cloud Becomes Worth It

| Monthly clients | Estimated MRR (avg €15/client) | Single cloud cost | Warm standby cost | Multi-region cost | Recommendation |
|-----------------|-------------------------------|-------------------|-------------------|-------------------|---------------|
| 10 | €150 | €31 (21%) | €60 (40%) | €277 (185%) | Single cloud |
| 50 | €750 | €50 (7%) | €60 (8%) | €277 (37%) | Single cloud |
| 100 | €1,500 | €50 (3%) | €60 (4%) | €277 (18%) | Warm standby |
| 150 | €2,250 | €80 (4%) | €90 (4%) | €277 (12%) | **Warm standby** |
| 300 | €4,500 | €120 (3%) | €130 (3%) | €277 (6%) | **Multi-region** |
| 500 | €7,500 | €200 (3%) | €210 (3%) | €277 (4%) | Multi-region |

**Recommendation:**
- **Months 0-3 (< 100 clients):** Single cloud (Hetzner only) — lowest complexity
- **Months 3-6 (100–150 clients):** Add warm standby OVH (~€29/mo extra — worth it at this revenue level)
- **Months 6+ (150+ clients):** Full multi-region setup — infrastructure cost drops to < 10% of MRR

---

## Operational Complexity Analysis

### Complexity by Phase

| Phase | Setup Providers | Clusters | DNS Mgmt | Data Sync | Failover | Operational Load |
|-------|---|---|---|---|---|---|
| Phase 1 | Hetzner only | 1 | Simple | None | N/A | 🟢 Low |
| Phase 2 | Hetzner + OVH | 2 (1 standby) | Moderate | Nightly | Manual | 🟡 Medium |
| Phase 3 | H + OVH + Linode | 3 (2 active) | Complex | Real-time | Automatic | 🟠 High |

### Operational Responsibilities

#### Phase 1 (Single Cloud)
- ✅ Monitor Hetzner cluster health
- ✅ Daily backups to external SFTP
- ✅ Certificate management (cert-manager handles)
- ✅ DNS management (PowerDNS, single provider)

#### Phase 2 (Primary + Warm Standby)
- ✅ Monitor both Hetzner and OVH
- ✅ **NEW:** Nightly sync of critical data (DB, files, DNS)
- ✅ **NEW:** Test failover procedures (monthly)
- ✅ **NEW:** Maintain OVH standby cluster (patching, updates)
- ✅ **NEW:** Manual failover runbook (when needed)

#### Phase 3 (Full Disaster Recovery)
- ✅ Monitor all three clusters
- ✅ **NEW:** Real-time data replication between Hetzner/OVH
- ✅ **NEW:** Automated DNS failover (GeoDNS)
- ✅ **NEW:** Health checks across all providers
- ✅ **NEW:** Client migration during failures (automated)

### Automation to Reduce Complexity

**Recommended tools:**
- **Terraform:** Infrastructure-as-Code for all providers
- **Flux v2:** GitOps for cluster deployments + syncing
- **Velero + rsync --archive:** Automated cross-provider backups
- **External DNS:** Automatic DNS management
- **Prometheus + AlertManager:** Health monitoring across clusters
- **Custom Python/Go scripts:** Failover automation, data sync

---

## Decision Matrix: Should You Multi-Cloud?

### Go Multi-Cloud IF:

✅ **Compliance requires:** EU data in EU, US data in US
✅ **Clients demand:** Geographic redundancy or high-SLA
✅ **Risk tolerance:** Can't accept single-provider outages
✅ **Scaling to:** 150+ clients where cost justifies it
✅ **Team capacity:** Can handle moderate complexity

### Stay Single-Cloud IF:

❌ **Budget tight:** Every €40/mo matters (months 0-6)
❌ **Team small:** Don't want operational overhead
❌ **Early stage:** MVP is priority, risk acceptable
❌ **Compliance simple:** No data residency requirements
❌ **Can rebuild quickly:** Hetzner's backups sufficient for RTO

---

## Recommended Path for You

**Given your requirements (geographic distribution, moderate complexity):**

### Months 0-3: Single Cloud (Hetzner Frankfurt)

- Deploy single k3s cluster on Hetzner Frankfurt (1 control + 1 worker)
- Daily backups to Hetzner StorageBox via SSHFS mount
- No cross-region sync — single region, simple operations
- All clients on Frankfurt; admin access via NetBird mesh
- Target: first Plesk migration complete, 10–50 clients onboarded
- **Infrastructure cost: ~€31–50/mo**

### Months 3-6: Add Warm Standby (OVH Strasbourg)

- Provision OVH Strasbourg cluster (1 smaller worker node — standby only)
- Set up nightly cross-region backup sync: Frankfurt SFTP → Strasbourg SFTP
- Configure PowerDNS AXFR replication: Frankfurt ns1 → Strasbourg ns1
- Write and test manual failover runbook (monthly drills)
- OVH cluster stays idle unless Frankfurt fails — minimal ongoing cost
- Target: 50–150 clients, 99.9% SLA achievable with 15–60 min manual failover
- **Additional cost: ~€29/mo → total ~€60–80/mo**

### Months 6-12: Geographic Distribution

- Scale Strasbourg to a full active cluster (promote from standby to active)
- Route 20% of new EU Starter clients to Strasbourg (load distribution)
- Deploy Linode Ashburn cluster for US-based clients
- Implement geographic routing in PowerDNS (GeoIP → nearest region A record)
- Enable pglogical real-time replication between Frankfurt ↔ Strasbourg
- Expand Harbor to replicate images to all 3 clusters
- Target: 150–300 clients across EU + US, 99.9%+ uptime
- **Total cost: ~€180–250/mo**

### Months 12+: Full Disaster Recovery

- Implement automated GeoDNS failover (Cloudflare or self-hosted)
- Add Hetzner Singapore for APAC clients
- Achieve automated failover: Frankfurt failure → Strasbourg takes over EU in < 5 min
- Real-time PostgreSQL replication across all regions (pglogical multi-master)
- Full Flux v2 GitOps across all 4 clusters from single Git repo
- SLA target: 99.95%+ (< 4.4 hours/year downtime)
- **Total cost: ~€250–400/mo for 300+ clients**

---

## Implementation Checklist

### Immediate Actions (Months 0-3)

- [ ] Deploy to Hetzner Frankfurt (single cluster)
- [ ] Implement daily backups to external SFTP
- [ ] Set up PowerDNS for centralized DNS management
- [ ] Document client → provider assignment logic
- [ ] Create Terraform modules for reproducible deployments

### Short Term (Months 3-6)

- [ ] Deploy OVH Strasbourg cluster (warm standby)
- [ ] Implement nightly data sync (databases, files, DNS zones)
- [ ] Create failover runbook (manual procedures)
- [ ] Test failover procedure monthly
- [ ] Set up monitoring across both clusters
- [ ] Automate standby cluster patching/updates

### Medium Term (Months 6-12)

- [ ] Deploy Linode Ashburn cluster (US clients)
- [ ] Implement geographic routing in DNS
- [ ] Create per-region management dashboards
- [ ] Set up per-region backup/restore procedures
- [ ] Test cross-provider client migration

### Long Term (Months 12+)

- [ ] Implement real-time etcd federation (Hetzner ↔ OVH)
- [ ] Automate DNS failover with GeoDNS
- [ ] Deploy APAC region (Hetzner Singapore or OVH Singapore)
- [ ] Achieve 99.95%+ uptime SLA
- [ ] Implement automated client failover

---

## Terraform: Multi-Cloud Infrastructure as Code

All infrastructure is defined in `terraform/` using the monorepo structure from `PHASE_1_ROADMAP.md`. Provider credentials are stored as GitHub Secrets and passed via environment variables — never hardcoded.

### Single Cloud Setup (Starting Point)

```hcl
# terraform/environments/frankfurt.tfvars
region         = "hetzner-eu-central"
control_planes = 1
workers        = 1
worker_type    = "cx31"   # 2 vCPU / 8 GB / €11/mo
storage_gb     = 200

# terraform/main.tf (simplified)
module "frankfurt" {
  source       = "./modules/hetzner-cluster"
  location     = "nbg1"   # Nuremberg (Hetzner Frankfurt zone)
  server_type  = var.worker_type
  worker_count = var.workers
  ssh_key_name = "platform-admin"
  labels       = { region = "eu-frankfurt", role = "worker" }
}

output "worker_ips" {
  value = module.frankfurt.worker_public_ips
}
```

### Multi-Cloud Setup (Hetzner + OVH)

```hcl
# terraform/environments/multi-cloud.tfvars
hetzner_workers = 2
ovh_workers     = 1   # standby — smaller instance
linode_workers  = 1   # US region

# terraform/main.tf (multi-cloud)
module "hetzner_eu" {
  source       = "./modules/hetzner-cluster"
  location     = "nbg1"
  server_type  = "cx41"
  worker_count = var.hetzner_workers
  labels       = { region = "eu-frankfurt", role = "worker" }
}

module "ovh_eu" {
  source       = "./modules/ovh-cluster"
  region       = "GRA11"   # Gravelines / Strasbourg zone
  flavor_name  = "b2-7"    # 2 vCPU / 7 GB
  worker_count = var.ovh_workers
  labels       = { region = "eu-strasbourg", role = "standby" }
}

module "linode_us" {
  source       = "./modules/linode-cluster"
  region       = "us-east"   # Ashburn, VA
  type         = "g6-standard-4"   # 2 vCPU / 4 GB
  worker_count = var.linode_workers
  labels       = { region = "us-ashburn", role = "worker" }
}
```

### Module: Reusable K8s Cluster

```hcl
# terraform/modules/hetzner-cluster/main.tf
variable "location"     { type = string }
variable "server_type"  { type = string }
variable "worker_count" { type = number }
variable "ssh_key_name" { type = string }
variable "labels"       { type = map(string) }

resource "hcloud_server" "worker" {
  count       = var.worker_count
  name        = "worker-${var.location}-${count.index + 1}"
  server_type = var.server_type
  location    = var.location
  image       = "debian-12"
  ssh_keys    = [data.hcloud_ssh_key.admin.id]
  labels      = var.labels

  user_data = templatefile("${path.module}/templates/k3s-agent.sh.tpl", {
    k3s_url   = var.k3s_server_url
    k3s_token = var.k3s_token
    node_name = "worker-${var.location}-${count.index + 1}"
  })
}

resource "hcloud_volume" "longhorn" {
  count    = var.worker_count
  name     = "longhorn-${var.location}-${count.index + 1}"
  size     = 100   # GB per worker
  location = var.location
  format   = "ext4"
}

resource "hcloud_volume_attachment" "longhorn" {
  count     = var.worker_count
  volume_id = hcloud_volume.longhorn[count.index].id
  server_id = hcloud_server.worker[count.index].id
  automount = true
}

output "worker_public_ips" {
  value = hcloud_server.worker[*].ipv4_address
}
```

---

## Migration Path: Single → Multi-Cloud

### Step 1: Deploy on Hetzner Only (Day 1)

```bash
cd terraform
terraform init
terraform apply -var-file=environments/frankfurt.tfvars

# Bootstrap k3s on the provisioned nodes
# (Terraform outputs the IPs; bootstrap script runs via NetBird mesh)
./scripts/bootstrap-k3s.sh --role=server --ip=$(terraform output -raw control_plane_ip)
./scripts/bootstrap-k3s.sh --role=agent  --ip=$(terraform output -raw worker_ip) \
  --server=$(terraform output -raw control_plane_ip)

# Verify cluster
kubectl get nodes
# NAME              STATUS   ROLES                  AGE
# control-nbg1-1    Ready    control-plane,master   2m
# worker-nbg1-1     Ready    <none>                 1m
```

### Step 2: Add OVH Standby (Month 3)

```bash
# Provision OVH standby node
terraform apply -var-file=environments/multi-cloud.tfvars \
  -target=module.ovh_eu

# Bootstrap k3s agent on OVH node — joins Frankfurt cluster
./scripts/bootstrap-k3s.sh --role=agent \
  --ip=$(terraform output -raw ovh_worker_ip) \
  --server=$(terraform output -raw hetzner_control_plane_ip) \
  --label="region=eu-strasbourg,role=standby"

# Set up nightly backup sync: Frankfurt SFTP → Strasbourg SFTP
kubectl apply -f k8s/base/cronjobs/cross-region-backup-sync.yaml

# Configure PowerDNS AXFR to Strasbourg ns
kubectl exec -n platform deploy/powerdns -- \
  pdnsutil set-meta platform.internal SLAVE-NOTIFY-TYPE NOTIFY-SLAVES
```

### Step 3: Add Linode US (Month 6)

```bash
# Provision Linode US node
terraform apply -var-file=environments/multi-cloud.tfvars \
  -target=module.linode_us

# Bootstrap as independent k3s cluster (separate US region — not joined to EU)
./scripts/bootstrap-k3s.sh --role=server \
  --ip=$(terraform output -raw linode_us_ip) \
  --region=us-ashburn

# Deploy platform services to US cluster via Flux
kubectl config use-context linode-us-ashburn
flux bootstrap github \
  --owner=hosting-platform \
  --repository=hosting-platform \
  --branch=main \
  --path=k8s/overlays/us-ashburn

# Set up pglogical replication: Frankfurt → Linode (metadata sync)
kubectl apply -f k8s/base/postgres/pglogical-subscription-us.yaml
```

---

## Summary Table: Multi-Cloud Decision

| Aspect | Single Cloud | Multi-Cloud (Warm Standby) | Multi-Cloud (Full HA) |
|--------|---|---|---|
| **Cost** | €50/mo | €90/mo | €180+/mo |
| **Complexity** | Low | Medium | High |
| **Uptime SLA** | 99.5% | 99.9% (if failover works) | 99.95%+ |
| **Failover time** | N/A | 15-60 min | 0 min (auto) |
| **Data loss risk** | High (24h+) | Low (<24h) | None |
| **Team size needed** | 1 DevOps | 1.5-2 DevOps | 2-3 DevOps |
| **When to adopt** | Month 0 | Month 3-6 | Month 12+ |
| **Clients supported** | 0-100 | 50-300 | 300+ |

---

**BOTTOM LINE:** Yes, absolutely mix cloud providers. Start with single cloud, add a warm standby at month 3, then expand to multi-region at month 6. The extra operational complexity is worth it once you have sufficient clients.

**File:** `./MULTI_CLOUD_STRATEGY.md`
