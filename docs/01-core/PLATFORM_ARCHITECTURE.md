# Platform Architecture - Kubernetes Web Hosting Platform

> **Status:** Draft (Finalized 2026-02-27)
> **Last Updated:** 2026-03-27
> **Platform:** Self-managed Kubernetes on bare metal / VPS
> **Orchestration:** Kubernetes + Docker
> **Migration From:** Plesk-based manually configured servers
>
> **Note (ADR-022):** DNS (PowerDNS), VPN mesh (NetBird), and IAM (Dex/OIDC) are
> **external services** provided by a separate infrastructure project. This platform
> consumes their APIs (PowerDNS REST API, OIDC endpoint, NetBird mesh) and exposes
> their connection settings as configurable options in the admin panel.

---

## Table of Contents

0. [Architectural Decisions](#0-architectural-decisions)
1. [Overview & Goals](#1-overview--goals)
2. [Workload Container Catalog](#2-workload-container-catalog)
3. [Application Catalog](#3-application-catalog)
4. [Architecture Diagram Notes](#4-architecture-diagram-notes)

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
| **CNI Plugin**              | **Calico** (required from Phase 1 for NetworkPolicy enforcement) | Flannel does not support NetworkPolicy; Calico provides network-level tenant isolation from day one. Minimal overhead on single-node. |
| **Ingress Controller**      | **NGINX Ingress Controller** (k3s default Traefik disabled) | Mature, battle-tested, native ModSecurity WAF support, large community. See ADR-010. |
| **Traffic Routing**         | **DNS-based ingress routing** (NGINX DaemonSet + external PowerDNS multi-A records) | No hoster lock-in, no Floating IP needed, automatic failover via DNS. See ADR-014. |
| **External DNS**            | **External PowerDNS API** (configurable endpoint + credentials in admin panel) | Programmatic DNS record management for client domains; PowerDNS deployed by infrastructure project. See ADR-022. |

### 0.3 Security & Authentication

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **OIDC Provider**           | **External OIDC provider** (e.g., Dex; configurable endpoint + credentials in admin panel) | Deployed by infrastructure project; this platform consumes the OIDC endpoint. See ADR-022. |
| **Secrets Backend**         | **Sealed Secrets** (not Vault)            | GitOps-friendly, simple, lower overhead, sufficient for self-managed K8s |
| **WAF Engine**              | **ModSecurity** (with NGINX Ingress)      | Industry standard, proven with OWASP CRS v4, integrates directly with NGINX |
| **Intrusion Detection**     | **fail2ban** (via DaemonSet + shared Redis ban list) | Lightweight, traditional approach, proven for SSH/SFTP/HTTP protection |

### 0.4 Data & Storage

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **Block Storage**           | **Longhorn** (self-hosted distributed storage) | Replicated PVs, snapshots, S3 backup capability, no external dependency |
| **Media/Branding Storage**  | **Longhorn PV** (local persistent volume) | Logo uploads, favicons, platform branding assets. See ADR-015. |
| **MariaDB (add-on)**          | **Per-client dedicated StatefulSet** (provisioned on demand) | Database is a premium add-on; ~90% of clients don't use databases. Each DB client gets their own instance (~100-150Mi RAM). See ADR-024. |
| **PostgreSQL (platform)**     | **1 single instance** → replica for HA    | Platform metadata only; not offered as client-facing service in Phase 1 |
| **Redis (platform)**          | **1 single instance** → Redis Sentinel for HA | Platform cache, fail2ban ban list. Per-client Redis available as premium add-on. |
| **Offsite Backups**         | **SFTP/SSH to external server**          | Daily uploads to separate provider; disaster recovery |

### 0.5 Email Stack

| Decision                    | Choice                                    | Rationale                                 |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| **Email Model**             | **Hybrid**: self-hosted + external provider option | Default: Docker-Mailserver (full control); clients can opt for external SMTP relay |
| **MTA / IMAP**              | **Docker-Mailserver** (Postfix + Dovecot + Rspamd) | All-in-one, self-contained, includes spam filtering |
| **Webmail**                 | **Roundcube** (single shared instance)    | Lightweight, battle-tested, rich feature set, good UX |
| **OIDC Email Login**        | **Yes** (Google/Apple via external OIDC provider) | Enhanced security, password-less access for clients' users |
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
| **Pricing Model**           | **NOT in scope for this project**         | Focus on technical infrastructure; business team will define pricing strategy |
| **Starter Plan**            | **Business decision (out of scope)**      | Dedicated pod (ADR-024), resource-limited; pricing TBD by business |
| **Business Plan**           | **Business decision (out of scope)**      | Dedicated pods, better isolation; pricing TBD by business |
| **Premium Plan**            | **Business decision (out of scope)**      | Dedicated resources, support, features; pricing TBD by business |

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
| Workload model      | **Dedicated pods for all clients** — every client gets their own pod in a `client-{id}` namespace. NGINX+PHP-FPM default, Apache+PHP-FPM available per domain. See ADR-024. |
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
- [ ] Namespace-per-client isolation with enforced resource quotas — every client gets a `client-{id}` namespace (ADR-024)
- [ ] Centrally managed workload container catalog — admin controls all available runtime images
- [ ] Clients select from pre-approved containers only (e.g., "NGINX PHP 8.4")
- [ ] Admin can publish new container versions, deprecate old ones, and migrate clients
- [ ] **Dedicated pod for every client** — full namespace isolation regardless of plan. NGINX+PHP-FPM default, Apache+PHP-FPM available per domain. See ADR-024.
- [ ] **Database as premium add-on** — not included in base plans; provisioned on demand as a dedicated MariaDB StatefulSet per client (ADR-024)
- [ ] Minimize server resource usage and infrastructure costs through resource overcommit, scale-to-zero, and image layer sharing
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

**Deployment model (ADR-024):**

Every client — regardless of plan — gets a **dedicated pod** in their own `client-{id}` namespace running a catalog image with full Kubernetes-native isolation (ResourceQuota, NetworkPolicy, RBAC).

> NGINX+PHP-FPM is the default web server (ADR-023). Apache+PHP-FPM is available as
> a per-domain option for clients who need `.htaccess` support. Plan differentiation
> is based on resource limits and features, not isolation model.

**Benefits:**
- **Security**: Every image is scanned, hardened, and patched centrally; full namespace isolation for every client
- **Consistency**: All clients on the same runtime get identical environments
- **Efficient updates**: Upgrade PHP 8.3 -> 8.4 for all clients in one operation
- **Simplicity**: Single provisioning path for all plans — no shared pod management
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

### 2.3 Dedicated Pod Provisioning (All Plans)

> **Note (ADR-024):** The previous shared pod architecture has been superseded. All clients
> now get dedicated pods. See `SHARED_POD_IMPLEMENTATION.md` for historical reference only.

Every client gets a dedicated pod in their own `client-{id}` namespace:

**How it works:**
1. Management API creates `client-{id}` namespace with ResourceQuota, NetworkPolicy, and RBAC
2. Dedicated pod provisioned with selected catalog image (default: `nginx-php84`)
3. Client's PVC created and mounted at `/var/www/html`
4. Ingress rule created pointing client's domain to the client's pod Service
5. Secrets created for SFTP credentials (and DB credentials if database add-on is enabled)
6. If database add-on is enabled: dedicated MariaDB StatefulSet provisioned in the same namespace

**Plan upgrades:**
- Plan changes are **ResourceQuota edits** — no pod migration required
- Admin updates resource limits (CPU, memory, storage) via Management API
- Pod restarts with new limits; PVC and Ingress remain unchanged
- Database add-on can be enabled/disabled at any time (provisions or removes MariaDB StatefulSet)

**Resource defaults by plan:**

| Parameter | Starter | Business | Premium |
| --- | --- | --- | --- |
| CPU Request / Limit | 50m / 500m | 100m / 1000m | 200m / 2000m |
| Memory Request / Limit | 64Mi / 256Mi | 256Mi / 1Gi | 512Mi / 4Gi |
| Storage | 5Gi | 20Gi | 50Gi |
| Database | Add-on ($) | Add-on ($) | Included |
| Redis | None | Add-on ($) | Dedicated pod |

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

1. Admin publishes new version in Harbor registry
2. Management API marks old version as deprecated
3. Notification sent to all affected clients
4. Rolling update automatically migrates clients to new version (configurable per admin)
5. Clients can manually switch if auto-migration is disabled

### 2.7 Client Container Selection

Clients can select their preferred runtime via the management panel at any time. Selection triggers:
- Pod replacement with the new image
- Data preserved (PersistentVolume remains unchanged)
- Minimal downtime (graceful shutdown → new pod startup)

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

**Application definition includes:**
- Helm chart with all component templates
- Configurable parameters (resources, features, domains)
- Database requirements (MariaDB, PostgreSQL, MongoDB, etc.)
- Storage requirements (PVCs for data, backups, caches)
- Networking (Ingress, Services, network policies)
- RBAC (service accounts, roles)
- Monitoring (Prometheus ServiceMonitor, Loki config)
- Lifecycle hooks (post-install, pre-delete)

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

### 3.5 Application Lifecycle Management

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

### 3.6 Application Resource & Cost Tracking

Each application instance is tracked separately for resource usage and billing:

| Metric                    | Tracked Per Instance                              |
| ------------------------- | ------------------------------------------------- |
| CPU / Memory usage        | Prometheus metrics per namespace                  |
| Storage usage             | PVC utilization                                   |
| Bandwidth                 | Ingress controller metrics per host               |
| Active users              | Application-specific (if exposed via API)         |
| Monthly cost              | Base price + resource usage surcharges             |

### 3.7 Integration with Hosting Plans

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

These are the **platform-level** services that power the hosting infrastructure. For complete details, see ADMIN_PANEL_REQUIREMENTS.md section 4 (Platform Services) which lists all ~25 services with descriptions.

**Major service categories:**

- **Management** (Management API, Admin/Client Panels)
- **Networking** (Ingress Controller, cert-manager, external PowerDNS API)
- **Container Management** (Harbor Registry, Catalog Service)
- **Storage & Databases** (Longhorn, MariaDB, PostgreSQL, Redis)
- **Observability** (Prometheus, Grafana, Loki, Alertmanager)
- **Security** (external OIDC provider, Sealed Secrets, fail2ban, WAF)
- **File Access** (SFTP Gateway, FileBrowser)
- **Email** (Docker-Mailserver, Roundcube)
- **Backup** (Velero, rsync --archive, CronJobs → offsite server via SSHFS)

---

**See Also:**
- [QUICKSTART.md](../QUICKSTART.md) — Navigation guide by role and topic
- [HOSTING_PLANS.md](HOSTING_PLANS.md) — Plan tier definitions
- [WORKLOAD_DEPLOYMENT.md](WORKLOAD_DEPLOYMENT.md) — Deployment models details
- [FRONTEND_DEPLOYMENT_ARCHITECTURE.md](../04-deployment/FRONTEND_DEPLOYMENT_ARCHITECTURE.md) — Admin/client panel deployment
- [FRONTEND_INGRESS_CONFIGURATIONS.md](../04-deployment/FRONTEND_INGRESS_CONFIGURATIONS.md) — Kubernetes Ingress configurations
