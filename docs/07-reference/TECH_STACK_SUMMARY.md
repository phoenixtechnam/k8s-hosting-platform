# Technology Stack Summary

## Quick Reference

A consolidated summary of all major technology choices made for the Kubernetes Web Hosting Platform.

> **Note (ADR-022):** DNS (PowerDNS), VPN mesh (NetBird), and IAM (Dex/OIDC) are **external services**
> provided by a separate infrastructure project. This platform consumes their APIs.

## Core Infrastructure

### Kubernetes & Container Runtime

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **Kubernetes Distribution** | k3s | Latest | Lightweight (~50% less control plane memory), built-in tools, ideal for VPS/bare metal |
| **Operating System** | Debian 13 | Latest | Stable, widely supported, good kernel stability |
| **Container Runtime** | containerd | k3s default | Modern, lightweight, no daemon overhead |
| **CNI Plugin** | Flannel (→ Calico) | Latest | Simple overlay, upgrade path for advanced networking |
| **Ingress Controller** | NGINX Ingress | Latest | Mature, feature-rich, ModSecurity WAF support |
| **Traffic Routing** | DNS-based ingress routing (NGINX DaemonSet + external PowerDNS multi-A) | — | No hoster lock-in, no Floating IP, automatic DNS failover. See ADR-014. |
| **Service Mesh** | None (Phase 2: Linkerd) | — | Start simple, add mTLS later if needed |

## Networking & DNS

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **External DNS** | External PowerDNS API (configurable endpoint in admin panel) | 4.9+ | API-driven zone/record management. PowerDNS deployed by infrastructure project. See ADR-022. |
| **TLS Certificates** | cert-manager + Let's Encrypt | Latest | Automatic, free SSL/TLS, renewal handling |
| **DNS (Cluster)** | CoreDNS | k3s built-in | Standard Kubernetes DNS, built into k3s |

## Security & Authentication

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **OIDC Provider** | External OIDC provider (e.g., Dex; configurable in admin panel) | Latest | Deployed by infrastructure project. See ADR-022. |
| **Secrets Management** | Sealed Secrets | Latest | GitOps-friendly, simple, encryption key-based |
| **Intrusion Detection** | fail2ban (k8s cluster nodes) | Latest | Multi-layer (HTTP, SFTP, mail, SSH) |
| **WAF** | ModSecurity (with NGINX) | Latest | OWASP CRS v4, detection-only initially |
| **Pod Security** | Kubernetes Pod Security Standards | Built-in | `restricted` for platform, `baseline` for clients |
| **RBAC** | Kubernetes RBAC | Native | Role-based access control for all users |
| **Admin Access VPN** | External NetBird (WireGuard mesh; provided by infrastructure project) | Latest | Zero-trust admin access; SSH/kubectl via mesh only. See ADR-022. |

## Container Registry & CI/CD

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **Container Registry** | Harbor | Latest | Self-hosted, Trivy scanning integrated, no vendor lock-in |
| **Image Scanning** | Trivy | Latest | Fast, accurate vulnerability scanning, low resource usage |
| **GitOps Controller** | Flux v2 | Latest | Lightweight, GitOps-native, more flexible than ArgoCD |
| **CI/CD Runner** | GitHub Actions or Gitea Actions | Latest | GitHub (cloud) or Gitea (self-hosted) |
| **Git Repository** | GitHub or Gitea | Latest | GitHub (SaaS) or Gitea (self-hosted) |

## Storage & Databases

### Storage

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **Block Storage** | Longhorn | Latest | Replicated block storage, snapshots, backup-to-S3 |
| **Media/Branding** | Longhorn PV | N/A | Local persistent volume for logos, favicons, branding. See ADR-015. |
| **Persistent Volumes** | Longhorn | Latest | Replicated, encrypted, no external dependencies |
| **Shared Filesystem** | NFS | Standard | For SFTP gateway access to PVs |

### Databases

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **MariaDB** | Percona MariaDB Operator | Latest | Production-grade, replication support, operator-managed |
| **PostgreSQL** | CloudNativePG | Latest | Cloud-native, excellent HA features, operator-managed |
| **Caching** | Redis | Latest | Fast, single-threaded, per-client key prefix isolation |
| **Session Storage** | Redis or PostgreSQL | Latest | Database-backed for pod restarts |

### Backup & Disaster Recovery

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **Kubernetes Backup** | Velero | Latest | Snapshots, cluster state, incremental backups |
| **Database Backups** | CronJob: mysqldump / pg_dump | Standard | Simple, reliable, per-client database exports |
| **File Backups** | rsync --archive | Standard | Plain filesystem copy, individually browseable. See ADR-015. |
| **Offsite Backup** | SSHFS mount (direct write) | Standard | Mount on demand → write backups → unmount. Via NetBird mesh. Zero local disk. See ADR-014 backup notes. |

## Observability & Monitoring

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **Metrics** | Prometheus | Latest | Standard, flexible querying, PromQL |
| **Logs** | Loki + Promtail | Latest | 10x less memory than ELK, Grafana integration |
| **Dashboards** | Grafana | Latest | Rich visualization, alerting, per-client dashboards |
| **Alerting** | Alertmanager | Latest | Integrated with Prometheus, flexible routing |
| **Distributed Tracing** | Tempo (Phase 2) | Latest | Low resource usage, Loki integration, deferred |

## Email & Communication

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **Mail Server** | Docker-Mailserver | Latest | Self-hosted, Postfix + Dovecot, built-in fail2ban |
| **Webmail** | Roundcube | Latest | Lightweight, accessible, OIDC support |
| **Spam Filtering** | Rspamd (in Docker-Mailserver) | Latest | Modern, fast, configurable |
| **DKIM/SPF/DMARC** | OpenDKIM (in Docker-Mailserver) | Latest | Standard email authentication |
| **External SMTP** | SendGrid/Mailgun/AWS SES | Optional | Hybrid model if needed |

## Management & Operations

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **Package Manager** | Helm | v3+ | Standard Kubernetes package manager |
| **Configuration** | Kustomize | Latest | Layered configuration, GitOps-friendly |
| **Manifests Format** | Helm Charts + Kustomize overlays | Latest | Flexible, composable, version-controlled |
| **kubectl** | Native | Latest | Standard Kubernetes CLI |

## Development & Testing

| Component | Choice | Version | Rationale |
| --- | --- | --- | --- |
| **Management API** | Node.js (Fastify) | Latest LTS | Lightweight, fast, large ecosystem. See ADR-011. |
| **Frontend Framework** | React 18+ | Latest | Mature, large ecosystem, performance optimizations |
| **Build Tool** | Vite | Latest | ~100x faster dev server, smaller bundle |
| **Styling** | Tailwind CSS | Latest | Utility-first, dark mode, fast |
| **Component Library** | shadcn/ui or Headless UI | Latest | Unstyled, accessible, full design control |
| **State Management** | TanStack Query + Zustand | Latest | Lightweight, fine-grained control |
| **Testing** | Vitest + React Testing Library | Latest | Fast, modern, ESM-first |
| **API Documentation** | OpenAPI/Swagger | Latest | Standard, auto-generate from code |

## Containerized Workloads

### Supported Runtimes

| Runtime | Versions | Container Images |
| --- | --- | --- |
| **PHP** | 8.2, 8.3, 8.4 | php:X.X-apache-alpine, nginx-php-fpm |
| **Node.js** | 20, 22 | node:X-alpine |
| **Python** | 3.11, 3.12 | python:X-slim |
| **Ruby** | 3.4 | ruby:3.4-alpine |
| **.NET** | 9.0 | mcr.microsoft.com/dotnet/aspnet:9.0 |
| **Java** | 21 | eclipse-temurin:21-jre-alpine |
| **Static Sites** | — | nginx:alpine, caddy:alpine |

### WordPress

| Component | Choice |
| --- | --- |
| **Image** | wordpress:X-apache (with PHP) |
| **Optimization** | Caching via Redis, object cache plugin |
| **Database** | Shared MariaDB (multi-site capable) |
| **Staging** | Separate subdomain (e.g., `dev.example.com`) with manual promotion (ADR-016) |

## Development & Deployment

| Component | Choice | Purpose |
| --- | --- | --- |
| **Docker** | Docker CE | Container builds, local development |
| **Docker Compose** | Latest | Local development environment |
| **Kind** or **minikube** | Latest | Local Kubernetes for testing |
| **Lens IDE** | Latest | Optional: Kubernetes IDE for developers |

## Application Catalog

### Included Applications

| App | Technology | Deploy Model |
| --- | --- | --- |
| **Nextcloud** | PHP + MariaDB + Redis | Multi or single-tenant |
| **Gitea** | Go + PostgreSQL | Multi or single-tenant |
| **Matomo** | PHP + MariaDB | Multi or single-tenant |
| **Mattermost** | Go + PostgreSQL | Multi or single-tenant |
| **Vaultwarden** | Rust + SQLite/PostgreSQL | Multi or single-tenant |
| **Jitsi Meet** | JavaScript + prosody | Single or shared |
| **BigBlueButton** | Java/C++ + MongoDB | Single-tenant only |
| **Moodle** | PHP + MariaDB | Single-tenant only |
| **Gibbon** | PHP + MariaDB | Single-tenant only |
| **Keycloak** | Java + PostgreSQL | Single-tenant only |

## Infrastructure Costs (Monthly)

### Minimal Deployment (No HA)

| Component | Provider | Cost |
| --- | --- | --- |
| 1 control plane (2vCPU/4Gi) | Hetzner | $8-12 |
| 1 worker (4vCPU/8Gi) | Hetzner | $12-18 |
| Storage (200Gi) | Hetzner | $5-10 |
| Bandwidth (100GB) | Hetzner | $5-10 |
| **Total** | | **$31-52/mo** |

### Growth Deployment (HA)

| Component | Provider | Cost |
| --- | --- | --- |
| 3 control planes (2vCPU/4Gi each) | Hetzner | $24-36 |
| 3 workers (8vCPU/16Gi each) | Hetzner | $36-54 |
| Storage (500Gi, replicated) | Hetzner | $10-15 |
| Bandwidth (500GB) | Hetzner | $10-20 |
| **Total** | | **$82-124/mo** |

## Open Source & Licensing

**All major components are open source:**

- ✅ k3s — Apache 2.0
- ✅ Kubernetes — Apache 2.0
- ✅ Docker — Docker Open Source License + Community Edition
- ✅ Prometheus — Apache 2.0
- ✅ Grafana — AGPL (open source, can be self-hosted)
- ✅ Loki — AGPL (open source, can be self-hosted)
- ✅ Harbor — Apache 2.0
- ✅ Flux — Apache 2.0
- ✅ Longhorn — AGPL (open source, can be self-hosted)
- ✅ Velero — Apache 2.0

**No expensive proprietary licenses required.**

## Related Documentation

- **PLATFORM_ARCHITECTURE.md**: Overall design and decisions
- **INFRASTRUCTURE_SIZING.md**: Resource requirements by component
- **SECURITY_ARCHITECTURE.md**: Security tool decisions
- **DEPLOYMENT_PROCESS.md**: CI/CD tool decisions
- **MONITORING_OBSERVABILITY.md**: Observability stack details
