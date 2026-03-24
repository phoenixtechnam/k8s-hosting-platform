# Terminology & Glossary

## Quick Reference

Key terms, acronyms, and concepts used throughout the platform documentation.

## A

**Application** — A complex, multi-container workload (e.g., Nextcloud, Jitsi, Mattermost) deployed from the Application Catalog. See also **Workload**.

**Application Catalog** — Library of pre-defined, multi-container applications available for clients to deploy. See also **Workload Container Catalog**.

**Availability** — Percentage of time a system is operational and accessible. Target: 99.5% uptime (see **SLO**).

## B

**Backup** — A copy of customer data (files, databases, email, etc.) stored for recovery. See **Cluster-Managed Backups**, **Customer-Created Backups**.

**Business Plan** — Mid-tier hosting plan: dedicated pod, standard isolation, 14-day backup retention, 5 domains, optional custom database.

## C

**Catalog** — Curated library of pre-built container images or applications available for deployment. See **Workload Container Catalog**, **Application Catalog**.

**Catalog Image** — Pre-built, hardened Docker image from the Workload Container Catalog (e.g., `apache-php84`, `node22`). Also called **runtime image**, **workload image**.

**cert-manager** — Kubernetes operator for automatically managing TLS certificates. Integrates with Let's Encrypt for free SSL.

**Client** — End-user or organization hosting websites/applications on the platform. Each client has a namespace, domain(s), email account(s), databases, etc.

**Client Namespace** — Kubernetes namespace isolating one client's resources from others. Named `client-{id}`. Each client gets one or more namespaces.

**Cluster-Managed Backups** — Automated daily backups of all customer data, managed by platform admin, included free in all plans, NOT counted against storage quota.

**CNI Plugin** — Container Network Interface plugin (e.g., Flannel, Calico). Manages pod-to-pod networking in Kubernetes.

**Cold Start** — Time required to spin up a pod that was previously idle/scaled-to-zero. Typical: 2-5 seconds.

**Compliance** — Meeting regulatory requirements (GDPR, SOC 2, HIPAA, etc.). See **COMPLIANCE_MATRIX.md**.

**Control Plane** — Master node(s) in Kubernetes cluster. Runs etcd, API server, scheduler, controller manager.

**CPU Request** — Guaranteed minimum CPU allocation for a pod. Pod won't start if insufficient CPU available.

**CPU Limit** — Maximum CPU a pod can use. Exceeded = pod throttled. See also **QoS Class**.

**Credential** — Authentication secret (password, API key, app password, etc.). Stored encrypted in Kubernetes Secrets or Vault.

**Custom Plan** — Hosting plan tailored to a specific client's needs. Can mix features from Starter, Business, Premium.

## D

**Database** — Persistent data store (MariaDB, PostgreSQL, SQLite). Platform runs shared MariaDB and PostgreSQL; premium clients can have dedicated instances.

**Dedicated Pod** — Pod belonging solely to one client (Business/Premium plans). Contrast: **Shared Pod**.

**Deployment** — Kubernetes resource describing how to create, replicate, and update pods.

**Disaster Recovery (DR)** — Procedures and strategies to recover from cluster failure, data loss, etc. Includes backups, failover, RTO/RPO targets.

**Domain** — Internet domain name (e.g., `example.com`). Clients can host multiple domains.

**DNS** — Domain Name System; resolves domain names to IP addresses. Platform uses PowerDNS or cloud DNS.

**DPA** — Data Processing Agreement. Legal contract required by GDPR when processing personal data on behalf of others.

## E

**Egress** — Outbound network traffic from a pod. By default restricted; can be enabled per client.

**Encryption at Rest** — Data encrypted while stored (files, databases, backups). Key: AES-256.

**Encryption in Transit** — Data encrypted while being transmitted. Key: TLS/HTTPS.

**Environment Variable** — Configuration passed to containers (e.g., `DB_PASSWORD`, `API_KEY`). Stored in ConfigMap or Secret.

## F

**fail2ban** — Intrusion detection tool. Bans IPs with repeated authentication failures. Operates at HTTP, SFTP, mail, and SSH layers.

**Flannel** — Simple, lightweight CNI plugin for pod networking. k3s default.

**Flux** — GitOps tool for declarative cluster management. Watches Git repository and syncs cluster state.

**Frontend** — Web UI (admin panel, client panel). Built with React, served via NGINX Ingress.

## G

**GDPR** — General Data Protection Regulation (EU). Requires data protection, privacy, right to deletion. Applies if hosting EU residents' data.

**Git Deploy** — Deployment method: client pushes to Git repo, webhook triggers sync to PersistentVolume. No container build.

**GitOps** — Infrastructure-as-Code practice: Git repository is source of truth, controller syncs cluster to match Git state.

**Grafana** — Visualization tool for Prometheus metrics. Dashboards for platform health, per-client usage, etc.

## H

**HA (High Availability)** — Redundancy to survive failures. Optional upgrades: 3 control planes, 3+ workers, replicated databases, etc.

**Harbor** — Self-hosted container registry. Stores catalog images, integrates with Trivy scanning.

**Health Check** — Probe (HTTP, TCP, or exec) verifying pod is healthy. Kubernetes uses for liveness, readiness, startup.

**Helm** — Kubernetes package manager. Charts bundle related Kubernetes objects for easy deployment.

## I

**Ingress** — Kubernetes resource routing external HTTP(S) traffic to internal services. Platform uses NGINX Ingress Controller.

**Ingress Controller** — Controller implementing Ingress resources. Platform uses NGINX with ModSecurity WAF.

**Isolation** — Preventing one client from accessing another's data. Implemented via namespaces, NetworkPolicy, RBAC, etc.

## J

**Jotai** — Lightweight state management library (alternative to Redux). Used in client panel UI.

## K

**k3s** — Lightweight Kubernetes distribution (~50% less memory than kubeadm). Platform standard.

**Keycloak** — OIDC identity provider (alternative to Dex). Not used in MVP; alternative for Phase 2.

**Kustomize** — Template-free customization of Kubernetes manifests. Supports layering, patches, etc.

## L

**Loki** — Log aggregation system. Indexes logs by labels, queries via LogQL. 10x more efficient than Elasticsearch.

**Longhorn** — Distributed block storage for Kubernetes. Provides replicated PVs, snapshots, backup-to-S3.

## M

**Management API** — Core microservice handling client/admin operations: namespaces, domains, DNS, databases, email, etc. Built with Node.js.

**Memory Request** — Guaranteed minimum memory for a pod. Pod won't start if insufficient memory available.

**Memory Limit** — Maximum memory a pod can use. Exceeded = pod OOM-killed (evicted).

**MetalLB** — Load balancer for bare-metal Kubernetes. Provides floating IPs without cloud provider. **Note:** Not used in this platform — replaced by DNS-based ingress routing (ADR-014).

**MinIO** — S3-compatible object storage. Self-hosted alternative to AWS S3. **Note:** Not used in this platform — removed due to MinIO OSS being unmaintained (ADR-015). Backups go directly to offsite server via SSHFS; media/branding stored on Longhorn PV.

**ModSecurity** — Web Application Firewall (WAF) module for NGINX. Blocks SQL injection, XSS, etc.

**Multi-Tenant** — Multiple clients/users sharing same application instance (e.g., Nextcloud server). Contrast: **Single-Tenant**.

## N

**Namespace** — Kubernetes logical cluster isolation. Each client gets a namespace. Enables RBAC, quotas, network policies per namespace.

**NetworkPolicy** — Kubernetes resource controlling pod-to-pod traffic. Platform uses default-deny + explicit allow rules.

**Node** — Worker machine in Kubernetes cluster. Runs pods, has CPU/memory/disk resources.

**OIDC** — OpenID Connect. Authentication protocol used for client/admin login via Google or Apple.

## O

**OWASP** — Open Web Application Security Project. Provides CRS (Core Rule Set) for WAF.

**OOM** — Out of Memory. When pod exceeds memory limit, Kubernetes evicts it.

## P

**Percona** — MariaDB distribution with replication and operator support. Platform uses for shared MariaDB.

**PersistentVolume (PV)** — Kubernetes storage object. Backed by Longhorn block storage.

**PersistentVolumeClaim (PVC)** — Request for storage. Bound to PV. Mounted into pods.

**Phase 1 (MVP)** — Initial minimal deployment: single control plane, 1-2 workers, basic features, no HA.

**Phase 2 (Scale)** — Post-MVP: HA options, enterprise features, additional runtimes, compliance.

**PHP-FPM** — PHP FastCGI Process Manager. Runs PHP code, isolated per-client in shared pods via separate pool.

**Plan** — Hosting tier (Starter, Business, Premium, Custom). Defines features, resources, price.

**Pod** — Smallest Kubernetes workload object. One or more containers, shared networking/storage.

**Pod Disruption Budget (PDB)** — Kubernetes policy preventing simultaneous pod evictions. Enables safe rolling updates.

**Premium Plan** — Highest-tier plan: dedicated pod, dedicated database/Redis, WAF, 30-day backups, unlimited domains.

**Promtail** — Log shipper for Loki. Tails logs, adds labels, sends to Loki.

**Prometheus** — Metrics scraper and time-series database. Platform standard for observability.

## Q

**QoS Class** — Quality of Service class (Guaranteed, Burstable, BestEffort). Determines eviction priority. All client pods are Burstable.

**Quota** — Hard limit (storage, CPU, connections, etc.) per client or resource.

## R

**RBAC** — Role-Based Access Control. Kubernetes native authorization (admin vs. client roles).

**Readiness Probe** — Health check determining if pod is ready to receive traffic. Failed = removed from load balancer.

**Resource Quota** — Kubernetes object limiting resource consumption in a namespace (CPU, memory, storage, pod count).

**Restore** — Recovery of data from backup. Granular restore: select individual files, databases, email accounts.

**RTO (Recovery Time Objective)** — Target time to restore system after failure. MVP: 4 hours. With HA: 30 min.

**RPO (Recovery Point Objective)** — Target data loss tolerance. MVP: 24 hours (daily backups). With HA: 1 hour.

## S

**SaaS** — Software as a Service. The platform is a SaaS for web hosting.

**Scale-to-Zero** — Automatic pod termination when idle, restart on next request. Reduces cost for low-traffic sites. Optional per client.

**Sealed Secrets** — Kubernetes addon for encrypted secrets in Git. Encryption key kept separate, decryption in-cluster only.

**Secret** — Kubernetes object storing sensitive data (passwords, API keys, TLS certs, etc.). Encrypted at rest.

**SFTP** — SSH File Transfer Protocol. Secure file upload/download. Platform provides per-client SFTP access.

**Shared Pod** — Pod serving multiple Starter clients (via Apache VirtualHost). Contrast: **Dedicated Pod**.

**Single-Tenant** — One client per application instance (e.g., BigBlueButton). Contrast: **Multi-Tenant**.

**SLI** — Service Level Indicator. Measurable metric (e.g., uptime %, latency). See also **SLO**.

**SLO** — Service Level Objective. Target for SLI. Platform: 99.5% availability, < 1000ms p95 latency.

**Starter Plan** — Entry-level plan: shared pod, shared database/cache, 7-day backups, 1 domain.

**StatefulSet** — Kubernetes workload managing stateful apps (databases with persistent identity). Used for MariaDB, PostgreSQL, Redis.

**Storage Class** — Kubernetes object defining storage type and provisioning parameters. Platform uses Longhorn storage class.

**Subnet** — Logical subdivision of a network. Platform uses cluster-internal subnets for pod/service networks.

## T

**Tailwind CSS** — Utility-first CSS framework. Used in management panel UI.

**Tempo** — Distributed tracing backend (Phase 2). Deferred due to lower priority than metrics/logs.

**Tenancy** — Deployment model: single-tenant (dedicated per client) or multi-tenant (shared).

**Terraform** — Infrastructure-as-Code tool (not used in MVP; future option for cluster provisioning).

**TLS** — Transport Layer Security. Encrypts HTTP traffic (HTTPS). Platform uses Let's Encrypt certificates.

**Trivy** — Container image scanner. Detects vulnerabilities in images before publishing to Harbor.

## U

**Uptime** — Percentage of time system is operational. Target: 99.5% (allows ~3.6 hours downtime/month).

## V

**Velero** — Kubernetes backup/restore tool. Snapshots cluster state, etcd, PVs. Primary backup mechanism.

**VirtualHost** — Apache configuration block routing HTTP requests to specific document root. Shared pods use multiple VirtualHosts.

**Volume** — Storage attached to a pod. Types: PersistentVolume (Longhorn), ConfigMap (config), Secret (credentials), etc.

## W

**WAF** — Web Application Firewall. Optional ModSecurity integration with NGINX Ingress. Blocks OWASP Top 10 attacks.

**Webhook** — HTTP callback. Used for Git Deploy, Alertmanager, monitoring events, etc.

**Webmail** — Browser-based email client. Platform uses Roundcube (IMAP/SMTP client).

**Worker Node** — Kubernetes node running client workloads (pods). Contrast: **Control Plane**.

**Workload** — Container(s) running client application. Types: shared pod (Starter), dedicated pod (Business/Premium), application (Nextcloud, etc.).

**Workload Container Catalog** — Library of pre-built runtime images (PHP, Node, Python, etc.). See also **Application Catalog**.

## Z

**Zustand** — Lightweight state management library. Used in client panel UI.

---

## Common Acronyms

| Acronym | Expansion | Context |
| --- | --- | --- |
| API | Application Programming Interface | REST API for management operations |
| CCPA | California Consumer Privacy Act | US data privacy regulation |
| CLI | Command Line Interface | kubectl, helm, etc. |
| CPU | Central Processing Unit | Compute resource |
| CRUD | Create, Read, Update, Delete | API operations |
| DPIA | Data Protection Impact Assessment | GDPR compliance |
| DNS | Domain Name System | Domain resolution |
| DPA | Data Processing Agreement | GDPR contract |
| DR | Disaster Recovery | Backup/failover procedures |
| eCS | Elastic Container Service | Not used (AWS-specific) |
| EKS | Elastic Kubernetes Service | Not used (AWS-specific) |
| etcd | Distributed configuration store | Kubernetes control plane |
| GB | Gigabyte | 1000 MB |
| GDPR | General Data Protection Regulation | EU privacy law |
| Gi | Gibibyte | 1024 MiB (Kubernetes memory units) |
| GiB | Gibibyte | Same as Gi |
| HA | High Availability | Redundancy for reliability |
| HIPAA | Health Insurance Portability and Accountability Act | Healthcare privacy law |
| HTTP | HyperText Transfer Protocol | Unencrypted web traffic |
| HTTPS | HTTP Secure | Encrypted web traffic (TLS) |
| IMAP | Internet Message Access Protocol | Email retrieval protocol |
| JWT | JSON Web Token | Authentication token |
| K8s | Kubernetes | Short form |
| KB | Kilobyte | 1000 bytes |
| Li | Libibyte | 1024 KiB |
| LB | Load Balancer | Distributes traffic across servers |
| MFA | Multi-Factor Authentication | Two-factor or stronger auth |
| mTLS | Mutual TLS | Encrypted service-to-service auth |
| MB | Megabyte | 1000 KB |
| MiB | Mebibyte | 1024 KiB |
| MVP | Minimum Viable Product | Phase 1 launch |
| OIDC | OpenID Connect | Authentication protocol |
| OOM | Out of Memory | Pod eviction due to memory limit |
| PCI-DSS | Payment Card Industry Data Security Standard | Payment card security law |
| PDB | Pod Disruption Budget | Kubernetes scheduling policy |
| PV | PersistentVolume | Kubernetes storage object |
| PVC | PersistentVolumeClaim | Storage request |
| RBAC | Role-Based Access Control | Authorization system |
| Redis | Remote Dictionary Server | In-memory cache |
| REST | Representational State Transfer | API design pattern |
| RTO | Recovery Time Objective | Target downtime |
| RPO | Recovery Point Objective | Target data loss |
| SaaS | Software as a Service | Cloud application model |
| SLA | Service Level Agreement | Uptime guarantee contract |
| SLI | Service Level Indicator | Measurable metric |
| SLO | Service Level Objective | Target for SLI |
| SMTP | Simple Mail Transfer Protocol | Email sending protocol |
| SOC 2 | Service Organization Control 2 | Security audit standard |
| SQL | Structured Query Language | Database query language |
| SSH | Secure Shell | Encrypted remote access |
| SSL | Secure Sockets Layer | Predecessor to TLS |
| StatefulSet | Kubernetes stateful workload | For databases, caches |
| TCP | Transmission Control Protocol | Connection-oriented transport |
| TLS | Transport Layer Security | Encryption protocol (HTTPS) |
| TTL | Time To Live | Cache expiration; DNS record validity |
| UDP | User Datagram Protocol | Connectionless transport |
| VM | Virtual Machine | Emulated computer |
| WAF | Web Application Firewall | HTTP attack protection |
| YAML | YAML Ain't Markup Language | Configuration file format |

## Related Documentation

- **QUICKSTART.md**: Entry point for new readers
- **PLATFORM_ARCHITECTURE.md**: Detailed explanations of concepts
- **TECH_STACK_SUMMARY.md**: Technology choices and rationale
