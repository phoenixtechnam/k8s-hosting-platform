# Complete Admin Panel Requirements Specification

> **Comprehensive feature list extracted from ALL technical specifications in INFRASTRUCTURE_PLAN.md**
>
> **Covers:** Compute, storage, networking, security, monitoring, CI/CD, applications, subscriptions, migration, geo-sharding, VPS provisioning
>
> **Status:** Complete specification for all admin operations

## Important: Admin-Only Model

All customer and subscription management is **admin-only**. There is **no customer self-service billing or plan upgrades**.

- **Customers:** Can only manage their hosting infrastructure (domains, databases, backups, files, email) via the Client Panel. Customers may pay a renewal online (via "Renew Now" in the client panel) **only if** the admin has assigned a payment gateway to their account.
- **Admins:** Manage customer accounts, subscriptions, and expiry dates via the Admin Panel and Management API.
- **Billing:** **Optional.** The platform works fully without any payment gateway. Admins can renew subscriptions manually (set expiry date directly). Payment gateways (Stripe, PayPal, DPO, Chargebee, Paddle, etc.) are configured globally and assigned per customer as needed.
- **Plan Changes:** Require admin action via API (customers cannot self-service).
- **Payment modes:** Manual (admin sets expiry), once-off payment link (admin sends link or customer pays via client panel), or recurring gateway subscription.

---

## Table of Contents

1. [Cluster & Region Management](#cluster-region-management)
2. [Workload Catalog Management](#workload-catalog-management)
3. [Application Catalog & Instances](#application-catalog)
4. [Client & Plan Management](#client-plan-management)
5. [Infrastructure & Resource Management](#infrastructure-resource)
6. [Storage & Database Management](#storage-database)
7. [VPS Auto-Provisioning](#vps-provisioning)
8. [External Service Configuration](#external-service-configuration)
9. [Networking & DNS Management](#networking-dns)
10. [Security & Access Control](#security-access)
11. [Monitoring, Logging & Alerts](#monitoring-logging)
12. [CI/CD & Container Registry](#cicd-registry)
13. [Email & Communication](#email-communication)
14. [Backup & Disaster Recovery](#backup-recovery)
15. [Subscription & Expiry Management](#subscription-expiry-management)
16. [Audit & Compliance](#audit-compliance)
17. [Bulk Operations](#bulk-operations)
18. [Advanced Search & Filtering](#advanced-search)
19. [Branding & Customization](#branding--customization)
20. [Customizable Dashboards & Widgets](#customizable-dashboards--widgets)
21. [Authentication: Passwordless Login with OIDC](#authentication-passwordless-login-with-oidc)
22. [Mobile Optimization & Responsive Design](#mobile-optimization--responsive-design)
23. [Theme Customization - Light & Dark Mode](#theme-customization---light--dark-mode)

---

## Cluster & Region Management

### C.1 Cluster Overview Dashboard

**Requirement:** View all Kubernetes clusters and regions at a glance.

**Dashboard Displays:**

**Requirements:**

| Component | Specification | Phase |
|-----------|---|---|
| **Cluster List** | Show all regions with health status, node count, uptime | 1 |
| **Health Indicators** | CPU, memory, storage usage with trends | 1 |
| **Sync Status** | Show data replication status between regions | 2 |
| **Failover Status** | Can region failover? Dependencies ready? | 2 |
| **Worker Node List** | Show all nodes, capacity, running pods per node | 1 |
| **Node Details** | CPU/memory allocation, kernel version, labels, taints | 2 |

### C.2 Node Management

**Requirement:** View and manage individual k3s worker nodes — health inspection, cordoning, draining, labelling, taint management, and graceful reboot. All node operations execute via the in-cluster Kubernetes API (Management API pod has in-cluster kubeconfig); kubectl access is exclusively over the NetBird WireGuard mesh (port 6443 not publicly exposed).

**Critical constraint (ADR-014 — DNS-first drain ordering):** Before any drain the backend MUST: (1) remove the node IP from `ingress.platform.com` DNS A record via the PowerDNS API, (2) wait 60 seconds (one DNS TTL), (3) then issue `kubectl drain`. The panel must never allow a bare drain. This sequence is enforced server-side — the UI cannot bypass it.

See also: `SA.5 Node Firewall Management` (per-node iptables rules via node agent), `SA.6 NetBird Mesh Management` (WireGuard peer status), `ARCHITECTURE_DECISION_RECORDS.md` ADR-010 (NGINX Ingress DaemonSet), ADR-013 (NetBird), ADR-014 (DNS-first drain).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Node list** | All k3s nodes: role, status, Kubernetes version, CPU/memory allocation, pod count, uptime | 1 |
| **Node detail** | Full metadata: kernel version, OS, labels, taints, conditions, allocatable resources, running pods, events | 1 |
| **Cordon** | Mark node unschedulable (no new pods) — existing pods continue running | 1 |
| **Uncordon** | Re-enable scheduling on a previously cordoned node | 1 |
| **Drain** | Safely evict all pods — DNS-first sequence enforced; Longhorn replica re-replication check before proceeding | 1 |
| **Label management** | Add and remove node labels (e.g. `node-role.kubernetes.io/worker`, custom topology labels) | 1 |
| **Taint management** | Add and remove node taints with effect (`NoSchedule` / `PreferNoSchedule` / `NoExecute`) | 1 |
| **Node events** | Kubernetes Events stream for a node — scheduling failures, OOM kills, disk pressure warnings | 1 |
| **Pod list on node** | All pods currently scheduled on a node with status and namespace | 1 |
| **Graceful reboot** | Drain node → trigger reboot via node agent → wait for Ready → uncordon | 1 |

---

#### Node List

**Admin Panel → Cluster → Nodes**

| Column | Notes |
|--------|-------|
| Node name | Hostname / Kubernetes node name |
| Role | `control-plane` / `worker` |
| Status | `● Ready` / `⚠ NotReady` / `○ Cordoned` / `↻ Draining` |
| k3s version | e.g. `v1.29.3+k3s1` |
| OS | e.g. `Debian 13 (Trixie)` |
| CPU | `2.4 / 8 cores (30%)` — progress bar |
| Memory | `4.2 / 16 Gi (26%)` — progress bar |
| Pods | `34 / 110` |
| Internal IP | Node's cluster-internal IP |
| Uptime | Days since last reboot |
| Actions | View detail, Cordon, Drain, Reboot, Labels/Taints |

Nodes with status `NotReady` or `Cordoned` display a warning badge. A Critical banner fires if any node is `NotReady` for > 5 minutes (Prometheus: `kube_node_status_condition{condition="Ready",status="false"}`).

---

#### Node Detail

**Admin Panel → Cluster → Nodes → {node}**

Tabs: **Overview** | **Pods** | **Events** | **Labels & Taints**

**Overview tab:**

| Field | Notes |
|-------|-------|
| Status | `Ready` / `NotReady` / `Cordoned` / `Draining` |
| Kernel | e.g. `6.1.0-21-amd64` |
| OS image | e.g. `Debian GNU/Linux 13 (trixie)` |
| Container runtime | e.g. `containerd://1.7.13` |
| k3s version | e.g. `v1.29.3+k3s1` |
| Internal IP | |
| Allocatable CPU | Cores available to pods |
| Allocatable memory | GiB available to pods |
| Allocatable storage | Ephemeral storage |
| CPU requested | Sum of pod CPU requests |
| Memory requested | Sum of pod memory requests |
| Longhorn disks | Disks registered with Longhorn, path, used/total |

**Labels & Taints tab:** read-only list with inline add/remove forms for each.

---

#### Drain Workflow

Initiating a drain from the admin panel:

1. Admin clicks **Drain** on a node
2. Panel shows a confirmation dialog:
   ```
   ⚠ Drain node: worker-02

   This will:
   1. Remove worker-02 IP from ingress.platform.com DNS (TTL 60s wait)
   2. Evict all pods from worker-02
   3. Check Longhorn replica re-replication before completing

   Pods to be evicted: 34
   DaemonSet pods (will remain): 8

   Type CONFIRM to proceed.
   ```
3. Backend executes the DNS-first sequence (ADR-014 enforced server-side):
   - `PATCH /powerdns/api/v1/zones/platform.com./records` — remove worker-02 IP
   - Wait 60 seconds
   - `kubectl drain worker-02 --ignore-daemonsets --delete-emptydir-data`
   - Poll Longhorn replica status — wait until all volumes reach healthy replica count on remaining nodes
4. Progress shown as a live status panel: `DNS removed ✓ → Waiting TTL (38s) → Draining pods ✓ → Longhorn re-replication (2/3 volumes) → Complete ✓`
5. Node transitions to `Cordoned` after drain completes

**Reboot:** Drain → node agent executes `shutdown -r now` → Management API polls node Ready condition → auto-uncordons when `Ready` resumes (or prompts admin to uncordon manually).

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/nodes` | List all nodes with status, resource allocation, pod count |
| `GET` | `/api/v1/admin/nodes/{node}` | Node detail: metadata, conditions, allocatable resources, Longhorn disks |
| `GET` | `/api/v1/admin/nodes/{node}/pods` | All pods running on a specific node |
| `GET` | `/api/v1/admin/nodes/{node}/events` | Kubernetes events for a node (last 100) |
| `POST` | `/api/v1/admin/nodes/{node}/cordon` | Mark node unschedulable |
| `POST` | `/api/v1/admin/nodes/{node}/uncordon` | Re-enable scheduling |
| `POST` | `/api/v1/admin/nodes/{node}/drain` | Initiate drain (DNS-first sequence enforced server-side) — returns `drain_job_id` |
| `GET` | `/api/v1/admin/nodes/{node}/drain/{job_id}` | Poll drain job progress |
| `POST` | `/api/v1/admin/nodes/{node}/reboot` | Graceful drain → reboot → uncordon (`reason` required) |
| `PATCH` | `/api/v1/admin/nodes/{node}/labels` | Add/remove node labels (`add: {}`, `remove: []`) |
| `PATCH` | `/api/v1/admin/nodes/{node}/taints` | Add/remove node taints (`add: []`, `remove: []`) |

---

### C.3 Cluster Networking

**Requirement:** View and monitor the cluster networking layer — NGINX Ingress DaemonSet status, hostPort 80/443 binding per node, per-client Ingress rules, NetworkPolicy inventory, and DNS-to-node IP mapping health.

This section is read-only monitoring and inspection. Firewall rule management is in **SA.5 Node Firewall Management**. NetBird mesh status is in **SA.6 NetBird Mesh Management**.

See also: `ARCHITECTURE_DECISION_RECORDS.md` ADR-010 (NGINX Ingress DaemonSet, hostPort), ADR-013 (NetBird WireGuard mesh), `POWERDNS_INTEGRATION.md` (ingress.platform.com A records).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **NGINX Ingress DaemonSet status** | Per-node NGINX pod health, hostPort 80/443 binding status, version | 1 |
| **Ingress rule list** | All Kubernetes Ingress objects across all namespaces — host, backend service, TLS cert, annotations | 1 |
| **ingress.platform.com DNS status** | Current A record set for `ingress.platform.com` — which node IPs are registered, last update | 1 |
| **NetworkPolicy inventory** | All NetworkPolicies across all namespaces — ingress/egress rules, pod selectors | 1 |
| **Service list** | All Kubernetes Services — type (ClusterIP/NodePort/LoadBalancer), port mappings, endpoints | 1 |
| **DNS-to-pod connectivity check** | Ad-hoc check: resolve a domain → trace to node → verify NGINX pod is bound on that node | 1 |

---

#### NGINX Ingress DaemonSet Status

**Admin Panel → Cluster → Networking → Ingress**

| Column | Notes |
|--------|-------|
| Node | Worker node name |
| NGINX pod | Pod name + status (`● Running` / `✗ Not running`) |
| Port 80 | `● Bound` / `✗ Not bound` (hostPort check) |
| Port 443 | `● Bound` / `✗ Not bound` |
| NGINX version | Controller image tag |
| Requests (1m) | RPS from `nginx_ingress_controller_requests` metric |
| Error rate (1m) | 5xx % |
| In DNS | `● Yes` / `✗ No` — whether this node IP is in `ingress.platform.com` A records |

> NGINX Ingress runs as a **DaemonSet** on all worker nodes, binding directly to hostPort 80 and 443 (ADR-010). There is no external load balancer — client traffic reaches a node directly via DNS round-robin on `ingress.platform.com`. A node must be in the DNS A record set AND have NGINX running to accept traffic.

A node where NGINX is `✗ Not running` but `● In DNS` is a Critical alert — traffic will be dropped.

---

#### ingress.platform.com DNS Status

| Field | Notes |
|-------|-------|
| A records | One per healthy worker node — current list with IPs |
| TTL | `60s` (low TTL for fast failover) |
| Last updated | UTC timestamp of last PowerDNS record change |
| Nodes in DNS | Count vs. total worker nodes |
| Discrepancies | Nodes in DNS that have no running NGINX pod — flagged Critical |

Manual controls: **Add node IP** / **Remove node IP** — each triggers the PowerDNS API and is audit logged.

---

#### Ingress Rule List

**Admin Panel → Cluster → Networking → Ingress Rules**

| Column | Notes |
|--------|-------|
| Host | e.g. `acme.com`, `www.acme.com` |
| Namespace | Client namespace or `platform` |
| Client | Owning client |
| Backend | Service name + port |
| TLS | `● Yes` — cert secret name |
| Annotations | Key annotations (e.g. `nginx.ingress.kubernetes.io/rewrite-target`) |
| Status | `● Synced` / `⚠ No endpoints` / `✗ Error` |

Filter: by namespace, client, TLS status, status.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/networking/ingress-controller` | NGINX DaemonSet pod status per node — hostPort binding, DNS membership, request/error rate |
| `GET` | `/api/v1/admin/networking/ingress-dns` | Current `ingress.platform.com` A record set — node IPs, last update, discrepancy check |
| `POST` | `/api/v1/admin/networking/ingress-dns/add` | Add a node IP to `ingress.platform.com` (`node_name`, `ip`) — audit logged |
| `POST` | `/api/v1/admin/networking/ingress-dns/remove` | Remove a node IP from `ingress.platform.com` (`node_name`, `ip`) — audit logged |
| `GET` | `/api/v1/admin/networking/ingress-rules` | List all Kubernetes Ingress objects (filter: `namespace`, `client_id`, `tls`, `status`) |
| `GET` | `/api/v1/admin/networking/network-policies` | List all NetworkPolicies across all namespaces |
| `GET` | `/api/v1/admin/networking/services` | List all Kubernetes Services with port mappings and endpoint health |

---

### C.4 Region Failover Management

**Requirement:** Manage cross-region failover and replication (Phase 2+).

**Features (Phase 2):**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Failover readiness check** | Per-region: are all dependencies replicated and ready to accept traffic? | 2 |
| **Trigger failover** | Initiate controlled failover of a region to standby region — guided multi-step wizard | 2 |
| **Replication status** | Database, DNS, and configuration replication lag between regions | 2 |
| **DNS failover toggle** | Update `ingress.platform.com` to point to standby region node IPs | 2 |
| **Failover audit log** | Full history of failover events with before/after state | 2 |

**API Endpoints:** Deferred to Phase 2 design.

---

### C.5 Cluster Scaling

**Requirement:** Scale cluster capacity by adding or removing worker nodes, expanding Longhorn storage, and upgrading the cluster topology stage — all via the admin panel without manual SSH access.

Hetzner Cloud is the Phase 1 provider. Multi-cloud (AWS, OVH, NetCup, Azure) is Phase 2. Node provisioning is closely related to **VP.2 VPS Provisioning Wizard** — C.5 covers the cluster-integrated scaling flow (join existing cluster), while VP.2 covers provisioning standalone VPS servers.

Capacity thresholds triggering scale-out: CPU > 70% sustained, memory > 80%, storage > 70% Longhorn utilization.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Capacity dashboard** | Current cluster CPU/memory/storage utilisation vs. scale-out thresholds | 1 |
| **Add worker node** | Guided wizard: provider, server type, region, auto-join cluster, add to Longhorn, add to DNS | 1 |
| **Remove worker node** | Guided removal: drain → DNS removal → Longhorn re-replication → decommission VPS | 1 |
| **Expand Longhorn storage** | Attach additional Hetzner block volume to an existing node and register with Longhorn | 1 |
| **Topology upgrade** | Move from single-node (Stage 0) to multi-node stages (Stage 1–4) — guided checklist | 2 |
| **Scaling history** | Audit log of all scale events (nodes added/removed, volumes expanded) | 1 |

---

#### Capacity Dashboard

**Admin Panel → Cluster → Scaling**

| Metric | Current | Threshold | Status |
|--------|---------|-----------|--------|
| Cluster CPU utilisation | `58%` | `70%` | `● OK` |
| Cluster memory utilisation | `64%` | `80%` | `● OK` |
| Longhorn storage utilisation | `74%` | `70%` | `⚠ Scale recommended` |
| Worker node count | `3` | — | |
| Total CPU (allocatable) | `24 cores` | — | |
| Total memory (allocatable) | `48 Gi` | — | |
| Total Longhorn capacity | `300 Gi` | — | |

Recommendation banner: `Storage utilisation is above threshold. Consider adding a worker node or expanding Longhorn storage on an existing node.`

Projected headroom: `At current growth rate, storage will reach 90% in ~18 days`.

---

#### Add Worker Node Wizard

**Admin Panel → Cluster → Scaling → Add Worker**

Step-by-step guided flow:

| Step | Action | Details |
|------|--------|---------|
| 1 | **Select provider** | Hetzner Cloud (Phase 1); AWS / OVH / NetCup (Phase 2) |
| 2 | **Select server type** | e.g. Hetzner CX32 (4 vCPU / 8 GB / €15/mo), CX42 (8 vCPU / 16 GB / €30/mo) — estimated cost shown |
| 3 | **Configure** | Hostname, SSH key (auto-generated or paste), Debian 13 image |
| 4 | **Review & confirm** | Summary of resources and estimated cost; estimated join time ~5 minutes |
| 5 | **Provision** | Live progress log (WebSocket stream): |

Progress steps shown live:
```
✓ Creating Hetzner server...          (12s)
✓ Waiting for SSH availability...     (28s)
✓ Installing k3s agent...             (45s)
✓ Joining cluster...                  (18s)
✓ Applying worker labels...           (3s)
✓ Registering Longhorn disk...        (8s)
✓ Adding node IP to ingress DNS...    (5s)
✓ Verifying NGINX DaemonSet on node   (12s)
● Node worker-04 is Ready
```

Labels applied automatically: `node-role.kubernetes.io/worker=worker`, `kubernetes.io/role=worker` (required for DNS Ingress Controller and DaemonSet scheduling — ADR-010).

On failure: server is **not** automatically deleted (to allow forensic inspection). Admin is shown cleanup instructions. Manual cleanup button available.

---

#### Remove Worker Node Wizard

**Admin Panel → Cluster → Scaling → Remove Worker → {node}**

Guided removal — each step confirmed before proceeding:

| Step | Action | Safety check |
|------|--------|-------------|
| 1 | **Remove from DNS** | Remove node IP from `ingress.platform.com` — wait 60s TTL |
| 2 | **Drain pods** | `kubectl drain` — evict all workloads to other nodes |
| 3 | **Longhorn re-replication** | Wait for all volume replicas to rebuild on surviving nodes |
| 4 | **Remove from Longhorn** | Evict Longhorn engine and replicas from node |
| 5 | **Delete from cluster** | `kubectl delete node` |
| 6 | **Decommission VPS** | Delete Hetzner server (if cloud-provisioned) — requires explicit checkbox `☑ Delete VPS from Hetzner` |

Admin can abort after any step. Aborted removal is audit logged with the last completed step.

---

#### Expand Longhorn Storage

**Admin Panel → Cluster → Scaling → Expand Storage → {node}**

Used when Longhorn utilisation exceeds 70% and a full new node is not warranted.

| Step | Action |
|------|--------|
| 1 | Select target node |
| 2 | Select volume size (Hetzner block volumes: 10–10,000 GB; ~€0.04/GB/month) |
| 3 | Provision Hetzner volume and attach to node via cloud API |
| 4 | Mount at `/mnt/longhorn-data-01` on node |
| 5 | Register path in Longhorn disk configuration |
| 6 | Longhorn redistributes replicas to new disk transparently |

New disk capacity visible in Capacity Dashboard within ~60 seconds.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/cluster/capacity` | CPU/memory/storage utilisation vs. thresholds, worker count, projected headroom |
| `GET` | `/api/v1/admin/cluster/scaling-history` | Audit log of all scaling events |
| `POST` | `/api/v1/admin/cluster/workers` | Add worker node — starts provisioning wizard (`provider`, `server_type`, `hostname`) — returns `job_id` |
| `GET` | `/api/v1/admin/cluster/workers/{job_id}` | Poll add-worker job progress (WebSocket stream or polling) |
| `DELETE` | `/api/v1/admin/cluster/workers/{node}` | Start guided removal of a worker node — returns `removal_job_id` |
| `GET` | `/api/v1/admin/cluster/workers/{node}/removal/{job_id}` | Poll removal job step progress |
| `POST` | `/api/v1/admin/cluster/storage/expand` | Attach and register additional Longhorn disk on a node (`node`, `size_gb`) |

---

## Workload Catalog Management

### W.1 Container Image Management

**Requirement:** Manage Kubernetes workload container images (Apache+PHP, Node, Python, Ruby, Java, .NET, static).

**Dashboard:**

**Features:**

| Feature | Specification | Phase |
|---------|---|---|
| **List All Images** | Show all workload types, status, usage | 1 |
| **Image Details** | Base image, extensions, dependencies | 1 |
| **Build/Publish** | Upload new image version | 2 |
| **Enable/Disable** | Control which workloads are available | 1 |
| **Deprecate** | Mark old versions as deprecated (no new deployments) | 1 |
| **Force Migration** | Migrate all clients from one version to another | 2 |
| **Extension Management** | View/add PHP extensions, Node packages, Python modules | 2 |
| **Compatibility Matrix** | Show which extensions are available per version | 2 |
| **Security Scanning** | Scan images for vulnerabilities (Trivy) | 2 |

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/catalog/images` | List all catalog images (filter: `runtime`, `status`, `deprecated`; includes active client count per image) |
| `GET` | `/api/v1/admin/catalog/images/{image_id}` | Image detail: base image tag, runtime version, PHP/Node/Python version, included extensions, Harbor digest, Trivy scan status, clients using this image |
| `PATCH` | `/api/v1/admin/catalog/images/{image_id}` | Update image metadata: `enabled` (true/false), `deprecated` (true/false), `display_name`, `description` |
| `GET` | `/api/v1/admin/catalog/images/{image_id}/clients` | List all clients currently using this image (paginated; for impact assessment before deprecation) |
| `GET` | `/api/v1/admin/catalog/images/{image_id}/scan` | Get latest Trivy vulnerability scan report for this image (severity counts, CVE list) |
| `POST` | `/api/v1/admin/catalog/images/{image_id}/scan` | Trigger an on-demand Trivy rescan of this image |
| `GET` | `/api/v1/admin/catalog/images/{image_id}/compatibility` | Compatibility matrix: which PHP extensions / Node packages / Python modules are available in this image |
| `POST` | `/api/v1/admin/catalog/images/{image_id}/migrate` | Phase 2: Force-migrate all clients on this image to a target image (`target_image_id`, `reason`, `dry_run`) — returns `migration_job_id` |
| `GET` | `/api/v1/admin/catalog/images/{image_id}/migrate/{job_id}` | Phase 2: Poll force-migration job progress |

### W.2 Container Lifecycle Management

**Requirement:** Manage per-client container deployment and upgrades — catalog image switching (zero-downtime blue/green), rollback, scale-to-zero, deployment health monitoring, and file deployment history. This section covers the admin view of client workload lifecycle; the catalog image library management (enable/deprecate/force-migrate) is in **W.1**.

See also: `WORKLOAD_DEPLOYMENT.md`, `DEPLOYMENT_PROCESS.md`, `DATABASE_SCHEMA.md` (`workloads`, `deployment_history`, `container_images` tables).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Workload list** | All client workloads across the platform — image, status, replica count, CPU/memory usage | 1 |
| **Per-client workload detail** | Current image, resource usage, health probe status, switch history | 1 |
| **Catalog image switch** | Zero-downtime blue/green switch to a different catalog image for a client | 1 |
| **Switch progress monitor** | Live 6-step progress view for an in-flight image switch | 1 |
| **Cancel switch** | Abort an in-progress switch before the ingress cutover step | 1 |
| **Rollback** | Roll back a client to their previous catalog image | 1 |
| **Switch history** | Full timeline of all catalog image switches for a client | 1 |
| **Deployment history** | Per-client file deployment log (git-pull, SFTP, file manager) with commit SHA and re-deploy | 1 |
| **Restart workload** | Delete pod to trigger Kubernetes self-healing restart | 1 |
| **Scale to zero** | Set `replica_count = 0` to idle a Business-plan workload | 1 |
| **Scale up** | Restore `replica_count = 1` after a scale-to-zero | 1 |
| **Environment variable management** | View and edit per-workload environment variables (stored in namespace Secret) | 1 |
| **Compatibility pre-check** | Run pre-flight check before an image switch — scans `.htaccess`, PHP code, extensions | 1 |
| **Bulk force migrate (Phase 2)** | Rolling update of all clients on a deprecated image to a specified replacement | 2 |

---

#### Workload List

**Admin Panel → Workloads → All**

| Column | Notes |
|--------|-------|
| Client | Name + plan badge — clickable |
| Workload name | e.g. `acme-corp-web` |
| Image | `catalog/apache-php84:1.2.0-20260227` |
| Status | `● Running` / `⚠ Pending` / `✗ Failed` / `○ Idle (scale-to-zero)` / `↻ Switching` |
| Replicas | `1 / 1` (or `0 / 1` for scale-to-zero) |
| CPU (live) | Current usage from metrics-server |
| Memory (live) | Current usage from metrics-server |
| Restarts | Lifetime pod restart count — red badge if > 5 |
| Last switch | Date of last catalog image switch |
| Actions | View detail, Switch image, Rollback, Restart, Scale |

Filter: by plan, image/runtime, status, restart count threshold. Sort by any column.

**Quick filter tabs:** `All` | `Unhealthy` | `Idle` | `Switching`

---

#### Per-Client Workload Detail

**Admin Panel → Clients → {client} → Workloads → {workload}**

| Section | Content |
|---------|---------|
| **Current image** | `catalog/apache-php84:1.2.0-20260227` (digest shown, copy-to-clipboard) |
| **Status** | Running / Pending / Failed / Idle / Switching |
| **Replicas** | Current / desired (e.g. `1 / 1`) |
| **Resources** | CPU request/limit, memory request/limit, live usage gauges |
| **Health probes** | Liveness and readiness probe type, path/port, last result, failure count |
| **Pod** | Pod name, node, IP, uptime, restart count — links to IR.2 pod detail |
| **Environment variables** | Non-secret vars shown; secret refs shown as `***` |
| **Switch history** | Last 5 image switches (date, from → to, outcome, duration) |

Action buttons: **Switch Image** | **Rollback** | **Restart** | **Scale to Zero / Up** | **View Logs**

---

#### Catalog Image Switch

**Admin Panel → Clients → {client} → Workloads → {workload} → Switch Image**

**Step 1 — Select target image:**

Available images filtered by client's plan (e.g. Node.js images blocked for Starter). Each image shows: name, runtime version, web server, status (`Active` / `Deprecated`), and any compatibility warnings.

**Step 2 — Compatibility pre-check** (runs automatically on selection):

| Check | Result |
|-------|--------|
| `.htaccess` compatibility | `● OK` / `⚠ 2 rules may need review` |
| PHP extensions | `● All required extensions available` / `✗ ext-imagick not available in target image` |
| Config format (Apache → NGINX) | `● Auto-converted` / `⚠ Manual review recommended` |
| Estimated downtime | `0s (zero-downtime switch)` |

**Step 3 — Options:**

| Option | Default |
|--------|---------|
| Create backup before switch | `☑ Yes` |
| Auto-rollback on health failure | `☑ Yes` (rollback if new pod not healthy within 2 minutes) |
| Reason (required) | Free text — audit logged |

**Step 4 — Confirm and switch.**

---

#### Switch Progress Monitor

A live progress panel appears immediately after initiating a switch:

```
Switching apache-php83 → nginx-php84 for acme-corp

Step 1/6  ✓ Pre-flight checks passed                        (2s)
Step 2/6  ✓ Backup created                                  (18s)
Step 3/6  ✓ New pod started (nginx-php84-d9f7b)            (12s)
Step 4/6  ↻ Waiting for readiness probe /healthz...        (14s / 120s max)
Step 5/6  ○ Ingress cutover (pending)
Step 6/6  ○ Old pod drain and cleanup

[Cancel switch]   (available until Step 5 begins)
```

After ingress cutover:
```
Step 4/6  ✓ Readiness confirmed                             (22s)
Step 5/6  ✓ Ingress updated — traffic on new pod           (1s)
Step 6/6  ✓ Old pod drained and removed                    (38s)

● Switch complete — acme-corp is now running nginx-php84:1.2.0-20260227
```

**Automatic rollback display** (if triggered):
```
✗ Readiness check failed (timeout after 120s)
↻ Rolling back to apache-php83...
✓ Rollback complete — acme-corp restored to apache-php83
```

---

#### Rollback

**Admin Panel → Clients → {client} → Workloads → {workload} → Rollback**

Confirmation dialog:

```
Roll back acme-corp to previous image?

Current image:   nginx-php84:1.2.0-20260227
Previous image:  apache-php83:1.1.5-20260101

This will run a zero-downtime switch in reverse.
Auto-rollback is enabled if the previous image fails health checks.

Reason (required): _______________

[Cancel]   [Confirm rollback]
```

Rollback runs the same 6-step zero-downtime process as a forward switch. Returns `400` if no previous image exists in switch history.

---

#### Auto-Rollback Triggers

The system automatically initiates rollback (without admin action) during a switch if any of these occur:

| Trigger | Condition | Action |
|---------|-----------|--------|
| Readiness failure | New pod `/healthz` not passing for > 120s | Rollback — old pod retained |
| Post-switch crash | New pod crashes after ingress cutover | Recreate old pod; revert ingress |
| Error rate spike | > 5% HTTP 5xx for 1 continuous minute | Revert ingress to old pod |
| Total timeout | > 5 minutes from switch start without completion | Rollback |

All auto-rollback events create an `RESOURCE_WORKLOAD_UPDATED` audit log entry with `status: auto_rollback` and the trigger condition.

---

#### Deployment History (File Deployments)

**Admin Panel → Clients → {client} → Workloads → {workload} → Deployments**

Tracks file deployments (git-pull, SFTP upload, file manager, API) — separate from image switch history.

| Column | Notes |
|--------|-------|
| Date | UTC deployment timestamp |
| Method | `git_pull` / `sftp` / `filebrowser` / `api` |
| Status | `● Completed` / `↻ In progress` / `✗ Failed` / `↺ Rolled back` |
| Commit SHA | Git SHA (linked to repository if configured) — copyable |
| Branch | Git branch |
| Files changed | Count of files added/modified/deleted |
| Duration | Seconds |
| Triggered by | `webhook` / `panel` / `api` / `scheduled` |
| Actions | View logs, Re-deploy this commit |

**Re-deploy:** Replays a specific past deployment (re-pulls the specified Git commit SHA). Useful for reverting a bad deploy without a rollback mechanism. Audit logged.

---

#### Scale to Zero / Scale Up

**Admin Panel → Clients → {client} → Workloads → {workload} → Scale**

Available for **Business plan dedicated pods only** (not Starter, not Premium).

| Action | Mechanism | Effect |
|--------|-----------|--------|
| **Scale to zero** | Sets `replica_count = 0` on the Kubernetes Deployment | Pod terminated; PV retained; client's site becomes unavailable |
| **Scale up** | Sets `replica_count = 1` | New pod scheduled; site becomes available after readiness probe passes |

A prominent warning is shown before scale-to-zero: `⚠ This will make the client's site unavailable until scaled back up.`

Scale-to-zero is reflected in the workload status as `○ Idle`. The client panel also shows an idle state banner. Admin must provide a reason (audit logged).

---

#### Environment Variable Management

**Admin Panel → Clients → {client} → Workloads → {workload} → Environment**

| Column | Notes |
|--------|-------|
| Key | Variable name |
| Value | Shown masked (`***`) by default; reveal button for non-secret vars |
| Secret | `☑` if stored as a Kubernetes Secret ref (never shown plaintext in panel) |
| Source | `workload config` / `namespace secret` / `platform-injected` |
| Actions | Edit, Delete |

**Platform-injected variables** (read-only, managed automatically):

| Variable | Value |
|----------|-------|
| `DB_HOST` | MariaDB ClusterIP service DNS |
| `DB_PORT` | `3306` |
| `DB_NAME` | Client's database name |
| `DB_USER` | Client's database username |
| `DB_PASSWORD` | From namespace Secret (never shown) |
| `REDIS_HOST` | Redis ClusterIP service DNS |
| `PORT` | `3000` (for Node.js workloads) |

Adding or removing a variable triggers a pod restart after confirmation.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/workloads` | List all client workloads (filter: `plan`, `image`, `status`, `client_id`) |
| `GET` | `/api/v1/admin/customers/{id}/workloads` | List workloads for a specific client |
| `GET` | `/api/v1/admin/customers/{id}/workloads/{workload_id}` | Workload detail: image, status, resources, health probes, pod reference |
| `POST` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/switch` | Initiate catalog image switch (`target_image_id`, `backup_before`, `auto_rollback`, `reason`) — returns `switch_id` |
| `GET` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/switch/{switch_id}` | Poll switch progress (step, percentage, elapsed time) |
| `POST` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/switch/{switch_id}/cancel` | Cancel in-progress switch (before ingress cutover only) |
| `POST` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/rollback` | Rollback to previous catalog image (`reason` required) |
| `GET` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/switch-history` | Full image switch history for a workload |
| `GET` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/deployments` | File deployment history (filter: `method`, `status`, `from`, `to`) |
| `POST` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/deployments/{deploy_id}/redeploy` | Re-deploy a specific past commit (`reason` required) |
| `PATCH` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/scale` | Set replica count (`replicas`: 0 or 1; Business plan only) |
| `POST` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/restart` | Restart pod (`reason` required; audit logged) |
| `GET` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/env` | List environment variables (secrets masked) |
| `PATCH` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/env` | Add/update/delete environment variables (triggers pod restart) |
| `POST` | `/api/v1/admin/customers/{id}/workloads/{workload_id}/compatibility-check` | Pre-flight compatibility check for a target image switch |

---

## Application Catalog & Instances

### A.1 Application Catalog Management

**Requirement:** Manage published applications (Nextcloud, Jitsi, BigBlueButton, Gitea, Mattermost, WordPress, Drupal, Magento, PrestaShop, WooCommerce, Ghost, Plone, DokuWiki, MediaWiki, Mastodon, Lemmy, PeerTube, Matrix, Synapse, Moodle LMS, Gibbon LMS, Keycloak, etc.).

**Dashboard:**

**Features:**

| Feature | Specification | Phase |
|---------|---|---|
| **List Apps** | Show all available applications | 1 |
| **App Details** | Description, requirements, pricing | 1 |
| **Enable/Disable** | Control app availability | 1 |
| **Publish Version** | Publish new app version | 2 |
| **Tier Availability** | Which plans can use this app? | 1 |
| **Resource Requirements** | Minimum CPU, RAM, storage per app | 1 |
| **Pricing Model** | Included in plan vs extra cost | 2 |
| **Documentation** | Links to setup docs, tutorials | 1 |
| **Deployment Settings** | Configure app defaults (domain, admin user, etc.) | 2 |

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/apps` | List all catalog applications (filter: `status`, `plan_tier`; includes instance count per app) |
| `GET` | `/api/v1/admin/apps/{app_id}` | Application detail: description, Helm chart name/version, resource requirements (CPU/mem/storage defaults), plan tier availability, documentation URL |
| `PATCH` | `/api/v1/admin/apps/{app_id}` | Update catalog app: `enabled` (true/false), `plan_tiers` (array of plan slugs), `display_name`, `description`, `docs_url` |
| `GET` | `/api/v1/admin/apps/{app_id}/versions` | List published Helm chart versions for this app (version, published date, changelog, current default flag) |
| `PATCH` | `/api/v1/admin/apps/{app_id}/versions/{version}` | Set a version as the default for new deployments; or deprecate a version |
| `GET` | `/api/v1/admin/apps/{app_id}/instances` | List all deployed instances of this app across all clients (client, status, version, resource usage) |

### A.2 Application Instance Management

**Requirement:** Manage deployed application instances per client.

**Dashboard:**

**Features:**

| Feature | Specification | Phase |
|---------|---|---|
| **List Instances** | Show all apps deployed for client | 1 |
| **Instance Details** | URL, status, version, users, resource usage | 1 |
| **Deploy New App** | Select app, configure, deploy | 1 |
| **Update App** | Upgrade to new version | 1 |
| **Configure App** | Change settings (admin user, title, theme, etc.) | 2 |
| **Scale Resources** | Adjust CPU/memory allocation | 2 |
| **Backup Instance** | Manual backup of app + database | 1 |
| **Restore Instance** | Restore from point-in-time backup | 2 |
| **View Logs** | Application logs, deployment logs | 1 |
| **Delete Instance** | Remove app (with backup first option) | 1 |
| **Health Monitoring** | CPU, memory, disk usage trends | 1 |

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/customers/{id}/app-instances` | List all deployed application instances for a client (app name, version, status, URL, resource usage, phase) |
| `GET` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}` | Instance detail: app ID, Helm release name, namespace, version, admin URL, external URL, resource usage, last deployed timestamp |
| `POST` | `/api/v1/admin/customers/{id}/app-instances` | Deploy a new application instance (`app_id`, `version`, `domain`, `admin_email`, `config` key-value map, `plan_override` optional) — returns `instance_id` and deployment job ID |
| `GET` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}/deploy-status` | Poll deployment progress (step, percentage, logs tail, elapsed time) |
| `PATCH` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}/version` | Upgrade or downgrade the app version (`target_version`, `backup_before`: boolean, `reason`) — returns upgrade job ID |
| `PATCH` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}/config` | Update runtime configuration values (app-specific Helm values: title, theme, SMTP settings, feature flags, etc.) — triggers rolling restart |
| `PATCH` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}/resources` | Adjust CPU/memory allocations (`cpu_request`, `cpu_limit`, `mem_request`, `mem_limit`; plan limits enforced) |
| `POST` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}/backup` | Trigger an immediate manual backup of the app instance and its database — returns `backup_id` |
| `POST` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}/restore` | Restore instance from a backup (`backup_id`, `scope`: `full`\|`db_only`\|`files_only`) — returns restore job ID; see `RESTORE_SPECIFICATION.md` |
| `GET` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}/logs` | Stream or paginate application logs (query: `since`, `until`, `lines`, `stream`: `stdout`\|`stderr`) |
| `GET` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}/health` | Current health status: pod readiness, liveness probe result, CPU/memory trend (last 1h), error rate |
| `DELETE` | `/api/v1/admin/customers/{id}/app-instances/{instance_id}` | Delete application instance (`backup_first`: boolean, `reason` required) — uninstalls Helm release, removes PVCs, purges DNS records |

---

## Client & Plan Management

### CP.1 Client Account Management

**Requirement:** Manage client accounts and subscriptions (admin-only).

**Features (Phase 1):**

| Feature | Specification | Phase |
|---------|---|---|
| **Create Client** | Add new customer with plan and subscription | 1 |
| **Client List** | View all clients, filter by status/plan | 1 |
| **Client Details** | View client info, current plan, usage metrics | 1 |
| **Update Client** | Edit name, email, status (active/suspended/cancelled) | 1 |
| **Update Subscription** | Change expiry date, sync with external billing | 1 |
| **View Subscription Status** | See expiry date, days remaining, renewal status | 1 |
| **Suspend Client** | Block service access (data retained) | 1 |
| **Delete Client** | Remove client after archiving data | 1 |

**API Endpoints:** See `./MANAGEMENT_API_SPEC.md`

**External Billing Integration:** See `../01-core/EXTERNAL_BILLING_INTEGRATION.md`

### CP.2 Plan Management

**Requirement:** Define hosting plans (fixed tier structure, not customer-configurable).

**Plan Tiers (Default Templates — fully customizable, see `HOSTING_PLANS.md`):**

| Plan | CPU Req/Limit | Mem Req/Limit | Storage | Domains | Databases | Email Accounts | Monthly Cost |
|------|---------------|---------------|---------|---------|-----------|----------------|--------------|
| **Starter** | N/A (shared) | N/A (shared) | 5Gi | 1 | 1 | 5 | $5.99 |
| **Business** | 100m / 1000m | 256Mi / 1Gi | 20Gi | 5 | 3 | 25 | $19.99 |
| **Premium** | 200m / 2000m | 512Mi / 4Gi | 50Gi | Unlimited | 10 | Unlimited | $49.99 |

> All plan values are defaults and can be overridden per-customer. WAF is available on all plans. Cron jobs are unlimited on all plans. Backup retention follows the global backup strategy. Admins can add, remove, and modify plans freely.

**Features (Admin Only):**

| Feature | Specification | Phase |
|---------|---|---|
| **View Plans** | See all defined plans and usage (how many clients) | 1 |
| **Plan Details** | View resource limits, quotas, included features | 1 |
| **Plan Assignment** | Assign plan when creating new client (can be changed by admin) | 1 |
| **Plan-Based Quotas** | Auto-apply plan quotas to client (enforced) | 1 |
| **Re-sync Customer** | Re-sync customer with current plan defaults (preserves explicit overrides) | 1 |
| **Plan Lifecycle** | Deprecate old plans (existing clients keep them) | 1 |
| **Custom Plans** | Create/edit/delete custom plans with any combination of settings | 1 |

**Note:** Customers cannot self-service upgrade/downgrade. All plan changes managed by admins via API.

**API Endpoints:** See `./MANAGEMENT_API_SPEC.md`

### CP.3 Client Bulk Operations

**Requirement:** Perform bulk actions on multiple clients.

**Operations (Phase 1.5):**

| Operation | Description | Phase |
|-----------|-------------|-------|
| **Bulk Suspend** | Suspend multiple clients simultaneously — sets each client `status = suspended`, triggers namespace quota enforcement and Ingress deactivation | 1.5 |
| **Bulk Unsuspend** | Restore multiple suspended clients to `active` status | 1.5 |
| **Bulk Plan Change** | Change the plan of multiple clients to a specified target plan (admin-only; same validation as single plan change) | 1.5 |
| **Bulk Expiry Update** | Set a new `subscription_expires_at` date for multiple clients at once (e.g. to extend annual renewals in bulk) | 1.5 |
| **Bulk Notification Send** | Send an email notification or in-panel announcement to a selected set of clients | 1.5 |
| **Bulk Delete (Phase 2)** | Schedule account termination for multiple clients — requires confirmation, triggers data-export job before deletion | 2 |

**Behaviour:**

- Bulk actions are submitted as a background job via Redis Bull queue.
- The API returns a `job_id` immediately; progress is tracked via WebSocket (same pattern as provisioning: `POST → job_id → WebSocket /ws/admin/jobs/{job_id}`).
- Each client within the batch is processed independently — partial failures are reported per client without aborting the remaining batch.
- Progress events are emitted every 2 seconds with `{ processed, total, failed, current_client_id }`.
- A final `complete` event includes a full per-client result summary (success / skipped / error + reason).
- All bulk actions are logged to `audit_logs` with `bulk_operation_id` grouping all child events.

**Progress WebSocket event schema:**

```json
{
  "event": "bulk_progress",
  "job_id": "bulk-abc123",
  "processed": 14,
  "total": 50,
  "failed": 1,
  "current_client_id": "client-xyz",
  "errors": [
    { "client_id": "client-foo", "reason": "Client is already suspended" }
  ]
}
```

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/admin/clients/bulk/suspend` | Suspend multiple clients (`client_ids[]`, optional `reason`) |
| `POST` | `/api/v1/admin/clients/bulk/unsuspend` | Unsuspend multiple clients (`client_ids[]`) |
| `POST` | `/api/v1/admin/clients/bulk/plan-change` | Change plan for multiple clients (`client_ids[]`, `plan_id`) |
| `POST` | `/api/v1/admin/clients/bulk/expiry-update` | Set new expiry date for multiple clients (`client_ids[]`, `expires_at`) |
| `POST` | `/api/v1/admin/clients/bulk/notify` | Send notification to multiple clients (`client_ids[]`, `subject`, `body`, `channel`: `email`/`panel`/`both`) |
| `GET` | `/api/v1/admin/jobs/{job_id}` | Poll bulk job status (fallback for non-WebSocket clients) |

---

## Infrastructure & Resource Management

### IR.1 Namespace Management

**Requirement:** View and manage Kubernetes namespaces — one dedicated namespace per Business/Premium client (`client-{id}`), plus the shared `platform` namespace and pool namespaces for Starter clients. Phase 1 provides a read-only view; Phase 2 adds lifecycle management.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Namespace list** | All namespaces: `platform`, shared pod pools, and per-client namespaces — with pod count, CPU/memory used, ResourceQuota status | 1 |
| **Namespace detail** | Per-namespace: pod list, resource usage, active NetworkPolicies, ResourceQuota, LimitRange | 1 |
| **ResourceQuota status** | View per-namespace quota (CPU, memory, storage, pod count) vs. actual usage — visual gauge | 1 |
| **Namespace creation** | Create a new client namespace with ResourceQuota and default-deny NetworkPolicy (Phase 2 — currently done by Management API automatically) | 2 |
| **Namespace deletion** | Delete a namespace (only when client is fully terminated and data exported) — Phase 2 | 2 |
| **NetworkPolicy viewer** | Read-only list of NetworkPolicies in a namespace — ingress/egress rules, selectors | 1 |

---

#### Namespace List

**Admin Panel → Infrastructure → Namespaces**

| Column | Notes |
|--------|-------|
| Namespace | `platform`, `mail`, `harbor`, `client-acme-corp`, etc. |
| Type | `Platform` / `Shared pool` / `Client` |
| Client | Owning client (for client namespaces) — clickable |
| Pods | Running / total (e.g. `3 / 3`) |
| CPU used | e.g. `420m / 1000m` — progress bar |
| Memory used | e.g. `512Mi / 1Gi` — progress bar |
| Storage (PVCs) | Total PVC capacity claimed |
| Quota status | `● Within limits` / `⚠ Near limit (>80%)` / `✗ Exceeded` |
| Actions | View detail, View pods (→ IR.2), View volumes (→ IR.3) |

Filter: by type (Platform / Shared pool / Client), quota status, plan.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/namespaces` | List all namespaces with pod count, resource usage, quota status |
| `GET` | `/api/v1/admin/namespaces/{ns}` | Namespace detail: pods, resource usage, ResourceQuota, LimitRange, NetworkPolicies |
| `GET` | `/api/v1/admin/namespaces/{ns}/quotas` | ResourceQuota and LimitRange objects for namespace |
| `GET` | `/api/v1/admin/namespaces/{ns}/network-policies` | List NetworkPolicies in namespace |

---

### IR.2 Pod Management

**Requirement:** View and manage Kubernetes pods across all client and platform namespaces — for troubleshooting, health inspection, log retrieval, and controlled restarts.

Namespace naming: client pods run in `client-{id}` namespaces. Starter clients share pods in pool namespaces (e.g. `shared-pool-php84`). Platform services run in `platform`, `mail`, `harbor`, etc.

Resource limits per plan:

| Plan | CPU request / limit | Memory request / limit | Pod model |
|------|--------------------|-----------------------|-----------|
| Starter | Shared pool (2 vCPU / 4Gi per pool pod, 20–50 clients) | Same | Shared (VirtualHost) |
| Business | `100m` / `1000m` | `256Mi` / `1Gi` | Dedicated namespace |
| Premium | `200m` / `2000m` | `512Mi` / `4Gi` | Dedicated namespace |

See also: `HOSTING_PLANS.md`, `SECURITY_ARCHITECTURE.md` (Pod Security Standards: `baseline` for client workloads; `imagePullPolicy: IfNotPresent` for catalog images, `Always` for platform services).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Pod list** | All pods across all namespaces — filterable by namespace, status, node, image | 1 |
| **Pod detail** | Container list, image, resource requests/limits, node assigned, IP, restart count, start time | 1 |
| **Pod logs** | Live and historical log streaming per container; tail last N lines | 1 |
| **Pod restart** | Delete pod to trigger Kubernetes self-healing restart (with confirmation) | 1 |
| **Pod events** | Kubernetes Events for a pod — scheduling failures, image pull errors, OOM kills | 1 |
| **Resource usage** | Live CPU and memory consumption per pod (from metrics-server) | 1 |
| **Health checks** | Liveness and readiness probe status and last result | 1 |
| **Platform pod overview** | Quick-view of all platform service pods (Harbor, mail, etc.) and external services (PowerDNS, OIDC, NetBird) with health badge | 1 |
| **Pod exec (admin only)** | Terminal exec into a pod container — Platform Admin only, audit logged, client pods blocked | 2 |

---

#### Pod List

**Admin Panel → Infrastructure → Pods**

| Column | Notes |
|--------|-------|
| Name | Pod name |
| Namespace | e.g. `client-acme-corp`, `platform`, `mail` |
| Client | Owning client (for client namespaces) |
| Status | `● Running` / `⚠ Pending` / `✗ CrashLoopBackOff` / `✗ OOMKilled` / `○ Completed` / `✗ Error` |
| Node | Kubernetes node name |
| CPU (live) | Current CPU usage from metrics-server |
| Memory (live) | Current memory usage from metrics-server |
| Restarts | Restart count (lifetime) — red badge if > 5 |
| Age | Pod uptime |
| Image | Container image (truncated) |
| Actions | View detail, View logs, View events, Restart |

Filter: by namespace, status, node, image tag, restart count threshold. Sort by any column.

**Quick filter tabs:** `All` | `Platform` | `Client` | `Unhealthy` (non-Running status or restarts > 5)

---

#### Pod Detail

**Admin Panel → Infrastructure → Pods → {pod}**

| Section | Content |
|---------|---------|
| **Overview** | Name, namespace, status, node, pod IP, start time, age |
| **Containers** | Per-container: name, image (with tag and digest), state, restart count, `imagePullPolicy` |
| **Resources** | CPU request/limit, memory request/limit, live usage bar |
| **Health checks** | Liveness probe: type (HTTP/TCP/exec), path/port, last result, failure count; readiness probe same |
| **Volumes** | Mounted volumes: PVC name, mount path, read-only flag |
| **Environment** | Non-secret environment variables (secrets shown as `***`) |
| **Events** | Last 10 Kubernetes events for this pod |

---

#### Pod Logs

**Admin Panel → Infrastructure → Pods → {pod} → Logs**

Controls:
- Container selector (for multi-container pods)
- Lines: last 100 / 500 / 1000 / all
- Live tail: toggle (SSE stream)
- Download: full log as `.txt`
- Search: filter log lines by keyword (client-side)

Logs are fetched via the Kubernetes API (`/api/v1/namespaces/{ns}/pods/{pod}/log`). No log retention beyond what the pod has in its container log buffer — for historical logs use ML.2 Loki Log Aggregation.

---

#### Platform Pod Overview

**Admin Panel → Infrastructure → Pods → Platform**

Condensed health grid — one card per platform service:

| Service | Pods | Status |
|---------|------|--------|
| PowerDNS (external) | API connected | `● Healthy` |
| Harbor | `3 / 3` | `● Healthy` |
| Docker-Mailserver | `1 / 1` | `● Healthy` |
| Roundcube | `1 / 1` | `● Healthy` |
| OIDC Provider (external) | Issuer reachable | `● Healthy` |
| Prometheus | `1 / 1` | `● Healthy` |
| Grafana | `1 / 1` | `● Healthy` |
| Alertmanager | `1 / 1` | `● Healthy` |
| Loki | `1 / 1` | `● Healthy` |
| cert-manager | `3 / 3` | `● Healthy` |
| NGINX Ingress | `N / N` (DaemonSet) | `● Healthy` |
| Longhorn | `N / N` (DaemonSet) | `● Healthy` |
| NetBird (external) | Management reachable | `● Healthy` |

Unhealthy services display a Critical banner. Clicking any row navigates to the pod list filtered by that service's namespace/label.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/pods` | List all pods (filter: `namespace`, `status`, `node`, `client_id`) |
| `GET` | `/api/v1/admin/pods/platform` | Platform service pod health summary (grouped by service) |
| `GET` | `/api/v1/admin/namespaces/{ns}/pods/{pod}` | Pod detail: containers, resources, health checks, volumes, events |
| `GET` | `/api/v1/admin/namespaces/{ns}/pods/{pod}/logs` | Pod logs (`container`, `tail_lines`, `follow`) |
| `GET` | `/api/v1/admin/namespaces/{ns}/pods/{pod}/events` | Kubernetes events for a pod |
| `GET` | `/api/v1/admin/namespaces/{ns}/pods/{pod}/metrics` | Live CPU and memory usage from metrics-server |
| `DELETE` | `/api/v1/admin/namespaces/{ns}/pods/{pod}` | Delete (restart) pod — `reason` required; audit logged |

---

### IR.3 Persistent Volume Management

**Requirement:** View and manage Kubernetes PersistentVolumeClaims and Longhorn volumes — for storage health monitoring, capacity management, snapshot management, and volume expansion.

Storage class: `longhorn`. Client workload PVCs are mounted at `/storage/customers/{id}/` inside shared pods (Starter) or at the container's working directory in dedicated pods (Business/Premium). Plan storage defaults: Starter 5 Gi, Business 20 Gi, Premium 50 Gi.

See also: `STORAGE_DATABASES.md`, `SLI_SLO_DEFINITION.md` (Storage SLO: backup success rate 99.5%, restore success rate 99.0%).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **PVC list** | All PersistentVolumeClaims across all namespaces — size, used, status, Longhorn health | 1 |
| **Per-client volume detail** | Volume name, mount path, access mode, storage class, Longhorn replica count and health | 1 |
| **Storage usage** | Used vs. provisioned GB per PVC — visual gauge; warning at 80%, critical at 90% | 1 |
| **Longhorn volume health** | Replica status, degraded/faulted volumes, replication factor | 1 |
| **Longhorn snapshot list** | Per-volume snapshot history — name, date, size, parent | 1 |
| **Create snapshot** | Trigger an on-demand Longhorn snapshot for a PVC | 1 |
| **Delete snapshot** | Remove a specific Longhorn snapshot (with confirmation) | 1 |
| **Volume expansion** | Increase PVC size (online expansion via Longhorn) — blocked if would exceed plan quota | 1 |
| **Storage quota enforcement** | Block expansion if client storage quota would be exceeded | 1 |
| **Orphaned PVC detection** | Flag PVCs not bound to any running pod or workload | 1 |
| **Longhorn UI deep link** | Direct link to Longhorn native UI for advanced volume management | 1 |

---

#### PVC List

**Admin Panel → Infrastructure → Volumes**

| Column | Notes |
|--------|-------|
| PVC name | e.g. `client-acme-corp-pvc`, `mariadb-pvc`, `harbor-pvc` |
| Namespace | Owning namespace |
| Client | Owning client (for client PVCs) — clickable |
| Storage class | `longhorn` (all) |
| Provisioned | GB claimed |
| Used | GB consumed (from Longhorn metrics) |
| % used | Progress bar — amber > 80%, red > 90% |
| Longhorn health | `● Healthy` / `⚠ Degraded` / `✗ Faulted` |
| Replicas | e.g. `2 / 2` — degraded if any replica down |
| Bound to | Pod name (if mounted) or `Unbound` / `Orphaned` |
| Snapshots | Count of Longhorn snapshots |
| Actions | View detail, Create snapshot, Expand, View in Longhorn |

Filter: by namespace, health status, client, orphaned flag. Sort by % used, provisioned size.

**Orphaned PVC badge:** PVCs with no bound pod and no workload record — highlighted with a `⚠ Orphaned` badge for admin review.

---

#### Per-Client Volume Detail

**Admin Panel → Infrastructure → Volumes → {pvc}**

| Field | Notes |
|-------|-------|
| PVC name | |
| Namespace | |
| Client | |
| Access mode | `ReadWriteOnce` (standard) |
| Storage class | `longhorn` |
| Provisioned | GB |
| Used | GB — from Longhorn |
| Longhorn volume name | Internal Longhorn volume ID |
| Replica count | e.g. `2` (Phase 1: `1`, Phase 2: `2–3`) |
| Replica health | Per-replica node and status |
| Mount path | e.g. `/storage/customers/acme-corp/` (Starter) or workload path |
| Bound pod | Pod name + namespace |
| Plan quota | `20 Gi` (Business) — used vs. limit |

---

#### Longhorn Snapshot List

**Admin Panel → Infrastructure → Volumes → {pvc} → Snapshots**

| Column | Notes |
|--------|-------|
| Snapshot name | Longhorn-generated name (timestamp-based) |
| Created | UTC timestamp |
| Size | Delta size (not full volume size — Longhorn snapshots are incremental) |
| Type | `Manual` (admin-triggered) / `Auto` (backup CronJob pre-backup snapshot) |
| Parent | Previous snapshot in the chain |
| Actions | Delete |

**Create snapshot:** One-click button. Snapshot is created synchronously in Longhorn (typically < 1 second). Action is logged to admin audit trail.

> Longhorn snapshots are **not** the same as offsite backups — they are local volume checkpoints. For disaster recovery, use the offsite backups managed in BR.1 / BR.2. Snapshots are useful for quick rollback within the same node.

---

#### Volume Expansion

Expanding a PVC online:

1. Admin enters new size (must be larger than current provisioned size)
2. System checks plan storage quota — blocked with error if new size would exceed `storage_gb` limit
3. Longhorn expands the volume online (no pod restart required for `ext4` / `xfs` filesystems)
4. PVC `.spec.resources.requests.storage` is patched via the Kubernetes API
5. Filesystem resize happens automatically on next mount (or immediately if already mounted via `resize2fs` / `xfs_growfs`)
6. New size reflected in the PVC list within ~30 seconds

Admin override: Platform Admins can expand beyond plan quota by explicitly confirming an override (requires stated reason, audit logged).

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/volumes` | List all PVCs (filter: `namespace`, `client_id`, `health`, `orphaned`) |
| `GET` | `/api/v1/admin/volumes/{pvc}` | PVC detail: Longhorn health, replicas, mount path, quota usage |
| `GET` | `/api/v1/admin/volumes/{pvc}/snapshots` | List Longhorn snapshots for a PVC |
| `POST` | `/api/v1/admin/volumes/{pvc}/snapshots` | Create on-demand Longhorn snapshot |
| `DELETE` | `/api/v1/admin/volumes/{pvc}/snapshots/{name}` | Delete a Longhorn snapshot |
| `POST` | `/api/v1/admin/volumes/{pvc}/expand` | Expand PVC size (`new_size_gi`; blocked if exceeds plan quota unless admin override) |
| `GET` | `/api/v1/admin/volumes/orphaned` | List orphaned PVCs (no bound pod or workload record) |
| `GET` | `/api/v1/admin/customers/{id}/volumes` | All PVCs for a specific client with usage vs. plan quota |

---

## Cron Job Management

For complete architecture, database schema, and API specification, see **CUSTOMER_CRON_JOBS.md** in the 06-features directory.

### CJ.1 Global Cron Job Dashboard

**Requirement:** View all cron jobs across all customers with filtering and searching capabilities.

**Features:**
- View all cron jobs in the system (paginated list)
- Search by job name, customer name, script path
- Filter by customer, status, plan, enabled/disabled, execution status
- Sort by customer, job name, last run date, next run time
- Bulk actions: View, Disable, Force run, Delete
- Display columns: Customer (name, ID), Job Name, Schedule, Status, Last Run, Next Run, Actions
- Quick stats widget: Total jobs, enabled count, failed count, success rate
- Alerts for failed jobs this week

**API Endpoints:**
- GET `/v1/admin/cron-jobs` — List all cron jobs with filtering
- POST `/v1/admin/cron-jobs/{job_id}/force-run` — Manually execute any customer's job
- POST `/v1/admin/cron-jobs/disable-all` — Disable all jobs for a customer

---

### CJ.2 Customer Cron Jobs Detail Page

**Requirement:** View and manage all cron jobs for a specific customer.

**Features:**
- List all jobs for selected customer
- Display plan usage (e.g., "4 of 10 jobs used")
- Plan-specific limits (max timeout, max retries, max jobs)
- Create new job button
- For each job: Name, Schedule, Last run (status/date), Next run, Status (enabled/disabled), Actions
- Bulk actions on selected jobs:
  - [ ] Select all
  - [ ] Disable all (with reason field)
  - [ ] Force run all
  - [ ] Delete all (with confirmation)

**API Endpoints:**
- GET `/v1/admin/cron-jobs?customer_id={id}` — List jobs for customer
- GET `/v1/customers/{customer_id}/cron-jobs` — Full customer cron job list

---

### CJ.3 Cron Job Debug & Monitoring

**Requirement:** View, edit, and debug individual cron job configurations and execution history.

**Features:**
- View job configuration (read-only display or editable form)
- All fields editable: name, schedule, timeout, max_retries, webhook settings
- Force run button: Immediately execute regardless of schedule
- View execution logs: Full stdout/stderr output, exit code, duration
- View Kubernetes metadata:
  - CronJob UID, Pod name, Namespace
  - kubectl commands for advanced debugging (copy-to-clipboard)
- Disable/Enable toggle (without deleting)
- Delete button with soft-delete option
- Execution history table:
  - Last 100 runs with pagination
  - Columns: Date, Time, Duration, Status, Exit Code, Output (preview/expand)
  - Filter by date range, status
  - Download as CSV/JSON

**API Endpoints:**
- GET `/v1/customers/{customer_id}/cron-jobs/{job_id}` — Job details
- PATCH `/v1/customers/{customer_id}/cron-jobs/{job_id}` — Update job config
- POST `/v1/customers/{customer_id}/cron-jobs/{job_id}/trigger` — Manual trigger
- DELETE `/v1/customers/{customer_id}/cron-jobs/{job_id}` — Delete job
- GET `/v1/customers/{customer_id}/cron-jobs/{job_id}/runs` — Execution history
- GET `/v1/customers/{customer_id}/cron-jobs/{job_id}/last-run` — Last execution details

---

### CJ.4 Audit Trail & Compliance

**Requirement:** Track all changes to cron jobs for compliance and security auditing.

**Features:**
- Cron Job Audit Log viewer:
  - What changed (old vs. new values, side-by-side comparison)
  - Who made the change (admin user ID/email)
  - When (timestamp with timezone)
  - Why (optional reason field for sensitive actions)
- Filter by customer, job, action type (created, updated, enabled, disabled, deleted, executed, failed), date range
- Export as CSV
- Retention based on plan (30 days Starter, 90 days Business, 365 days Premium)
- Email notifications for admin-initiated changes (optional)

---

### CJ.5 Performance Monitoring & Analytics

**Requirement:** Monitor cron job execution performance and identify bottlenecks.

**Features:**
- Performance dashboard widgets:
  - Total cron jobs: Count by status (enabled, disabled, failed, success)
  - Execution success rate: % of jobs succeeding by plan
  - Slowest jobs: Table of slowest 10 jobs (by duration)
  - Most failed jobs: Jobs with highest failure rate
  - Failed runs this week: Alert if any customer's jobs failing
  - Resource usage: CPU/memory usage by cron jobs (total and by customer)
  - Webhook failures: List of failed webhook deliveries
- Prometheus metrics exported:
  - `cron_job_execution_duration_seconds`
  - `cron_job_execution_status` (success/failure)
  - `cron_job_pod_cpu_usage`
  - `cron_job_pod_memory_usage`
  - `cron_job_webhook_delivery_time`
  - `cron_job_webhook_delivery_status`
- Charts and graphs (last 7 days, 30 days, custom range):
  - Job execution timeline
  - Success/failure rate trend
  - Resource usage trend
- Alerting:
  - Job failure alert (after 3 failed runs)
  - Job timeout alert (execution exceeded limit)
  - Webhook delivery failure alert (after 3 retries)
  - Customer plan quota alert (approaching job limit)
  - Excessive resource usage alert (>90% of CPU/memory limit)

**API Endpoints:**
- Metrics from Prometheus API (standard)
- Custom dashboard API endpoints for cron-specific metrics (if needed)

---

### CJ.6 Migration Monitoring & Tools

**Requirement:** Monitor and manage cron job migrations from legacy platforms (Plesk, cPanel, Virtualmin).

**Features:**
- Migration status dashboard:
  - Migration progress: Count of jobs migrated/pending/failed by source platform
  - Customer migration checklist: Which customers' jobs migrated successfully
  - Failed migrations: List with error details and retry button
- Migration tools:
  - Connect to legacy panel (enter credentials)
  - Discover cron jobs (preview list before import)
  - Validate compatibility (show issues, warnings, incompatibilities)
  - Import jobs (batch or one-by-one)
  - Verify execution (compare output with legacy run)
  - Notify customers (send email with new cron job management links)
- Migration logs:
  - Extract from source panel: Log of API calls, SSH commands
  - Transform: Show before/after conversion (legacy command → K8s CronJob)
  - Create on K8s: Log of CronJob creation, any errors
  - Verify: Test run results, comparison with source
- Rollback option: Revert migration for failed jobs, keep legacy job running

**API Endpoints:**
- POST `/v1/admin/migrations/discover-cron-jobs` — Connect and discover jobs
- POST `/v1/admin/migrations/validate-cron-jobs` — Pre-flight validation
- POST `/v1/admin/migrations/import-cron-jobs` — Batch import jobs
- GET `/v1/admin/migrations/status` — Migration progress dashboard

---

## Storage & Database Management

### SD.1 Shared Database Management

**Requirement:** Manage the shared MariaDB (Percona Operator) and PostgreSQL (CloudNativePG) instances in the `platform` namespace — health monitoring, per-client database provisioning, quota enforcement, credential rotation, connection metrics, and Longhorn storage management.

Connection pooling (PgBouncer) is deferred to Phase 2. See also: `STORAGE_DATABASES.md`, `DATABASE_SCHEMA.md`, `SLI_SLO_DEFINITION.md`.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Database health overview** | MariaDB and PostgreSQL pod status, connection counts, query latency, replication lag, storage used | 1 |
| **Per-client database list** | All databases provisioned for a client — name, engine, size, status, backup enabled | 1 |
| **Provision database** | Create a new MariaDB or PostgreSQL database for a client (within plan quota) | 1 |
| **Delete database** | Remove a client database with confirmation; requires prior backup | 1 |
| **Credential rotation** | Rotate a database user's password; old password remains valid for 7 days | 1 |
| **Quota management** | View and edit per-client database count and storage GB allowances | 1 |
| **Connection metrics** | Per-client active connections, connection saturation vs. `max_connections` | 1 |
| **Slow query log** | View slow queries (> 2s threshold) from MariaDB slow query log, grouped by client | 1 |
| **Storage breakdown** | MariaDB and PostgreSQL PV usage: total used, per-client breakdown, growth trend | 1 |
| **Longhorn volume list** | List Longhorn PVCs for DB volumes — size, replication factor, health, snapshots | 1 |
| **Connection pooling status** | PgBouncer pool stats (Phase 2) | 2 |
| **Dedicated DB provisioning** | Provision a dedicated MariaDB/PG StatefulSet in a Premium/Custom client namespace and migrate data | 2 |

---

#### Database Health Overview

**Admin Panel → Storage → Databases → Overview**

Two cards side by side — MariaDB and PostgreSQL:

| Field | MariaDB example | PostgreSQL example |
|-------|-----------------|--------------------|
| Pod | `● 1 / 1 running` | `● 1 / 1 running` |
| Operator | Percona Operator | CloudNativePG |
| Uptime | `12d 4h` | `12d 4h` |
| Connections (active / max) | `234 / 1000 (23%)` | `18 / 100 (18%)` |
| Replication lag | `N/A (no replica)` | `N/A (no replica)` |
| Storage used | `42 GB of 100 GB (42%)` | `8 GB of 50 GB (16%)` |
| Slow queries (last 1h) | `3` | — |
| Availability (24h) | `100%` | `100%` |
| SLO target | `99.5%` | `99.5%` |

SLO thresholds: warning if availability drops below 99.9%; Critical if below 99.5%.

Prometheus alerts surfaced here: `SharedDBDown` (Critical), `DBConnectionSaturation` (Warning), `DBStorageWarning` (Warning).

---

#### Per-Client Database List

**Admin Panel → Storage → Databases → Clients → {client}**

Summary bar: `2 of 5 databases used | 12.4 GB of 25 GB used`

| Column | Notes |
|--------|-------|
| Database name | e.g. `acme_prod` |
| Engine | `MySQL` / `PostgreSQL` |
| Username | e.g. `acme_prod_u` |
| Size | GB used |
| Status | `● Running` / `● Provisioning` / `✗ Failed` / `○ Stopped` |
| Backup enabled | `Yes` / `No` |
| Created | UTC date |
| Actions | View credentials, Rotate password, Delete |

---

#### Provision Database

Form fields:

| Field | Options / Notes |
|-------|----------------|
| Engine | `MySQL` (MariaDB 10.6) / `PostgreSQL` |
| Name | 3–64 alphanumeric chars; must be unique for client |
| Initial size | 1–500 GB (capped at plan `storage_gb` remaining) |
| Backup enabled | Toggle (default: on) |

On submit: database provisioned on shared instance, dedicated user created (`{db_name}_u`), credentials stored in client namespace Secret, backup scheduling configured, credentials emailed to client. If plan quota (`max_databases`) would be exceeded, provisioning is blocked with a clear error.

---

#### Credential Rotation

Rotating a database password:
1. Admin clicks **Rotate password** for a database
2. New password generated and stored in client namespace Secret
3. Old password remains valid for **7 days** (grace period for application reconfiguration)
4. New credentials displayed once in a modal (masked by default, reveal button)
5. Action logged to admin audit trail

---

#### Quota Management

**Admin Panel → Storage → Databases → Clients → {client} → Quotas**

| Quota | Plan default | Current usage | Override |
|-------|-------------|---------------|---------|
| Max databases | `5` (Business) | `2` | Editable (positive integer, ≥ current usage) |
| DB storage (GB) | `25` (Business) | `12.4 GB` | Editable (≥ current usage) |
| Max connections per DB | `100` | — | Phase 2 |

Per-plan database defaults (from `hosting_plans` table):

| Plan | Max databases | Max DB storage | DB mode |
|------|-------------|---------------|---------|
| Starter | 1 | 500 MB | Shared instance |
| Business | 3 | 5 GB | Shared instance |
| Premium | 10 | 25 GB | Dedicated pod (default) |
| Custom | Negotiated | Negotiated | Any |

---

#### Connection Metrics

**Admin Panel → Storage → Databases → Connections**

Per-client connection table:

| Column | Notes |
|--------|-------|
| Client | Name + plan |
| Engine | MySQL / PostgreSQL |
| Active connections | Current count from `SHOW PROCESSLIST` (MariaDB) or `pg_stat_activity` (PG) |
| Max allowed | `max_connections` value for this client's DB record |
| % used | Progress bar — amber > 80%, red > 95% |
| Avg query time (1h) | Mean query latency |
| Slow queries (1h) | Count of queries > 2s threshold |

Sort by active connections or % used. Filter by engine.

---

#### Slow Query Log

**Admin Panel → Storage → Databases → Slow Queries**

Pulled from MariaDB slow query log (threshold: `long_query_time = 2` seconds):

| Column | Notes |
|--------|-------|
| Timestamp | Query execution time (UTC) |
| Client | Derived from database username |
| Database | Database name |
| Query | Truncated SQL text (first 500 chars; full text expandable) |
| Duration | Seconds |
| Rows examined | From slow log |

Filter by client, database, duration threshold, date range. Export as CSV.

> Slow query logging is enabled globally via `slow_query_log = ON` and `long_query_time = 2` in `my.cnf`. Per-client filtering is by database name.

---

#### Longhorn Volume List

**Admin Panel → Storage → Longhorn**

| Column | Notes |
|--------|-------|
| PVC name | e.g. `mariadb-pvc`, `postgresql-pvc`, `client-acme-files` |
| Namespace | `platform` / `client-{id}` |
| Size | Provisioned GB |
| Used | GB consumed (from Longhorn) |
| Replication | `1x` / `2x` / `3x` |
| Health | `● Healthy` / `⚠ Degraded` / `✗ Faulted` |
| Snapshots | Count of Longhorn snapshots |
| Actions | View snapshots, Expand volume, Change replication factor |

Storage warning thresholds: Warning at 80%, Critical at 90% per volume.

Link to Longhorn native UI for advanced management.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/databases/health` | MariaDB and PostgreSQL health: pod status, connections, storage, SLO availability |
| `GET` | `/api/v1/admin/databases/connections` | Per-client active connection counts and slow query counts |
| `GET` | `/api/v1/admin/databases/slow-queries` | Slow query log (filter: `client_id`, `database`, `min_duration`, `from`, `to`) |
| `GET` | `/api/v1/admin/databases/storage` | DB storage usage: total, per-client breakdown, growth trend |
| `GET` | `/api/v1/admin/databases/longhorn` | Longhorn PVC list with health, replication, snapshot count |
| `GET` | `/api/v1/admin/customers/{id}/databases` | List databases for a client |
| `POST` | `/api/v1/admin/customers/{id}/databases` | Provision a database (`engine`, `name`, `size_gb`, `backup_enabled`) |
| `GET` | `/api/v1/admin/customers/{id}/databases/{db_id}` | Get database detail including credentials (masked) |
| `PATCH` | `/api/v1/admin/customers/{id}/databases/{db_id}/credentials` | Rotate database password |
| `DELETE` | `/api/v1/admin/customers/{id}/databases/{db_id}` | Delete database (`reason` required; blocked if no recent backup) |
| `GET` | `/api/v1/admin/customers/{id}/databases/quotas` | Get database quota and current usage for client |
| `PUT` | `/api/v1/admin/customers/{id}/databases/quotas` | Update database quota override (`max_databases`, `storage_gb`) |

---

### SD.2 Backup Management

**Requirement:** Admin view of all backup activity across all customers from the Storage section perspective — complementing the detailed BR.1/BR.2 backup management views. SD.2 provides the **storage-layer summary**: overall backup health, per-client storage usage, quota enforcement, and quick-access links to the full BR.1/BR.2 backup management tools.

> **Scope note:** Full backup job management, restore operations, offsite server configuration, and rsync/Velero job detail are specified in **BR.1** and **BR.2** (Backup & Disaster Recovery section). SD.2 does not duplicate that content — it provides the storage operations lens: how much quota is consumed, which clients are over threshold, and whether the daily backup pipeline completed successfully.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Backup pipeline status** | Daily backup pipeline health for all components — last run result per client type | 1 |
| **Per-client backup storage** | Backup GB used vs. plan quota; breakdown by tier (automated vs. customer-created) | 1 |
| **Quota violations** | Clients over 80% or 100% of backup storage quota — action required list | 1 |
| **Bulk quota update** | Increase backup storage quota for multiple clients at once | 1 |
| **Failed backup list** | All clients with a failed backup in the last 24h — quick link to BR.1 job detail | 1 |
| **Backup storage trend** | Platform-wide backup storage growth — 7-day and 30-day | 1 |
| **Links to BR.1 / BR.2** | Deep links into Velero backup management and file backup management | 1 |

---

#### Backup Pipeline Status

**Admin Panel → Storage → Backups → Pipeline**

One row per component, same as BR.1 Overview but scoped to the storage operations view:

| Component | Last successful | Status | Clients affected on failure |
|-----------|----------------|--------|---------------------------|
| MariaDB dumps | `2026-03-08 02:11 UTC` | `● OK` | All clients with MySQL databases |
| PostgreSQL dumps | `2026-03-08 02:14 UTC` | `● OK` | All clients with PostgreSQL databases |
| rsync file backups | `2026-03-08 03:04 UTC` | `● OK` | All clients |
| Velero cluster snapshot | `2026-03-08 01:03 UTC` | `● OK` | Platform-wide |
| Offsite SSHFS | `2026-03-08 02:00 UTC` | `● Clean` | All |
| Retention cleanup | `2026-03-08 07:45 UTC` | `● OK` | Expired backup archives purged |

A `Critical` banner is shown if any component has not completed successfully in the last 25 hours.

---

#### Per-Client Backup Storage

**Admin Panel → Storage → Backups → Clients**

| Column | Notes |
|--------|-------|
| Client | Name + plan badge |
| Automated backups | GB used (Tier 1 — not counted against quota) |
| Customer backups | GB used (Tier 2 — counted against quota) |
| Quota | Total customer backup quota (GB) |
| % used | Progress bar — amber > 80%, red = 100% |
| Backup count | Total backup archives stored |
| Status | `● OK` / `⚠ High` / `✗ Full` |
| Actions | View backups (→ BR.1), Increase quota, Force delete oldest |

Sort by quota %, customer backup GB, backup count. Filter by plan, status.

---

#### Quota Violations

**Admin Panel → Storage → Backups → Quota Alerts**

Clients at ≥ 80% backup quota, sorted by % used descending:

| Client | Quota | Used | % | Next auto-delete | Action |
|--------|-------|------|---|-----------------|--------|
| acme-corp | 50 GB | 49.2 GB | 98% | 2026-03-10 | Increase quota / Contact client |
| beta-co | 30 GB | 24.5 GB | 82% | — | Increase quota / Contact client |

Clients at 100% cannot create new customer-initiated backups. Scheduled automated backups also skip and alert when quota is exhausted.

---

#### Bulk Quota Update

**Admin Panel → Storage → Backups → Bulk Quota Update**

Multi-select client list with current quota and usage shown. Admin enters an additional GB amount (e.g. `+20 GB`) or sets an absolute value. Change is applied to all selected clients and logged to audit trail.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/storage/backups/pipeline` | Daily backup pipeline status per component |
| `GET` | `/api/v1/admin/storage/backups/clients` | Per-client backup storage usage and quota (filter: `plan`, `status`) |
| `GET` | `/api/v1/admin/storage/backups/quota-alerts` | Clients at ≥ 80% backup quota |
| `POST` | `/api/v1/admin/storage/backups/quotas/bulk` | Bulk quota update (`client_ids[]`, `add_gb` or `set_gb`) |
| `GET` | `/api/v1/admin/storage/backups/trend` | Platform-wide backup storage growth (7-day and 30-day) |
| `GET` | `/api/v1/admin/storage/backups/failures` | Clients with failed backup jobs in last 24h — links to BR.1 detail |

---

### SD.3 Shared Redis Cache

**Requirement:** Manage shared Redis caching layer.

**Features (Phase 2):**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Redis health** | Pod status, memory used vs. `maxmemory`, eviction rate, hit/miss ratio | 2 |
| **Per-client key stats** | Key count per client prefix (`client-{id}:~*`), memory estimated usage | 2 |
| **Eviction alerts** | Flag clients with sustained eviction activity (memory pressure) | 2 |
| **Key count violations** | Clients with > 10,000 keys in their prefix (misbehaving client detection) | 2 |
| **Flush client keys** | Force-flush all keys for a specific client prefix (emergency) | 2 |
| **Dedicated Redis status** | For Premium clients — dedicated Redis pod health and memory usage | 2 |

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/redis/health` | Redis pod status, memory, eviction rate, hit/miss ratio (Phase 2) |
| `GET` | `/api/v1/admin/redis/clients` | Per-client key count and estimated memory usage by prefix (Phase 2) |
| `POST` | `/api/v1/admin/redis/clients/{id}/flush` | Flush all keys for a client's Redis prefix (Phase 2) |

---

## VPS Auto-Provisioning

### VP.1 Cloud Provider Credential Management

**Requirement:** Store, manage, and validate API credentials for all supported cloud providers — enabling the VPS Provisioning Wizard (VP.2) and Cluster Scaling (C.5) to provision servers programmatically. Credentials are stored as Sealed Secrets (never exposed after save).

**Supported Providers (Phase 1: Hetzner; Phase 2: all others):**

| Provider | API type | Credential fields | Phase |
|----------|----------|-------------------|-------|
| **Hetzner Cloud** | REST API | API token (Bearer) | 1 |
| **AWS EC2** | boto3 SDK | Access Key ID + Secret Access Key + region | 2 |
| **OVH Cloud (OpenStack)** | OpenStack API | Project ID + username + password (or app key/secret) | 2 |
| **NetCup** | REST API | Customer number + API key + API password | 2 |
| **Azure** | ARM REST API | Subscription ID + Client ID + Client Secret + Tenant ID | 2 |

Multi-account support: multiple credential sets per provider are supported (e.g. multiple Hetzner projects) — each labelled for identification.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Credential list** | All stored provider credentials — provider, label, last tested, status | 1 |
| **Add credential** | Provider-specific form; credential stored as Sealed Secret immediately on save | 1 |
| **Test credential** | Validate credentials against provider API — returns account info on success | 1 |
| **Edit label** | Rename a credential set (label only — credentials cannot be partially updated; replace entire set) | 1 |
| **Delete credential** | Remove a credential set (blocked if any provisioned servers reference it) | 1 |
| **Credential audit log** | Every add/test/delete logged to admin audit trail | 1 |

---

#### Credential List

**Admin Panel → VPS → Credentials**

| Column | Notes |
|--------|-------|
| Label | Admin-assigned name (e.g. `hetzner-prod`, `aws-eu-west`) |
| Provider | `Hetzner Cloud` / `AWS EC2` / `OVH Cloud` / `NetCup` / `Azure` |
| Account info | Masked identifier (e.g. Hetzner project name returned by test, AWS account ID) |
| Status | `● Valid` / `⚠ Untested` / `✗ Invalid` |
| Last tested | UTC timestamp |
| Servers | Count of servers provisioned using this credential |
| Actions | Test, Edit label, Delete |

---

#### Add Credential Form

Provider-specific fields are shown dynamically based on selected provider. Example for Hetzner (Phase 1):

| Field | Notes |
|-------|-------|
| Provider | `Hetzner Cloud` |
| Label | e.g. `hetzner-frankfurt-prod` |
| API Token | Paste token — stored as Sealed Secret `vps-credentials-{label}` in `platform` namespace; never shown after save |

On save: credential is immediately validated (test call to provider API). If validation fails, save is blocked with the provider's error message shown inline.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/vps/credentials` | List all stored provider credentials (filter: `provider`) |
| `POST` | `/api/v1/admin/vps/credentials` | Store new credentials (`provider`, `label`, credential fields) — validates and seals immediately |
| `POST` | `/api/v1/admin/vps/credentials/{id}/test` | Test credentials against provider API — returns account info |
| `PATCH` | `/api/v1/admin/vps/credentials/{id}` | Update label only |
| `DELETE` | `/api/v1/admin/vps/credentials/{id}` | Delete credential set (blocked if servers reference it) |

---

### VP.2 VPS Provisioning Wizard

**Requirement:** Provision new VPS servers from the admin panel — either as new cluster workers (joining an existing k3s cluster) or as new standalone master nodes (new region). All provisioning uses the cloud provider API (VP.1 credentials); after VM creation the bootstrap sequence is provider-agnostic (SSH → k3s install → cluster join → labels → Longhorn → DNS).

> **Relationship with C.5:** C.5 Cluster Scaling handles cluster-integrated worker scaling (add/remove nodes to an existing cluster). VP.2 handles standalone VPS provisioning — servers that will become new masters (new region) or workers bootstrapped outside the C.5 scaling flow. Both share the same backend provisioning job system.

All provisioning operations are async: the API returns a `job_id` immediately; progress is streamed via WebSocket (updates every 2–3 seconds).

**Provisioning Form fields:**

| Field | Options / Notes |
|-------|----------------|
| Provider | Dropdown of credential sets from VP.1 |
| Server type | Filtered by provider and region — cost shown inline (e.g. `CX32 — 4 vCPU / 8 GB / €15/mo`) |
| Region | Provider-specific region list |
| Role | `Worker` (join existing cluster) / `Master` (new region) |
| Hostname | Free text — validated for DNS safety |
| SSH key | `Auto-generate Ed25519 key pair` (default) or paste existing public key |
| Bootstrap mode | `Auto-bootstrap` (k3s + full stack) / `Manual` (server only; k3s setup later via SSH) |
| Target cluster | (Worker role only) Dropdown of existing clusters |

**Provisioning Steps (shown live in UI):**

*Worker bootstrap (auto):*
```
✓ Creating server via Hetzner API...            (12s)
✓ Waiting for SSH availability...               (28s)
✓ Applying OS baseline (Debian 13)...           (15s)
✓ Installing k3s agent...                       (45s)
✓ Joining cluster (node token handshake)...     (18s)
✓ Applying worker labels...                     (3s)
✓ Configuring node firewall (SA.5 rules)...     (5s)
✓ Registering Longhorn disk...                  (8s)
✓ Adding node IP to ingress.platform.com...     (5s)
✓ Verifying NGINX DaemonSet on node...          (12s)
✓ Node worker-04 Ready — traffic routing active
```

*Master bootstrap (auto — new region):*
```
✓ Creating server via Hetzner API...            (12s)
✓ Waiting for SSH availability...               (28s)
✓ Applying OS baseline (Debian 13)...           (15s)
✓ Installing k3s server (--disable traefik)...  (50s)
✓ Configuring node firewall...                  (5s)
✓ Installing NGINX Ingress DaemonSet...         (20s)
✓ Installing Longhorn...                        (30s)
✓ Installing cert-manager...                    (25s)
✓ Installing Management API...                  (20s)
✓ Configuring PowerDNS API connection...         (5s)
✓ Registering NetBird peer (external mesh)...   (10s)
✓ Registering region in platform...             (5s)
✓ Running smoke tests...                        (30s)
✓ Region online — ready to accept clients
```

**Failure handling:** Server is **never** automatically deleted on failure. Admin is shown:
- The last completed step
- The error message and exit code
- A **Manual cleanup** button (calls `DELETE /api/v1/admin/vps/servers/{server_id}` after admin confirms)
- SSH connection instructions (via NetBird mesh) for forensic inspection

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Server configuration wizard** | Provider, instance type, region, role, hostname, SSH key, bootstrap mode | 1 |
| **Cost estimation** | Estimated monthly cost shown on server type selection; summary on review step | 1 |
| **Auto-bootstrap (worker)** | k3s agent install → cluster join → labels → firewall → Longhorn → DNS (10 steps) | 1 |
| **Auto-bootstrap (master)** | Full stack: k3s + NGINX + Longhorn + cert-manager + Management API + external service connections (PowerDNS API, NetBird peer) (14 steps) | 1 |
| **Manual bootstrap** | Server created; SSH access provided; k3s setup performed manually by admin | 1 |
| **SSH key management** | Auto-generate Ed25519 key pair (stored as Sealed Secret) or accept user-provided public key | 1 |
| **Live progress stream** | WebSocket, 15+ steps, elapsed time per step, spinner on active step | 1 |
| **Failure handling** | No auto-delete; last-step marker; manual cleanup button; SSH instructions | 1 |
| **Server list** | All provisioned VPS servers with provider, role, status, IP, cost | 1 |
| **Decommission** | Drain → remove from cluster → delete VPS from provider (with explicit checkbox) | 2 |
| **Monitoring integration** | Provider-level metrics + Kubernetes node metrics in single view | 2 |

---

#### Server List

**Admin Panel → VPS → Servers**

| Column | Notes |
|--------|-------|
| Hostname | e.g. `worker-04` |
| Provider | e.g. `Hetzner Cloud (hetzner-frankfurt-prod)` |
| Role | `Worker` / `Master` |
| Region | e.g. `Frankfurt` |
| Instance type | e.g. `CX32` |
| IP | Public IP |
| K8s status | `● Ready` / `⚠ NotReady` / `✗ Not in cluster` |
| Monthly cost | e.g. `€15/mo` |
| Provisioned | Date |
| Actions | View node (→ C.2), Decommission |

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/vps/servers` | List all provisioned VPS servers (filter: `provider`, `role`, `status`) |
| `POST` | `/api/v1/admin/vps/servers` | Provision a new VPS (`credential_id`, `server_type`, `region`, `role`, `hostname`, `ssh_key_mode`, `bootstrap_mode`, `cluster_id`) — returns `job_id` |
| `GET` | `/api/v1/admin/vps/servers/{job_id}/progress` | Poll/stream provisioning progress (WebSocket: `wss://…/vps/servers/{job_id}/progress`) |
| `GET` | `/api/v1/admin/vps/servers/{server_id}` | Get server detail: provider info, K8s node link, cost, provisioning log |
| `DELETE` | `/api/v1/admin/vps/servers/{server_id}` | Decommission: drain → remove from cluster → delete VPS (`confirm_delete_vps: true` required) |
| `GET` | `/api/v1/admin/vps/providers/{provider}/instance-types` | List available instance types for a provider (filtered by region, with cost estimates) |
| `GET` | `/api/v1/admin/vps/providers/{provider}/regions` | List available regions for a provider |

---

## External Service Configuration

### ES.1 External Service Endpoints

**Requirement:** Configure and validate the API endpoints for external services that the platform depends on but does not deploy or manage (see ADR-022). These settings are required before DNS, OIDC, and mesh features can function.

**Admin Panel → Settings → External Services**

| Service | Configuration fields | Validation |
|---------|---------------------|------------|
| **PowerDNS** | API endpoint URL (e.g. `https://dns.example.com/api/v1`), API key | Test: `GET /api/v1/servers/localhost` returns 200 |
| **OIDC Provider** | Issuer URL (e.g. `https://auth.example.com`), Client ID, Client Secret | Test: `GET /.well-known/openid-configuration` returns valid JSON |
| **NetBird** | Management URL (e.g. `https://netbird.example.com`), API token (optional — for status display) | Test: `GET /api/v1/peers` returns 200 (or health endpoint) |

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Endpoint configuration form** | Per-service form with URL, credentials, and a "Test Connection" button | 1 |
| **Connection status indicator** | Green/red badge per service showing current reachability (polled every 60s) | 1 |
| **Credential rotation** | Update API keys/secrets without downtime — new credentials are validated before replacing old ones | 1 |
| **Audit logging** | All endpoint configuration changes are recorded in the admin audit log | 1 |

> **Security:** API keys and client secrets are stored encrypted at rest (Sealed Secrets or equivalent). The admin panel UI masks secret values after initial entry — only the last 4 characters are displayed.

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/settings/external-services` | List all configured external service endpoints (secrets masked) |
| `PUT` | `/api/v1/admin/settings/external-services/{service}` | Update endpoint configuration for a service (`powerdns`, `oidc`, `netbird`) |
| `POST` | `/api/v1/admin/settings/external-services/{service}/test` | Test connectivity to the configured endpoint — returns status and latency |

---

## Networking & DNS Management

### ND.1 PowerDNS Management

**Requirement:** Manage DNS zones and records via the external PowerDNS API — zone list, per-zone record editing, DNSSEC management, external slave sync status, zone template administration, and AXFR/RNDC controls. PowerDNS runs as an external service (see ADR-022); the admin panel connects to it via a configured API endpoint and does not manage the DNS server infrastructure itself.

DNS zone template management (view/edit the global template, re-apply to domains) is fully specified in **ND.3 DNS Zone Template Management**. ND.1 covers the DNS zone and record management layer: API connectivity, zones, records, DNSSEC, and slave sync.

See also: `POWERDNS_INTEGRATION.md`, `DNS_ZONE_TEMPLATES.md`, `SLI_SLO_DEFINITION.md` (DNS SLO: **99.95% availability**, p95 query latency **< 50 ms**), `ARCHITECTURE_DECISION_RECORDS.md` ADR-022 (external services).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **PowerDNS API connectivity** | API endpoint reachability, zone count, API latency, AXFR notify queue | 1 |
| **Zone list** | All zones across all customers — name, kind, DNS mode, record count, DNSSEC status, last AXFR | 1 |
| **Per-zone record editor** | Full CRUD on all DNS records for any zone — all record types, batch apply | 1 |
| **DNSSEC management** | Enable/disable per zone; view KSK/ZSK keys; copy DS record for registrar publication | 1 |
| **External slave status** | Per-slave health, last AXFR timestamp, zone lag, enable/disable individual slaves | 1 |
| **Manual AXFR notify** | Force-notify all external slaves for a specific zone | 1 |
| **Zone creation** | Create a new Primary (`Native`), CNAME, or Secondary (`Slave`) zone | 1 |
| **Zone deletion** | Delete a zone from PowerDNS with confirmation (customer's domain record is updated) | 1 |
| **SOA inspection** | View SOA record detail: primary NS, serial, refresh, retry, expire, minimum TTL | 1 |
| **RNDC controls** | Trigger RNDC `reload`, `notify`, and `status` from the panel (Phase 2 multi-region) | 2 |
| **Propagation monitor** | Track SOA propagation to all nameservers after a zone change (polling status) | 1 |
| **Alert surface** | `PowerDNSAPIUnreachable`, `PowerDNSAPILatencyHigh`, `PowerDNSExternalSlaveDown`, `PowerDNSAXFRFailure`, `DNSSECDSRecordMissing` | 1 |

---

#### PowerDNS API Connectivity

**Admin Panel → DNS → Overview**

| Field | Example | Notes |
|-------|---------|-------|
| API endpoint | `https://dns.example.com/api/v1` | Configured in External Service Configuration |
| API reachability | `● Connected` / `✗ Unreachable` | Critical banner if unreachable (`PowerDNSAPIUnreachable`) |
| API response time | `4 ms` | Warning if > 1000 ms (`PowerDNSAPILatencyHigh`) |
| Zones total | `847` | |
| Records total | `23,418` | |
| DNSSEC-signed zones | `312` | |
| External slaves | `2 / 2 healthy` | Critical if any slave down |
| AXFR success rate (1h) | `100%` | Critical if < 50% |
| PowerDNS availability (30d) | `100%` | SLO target: **99.95%** (21.6 min/month error budget) |
| Query p95 latency (1h) | `12 ms` | SLO target: **< 50 ms** |

Alerts surfaced here: `PowerDNSAPIUnreachable` (Critical), `PowerDNSAPILatencyHigh` (Warning), `PowerDNSExternalSlaveDown` (Critical), `PowerDNSAXFRFailure` (Critical), `DNSSECDSRecordMissing` (Warning), `DNSSECValidationFailed` (Critical).

---

#### Zone List

**Admin Panel → DNS → Zones**

Filterable, sortable table:

| Column | Notes |
|--------|-------|
| Zone name | e.g. `acme.com.` — clickable to open record editor |
| Customer | Owning client — clickable |
| Kind | `Native` (Primary) / `Slave` (Secondary) |
| DNS mode | `Primary` / `Secondary` / `CNAME` (CNAME zones have no PowerDNS entry) |
| Records | Count of resource record sets |
| DNSSEC | `● Signed` / `○ Unsigned` |
| DS published | `● Yes` / `○ No` / `✗ Missing (24h+)` |
| Last AXFR | UTC timestamp of last successful AXFR to any slave |
| Status | `● Active` / `↻ Provisioning` / `✗ Error` |
| Actions | Edit records, DNSSEC, Force notify, Delete |

Filter: by customer, kind, DNSSEC status, DS published status.

---

#### Per-Zone Record Editor

**Admin Panel → DNS → Zones → {zone} → Records**

Zone header: zone name, customer, SOA serial, kind, DNSSEC badge, record count.

Record table:

| Column | Notes |
|--------|-------|
| Name | FQDN (e.g. `acme.com.`, `www.acme.com.`) |
| Type | `A` / `AAAA` / `CNAME` / `LUA` / `MX` / `TXT` / `NS` / `SRV` / `CAA` / `SOA` / `DNSKEY` / etc. |
| TTL | Seconds |
| Content | Record value (multi-line for MX priority, SRV weight/port, TXT content) |
| Auto-managed | Badge for records managed by the platform (SOA, DNSKEY, RRSIG, NSEC/NSEC3) — editable only by Platform Admin |
| Actions | Edit, Delete |

**Create / edit record form:**

| Field | Notes |
|-------|-------|
| Name | Subdomain or `@` for apex |
| Type | Dropdown of all supported types |
| TTL | Integer (seconds); recommended values shown (60 / 300 / 3600) |
| Content | Type-aware input — MX shows priority + hostname fields; SRV shows weight/port/target |
| Disabled | Toggle to disable a record without deleting it |

Changes are applied as a `PATCH rrsets` batch to the PowerDNS API. SOA serial is auto-incremented (`gpgsql-soa-edit-api=DEFAULT`). After each change, a notify is sent to all configured external slaves.

**Supported record types (all PowerDNS-native):** A, AAAA, CNAME, LUA, MX, TXT, NS, SRV, CAA, SOA, DNSKEY, RRSIG, NSEC, NSEC3, DS, PTR.

> **LUA records (apex ALIAS):** The apex A record uses a LUA record (`ifportup(80, {'<ingress-ip>'})`) for health-checked dynamic DNS. This is managed automatically by the platform — admins can view but should not manually edit unless overriding platform behaviour. TTL is set to 60s; answers are not cached for longer.

---

#### DNSSEC Management

**Admin Panel → DNS → Zones → {zone} → DNSSEC**

Status panel:

| Field | Notes |
|-------|-------|
| DNSSEC enabled | `● Yes` / `○ No` |
| KSK | Key tag, algorithm (`ECDSAP256SHA256`), public key (truncated), next rotation date |
| ZSK | Key tag, algorithm, public key (truncated), next rotation date (every 30 days) |
| DS record | `keytag algorithm digest_type digest` — copy-to-clipboard button |
| DS published | `● Verified in parent zone` / `○ Not detected` / `✗ Missing for 24h+` |
| NSEC mode | `NSEC` / `NSEC3` (configurable at enable time) |

**Actions:**

| Action | Notes |
|--------|-------|
| **Enable DNSSEC** | Generates KSK + ZSK; returns DS record for customer to add at registrar |
| **Disable DNSSEC** | Warning: customer must remove DS record within 24h to avoid DNSSEC validation failures |
| **Copy DS record** | Copies formatted DS record to clipboard |
| **Check DS in parent** | Live DNS lookup to verify DS record is present in the parent TLD zone |

DNSSEC key rotation is fully automatic — ZSK every 30 days, KSK every 365 days. No admin action required. `DNSSECKeyRotationDue` alert fires 7 days before rotation as an informational notice.

---

#### External Slave Status

**Admin Panel → DNS → Slaves**

| Column | Notes |
|--------|-------|
| Hostname | e.g. `ns2.external.com` |
| IP | e.g. `203.0.113.10` |
| Enabled | Toggle |
| Status | `● Healthy` / `✗ Unreachable` |
| Zones synced | Count of zones successfully replicated |
| Last AXFR | UTC timestamp of most recent successful transfer |
| Zone lag (max) | Largest lag across all zones (seconds) — Warning if > 300s |
| Actions | Force AXFR all zones, Disable, Remove |

**Add slave form:** hostname, IP address, enable toggle. Saving updates `allow-axfr-ips` and triggers a full AXFR notify for all zones.

**Force AXFR** — triggers `rndc notify <zone>` for every zone on the master, instructing slaves to pull immediately. Displays a progress indicator; zones are acknowledged as slaves respond.

---

#### Manual AXFR Notify (Per Zone)

**Admin Panel → DNS → Zones → {zone} → Force Notify**

Button on the zone detail page. Sends a notify request via the PowerDNS API. The notify queue drains within seconds under normal conditions. Propagation monitor (SOA polling) activates and shows per-nameserver confirmation status:

| Nameserver | SOA serial queried | Match master | Confirmed |
|-----------|-------------------|--------------|-----------|
| `ns1.platform.com` | `2026030801` | `● Yes` | 0.2s |
| `ns2.external.com` | `2026030801` | `● Yes` | 2.1s |
| `ns3.external.com` | `⟳ Polling…` | — | — |

Timeout: 300 seconds. Unconfirmed nameservers shown with last-known SOA serial.

---

#### SOA Inspection

**Admin Panel → DNS → Zones → {zone} → SOA**

| Field | Value |
|-------|-------|
| Primary NS | `ns1.platform.com.` |
| Hostmaster | `hostmaster.acme.com.` |
| Serial | `2026030801` |
| Refresh | `10800` (3h) |
| Retry | `3600` (1h) |
| Expire | `604800` (7d) |
| Minimum TTL | `3600` (1h) |

SOA serial is auto-managed by PowerDNS (`soa-edit-api=DEFAULT` — increments on every API change). Manual serial override is available to Platform Admins for zone migration scenarios.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/dns/health` | PowerDNS API connectivity, zone count, API latency, SLO availability (30d), AXFR queue |
| `GET` | `/api/v1/admin/dns/zones` | List all zones (filter: `customer_id`, `kind`, `dnssec`, `ds_published`) |
| `POST` | `/api/v1/admin/dns/zones` | Create zone (`name`, `kind`: `Native`/`Slave`, `dns_mode`, `masters[]` for Slave) |
| `GET` | `/api/v1/admin/dns/zones/{zone}` | Get zone detail: records, SOA, DNSSEC status, last AXFR |
| `DELETE` | `/api/v1/admin/dns/zones/{zone}` | Delete zone from PowerDNS (`reason` required) |
| `GET` | `/api/v1/admin/dns/zones/{zone}/records` | List all resource record sets for a zone |
| `PATCH` | `/api/v1/admin/dns/zones/{zone}/records` | Batch create/update/delete records (`rrsets[]` with `changetype`) |
| `GET` | `/api/v1/admin/dns/zones/{zone}/dnssec` | Get DNSSEC status: KSK/ZSK keys, DS record, DS published flag |
| `POST` | `/api/v1/admin/dns/zones/{zone}/dnssec/enable` | Enable DNSSEC (`nsec3param` optional) |
| `POST` | `/api/v1/admin/dns/zones/{zone}/dnssec/disable` | Disable DNSSEC (with warning) |
| `POST` | `/api/v1/admin/dns/zones/{zone}/dnssec/check-ds` | Live DNS lookup to verify DS record in parent zone |
| `POST` | `/api/v1/admin/dns/zones/{zone}/notify` | Force AXFR notify for zone to all configured slaves |
| `GET` | `/api/v1/admin/dns/zones/{zone}/propagation` | SOA propagation status per nameserver |
| `GET` | `/api/v1/admin/dns/slaves` | List external slaves with health, last AXFR, zone lag |
| `PUT` | `/api/v1/admin/dns/slaves` | Add/update/remove external slave configuration |
| `POST` | `/api/v1/admin/dns/slaves/notify-all` | Force AXFR notify for all zones to all slaves |

### ND.2 SSL Certificate Management

**Requirement:** Manage TLS certificates issued via cert-manager (Let's Encrypt wildcard/single-domain) and custom certificates uploaded through the CSR workflow. See `03-security/TLS_CERTIFICATE_MANAGEMENT.md` for full cert strategy.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Global certificate list** | Filterable table of all certificates across all clients — see column spec below | 1 |
| **Per-domain SSL detail panel** | Full certificate metadata view — see field spec below | 1 |
| **Certificate status badge** | Compact badge in domain list column — see badge spec below | 1 |
| **Force renew** | Trigger immediate cert-manager renewal regardless of expiry window | 1 |
| **Revoke** | Revoke cert with Let's Encrypt and issue a new one | 1 |
| **View raw cert** | Display certificate PEM + full chain in a modal | 1 |
| **View download log** | List all API token downloads for a certificate (token name, timestamp, IP) | 1 |
| **Switch cert type** | Convert between wildcard and single-domain — triggers re-issuance | 2 |
| **Custom cert install (admin)** | Admin can paste/upload a custom signed cert on behalf of a client | 2 |

**Global Certificate List (Admin Panel → Certificates):**

Filterable by: client, domain, cert type, status, expiry range, auto-renew.

| Column | Notes |
|--------|-------|
| Domain | Clickable — navigates to domain detail |
| Client | Clickable — navigates to client detail |
| Type | `Wildcard` / `Single-domain` / `Custom` |
| Expiry | Date + days remaining (colour-coded: green >30, amber 8–30, red ≤7) |
| Status | `Valid` / `Expiring soon` / `Expired` / `Renewal pending` / `Error` |
| Auto-renew | `Yes` / `No` |
| Actions | Force renew, View details, Revoke |

**Per-Domain SSL Detail Panel (Admin Panel → Clients → {client} → Domains → {domain} → SSL):**

| Field | Value |
|-------|-------|
| Certificate type | `Wildcard (Let's Encrypt)` / `Single-domain (Let's Encrypt)` / `Custom (external CA)` |
| Common Name | e.g. `*.example.com` |
| SANs | e.g. `*.example.com`, `example.com` |
| Issuer | `Let's Encrypt Authority X3` / CA name |
| Valid from | ISO date |
| Valid until | ISO date |
| Days remaining | Integer, colour-coded: green >30, amber 8–30, red ≤7 |
| Auto-renewal | `Enabled` / `Disabled (custom cert)` |
| ACME challenge | `DNS-01` / `HTTP-01` / `n/a (custom)` |
| Cert secret | Kubernetes Secret name (e.g. `client-acme-example-com-wildcard-tls`) |
| Last renewed | UTC timestamp |
| Subdomains using this cert | List of subdomains sharing the wildcard |
| API token downloads | Count of times private key has been fetched via API token — links to download log |

**Certificate Status Badge (domain list column):**

| Badge | Meaning |
|-------|---------|
| `✓ Valid (87d)` | Certificate valid — days remaining shown |
| `⚠ Expiring (12d)` | Within 30-day renewal window — renewal may be in progress |
| `✗ Expired` | Certificate expired — immediate action required |
| `↻ Renewing` | cert-manager renewal in progress |
| `! Error` | Renewal failed — click for details |
| `Custom` | Custom certificate installed — manual renewal |

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/certificates` | List all certificates (supports filter params: `client_id`, `domain_id`, `type`, `status`, `expiry_before`) |
| `GET` | `/api/v1/admin/certificates/{cert_id}` | Get full certificate detail |
| `POST` | `/api/v1/domains/{id}/certificates/renew` | Force immediate renewal |
| `POST` | `/api/v1/domains/{id}/certificates/revoke` | Revoke certificate |
| `GET` | `/api/v1/domains/{id}/certificates/raw` | Return PEM certificate + chain (no private key) |
| `GET` | `/api/v1/certs/{domain}/download` | Customer-facing PEM bundle download — authenticated via scoped `cert:read` Bearer token |
| `GET` | `/api/v1/admin/certificates/{cert_id}/download-log` | View API token download history for a certificate |
| `GET` | `/api/v1/admin/domains/{id}/cert-tokens` | List active `cert:read` API tokens for a domain |
| `DELETE` | `/api/v1/admin/domains/{id}/cert-tokens/{token_id}` | Revoke a customer cert download token (admin override) |
| `POST` | `/api/v1/domains/{id}/certificates/switch` | Switch cert type (`wildcard` ↔ `single`) — triggers re-issuance |

---

### ND.3 DNS Zone Template Management

**Requirement:** Define and manage the global DNS zone template applied to all new customer domains in Primary DNS mode. The template ensures every domain is immediately operational for web and email without any manual DNS configuration.

**Features (Phase 1):**

| Feature | Specification | Phase |
|---------|---|---|
| **View Template** | Display current global template as record table and YAML | 1 |
| **Edit Template** | Add, modify, or disable individual records in the template | 1 |
| **Template Variables** | `{{platform.*}}` and `{{domain.*}}` placeholders resolved at apply-time | 1 |
| **Preview** | Render template for a test domain — shows exact records that would be created | 1 |
| **Re-apply to Domains** | Non-destructive re-apply to selected domains — domain list with Select All / None / individual selection | 1 |
| **Per-Domain DNS Editor (Admin)** | Full CRUD on all DNS records for any customer domain — no template restrictions | 1 |
| **Per-Domain DNS Editor (Customer)** | Full CRUD on all DNS records for own domains via client panel | 1 |

> **Re-apply is non-destructive:** adds missing records and updates changed records from the template. Never deletes existing records on the domain. Customer custom records are always preserved.

**Template Records Included by Default:**

| Record | Purpose |
|---|---|
| `A` / `AAAA` | Apex → platform ingress |
| `CNAME www` | www → apex |
| `MX` | Inbound mail → platform mail server |
| `TXT SPF` | `v=spf1 include:mail.platform.com ~all` |
| `TXT DKIM` | Per-domain DKIM public key (generated at provisioning) |
| `TXT DMARC` | `_dmarc` → `p=none` reporting policy |
| `CNAME webmail` | `webmail.<domain>` → `webmail.platform.com` |
| `CNAME mail` | `mail.<domain>` → `mail.platform.com` |
| `CNAME autodiscover` | Outlook autodiscover CNAME |
| `CNAME autoconfig` | Thunderbird autoconfig CNAME |
| `SRV _imaps._tcp` | IMAP over TLS — port 993 (RFC 6186) |
| `SRV _imap._tcp` | IMAP + STARTTLS — port 143 (RFC 6186) |
| `SRV _submissions._tcp` | SMTP implicit TLS — port 465 (RFC 8314) |
| `SRV _submission._tcp` | SMTP + STARTTLS — port 587 (RFC 6186) |
| `SRV _autodiscover._tcp` | Microsoft Outlook autodiscovery — port 443 |
| `CAA` | Restrict certificate issuance to Let's Encrypt only |

**Template Editor UI (Admin Panel → Settings → DNS → Zone Template):**

```
┌──────────────────────────────────────────────────────────────────┐
│  DNS Zone Template                                               │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ [Table View] [YAML View]           [Preview for domain] │    │
│  ├──────────┬──────┬──────┬───────────────────────┬───────┤    │
│  │ Name     │ Type │ TTL  │ Content               │       │    │
│  ├──────────┼──────┼──────┼───────────────────────┼───────┤    │
│  │ @        │ A    │ 300  │ {{platform.ingress_ipv4}} │ ✎ 🗑 │    │
│  │ @        │ AAAA │ 300  │ {{platform.ingress_ipv6}} │ ✎ 🗑 │    │
│  │ www      │CNAME │ 300  │ {{domain.name}}.       │ ✎ 🗑 │    │
│  │ @        │ MX   │ 3600 │ 10 {{platform.mail_hostname}}. │ ✎ 🗑 │    │
│  │ @        │ TXT  │ 3600 │ v=spf1 ...             │ ✎ 🗑 │    │
│  │ default._domainkey │TXT│3600│{{domain.dkim_public_key}}│ ✎ 🗑│    │
│  │ _dmarc   │ TXT  │ 3600 │ v=DMARC1; p=none; ... │ ✎ 🗑 │    │
│  │ _imaps._tcp│ SRV│3600 │ 10 10 993 ...          │ ✎ 🗑 │    │
│  │ ...      │ ...  │ ...  │ ...                    │      │    │
│  └──────────┴──────┴──────┴───────────────────────┴───────┘    │
│                                                                  │
│  [+ Add Record]                                                  │
│                                                                  │
│  ℹ Applied automatically at new domain provisioning.             │
│    Use [Re-apply to Domains] to push changes to existing ones.   │
│                                                                  │
│  [Preview for: example.com]  [Re-apply to Domains]  [Save]      │
└──────────────────────────────────────────────────────────────────┘
```

**Re-apply to Domains UI (Admin Panel → Settings → DNS → Zone Template → Re-apply to Domains):**

```
┌────────────────────────────────────────────────────────────────────┐
│  Re-apply DNS Zone Template                                        │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Mode: Non-destructive                                             │
│  ℹ Adds missing records and updates changed records only.          │
│    Existing records outside the template are never deleted.        │
│                                                                    │
│  [Select All]  [Select None]                Search: [___________]  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ [✓] acme.com              Business  · Primary  · Active     │  │
│  │ [✓] betacorp.net          Premium   · Primary  · Active     │  │
│  │ [ ] example.org           Starter   · Primary  · Active     │  │
│  │ [✓] shop.clientx.co.za   Business  · Primary  · Suspended  │  │
│  │ [—] otherdomain.com       Starter   · CNAME    · (excluded) │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  3 of 4 eligible domains selected                                  │
│  (CNAME and Secondary mode domains are not eligible)               │
│                                                                    │
│  [Cancel]                        [Re-apply to 3 domains →]        │
└────────────────────────────────────────────────────────────────────┘
```

**API Endpoints:**
- `GET /api/v1/admin/dns-template` — Get current template
- `PUT /api/v1/admin/dns-template` — Update template
- `POST /api/v1/admin/dns-template/preview` — Preview rendered for a domain
- `POST /api/v1/admin/dns-template/reapply` — Non-destructive re-apply to selected or all Primary-mode domains
- `GET /api/v1/clients/{id}/domains/{domain_id}/records` — List all DNS records for a domain
- `POST /api/v1/clients/{id}/domains/{domain_id}/records` — Add a record
- `PUT /api/v1/clients/{id}/domains/{domain_id}/records/{record_id}` — Update a record
- `DELETE /api/v1/clients/{id}/domains/{domain_id}/records/{record_id}` — Delete a record

**Reference:** See `../01-core/DNS_ZONE_TEMPLATES.md` for full specification.

---

## Security & Access Control

### SA.1 OIDC Authentication Management

**Requirement:** Operational management of the external OIDC provider — the platform identity layer that underpins all admin, staff, and client authentication. The OIDC provider runs as an external service (see ADR-022); the admin panel connects to it via a configured issuer URL and does not manage the provider infrastructure itself. This section covers the operational view: provider reachability, signing keys, registered OIDC clients, and connector status.

Provider configuration (adding/editing Google, Apple, GitHub, and custom OIDC providers) and the login UX are fully specified in **AU.1 Multi-Provider OIDC Authentication** (see the Authentication section of this document). SA.1 does not duplicate that content.

See also: `03-security/SECURITY_ARCHITECTURE.md` (JWT validation, JWKS config, token lifecycle) and `ARCHITECTURE_DECISION_RECORDS.md` ADR-004 (OIDC provider decision), ADR-022 (external services).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **OIDC provider health** | Real-time endpoint reachability for the external OIDC provider | 1 |
| **JWKS / signing key status** | Current signing key ID, algorithm, age, and next rotation | 1 |
| **Registered OIDC clients** | List of applications registered as OIDC clients in the external provider | 1 |
| **Connector status** | Per-connector health for each configured upstream provider | 1 |
| **Active session count** | Number of currently valid access and refresh tokens | 1 |
| **Auth event log** | Filtered view of OIDC login events across all accounts | 1 |
| **Force signing key rotation** | Immediately rotate OIDC signing keys (emergency action — requires provider API support) | 2 |
| **Revoke all sessions** | Invalidate all active refresh tokens for a user or globally | 2 |

---

#### OIDC Provider Health

**Admin Panel → Security → OIDC → Health**

| Field | Value |
|-------|-------|
| Issuer URL | Configured issuer URL — clickable to `/.well-known/openid-configuration` |
| Discovery endpoint | `● Reachable` / `✗ Unreachable` — live HTTP check |
| JWKS endpoint | `● Reachable` / `✗ Unreachable` — live HTTP check |
| Token endpoint | `● Reachable` / `✗ Unreachable` — live HTTP check |
| Last checked | Timestamp of most recent health check |

An inline alert banner appears if any endpoint is unreachable, with a link to the `Authentication/OIDC Failures` section of the incident response runbook.

---

#### JWKS / Signing Key Status

The OIDC provider signs all JWTs with a signing key. The admin panel reads the current key metadata (not the private key material) via the JWKS endpoint.

| Field | Value |
|-------|-------|
| Key ID (`kid`) | Hex identifier of the active signing key |
| Algorithm | `RS256` |
| Key age | Duration since the key was generated |
| Rotation policy | Managed by the external OIDC provider — rotation schedule depends on provider configuration |
| Previous key (`kid`) | Prior key ID still accepted during rotation overlap window |

> **Emergency key rotation:** If a signing key is suspected compromised, the admin can trigger immediate rotation via the "Force Key Rotation" action (requires the external OIDC provider to support key rotation via API). All existing access tokens become invalid immediately; refresh tokens remain valid and will obtain new access tokens signed with the new key on next use.

---

#### Registered OIDC Clients

Every application that authenticates via the OIDC provider must be registered as a client with a client ID, secret, and allowed redirect URIs. The admin panel shows the current registered client list (read-only — changes require updating the OIDC provider configuration).

| Client ID | Application | Redirect URIs | Grant types |
|-----------|-------------|---------------|-------------|
| `management-api` | Admin/Client Panel | `https://panel.platform.com/auth/callback` | `authorization_code`, `refresh_token` |
| `netbird` | NetBird VPN dashboard | `https://netbird.platform.com/auth/callback` | `authorization_code` |
| `filebrowser` | FileBrowser (client file manager) | `https://files.{domain}/auth/callback` | `authorization_code` |
| `grafana` | Grafana monitoring | `https://grafana.platform.com/login/generic_oauth` | `authorization_code` |

> **Adding or modifying a client** requires updating the external OIDC provider configuration. The panel surfaces what is configured — it does not provide a live editor for OIDC clients. This is intentional: client changes are infrastructure changes managed outside the admin UI.

---

#### Connector Status

Each upstream identity provider configured in the OIDC provider is a "connector". The panel shows the health of each by performing a test discovery/token exchange.

| Connector | Type | Status | Last tested |
|-----------|------|--------|-------------|
| `google` | OIDC | `● Healthy` / `⚠ Degraded` / `✗ Error` | Timestamp |
| `apple` | OIDC | `● Healthy` / `⚠ Degraded` / `✗ Error` | Timestamp |
| `github` | OAuth2 | `● Healthy` / `⚠ Degraded` / `✗ Error` | Timestamp |
| `local` | Local passwords (fallback) | `● Healthy` / `Disabled` | — |

Status is determined by testing the connector's discovery URL or token endpoint reachability. A degraded upstream provider (e.g. a Google outage) is surfaced here before users start reporting login failures.

> For adding and configuring connectors (Google OAuth app credentials, Apple developer keys, etc.), see **AU.1** in the Authentication section.

---

#### Auth Event Log

**Admin Panel → Security → OIDC → Audit Log**

Filterable by: account, provider/connector, event type, date range, outcome (success/failure).

| Column | Notes |
|--------|-------|
| Timestamp | UTC |
| Account | Username / email |
| Account type | `Admin` / `Staff` / `Client` |
| Provider | `google` / `apple` / `github` / `local` |
| Event | `login` / `logout` / `token_refresh` / `login_failure` / `link` / `unlink` |
| Outcome | `✓ Success` / `✗ Failed` |
| IP address | Source IP |
| Failure reason | OIDC error code if applicable (e.g. `access_denied`, `invalid_grant`) |

This view is the first stop when investigating a reported login problem. The full event taxonomy (8 event types) is specified in AU.1.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/oidc/health` | OIDC provider reachability: issuer URL, discovery endpoint, JWKS endpoint |
| `GET` | `/api/v1/admin/oidc/keys` | Current and previous signing key metadata (no private key material) |
| `POST` | `/api/v1/admin/oidc/keys/rotate` | Force immediate signing key rotation (requires external OIDC provider API support) |
| `GET` | `/api/v1/admin/oidc/clients` | List registered OIDC clients |
| `GET` | `/api/v1/admin/oidc/connectors` | List configured connectors with health status |
| `POST` | `/api/v1/admin/oidc/connectors/{id}/test` | Test a specific connector's upstream reachability |
| `GET` | `/api/v1/admin/oidc/sessions` | Active session count (access + refresh tokens) per account type |
| `DELETE` | `/api/v1/admin/oidc/sessions/{account_id}` | Revoke all refresh tokens for a specific account |
| `DELETE` | `/api/v1/admin/oidc/sessions` | Revoke all active refresh tokens globally (emergency action) |
| `GET` | `/api/v1/admin/oidc/audit` | Auth event log (filter: `account`, `provider`, `event`, `from`, `to`, `outcome`) |

### SA.2 Admin Security & Access Control

**Requirement:** Manage platform admin and staff accounts, role assignments, MFA enforcement, IP allowlisting, active sessions, and the admin activity audit log. The underlying role model (six built-in roles, permission format `resource:action:scope`, assignment constraints, and middleware) is fully specified in `AUTHORIZATION_MATRIX.md`. This section defines the admin panel UI surface over that model.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Admin account list** | Table of all admin/staff accounts with role, MFA status, last login, status | 1 |
| **Invite admin** | Send email invitation to a new admin or staff member | 1 |
| **Assign / change role** | Assign one of the six built-in roles (or a custom role) to an account | 1 |
| **Suspend / unsuspend account** | Block a specific admin from logging in without deleting the account | 1 |
| **Delete account** | Permanently remove an admin account; requires confirmation | 1 |
| **MFA status per account** | View whether each admin has MFA active on their OIDC provider | 1 |
| **Require MFA globally** | Toggle: all admin accounts must have MFA on their upstream OIDC provider to log in | 1.5 |
| **TOTP / U2F enrolment** | Platform-level TOTP and U2F (security key) as second factor, independent of OIDC provider MFA | 1.5 |
| **IP allowlist** | Restrict admin panel access to a list of CIDR ranges; requests from unlisted IPs receive 403 | 2 |
| **Active sessions** | List all live admin sessions; force-logout any session | 1 |
| **Role management** | Create, edit, and delete custom roles with fine-grained permission selection | 2 |
| **Admin activity log** | Filterable audit trail of all admin actions — see audit log spec below | 1 |

---

#### Admin Account List

**Admin Panel → Security → Admins**

Filterable by: role, MFA status, account status (active/suspended).

| Column | Notes |
|--------|-------|
| Name | Full name |
| Email | Login email |
| Role | Badge: `Platform Admin` / `Region Admin` / `Support Staff` / `Viewer` / custom role name |
| Scope | `Global` / region name / client name (where applicable) |
| MFA | `● Enabled` / `⚠ Not configured` |
| Last login | Relative timestamp + IP |
| Status | `Active` / `Suspended` |
| Actions | Edit role, Suspend/Unsuspend, Force logout, Delete |

Clicking an account opens a detail panel showing: full role assignment history, all active sessions, recent audit events for that account, and linked OIDC providers.

---

#### Role Assignment

**Admin Panel → Security → Admins → {account} → Edit Role**

The six built-in roles from `AUTHORIZATION_MATRIX.md` are selectable from a dropdown. Region Admin and Client Admin require a scope selection (which region or client the role applies to).

| Role | Scope required | Notes |
|------|---------------|-------|
| `Platform Admin` | None (global) | Full wildcard permissions on all resources |
| `Region Admin` | Region | Full CRUD within assigned region; can assign `client_admin` to clients in region |
| `Client Admin` | Client | Full CRUD on own client resources; can assign `client_user` to team members |
| `Client User` | Client | Read + limited start/stop on own resources |
| `Support Staff` | None (global read-only) | Read-only across all; can create/update support tickets |
| `Viewer` | Client | Pure read-only on assigned client |

Assignment constraints enforced by the panel (from `AUTHORIZATION_MATRIX.md`):
- `Support Staff` cannot assign any role to anyone
- `Region Admin` can only assign `client_admin` — not `platform_admin` or `region_admin`
- `Platform Admin` can assign any role
- A user cannot assign a role higher than their own

Every role change is written to `audit_logs` with `AUTHZ_ROLE_ASSIGNED` or `AUTHZ_ROLE_REVOKED` event type, including `before`/`after` JSON.

---

#### MFA Management

**Phase 1 — OIDC-delegated MFA:**

MFA is currently delegated to the upstream OIDC provider (Google, Apple, GitHub). The panel shows whether each admin's OIDC provider account has MFA active (read from the OIDC token claims where available) and surfaces a global toggle:

| Setting | Default | Effect |
|---------|---------|--------|
| Require MFA for all admins | Off | When enabled: admin logins are rejected at the panel if the OIDC provider did not assert MFA in the `amr` claim |

**Phase 1.5 — Platform-level TOTP / U2F:**

The platform adds its own second-factor layer independent of the OIDC provider:

| Method | Description |
|--------|-------------|
| TOTP | RFC 6238 time-based one-time password — customer scans QR code in authenticator app (Google Authenticator, Authy, etc.) |
| U2F / FIDO2 | Hardware security key (YubiKey, etc.) — WebAuthn API |

MFA is enforced **after** OIDC login completes. Flow:
```
1. Admin completes OIDC login → receives short-lived "pre-MFA" session token
2. Panel prompts for TOTP code or security key tap
3. On success → full session token issued
4. On failure → AUTH_MFA_FAILED event logged; fail2ban jail `panel-auth` increments counter
```

Enrolment: Admin Panel → Profile → Security → Enable Two-Factor Authentication.

The `billing:manage` permission always requires MFA re-verification at action time, regardless of session MFA state (enforced by the permission middleware per `AUTHORIZATION_MATRIX.md`).

---

#### IP Allowlist

**Admin Panel → Security → Admins → IP Allowlist** (Phase 2)

CIDR ranges from which admin panel login is permitted. Requests from IPs not matching any entry receive `403 Forbidden` before the OIDC redirect.

| Field | Notes |
|-------|-------|
| CIDR | e.g. `192.0.2.0/24`, `203.0.113.5/32` |
| Label | Human note (e.g. `"Office"`, `"Home VPN"`) |
| Added by | Admin username |
| Added at | Timestamp |
| Actions | Delete |

> **Lockout guard:** The panel requires at least one active CIDR entry before enabling the allowlist. The admin's current IP is highlighted and must be included before saving — prevents self-lockout.

The allowlist is enforced at the Management API ingress layer (NGINX Ingress annotation `nginx.ingress.kubernetes.io/whitelist-source-range`), not at the application layer, so it cannot be bypassed even if the application has a bug.

---

#### Active Sessions

**Admin Panel → Security → Admins → Sessions**

| Column | Notes |
|--------|-------|
| Account | Admin name + email |
| Role | Current role |
| Logged in | Timestamp |
| Last active | Last API request timestamp |
| IP address | Source IP of the session |
| User agent | Browser / client |
| MFA | `● Verified` / `⚠ OIDC only` |
| Actions | Force logout |

Force logout invalidates the refresh token for that session immediately. The admin whose session was terminated sees a `Session terminated by administrator` message on their next API request. The action is logged with `AUTH_SESSION_REVOKED` event.

---

#### Custom Role Management

**Admin Panel → Security → Roles** (Phase 2)

| Feature | Description |
|---------|-------------|
| **Role list** | Table of all roles: built-in (read-only) and custom (editable) |
| **Create role** | Name, description, scope type, permission checkboxes |
| **Edit role** | Modify permissions on custom roles; built-in roles are immutable |
| **Delete role** | Only if no accounts are currently assigned to this role |
| **Permission picker** | Grouped checkbox tree: resource → action → scope for each permission string |
| **Preview** | Shows exactly what the role can and cannot do before saving |

Permission strings follow the `resource:action:scope` format from `AUTHORIZATION_MATRIX.md`. Wildcards (`*`) are not available in the custom role picker — only explicit actions can be selected (wildcards are reserved for `Platform Admin`).

---

#### Admin Activity Log

**Admin Panel → Security → Admins → Activity Log**

The primary audit surface for admin actions. Backed by the `audit_logs` table (see `DATABASE_SCHEMA.md`) with 7-year retention. Filterable by: admin account, event category, event type, resource type, outcome, date range.

| Column | Notes |
|--------|-------|
| Timestamp | UTC |
| Admin | Name + email |
| Role | Role at time of action |
| IP address | Source IP |
| Event type | e.g. `AUTHZ_ROLE_ASSIGNED`, `CONFIG_PLAN_CHANGED`, `DATA_BULK_DELETE` |
| Category | `AUTH` / `AUTHZ` / `RESOURCE` / `DATA` / `CONFIG` / `SECURITY` |
| Severity | `INFO` / `WARNING` / `CRITICAL` |
| Resource | Type + ID of affected resource |
| Changes | `before` / `after` diff — expandable inline |
| Status | `✓ Success` / `✗ Failed` |

Events of severity `CRITICAL` (e.g. `AUTHZ_PRIVILEGE_ESCALATION`, `DATA_BULK_DELETE`) are highlighted in red and trigger a panel notification to all `Platform Admin` accounts.

Full event taxonomy (40+ event codes across 8 categories) is defined in `EVENT_LOGGING_STRATEGY.md`.

**Export:** Activity log can be exported as CSV for a selected date range — used for compliance audits.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/admins` | List all admin/staff accounts (filter: `role`, `mfa_status`, `status`) |
| `POST` | `/api/v1/admin/admins/invite` | Send invitation email to a new admin (`email`, `role`, `scope_id`) |
| `GET` | `/api/v1/admin/admins/{id}` | Get account detail: role history, sessions, recent audit events |
| `PUT` | `/api/v1/admin/admins/{id}/role` | Assign or change role (`role_id`, `scope_type`, `scope_id`) |
| `POST` | `/api/v1/admin/admins/{id}/suspend` | Suspend account |
| `POST` | `/api/v1/admin/admins/{id}/unsuspend` | Unsuspend account |
| `DELETE` | `/api/v1/admin/admins/{id}` | Delete account (requires confirmation token) |
| `GET` | `/api/v1/admin/admins/{id}/sessions` | List active sessions for a specific account |
| `DELETE` | `/api/v1/admin/admins/{id}/sessions/{session_id}` | Force-logout a specific session |
| `DELETE` | `/api/v1/admin/admins/{id}/sessions` | Force-logout all sessions for an account |
| `GET` | `/api/v1/admin/sessions` | List all active admin sessions across all accounts |
| `GET` | `/api/v1/admin/settings/mfa` | Get global MFA enforcement setting |
| `PUT` | `/api/v1/admin/settings/mfa` | Enable/disable global MFA requirement |
| `GET` | `/api/v1/admin/settings/ip-allowlist` | List IP allowlist entries |
| `POST` | `/api/v1/admin/settings/ip-allowlist` | Add CIDR entry (`cidr`, `label`) |
| `DELETE` | `/api/v1/admin/settings/ip-allowlist/{id}` | Remove CIDR entry |
| `GET` | `/api/v1/admin/roles` | List all roles (built-in + custom) |
| `POST` | `/api/v1/admin/roles` | Create custom role (`name`, `scope_type`, `permissions[]`) |
| `PUT` | `/api/v1/admin/roles/{id}` | Update custom role (custom roles only) |
| `DELETE` | `/api/v1/admin/roles/{id}` | Delete custom role (only if no accounts assigned) |
| `GET` | `/api/v1/admin/audit` | Admin activity log (filter: `actor_id`, `category`, `event_type`, `resource_type`, `from`, `to`, `status`) |
| `GET` | `/api/v1/admin/audit/export` | Export activity log as CSV for a date range |

### SA.3 fail2ban Management

**Requirement:** Full management of the fail2ban intrusion detection system across all layers. See `03-security/SECURITY_ARCHITECTURE.md` for the multi-layer fail2ban architecture (HTTP, SFTP, SSH, mail, management panel) and ban storage design (centralized Redis ban list).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Active bans list** | Filterable table of all currently banned IPs — see column spec below | 1 |
| **Ban history** | Log of all past bans with reason, duration, layer, and resolution | 1 |
| **Manual ban** | Admin manually bans an IP across all layers for a configurable duration | 1 |
| **Unban** | Admin releases an active ban immediately | 1 |
| **Whitelist management** | Add/remove IPs and CIDR ranges that are never banned (admin IPs, monitoring probes) | 1 |
| **Jail configuration** | Per-jail threshold settings (maxretry, findtime, bantime) — see jail list below | 2 |
| **Ban duration presets** | Admin configures the progressive ban ladder (e.g. 10min → 1hr → 24hr → permanent) | 2 |
| **Global ban toggle** | Emergency: pause all new bans (without removing active ones) | 2 |

**Active Bans List (Admin Panel → Security → fail2ban → Active Bans):**

| Column | Notes |
|--------|-------|
| IP address | Banned IP — click to view full ban history for that IP |
| Layer | `HTTP` / `SFTP` / `SSH` / `Mail` / `Panel` |
| Jail | Specific jail name (e.g. `nginx-botsearch`, `sshd`, `postfix`) |
| Banned since | Timestamp |
| Expires | Timestamp or `Permanent` |
| Reason | Log excerpt that triggered the ban |
| Actions | Unban, Extend ban, View history |

**Jails managed (per layer):**

| Layer | Jail name | Default maxretry | Default bantime |
|-------|-----------|-----------------|----------------|
| HTTP — brute force | `nginx-http-auth` | 5 | 10 min |
| HTTP — bot/scan | `nginx-botsearch` | 10 | 24 hr |
| SFTP | `sshd-sftp` | 3 | 1 hr |
| SSH (node-level) | `sshd` | 3 | 1 hr |
| Mail — SMTP auth | `postfix-sasl` | 5 | 1 hr |
| Mail — IMAP auth | `dovecot` | 5 | 1 hr |
| Management Panel | `panel-auth` | 5 | 30 min |

Progressive ban ladder (applied when same IP is banned repeatedly):

```
1st ban  → bantime as configured per jail
2nd ban  → 1 hour
3rd ban  → 24 hours
4th+ ban → Permanent (requires manual admin unban)
```

**Whitelist (Admin Panel → Security → fail2ban → Whitelist):**

- CIDR ranges and individual IPs never subject to banning
- Pre-populated with: admin NetBird mesh IPs, Prometheus/Grafana scrape IPs, uptime monitoring probe IPs
- Admin can add any IP or CIDR with a note (e.g. `"Office static IP"`, `"CI/CD runner"`)
- Changes take effect within 30 seconds (fail2ban ignoreip reload)

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/fail2ban/bans` | List active bans (filter: `layer`, `jail`, `ip`) |
| `GET` | `/api/v1/admin/fail2ban/history` | Ban history log (filter: `ip`, `layer`, `from`, `to`) |
| `POST` | `/api/v1/admin/fail2ban/bans` | Manually ban an IP (`ip`, `duration`, `reason`) |
| `DELETE` | `/api/v1/admin/fail2ban/bans/{ip}` | Unban an IP immediately |
| `GET` | `/api/v1/admin/fail2ban/whitelist` | List whitelisted IPs/CIDRs |
| `POST` | `/api/v1/admin/fail2ban/whitelist` | Add IP or CIDR to whitelist |
| `DELETE` | `/api/v1/admin/fail2ban/whitelist/{id}` | Remove entry from whitelist |
| `GET` | `/api/v1/admin/fail2ban/jails` | List all jails and their current configuration |
| `PUT` | `/api/v1/admin/fail2ban/jails/{jail}` | Update jail thresholds (`maxretry`, `findtime`, `bantime`) |

### SA.4 WAF Management

**Requirement:** Platform-wide administration of the ModSecurity v3 + OWASP CRS v4 WAF. The admin panel provides a global oversight layer: per-customer WAF enable/disable, platform-wide alert management, OWASP CRS rule update control, and global custom rule authoring. The full customer-facing WAF UI (mode switching, rule exclusions, logs, attack analytics) is specified in `06-features/WEB_APPLICATION_FIREWALL_SPECIFICATION.md` and is not duplicated here.

See also: `03-security/SECURITY_ARCHITECTURE.md` (WAF architecture), `ARCHITECTURE_DECISION_RECORDS.md` ADR-010 (NGINX Ingress + ModSecurity decision).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Global WAF dashboard** | Platform-wide WAF statistics: total blocks today, customers in blocking mode, active alerts, top attack types | 2 |
| **Per-customer WAF control** | Filterable table of all customers with WAF status — enable/disable per customer | 2 |
| **Platform-wide alert list** | All open WAF alerts across all customers — see alert spec below | 2 |
| **Alert acknowledgement** | Mark alerts as acknowledged or resolved; add internal notes | 2 |
| **OWASP CRS rule update control** | View current CRS version, staged next version, trigger phased rollout | 2 |
| **Global custom rules** | Author platform-wide ModSecurity rules that apply to all customers — see custom rule spec below | 2 |
| **Exclusion approval workflow** | Optional: require admin approval before a customer-submitted rule exclusion takes effect | 2 |
| **WAF statistics** | Aggregate blocks per day/week, top triggered rule IDs, top attack source IPs across platform | 2 |

---

#### Global WAF Dashboard

**Admin Panel → Security → WAF**

| Metric | Notes |
|--------|-------|
| Total requests today | Platform-wide count inspected by WAF |
| Total blocks today | Requests blocked across all customers |
| Block rate | Percentage of requests blocked |
| Customers with WAF enabled | Count + breakdown: OFF / DETECTION_ONLY / ON |
| Active alerts | Count by severity: Critical / Warning / Info |
| Top attack types | Bar chart: SQLi, XSS, RFI/LFI, scanner/bot, protocol violation |
| Top attacked customers | Ranked by block count in last 24 hours |
| CRS version | Current deployed version + whether an update is staged |

---

#### Per-Customer WAF Control

**Admin Panel → Security → WAF → Customers**

Filterable by: WAF status (enabled/disabled), mode (OFF/DETECTION/ON), paranoia level, plan.

| Column | Notes |
|--------|-------|
| Customer | Name — links to customer detail |
| Plan | Starter / Business / Premium |
| WAF enabled | Toggle — admin can override per customer regardless of plan default |
| Mode | `OFF` / `DETECTION_ONLY` / `ON` |
| Paranoia level | 1–4 (plan-constrained) |
| Blocks today | Count |
| Open alerts | Count — links to customer alert list |
| Actions | Enable/Disable, View config, View logs, View alerts |

> **Plan defaults:** WAF is off by default on Starter and Business; enabled by default on Premium. Admin can override the default for any individual customer in either direction.

**Admin override:** When an admin enables or disables WAF for a customer, the action is logged in the audit trail with `AUTHZ_PERMISSION_GRANTED` / `CONFIG_SETTINGS_UPDATED` event and a note that it was an admin override.

---

#### Platform-Wide Alert List

**Admin Panel → Security → WAF → Alerts**

Filterable by: customer, alert type, severity, status (open/acknowledged/resolved), date range.

| Column | Notes |
|--------|-------|
| Customer | Name |
| Alert type | `MULTIPLE_BLOCKS` / `REPEATED_PATTERN` / `SCANNER_DETECTED` / `RATE_LIMIT` / `CRITICAL_RULE` |
| Severity | `Critical` / `Warning` / `Info` |
| First seen | Timestamp |
| Last seen | Timestamp |
| Count | Number of events contributing to the alert |
| Status | `Open` / `Acknowledged` / `Resolved` |
| Auto-action | Whether the platform took automated action (e.g. temporary IP block) |
| Actions | Acknowledge, Resolve, View details, View customer WAF logs |

Alert thresholds (from `WEB_APPLICATION_FIREWALL_SPECIFICATION.md`):
- `MULTIPLE_BLOCKS` — same IP triggers > 10 blocks within 5 minutes
- `REPEATED_PATTERN` — same rule triggered > 50 times in 1 hour
- `SCANNER_DETECTED` — scanner/bot rule category (944xxx) triggered
- `CRITICAL_RULE` — any rule with severity CRITICAL fires

Critical alerts (`SCANNER_DETECTED`, `CRITICAL_RULE`) also fire the `security.waf_attack_surge` platform event, which triggers admin email + SMS notification.

---

#### OWASP CRS Rule Update Control

**Admin Panel → Security → WAF → Rule Updates**

ModSecurity OWASP CRS rules are updated monthly. Updates are staged and rolled out in phases to minimise false-positive impact.

| Field | Notes |
|-------|-------|
| Current CRS version | e.g. `4.0.0` — deployed to 100% of customers |
| Staged version | e.g. `4.1.0` — tested in staging, ready for rollout |
| Rollout status | `Not started` / `10% (canary)` / `50%` / `100% (complete)` |
| Canary customers | Names of customers receiving the update first (typically low-traffic, admin-selected) |
| Staged since | Timestamp when the staged version was pulled from upstream |
| Rollback available | Yes / No — whether the previous version is still available |

**Rollout actions:**

| Action | Description |
|--------|-------------|
| Start canary rollout | Apply staged version to selected canary customers (10%) |
| Expand to 50% | Apply to half of customers; monitor alert rate for 24 hours |
| Complete rollout | Apply to all remaining customers |
| Rollback | Revert all customers to the previous CRS version |
| Pause rollout | Halt expansion at current percentage — leave canary/50% as-is |

The platform monitors the block rate delta after each expansion step. If blocks increase > 20% compared to the pre-update baseline, the rollout is automatically paused and an admin alert is raised.

---

#### Global Custom Rules

**Admin Panel → Security → WAF → Custom Rules**

Admin-authored ModSecurity rules that apply to **all customers** across the platform, in addition to the OWASP CRS rules. These are platform-level rules not configurable by customers.

| Column | Notes |
|--------|-------|
| Rule ID | Numeric — must be in the custom range (1000001–1999999) |
| Name | Short description |
| Action | `DENY` / `LOG` / `REDIRECT` |
| Status | `Active` / `Disabled` |
| Matches today | Count of requests matched in last 24 hours |
| Added by | Admin name + timestamp |
| Actions | Edit, Enable/Disable, Delete, View matches |

**Rule editor fields:**

| Field | Description |
|-------|-------------|
| Rule ID | Must be unique within the 1000001–1999999 range |
| Description | Human-readable explanation of what the rule targets |
| Variable | ModSecurity variable to inspect (e.g. `REQUEST_HEADERS:User-Agent`, `ARGS`, `REQUEST_URI`) |
| Operator | `@contains`, `@rx` (regex), `@gt`, `@lt`, `@streq` |
| Value | Pattern to match (e.g. `sqlmap\|nikto\|nmap` for scanner blocking) |
| Action | `deny,status:403` / `log` / `redirect:{url}` |
| Severity | `CRITICAL` / `ERROR` / `WARNING` / `NOTICE` |
| Phase | `1` (request headers) / `2` (request body) / `3` (response headers) / `4` (response body) |
| Enabled | Toggle |

Example built-in global rules (pre-seeded):
```
ID 1000001 — Rate limit: block IP sending > 100 req/min
ID 1000002 — Scanner block: User-Agent contains sqlmap|nmap|nikto
ID 1000003 — Path traversal: REQUEST_URI matches \.\./ pattern
```

All custom rule changes are logged to `waf_rule_audit_log`.

---

#### Exclusion Approval Workflow

When enabled, customer-submitted rule exclusions are held in a `PENDING_APPROVAL` state and do not take effect until an admin approves them.

**Admin Panel → Security → WAF → Pending Exclusions**

| Column | Notes |
|--------|-------|
| Customer | Name |
| Exclusion type | `RULE_ID` / `TAG` / `REGEX_PATTERN` |
| Value | The rule ID, tag name, or regex being excluded |
| Reason | Customer-supplied justification |
| Submitted | Timestamp |
| Rule details | Rule ID description + OWASP category |
| Actions | Approve, Reject, Request more info |

Rejections are delivered to the customer as a panel notification with the admin's reason.

The approval workflow is optional — disabled by default. When disabled, customer exclusions take effect immediately (subject to the plan's exclusion limit).

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/waf/statistics` | Platform-wide WAF metrics (blocks, block rate, top attack types, top attacked customers) |
| `GET` | `/api/v1/admin/waf/customers` | Per-customer WAF config list (filter: `enabled`, `mode`, `plan`) |
| `PATCH` | `/api/v1/admin/waf/customers/{id}` | Enable/disable WAF or override mode for a specific customer |
| `GET` | `/api/v1/admin/waf/alerts` | All open WAF alerts across platform (filter: `customer_id`, `type`, `severity`, `status`) |
| `POST` | `/api/v1/admin/waf/alerts/{id}/acknowledge` | Acknowledge an alert with optional internal note |
| `POST` | `/api/v1/admin/waf/alerts/{id}/resolve` | Mark alert as resolved |
| `GET` | `/api/v1/admin/waf/rules/update` | Current and staged CRS version, rollout status |
| `POST` | `/api/v1/admin/waf/rules/update/rollout` | Advance rollout to next stage (`canary` → `50%` → `100%`) |
| `POST` | `/api/v1/admin/waf/rules/update/rollback` | Revert all customers to previous CRS version |
| `POST` | `/api/v1/admin/waf/rules/update/pause` | Pause rollout at current stage |
| `GET` | `/api/v1/admin/waf/custom-rules` | List global custom rules |
| `POST` | `/api/v1/admin/waf/custom-rules` | Create a global custom rule |
| `PUT` | `/api/v1/admin/waf/custom-rules/{id}` | Update a global custom rule |
| `DELETE` | `/api/v1/admin/waf/custom-rules/{id}` | Delete a global custom rule |
| `GET` | `/api/v1/admin/waf/exclusions/pending` | List customer exclusions pending admin approval |
| `POST` | `/api/v1/admin/waf/exclusions/{id}/approve` | Approve a pending exclusion |
| `POST` | `/api/v1/admin/waf/exclusions/{id}/reject` | Reject a pending exclusion with reason |
| `GET` | `/api/v1/admin/waf/settings` | Get global WAF settings (approval workflow enabled, default plan configs) |
| `PUT` | `/api/v1/admin/waf/settings` | Update global WAF settings |

### SA.5 Node Firewall Management

**Requirement:** View and manage iptables rules on individual cluster nodes via the admin panel, without requiring SSH access. Changes can be applied per-node or broadcast to multiple nodes. See `03-security/SECURITY_ARCHITECTURE.md` for the canonical per-node firewall rule reference.

> **Safety constraint:** The panel enforces one hard invariant — any rule that would block port `51820/UDP` (WireGuard/NetBird mesh) is rejected. Blocking this port would cut the admin's own access to the node. All other rules, including DROP rules for ports 22/6443/10250, are fully manageable.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Per-node rule view** | Display the live `iptables -L -n -v --line-numbers` output for a selected node | 1 |
| **Rule editor** | Add, delete, or reorder iptables rules via structured form (no raw iptables command entry) | 2 |
| **Bulk apply** | Apply a rule change to one node, a custom selection, or all nodes simultaneously | 2 |
| **Rule templates** | Pre-built templates matching the platform standard (worker, control-plane, storage) — admin applies with one click | 2 |
| **Dry run / diff** | Preview the resulting rule set before applying; show diff vs current state | 2 |
| **Rule history** | Audit log of all changes made via panel (who, when, what change, which nodes) | 1 |
| **Rollback** | Revert the last change on a node (re-applies the previous saved rule set) | 2 |
| **Persistence** | Changes are saved via `iptables-save > /etc/iptables/rules.v4` automatically after apply | 1 |
| **WireGuard lockout guard** | Panel refuses to apply any rule that would DROP or REJECT port `51820/UDP` | 1 |

**Node Firewall View (Admin Panel → Infrastructure → Nodes → {node} → Firewall):**

| Column | Notes |
|--------|-------|
| Chain | `INPUT` / `FORWARD` / `OUTPUT` |
| Line # | Rule position in chain |
| Target | `ACCEPT` / `DROP` / `REJECT` / custom chain |
| Protocol | `tcp` / `udp` / `all` |
| Source | IP/CIDR or `anywhere` |
| Destination | IP/CIDR or `anywhere` |
| Options | Port, interface (`-i wt0`), state match |
| Packets / Bytes | Live counter from `iptables -L -v` |
| Actions | Delete rule, Move up/down |

**Rule Editor — Add Rule Form:**

| Field | Options |
|-------|---------|
| Chain | `INPUT` / `FORWARD` / `OUTPUT` |
| Position | Insert at line N, or append to end |
| Target | `ACCEPT` / `DROP` / `REJECT` / `LOG` |
| Protocol | `tcp` / `udp` / `icmp` / `all` |
| Source IP | IP, CIDR, or blank (any) |
| Destination IP | IP, CIDR, or blank (any) |
| Port | Single port or range |
| Interface | In-interface (e.g. `wt0` for WireGuard, `eth0`) |
| State match | `NEW` / `ESTABLISHED` / `RELATED` (optional) |
| Apply to | Selected node(s) / all nodes / all workers / all control-plane nodes |

**Standard Platform Rule Templates:**

| Template | Applies to | Contents |
|----------|-----------|---------|
| `worker-standard` | Worker nodes | Open: 80/TCP, 443/TCP, 25/TCP, 587/TCP, 993/TCP, 2222/TCP, 51820/UDP; via wt0 only: 22/TCP, 10250/TCP; DROP: 22/TCP public, 6443/TCP public, 10250/TCP public; default INPUT DROP |
| `control-plane-standard` | Control-plane nodes | Open: 51820/UDP; via wt0 only: 22/TCP, 6443/TCP, 2379-2380/TCP (etcd), 10250/TCP; DROP: all above on public; default INPUT DROP |
| `storage-standard` | Dedicated storage/Longhorn nodes | Open: 51820/UDP; via wt0 only: 22/TCP, 9500/TCP (Longhorn manager), 10250/TCP; DROP: all above on public; default INPUT DROP |

**Audit Log (Admin Panel → Security → Firewall → History):**

Every change is logged:

| Field | Value |
|-------|-------|
| Timestamp | UTC datetime |
| Admin | Username |
| Node(s) | Affected node(s) |
| Action | `add_rule` / `delete_rule` / `apply_template` / `rollback` |
| Rule detail | Human-readable description of the change |
| Before / After | Saved rule-set snapshots |

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/nodes/{node}/firewall` | Get live iptables rules for a node |
| `POST` | `/api/v1/admin/nodes/{node}/firewall/rules` | Add a rule to a node (`chain`, `position`, `target`, `protocol`, `port`, `source`, `interface`) |
| `DELETE` | `/api/v1/admin/nodes/{node}/firewall/rules/{line}` | Delete rule at line N from chain |
| `POST` | `/api/v1/admin/nodes/{node}/firewall/rules/reorder` | Move rule to new position |
| `POST` | `/api/v1/admin/nodes/firewall/bulk` | Apply a rule change to multiple nodes (`node_ids` or `role`) |
| `GET` | `/api/v1/admin/nodes/{node}/firewall/history` | Rule change history for a node |
| `POST` | `/api/v1/admin/nodes/{node}/firewall/rollback` | Rollback to previous rule set |
| `GET` | `/api/v1/admin/nodes/firewall/templates` | List available rule templates |
| `POST` | `/api/v1/admin/nodes/{node}/firewall/apply-template` | Apply a named template to a node |
| `POST` | `/api/v1/admin/nodes/firewall/apply-template/bulk` | Apply template to multiple nodes |

**Implementation Notes:**

The panel communicates with each node's firewall via a lightweight **node agent** (small Go binary, systemd service) that:
- Listens on a local Unix socket only (not network-exposed)
- Receives signed commands from the Management API (via the NetBird mesh)
- Executes `iptables` commands and returns current rule output
- Refuses commands that would DROP port `51820/UDP`
- Persists rules to `/etc/iptables/rules.v4` after each successful change

The agent never exposes an unauthenticated HTTP endpoint. All communication between the Management API and the agent is authenticated via mutual TLS over the NetBird mesh.

### SA.6 NetBird Mesh Management

**Requirement:** Surface external VPN mesh (NetBird) health, peer status, and topology within the admin panel (status display only). NetBird runs as an external service (see ADR-022); the admin panel does not deploy or manage the NetBird infrastructure. Full peer management (access policies, ACLs, OIDC config, setup key issuance) is handled in the native NetBird dashboard — the admin panel links to it and exposes the health/status subset that is most relevant during day-to-day operations and incident response. See `03-security/SECURITY_ARCHITECTURE.md` and `ARCHITECTURE_DECISION_RECORDS.md` ADR-013 for the full NetBird architecture.

**Data source:** The admin panel backend calls the **NetBird Management API** at the configured management URL (see External Service Configuration) to retrieve peer and server state. Data is refreshed on page load and auto-polled every 60 seconds while the page is open.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Mesh overview** | Summary card: total peers, online peers, offline peers, Signal/TURN health | 1 |
| **Peer list** | Table of all mesh participants with status, IP, last seen, role — see column spec below | 1 |
| **Connectivity matrix** | Tabular peer-to-peer connection state — see matrix spec below | 1 |
| **Signal / TURN server status** | Per-server health panel for VPS 1, VPS 2, and home server — see server health spec below | 1 |
| **Link to NetBird dashboard** | Direct link to `https://netbird.platform.com` for full peer management | 1 |
| **Alerts integration** | Surface active `NetBirdPrimaryDown`, `NetBirdSignalDown`, `NetBirdAllRelaysDown` alerts inline | 1 |

---

#### Mesh Overview Card

Displayed at the top of **Admin Panel → Infrastructure → Mesh**:

| Field | Value |
|-------|-------|
| Total peers | Count of all enrolled mesh participants |
| Online | Peers with an active WireGuard tunnel (last seen < 5 minutes) |
| Offline | Peers not seen in > 5 minutes |
| Signal servers | `All healthy` / `⚠ Degraded (N/3)` / `✗ All down` |
| TURN/Relay servers | `All healthy` / `⚠ Degraded (N/3)` / `✗ All down` |
| Management server | `Online (VPS 1)` / `Failover (VPS 2)` / `✗ Unreachable` |
| Link | `Open NetBird Dashboard →` (opens `https://netbird.platform.com` in new tab) |

---

#### Peer List

**Admin Panel → Infrastructure → Mesh → Peers**

Filterable by: role, status (online/offline), last seen.

| Column | Notes |
|--------|-------|
| Name | Peer hostname (e.g. `cp-node-1`, `worker-1`, `admin-alice`) |
| Role | `Control Plane` / `Worker` / `Storage` / `DNS/NetBird VPS` / `Admin Workstation` / `Backup Server` |
| Mesh IP | WireGuard interface IP assigned by NetBird (e.g. `100.64.0.x`) |
| Public IP | Last known public endpoint IP |
| Status | `● Online` (green) / `● Offline` (red) / `● Idle` (amber — connected but no recent traffic) |
| Last seen | Relative timestamp (e.g. `2 min ago`) |
| OS | Debian version + kernel |
| NetBird version | Agent version running on this peer |

Clicking a peer opens a detail panel showing its full connection list (which other peers it has active tunnels to), WireGuard public key, allowed IPs, and last handshake timestamps per tunnel.

---

#### Connectivity Matrix

**Admin Panel → Infrastructure → Mesh → Topology**

A table where both rows and columns are peers. Each cell indicates the tunnel state between that pair:

| Symbol | Meaning |
|--------|---------|
| `●` (green) | Active tunnel — recent handshake (< 3 minutes) |
| `○` (amber) | Stale tunnel — handshake exists but > 3 minutes ago |
| `✗` (red) | No tunnel — peers cannot reach each other |
| `—` | Same peer (diagonal) |
| `~` | Direct P2P tunnel (no TURN relay needed) |
| `R` | Relayed via TURN (P2P not possible — likely symmetric NAT) |

The matrix is populated from the NetBird Management API peer routes and from WireGuard handshake times retrieved via the node agent on each peer (`sudo wg show` over the mesh).

> **Operational use:** During an incident, the matrix immediately shows which nodes have lost mesh connectivity to each other — critical for diagnosing cluster split-brain or node isolation.

---

#### Signal / TURN Server Health

**Admin Panel → Infrastructure → Mesh → Servers**

Three server panels — one per Signal/TURN instance (VPS 1, VPS 2, home server):

| Field | Value |
|-------|-------|
| Host | `ns1.platform.com` / `ns2.platform.com` / `home.platform.com` |
| Role | `Primary` / `Secondary` / `Tertiary` |
| Signal server | `● Running` / `✗ Down` — port 10000/TCP reachable |
| TURN/Relay | `● Running` / `✗ Down` — port 3478/UDP reachable |
| Management server | `● Active` / `Standby` / `✗ Down` — Management API `/api/v1/health` |
| NetBird dashboard | `● Reachable` / `✗ Down` — HTTPS health check |
| Last checked | Timestamp |

Unhealthy services show an inline alert banner and surface the relevant Prometheus alert (`NetBirdPrimaryDown`, `NetBirdSignalDown`, `NetBirdAllRelaysDown`) with a link to the incident runbook section.

---

#### Alert Integration

Active mesh alerts are surfaced inline on the Mesh page without requiring the admin to navigate to Grafana:

| Alert | Inline display |
|-------|---------------|
| `NetBirdPrimaryDown` | Red banner: "Management server (VPS 1) is unreachable. Failover to VPS 2 or home server required. [View runbook]" |
| `NetBirdSignalDown` | Amber banner: "Signal server degraded — N of 3 instances reachable. New peer connections may fail." |
| `NetBirdAllRelaysDown` | Red banner: "All TURN/Relay servers are down. Peers behind NAT cannot establish new tunnels." |

---

**API Endpoints:**

All endpoints proxy to the external NetBird Management API via the platform backend — the frontend never calls NetBird directly.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/mesh/overview` | Mesh summary (peer counts, Signal/TURN health, management server status) |
| `GET` | `/api/v1/admin/mesh/peers` | Full peer list with status, mesh IP, role, last seen |
| `GET` | `/api/v1/admin/mesh/peers/{peer_id}` | Single peer detail including per-tunnel handshake times |
| `GET` | `/api/v1/admin/mesh/topology` | Connectivity matrix — all peer-to-peer tunnel states |
| `GET` | `/api/v1/admin/mesh/servers` | Signal/TURN/Management server health per VPS |
| `GET` | `/api/v1/admin/mesh/alerts` | Active mesh-related Prometheus alerts |

---

## Monitoring, Logging & Alerts

### ML.1 Prometheus & Grafana Integration

**Requirement:** Surface platform metrics and Grafana dashboards within the admin panel. The full metrics stack (Prometheus via `kube-prometheus-stack`, Grafana, Alertmanager) runs in the `monitoring` namespace and is the authoritative source for all operational data. See `MONITORING_OBSERVABILITY.md` for the full observability stack specification and `SLI_SLO_DEFINITION.md` for SLO targets and PromQL queries.

Grafana is also accessible directly at `https://grafana.platform.com` (OIDC SSO via the external OIDC provider, client ID `grafana`). The admin panel provides an integrated subset — the most operationally relevant views — without requiring admins to navigate to Grafana for routine checks.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Metrics overview** | Key platform health metrics on the admin home dashboard — see widget spec below | 1 |
| **Grafana embed / link** | Embed Grafana panels via iframe (signed URLs) or link directly to `grafana.platform.com` | 1 |
| **Dashboard index** | List of all provisioned Grafana dashboards with direct links | 1 |
| **SLO status panel** | Current SLO compliance and error budget remaining for each service | 1 |
| **Per-client metrics** | CPU, memory, storage, HTTP error rate for a selected client | 1 |
| **Prometheus health** | Prometheus pod status, scrape target health, TSDB size, retention | 1 |
| **Custom PromQL query** | Admin can run an ad-hoc PromQL query and view results as a table or time-series graph | 2 |
| **Metrics retention config** | View and update Prometheus retention duration (default 15 days) | 2 |

---

#### Admin Home Dashboard — Metrics Widgets

Key metrics surfaced directly on the admin dashboard without navigating to Grafana. Data is fetched from the Prometheus HTTP API (`/api/v1/query`).

| Widget | Metric(s) | Refresh |
|--------|-----------|---------|
| Cluster node health | `kube_node_status_condition{condition="Ready"}` — count ready / total | 60s |
| Pod restarts (1h) | `increase(kube_pod_container_status_restarts_total[1h])` — top 5 pods | 60s |
| Ingress error rate | `rate(nginx_ingress_controller_requests{status=~"[45].."}[5m])` | 30s |
| p95 latency | `histogram_quantile(0.95, nginx_ingress_controller_request_duration_seconds_bucket)` | 30s |
| Storage utilisation | `kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes` — top 5 PVCs | 5m |
| Active alerts | Count from Alertmanager API — Critical / Warning breakdown | 30s |
| Cert expiry (nearest) | `min(platform_cert_expiry_days)` — days until next cert expires | 5m |
| Email queue | `postfix_queue_size_total{status="active"}` + `{status="deferred"}` | 60s |

---

#### Dashboard Index

**Admin Panel → Monitoring → Dashboards**

| Dashboard | Category | Link |
|-----------|----------|------|
| Cluster health | Infrastructure | Grafana |
| Ingress & routing | Infrastructure | Grafana |
| Database health | Infrastructure | Grafana |
| Storage utilisation | Infrastructure | Grafana |
| Email queue & delivery | Application | Grafana |
| Backup status | Operations | Grafana |
| SLO status & burn rate | SLO | Grafana |
| Per-client resource usage | Client | Grafana |
| Per-client HTTP traffic | Client | Grafana |
| WAF events | Security | Grafana |
| fail2ban events | Security | Grafana |
| PowerDNS health | DNS | Grafana |
| NetBird mesh | Admin VPN | Grafana |
| Certificate expiry | TLS | Grafana |

Each row links directly to the relevant Grafana dashboard (pre-authenticated via OIDC session).

---

#### SLO Status Panel

**Admin Panel → Monitoring → SLOs**

| Service | SLI | SLO target | Current (30d) | Error budget used | Status |
|---------|-----|-----------|--------------|-----------------|--------|
| Client web hosting | Availability | 99.5% | 99.8% | 12% | `● On track` |
| Client web hosting | p95 Latency | < 1000ms | 340ms | — | `● On track` |
| Management panel | Availability | 99.5% | — | — | — |
| Shared MariaDB | Availability | 99.5% | — | — | — |
| Shared PostgreSQL | Availability | 99.5% | — | — | — |
| Email delivery | Delivery success | 99% | — | — | — |
| DNS resolution | Query success | 99.5% | — | — | — |

Status badges: `● On track` (green) / `⚠ At risk` (amber — >50% budget consumed) / `✗ Breached` (red).

Full SLO specification and PromQL queries: `SLI_SLO_DEFINITION.md`.

---

**API Endpoints:**

All metric queries are proxied through the Management API backend — the frontend never calls Prometheus or Grafana directly.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/metrics/overview` | Home dashboard widget data (cluster health, error rate, latency, alerts, queue) |
| `GET` | `/api/v1/admin/metrics/slo` | SLO compliance and error budget status for all services |
| `GET` | `/api/v1/admin/metrics/clients/{id}` | Per-client CPU, memory, storage, HTTP error rate |
| `GET` | `/api/v1/admin/metrics/prometheus/health` | Prometheus pod status, scrape targets, TSDB stats |
| `POST` | `/api/v1/admin/metrics/query` | Execute ad-hoc PromQL query (`query`, `start`, `end`, `step`) — returns time-series data |
| `GET` | `/api/v1/admin/metrics/dashboards` | List provisioned Grafana dashboards with URLs |
| `GET` | `/api/v1/admin/metrics/retention` | Current Prometheus retention setting |
| `PUT` | `/api/v1/admin/metrics/retention` | Update Prometheus retention duration |

---

### ML.2 Loki Log Aggregation

**Requirement:** Centralized log search, filtering, and export across all platform components and customer workloads. Loki (with Promtail) is the log aggregation backend. See `MONITORING_OBSERVABILITY.md` for retention policy and `03-security/DATABASE_ACCESS_CONTROL.md` for database audit log pipeline details.

Log retention policy (from `MONITORING_OBSERVABILITY.md`):

| Source | Retention |
|--------|-----------|
| Client access logs | 30 days |
| Platform service logs | 90 days |
| Security / audit logs | 1 year |
| Backup logs | 90 days |
| WAF blocks | 30 days |
| Auth attempts / failures | 1 year |
| fail2ban bans | 90 days |

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Log search** | Full-text and label-based search via LogQL across all log sources | 1 |
| **Log stream browser** | Browse available Loki streams by label (namespace, pod, job, component) | 1 |
| **Predefined queries** | Library of common LogQL queries for platform troubleshooting — see query library below | 1 |
| **Per-client log view** | Filter logs to a specific client namespace | 1 |
| **Time range selector** | Absolute or relative time range for all queries | 1 |
| **Log export** | Download filtered log results as plain text or JSON (up to 100,000 lines) | 1 |
| **Tail (live stream)** | Real-time log tail for a selected stream — auto-scrolling | 1 |
| **Context view** | Show N lines before/after a matching log line for context | 2 |
| **Saved queries** | Save and name frequently used LogQL queries | 2 |
| **Loki health** | Loki pod status, ingestion rate, storage usage | 1 |

---

#### Log Stream Browser

**Admin Panel → Monitoring → Logs**

Streams are browseable by label. Common labels available:

| Label | Example values |
|-------|---------------|
| `namespace` | `ingress-nginx`, `mail`, `auth`, `monitoring`, `client-{id}` |
| `pod` | `nginx-ingress-controller-xxx`, `dex-0`, `postfix-0` |
| `job` | `database-audit`, `mail-logs`, `waf-events`, `fail2ban` |
| `component` | `postfix`, `dovecot`, `rspamd`, `powerdns`, `netbird` |
| `client_id` | UUID of a specific client (for client namespace logs) |

---

#### Predefined Query Library

| Query name | LogQL | Use case |
|------------|-------|----------|
| Auth failures (1h) | `{namespace="auth"} \|= "failed"` | Login troubleshooting |
| WAF blocks | `{job="waf-events"} \| json \| action="BLOCKED"` | Attack investigation |
| fail2ban bans | `{job="fail2ban"} \|= "Ban"` | IP ban history |
| Postfix bounces | `{component="postfix"} \|= "bounced"` | Email delivery issues |
| Database DDL changes | `{job="database-audit"} \|~ "CREATE\|ALTER\|DROP"` | DB change audit |
| Client error logs | `{namespace="client-{id}"} \|= "error"` | Client troubleshooting |
| Ingress 5xx errors | `{namespace="ingress-nginx"} \|= "\" 5"` | Availability investigation |
| Cert renewal events | `{namespace="cert-manager"} \|= "Certificate"` | TLS troubleshooting |
| PowerDNS errors | `{component="powerdns"} \|= "Error"` | DNS troubleshooting |
| NetBird events | `{component="netbird"} \|= "peer"` | Mesh troubleshooting |

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/logs/streams` | List available Loki streams and their labels |
| `POST` | `/api/v1/admin/logs/query` | Execute LogQL query (`query`, `start`, `end`, `limit`, `direction`) |
| `POST` | `/api/v1/admin/logs/tail` | Open SSE stream for live log tail (`query`, `delay_for`) |
| `GET` | `/api/v1/admin/logs/queries` | List saved/predefined LogQL queries |
| `POST` | `/api/v1/admin/logs/queries` | Save a custom named query |
| `DELETE` | `/api/v1/admin/logs/queries/{id}` | Delete a saved query |
| `POST` | `/api/v1/admin/logs/export` | Export log results as plain text or JSON (async — returns download URL) |
| `GET` | `/api/v1/admin/logs/health` | Loki pod status, ingestion rate, storage utilisation |

---

### ML.3 Alertmanager Configuration

**Requirement:** View and manage Prometheus alert routing, receivers, silences, and inhibition rules. Alertmanager routes Prometheus alerts to the platform Notification Service via webhook, which handles final delivery (email, SMS). See `MONITORING_OBSERVABILITY.md` for the full alerting specification and `INFRASTRUCTURE_PLAN.md §9.7.6` for the Alertmanager ↔ Notification Service integration.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Active alert list** | All currently firing Prometheus alerts — see column spec below | 1 |
| **Alert history** | Log of all past alerts with firing and resolution timestamps | 1 |
| **Alert rules browser** | Read-only view of all deployed PrometheusRule resources | 1 |
| **Silence management** | Create, list, and expire silences for maintenance windows | 1 |
| **Routing configuration** | View current Alertmanager routing tree (read-only in Phase 1) | 1 |
| **Receiver management** | Add/edit notification receivers (email, SMS, webhook endpoints) | 2 |
| **Inhibition rules** | View and manage inhibition rules (suppress child alerts when parent fires) | 2 |
| **Test alert** | Send a test notification through a receiver to verify delivery | 2 |
| **Alertmanager health** | Alertmanager pod status, cluster status (HA), last reload timestamp | 1 |

---

#### Active Alert List

**Admin Panel → Monitoring → Alerts → Active**

| Column | Notes |
|--------|-------|
| Alert name | e.g. `EmailIPBlacklisted`, `CertExpiryCritical`, `PowerDNSAPIUnreachable` |
| Severity | `Critical` / `Warning` / `Info` — colour-coded |
| Component | Derived from alert labels (e.g. `email`, `dns`, `tls`, `cluster`) |
| Labels | Key label pairs (e.g. `domain=example.com`, `client_id=abc`) |
| Firing since | Duration alert has been active |
| Summary | Alert annotation summary text |
| Actions | Silence, View runbook, View in Grafana |

Alerts are grouped by severity. Critical alerts additionally appear as a persistent banner on every admin panel page until resolved.

**Known platform alert names** (from across the codebase):

| Alert | Severity | Source |
|-------|----------|--------|
| `EmailIPBlacklisted` | Critical | Email |
| `EmailQueueTooLarge` | Warning | Email |
| `EmailQueueStalled` | Warning | Email |
| `EmailBounceRateHigh` | Warning | Email |
| `CustomerEmailQuotaExceeded` | Warning | Email |
| `CustomerFBLThreshold` | Warning | Email deliverability |
| `CustomerFBLSuspend` | Critical | Email deliverability |
| `CertExpiryWarning` | Warning | TLS |
| `CertExpiryCritical` | Critical | TLS |
| `CertRenewalFailed` | Critical | TLS |
| `PowerDNSAPIUnreachable` | Critical | DNS |
| `PowerDNSAPILatencyHigh` | Warning | DNS |
| `PowerDNSExternalSlaveDown` | Warning | DNS |
| `PowerDNSAXFRFailure` | Warning | DNS |
| `DNSIngressControllerSyncFailed` | Warning | DNS |
| `DNSSECDSRecordMissing` | Warning | DNSSEC |
| `NetBirdPrimaryDown` | Critical | Admin VPN |
| `NetBirdSignalDown` | Warning | Admin VPN |
| `NetBirdAllRelaysDown` | Critical | Admin VPN |
| `HighErrorRateBurnRate` | Critical | SLO |
| `MediumErrorRateBurnRate` | Warning | SLO |

---

#### Silence Management

**Admin Panel → Monitoring → Alerts → Silences**

| Column | Notes |
|--------|-------|
| Matchers | Label selectors the silence applies to (e.g. `alertname="EmailQueueTooLarge"`) |
| Created by | Admin name |
| Starts | UTC timestamp |
| Ends | UTC timestamp |
| Comment | Required — reason for the silence (e.g. `"Planned maintenance 2026-03-15"`) |
| Status | `Active` / `Pending` / `Expired` |
| Actions | Expire now, Edit end time |

Creating a silence requires a comment and an end time. Indefinite silences are not permitted — maximum silence duration is 7 days. The action is logged to the admin audit trail.

---

#### Alert Rules Browser

**Admin Panel → Monitoring → Alerts → Rules**

Read-only view of all `PrometheusRule` resources deployed across the cluster, grouped by rule group name.

| Column | Notes |
|--------|-------|
| Alert name | Rule name |
| Group | Rule group (e.g. `certificates`, `email`, `dns`) |
| Expr | PromQL expression |
| For | Pending duration before firing |
| Severity | From labels |
| Annotations | Summary, description, runbook URL |

---

#### Routing Configuration

**Admin Panel → Monitoring → Alerts → Routing**

Read-only tree view of the Alertmanager routing configuration:

```
root route
├── severity=critical → receiver: pagerduty (Phase 2) / email+sms (Phase 1)
│   ├── alertname=EmailIPBlacklisted → receiver: email-admin+sms
│   ├── alertname=NetBirdPrimaryDown → receiver: email-admin+sms
│   └── (all other critical) → receiver: email-admin+sms
└── severity=warning → receiver: email-admin
    └── (default warning routing)
```

Phase 2: routing tree becomes editable via form UI with drag-and-drop route ordering.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/alerts/active` | List all currently firing alerts (filter: `severity`, `component`) |
| `GET` | `/api/v1/admin/alerts/history` | Alert history (filter: `name`, `severity`, `from`, `to`) |
| `GET` | `/api/v1/admin/alerts/rules` | List all PrometheusRule resources |
| `GET` | `/api/v1/admin/alerts/silences` | List silences (filter: `status`) |
| `POST` | `/api/v1/admin/alerts/silences` | Create silence (`matchers`, `starts_at`, `ends_at`, `comment`) |
| `DELETE` | `/api/v1/admin/alerts/silences/{id}` | Expire a silence immediately |
| `GET` | `/api/v1/admin/alerts/routing` | Get current Alertmanager routing configuration |
| `PUT` | `/api/v1/admin/alerts/routing` | Update routing configuration (Phase 2) |
| `GET` | `/api/v1/admin/alerts/receivers` | List notification receivers |
| `POST` | `/api/v1/admin/alerts/receivers` | Add receiver (Phase 2) |
| `PUT` | `/api/v1/admin/alerts/receivers/{name}` | Update receiver (Phase 2) |
| `POST` | `/api/v1/admin/alerts/receivers/{name}/test` | Send test notification (Phase 2) |
| `GET` | `/api/v1/admin/alerts/health` | Alertmanager pod status, cluster mode, last config reload |

---

### ML.4 Health Scoring & Anomaly Detection

**Requirement:** Proactive platform health visibility — a single aggregated health score per service and per client, with anomaly detection to surface degradation before it triggers threshold-based alerts. Phase 2.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Platform health scorecard** | Aggregated health score (0–100) per service, computed from SLI signals | 2 |
| **Per-client health score** | Individual health score per client derived from their resource, error, and uptime signals | 2 |
| **Anomaly indicators** | Flag metrics behaving unusually relative to their own historical baseline — no fixed threshold required | 2 |
| **Trend view** | 7-day and 30-day score trend per service/client | 2 |
| **Health history** | Point-in-time score snapshots — useful for incident post-mortems | 2 |
| **Degradation timeline** | When did a service/client's health start declining? Visual timeline. | 2 |

---

#### Platform Health Scorecard

**Admin Panel → Monitoring → Health**

Each service is scored 0–100. The score is a weighted composite of relevant SLI signals:

| Service | Signals used | Weight |
|---------|-------------|--------|
| Cluster | Node availability, pod restart rate, OOM kills | Equal |
| Ingress | Availability (non-5xx rate), p95 latency vs SLO | Equal |
| Database (shared MariaDB) | Availability, connection saturation, replication lag | Equal |
| Database (shared PostgreSQL) | Availability, connection saturation, replication lag | Equal |
| Email | Queue depth, bounce rate, delivery success rate | Equal |
| DNS | Query success rate, AXFR sync status, SERVFAIL rate | Equal |
| Certificates | Days to nearest expiry, renewal failure rate | Equal |
| Admin VPN (NetBird) | Peer connectivity, Signal/TURN availability | Equal |
| Backups | Last successful backup age, restore test pass rate | Equal |

Score mapping: 90–100 = `● Healthy`, 70–89 = `⚠ Degraded`, 0–69 = `✗ Unhealthy`.

---

#### Per-Client Health Score

Each client gets a score derived from their own metrics in the `client-{id}` namespace:

| Signal | Weight |
|--------|--------|
| HTTP availability (non-5xx rate, 24h) | 40% |
| p95 response latency vs 1000ms SLO | 20% |
| CPU usage vs plan limit | 15% |
| Memory usage vs plan limit | 15% |
| Storage usage vs plan limit | 10% |

Clients with health score < 70 are surfaced in an "Attention needed" list on the admin home dashboard.

---

#### Anomaly Detection

Rather than fixed thresholds, anomaly detection compares a metric's current value against its own rolling baseline (7-day or 30-day median ± N standard deviations). An anomaly is flagged when the current value falls outside the expected range.

| Signal monitored | Baseline window | Sensitivity |
|-----------------|----------------|-------------|
| Per-client HTTP error rate | 7-day rolling | > 3 std dev |
| Per-client response latency | 7-day rolling | > 2 std dev |
| Platform ingress error rate | 30-day rolling | > 3 std dev |
| Email bounce rate | 30-day rolling | > 2 std dev |
| DNS SERVFAIL rate | 7-day rolling | > 3 std dev |
| Storage growth rate | 30-day rolling | > 2 std dev |

Anomaly indicators appear as a subtle `↑ Unusual` badge alongside the metric value. They do not fire alerts by default — they are informational signals to help admins notice drift before it becomes an incident. Admins can promote an anomaly indicator to a full Prometheus alert rule with one click (Phase 2).

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/health/scorecard` | Platform health scorecard — all services with current score and trend |
| `GET` | `/api/v1/admin/health/scorecard/{service}` | Single service health detail — score breakdown by signal |
| `GET` | `/api/v1/admin/health/clients` | Per-client health scores — sortable, filterable by score range |
| `GET` | `/api/v1/admin/health/clients/{id}` | Single client health detail — signal breakdown and 7-day trend |
| `GET` | `/api/v1/admin/health/anomalies` | Current anomaly indicators across all services and clients |
| `GET` | `/api/v1/admin/health/history` | Historical score snapshots (filter: `service`, `client_id`, `from`, `to`) |

---

## CI/CD & Container Registry

### CR.1 Harbor Container Registry Management

**Requirement:** Manage the Harbor container registry — project health, image inventory, vulnerability scan results, retention policies, replication, and registry storage. This section covers the **registry layer only**. Catalog image lifecycle management (enable, deprecate, force-migrate workloads) is covered in W.1 Container Image Management.

See also: `ARCHITECTURE_DECISION_RECORDS.md` ADR-002 (Harbor), ADR-004 (Trivy scanning); `SECURITY_ARCHITECTURE.md §Container Security`.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Harbor health status** | Pod count (running/expected), storage usage (used/total), replication job health, last backup timestamp | 1 |
| **Project list** | All Harbor projects (`catalog/`, `platform/`) — image count, storage used, retention policy summary, public/private | 1 |
| **Image browser** | Per-project list of repositories; per-repository list of tags with digest, size, push date, scan status | 1 |
| **Vulnerability scan results** | Per-image Trivy findings: CVE ID, severity, package, installed version, fix version, CVSS score | 1 |
| **Scan policy management** | Configure when scans run: on push, on schedule, or manual — per project | 1 |
| **Retention policy management** | View and edit per-project retention rules (default: keep last 5 versions per repository) | 1 |
| **Manual rescan** | Trigger an on-demand Trivy scan for a specific image tag | 1 |
| **Image / tag deletion** | Delete a specific image tag or entire repository with confirmation (blocked if image is referenced by a live workload) | 1 |
| **Registry storage metrics** | Total used vs 100 GB capacity, growth trend (7-day and 30-day), per-project breakdown | 1 |
| **Image pull statistics** | Pull count per repository (24h / 7d / 30d), pull success rate vs 99.8% SLO | 1 |
| **Replication rules** | View configured replication rules (source, destination, trigger, filter) and last job status | 2 |
| **Harbor UI deep link** | Direct link to `harbor.platform.com` for full Harbor native management | 1 |

---

#### Harbor Health Status

**Admin Panel → Registry → Overview**

Top-of-page status card:

| Field | Value example | Notes |
|-------|--------------|-------|
| Harbor pods | `3 / 3 running` | Alerts if < 3 |
| Registry storage | `42.1 GB / 100 GB (42%)` | Warning at 80%, Critical at 90% |
| Trivy DB last updated | `2026-03-08 04:12 UTC` | Warning if > 24 h stale |
| Last backup | `2026-03-07 03:00 UTC` | Warning if > 25 h ago |
| Replication jobs (last 24h) | `4 succeeded / 0 failed` | Error badge on any failure |
| Image pull SLO (24h) | `99.95%` | SLO target 99.8% — red if below |
| Harbor UI | `Open Harbor →` | Link to `harbor.platform.com` |

A `Critical` banner is shown if Harbor pods < 2 (registry unavailable for HA) or storage ≥ 90%.

---

#### Project List

**Admin Panel → Registry → Projects**

| Column | Notes |
|--------|-------|
| Project name | `catalog`, `platform` |
| Visibility | `Private` (both projects) |
| Repositories | Count of image repositories in the project |
| Storage used | Human-readable (e.g. `18.4 GB`) |
| Retention rule | Summary (e.g. `Keep last 5 tags`) |
| Scan status | `All clean` / `N CVEs found` (highest severity badge) |
| Actions | View images, Edit retention, View scan summary |

---

#### Image Browser

**Admin Panel → Registry → Projects → {project} → Images**

Repository list for the selected project:

| Column | Notes |
|--------|-------|
| Repository | e.g. `catalog/apache-php84` |
| Tags | Count of published tags |
| Latest tag | e.g. `1.2.0-20260227` |
| Last pushed | UTC timestamp |
| Total size | Sum of all tag sizes |
| Scan status | Worst severity across all tags |
| Actions | View tags, Trigger scan, Delete repository |

Clicking a repository expands the **tag list**:

| Column | Notes |
|--------|-------|
| Tag | e.g. `1.2.0-20260227` |
| Digest | Truncated SHA256 (copyable) |
| Size | Compressed image size |
| Pushed | UTC timestamp and actor |
| Scan status | `● Clean` / `⚠ Low` / `▲ Medium` / `✗ High` / `✗ Critical` |
| Actions | View scan report, Trigger rescan, Delete tag |

> Image tag format: `catalog/<id>:<version>-<YYYYMMDD>` (e.g. `catalog/apache-php84:1.2.0-20260227`). Platform service images follow `platform/<name>:<version>`.

Deleting a tag is blocked with an error if any live workload references the image by that tag or digest. A list of affected workload namespaces is shown.

---

#### Vulnerability Scan Results

**Admin Panel → Registry → Projects → {project} → Images → {repo} → {tag} → Scan Report**

Summary bar: `Critical: 0 | High: 2 | Medium: 5 | Low: 8 | Negligible: 3 | Unknown: 0`

Findings table:

| Column | Notes |
|--------|-------|
| CVE ID | Linked to NVD (e.g. `CVE-2025-12345`) |
| Severity | Colour-coded badge |
| Package | Affected package name |
| Installed version | Currently installed version in image |
| Fix version | Available fixed version (`None` if no fix exists) |
| CVSS score | Numeric score (0.0–10.0) |
| Description | One-line summary |

Default sort: severity descending, then CVSS score descending.

Findings are filterable by severity. A `Rescan` button triggers a fresh Trivy scan and refreshes results. Scan timestamp is shown prominently.

> Per `SECURITY_ARCHITECTURE.md`: Trivy scans run on every build before publishing to catalog. Images with **Critical** severity CVEs that have an available fix are flagged for rebuild.

---

#### Scan Policy Management

**Admin Panel → Registry → Projects → {project} → Scan Policy**

| Setting | Options | Default |
|---------|---------|---------|
| Scan on push | Enabled / Disabled | Enabled |
| Scheduled scan | Daily / Weekly / Disabled | Daily 04:00 UTC |
| Prevent deployment of unscanned images | Enabled / Disabled | Enabled |
| Prevent deployment of Critical CVEs | Enabled / Disabled | Disabled (Phase 2 enforcement) |

Changes are logged to the admin audit trail.

---

#### Retention Policy Management

**Admin Panel → Registry → Projects → {project} → Retention**

Current policy summary (e.g. `Keep last 5 tags matching **/**`). Editable fields:

| Field | Type | Default |
|-------|------|---------|
| Rule type | `Keep most recent N tags` / `Keep tags pushed within N days` | `Keep most recent N tags` |
| Retain count / days | Integer | `5` |
| Tag filter | Glob pattern (e.g. `**` = all, `1.*` = v1 only) | `**` |
| Repository filter | Glob pattern | `**` |

Up to 3 rules may be defined per project. Rules are evaluated in order; a tag matching any "keep" rule is retained.

> Changing a retention policy does **not** immediately delete tags — it runs at the next scheduled retention job (nightly). The estimated deletion count is shown as a preview before saving.

---

#### Registry Storage Metrics

**Admin Panel → Registry → Storage**

| Metric | Display |
|--------|---------|
| Total used | `42.1 GB of 100 GB (42%)` — progress bar |
| By project | `catalog`: X GB, `platform`: Y GB — stacked bar |
| Growth trend | Sparkline: last 7 days and last 30 days |
| Estimated days until full | Projected at current growth rate |
| Largest repositories | Top 10 by size — sortable table |

Storage warning thresholds (matching `MONITORING_OBSERVABILITY.md` alert thresholds): Warning at 80%, Critical at 90%.

---

#### Image Pull Statistics

**Admin Panel → Registry → Pull Stats**

| Column | Notes |
|--------|-------|
| Repository | e.g. `catalog/apache-php84` |
| Pulls (24h) | Count |
| Pulls (7d) | Count |
| Pulls (30d) | Count |
| Pull success rate (24h) | Percentage — red if < 99.8% SLO |
| Last pull | UTC timestamp |

Platform-wide pull success rate vs the **99.8% SLO** (`Error budget: 52 min/month`) is shown as a summary KPI card at the top of the page.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/registry/health` | Harbor pod status, storage usage, Trivy DB age, last backup, replication summary |
| `GET` | `/api/v1/admin/registry/projects` | List all Harbor projects with image count, storage, retention policy, and scan summary |
| `GET` | `/api/v1/admin/registry/projects/{project}/images` | List repositories in a project (image count, latest tag, last push, scan status) |
| `GET` | `/api/v1/admin/registry/projects/{project}/images/{repo}/tags` | List tags for a repository (digest, size, push date, scan status) |
| `GET` | `/api/v1/admin/registry/projects/{project}/images/{repo}/tags/{tag}/scan` | Get Trivy scan report for a specific tag |
| `POST` | `/api/v1/admin/registry/projects/{project}/images/{repo}/tags/{tag}/scan` | Trigger an on-demand rescan of a specific tag |
| `DELETE` | `/api/v1/admin/registry/projects/{project}/images/{repo}/tags/{tag}` | Delete a tag (blocked if referenced by a live workload) |
| `DELETE` | `/api/v1/admin/registry/projects/{project}/images/{repo}` | Delete entire repository (blocked if any tag is referenced by a live workload) |
| `GET` | `/api/v1/admin/registry/projects/{project}/retention` | Get retention policy for a project |
| `PUT` | `/api/v1/admin/registry/projects/{project}/retention` | Update retention policy for a project |
| `GET` | `/api/v1/admin/registry/projects/{project}/scan-policy` | Get scan policy for a project |
| `PUT` | `/api/v1/admin/registry/projects/{project}/scan-policy` | Update scan policy for a project |
| `GET` | `/api/v1/admin/registry/storage` | Storage metrics: total used, per-project breakdown, growth trend, largest repos |
| `GET` | `/api/v1/admin/registry/pull-stats` | Pull statistics per repository (24h / 7d / 30d counts, success rate) |
| `GET` | `/api/v1/admin/registry/replication` | List replication rules and last job status (Phase 2) |

### CR.2 Flux v2 GitOps Management

**Requirement:** Manage continuous deployment via GitOps. The platform uses Flux v2 (pull-based) to reconcile all workloads and platform services from a Git repository. Flux watches the repo on a 5-minute sync interval and applies Helm charts and Kustomize overlays. See also: `ADR-005` (Flux v2 accepted), `../04-deployment/DEPLOYMENT_PROCESS.md`.

**Key Flux concepts:**

| Concept | Description |
|---------|-------------|
| **GitRepository** | Flux CRD pointing at the platform Git repo (branch, interval, SSH key) |
| **Kustomization** | Flux CRD specifying a path in the repo to reconcile; can target specific namespaces |
| **HelmRelease** | Flux CRD managing a Helm chart installation, with version pinning and value overrides |
| **Reconciliation** | Flux periodically pulls the repo and applies any diff vs. current cluster state |
| **Drift detection** | If cluster state diverges from Git, Flux re-applies the desired state on next sync |
| **Suspend/Resume** | A Flux resource can be suspended (no reconciliation) for maintenance or rollback |

**Features (Phase 2):**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **GitOps status overview** | List all Flux resources (GitRepository, Kustomization, HelmRelease) with ready status, last applied revision, and last sync time | 2 |
| **Sync health** | Per-resource health badge: `Ready` / `Reconciling` / `Failed` / `Suspended` — with last error message on failure | 2 |
| **Manual sync trigger** | Force an immediate reconciliation of a specific Kustomization or HelmRelease | 2 |
| **Suspend / Resume** | Suspend a Flux resource to pause reconciliation (e.g. during a hotfix), then resume when ready | 2 |
| **Revision history** | List of recent applied Git revisions per Kustomization, with commit SHA, author, message, and applied timestamp | 2 |
| **Rollback** | Trigger a rollback: either git revert via UI (creates a new commit) or manual suspend + kubectl apply of a prior state | 2 |
| **Deployment logs** | Stream Flux controller logs (`flux-system` namespace, `source-controller`, `kustomize-controller`, `helm-controller`) | 2 |
| **Helm chart versions** | List all HelmReleases with current chart version, latest available version, and upgrade eligibility | 2 |

**Rollback behaviour:**

- Preferred path: create a `git revert` commit in the platform repo — Flux auto-syncs within 5 minutes.
- Emergency path: `flux suspend kustomization <name>` → admin applies prior manifest manually → resume when confirmed stable.
- Both paths are surfaced in the admin panel; revert creates an audit event `GITOPS_ROLLBACK`.

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/gitops/resources` | List all Flux GitRepository, Kustomization, and HelmRelease resources with status |
| `GET` | `/api/v1/admin/gitops/resources/{type}/{name}` | Detail for a specific Flux resource (status, last revision, last error, events) |
| `POST` | `/api/v1/admin/gitops/resources/{type}/{name}/sync` | Trigger immediate reconciliation of a specific resource |
| `POST` | `/api/v1/admin/gitops/resources/{type}/{name}/suspend` | Suspend reconciliation for a resource |
| `POST` | `/api/v1/admin/gitops/resources/{type}/{name}/resume` | Resume reconciliation for a suspended resource |
| `GET` | `/api/v1/admin/gitops/resources/{type}/{name}/history` | List recent applied revisions (commit SHA, author, message, timestamp) |
| `POST` | `/api/v1/admin/gitops/resources/{type}/{name}/rollback` | Initiate rollback (`strategy`: `git_revert` or `suspend_apply`) |
| `GET` | `/api/v1/admin/gitops/logs` | Stream Flux controller logs (`controller`: source/kustomize/helm) |

---

## Email & Communication

### EC.1 Docker-Mailserver Management

**Requirement:** Manage the full email stack — Docker-Mailserver (Postfix + Dovecot + Rspamd + OpenDKIM + fail2ban) running in the `mail` namespace. Covers: stack health, per-customer mailbox and domain management, DKIM key lifecycle, alias management, quota enforcement, spam filter configuration, outbound queue health, IP pool and deliverability controls, and external SMTP relay configuration.

See also: `EMAIL_SERVICES.md`, `EMAIL_ENHANCEMENTS_SPECIFICATION.md`, `EMAIL_SENDING_LIMITS_AND_MONITORING.md`, `EMAIL_DELIVERABILITY.md`.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Stack health status** | Pod status, component health (Postfix, Dovecot, Rspamd, OpenDKIM, fail2ban), queue depth, last config reload | 1 |
| **Per-customer email service** | Enable/disable email service per customer (suspend or hard-delete with data wipe) | 1 |
| **Mailbox management** | List, create, delete, and set storage quota per mailbox | 1 |
| **Alias management** | Create, list, and delete email aliases per domain | 1 |
| **DKIM key management** | View key status, trigger rotation, view key history, revoke key | 1 |
| **Outbound queue monitor** | Active/deferred/hold/corrupt queue sizes; per-message queue inspection; flush and delete actions | 1 |
| **Per-customer sending stats** | Sent count (24h/7d/30d), bounce rate, quota usage, FBL complaint rate, status badge | 1 |
| **Blacklist status** | Per-IP DNSBL check results (Spamhaus, Barracuda, Sorbs, Invaluement) with last-checked timestamp | 1 |
| **Deliverability dashboard** | IP pool status, FBL complaint overview, DMARC pass-rate overview, domain reputation table | 1 |
| **IP pool management** | Assign customers to Pool A or Pool B; view pool membership and warm-up status | 1 |
| **External SMTP relay** | Configure per-customer relay (SendGrid, Mailgun, Brevo, AWS SES, custom); enable/disable | 1 |
| **Spam filter overview** | Rspamd health, per-domain spam/ham counts (24h), spam score threshold configuration | 2 |
| **DMARC tightening** | Per-domain 30-day pass rate; one-click "Apply recommended policy" for eligible domains | 1 |
| **Website sendmail audit** | Per-customer sendmail send/reject/rate-limited log | 1 |
| **Autodiscover management** | Enable/disable autodiscover and SRV records per customer | 1 |

---

#### Stack Health Status

**Admin Panel → Email → Overview**

Top-of-page status card:

| Field | Value example | Notes |
|-------|--------------|-------|
| Mail pod | `1 / 1 running` | Critical banner if pod not running |
| Postfix | `● Healthy` | Queue not stalled, delivery rate > 0 |
| Dovecot | `● Healthy` | Auth passdb responding, IMAP accepting connections |
| Rspamd | `● Healthy` | Rspamd web UI reachable, scan queue normal |
| OpenDKIM | `● Healthy` | Milter socket active |
| fail2ban | `● Active` | Jail count and active ban count |
| Queue depth | `Active: 3 / Deferred: 12 / Hold: 0 / Corrupt: 0` | Warning if deferred > 100 |
| Last Postfix reload | `2026-03-08 04:01 UTC` | Shown after any config change |
| Delivery rate (1h) | `142 emails/hour` | |
| Bounce rate (24h) | `0.8%` | Warning badge if > 5% |

Prometheus alerts surfaced in this view: `EmailQueueTooLarge`, `EmailQueueStalled`, `EmailBounceRateHigh`, `EmailIPBlacklisted`.

---

#### Per-Customer Email Service

**Admin Panel → Email → Customers → {customer}**

Summary card: email enabled/disabled, mailbox count, domain count, plan limits, FBL status, last activity.

| Action | Behaviour |
|--------|-----------|
| **Disable (Suspend)** | Postfix stops accepting/relaying for customer domains; Dovecot denies login; data retained. Requires reason (logged to audit trail). |
| **Disable (Hard Delete)** | Full data wipe — all mailboxes, DKIM keys, aliases, config deleted. Requires admin confirmation and backup-first prompt. |
| **Re-enable** | Restores Postfix routing and Dovecot auth for customer domains. |
| **Move to Pool A / Pool B** | Updates `transport_maps`, runs `postfix reload`. |
| **Enable external relay** | Prompts for relay configuration form (see External SMTP Relay below). |

---

#### Mailbox Management

**Admin Panel → Email → Customers → {customer} → Mailboxes**

| Column | Notes |
|--------|-------|
| Email address | `user@customer.com` |
| Storage used | `1.2 GB of 10 GB` — progress bar |
| Last login | UTC timestamp (Dovecot last auth) |
| Status | `Active` / `Suspended` |
| App passwords | Count of active application passwords |
| Actions | Edit quota, Suspend, Delete, View app passwords |

**Create mailbox form:** email address, display name, initial storage quota (MB/GB), send welcome email toggle.

Deleting a mailbox requires a confirmation dialog. The delete is permanently destructive — no recycle period.

---

#### Alias Management

**Admin Panel → Email → Customers → {customer} → Aliases**

| Column | Notes |
|--------|-------|
| Alias address | `info@customer.com` |
| Destination(s) | One or more target addresses (pipe-separated) |
| Domain | Owning domain |
| Created | UTC timestamp |
| Actions | Edit destinations, Delete |

**Create alias form:** source address, one or more destination addresses (within or outside platform), destination validation (warn if external).

Catch-all aliases (`@domain.com → address`) are supported with a dedicated toggle on the domain settings view.

---

#### DKIM Key Management

**Admin Panel → Email → Customers → {customer} → DKIM**

Per-domain DKIM table:

| Column | Notes |
|--------|-------|
| Domain | e.g. `customer.com` |
| Selector | e.g. `default` |
| Key length | `2048` / `4096` |
| Status | `Active` / `Rotating` / `Deprecated` / `Revoked` |
| Created | UTC date |
| Next rotation | UTC date |
| DNS published | `● Verified` / `✗ Missing` — live DNS lookup result |
| Actions | Rotate key, View public key, Revoke |

**Key rotation flow:**

1. Admin clicks **Rotate** — system generates new key, publishes new selector DNS record, marks old key `Rotating` (remains valid for 30 days).
2. After 30 days the old key transitions to `Deprecated` and is removed from OpenDKIM.
3. Admin can force-revoke at any time (immediate removal — use only if key is compromised).

All key operations are logged to the admin audit trail. Private keys are never shown — stored in Vault.

---

#### Outbound Queue Monitor

**Admin Panel → Email → Queue**

Summary bar: `Active: N | Deferred: N | Hold: N | Corrupt: N`

Queue message table (paginated, sortable):

| Column | Notes |
|--------|-------|
| Queue ID | Postfix queue ID |
| Status | `Active` / `Deferred` / `Hold` |
| From | Sender address |
| To | Recipient address |
| Customer | Derived from sending domain |
| Size | Message size |
| Age | Time in queue |
| Next retry | For deferred messages |
| Defer reason | Last SMTP error (e.g. `Connection refused`, `452 Mailbox full`) |
| Actions | Force retry, Move to hold, Delete |

**Bulk actions:** Flush all deferred (attempt immediate retry), Delete all held, Flush queue for a specific customer domain.

> Deleting a queued message is irreversible and is logged to the audit trail with the admin's identity and a required reason.

---

#### Per-Customer Sending Stats

**Admin Panel → Email → Customers**

Overview table (all customers):

| Column | Notes |
|--------|-------|
| Customer | Name + plan badge |
| Sent (24h) | Count |
| Bounce rate (24h) | % — red if > 5% |
| Hourly quota used | `340 / 500 (68%)` — progress bar |
| Daily quota used | `1200 / 5000 (24%)` |
| FBL rate (7d) | % — amber > 0.1%, red > 0.3% |
| Status | `● Normal` / `⚠ Throttled` / `✗ Suspended` |
| Actions | View detail, Suspend sending, Move pool |

Filter: by plan, status, bounce rate threshold, FBL rate threshold. Sort by any column.

---

#### Blacklist Status

**Admin Panel → Email → Deliverability → Blacklists**

| Column | Notes |
|--------|-------|
| IP | Pool A or Pool B address |
| Pool | `A` / `B` |
| RBL | Spamhaus ZEN / Barracuda BRBL / Sorbs / Invaluement |
| Status | `● Clean` / `✗ Listed` |
| Last checked | UTC timestamp (hourly checks) |
| Listing reason | If listed |
| Delisting URL | Link to provider's removal page |

A `Critical` banner is shown platform-wide if any pool IP is listed on Spamhaus ZEN or Barracuda BRBL.

---

#### Deliverability Dashboard

**Admin Panel → Email → Deliverability**

Five panels:

1. **IP Pool Status** — Pool A and Pool B: IPs, warm status (`Warming` / `Warm`), PTR verified badge, blacklist summary
2. **FBL Complaint Overview** — Domains flagged in last 7 days; complaint rate chart; throttled/suspended count
3. **DMARC Overview** — Domains with tightening recommendation (30 days + ≥ 95% pass rate); table of pass rates per domain
4. **Domain Reputation** — Per-customer-domain: complaint rate (7d / 30d), FBL status badge, DMARC policy current/recommended
5. **Google Postmaster** — Link to external Google Postmaster Tools dashboard; placeholder for future API-integrated reputation summary

**Admin actions available here:**

| Action | Notes |
|--------|-------|
| Move customer to Pool A / B | Updates `transport_maps`, triggers `postfix reload`, audit logged |
| Suspend outbound for domain | Halt all outbound immediately; requires reason |
| Resume outbound | Re-enables after suspension; requires reason |
| Apply recommended DMARC policy | One-click update of DMARC TXT record via DNS controller; never auto-applied |
| View FBL complaints | Opens filtered complaint list for domain |
| Download complaint CSV | Date-ranged export |

---

#### IP Warm-Up Status

**Admin Panel → Email → Deliverability → IP Pools**

Per-IP panel showing current warm-up week, daily volume cap, actual sent count (today), abort-criteria indicators:

| Signal | Threshold | Indicator |
|--------|-----------|-----------|
| Bounce rate today | > 2% | `⚠ Pause recommended` |
| Blacklist hit | Any Spamhaus ZEN / Barracuda listing | `✗ Pause required` |
| FBL complaint rate | > 0.1% | `⚠ Pause recommended` |
| Outlook/Gmail deferral rate | > 10% of deliveries | `⚠ Slow down` |

Admin can manually advance or roll back the warm-up week, or mark an IP as fully warm.

---

#### External SMTP Relay Configuration

**Admin Panel → Email → Customers → {customer} → External Relay**

| Field | Notes |
|-------|-------|
| Provider | SendGrid / Mailgun / Brevo / AWS SES / Custom |
| SMTP host | Provider endpoint |
| SMTP port | `587` (STARTTLS) or `465` (implicit TLS) |
| Username | Provider SMTP username or `apikey` |
| Password / API key | Stored as Sealed Secret in client namespace — never shown after save |
| From domain | Domain being routed through relay |
| Status | `Enabled` / `Disabled` |

On save: management API updates `transport_maps`, runs `postfix reload`, updates customer SPF record via DNS controller (adds relay `include:`), stores credentials as Sealed Secret. All steps are atomic — on any failure the change is rolled back and an error shown.

Customers cannot self-configure relay — credentials are provided to support staff and entered by an admin.

---

#### Spam Filter Overview

**Admin Panel → Email → Spam (Phase 2)**

| Panel | Data |
|-------|------|
| Rspamd health | Pod status, scan queue depth, actions taken (reject/quarantine/tag) per hour |
| Per-domain spam stats | Spam count, ham count, false positive count, avg spam score (24h) |
| Score thresholds | Current reject/quarantine/tag score thresholds — editable (caution: platform-wide change) |
| Rspamd Web UI link | Direct link to Rspamd web interface for detailed module configuration |

---

#### Website Sendmail Audit

**Admin Panel → Email → Customers → {customer} → Sendmail Log**

| Column | Notes |
|--------|-------|
| Timestamp | UTC |
| Sender IP | Pod IP originating the send |
| From address | `noreply@customer.com` |
| To address | Recipient |
| Subject | Truncated |
| Status | `Accepted` / `Rejected` / `Rate Limited` / `Auth Failed` |
| Error | If non-accepted |

Filter by status, date range. CSV export. Sendmail rate limit override (emergency brake — set 0 to block all sendmail for a customer).

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/email/health` | Mail pod status, component health, queue depth, delivery and bounce rates |
| `GET` | `/api/v1/admin/email/customers` | Per-customer sending stats — sent, bounce rate, quota, FBL rate, status |
| `GET` | `/api/v1/admin/email/customers/{id}` | Full email service detail for a customer |
| `POST` | `/api/v1/admin/email/customers/{id}/disable` | Disable email service (`action`: `suspend` or `delete`, `reason` required) |
| `POST` | `/api/v1/admin/email/customers/{id}/enable` | Re-enable email service |
| `GET` | `/api/v1/admin/email/customers/{id}/mailboxes` | List mailboxes for customer |
| `POST` | `/api/v1/admin/email/customers/{id}/mailboxes` | Create mailbox (`address`, `quota_mb`, `display_name`) |
| `PATCH` | `/api/v1/admin/email/customers/{id}/mailboxes/{address}` | Update mailbox quota or status |
| `DELETE` | `/api/v1/admin/email/customers/{id}/mailboxes/{address}` | Delete mailbox (irreversible) |
| `GET` | `/api/v1/admin/email/customers/{id}/aliases` | List aliases for customer |
| `POST` | `/api/v1/admin/email/customers/{id}/aliases` | Create alias (`source`, `destinations[]`) |
| `PATCH` | `/api/v1/admin/email/customers/{id}/aliases/{source}` | Update alias destinations |
| `DELETE` | `/api/v1/admin/email/customers/{id}/aliases/{source}` | Delete alias |
| `GET` | `/api/v1/admin/email/customers/{id}/dkim` | List DKIM keys per domain for customer |
| `POST` | `/api/v1/admin/email/customers/{id}/dkim/{domain}/rotate` | Trigger DKIM key rotation for domain |
| `POST` | `/api/v1/admin/email/customers/{id}/dkim/{domain}/revoke` | Revoke DKIM key immediately |
| `GET` | `/api/v1/admin/email/queue` | Postfix queue contents (filter: `status`, `customer_id`, `domain`) |
| `POST` | `/api/v1/admin/email/queue/{queue_id}/retry` | Force-retry a deferred message |
| `POST` | `/api/v1/admin/email/queue/{queue_id}/hold` | Move message to hold queue |
| `DELETE` | `/api/v1/admin/email/queue/{queue_id}` | Delete queued message (`reason` required) |
| `POST` | `/api/v1/admin/email/queue/flush` | Flush all deferred messages (optional filter: `domain`) |
| `GET` | `/api/v1/admin/email/deliverability` | Deliverability dashboard — IP pools, FBL overview, DMARC overview |
| `GET` | `/api/v1/admin/email/blacklists` | Per-IP DNSBL check results for all pool IPs |
| `POST` | `/api/v1/admin/email/customers/{id}/pool` | Assign customer to Pool A or Pool B |
| `GET` | `/api/v1/admin/email/customers/{id}/relay` | Get external SMTP relay configuration |
| `PUT` | `/api/v1/admin/email/customers/{id}/relay` | Set or update external relay configuration |
| `DELETE` | `/api/v1/admin/email/customers/{id}/relay` | Remove external relay (revert to platform Postfix) |
| `GET` | `/api/v1/admin/email/customers/{id}/sendmail-log` | Website sendmail audit log (filter: `status`, `from`, `to`, date range) |
| `GET` | `/api/v1/admin/email/customers/{id}/fbl` | FBL complaint list for customer (filter: `provider`, date range) |
| `POST` | `/api/v1/admin/email/customers/{id}/dmarc/{domain}/apply` | Apply recommended DMARC policy tightening via DNS controller |

### EC.2 Roundcube Webmail Configuration

**Requirement:** Manage Roundcube webmail configuration and monitor user access.

**Features:**

- [ ] **Webmail Dashboard:** View Roundcube status (pod health, database connectivity, active users, response time)
- [ ] **Webmail Domain Management:** List all domains with certificate status, enable/disable, user stats
- [ ] **Per-Domain Settings:** Edit default theme, language, OIDC settings, certificate details
- [ ] **Customer-Level Toggle:** Quick enable/disable webmail for specific customer
- [ ] **Certificate Monitoring:** View expiration dates, auto-renewal status, manual renewal button
- [ ] **Usage Statistics:** Track unique users, login events, peak concurrent users, failed logins
- [ ] **Active Sessions:** View currently logged-in users, last activity, kick sessions
- [ ] **Roundcube Configuration:** Manage plugins, features, resource limits, logging

**API Endpoints:**
- GET `/api/v1/admin/webmail-domains` — List all webmail domains
- GET `/api/v1/admin/webmail-domains/{domain_id}` — Get domain details
- PATCH `/api/v1/admin/webmail-domains/{domain_id}` — Update settings
- POST `/api/v1/admin/webmail-domains/{domain_id}/disable` — Disable webmail
- POST `/api/v1/admin/webmail-domains/{domain_id}/enable` — Re-enable webmail
- GET `/api/v1/admin/webmail/sessions` — List active sessions
- POST `/api/v1/admin/webmail/sessions/{session_id}/kick` — Invalidate session
- GET `/api/v1/admin/webmail/usage-stats` — Get usage statistics

---

### EC.3 Admin Email Access (Masquerading as Customer)

**Requirement:** Allow admins to temporarily log into customer email accounts for support and troubleshooting with full audit logging.

**Features:**

- [ ] **Generate Access Token:** Create secure one-time token for admin email access
- [ ] **Role-Based Access Control:** Support staff (read-only) vs Senior Admin (full access)
- [ ] **Auto-Login from Control Panel:** One-click access to customer email via secure token
- [ ] **Session Management:** Automatic timeout (60 min), session revocation, IP validation
- [ ] **Comprehensive Audit Logging:** Track every action (read, search, delete, send, etc.)
- [ ] **Detailed Action Log:** View what admin did during session (emails read, searches, sensitive actions)
- [ ] **Admin Access Dashboard:** Monitor active sessions, sensitive actions, per-admin metrics
- [ ] **Confirmation Dialogs:** Require confirmation for email sends and deletions
- [ ] **Audit Trail Viewer:** View complete history of admin access per customer (timestamped, IP-logged)
- [ ] **Session Revocation:** Super admin can revoke active sessions early
- [ ] **Access History:** View all admin access to customer emails (date, duration, actions)
- [ ] **Metrics & Alerts:** Track sensitive actions (sends, deletes), anomaly detection

**Database Tables:**
- `admin_email_access_sessions` — Session tracking with tokens, IP, expiry
- `admin_email_access_audit_log` — Detailed action log (every action timestamped)
- `admin_email_access_summary` — Summary stats per session

**API Endpoints:**
- POST `/api/v1/admin/email-access/generate-token` — Create access token
- GET `/api/v1/admin/email-access/sessions?status=active` — List active sessions
- GET `/api/v1/admin/email-access/sessions/{session_id}/log` — View complete audit log
- POST `/api/v1/admin/email-access/sessions/{session_id}/revoke` — Revoke session early
- GET `/api/v1/admin/customers/{customer_id}/email-access-history` — Access history per customer

---

## Backup & Disaster Recovery

The platform uses a **three-tier backup model**:

| Tier | Type | Quota impact | Storage |
|------|------|--------------|---------|
| 1 | Cluster-managed automated backups (Velero + rsync + mysqldump/pg_dump) | None — platform cost | Offsite server (SSHFS) |
| 2 | Customer-created on-demand backups | Yes — counts against plan quota | Offsite server (`customer-backups/`) |
| 3 | Encrypted offsite archives (AES-256-CBC) | None | Offsite server (SSHFS) |

The offsite server is mounted on-demand via **SSHFS** during the backup window and immediately unmounted — consuming no persistent local cluster disk. All operations are async; the API returns `202 Accepted` with a job ID.

See also: `BACKUP_STRATEGY.md`, `BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md`, `BACKUP_EXPORT_MIGRATION_GUIDE.md`.

---

### BR.1 Velero Backup Management

**Requirement:** View and manage Kubernetes cluster-state backups (Velero), database dumps (mysqldump / pg_dump), and the offsite SSHFS backup infrastructure. Velero captures cluster-state snapshots; BR.2 covers workload file backups via rsync.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Backup overview** | Global backup health card: last successful run per component, next scheduled run, offsite storage used/free | 1 |
| **Backup job list** | All backup jobs across all customers — date, type, status, size, checksum, retention expiry | 1 |
| **Per-customer backup list** | All automated and manual backups for a specific customer — filterable by type and status | 1 |
| **Manual trigger** | Trigger an immediate full, database-only, or files-only backup for a customer | 1 |
| **Restore** | Initiate restore from a selected backup — scope: full / database only / files only | 1 |
| **Backup deletion** | Delete a specific backup archive from offsite storage (with confirmation) | 1 |
| **Retention policy** | View and edit per-customer retention days (within plan limits) | 1 |
| **Offsite server configuration** | Configure hostname, port, SSH credentials, remote base path, archive format, encryption | 1 |
| **Encryption settings** | Enable/disable AES-256-CBC encryption; manage per-customer encryption passwords | 1 |
| **Storage usage** | Per-customer backup storage breakdown; total offsite usage vs capacity; growth trend | 1 |
| **Backup verification** | Trigger SHA-256 checksum verification for a specific backup; weekly scheduled verify job status | 1 |
| **Alert status** | Surface `BackupJobFailed`, `OffsiteBackupFailed`, `OffsiteMountFailed` alerts | 1 |
| **Velero schedule list** | View Velero Schedule and BackupStorageLocation resources; last Velero backup age | 1 |

---

#### Backup Overview

**Admin Panel → Backup → Overview**

Top-of-page status card:

| Component | Last run | Status | Next run |
|-----------|----------|--------|----------|
| Velero cluster snapshot | `2026-03-08 01:03 UTC` | `● Completed` | `2026-03-09 01:00 UTC` |
| Database dumps (MariaDB) | `2026-03-08 02:11 UTC` | `● Completed` | `2026-03-09 02:00 UTC` |
| Database dumps (PostgreSQL) | `2026-03-08 02:14 UTC` | `● Completed` | `2026-03-09 02:00 UTC` |
| Encryption pass | `2026-03-08 07:02 UTC` | `● Completed` | `2026-03-09 07:00 UTC` |
| Offsite SSHFS mount | `2026-03-08 02:00 UTC` | `● Clean` | — |
| Checksum verification | `2026-03-08 03:00 UTC (Sun)` | `● Passed` | `2026-03-15 03:00 UTC` |

Offsite storage gauge: `312 GB of 1 TB used (31%)`. Warning at 80%, Critical at 90%.

Critical banner is shown for any component with status `Failed` or `Mount Error`. Alert badges link to the corresponding Prometheus alert in ML.3.

---

#### Backup Job List

**Admin Panel → Backup → Jobs**

| Column | Notes |
|--------|-------|
| Date | Backup creation timestamp (UTC) |
| Customer | Name + plan badge |
| Type | `Full` / `Database` / `Files` / `Velero` |
| Source | `auto` / `manual` / `scheduled` |
| Status | `● Completed` / `↻ In progress` / `✗ Failed` |
| Size | Human-readable (e.g. `4.2 GB`) |
| Checksum | SHA-256 prefix (copyable); `✓ Verified` / `✗ Mismatch` badge |
| Retention until | Date + days remaining |
| Actions | View details, Trigger restore, Delete |

Filter: by customer, type, status, date range, checksum status. Sort by date, size, customer.

---

#### Per-Customer Backup Detail

**Admin Panel → Backup → Customers → {customer} → Backups**

Summary bar: `N backups | Total: X GB | Oldest: YYYY-MM-DD | Newest: YYYY-MM-DD | Retention: 14 days`

Backup table (same columns as job list, scoped to customer). Per-backup actions:

| Action | Notes |
|--------|-------|
| **Restore → Full** | Overwrites all workload files and databases from backup. Requires `CONFIRM` typed in dialog. Pre-restore snapshot taken automatically. |
| **Restore → Database only** | Restores database dumps only, leaves files untouched. |
| **Restore → Files only** | Restores workload files only, leaves databases untouched. |
| **Verify checksum** | Runs SHA-256 verification against offsite archive. Result shown inline. |
| **Delete** | Permanently removes archive from offsite server. Requires reason. Logged to audit trail. |

> **Restore safety:** Before overwriting, the system automatically snapshots current data. If the restore fails, it rolls back to the pre-restore snapshot. Admin is notified of success or failure via the notification service.

---

#### Retention Policy Management

**Admin Panel → Backup → Customers → {customer} → Retention**

| Plan | Default | Maximum |
|------|---------|---------|
| Starter | 7 days | 14 days |
| Business | 14 days | 30 days |
| Premium | 30 days | 90 days |
| Custom | Negotiated | Unlimited |

Admin can set a per-customer override within plan limits. The `expires_at` field on the `backups` table is recomputed when retention is changed. A 7-day warning notification is sent before auto-deletion of any backup.

---

#### Offsite Server Configuration

**Admin Panel → Backup → Settings → Offsite Server**

| Field | Notes |
|-------|-------|
| Hostname | SSH hostname or IP |
| Port | Default `22` (Hetzner StorageBox: `23`) |
| Username | SSH login user |
| SSH private key | Paste Ed25519 private key — stored as Sealed Secret `offsite-ssh-key` in `platform` namespace, never shown after save |
| Remote base path | e.g. `/backups` |
| Archive format | `tar.gz` (default) / `tar` / `zip` |
| Encryption | Enable AES-256-CBC — password stored as Sealed Secret `backup-encryption` |
| Test connection | Button — validates SSH connectivity and write access |

After saving, the system runs a connectivity test. Any failure is shown inline and the previous configuration is retained.

---

#### Storage Usage

**Admin Panel → Backup → Storage**

| Panel | Data |
|-------|------|
| Total offsite usage | `312 GB of 1 TB (31%)` — progress bar |
| By type | Cluster snapshots / DB dumps / File backups / Customer-created — stacked bar |
| Top 10 customers by backup size | Sortable table (name, total backup GB, % of total) |
| Growth trend | 7-day and 30-day sparkline |
| Estimated days until full | At current growth rate |

---

#### Velero Schedule List

**Admin Panel → Backup → Velero**

Read-only view of Velero resources in the cluster:

| Column | Notes |
|--------|-------|
| Schedule name | e.g. `daily-cluster-snapshot` |
| Cron expression | e.g. `0 1 * * *` |
| Last backup | Name + timestamp + status |
| Backup storage location | e.g. `default` |
| TTL | Velero-managed retention (e.g. `720h`) |
| Phase | `Enabled` / `Paused` |

Link to Velero CLI commands for advanced operations (copy-to-clipboard).

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/backups` | List all backup jobs (filter: `customer_id`, `type`, `status`, `from`, `to`) |
| `GET` | `/api/v1/admin/backups/overview` | Global backup health: last run per component, offsite storage usage |
| `GET` | `/api/v1/admin/backups/storage` | Storage usage breakdown: by type, by customer, growth trend |
| `GET` | `/api/v1/admin/backups/velero` | List Velero Schedules and BackupStorageLocations |
| `GET` | `/api/v1/admin/customers/{id}/backups` | List backups for a customer (filter: `type`, `status`) |
| `POST` | `/api/v1/admin/customers/{id}/backups` | Trigger manual backup (`type`: `full`/`database`/`files`, `retention_days`) |
| `GET` | `/api/v1/admin/customers/{id}/backups/{backup_id}` | Get backup detail (metadata, checksum, path, size) |
| `POST` | `/api/v1/admin/customers/{id}/backups/{backup_id}/restore` | Initiate restore (`scope`: `full`/`database`/`files`) — returns `restore_id` |
| `GET` | `/api/v1/admin/customers/{id}/backups/{backup_id}/verify` | Trigger or get result of SHA-256 checksum verification |
| `DELETE` | `/api/v1/admin/customers/{id}/backups/{backup_id}` | Delete backup archive (`reason` required) |
| `GET` | `/api/v1/admin/customers/{id}/backup-retention` | Get retention policy for customer |
| `PUT` | `/api/v1/admin/customers/{id}/backup-retention` | Set retention days override (within plan limits) |
| `GET` | `/api/v1/admin/backup-settings/offsite` | Get offsite server configuration (credentials masked) |
| `PUT` | `/api/v1/admin/backup-settings/offsite` | Update offsite server configuration |
| `POST` | `/api/v1/admin/backup-settings/offsite/test` | Test SSH connectivity and write access to offsite server |
| `GET` | `/api/v1/admin/backup-settings/encryption` | Get encryption settings (enabled/disabled; key name only) |
| `PUT` | `/api/v1/admin/backup-settings/encryption` | Enable/disable encryption; rotate encryption password |
| `GET` | `/api/v1/admin/backups/restores/{restore_id}` | Poll restore job status and progress |

---

### BR.2 File Backups (rsync --archive)

**Requirement:** View and manage workload file backups performed nightly by `rsync --archive --delete` from Longhorn PVs to the offsite SSHFS-mounted server. Covers file backup job status, per-customer file backup listing, manual triggers, and restore initiation.

> **Separation of concerns:** BR.1 covers Velero cluster-state snapshots and database dumps. BR.2 covers workload file trees (web root, application files, email data, etc.) copied via rsync.

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **File backup job status** | Per-customer rsync job results from nightly `file-backup` CronJob (03:00 UTC) | 1 |
| **Per-customer file backup list** | List of completed file backups with date, size, path, checksum | 1 |
| **File backup detail** | Directory tree snapshot overview: top-level paths, total file count, total size | 1 |
| **Manual trigger** | Trigger an immediate rsync file backup for a specific customer | 1 |
| **File restore** | Initiate restore of workload files from a selected file backup snapshot | 1 |
| **rsync job log** | View stdout/stderr output of a specific rsync job run | 1 |
| **Backup path browser** | Read-only view of the offsite directory structure for a customer (`/backups/daily/{date}/files/{customer}/`) | 1 |
| **Customer-created backup list** | List Tier 2 backups (customer-initiated) for a customer — size, retention, expiry | 1 |
| **Quota usage** | Customer backup quota: used vs. plan limit; breakdown by type | 1 |

---

#### File Backup Job Status

**Admin Panel → Backup → Files → Jobs**

| Column | Notes |
|--------|-------|
| Date | rsync run timestamp (UTC) |
| Customer | Name + plan badge |
| Workload | Workload name (maps to `/backups/daily/{date}/files/{customer}/{workload}/`) |
| Status | `● Completed` / `↻ In progress` / `✗ Failed` |
| Duration | rsync wall-clock time (e.g. `1m 23s`) |
| Files synced | Count of files transferred in this run |
| Size | Total size of the workload file tree (not the delta) |
| Exit code | `0` = success; non-zero with inline error message |
| Actions | View log, Trigger restore |

Filter: by customer, status, date range. Failed jobs surface the rsync exit code and stderr snippet inline.

**Nightly schedule:** `0 3 * * *` UTC. `concurrencyPolicy: Forbid`.

---

#### Per-Customer File Backup List

**Admin Panel → Backup → Customers → {customer} → File Backups**

Summary: `N snapshots | Oldest: YYYY-MM-DD | Newest: YYYY-MM-DD | Total size: X GB`

Per-snapshot table:

| Column | Notes |
|--------|-------|
| Date | Snapshot date (maps to `/backups/daily/{date}/files/{customer}/`) |
| Workload | Individual workload subdirectory |
| Size | Total size of file tree |
| Files | Total file count |
| Checksum | SHA-256 of the snapshot tarball (if present in `checksums.sha256`) |
| Actions | View log, Browse paths, Trigger restore |

**Path convention:** `/backups/daily/{YYYY-MM-DD}/files/{customer-id}/{workload-name}/`

---

#### File Restore

Initiating a file restore from BR.2:

1. Admin selects snapshot date and optionally a specific workload subdirectory
2. Restore scope: **entire workload file tree** or **specific subdirectory**
3. Confirmation dialog: `WARNING: This will overwrite current workload files for {workload}. Type CONFIRM to proceed.`
4. Pre-restore snapshot of current files taken automatically
5. rsync copies files from SSHFS mount back to Longhorn PV
6. Permissions verified (`644` files, `755` directories)
7. Workload pod restarted after successful restore
8. Admin and customer notified of completion or failure

---

#### rsync Job Log

**Admin Panel → Backup → Files → Jobs → {job} → Log**

Full stdout/stderr output of the rsync run, paginated. Includes:

- rsync version and invocation flags (`--archive --delete --stats`)
- Files transferred count and total size transferred
- Transfer speed and wall-clock duration
- Any error lines (e.g. permission denied, disk full, SSHFS timeout)

---

#### Customer-Created Backup List

**Admin Panel → Backup → Customers → {customer} → Customer Backups**

Tier 2 (customer-initiated) backups stored in `/backups/customer-backups/{customer-id}/`:

| Column | Notes |
|--------|-------|
| Name | e.g. `backup-2026-03-01-full.tar.gz.enc` |
| Created | UTC timestamp |
| Size | Archive size |
| Encrypted | `● Yes` / `✗ No` |
| Retention | Days setting (from `.retention_days` file) |
| Expires | UTC date — warning badge if within 7 days |
| Actions | Verify checksum, Delete |

Quota usage bar: `15 GB used of 50 GB customer backup quota`.

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/backups/files` | List file backup jobs (filter: `customer_id`, `status`, `from`, `to`) |
| `GET` | `/api/v1/admin/customers/{id}/backups/files` | List file backup snapshots for a customer |
| `GET` | `/api/v1/admin/customers/{id}/backups/files/{date}` | Get file backup detail for a specific date — workload list, sizes, checksums |
| `GET` | `/api/v1/admin/customers/{id}/backups/files/{date}/log` | Get rsync job log output for a specific snapshot |
| `POST` | `/api/v1/admin/customers/{id}/backups/files/trigger` | Trigger immediate rsync file backup for customer |
| `POST` | `/api/v1/admin/customers/{id}/backups/files/{date}/restore` | Initiate file restore (`workload`, `scope`: `full`/`subdirectory`, `path`) |
| `GET` | `/api/v1/admin/customers/{id}/backups/customer-created` | List Tier 2 (customer-created) backups |
| `DELETE` | `/api/v1/admin/customers/{id}/backups/customer-created/{name}` | Delete a customer-created backup archive (`reason` required) |
| `GET` | `/api/v1/admin/customers/{id}/backup-quota` | Backup quota usage: used vs. plan limit, breakdown by tier |

---

### BR.3 Cross-Region Backup Sync

**Requirement:** Manage backup replication to other regions (Phase 2). Cross-region sync transfers completed Velero and rsync backups from the primary region's object store to one or more remote region buckets for disaster recovery. Complements BR.1 (Velero) and BR.2 (file backups).

**Features (Phase 2):**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Replication status overview** | Per-configured remote region: last successful sync time, objects transferred, bytes transferred, transfer duration, and current status (`Idle` / `Syncing` / `Failed`) | 2 |
| **Sync schedule** | View and update the cron schedule for each remote region sync job (default: nightly at 02:00 UTC) | 2 |
| **Manual sync trigger** | Trigger an immediate sync to a specific remote region for a specific customer or all customers | 2 |
| **Transfer health** | Per-region connectivity check: target bucket reachable, credentials valid, last error message | 2 |
| **Per-customer replication status** | View which remote regions have a current copy of a customer's backups, and the age of the most recent copy | 2 |
| **Replication lag alert** | Warning badge when a remote region's most recent sync is > 24 hours behind the primary | 2 |

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/backups/sync/regions` | List configured remote regions with current replication status and last sync time |
| `GET` | `/api/v1/admin/backups/sync/regions/{region}` | Detail for a remote region: schedule, last sync result, transfer stats, last error |
| `PUT` | `/api/v1/admin/backups/sync/regions/{region}/schedule` | Update sync cron schedule for a remote region |
| `POST` | `/api/v1/admin/backups/sync/regions/{region}/trigger` | Trigger immediate sync to a remote region (optional `customer_id` to scope to one customer) |
| `GET` | `/api/v1/admin/customers/{id}/backups/sync-status` | Per-customer replication status across all remote regions |

---

## Subscription & Expiry Management

### SE.1 Subscription Tracking & Expiry Alerts

**Requirement:** Track customer subscription expiry dates and send admin alerts. No billing platform is required — the platform operates fully in manual mode.

**Features (Phase 1):**

| Feature | Specification | Phase |
|---------|---|---|
| **Subscription List** | View all customers, expiry dates, billing mode, and gateway assignment | 1 |
| **Expiry Alerts** | Dashboard badge showing expiring/expired subscriptions | 1 |
| **Alert Schedule** | Day 60, 30, 7, 0, +7 alerts (configurable) | 1 |
| **Manual Renewal** | Admin sets new expiry date directly — no gateway required | 1 |
| **Record Payment** | Admin logs payment reference, method, amount, and new expiry date | 1 |
| **Send Payment Link** | Generate once-off payment link via assigned gateway and email to customer | 1 |
| **Gateway Assignment** | Assign or change the payment gateway for a specific customer | 1 |
| **Billing Mode** | Set per-customer: `manual`, `once_off`, or `recurring` | 1 |
| **Renewal Amount/Currency** | Set the renewal price per customer for payment link and client panel checkout | 1 |
| **Payment History** | View all past payments (manual records + gateway transactions) per customer | 1 |
| **Webhook Status** | View webhook delivery status for gateway-connected customers | 1 |
| **Bulk Renewal** | Update expiry dates for multiple customers at once | 1.5 |
| **Grace Period Config** | Set how many days service remains active after expiry before auto-suspend | 1.5 |
| **Gateway Sync** | Manually trigger reconciliation for customers with recurring gateway billing | 1.5 |

**Integration:** See `../01-core/EXTERNAL_BILLING_INTEGRATION.md` and `../04-deployment/SUBSCRIPTION_EXPIRY_NOTIFICATIONS.md`

**API Endpoints:** See `./MANAGEMENT_API_SPEC.md`

---

### SE.2 Payment Gateway Management

**Requirement:** Configure and manage payment gateways at the platform level. Gateways are optional — the platform works fully without any gateway configured.

**Features (Phase 1):**

| Feature | Specification | Phase |
|---------|---|---|
| **Gateway List** | View all configured gateways, provider, status, and assigned customer count | 1 |
| **Add Gateway** | Configure a new gateway (Stripe, PayPal, DPO, Chargebee, Paddle, etc.) | 1 |
| **Edit Gateway** | Update credentials, display name, or settings | 1 |
| **Enable / Disable** | Temporarily disable a gateway without deleting it | 1 |
| **Test Gateway** | Send a test request to verify credentials and connectivity | 1 |
| **Delete Gateway** | Remove gateway (only if no customers currently assigned) | 1 |
| **Webhook Status** | View recent webhook deliveries and failures per gateway | 1 |
| **Webhook Retry** | Manually retry failed webhook events | 1.5 |

**Supported Gateways:**

| Gateway | Region Focus | Once-Off | Recurring |
|---------|-------------|----------|-----------|
| **Stripe** | Global | ✅ | ✅ |
| **PayPal** | Global | ✅ | ✅ |
| **DPO (Direct Pay Online)** | Africa (ZAR, KES, NGN, 20+ currencies, mobile money) | ✅ | ✅ |
| **Chargebee** | Global | ✅ | ✅ |
| **Paddle** | Global | ✅ | ✅ |
| **2Checkout / Verifone** | Global | ✅ | ✅ |
| **Adyen** | Global | ✅ | ✅ |

**API Endpoints:**
- `GET /api/v1/admin/gateways` — List all configured gateways
- `POST /api/v1/admin/gateways` — Add new gateway
- `PATCH /api/v1/admin/gateways/{gateway_id}` — Update gateway
- `DELETE /api/v1/admin/gateways/{gateway_id}` — Remove gateway
- `POST /api/v1/admin/gateways/{gateway_id}/test` — Test connectivity
- `GET /api/v1/admin/gateways/{gateway_id}/webhooks` — View webhook deliveries

---

### SE.3 Manual Renewal & Payment Recording (Admin Panel UI)

**Requirement:** Allow admins to renew any subscription directly in the Admin Panel without requiring any payment gateway.

**Renew Subscription Form (Admin Panel → Client → Subscription → Renew):**

```
┌──────────────────────────────────────────────────────┐
│  Renew Subscription — Acme Corp                      │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Current Expiry:   2026-03-01   (7 days remaining)   │
│                                                      │
│  New Expiry Date:  [2027-03-01 ▼]                    │
│                                                      │
│  ── Payment Record (optional) ────────────────────── │
│  Amount Paid:      [19.99    ]  Currency: [USD ▼]    │
│  Payment Method:   [EFT / Bank Transfer        ▼]    │
│  Payment Reference:[EFT-REF-20260301           ]     │
│  Notes:            [Annual renewal             ]     │
│                                                      │
│  [Cancel]                        [Save & Renew]      │
└──────────────────────────────────────────────────────┘
```

**Payment Method options (dropdown):**
- EFT / Bank Transfer
- Cash
- Invoice / Purchase Order
- Stripe (manual record)
- PayPal (manual record)
- DPO (manual record)
- Other

**API Endpoint:**
```bash
PATCH /api/v1/clients/{id}/subscription
{
  "expiry_date": "2027-03-01",
  "status": "active",
  "payment_amount": 19.99,
  "payment_currency": "USD",
  "payment_method": "eft",
  "payment_reference": "EFT-REF-20260301",
  "notes": "Annual renewal, paid via EFT"
}
```

---

### SE.4 Send Payment Link (Admin Panel UI)

**Requirement:** Allow admin to generate a once-off payment link via the customer's assigned gateway and send it by email.

**Send Payment Link Form (Admin Panel → Client → Subscription → Send Payment Link):**

```
┌──────────────────────────────────────────────────────┐
│  Send Payment Link — Acme Corp                       │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Gateway:     [DPO (Direct Pay Online)         ▼]    │
│  Amount:      [19.99    ]  Currency: [USD ▼]         │
│  Renewal For: [12 months ▼]                          │
│                                                      │
│  ── Email ──────────────────────────────────────── │
│  Send to:    [admin@acme.com                   ]     │
│  Message:    [Please renew your hosting...     ]     │
│                                                      │
│  Link expires: [7 days ▼]                            │
│                                                      │
│  [Cancel]                    [Generate & Send Link]  │
└──────────────────────────────────────────────────────┘
```

**After sending:**
- Payment link URL is shown to admin (can copy manually)
- Email sent to customer with link
- Link status tracked: Pending → Paid / Expired
- On payment: subscription auto-renewed via webhook, admin notified

**API Endpoint:**
```bash
POST /api/v1/clients/{id}/subscription/send-payment-link
{
  "gateway_id": "dpo_africa",
  "amount": 19.99,
  "currency": "USD",
  "renewal_period_months": 12,
  "notify_customer_email": true,
  "email_message": "Please renew your hosting subscription."
}
```

---

### SE.5 Revenue & Customer Analytics (Phase 2+)

**Requirement:** Track platform revenue metrics (out of MVP scope).

**Future Features:**

| Feature | Phase |
|---------|-------|
| **MRR (Monthly Recurring Revenue)** | 2 |
| **Customer Lifetime Value (LTV)** | 2 |
| **Churn Rate** | 2 |
| **Plan Distribution** | 2 |
| **Payment Method Breakdown** | 2 |
| **Revenue by Gateway** | 2 |
| **Revenue Forecast** | 3 |

**Note:** The platform tracks all payments in `payment_history`. Revenue analytics are derived from this table.

---

## Audit & Compliance

### AC.1 Audit Logging

**Requirement:** Provide a comprehensive, immutable audit trail of all admin and client actions across the platform — for compliance (GDPR, SOC 2, PCI-DSS), security investigation, and operational accountability.

See also: `EVENT_LOGGING_STRATEGY.md` (full event taxonomy, JSON schema, capture points), `DATABASE_SCHEMA.md` (table definitions), `AUTHORIZATION_MATRIX.md` (per-role access constraints).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Audit log viewer** | Paginated, filterable list of all platform audit events | 1 |
| **Real-time security dashboard** | Login failure rate, permission denials, privilege escalations, data exports — live counters | 1 |
| **Per-client audit scope** | Filter all audit events to a specific client | 1 |
| **Per-admin audit scope** | Filter all audit events by actor (admin user) | 1 |
| **Security event log** | Dedicated view for `SECURITY_*` and `AUTHZ_PRIVILEGE_ESCALATION` events | 1 |
| **Event detail view** | Full JSON event payload: before/after changes, actor, IP, user agent, request ID | 1 |
| **Export** | Export filtered results as CSV or JSON (requires stated reason; export itself is audited) | 1 |
| **Retention overview** | Per-category retention periods; cold archive status; total log volume | 1 |
| **GDPR data-subject export** | Trigger export of all audit events for a specific user (all time) | 2 |
| **Monthly compliance report** | Aggregated event counts by category and severity for a given month | 2 |

---

#### Real-Time Security Dashboard

**Admin Panel → Audit → Overview**

| Metric | Description | Alert threshold |
|--------|-------------|-----------------|
| Login failures (last 1h) | Count of `AUTH_LOGIN_FAILED` events | > 50 → Critical banner |
| Failed permission checks (last 1h) | Count of `AUTHZ_PERMISSION_DENIED` events | — |
| Privilege escalations (all time) | Count of `AUTHZ_PRIVILEGE_ESCALATION` — should always be 0 in normal operation | Any > 0 → Critical |
| Critical security events (unresolved) | Count of unresolved rows in `security_events` with `severity = critical` | Any > 0 → Critical |
| Data exports (last 24h) | Count of `DATA_EXPORT` and `DATA_GDPR_EXPORT` events | > 10 → Warning |
| Bulk delete operations (last 24h) | Count of `DATA_BULK_DELETE` events | — |
| Unusual API usage flags | Count of `SECURITY_SUSPICIOUS_API` events | Any > 0 → Warning |

Critical counters display as a persistent red badge. Any `AUTHZ_PRIVILEGE_ESCALATION` event triggers an immediate platform-wide admin email notification regardless of panel state.

---

#### Audit Log Viewer

**Admin Panel → Audit → Log**

Filterable, paginated table — default sort: newest first.

| Column | Notes |
|--------|-------|
| Timestamp | UTC with milliseconds |
| Category | `AUTH` / `AUTHZ` / `RESOURCE` / `DATA` / `CONFIG` / `SYSTEM` / `SECURITY` / `INTEGRATION` |
| Event type | e.g. `RESOURCE_CLIENT_SUSPENDED` — colour-coded by severity |
| Severity | `DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL` — badge |
| Actor | Admin/user name + type (`user` / `system` / `webhook`) |
| Client | Affected client (if applicable) — clickable |
| Resource | Resource type + ID (e.g. `workload:wl-abc123`) |
| Status | `● Success` / `✗ Failure` |
| Actions | View detail |

**Filter controls:**

| Filter | Type |
|--------|------|
| Category | Multi-select dropdown |
| Severity | Multi-select: DEBUG / INFO / WARNING / ERROR / CRITICAL |
| Event type | Text search or category-scoped dropdown |
| Actor | User search (name or email) |
| Client | Client search |
| Resource type | Dropdown: client / workload / domain / database / backup / user_role / certificate / dns / email / registry / firewall |
| Status | Success / Failure / Both |
| Date range | Date-time pickers (`from` / `to`) — default last 24 hours |

Pagination: 50 rows per page. Total count shown.

---

#### Event Detail View

Clicking any row opens a detail panel:

```
Event: RESOURCE_CLIENT_SUSPENDED
──────────────────────────────────────────────────────
ID:            evt-7f3a9c21
Timestamp:     2026-03-08 14:32:07.441 UTC
Category:      RESOURCE
Severity:      WARNING
Status:        success

Actor
  ID:          user-001
  Type:        user
  Name:        Jane Admin
  IP:          10.42.0.15
  User agent:  Mozilla/5.0 (X11; Linux x86_64) ...

Resource
  Type:        client
  ID:          client-acme-corp
  Name:        Acme Corp

Changes
  Before:      { "status": "active" }
  After:       { "status": "suspended", "suspended_reason": "Non-payment" }

Metadata
  API endpoint: POST /api/v1/admin/customers/client-acme-corp/suspend
  Request ID:   req-88bc1d44
  Duration:     142 ms
```

Sensitive fields (`password`, `api_token`, `private_key`) are always shown as `***REDACTED***`.

---

#### Security Event Log

**Admin Panel → Audit → Security Events**

Dedicated view of the `security_events` table — only `SECURITY_*`, `AUTHZ_PRIVILEGE_ESCALATION`, `AUTH_ACCOUNT_LOCKED`, and `AUTH_MFA_DISABLED` events.

| Column | Notes |
|--------|-------|
| Timestamp | UTC |
| Event type | e.g. `SECURITY_UNAUTHORIZED_ACCESS` |
| Severity | Badge — Critical events highlighted in red |
| Client | If applicable |
| User | If applicable |
| Description | Human-readable summary |
| Resolved | `● Yes` / `○ No` |
| Remediation | Notes field — editable by Platform Admin |
| Actions | Mark resolved, View detail |

Unresolved critical events appear as a persistent banner on every admin panel page until marked resolved.

---

#### Audit Event Taxonomy (Reference)

Full event taxonomy — all event codes the log viewer recognises:

| Category | Events |
|----------|--------|
| **AUTH** | `AUTH_LOGIN_SUCCESS`, `AUTH_LOGIN_FAILED`, `AUTH_LOGOUT`, `AUTH_PASSWORD_CHANGED`, `AUTH_PASSWORD_RESET`, `AUTH_MFA_ENABLED`, `AUTH_MFA_DISABLED`, `AUTH_ACCOUNT_LOCKED`, `AUTH_TOKEN_REFRESH`, `AUTH_EMAIL_VERIFIED` |
| **AUTHZ** | `AUTHZ_PERMISSION_GRANTED`, `AUTHZ_PERMISSION_DENIED`, `AUTHZ_ROLE_ASSIGNED`, `AUTHZ_ROLE_REVOKED`, `AUTHZ_PRIVILEGE_ESCALATION` |
| **RESOURCE** | `RESOURCE_CLIENT_CREATED`, `RESOURCE_CLIENT_UPDATED`, `RESOURCE_CLIENT_SUSPENDED`, `RESOURCE_CLIENT_DELETED`, `RESOURCE_WORKLOAD_CREATED`, `RESOURCE_WORKLOAD_UPDATED`, `RESOURCE_WORKLOAD_DELETED`, `RESOURCE_WORKLOAD_STARTED`, `RESOURCE_WORKLOAD_STOPPED`, `RESOURCE_DOMAIN_CREATED`, `RESOURCE_DOMAIN_VERIFIED`, `RESOURCE_DATABASE_CREATED`, `RESOURCE_DATABASE_DELETED`, `RESOURCE_BACKUP_CREATED`, `RESOURCE_BACKUP_RESTORED` |
| **DATA** | `DATA_EXPORT`, `DATA_IMPORT`, `DATA_BULK_DELETE`, `DATA_SENSITIVE_ACCESSED`, `DATA_GDPR_EXPORT` |
| **CONFIG** | `CONFIG_PLAN_CHANGED`, `CONFIG_SETTINGS_UPDATED`, `CONFIG_WEBHOOK_ADDED`, `CONFIG_WEBHOOK_DELETED`, `CONFIG_BRANDING_UPDATED` |
| **SYSTEM** | `SYSTEM_BACKUP_COMPLETED`, `SYSTEM_BACKUP_FAILED`, `SYSTEM_DB_MIGRATION`, `SYSTEM_API_ERROR`, `SYSTEM_RATE_LIMIT_HIT`, `SYSTEM_CERT_RENEWED` |
| **SECURITY** | `SECURITY_SQL_INJECTION`, `SECURITY_XSS_DETECTED`, `SECURITY_DDOS_DETECTED`, `SECURITY_SUSPICIOUS_API`, `SECURITY_MFA_FAILED`, `SECURITY_UNAUTHORIZED_ACCESS`, `SECURITY_CERT_ERROR` |
| **INTEGRATION** | `INTEGRATION_BILLING_SYNC`, `INTEGRATION_DNS_UPDATE`, `INTEGRATION_API_CALL`, `INTEGRATION_WEBHOOK_DELIVERY` |

---

#### Retention Overview

**Admin Panel → Audit → Retention**

| Category | Retention | Hot (active DB) | Cold archive |
|----------|-----------|-----------------|--------------|
| Authentication | 1 year | 90 days | Remainder |
| Authorization | 1 year | 90 days | Remainder |
| Resource changes | **7 years** | 90 days | Remainder |
| Data access | 1 year | 90 days | Remainder |
| Security events | 2 years | 1 year | Second year |
| System events | 90 days | 90 days | None |
| API request logs | 90 days | 90 days | None (aggregate summaries kept) |

Storage gauge: `audit_logs` table size (GB), partition list with row counts per month, estimated months until next partition required.

Audit logs are **immutable** — `DELETE` and `UPDATE` are revoked at the database level for the application user. Archives are written to the offsite SSHFS backup server monthly.

---

#### RBAC for Audit Access

| Role | Scope | Export | Hidden fields |
|------|-------|--------|---------------|
| Platform Admin | All logs, all clients, all time | Yes (CSV / JSON) — no reason required | Nothing hidden |
| Region Admin | Region-scoped logs only | Yes — reason required | — |
| Support Staff | All logs globally (read-only) | No | — |
| Client Admin | Own client's logs only | Yes (CSV / JSON) — reason required | — |
| Client User | Own actions only | No | `ip_address` hidden |
| Viewer | Own client's logs (read-only) | No | — |

Exports are themselves logged as `DATA_EXPORT` events with the exporting user's identity and the filter criteria used.

---

**Actions that mandate an audit log entry** (from `AUTHORIZATION_MATRIX.md`):

| Action | Required event | Additional requirement |
|--------|---------------|----------------------|
| Client delete | `RESOURCE_CLIENT_DELETED` | `requires_audit: true` |
| Client suspend | `RESOURCE_CLIENT_SUSPENDED` | `requires_audit: true` |
| Backup restore | `RESOURCE_BACKUP_RESTORED` | `audit_required: true` |
| Billing manage | `CONFIG_PLAN_CHANGED` / payment events | `requires_mfa: true` also |
| Role assignment | `AUTHZ_ROLE_ASSIGNED` | Every change, no exceptions |
| Permission denial | `AUTHZ_PERMISSION_DENIED` + `security_events` insert | Automatic via middleware |

---

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/audit/logs` | Query audit logs (filter: `category`, `severity`, `event_type`, `actor_id`, `client_id`, `resource_type`, `status`, `from`, `to`) |
| `GET` | `/api/v1/admin/audit/logs/{event_id}` | Get full event detail including before/after JSON |
| `GET` | `/api/v1/admin/audit/security-events` | Query `security_events` table (filter: `severity`, `resolved`, `client_id`, `from`, `to`) |
| `PATCH` | `/api/v1/admin/audit/security-events/{id}` | Mark security event resolved; add remediation note |
| `GET` | `/api/v1/admin/audit/overview` | Real-time security dashboard metrics (login failures, permission denials, privilege escalations, etc.) |
| `POST` | `/api/v1/admin/audit/export` | Export filtered audit log as CSV or JSON — async, returns download URL; requires `reason` field; logs `DATA_EXPORT` |
| `GET` | `/api/v1/admin/audit/retention` | Retention summary: category retention periods, `audit_logs` table size, partition list |
| `GET` | `/api/v1/admin/audit/report/monthly` | Aggregated compliance report: event counts by category and severity for a given month (Phase 2) |
| `POST` | `/api/v1/admin/audit/gdpr/export/{user_id}` | Export all audit events where `actor_id = user_id` (all time) — logs `DATA_GDPR_EXPORT` (Phase 2) |

---

### AC.2 Data Privacy & GDPR

**Requirement:** Manage data privacy and GDPR compliance (Phase 2).

**Features:**

| Feature | Specification | Phase |
|---------|---------------|-------|
| **Data subject access request (DSAR)** | Export all platform data for a specific user (email, backups, audit events, billing history) | 2 |
| **Right to erasure** | Permanently delete all data for a client or user, with pre-deletion export option | 2 |
| **Consent management** | Track and display per-user consent records | 2 |
| **Data retention enforcement** | Automated cleanup of expired data per retention policy | 2 |
| **Breach notification log** | Record of any personal data breach notifications sent (GDPR Art. 33) | 2 |
| **Privacy audit trail** | All GDPR actions (DSARs, erasure, consent changes) logged to `audit_logs` as `DATA_GDPR_EXPORT` / `DATA_BULK_DELETE` | 2 |

---

## Advanced Search & Filtering

### AS.1 Client Search

**Requirement:** Find clients quickly across name, email, domain, company, and notes — with real-time results, saved filters, and export.

**Search Modes:**

| Mode | Description |
|------|-------------|
| **Quick search** | Single text input — searches `company_name`, `company_email`, `contact_email`, and primary domain simultaneously; results appear as you type (debounced 300ms) |
| **Advanced search** | Multi-field form — AND/OR logic across: company name, email, domain, contact email, contact phone, notes, namespace; results shown with active filter summary |
| **Preset filters** | One-click presets: `Active`, `Suspended`, `New This Month`, `At Risk` (expiring ≤ 30 days), `High Value` (Premium plan), `Overdue` (expired subscription) |
| **Saved filters** | Save any filter combination with a name; load, update, or delete saved filters; sharable across admin users |

**Filter options:**

| Filter | Options |
|--------|---------|
| **Plan** | All / Starter / Business / Premium |
| **Status** | All / Active / Suspended / Cancelled |
| **Subscription Status** | All / Active / Expiring Soon (≤ 30 days) / Expired |
| **Sort By** | Company Name / Created Date / Expiry Date / Storage Used |
| **Sort Direction** | Ascending / Descending |

**Result display:**

- Results shown as paginated table — 50 items per page.
- Each row: company name, plan badge, status badge, primary domain, subscription expiry, storage used, actions (View, Edit, Suspend).
- Result count shown: `Showing 1–50 of 342 clients`.
- Export filtered results: CSV or JSON (includes all visible columns).

**Quick stats bar** (above results when any filter is active):

| Stat | Description |
|------|-------------|
| Total matching | Count of clients matching current filter |
| Active | Active count within results |
| Expiring soon | Count expiring within 30 days within results |
| Suspended | Suspended count within results |

**Performance:**

- Search response < 500ms (at 1000+ clients).
- Pagination: 50 items per page.
- Full-text search backed by `FULLTEXT INDEX` on `(company_name, company_email, contact_email)` in the `clients` table — **note:** this index must be added to the schema DDL (not yet present).
- Filterable fields (`plan_id`, `status`, `subscription_expires_at`, `region_id`) covered by standard B-tree indexes.

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/clients` | Search and list clients. Query params: `search` (full-text), `plan` (plan slug), `status` (active/suspended/cancelled), `subscription_status` (active/expiring/expired), `sort` (company_name/created_at/subscription_expires_at/storage_used), `dir` (asc/desc), `page`, `limit` (default 50) |
| `GET` | `/api/v1/admin/clients/search/stats` | Quick stats for current filter (total, active, expiring_soon, suspended) — same filter params as above |
| `GET` | `/api/v1/admin/clients/search/export` | Export filtered client list as CSV or JSON (`format`: `csv`/`json`) — same filter params |
| `GET` | `/api/v1/admin/clients/saved-filters` | List saved search filters for the current admin user |
| `POST` | `/api/v1/admin/clients/saved-filters` | Save a new filter (`name`, filter param set) |
| `PUT` | `/api/v1/admin/clients/saved-filters/{id}` | Update a saved filter |
| `DELETE` | `/api/v1/admin/clients/saved-filters/{id}` | Delete a saved filter |

**Schema note — required migration:**

```sql
-- Add full-text index to clients table (not yet in schema DDL)
ALTER TABLE clients
  ADD FULLTEXT INDEX idx_clients_fulltext (company_name, company_email, contact_email);
```

---

## Branding & Customization

### BR.1 Platform Branding Options

**Requirement:** Customize basic platform branding for white-label or multi-tenant scenarios.

**Branding Elements (Phase 1.5):**

| Element | Customizable | Details |
|---------|---|---|
| **Logo** | Yes | Upload custom logo (PNG, SVG) for sidebar/header |
| **Favicon** | Yes | Upload custom favicon |
| **Color Scheme** | Yes | Primary, secondary, accent colors (hex codes) |
| **Company Name** | Yes | Display in header, emails, documentation |
| **Company URL** | Yes | Link in header/footer |
| **Email Sender Name** | Yes | Name for system emails |
| **Footer Text** | Yes | Custom copyright/legal text |
| **Help/Support Links** | Yes | Custom support portal URL, documentation links |
| **Theme Mode** | Yes | Light/Dark mode toggle option |

**Features:**

| Feature | Specification | Phase |
|---------|---|---|
| **Logo Upload** | Support PNG, SVG, JPEG (max 2MB) | 1.5 |
| **Color Customization** | Primary, secondary, accent + semantic colors | 1.5 |
| **Preview Changes** | Live preview before saving | 1.5 |
| **Reset to Default** | Reset all branding to platform defaults | 1.5 |
| **Apply Globally** | Changes apply to admin panel + client panel | 1.5 |
| **Email Templates** | Customize email templates with branding | 2 |
| **Custom CSS** | Advanced: Allow custom CSS overrides | 3 |
| **White-Label Mode** | Option to completely remove platform branding | 2 |

**API Endpoints:**
- `GET /admin/branding` - Get current branding settings
- `PUT /admin/branding` - Update branding
- `POST /admin/branding/logo` - Upload logo
- `DELETE /admin/branding/reset` - Reset to defaults

---

## Customizable Dashboards & Widgets

### DW.1 Dashboard Widget System

**Requirement:** Allow customizable dashboards with configurable widgets for different user roles and preferences.

**Dashboard Types:**

| Dashboard | Users | Customizable | Default Widgets |
|-----------|-------|---|---|
| **Admin Dashboard** | Super Admin | Yes | Clusters, Clients, Alerts, Revenue |
| **DevOps Dashboard** | DevOps Admin | Yes | Cluster Health, Storage, Nodes, Logs |
| **Support Dashboard** | Support Admin | Yes | Open Tickets, Client Issues, Activity |
| **Billing Dashboard** | Billing Admin | Yes | Revenue, Subscriptions, Invoices, Churn |

**Features (Phase 2):**

| Feature | Specification |
|---------|---|
| **Widget Library** | 30+ pre-built widgets available |
| **Drag & Drop** | Rearrange widgets on dashboard |
| **Add/Remove** | Add/remove widgets from library |
| **Widget Settings** | Configure each widget (time range, filters, size) |
| **Resize Widgets** | Change widget dimensions (small, medium, large) |
| **Save Layouts** | Save custom dashboard layouts |
| **Multiple Dashboards** | Create multiple dashboard configurations |
| **Share Dashboards** | Share dashboard config with other users |
| **Default Layout** | Admin sets default dashboard for each role |
| **Widget Refresh** | Auto-refresh interval per widget (5s - 60m) |

**Available Widgets (Examples):**

**Metrics Widgets:**
- System Health (% uptime, status)
- Client Count (active, suspended, expired)
- Storage Usage (used, capacity, trend)
- CPU/Memory/Network Usage
- Revenue (this month, trend, forecast)
- Subscription Stats (active, expiring, churn rate)

**Table Widgets:**
- Recent Clients (name, plan, status, expiry)
- Active Alerts (severity, source, time)
- Billing Summary (invoices, payments, outstanding)
- Node Status (health, resources, uptime)
- Recent Activity Log

**Chart Widgets:**
- Client Growth Chart (line graph, monthly)
- Storage Growth Chart (area chart, daily)
- Revenue Chart (bar graph, monthly)
- Uptime Chart (line graph, 30-day)
- CPU Usage Heatmap (cluster overview)
- Resource Utilization (pie, bar, line)

**Status Widgets:**
- Cluster Health Grid (showing all clusters)
- Alert Summary (counts by severity)
- Infrastructure Status (storage, backup, replication)

**API Endpoints:**
- `GET /admin/dashboard` - Get current dashboard config
- `PUT /admin/dashboard` - Update dashboard layout
- `GET /admin/dashboard/widgets` - List all available widgets
- `POST /admin/dashboard/widgets/:widgetId` - Add widget
- `DELETE /admin/dashboard/widgets/:widgetId` - Remove widget
- `POST /admin/dashboard/layouts` - Save layout
- `GET /admin/dashboard/layouts` - List saved layouts

---

## Authentication: Passwordless Login with OIDC

### AU.1 Multi-Provider OIDC Authentication

**Requirement:** Support passwordless login for Admin, Staff, and User accounts via OIDC providers (Google, Apple, GitHub, and configurable providers).

**Out-of-Box Providers (Phase 1.5):**

| Provider | Status | Details |
|----------|--------|---------|
| **Google** | ✅ Pre-configured | OIDC + OAuth2 |
| **Apple** | ✅ Pre-configured | Sign in with Apple |
| **GitHub** | ✅ Pre-configured | OAuth2 (developer focus) |
| **OIDC Provider (External)** | ✅ Configured | External OpenID Connect provider (see ADR-022) |

**Features:**

| Feature | Specification | Phase |
|---------|---|---|
| **Social Login Buttons** | Display on login page for each provider | 1.5 |
| **Account Linking** | Link multiple OIDC providers to one account | 1.5 |
| **First-Time Login** | Auto-create account on first successful login | 1.5 |
| **Email Verification** | Email from OIDC provider auto-verified | 1.5 |
| **Passwordless Enforcement** | Option to disable password login entirely | 1.5 |
| **Account Attributes** | Map OIDC claims to user attributes (name, email, role) | 1.5 |
| **Just-In-Time Provisioning** | Auto-create user on first OIDC login | 1.5 |

**Admin Customizable OIDC Providers (Phase 2):**

| Provider | Type | Configuration |
|----------|------|---|
| **Keycloak** | OIDC | URL, Client ID, Client Secret |
| **Auth0** | OIDC | Tenant, Client ID, Client Secret |
| **Okta** | OIDC | Domain, Client ID, Client Secret |
| **Azure AD** | OIDC | Tenant ID, Client ID, Client Secret |
| **Custom OIDC** | OIDC | Discovery URL, Client ID, Secret |

**OIDC Configuration (Admin Only - Phase 2):**

| Setting | Type | Purpose |
|---------|------|---------|
| **Provider Name** | Text | Display name for UI |
| **Discovery URL** | URL | OIDC Discovery endpoint |
| **Client ID** | Text | OAuth2 application ID |
| **Client Secret** | Secret | OAuth2 application secret (encrypted) |
| **Scopes** | List | OIDC scopes to request (openid, email, profile) |
| **Claim Mapping** | Map | Map OIDC claims to platform attributes |
| **Auto-Create Users** | Boolean | Auto-create users on first login |
| **Auto-Assign Role** | Select | Default role for new users (Admin, Staff, User) |
| **Email Domain Filter** | Text | Only allow emails from domain (optional) |
| **Enabled** | Boolean | Enable/disable provider |

**Account Types Supporting OIDC:**

| Account Type | OIDC Support | Login | Scope |
|---|---|---|---|
| **Admin** | ✅ Yes | Google, Apple, GitHub, Custom | Admin panel access |
| **Staff** | ✅ Yes | Google, Apple, GitHub, Custom | Limited admin panel |
| **User/Client** | ✅ Yes | Google, Apple, GitHub, Custom | Customer portal + email |

**Features:**

| Feature | Specification | Phase |
|---------|---|---|
| **Google Login** | Pre-configured, click setup | 1.5 |
| **Apple Login** | Pre-configured, click setup | 1.5 |
| **GitHub Login** | Pre-configured, click setup | 1.5 |
| **Add OIDC Provider** | Admin UI to add custom OIDC provider | 2 |
| **Provider Management** | List, edit, disable, delete OIDC providers | 2 |
| **Test Provider** | Test OIDC connection before enabling | 2 |
| **Account Linking** | Link OIDC providers to existing account | 2 |
| **Unlink Provider** | Unlink OIDC provider from account | 2 |
| **Provider Audit Log** | Log all OIDC logins per provider | 2 |
| **Require MFA** | Require MFA in addition to OIDC | 2 |

**Admin Settings for OIDC (Phase 2):**

**Settings Section:**
- `GET /admin/settings/oidc` - Get OIDC configuration
- `PUT /admin/settings/oidc/:providerId` - Update provider settings
- `POST /admin/settings/oidc` - Add new OIDC provider
- `DELETE /admin/settings/oidc/:providerId` - Remove provider
- `POST /admin/settings/oidc/:providerId/test` - Test provider connection

**User Account Settings (All Users):**
- `GET /user/accounts/oidc` - List linked OIDC providers
- `POST /user/accounts/oidc/:providerId/link` - Link provider
- `DELETE /user/accounts/oidc/:providerId/unlink` - Unlink provider

**Login Page Updates:**
```
┌─────────────────────────────────────────┐
│         Login to HostPlatform            │
├─────────────────────────────────────────┤
│                                         │
│  [Google Login Button]                  │
│  [Apple Login Button]                   │
│  [GitHub Login Button]                  │
│  [Custom Provider 1 Button] (if added)  │
│  [Custom Provider 2 Button] (if added)  │
│                                         │
│  Or use email/password login            │
│  ─────────────────────────────────────  │
│  Email: [____________]                  │
│  Password: [____________]                │
│  [Sign In]                              │
│                                         │
│  [Forgot Password?]                     │
└─────────────────────────────────────────┘
```

**Security Features:**

| Feature | Details |
|---------|---------|
| **PKCE Flow** | Use authorization code flow with PKCE |
| **State Validation** | Validate CSRF state parameter |
| **Nonce Validation** | Validate nonce in ID token |
| **Signature Verification** | Verify OIDC token signatures |
| **Token Caching** | Cache JWKs for performance |
| **Refresh Tokens** | Support refresh token flow for long sessions |
| **Token Rotation** | Rotate refresh tokens on use |
| **Client Secret Encryption** | Encrypt OIDC client secrets at rest |

**Audit & Logging:**

| Event | Logged | Details |
|-------|--------|---------|
| OIDC Provider Added | ✅ | Admin name, provider name, timestamp |
| OIDC Provider Updated | ✅ | Admin name, changes, timestamp |
| OIDC Provider Deleted | ✅ | Admin name, provider name, timestamp |
| OIDC Provider Test | ✅ | Result (success/failure), timestamp |
| User OIDC Login | ✅ | Username, provider, timestamp |
| Account Link Success | ✅ | Username, provider, timestamp |
| Account Unlink | ✅ | Username, provider, timestamp |
| OIDC Login Failure | ✅ | Reason, provider, timestamp |

---

## Mobile Optimization & Responsive Design

### MO.1 Mobile-First Design Approach

**Requirement:** Admin panel must be fully optimized for mobile and tablet devices, with a mobile-first design philosophy.

**Device Support (Phase 1):**

| Device | Breakpoint | Priority | Support |
|--------|-----------|----------|---------|
| **Smartphone** | < 480px | Critical | Full feature parity |
| **Large Phone** | 480-768px | Critical | Full feature parity |
| **Tablet (Portrait)** | 768-1024px | High | Full feature parity |
| **Tablet (Landscape)** | 1024-1366px | High | Full feature parity |
| **Desktop** | > 1366px | Medium | Full feature parity |

**Supported Devices:**
- ✅ iPhone (iOS 14+)
- ✅ Android phones (6.0+)
- ✅ iPad (iPad Air 2+)
- ✅ Android tablets
- ✅ Windows tablets
- ✅ Desktops/Laptops

**Performance Targets (Phase 1):**

| Metric | Target | Mobile | Tablet | Desktop |
|--------|--------|--------|--------|---------|
| **First Contentful Paint (FCP)** | < 2s | < 2.5s | < 2s | < 1.5s |
| **Largest Contentful Paint (LCP)** | < 2.5s | < 3s | < 2.5s | < 2s |
| **Cumulative Layout Shift (CLS)** | < 0.1 | < 0.1 | < 0.1 | < 0.1 |
| **Time to Interactive (TTI)** | < 3.5s | < 4s | < 3.5s | < 3s |
| **Page Load Size** | < 2MB | < 2MB | < 2.5MB | < 3MB |
| **Initial JS Bundle** | < 200KB | < 200KB | < 250KB | < 300KB |

### MO.2 Touch-Friendly Interface

**Requirement:** All interactive elements must be optimized for touch input with appropriate sizing and spacing.

**Touch Target Sizes (Phase 1):**

| Element | Minimum Size | Recommended | Spacing |
|---------|---|---|---|
| **Button** | 44x44 px | 48x48 px | 8px |
| **Link/Tap Area** | 44x44 px | 48x48 px | 8px |
| **Form Input** | 44px height | 48px height | 12px |
| **Checkbox/Radio** | 24x24 px | 44x44 px | 8px |
| **Icon Button** | 44x44 px | 48x48 px | 8px |
| **Menu Item** | 44px height | 48px height | 0px |
| **List Item** | 44px height | 56px height | 0px |

**Touch Interactions (Phase 1):**

| Interaction | Requirement | Implementation |
|-------------|---|---|
| **Tap** | Single tap activates button/link | 300ms response |
| **Swipe** | Left/right swipe to navigate | Smooth transitions |
| **Pinch-to-Zoom** | Zoom text/images on content pages | Allow 2-4x zoom |
| **Long Press** | Long press reveals context menu | 500ms hold |
| **Double Tap** | Double tap to zoom content area | Smooth zoom animation |
| **Scroll** | Smooth momentum scrolling | iOS/Android momentum |

**Haptic Feedback (Phase 2):**
- ✅ Tap feedback on button press
- ✅ Success feedback on form submission
- ✅ Error feedback on validation fail
- ✅ Warning feedback on dangerous actions

### MO.3 Mobile Navigation

**Requirement:** Navigation must be optimized for mobile with touch-friendly menus and reduced cognitive load.

**Mobile Navigation Patterns (Phase 1):**

| Pattern | Use Case | Implementation |
|---------|----------|---|
| **Bottom Tab Bar** | Primary navigation (5 max items) | Fixed at bottom |
| **Drawer/Sidebar** | Secondary navigation, settings | Swipe from left edge |
| **Hamburger Menu** | Toggle navigation on/off | Tap icon, overlay drawer |
| **Breadcrumb** | Show location in hierarchy | Single-line, scrollable |
| **Back Button** | Return to previous screen | Top-left, 44x44 px |

**Navigation Hierarchy (Phase 1):**

**Bottom Tab Bar (Mobile):**
- 📊 Dashboard (icon + label)
- 👥 Clients (icon + label)
- 🏢 Clusters (icon + label)
- 📈 Monitoring (icon + label)
- ⋮ More (icon only) → Drawer with additional items

**Drawer Menu (Mobile - shown on tap "More"):**
- 📦 Workloads
- 🚀 Applications
- 💾 Storage & DB
- 🔐 Security
- ⚙️ Settings
- 👤 Profile/Account
- 🚪 Logout

**Desktop Sidebar:**
- All items visible (no truncation)
- Collapsible to icons (Phase 2)

**Features (Phase 1):**
- ✅ Bottom tab navigation on mobile
- ✅ Active tab highlighting
- ✅ Badge indicators (notification count)
- ✅ Swipe gesture to switch tabs
- ✅ Drawer menu for additional items
- ✅ Sticky header with back button
- ✅ Sticky footer with bottom tabs

### MO.4 Mobile-Optimized Tables & Lists

**Requirement:** Tables and lists must be readable and usable on small screens with appropriate layouts and scrolling.

**Table Display Modes (Phase 1):**

| Screen Size | Layout | Behavior |
|-------------|--------|----------|
| **< 480px** | Card View | Vertical cards, no scrolling |
| **480-768px** | Compact Table | Horizontal scroll, essential columns |
| **> 768px** | Full Table | All columns visible |

**Card View Layout (< 480px):**
```
┌─────────────────────────┐
│ Client Name             │
│ ─────────────────────── │
│ Status: Active          │
│ Plan: Premium           │
│ Expires: Dec 15, 2024   │
│ Storage: 180GB/500GB    │
│ ─────────────────────── │
│ [View] [Edit] [More]    │
└─────────────────────────┘
```

**Compact Table (480-768px):**
```
┌──────────────────────────────────┐
│ Name      │ Plan  │ Status │ ...  │
├──────────────────────────────────┤
│ Tech Inc  │ Prem. │ Active │ >    │
│ Design Co │ Bus.  │ Active │ >    │
└──────────────────────────────────┘
(Horizontal scroll for more columns)
```

**Features (Phase 1):**
- ✅ Auto-switching between card/table views
- ✅ Essential columns only on mobile
- ✅ Swipe right on card to reveal more actions
- ✅ Tap row to see full details
- ✅ Horizontal scroll for additional columns
- ✅ Sticky first column (name/ID)
- ✅ Collapse/expand details inline

### MO.5 Mobile Forms & Input

**Requirement:** Forms must be easy to fill on mobile with appropriate input types and keyboard handling.

**Form Optimization (Phase 1):**

| Feature | Mobile | Desktop |
|---------|--------|---------|
| **Input Fields** | Full width | 2-3 columns |
| **Labels** | Above input | Above/beside input |
| **Help Text** | Below input | Tooltip on hover |
| **Errors** | Inline, red text | Inline or tooltip |
| **Submit Button** | Full width, 48px | Normal sizing |
| **Keyboard Type** | Appropriate (email, number, etc.) | N/A |
| **Auto-focus** | First input only | N/A |
| **Auto-capitalize** | Disabled for code | N/A |

**Input Types (Phase 1):**
- ✅ `type="email"` → Shows @ on keyboard
- ✅ `type="number"` → Shows numeric keyboard
- ✅ `type="tel"` → Shows phone keyboard
- ✅ `type="url"` → Shows URL keyboard
- ✅ `type="password"` → Shows password keyboard
- ✅ `type="search"` → Shows search keyboard with clear button
- ✅ Date picker (native on mobile)
- ✅ Time picker (native on mobile)

**Features (Phase 1):**
- ✅ Single column forms on mobile
- ✅ Full-width inputs (100% - 24px padding)
- ✅ 48px+ tall input fields
- ✅ Visible labels above inputs
- ✅ Clear error messages
- ✅ One-tap form submission (full-width button)
- ✅ Autofill support (name, email, password)
- ✅ No zoom on input focus (prevent pinch-zoom)

### MO.6 Mobile-Optimized Modals & Dialogs

**Requirement:** Modals and dialogs must work well on mobile screens with touch-friendly controls.

**Modal Behavior (Phase 1):**

| Aspect | Mobile | Desktop |
|--------|--------|---------|
| **Width** | 100% - 16px padding | 500px centered |
| **Height** | Fit content, max 80vh | Fit content, max 90vh |
| **Position** | Bottom sheet (slide up) | Centered overlay |
| **Close Button** | X button, 48x48 px | X button, 32x32 px |
| **Outside Tap** | Can close (if safe) | Can close |
| **Scrolling** | Content scrolls inside modal | Modal scrolls |
| **Swipe Down** | Close modal (iOS style) | N/A |

**Features (Phase 1):**
- ✅ Bottom sheet modals on mobile
- ✅ Full-width buttons in modals
- ✅ Swipe-down to close gesture
- ✅ Large touch-friendly controls
- ✅ No fixed height (fit content)
- ✅ Keyboard-aware (shift up when keyboard shown)

### MO.7 Mobile Notifications & Alerts

**Requirement:** Notifications and alerts must be visible and accessible on mobile without blocking interaction.

**Notification Display (Phase 1):**

| Type | Mobile Position | Desktop Position | Duration |
|------|---|---|---|
| **Success** | Top-right, inline | Top-right | 4s |
| **Error** | Top-right, overlay | Top-right | Persistent |
| **Warning** | Top-right, inline | Top-right | 6s |
| **Info** | Top-right, inline | Top-right | 4s |

**Features (Phase 1):**
- ✅ Toast notifications (small, non-blocking)
- ✅ Auto-dismiss (success/info after 4-6s)
- ✅ Persistent errors (require dismiss)
- ✅ Swipe-to-dismiss on mobile
- ✅ Clear action button in notification
- ✅ Notification stacking (max 3)
- ✅ Sound/haptic feedback (optional)

### MO.8 Mobile Performance Optimization

**Requirement:** Admin panel must load and perform quickly on mobile devices with varying network speeds.

**Optimization Strategies (Phase 1):**

| Strategy | Implementation | Impact |
|----------|---|---|
| **Code Splitting** | Page-based lazy loading | -40% initial JS |
| **Image Optimization** | WebP, srcset, lazy loading | -60% image size |
| **CSS Minification** | Remove unused CSS | -50% CSS size |
| **JS Minification** | Uglify, tree-shake | -40% JS size |
| **Compression** | Gzip/Brotli (>2KB) | -70% transfer size |
| **Caching** | Service Worker, HTTP caching | Offline-capable |
| **API Optimization** | Pagination, field selection | -80% payload |
| **Font Optimization** | System fonts, minimal web fonts | -100KB |

**Network Optimization (Phase 1):**

| Network | Target FCP | Strategy |
|---------|---|---|
| **5G** | < 1.5s | Full experience |
| **4G** | < 2.5s | Code split |
| **3G** | < 4s | Defer non-essential |
| **2G (Slow)** | < 6s | Text-only fallback |

**Features (Phase 1):**
- ✅ Service Worker for offline support
- ✅ Cache static assets (365 days)
- ✅ Cache API responses (5 min - 1 hour)
- ✅ Lazy-load images and components
- ✅ Network status detection
- ✅ Graceful degradation on slow networks
- ✅ Offline mode with cached data
- ✅ Retry failed requests with exponential backoff

### MO.9 Mobile Accessibility

**Requirement:** Admin panel must be accessible to all users on mobile devices, including those with disabilities.

**Accessibility Features (Phase 1):**

| Feature | Mobile | Details |
|---------|--------|---------|
| **Screen Reader** | ✅ Yes | Full VoiceOver/TalkBack support |
| **Keyboard Navigation** | ✅ Yes | Tab through all interactive elements |
| **High Contrast** | ✅ Yes | WCAG AA compliant on mobile |
| **Text Sizing** | ✅ Yes | Support 200% zoom without loss |
| **Color Not Sole Indicator** | ✅ Yes | Use text + icons + color |
| **Focus Indicators** | ✅ Yes | Visible 2px outline |
| **Touch Target Size** | ✅ Yes | Min 44x44 px all buttons |
| **Alt Text** | ✅ Yes | Descriptive alt text for images |
| **Form Labels** | ✅ Yes | Associated <label> for all inputs |
| **ARIA Labels** | ✅ Yes | aria-label for icon buttons |

**Standards Compliance:**
- ✅ WCAG 2.1 Level AA
- ✅ Section 508 (US)
- ✅ EN 301 549 (EU)
- ✅ Apple Accessibility Guidelines
- ✅ Android Accessibility Guidelines

### MO.10 Mobile Testing & QA

**Requirement:** Admin panel must be tested thoroughly on real mobile devices to ensure quality.

**Testing Devices (Phase 1):**

| Device | iOS Version | Android Version |
|--------|---|---|
| iPhone SE | 15+ | N/A |
| iPhone 13 | 15+ | N/A |
| iPhone 14+ | 16+ | N/A |
| iPad Air | 15+ | N/A |
| Samsung S21 | N/A | 11+ |
| Google Pixel | N/A | 12+ |
| Generic Android | N/A | 8+ |

**Testing Scenarios (Phase 1):**

| Scenario | Test | Pass Criteria |
|----------|------|---|
| **Touch Interaction** | Tap buttons, swipe, long press | Smooth, responsive |
| **Orientation Change** | Rotate device, check layout | No content loss, smooth transition |
| **Keyboard** | Type in forms, autocomplete | Works without zoom |
| **Network** | Test on 4G/5G/WiFi | Loads in target time |
| **Low Battery Mode** | Enable low power mode | Functions normally |
| **Dark Mode** | Enable dark mode system-wide | Colors readable |
| **Accessibility** | Use screen reader, zoom | All content accessible |
| **Performance** | Check metrics, monitor memory | Meets performance targets |

**Testing Tools (Phase 2):**
- ✅ BrowserStack (real devices)
- ✅ Mobile Safari DevTools
- ✅ Chrome DevTools (device emulation)
- ✅ Lighthouse (performance audit)
- ✅ Axe DevTools (accessibility)
- ✅ TestFlight (iOS beta)
- ✅ Google Play Testing (Android)

### MO.11 Mobile-Specific Features (Phase 2)

**Optional mobile-only features:**

| Feature | Phase | Benefit |
|---------|-------|---------|
| **App Install Prompt** | 2 | Add to home screen (PWA) |
| **Push Notifications** | 2 | Real-time alerts on mobile |
| **Biometric Auth** | 2 | Face ID, Touch ID login |
| **Camera Integration** | 3 | QR code scanning, photo upload |
| **Offline Sync** | 2 | Sync data when connection restored |
| **Shortcuts** | 3 | Quick actions from home screen |
| **Voice Commands** | 3 | Voice-activated actions |

**PWA Features (Phase 2):**
- ✅ Installable as app
- ✅ App icon on home screen
- ✅ Full screen experience (no browser chrome)
- ✅ Standalone mode
- ✅ Splash screen
- ✅ Push notifications
- ✅ Offline capability
- ✅ Camera/microphone access (with permission)

---

## Summary: All Admin Panel Requirements

**Total Features by Phase:**

| Phase | Count | Focus |
|-------|-------|-------|
| **Phase 1 MVP** | 60+ features | Core ops, mobile optimization, touch UI, light/dark theme |
| **Phase 1.5** | 40+ features | Bulk ops, branding, passwordless OIDC, performance, mobile polish |
| **Phase 2** | 50+ features | Customizable dashboards/widgets, custom OIDC, PWA, print stylesheet |
| **Phase 3+** | 20+ features | Advanced (custom integrations, premium features, white-label) |

**New Features Added (Phase 1, 1.5 & 2):**

| Category | Features | Phase |
|----------|----------|-------|
| **Mobile Optimization** | Touch-friendly UI, responsive layouts, performance | 1 |
| **Mobile Navigation** | Bottom tabs, drawer menu, back button | 1 |
| **Light & Dark Mode** | Automatic system detection, switchable, persistent | 1 |
| **Theme Colors** | Light palette (16 colors), dark palette (16 colors) | 1 |
| **Branding** | Logo upload, colors, company info, theme mode | 1.5 |
| **Passwordless Auth** | Google, Apple, GitHub, custom OIDC providers | 1.5 |
| **Mobile Performance** | Code splitting, image optimization, caching, offline | 1 |
| **Customizable Dashboards** | Widgets, drag-drop, layouts, sharing | 2 |
| **OIDC Provider Mgmt** | Add/edit/delete custom OIDC, account linking | 2 |
| **PWA Features** | Install prompt, push notifications, offline sync | 2 |
| **Theme Persistence** | localStorage storage, sync across devices (P2) | 1 |
| **Multi-Account Support** | Admin, Staff, User all support OIDC | 1.5 |

**Total:** 175+ admin panel features (increased from 100+)

---

## Theme Customization - Light & Dark Mode

### TH.1 Automatic Theme Detection

**Requirement:** Admin panel must automatically detect system theme preference and apply accordingly, with user override capability.

**Features (Phase 1):**

| Feature | Requirement | Implementation |
|---------|---|---|
| **System Preference Detection** | Auto-detect OS theme | CSS media query `prefers-color-scheme` |
| **Default Behavior** | Use system setting on first visit | Read `prefers-color-scheme` |
| **User Override** | Allow user to switch themes | Toggle in settings/header |
| **Persistent Preference** | Remember user choice | Store in localStorage |
| **No Flash** | Prevent theme flash on load | Check localStorage before render |

**Browser Support:**
- ✅ iOS 13+ (Settings → Display & Brightness)
- ✅ macOS 10.14+ (System Preferences → General)
- ✅ Android 10+ (Settings → Display → Dark theme)
- ✅ Windows 10+ (Settings → Personalization → Colors)
- ✅ Linux (DE-dependent: GNOME, KDE, etc.)

**Implementation:**
```css
/* Detect system preference */
@media (prefers-color-scheme: dark) {
  /* Dark mode styles */
}

@media (prefers-color-scheme: light) {
  /* Light mode styles */
}
```

**localStorage Key:**
```
theme: 'light' | 'dark' | 'system' (default: 'system')
```

### TH.2 Light Mode Color Palette

**Requirement:** Complete light mode color scheme with accessible contrast ratios.

**Core Colors:**

| Element | Light Mode | Hex | WCAG AAA |
|---------|-----------|-----|----------|
| **Primary Background** | White | #ffffff | - |
| **Secondary Background** | Light Gray | #f5f7fa | - |
| **Tertiary Background** | Very Light Gray | #f9fafb | - |
| **Primary Text** | Dark Gray | #1f2937 | ✅ |
| **Secondary Text** | Medium Gray | #6b7280 | ✅ |
| **Tertiary Text** | Light Gray | #9ca3af | ✅ |
| **Primary Action** | Blue (gradient) | #0066cc | ✅ |
| **Primary Action Alt** | Dark Green | #00663d | ✅ |
| **Success** | Green | #10b981 | ✅ |
| **Warning** | Orange | #f59e0b | ✅ |
| **Error** | Red | #ef4444 | ✅ |
| **Info** | Blue | #3b82f6 | ✅ |
| **Border** | Light Gray | #e5e7eb | ✅ |
| **Hover Background** | Very Light Gray | #f3f4f6 | ✅ |
| **Disabled Text** | Light Gray | #d1d5db | ✅ |
| **Disabled Background** | Very Light Gray | #f9fafb | ✅ |

**Component Colors (Light):**

| Component | Background | Border | Text |
|-----------|-----------|--------|------|
| **Card** | #ffffff | #e5e7eb | #1f2937 |
| **Input** | #ffffff | #d1d5db | #1f2937 |
| **Button Primary** | #0066cc → #00663d | None | #ffffff |
| **Button Secondary** | #f3f4f6 | #e5e7eb | #1f2937 |
| **Alert Success** | #ecfdf5 | #d1fae5 | #065f46 |
| **Alert Error** | #fef2f2 | #fecaca | #991b1b |
| **Alert Warning** | #fffbeb | #fcd34d | #92400e |
| **Alert Info** | #eff6ff | #bfdbfe | #1e40af |
| **Sidebar** | #f9fafb | #e5e7eb | #1f2937 |
| **Header** | #ffffff | #e5e7eb | #1f2937 |
| **Table Header** | #f9fafb | #e5e7eb | #374151 |
| **Table Row Hover** | #f9fafb | #e5e7eb | #1f2937 |

### TH.3 Dark Mode Color Palette

**Requirement:** Complete dark mode color scheme with accessible contrast ratios and reduced eye strain.

**Core Colors:**

| Element | Dark Mode | Hex | WCAG AAA |
|---------|----------|-----|----------|
| **Primary Background** | Very Dark Gray | #111827 | - |
| **Secondary Background** | Dark Gray | #1f2937 | - |
| **Tertiary Background** | Medium Dark | #374151 | - |
| **Primary Text** | Light Gray | #f3f4f6 | ✅ |
| **Secondary Text** | Medium Light | #d1d5db | ✅ |
| **Tertiary Text** | Medium Gray | #9ca3af | ✅ |
| **Primary Action** | Blue (gradient) | #3b82f6 | ✅ |
| **Primary Action Alt** | Light Green | #10b981 | ✅ |
| **Success** | Green | #10b981 | ✅ |
| **Warning** | Orange | #f59e0b | ✅ |
| **Error** | Red | #ef4444 | ✅ |
| **Info** | Blue | #60a5fa | ✅ |
| **Border** | Dark Gray | #374151 | ✅ |
| **Hover Background** | Lighter Gray | #4b5563 | ✅ |
| **Disabled Text** | Dark Gray | #6b7280 | ✅ |
| **Disabled Background** | Very Dark | #1f2937 | ✅ |

**Component Colors (Dark):**

| Component | Background | Border | Text |
|-----------|-----------|--------|------|
| **Card** | #1f2937 | #374151 | #f3f4f6 |
| **Input** | #111827 | #4b5563 | #f3f4f6 |
| **Button Primary** | #3b82f6 → #10b981 | None | #111827 |
| **Button Secondary** | #374151 | #4b5563 | #f3f4f6 |
| **Alert Success** | #064e3b | #10b981 | #d1fae5 |
| **Alert Error** | #7f1d1d | #fca5a5 | #fee2e2 |
| **Alert Warning** | #78350f | #fcd34d | #fef3c7 |
| **Alert Info** | #1e3a8a | #93c5fd | #dbeafe |
| **Sidebar** | #111827 | #374151 | #f3f4f6 |
| **Header** | #1f2937 | #374151 | #f3f4f6 |
| **Table Header** | #111827 | #374151 | #d1d5db |
| **Table Row Hover** | #374151 | #4b5563 | #f3f4f6 |

**Reduced Eye Strain (Dark Mode):**
- ✅ No pure black (#000000) - use #111827
- ✅ No pure white (#ffffff) - use #f3f4f6
- ✅ Reduced blue light (use warmer tones at night)
- ✅ Dimmed accent colors
- ✅ Increased contrast for readability

### TH.4 Theme Toggle Control

**Requirement:** User-friendly theme toggle with clear indication of current mode.

**Toggle Location (Phase 1):**

**Mobile (Bottom Right Corner):**
```
┌─────────────────────────────┐
│ [Content Area]              │
│                             │
│                      [🌙 ☀️]│ ← Floating toggle
└─────────────────────────────┘
```

**Desktop (Settings Menu):**
```
Header Right: [🔍] [🔔] [⚙️] [👤]
                          ↓
                    Settings Menu:
                    ├── Appearance
                    │   ├── ☀️ Light Mode
                    │   ├── 🌙 Dark Mode
                    │   └── ⚙️ System (Default)
                    ├── Language
                    ├── Notifications
                    └── Logout
```

**Features (Phase 1):**

| Feature | Requirement | Implementation |
|---------|---|---|
| **Toggle Button** | Clickable theme switch | Icon: ☀️ (light) / 🌙 (dark) |
| **Current State** | Show active mode | Button highlight/styling |
| **System Option** | Auto-detect system theme | "Auto" or "System" option |
| **Smooth Transition** | No flash when switching | CSS transition 0.3s |
| **Icon Change** | Show appropriate icon | Light mode shows ☀️, Dark shows 🌙 |
| **Tooltip** | Show on hover | "Switch to Dark/Light Mode" |
| **Keyboard Shortcut** | Quick toggle via keyboard | Ctrl+Shift+D (or Cmd+Shift+D on Mac) |
| **Accessibility** | ARIA label | aria-label="Toggle dark mode" |

**Toggle Behavior:**
```
System Light Mode (Default)
         ↓
User clicks toggle → Dark Mode
         ↓
User clicks toggle → Light Mode
         ↓
User clicks toggle → System (Auto)
         ↓
[Cycle repeats]
```

### TH.5 Theme Application & Consistency

**Requirement:** Theme must be consistently applied across all pages and components.

**Pages Affected (All):**
- ✅ Login page
- ✅ Dashboard
- ✅ Clients page
- ✅ Client details
- ✅ Clusters page
- ✅ Cluster details
- ✅ Workloads page
- ✅ Applications page
- ✅ Storage & database
- ✅ Monitoring & alerts
- ✅ Settings page
- ✅ Profile/Account page

**Components Affected (All):**
- ✅ Sidebar
- ✅ Header
- ✅ Cards
- ✅ Tables
- ✅ Buttons
- ✅ Forms & inputs
- ✅ Modals & dialogs
- ✅ Notifications/alerts
- ✅ Badges
- ✅ Charts & graphs
- ✅ Dropdowns & menus
- ✅ Pagination
- ✅ Loading spinners
- ✅ Empty states
- ✅ Error pages

**Charts & Graphs (Phase 2):**
| Chart Type | Light Mode | Dark Mode |
|-----------|-----------|-----------|
| **Line Chart** | Dark lines on light | Light lines on dark |
| **Bar Chart** | Blue bars on light | Blue/light bars on dark |
| **Pie Chart** | Multiple colors | Adjusted saturation |
| **Heatmap** | Light to dark red | Dark to bright red |
| **Legend** | Dark text, light bg | Light text, dark bg |
| **Tooltip** | Light bg, dark text | Dark bg, light text |

**Custom Branding (Phase 1.5):**
- ✅ Custom primary color works in both themes
- ✅ Logo brightness adjusted for theme
- ✅ Custom colors generated for dark mode
- ✅ High contrast maintained in both modes

### TH.6 Theme Storage & Persistence

**Requirement:** User theme preference must be saved and restored across sessions.

**Storage Strategy (Phase 1):**

**localStorage:**
```javascript
// Save user preference
localStorage.setItem('theme-preference', 'dark');

// Read on page load
const theme = localStorage.getItem('theme-preference') || 'system';

// Valid values:
// 'light'  - Force light mode
// 'dark'   - Force dark mode
// 'system' - Follow system preference (default)
```

**Cookie (Optional - Phase 2):**
```
theme-preference=dark; Max-Age=31536000; Path=/
```

**Implementation Order:**
1. Check localStorage (user preference)
2. If not set, check system preference (`prefers-color-scheme`)
3. Default to 'light' if no system preference available
4. Save any manual changes to localStorage

**Sync Across Devices (Phase 2):**
- ✅ Store theme preference in user settings API
- ✅ Sync when user logs in on new device
- ✅ Override localStorage with server preference

### TH.7 Transition & Animation

**Requirement:** Smooth theme transitions without jarring color changes.

**Transition Implementation (Phase 1):**

```css
/* Smooth color transitions */
* {
  transition: background-color 0.3s ease,
              color 0.3s ease,
              border-color 0.3s ease;
}

/* Exclude animations from transition */
*, *::before, *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
}
```

**Features (Phase 1):**
- ✅ CSS transition on all color properties (300ms)
- ✅ No animation interference
- ✅ Smooth fade between themes
- ✅ No flickering or flash
- ✅ Fast enough to feel instant

**Disable Transitions (Accessibility - Phase 2):**
```javascript
// Respect user's motion preference
if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  // Use instant switches, no transition
  document.documentElement.style.transition = 'none';
}
```

### TH.8 Images & Icons in Dark Mode

**Requirement:** Images and icons must be optimized for both light and dark modes.

**Icon Strategy (Phase 1):**

| Icon Type | Light Mode | Dark Mode | Implementation |
|-----------|-----------|-----------|---|
| **UI Icons** | Dark gray | Light gray | CSS filter or SVG |
| **SVG Icons** | Scalable | Scalable | Inline SVG with CSS |
| **Logos** | Normal | Inverted/lighter | CSS filter or dual file |
| **Charts** | Dark lines | Light lines | Inline SVG with data attrs |
| **Avatars** | Normal | Normal | No change needed |

**Image Strategy (Phase 1):**

| Image Type | Light Mode | Dark Mode | Implementation |
|-----------|-----------|-----------|---|
| **Screenshots** | Normal | Inverted background | Dual images or CSS filter |
| **Diagrams** | Normal | Inverted | CSS filter or dual images |
| **Charts** | Dark lines | Light lines | Dynamic generation |
| **Banners** | Normal | Darker overlay | CSS filter |

**CSS Filter Approach (Phase 1):**
```css
/* Simple invert for dark mode */
@media (prefers-color-scheme: dark) {
  img {
    filter: brightness(0.9) contrast(1.1);
  }
}

/* Optional: Use picture element for fine control */
<picture>
  <source srcset="light-image.png" media="(prefers-color-scheme: light)">
  <source srcset="dark-image.png" media="(prefers-color-scheme: dark)">
  <img src="light-image.png" alt="Description">
</picture>
```

### TH.9 Print Stylesheet

**Requirement:** Print output should always use light mode for clarity on paper.

**Features (Phase 2):**

```css
@media print {
  /* Force light mode for printing */
  :root {
    --bg-color: #ffffff;
    --text-color: #1f2937;
    --border-color: #e5e7eb;
  }
  
  /* Hide theme toggle in print */
  .theme-toggle {
    display: none;
  }
  
  /* Optimize for printing */
  body {
    background: white;
    color: black;
    font-size: 12pt;
  }
}
```

### TH.10 Testing & Quality Assurance

**Requirement:** Both themes must be thoroughly tested for quality and consistency.

**Testing Checklist (Phase 1):**

| Test | Light Mode | Dark Mode | Notes |
|------|-----------|-----------|-------|
| **Colors** | WCAG AAA | WCAG AAA | 4.5:1 contrast minimum |
| **Readability** | ✅ | ✅ | Test text at various sizes |
| **Contrast** | ✅ | ✅ | No text < 4.5:1 ratio |
| **Links** | ✅ | ✅ | Must be distinguishable |
| **Buttons** | ✅ | ✅ | Hover/active states clear |
| **Forms** | ✅ | ✅ | Inputs clearly visible |
| **Tables** | ✅ | ✅ | Rows alternating (if used) |
| **Charts** | ✅ | ✅ | Lines/bars clearly visible |
| **Icons** | ✅ | ✅ | No color-only indicators |
| **Toggle** | ✅ | ✅ | Works consistently |
| **Persistence** | ✅ | ✅ | Remembers preference |
| **Transition** | ✅ | ✅ | No flash or flicker |
| **System Sync** | ✅ | ✅ | Follows OS setting |
| **Mobile** | ✅ | ✅ | All devices/sizes |
| **Print** | Light only | Light only | Prints correctly |
| **Screen Reader** | ✅ | ✅ | Color not sole indicator |

**Accessibility Testing (Phase 1):**
- ✅ Color contrast (4.5:1 text, 3:1 graphics)
- ✅ No color-only differentiation
- ✅ VoiceOver/TalkBack narration clear
- ✅ Keyboard navigation works
- ✅ Focus indicators visible

**Real Device Testing (Phase 1):**
- ✅ iPhone (iOS light/dark)
- ✅ Android (light/dark preference)
- ✅ macOS (light/dark)
- ✅ Windows (light/dark)
- ✅ Linux (system preference)

**Browser Testing (Phase 1):**
- ✅ Chrome/Chromium
- ✅ Firefox
- ✅ Safari
- ✅ Edge
- ✅ Mobile browsers

---

**Ready to build!** All requirements extracted from INFRASTRUCTURE_PLAN.md and specified in detail.

New additions:
- ✅ Light & dark mode with automatic system detection (Phase 1)
- ✅ Switchable themes with persistent storage (Phase 1)
- ✅ Full light mode color palette (16 colors, WCAG AAA) (Phase 1)
- ✅ Full dark mode color palette (16 colors, WCAG AAA) (Phase 1)
- ✅ Theme toggle control with keyboard shortcut (Phase 1)
- ✅ Customizable platform branding (Phase 1.5)
- ✅ Passwordless login with Google, Apple, GitHub (Phase 1.5)
- ✅ Configurable OIDC providers (Phase 2)
- ✅ Account linking for multiple OIDC providers (Phase 2)
- ✅ Customizable dashboards with widgets (Phase 2)
- ✅ Full OIDC provider management UI (Phase 2)
- ✅ Print stylesheet (always light mode) (Phase 2)

