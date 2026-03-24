# Server Infrastructure Plan — Kubernetes Web Hosting Platform

> **Status:** Partially superseded — see note below
> **Last Updated:** 2026-03-01 (Added Section 5.6.11: Customer Co-hosting)
> **Platform:** Self-managed Kubernetes on bare metal / VPS
> **Orchestration:** Kubernetes + Docker
> **Migration From:** Plesk-based manually configured servers
> **Current Scale:** 50-200 client sites/domains
>
> **IMPORTANT (ADR-022):** This master reference predates the architectural separation.
> Sections covering **PowerDNS deployment**, **NetBird deployment**, and **Dex/OIDC deployment**
> describe infrastructure now managed by a **separate infrastructure project**. This hosting
> platform consumes those services via external APIs. For current architecture, see the
> subdirectory docs (especially `01-core/PLATFORM_ARCHITECTURE.md` and
> `04-deployment/FRESH_INFRASTRUCTURE_PLAN.md`).

---

## Table of Contents

0. [Architectural Decisions](#0-architectural-decisions)
1. [Overview & Goals](#1-overview--goals)
2. [Workload Container Catalog](#2-workload-container-catalog)
3. [Application Catalog](#3-application-catalog)
4. [Architecture Diagram Notes](#4-architecture-diagram-notes)
5. [Compute, Networking & Cost Optimization](#5-compute-networking--cost-optimization)
   - [5.6 Geographic Sharding with Centralized Management](#56-geographic-sharding-with-centralized-management)
   - [5.6.11 Customer Co-hosting: Optional Active-Passive Hot Standby](#5611-customer-co-hosting-optional-active-passive-hot-standby)
6. [Storage & Databases](#6-storage--databases)
7. [Security & Access Control](#7-security--access-control)
8. [CI/CD & Deployment](#8-cicd--deployment)
9. [Management Panels](#9-management-panels)
10. [Monitoring & Logging](#10-monitoring--logging)
11. [Email & Webmail](#11-email--webmail)
12. [Disaster Recovery & HA](#12-disaster-recovery--ha)
13. [Migration Plan](#13-migration-plan)
14. [Infrastructure Provider & Cost Analysis](#14-infrastructure-provider--cost-analysis)

---

## 0. Architectural Decisions

> **Status:** Finalized on 2026-02-27
> **Decision Authority:** Platform Team
> 
> This section documents all technology choices made during the planning phase.
> These decisions were made to balance resource efficiency, ease of deployment,
> and operational simplicity for a small team new to Kubernetes.

### 0.1 Kubernetes & Infrastructure

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **K8s Distribution**        | **k3s (lightweight)**                     | 50% less control plane memory, built-in tools, perfect for VPS/bare metal, ideal for learning |
| **Base OS**                 | **Debian 13** (bleeding-edge stable)      | Lightweight, excellent for production containers, latest packages |
| **Container Runtime**       | **containerd** (k3s default)               | Modern, lightweight, standard for production |
| **Initial Control Plane**   | **1 node** (single CP)                    | Minimal cost, sufficient for start; HA upgrade path available |
| **Initial Worker Nodes**    | **1-2 nodes** (general-purpose, 4vCPU/8Gi+) | Can host 50-100 Starter clients + platform services; scale by adding nodes |

### 0.2 Networking & Ingress

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **CNI Plugin**              | **Flannel** (k3s default) → Calico later  | Simple overlay, low overhead; upgrade to Calico for network policies at scale |
| **Ingress Controller**      | **NGINX Ingress Controller** (k3s default Traefik disabled) | Mature, battle-tested, native ModSecurity WAF support, large community. See ADR-010. |
| **Traffic Routing**         | **DNS-based ingress routing** (NGINX DaemonSet + PowerDNS multi-A records) | No hoster lock-in, no Floating IP needed, automatic failover via DNS. See ADR-014. |
| **External DNS**            | **PowerDNS Authoritative** (`powerdns/pdns-auth-49` Docker image) — 2 regionally diversified VPS (ns1: Falkenstein, ns2: Helsinki). Deployed via Docker Compose at `/opt/powerdns/`. Primary/secondary AXFR/NOTIFY replication (< 5s). API-driven zone management via NetBird mesh. No RNDC — native 4.9 replication only. See ADR-016. | Fully self-hosted, static IPs for glue records, geographic redundancy. Co-hosted with NetBird VPN. Docker avoids Debian 13 apt repo compatibility issues. |

### 0.3 Security & Authentication

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **OIDC Provider**           | **Dex** (lightweight IdP federation)      | Low resource overhead, easy to deploy, focuses on OIDC, perfect for learning K8s |
| **Secrets Backend**         | **Sealed Secrets** (not Vault)            | GitOps-friendly, simple, lower overhead, sufficient for self-managed K8s |
| **WAF Engine**              | **ModSecurity** (with NGINX Ingress)      | Industry standard, proven with OWASP CRS v4, integrates directly with NGINX |
| **Intrusion Detection**     | **fail2ban** (via DaemonSet + shared Redis ban list) | Lightweight, traditional approach, proven for SSH/SFTP/HTTP protection |
| **Admin Access VPN**        | **NetBird** (WireGuard mesh, self-hosted) | Zero-trust admin access; SSH/kubectl closed on public firewall, only via mesh. Co-hosted on DNS VPS (ns1+ns2). See ADR-013. |

### 0.4 Data & Storage

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **Block Storage**           | **Longhorn** (self-hosted distributed storage) | Replicated PVs, snapshots, S3 backup capability, no external dependency |
| **Media/Branding Storage**  | **Longhorn PV** (local persistent volume) | Logo uploads, favicons, platform branding assets |
| **Shared MariaDB**            | **1 single instance** → replica for HA    | Per-client isolation via separate databases + dedicated users |
| **Shared PostgreSQL**       | **1 single instance** → replica for HA    | Alternative/parallel to MariaDB; clients choose |
| **Shared Redis**            | **1 single instance** → Redis Sentinel for HA | Session cache, PHP object cache, fail2ban ban list |
| **Offsite Backups**         | **SSHFS mount over NetBird mesh** to external server | Daily mount → direct write → unmount. Zero local disk. Via WireGuard tunnel; no public SSH on backup server. See ADR-013. |

### 0.5 Email Stack

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **Email Model**             | **Hybrid**: self-hosted + external provider option | Default: Docker-Mailserver (full control); clients can opt for external SMTP relay |
| **MTA / IMAP**              | **Docker-Mailserver** (Postfix + Dovecot + Rspamd) | All-in-one, self-contained, includes spam filtering |
| **Webmail**                 | **Roundcube** (single shared instance)    | Lightweight, battle-tested, rich feature set, good UX |
| **OIDC Email Login**        | **Yes** (Google/Apple via Dex)            | Enhanced security, password-less access for clients' users |
| **App Passwords**           | **Auto-generated, admin-readable, client-manageable** | Highest security + usability balance |

### 0.6 Monitoring & Observability

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **Metrics**                 | **Prometheus** (via kube-prometheus-stack) | Standard K8s metrics, scrapes all services |
| **Logs**                    | **Loki** (not ELK)                        | 10x less memory than Elasticsearch, perfect for self-managed |
| **Dashboards**              | **Grafana**                               | Industry standard, rich plugin ecosystem |
| **Alerting**                | **Alertmanager** (Prometheus-integrated)  | Standard PromQL rules + notification service for business events |
| **Tracing** (Phase 2)       | **Tempo** (planned for Phase 2; not MVP) | Low resource usage, Loki integration; defer until needed |

### 0.7 CI/CD & Container Registry

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **Container Registry**      | **Harbor** (self-hosted, vulnerability scanning) | Built-in Trivy scanning, retention policies, simple interface |
| **Container Scanning**      | **Trivy** (on every build)                | Fast, accurate, integrated with Harbor |
| **GitOps for Platform**     | **Flux v2** (lightweight, GitOps-native) | Kubernetes-native, more flexible, event-driven |
| **CI Runner**               | **Gitea Actions** (if self-hosted) or **GitHub Actions** | Automated builds, tests, image pushes for catalog and platform services |

### 0.8 Business Model & Pricing

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **Target Revenue**          | **$0-5k/month** (initial phase)           | Small but sustainable platform; can scale to higher revenue |
| **Positioning**             | **Premium**                               | Focus on quality/features over low-cost competition; higher margins |
| **Pricing Model**      | **NOT in scope for this project**                 | Focus on technical infrastructure; business team will define pricing strategy |
| **Starter Plan**       | **Business decision (out of scope)**              | Shared pods, cost optimization; pricing TBD by business |
| **Business Plan**      | **Business decision (out of scope)**              | Dedicated pods, better isolation; pricing TBD by business |
| **Premium Plan**       | **Business decision (out of scope)**              | Dedicated resources, support, features; pricing TBD by business |

---

## 1. Overview & Goals

### 1.1 Project Purpose

This infrastructure replaces the current Plesk-based commercial web hosting platform with a
modern, Kubernetes-orchestrated system. The business provides shared web hosting, WordPress
hosting, email hosting, database hosting, DNS management, SSL/TLS certificates, and file
access (SFTP) to commercial clients.

The primary driver is **operational efficiency** — eliminating manual server configuration,
reducing maintenance overhead, and enabling scalable, repeatable client provisioning through
automation.

### 1.2 Current State (Plesk)

| Aspect              | Current State                                     |
| ------------------- | ------------------------------------------------- |
| Hosting panel       | Plesk                                             |
| Server management   | Manual, per-server configuration                  |
| Client isolation    | Plesk subscription-level (OS user separation)     |
| Scaling             | Vertical (bigger servers) or manual server adds   |
| Deployment          | FTP/SFTP file upload, Plesk Git integration       |
| Monitoring          | Plesk built-in + ad-hoc                           |
| Backup              | Plesk backup manager                              |
| SSL                 | Plesk Let's Encrypt extension                     |
| Email               | Plesk mail server (Postfix/Dovecot)               |

### 1.3 Target State (Kubernetes)

| Aspect              | Target State                                       |
| ------------------- | -------------------------------------------------- |
| Hosting panel       | Custom management API + web UI                     |
| Server management   | Declarative, automated via Kubernetes              |
| Client isolation    | Namespace-per-client with resource quotas + network policies |
| Workload model      | **Hybrid**: shared Apache+PHP pods for Starter plans; dedicated pods for Business/Premium |
| Container catalog   | Centrally managed, standardized images — admin controls lifecycle |
| Scaling             | Horizontal (add nodes), auto-scaling workloads     |
| Deployment          | SFTP, Git-based file sync, web file manager (no per-client builds) |
| Monitoring          | Prometheus + Grafana + Loki                        |
| Backup              | Velero + per-client DB/file backups                |
| SSL                 | cert-manager + Let's Encrypt (fully automated)     |
| Email               | Hybrid (self-hosted + external provider support); Roundcube webmail with OIDC + app passwords |
| HA strategy         | **All HA features optional** — start minimal, upgrade as needed |

### 1.4 Key Objectives

- [ ] Eliminate manual server provisioning — all client onboarding automated
- [ ] Namespace-per-client isolation with enforced resource quotas
- [ ] Centrally managed workload container catalog — admin controls all available runtime images
- [ ] Clients select from pre-approved containers only (e.g., "Apache PHP 8.4")
- [ ] Admin can publish new container versions, deprecate old ones, and migrate clients
- [ ] **Hybrid workload model**: shared Apache+PHP pods for Starter; dedicated pods for Business/Premium
- [ ] Minimize server resource usage and infrastructure costs through shared services and density optimization
- [ ] **All HA features optional** — start with minimal single-instance deployment, enable HA incrementally
- [ ] Provide a self-service control panel comparable to Plesk functionality
- [ ] Automated SSL/TLS certificate provisioning via Let's Encrypt
- [ ] Hybrid email hosting (self-hosted option + external provider integration)
- [ ] Three file management methods: SFTP, Git-based file sync, web file manager
- [ ] Comprehensive security: fail2ban, optional WAF, OIDC authentication (Google/Apple)
- [ ] Full observability stack for platform operations
- [ ] Phased migration from Plesk with zero downtime for clients

### 1.5 Success Criteria

| Criteria                        | Target            |
| ------------------------------- | ----------------- |
| Service uptime (SLA)            | **99.5%** (~4.3 hours downtime/month) |
| Client onboarding time          | < 5 minutes (automated) |
| Time to deploy a client update  | < 2 minutes       |
| Container upgrade rollout       | < 1 hour across all affected clients |
| Mean time to recovery (MTTR)    | < 15 minutes (for critical services) |
| P95 response latency (API/Panel)| **< 1000ms** (relaxed, acceptable for admin tools) |
| Max concurrent clients at launch| 50-100 clients    |
| Max concurrent clients at scale | **300+ clients** (platform should grow to this) |
| Resource cost per client        | Target: < $2-4/month platform cost (track & optimize) |
| Plesk migration completion      | **No hard deadline** — complete when technically ready, business-driven |

### 1.6 Constraints & Assumptions

- Self-managed Kubernetes on bare metal or VPS (no managed K8s services)
- All services packaged as Docker images
- Clients do **not** build or supply their own containers — they select from admin-curated catalog
- Clients expect a GUI control panel — CLI/API alone is insufficient
- SFTP access must be preserved for clients who rely on it
- **Budget:** **< $200/month** for initial cluster (50-100 clients) — design must prioritize resource efficiency
- **Timeline:** Exploratory phase — no hard deadline
- **Team size:** **1-2 engineers** — must prioritize ruthlessly, parallelize only when possible
- **Target Scale:** 50-100 clients at launch, grow to 300+ clients at maturity
- **HA Strategy:** Minimal initially; upgrade to HA when cost-effective (around 100+ clients)

---

## 2. Workload Container Catalog

> _This is the central architectural concept: all client workloads run on standardized,
> admin-managed container images. Clients choose from the catalog; they cannot bring their own._

### 2.1 Concept

Instead of allowing clients to run arbitrary containers or build custom images, the platform
provides a **curated catalog of workload containers**. Each container is a pre-built,
hardened, tested runtime image maintained by the platform admin.

**Two deployment modes exist:**

| Mode              | How It Works                                          | Plans         |
| ----------------- | ----------------------------------------------------- | ------------- |
| **Shared pods**   | Multiple Starter clients share a pool of Apache+PHP pods. Apache VirtualHost config routes requests to each client's document root on their PV. | Starter |
| **Dedicated pods**| Client gets their own pod running a catalog image. Full resource isolation. | Business, Premium, Custom |

> The default experience for most clients is **shared Apache+PHP** — this mirrors
> traditional shared hosting and is the most resource-efficient model. Clients on
> Business/Premium plans get dedicated pods for better performance and isolation.

**Benefits:**
- **Security**: Every image is scanned, hardened, and patched centrally
- **Consistency**: All clients on the same runtime get identical environments
- **Efficient updates**: Upgrade PHP 8.3 -> 8.4 for all clients in one operation
- **Extreme density**: Shared pods serve 20-50 Starter clients per pod (like traditional shared hosting)
- **Lower resource usage**: Shared base layers across clients (Docker layer caching on nodes)
- **Simplified support**: Known environments reduce debugging complexity
- **No build infrastructure needed**: Eliminates per-client CI/CD pipelines

### 2.2 Catalog Structure

Each catalog entry defines a workload container with a specific runtime, web server, and
version combination.

| Catalog ID               | Base Image              | Web Server | Runtime     | Status      |
| ------------------------ | ----------------------- | ---------- | ----------- | ----------- |
| `apache-php84`           | php:8.4-apache-alpine   | Apache 2.4 | PHP 8.4     | Active      |
| `apache-php83`           | php:8.3-apache-alpine   | Apache 2.4 | PHP 8.3     | Active      |
| `apache-php82`           | php:8.2-apache-alpine   | Apache 2.4 | PHP 8.2     | Deprecated  |
| `nginx-php84`            | custom (nginx + php-fpm)| Nginx      | PHP 8.4     | Active      |
| `nginx-php83`            | custom (nginx + php-fpm)| Nginx      | PHP 8.3     | Active      |
| `wordpress-php84`        | wordpress:php8.4-apache | Apache 2.4 | PHP 8.4 + WP optimized | Active |
| `wordpress-php83`        | wordpress:php8.3-apache | Apache 2.4 | PHP 8.3 + WP optimized | Active |
| `node22`                 | node:22-alpine          | Built-in   | Node.js 22  | Active      |
| `node20`                 | node:20-alpine          | Built-in   | Node.js 20  | Active      |
| `python312`              | python:3.12-slim        | Gunicorn   | Python 3.12 | Active      |
| `python311`              | python:3.11-slim        | Gunicorn   | Python 3.11 | Active      |
| `ruby34`                 | ruby:3.4-alpine         | Puma       | Ruby 3.4    | Active      |
| `dotnet9`                | mcr.microsoft.com/dotnet/aspnet:9.0 | Kestrel | .NET 9 | Active   |
| `java21`                 | eclipse-temurin:21-jre-alpine | Tomcat/embedded | Java 21 | Active |
| `static-nginx`           | nginx:alpine            | Nginx      | Static only | Active      |
| `static-caddy`           | caddy:alpine            | Caddy      | Static only | Active      |

### 2.3 Shared Pod Architecture (Starter Plan)

Shared pods host multiple Starter-plan clients within a single Apache+PHP container,
similar to how traditional shared hosting works with Apache VirtualHosts.

**Shared Apache+PHP Pod Structure**

Each client's PV is mounted as a subdirectory under /mnt/clients/.
VirtualHost configs are auto-generated by the Management API.

**Shared pod pool design:**

| Parameter                    | Value                                         |
| ---------------------------- | --------------------------------------------- |
| Clients per shared pod       | 20-50 (configurable, based on resource usage)  |
| Shared pod replicas          | 2-4 pods per pool (for load distribution)      |
| VirtualHost config injection | ConfigMap mounted into pod, reloaded on change (Apache graceful restart) |
| Client file isolation        | Each client's PV mounted at unique subpath     |
| PHP process isolation        | PHP-FPM pools per client with `open_basedir` restriction |
| Resource limits (per pod)    | 2 vCPU / 4Gi RAM (serves 20-50 clients)        |
| Scale trigger                | New pool pod added when existing pods reach client capacity |

**How it works:**
1. Management API assigns new Starter client to a shared pod pool with capacity
2. Client's PV mounted into the shared pod at `/mnt/clients/client-{id}/`
3. Apache VirtualHost config generated and added to ConfigMap
4. Apache gracefully reloaded to pick up new VirtualHost
5. Ingress rule created pointing client's domain to the shared pod pool service
6. PHP-FPM pool created for client with `open_basedir` enforced to their directory only

**Upgrade to dedicated pod (admin-initiated only):**
- Admin upgrades client from Starter to Business/Premium via Admin Panel or Management API (`PATCH /api/v1/clients/{id}` with new `plan`). Clients cannot self-service upgrade — all plan changes require admin action. See `BILLING_MODEL_CHANGES.md`.
- Management API provisions a dedicated pod in client namespace with selected catalog image
- Client's PV remounted from shared pod to dedicated pod
- VirtualHost removed from shared pod ConfigMap
- Ingress updated to point to new dedicated pod
- Zero downtime — switch happens via ingress routing

### 2.4 Image Build & Maintenance

Platform admin builds and maintains all catalog images in a central CI pipeline.

**Each image includes:**
- Runtime (PHP, Node, Python, etc.) at a pinned version
- Web server (Apache, Nginx, Gunicorn, etc.)
- Common extensions/modules pre-installed (e.g., PHP: mysqli, gd, curl, mbstring, opcache)
- Security hardening (non-root user, minimal packages, no dev tools)
- Health check endpoint (`/healthz` or TCP probe)
- Log output to stdout/stderr (for Loki collection)
- Volume mount point at `/var/www/html` (or equivalent) for client files

**Image build pipeline:**
1. Admin updates Dockerfile in platform Git repo
2. CI builds image, runs tests (smoke test with sample app)
3. Trivy scans for vulnerabilities
4. Image pushed to Harbor registry with tag: `catalog/<id>:<version>-<date>`
5. Admin enables new image in catalog via Management API
6. Old image marked as deprecated (existing clients keep running until migrated)

### 2.5 Admin Container Lifecycle Management

The admin panel provides full lifecycle control over the catalog:

| Action                    | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| **Add new container**     | Publish a new runtime to the catalog (e.g., PHP 8.5 when released) |
| **Enable / Disable**      | Control which containers are available for new client selection |
| **Deprecate**             | Mark a container as end-of-life; show warning to clients using it |
| **Force migrate**         | Rolling-update all clients on a deprecated container to a specified replacement |
| **View usage**            | See which clients are on which container version      |
| **Remove**               | Delete a container from catalog (only after 0 clients remain on it) |
| **Rollback**              | Revert a container update if issues are discovered    |

### 2.6 Container Upgrade Workflow

When a new container version is published (e.g., `apache-php84` with a security patch):

### 2.7 Client Container Selection

In the management panel, clients see:

Clients can switch containers via the panel at any time (triggers a pod replacement
with the new image, preserving the PersistentVolume with their files).

### 2.8 Custom Extensions / Modules

For cases where a client needs a PHP extension or system package not in the default image:

| Approach                         | Complexity | Recommendation        |
| -------------------------------- | ---------- | --------------------- |
| Include all common extensions in base image | Low | Default approach — cover 95% of cases |
| Offer "extended" image variants (e.g., `apache-php84-imagick`) | Medium | For popular extras |
| Init container that installs extras at startup | Medium | Flexible but slower startup |
| Client requests admin to add extension to catalog | Low | Manual but controlled |
| Allow custom Dockerfiles         | High       | **Not supported** — breaks the model |

> **Recommendation:** Ship fat images with all commonly needed extensions pre-installed.
> The marginal storage cost is low and it eliminates most custom extension requests.
> For rare cases, create "-extended" image variants.

---

## 3. Application Catalog

> _The Application Catalog handles complex, multi-container workloads (Nextcloud, BigBlueButton,
> Jitsi, etc.) that go beyond simple website hosting. This is separate from the Workload
> Container Catalog (Section 2) which handles client web runtimes._

### 3.1 Concept — Two Catalogs

The platform maintains **two distinct catalogs**:

| Catalog                      | Purpose                                          | Deployed By    | Example                        |
| ---------------------------- | ------------------------------------------------ | -------------- | ------------------------------ |
| **Workload Container Catalog** (Section 2) | Standardized web runtimes for client sites | Admin (manages images), Client (selects) | `apache-php84`, `node22`, `wordpress-php84` |
| **Application Catalog** (this section) | Complex multi-container applications | Admin (defines apps), Admin or Client (deploys instances) | Nextcloud, BigBlueButton, Jitsi, Gitea, Matomo, Moodle, Gibbon, Keycloak |

**Key difference:** A workload container is a single runtime image that serves client-provided
files. An application is a **complete stack** — often multiple containers, its own database,
configuration, volumes, and ingress — deployed as a unit via a Helm chart or Kustomize template.

### 3.2 How Applications Are Defined

Each application in the catalog is defined as a **Helm chart** (or Kustomize overlay)
with admin-configurable parameters. The Management API stores the catalog; the admin panel
provides the UI.

**Application definition structure:**

Each catalog application is stored in the `app_catalog` table and referenced by a Helm chart in the platform's GitOps repository (`helm/catalog/<app_id>/`). The canonical definition includes:

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | `TEXT` | Unique slug — used as Helm release prefix | `nextcloud`, `wordpress`, `jitsi` |
| `display_name` | `TEXT` | Human-readable name shown in admin and client panels | `Nextcloud` |
| `description` | `TEXT` | Short description (< 200 chars) | `Self-hosted file sync and sharing` |
| `helm_chart` | `TEXT` | Path to Helm chart in the repo | `helm/catalog/nextcloud` |
| `helm_version` | `TEXT` | Pinned chart version | `29.0.1` |
| `default_values` | `JSONB` | Default Helm values overridden at deploy time | `{ "replicaCount": 1, "persistence": { "size": "10Gi" } }` |
| `min_resources` | `JSONB` | Minimum CPU/memory/storage required | `{ "cpu_m": 500, "memory_mi": 1024, "storage_gi": 10 }` |
| `plan_tiers` | `TEXT[]` | Which plans can deploy this app | `["business", "premium"]` |
| `tenancy` | `TEXT` | `single` or `multi` — whether each client gets a dedicated instance | `single` |
| `components` | `TEXT[]` | Informational: what runs in the Helm chart | `["app", "postgresql", "redis"]` |
| `docs_url` | `TEXT` | Link to upstream documentation | `https://docs.nextcloud.com` |
| `enabled` | `BOOLEAN` | Whether this app is available for new deployments | `true` |
| `pricing_model` | `TEXT` | `included` (in plan) or `addon` (extra cost) | `included` |

Example row:

```json
{
  "id": "nextcloud",
  "display_name": "Nextcloud",
  "helm_chart": "helm/catalog/nextcloud",
  "helm_version": "29.0.1",
  "default_values": {
    "nextcloud.host": "{{ .domain }}",
    "persistence.size": "10Gi",
    "postgresql.enabled": true,
    "redis.enabled": true
  },
  "min_resources": { "cpu_m": 500, "memory_mi": 1024, "storage_gi": 10 },
  "plan_tiers": ["business", "premium"],
  "tenancy": "single",
  "components": ["app", "postgresql", "redis", "cronjob"],
  "enabled": true,
  "pricing_model": "included"
}
```

The management API merges `default_values` with admin-provided deploy-time parameters when calling `helm install`. Template variables like `{{ .domain }}` are resolved from the client's domain record before passing to Helm.

### 3.3 Application Catalog — Example Entries

| App ID             | Name               | Components                                     | Tenancy Options     | Default Resources   |
| ------------------ | ------------------ | ---------------------------------------------- | ------------------- | ------------------- |
| `nextcloud`        | Nextcloud          | App pod + DB + Redis + CronJob                 | Multi or Single     | 500m CPU, 1Gi RAM, 10Gi storage |
| `bigbluebutton`    | BigBlueButton      | bbb-web + TURN server + recordings + MongoDB + Redis | Single only    | 4 CPU, 8Gi RAM, 50Gi storage |
| `jitsi`            | Jitsi Meet         | web + prosody + jicofo + jvb (video bridge)    | Single or Shared    | 2 CPU, 4Gi RAM, 5Gi storage |
| `gitea`            | Gitea              | App pod + DB (PostgreSQL)                      | Multi or Single     | 250m CPU, 512Mi RAM, 5Gi |
| `matomo`           | Matomo Analytics   | App pod + DB (MariaDB)                           | Multi or Single     | 250m CPU, 512Mi RAM, 5Gi |
| `vaultwarden`      | Vaultwarden        | App pod + SQLite/PG                            | Multi or Single     | 100m CPU, 256Mi RAM, 1Gi |
| `wordpress`        | WordPress (managed)| App pod + DB + Redis + WP-CLI CronJob          | Single only         | 250m CPU, 512Mi RAM, 5Gi |
| `mattermost`       | Mattermost         | App pod + DB (PostgreSQL) + file storage       | Multi or Single     | 500m CPU, 1Gi RAM, 10Gi |
| `moodle`           | Moodle LMS         | App pod + DB (MariaDB/PostgreSQL) + file storage | Single only         | 1 CPU, 2Gi RAM, 20Gi storage |
| `gibbon`           | Gibbon LMS         | App pod + DB (MariaDB)                           | Single only         | 500m CPU, 1Gi RAM, 10Gi storage |
| `keycloak`         | Keycloak           | App pod + DB (PostgreSQL) + Cache (Redis)      | Single only         | 500m CPU, 1Gi RAM, 5Gi storage |

> **Resource Defaults & Customization:**
> - The "Default Resources" column shows the global default allocation when an application is added to the catalog
> - These defaults apply to all new deployments of the application unless overridden
> - When deploying an instance for a specific customer, the admin can customize CPU, memory, and storage allocations to meet that customer's needs
> - Customizations are tracked per deployment for billing and resource allocation purposes
> - Admin can add new applications to the catalog at any time by adding a Helm chart definition via the management panel or API

### 3.4 Tenancy Models

Applications can be deployed in different tenancy modes, configurable per application:

#### Single-Tenant (Dedicated Instance)

Each deployment gets its own full stack in a dedicated namespace.

**Pros:** Full isolation, independent scaling, client can customize freely
**Cons:** Higher resource usage — each instance runs its own pods
**Best for:** BigBlueButton, Jitsi, Moodle LMS, Gibbon LMS, Keycloak (resource-heavy, client-specific config, privacy-sensitive)

#### Multi-Tenant (Shared Instance)

One application instance serves multiple users/clients with account-level separation.

**Pros:** Very resource-efficient, single instance to maintain
**Cons:** Less isolation, shared resource contention, single point of failure for all users
**Best for:** Nextcloud, Gitea, Matomo, Vaultwarden (apps with built-in user management)

#### Admin Configures Per Application

The admin decides the tenancy model when adding an app to the catalog:

| Setting                   | Options                                         |
| ------------------------- | ----------------------------------------------- |
| `tenancy`                 | `single-tenant` / `multi-tenant` / `configurable` |
| `default_tenancy`         | Which mode is used when deploying               |
| If `configurable`         | Admin/client chooses per deployment              |

#### Resource Allocation & Customization

Each application has **global default resource allocations** defined in the catalog, but these are **fully customizable per deployment**:

| Resource Setting          | Definition                                      |
| ------------------------- | ----------------------------------------------- |
| **Catalog defaults**      | CPU, memory, and storage minimums set when app is added to catalog |
| **Per-deployment override** | Admin can increase/decrease resources for specific customer instances |
| **CPU customization**     | Scale up for high-traffic or compute-intensive workloads |
| **Memory customization**  | Increase for applications with large datasets or caches |
| **Storage customization** | Adjust based on customer's expected file storage needs |
| **Tracking**              | Resource allocations tracked per instance for billing |

**Example:** Moodle LMS has a catalog default of 1 CPU / 2Gi RAM / 20Gi storage, but:
- Customer A (small course) → deploy with 500m CPU / 1Gi RAM / 10Gi storage
- Customer B (large course) → deploy with 2 CPU / 4Gi RAM / 50Gi storage

### 3.5 Deployment Workflow

#### Admin Deploys an Application

1. Admin navigates to **Admin Panel → Applications → Catalog**
2. Selects the application (e.g., Nextcloud, Gitea, Moodle) and clicks **Deploy Instance**
3. Selects the target client from a searchable dropdown
4. Chooses tenancy mode (if the catalog entry supports `configurable`): `single-tenant` or `multi-tenant`
5. Sets resource overrides (CPU, memory, storage) — or accepts catalog defaults
6. Assigns a domain (existing client domain or new subdomain)
7. Chooses database backend (shared MariaDB / shared PostgreSQL / dedicated — per plan)
8. Reviews cost estimate (base + resource surcharges per billing model)
9. Confirms → Management API provisions the Helm release into the client's namespace
10. Real-time provisioning progress displayed via WebSocket (same pattern as VPS provisioning in §5.7.5)
11. On success: application URL shown; DNS record automatically added via PowerDNS API; TLS certificate issued via cert-manager

**Admin-only capabilities during deploy:**
- Override resource limits beyond plan defaults (for custom/premium arrangements)
- Deploy to any client namespace regardless of the client's current plan
- Set a custom domain not yet in the DNS zone (admin must ensure delegation is correct)
- Skip integrity checks for Helm chart validation (emergency deploys only)

#### Client Requests an Application

1. Client navigates to **Client Panel → Applications → Catalog**
2. Browses available applications filtered to those compatible with their current plan
3. Selects an application and clicks **Request / Deploy**
4. If the application is `auto-approve` in the catalog: provisioning begins immediately (same flow as admin deploy, steps 4–11 above, with plan-constrained resource limits)
5. If the application requires admin approval:
   - Client fills in a request form (desired domain, any notes)
   - Request is queued as a pending task in the Admin Panel notification feed
   - Admin reviews, adjusts resources if needed, then approves → provisioning begins
   - Client receives an email notification when the application is ready
6. Plan enforcement: the Management API validates that the client's current plan permits the requested application type and resource footprint before accepting the request
7. On success: application URL and credentials (if any) are shown in **Client Panel → Applications → My Apps**

### 3.6 Application Lifecycle Management

| Action                    | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| **Deploy instance**       | Create a new application instance (admin or client); customize resources per deployment |
| **Upgrade version**       | Update Helm chart version — rolling update of all components |
| **Configure**             | Change parameters (storage, features, domain, CPU/memory allocations) |
| **Scale**                 | Adjust replicas, resources (for single-tenant instances); customize per customer needs |
| **Backup** (Cluster)      | Application data included in daily platform-managed backup pipeline (free, not counted in quota) |
| **Backup** (Customer)     | Manual backups and custom schedules with customer-defined retention (counts toward disk quota) |
| **Suspend**               | Stop all pods but preserve data (for non-paying clients) |
| **Delete**                | Remove instance, optionally export data first         |
| **View logs / metrics**   | Application logs in Loki, metrics in Grafana          |

### 3.7 Application Updates

Application catalog images and Helm chart versions are updated independently of the platform itself. The update process is:

**Platform-managed catalog images** (PHP, Node.js, static nginx, etc.):
1. New image published to Harbor registry with tag `catalog/<id>:<version>-<YYYYMMDD>`
2. Admin reviews release notes in **Admin Panel → Applications → Catalog → {app} → Versions**
3. Admin selects which client instances to update (all at once, or per-client)
4. Management API triggers a Helm upgrade on the selected instance(s) — rolling update strategy (one pod at a time, health-checked before proceeding)
5. If a pod fails to become Ready within the configured timeout, the rollout is automatically paused and the previous ReplicaSet is restored
6. Client is notified by email on completion (or failure with rollback confirmation)

**Application Helm chart updates** (Nextcloud, Gitea, Moodle, etc.):
1. Updated Helm chart committed to the platform Git repo
2. Flux v2 detects the change and reconciles — applies the updated chart to all instances using that chart version
3. Admin can pin specific instances to a chart version to opt out of automatic updates
4. Rollback: `git revert` the Helm chart bump commit → Flux auto-syncs within 5 minutes

**Client-initiated updates:**
- Clients can view the current version of each deployed application in **Client Panel → Applications → My Apps**
- Clients can request an update via the panel — queued for admin approval (same flow as initial deploy approval)
- Clients cannot directly trigger Helm upgrades; all chart-level changes go through the Management API

**Automatic security patching:**
- Critical CVE patches to catalog images (severity HIGH/CRITICAL in Trivy) trigger an automated update job
- Admin is notified before the job runs (24-hour window to defer if needed)
- Non-critical updates are batched into weekly maintenance windows

### 3.8 Application Resource & Cost Tracking

Each application instance is tracked separately for resource usage and billing:

| Metric                    | Tracked Per Instance                              |
| ------------------------- | ------------------------------------------------- |
| CPU / Memory usage        | Prometheus metrics per namespace                  |
| Storage usage             | PVC utilization                                   |
| Bandwidth                 | Ingress controller metrics per host               |
| Active users              | Application-specific (if exposed via API)         |
| Monthly cost              | Base price + resource usage surcharges             |

### 3.9 Integration with Hosting Plans

Applications can be offered as **add-ons** to hosting plans:

| Plan Parameter              | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `available_applications`    | List of app IDs this plan can access (or `all`)   |
| `application_instances_max` | Max simultaneous app instances per client          |
| `application_auto_approve`  | Whether client requests are auto-approved          |

**Example plan configurations:**

| Plan    | Available Apps        | Max Instances | Auto-Approve |
| ------- | --------------------- | ------------- | ------------ |
| Starter | None (or limited)     | 0             | N/A          |
| Business| Nextcloud, Gitea      | 2             | No           |
| Premium | All                   | Unlimited     | Yes          |

> Like all plan parameters, these can be **overridden per-client**.

---

## 4. Architecture Diagram Notes

> _This section captures the logical architecture before a formal diagram is produced._

### 4.1 Platform Service Inventory

These are the **platform-level** services that power the hosting infrastructure:

| Service                    | Responsibility                                          | Status   |
| -------------------------- | ------------------------------------------------------- | -------- |
| **Management API**         | Client CRUD, namespace provisioning, domain mgmt, catalog mgmt | Planned |
| **Management Web UI**      | Self-service control panel for clients + admin panel    | Planned  |
| **Container Catalog Service** | Maintains workload image catalog, handles upgrades/rollbacks | Planned |
| **Application Catalog Service** | Manages complex app definitions (Helm charts), deploys/upgrades app instances | Planned |
| **Ingress Controller**     | Route external traffic to client sites, TLS termination | Planned  |
| **cert-manager**           | Automated Let's Encrypt certificate provisioning        | Planned  |
| **DNS Controller**         | Programmatic DNS record management for client domains   | Planned  |
| **Shared DB Service (MariaDB)** | Shared MariaDB instance with per-client databases      | Planned  |
| **Shared DB Service (PG)**    | Shared PostgreSQL instance with per-client databases | Planned  |
| **Shared Redis**           | Shared Redis instance with per-client key prefixes      | Planned  |
| **SFTP Gateway**           | Per-client SFTP access to site files                    | Planned  |
| **Git Deploy Service**     | Webhook-triggered file sync from client Git repos (no builds) | Planned |
| **File Manager**           | **FileBrowser** (lightweight, Go-based, user-friendly) | Planned |
| **Mail Stack**             | Self-hosted email (Docker-Mailserver) in dedicated namespace | Planned |
| **Roundcube Webmail**      | Webmail UI — shared instance, client-level domains, OIDC + app password auth | Planned |
| **App Password Service**   | Manages email application passwords — auto-provisioned, admin-readable, client self-service | Planned |
| **Auth Service (OIDC)**    | OpenID Connect provider — Google/Apple sign-in          | Planned  |
| **fail2ban Controller**    | Intrusion detection/prevention across ingress + SSH/SFTP | Planned |
| **WAF (optional)**         | Web Application Firewall at ingress layer               | Planned  |
| **Prometheus + Grafana**   | Metrics collection and dashboards                       | Planned  |
| **Loki**                   | Log aggregation                                         | Planned  |
| **Velero**                 | Kubernetes state and volume backup                      | Planned  |
| **Backup CronJobs**        | Per-client database and file backups                    | Planned  |
| **Notification Service**   | Configurable email notifications for all client/system/security events | Planned |
| **Migration Service**      | Native migration from Plesk, cPanel, Virtualmin; data extraction, transformation, import | Planned |

### 4.2 Per-Client Resource Stack

Resources vary by hosting plan — Starter clients consume almost no per-namespace resources:

#### Starter Plan (Shared Pod) — Per Client Namespace

| Resource                | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| **PersistentVolumeClaim** | Site files (mounted into shared pod at `/mnt/clients/client-{id}/`) |
| **Ingress rules**       | Per-domain routing (points to shared pod pool Service)  |
| **NetworkPolicy**       | Default-deny + allow ingress controller                 |
| **ConfigMap**            | Client-specific PHP settings                           |
| **Secret**               | DB credentials, SFTP credentials (auto-generated)     |

> Starter clients do **not** have their own pod — they are served by the shared
> Apache+PHP pod pool in the `platform` namespace. This means a Starter client
> consumes virtually zero CPU/memory in their own namespace.

#### Business / Premium / Custom Plan (Dedicated Pod) — Per Client Namespace

| Resource                | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| **Web runtime pod**     | Dedicated pod running a catalog container image (e.g., `apache-php84`) |
| **PersistentVolumeClaim** | Site files mounted at `/var/www/html`                |
| **Ingress rules**       | Per-domain routing with TLS certificates                |
| **ResourceQuota**       | CPU, memory, storage limits per hosting plan            |
| **NetworkPolicy**       | Default-deny + allow ingress controller + shared services |
| **ServiceAccount**      | Scoped to client namespace only                         |
| **ConfigMap**            | Client-specific config (PHP settings, vhost overrides) |
| **Secret**               | DB credentials, SFTP credentials (auto-generated)     |
| **Optional: Dedicated Redis** | Premium plan only (256Mi)                        |
| **Optional: Dedicated DB**    | Premium/Custom plan only                         |

> **Note:** Databases and Redis are **shared services** by default — not per-client pods.
> Dedicated instances are optional for Premium/Custom plans.
> See [Section 5: Storage & Databases](#5-storage--databases) for details.

### 4.3 Communication Patterns

| Pattern                       | Technology / Protocol                  | Use Case                          |
| ----------------------------- | -------------------------------------- | --------------------------------- |
| Client HTTP traffic           | HTTPS via Ingress Controller           | End-user requests to client sites |
| Management API calls          | REST API (HTTPS)                       | Panel UI to management backend    |
| Service-to-service (internal) | ClusterIP services                     | Management API to controllers     |
| DB connections                | MariaDB/PG protocol via ClusterIP        | Client pods to shared DB services |
| Cache connections             | Redis protocol via ClusterIP           | Client pods to shared Redis       |
| OIDC authentication           | HTTPS (OpenID Connect)                 | Google/Apple sign-in flows        |
| DNS updates                   | API calls to DNS service               | Domain record automation          |
| Git deploy webhooks           | HTTPS webhooks                         | Trigger file sync from Git pushes |
| Container catalog events      | K8s Jobs / internal API                | Image upgrades, rollbacks         |

### 4.4 High-Level Architecture Topology

The platform is structured as a single k3s cluster (per region) with layered zones:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INTERNET / CLIENTS                           │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ HTTPS :443 / HTTP :80
┌──────────────────────────▼──────────────────────────────────────────┐
│              NGINX Ingress Controller (DaemonSet)                   │
│        hostPort 80/443 on all worker nodes — multi-A DNS            │
│        PowerDNS round-robin A records → all worker node IPs         │
│        TLS terminated here (cert-manager + Let's Encrypt)           │
│        ModSecurity WAF (detection mode, Phase 1)                    │
└──────┬──────────────────────────────────────────────────────────────┘
       │
       ├─── Client sites ──────────────────────────────────────────────┐
       │                                                               │
       │    ┌──────────────────┐  ┌──────────────────┐                │
       │    │ client-acme-corp │  │ client-beta-ind  │  … (n clients) │
       │    │ namespace        │  │ namespace        │                │
       │    │                  │  │                  │                │
       │    │ [web pod]        │  │ [web pod]        │                │
       │    │ [Longhorn PVC]   │  │ [Longhorn PVC]   │                │
       │    │ ResourceQuota    │  │ ResourceQuota    │                │
       │    │ NetworkPolicy    │  │ NetworkPolicy    │                │
       │    └──────────────────┘  └──────────────────┘                │
       │                                                               │
       │    ┌─────────────────────────────────────────────────┐        │
       │    │          shared-pool-php84 namespace             │        │
       │    │  [shared pod] (Starter clients, multi-tenant)   │        │
       │    └─────────────────────────────────────────────────┘        │
       └───────────────────────────────────────────────────────────────┘
       │
       └─── Platform services ─────────────────────────────────────────┐
                                                                       │
            ┌─────────────────────────────────────────────────────┐    │
            │                  platform namespace                  │    │
            │  [management-api]   [dns-controller]                │    │
            │  [cert-controller]  [backup-cronjob]                │    │
            │  [dex-oidc]         [sealed-secrets]                │    │
            └─────────────────────────────────────────────────────┘    │
                                                                       │
            ┌─────────────────────────────────────────────────────┐    │
            │                    mail namespace                    │    │
            │         [docker-mailserver]   [roundcube]           │    │
            └─────────────────────────────────────────────────────┘    │
                                                                       │
            ┌─────────────────────────────────────────────────────┐    │
            │                   harbor namespace                   │    │
            │      [harbor-core]  [harbor-registry]  [trivy]      │    │
            └─────────────────────────────────────────────────────┘    │
                                                                       │
            ┌─────────────────────────────────────────────────────┐    │
            │                monitoring namespace                  │    │
            │    [prometheus]  [grafana]  [loki]  [alertmanager]  │    │
            └─────────────────────────────────────────────────────┘    │
                                                                       │
            ┌──────────────────────┐  ┌──────────────────────────┐    │
            │    mariadb namespace  │  │   postgresql namespace    │    │
            │ [Percona MariaDB Op.] │  │   [CloudNativePG]        │    │
            │ shared DB cluster     │  │   shared DB cluster      │    │
            └──────────────────────┘  └──────────────────────────┘    │
                                                                       │
            ┌─────────────────────────────────────────────────────┐    │
            │                  flux-system namespace               │    │
            │  [source-controller]  [kustomize-controller]        │    │
            │  [helm-controller]    [notification-controller]     │    │
            └─────────────────────────────────────────────────────┘    │
            └───────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                         ADMIN ACCESS (VPN only)                        │
│                NetBird WireGuard mesh — not public internet            │
│                SSH :22 / kubectl API :6443 via mesh IP only            │
│              PowerDNS ns1 + ns2 co-hosted on NetBird VPN nodes        │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                      OFFSITE BACKUP SERVER                             │
│               SSHFS mount on-demand via NetBird mesh                   │
│           /backups/daily/{date}/{customer}/  (Tier 1)                 │
│           /backups/customer-backups/{customer}/  (Tier 2)             │
└────────────────────────────────────────────────────────────────────────┘
```

**Key topology properties:**
- All worker nodes run NGINX Ingress pods (DaemonSet); PowerDNS has a multi-A record pointing to all worker IPs — traffic is balanced without a load balancer appliance (ADR-010)
- Client namespaces are isolated by NetworkPolicy (default-deny; allow Ingress controller + shared services only)
- Platform services and client namespaces are co-located on the same nodes — ResourceQuotas prevent resource starvation
- Admin access to `kubectl` and SSH is exclusively via NetBird mesh (port 6443 not exposed to the public internet — ADR-013)
- Flux v2 watches the platform Git repo and reconciles all namespaces; no direct `kubectl apply` in production

### 4.5 Diagram Placeholder

> _The ASCII topology in §4.4 above is the canonical reference. A polished visual diagram can be produced from it using Excalidraw, draw.io, or Mermaid if needed for presentations._

---

## 5. Compute, Networking & Cost Optimization

### 5.1 Kubernetes Cluster Topology

> **Design principle:** Start with the minimum viable cluster on single provider (Hetzner).
> All HA features are optional and can be enabled incrementally as the business grows or budget allows.
>
> **Multi-cloud strategy available:** See separate `MULTI_CLOUD_STRATEGY.md` document for
> geographic distribution, disaster recovery, and multi-provider setup options.

#### Initial Deployment (Minimal)

| Parameter             | Value / Decision                                     |
| --------------------- | ---------------------------------------------------- |
| Cluster count         | Single cluster                                       |
| **K8s distribution**  | **k3s (lightweight)** — see [Section 0.1](#01-kubernetes--infrastructure) |
| Control plane         | **1 node** (single control plane — HA is optional upgrade) |
| Worker nodes          | **1-2 nodes** (general-purpose, 4vCPU/8Gi minimum)  |
| Auto-scaling          | Manual (add worker nodes as capacity increases)      |
| **OS**                | **Debian 13** — see [Section 0.1](#01-kubernetes--infrastructure) |
| **Container runtime** | **containerd** (k3s default)                         |
| **CNI Plugin**        | **Flannel** (k3s default, simple overlay) → Calico upgrade path — see [Section 0.2](#02-networking--ingress) |

#### HA Upgrade Path (Optional — Enable When Needed)

> **Step-by-step migration procedures:** See `02-operations/HA_MIGRATION_RUNBOOK.md` for detailed runbooks covering each stage transition (Stage 0→1→2→3→4) with pre-flight checklists, exact commands, verification steps, and rollback procedures.

| HA Feature                   | Initial  | Upgrade To                        | When to Enable | Runbook Stage |
| ---------------------------- | -------- | --------------------------------- | -------------- | ------------- |
| Control plane nodes          | 1        | 3 (etcd quorum)                   | When downtime is unacceptable | Stage 2→3 |
| Worker nodes                 | 1-2      | 3+ (N+1 redundancy)              | When single node can't fit all workloads | Stage 0→1, 1→2 |
| DB replication               | Single   | Primary + replica                 | When DB downtime risk is too high | Stage 3→4 |
| Ingress controller (DaemonSet)| 1 (auto) | 1 per worker node (auto-scales)  | Automatic with DaemonSet — adds pod per new worker | Stage 0+ |
| Longhorn replication factor  | 1        | 2-3                               | When adding storage nodes | Stage 1→2 |
| Pod disruption budgets       | None     | Set for platform services          | When running multi-node | Stage 1→2 |
| Anti-affinity rules          | None     | Spread platform services across nodes | When running 3+ nodes | Stage 1→2 |
| Multi-region / multi-cluster | No       | Evaluate for DR                   | At scale or compliance requirement | Phase 2+ |

### 5.2 Namespace Strategy

| Namespace               | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `platform`              | Management API/UI, catalog service, DNS controller, Git deploy, shared DB/Redis |
| `ingress`               | Ingress controller, WAF, fail2ban controller      |
| `auth`                  | OIDC proxy / authentication services              |
| `monitoring`            | Prometheus, Grafana, Loki, Alertmanager           |
| `mail`                  | Docker-Mailserver, Roundcube webmail, app password service |
| `backup`                | Velero, backup CronJobs                           |
| `sftp`                  | SFTP gateway service                              |
| `client-{name}`         | One namespace per client (auto-provisioned)       |
| `app-{appid}-{instance}`| Application instances from Application Catalog    |

### 5.3 Networking

| Component                | Decision                                            |
| ------------------------ | --------------------------------------------------- |
| **CNI plugin**           | **Flannel** (k3s default, simple) → **Calico upgrade** for network policies at scale — see [Section 0.2](#02-networking--ingress) |
| Service mesh             | Not initially — evaluate Linkerd if mTLS needed at scale |
| **Ingress controller**   | **NGINX Ingress Controller** (with ModSecurity WAF) — see [Section 0.2](#02-networking--ingress) |
| **DNS (external)**       | **PowerDNS Authoritative** — 2 VPS: ns1 (Falkenstein, primary) + ns2 (Helsinki, secondary). AXFR replication. API via NetBird mesh. Co-hosted with NetBird VPN. See ADR-013. |
| **Admin access VPN**     | **NetBird** (WireGuard mesh) — SSH/kubectl not exposed publicly, only via mesh. See ADR-013. |
| DNS (internal/cluster)   | CoreDNS (Kubernetes default, built-in to k3s)       |
| **Traffic routing**      | **DNS-based ingress routing** — NGINX Ingress as DaemonSet on every worker; `ingress.platform.com` multi-A record (60s TTL) auto-managed by DNS Ingress Controller. No Floating IP / MetalLB. See ADR-014. |
| Network policies         | Default-deny per client namespace; explicit allow for ingress controller and shared services |
| Pod-to-pod across clients| Denied — NetworkPolicy blocks all cross-namespace client traffic |

### 5.4 Cost Optimization Strategies

> _These strategies are designed to maximize client density per node and minimize
> infrastructure spend without sacrificing reliability._

#### 4.4.1 Shared Everything for Starter Plan (Largest Cost Saver)

The Starter plan shares **pods, databases, and cache** — Starter clients consume almost
no dedicated resources:

| Service               | Dedicated Model               | Shared Model (Starter)               | Savings                     |
| --------------------- | ----------------------------- | ------------------------------------ | --------------------------- |
| **Web server**        | 200 pods, 200 x 128Mi RAM    | 3-5 shared Apache+PHP pods           | ~97% fewer web pods         |
| **MariaDB**             | 200 pods, 200 PVCs, ~100Gi RAM | 1 instance, per-client databases   | ~99% fewer DB pods          |
| **PostgreSQL**        | Separate pod per client       | 1 instance, per-client databases     | ~99% fewer DB pods          |
| **Redis**             | Per-client pod                | 1 instance, per-client key prefixes (`client-{id}:*`) | ~99% fewer Redis pods |

**At 200 Starter clients, total pod count: ~10 pods** (3-5 shared web + 1 MariaDB + 1 PG + 1 Redis + platform services)
vs. **~600+ pods** in a fully dedicated model.

> Isolation is maintained at the VirtualHost/database/user level (separate document roots,
> separate DB credentials, separate databases within the shared instance).
> Business/Premium clients still get dedicated pods.
> See [Section 5.1](#51-database-strategy--shared-instances).

#### 4.4.2 Resource Overcommit & Density

Most web hosting clients use a fraction of their allocated resources most of the time.
Design for this reality:

| Strategy                       | Implementation                                   |
| ------------------------------ | ------------------------------------------------ |
| **Low requests, higher limits** | Set CPU request to 50m, limit to 500m-2000m. Pods get burst capacity without reserving resources. |
| **Memory request < limit**      | Request 128Mi, limit 512Mi. Allows node-level overcommit. |
| **QoS class: Burstable**       | All client pods run as Burstable (not Guaranteed). Platform services run as Guaranteed. |
| **Shared web pods for Starter** | 3-5 pods serve 100-200 Starter clients |
| **No resource waste on DB pods**| Shared DB eliminates hundreds of idle DB pods    |

**Example deployment sizing:**

| Deployment Stage     | Nodes                    | Starter Clients | Dedicated Clients | Total Pods | Est. Monthly Cost |
| -------------------- | ------------------------ | --------------- | ----------------- | ---------- | ----------------- |
| **Minimal (initial)**| 1 CP + 1 worker (4vCPU/8Gi) | Up to 50     | Up to 10          | ~25-35     | ~$30-60           |
| **Small**            | 1 CP + 2 workers (4vCPU/8Gi) | Up to 100   | Up to 30          | ~50-70     | ~$60-100          |
| **Medium**           | 1 CP + 2 workers (8vCPU/16Gi) | Up to 200  | Up to 50          | ~80-120    | ~$100-200         |
| **HA-enabled**       | 3 CP + 3 workers (8vCPU/16Gi) | 200+       | 100+              | ~150+      | ~$300-500         |

> **Recommendation:** Start with the **Minimal** deployment (1 control plane + 1 worker).
> A single 4 vCPU / 8Gi node can comfortably host 50 Starter clients (via shared pods)
> plus 10 dedicated-pod clients plus all platform services. Scale by adding worker nodes.
> Enable HA only when business justifies the cost.

#### 4.4.3 Scale-to-Zero for Inactive Dedicated Sites

> **Note:** Scale-to-zero only applies to **dedicated pod clients** (Business/Premium).
> Starter clients on shared pods already consume no dedicated resources when idle.

Many dedicated-pod client sites receive little to no traffic for extended periods.
Scale-to-zero eliminates resource consumption for idle sites.

| Component              | Implementation                                    |
| ---------------------- | ------------------------------------------------- |
| **Applies to**         | **Optional per plan and per application** (configurable by admin/client) |
| **Scale-to-zero tool** | **KEDA** (Kubernetes Event-Driven Autoscaling) with HTTP trigger |
| **Idle threshold**     | Configurable: 15-30 minutes of no HTTP requests (admin-set default) |
| **Wake-up trigger**    | Ingress controller routes request to activator; pod spins up in 2-5 seconds |
| **Cold start latency** | First request after idle: ~2-5 seconds (acceptable for low-traffic sites) |
| **Exclusions**         | Premium plan clients can disable scale-to-zero if desired; Starter uses shared pods |
| **Savings estimate**   | Reduces dedicated pod count during off-peak hours by 30-50% |
| **Configuration**      | Admin sets global scale-to-zero defaults; clients can opt-in/opt-out per application |

#### 4.4.4 Container Image Layer Sharing

Because all clients use images from the same catalog:

- Node-level Docker layer cache is highly effective — base layers pulled once per node
- Upgrades only pull changed layers (not full images)
- Disk usage per client is minimal (just the client's PV, not a full image)

#### 4.4.5 Lightweight Platform Components

| Choice                          | Why                                             |
| ------------------------------- | ----------------------------------------------- |
| **k3s over kubeadm**           | ~50% less control plane memory, built-in ingress/LB options |
| **Loki over ELK**              | 10x less memory than Elasticsearch               |
| **Prometheus with retention limits** | 15-day local retention; long-term to offsite backup server if needed |
| **Alpine-based images**         | 5-50MB vs. 200-800MB for Debian/Ubuntu-based     |
| **Single shared Redis**         | 50Mi RAM vs. 200 x 64Mi = 12.5Gi for per-client |

#### 4.4.6 Cost Estimation Framework

**Initial Minimal Deployment (no HA) — Target: < $200/mo for 50-100 clients:**

| Component                | Count | Est. Resources         | Est. Monthly Cost |
| ------------------------ | ----- | ---------------------- | ----------------- |
| Control plane node       | 1     | 2 vCPU / 4Gi           | ~$8-12            |
| Worker node              | 1     | 4 vCPU / 8Gi           | ~$12-18           |
| Storage (Longhorn)       | ~200Gi| No replication initially| ~$5-10            |
| Bandwidth               | ~100GB| Standard usage         | ~$5-10            |
| **Total (minimal)**      |       |                        | **~$31-52/mo**    |
| **With 3-4x buffer**     |       |                        | **~$100-200/mo** ✅ |

**Growth Deployment (with optional HA — implement when cost-effective):**

| Component                | Count | Est. Resources         | Est. Monthly Cost |
| ------------------------ | ----- | ---------------------- | ----------------- |
| Control plane nodes      | 3     | 2 vCPU / 4Gi each     | ~$24-36           |
| Worker nodes             | 3     | 8 vCPU / 16Gi each    | ~$36-54           |
| Storage (Longhorn)       | ~500Gi| Replicated 2x         | ~$10-15           |
| Bandwidth               | ~500GB| Higher usage          | ~$10-20           |
| **Total (HA)**           |       |                        | **~$82-124/mo**   |

> **Action item:** Price out on Hetzner (primary), OVH, and Linode for cost comparison.
> **Target:** Keep initial deployment under $200/mo budget; scale HA only when business justifies it.

### 5.5 Hosting Plan System — Fully Customizable

> **Design principle:** All hosting plans are **fully customizable templates**. Admin defines
> global plan defaults, but **every setting can be overridden on a per-client basis** via
> the management panel. This allows maximum flexibility — standard plans for most clients,
> fine-tuned settings for specific clients when needed.

#### 4.5.1 How Plan Customization Works

**Management API logic:**
- Each plan defines a complete set of default values for all configurable parameters
- Each client record stores a `plan_id` plus an optional `overrides` object
- The effective configuration is: `plan_defaults MERGED WITH client_overrides`
- Any parameter not in overrides inherits the plan default
- Admin can override any client setting without changing their plan
- Client plan changes apply all new defaults, but preserve explicit per-client overrides

**Example:**

A client is on the **Starter** plan (`web_mode: shared`, `storage_limit_gb: 5`, `max_email_accounts: 5`) but has a custom storage allocation negotiated with the admin:

```json
{
  "client_id": "cust_abc123",
  "plan_id": "starter",
  "overrides": {
    "storage_limit_gb": 15,
    "max_email_accounts": 10
  }
}
```

Effective configuration:

```
web_mode:            shared        (from plan — no override)
catalog_image:       apache-php84  (from plan — no override)
storage_limit_gb:    15            (override — was 5 in plan)
max_email_accounts:  10            (override — was 5 in plan)
max_databases:       1             (from plan — no override)
```

If this client is later upgraded to **Business** plan (`storage_limit_gb: 20`), the override (`15`) is preserved and takes precedence — the client retains 15 GB, not 20 GB. The admin would need to explicitly remove the override to revert to the new plan default.

#### 4.5.2 Configurable Plan Parameters

Every parameter below is set at the **plan level** (global default) and can be
**overridden per-client** by the admin via the management panel.

| Parameter              | Description                              | Example Values                |
| ---------------------- | ---------------------------------------- | ----------------------------- |
| `web_mode`             | Shared pod or dedicated pod              | `shared` / `dedicated`        |
| `catalog_image`        | Workload container from catalog          | `apache-php84` / `wordpress-php84` / `node22` |
| `cpu_request`          | CPU request (dedicated pods only)        | `50m` / `100m` / `200m`      |
| `cpu_limit`            | CPU limit (dedicated pods only)          | `500m` / `1000m` / `2000m`   |
| `memory_request`       | Memory request (dedicated pods only)     | `128Mi` / `256Mi` / `512Mi`  |
| `memory_limit`         | Memory limit (dedicated pods only)       | `512Mi` / `1Gi` / `4Gi`      |
| `storage`              | PersistentVolume size                    | `5Gi` / `20Gi` / `50Gi`      |
| `database_mode`        | Shared or dedicated database             | `shared` / `dedicated`        |
| `database_engine`      | MariaDB or PostgreSQL                      | `mysql` / `postgresql`        |
| `database_storage`     | DB storage (dedicated only)              | `5Gi` / `20Gi`               |
| `cache_mode`           | Shared Redis, dedicated, or none         | `shared` / `dedicated` / `none` |
| `cache_memory`         | Redis memory (dedicated only)            | `64Mi` / `256Mi` / `1Gi`     |
| `scale_to_zero`        | Enable scale-to-zero (dedicated only)    | `true` / `false`              |
| `backup_retention_days`| How many days to retain backups          | `7` / `14` / `30` / `90`     |
| `backup_frequency`     | How often to run backups                 | `daily` / `twice_daily` / `hourly` |
| `waf_enabled`          | Enable WAF for this client               | `true` / `false`              |
| `max_domains`          | Maximum number of domains allowed        | `1` / `5` / `10` / `unlimited` |
| `max_email_accounts`   | Email accounts (if self-hosted)          | `0` / `5` / `10` / `unlimited` |
| `email_sending_limit`  | Max emails per hour per account          | `50` / `200` / `500` / `unlimited` |
| `webmail_enabled`      | Enable Roundcube webmail access          | `true` / `false`              |
| `webmail_domain`       | Custom webmail domain (e.g., `webmail.client.com`) | Domain string or `null` (use platform default) |
| `email_oidc_enabled`   | Allow OIDC (Google/Apple) login for email | `true` / `false`             |
| `sftp_enabled`         | Enable SFTP access                       | `true` / `false`              |
| `git_deploy_enabled`   | Enable Git-based deployments             | `true` / `false`              |
| `file_manager_enabled` | Enable web file manager                  | `true` / `false`              |
| `php_version`          | PHP version override (if applicable)     | `8.3` / `8.4`                |
| `php_memory_limit`     | PHP memory_limit ini setting             | `128M` / `256M` / `512M`     |
| `php_max_upload`       | PHP upload_max_filesize                  | `64M` / `128M` / `256M`      |
| `custom_php_ini`       | Additional php.ini overrides             | Key-value pairs               |
| `egress_internet`      | Allow outbound internet from client pod  | `true` / `false`              |
| `price_monthly`        | Monthly price for this plan/client       | Decimal value                 |

#### 4.5.3 Default Plan Templates

These are the **default plan templates** shipped with the platform. Admin can modify
any value, create new plans, or delete unused plans entirely.

| Parameter | Starter | Business | Premium |
| --------- | ------- | -------- | ------- |
| **Web Mode** | Shared pod | Dedicated | Dedicated |
| **CPU Req/Limit** | N/A (shared) | 100m / 1000m | 200m / 2000m |
| **Mem Req/Limit** | N/A (shared) | 256Mi / 1Gi | 512Mi / 4Gi |
| **Storage** | 5Gi | 20Gi | 50Gi |
| **DB Mode** | Shared | Shared | Dedicated |
| **Max Databases** | 1 | 3 | 10 |
| **Cache** | Shared | Shared | Dedicated |
| **Max Domains** | 1 | 5 | Unlimited |
| **Email Accounts** | 5 | 25 | Unlimited |
| **Bandwidth** | 50GB/mo | 500GB/mo | Unlimited |
| **WAF** | Available (off by default) | Available (off by default) | Enabled |
| **Cron Jobs** | Unlimited | Unlimited | Unlimited |
| **Backup Retention** | Per global backup strategy | Per global backup strategy | Per global backup strategy |
| **Price (USD)** | **$5.99/mo** | **$19.99/mo** | **$49.99/mo** |

> These are **default plan templates** — fully customizable by admins. Plans can be added, removed, and modified. Individual values can be overridden per-customer and re-synced with plan defaults. WAF is available on all plans. Cron jobs are unlimited. Backup retention follows the global backup strategy (see `BACKUP_STRATEGY.md`). Canonical plan definitions are in `HOSTING_PLANS.md`.

**Pricing Rationale:**
- **Starter ($5.99/mo)**: Entry-level, shared resources, minimal support — highest margin per client but requires volume
- **Business ($19.99/mo)**: Mid-tier, dedicated pod, better isolation, standard support — balanced revenue
- **Premium ($49.99/mo)**: High-value, dedicated resources, WAF enabled, priority support — premium positioning for serious clients

#### 4.5.4 Key Differences by Default Plan

| Feature               | Starter              | Business             | Premium              |
| --------------------- | -------------------- | -------------------- | -------------------- |
| Web pod               | Shared (VirtualHost) | Own dedicated pod    | Own dedicated pod    |
| PHP process isolation | `open_basedir` + FPM pool | Full pod isolation | Full pod isolation |
| CPU/Memory            | Shared (fair-use)    | Guaranteed limits    | Higher guaranteed limits |
| Database              | Shared instance      | Shared instance      | Dedicated pod        |
| Redis cache           | Shared instance      | Shared instance      | Dedicated pod        |
| Scale-to-zero         | N/A                  | Optional             | No (always on)       |
| Custom PHP config     | Via panel overrides   | Full control         | Full control         |

> **Any of the above can be changed per-client.** For example, a Starter client could
> be given WAF access, or a Business client could be given a dedicated database — all
> via per-client overrides without changing their plan.

#### 4.5.5 Admin Plan Management UI

The admin panel provides full CRUD for plans:

| Action                       | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| **Create plan**              | Define a new plan template with all parameters |
| **Edit plan defaults**       | Modify any global default — changes apply to all clients on this plan (unless overridden) |
| **Clone plan**               | Duplicate an existing plan as starting point   |
| **Delete plan**              | Remove plan (only if 0 clients assigned)       |
| **View clients on plan**     | List all clients using this plan               |
| **Override client settings** | Edit any parameter for a specific client       |
| **Reset client overrides**   | Clear per-client overrides, revert to plan defaults |
| **Bulk update**              | Change a setting across all clients on a plan  |

> **Cost impact:** A Starter client's marginal infrastructure cost is near zero — they
> consume only PV storage and a share of the shared pod's resources. This makes it
> viable to offer very low-cost entry-level hosting. Per-client overrides allow upselling
> individual features without forcing a full plan upgrade.

### 5.6 Geographic Sharding with Centralized Management

> **Design principle:** Deploy independent K8s clusters across multiple geographic regions.
> Each region operates completely independently but shares centralized management,
> DNS, and backup systems. If any region fails, clients can be re-deployed from backup
> to a healthy region, and the management system continues functioning.

#### 5.6.1 Geographic Sharding Architecture

**Three-Tier System:**

The geographic sharding architecture operates across three tiers:

| Tier | Components | Scope | Failure impact |
|------|-----------|-------|---------------|
| **Tier 1 — Global Management** | Central management database (PostgreSQL, Frankfurt primary), admin panel, cross-region configuration store, billing system | Platform-wide | If this tier is unavailable, admins cannot make configuration changes, but all regional client traffic continues unaffected |
| **Tier 2 — Regional Cluster** | Per-region k3s cluster (control plane + workers), regional management API replica, regional PowerDNS slave, regional Harbor | One cloud region (e.g. `eu-frankfurt`, `us-ashburn`) | If a regional cluster fails, only clients in that region are affected; other regions continue serving clients independently |
| **Tier 3 — Client Workload** | Per-client Kubernetes namespace, NGINX/PHP pods, MariaDB/PostgreSQL databases, Longhorn PVs, Ingress rules | One client within one region | If one client's workload fails, other clients in the same region are unaffected |

This structure means a failure at any tier is contained: a single client crash never affects the region, and a full regional outage never affects other regions or the global management plane.

#### 5.6.2 Regional Cluster Characteristics

**Each regional cluster is:**

| Characteristic | Details |
|---|---|
| **Completely Independent** | Can operate for weeks without contacting other regions |
| **Full Management Capability** | Has own Management API + database replicas; can provision/delete clients |
| **Self-Healing** | If other regions fail, continues serving clients with degraded coordination |
| **Backup-Enabled** | Daily backups to external SFTP server unique to that region |
| **DNS-Resilient** | Caches PowerDNS queries locally; continues DNS if central PowerDNS fails |
| **Client Auto-Failover Ready** | If another region fails, clients can be re-provisioned from backups |

#### 5.6.3 Multi-Master Database Replication

**PostgreSQL Multi-Master Setup (Using pglogical):**

The platform's management database (CloudNativePG) uses `pglogical` for logical replication between regions. In Phase 2 (warm standby), Frankfurt is the single writer; the OVH replica is read-only. In Phase 3 (full HA), both regions can write, with conflict resolution handled at the application layer.

```
Frankfurt (primary writer)  ──pglogical REPLICATION SET──►  OVH Strasbourg (subscriber/replica)
                            ◄──pglogical REPLICATION SET──   (Phase 3: bi-directional)
```

Replication sets:
- `management_data`: `customers`, `plans`, `domains`, `databases`, `subscriptions`, `audit_events`
- `dns_zones`: `dns_zones`, `dns_records` (mirrored to all regions for DNS query serving)
- `billing`: `invoices`, `payments` (Phase 3: single-writer only — Frankfurt wins)

```sql
-- On Frankfurt (provider):
SELECT pglogical.create_node(node_name := 'frankfurt', dsn := 'host=postgres.platform.svc port=5432 dbname=platform');
SELECT pglogical.create_replication_set('management_data');
SELECT pglogical.replication_set_add_all_tables('management_data', ARRAY['public']);

-- On OVH (subscriber):
SELECT pglogical.create_node(node_name := 'strasbourg', dsn := 'host=postgres.platform-ovh.svc port=5432 dbname=platform');
SELECT pglogical.create_subscription(
  subscription_name := 'sub_frankfurt',
  provider_dsn := 'host=<FRANKFURT_IP> port=5432 dbname=platform user=pglogical password=<SECRET>',
  replication_sets := ARRAY['management_data', 'dns_zones']
);
```

**Application-Level Conflict Resolution:**

All management data rows include `updated_at` and `updated_by_region` columns. The conflict resolution policy (per `CONFLICT_RESOLUTION_MATRIX.md`) is:
- **Last-write-wins** for most fields (higher `updated_at` wins).
- **Plan upgrades always win** over plan downgrades in the same conflict window.
- **Deletes always win** over updates (a deleted record stays deleted).
- Conflicts are logged to `conflict_log` table and visible in the admin panel (Monitoring → Conflict Log).

#### 5.6.4 Centralized PowerDNS with Regional Caching

**Architecture:**

One authoritative PowerDNS instance runs in Frankfurt (`ns1.platform.example.com`). Secondary PowerDNS instances in each additional region receive all zones via AXFR and answer queries locally, reducing cross-region latency for DNS resolution.

```
Client DNS query (EU)
  → Resolver queries ns1 or ns2
    ├── ns1 (Frankfurt, authoritative master) — answers directly
    └── ns2 (OVH Strasbourg, AXFR slave)    — answers from local copy

Frankfurt PowerDNS ──AXFR on-change──► OVH Strasbourg PowerDNS
                   ──AXFR on-change──► Linode Ashburn PowerDNS   (Phase 2+)
                   ──AXFR on-change──► Hetzner Singapore PowerDNS (Phase 3+)
```

**DNS Query Flow:**

1. Client site visitor resolves `example-client.com` → queries ns1 or ns2 (both delegated).
2. ns2 (nearest slave) answers from its local zone copy — no cross-region round-trip.
3. On zone change (A record update, new domain): management API calls Frankfurt PowerDNS REST API → Frankfurt NOTIFIES all slaves → slaves request AXFR → typically propagated in < 5 seconds.
4. TTL is 60 seconds for A/AAAA records (matches ADR-010 drain requirement); 3600 seconds for NS/MX/TXT.

**Zone Replication:**

```bash
# Verify AXFR replication is working:
dig AXFR example-client.com @ns2.platform.example.com
# Should return full zone identical to ns1

# Force immediate AXFR from Frankfurt to all slaves:
kubectl exec -n dns deploy/powerdns -- \
  pdns_control notify example-client.com

# Check replication status (PowerDNS slave monitoring):
kubectl exec -n dns deploy/powerdns-slave -- \
  pdnsutil show-zone example-client.com | grep "Serial"
# Compare serial with master — should match within seconds
```

#### 5.6.5 Per-Region External Backup Storage

**Each region has dedicated backup infrastructure:**

| Region | Storage Type | Target | Retention |
|--------|-------------|--------|-----------|
| Frankfurt (Hetzner) | Hetzner StorageBox (1 TB) | Primary backup target | 30 days |
| Strasbourg (OVH) | OVH Object Storage S3 (500 GB) | Cross-region backup copy | 14 days |
| Ashburn (Linode) | Linode Object Storage (500 GB) | Cross-region backup copy | 14 days |
| Singapore (Hetzner) | Hetzner StorageBox (500 GB) | Cross-region backup copy | 14 days |

The external SFTP/S3 server is mounted into the backup pod via SSHFS (direct write, no Kubernetes PV involved). Each client's backup is stored under a directory named by UUID: `backups/<client_uuid>/<date>/`.

**Cross-Region Backup Sync (Nightly):**

```bash
# CronJob: k8s/base/cronjobs/cross-region-backup-sync.yaml
# Runs at 03:00 UTC nightly on the Frankfurt cluster

# Sync Frankfurt → OVH:
rsync --archive --delete --compress \
  /mnt/backup-frankfurt/ \
  backup@ovh-strasbourg.platform.internal:/mnt/backup-ovh/

# Sync Frankfurt → Linode (Phase 2+):
rsync --archive --delete --compress \
  /mnt/backup-frankfurt/ \
  backup@linode-ashburn.platform.internal:/mnt/backup-linode/
```

Each region's backups are accessible for restore via the management API's restore endpoint, regardless of which region the client is currently on. Restoring from a cross-region backup is used in disaster recovery scenarios.

#### 5.6.6 Client Geo-Assignment Strategy

**How clients are assigned to regions:**

See `MULTI_CLOUD_STRATEGY.md § How to Assign Clients to Providers` for the full decision logic and TypeScript implementation. Summary:

1. Admin explicit override → use specified region.
2. Client billing country → map to nearest region (country-to-region table).
3. Data residency flag → never send EU-restricted clients outside EU regions.
4. Capacity threshold (80% CPU) → route to next-nearest region if primary is full.
5. Plan tier → Business/Premium always go to primary cluster in their region.

The assigned region is stored in `customers.region` and is admin-editable. Client migration between regions is performed via the admin panel (`C.3 Region Management` in `ADMIN_PANEL_REQUIREMENTS.md`).

#### 5.6.7 Regional Failover and Client Re-Deployment

**Scenario: Hetzner Frankfurt cluster fails**

**Automated Failover Workflow:**

1. Prometheus detects all Frankfurt worker nodes unreachable → AlertManager fires `CRITICAL: Region hetzner-eu down`.
2. Admin receives alert via email + configured notification channel.
3. Admin assesses estimated downtime: if > 30 minutes → trigger failover.
4. Admin Panel → Infrastructure → Region Failover → Select `eu-frankfurt` → Confirm.
5. Management API marks Frankfurt clients as `region_status: failover_pending`.
6. Management API updates DNS A records to point to OVH Strasbourg ingress IPs (TTL 60s → propagates in ~1 minute).
7. New client requests arrive at Strasbourg ingress.
8. For Phase 2 (nightly sync): Restore client workloads from most recent backup copies on OVH. ETA 15–60 minutes per batch.
9. For Phase 3 (real-time pglogical): Client data already present on Strasbourg. Kubernetes workloads re-scheduled on Strasbourg worker nodes immediately. ETA < 5 minutes.

**Re-Deployment Process (Manual or Automated):**

```
Phase 2 (nightly backup):
  Admin Panel → Clients → Filter: region=Frankfurt, status=offline
  → Select All → Bulk Action: Restore from Latest Backup on Strasbourg
  → Confirm → WebSocket progress stream per client

Phase 3 (automated via pglogical + GeoDNS):
  GeoDNS detects Frankfurt health check fail
  → Routes EU traffic to Strasbourg automatically
  → Kubernetes scheduler on Strasbourg re-schedules pods from etcd state
  → No manual intervention needed
```

#### 5.6.8 Management API High Availability

**Full Replicas in Every Region:**

The management API (Fastify backend) runs as a Deployment in every active region cluster. Each regional instance has read-write access to its local PostgreSQL replica. In Phase 2, only Frankfurt's instance processes write operations that must propagate to other regions. In Phase 3, any regional instance can process writes; pglogical replicates changes to all other regions.

| Region | Management API | Database access | Write authority |
|--------|---------------|-----------------|----------------|
| Frankfurt | Primary | Read-write (master) | All operations |
| Strasbourg | Replica | Read-write (Phase 3) / Read-only (Phase 2) | Phase 3: all; Phase 2: failover only |
| Ashburn | Replica | Read-write local | US clients only |

Admin panel requests are routed to the nearest healthy management API instance via GeoDNS (Phase 3) or static DNS with manual failover (Phase 2).

**Conflict Resolution for Management Updates:**

When two regions process conflicting writes (e.g. a client is updated in Frankfurt and Strasbourg within the same second during a network partition), pglogical detects the conflict and applies the rule from `CONFLICT_RESOLUTION_MATRIX.md`:
- `last_update_wins` for most fields
- `higher_plan_wins` for `plan_id` conflicts
- `delete_wins` for deletion vs. update conflicts

All resolved conflicts are inserted into the `conflict_log` table in both regions for audit visibility.

#### 5.6.9 Graceful Degradation: What Still Works If...

**If Frankfurt goes down:**
- ✅ Strasbourg, Ashburn, Singapore clients: Unaffected
- ✅ Management API: Strasbourg/Ashburn/Singapore can issue new commands
- ✅ Admin panel: Routes to Strasbourg/Ashburn (nearest)
- ✅ Client management: Strasbourg can create/delete clients
- ✅ PowerDNS: External backup server active; zones cached in all regions
- ✅ Backups: Frankfurt's backups synced to other regions
- ❌ Frankfurt clients: Offline temporarily; re-deploy from backup

**If PowerDNS sync breaks (Frankfurt ↔ replicas):**
- ✅ Existing domains: Cached locally in each region; continue working
- ✅ Existing clients: Can create new subdomains (using cached base zone)
- ✅ Client traffic: Continues routing via cached DNS
- ❌ New domains: Cannot create until PowerDNS sync restored
- ❌ DNS changes: Cannot propagate to other regions

**If database replication lags (> 1 hour):**
- ✅ All regions: Can continue operating with local data
- ✅ New clients: Can be created in any region (UUIDs prevent conflicts)
- ⚠️ Billing: May have brief inconsistency between regions
- ⚠️ Client queries: May see slightly stale data for 1 hour

#### 5.6.10 Monitoring and Alerts

**What's monitored per region:**

| Metric | Tool | Alert threshold |
|--------|------|----------------|
| Node CPU utilisation | Prometheus `node_cpu_seconds_total` | > 80% for 5 min → warning |
| Node memory utilisation | Prometheus `node_memory_MemAvailable_bytes` | < 10% free → warning |
| Disk usage (Longhorn PVs) | Longhorn metrics | > 85% used → warning |
| pglogical replication lag | Custom metric from `pg_stat_replication` | > 60 seconds → warning; > 300s → critical |
| DNS AXFR replication | Custom probe (compare zone serial master vs slaves) | Serial mismatch for > 5 min → warning |
| Cross-region backup sync | Prometheus pushgateway from CronJob | Sync job failed or > 26h since last success → critical |
| Management API response time | Prometheus `http_request_duration_seconds` | p95 > 1s → warning; p95 > 5s → critical |
| Ingress error rate | `nginx_ingress_controller_requests{status=~"5.."}` | > 1% of requests → warning |
| Pod restart count | `kube_pod_container_status_restarts_total` | > 5 restarts/hour → warning |

Each region's Prometheus instance runs independently and scrapes local targets. AlertManager in Frankfurt aggregates alerts from all regions and sends to the admin notification channels. In Phase 3, a federated Prometheus setup (or Thanos) aggregates metrics from all regions into a single Grafana view.

#### 5.6.11 Customer Co-hosting: Optional Active-Passive Hot Standby

**Design Principle:** Customers can optionally enable co-hosting (per-customer setting) to run in two regions simultaneously: active primary + passive secondary with hourly sync. On primary region failure, admin triggers manual failover to secondary region. This provides disaster recovery without complexity of active-active replication.

**Co-hosting Architecture (Per-Customer, Optional):**

```
Normal Operation (Both Regions Healthy):

Primary Region: Frankfurt              Secondary Region: Strasbourg
├─ Website Files (Active, RW)          ├─ Website Files (Standby, RO)
├─ Database (Active, RW)               ├─ Database (Standby, RO)
├─ Email Mailboxes (Active)            ├─ Email Mailboxes (Standby)
├─ SSL Certificates                    ├─ SSL Certificates (copy)
└─ DNS (Primary Master)                └─ DNS (Read-only Slave)
    ↓ Hourly Sync (rsync, pg_dump, IMAP, certs)
    ├─ Files: Incremental (typical 2-5 min)
    ├─ Database: Hot backup, streamed (no locks)
    ├─ Email: IMAP export/import (new only)
    └─ Certs: Encrypted transfer via Vault
```

**Key Characteristics:**

| Aspect | Details |
|--------|---------|
| **Cost Model** | Add-on: 50% of base plan (€2.50-25/month depending on plan) |
| **Activation** | Per-customer, can be enabled/disabled anytime |
| **Sync Frequency** | Hourly (configurable) |
| **Traffic Pattern** | Active-Passive (primary active, secondary standby only) |
| **RTO on Failure** | Manual failover, admin action required via Control Panel |
| **RPO** | Hourly sync, max 1 hour data loss in worst case |
| **Volume Ownership** | Primary owns during normal op; secondary takes on failure |
| **DNS Authority** | Primary region is DNS master; secondary is read-only slave |

**Hourly Sync Process (Primary → Secondary):**

```
1. Trigger (every hour, 00:00, 01:00, 02:00, etc. UTC)

2. Pre-Sync Checks
   ├─ Verify primary region accessible
   ├─ Verify secondary region accessible
   ├─ Check secondary has capacity
   └─ Verify persistent volumes mounted

3. Files Sync (Typical: 2-5 minutes)
   ├─ Snapshot primary volume
   ├─ rsync incremental from primary → secondary
   ├─ Only changed blocks transferred
   └─ Verify checksum matches

4. Database Sync (Typical: 1-5 minutes, depends on size)
   ├─ pg_dump primary (hot backup, no locks)
   ├─ Transfer stream to secondary region
   ├─ Restore to secondary database
   └─ Verify row counts match

5. Email Sync (Typical: 2-10 minutes)
   ├─ Query primary mailboxes (since last sync timestamp)
   ├─ IMAP export new messages
   ├─ IMAP import to secondary
   └─ Update last_sync timestamp

6. SSL Certs Sync (Typical: < 1 minute)
   ├─ Encrypt with Vault key
   ├─ Transfer to secondary region
   ├─ Decrypt and store
   └─ Verify cert validity date

7. Report & Alert
   ├─ Log sync completion timestamp
   ├─ Record sync lag (minutes)
   ├─ Alert if sync > 10 minutes (warning)
   └─ Alert if sync fails 3x in row (critical)
   
Total Sync Time: 5-15 minutes (typical small sites)
                 15-60 minutes (large sites > 1GB)
```

**Sync Status in Control Panel:**

```
Customer: acme.com (Premium + Co-hosting)

Co-hosting Status: ✓ Healthy
├─ Primary Region: Frankfurt (Active) ✓
├─ Secondary Region: Strasbourg (Standby) ✓
├─ Last Sync: 2026-03-01 10:00 UTC
├─ Sync Lag: 5 minutes (normal)
├─ Sync Status: Healthy
│
├─ Sync Details:
│  ├─ Files: 2.5 GB (synced 5 min ago)
│  ├─ Database: 150,000 rows (synced 3 min ago)
│  ├─ Email: 5,000 messages (synced 8 min ago)
│  └─ SSL Certs: 2 certs (synced < 1 min ago)
│
├─ Cost: €50/month (Premium) + €25/month (Co-hosting)
│
└─ Actions: [Sync Now] [Disable Co-hosting]
```

**Multi-Region Admin Panel: Co-hosting Management**

Each region has a full admin panel that can:
- **Manage own region:** Full read-write access to customers in that region
- **View other regions:** Read-only view of customers in other regions
- **Enable co-hosting:** Select primary + secondary region, hourly sync enabled
- **Monitor region health:** Dashboard shows each region's status
- **Detect degradation:** Alert when region is degraded/failed
- **Trigger failover:** One-click manual failover if primary region down

**Example: Frankfurt Admin Panel**

```
Region Health: Frankfurt ✓ Healthy | Strasbourg ✓ Healthy | Ashburn ✓ | Singapore ✓

Customers in This Region (Frankfurt): 47
├─ With Co-hosting: 5
│  ├─ acme.com (Frankfurt + Strasbourg) - Sync: Healthy
│  ├─ corp.fr (Frankfurt + Ashburn) - Sync: Healthy
│  └─ ...
│
└─ Without Co-hosting: 42

View Other Regions:
├─ Strasbourg Customers: 32 (view only)
├─ Ashburn Customers: 25 (view only)
└─ Singapore Customers: 18 (view only)

Quick Actions:
├─ [Enable Co-hosting for Customer]
├─ [Migrate Customer to Another Region]
├─ [View Region Health Dashboard]
└─ [Failover Degraded Region]
```

**Customer Migration with Co-hosting:**

```
Scenario 1: Live Migration (Source Region Healthy)
├─ Select customer: acme.com
├─ Select target region: Strasbourg
├─ Select migration type:
│  ├─ "Move" (remove from Frankfurt)
│  ├─ "Copy" (keep Frankfurt, add co-hosting to Strasbourg)
│  └─ "Replace" (disable Frankfurt, use Strasbourg only)
├─ Transfer persistent volume live (snapshot + network)
├─ Restore database
├─ Switch DNS A record (TTL 5 min)
└─ Total time: 30-120 minutes (depends on size)

Scenario 2: Backup Restore (Source Region Down)
├─ Alert: Frankfurt cluster unreachable
├─ Admin reviews: 47 affected customers
├─ Admin selects target region: Strasbourg
├─ System retrieves latest backup (< 24 hours)
├─ Restore to new namespace in Strasbourg
├─ Update DNS to Strasbourg IP
└─ Total time: 60-180 minutes (backup size + network)

Scenario 3: Proactive Migration (Before Failure)
├─ Detect degradation: High latency, low disk space, node failures
├─ Plan migration: Low-traffic window
├─ Notify customers: 48-72 hour notice
├─ Live migrate: No downtime
└─ Benefits: No data loss, demonstrates reliability
```

**Volume Ownership Transfer (Failover):**

```
Normal Operation:
├─ Primary region (Frankfurt): Owns persistent volume
│  └─ pvc-frankfurt-acme-001 (Read-Write, Active)
├─ Secondary region (Strasbourg): Standby copy
│  └─ pvc-strasbourg-acme-001 (Read-Only, Synced hourly)
│
└─ Database owner: Primary (Frankfurt)
   └─ Secondary (Strasbourg): Read-only replica

Primary Region Failure:
├─ Admin detects: Frankfurt unreachable for 5+ minutes
├─ Admin sees dashboard: "CRITICAL - Frankfurt Down"
├─ Admin clicks: [Failover acme.com to Strasbourg]
├─ System promotes Strasbourg to primary:
│  ├─ pvc-strasbourg-acme-001: Read-Write (now owner)
│  ├─ Database: Strasbourg writable (now primary)
│  └─ DNS A record: Updated to Strasbourg IP
│
└─ Recovery (if Frankfurt comes back):
   ├─ Option 1: Restore Frankfurt as secondary (sync from Strasbourg)
   ├─ Option 2: Keep Strasbourg as primary (recommended)
   └─ Option 3: Manual reconciliation (if needed)
```

**API Endpoints for Co-hosting:**

```bash
# Enable co-hosting for customer
POST /api/v1/customers/{customerId}/cohosting/enable
{
  "primary_region": "frankfurt",
  "secondary_region": "strasbourg",
  "sync_schedule": "hourly"
}

# Get co-hosting status
GET /api/v1/customers/{customerId}/cohosting

# Trigger manual sync (if not on schedule)
POST /api/v1/customers/{customerId}/cohosting/sync-now

# Migrate customer between regions
POST /api/v1/customers/{customerId}/migrate-region
{
  "target_region": "strasbourg",
  "migration_type": "move",  // or "copy", "replace"
  "enable_cohosting": true
}

# Get region health status
GET /api/v1/admin/regions/{region}/health

# Failover co-hosted customer (manual)
POST /api/v1/admin/customers/{customerId}/failover
{
  "target_region": "strasbourg"
}
```

**Billing for Co-hosting Add-on:**

```
Base Plans:
├─ Starter: €5/month
├─ Business: €20/month
└─ Premium: €50/month

Co-hosting Add-on (50% of base):
├─ Starter + Co-hosting: €5 + €2.50 = €7.50/month
├─ Business + Co-hosting: €20 + €10 = €30/month
└─ Premium + Co-hosting: €50 + €25 = €75/month

Rationale:
├─ No double infrastructure cost (shared regional resources)
├─ Hourly sync overhead: ~10-20% per customer
└─ 50% discount reflects actual operational cost
```

**Region Health Monitoring for Co-hosted Customers:**

```
Automated Health Checks (every 5 minutes):

Per-Region Metrics:
├─ Kubernetes: Nodes up? Pods running? PVCs healthy?
├─ Database: Replication lag? Disk space? Can query?
├─ DNS: Zones correct? Query latency < 100ms?
├─ Backups: Last backup < 24h? External SFTP reachable?
└─ Inter-region links: APIs reachable? Database sync working?

Health Levels:
├─ GREEN: All checks passing, healthy, no action needed
├─ YELLOW: Some checks failing (high latency, slow db, low disk)
│          Region can serve customers, recommend proactive migration
│          Auto-migrate co-hosted customers if secondary healthy
└─ RED: Region unreachable/critical services down
        Requires manual intervention, emergency failover options

Admin Dashboard Alert (when degraded):
┌─────────────────────────────────────────┐
│ ⚠️ Frankfurt Region: DEGRADED (Yellow)  │
├─────────────────────────────────────────┤
│ Issues:                                 │
│ ├─ API latency: 450ms (threshold: 100ms)
│ ├─ DB replication lag: 8 seconds       │
│ └─ 3 pods pending (memory pressure)    │
│                                         │
│ Affected Customers: 47                  │
│ ├─ Critical: 5 (with co-hosting)       │
│ ├─ Standard: 32                        │
│ └─ Starter: 10                         │
│                                         │
│ Recommended Actions:                    │
│ [Migrate All] [Migrate Critical] [More] │
└─────────────────────────────────────────┘
```

**Related Documentation:**

See `05-advanced/MULTI_REGION_ADMIN_AND_COHOSTING.md` for:
- Complete multi-region admin panel architecture
- Detailed migration workflows (live, backup-based, proactive)
- Volume ownership transfer procedures
- Co-hosting sync mechanisms
- Billing model details
- Admin panel UI components
- Full API endpoint specifications

---

### 5.7 VPS Auto-Provisioning via Control Panel

> **Design principle:** Admins can provision any new VPS server as a master (new region)
> or worker (existing region) directly from the control panel. Automatic provisioning
> supports AWS, Hetzner, NetCup, OVH, and Azure APIs. Master servers can also act
> as workers. Full provisioning workflow with cost estimation, credential management,
> and live progress tracking.

#### 5.7.1 Provisioning Flow Overview

Provisioning a new VPS as a **worker node** (existing region) or **master node** (new region) follows this sequence:

```
Admin Panel
    │
    │  1. Select provider + region + instance type
    │     Cost estimate shown before confirm
    │
    ▼
Management API → Cloud Provider API
    │
    │  2. Create VPS instance
    │     (Hetzner: POST /v1/servers, AWS: RunInstances, etc.)
    │
    │  3. Wait for instance RUNNING state (~30–90s)
    │
    │  4. Inject bootstrap script via cloud-init / user-data:
    │     - Install Docker + containerd
    │     - Install NetBird agent → join WireGuard mesh
    │     - Install k3s agent (worker) OR k3s server (master)
    │     - Worker: joins cluster via API server IP on mesh
    │     - Master: initialises new k3s cluster (new region)
    │
    │  5. Verify node joins cluster:
    │     kubectl get node <hostname> → Ready
    │     Timeout: 10 minutes; alert if exceeded
    │
    │  6. Apply node labels + taints:
    │     region=<region>, role=worker|master
    │
    │  7. (Worker only) Install Longhorn on new node:
    │     Longhorn manager DaemonSet auto-detects new node
    │     Add node to Longhorn storage pool
    │
    │  8. (Master / new region) Bootstrap platform services:
    │     Flux reconciles platform namespace manifests
    │     PowerDNS secondary NS configured via AXFR
    │
    ▼
WebSocket → Admin Panel
    │
    │  Live step progress streamed to admin:
    │  [✓] Instance created   [✓] NetBird joined
    │  [✓] k3s joined         [✓] Node Ready
    │  [✓] Longhorn enrolled  [✓] Labels applied
    │
    ▼
Completion
    │  Node visible in Admin Panel → Infrastructure → Nodes
    │  Ready to receive workloads
```

**Failure handling:**
- If any step fails, the failed step and error message are shown inline
- Partially provisioned VPS is not automatically deleted (admin may want to SSH in to diagnose)
- Admin can retry the failed step from the panel, or manually destroy and start over
- All provisioning events logged to `audit_logs` with `VP_PROVISION_START`, `VP_PROVISION_COMPLETE`, `VP_PROVISION_FAILED`

See also: `ADMIN_PANEL_REQUIREMENTS.md §VP.2` for the full admin panel UI spec and API endpoints.

#### 5.7.2 Supported Cloud Providers

| Provider | API Type | Supported Regions | Instance Types | Cost Tracking | Status |
|----------|----------|---|---|---|---|
| **Hetzner Cloud** | REST API | Frankfurt, Nuremberg, Helsinki, Ashburn, Singapore | cx21, cx31, cx41, custom | €/hour | ✅ Implemented |
| **AWS EC2** | boto3 SDK | All AWS regions | t3, m5, c5, custom | $/hour | ✅ Implemented |
| **OVH Cloud** | OpenStack API | EU, Canada, Singapore, Australia, USA | b2, d2, r2, custom | €/hour | ✅ Implemented |
| **NetCup** | REST API | DE (Nuremberg), EU (Cologne) | VPS M/L/XL, custom | €/month | ✅ Implemented |
| **Azure** | ARM REST API | All Azure regions | B, D, E series, custom | $/hour | ✅ Implemented |

#### 5.7.3 Provider Credential Management

**Multi-Account Support with Labeling:**

Admins can configure multiple accounts per cloud provider (e.g. two Hetzner projects, one for EU and one for US). Each credential set is stored with a human-readable label and a region tag.

| Field | Example | Notes |
|-------|---------|-------|
| Provider | `hetzner` | Enum: `hetzner`, `aws`, `ovh`, `netcup`, `azure` |
| Label | `Hetzner EU (primary)` | Free text, displayed in provider selector |
| Region scope | `eu-frankfurt` | Which platform region this credential is used for |
| Status | `active` / `invalid` | Validated on save and re-checked hourly |
| Last validated | `2026-03-08 10:00 UTC` | Timestamp of last successful API call with this credential |

**Credential Storage & Validation:**

Credentials (API keys, access key IDs, client secrets) are stored in Kubernetes Sealed Secrets, never in the database. The management API stores only a reference (`credential_id` → Sealed Secret name). On add/update:

1. Admin enters credentials in admin panel → `POST /api/v1/admin/cloud-credentials`.
2. Management API calls the provider's cheapest "list regions" or "list instances" API endpoint to validate the credentials work.
3. On success: credentials are sealed via `kubeseal` and stored as a Secret in the `platform` namespace; `credential_id` is stored in `cloud_provider_credentials` table.
4. On failure: 400 returned with provider error message; nothing is stored.

Credentials are never returned in API responses (only `credential_id`, `label`, `status`, `last_validated`).

#### 5.7.4 Server Configuration & Provisioning

**Admin Flow in Control Panel:**

1. **Admin Panel → Infrastructure → Nodes → Add Node**
2. Select role: **Worker** (joins existing region) or **Master** (creates new region).
3. Select cloud provider credential from dropdown (pre-configured and validated).
4. Select provider region (e.g. `Hetzner / Nuremberg`).
5. Select instance type with live cost estimate (see §5.7.11).
6. Optionally: set node label (e.g. `pool=database`), SSH key override.
7. Click **Provision** → confirmation modal showing cost/month.
8. On confirm: provisioning job starts, WebSocket progress stream opens (see §5.7.5).

Configuration options per provider:

| Option | Hetzner | AWS | OVH | NetCup | Azure |
|--------|---------|-----|-----|--------|-------|
| Instance type | cx21–cx41 | t3.small–m5.4xl | b2-7–d2-240 | VPS M/L/XL | B2s–D4s |
| Volumes (Longhorn) | Hetzner Volume | EBS gp3 | OVH Block | Local disk | Azure Disk |
| SSH key | Hetzner key pair | EC2 Key Pair | OpenStack keypair | Via API | Azure key |
| User-data / cloud-init | ✅ | ✅ | ✅ | Limited | ✅ |

#### 5.7.5 Live Provisioning Progress

**Real-Time Status Dashboard:**

```
Admin Panel → Infrastructure → Nodes → Provisioning: worker-nbg1-3

Step                        Status      Elapsed
─────────────────────────────────────────────────
1. Create VPS instance      ✓ Done      12s
2. Wait for RUNNING state   ✓ Done      38s
3. NetBird agent installed  ✓ Done       8s
4. Node joined WireGuard    ✓ Done       3s
5. k3s agent started        ✓ Done      22s
6. Node Ready (kubectl)     ✓ Done      15s
7. Labels applied           ✓ Done       1s
8. Longhorn enrolled        ⟳ Running   …
─────────────────────────────────────────────────
Total elapsed: 1m 39s
```

**WebSocket Updates (live):**

Every 2-3 seconds, progress updates push to admin panel:

```json
{
  "provision_job_id": "job_abc123",
  "step": 8,
  "step_name": "Longhorn enrolled",
  "status": "running",
  "elapsed_seconds": 99,
  "log_tail": "Waiting for Longhorn manager to discover node worker-nbg1-3…"
}
```

On completion:
```json
{
  "provision_job_id": "job_abc123",
  "status": "complete",
  "node_name": "worker-nbg1-3",
  "node_ip": "65.21.1.3",
  "region": "eu-frankfurt",
  "elapsed_seconds": 187,
  "message": "Node is Ready and available for workloads."
}
```

#### 5.7.6 Master Node Resource Allocation

**Shared Resources with Limits:**

A master node (k3s server) also acts as a worker in single-node and small setups. To prevent workload pods from starving control-plane components, resource limits are applied:

| Component | CPU request / limit | Memory request / limit |
|-----------|--------------------|-----------------------|
| k3s server process | 200m / 500m | 256Mi / 512Mi |
| etcd (embedded) | 200m / 500m | 512Mi / 1Gi |
| CoreDNS | 100m / 200m | 70Mi / 170Mi |
| metrics-server | 50m / 100m | 30Mi / 100Mi |
| Calico node | 150m / 300m | 64Mi / 256Mi |
| Reserve for OS | — | 512Mi |
| **Available for workloads** | ~800m of 2000m (cx21) | ~1.4Gi of 4Gi |

**Pod scheduling on master:**

By default k3s does not taint master nodes, so workloads schedule there. To restrict which pods run on masters, apply a taint:

```bash
kubectl taint node <master-name> node-role.kubernetes.io/master=:NoSchedule
```

Then add `tolerations` to platform services (Flux, PowerDNS, management API, monitoring) so they can schedule on masters. Client workloads do not have this toleration and therefore will not run on master nodes.

#### 5.7.7 Bootstrap Automation

**Master Bootstrap (Complete Management Stack):**

```bash
# scripts/bootstrap-master.sh
# Run via cloud-init user-data OR manually over NetBird mesh after node is up

#!/usr/bin/env bash
set -euo pipefail
K3S_VERSION="v1.29.3+k3s1"
REGION="${1:?Region required (e.g. eu-frankfurt)}"

# 1. Install k3s server (control plane + embedded etcd)
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=$K3S_VERSION sh -s - server \
  --cluster-init \
  --flannel-backend=none \
  --disable-network-policy \
  --disable=traefik \
  --node-label="region=$REGION,role=master"

# 2. Install Calico CNI
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/tigera-operator.yaml
kubectl apply -f /opt/bootstrap/calico-installation.yaml

# 3. Bootstrap Flux v2 (GitOps)
flux bootstrap github \
  --owner=hosting-platform \
  --repository=hosting-platform \
  --branch=main \
  --path="k8s/overlays/$REGION" \
  --personal

# 4. Apply Sealed Secrets controller (Flux reconciles the rest)
kubectl apply -f /opt/bootstrap/sealed-secrets-controller.yaml

# 5. Wait for platform namespace to be Ready
kubectl wait --for=condition=ready pod -l app=management-api -n platform --timeout=300s

echo "Master bootstrap complete for region: $REGION"
```

**Worker Bootstrap:**

```bash
# scripts/bootstrap-worker.sh
# Run via cloud-init user-data

#!/usr/bin/env bash
set -euo pipefail
K3S_SERVER_URL="${1:?K3S server URL required}"
K3S_TOKEN="${2:?K3S token required}"
REGION="${3:?Region required}"

curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.29.3+k3s1" sh -s - agent \
  --server="$K3S_SERVER_URL" \
  --token="$K3S_TOKEN" \
  --node-label="region=$REGION,role=worker" \
  --kubelet-arg=node-labels="region=$REGION,role=worker"

echo "Worker bootstrap complete, joined $K3S_SERVER_URL"
```

#### 5.7.8 Failure Handling

**Provisioning Failure Scenario:**

If any provisioning step fails (e.g. cloud provider API timeout, k3s join timeout), the WebSocket push delivers:

```json
{
  "provision_job_id": "job_abc123",
  "status": "failed",
  "failed_step": 5,
  "failed_step_name": "k3s agent started",
  "error": "Timeout: node did not appear in kubectl get nodes within 10 minutes",
  "vps_id": "htz-12345",
  "vps_ip": "65.21.1.3"
}
```

Admin options after failure:
- **Retry from step** — management API re-runs the bootstrap script on the existing VPS.
- **SSH Diagnose** — admin copies the node IP and SSHes via NetBird mesh to inspect manually.
- **Destroy and restart** — `DELETE /api/v1/admin/cloud-servers/{vps_id}` removes the VPS from the cloud provider and cleans up the provisioning job record.

**Failure Prevention:**

- Cloud provider API calls use exponential backoff (3 retries, 2s/4s/8s delays).
- k3s join timeout is 10 minutes; node-ready timeout is an additional 5 minutes.
- If NetBird agent fails to join the mesh, all subsequent steps are skipped (k3s cannot reach the API server safely without the mesh).
- All provisioning events are logged to `audit_logs` with structured fields (`provider`, `vps_id`, `step`, `error`).

#### 5.7.9 Server Decommissioning with Safety Checks

**Decommission Flow:**

1. Admin Panel → Infrastructure → Nodes → Select node → **Decommission**.
2. Management API runs pre-flight safety checks:
   - Node has 0 client workloads running (`kubectl get pods -n <client-ns> --field-selector=spec.nodeName=<node>`).
   - No Longhorn replicas are on this node that don't have copies elsewhere.
   - Node is not the only control-plane node in the cluster (masters only).
3. If checks pass: `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data` (after ADR-014 DNS drain: remove node IP from DNS, wait 60s TTL).
4. `kubectl delete node <node>`.
5. Delete cloud VPS via provider API.
6. Update `nodes` table: `status = decommissioned`.
7. Audit log: `NODE_DECOMMISSION_COMPLETE`.

If pre-flight checks fail, the admin is shown which workloads or Longhorn replicas must be migrated first.

#### 5.7.10 Monitoring and Metrics

**What's Tracked:**

| Metric | Source | Stored in |
|--------|--------|-----------|
| Provisioning duration per step | Management API timer | `provisioning_jobs` table |
| VPS hourly/monthly cost | Cloud provider API (price list) | `cloud_servers` table |
| Node CPU/memory utilisation | Prometheus node-exporter | Prometheus TSDB |
| Node disk usage (Longhorn) | Longhorn metrics | Prometheus TSDB |
| Provisioning success rate | Count of `status=complete` vs `status=failed` | `provisioning_jobs` table |

**Admin Dashboard Widgets:**

| Widget | Location | Description |
|--------|----------|-------------|
| Node count by region | Infrastructure overview | Running / total per region |
| Node health heatmap | Infrastructure overview | Red/yellow/green per node |
| Provisioning history | Infrastructure → Nodes | Last 10 provisioning jobs with status |
| Cost by provider | Infrastructure → Cost | Monthly cost breakdown by cloud provider |
| Capacity remaining | Infrastructure overview | Free CPU/memory across all worker nodes |

#### 5.7.11 Cost Estimation & Tracking

**Cost Estimate Display:**

When an admin selects a provider + region + instance type in the provisioning form, the management API queries a local price list (updated weekly from provider APIs) and shows:

```
Instance: Hetzner cx31 (Frankfurt)
  vCPU: 2    RAM: 8 GB    Disk: 80 GB SSD
  Cost: €0.013/hour → ~€9.49/month

Additional volumes (Longhorn storage):
  200 GB Hetzner Volume: €0.042/GB/month → ~€8.40/month

Estimated total: ~€17.89/month
```

**Cost tracking after provisioning:**

Each cloud server record in the `cloud_servers` table includes `hourly_cost_eur`, `provisioned_at`, and `decommissioned_at`. A monthly cost summary query:

```sql
SELECT
  provider,
  SUM(hourly_cost_eur * EXTRACT(EPOCH FROM (COALESCE(decommissioned_at, NOW()) - provisioned_at)) / 3600) AS total_eur
FROM cloud_servers
WHERE provisioned_at >= date_trunc('month', NOW())
GROUP BY provider;
```

This feeds the **Infrastructure → Cost** dashboard in the admin panel.

#### 5.7.12 Control Panel UI Components

**New Admin Panel Sections:**

| Section | Path | Description |
|---------|------|-------------|
| **Node List** | Infrastructure → Nodes | Table: name, region, provider, role, status, CPU%, memory%, cost/mo, actions |
| **Add Node Wizard** | Infrastructure → Nodes → Add | 4-step wizard: role → provider → instance type → confirm |
| **Provisioning Progress** | Infrastructure → Nodes → {job_id} | Live step tracker with WebSocket feed |
| **Cloud Credentials** | Infrastructure → Cloud Credentials | Add/edit/delete provider credentials; status indicators |
| **Decommission Modal** | Triggered from Node List | Pre-flight check results + confirm/cancel |
| **Cost Dashboard** | Infrastructure → Cost | Monthly cost by provider; estimated cost for current month |

See `ADMIN_PANEL_REQUIREMENTS.md §VP.2` for the full feature table and API endpoint list.

#### 5.7.13 API Endpoints for Provisioning

**REST API for VPS Provisioning:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/cloud-credentials` | List all configured cloud provider credentials (no secrets returned) |
| `POST` | `/api/v1/admin/cloud-credentials` | Add new credential set (`provider`, `label`, `credentials` object); validates against provider API |
| `PATCH` | `/api/v1/admin/cloud-credentials/{id}` | Update label or credential values; re-validates on save |
| `DELETE` | `/api/v1/admin/cloud-credentials/{id}` | Delete credential set (blocked if nodes are provisioned with it) |
| `GET` | `/api/v1/admin/cloud-providers/{provider}/regions` | List available regions for a provider (requires valid credential) |
| `GET` | `/api/v1/admin/cloud-providers/{provider}/instance-types` | List instance types with specs + hourly cost for a given region |
| `POST` | `/api/v1/admin/cloud-servers` | Provision new VPS (`credential_id`, `region`, `instance_type`, `role`: `worker`\|`master`, `node_label`) — returns `provision_job_id` |
| `GET` | `/api/v1/admin/cloud-servers` | List all provisioned cloud servers with status, cost, region |
| `GET` | `/api/v1/admin/cloud-servers/{vps_id}` | Server detail: node name, IP, cost, Longhorn status, workload count |
| `GET` | `/api/v1/admin/provisioning-jobs/{job_id}` | Poll provisioning progress (step, status, elapsed, log_tail) |
| `POST` | `/api/v1/admin/provisioning-jobs/{job_id}/retry` | Retry from last failed step |
| `DELETE` | `/api/v1/admin/cloud-servers/{vps_id}` | Decommission server: drain, delete node, destroy VPS (pre-flight checks enforced) |
| `GET` | `/api/v1/admin/infrastructure/cost-summary` | Monthly cost by provider for current and last 3 months |

---

## 6. Storage & Databases

### 6.1 Database Strategy — Shared Instances

> **Revised decision:** Shared database instances with per-client databases, replacing the
> earlier dedicated-pod-per-client model. This reduces pod count by ~200-400 and saves
> significant resources. Isolation is maintained at the database and user level.

#### Shared MariaDB

| Parameter              | Initial (No HA)                                | HA Upgrade (Optional)                    |
| ---------------------- | ---------------------------------------------- | ---------------------------------------- |
| Deployment             | **1 single instance** in `platform` namespace  | 1 primary + 1 replica                   |
| Operator               | **Percona Operator for MariaDB** (production-grade, widely used) | Same operator, enable replication |
| Per-client isolation   | Separate database + dedicated MariaDB user per client | Same                              |
| Client credentials     | Auto-generated, stored in client namespace Secret | Same                                |
| Connection             | ClusterIP service; client pods connect via service DNS | Same (failover handled by operator) |
| Resource allocation    | 1-2 vCPU, 2-4Gi RAM                            | 2-4 vCPU, 4-8Gi RAM per instance       |
| Storage                | 50-100Gi PV                                    | 100-200Gi PV (Longhorn replicated)      |
| Max connections        | **Configure after load testing** (empirical approach) | Same; determine from actual usage patterns |

#### Shared PostgreSQL

| Parameter              | Initial (No HA)                                | HA Upgrade (Optional)                    |
| ---------------------- | ---------------------------------------------- | ---------------------------------------- |
| Deployment             | **1 single instance** in `platform` namespace  | 1 primary + 1 replica                   |
| Operator               | **CloudNativePG** (cloud-native design, excellent HA features) | Same operator, enable replication       |
| Per-client isolation   | Separate database + dedicated PG role per client | Same                                  |
| Client credentials     | Auto-generated, stored in client namespace Secret | Same                                |
| Connection             | ClusterIP service; client pods connect via service DNS | Same (failover handled by operator) |
| Resource allocation    | 1-2 vCPU, 2-4Gi RAM                            | 2-4 vCPU, 4-8Gi RAM per instance       |
| Storage                | 50-100Gi PV                                    | 100-200Gi PV (Longhorn replicated)      |

#### Client-Side Database Access

> **NetworkPolicy** explicitly allows client pods to reach the shared DB services in
> the `platform` namespace on the MariaDB/PG ports only.

#### Upgrade Path to Dedicated DB

For Premium/Custom plan clients who need dedicated databases:
- Provision a dedicated MariaDB/PG StatefulSet in their client namespace
- Migrate their data from the shared instance
- Update their pod's DB connection config

This allows starting cheap and upgrading per-client as needed.

### 6.2 Caching Layer — Shared Redis

| Parameter              | Initial                                        | HA Upgrade (Optional)                    |
| ---------------------- | ---------------------------------------------- | ---------------------------------------- |
| Deployment             | **1 Redis instance** in `platform` namespace   | Redis Sentinel or Redis Cluster          |
| Resource allocation    | 0.5 vCPU, 512Mi-1Gi RAM                        | 1 vCPU, 1-2Gi RAM                       |
| Per-client isolation   | Redis ACLs: each client gets a dedicated user with key prefix restriction (`client-{id}:~*`) | Same |
| Memory quota per client| Enforced via application-level tracking (Redis doesn't natively quota per-prefix) | Same |
| Eviction policy        | allkeys-lru                                     | Same                                    |
| Use cases              | WordPress object cache, PHP sessions, app cache  | Same                                   |
| Premium plan           | Dedicated Redis pod in client namespace (256Mi)  | Same                                   |

### 6.3 Persistent Storage

| Storage Type           | Technology                            | Notes                         |
| ---------------------- | ------------------------------------- | ----------------------------- |
| Block storage (PVs)    | Local path provisioner or Longhorn    | Client site files             |
| Media/branding storage | Longhorn PV (local persistent volume) | Logos, favicons, branding assets |
| Shared filesystem      | NFS (for SFTP gateway access to PVs) | SFTP needs to mount client PVs |

> **Longhorn** is recommended as the storage backend for self-managed K8s — it provides
> replicated block storage, snapshots, and backup-to-S3 capability without external dependencies.

### 6.4 Data Backup Strategy

#### Cluster-Managed Backups (Platform Responsibility)

| Parameter               | Value                                          |
| ----------------------- | ---------------------------------------------- |
| Backup frequency (DB)   | Daily automated (full dump per client DB from shared instance) |
| Backup frequency (files)| Daily incremental                              |
| Backup frequency (K8s state) | Daily (Velero snapshots)                    |
| Retention period        | Configurable per plan (global default, per-client override) |
| Backup tool (K8s state) | Velero                                         |
| Backup tool (DB)        | CronJob: mysqldump / pg_dump → offsite server (SSHFS mount) |
| Backup tool (files)     | rsync --archive → offsite server (SSHFS mount)  |
| Backup encryption       | Encrypted at rest (AES-256) before upload       |
| Backup storage          | Offsite backup server (SSHFS mount via NetBird mesh) |
| Cost model              | Platform-managed (not charged to customers, included in all plans) |

#### Customer-Created Independent Backups

| Parameter               | Value                                          |
| ----------------------- | ---------------------------------------------- |
| Backup creation         | Manual triggers OR customer-defined schedules (hourly/daily/weekly/monthly) |
| Backup types supported  | Full / Incremental / Differential               |
| Backup tool             | On-demand CronJob: mysqldump / pg_dump / file snapshots |
| Retention               | Customer-configured (7 / 14 / 30 / 90 / 365+ days) |
| Backup storage          | Offsite server (customer-backups/ directory) — within customer's disk quota |
| Quota impact            | **Fully counted** against customer's overall storage limit |
| Cost model              | Included in storage tier (customer pays for quota they use) |
| Use cases               | Before major updates, before migrations, compliance requirements, custom retention |

#### Offsite Backup — Mount-Based Direct Write

All **cluster-managed backups** are written directly to an **external backup server** mounted via SSHFS
during the backup window. This avoids storing a second copy locally, conserving cluster disk space.

**Note:** Customer-created backups are stored on the offsite backup server (`customer-backups/` directory) within customer quota. Customers can request backup exports for external archival.

| Parameter                   | Value                                          |
| --------------------------- | ---------------------------------------------- |
| Offsite transport           | **SSHFS** (SSH filesystem mount via NetBird mesh) |
| Offsite destination         | External server (different provider / location) |
| Mount schedule              | Mount at start of backup window, unmount when done |
| What gets written           | DB dumps, file backups, Velero snapshots, DNS zones, email data — directly to mount |
| Mount method                | CronJob: `sshfs` mount → backup scripts write to mount path → `fusermount -u` unmount |
| Authentication              | SSH key-based (no passwords), via NetBird mesh   |
| Encryption                  | Backups encrypted (AES-256) before write; SSH tunnel for transport |
| Retention (offsite)         | Mirror local retention policy per client         |
| Local disk impact           | **Near zero** — no local backup copy stored; only temporary working files during backup |
| Verification                | SHA-256 checksum verification after write        |
| Alert on failure            | Alertmanager notification if mount fails or backup write fails |

**Backup flow:**

```
1. CronJob starts (2 AM UTC)
2. Mount: sshfs backup@backup-server:/backups /mnt/offsite -o IdentityFile=/tmp/id_rsa
3. DB dumps write directly to /mnt/offsite/daily/<date>/databases/
4. File backups (rsync --archive) write to /mnt/offsite/daily/<date>/files/
5. Config exports write to /mnt/offsite/daily/<date>/config/
6. Encryption pass over written files (AES-256 in-place)
7. Unmount: fusermount -u /mnt/offsite
8. CronJob exits — no local disk consumed
```

> **Admin configuration:** The offsite backup server is configured globally in the
> platform settings (host, port, SSH key, remote path). The Management API stores the
> SSH private key in Vault / Sealed Secret. The backup server is accessed via NetBird
> mesh (not exposed on public internet).

### 6.4.1 Backup Storage Quota & Accounting

Customer-created backups consume space within each customer's **overall disk quota**. This ensures backup storage doesn't consume unlimited platform resources and encourages customers to manage retention policies.

#### Storage Accounting Model

| Backup Type                | Storage Count | Cost Model                                    |
| -------------------------- | ------------- | --------------------------------------------- |
| **Cluster-managed backups** | NO            | Free to customers; charged to platform operations |
| **Customer-created backups**| **YES**       | Fully counted toward customer storage quota   |

#### Quota Tracking & Display

**In Customer Panel:**
- Storage usage breakdown: "Site files: 25GB, Databases: 10GB, Customer backups: 15GB (of 100GB total)"
- Per-backup size visible in backup list: "Backup from 2026-02-27: 8.5GB"
- Warnings: "You are using 87% of storage. Customer backups consume 15GB."
- Warning threshold: Alert when customer backups exceed 50% of remaining available quota

**In Admin Panel:**
- Bulk storage quota updates: "Add 50GB storage to 100 Starter plan clients"
- Per-client breakdown: "Client ABC using 95GB (94 MB in backups), 2 backups total"
- Storage trend chart: Shows growth of backup storage vs site files month-over-month

#### Quota Enforcement

| Scenario | Behavior |
| -------- | -------- |
| Customer at quota | Cannot create new backups; must delete old backups or upgrade plan |
| Customer approaching quota (90%+) | Alert in panel: "Limited backup storage remaining" |
| Backup would exceed quota | Backup creation fails; error message: "Backup would exceed storage limit. Delete backups or upgrade plan." |
| Manual backup trigger | Check quota **before** creating backup; fail gracefully if insufficient space |
| Scheduled backup trigger | Skip backup if quota exceeded; log error and send customer alert |

#### Retention & Cleanup

| Action | Details |
| ------ | ------- |
| **Automatic cleanup** | Retention cleanup script (`find` + `rm`) auto-deletes expired customer backups per retention setting (customer-configurable) |
| **Manual deletion** | Customers can manually delete backups to free quota space |
| **Bulk cleanup** | Admin can force-delete old customer backups (with warning) to reclaim space |
| **Billing notification** | If customer deletes backups to avoid quota overages, no refund (backup consumption was during paid period) |

#### Upgrade Path

If customer exceeds quota with backups:
1. Customer receives alert: "Storage quota exceeded. Upgrade your plan to continue creating backups."
2. Customer can upgrade: Starter → Business (e.g., 100GB → 500GB)
3. New quota applied immediately; customer can resume backups
4. Billing prorated if upgrade happens mid-cycle

### 6.5 Storage Cost Optimization

| Strategy                          | Impact                                    |
| --------------------------------- | ----------------------------------------- |
| Shared DB storage vs. per-client PVs | ~200 fewer PVs, ~90% less DB storage overhead |
| Longhorn thin provisioning        | Storage allocated on write, not on claim   |
| Retention cleanup script (`find` + `rm`) | Auto-delete old backups per client retention setting |
| Compress backups (gzip/zstd)      | 50-80% backup size reduction               |
| rsync --archive with hardlinks    | Incremental = unchanged files linked, not copied |
| Offsite SFTP retention mirroring  | Offsite mirrors local retention — no excess storage cost |

---

## 7. Security & Access Control

### 7.1 Authentication — OpenID Connect (OIDC)

Client and admin authentication for the management panel and related services uses
**OpenID Connect** with support for Google and Apple accounts.

| Component                 | Decision                                          |
| ------------------------- | ------------------------------------------------- |
| **OIDC Provider**         | **Dex** (lightweight IdP federation) — see [Section 0.3](#03-security--authentication) |
| Supported providers       | Google, Apple (via OIDC)                          |
| Local accounts            | Optional fallback — email/password via OIDC provider |
| Admin authentication      | OIDC with admin role claim                        |
| Client authentication     | OIDC with client role claim, scoped to their namespace |
| Session management        | JWT tokens with short expiry + refresh tokens     |
| MFA                       | Delegated to OIDC provider (Google/Apple handle MFA) |

**Flow:**
1. Client visits management panel
2. Redirected to OIDC provider (Google/Apple sign-in)
3. On success, JWT issued with claims: `role`, `client_id`, `namespace`
4. Management API validates JWT on every request
5. API enforces namespace-scoped access based on claims

### 7.2 Intrusion Detection — fail2ban

fail2ban operates at **multiple layers** to protect both the platform and client sites.

| Layer                  | Implementation                                     |
| ---------------------- | -------------------------------------------------- |
| **Ingress (HTTP)**     | fail2ban DaemonSet reading ingress controller access logs; bans IPs with repeated 401/403/brute-force patterns |
| **SFTP**               | fail2ban monitoring SFTP gateway auth logs; bans after N failed login attempts |
| **SSH (node-level)**   | Host-level fail2ban on each K8s node (not containerized) |
| **Mail**               | fail2ban integrated in Docker-Mailserver (built-in support) |
| **Management Panel**   | Rate limiting at OIDC proxy + fail2ban on auth failure logs |
| **Ban storage**        | Centralized ban list in shared Redis (`f2b:banned:{ip}`) to propagate bans across all nodes/pods |
| **Ban duration**       | Progressive: 10min -> 1hr -> 24hr -> permanent (configurable) |
| **Whitelist**          | Admin IPs and monitoring probes excluded            |

### 7.3 Web Application Firewall (WAF) — Optional

An optional WAF layer at the ingress controller to protect client sites from common web attacks.

| Decision                | Value                                              |
| ----------------------- | -------------------------------------------------- |
| **WAF engine**          | **ModSecurity** (with NGINX Ingress) — see [Section 0.3](#03-security--authentication) |
| Rule set                | OWASP Core Rule Set (CRS) v4                       |
| Mode                    | Detection-only initially; switch to blocking after tuning |
| Per-client toggle       | Clients can enable/disable WAF via management panel |
| Custom rules            | Admin-defined global rules + per-client overrides   |
| Logging                 | WAF events logged to Loki, visible in Grafana       |

### 7.4 Kubernetes RBAC & Access Management

| Area                    | Approach                                           |
| ----------------------- | -------------------------------------------------- |
| Cluster admin           | Limited to ops team — OIDC-authenticated kubectl   |
| Client access           | No direct K8s access — all via management panel    |
| Service accounts        | Per-service, least privilege, per namespace         |
| Admin kubectl access    | OIDC-authenticated via kube-apiserver OIDC config   |

### 7.5 Secrets Management

| Decision                | Value                                              |
| ----------------------- | -------------------------------------------------- |
| **Secrets backend**     | **Sealed Secrets** (GitOps-friendly, simple) — see [Section 0.3](#03-security--authentication) |
| DB credentials          | Auto-generated per client, stored in namespace Secret, rotated via Management API |
| SFTP credentials        | Auto-generated, stored in namespace Secret         |
| TLS certificates        | Managed by cert-manager (not stored manually). Primary: Let's Encrypt. Fallback: ZeroSSL. See SECRETS_MANAGEMENT.md for ClusterIssuer configs. |
| OIDC client secrets     | Stored in Sealed Secret                            |
| Rotation policy         | DB passwords: 90 days; SFTP: on request; API keys: 30 days |
| Injection method        | Environment variables + volume mounts (no sidecars initially) |

### 7.6 Network Security

- [ ] Default-deny NetworkPolicy in every client namespace
- [ ] Ingress controller is the **only** external HTTP entry point to client pods
- [ ] Cross-namespace client traffic blocked (client-a cannot reach client-b)
- [ ] Client pods allowed to reach shared DB/Redis in `platform` namespace (specific ports only)
- [ ] Platform services access client namespaces via explicit NetworkPolicy rules
- [ ] TLS termination at ingress controller (HTTPS everywhere)
- [ ] mTLS between platform services — **Deferred to Phase 2** (start with NetworkPolicy, upgrade if service mesh needed)
- [ ] Egress controls: client pods restricted to DNS + shared services by default; internet access opt-in per client
- [ ] DDoS mitigation: rate limiting at ingress + optional upstream protection (Cloudflare proxy)

### 7.7 Container Security

- [ ] All client workloads run **admin-managed catalog images only** — no client-supplied images
- [ ] Images scanned with **Trivy** on every build before publishing to catalog
- [ ] Base images: **Alpine-based** for all catalog containers and platform services
- [ ] Pod security: Kubernetes **Pod Security Standards** set to `restricted` for platform, `baseline` for client workloads
- [ ] No privileged containers — all pods run as non-root where possible
- [ ] Read-only root filesystem for platform services; client pods get writable PV mount only
- [ ] Runtime security: **Basic Pod Security Standards only** (MVP); Falco evaluation in Phase 2
- [ ] Image pull policy: `Always` for platform; `IfNotPresent` for catalog images (pinned by digest)
- [ ] No `exec` into client pods via kubectl — disabled for non-admin RBAC roles

### 7.8 Compliance

| Requirement | Applies? | Notes                                       |
| ----------- | -------- | ------------------------------------------- |
| GDPR        | Likely   | If hosting EU client data — data residency, right to deletion |
| PCI-DSS     | **Not required (MVP)** | Defer until/if clients process payments |
| SOC 2       | **Not required (MVP)** | Defer until/if enterprise clients require it |
| HIPAA       | Unlikely | Unless hosting healthcare clients            |

---

## 8. CI/CD & Deployment

### 8.1 Container Registry

| Decision              | Value                                            |
| --------------------- | ------------------------------------------------ |
| **Registry**          | **Harbor** (self-hosted, Trivy scanning) — see [Section 0.7](#07-cicd--container-registry) |
| Image tagging scheme  | `catalog/<id>:<version>-<YYYYMMDD>` (e.g., `catalog/apache-php84:1.2.0-20260227`) |
| **Vulnerability scan**| **Trivy** (on every build, integrated with Harbor) — see [Section 0.7](#07-cicd--container-registry) |
| Retention policy      | Keep last 5 versions per catalog entry           |
| Image signing         | **Skip for MVP** (cosign/supply chain security deferred to Phase 2) |

### 8.2 Platform Service Pipeline

> _CI/CD for the platform services themselves (management API, controllers, etc.)._

| Stage           | Tool / Action                                    |
| --------------- | ------------------------------------------------ |
| Source control   | GitHub or Gitea (self-hosted option)            |
| **CI runner**    | **Gitea Actions** (if self-hosted) or **GitHub Actions** — see [Section 0.7](#07-cicd--container-registry) |
| Build            | Docker multi-stage builds                       |
| Test             | Unit + integration tests                        |
| **Image scan**   | **Trivy** (integrated with Harbor)              |
| Image push       | To Harbor registry                              |
| **Deploy**       | **Flux v2** (GitOps) — see [Section 0.7](#07-cicd--container-registry) |
| Rollout strategy | Rolling update (platform services)               |

### 8.3 Catalog Image Pipeline

> _CI/CD for building and publishing workload catalog images._

### 8.4 Client Site Deployment — Three Methods (No Build Step)

> _Clients deploy by placing files in their PersistentVolume. The container (shared or
> dedicated) serves whatever files are in the volume. No container builds happen per-client.
> All three methods work identically for both Starter (shared pod) and Business/Premium
> (dedicated pod) clients — the PV is the same regardless of deployment mode._

#### Method 1: SFTP Upload

1. Client connects via SFTP to the SFTP gateway
2. Gateway maps client credentials to their PersistentVolume
3. Files uploaded directly to the volume mount
4. Files are immediately live (volume is mounted in web pod)
5. No build step — traditional shared hosting experience

#### Method 2: Git-Based File Sync

1. Client pushes to their Git repository (hosted on platform or external)
2. Webhook triggers the **Git Deploy Service**
3. Service clones repo and **syncs files to the client's PV** (rsync-style)
4. No container build — just file sync
5. Rollback available by reverting Git commit and re-syncing

#### Method 3: Web File Manager

1. Client logs into management panel
2. Opens web-based file manager (FileBrowser or similar)
3. Upload, edit, delete files directly in the browser
4. Changes are live immediately (same PV as SFTP)

### 8.5 Client Onboarding Automation

> _What happens when a new client is provisioned via the management panel:_

#### All Plans (Common Steps)

1. Management API creates `client-{name}` namespace
2. NetworkPolicy applied (default-deny + allow ingress + allow shared services)
3. PersistentVolumeClaim created for site files
4. Database and user created on shared MariaDB or PostgreSQL instance
5. Redis ACL user created on shared Redis (with key prefix restriction)
6. Ingress rule created for client domain(s)
7. cert-manager Certificate resource created (Let's Encrypt)
8. DNS records created via DNS controller
9. SFTP credentials generated and stored in namespace Secret
10. DB credentials stored in namespace Secret
11. OIDC account linked (client can log into panel)
12. Email account(s) provisioned on Docker-Mailserver (if `max_email_accounts > 0`)
13. Application password auto-generated for each email account, stored in namespace Secret (admin-readable)
14. Webmail ingress created for client domain (e.g., `webmail.client.com`) if `webmail_domain` set
15. Welcome email sent with credentials (including email app password) and panel URL

#### Starter Plan (Additional Steps)

13. Client's PV mounted into the shared Apache+PHP pod pool at `/mnt/clients/client-{id}/`
14. VirtualHost config generated and added to shared pod ConfigMap
15. PHP-FPM pool created for client with `open_basedir` restriction
16. Apache gracefully reloaded in shared pod

#### Business / Premium / Custom Plan (Additional Steps)

13. ResourceQuota and LimitRange applied based on hosting plan
14. ServiceAccount created with namespace-scoped RBAC
15. Dedicated web pod deployed using **client-selected catalog image**
16. _(Premium only)_ Dedicated Redis pod provisioned in client namespace
17. _(Premium/Custom only)_ Optional: dedicated DB provisioned in client namespace

### 8.6 GitOps for Platform

| Decision              | Value                                            |
| --------------------- | ------------------------------------------------ |
| GitOps controller     | **Flux v2** (lightweight, GitOps-native, more flexible than ArgoCD) |
| Repository structure  | Monorepo with per-service Helm charts + per-client overlays |
| Deployment method     | Helm charts for platform services; Kustomize overlays for client namespaces |
| Rollback mechanism    | Flux auto-sync rollback or manual Git revert   |

---

## 9. Management Panels

> _The Management Panels (admin and client) are the primary user interfaces for the platform.
> They must be modern, fast-loading, responsive, and support light/dark modes with customizable
> branding. This section covers UI/UX requirements, architecture, and implementation approach._

### 9.1 Overview

The platform provides **two integrated panels** accessible via web browser:

| Panel                  | Audience                                              | Key Functions                                          |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| **Admin Panel**        | Platform administrators and ops team                  | Client management, plan/quota management, system monitoring, email/DNS/SSL management, app/image updates, settings |
| **Client Panel**       | Hosting clients (one panel per client account)        | Site management, domain management, files, databases, email, backups, support tickets, billing |

Both panels share the same codebase (single-page application) but use role-based access control (RBAC) to expose different features. The panels are accessed at different URLs (admin.platform.com vs panel.client-domain.com or panel.platform.com).

### 9.2 UI/UX Requirements

#### 9.2.1 Design System

| Requirement            | Specification                                        |
| ---------------------- | ---------------------------------------------------- |
| **Framework**          | Modern responsive design system (Material Design 3, Tailwind, shadcn/ui, or similar) |
| **Light mode**         | Default — high contrast, accessibility compliant (WCAG AA+) |
| **Dark mode**          | Full dark theme with inverted colors and reduced eye strain |
| **Accent color**       | Configurable per platform instance (HSL values stored in Vault) |
| **Logo/branding**      | Custom logo upload, favicon, platform name, footer text (stored on Longhorn PV) |
| **Typography**         | System font stack (sans-serif: -apple-system, Segoe UI, Roboto) for fast rendering; monospace for code/CLI examples |
| **Spacing/layout**     | Consistent 8px grid; responsive breakpoints: mobile, tablet, desktop, wide |
| **Animations**         | Smooth CSS transitions (200-300ms); fade-in on load; no jank on scrolling/resizing |
| **Accessibility**      | Keyboard navigation, ARIA labels, color contrast, focus indicators |

#### 9.2.2 Color Theming System

Theming is fully dynamic and configurable without code changes:

| Element                | Light Mode Default      | Dark Mode Default       | Customizable? |
| ---------------------- | ----------------------- | ----------------------- | ------------- |
| **Primary accent**     | #0066cc (blue)          | #6699ff                 | **Yes** — admin sets HSL |
| **Success**            | #28a745 (green)         | #5fcf7f                 | Derived from primary |
| **Warning**            | #ff9800 (orange)        | #ffb74d                 | Derived from primary |
| **Danger**             | #dc3545 (red)           | #ff6b6b                 | Derived from primary |
| **Background (light)** | #ffffff                 | #1a1a1a                 | Fixed per mode |
| **Surface (light)**    | #f5f5f5                 | #2d2d2d                 | Fixed per mode |
| **Text (light)**       | #1a1a1a                 | #e0e0e0                 | Fixed per mode |
| **Border (light)**     | #e0e0e0                 | #404040                 | Fixed per mode |

**How it works:**

The theming system uses **CSS custom properties** (variables) defined on `:root`. All component styles reference these variables rather than hardcoded colour values. When an admin changes the primary accent colour, a single CSS variable update cascades to every button, link, badge, and chart in the panel:

```css
/* Generated by the admin branding system and injected as a <style> tag */
:root {
  --color-primary:      hsl(210, 100%, 40%);   /* admin-chosen hue/saturation/lightness */
  --color-primary-hover: hsl(210, 100%, 35%);
  --color-success:      hsl(134, 61%, 41%);
  --color-warning:      hsl(36, 100%, 50%);
  --color-danger:       hsl(354, 70%, 54%);
  --color-surface:      #ffffff;
  --color-surface-alt:  #f5f5f5;
  --color-text:         #1a1a1a;
  --color-border:       #e0e0e0;
  --font-family-base:   'Inter', system-ui, sans-serif;
}
```

Dark mode overrides the surface, text, and border variables via `@media (prefers-color-scheme: dark)` and a `[data-theme="dark"]` attribute toggle. The primary accent (admin-chosen) remains the same in both modes but is lightened automatically by +15% lightness for dark mode readability.

The CSS variable block is served from `GET /api/v1/platform/theme.css` — a dynamic endpoint that reads the `platform_settings` table and generates the CSS block. The admin and client panel `<head>` include this as a linked stylesheet, so theme changes take effect on next page load (< 1 second cache TTL for this endpoint).

**Admin branding configuration:**

Admins set the platform theme in **Settings → Branding**:

| Setting | Input | Notes |
|---------|-------|-------|
| **Primary accent colour** | HSL colour picker (hue 0–360, saturation 0–100%, lightness 20–70%) | Saved as HSL values; saturation/lightness constrained to ensure WCAG AA contrast ratio ≥ 4.5:1 |
| **Platform name** | Text field (max 40 chars) | Shown in browser tab title, email footers, login page |
| **Logo (light mode)** | PNG/SVG upload (max 200KB) | Displayed in sidebar header; SVG preferred for crisp scaling |
| **Logo (dark mode)** | PNG/SVG upload (max 200KB) | Optional — if absent, light logo is used on dark background |
| **Favicon** | ICO/PNG upload (max 32×32px) | Used as browser tab icon |
| **Footer text** | Textarea (max 200 chars) | Shown in email notification footers |
| **Login page background** | Solid colour or image URL | Optional branding for the Dex OIDC login page |

Changes are saved to `platform_settings` table and take effect immediately (next page load). There is no deploy step required — the CSS endpoint reads live from the database.

#### 9.2.3 Performance Requirements

| Metric                 | Target           | Optimization Strategy                             |
| ---------------------- | ---------------- | ------------------------------------------------- |
| **First Contentful Paint (FCP)** | < 1.5s | Code splitting, lazy loading, critical CSS inline |
| **Largest Contentful Paint (LCP)** | < 2.5s | Optimized images, font loading strategy          |
| **Cumulative Layout Shift (CLS)** | < 0.1   | Fixed heights, skeleton screens, no layout thrashing |
| **Time to Interactive (TTI)** | < 3s    | Minimal main thread blocking, efficient JS       |
| **Initial bundle size**| < 150KB gzipped   | Tree shaking, code splitting per route           |
| **Repeat visit (cached)**| < 500ms   | Service worker, HTTP cache headers               |
| **API response time** | < 200ms p50, < 500ms p95 | Database query optimization, caching layer |

**Optimization techniques:**

- **Code splitting**: Separate bundles per route (admin vs client features)
- **Lazy loading**: Images with `loading="lazy"`, components loaded on-demand
- **Asset compression**: gzip/brotli for JS, CSS; WebP for images
- **Caching strategy**: Service worker for offline access, HTTP ETag headers
- **Font loading**: `font-display: swap`; prefer system fonts
- **Bundle analysis**: Monitor with webpack-bundle-analyzer or Vite equivalent
- **Server-side rendering** (optional): SSR for faster initial load, SEO benefits
- **API batching**: Combine multiple API calls into single request where possible

### 9.3 Frontend Technology Stack

| Layer                  | Technology                                          | Rationale                                         |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------- |
| **Framework**          | **React 18+** (with TypeScript)                     | Mature, large ecosystem, performance optimizations, widespread knowledge |
| **Alternative**        | Vue 3 + TypeScript OR Svelte (lighter, faster)     | Vue: familiar syntax; Svelte: minimal runtime overhead |
| **Build tool**         | **Vite** (not Webpack)                              | ~100x faster dev server, smaller bundle, ESM-first |
| **Styling**            | **Tailwind CSS** + CSS modules                      | Utility-first, dark mode support, fast, low runtime cost |
| **Component library**  | **shadcn/ui** OR **Headless UI** + custom          | Unstyled, accessible components; full control over design |
| **UI icons**           | **Lucide React** OR **Heroicons**                   | High-quality icons, tree-shakeable, small size   |
| **State management**   | **TanStack Query** (data) + **Zustand/Jotai** (UI) | Lightweight, fine-grained control, minimal boilerplate |
| **Form handling**      | **React Hook Form** + **Zod**                       | Minimal re-renders, runtime validation, TypeScript support |
| **Routing**            | **TanStack Router** OR **React Router v6.4+**      | Nested routing, type-safe routes, code splitting |
| **HTTP client**        | **TanStack Query** (data fetching) + Axios/fetch   | Built-in caching, retry logic, request deduplication |
| **Dark mode**          | **next-themes** OR manual context + CSS vars       | System preference detection, persistent user choice |
| **Testing**            | **Vitest** + **React Testing Library**              | Fast, modern, ESM-first, great for components   |
| **E2E testing**        | **Playwright** OR **Cypress**                       | Headless browser testing, visual regression      |
| **Linting**            | **ESLint** + **Prettier**                           | Code quality, consistent formatting              |

### 9.4 Admin Panel Features

The admin panel provides full control over the platform:

#### 9.4.1 Dashboard & Overview

| Widget                 | Data Displayed                                      |
| ---------------------- | --------------------------------------------------- |
| **System health**      | Cluster status, node count, uptime, resource usage |
| **Client summary**     | Total clients, active clients, churn, MRR trend    |
| **Recent activity**    | New clients, plan changes, alerts, incidents       |
| **Alerts & warnings**  | Critical: nodes down, disk full; Warning: storage near limit |
| **Resource usage**     | CPU, memory, storage per namespace + total         |
| **Billing overview**   | MRR, ARR, failed payments, upcoming renewals       |

#### 9.4.2 Client Management

Full CRUD for clients with inline editing:

| Action                 | Description                                        |
| ---------------------- | -------------------------------------------------- |
| **Create client**      | Add new account, set plan, generate credentials    |
| **Edit client**        | Change plan, billing info, overrides, suspension status |
| **View client details**| Domains, sites, email accounts, databases, usage, backups, logs |
| **Override settings**  | Fine-tune any plan parameter for specific client   |
| **Suspend/reactivate**| Disable access (billing or security)              |
| **Delete client**      | Remove account + archive data (configurable retention) |
| **Search/filter**      | By name, domain, plan, status, creation date       |
| **Bulk actions**       | Suspend multiple clients, mass email, plan migration |

#### 9.4.3 Plan Management

Create, edit, duplicate, and manage hosting plans:

| Action                 | Description                                        |
| ---------------------- | -------------------------------------------------- |
| **Create plan**        | Define plan name, all parameters, pricing         |
| **Edit plan**          | Change default values (applies to new clients only) |
| **Clone plan**         | Duplicate existing plan as starting point         |
| **View usage**         | How many clients on each plan, breakdown          |
| **Bulk client update** | Apply new plan settings to all clients on a plan   |
| **Deprecate plan**     | Mark as old; existing clients keep it, new clients can't select |

#### 9.4.4 Email & Domain Management

| Section                | Features                                           |
| ---------------------- | -------------------------------------------------- |
| **Email accounts**     | View all accounts per client, create, delete, reset password |
| **App passwords**      | View plaintext, rotate, revoke; view usage logs    |
| **Domain management**  | Register, verify, transfer, renew; SSL status      |
| **DNS records**        | View/create/edit A, CNAME, MX, TXT, SPF, DKIM     |
| **Email settings**     | Sending limits, bounce handling, blacklist status  |

#### 9.4.5 Bulk Operations (NEW - CRITICAL FOR 100-1000 CLIENTS)

**Critical requirement for scaling beyond 100 clients.** Bulk operations enable admins to perform actions on multiple clients simultaneously without manual one-by-one processing.

| Operation Type | Description | Use Cases |
| ---------------------- | -------------------------------------------------- | -------------------------------------------------- |
| **Bulk Plan Change** | Change subscription plan for multiple clients (filter by current plan, status, etc.) | Promote cohort to higher tier, downgrade overdue clients, seasonal upgrades |
| **Bulk Suspend/Reactivate** | Suspend or reactivate multiple accounts based on criteria | Billing issues, license expiration, policy violations |
| **Bulk Email Quota** | Update email account quota (MB) for multiple clients | Storage upgrade, special promotions |
| **Bulk Storage Quota** | Update storage limit (GB) for multiple clients | Scale infrastructure, promotional offers |
| **Bulk Email Account Creation** | Create email accounts across multiple domains | Account provisioning, onboarding |
| **Bulk Backup Trigger** | Force immediate backup for multiple clients | Before major updates, before migration |
| **Bulk Messaging** | Send notifications to multiple clients | Maintenance windows, policy changes, promotions |
| **Bulk Export** | Export data for multiple clients | Audits, compliance, reporting |
| **Bulk Restore** | Restore data for multiple clients from point-in-time | After data corruption, mass rollback |
| **Bulk Domain Transfer** | Transfer domains in bulk | Registrar migration, mass customer migration |

**Bulk Operation Workflow:**

1. Admin opens **Clients → Bulk Operations** tab.
2. Uses the Advanced Search / filter UI to select a target set (e.g. all Starter plan clients in `eu-frankfurt` with storage usage > 80%).
3. Clicks **Select All** (or manually picks items from the list) → item count badge updates.
4. Chooses an action from the **Bulk Action** dropdown (e.g. "Change Plan").
5. A **Dry Run** is executed first: the API returns which items would be affected, which would fail pre-flight checks, and why. The admin reviews the preview list.
6. Admin confirms → confirmation modal shows: action, item count, estimated duration, and an acknowledgement checkbox for destructive operations.
7. The management API enqueues a bulk job and returns a `job_id`. The WebSocket channel for that `job_id` is opened.
8. The progress modal shows a live count: `Completed: 34 / 100 | Failed: 2 | Skipped: 1`. Each item shows its own status row.
9. On completion: a summary report is shown and downloadable as CSV. Failed items include the error reason.
10. All individual operations within the bulk job are written to `audit_logs` (one entry per client affected).

**Bulk Operation API:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/admin/bulk-operations/dry-run` | Preview a bulk action (`action`, `filter`, `params`) — returns affected count, pre-flight failures, warnings. No changes made. |
| `POST` | `/api/v1/admin/bulk-operations` | Execute a bulk action (same body as dry-run) — returns `job_id` |
| `GET` | `/api/v1/admin/bulk-operations/{job_id}` | Poll job status: `{ status, total, completed, failed, skipped, errors[] }` |
| `GET` | `/api/v1/admin/bulk-operations/{job_id}/report` | Download full per-item result report as JSON or CSV |
| `POST` | `/api/v1/admin/bulk-operations/{job_id}/cancel` | Cancel a running job (items already processed are not rolled back) |
| `GET` | `/api/v1/admin/bulk-operations` | List recent bulk jobs: `action`, `total`, `status`, `started_at`, `completed_at` |

Example request body:

```json
{
  "action": "change_plan",
  "filter": { "plan_id": "starter", "region": "eu-frankfurt", "storage_used_percent_gte": 80 },
  "params": { "target_plan_id": "business", "reason": "Capacity upgrade Q1 2026" }
}
```

**Backend Implementation:**

- Background job queue (Redis Bull, Celery, or similar)
- Async processing (don't block admin UI)
- Real-time WebSocket progress updates
- Error tracking and reporting
- Dry-run mode (preview before executing)
- Undo capability (if operation is reversible)

**Frontend Components:**

- Filter UI (advanced search with saved filters)
- Bulk action dropdown menu
- Confirmation modal with item preview
- Real-time progress modal (WebSocket updates)
- Bulk operation history table
- Error report viewer

**Testing Requirements:**

- Bulk change plan: 50 clients from Starter → Business ✓
- Bulk suspend: 10 overdue clients ✓
- Bulk storage quota: 100 clients +50GB ✓
- Bulk email create: All Starter clients get admin@domain.com ✓
- Dry-run mode: Preview 200 items, confirm count matches ✓
- Error handling: Some items fail, others succeed, report shows both ✓
- Progress tracking: WebSocket updates every 2 seconds ✓

---

#### 9.4.6 Advanced Search & Filtering (NEW - CRITICAL FOR 500+ CLIENTS)

**Critical requirement for managing 500+ clients effectively.**

| Feature | Description |
| ---------------------- | -------------------------------------------------- |
| **Advanced Search** | Search across name, email, domain, company, notes with full-text indexing |
| **Saved Filters** | Save frequently used filter combinations (e.g., "Churning Clients", "Upgrade Targets") |
| **Complex Filters** | Combine multiple criteria with AND/OR logic |
| **Filter Presets** | Pre-built filters: Active, Suspended, New This Month, At Risk, High Value, Overdue |
| **Quick Stats** | Show count/total value matching current filter in real-time |
| **Export Filtered Results** | Export matching items to CSV/JSON |
| **Filter Sharing** | Share custom filters with other admins |

**Filterable Fields:**

| Field | Type | Filter operators | Example values |
|-------|------|-----------------|----------------|
| `plan_id` | Enum | `=`, `!=`, `in`, `not_in` | `starter`, `business`, `premium` |
| `status` | Enum | `=`, `in` | `active`, `suspended`, `cancelled` |
| `region` | Enum | `=`, `in` | `eu-frankfurt`, `us-ashburn` |
| `storage_used_gb` | Numeric | `>`, `<`, `>=`, `<=`, `between` | `50`, `100` |
| `storage_used_percent` | Numeric | `>`, `<`, `>=`, `<=` | `80`, `95` |
| `cpu_used_percent` | Numeric | `>`, `<`, `>=` | `70` |
| `domain_count` | Numeric | `>`, `<`, `=` | `1`, `5` |
| `db_count` | Numeric | `>`, `<`, `=` | `3` |
| `email_account_count` | Numeric | `>`, `<`, `=` | `10` |
| `created_at` | Date | `before`, `after`, `between` | `2026-01-01`, last 30 days |
| `last_login_at` | Date | `before`, `after`, `never` | last 90 days, never |
| `subscription_expires_at` | Date | `before`, `after`, `between` | next 30 days |
| `backup_last_success_at` | Date | `before`, `after`, `never` | last 24h, never |
| `tags` | Array | `contains`, `any_of`, `all_of` | `vip`, `trial`, `managed` |
| `country` | String | `=`, `in` | `DE`, `FR`, `US` |
| `name` | Full-text | `contains`, `starts_with` | `acme` |
| `email` | Full-text | `contains`, `=` | `@example.com` |
| `domain` | Full-text | `contains`, `=` | `example.com` |
| `notes` | Full-text | `contains` | `at risk`, `enterprise` |

Filters are sent as a JSON object to the API: `{ "plan_id": { "in": ["business", "premium"] }, "storage_used_percent": { "gte": 80 } }`. The management API translates them to parameterised SQL `WHERE` clauses. Full-text fields use `pg_trgm` GIN indexes (PostgreSQL) or `FULLTEXT` indexes (MariaDB) for sub-500ms performance at 1000+ clients.

**Performance Requirements:**

- Search results in < 500ms (even with 1000+ clients)
- Filter changes update results instantly
- Full-text indexing on searchable fields
- Elasticsearch integration (optional, for scale)

---

#### 9.4.7 Container & Application Management

| Section                | Features                                           |
| ---------------------- | -------------------------------------------------- |
| **Workload catalog**   | View all container images, enable/disable, deprecate, force migration |
| **Image upgrades**     | Publish new version, set rollout strategy (auto/manual/scheduled), monitor progress |
| **Application catalog**| View all apps, create instances, manage versions   |
| **App instances**      | View all instances per client, scale, update, delete |

#### 9.4.6 Monitoring & Alerts

| View                   | Details                                            |
| ---------------------- | -------------------------------------------------- |
| **Prometheus/Grafana** | Embedded dashboards OR direct link to Grafana     |
| **Alerts**             | List of active/resolved alerts, acknowledgment, escalation |
| **Audit log**          | All admin actions: client creates, plan changes, secret views, app updates |
| **System events**      | Pod crashes, node issues, storage warnings        |

#### 9.4.8 Advanced Team & Security Features (NEW - PHASE 2)

**For teams with 5+ admins and 500+ clients.**

| Feature | Description | Phase |
| ---------------------- | -------------------------------------------------- | ---- |
| **Admin Roles & Permissions** | Define custom roles: Full Admin, Support, Finance, DevOps | 2 |
| **2FA/MFA for Admins** | TOTP, U2F security keys required for admin accounts | 1.5 |
| **IP Whitelist** | Restrict admin panel access to office IPs only | 2 |
| **Admin API Tokens** | Create tokens for automation, with granular scopes | 2 |
| **Action Approval Workflows** | Require second admin approval for critical actions (delete client, refund, etc.) | 2 |
| **Audit Trail** | Complete audit log of all admin actions with IP, timestamp, details | 1 |
| **Rate Limiting** | Throttle API calls per admin to prevent abuse | 2 |
| **Session Management** | View active sessions, force logout, session timeout | 2 |
| **Admin Activity Dashboard** | See what admins are doing (who deleted this client? when?) | 2 |

**Admin Roles Example:**

| Role | Description | Permissions |
|------|-------------|------------|
| **Super Admin** | Full platform control — unrestricted | Create/delete clients, change plans, billing, infrastructure, team management, all destructive actions |
| **Billing Admin** | Manages invoices and subscriptions | View clients, change plan/expiry, send invoices, view billing history; cannot delete clients or touch infrastructure |
| **Support Admin** | Handles client issues and requests | View clients and their resources, trigger restores, reset passwords, view logs; cannot delete or make billing changes |
| **DevOps Admin** | Manages infrastructure and deployments | View/provision/decommission nodes, manage catalog images, view monitoring; cannot access client billing data |
| **Read-Only** | Audit and compliance access | View everything; no write operations |

Roles are stored as a `role` enum on the `admin_users` table. The RBAC rules are enforced in the management API middleware — every route checks `req.admin.role` against the required permission set before processing the request. The full permission matrix is in `AUTHORIZATION_MATRIX.md`.

Custom roles (Phase 2): admins can define custom roles with granular permission toggles in the admin panel under **Settings → Team → Role Editor**.

---

#### 9.4.9 Monitoring & System Health (ENHANCED)

**For proactive operations at 500+ clients.**

| Feature | Description | Criticality |
| ---------------------- | -------------------------------------------------- | ---- |
| **Dashboard Health Score** | Overall platform health (CPU, memory, storage, uptime) | High |
| **Anomaly Detection** | Alert on unusual spikes (storage, CPU, bandwidth) | High |
| **Capacity Planning** | Forecast when storage/CPU will hit limits | Medium |
| **Cost Monitoring** | Track infrastructure costs vs projections | Medium |
| **Customer Health Scores** | Identify at-risk clients (high support tickets, low activity) | Medium |
| **SLA Tracking** | Monitor uptime vs promised SLAs per client | High |
| **Performance Trends** | API response time, database query times, trends | Medium |
| **Alert Rules** | Create custom alerts (client storage > 100GB, API latency > 500ms) | High |
| **Incident Tracking** | Track incidents from creation to resolution | Medium |
| **Status Page Integration** | Manually update status.example.com during incidents | Medium |

**Monitoring Dashboards:**

| Dashboard | What It Shows | Primary User |
|-----------|--------------|-------------|
| **Platform Overview** | Global health score, active clients, open incidents, top-5 resource consumers | All admins |
| **Cluster Health** | Node CPU/memory/disk heatmap, pod restart counts, DaemonSet status (NGINX, Longhorn), k3s version | DevOps |
| **Client Health** | Per-client storage %, last backup timestamp, uptime last 30 days, error rate | Support |
| **Capacity Planning** | Storage growth trend (30/60/90 day projections), CPU utilisation trend, headroom remaining | DevOps |
| **Database Performance** | MariaDB/PostgreSQL query latency (p50/p95/p99), connection pool usage, slow query log | DevOps |
| **Ingress & Traffic** | Request rate per second, HTTP error rate (4xx/5xx), response time percentiles, top domains by traffic | DevOps / Support |
| **Email Delivery** | Messages sent/hour, bounce rate, spam score distribution, queue depth | Support |
| **Backup Status** | Last successful backup per client, backup job duration, offsite sync status, storage used | DevOps |
| **Cost Tracking** | Infrastructure cost by provider this month vs last month, cost per client, projected month-end | Billing |
| **Security & Audit** | Failed login attempts, admin actions last 24h, certificate expiry warnings, fail2ban blocks | Super Admin |
| **SLA Tracking** | Uptime % per client against SLO target, error budget remaining, incidents this month | Support / Management |

All dashboards are provisioned as Grafana JSON files from `k8s/base/monitoring/grafana/dashboards/`. The admin panel embeds Grafana iframes for the client-facing health widgets; the full Grafana instance is accessible to admins via the internal panel at `/grafana`.

---

#### 9.4.10 Settings & Configuration

| Setting                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| **Branding**           | Logo, colors, platform name, footer text          |
| **SMTP (notifications)**| External relay (SendGrid, Mailgun, SES) or platform mail |
| **OIDC (Google/Apple)**| Client IDs, secrets for authentication             |
| **DNS provider**       | API credentials for PowerDNS, Route53, etc.       |
| **Cluster Backup Settings** | **Backup schedule**: Full/Incremental/Differential, frequency (hourly/daily/weekly); **Retention policies**: per plan; **Offsite destination**: SFTP/SSH server config; **Backup types per component**: Velero, database dumps, file-level backups |
| **Mail server**        | Docker-Mailserver settings, limits, SPF/DKIM config |
| **Roundcube settings** | Default domain, plugins, appearance               |
| **Security**           | Rate limiting, fail2ban thresholds, session timeout, 2FA requirement |
| **API keys**           | Generate/revoke platform API keys                 |
| **Team members**       | Add admins, set roles, MFA                        |
| **Webhooks** (Phase 2) | Custom webhooks for client actions (create, suspend, etc.) |
| **Integrations** (Phase 2) | Stripe, Paddle, or other payment processors | 

#### 9.4.11 Cluster Backup Schedule Management

Admin can configure and customize cluster-wide backup schedules for all components:

##### Backup Types

| Type           | Description                                              | Use Case                                |
| -------------- | -------------------------------------------------------- | --------------------------------------- |
| **Full**       | Complete backup of all data (K8s state, DBs, files)      | Weekly baseline, disaster recovery      |
| **Incremental**| Only changes since last backup (any type)                | Daily backups, fast & space-efficient   |
| **Differential** | Only changes since last full backup                     | Daily backups, faster restore than incremental |

##### Schedule Configuration UI

| Setting                | Options                                    | Default         |
| ---------------------- | ------------------------------------------ | --------------- |
| **Kubernetes State (Velero)** | Full: weekly; Incremental: daily OR Full: daily | Full weekly + Incremental daily |
| **Database Backups**   | Full: daily/weekly; Incremental: hourly/daily | Full daily      |
| **File Backups**       | Full: weekly; Incremental: daily OR Differential: daily | Incremental daily |
| **Backup Frequency**   | Hourly / Daily / Weekly / Monthly / Custom cron | Daily           |
| **Retention Period**   | 7 / 14 / 30 / 90 / 365 days (per plan override) | 30 days         |
| **Offsite Write**      | SSHFS mount → direct write → unmount (during backup window) | During backup    |
| **Compression**        | gzip / zstd / none                         | zstd (best ratio) |
| **Encryption**         | AES-256 before offsite write               | Enabled         |

##### Admin Backup Schedule Editor

**UI Form:**
- Dropdown to select schedule preset: "Standard", "Aggressive (more backups)", "Minimal (lower cost)"
- Or "Custom" to manually configure each backup type
- Toggle buttons for each component: Velero on/off, MariaDB backups on/off, file backups on/off, etc.
- Text input for cron schedule (with helper: every hour, every 6 hours, 2 PM daily, etc.)
- Dropdown for retention (7/14/30/90/365 days with cost estimate)
- Preview of: "Backups will run at: Mon/Wed/Fri 10 PM, Tue/Thu/Sat 2 AM, etc."

**After Save:**
- Confirmation message: "Cluster backup schedule updated. Next backup: [timestamp]"
- Current schedule table showing all active backup jobs
- View logs: Last 10 backups with status, duration, size, offsite write status

##### Per-Client Backup Schedule Overrides

Admins can override backup schedules for specific high-value clients:

| Client Setting        | Default (from cluster) | Options              |
| --------------------- | ---------------------- | -------------------- |
| **Backup frequency**  | Inherited from cluster | More frequent than cluster default |
| **Retention period**  | Inherited from plan    | Can increase (paid) or decrease |
| **Backup type**       | Inherited from cluster | Force to Full (more safety) or Incremental (cost) |
| **Offsite sync**      | Inherited from cluster | Require immediate sync (no batching) |

**Example:** Client on Business plan → cluster default is daily incremental → override to hourly full backups (paid add-on)

### 9.5 Client Panel Features

Clients manage their own hosting via the client panel:

#### 9.5.1 Dashboard & Overview

| Widget                 | Data Displayed                                      |
| ---------------------- | -------------------------------------------------- |
| **Account summary**    | Plan, domains, email accounts, storage usage      |
| **Resource usage**     | Storage (files + DB), bandwidth, email quota      |
| **Quick actions**      | Create domain, create email account, upload files, open webmail |
| **Recent activity**    | Latest backups, deployments, certificate renewals |
| **Support widget**     | Contact support, documentation links, FAQ         |
| **Billing**            | Current plan, pricing, next invoice, payment method |

#### 9.5.2 Domains & Sites

| Feature                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| **Domain list**        | All domains with status, SSL cert expiry, DNS status |
| **Add domain**         | Enter domain, auto-verify, provision SSL, create DNS records |
| **SSL certificates**   | View current cert, expiry date, renewal status    |
| **DNS records**        | View current records (read-only), instructions for manual changes |
| **Domain transfer**    | Instructions for transferring domain to client's registrar |
| **Subdomain creation**| Create subdomains (e.g., blog.example.com)        |

#### 9.5.3 Files & Deployment

| Method                 | UI Elements                                        |
| ---------------------- | -------------------------------------------------- |
| **Web file manager**   | Browse folders, upload files, edit in-browser, download, delete, rename |
| **SFTP credentials**   | Display SFTP server, port, username, password (copyable) |
| **Git deployment**     | View deployment webhook URL, configure in GitHub/GitLab, view deployment history |
| **Deployment log**     | Real-time deployment status, error messages, rollback option |

#### 9.5.4 Databases

| Section                | Features                                           |
| ---------------------- | -------------------------------------------------- |
| **Database list**      | MariaDB and PostgreSQL databases, storage usage     |
| **Database details**   | Credentials, phpmyadmin/pgAdmin links, connection info |
| **Backup management**  | View backups, download backup, restore to timestamp |
| **Database tools**     | Run SQL query, import/export SQL dump             |

#### 9.5.5 Email

| Section                | Features                                           |
| ---------------------- | -------------------------------------------------- |
| **Email accounts**     | List accounts, create new, delete, storage usage per account |
| **App passwords**      | View list (labels + created date), create new, regenerate, delete, copy to clipboard |
| **Webmail access**     | Links to Roundcube (default + custom domain), SSO login |
| **IMAP/SMTP settings**| Display server addresses, ports, encryption, example configs for Thunderbird/Outlook |
| **Email forwarding**   | Set up forwarding rules (optional)                 |
| **Sending limits**     | View current quota, usage, warnings               |

#### 9.5.6 Applications

| Feature                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| **Browse catalog**     | View available applications (Nextcloud, Gitea, Mattermost, etc.) |
| **Request app**        | Click "Request Nextcloud" → configure params (domain, storage) → submit for approval (if required) |
| **View instances**     | List deployed apps with status, URL, created date |
| **App management**     | Access app, view logs, scale resources, update version, backup, delete |

#### 9.5.7 Backups & Granular Restore

Clients can restore from **platform-managed global cluster backups** or create and manage **their own independent backups** with custom schedules.

##### Global Cluster Backups (Platform-Managed)

| Feature                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| **Backup list**        | All cluster-managed backups (daily/weekly), size, timestamp, type (full/incremental/differential) |
| **Backup details**     | What's included, storage location, retention policy (admin-configured) |
| **Restore from backup**| **Granular restore**: Select individual objects (websites, databases, mail accounts) and specific files/folders from any cluster backup version |
| **Backup schedule** (View-only) | Display current cluster backup schedule and frequency; customers can request admin to adjust retention/frequency per plan tier |

**Cluster Backups:**
- Managed by platform admin (schedule, retention, type all configured globally)
- Free to all customers (included with all plan tiers)
- Stored on offsite backup server (SSHFS mount via NetBird mesh)
- Not counted against customer disk quota
- Admin-controlled retention (e.g., 30 days default)

##### Customer-Created Independent Backups

| Feature                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| **Create manual backup** | Trigger immediate backup of selected objects: specific domains, databases, email accounts, or entire account |
| **Backup schedule**    | Create custom backup schedules independent of cluster defaults; configure frequency (hourly/daily/weekly/monthly), type (full/incremental/differential), retention |
| **Manage schedules**   | View all customer-created schedules, edit, pause, resume, delete |
| **Backup list**        | List all customer backups (manual triggers + scheduled), size, timestamp, type, source |
| **Download backup**    | Direct download of gzipped backup                 |
| **Restore from backup**| **Granular restore**: Select individual objects and files/folders from customer-created backups |
| **Delete backup**      | Manual deletion of backup (frees up quota)         |

**Customer Backups:**
- Created and managed by customers
- Stored in customer's disk quota (included in overall storage limit)
- Customers pay for additional storage if backup exceeds quota
- Customers control retention (can set 7/14/30/90/365+ days)
- Customers can trigger manual backups anytime
- Cost-transparent: storage usage shown in backup details

**Storage Accounting:**
- Cluster backups → NOT counted in quota (platform operational cost)
- Customer backups → FULLY counted in quota
- Quota usage visible: "You are using 45 GB of 100 GB (includes 15 GB in customer backups)"
- Warning threshold: Alert when customer backups exceed 50% of remaining quota
- Quota enforcement: Customer cannot create new backups if quota exceeded; must delete old backups or upgrade plan

**Granular Restore Features (NEW):**

All backup versions are browsable and restorable:

| Restore Type | Objects | UI Features | Availability |
|---|---|---|---|
| **Website** | Individual domain/installation | Select backup version → preview files/DB → choose restore target (overwrite/new domain) → confirm | Both Admin & Client |
| **Database** | Single MariaDB/PostgreSQL database | Choose backup version → select tables or full DB → scope (full/data-only) → target (overwrite/new DB) | Both |
| **Mail Account** | Individual email account | Choose backup version → select scope (full/content-only/date-range) → merge or overwrite → target account | Both |
| **Files & Folders** | Specific files or directory trees | Browse file tree OR search → select files/folders → exclude patterns → target path (original/alternate) → conflict resolution | Both |

**Key Capabilities:**

- **All Backup Versions Visible:** Users see complete history (hourly/daily snapshots)
- **Non-Destructive by Default:** Restored items renamed or placed in alternate location unless user explicitly confirms overwrite
- **Preview Before Restore:** View file list, database tables, email metadata before executing
- **Async Restores:** Background jobs with real-time progress tracking (WebSocket)
- **Admin + Client Access:** Both can initiate restores with appropriate RBAC controls
- **Automatic Rollback:** Failed restores roll back automatically; no partial restorations
- **Audit Trail:** Every restore logged (who, what, when, result)

> **See [RESTORE_SPECIFICATION.md](./RESTORE_SPECIFICATION.md) for complete UI/UX flows, API endpoints, error handling, and implementation checklist.**

#### 9.5.8 Account Settings

| Section                | Features                                           |
| ---------------------- | -------------------------------------------------- |
| **Profile**            | Name, email, contact info, language preference    |
| **Security**           | Password change (via OIDC), API tokens, session management |
| **Notifications**      | Email notification preferences (which events trigger emails) |
| **Plan & billing**     | Current plan details, usage vs quota, upgrade/downgrade |
| **Support**            | Contact support, view ticket history, documentation |

### 9.6 API-Driven Architecture

Both panels are driven by a **REST API** (or GraphQL alternative). The API is the single source of truth.

| API Layer              | Responsibility                                      |
| ---------------------- | --------------------------------------------------- |
| **Management API**     | Core business logic: client CRUD, plan management, email/DNS |
| **Data API**           | Metrics, logs, backups, resources (read-heavy, cached) |
| **Auth API**           | JWT issuance, token refresh, OIDC integration      |
| **Webhook API**        | Git deploy hooks, monitoring alerts → Notification Service |

**API design principles:**

- RESTful endpoints with clear resource hierarchies
- Consistent error responses (JSON with code + message)
- Pagination, filtering, sorting on list endpoints
- Request/response compression (gzip)
- API versioning (v1, v2, etc.) for backwards compatibility
- Rate limiting (configurable per role)
- Request tracing (X-Request-ID header)
- Comprehensive API documentation (OpenAPI/Swagger)

### 9.7 Authentication & Authorization

| Aspect                 | Implementation                                      |
| ---------------------- | --------------------------------------------------- |
| **Login method**       | OIDC (Google/Apple) via Dex + email/password fallback |
| **Session management**| JWT tokens (access + refresh), httpOnly cookies    |
| **Logout**             | Clear session, revoke refresh token                |
| **Role-based access** | Admin role (full access), Client role (scoped to client namespace) |
| **MFA**                | Delegated to OIDC provider (Google Authenticator, Face ID, etc.) |
| **Session timeout**    | Configurable (default 4 hours); refresh token valid for 30 days |
| **Remember me**        | Persistent login via refresh token (browser local storage) |

### 9.8 Responsive Design Breakpoints

| Breakpoint | Width       | Use Case                                            |
| ---------- | ----------- | --------------------------------------------------- |
| **Mobile** | < 640px     | Phones, small devices; single-column layout        |
| **Tablet** | 640-1024px  | iPads, tablets; two-column layout where applicable |
| **Desktop**| 1024-1920px | Desktop browsers; full multi-column layout         |
| **Ultra-wide** | > 1920px  | Large monitors; extended sidebars, more info      |

**Mobile-specific considerations:**

- Touch-friendly buttons (min 48px height)
- Hamburger menu for navigation
- Simplified forms (fewer fields per screen)
- Optimized modals (full-height on mobile)
- Readable font sizes (no zooming required)
- Tap-friendly link spacing

### 9.9 Deployment & Hosting

| Component              | Deployment Strategy                                  |
| ---------------------- | --------------------------------------------------- |
| **Frontend build**     | Static SPA (HTML/CSS/JS), no server-side rendering required |
| **Distribution**       | Cloud CDN (Cloudflare, AWS CloudFront, or similar) for global edge caching |
| **Hosting**            | Longhorn PV + NGINX static file serving for assets |
| **API gateway**        | Kubernetes Ingress pointing to Management API pods |
| **Version management** | Git tags for releases, semantic versioning (v1.2.3) |
| **Rolling updates**    | Blue-green deployment of frontend via CDN cache invalidation |

### 9.10 Accessibility & Internationalization

| Feature                | Details                                             |
| ---------------------- | --------------------------------------------------- |
| **WCAG compliance**    | AA level minimum; test with axe DevTools, Lighthouse |
| **Keyboard navigation**| Tab order, focus indicators, skip links            |
| **Screen reader support** | ARIA labels, semantic HTML, role attributes       |
| **Color contrast**     | 4.5:1 for normal text, 3:1 for large text (WCAG AA) |
| **i18n (optional future)** | Extract strings to translation files, support multiple languages |

### 9.11 Development & Maintenance

| Aspect                 | Approach                                            |
| ---------------------- | --------------------------------------------------- |
| **Version control**    | Git, monorepo with admin/ and client/ subdirectories |
| **CI/CD**              | GitHub Actions / GitLab CI for tests, linting, build |
| **Storybook**          | Component library showcasing all UI elements       |
| **Environment strategy**| dev, staging, production with distinct API endpoints |
| **Monitoring**         | Sentry for frontend errors, DataDog/New Relic for APM |
| **Analytics** (optional)| Plausible or similar for user behavior insights    |

---

## 10. Monitoring & Logging

### 9.1 Observability Stack

| Pillar     | Tool                         | Notes                              |
| ---------- | ---------------------------- | ---------------------------------- |
| Metrics    | **Prometheus** (via kube-prometheus-stack) | Cluster, node, pod, and app metrics |
| Logs       | **Loki** + **Promtail**       | Centralized log aggregation        |
| Dashboards | **Grafana**                   | Platform ops + per-client dashboards |
| Alerting   | **Alertmanager**              | Integrated with Prometheus         |
| Traces     | **Tempo** (Phase 2 — planned post-MVP) | Low resource usage, Loki integration, deferred for Phase 2 |

### 9.2 What Gets Monitored

| Category                | Metrics / Signals                                |
| ----------------------- | ------------------------------------------------ |
| **Cluster health**      | Node status, CPU/mem/disk per node, pod restarts, OOM kills |
| **Ingress**             | Request rate, error rate (4xx/5xx), latency per host, TLS cert expiry |
| **Per-client**          | CPU/mem usage vs. quota, storage usage, HTTP errors, response time |
| **Shared databases**    | Connections per client, query latency, replication lag, total storage |
| **Shared Redis**        | Memory per prefix, hit/miss ratio, connections   |
| **Email**               | Queue length, delivery success/failure, spam score |
| **Security**            | fail2ban triggers, WAF blocks, auth failures, suspicious patterns |
| **Backups**             | Last successful backup time, backup size, restore test results |
| **Certificates**        | Days until expiry, renewal failures               |
| **Catalog images**      | Clients per image version, deprecated image usage count |
| **Scale-to-zero**       | Cold start latency, idle client count, wake-up success rate |

### 9.3 Alerting

| Parameter             | Value                                            |
| --------------------- | ------------------------------------------------ |
| Alerting tool         | Alertmanager (with Prometheus rules)             |
| Notification channels | **Email + SMS** (PagerDuty integration in Phase 2) |
| Critical alerts       | Node down, cluster unhealthy, shared DB down, backup failure, cert expiry < 7d, disk > 90% |
| Warning alerts        | Client near quota, high error rate, deprecated image still in use, DB connection saturation |
| On-call support       | **Business hours only (MVP)** — no 24/7 on-call initially |
| Escalation policy     | **Single level: immediately page primary engineer** (direct escalation, minimal delay) |
| On-call rotation      | Not applicable (business hours support, no rotation needed for MVP) |

### 9.4 SLOs & SLIs

| Service              | SLI (Indicator)        | SLO (Objective)  | Error Budget (per month) |
| -------------------- | ---------------------- | ---------------- | ------------- |
| Client web hosting   | Availability (uptime)  | **99.5%** (~4.3 hours downtime)    | 3.6 hours     |
| Client web hosting   | Latency (p95)          | **< 1000ms** (relaxed, admin tools acceptable) | N/A |
| Management panel     | Availability           | **99.5%** (~4.3 hours downtime)     | 3.6 hours     |
| Shared MariaDB         | Availability           | **99.5%** (no HA initially; upgrade later)     | 3.6 hours     |
| Shared PostgreSQL    | Availability           | **99.5%** (no HA initially; upgrade later)     | 3.6 hours     |
| Email delivery       | Delivery success rate  | **99%** (acceptable, some mail loss tolerated)   | 4.3 hours equivalent |
| DNS resolution       | Query success rate     | **99.5%** (PowerDNS primary)        | 3.6 hours     |

### 9.5 Log Retention

| Environment / Source | Retention Period    |
| -------------------- | ------------------- |
| Client access logs   | 30 days             |
| Platform service logs| 90 days             |
| Security / audit logs| 1 year              |
| Backup logs          | 90 days             |

### 9.6 Client-Facing Metrics

> _Clients should see basic metrics in their panel:_

- Bandwidth usage (monthly)
- Storage usage (files + DB)
- CPU / memory utilization vs. plan limits
- Recent HTTP error rates
- Last backup timestamp
- Current container image version (with upgrade available indicator)

### 9.7 Email Notification System

> _The management panel sends configurable email notifications to admins (and optionally
> clients) for all relevant client, system, and security events. Every notification is
> individually toggleable and routable to specific recipients._

#### 9.7.1 Architecture

| Component                  | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| **Notification Service**   | Platform microservice that processes events and dispatches emails |
| **Event bus**              | Internal event stream — all platform services emit events (K8s events, API actions, metric thresholds) |
| **Template engine**        | Renders email content from configurable templates (subject, body, variables) |
| **SMTP delivery**          | Sends via platform mail stack (Docker-Mailserver) or external SMTP relay (SendGrid, Mailgun, etc.) |
| **Notification log**       | All sent notifications logged in DB for audit trail  |
| **Digest mode**            | Option to batch low-priority notifications into a daily/weekly digest instead of individual emails |

#### 9.7.2 Notification Events — Full Catalog

Every event below can be **individually enabled/disabled** per recipient in the admin panel.

**Client Account Events:**

| Event ID                      | Trigger                                          | Default Recipients | Severity |
| ----------------------------- | ------------------------------------------------ | ------------------ | -------- |
| `client.created`              | New client account provisioned                   | Admin              | Info     |
| `client.deleted`              | Client account removed                           | Admin              | Info     |
| `client.plan_changed`         | Client switched plans or plan overrides changed  | Admin, Client      | Info     |
| `client.plan_expiry_warning`  | Plan expiry approaching (configurable: 30/14/7/1 days before) | Admin, Client | Warning |
| `client.plan_expired`         | Plan has expired                                 | Admin, Client      | Critical |
| `client.suspended`            | Client account suspended (non-payment, abuse, etc.) | Admin, Client   | Warning  |
| `client.reactivated`          | Client account reactivated after suspension      | Admin, Client      | Info     |
| `client.login`                | Client logged into management panel              | Client (optional)  | Info     |
| `client.password_reset`       | OIDC password/account recovery triggered         | Client             | Info     |

**Resource & Quota Events:**

| Event ID                      | Trigger                                          | Default Recipients | Severity |
| ----------------------------- | ------------------------------------------------ | ------------------ | -------- |
| `resource.storage_warning`    | Storage usage approaching limit (configurable: 80%/90%/95%) | Admin, Client | Warning |
| `resource.storage_full`       | Storage at 100% — writes may fail                | Admin, Client      | Critical |
| `resource.cpu_sustained`      | CPU usage sustained above limit (e.g., >90% for 30 min) | Admin         | Warning  |
| `resource.memory_sustained`   | Memory usage sustained above limit               | Admin              | Warning  |
| `resource.db_storage_warning` | Database storage approaching limit               | Admin, Client      | Warning  |
| `resource.db_connections_high`| Database connections near max for client          | Admin              | Warning  |
| `resource.bandwidth_warning`  | Monthly bandwidth approaching limit (if metered) | Admin, Client      | Warning  |
| `resource.bandwidth_exceeded` | Monthly bandwidth limit exceeded                 | Admin, Client      | Critical |

**Email Sending Events:**

| Event ID                      | Trigger                                          | Default Recipients | Severity |
| ----------------------------- | ------------------------------------------------ | ------------------ | -------- |
| `email.sending_limit_warning` | Client approaching daily/hourly email sending limit (80%) | Admin, Client | Warning |
| `email.sending_limit_reached` | Client hit email sending limit — emails queued/rejected | Admin, Client | Critical |
| `email.bounce_rate_high`      | Bounce rate exceeds threshold (e.g., >5%)        | Admin              | Warning  |
| `email.spam_report`           | Client's emails flagged as spam                  | Admin              | Warning  |
| `email.queue_stalled`         | Mail queue not draining (system-wide)            | Admin              | Critical |
| `email.blacklist_detected`    | Server IP detected on email blacklist            | Admin              | Critical |

**Security Events:**

| Event ID                      | Trigger                                          | Default Recipients | Severity |
| ----------------------------- | ------------------------------------------------ | ------------------ | -------- |
| `security.fail2ban_ban`       | IP banned by fail2ban (any layer)                | Admin              | Info     |
| `security.brute_force`        | Brute force attack detected (high ban rate)      | Admin              | Warning  |
| `security.waf_block`          | WAF blocked a malicious request                  | Admin (digest)     | Info     |
| `security.waf_attack_surge`   | WAF blocks exceed threshold (possible attack)    | Admin              | Critical |
| `security.unauthorized_access`| Unauthorized API call or kubectl access attempt  | Admin              | Critical |
| `security.client_compromise`  | Suspected client site compromise (malware, defacement) | Admin, Client | Critical |
| `security.ssl_cert_expiry`    | TLS certificate expiring within 7 days (renewal failed) | Admin        | Critical |

**System & Infrastructure Events:**

| Event ID                      | Trigger                                          | Default Recipients | Severity |
| ----------------------------- | ------------------------------------------------ | ------------------ | -------- |
| `system.node_down`            | K8s node unreachable                             | Admin              | Critical |
| `system.node_disk_pressure`   | Node disk usage > 85%                            | Admin              | Warning  |
| `system.pod_crash_loop`       | Platform service pod in CrashLoopBackOff         | Admin              | Critical |
| `system.db_down`              | Shared MariaDB or PostgreSQL unreachable            | Admin              | Critical |
| `system.db_replication_lag`   | DB replication lag > threshold (if HA enabled)   | Admin              | Warning  |
| `system.redis_down`           | Shared Redis unreachable                         | Admin              | Critical |
| `system.ingress_error_spike`  | Ingress 5xx error rate exceeds threshold         | Admin              | Critical |
| `system.dns_failure`          | DNS resolution failures detected                 | Admin              | Critical |

**Backup Events:**

| Event ID                      | Trigger                                          | Default Recipients | Severity |
| ----------------------------- | ------------------------------------------------ | ------------------ | -------- |
| `backup.success`              | Daily backup completed successfully              | Admin (digest)     | Info     |
| `backup.failure`              | Backup job failed for any client                 | Admin              | Critical |
| `backup.offsite_failure`      | Offsite SSHFS mount or backup write failed       | Admin              | Critical |
| `backup.offsite_success`      | Offsite backup write completed                   | Admin (digest)     | Info     |
| `backup.restore_test_pass`    | Automated restore test succeeded                 | Admin (digest)     | Info     |
| `backup.restore_test_fail`    | Automated restore test failed                    | Admin              | Critical |

**Update & Maintenance Events:**

| Event ID                      | Trigger                                          | Default Recipients | Severity |
| ----------------------------- | ------------------------------------------------ | ------------------ | -------- |
| `update.catalog_image`        | New workload container image available in catalog | Admin              | Info     |
| `update.app_update`           | Application Catalog app has a new version available | Admin            | Info     |
| `update.k8s_update`           | New Kubernetes version available                 | Admin              | Info     |
| `update.security_patch`       | Critical security patch available for any component | Admin           | Warning  |
| `update.deprecated_image_in_use` | Clients still running a deprecated container image | Admin          | Warning  |
| `update.upgrade_completed`    | Container image or app upgrade completed         | Admin              | Info     |
| `update.upgrade_failed`       | Container image or app upgrade failed/rolled back | Admin             | Critical |

**Application Catalog Events:**

| Event ID                      | Trigger                                          | Default Recipients | Severity |
| ----------------------------- | ------------------------------------------------ | ------------------ | -------- |
| `app.instance_requested`      | Client requested a new application instance       | Admin              | Info     |
| `app.instance_deployed`       | Application instance successfully deployed        | Admin, Client      | Info     |
| `app.instance_failed`         | Application deployment failed                     | Admin              | Critical |
| `app.instance_deleted`        | Application instance removed                      | Admin              | Info     |

#### 9.7.3 Notification Configuration Model

All notification settings are managed in the admin panel with a layered configuration:

**Admin configuration UI:**

| Setting                      | Description                                       |
| ---------------------------- | ------------------------------------------------- |
| **Event toggle**             | Enable/disable each event individually            |
| **Recipient list**           | Who receives this notification (admin emails, client email, distribution list) |
| **Severity filter**          | Only send notifications above a severity threshold (e.g., Warning+) |
| **Digest mode**              | Batch Info-level events into daily/weekly digest emails |
| **Digest schedule**          | When to send digests (e.g., daily at 08:00, weekly on Monday) |
| **Quiet hours**              | Suppress non-critical notifications during off-hours (optional) |
| **Escalation**               | If a Critical event is not acknowledged within N minutes, re-send or escalate |
| **Client notification prefs**| Which events clients receive (admin controls defaults, client can opt out of non-essential) |

**Example configuration:**

```json
{
  "notifications": {
    "storage_warning": {
      "enabled": true,
      "recipients": ["admin@platform.example.com", "support@platform.example.com"],
      "also_notify_client": true,
      "severity_filter": "warning",
      "digest_mode": false
    },
    "plan_expiry_7d": {
      "enabled": true,
      "recipients": ["billing@platform.example.com"],
      "also_notify_client": true,
      "severity_filter": "info",
      "digest_mode": false
    },
    "node_down": {
      "enabled": true,
      "recipients": ["ops@platform.example.com"],
      "also_notify_client": false,
      "severity_filter": "critical",
      "digest_mode": false,
      "escalation_minutes": 10,
      "escalation_recipients": ["cto@platform.example.com"]
    },
    "client_created": {
      "enabled": true,
      "recipients": ["admin@platform.example.com"],
      "also_notify_client": false,
      "severity_filter": "info",
      "digest_mode": true,
      "digest_schedule": "daily_0800"
    }
  },
  "quiet_hours": {
    "enabled": true,
    "start": "22:00",
    "end": "07:00",
    "timezone": "Europe/Berlin",
    "suppress_severity": ["info", "warning"]
  }
}
```

This configuration is stored in the `platform_settings` table under the key `notification_config` as a JSONB column and is editable through the admin panel's **Settings → Notifications** page.

#### 9.7.4 Email Templates

All notification emails use **customizable templates** stored in the platform:

| Template Component | Description                                       |
| ------------------ | ------------------------------------------------- |
| **Subject line**   | Configurable per event, supports variables (e.g., `[{{severity}}] {{client_name}} — {{event_summary}}`) |
| **Body (HTML)**    | Rich HTML email with platform branding            |
| **Body (text)**    | Plain text fallback                                |
| **Variables**      | `{{client_name}}`, `{{client_email}}`, `{{domain}}`, `{{resource_usage}}`, `{{threshold}}`, `{{timestamp}}`, `{{action_url}}`, etc. |
| **Branding**       | Logo, colors, footer configurable in admin panel  |
| **Language**       | **English only (MVP)** — i18n support deferred to future release |

**Example email:**

```
Subject: [Warning] acme-corp.com — Storage at 87% (43.5 GB / 50 GB)

──────────────────────────────────────────────────────────────
                    Platform Name
──────────────────────────────────────────────────────────────

Storage Warning — Action Required

Client:   Acme Corp (acme-corp.com)
Plan:     Business (50 GB storage)
Usage:    43.5 GB used / 50 GB limit (87%)
Time:     2026-03-08 14:23 UTC

This is a warning that Acme Corp's storage is approaching the
plan limit. When storage reaches 100%, file uploads and database
writes will be blocked.

Recommended actions:
  • Delete unused files or database backups
  • Upgrade the client to the Premium plan (50 GB → unlimited)
  • Purchase a storage add-on

──────────────────────────────────────────────────────────────
Manage this notification: https://admin.platform.example.com/settings/notifications
Platform Name · support@platform.example.com
──────────────────────────────────────────────────────────────
```

The HTML version of this email uses the platform's branded template (logo, primary accent colour, button styling). Plain-text version (shown above) is always generated as a fallback for email clients that don't render HTML.

#### 9.7.5 SMTP Delivery Options

| Option                     | Description                                       |
| -------------------------- | ------------------------------------------------- |
| **Platform mail stack**    | Send via the Docker-Mailserver instance (no external dependency) |
| **External SMTP relay**    | Send via SendGrid, Mailgun, Amazon SES, or any SMTP server |
| **Dual delivery**          | Send Critical notifications via external relay for reliability; Info via platform |

> **Recommendation:** Use an **external SMTP relay** (SendGrid free tier or similar)
> for notification emails. This separates notification delivery from client email hosting
> and ensures admin alerts are received even if the platform mail stack is down.

#### 9.7.6 Integration with Alertmanager

The Notification Service complements — but does not replace — Prometheus Alertmanager:

| Concern                    | Alertmanager                          | Notification Service                   |
| -------------------------- | ------------------------------------- | -------------------------------------- |
| **Source**                 | Prometheus metrics (infrastructure)   | Platform API events (business logic)   |
| **Events**                | Node down, disk full, pod crash       | Plan expiry, storage warning, client created |
| **Recipients**            | Ops team (Slack, PagerDuty)           | Admin + clients (email)                |
| **Customization**         | PromQL rules, static config           | Per-event toggles, templates, digests  |
| **Overlap**               | Some infra events trigger both        | Notification Service can consume Alertmanager webhooks |

> For infrastructure events that should also reach the admin via email (e.g., node down),
> Alertmanager sends a webhook to the Notification Service, which renders and sends the email.
> This avoids duplicating alerting logic.

---

## 11. Email & Webmail

> _This section covers the complete email stack: Docker-Mailserver for SMTP/IMAP,
> Roundcube for webmail, email authentication (OIDC + application passwords), and
> client-level webmail domain routing._

### 11.1 Email Stack Overview

| Component                  | Technology                                          | Namespace  |
| -------------------------- | --------------------------------------------------- | ---------- |
| **MTA (outbound/inbound)** | **Docker-Mailserver** (Postfix) — see [Section 0.5](#05-email-stack) | `mail`     |
| **IMAP server**            | **Docker-Mailserver** (Dovecot) — see [Section 0.5](#05-email-stack) | `mail`     |
| **Webmail**                | **Roundcube** (shared instance) — see [Section 0.5](#05-email-stack) | `mail`     |
| **App Password Service**   | Custom microservice (part of Management API or standalone) | `mail` |
| **Spam filtering**         | **Docker-Mailserver** (Rspamd)                      | `mail`     |
| **DKIM/SPF/DMARC**        | **Docker-Mailserver** (OpenDKIM)                    | `mail`     |
| **fail2ban (mail)**        | Docker-Mailserver built-in                          | `mail`     |
| **External SMTP option**   | **SendGrid/Mailgun/AWS SES integration** (for hybrid model) — see [Section 0.5](#05-email-stack) | N/A |

### 11.2 Roundcube Webmail

#### 11.2.1 Deployment

Roundcube runs as a **single shared instance** in the `mail` namespace, serving all
clients. It connects to Docker-Mailserver's Dovecot (IMAP) and Postfix (SMTP) via
ClusterIP services.

| Parameter                  | Value                                               |
| -------------------------- | --------------------------------------------------- |
| Deployment model           | Single pod in `mail` namespace (shared by all clients) |
| Base image                 | `roundcube/roundcubemail:latest-apache` (Alpine-based) |
| Resource allocation        | 200m-500m CPU, 256Mi-512Mi RAM                      |
| Database                   | Shared MariaDB or PostgreSQL (single `roundcube` database for sessions, contacts, identities) |
| IMAP backend               | `dovecot.mail.svc.cluster.local:993` (TLS)          |
| SMTP backend               | `postfix.mail.svc.cluster.local:587` (STARTTLS)     |
| Session storage            | Database-backed (survives pod restarts)              |
| Plugins                    | managesieve, password (app passwords), identity_select, archive, zipdownload |

#### 11.2.2 Client-Level Webmail Domains

Roundcube is reachable via both a **platform-level default domain** and **per-client
custom domains**. This allows clients to offer branded webmail access to their users.

| Access Method              | Domain Example                                      | How It Works |
| -------------------------- | --------------------------------------------------- | ------------ |
| **Platform default**       | `webmail.platform.com`                              | Single Ingress rule; all clients can log in here with their email credentials |
| **Client custom domain**   | `webmail.client-a.com`, `mail.client-b.org`         | Per-client Ingress rule pointing to the same Roundcube Service |

**How client-level domains work:**

When an admin or client sets a custom webmail domain (e.g. `webmail.acme-corp.com`):

1. The management API creates a Kubernetes `Ingress` resource in the `mail` namespace with `host: webmail.acme-corp.com` pointing to the `roundcube` Service.
2. cert-manager automatically provisions a TLS certificate for `webmail.acme-corp.com` via DNS-01 or HTTP-01 (depending on the client's DNS mode).
3. A DNS A record for `webmail.acme-corp.com` is created in PowerDNS pointing to the platform's worker node IPs (same as any other client domain).
4. The `webmail_domain` column on the `clients` table is updated to `webmail.acme-corp.com`.
5. Roundcube itself requires no configuration change — it accepts any domain and authenticates users by email address against Dovecot.

**Ingress configuration:**

All webmail domains (platform default + all client custom domains) route to the
same Roundcube Service in the `mail` namespace. Roundcube itself is domain-agnostic —
it authenticates users by email address against Dovecot regardless of which domain
they accessed it from.

> **Cleanup:** When a client is deleted or their `webmail_domain` is removed, the
> Management API deletes the corresponding Ingress and Certificate resources.

### 11.3 Email Authentication — OIDC + Application Passwords

#### 11.3.1 OIDC Login for Webmail

Clients who configure OIDC (Google or Apple) can log into Roundcube without entering
a password. The flow uses the platform's OIDC infrastructure (Dex) as an
intermediary.

**How it works:**

1. User visits `webmail.platform.com` (or a client custom webmail domain) and clicks **Sign in with Google** (or Apple).
2. Roundcube redirects to the platform's Dex OIDC server, which proxies to Google's OAuth2 endpoint.
3. Google authenticates the user and returns an ID token to Dex.
4. Dex validates the token, maps the Google email to a Roundcube user identity, and returns a Dex ID token to Roundcube.
5. Roundcube validates the Dex token against Dex's JWKS endpoint and extracts the email address.
6. Roundcube checks that the authenticated email address matches an `email_accounts` row in the platform database (via the App Password Service API) — if no match, login is rejected.
7. If `email_oidc_domain_restriction` is set, Roundcube also verifies the email domain matches the client's allowed domains.
8. On success: Roundcube creates a session and opens the mailbox — no app password is needed.

OIDC tokens for Roundcube sessions are short-lived (1 hour); Roundcube silently refreshes them using the OIDC refresh token before expiry.

**OIDC configuration per client:**

| Parameter                  | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `email_oidc_enabled`       | Whether OIDC login is available for this client's email accounts |
| `email_oidc_providers`     | Which providers are enabled: `google`, `apple`, or both |
| `email_oidc_domain_restriction` | Optional: restrict OIDC login to users whose OIDC email matches the client's domain(s) |

> **OIDC is optional per client.** Clients who don't configure OIDC still have full
> access via application passwords. OIDC is an enhancement for clients who want
> password-less webmail access for their users.

**Dovecot OIDC integration options:**

| Approach                       | Complexity | Recommendation              |
| ------------------------------ | ---------- | --------------------------- |
| **Dovecot OAuth2 passdb**      | Medium     | Recommended — Dovecot natively supports OAuth2 token validation via passdb lookup |
| **Master password delegation** | Low        | Roundcube uses a Dovecot master password to authenticate on behalf of the OIDC-verified user |
| **Token-to-app-password swap** | Medium     | OIDC flow generates a short-lived app password used for the session |

> **Recommendation:** Use **Dovecot OAuth2 passdb** if the OIDC provider (Dex)
> can issue tokens Dovecot can validate. Fall back to **master password delegation**
> (simpler) where Roundcube authenticates to Dovecot using a master password after
> independently verifying the user's OIDC identity.

#### 11.3.2 Application Passwords

Application passwords are the primary credential for email access outside of OIDC.
They are used for:

- **IMAP/SMTP clients** (Thunderbird, Outlook, Apple Mail, mobile clients)
- **Webmail fallback** (manual login on the Roundcube login page)
- **Automated systems** (scripts that send email via SMTP)

**Key properties:**

| Property                   | Value                                               |
| -------------------------- | --------------------------------------------------- |
| Format                     | High-entropy random string (e.g., 32-char base62: `xK9m2pL7...`) |
| Scope                      | One app password per email account per purpose (or multiple per account) |
| Storage                    | Hashed (bcrypt/argon2) in app password database; plaintext stored **only** in client namespace Secret and platform vault for admin access |
| Rotation                   | Client can regenerate via management panel; admin can rotate via admin panel |
| Revocation                 | Instant — delete the app password, Dovecot rejects it on next auth attempt |
| Multiple per account       | Yes — client can create multiple app passwords (e.g., one for phone, one for desktop) with labels |
| Auto-generated on creation | Yes — one default app password created per email account during provisioning |

**App password lifecycle:**

```
1. CREATE
   Client (or admin) requests a new app password via management panel or API.
   → System generates a 32-character base62 random string (e.g. xK9m2pL7qR3vN8wZ...)
   → Plaintext is shown ONCE to the client in the panel (copy-to-clipboard prompt).
   → Plaintext is encrypted via Vault transit and stored in the client namespace Secret.
   → bcrypt/argon2id hash is stored in the `app_passwords` table.
   → Dovecot passdb (SQL) can now authenticate with this password.
   → Audit log: APP_PASSWORD_CREATED (label, creator, account)

2. USE
   Email client (Outlook, Thunderbird, iOS Mail, etc.) sends the plaintext password
   over IMAP/SMTP with STARTTLS or SSL.
   → Dovecot queries the `app_passwords` table for a matching hash.
   → On match: access granted. `last_used_at` column updated.
   → Failed attempts are logged and subject to fail2ban rate limiting.

3. VIEW (admin only)
   Admin decrypts plaintext from Vault transit to display in the admin panel.
   → Audit log: APP_PASSWORD_VIEWED (admin, account)

4. ROTATE
   Client clicks "Regenerate" (or admin triggers rotation).
   → New random string generated; old hash replaced in `app_passwords`.
   → New plaintext shown once; Vault Secret updated.
   → Old password immediately invalid — Dovecot next-auth check fails.
   → Audit log: APP_PASSWORD_ROTATED

5. REVOKE
   Client or admin deletes a specific app password.
   → Row deleted from `app_passwords`.
   → Vault Secret key for this password deleted.
   → Dovecot immediately rejects further authentication with this password.
   → Audit log: APP_PASSWORD_REVOKED
```

#### 11.3.3 App Password Service

The App Password Service is a microservice (or module within the Management API)
that manages the full lifecycle of email application passwords.

| Endpoint / Action          | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `POST /email/{account}/app-passwords` | Create a new app password for an email account |
| `GET /email/{account}/app-passwords`  | List app passwords (labels + creation dates; plaintext only for admin role) |
| `DELETE /email/{account}/app-passwords/{id}` | Revoke a specific app password |
| `POST /email/{account}/app-passwords/{id}/rotate` | Regenerate a specific app password |
| `POST /email/{account}/app-passwords/rotate-all` | Rotate all app passwords for an account (admin only) |

**Storage model:**

```sql
-- migrations/0042_app_passwords.sql
CREATE TABLE app_passwords (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id UUID       NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  label           TEXT        NOT NULL,                    -- "iPhone Mail", "Thunderbird"
  password_hash   TEXT        NOT NULL,                    -- argon2id hash
  vault_secret_key TEXT       NOT NULL,                    -- Vault transit key name for encrypted plaintext
  created_by      UUID,                                    -- admin or client user ID (nullable for system-created)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,                             -- updated by Dovecot passdb on each successful auth
  revoked_at      TIMESTAMPTZ                              -- non-null = revoked (soft delete)
);

CREATE INDEX app_passwords_account_idx ON app_passwords (email_account_id) WHERE revoked_at IS NULL;
```

Dovecot's SQL passdb query (in `dovecot-sql.conf.ext`):

```sql
password_query = \
  SELECT password_hash AS password \
  FROM app_passwords \
  WHERE email_account_id = (SELECT id FROM email_accounts WHERE CONCAT(username, '@', domain) = '%u') \
    AND revoked_at IS NULL \
  LIMIT 10
```

Dovecot tries each returned hash in order (one account can have multiple app passwords). The `last_used_at` column is updated via a separate `UPDATE` call after successful authentication, using a fire-and-forget queue to avoid blocking the auth path.

**Dovecot integration:**

App passwords are validated by Dovecot's passdb. The App Password Service syncs
password hashes to Dovecot's authentication backend:

| Dovecot passdb option      | How it works                                         |
| -------------------------- | ---------------------------------------------------- |
| **SQL passdb**             | Dovecot queries the app password table directly (MariaDB/PG) — recommended for simplicity |
| **Lua passdb**             | Custom Lua script that calls the App Password Service API to validate |
| **passwd-file passdb**     | App Password Service writes hashed passwords to a mounted file; Dovecot reads it |

> **Recommendation:** Use **SQL passdb** — Dovecot queries the shared MariaDB/PG
> instance for the password hash. The App Password Service writes to the same table.
> This avoids extra API calls in the auth path and keeps latency minimal.

#### 11.3.4 Admin Access to App Passwords

Admin users have **full read access** to all application passwords in plaintext.
This is necessary for:

- Client support (helping clients configure their email clients)
- Account recovery (resending credentials to clients)
- Security auditing (reviewing which passwords exist and when they were last used)

| Admin capability            | Description                                         |
| --------------------------- | --------------------------------------------------- |
| **View plaintext passwords**| Admin panel shows app passwords in cleartext (decrypted from vault) |
| **View usage metadata**     | Last used timestamp, created by, label, active status |
| **Rotate for client**       | Admin can regenerate any client's app password       |
| **Revoke for client**       | Admin can disable any app password immediately       |
| **Bulk operations**         | Rotate all passwords for a client; revoke all passwords for a client |
| **Audit log**               | All admin actions on app passwords are logged        |

**Security considerations for admin-readable passwords:**

| Concern                    | Mitigation                                           |
| -------------------------- | ---------------------------------------------------- |
| Plaintext at rest          | Encrypted via Vault transit engine (or Sealed Secret); decrypted only on admin request |
| Access control             | Only admin role can access plaintext; client role sees masked passwords |
| Audit trail                | Every plaintext password view/retrieval is logged with admin identity and timestamp |
| Rotation after admin view  | Optional policy: auto-rotate password N days after admin views it |
| Principle of least privilege | Consider: admin can view but not use passwords (no IMAP login as client) |

#### 11.3.5 Authentication Flow Summary

The complete authentication chain for a client accessing their email via a third-party mail client (e.g., Thunderbird, Apple Mail):

```
Mail Client (IMAP/SMTP)
        │
        │  username: user@domain.com
        │  password: <app-password>   ← NOT the platform panel password
        │
        ▼
Docker-Mailserver (Postfix / Dovecot)
        │
        │  Dovecot passdb lookup:
        │  - Hash app-password with argon2id
        │  - Compare against stored hash in MariaDB
        │    (app_passwords table, keyed by email + label)
        │
        ├─ Match → IMAP/SMTP session opened
        └─ No match → 421 Authentication failed
                      fail2ban increments counter
                      (3 failures → 1h ban of source IP)

Platform Panel (Client)
        │
        │  username: client@platform.com (OIDC email)
        │  password: Dex OIDC → Google/Apple/local
        │
        ▼
Dex OIDC Provider
        │
        │  Issues JWT (id_token + access_token)
        │  JWT claims: sub, email, roles, client_id
        │
        ▼
Management API (Fastify)
        │
        │  Validates JWT signature (Dex public key)
        │  Checks roles claim → client / admin / support
        │  Enforces client_id scoping (clients see only their data)
        │
        ├─ Valid → request processed
        └─ Invalid → 401 Unauthorized

Admin Panel
        │
        │  Same Dex OIDC flow
        │  Roles: admin / support (not client)
        │
        ▼
Management API
        │  Admin role → full access to all client data
        │  Support role → read + restore, no destructive actions
```

**Key properties:**
- Email authentication (IMAP/SMTP) uses **app passwords only** — the platform panel password is never used for mail clients
- App passwords are argon2id-hashed at rest; plaintext is shown once on creation and never again (except to admins via the admin panel, which decrypts from the secrets store)
- Platform panel authentication goes through Dex OIDC — supports Google, Apple, and local credentials
- JWTs are short-lived (1 hour); refresh tokens managed by Dex
- All authentication events (panel login, app password use, failed attempts) are logged to `audit_logs`

### 11.4 Email Account Provisioning

#### 11.4.1 During Client Onboarding

When a new client is created with `max_email_accounts > 0`:

#### 11.4.2 Client Self-Service (via Management Panel)

Clients can manage their email accounts and app passwords through the panel:

| Action                        | Description                                       |
| ----------------------------- | ------------------------------------------------- |
| **Create email account**      | New mailbox (up to `max_email_accounts` limit)    |
| **Delete email account**      | Remove mailbox + all app passwords + data         |
| **Create app password**       | Generate new app password with label              |
| **View app passwords**        | See list with labels, creation date, last used (masked; reveal on click) |
| **Regenerate app password**   | Replace existing app password (old one immediately revoked) |
| **Delete app password**       | Revoke a specific app password                    |
| **Configure OIDC**            | Enable/disable Google/Apple login for their email accounts |
| **Set webmail domain**        | Configure `webmail.client.com` custom domain       |
| **View IMAP/SMTP settings**   | Display server addresses, ports, encryption settings |

### 11.5 Roundcube Resource & Cost Impact

| Aspect                     | Impact                                               |
| -------------------------- | ---------------------------------------------------- |
| Pods added                 | 1 Roundcube pod (shared by all clients)              |
| CPU                        | 200m-500m (lightweight PHP app)                      |
| Memory                     | 256Mi-512Mi                                          |
| Database                   | 1 small database on shared MariaDB/PG (sessions, contacts, identities) |
| Storage                    | Minimal — no per-client PVs (all data in DB + Dovecot) |
| Ingress rules              | 1 platform default + 1 per client with custom webmail domain |
| TLS certificates           | 1 platform + 1 per client custom webmail domain      |
| App Password Service       | Minimal footprint — lightweight API, uses shared DB  |

> **Cost impact is negligible.** Roundcube adds a single lightweight pod. The App
> Password Service can be a module within the Management API (zero additional pods)
> or a separate microservice (one small pod). All data lives in the existing shared
> database infrastructure.

### 11.6 Email Security

| Concern                    | Implementation                                       |
| -------------------------- | ---------------------------------------------------- |
| No traditional passwords   | Email accounts have no user-facing "mailbox password" — all access is via OIDC or app passwords |
| App password strength      | System-generated only (32-char high-entropy); users cannot choose weak passwords |
| Brute force protection     | fail2ban on Dovecot auth logs (Docker-Mailserver built-in) + rate limiting on Roundcube login |
| App password audit trail   | All creation, rotation, revocation, and admin-view events logged |
| OIDC token validation      | Short-lived tokens; validated against Dex on every Roundcube session |
| Transport encryption       | IMAP: TLS/STARTTLS; SMTP: STARTTLS; Webmail: HTTPS (TLS at ingress) |
| At-rest encryption (passwords) | App password plaintext encrypted via Vault transit; hashes stored with argon2/bcrypt |
| Sending limits             | Per-account hourly/daily sending limits enforced by Postfix + tracked by platform |

---

## 12. Disaster Recovery & HA

> **Design principle:** All HA features are **optional upgrades**. The initial deployment
> runs on minimal infrastructure with single instances. HA is enabled incrementally as the
> business grows, budget allows, or uptime requirements demand it. Backups are **always
> required** regardless of HA level.

### 12.1 Availability Targets

| Parameter                      | Initial (No HA)    | With HA Enabled    |
| ------------------------------ | ------------------ | ------------------ |
| Recovery Time Objective (RTO)  | < 4 hours (manual restore) | < 30 minutes (automatic failover) |
| Recovery Point Objective (RPO) | < 24 hours (daily backups) | < 1 hour (replication + backups) |
| Target availability            | ~99.5% (allows for maintenance windows) | 99.9%+ |

### 12.2 High Availability Strategy — All Optional

Every HA feature below is an **opt-in upgrade**. The "Initial" column shows what ships
on day one; the "HA Upgrade" column shows what can be enabled later.

| HA Feature                     | Initial (Day 1)                    | HA Upgrade (Optional)                   | Trigger to Enable            |
| ------------------------------ | ---------------------------------- | --------------------------------------- | ---------------------------- |
| **Control plane**              | 1 node                            | 3 nodes (etcd quorum)                   | When unplanned CP downtime is unacceptable |
| **Worker nodes**               | 1-2 nodes                         | 3+ nodes (N+1 redundancy)              | When single-node capacity is exceeded |
| **Shared MariaDB**               | 1 instance (no replica)           | Primary + replica (auto-failover)       | When DB downtime risk is too high |
| **Shared PostgreSQL**          | 1 instance (no replica)           | Primary + replica (auto-failover)       | Same as MariaDB                |
| **Shared Redis**               | 1 instance                        | Redis Sentinel (auto-failover)          | When cache downtime affects clients |
| **Ingress controller**         | DaemonSet (1 per worker, auto)    | Scales automatically with workers      | Automatic — DaemonSet adds pod per new worker |
| **Shared web pod pool**        | 2 pods                            | 3-5 pods across nodes                  | When adding worker nodes     |
| **Storage (Longhorn)**         | Replication factor 1              | Replication factor 2-3                  | When adding storage capacity |
| **Pod disruption budgets**     | None                              | Set for platform services (min 1 avail)| When running multi-node     |
| **Anti-affinity rules**        | None                              | Spread platform services across nodes   | When running 3+ nodes       |
| **Multi-region / multi-cluster** | No                              | Active-passive or active-active         | At enterprise scale or compliance req |

> **The only non-optional requirement is backups.** Even on the minimal deployment,
> daily backups to the offsite server must be running. Everything else is an upgrade.

### 12.3 Backup & Restore

| Component           | Backup Method                      | Offsite (SSHFS mount) | Restore Tested? |
| ------------------- | ---------------------------------- | --------------------- | --------------- |
| Kubernetes state    | Velero (etcd + resource snapshots) | Daily (direct write)  | No              |
| Shared MariaDB        | mysqldump per client DB             | Daily (direct write)  | No              |
| Shared PostgreSQL   | pg_dump per client DB               | Daily (direct write)  | No              |
| Client site files   | rsync --archive (plain filesystem) | Daily (direct write)  | No              |
| Platform secrets    | Vault backup / Sealed Secrets in Git| On change     | Daily (direct write)  | No              |
| DNS zone data       | Zone file export                    | Daily         | Daily (direct write)  | No              |
| Email data          | Docker-Mailserver volume backup     | Daily         | Daily (direct write)  | No              |
| App password DB     | Included in shared DB dump          | Daily         | Daily (direct write)  | No              |
| Roundcube DB        | Included in shared DB dump          | Daily         | Daily (direct write)  | No              |
| Catalog images      | Stored in Harbor                    | On publish    | Daily (direct write)  | No              |

> Cluster-managed backups are written directly to the **external backup server** via SSHFS
> mount during the daily backup window (mount on demand, unmount when done — zero local disk
> consumed). Customer-created backups are stored on the offsite server (`customer-backups/` directory). See [Section 6.4](#64-data-backup-strategy)
> for offsite backup details.

### 12.4 Failover Procedures

> _Procedures differ based on whether HA is enabled._

| Scenario                    | Without HA (Initial)                             | With HA Enabled                            | Runbook Status |
| --------------------------- | ------------------------------------------------ | ------------------------------------------ | -------------- |
| Worker node failure         | Manual: restart node or rebuild + restore from backup | Automatic: K8s reschedules pods to healthy nodes | To document |
| Control plane failure       | Manual: restart node or rebuild cluster from backup | Automatic: etcd quorum maintains cluster | To document |
| Full cluster failure        | Rebuild cluster + restore from Velero backup      | Same (but less likely with HA)            | To document    |
| Shared DB failure           | Manual: restart pod, restore from backup if corrupt | Automatic: replica promotes to primary   | To document    |
| Ingress controller failure  | Manual: restart pod (brief downtime)              | Automatic: DNS removes dead worker IP; other workers handle traffic (DaemonSet) | To document    |
| DNS failure                 | Manual intervention                               | Failover to secondary DNS                 | To document    |
| Storage failure             | Restore PV from backup                            | Longhorn rebuilds replicas on healthy nodes | To document  |
| Compromised client site     | Isolate namespace, disable ingress, investigate   | Same                                      | To document    |
| Bad catalog image rollout   | Rollback to previous image version; redeploy affected clients | Same                          | To document    |

### 12.5 DR Testing

| Parameter            | Value                                |
| -------------------- | ------------------------------------ |
| DR drill frequency   | Quarterly                            |
| Last drill date      | N/A                                  |
| Backup restore test  | Monthly (automated, random client)   |
| Chaos engineering    | **Manual testing only** (MVP); automate with Litmus/Chaos Mesh in Phase 2 |

---

## 13. Migration Plan

### 13.1 Migration Strategy

Phased migration from Plesk to Kubernetes. Both platforms run in parallel during
the transition period. Clients are migrated in batches, starting with low-risk sites.

### 13.2 Migration Phases

| Phase | Name                    | Scope                                          | Est. Duration | Notes |
| ----- | ----------------------- | ---------------------------------------------- | -------- | ----- |
| 0     | **Foundation**          | K8s cluster setup, networking, storage, shared DB/Redis | **4-8 weeks** (1-2 eng) | Infrastructure baseline |
| 1     | **Platform Services**   | Management API/UI, catalog service, ingress, cert-manager, DNS, monitoring | **8-12 weeks** (1-2 eng) | MVP management platform |
| 2     | **Migration Service**   | Build Migration Service for Plesk, cPanel, Virtualmin; test against live panels | **6-10 weeks** (1-2 eng) | Data extraction & import |
| 3     | **Catalog Build**       | Build and test all required workload container images | **4-6 weeks** (1-2 eng) | PHP, Node, Python, Ruby runtimes |
| 4     | **Pilot Migration**     | Migrate 5-10 low-risk client sites from Plesk/cPanel/Virtualmin; validate workflows | **2-4 weeks** (1-2 eng) | Real-world testing |
| 5     | **Batch Migration**     | Migrate remaining clients in batches of 10-20 (panels mixed or grouped) | **4-12 weeks** (depends on batch sizes) | Operational phase |
| 6     | **Email Migration**     | Migrate self-hosted email clients; configure external provider integrations | **2-4 weeks** (concurrent) | Self-hosted or external |
| 7     | **Legacy Panel Decommission** | Final client cutover; shut down Plesk/cPanel/Virtualmin servers | **1-2 weeks** (cleanup) | Post-migration |
| **Total** | | | **32-58 weeks (8-14 months)** with 1-2 engineers | No hard deadline; phases can overlap |

### 13.3 Per-Client Migration Checklist

**Automated via Migration Service (all panels):**
- [ ] Authenticate to source panel (Plesk/cPanel/Virtualmin)
- [ ] Identify client's current runtime (PHP version, Node version, etc.)
- [ ] Determine target plan based on source resource usage
- [ ] Pre-flight validation:
  - [ ] Check storage quota availability
  - [ ] Check database size compatibility
  - [ ] Check email account count within plan limits
  - [ ] Verify PHP version compatibility with K8s catalog images
  - [ ] Test SSH/API connectivity to source panel
- [ ] Select appropriate catalog container image
- [ ] Extract all data from source panel:
  - [ ] Site files (via SFTP/rsync)
  - [ ] Database dump (via mysqldump/pg_dump)
  - [ ] Email accounts + mail data
  - [ ] SSL certificates
  - [ ] DNS records
  - [ ] .htaccess, php.ini, configuration files
  - [ ] Cron jobs (as scripts)
  - [ ] Add-on domains (if applicable)

**K8s Platform Creation:**
- [ ] Provision client namespace on K8s
- [ ] Create PersistentVolumeClaim for site files
- [ ] **(Starter)** Mount PV into shared pod pool, generate VirtualHost config
- [ ] **(Business/Premium)** Deploy dedicated web pod with matched catalog image
- [ ] Create Ingress rules for all client domains (primary + add-ons)
- [ ] Provision SSL certificates via cert-manager (Let's Encrypt)
- [ ] Create database + user on shared MariaDB/PostgreSQL instance
- [ ] Create email accounts on Docker-Mailserver

**Data Import:**
- [ ] Import site files to PersistentVolume
- [ ] Import database dump to shared instance
- [ ] Import email maildir data to Dovecot
- [ ] Apply DNS records via PowerDNS API
- [ ] Import SSL certificates (if available) or use Let's Encrypt

**Verification:**
- [ ] HTTP health check on each domain (verify site loads)
- [ ] Database connectivity test
- [ ] Email account login test (IMAP + SMTP + Roundcube)
- [ ] DNS propagation check
- [ ] Compare source vs. destination (file count, DB size, email accounts)

**Post-Migration Setup:**
- [ ] Provision SFTP access and share new credentials
- [ ] Set up OIDC account for management panel access
- [ ] Configure webmail domain (if client had webmail on source)
- [ ] Set up OIDC for email (if client wants Google/Apple login)
- [ ] Create initial backups
- [ ] Send welcome email with new access credentials

**Monitoring & Finalization:**
- [ ] Monitor for 48 hours post-migration (watch logs, error rates)
- [ ] Check DNS: client updates registrar nameservers (or auto-update if delegated)
- [ ] Verify traffic routing to K8s ingress
- [ ] Mark client as migrated in migration tracker
- [ ] Optionally remove from source panel (Plesk/cPanel/Virtualmin) or keep as fallback

### 13.4 Rollback Plan

If a client migration fails:
1. DNS reverted to point back to Plesk server
2. Client restored on Plesk (original data preserved until migration confirmed)
3. Issue investigated and resolved before retry
4. Plesk servers maintained as fallback until all migrations confirmed stable

### 13.5 Multi-Panel Native Migration Support

> **Design principle:** Support native migration from Plesk, cPanel, and Virtualmin/Webmin
> without requiring clients to manually export/import data. Automated, panel-specific
> migration tools extract data directly from source panels and import into Kubernetes platform.

#### 13.5.1 Supported Migration Sources

The platform provides automated migration tooling for three major control panels:

| Source Panel   | Supported Versions | Data Extracted                          | API/Access Method        |
| -------------- | ------------------ | --------------------------------------- | ------------------------ |
| **Plesk**      | 18.0+              | Sites, databases, emails, DNS, SSL certs, file permissions | Plesk RPC API, SSH file sync |
| **cPanel**     | 94+                | Accounts, databases, emails, addon domains, SSL, DNS | cPanel API, CPAN modules, file sync |
| **Virtualmin** | 6.0+               | Virtual servers, databases, emails, DNS, SSL certs | Virtualmin API, SSH, file sync |

#### 13.5.2 Common Data Extracted from All Panels

Regardless of source panel, the migration process extracts:

| Data Type           | How It's Extracted                                    |
| ------------------- | ----------------------------------------------------- |
| **Website files**   | Via SFTP/SSH rsync or panel-provided backup export    |
| **Databases**       | mysqldump (MariaDB) or pg_dump (PostgreSQL) via SSH     |
| **Email accounts**  | Exported via API + mail data via SFTP (maildir/mbox)  |
| **SSL certificates**| Extracted from panel certificate store                |
| **DNS records**     | Exported via API or zone file export                  |
| **Domain info**     | Domain names, registrar info, nameservers             |
| **File ownership**  | Unix user/group/permissions metadata                 |
| **Configuration**   | .htaccess, php.ini overrides, cron jobs (extracted as scripts) |

#### 13.5.3 Plesk-Specific Migration

**Source:** Plesk RPC API + SSH file access

**Plesk Migration Workflow:**

1. **Authenticate to Plesk**: Provide RPC API credentials (admin or reseller account)
2. **Discover clients**: Query Plesk API for list of subscriptions/domains to migrate
3. **Select clients**: Admin selects which clients to migrate in this batch
4. **Pre-flight checks**:
   - Verify database size fits destination
   - Verify storage quota available on destination
   - Verify email accounts count within plan limits
   - Test SSH connectivity to Plesk server
5. **Extract data**:
   - API call: Get domain, database, email, DNS, SSL info
   - SSH rsync: Copy /var/www/vhosts/{domain}/* to temp staging area
   - SSH command: mysqldump per database
   - SSH command: Backup mail data from /var/vmail
6. **Transform data**:
   - Parse Plesk-specific configuration files (.htaccess, php.ini overrides)
   - Convert Plesk DNS records to standard format
   - Extract SSL certificate + key
   - Identify PHP version, required extensions
7. **Map to K8s resources**:
   - Determine target plan (Starter/Business/Premium based on resource usage)
   - Select appropriate catalog image (Apache+PHP version)
   - Generate namespace configuration
8. **Create K8s resources**:
   - Create client namespace
   - Create PersistentVolumeClaim
   - Deploy pod (shared or dedicated based on plan)
   - Create Ingress rules for all domains
   - Create cert-manager Certificate for SSL
9. **Import data**:
   - Copy files to PV
   - Create database + user on shared instance
   - Import database dump
   - Create email accounts on Docker-Mailserver
   - Import mail data to Dovecot maildir
   - Apply DNS records via PowerDNS API
10. **Post-import verification**:
    - HTTP health check on each domain
    - Database connectivity test
    - Email account login test (IMAP + SMTP)
    - DNS propagation check
11. **DNS cutover**:
    - Update client's domain registrar nameservers (or provide instructions)
    - Monitor DNS propagation
    - Verify traffic routing to K8s ingress
12. **Cleanup**:
    - Verify client data in K8s platform
    - Remove temporary staging files
    - Mark client as migrated in migration tracker

**Plesk API Integration Details:**

The Migration Service communicates with Plesk over its XML-RPC API (HTTP POST to `/enterprise/control/agent.php`). Authentication uses a Plesk admin API key (preferred) or username/password.

```typescript
// migration-service/src/adapters/plesk.ts
const PLESK_API_URL = `https://${host}:8443/enterprise/control/agent.php`

// List all subscriptions (clients):
const listSubscriptions = async (): Promise<PleskSubscription[]> => {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
    <packet><webspace><get><filter/><dataset><gen_info/><disk_usage/><php/></dataset></get></webspace></packet>`
  const res = await fetch(PLESK_API_URL, {
    method: 'POST',
    headers: {
      'HTTP_AUTH_LOGIN': credentials.username,
      'HTTP_AUTH_PASSWD': credentials.password,
      'Content-Type': 'text/xml',
    },
    body,
  })
  return parsePleskXml(await res.text())
}

// Get database list for a subscription:
const getDatabases = async (domainId: string) => {
  const body = `<packet><db><get-db-list><filter><site-id>${domainId}</site-id></filter></get-db-list></db></packet>`
  // ...
}

// Get email accounts for a domain:
const getEmailAccounts = async (domain: string) => {
  const body = `<packet><mail><get-list><filter><site>${domain}</site></filter></get-list></mail></packet>`
  // ...
}
```

Key Plesk API endpoints used:

| Operation | API path / packet type | Notes |
|-----------|----------------------|-------|
| List subscriptions | `<webspace><get>` | Returns domains, disk usage, PHP version |
| Get databases | `<db><get-db-list>` | Per domain — includes DB name, user, type |
| Get email accounts | `<mail><get-list>` | Per domain — includes quota, aliases |
| Get DNS records | `<dns><get_rec>` | Per domain — A, MX, TXT, CNAME |
| Get SSL cert | `<certificate><get>` | Per domain — PEM-encoded cert + key |
| Get FTP accounts | `<ftp><get_accs>` | Per domain — used to note access methods |

#### 13.5.4 cPanel-Specific Migration

**Source:** cPanel API v2 + SSH file access

**cPanel Migration Workflow:**

1. **Authenticate to cPanel**: Provide root SSH key or API token
2. **Discover accounts**: Query cPanel API for list of accounts
3. **Select accounts**: Admin selects which accounts to migrate
4. **Pre-flight checks**: Same as Plesk
5. **Extract data**:
   - API call: Get account info, databases, email accounts, SSL, add-on domains
   - SSH rsync: Copy /home/{user}/public_html/* to staging
   - SSH rsync: Copy /home/{user}/public_html for add-on domains
   - SSH command: mysqldump per database
   - SSH command: Backup /home/{user}/mail directories
   - Extract .htaccess, php.ini overrides
6. **Transform data**:
   - Parse cPanel account metadata
   - Convert addon domains to K8s domains
   - Extract PHP version, custom configuration
   - Process email forwarders, autoresponders
7. **Map to K8s**: Same as Plesk
8. **Create K8s resources**: Same as Plesk
9. **Import data**: Same as Plesk, plus:
   - Create addon domains as Ingress rules
   - Restore email forwarders + autoresponders
10. **Post-import verification**: Same as Plesk
11. **DNS cutover**: Same as Plesk
12. **Cleanup**: Same as Plesk

**cPanel API Integration Details:**

The Migration Service communicates with cPanel via the UAPI (preferred for cPanel 82+) or cPanel API2 over HTTPS on port 2087 (WHM) or 2083 (cPanel user). Authentication uses a WHM API token (root or reseller level).

```typescript
// migration-service/src/adapters/cpanel.ts
const WHM_BASE = `https://${host}:2087/json-api`
const CPANEL_BASE = `https://${host}:2083/execute`

// List all cPanel accounts (WHM API):
const listAccounts = async (): Promise<CpanelAccount[]> => {
  const res = await fetch(`${WHM_BASE}/listaccts?api.version=1`, {
    headers: { Authorization: `whm ${credentials.username}:${credentials.apiToken}` },
  })
  const { data } = await res.json()
  return data.acct  // array of { user, domain, ip, diskused, ... }
}

// List databases for an account (UAPI via WHM):
const getDatabases = async (username: string): Promise<CpanelDatabase[]> => {
  const res = await fetch(
    `${WHM_BASE}/cpanel?cpanel_jsonapi_user=${username}&cpanel_jsonapi_module=Mysql&cpanel_jsonapi_func=list_databases&api.version=1`,
    { headers: { Authorization: `whm ${credentials.username}:${credentials.apiToken}` } },
  )
  const { result } = await res.json()
  return result.data  // array of { database, diskusage }
}
```

Key cPanel/WHM API endpoints used:

| Operation | WHM/UAPI endpoint | Notes |
|-----------|------------------|-------|
| List accounts | `WHM: /json-api/listaccts` | Root-level; returns all hosted accounts |
| List databases | `WHM: cpanel?module=Mysql&func=list_databases` | Per user |
| List email accounts | `WHM: cpanel?module=Email&func=list_pops` | Per user, returns quota |
| List addon domains | `WHM: cpanel?module=AddonDomain&func=listaddondomains` | Per user |
| List SSL certs | `WHM: cpanel?module=SSL&func=installed_host` | Per domain |
| List DNS zones | `WHM: /json-api/dumpzone?domain=...` | Full zone dump |
| Export full backup | `WHM: /json-api/pkgacct?user=...` | `.tar.gz` backup; used as fallback |

#### 13.5.5 Virtualmin/Webmin-Specific Migration

**Source:** Virtualmin API + SSH file access

**Virtualmin Migration Workflow:**

1. **Authenticate to Virtualmin**: Provide RPC login credentials or API key
2. **Discover virtual servers**: Query Virtualmin API for list of virtual servers
3. **Select servers**: Admin selects which servers to migrate
4. **Pre-flight checks**: Same as Plesk/cPanel
5. **Extract data**:
   - API call: Get virtual server info, databases, email, SSL, DNS zones
   - SSH rsync: Copy web root (typically /home/{user}/public_html or /var/www/vhosts)
   - SSH command: mysqldump or pg_dump per database
   - SSH command: Backup mail directory
   - Extract .htaccess, php configuration
6. **Transform data**:
   - Parse Virtualmin virtual server metadata
   - Extract PHP version, custom configuration
   - Process email accounts, forwarders, aliases
   - Convert Virtualmin-style cron jobs to standard format
7. **Map to K8s**: Same as Plesk/cPanel
8. **Create K8s resources**: Same as Plesk/cPanel
9. **Import data**: Same as Plesk/cPanel
10. **Post-import verification**: Same as Plesk/cPanel
11. **DNS cutover**: Same as Plesk/cPanel
12. **Cleanup**: Same as Plesk/cPanel

**Virtualmin API Integration Details:**

The Migration Service communicates with Virtualmin via its remote API (HTTP GET/POST to `/virtual-server/remote.cgi`) using HTTP Basic Auth or an API key. The Virtualmin API uses a simple key=value or JSON response format.

```typescript
// migration-service/src/adapters/virtualmin.ts
const VMIN_BASE = `https://${host}:10000/virtual-server/remote.cgi`

// List all virtual servers:
const listVirtualServers = async (): Promise<VirtualminServer[]> => {
  const params = new URLSearchParams({
    program: 'list-domains',
    'name-only': '1',
    multiline: '1',
  })
  const res = await fetch(`${VMIN_BASE}?${params}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
    },
  })
  return parseVirtualminOutput(await res.text())
}

// Get info for a specific virtual server:
const getDomainInfo = async (domain: string) => {
  const params = new URLSearchParams({ program: 'info', domain, multiline: '1' })
  const res = await fetch(`${VMIN_BASE}?${params}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` },
  })
  return parseVirtualminOutput(await res.text())
}
```

Key Virtualmin API programs used:

| Operation | `program=` param | Notes |
|-----------|-----------------|-------|
| List virtual servers | `list-domains` | Returns all virtual servers; `--multiline` for detailed output |
| Get domain info | `info` | Disk usage, home dir, web root, PHP version |
| List databases | `list-databases` | Per domain — MySQL and PostgreSQL |
| List email accounts | `list-users` | Per domain |
| Get DNS records | `list-dns` | Per domain zone |
| Export backup | `backup-domain` | Full `.tar.gz` backup; used as fallback if granular extract fails |
| Get SSL cert | `get-ssl` | Returns PEM cert for the domain |

The Virtualmin API response format is a plain text key-value block (one record per virtual server, separated by blank lines). The Migration Service includes a parser that handles both the legacy Webmin format and the Virtualmin 7+ JSON output.

#### 13.5.6 Migration Tool Architecture

The platform includes a **Migration Service** — a dedicated microservice that handles
all data extraction, transformation, and import:

**Migration Service Storage & Queuing:**

| Component        | Purpose                                         |
| ---------------- | ----------------------------------------------- |
| **Job Queue**    | Redis queue (Celery/Bull) for async migration jobs |
| **Progress DB**  | Track per-client migration status + logs         |
| **Staging Area** | Longhorn PV for temporary extracted data          |
| **Logs**         | Loki integration for detailed migration logs     |

#### 13.5.7 Migration Admin Panel Features

The admin panel provides full visibility and control over migrations:

**Pre-Migration:**
- Source panel credentials input (Plesk RPC, cPanel API token, Virtualmin SSH key)
- Discover and list all clients on source panel
- Bulk select clients for migration batch
- Pre-flight validation report (storage, database, email account space, PHP version compatibility)
- Estimated migration duration per client
- Option to auto-assign target plan based on source resource usage

**During Migration:**
- Real-time progress tracking per step (extraction, transformation, import, verification)
- Per-client status dashboard (pending, running, verifying, completed, failed, rolled back)
- Ability to pause, resume, or cancel individual migrations
- Live log view for troubleshooting failed migrations
- Manual intervention options (e.g., fix SSL cert import issue, re-run DNS sync)

**Post-Migration:**
- Verification report (HTTP tests, database tests, email tests, DNS checks)
- Comparison view: source vs destination (file count, database size, email accounts)
- DNS instructions if manual update needed (e.g., update registrar nameservers)
- Bulk email notifications to migrated clients with new panel access info
- Option to immediately decomission source client on old panel or keep as fallback

#### 13.5.8 Migration Error Handling & Rollback

| Error Scenario                | Action                                          |
| ----------------------------- | ----------------------------------------------- |
| SSH connection fails          | Retry with exponential backoff; alert admin     |
| Database dump fails           | Check disk space, user permissions; retry       |
| File rsync timeout            | Resumable rsync; continue from last checkpoint  |
| SSL cert extraction fails     | Skip cert, create new via cert-manager + Let's Encrypt; alert admin |
| Email import fails            | Skip mailbox, create empty account; notify admin |
| K8s resource creation fails   | Rollback: delete partial namespace, retry       |
| Post-import verification fails| Keep K8s namespace, don't update DNS; investigate |
| Manual rollback              | Option: delete K8s namespace, restore source client on old panel |

#### 13.5.9 Supported Features Per Panel

| Feature                    | Plesk | cPanel | Virtualmin |
| -------------------------- | ----- | ------ | ---------- |
| Website files migration    | ✅    | ✅     | ✅         |
| Database migration         | ✅    | ✅     | ✅         |
| Email accounts migration   | ✅    | ✅     | ✅         |
| Email data (maildir) migration | ✅ | ✅     | ✅         |
| SSL certificate migration  | ✅    | ✅     | ✅         |
| DNS zone migration         | ✅    | ✅     | ✅         |
| Cron job migration         | ⚠️ (as scripts) | ⚠️ (as scripts) | ⚠️ (as scripts) |
| .htaccess migration        | ✅    | ✅     | ✅         |
| php.ini overrides          | ✅    | ⚠️ (from .user.ini) | ✅ |
| Add-on domains             | ✅    | ✅     | ✅ (sub-servers) |
| Database users             | ✅    | ✅     | ✅         |
| Email forwarders           | ✅    | ✅     | ✅         |
| Mail autoresponders        | ✅    | ✅     | ✅         |
| FTP/SFTP accounts          | ✅ (mapped to OS users) | ✅ (mapped to OS users) | ✅ (mapped to OS users) |
| File permissions           | ✅ (preserved)      | ✅ (preserved)      | ✅ (preserved) |
| Backups                    | ✅ (exported as backup reference) | ✅ | ✅ |

> ⚠️ = Partial support or requires manual post-migration configuration

---

## 14. Infrastructure Provider & Cost Analysis

> **Status:** Recommendations based on target revenue of $0-5k/month and premium positioning.
> Detailed pricing to be finalized after provider evaluation.

### 14.1 Infrastructure Provider Recommendations


>
> This section provides a summary; see the comparison document for:
> - Full cost breakdowns with projected 12-month timelines
> - Performance benchmarks (storage I/O, network latency)
> - Risk analysis & mitigation strategies
> - Step-by-step implementation guides (Terraform, CLI, manual)
> - Monthly invoice examples

Based on the decision to use Debian 13, k3s, and self-managed Kubernetes, three providers
stand out for excellent value and suitability:

#### Option 1: **Hetzner Cloud** (Recommended for EU/Global)

**Strengths:**
- Excellent price-to-performance ratio
- Reliable, fast infrastructure
- Great for self-managed K8s
- EU data center options (GDPR-friendly)
- Simple and transparent pricing
- Excellent community and documentation

**Instance Types for Initial Deployment:**

| Component          | Recommended Instance | vCPU | RAM  | Cost/mo (EUR) |
| ------------------ | -------------------- | ---- | ---- | ------------- |
| Control Plane      | CPX21 or CX21        | 4    | 8GB  | €10-15        |
| Worker Node 1      | CPX21 or CX21        | 4    | 8GB  | €10-15        |
| Storage (Longhorn) | Volume (200GB)       | -    | -    | €8-10         |
| Network            | Public IP              | -  | -    | €1-3          |
| **Total (Minimal)**| -                    | -    | -    | **~€38-48/mo**|

**Growth Path:**
- Add Worker Node 2 (CPX21): +€10-15/mo when needed
- Scale Longhorn storage as required: +€0.04/GB/mo
- Add HA: 1 additional CP node (CPX21) + replicated storage

**Hetzner Locations:** DE (Frankfurt), Finland, USA (Virginia)

---

#### Option 2: **OVH Cloud** (Alternative, Good Global Presence)

**Strengths:**
- Global data center presence (EU, Canada, Singapore, Australia)
- Competitive pricing
- Good for enterprise clients
- Strong GDPR compliance
- Baremetal options available if needed later

**Instance Types for Initial Deployment:**

| Component          | Recommended Instance | vCPU | RAM  | Cost/mo (EUR) |
| ------------------ | -------------------- | ---- | ---- | ------------- |
| Control Plane      | b2-4 or d2-4         | 4    | 16GB | €15-20        |
| Worker Node 1      | b2-4 or d2-4         | 4    | 16GB | €15-20        |
| Storage (Block)    | Volume (200GB)       | -    | -    | €10-12        |
| Network            | Public IP            | -    | -    | €1-3          |
| **Total (Minimal)**| -                    | -    | -    | **~€49-58/mo**|

**Growth Path:**
- Add Worker Node 2 (b2-4): +€15-20/mo
- Scale storage as required: +€0.05/GB/mo
- Add HA: 1 additional CP node + replicated storage

**OVH Locations:** EU (FR, DE, UK), Canada, Singapore, Australia, USA

---

#### Option 3: **Linode / AWS Lightsail** (Global, Higher Cost)

**Strengths:**
- Excellent global presence
- Good managed services options
- High reliability
- Larger ecosystem

**Typical Costs (Lightsail):**
- 4GB / 2vCPU instances: ~$20-25/mo each
- **Total (minimal, 2 nodes):** ~$50-60/mo
- **Higher cost than Hetzner/OVH**, but good if already in AWS ecosystem

---

### 14.2 Provider Comparison Matrix

| Criteria                    | Hetzner           | OVH               | Linode/AWS        |
| --------------------------- | ----------------- | ----------------- | ----------------- |
| **Price (minimal setup)**   | €40-50/mo (⭐⭐⭐⭐⭐) | €50-60/mo (⭐⭐⭐⭐)| $50-60/mo (⭐⭐⭐)  |
| **Performance**             | Excellent (⭐⭐⭐⭐⭐) | Very Good (⭐⭐⭐⭐) | Very Good (⭐⭐⭐⭐) |
| **Documentation**           | Excellent (⭐⭐⭐⭐⭐) | Good (⭐⭐⭐⭐)     | Excellent (⭐⭐⭐⭐⭐)|
| **K8s-friendly**            | Excellent (⭐⭐⭐⭐⭐) | Very Good (⭐⭐⭐⭐) | Very Good (⭐⭐⭐⭐) |
| **EU Compliance**           | Excellent (⭐⭐⭐⭐⭐) | Excellent (⭐⭐⭐⭐⭐) | Good (⭐⭐⭐⭐)     |
| **Global Presence**         | Good (3 regions)  | Excellent (6 regions) | Excellent (20+ regions) |
| **Community**               | Large (⭐⭐⭐⭐⭐) | Moderate (⭐⭐⭐⭐)  | Very Large (⭐⭐⭐⭐⭐)|
| **Scaling Ease**            | Easy (⭐⭐⭐⭐⭐) | Easy (⭐⭐⭐⭐)      | Easy (⭐⭐⭐⭐⭐) |

**Recommendation:** **Hetzner for cost optimization** (€40-50/mo), or **OVH if global presence required**.

---

### 14.3 Detailed Cost Estimation — Initial Deployment

Based on Hetzner pricing (EUR, typical scenario):

#### Infrastructure Costs

| Component                 | Unit Cost | Qty | Monthly Cost | Notes |
| ------------------------- | --------- | --- | ------------ | ----- |
| **Control Plane (CPX21)** | €12/mo    | 1   | €12          | 4 vCPU, 8GB RAM, NVMe SSD |
| **Worker Node 1 (CPX21)** | €12/mo    | 1   | €12          | Can run 50-100 Starter + platform services |
| **Longhorn Storage (200GB)** | €0.04/GB/mo | 200 | €8         | Scales as needed; thin provisioning |
| **Public IP**             | €1-3/mo   | 1   | €1-3         | Per worker node (included with most VPS) |
| **Bandwidth** (estimate)  | €0.20/GB  | 100 | €20          | ~100GB/mo for 50-100 clients (conservative) |
| **Control Plane Backup (snapshots)** | €0.40/GB/mo | 10 | €4 | Daily snapshots |
| **Subtotal Infrastructure** | - | - | **€59/mo** | - |

#### Software & Services (Monthly Estimate)

| Service                  | Cost     | Notes |
| ------------------------ | -------- | ----- |
| **External SFTP Backup** | $5-10/mo | Offsite backup to separate provider |
| **DNS (PowerDNS) + NetBird VPN** | €8/mo | 2x Hetzner CX22 (Falkenstein + Helsinki): DNS + admin VPN co-hosted |
| **Container Registry (Harbor)** | Free | Self-hosted |
| **Monitoring Stack (Prometheus/Loki)** | Free | Self-hosted |
| **External SMTP for notifications** | $10-20/mo (optional) | SendGrid/Mailgun; or use Docker-Mailserver (free) |
| **OIDC (Dex)**           | Free     | Self-hosted |
| **Subtotal Software** | **$23-38/mo** | DNS/VPN infra (€8) + optional services |

#### **Total Monthly Infrastructure Cost: €83-98 (~$88-103 USD)**

---

### 14.4 Cost Scaling

| Growth Stage | Cluster Nodes | DNS/VPN VPS | Monthly Cost | Rationale |
| ------------ | ------------- | ----------- | ------------ | --------- |
| **MVP (single node)** | 1 (CP+Worker) | 2 (ns1+ns2) | €23-30 | Minimum viable: 1 cluster node + 2 DNS/VPN VPS. 0-20 clients. |
| **Minimal** | 1 CP + 1 worker | 2 (ns1+ns2) | €48-58 | Pilot phase, 20-50 clients |
| **Growing** | 1 CP + 2 workers | 2 (ns1+ns2) | €63-83 | 50-150 Starter + 30 Business clients |
| **Established** | 1 CP + 3 workers | 2 (ns1+ns2) | €83-103 | 200+ Starter + 50+ Business clients |
| **HA-ready** | 3 CP + 3 workers | 2 (ns1+ns2) | €158-188 | Full redundancy for mission-critical deployments |

> **Note:** DNS/VPN VPS cost (€8/month for 2x CX22) is constant across all stages. These are external to the k3s cluster.

> **Key insight:** Marginal cost per additional Starter client is **near zero** (shared pod model).
> Most incremental cost comes from Business/Premium clients (dedicated pods) and storage growth.

---

### 14.5 Revenue vs. Infrastructure Cost (Break-Even Analysis)

Assuming premium positioning with target pricing:

| Scenario | Starter Clients | Business Clients | Premium Clients | MRR      | Infra Cost | Margin |
| -------- | --------------- | ---------------- | --------------- | -------- | ---------- | ------ |
| **Minimal** | 30 | 5 | 2 | $347 | €59 | 79% |
| **Growing** | 80 | 20 | 3 | $1,388 | €70 | 95% |
| **Established** | 150 | 40 | 5 | $2,760 | €85 | 97% |
| **Scale** | 300 | 80 | 10 | $5,685 | €120 | 98% |

> **Margin = (MRR - Infra Cost in USD) / MRR**
> 
> Even at minimal scale ($347/mo MRR), infrastructure overhead is only 17%.
> As you grow, infrastructure costs become negligible due to the shared pod model.

---

### 14.6 Next Steps: Provider Selection

1. **Create Hetzner account** (recommended) or OVH account
2. **Provision initial minimal cluster** (1 CP + 1 worker)
3. **Run cost tracking for 1 month** to validate estimates
4. **Document actual bandwidth and storage usage**
5. **Refine cost model** based on real data
6. **Plan HA upgrade** when revenue justifies it

---

## Appendix

### A. Decision Log

| Date       | Decision                              | Rationale                                     |
| ---------- | ------------------------------------- | --------------------------------------------- |
| 2026-02-27 | Kubernetes + Docker                   | Replace manual Plesk config with declarative orchestration |
| 2026-02-27 | Self-managed K8s (bare metal/VPS)     | Full control, no cloud vendor lock-in         |
| 2026-02-27 | Namespace-per-client isolation        | Balance of isolation vs. overhead for 50-200 clients |
| 2026-02-27 | SFTP + Git + File Manager             | Preserve existing client workflows while offering modern options |
| 2026-02-27 | Hybrid email (self-hosted + external) | Flexibility — not all clients want self-hosted email |
| 2026-02-27 | Custom management panel               | No existing panel maps to multi-tenant K8s web hosting |
| 2026-02-27 | OIDC (Google + Apple)                 | Modern auth, no password management burden    |
| 2026-02-27 | fail2ban across all services          | Proven intrusion prevention, familiar tooling |
| 2026-02-27 | Optional WAF (ModSecurity/Coraza)     | Protect client sites from common web attacks  |
| 2026-02-27 | Centralized workload container catalog | Security, consistency, efficient updates — clients select, don't build |
| 2026-02-27 | Shared DB instances (revised from dedicated) | ~98% fewer DB pods, major cost savings, isolation via DB-level users |
| 2026-02-27 | Shared Redis with ACLs                | Single instance serves all clients; per-client key isolation |
| 2026-02-27 | Scale-to-zero for idle dedicated sites | Reclaim resources from inactive Business-plan clients |
| 2026-02-27 | Resource overcommit (Burstable QoS)   | Most sites are idle; overcommit allows higher density |
| 2026-02-27 | Hybrid workload model (shared + dedicated) | Starter clients share Apache+PHP pods; Business/Premium get dedicated pods |
| 2026-02-27 | All HA features optional              | Start with minimal single-instance deployment to reduce initial costs; HA enabled incrementally |
| 2026-02-27 | Offsite backups to external SFTP/SSH  | Daily upload to external server for disaster recovery — survives complete cluster/provider failure |
| 2026-02-27 | Fully customizable plans + per-client overrides | All plan parameters are global defaults that can be overridden per-client via management panel |
| 2026-02-27 | Application Catalog for complex workloads | Helm-chart-based catalog for apps like Nextcloud, BBB, Jitsi — deployed by admin or requested by clients |
| 2026-02-27 | Configurable tenancy per application | Some apps multi-tenant (Nextcloud), others single-tenant (BBB) — admin decides per app |
| 2026-02-27 | Email notification system for all events | Configurable per-event email notifications to admin and clients; digest mode for low-priority events |
| 2026-02-27 | Roundcube for webmail | Lightweight, battle-tested, single shared instance, integrates with Docker-Mailserver, familiar to Plesk-migrating clients |
| 2026-02-27 | Client-level webmail domains | Per-client Ingress rules (e.g., webmail.client.com) pointing to shared Roundcube — branded webmail access |
| 2026-02-27 | OIDC login for email (optional per client) | Google/Apple sign-in for Roundcube via Dex; eliminates password management for webmail |
| 2026-02-27 | Application passwords for email | No traditional mailbox passwords; all email auth via system-generated app passwords or OIDC; auto-provisioned on account creation |
| 2026-02-27 | Admin-readable app passwords | Plaintext stored vault-encrypted; admin can view, rotate, revoke any client's app passwords for support and security |
| 2026-02-27 | Modern, responsive management panels | Admin + client panels as single SPA codebase; light/dark modes, customizable accent color and branding (logo, platform name) |
| 2026-02-27 | Fast-loading panels (< 2.5s LCP) | Vite + code splitting, lazy loading, optimized images; React/Vue/Svelte with TypeScript |
| 2026-02-27 | API-driven panel architecture | Panels powered by REST API; separation of concerns, enables future mobile app development |
| 2026-02-27 | Themeable branding system | CSS variables for accent color (HSL); dynamic logo, favicon, platform name in Vault; no code changes for rebranding |

### B. Open Questions & Remaining TBDs

**Decisions Made (2026-02-27):**
- ✅ K8s distribution: **k3s** (lightweight, ideal for learning)
- ✅ CNI plugin: **Flannel** (k3s default) → Calico upgrade path
- ✅ Ingress controller: **NGINX Ingress Controller** (k3s default Traefik disabled via `--disable traefik`). See ADR-010.
- ✅ OIDC provider: **Dex** (lightweight federation)
- ✅ Secrets backend: **Sealed Secrets** (GitOps-friendly)
- ✅ WAF engine: **ModSecurity** (with NGINX)
- ✅ Email model: **Hybrid** (self-hosted + external provider option)
- ✅ Hosting plans: **Starter / Business / Premium**
- ✅ Target positioning: **Premium** (quality over low-cost competition)
- ✅ Base OS: **Debian 13** (lightweight, cutting-edge stable)

**Remaining TBDs:**

> Items marked ✅ have been resolved in other planning documents. Items marked `[ ]` are still open.

- [x] ~~Bare metal servers or VPS provider?~~ **Resolved:** Hetzner Cloud (primary), OVH as warm standby. See `TECH_STACK_SUMMARY.md §Infrastructure Costs` and `05-advanced/MULTI_CLOUD_STRATEGY.md`.
- [x] ~~Exact node specifications and monthly costs.~~ **Resolved:** Minimal: 1×cx21 control + 1×cx31 worker (~€31–52/mo); HA: 3×cx21 control + 3×cx41 worker (~€82–124/mo). See `TECH_STACK_SUMMARY.md §Infrastructure Costs`.
- [ ] Team size and on-call structure?
- [ ] Compliance requirements (GDPR, PCI-DSS, SOC 2)? See `03-security/COMPLIANCE_MATRIX.md` for partial coverage.
- [ ] Target launch date for pilot migration?
- [ ] Which PHP extensions to include in default images?
- [ ] Client data residency requirements (EU-only hosting)?
- [ ] How many Starter clients per shared pod (20? 50? auto-scale threshold)?
- [ ] What is the upgrade trigger from Starter to Business (client request only, or resource-based)?
- [ ] When should HA be enabled? (client count threshold, revenue threshold, or SLA commitment?)
- [ ] External SFTP/SSH backup server provider and location?
- [ ] Bandwidth/storage budget for offsite backups?
- [x] ~~Which plan parameters should clients be able to self-service upgrade?~~ **Resolved:** All plan changes are admin-only via Management API. Clients cannot self-service upgrade/downgrade. See `BILLING_MODEL_CHANGES.md`.
- [ ] Which applications should be available in the Application Catalog at launch?
- [ ] Pricing model for application instances (flat fee, per-user, resource-based)?
- [x] ~~Should application instances be included in daily offsite backups?~~ **Resolved:** Yes — application data is included in the cluster-managed Tier 1 backup pipeline (free to clients, not counted against quota). See `BACKUP_STRATEGY.md`.
- [x] ~~External SMTP relay provider for notification emails.~~ **Resolved:** SendGrid, Mailgun, Brevo, and AWS SES are all supported as configurable per-customer relay options. See `ADMIN_PANEL_REQUIREMENTS.md §EC.1` and `EMAIL_SERVICES.md`.
- [ ] Which notification events should clients be able to opt out of?
- [ ] Email template branding and language requirements?
- [x] ~~Dovecot OIDC integration method?~~ **Resolved:** App Password model (argon2id-hashed, per-account passwords stored in MariaDB). Clients never use their OIDC panel password for mail clients. See §11.3 above and `EMAIL_SERVICES.md`.
- [x] ~~App Password Service as standalone microservice or module within Management API?~~ **Resolved:** Module within Management API. See `MANAGEMENT_API_SPEC.md` and `EMAIL_ENHANCEMENTS_SPECIFICATION.md`.
- [ ] App password auto-rotation policy after admin views plaintext? (e.g., 30 days)
- [ ] Maximum number of app passwords per email account?
- [x] ~~Should clients be able to create email accounts via API (not just panel)?~~ **Resolved:** Yes — Management API exposes email management endpoints accessible via API tokens. See `MANAGEMENT_API_SPEC.md §Email`.
- [ ] Roundcube plugin selection — which plugins to enable by default?
- [ ] Default email account(s) created during client onboarding (e.g., admin@, info@)?
- [x] ~~Frontend framework: React, Vue 3, or Svelte?~~ **Resolved:** React 18+ with Vite. See `TECH_STACK_SUMMARY.md §Development & Testing` and `PHASE_1_ROADMAP.md`.
- [x] ~~Monorepo for admin + client panels, or separate repos?~~ **Resolved:** Monorepo (`hosting-platform/` with `frontend/admin-panel/` and `frontend/client-panel/` subdirectories). See `PHASE_1_ROADMAP.md §GitHub Repository Structure`.
- [x] ~~Component library: shadcn/ui or Material Design?~~ **Resolved:** shadcn/ui (headless, full design control, accessible). See `TECH_STACK_SUMMARY.md §Development & Testing`.
- [ ] Dark mode: system preference detection + user toggle, or user choice only?
- [x] ~~Can clients rebrand their own panel with their logo/colors (whitelabel), or platform-wide only?~~ **Resolved:** Platform-wide branding only (admin-controlled). Phase 2 adds white-label mode. See `ADMIN_PANEL_REQUIREMENTS.md §BR.1`.
- [ ] Panel analytics: Plausible, Fathom, or none (privacy-first)?
- [x] ~~Server-side rendering (SSR) for panels, or client-side SPA only?~~ **Resolved:** Client-side SPA (Vite + React). No SSR in Phase 1. See `TECH_STACK_SUMMARY.md`.
- [ ] Storybook for component development + documentation?
- [x] ~~Admin panel: embedded Grafana dashboards or direct link to Grafana?~~ **Resolved:** Direct link to Grafana (with SSO via Dex OIDC). Embedding deferred to Phase 2. See `ADMIN_PANEL_REQUIREMENTS.md §ML.3`.

### C. Technology Stack Summary

**Finalized Choices (see Section 0 for rationale):**

| Layer                | Technology                                         |
| -------------------- | -------------------------------------------------- |
| Orchestration        | **Kubernetes (k3s)** [Finalized]                   |
| Base OS              | **Debian 13** [Finalized]                             |
| Container runtime    | **containerd** (k3s default) [Finalized]           |
| Networking (CNI)     | **Flannel** (k3s default) → Calico upgrade path [Finalized] |
| Ingress              | **NGINX Ingress Controller** (k3s Traefik disabled) [Finalized] |
| Traffic routing      | **DNS-based ingress routing** — NGINX DaemonSet + PowerDNS multi-A records (no Floating IP / MetalLB). See ADR-014. [Finalized] |
| TLS automation       | **cert-manager** + Let's Encrypt [Finalized]       |
| DNS                  | **PowerDNS Authoritative** — 2 VPS (ns1: Falkenstein primary, ns2: Helsinki secondary). Co-hosted with NetBird VPN. [Finalized] |
| Storage              | **Longhorn** (distributed, replicated) [Finalized] |
| Media/branding       | **Longhorn PV** (local persistent volume) — logos, favicons, branding. See ADR-015. [Finalized] |
| Shared database (MariaDB) | Single instance → Primary + replica (HA optional) [Finalized] |
| Shared database (PG) | Single instance → Primary + replica (HA optional) [Finalized] |
| Shared cache         | **Redis** with ACLs → Sentinel for HA [Finalized] |
| Shared web pods      | **Apache+PHP** pool for Starter clients (VirtualHost routing) [Finalized] |
| Auth (OIDC)          | **Dex** (lightweight IdP federation) [Finalized]   |
| Secrets              | **Sealed Secrets** (GitOps-friendly) [Finalized]   |
| Container registry   | **Harbor** (with Trivy scanning) [Finalized]       |
| GitOps               | **Flux v2** (lightweight, Kubernetes-native) [Finalized] |
| Image scanning       | **Trivy** (integrated with Harbor) [Finalized]     |
| Scale-to-zero        | **KEDA** (HTTP trigger-based, optional per plan) [Finalized] |
| Monitoring           | **Prometheus** + **Grafana** + **Alertmanager** [Finalized] |
| Logging              | **Loki** + **Promtail** [Finalized]                |
| Backup (cluster)     | **Velero** + **rsync --archive** + CronJobs → offsite server (SSHFS mount). See ADR-015. [Finalized] |
| Backup (offsite)     | **SSHFS mount** — direct write to external backup server (mount on demand, unmount when done). Via NetBird mesh. [Finalized] |
| WAF (optional)       | **ModSecurity** + OWASP CRS v4 [Finalized] |
| Intrusion prevention | **fail2ban** (DaemonSet + shared Redis ban list) [Finalized] |
| Email (MTA/IMAP)     | **Docker-Mailserver** (Postfix + Dovecot) [Finalized] |
| Email (SMTP relay)   | **External option** (SendGrid, Mailgun, SES) — hybrid model [Finalized] |
| Webmail              | **Roundcube** (shared instance, client-level domains) [Finalized] |
| Email auth           | **OIDC** (Google/Apple) + **app passwords** (platform-managed) [Finalized] |
| File manager         | **FileBrowser** (lightweight, Go-based, user-friendly) [Finalized] |
| SFTP                 | **SFTP gateway** (OpenSSH in container) [Finalized] |
| Workload containers  | **Centralized catalog** (admin-managed images) [Finalized] |
| Application catalog  | **Helm-chart-based** catalog (Nextcloud, BBB, Jitsi, etc.) [Finalized] |
| Notifications        | **Custom Notification Service** (event-driven email, digest, templates) [Finalized] |
| Migration Service    | **Plesk/cPanel/Virtualmin** data extraction + transformation + import to K8s [Finalized] |
| Migration Job Queue  | **Redis** (Celery/Bull) for async migration job processing [Finalized] |
| Management panel (API) | **REST API** (**Node.js + Fastify**) [Finalized] |
| Management panel (Frontend) | **React 18+** with TypeScript [Recommended]  |
| Frontend build tool  | **Vite** [Finalized]                               |
| Frontend styling     | **Tailwind CSS** + CSS modules [Finalized]         |
| Component library    | **shadcn/ui** (headless, full control) [Recommended] |
| UI icons             | **Lucide React** [Recommended]                     |
| State management     | **TanStack Query** (data) + **Zustand** (UI state) [Recommended] |
| Form handling        | **React Hook Form** + **Zod** [Recommended]        |
| Frontend routing     | **TanStack Router** [Recommended]                  |
| Frontend HTTP client | **TanStack Query** + **Axios** [Recommended]       |
| Dark mode            | **next-themes** or custom context [Recommended]    |
| Frontend testing     | **Vitest** + **React Testing Library** (unit), **Playwright** (E2E) [Recommended] |
| Frontend linting     | **ESLint** + **Prettier** [Finalized]              |
| CDN/hosting          | **Cloud CDN** (Cloudflare or CloudFront) + Longhorn PV [Finalized] |

### D. References

> _Link relevant RFCs, ADRs, vendor docs, or internal wikis here._

- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [k3s Documentation](https://docs.k3s.io/)
- [cert-manager](https://cert-manager.io/docs/)
- [Longhorn Storage](https://longhorn.io/docs/)
- [CloudNativePG](https://cloudnative-pg.io/documentation/)
- [Docker-Mailserver](https://docker-mailserver.github.io/docker-mailserver/)
- [Roundcube Webmail](https://roundcube.net/)
- [Dovecot OAuth2 Authentication](https://doc.dovecot.org/configuration_manual/authentication/oauth2/)
- [OWASP ModSecurity Core Rule Set](https://coreruleset.org/)
- [Dex OIDC](https://dexidp.io/docs/)
- [KEDA Autoscaling](https://keda.sh/docs/)
- [Redis ACLs](https://redis.io/docs/management/security/acl/)
- [fail2ban](https://www.fail2ban.org/)
- [Velero Backup](https://velero.io/docs/)
- [Harbor Registry](https://goharbor.io/docs/)
- [Flux v2](https://fluxcd.io/docs/)
- [Trivy Scanner](https://trivy.dev/latest/docs/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [shadcn/ui](https://ui.shadcn.com/)
- [TanStack Query](https://tanstack.com/query/latest)
- [React Hook Form](https://react-hook-form.com/)
- [TanStack Router](https://tanstack.com/router/latest)
