# Multi-Node Infrastructure Roadmap

> Status: Planning (Phase 0 + Phase 3 in progress 2026-04-21)
> Last updated: 2026-04-21
> Principles: No vendor lock-in. Worker nodes before HA. Open-source stack only.
>
> **2026-04-21 update:** Phase 3 (Longhorn distributed storage) is being rolled out
> alongside Phase 0 (real-server bootstrap) because no production deployment exists
> yet — destructive reprovision is acceptable. See [`../04-deployment/STAGING_DEPLOYMENT.md`](../04-deployment/STAGING_DEPLOYMENT.md)
> and [`ADR-028`](../07-reference/ADR-028-backup-architecture.md). The migration
> script originally scoped in §3B is no longer needed — there is nothing to
> migrate.

## Overview

The platform currently runs on a single k3s server in a Docker-in-Docker (DinD) local dev environment. This roadmap describes the path from single-node DinD to a production multi-node cluster with worker nodes, workload mobility, distributed storage, high availability, and disaster recovery.

---

## Phase 0: Real Server Bootstrap (Bridge the Gap)

**Goal**: Deploy the platform on a real server while preserving DinD local dev capability.

### What Needs to Change

| Component | DinD (local) | Real Server |
|-----------|-------------|-------------|
| k3s | Docker container (`rancher/k3s`) | Native install on host OS |
| PostgreSQL | Docker Compose container | k3s Deployment + PVC |
| Redis | Docker Compose container | k3s Deployment |
| Backend | Docker Compose container | k3s Deployment |
| Admin/Client panels | Docker Compose containers | k3s Deployments + Ingress |
| Dex / OAuth2 Proxy | Docker Compose containers | k3s Deployments |
| TLS | Self-signed (local-ca-issuer) | Let's Encrypt (prod ClusterIssuer) |
| DNS | `*.<PLATFORM_BASE_DOMAIN>` (internal DNS server, default `k8s-platform.test`) | Real domains via PowerDNS |
| Container images | Local `docker build` | GHCR pull (or local build + import) |

### What's Already Portable (runs in k3s in both modes)

- Stalwart mail server (kustomize overlays)
- SFTP gateway (k8s manifests + Go binary)
- cert-manager + ClusterIssuers
- NGINX Ingress controller
- Client namespaces, file-managers, deployments
- Per-namespace RBAC

### Deliverables

1. **`k8s/overlays/production/`** — Full set of k8s manifests for services currently in Docker Compose:
   - PostgreSQL 16 Deployment + PVC + Service + Secret
   - Redis 7 Deployment + Service
   - Backend Deployment + Service + ConfigMap + Secret
   - Admin panel Deployment + Service + Ingress
   - Client panel Deployment + Service + Ingress
   - Dex Deployment + Service + ConfigMap + Ingress
   - OAuth2 Proxy Deployment + Service
   - Let's Encrypt ClusterIssuer

2. **`scripts/bootstrap.sh`** — Production bootstrap script:
   ```
   bootstrap.sh control --domain platform.example.com
   bootstrap.sh worker --server <control-netbird-ip> --token <token>
   bootstrap.sh local   # delegates to local.sh (DinD mode)
   ```
   Control mode: installs k3s, Helm, NGINX Ingress, cert-manager, generates secrets, applies production kustomize overlay, runs migrations, creates admin user.

3. **Configuration model** (`/etc/platform/config.env`):
   - Operator-provided: domain, admin email, Let's Encrypt email
   - Auto-generated: DB password, JWT secret, platform internal secret, k3s token
   - Templates into k8s Secrets/ConfigMaps via kustomize secretGenerator

4. **Container image strategy**:
   - Primary: GHCR (CI/CD builds on push to main)
   - Fallback: local build on server if Docker available
   - Air-gapped: pre-built tarball import

5. **CI/CD pipeline** (GitHub Actions):
   - Build + push images to GHCR on main push
   - Run unit tests
   - Tag with git SHA
   - Optional: SSH deploy to staging server

6. **DinD compatibility preserved**:
   - `scripts/local.sh` unchanged
   - Same container images for both modes
   - `scripts/smoke-test.sh` works in both (auto-detects API URL)

---

## Phase 1: Worker Node Support + Client Pinning

**Goal**: Add worker nodes. Clients are pinned to specific nodes.

### 1A: Worker Node Join

`bootstrap.sh worker` does:
1. Install prerequisites (open-iscsi, nfs-common for Longhorn)
2. Install NetBird, join VPN mesh
3. Install k3s agent, join cluster via NetBird IP
4. Label node: `node-role.platform.io/worker=true`

Works on any Linux VPS or bare metal with SSH access. No Terraform, no cloud API.

### 1B: Node Registration

New `nodes` table in the platform database:

```sql
CREATE TABLE nodes (
  id varchar(36) PRIMARY KEY,
  name varchar(255) NOT NULL UNIQUE,
  role varchar(20) NOT NULL DEFAULT 'worker',  -- 'control' | 'worker'
  netbird_ip varchar(45),
  public_ip varchar(45),
  labels jsonb DEFAULT '{}',
  status varchar(20) DEFAULT 'active',         -- 'active' | 'draining' | 'offline'
  created_at timestamp DEFAULT now()
);
```

### 1C: Client Node Affinity

New column: `clients.pinned_node` references `nodes.id`.

- Default: pinned to control node (or least-loaded node)
- Admin can change via admin panel
- All client workloads (deployments, file-manager, databases) get `nodeAffinity` matching pinned node
- Provisioner (`k8s-lifecycle.ts`, `k8s-deployer.ts`) injects `nodeAffinity`

### 1D: Platform Workload Placement

Platform services prefer control node but control node is also a worker:

```yaml
nodeSelector:
  node-role.platform.io/control: "true"
# No NoSchedule taint — control node accepts client workloads too
```

### Node Model

```
Node A (control + worker)     Node B (worker)     Node C (worker)
- Platform services           - Client workloads   - Client workloads
- Client workloads            - Longhorn           - Longhorn
- PostgreSQL, Redis           - Ingress DaemonSet  - Ingress DaemonSet
- Stalwart mail
- SFTP gateway
- Longhorn
- Ingress DaemonSet
```

---

## Phase 2: Workload Mobility + Client Transfer

**Priority: ASAP** — this makes multi-node operationally useful.

### 2A: Client Migration

Admin action: "Move client X from node A to node B"

1. Update `clients.pinned_node` to target node
2. If Longhorn: ensure volume replica exists on target, evict from source
3. If local-path: snapshot data, create Longhorn volume on target, restore
4. Update `nodeAffinity` on all client deployments
5. Delete old pods (k8s reschedules to target)
6. Verify pods running on target
7. Update DNS if client's ingress IP changed (new node's public IP)

### 2B: Stalwart Mail Migration

Stalwart Community Edition does not support HA. It's pinned to one node but movable:

1. Scale StatefulSet to 0
2. Ensure Longhorn volume replica on target node
3. Update `nodeSelector` to target node
4. Scale StatefulSet to 1
5. Update mail DNS (MX, SPF) if IP changed

Admin panel: "Move Mail Server" button.

### 2C: Node Evacuation (Drain)

Admin action: "Drain node B"

1. List all clients pinned to node B
2. For each: run client migration (2A) to admin-selected target
3. If Stalwart on node B: migrate mail (2B)
4. `kubectl cordon` node B
5. `kubectl drain` remaining pods
6. Node is empty — safe to maintain or decommission

---

## Phase 3: Distributed Storage (Longhorn)

**Goal**: Client data survives node failure. Replicated volumes.

### 3A: Longhorn Installation

- `bootstrap.sh` installs Longhorn prerequisites on all nodes
- Longhorn deployed via Helm on control node, auto-discovers workers
- Default StorageClass: `longhorn` (replaces `local-path`)
- Replica count: 1 (single node), 2+ (multi-node)

### 3B: Migration from local-path

Script: `scripts/migrate-storage.sh <namespace>`

1. Snapshot PVC data (tar/rsync)
2. Create Longhorn PV/PVC with same name
3. Restore data into Longhorn volume
4. Delete old local-path PV

### 3C: Backup Targets

| Target | Method | Notes |
|--------|--------|-------|
| S3-compatible | Longhorn native S3 backup | MinIO (self-hosted) or any S3 provider |
| SSH storage | CronJob with `borg` or `rsync` | Mounts Longhorn volume, pushes to SSH target |

Both targets configurable per-cluster. Scheduled + on-demand.

---

## Phase 4: Disaster Recovery

**Goal**: Documented and tested recovery procedures for node loss (without HA).

### 4A: Automated Backups

CronJob runs daily at 02:00:
- etcd snapshot → SSH/S3 backup target
- PostgreSQL dump (`pg_dump`) → SSH/S3
- Longhorn volume snapshots → S3/SSH
- Cluster manifest (node list, client pinning, secrets) → SSH/S3

### 4B: Control Node Loss Recovery

Scenario: Control node dies. Workers are orphaned.

1. Provision new VPS (any provider)
2. `bootstrap.sh control --restore <backup-path>`
   - Install k3s server with `--cluster-reset`
   - Restore etcd snapshot
   - Restore PostgreSQL dump
   - Install Longhorn, restore volume snapshots
3. Workers detect new control plane (NetBird IP unchanged)
4. Workers rejoin automatically (k3s agent reconnects)
5. Verify client pods reschedule
6. Update DNS for platform services

Target RTO: ~30 minutes (manual), ~10 minutes (automated restore).

### 4C: Worker Node Loss Recovery

Scenario: Worker node dies. Clients pinned to it are down.

**If Longhorn replicas exist on other nodes** (preferred):
- k3s detects node offline, marks pods for rescheduling
- Admin updates `pinned_node` for affected clients (or auto-failover)
- Longhorn serves data from surviving replica
- Pods start on new node immediately

**If no replica** (single-node volume):
- Restore from latest backup (S3/SSH)
- Re-provision worker, re-pin clients
- Data loss limited to time since last backup

---

## Phase 5: HA Control Plane

**Goal**: Platform survives single server failure without manual intervention.

- 3 server nodes with embedded etcd (odd number for quorum)
- First server: `k3s server --cluster-init`
- Others: `k3s server --server https://<first>:6443`
- keepalived VIP for API server (floating IP between servers)
- Backend: 2+ replicas with pod anti-affinity
- CloudNativePG: 3-node PostgreSQL (1 primary + 2 standby, auto-failover)
- Redis Sentinel: 3-node Redis (1 master + 2 replicas + 3 sentinels)
- Stalwart: remains single-instance, pinned to one server (CE limitation)
- NetBird mesh between all server + worker nodes

---

## Phase 6: Auto-Scaling + Node Management UI

**Priority: Lowest** — manual operations are sufficient initially.

### Admin Panel: Cluster Management

- **Nodes page**: list nodes, status, resource usage (CPU/RAM/disk), client count per node
- **Add Worker**: generates `bootstrap.sh worker` command with pre-filled token + server IP
- **Drain Node**: auto-migrates all clients, cordons, drains
- **Remove Node**: drain + remove from cluster
- **Resource dashboard**: Prometheus metrics per node, alerts at >80% utilization

### Client Detail Enhancements

- **Node field**: shows pinned node name
- **"Move to..." dropdown**: admin-only, triggers client migration (Phase 2A)

### No Auto-Provisioning

Node creation remains manual (SSH to VPS, run bootstrap.sh). The platform does not provision VPS instances — this is intentional to support any provider including bare metal.

---

## Technology Stack (All Vendor-Agnostic)

| Layer | Choice | Runs on |
|-------|--------|---------|
| Orchestration | k3s | Any Linux host |
| CNI | Calico | Any network |
| Storage | Longhorn | Any disk |
| Database | PostgreSQL 16 (CloudNativePG for HA) | k3s pods |
| Cache | Redis 7 (Sentinel for HA) | k3s pods |
| Ingress | NGINX Ingress Controller | DaemonSet on all nodes |
| TLS | cert-manager + Let's Encrypt | Standard ACME |
| VPN Mesh | NetBird (WireGuard) | Any host |
| DNS | PowerDNS + pluggable providers | Self-hosted |
| Mail | Stalwart CE | Single node, movable |
| Load Balancing | MetalLB + keepalived (HA phase) | Bare metal / VPS |
| Monitoring | Prometheus + Grafana | k3s pods |
| Backups | Longhorn snapshots + borg/rsync | S3 or SSH targets |
| Provisioning | bootstrap.sh (SSH + cloud-init) | Any VPS or bare metal |

---

## Implementation Order

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 5 ──→ Phase 6
Real        Worker      Workload    Longhorn    Disaster    HA          Auto-
server      nodes +     mobility    storage     recovery    control     scaling
bootstrap   client      + client                            plane
            pinning     transfer
```

Phases 0-2 are the critical path. Phase 3 enables Phase 4. Phase 5 is independent of Phase 6.

---

## Budget Estimate (Any VPS Provider)

| Component | Spec | Typical Monthly Cost |
|-----------|------|---------------------|
| 1x control node | 4 vCPU, 8GB RAM, 80GB SSD | ~$15 |
| 2x worker nodes | 4-8 vCPU, 8-16GB RAM each | 2 x ~$15-28 = $30-56 |
| Backup storage (SSH/S3) | 100GB | ~$3-5 |
| **Total (small cluster)** | | **~$48-76/month** |
| **Total (medium cluster)** | 3 workers | **~$63-104/month** |

Well within the <$200/month budget for 50-100 clients.
