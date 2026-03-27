# Infrastructure Sizing & Cost Optimization

## Overview

This document covers compute cluster topology, namespace strategy, networking configuration, and cost optimization strategies for supporting client workloads at various scales.

**Key design principle:** Start with the minimum viable cluster on a single provider (Hetzner), enable HA features incrementally as the business grows.

## Kubernetes Cluster Topology

### Initial Deployment (Minimal)

Recommended for launch with 50-100 clients.

| Parameter | Value |
| --- | --- |
| Cluster count | Single cluster |
| **Kubernetes distribution** | **k3s (lightweight)** |
| Control plane | **1 node** (single control plane — HA is optional upgrade) |
| Worker nodes | **1-2 nodes** (general-purpose, 4vCPU/8Gi minimum) |
| Auto-scaling | Manual (add worker nodes as capacity increases) |
| **Operating System** | **Debian 13** |
| **Container runtime** | **containerd** (k3s default) |
| **CNI Plugin** | **Calico** (required for NetworkPolicy enforcement from day one — see architecture review) |

### Phase 1 Single-Node Resource Budget (4vCPU / 8Gi)

The following resource budget validates that all platform services fit on a single Hetzner CX32 (4 vCPU, 8 GB RAM, 80 GB NVMe). **Services deferred to Phase 2 are excluded.**

| Service | CPU Request | Memory Request | CPU Limit | Memory Limit | Notes |
|---------|-------------|----------------|-----------|--------------|-------|
| **k3s control plane** | 500m | 512Mi | — | — | Built-in overhead (API server, etcd, scheduler) |
| **NGINX Ingress (DaemonSet)** | 100m | 128Mi | 500m | 512Mi | Single pod on single node |
| **Calico** | 150m | 128Mi | 300m | 256Mi | CNI + NetworkPolicy enforcement |
| **cert-manager** | 50m | 64Mi | 200m | 128Mi | |
| **Sealed Secrets** | 50m | 32Mi | 100m | 64Mi | |
| **MariaDB (platform only)** | 100m | 256Mi | 500m | 1Gi | Platform admin data only; client DBs are per-client StatefulSets (add-on). See ADR-024. |
| **PostgreSQL (platform)** | 100m | 128Mi | 500m | 512Mi | Platform metadata only |
| **Redis (platform)** | 50m | 64Mi | 200m | 256Mi | Platform cache + fail2ban bans only. Client Redis is per-client add-on. |
| **Management API** | 100m | 128Mi | 500m | 512Mi | Node.js Fastify |
| **Admin Panel** | 50m | 64Mi | 200m | 128Mi | Static React SPA |
| **Client Panel** | 50m | 64Mi | 200m | 128Mi | Static React SPA |
| **Prometheus + Alertmanager** | 100m | 256Mi | 500m | 512Mi | 7-day retention |
| **Loki** | 100m | 128Mi | 300m | 256Mi | 14-day retention |
| **Grafana** | 50m | 64Mi | 200m | 256Mi | |
| **Docker-Mailserver** | 200m | 256Mi | 500m | 1Gi | Postfix + Dovecot + Rspamd |
| **Roundcube** | 50m | 64Mi | 200m | 128Mi | |
| **Client web pods (10 initial)** | 500m | 640Mi | 5000m | 2560Mi | 10 dedicated pods × 50m/64Mi request each (ADR-024) |
| **SFTP Gateway** | 50m | 64Mi | 200m | 256Mi | |
| **Flux v2** | 50m | 64Mi | 200m | 128Mi | GitOps controller |
| **TOTALS** | **2450m** | **3076Mi** | — | — | With 10 initial client pods |
| **Node capacity** | **4000m** | **8192Mi** | — | — | |
| **Remaining headroom** | **1550m** | **5116Mi** | — | — | For additional client pods (~50m/64Mi each) + DB add-ons (~100m/150Mi each) |

**Key Phase 1 decisions:**
- **No Harbor** — Use GitHub Container Registry or pre-built images imported via `ctr image import`. Harbor deferred to Phase 2 (saves ~1Gi RAM, 500m CPU).
- **No Longhorn** — Use k3s built-in `local-path` provisioner. Longhorn replication is pointless on single node (saves ~512Mi RAM, 250m CPU).
- **Dedicated pods for all clients** (ADR-024) — no shared pod management. Each client gets ~50m CPU / 64Mi memory request. Scale-to-zero via KEDA for idle sites.
- **Prometheus 7-day retention** — Reduced from 15 days. Saves disk space on 80GB NVMe.
- **Grafana optional** — Can be omitted initially and accessed via port-forward when needed.

**Phase 2 additions** (when expanding to 2+ nodes):
- Longhorn (replicated storage)
- Harbor (container registry)
- Additional worker nodes for client pod capacity
- Scaled platform MariaDB resources
- Tempo (distributed tracing)

### HA Upgrade Path (Optional)

Enable incrementally as the business grows or cost justifies investment. For step-by-step migration procedures, see **`HA_MIGRATION_RUNBOOK.md`**.

| HA Feature | Initial | Upgrade To | When to Enable |
| --- | --- | --- | --- |
| Control plane nodes | 1 | 3 (etcd quorum) | When downtime is unacceptable |
| Worker nodes | 1-2 | 3+ (N+1 redundancy) | When single node can't fit all workloads |
| DB replication | Single | Primary + replica | When DB downtime risk is too high |
| Ingress controller (DaemonSet) | 1 per worker (auto) | Scales automatically with workers | Automatic — DaemonSet adds pod per new worker |
| Longhorn replication factor | 1 | 2-3 | When adding storage nodes |
| Storage capacity (per node) | Node local disk only | + Hetzner volume attached as Longhorn disk | When Longhorn utilisation >70% but compute headroom remains (€0.04/GB/month — cheaper than a new node) |
| Pod disruption budgets | None | Set for platform services | When running multi-node |
| Anti-affinity rules | None | Spread platform services across nodes | When running 3+ nodes |
| Multi-region / multi-cluster | No | Evaluate for DR | At scale or compliance requirement |

## Namespace Strategy

| Namespace | Purpose | Who Lives Here |
| --- | --- | --- |
| `platform` | Management API/UI, catalog service, DNS API client, Git deploy, platform DB/Redis | Core platform services |
| `ingress` | Ingress controller, WAF, fail2ban controller | Traffic routing |
| `auth` | OIDC token validation proxy (oauth2-proxy or similar) | Relays to external OIDC provider per ADR-022 |
| `monitoring` | Prometheus, Grafana, Loki, Alertmanager | Observability stack |
| `mail` | Docker-Mailserver, Roundcube webmail, app password service | Email stack |
| `backup` | Velero, backup CronJobs | Backup operations |
| `sftp` | SFTP gateway service | File access |
| `client-{id}` | One namespace per client — **all plans** (auto-provisioned, ADR-024) | Dedicated pod, PVC, secrets, NetworkPolicies, optional MariaDB StatefulSet (DB add-on) |
| `app-{appid}-{instance}` | Application instances from Application Catalog | Catalog apps (Nextcloud, Jitsi, etc.) |

> **Every client gets a `client-{id}` namespace** (ADR-024) with their own dedicated pod, PVC, secrets, and NetworkPolicies. This provides full Kubernetes-native isolation regardless of plan tier. The previous `hosting` shared namespace has been eliminated.
>
> Clients with the database add-on also have a MariaDB StatefulSet in their namespace (~100-150Mi RAM each).

## Networking Configuration

| Component | Decision |
| --- | --- |
| **CNI plugin** | **Calico** (required from Phase 1 for NetworkPolicy enforcement between client namespaces) |
| Service mesh | Not initially — evaluate Linkerd if mTLS needed at scale |
| **Ingress controller** | **NGINX Ingress Controller** (with ModSecurity WAF) — Traefik disabled |
| **DNS (external)** | **External PowerDNS API** (configurable endpoint in admin panel; see ADR-022) |
| DNS (internal/cluster) | CoreDNS (Kubernetes default, built-in to k3s) |
| **Traffic routing** | **DNS-based ingress routing** — NGINX DaemonSet + PowerDNS multi-A records (no Floating IP / MetalLB). See ADR-014. |
| Network policies | Default-deny per client namespace; explicit allow for ingress controller and shared services |
| Pod-to-pod across clients | Denied — NetworkPolicy blocks all cross-namespace client traffic |

## Cost Optimization Strategies

### 1. Dedicated Pods with Resource Overcommit (ADR-024)

All clients get dedicated pods. Cost efficiency comes from low resource requests (Burstable QoS), scale-to-zero, and database-as-add-on:

| Strategy | How It Saves |
| --- | --- |
| **Low CPU/memory requests** | Starter pods request only 50m CPU / 64Mi RAM — node can fit ~60 Starter pods per 4vCPU/8Gi worker |
| **Scale-to-zero (KEDA)** | Idle dedicated pods scale to zero after configurable timeout, freeing resources |
| **Database as add-on** | ~90% of clients don't use databases; no MariaDB overhead for them. DB clients get dedicated StatefulSet (~100-150Mi each) |
| **No shared infrastructure overhead** | No ProxySQL, no shared Redis ACLs, no shared pod pool management |

**At 50 clients (45 without DB, 5 with DB add-on):**
- **Web pods:** 50 × 50m/64Mi = 2.5vCPU / 3.2Gi requests
- **DB add-ons:** 5 × 100m/150Mi = 0.5vCPU / 0.75Gi requests
- **Platform services:** ~2vCPU / 3Gi
- **Total:** ~5vCPU / 7Gi requests → fits on 2× CX31 nodes (4vCPU/8Gi, ~$10/month each)

### 2. Resource Overcommit & Density

Most web hosting clients use a fraction of their allocated resources most of the time. Design for this reality:

| Strategy | Implementation |
| --- | --- |
| **Low requests, higher limits** | Set CPU request to 50m, limit to 500m-2000m. Pods get burst capacity without reserving resources. |
| **Memory request < limit** | Request 128Mi, limit 512Mi. Allows node-level overcommit. |
| **QoS class: Burstable** | All client pods run as Burstable (not Guaranteed). Platform services run as Guaranteed. |
| **Scale-to-zero (KEDA)** | Idle dedicated pods scale to zero after configurable timeout, reducing active pod count by 30-50% during off-peak. |
| **Database as add-on** | Only ~10% of clients need databases. Per-client MariaDB StatefulSet (~100-150Mi) provisioned only when add-on is enabled. See ADR-024. |

### 3. Deployment Sizing Examples

| Deployment Stage | Nodes | Total Clients | DB Add-on Clients | Total Pods | Est. Monthly Cost |
| --- | --- | --- | --- | --- | --- |
| **Minimal (initial)** | 1 CP + 1 worker (4vCPU/8Gi) | Up to 50 | Up to 10 | ~65-75 | ~$30-60 |
| **Small** | 1 CP + 2 workers (4vCPU/8Gi) | Up to 100 | Up to 20 | ~130-150 | ~$60-100 |
| **Medium** | 1 CP + 2 workers (8vCPU/16Gi) | Up to 200 | Up to 40 | ~260-300 | ~$100-200 |
| **HA-enabled** | 3 CP + 3 workers (8vCPU/16Gi) | 300+ | 50+ | ~400+ | ~$300-500 |

**Recommendation:** Start with the **Minimal** deployment (1 control plane + 1 worker). A single 4 vCPU / 8Gi worker node can comfortably host:
- 50 dedicated client pods (50m/64Mi request each = 2.5vCPU/3.2Gi total)
- 5-10 database add-on StatefulSets (~100m/150Mi each)
- All platform services (~2vCPU/3Gi)
- Scale-to-zero reduces active pod count during off-peak

Scale by adding worker nodes. Enable HA only when business justifies the cost.

### 4. Scale-to-Zero for Inactive Dedicated Sites

Since all clients now have dedicated pods (ADR-024), scale-to-zero is a key cost optimization strategy. Many client sites receive little to no traffic for extended periods — scale-to-zero eliminates resource consumption for idle sites.

| Component | Implementation |
| --- | --- |
| **Applies to** | **All plans** — optional per client (configurable by admin/client) |
| **Scale-to-zero tool** | **KEDA** (Kubernetes Event-Driven Autoscaling) with HTTP trigger |
| **Idle threshold** | Configurable: 15-30 minutes of no HTTP requests (admin-set default) |
| **Wake-up trigger** | Ingress controller routes request to activator; pod spins up in 2-5 seconds |
| **Cold start latency** | First request after idle: ~2-5 seconds (acceptable for low-traffic sites) |
| **Exclusions** | Premium plan clients can disable scale-to-zero if desired (always-on) |
| **Savings estimate** | Reduces dedicated pod count during off-peak hours by 30-50% |
| **Configuration** | Admin sets global scale-to-zero defaults; clients can opt-in/opt-out per application |

### 5. Container Image Layer Sharing

Because all clients use images from the same catalog:

- Node-level Docker layer cache is highly effective — base layers pulled once per node
- Upgrades only pull changed layers (not full images)
- Disk usage per client is minimal (just the client's PV, not a full image)

### 6. Lightweight Platform Components

| Choice | Why |
| --- | --- |
| **k3s over kubeadm** | ~50% less control plane memory, built-in ingress/LB options |
| **Loki over ELK** | 10x less memory than Elasticsearch |
| **Prometheus with retention limits** | 15-day local retention; long-term to offsite backup server if needed |
| **Alpine-based images** | 5-50MB vs. 200-800MB for Debian/Ubuntu-based |
| **Redis as add-on only** | Platform Redis ~50Mi; per-client Redis only for Premium/add-on clients |

## Cost Estimation Framework

### Initial Minimal Deployment (no HA) — Target: < $200/mo for 50-100 clients

| Component | Count | Est. Resources | Est. Monthly Cost |
| --- | --- | --- | --- |
| Control plane node | 1 | 2 vCPU / 4Gi | ~$8-12 |
| Worker node | 1 | 4 vCPU / 8Gi | ~$12-18 |
| Storage (Longhorn) | ~200Gi | Node local disk; expand via Hetzner volumes (€0.04/GB/month) | ~$5-10 |
| Bandwidth | ~100GB | Standard usage | ~$5-10 |
| **Total (minimal)** | | | **~$31-52/mo** |
| **With 3-4x buffer** | | | **~$100-200/mo** ✅ |

### Growth Deployment (with optional HA)

| Component | Count | Est. Resources | Est. Monthly Cost |
| --- | --- | --- | --- |
| Control plane nodes | 3 | 2 vCPU / 4Gi each | ~$24-36 |
| Worker nodes | 3 | 8 vCPU / 16Gi each | ~$36-54 |
| Storage (Longhorn) | ~500Gi | Replicated 2x | ~$10-15 |
| Bandwidth | ~500GB | Higher usage | ~$10-20 |
| **Total (HA)** | | | **~$82-124/mo** |

**Action items:**
- Price out on Hetzner (primary), OVH, and Linode for cost comparison
- **Target:** Keep initial deployment under $200/mo budget; scale HA only when business justifies it

## Per-Client Resource Stack (ADR-024)

All clients get the same resource stack structure. Plan differentiation is via resource limits and add-ons.

### All Plans (Dedicated Pod)

| Resource | Description |
| --- | --- |
| **Web runtime pod** | Dedicated pod running a catalog container image (e.g., `nginx-php84`) |
| **PersistentVolumeClaim** | Site files mounted at `/var/www/html` |
| **Ingress rules** | Per-domain routing with TLS certificates |
| **ResourceQuota** | CPU, memory, storage limits per hosting plan |
| **NetworkPolicy** | Default-deny + allow ingress controller + platform services |
| **ServiceAccount** | Scoped to client namespace only |
| **ConfigMap** | Client-specific config (PHP settings, vhost overrides) |
| **Secret** | SFTP credentials (auto-generated); DB credentials if add-on enabled |
| **Optional: MariaDB StatefulSet** | Database add-on (~100m CPU, ~150Mi RAM). Included in Premium; paid add-on for Starter/Business. |
| **Optional: Dedicated Redis** | Redis add-on (~50m CPU, ~64Mi RAM). Included in Premium; paid add-on for Business. |

**Resource requests by plan:**

| Plan | CPU Request | Memory Request | Estimated pods per 4vCPU/8Gi worker |
| --- | --- | --- | --- |
| Starter | 50m | 64Mi | ~60 (web pod only) |
| Business | 100m | 256Mi | ~30 (web pod only) |
| Premium | 200m + 100m (DB) + 50m (Redis) | 512Mi + 150Mi + 64Mi | ~10 (full stack) |

## Related Documentation

- **HOSTING_PLANS.md**: Plan definitions and resource allocations
- **STORAGE_DATABASES.md**: Database sizing and configuration
- **PLATFORM_ARCHITECTURE.md**: Overall platform design
- **MULTI_CLOUD_STRATEGY.md**: Multi-provider and geographic distribution options
- **DISASTER_RECOVERY.md**: HA and backup strategies
- **HA_MIGRATION_RUNBOOK.md**: Storage Expansion section — attaching Hetzner volumes as Longhorn disks
