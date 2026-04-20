# Architecture Decision Records (ADRs)

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** Architecture & Engineering Team

## Overview

Architecture Decision Records document key technical decisions, rationale, and consequences. This ensures:
- **Traceability:** Why decisions were made
- **Context:** Future team members understand reasoning
- **Accountability:** Who decided and when
- **Trade-offs:** What alternatives were considered

---

## ADR Format

Each ADR follows this template:

```
# ADR-[NUMBER]: [Title]

## Status
[ACCEPTED | PROPOSED | REJECTED | DEPRECATED]

## Context
[What problem are we trying to solve?]

## Decision
[What did we decide?]

## Rationale
[Why did we make this decision?]

## Consequences
[What are the trade-offs and impacts?]

## Alternatives Considered
[What other options did we evaluate?]

## Related ADRs
[Links to related decisions]
```

---

## ADR-001: Multi-Tenancy via Kubernetes Namespaces

**Status:** ACCEPTED  
**Date:** 2026-01-15  
**Author:** Architecture Team

### Context

We need to isolate customer workloads and data while maintaining operational efficiency.

### Decision

Each client gets one dedicated Kubernetes namespace per region.
- Client A: `namespace: client-a-prod`
- Client B: `namespace: client-b-prod`
- Admin: `namespace: platform`

### Rationale

1. **Isolation:** Network policies per namespace prevent cross-client traffic
2. **RBAC:** Role-based access control scoped to namespace
3. **Resource Management:** Resource quotas per namespace (CPU, memory, storage)
4. **Disaster Recovery:** Delete one namespace doesn't affect others
5. **Native K8s:** Leverages Kubernetes' built-in multi-tenancy

### Consequences

**Positive:**
- ✅ Simple isolation model
- ✅ Native K8s tooling works out of the box
- ✅ Easy to implement network policies (Calico)
- ✅ Audit logs per namespace

**Negative:**
- ❌ API server load increases with number of namespaces (500+ namespace concern)
- ❌ More disk space for etcd (one namespace object per client)

**Mitigation:**
- Implement etcd backup strategy
- Monitor API server load
- Plan horizontal scaling for Phase 2

### Alternatives Considered

1. **Shared namespace with labels** - Less isolation, harder to RBAC
2. **Virtual K8s clusters (vcluster)** - More overhead, complex management
3. **Docker containers instead of pods** - No K8s orchestration benefits

### Related ADRs
- ADR-002: Network Policies for Isolation
- ADR-003: RBAC Implementation

---

## ADR-002: Container Image Registry (Harbor)

**Status:** ACCEPTED  
**Date:** 2026-01-16  
**Author:** Infrastructure Team

### Context

We need secure, private container image registry with vulnerability scanning and access control.

### Decision

Deploy Harbor as self-hosted registry in K3s cluster.

```yaml
namespace: harbor
replicas: 3
storage: 100GB Longhorn
backup: Daily to offsite server (SSHFS mount)
```

### Rationale

1. **Security:** Sealed Secrets for registry credentials
2. **Vulnerability Scanning:** Built-in Trivy integration
3. **Cost:** Self-hosted vs $150/month SaaS (Docker Hub paid)
4. **Control:** Full ownership of image storage and scanning
5. **GDPR:** Data doesn't leave our infrastructure

### Consequences

**Positive:**
- ✅ Zero egress costs (images pulled from local registry)
- ✅ <50ms image pull time (vs 2-5s from Docker Hub)
- ✅ Vulnerability scanning on every push
- ✅ Full audit trail of image deployments

**Negative:**
- ❌ Operational overhead (backup, updates, troubleshooting)
- ❌ Storage management (disk usage grows with images)
- ❌ Single point of failure if not HA

**Mitigation:**
- Implement HA Harbor (3 replicas)
- Automated backups to offsite server
- Disaster recovery testing quarterly

### Alternatives Considered

1. **Docker Hub** - Higher costs, public by default
2. **Quay.io** - Enterprise features not needed, costs more
3. **AWS ECR** - Cloud-dependent, egress charges
4. **GitLab Registry** - Tightly coupled to GitLab

### Related ADRs
- ADR-004: Container Security Scanning
- ADR-005: GitOps with Flux v2

---

## ADR-003: Database Selection (MariaDB + PostgreSQL)

**Status:** ACCEPTED  
**Date:** 2026-01-17  
**Author:** Data Team

### Context

Different workloads have different database requirements. We need both relational (MariaDB) and advanced features (PostgreSQL).

### Decision

- **MariaDB 10.6+** for standard transactional data (clients, workloads, domains)
- **PostgreSQL 16+** for advanced features (full-text search, JSON operators, window functions)
- **Redis** for caching and sessions (not primary storage)

### Rationale

**MariaDB for:**
- Simple schema, good for CRUD operations
- Excellent compatibility with PHP applications (popular customer use case)
- Wide hosting provider support (Amazon RDS, Azure, etc.)

**PostgreSQL for:**
- Full-text search (audit logs, resource description search)
- JSON/JSONB data types (flexible schema for features)
- Window functions (analytics, reporting)
- PostGIS for geolocation (future feature)

### Consequences

**Positive:**
- ✅ Right tool for right job
- ✅ Flexible schema with PostgreSQL
- ✅ Customer familiarity with MariaDB
- ✅ Strong open-source communities

**Negative:**
- ❌ Operational complexity (manage 2 DB engines)
- ❌ Data consistency between MariaDB and PostgreSQL hard
- ❌ More monitoring/backup complexity

**Mitigation:**
- Clear separation: MariaDB for transactional, PostgreSQL for analytics
- Separate backup jobs for each
- Replication between them for critical data only

### Alternatives Considered

1. **PostgreSQL only** - MariaDB for customer apps isn't needed in control plane
2. **MongoDB** - No ACID transactions, harder to model customer data
3. **SQLite** - Not suitable for multi-client concurrent access

### Related ADRs
- ADR-006: Data Replication Strategy
- ADR-007: Backup & Disaster Recovery

---

## ADR-004: OIDC Authentication (Dex)

**Status:** ACCEPTED — Deployment moved to infrastructure project per ADR-022. This project consumes the OIDC endpoint.
**Date:** 2026-01-18
**Author:** Security Team

### Context

We need passwordless authentication with support for multiple identity providers (Google, GitHub, Apple, custom OIDC).

### Decision

Deploy Dex as OIDC provider in K3s cluster.
- Internal Dex instance for core authentication
- External provider connectors: Google, GitHub, Apple
- Custom OIDC provider support for enterprise clients

### Rationale

1. **Passwordless:** Less credential management risk
2. **Federated Identity:** Support multiple providers
3. **Standards-Based:** OIDC is industry standard
4. **No Vendor Lock-in:** Dex is open-source, can be self-hosted
5. **Security:** JWT tokens, short expiry, refresh tokens

### Consequences

**Positive:**
- ✅ Better security posture than passwords
- ✅ Flexible provider support
- ✅ Single sign-on across platform
- ✅ GDPR compliant (minimal credential storage)

**Negative:**
- ❌ Operational overhead (Dex deployment, maintenance)
- ❌ External provider outages affect login
- ❌ Learning curve for customers with custom OIDC

**Mitigation:**
- High availability Dex (3 replicas)
- Offline authentication token support
- Fallback to temporary password reset

### Alternatives Considered

1. **Auth0** - SaaS, data leaves infrastructure, costs $0/month
2. **Keycloak** - Heavier than Dex, more features than needed
3. **Firebase Auth** - Google lock-in, limited OIDC customization
4. **Custom JWT** - No federation support, reinventing wheel

### Related ADRs
- ADR-008: Secrets Management with Sealed Secrets
- ADR-009: API Token Authentication

---

## ADR-005: GitOps with Flux v2

**Status:** ACCEPTED  
**Date:** 2026-01-19  
**Author:** DevOps Team

### Context

We need automated, declarative deployments with version control as source of truth.

### Decision

Use Flux v2 for GitOps workflow:
- Git repo contains all infrastructure manifests
- Pull-based deployment (Flux polls Git)
- Automatic reconciliation on drift
- Sealed Secrets for credentials in Git

### Rationale

1. **Declarative:** What-you-see-is-what-runs
2. **Version Control:** Git history of all deployments
3. **Pull-based:** More secure than push-based (no CI/CD credentials in cluster)
4. **Automatic Remediation:** Drift detection and auto-correction
5. **Standards-Aligned:** Kubernetes native (CRDs)

### Consequences

**Positive:**
- ✅ Git as source of truth
- ✅ Auditability (who deployed what, when)
- ✅ Easy rollback (git revert)
- ✅ Infrastructure as code best practices

**Negative:**
- ❌ Git pushes trigger deployments (careful PR reviews needed)
- ❌ Debugging drift issues requires understanding Flux
- ❌ Initial learning curve

**Mitigation:**
- Mandatory code reviews before merge
- Automated tests on pull requests
- Flux monitoring dashboard
- Regular training on Flux workflows

### Alternatives Considered

1. **ArgoCD** - More UI-focused, similar functionality
2. **Helm+Jenkins** - Push-based, less secure
3. **Kustomize** - Only templating, no reconciliation
4. **Terraform** - Works but not K8s native

### Related ADRs
- ADR-010: CI/CD Pipeline Strategy
- ADR-012: Container Image Scanning

---

## ADR-006: Three-Layer Caching Strategy

**Status:** ACCEPTED  
**Date:** 2026-01-20  
**Author:** Performance Team

### Context

API latency targets: p50 < 100ms, p95 < 500ms. Database queries alone can't meet this.

### Decision

Implement three-layer caching:
1. **HTTP** (Cache-Control headers, browser/CDN)
2. **Application** (Redis, in-memory)
3. **Database** (Connection pooling, query result cache)

### Rationale

1. **Performance:** Dramatically reduces latency (50ms → 300ms typical)
2. **Scalability:** Reduces database load by 80%+
3. **Cost:** Fewer database queries = lower infrastructure costs
4. **Layered:** Each layer optimized for its use case

### Consequences

**Positive:**
- ✅ Meets latency SLO
- ✅ Reduces database load
- ✅ Better user experience
- ✅ Cost savings

**Negative:**
- ❌ Cache invalidation complexity
- ❌ Stale data potential
- ❌ Redis dependency adds failure point
- ❌ Debugging issues harder (cache layers add complexity)

**Mitigation:**
- Careful cache TTL selection
- Event-driven cache invalidation
- Redis redundancy (replication)
- Cache hit ratio monitoring

### Alternatives Considered

1. **No caching** - Can't meet latency SLOs
2. **Database caching only** - Not enough performance gain
3. **In-memory cache only** - Lost on pod restart, doesn't scale horizontally

### Related ADRs
- ADR-007: Redis for Distributed Caching
- ADR-012: Monitoring & Observability

---

## ADR-007: Multi-Region Strategy (Phase 2+)

**Status:** PROPOSED (Phase 2)  
**Date:** 2026-01-21  
**Author:** Architecture Team

### Context

Scale globally and improve disaster recovery with geographic distribution.

### Decision (Future)

Deploy K3s clusters in multiple regions:
- Primary region: US East (primary writes)
- Secondary regions: EU West, APAC (read replicas)
- Cross-region database replication
- Multi-master DNS (PowerDNS)

### Rationale

1. **Latency:** Local region serving reduces latency
2. **Compliance:** GDPR/data residency (EU data stays in EU)
3. **HA:** Failure of one region doesn't affect others
4. **Capacity:** Distribute load across regions

### Consequences

**Positive:**
- ✅ Global reach
- ✅ Disaster recovery (RTO < 1 hour)
- ✅ Compliance flexibility

**Negative:**
- ❌ High operational complexity
- ❌ Cross-region data consistency challenges
- ❌ Costs increase 3-5x
- ❌ Network latency between regions

**Mitigation:**
- Clear data ownership (which region masters each data type)
- Eventual consistency model
- Regular DR drills

### Alternatives Considered

1. **Single region only** - Simpler but no HA/compliance benefits
2. **Active-passive failover** - Simpler, slower RTO

### Related ADRs
- ADR-002: Kubernetes Cluster Architecture
- ADR-006: Data Replication Strategy

---

## ADR-008: Observability Stack (Prometheus + Grafana + Loki)

**Status:** ACCEPTED  
**Date:** 2026-01-22  
**Author:** Observability Team

### Context

Need comprehensive visibility into system behavior for debugging and SLO monitoring.

### Decision

- **Prometheus** for metrics (time-series data)
- **Grafana** for dashboards and alerting
- **Loki** for logs (structured logging)

### Rationale

1. **Open-Source:** No vendor lock-in
2. **Integrated:** Works well together (Prometheus + Grafana proven combination)
3. **Cost:** Self-hosted, minimal overhead
4. **Flexibility:** Easy to add custom metrics/dashboards

### Consequences

**Positive:**
- ✅ Comprehensive observability
- ✅ SLO monitoring built-in
- ✅ Flexible alerting rules
- ✅ Community support

**Negative:**
- ❌ Operational overhead (monitoring infrastructure)
- ❌ Storage requirements (metrics/logs retention)
- ❌ Performance tuning needed at scale

**Mitigation:**
- Prometheus data retention: 15 days (archive to S3 older data)
- Loki log retention: 30 days
- Regular optimization of metric cardinality

### Alternatives Considered

1. **Datadog** - Enterprise SaaS, high cost ($50-100k/year)
2. **New Relic** - Good but proprietary
3. **ELK Stack** - Elasticsearch heavy, disk intensive

### Related ADRs
- ADR-009: SLI/SLO Definition
- ADR-012: Alerting Strategy

---

## ADR-009: Sealed Secrets for Credential Management

**Status:** ACCEPTED  
**Date:** 2026-01-23  
**Author:** Security Team

### Context

Need to store secrets in Git-friendly way without compromising security.

### Decision

Use Bitnami Sealed Secrets for all credential management:
- Secrets encrypted with cluster public key
- Safe to commit to Git
- Decrypted only in cluster by controller
- Rotation via versioned sealed secrets

### Rationale

1. **GitOps-Friendly:** Secrets can be in Git (encrypted)
2. **Cluster-Bound:** Secrets tied to cluster identity
- Only decryptable on original cluster
3. **Automatic:** No manual secret distribution needed
4. **K8s Native:** Uses standard Kubernetes Secret API

### Consequences

**Positive:**
- ✅ Infrastructure as code (including secrets)
- ✅ Version control history
- ✅ Automated deployment
- ✅ Easy rotation

**Negative:**
- ❌ Sealing key backup critical (disaster recovery)
- ❌ Can't easily rotate sealing key
- ❌ Not suitable for high-security environments requiring offline storage

**Mitigation:**
- Sealing key backed up daily
- Key stored in offline secure location
- Quarterly disaster recovery drills

### Alternatives Considered

1. **External Vault** - More flexible but adds dependency
2. **Encrypt-at-rest only** - Not git-safe
3. **CI/CD secrets** - Not infrastructure-as-code

### Related ADRs
- ADR-010: Secrets Rotation Policy
- ADR-004: OIDC & Authentication

---

## ADR-010: NGINX Ingress Controller

**Status:** ACCEPTED  
**Date:** March 6, 2026  
**Deciders:** Architecture & Engineering Team

### Context

The platform requires an ingress controller for HTTP/HTTPS routing, TLS termination, and Web Application Firewall (WAF) integration. k3s ships with Traefik as its default ingress controller, making it a natural candidate. However, the platform has specific requirements that narrow the field:

1. **ModSecurity WAF integration** — The WAF specification (Business/Premium plans) requires ModSecurity v3 with OWASP CRS v4.0, including per-customer toggle, paranoia levels, and granular rule exclusions.
2. **HTTP Basic Authentication** — Password-protected directories use `auth_basic` with `.htpasswd` files, a native NGINX directive.
3. **PHP-FPM routing** — Shared pod architecture uses `fastcgi_pass` directives with `open_basedir` enforcement via `fastcgi_param`.
4. **Per-domain configuration snippets** — Hosting settings (WWW redirect, HTTPS redirect, external forwarding, webroot path) require custom `location` and `server` block directives.
5. **Consistent NGINX stack** — Shared pods already use NGINX internally for VirtualHost routing; having NGINX at the ingress layer provides a consistent operational model.

### Decision

Use **NGINX Ingress Controller** as the platform's sole ingress controller. Disable k3s's built-in Traefik at installation time using the `--disable traefik` flag.

```bash
# k3s installation with Traefik disabled
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
```

Deploy NGINX Ingress Controller separately via Helm (ingress-nginx chart) into the `ingress` namespace.

### Rationale

| Criterion | NGINX Ingress | Traefik |
| --- | --- | --- |
| ModSecurity WAF | Native — compiled into binary | Not supported |
| `auth_basic` / `.htpasswd` | Native directive | Middleware (BasicAuth), but no `.htpasswd` file support |
| `fastcgi_pass` (PHP-FPM) | Native directive | Not applicable (different proxy model) |
| Custom config snippets | Full support (server/location) | Not applicable (middleware model) |
| cert-manager integration | Standard annotations + CRDs | Standard annotations + CRDs |
| HA via DaemonSet | Stateless — one per worker node, auto-scales | Requires shared storage for built-in ACME certs |
| Community adoption | Largest K8s ingress controller | Second largest |
| Prometheus metrics | Full support | Full support |
| GitOps (Flux v2) | Standard Ingress resources | IngressRoute CRDs or standard Ingress |
| Built-in dashboard | None (use Grafana) | Yes |

The deciding factor is **ModSecurity WAF support**. The WAF specification is deeply integrated into the platform — it's tied to hosting plan tiers, the admin panel, the client panel, the Management API, and the security architecture. Traefik has no equivalent capability, and bolting on an external WAF proxy would add complexity, latency, and an additional failure point.

### Consequences

**Positive:**
- ✅ Native ModSecurity v3 + OWASP CRS v4.0 — no additional proxy layer needed
- ✅ Native `auth_basic` for password-protected directories
- ✅ Consistent NGINX configuration from ingress to shared pod level
- ✅ Battle-tested with the largest community and extensive documentation
- ✅ cert-manager works via standard annotations
- ✅ Stateless DaemonSet — auto-scales with worker nodes (see ADR-014)

**Negative:**
- ❌ Must explicitly disable k3s default Traefik (`--disable traefik`) at installation
- ❌ Separate Helm deployment and lifecycle management (not bundled with k3s)
- ❌ No built-in dashboard (mitigated by Grafana dashboards)
- ❌ Occasional CVEs (e.g., IngressNightmare, 2025) — requires active security patching

**Mitigation:**
- Subscribe to NGINX Ingress Controller security advisories
- Restrict admission webhook access (see security hardening guide)
- Include in monthly patching cycle per CLUSTER_MAINTENANCE_AND_UPGRADES.md
- Monitor via Prometheus alerts for ingress health

### Alternatives Considered

1. **Traefik** (k3s default) — Simpler initial setup, built-in dashboard, automatic service discovery. Rejected because it lacks ModSecurity WAF support, which would require rearchitecting the WAF specification, password-protected directories, and shared pod configuration.
2. **HAProxy Ingress** — High performance, TCP/UDP support. Rejected because ModSecurity integration is not native and community is smaller.
3. **Envoy / Emissary** — Advanced L7 features, gRPC support. Rejected as over-engineered for this platform's requirements and adds operational complexity.

### Related ADRs

- ADR-001: Multi-Tenancy via Kubernetes Namespaces (NetworkPolicy works with any ingress)
- ADR-009: Sealed Secrets for Credential Management (TLS secrets managed by cert-manager)
- ADR-014: DNS-Based Ingress Routing (DaemonSet deployment model, no Floating IP / MetalLB)

---

## ADR-011: Fastify as API Framework

**Status:** ACCEPTED  
**Date:** March 6, 2026  
**Deciders:** Architecture & Engineering Team

### Context

The platform requires a Node.js HTTP framework for the Management API (REST API serving admin and client panels). Two frameworks were evaluated: **Express.js** and **Fastify**. Early documentation referenced both ("Express.js or Fastify"), and one conceptual CORS example used Express.js. However, newer specifications — API error handling, pagination strategy, frontend deployment architecture, and the architecture dependency diagram — standardized on Fastify. A formal decision is needed to resolve the inconsistency.

### Decision

Use **Fastify** for all Management API services. All new API code, middleware, plugins, and documentation should target Fastify exclusively.

### Rationale

1. **Performance:** Fastify delivers 2–3x higher throughput than Express.js. For a hosting platform serving 50–300+ concurrent clients, this headroom reduces the need for early horizontal scaling.
2. **Built-in schema validation:** Fastify validates request/response payloads via JSON Schema natively, eliminating the need for separate validation libraries and reducing boilerplate.
3. **Built-in TypeScript support:** First-class TypeScript typings ship with the framework, aligning with the platform's TypeScript-first approach.
4. **Plugin architecture:** Fastify's encapsulated plugin system maps cleanly to the platform's modular API design (auth, clients, domains, databases, backups, etc.).
5. **Existing specification alignment:** The API error handling spec, pagination strategy, frontend deployment architecture, and dependency/risk documents already reference Fastify — this decision formalizes what newer specs adopted.
6. **Native async/await:** Fastify is designed around async/await with no legacy callback patterns, simplifying middleware and route handler code.

### Consequences

**Positive:**
- ✅ Higher request throughput with lower latency under load
- ✅ Declarative schema validation reduces hand-written validation code
- ✅ Consistent TypeScript experience across the codebase
- ✅ Plugin encapsulation prevents cross-module side effects
- ✅ Documentation consistency — resolves "Express.js or Fastify" ambiguity

**Negative:**
- ❌ Smaller ecosystem than Express.js — some middleware may need Fastify-specific alternatives or wrappers
- ❌ Team members familiar with Express.js will need to learn Fastify-specific patterns (lifecycle hooks, decorators, plugin encapsulation)
- ❌ Fewer community tutorials and Stack Overflow answers compared to Express.js

**Mitigation:**
- Maintain an internal Fastify patterns/recipes guide during onboarding
- Evaluate Fastify-compatible replacements for any required Express middleware before Phase 1 development begins
- Leverage Fastify's `fastify-express` compatibility layer only as a temporary bridge if absolutely necessary

### Alternatives Considered

1. **Express.js** — Largest Node.js framework ecosystem, most tutorials and community answers, extensive middleware library. Rejected because: lower throughput under load, callback-oriented middleware patterns, no built-in schema validation, and newer platform specs already moved to Fastify.

### Related ADRs

- None directly.

---

## ADR-013: NetBird WireGuard Mesh for Admin Access

**Status:** ACCEPTED — Deployment moved to infrastructure project per ADR-022. This project assumes NetBird mesh is available.
**Date:** March 6, 2026
**Deciders:** Architecture & Security Team

### Context

The platform requires secure admin access to cluster nodes (SSH, kubectl, etcd) and backup servers. Without a VPN layer, ports 22 (SSH) and 6443 (Kubernetes API) must be exposed on the public internet, relying solely on key-based authentication and fail2ban for protection. This increases attack surface and contradicts zero-trust principles.

A secure admin access transport layer is needed that:
- Encrypts all admin traffic (SSH, kubectl, backup SSHFS)
- Removes the need to expose management ports to the public internet
- Integrates with the existing OIDC authentication (Dex)
- Provides auditable access logs
- Survives cluster outages (break-glass access)
- Has minimal operational overhead for a small team

### Decision

Adopt **NetBird** (WireGuard-based zero-trust mesh VPN) for all admin infrastructure access. Self-hosted across two geographically diversified VPS nodes that also serve as authoritative DNS servers (PowerDNS). Each VPS is primary for one service and secondary for the other:

**VPS 1 — ns1.platform.com (Hetzner Falkenstein, CX22 — €4/month):**
- **PowerDNS Primary** (authoritative DNS, API for zone management)
- **NetBird Primary** (Management server, Signal, TURN/Relay, Dashboard)
- PostgreSQL (DNS zone data + NetBird state)

**VPS 2 — ns2.platform.com (Hetzner Helsinki, CX22 — €4/month):**
- **PowerDNS Secondary** (zone sync via AXFR/IXFR from VPS 1)
- **NetBird Secondary** (Signal, TURN/Relay, Dashboard standby)
- PostgreSQL (DNS zone replica; NetBird state backup)

**Home server (tertiary fallback — NetBird only):**
- NetBird Signal + TURN/Relay (additional redundancy)
- NetBird Management standby (activate if both VPS fail)

**Mesh participants:**
- Both DNS/NetBird VPS nodes
- All k3s cluster nodes (control plane + workers)
- Admin workstations
- Backup server(s)

**Access policy:**
- SSH (port 22) and Kubernetes API (port 6443) closed on public firewall
- Only reachable via NetBird WireGuard mesh
- OIDC integration with Dex for identity-based access
- Pre-authenticated setup keys for break-glass access (bypasses OIDC)
- Customer-facing ports (80, 443, 25, 587, 993, SFTP) remain publicly accessible via NGINX Ingress

### Rationale

1. **WireGuard protocol** — proven, fast, audited, in-kernel on Linux, minimal attack surface
2. **Self-hosted** — no dependency on third-party SaaS for admin access to production
3. **Co-hosted with DNS** — both VPS serve double duty (DNS + NetBird), maximizing value of two regionally-diversified servers
4. **Cross-primary redundancy** — VPS 1 is DNS primary / NetBird primary; VPS 2 is DNS secondary / NetBird secondary. Either VPS can sustain both services independently if needed.
5. **Geographic diversity** — Falkenstein (Germany) + Helsinki (Finland): different datacenters, countries, network paths
6. **OIDC integration** — NetBird supports OIDC natively; connects to existing Dex provider
7. **Break-glass** — WireGuard P2P tunnels persist without management server; setup keys bypass OIDC
8. **Low cost** — two CX22 VPS (€8/month total) for DNS + NetBird + redundancy; home server as tertiary fallback (no additional cost)

### Alternatives Considered

1. **OpenZiti** — Full zero-trust fabric with application-level controls. More powerful but significantly more complex (custom protocol, heavier control plane, steeper learning curve). Overkill for admin-only access on a small team.
2. **Tailscale** — Excellent UX but SaaS-dependent for coordination server. Contradicts self-hosted principle. Headscale (self-hosted) is an option but less mature than NetBird.
3. **Plain WireGuard** — Manual key management, no identity integration, no dashboard, no policy engine. Works but doesn't scale well operationally.
4. **SSH bastion host** — Traditional approach. Still exposes SSH port publicly on the bastion. No mesh, no identity integration, single point of failure.
5. **No VPN (current state)** — Rely on SSH keys + fail2ban. Exposes management ports to internet. Unacceptable for production.

### Consequences

**Positive:**
- Management ports (SSH, K8s API) removed from public internet
- All admin traffic encrypted via WireGuard
- Identity-based access control (who accessed what, when)
- Break-glass access survives cluster outages
- Secure backup transport (SSHFS mount over mesh, no public SSH on backup server)
- Path to multi-region secure interconnect (Phase 2)

**Negative:**
- Additional component to maintain (NetBird server + agents)
- Dependency on NetBird project continuity (mitigated: WireGuard tunnels work without management server)
- Slight initial setup complexity
- Admin workstations must have NetBird agent installed

### Related ADRs

- ADR-004: Dex OIDC Provider (NetBird authenticates via Dex)
- ADR-009: Sealed Secrets (NetBird credentials stored as Sealed Secrets)
- ADR-010: NGINX Ingress Controller (customer traffic unaffected by VPN)

---

## ADR-014: DNS-Based Ingress Routing (No Floating IP / No MetalLB)

**Date:** 2026-03-07  
**Status:** Accepted  
**Deciders:** Platform Architecture Team

### Context

The platform needs to route customer HTTP/HTTPS traffic to the NGINX Ingress Controller running inside the k3s cluster. Traditional approaches use either:

1. **Floating IP + MetalLB** — MetalLB assigns a virtual IP that moves between nodes on failure
2. **Floating IP + keepalived** — VRRP protocol moves a floating IP between nodes
3. **Cloud Load Balancer** — Hetzner/AWS/GCP managed load balancer

All three approaches share drawbacks for this platform:

- **Hoster lock-in:** Floating IPs and cloud load balancers are hoster-specific. They don't work cross-hoster (e.g., Hetzner floating IP can't point to a Strato VPS).
- **Additional cost:** Floating IPs cost €1-3/month each; cloud load balancers cost €6+/month.
- **Extra components:** MetalLB and keepalived add operational complexity and failure modes.
- **Single ingress point:** All traffic flows through one node, even when multiple workers are available.

The platform already operates its own authoritative DNS (PowerDNS) with API-driven zone management. This creates an opportunity to use DNS itself as the traffic routing and failover mechanism, eliminating all of the above.

### Decision

Adopt a **DNS-based ingress routing** model:

1. **NGINX Ingress Controller runs as a DaemonSet** — one instance on every worker node, bound to host ports 80 and 443 via `hostPort`.
2. **`ingress.platform.com` A record set** — contains the public IP of every worker node running an Ingress pod. TTL: 60 seconds.
3. **Customer DNS records use CNAME indirection** — `www.customer.com` → CNAME → `ingress.platform.com`. Apex domains (`customer.com`) use ALIAS/ANAME records where supported, or a direct A record set mirroring `ingress.platform.com`.
4. **DNS Ingress Controller** — a small reconciliation controller (runs in the `platform` namespace) watches k8s node and pod events. When a worker node joins, leaves, or becomes NotReady, it updates the `ingress.platform.com` A record set via the PowerDNS API. It also manages apex A records that can't use CNAME.

   **PowerDNS API failure behaviour:** If the PowerDNS API is unreachable, the controller **retries with exponential backoff** (2s, 4s, 8s … up to 60s ceiling) and fires a `DNSIngressControllerSyncFailed` Prometheus alert after 3 consecutive failures. DNS records are **never deleted speculatively** — they remain at their last known good state until a successful update confirms the new state. An admin must manually intervene (fallback: manual PowerDNS API call or direct `pdnsutil` edit) if the controller cannot sync. This prevents a transient PowerDNS outage from accidentally removing valid worker IPs from DNS and causing a traffic outage.

   **Drain ordering contract:** The DNS Ingress Controller (or the admin, when draining manually) **must remove a worker's IP from `ingress.platform.com` before initiating `kubectl drain`**. Draining first causes a window where DNS still routes traffic to a node that is shedding connections. The correct order is: remove IP from DNS → wait one TTL (60s) → drain node. See `HA_MIGRATION_RUNBOOK.md` Stage 0→1 Step 6 for the procedure.
5. **No Floating IP, no MetalLB, no keepalived** — these components are removed from the stack entirely.

#### Traffic Flow

```
Client browser
    │
    │  DNS lookup: customer.com
    ▼
PowerDNS (ns1/ns2)
    │  CNAME → ingress.platform.com
    │  A records: [worker1-ip, worker2-ip, worker3-ip]  TTL=60
    ▼
Client picks one IP (DNS round-robin)
    │
    ▼
Worker Node (any) — hostPort 80/443
    │
    ▼
NGINX Ingress Controller (DaemonSet pod)
    │  Routes by Host header / SNI
    ▼
Backend pod (on any node — Flannel overlay routes cross-node)
```

#### Node Failure Handling

```
Worker 2 goes NotReady:
  1. DNS Ingress Controller detects node status change (k8s watch)
  2. Removes Worker 2 IP from ingress.platform.com A record set
  3. PowerDNS serves updated records within seconds
  4. Clients with cached Worker 2 IP get connection timeout → retry another IP
  5. New DNS lookups never receive Worker 2 IP
  6. Recovery time: ~0s for clients on surviving IPs; ~60-90s for clients that cached dead IP
```

#### DaemonSet Configuration

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ingress-nginx
    spec:
      nodeSelector:
        node-role.kubernetes.io/worker: ""
      tolerations: []  # Do NOT run on control plane nodes
      hostNetwork: false
      containers:
        - name: controller
          image: registry.k8s.io/ingress-nginx/controller:latest
          ports:
            - containerPort: 80
              hostPort: 80
              protocol: TCP
            - containerPort: 443
              hostPort: 443
              protocol: TCP
          args:
            - /nginx-ingress-controller
            - --publish-status-address=$(POD_IP)
```

#### DNS Record Model

```
# Managed by DNS Ingress Controller (auto-updated):
ingress.platform.com.      60   IN  A  1.1.1.1    # Worker 1
ingress.platform.com.      60   IN  A  2.2.2.2    # Worker 2
ingress.platform.com.      60   IN  A  3.3.3.3    # Worker 3

# Set once per customer at provisioning (static, never changes):
www.customer.com.         3600  IN  CNAME  ingress.platform.com.
customer.com.             3600  IN  ALIAS  ingress.platform.com.   # Apex (ALIAS/ANAME)

# Platform services (static CNAME):
panel.platform.com.       3600  IN  CNAME  ingress.platform.com.
api.platform.com.         3600  IN  CNAME  ingress.platform.com.
```

### Alternatives Considered

1. **Floating IP + MetalLB** — Standard bare-metal K8s approach. Works well within a single hoster, but creates hoster lock-in (Floating IPs are hoster-specific), adds MetalLB as a dependency, and still funnels all traffic through one IP/node.
2. **Floating IP + keepalived** — Same as above but using VRRP. Additional complexity (keepalived config, VRRP protocol). Same hoster lock-in issue.
3. **Cloud Load Balancer (Hetzner LB)** — Simplest HA approach. But costs €6+/month, still hoster-specific, and adds an external dependency.
4. **Cloudflare Proxy** — Free tier available, built-in DDoS protection. But adds dependency on external SaaS, changes SSL model (Cloudflare terminates TLS), and complicates debugging.

### Consequences

**Positive:**
- **No hoster lock-in** — Worker nodes can be on any hoster (Hetzner, Strato, OVH, etc.). Each worker just needs a public IP.
- **No additional cost** — Eliminates Floating IP (€1-3/mo) and MetalLB from the stack.
- **Load distribution** — Traffic naturally spreads across all workers (DNS round-robin), not funneled through one IP.
- **No single point of failure** — If one worker dies, clients on other workers are unaffected. Only clients that cached the dead IP experience brief disruption (~60s).
- **Automatic scaling** — Adding a worker node automatically adds its IP to the DNS record set. Removing one removes it. No manual IP management.
- **Fewer components** — MetalLB and keepalived removed entirely. Less to configure, monitor, and debug.
- **Cross-hoster ready** — Supports future mixed-hoster deployments (e.g., CP on Hetzner, workers on Strato).

**Negative:**
- **DNS propagation delay** — Failover depends on DNS TTL (60s). Some clients may experience 60-90s of errors if they cached the IP of a dead worker. (Acceptable: platform SLO is 99.5% = 3.6 hours/month.)
- **Apex domain handling** — CNAME at zone apex violates DNS spec. Requires ALIAS/ANAME support in PowerDNS (available via LUA records) or maintaining direct A records for apex domains.
- **Custom controller needed** — Requires building a DNS Ingress Controller (small reconciliation loop watching node/pod events and calling PowerDNS API). Estimated: ~200 lines of code.
- **hostPort conflicts** — Ports 80 and 443 are claimed on every worker node. No other service can bind those ports. (Acceptable: only the Ingress Controller needs them.)
- **TTL trade-off** — 60s TTL means higher DNS query volume (every client, every minute). PowerDNS handles this easily, but it's more queries than a 300s TTL would generate.

### Related ADRs

- ADR-010: NGINX Ingress Controller (now deployed as DaemonSet instead of Deployment)
- ADR-013: NetBird + PowerDNS co-hosting (PowerDNS API enables the DNS-based routing)

---

## ADR-015: Remove MinIO — Plain Filesystem Backups on Offsite Server

**Date:** 2026-03-07  
**Status:** Accepted  
**Deciders:** Platform Architecture Team

### Context

The platform previously used **MinIO** (S3-compatible object storage) as the local backup staging area and media/object storage layer. MinIO served four roles:

1. **Cluster-managed backup storage** — DB dumps, file backups (Restic), Velero snapshots written to MinIO buckets
2. **Customer-created on-demand backup storage** — manual backups stored in MinIO within customer quota
3. **Media/branding storage** — logos, favicons, uploaded assets
4. **Event log cold storage** — old audit logs archived to MinIO

**MinIO OSS is no longer maintained.** MinIO Inc. has pivoted entirely to their commercial "AIStor" product. The open-source community edition is frozen — no security patches, no bug fixes. This was confirmed via their official blog post: "MinIO OSS is no longer maintained. This post details 13K+ commits separating AIStor from the frozen open-source edition." Running unmaintained software in a hosting platform is an unacceptable security risk.

Additionally, the backup architecture has been redesigned (see ADR-014 timeline) to use **SSHFS mount-based direct writes** to an offsite backup server, which already eliminates MinIO's primary role as a backup staging area. The remaining roles (media storage, cold storage) can be served by simpler alternatives.

A second requirement has emerged: **admins need to access individual customer files from backups** — both via the admin panel (selective file restore) and by browsing the backup server filesystem directly via SSH. The previous Restic-based backup format stores files in a deduplicated repository that cannot be browsed as a regular filesystem. This needs to change to plain filesystem copies.

### Decision

**Remove MinIO entirely from the platform stack.** Replace its roles as follows:

| Former MinIO Role | Replacement | Rationale |
|---|---|---|
| Cluster-managed backup storage | **Offsite server** (SSHFS mount, already implemented) | Backups write directly to offsite — no local staging needed |
| Customer-created backup storage | **Offsite server** (customer-backups/ directory, quota-accounted) | Same transport, separate directory tree |
| Media/branding storage (logos, favicons) | **Longhorn PV** (local persistent volume in `platform` namespace) | Simple, no additional component. Media is small (MBs). |
| Event log cold storage | **Offsite server** or **Longhorn PV** | Old logs archived to offsite backup during daily backup window |
| Harbor registry storage | **Longhorn PV** (Harbor default) | Harbor already uses PVs; MinIO was optional backend |

**Change file backup format from Restic to plain filesystem copy (`rsync --archive`).** This makes every customer file individually browseable and restorable from the backup server.

#### New Backup File Layout (Browseable Filesystem)

```
/backups/                              ← offsite server root (SSHFS mount target)
├── daily/
│   ├── 2026-03-07/
│   │   ├── databases/
│   │   │   ├── client-acme-corp/
│   │   │   │   ├── acme_wordpress.sql.gz.enc
│   │   │   │   └── acme_analytics.dump.enc
│   │   │   └── client-beta/
│   │   │       └── beta_app.sql.gz.enc
│   │   ├── files/                     ← PLAIN FILESYSTEM COPY (browseable!)
│   │   │   ├── client-acme-corp/
│   │   │   │   ├── index.html
│   │   │   │   ├── wp-content/
│   │   │   │   │   └── uploads/
│   │   │   │   │       └── logo.png   ← individually accessible
│   │   │   │   └── .htaccess
│   │   │   └── client-beta/
│   │   │       └── app/
│   │   │           └── server.js
│   │   ├── config/
│   │   │   ├── client-acme-corp/
│   │   │   │   └── metadata.json
│   │   │   └── client-beta/
│   │   │       └── metadata.json
│   │   ├── velero/
│   │   │   └── daily-2026-03-07.tar.gz
│   │   └── checksums.sha256
│   ├── 2026-03-06/                    ← previous day (same structure)
│   └── ...
├── customer-backups/                  ← customer-created on-demand backups
│   ├── client-acme-corp/
│   │   ├── manual-2026-03-05/         ← same structure as daily
│   │   └── manual-2026-03-01/
│   └── client-beta/
└── retention.conf
```

**Key properties:**
- `files/` directory uses `rsync --archive --delete` per customer — exact mirror of their live site files
- Individual files can be accessed by path: `cat /backups/daily/2026-03-07/files/client-acme-corp/wp-content/uploads/logo.png`
- Admin panel selective restore: mount offsite via SSHFS → copy specific file → unmount
- SSH browse: admin connects to backup server via NetBird mesh, navigates filesystem normally
- Database dumps remain compressed+encrypted (not browseable, but restorable per-database)
- Velero snapshots stored as tarball for full cluster recovery

#### Access Methods

| Method | Use Case | How |
|---|---|---|
| **Admin panel selective restore** | Restore specific file for a customer | Management API mounts offsite via SSHFS → copies requested file to customer PV → unmounts |
| **Admin SSH browse** | Investigate backup contents, verify integrity | `ssh backup-server` via NetBird → `ls /backups/daily/2026-03-07/files/client-acme/` |
| **Full customer restore** | Rebuild customer from backup | Mount offsite → `rsync` files/ back to customer PV, restore DB dump |
| **Customer backup export** | Customer downloads their data | Package their directory as .tar.gz, serve via panel download link |
| **GDPR deletion** | Remove all customer data from backups | `find /backups -path "*/client-{id}*" -exec rm -rf {} \;` across all daily/ directories |

#### File Backup: Restic → rsync

| Aspect | Restic (old) | rsync --archive (new) |
|---|---|---|
| Deduplication | Yes (chunk-level) | No (full copy per day) |
| Disk usage on backup server | Lower (dedup saves ~60-80%) | Higher (~1x per daily snapshot) |
| Individual file access | No (must `restic mount` or `restic restore`) | **Yes** — plain filesystem, any file accessible |
| Incremental backup | Yes (only changed chunks) | **Yes** — rsync only transfers changed files |
| Restore speed (single file) | Slow (must reconstruct from chunks) | **Instant** — just copy the file |
| Restore speed (full) | Medium (reconstruct all) | Fast (rsync or cp) |
| Encryption | Built-in | External (AES-256 pass over DB dumps; files unencrypted on backup server) |
| Complexity | Moderate (Restic repo management) | **Minimal** (standard Unix tools) |

**Trade-off:** rsync uses more disk on the backup server (no dedup), but disk is cheap on a dedicated backup VPS. The benefit — instant individual file access without specialized tooling — outweighs the storage cost for a hosting platform where file-level restore is a core operational need.

**File encryption note:** Database dumps are encrypted (AES-256) because they contain credentials and PII. Site files (HTML, CSS, images, PHP) are stored unencrypted on the backup server for direct browsability. The backup server itself is secured: accessed only via NetBird mesh (no public SSH), encrypted disk (LUKS), and restricted to admin access.

### Alternatives Considered

1. **Replace MinIO with Garage** — Lightweight Rust-based S3-compatible storage. Drop-in replacement. But adds another component to maintain, and we no longer need S3 API for anything — the SSHFS backup model uses plain filesystem.
2. **Replace MinIO with SeaweedFS** — Distributed storage with S3 API. More mature than Garage but heavier. Overkill for this platform's scale and needs.
3. **Keep MinIO OSS (frozen)** — Run the last released version. Rejected: unmaintained software with no security patches is unacceptable for a hosting platform.
4. **Use AIStor (MinIO commercial)** — Actively maintained but requires commercial license. Rejected: contradicts the self-hosted, open-source-only principle, and the platform doesn't need enterprise object storage features.
5. **Keep Restic for file backups** — Maintains deduplication savings. Rejected: individual file access from backups is a core requirement, and Restic's repository format doesn't support direct browsing.

### Consequences

**Positive:**
- **No unmaintained software** — MinIO OSS removed; no security risk from frozen codebase
- **Simpler stack** — one fewer component to deploy, configure, monitor, and secure
- **Browseable backups** — admin can SSH to backup server and navigate customer files as a normal filesystem
- **Instant file-level restore** — copy a single file from backup without reconstructing anything
- **Standard Unix tools** — backup and restore use `rsync`, `cp`, `find`, `tar`/`tar.gz`/`zip` — no specialized software. Archive format is configurable per customer (`tar`, `tar.gz`, or `zip`).
- **Backup server requires no mesh membership** — SSHFS connects over plain SSH; Hetzner StorageBox, rsync.net, and any standard SSH server work without NetBird agent. Optional: mesh transport available for self-managed backup VPS already in the NetBird network.
- **Cost savings** — no local MinIO storage needed (Longhorn capacity freed), no MinIO monitoring
- **Simpler GDPR deletion** — `rm -rf` on filesystem vs. S3 API calls
- **Customer-created backups** still supported (written to `customer-backups/` directory on offsite server)

**Negative:**
- **Higher backup server disk usage** — no Restic deduplication. Each daily snapshot stores a full copy of changed files. Mitigated: rsync only transfers deltas; unchanged files use hardlinks or are skipped.
- **Backup encryption is optional** — encryption is applied only when an admin-configured password is set in Admin Panel → Backup Settings. When no password is set, backups are written unencrypted (plain filesystem, directly browseable). When encryption is enabled, AES-256-CBC is applied to each archive. This is a deliberate trade-off: browsability and direct file access are preserved by default; admins who require encryption at rest can enable it at the cost of direct browsability. Mitigated: backup server secured via SSH keypair auth, LUKS disk encryption on backup server recommended, admin-only access.
- **No S3 API available** — any future feature requiring S3 API (e.g., direct upload from browser) would need a different solution. Mitigated: not needed for MVP; can add a lightweight S3 proxy later if required.
- **Media storage on Longhorn PV** — logos/branding stored on local PV instead of object storage. Mitigated: media is small (MBs per customer), Longhorn PV is sufficient.

### Implementation Notes (for applying edits)

**102 references to MinIO across 29 files need updating.** Key replacements:

| Pattern | Replacement |
|---|---|
| "MinIO" as backup storage | "offsite backup server" or "offsite server (SSHFS mount)" |
| "MinIO" as object/media storage | "Longhorn PV" or "local persistent volume" |
| "S3/MinIO" in database schema paths | "local filesystem path" or "Longhorn PV path" |
| "MinIO" in cost tables | Remove line (no separate object storage cost) |
| "MinIO" in tech stack tables | Remove or replace with "Longhorn PV (media/branding)" |
| "Restic" for file backups | "rsync --archive" (plain filesystem copy) |
| "MinIO lifecycle policies" | "Retention cleanup script (find + rm)" |
| MinIO credentials in SECRETS_MANAGEMENT | Remove MinIO access keys section |
| MinIO in COMPLIANCE_MATRIX | Replace S3 deletion commands with filesystem `rm -rf` |
| "minio/" bucket paths in CronJobs | SSHFS mount paths (`/mnt/offsite/daily/...`) |

**Files requiring edits (sorted by reference count):**
1. INFRASTRUCTURE_PLAN.md — 22 refs
2. BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md — 16 refs
3. BACKUP_STRATEGY.md — 14 refs
4. STORAGE_DATABASES.md — 9 refs
5. TECH_STACK_SUMMARY.md — 5 refs
6. DISASTER_RECOVERY.md — 4 refs
7. COMPLIANCE_MATRIX.md — 4 refs
8. SECRETS_MANAGEMENT.md — 3 refs
9. DATABASE_SCHEMA.md — 3 refs
10. Plus 20 more files with 1-2 refs each

### Related ADRs

- ADR-014: DNS-Based Ingress Routing (same session — SSHFS backup model established)
- ADR-013: NetBird WireGuard Mesh (backup server may optionally use mesh, but plain SSH is the default — Hetzner StorageBox does not support NetBird)
- ADR-003: MariaDB + PostgreSQL (database dumps format unchanged)
- ADR-009: Sealed Secrets (backup encryption keys still managed via Sealed Secrets)

---

## ADR-016: PowerDNS Runs in Docker Compose (Not Bare-Metal, Not Kubernetes)

**Date:** 2026-03-09
**Status:** Accepted — Deployment moved to infrastructure project per ADR-022. This project consumes the PowerDNS REST API.
**Deciders:** Platform Architecture Team

### Context

PowerDNS needs to run on ns1 (Hetzner Falkenstein, Debian 13 trixie) and ns2 (Hetzner
Helsinki, Debian 13 trixie). These VPS nodes are **not** part of the k3s cluster — they
are standalone nodes that serve DNS and host NetBird management.

Three deployment options were evaluated:

1. **Bare-metal apt install** — Install PowerDNS directly from the system package manager
2. **Kubernetes pod** — Run PowerDNS as a pod inside the k3s cluster
3. **Docker Compose on VPS nodes** — Run PowerDNS as a Docker Compose stack on ns1/ns2

Bare-metal was attempted first (via Ansible) and immediately encountered problems:

- The PowerDNS official apt repository only provides `bookworm` (Debian 12) builds
- The `bookworm` PowerDNS packages depend on `libboost1.74`, which does not exist on
  Debian 13 trixie (trixie ships `libboost1.83+`)
- Backporting or building from source adds operational complexity and an unbounded
  maintenance burden

### Decision

Run PowerDNS as a **Docker Compose stack** on each VPS node using the official
`powerdns/pdns-auth-49` Docker image. Files live at `/opt/powerdns/` on each node.

**ns1 (primary):** `powerdns/pdns-auth-49` + `postgres:16-alpine` sidecar, named volume
`pdns_pgdata` for PostgreSQL data.

**ns2 (secondary):** `powerdns/pdns-auth-49` only, named volume `pdns_sqlite` for SQLite
data (no PostgreSQL needed on the secondary).

Ansible deploys and manages both stacks via the `powerdns_master` and `powerdns_slave`
roles using `community.docker.docker_compose_v2`.

### Rationale

1. **Distro-independent** — Docker image works identically on Debian 12, Debian 13, or
   any future OS. No apt repo compatibility issues.
2. **Official image** — `powerdns/pdns-auth-49` is maintained by the PowerDNS project,
   tracks 4.9.x releases, and gets security updates independently of the host OS.
3. **Easy backup** — `docker volume` commands back up all PowerDNS state. On ns2, zones
   can be fully rebuilt via AXFR from ns1 anyway.
4. **Clean separation** — Config at `/opt/powerdns/pdns.conf`, mounted read-only into
   the container. Ansible manages config + compose file; Docker manages the process.
5. **No k8s dependency** — ns1 and ns2 are DNS + NetBird VPS that must function
   independently of the k3s cluster. Running DNS inside k3s would create a circular
   dependency (cluster needs DNS to start; DNS needs cluster to run).
6. **Fast iteration** — Config changes apply with `docker compose restart pdns`. No
   `systemctl` reload race conditions or `systemctl reset-failed` required.

### Consequences

**Positive:**
- DNS deployment is distro-independent — works on any Debian/Ubuntu/RHEL host with Docker CE
- Single `docker compose up` deploys the full stack
- Volumes provide clear backup targets (`pdns_pgdata`, `pdns_sqlite`)
- No apt repository compatibility issues
- Same image supports Phase 2 multi-region deployment

**Negative:**
- Docker CE must be installed on ns1 and ns2 (handled by Ansible `powerdns_master` and
  `powerdns_slave` roles — Docker CE installed from official repo with `bookworm stable`
  channel, which works on Debian 13)
- Config files must be deployed **before** `docker compose up` (Docker creates a directory
  at the bind-mount target if the file doesn't exist — Ansible task order enforces this)
- API endpoint is `http://127.0.0.1:8081` on ns1 host (not a k8s service) — Management
  API must reach it via NetBird WireGuard mesh

### PowerDNS 4.9 Setting Name Changes

The Docker image uses **PowerDNS 4.9**, which renamed several settings from the 4.x era:

| Old name (4.x) | New name (4.9) | Notes |
|----------------|----------------|-------|
| `master=yes` | `primary=yes` | |
| `slave=yes` | `secondary=yes` | |
| `superslave=yes` | `autosecondary=yes` | |
| `allow-unsigned-axfr` | `allow-unsigned-autoprimary` | |
| `axfr-master-only` | *(removed)* | |
| `api-readonly` | *(removed)* | |

Using old names results in startup warnings or silent ignored config. All Ansible templates
use the 4.9 names exclusively.

### Alternatives Considered

1. **Bare-metal apt install** — Rejected: PowerDNS official apt repo only has `bookworm`
   builds; `bookworm` packages depend on `libboost1.74` which doesn't exist on Debian 13.
   Building from source is a maintenance burden.
2. **Kubernetes pod** — Rejected: creates circular dependency (DNS needed by k3s CoreDNS
   and by the cluster's own domain resolution). ns1/ns2 must run independently.
3. **PowerDNS from Debian trixie main** — The trixie repo ships PowerDNS 4.9.x but was
   not always current at the time of initial deployment. Docker image provides a consistent
   version regardless of repo state.

### Related ADRs

- ADR-013: NetBird WireGuard Mesh (ns1 + ns2 are co-hosted DNS + NetBird nodes)
- ADR-014: DNS-Based Ingress Routing (PowerDNS API on ns1 is called by the DNS Ingress Controller)

---

## Decision Matrix: When to Create ADR

Create ADR for decisions that meet ANY of:
- ✅ Affects system architecture
- ✅ Technology selection (database, framework, etc.)
- ✅ Major operational policy
- ✅ Irreversible or hard to change
- ✅ Non-trivial trade-offs
- ✅ Security implications
- ✅ Cross-team impact

Don't need ADR for:
- ❌ Code style changes
- ❌ Naming conventions
- ❌ Minor library upgrades
- ❌ Configurable settings

---

## ADR Workflow

```
1. Propose → Create PR with new ADR-###.md
              Status: PROPOSED
              
2. Discuss → Team review, architecture committee sign-off
              Comments, rationale refinement
              
3. Accept  → Status changed to ACCEPTED
              Merge to main branch
              Communicate to team
              
4. Implement → Follow decision in code
               Reference ADR in commits
               
5. Evaluate → Quarterly review of adopted ADRs
              Might become DEPRECATED if context changes
```

---

## Checklist

- [ ] ADR-001: Namespace isolation implemented
- [ ] ADR-002: Harbor registry deployed
- [ ] ADR-003: MariaDB + PostgreSQL databases configured
- [ ] ADR-004: Dex OIDC provider deployed
- [ ] ADR-005: Flux v2 GitOps pipeline setup
- [ ] ADR-006: Three-layer caching implemented
- [ ] ADR-008: Prometheus + Grafana + Loki stack running
- [ ] ADR-009: Sealed Secrets for credential management active
- [ ] ADR-010: NGINX Ingress Controller deployed (k3s Traefik disabled)
- [ ] ADR-011: Fastify API framework configured
- [ ] ADR-013: NetBird WireGuard mesh deployed (admin access VPN)
- [ ] ADR-014: DNS-based ingress routing active (DaemonSet NGINX + PowerDNS multi-A records)
- [ ] ADR-015: MinIO removed; backups on offsite server; media on Longhorn PV
- [x] ADR-016: PowerDNS Docker Compose stacks deployed on ns1 + ns2
- [x] ADR-017: PowerDNS-Admin bound to loopback + nftables DNAT from NetBird wt0
- [x] ADR-018: Docker restarted after every nftables reload via handler listen
- [x] ADR-019: route_localnet enabled on dns_master for DNAT-to-loopback
- [x] ADR-020: AXFR/NOTIFY routed over NetBird WireGuard tunnel (TSIG removed)
- [ ] Create ADR for any new architectural decisions
- [ ] Review ADRs quarterly for relevance

---

## ADR-016b: Traditional Hosting Deployment Model — FileBrowser, SFTP, Git Pull

> **Note:** This was originally numbered ADR-016 (duplicate). Renumbered to ADR-016b to avoid conflict with ADR-016 (PowerDNS Docker Compose).

**Date:** 2026-03-07
**Status:** Accepted
**Deciders:** Platform Architect

### Context

The platform needs to define how customers deploy code to their workloads (websites/apps). The question arose specifically for the staging-to-production workflow: how does a customer with `dev.example.com` push code to the live `www.example.com`?

The platform is a **Plesk/cPanel replacement** for traditional web hosting. Target users are web developers and agencies who expect a familiar shared-hosting experience, not a DevOps/CI/CD pipeline.

A secondary issue existed: customer file paths were inconsistent across 6+ documents, using different mount points and directory structures. This ADR establishes a canonical layout.

### Decision

**Adopt a traditional hosting deployment model.** No staging-to-production automation, no per-customer CI/CD pipelines, no blue-green deployments for customer sites.

Customers deploy code using **three methods**, all writing to the same underlying PersistentVolume:

1. **SFTP** — Traditional file upload (FileZilla, WinSCP, terminal)
2. **FileBrowser** — Web-based file manager accessible from the client panel
3. **Git Pull** — Pull files from a Git repository into a specific webroot (triggered by webhook or API call)

**Promotion from dev to production is manual** — the customer copies files within FileBrowser (or SFTP) from one directory to another. This is the same model as cPanel/Plesk.

#### Canonical Customer File Path Layout

All customer files live on a single PersistentVolume per customer. Every access method (SFTP, FileBrowser, shared pod mount, dedicated pod mount) sees the **same filesystem**:

```
/storage/customers/{customer_id}/
├── domains/
│   ├── example.com/                    ← webroot for www.example.com
│   │   ├── public_html/                ← document root (configurable per domain)
│   │   │   ├── index.php
│   │   │   ├── wp-content/
│   │   │   └── ...
│   │   ├── logs/                       ← per-domain access/error logs (optional)
│   │   └── private/                    ← above webroot — not web-accessible
│   ├── dev.example.com/               ← webroot for dev subdomain
│   │   ├── public_html/
│   │   │   └── index.php
│   │   └── private/
│   └── blog.example.com/              ← webroot for blog subdomain
│       ├── public_html/
│       └── private/
├── shared/                             ← files shared across all domains (e.g., common libs)
├── tmp/                                ← temporary files (PHP sessions, uploads)
├── backups/                            ← customer-created backup downloads
└── .platform/                          ← platform metadata (read-only to customer)
    ├── git-deploy/                     ← Git deploy configs per domain
    │   ├── example.com.json
    │   └── dev.example.com.json
    └── logs/                           ← platform-generated logs
```

**Path mapping across components:**

| Component | Mount Point | What It Sees |
|-----------|------------|--------------|
| **SFTP gateway** | Chroot to `/storage/customers/{id}/` | Full customer directory (all domains) |
| **FileBrowser** | Root at `/storage/customers/{id}/` | Full customer directory (all domains) |
| **Shared pod (Starter)** | `/mnt/clients/{id}/` → PV | Full customer directory |
| **Dedicated pod (Biz/Prem)** | `/var/www/` → PV | Full customer directory |
| **NGINX/Apache** | Document root: `/storage/customers/{id}/domains/{domain}/public_html/` | Single domain's public files |
| **PHP-FPM** | `open_basedir`: `/storage/customers/{id}/` | Full customer directory (PHP can access all domains) |
| **Offsite backup** | rsync source: `/storage/customers/{id}/` | Full customer directory |

**Key principle:** One PV per customer. One filesystem. All domains, subdomains, and shared files are visible from every access method. The customer can freely copy files between `domains/dev.example.com/public_html/` and `domains/example.com/public_html/` using FileBrowser or SFTP.

#### FileBrowser Model

| Decision | Value |
|----------|-------|
| Deployment | **One FileBrowser instance per customer** (launched on-demand from client panel) |
| Root directory | `/storage/customers/{customer_id}/` (customer sees all their domains) |
| Authentication | Platform OIDC (Dex) — single sign-on from client panel |
| Features | Browse, upload, download, rename, delete, **copy**, **move**, edit (code editor with syntax highlighting), create folder, zip/unzip |
| Access control | Customer has full read/write to their PV; `.platform/` directory is read-only |
| Lifecycle | Starts when customer opens file manager; auto-terminates after 30 min idle |
| Pod spec | Sidecar or on-demand Job in customer namespace, ~64Mi RAM, ~100m CPU |

**The copy/move operations within FileBrowser are how customers "promote" code from dev to production.** This is the primary staging-to-production workflow:

1. Customer develops on `dev.example.com` (files in `domains/dev.example.com/public_html/`)
2. Customer opens FileBrowser from client panel
3. Customer selects files in `domains/dev.example.com/public_html/`
4. Customer copies them to `domains/example.com/public_html/`
5. Files are immediately live on `www.example.com`

#### Git Pull Model (Git Deploy Service)

The Git Deploy Service does **not build** anything. It pulls files from a Git repository and syncs them to a specific domain's webroot. It is a **pull model**, not a push model — the platform pulls from the customer's repo.

| Decision | Value |
|----------|-------|
| Trigger | **Webhook** (GitHub/GitLab/Gitea/Bitbucket) OR **API call** from client panel |
| Operation | `git clone --depth 1 --branch {branch}` → `rsync --archive --delete` to domain webroot |
| Scope | **Per-domain** — each domain can have its own Git repo + branch |
| Branch mapping | Customer configures: repo URL + branch + deploy path per domain |
| Authentication | Deploy key (SSH) or personal access token (HTTPS) — stored as Sealed Secret |
| Post-deploy hooks | Optional: `composer install`, `npm install` (configurable per domain) |
| Deployment log | Stored in `deployment_history` table; visible in client panel |
| Rollback | Re-deploy previous commit (stored in history) or manual re-pull |
| Concurrent deploys | Queued per-domain (only one deploy at a time per domain) |

**Example workflow — Git-based dev-to-production:**

1. Customer has two Git Deploy configs:
   - `dev.example.com` → repo `github.com/acme/site.git`, branch `develop`
   - `example.com` → repo `github.com/acme/site.git`, branch `main`
2. Customer pushes to `develop` → webhook fires → files sync to `domains/dev.example.com/public_html/`
3. Customer tests on `dev.example.com`
4. Customer merges `develop` → `main` in Git
5. Webhook fires (or customer clicks "Deploy" in panel) → files sync to `domains/example.com/public_html/`

**API endpoint for manual trigger:**
```
POST /api/v1/domains/{domain_id}/deploy
Authorization: Bearer {token}

Response: { "deployment_id": "...", "status": "queued" }
```

**Webhook endpoint:**
```
POST /api/v1/webhooks/git-deploy/{webhook_secret}
Content-Type: application/json

Body: Standard GitHub/GitLab webhook payload
→ Platform extracts branch, matches to domain config, triggers deploy
```

#### What This ADR Explicitly Does NOT Include

- **No staging-to-production automation** — promotion is manual (FileBrowser copy or Git merge)
- **No blue-green / canary deployments** for customer sites (only for platform services)
- **No per-customer CI/CD pipelines** — the platform does not run customer build scripts (except optional `composer install` / `npm install` as post-deploy hooks)
- **No atomic file swaps** — files are immediately live during SFTP upload (same as cPanel/Plesk)
- **No container builds per customer** — customers deploy files, not images

### Alternatives Considered

1. **Full CI/CD per customer** (GitHub Actions-style) — Rejected: too complex for target audience, massive resource overhead, not a shared-hosting paradigm
2. **Staging environment with promote button** — Rejected: adds complexity without clear value for traditional hosting users; FileBrowser copy achieves the same result
3. **Git push model** (platform hosts Git repos) — Rejected: requires Git server infrastructure (Gitea/Forgejo); pull model is simpler and works with any external Git provider
4. **Atomic deploys via symlink swap** — Deferred: could be added later as an optional feature for Git Deploy (deploy to new directory, swap symlink). Not needed for MVP.

### Consequences

**Positive:**
- Familiar to cPanel/Plesk users — zero learning curve
- Simple implementation — no build infrastructure needed
- FileBrowser gives full cross-domain file access (copy dev → prod)
- Git Deploy covers the developer workflow (branch-based deploys)
- Low resource usage — no CI/CD runners, no build queues

**Negative:**
- No atomic deploys — partial SFTP uploads can briefly serve broken state
- No automated testing before deploy — customer responsibility
- Manual promotion — customer must copy files or merge branches
- Post-deploy hooks limited to `composer install` / `npm install` (no arbitrary scripts)

**Mitigations:**
- Document best practices: "upload to a temp directory, then rename" for atomic-ish deploys via SFTP
- Git Deploy uses `rsync --delete` which is atomic at the filesystem level (files appear after rsync completes)
- Future: optional symlink-swap mode for Git Deploy (ADR deferred)

### Implementation Notes

**Database tables needed:**

```sql
-- Git Deploy configuration per domain
CREATE TABLE git_deploy_configs (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  domain_id VARCHAR(36) NOT NULL UNIQUE,
  client_id VARCHAR(36) NOT NULL,
  repository_url VARCHAR(500) NOT NULL,
  branch VARCHAR(255) DEFAULT 'main',
  deploy_path VARCHAR(500) DEFAULT 'public_html/',
  credential_type ENUM('ssh_key', 'access_token') NOT NULL,
  credential_secret_name VARCHAR(255) NOT NULL,
  post_deploy_hooks JSON,
  webhook_secret VARCHAR(255) NOT NULL,
  auto_deploy_on_push BOOLEAN DEFAULT TRUE,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  KEY idx_client_id (client_id),
  KEY idx_webhook_secret (webhook_secret),
  
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Deployment history log
CREATE TABLE deployment_history (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  domain_id VARCHAR(36) NOT NULL,
  client_id VARCHAR(36) NOT NULL,
  deploy_method ENUM('git_pull', 'sftp', 'filebrowser', 'api') NOT NULL,
  git_commit_sha VARCHAR(40),
  git_branch VARCHAR(255),
  status ENUM('queued', 'in_progress', 'completed', 'failed', 'rolled_back') DEFAULT 'queued',
  files_changed INT,
  duration_seconds INT,
  error_message TEXT,
  triggered_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  
  KEY idx_domain_id (domain_id),
  KEY idx_client_id (client_id),
  KEY idx_status (status),
  KEY idx_created_at (created_at),
  
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Files updated to adopt canonical path layout (`/storage/customers/{id}/`):**
- `01-core/SHARED_POD_IMPLEMENTATION.md` — updated to `/storage/customers/{id}/domains/{domain}/public_html/`
- `01-core/WORKLOAD_DEPLOYMENT.md` — updated to `/storage/customers/{id}/`
- `01-core/HOSTING_PLANS.md` — updated to `/storage/customers/{id}/`
- `01-core/PLATFORM_ARCHITECTURE.md` — updated to `/storage/customers/{id}/`
- `02-operations/INFRASTRUCTURE_SIZING.md` — updated to `/storage/customers/{id}/`
- `02-operations/ADMIN_PANEL_REQUIREMENTS.md` — updated to `/storage/customers/{id}/`

**Files still requiring review for path consistency:**
- `06-features/FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md` — `/home/customer/public_html/` → chroot to `/storage/customers/{id}/`
- `06-features/HOSTING_SETTINGS_SPECIFICATION.md` — `config_mode` ENUM simplified
- `04-deployment/DEPLOYMENT_PROCESS.md` — Git Deploy section expanded
- `02-operations/CLIENT_PANEL_FEATURES.md` — FileBrowser and Git Deploy details added
- `01-core/DATABASE_SCHEMA.md` — New tables added

> **Note:** `INFRASTRUCTURE_PLAN.md` (master reference) retains legacy `/mnt/clients/` paths; subdirectory docs are authoritative.

---

## ADR-017: PowerDNS-Admin Port Binding — Loopback + nftables DNAT from NetBird wt0

**Date:** 2026-03-09
**Status:** Accepted
**Deciders:** Platform Architect

### Context

PowerDNS-Admin (pdns-admin) is an internal management web UI that must only be accessible to
platform operators over the NetBird mesh (not the public internet). It runs as a Docker container
on ns1.

Initial attempt bound the Docker port to the NetBird IP directly
(`{{ ns1_netbird_ip }}:8082:80`). This failed with:

```
iptables: No chain/target/match by that name
```

Docker's iptables backend initialises its `DOCKER` chain only for interfaces known at startup
(typically `0.0.0.0` or a specific interface already established). Binding to the NetBird `wt0`
IP at container start time fails because Docker's iptables `DOCKER` chain has not been
initialised for that interface.

### Decision

Bind Docker to **loopback only**: `127.0.0.1:{{ pdns_admin_port }}:80`.

Expose the service to NetBird peers via an **nftables prerouting DNAT rule**:

```nftables
table ip nat {
    chain prerouting {
        type nat hook prerouting priority dstnat;
        iifname "wt0" tcp dport 8082 dnat to 127.0.0.1:8082
    }
}
```

Additionally, enable `net.ipv4.conf.all.route_localnet = 1` (ADR-019) so the kernel routes
DNAT-rewritten packets (destination `127.0.0.1`) arriving on `wt0` to the loopback interface.

### Consequences

- pdns-admin is inaccessible from public internet; only reachable from a NetBird peer
- Binding to `127.0.0.1` avoids all Docker iptables interface initialisation problems
- The nftables DNAT approach is independent of Docker — works regardless of Docker restart order
- `route_localnet` is a non-default kernel parameter; must be set persistently via sysctl

### Alternatives Considered

- **Bind to `0.0.0.0:8082`** — exposes the UI to the public internet (rejected)
- **Reverse proxy (nginx/Traefik) on wt0** — adds complexity; DNAT approach is simpler
- **Bind to `wt0` IP directly** — fails due to Docker iptables chain initialisation (rejected)

---

## ADR-018: Docker Daemon Restart After nftables Reload

**Date:** 2026-03-09
**Status:** Accepted
**Deciders:** Platform Architect

### Context

The `common` role manages the nftables firewall. When the nftables config changes, Ansible
notifies the `Reload nftables` handler which runs `systemctl reload nftables`. This causes
`nft -f /etc/nftables.conf` to execute `flush ruleset` then reload all rules.

`flush ruleset` removes **all** nftables tables and chains, including the `DOCKER`,
`DOCKER-USER`, `DOCKER-ISOLATION-STAGE-*` chains that Docker creates via `iptables-nft` when it
starts. After the flush, those chains no longer exist.

When Docker then tries to start a new container with a port mapping, it calls:
```
iptables --wait -t nat -A DOCKER -p tcp ... -j DNAT ...
```
This fails with `iptables: No chain/target/match by that name` because the `DOCKER` chain was
wiped by the nftables flush.

### Decision

Add a second handler in `common/handlers/main.yml` that **listens** for the `Reload nftables`
notification and restarts Docker:

```yaml
- name: Restart Docker after nftables reload
  ansible.builtin.systemd:
    name: docker
    state: restarted
  failed_when: false
  listen: Reload nftables
```

`failed_when: false` ensures this is a no-op on hosts where Docker is not installed (e.g. ns2
before Docker is deployed, future k3s nodes).

Using `listen:` causes Ansible to run both handlers in declaration order when any task notifies
`Reload nftables` — nftables reloads first, then Docker restarts and re-creates its iptables
chains.

### Consequences

- Every nftables ruleset change causes a Docker restart on Docker hosts
- Docker restart takes ~2 seconds; running containers are unaffected (only the daemon restarts)
- Docker Compose stacks auto-recover because Docker restarts containers that have `restart: unless-stopped`
- `failed_when: false` silently ignores Docker-not-found on non-Docker hosts

### Alternatives Considered

- **Manual Docker restart** — error-prone, breaks idempotency (rejected)
- **iptables-save/restore** — saves Docker's chains before nftables reload and restores after;
  fragile across Docker version updates (rejected)
- **nftables `include` Docker chains** — Docker manages its chains dynamically; static includes
  would be stale immediately (rejected)

---

## ADR-019: Enable route_localnet for DNAT-to-Loopback on dns_master

**Date:** 2026-03-09
**Status:** Accepted
**Deciders:** Platform Architect

### Context

ADR-017 establishes that pdns-admin traffic arriving on NetBird `wt0` is DNAT'd to
`127.0.0.1:8082`. However, Linux by default drops packets routed to `127.0.0.0/8` that arrive
on non-loopback interfaces, even after a prerouting DNAT rewrites the destination.

The kernel parameter controlling this is `net.ipv4.conf.<iface>.route_localnet` (default `0`).
With `route_localnet=0`, DNAT packets destined for `127.0.0.1` are silently dropped after
prerouting — they never reach the Docker port.

Symptom: `curl http://100.76.182.198:8082/` from ns2 returns `000` (connection refused/timeout)
even though the DNAT rule and Docker port binding are both correct.

### Decision

Set `net.ipv4.conf.all.route_localnet = 1` persistently via Ansible `ansible.posix.sysctl` on
hosts in the `dns_master` group:

```yaml
- name: Enable route_localnet for DNAT-to-loopback on dns_master
  ansible.posix.sysctl:
    name: net.ipv4.conf.all.route_localnet
    value: '1'
    state: present
    sysctl_set: true
    reload: true
  when: inventory_hostname in groups['dns_master']
```

`sysctl_set: true` applies the parameter immediately; `state: present` writes it to
`/etc/sysctl.d/` for persistence across reboots.

### Consequences

- Packets DNAT'd to `127.0.0.1` from `wt0` are correctly routed to the loopback interface
- `route_localnet=1` is a mild security relaxation: it allows traffic from any interface to
  reach loopback services. Mitigated here by the nftables input chain which only accepts port
  8082 from `wt0` (NetBird peers) — the public internet cannot reach port 8082
- Must be set on any future host that uses DNAT-to-loopback from a non-loopback interface

### Alternatives Considered

- **Bind Docker to `0.0.0.0`** — exposes service publicly (rejected)
- **Use a Unix socket + reverse proxy** — adds component complexity (rejected)
- **WireGuard/NetBird built-in routing** — NetBird does not support per-peer port forwarding
  rules at the application layer (rejected)

---

## ADR-020: AXFR/NOTIFY Routed Over NetBird WireGuard Tunnel (TSIG Removed)

**Date:** 2026-03-10 (supersedes 2026-03-09 TSIG draft)
**Status:** Accepted — Moved to infrastructure project per ADR-022.
**Deciders:** Platform Architect

### Context

Zone transfers (AXFR) and change notifications (NOTIFY) between ns1 (primary) and ns2
(secondary) must be authenticated and protected against injection or eavesdropping.

An initial implementation used TSIG (HMAC-SHA256) to authenticate DNS messages while still
routing them over the public internet. TSIG was then removed in favour of routing AXFR/NOTIFY
exclusively over the existing NetBird WireGuard mesh.

The platform already runs NetBird on both ns1 and ns2 for admin access (ADR-013). The
WireGuard tunnel between them provides:

- **Authentication:** Public-key WireGuard handshake — only peers with the correct private key
  can establish or inject traffic into the tunnel
- **Encryption:** ChaCha20-Poly1305 AEAD — zone data is encrypted in transit
- **Replay protection:** WireGuard nonce prevents packet replay

TSIG provided authentication + integrity (HMAC-SHA256) but **no encryption** — zone data
(A, MX, TXT, DKIM, SPF records) travelled in cleartext. WireGuard provides all three properties.
TSIG is redundant when WireGuard is already in use.

### Decision

Route all AXFR and NOTIFY traffic between ns1 and ns2 exclusively over the NetBird WireGuard
tunnel. TSIG is not used.

**ns1 (primary) configuration:**
- `also-notify = {{ ns2_netbird_ip }}:53` — sends NOTIFY to ns2's WireGuard IP
- `allow-axfr-ips = {{ ns2_netbird_ip }}` — only accepts AXFR requests from ns2's WireGuard IP

**ns2 (secondary) configuration:**
- `allow-notify-from = {{ ns1_netbird_ip }}` — only accepts NOTIFYs from ns1's WireGuard IP
- Autoprimary registered with ns1's **WireGuard IP** (`{{ ns1_netbird_ip }}`), not its public IP

**NetBird IPs:**
- ns1: `100.76.182.198`
- ns2: `100.76.92.172`

### What WireGuard provides

| Property | Status |
|---|---|
| Authenticity | **Yes** — WireGuard public-key handshake |
| Integrity | **Yes** — ChaCha20-Poly1305 AEAD |
| Confidentiality | **Yes** — encrypted in transit |
| Replay protection | **Yes** — WireGuard nonce |

### Consequences

- Zone transfers are encrypted and authenticated — no plain-text zone data on the wire
- NOTIFY from ns1's public IP is rejected by ns2 (`allow-notify-from` only accepts `100.76.182.198`)
- AXFR from ns2's public IP is rejected by ns1 (`allow-axfr-ips` only accepts `100.76.92.172`)
- Zone transfer depends on the WireGuard mesh being up. If both ns1 and ns2 lose NetBird
  connectivity simultaneously (extremely unlikely — different datacenters), AXFR will not work
  until the tunnel is restored. Mitigation: the xfr-cycle-interval (60s) ensures automatic
  recovery once the tunnel is re-established.
- Management API must create zones with `kind: "Master"` (not `kind: "Native"`) — `Native`
  zones on ns1 do not serve AXFR out. See Gotcha #14 in NS_SERVERS_OPERATIONS.md.

### Implementation Gotchas

1. **Docker userland-proxy masquerades source IPs.** With Docker's default `userland-proxy=true`,
   PowerDNS inside the container sees AXFR/NOTIFY sources as `172.18.0.1` (Docker bridge
   gateway) instead of the real remote IP. Fix: `"userland-proxy": false` in `daemon.json` on
   both ns1 and ns2.
2. **ns2 PowerDNS must use `network_mode: host`.** Even with `userland-proxy: false`, NetBird's
   postrouting masquerade chain rewrites source IPs for packets forwarded from `wt0` through
   Docker's bridge network. `network_mode: host` bypasses all Docker NAT entirely, preserving
   the original WireGuard source IP (`100.76.182.198`) end-to-end.
3. **`network_mode: host` requires `user: root`** for the `powerdns/pdns-auth-49` image to bind
   port 53 (privileged port, below 1024). The image's default uid 953 cannot bind privileged
   ports without ambient capabilities, so the container is run as root.
4. **Zone type must be `primary`** for AXFR out. pdns-admin creates `Native` zones by default.
   Set with: `pdnsutil set-kind <zone> primary` on ns1.
5. **Old public-IP autoprimary must be removed** if it was ever registered on ns2. Having both
   `23.88.111.142` and `100.76.182.198` as autoprimaries allows the old public-IP NOTIFY path
   to bypass `allow-notify-from`. Remove with:
   `pdnsutil remove-autoprimary 23.88.111.142 ns1.phoenix-host.net`

### Alternatives Considered

- **TSIG (HMAC-SHA256)** — authentication + integrity but no encryption; requires shared secret
  management; `pdnsutil import-tsig-key` is not idempotent (plain INSERT). TSIG was briefly
  implemented and then removed in favour of this approach (WireGuard supersedes it).
- **TSIG + WireGuard** — belt-and-suspenders; redundant given WireGuard already provides auth +
  encryption. Adds operational complexity for no security benefit.
- **DNSSEC** — signs zone records, not the transfer channel; does not prevent AXFR injection
  (complementary, not a replacement for transport security).
- **No protection** — rejected; zone injection risk is real on shared Hetzner backbone.

---

## ADR-021: NetBird Redundancy — DNS Round-Robin with Floating IP Preparation

**Date:** 2026-03-11
**Status:** Accepted — Moved to infrastructure project per ADR-022.
**Deciders:** Platform Architect, User

### Context

NetBird provides critical infrastructure services: Management, Signal, and Relay servers for the WireGuard mesh. Initially planned as single-instance deployment on ns1, this created a single point of failure.

**Requirements:**
1. High availability for NetBird services (Management + Signal + Relay)
2. If ns1 fails, NetBird services must remain accessible
3. Solution must be simple enough for Phase 1 (3 servers, 0 customers)
4. Must support future migration to floating IP (for faster failover)

**Options evaluated:**
1. **Single instance on ns1** — Simple but single point of failure (15-20 min RTO)
2. **Active-Passive with DNS round-robin** — Redundant, automatic failover, 5-10 sec delay
3. **Keepalived with floating IP** — True HA (3-10 sec failover), but ns1/ns2 in different datacenters
4. **External DNS provider (Cloudflare)** — Automatic health checks, but not self-hosted

### Decision

Deploy NetBird Management + Signal + Relay on **both ns1 and ns2** in active-passive configuration, using **DNS round-robin** for failover. Prepare architecture to support **floating IP migration** in the future.

**Architecture:**

**Phase 1 (Now): DNS Round-Robin**
- ns1: NetBird Management + Signal + Relay (active)
- ns2: NetBird Management + Signal + Relay (active)
- Shared PostgreSQL database on ns1 (both ns1 and ns2 connect to it)
- DNS: `netbird.phoenix-host.net. IN A 23.88.111.142` (ns1)
- DNS: `netbird.phoenix-host.net. IN A 89.167.125.29` (ns2)

**Clients connect to `https://netbird.phoenix-host.net`:**
- DNS returns both IPs
- Client tries ns1 first (or random order)
- If ns1 is down, client automatically retries ns2
- Failover delay: 5-10 seconds

**Phase 2+ (Future): Floating IP**
- DNS: `netbird.phoenix-host.net. IN A 100.76.100.100` (floating IP)
- Floating IP managed by keepalived (if ns1/ns2 migrate to same datacenter) or Hetzner Floating IP (if migrated to Hetzner Cloud)
- Failover delay: 3-10 seconds (automatic)

### Rationale

**Why DNS round-robin:**
1. ✅ Automatic failover — no manual intervention required
2. ✅ Simple implementation — just add two A records
3. ✅ Works with current infrastructure (ns1 in Falkenstein, ns2 in Helsinki)
4. ✅ NetBird clients handle failover automatically
5. ✅ Acceptable 5-10 second delay for Phase 1

**Why shared PostgreSQL:**
1. ✅ NetBird state preserved across failover (peer configs, access control)
2. ✅ Both ns1 and ns2 can serve NetBird management API
3. ✅ No manual state sync required

**Why prepare for floating IP:**
1. ✅ Faster failover (3-10 seconds vs 5-10 seconds)
2. ✅ Single DNS record (simpler)
3. ✅ Future-proof for infrastructure changes (datacenter consolidation, Hetzner Cloud migration)
4. ✅ Migration path clear — update DNS only, no application changes

### Consequences

**Positive:**
- ✅ NetBird services survive ns1 failure
- ✅ Automatic failover (no manual DNS updates)
- ✅ Prepared for faster failover with floating IP
- ✅ Works with current multi-datacenter deployment

**Negative:**
- ❌ 5-10 second failover delay (vs 3-10 sec with floating IP)
- ❌ PostgreSQL on ns1 is single point of failure (mitigated by Restic backups)
- ❌ Additional complexity (NetBird services on both ns1 and ns2)

**Mitigation:**
- PostgreSQL backup: Restic to Storagebox 2x daily (02:00 UTC)
- PostgreSQL recovery: Restore from backup + redeploy (RTO: 15 minutes)
- Floating IP migration path documented in this ADR

### Migration Path to Floating IP

**When to migrate:**
- ns1 and ns2 moved to same datacenter (enables keepalived)
- Platform migrated to Hetzner Cloud (enables Hetzner Floating IPs)
- Failover delay becomes critical (< 5 seconds required)

**Migration steps:**
1. Provision floating IP (keepalived VIP or Hetzner Floating IP)
2. Configure keepalived on ns1 and ns2 (if using keepalived)
3. Update DNS: `netbird.phoenix-host.net. IN A <floating-ip>`
4. Wait for DNS TTL (typically 300 seconds)
5. Test failover (stop NetBird on ns1, verify floating IP moves to ns2)

**No application changes required** — NetBird clients will automatically use new DNS record.

### PostgreSQL Redundancy (Future Consideration)

**Current:** PostgreSQL on ns1 only (single point of failure)

**Future options (Phase 2+):**
1. PostgreSQL replication (primary on ns1, replica on ns2)
2. External managed PostgreSQL (Hetzner Cloud Database, AWS RDS)
3. PostgreSQL cluster (Patroni, Stolon)

**Not implemented in Phase 1** — Restic backups sufficient for current scale.

### Alternatives Considered

1. **Single instance on ns1 with break-glass SSH**
   - Rejected: 15-20 minute RTO unacceptable for VPN infrastructure
   - Mitigation: SSH break-glass stays available as backup

2. **Keepalived with floating IP (now)**
   - Rejected: ns1 (Falkenstein) and ns2 (Helsinki) in different datacenters, no Layer 2 adjacency
   - Deferred to Phase 2+ when infrastructure changes

3. **External DNS provider (Cloudflare Load Balancer)**
   - Rejected: Not self-hosted, conflicts with project goals

4. **Health-check based DNS updates (monitoring script)**
   - Rejected: Additional complexity, monitoring script is single point of failure
   - DNS round-robin simpler and more reliable

### Related ADRs

- ADR-013: NetBird WireGuard Mesh for Admin Access
- ADR-016: PowerDNS Runs in Docker Compose
- ADR-020: AXFR/NOTIFY Routed Over NetBird WireGuard Tunnel

---

## ADR-022: Architectural Separation — External DNS, NetBird & IAM

**Date:** 2026-03-24
**Status:** Accepted
**Deciders:** Platform Architect, User
**Supersedes context of:** ADR-004 (Dex), ADR-013 (NetBird), ADR-016 (PowerDNS Docker Compose), ADR-020 (AXFR over NetBird), ADR-021 (NetBird Redundancy)

### Context

The K8s hosting platform originally included deployment and management of three foundational infrastructure services:

1. **PowerDNS** — Authoritative DNS on ns1/ns2 (Docker Compose, Ansible-managed)
2. **NetBird** — WireGuard mesh VPN for admin access (Docker Compose on ns1/ns2)
3. **Dex** — OIDC identity provider (planned for K8s cluster)

These services are **foundational infrastructure** that the hosting platform depends on, but their deployment, HA, and operations are fundamentally different concerns from building a web hosting platform. Specifically:

- DNS must survive cluster failure (cannot share fate with the cluster it serves)
- NetBird provides the admin access layer to the cluster (chicken-and-egg if co-deployed)
- IAM/OIDC is a shared service potentially used by multiple projects
- Managing ns1/ns2 VPS nodes, Ansible roles, Docker Compose stacks, and DNS replication is a separate operational domain from K8s workload management

### Decision

**Split into two projects:**

1. **Infrastructure Project** (separate repository) — Deploys and manages:
   - PowerDNS authoritative DNS (ns1 primary, ns2 secondary)
   - NetBird WireGuard mesh VPN (management, signal, relay)
   - IAM/OIDC provider (Dex or equivalent)
   - Ansible automation for ns1/ns2/VPS provisioning
   - DNS replication (AXFR/NOTIFY)
   - Certificate management for these services

2. **K8s Hosting Platform** (this project) — Consumes external APIs:
   - PowerDNS REST API for zone/record management (endpoint configurable in admin panel)
   - NetBird mesh for admin access (assumes mesh already running)
   - OIDC provider for authentication (issuer URL configurable in admin panel)
   - Focuses exclusively on K8s hosting, management API, admin panel, and client panel

**K8s cluster model:**
- Starts as single-node k3s cluster
- Expands to multi-node and eventually full HA as the business grows
- No dependency on external VPS nodes (ns1/ns2) for cluster operations

### Consequences

**Positive:**
- Clear separation of concerns — infrastructure vs. application
- Each project can evolve independently
- Hosting platform becomes portable (can point to any PowerDNS/OIDC provider)
- Simpler onboarding — developers don't need to understand DNS deployment to work on the admin panel
- Admin panel gains "External Service Configuration" section for connecting to infrastructure services

**Negative:**
- Two repositories to manage instead of one
- Integration testing requires both projects running
- API contracts between projects must be documented and versioned

**Neutral:**
- ADRs 004, 013, 016, 020, 021 remain valid architectural decisions — they move to the infrastructure project, not rejected
- DNS management logic (zone templates, mode selection, record CRUD) stays in this project as API consumer patterns
- Security model unchanged — just the deployment location of services changes

### Documentation Impact

Files archived from this project (moved to infrastructure project scope):
- `01-core/DISPERSED_DNS_ARCHITECTURE.md`
- `01-core/POWERDNS_INTEGRATION.md`
- `02-operations/NS_SERVERS_OPERATIONS.md`
- `04-deployment/NETBIRD_CERTIFICATE_BOOTSTRAP.md`
- `04-deployment/NETBIRD_SIGNAL_CORRECTION.md`

Files updated to reflect external service consumption:
- `01-core/PLATFORM_ARCHITECTURE.md`
- `03-security/SECURITY_ARCHITECTURE.md`
- `04-deployment/FRESH_INFRASTRUCTURE_PLAN.md`
- All DNS documentation (mode selection, zone templates, admin panel)

### Related ADRs

- ADR-004: Dex OIDC — decision still valid, deployment moves to infra project
- ADR-013: NetBird — decision still valid, deployment moves to infra project
- ADR-016: PowerDNS Docker Compose — deployment moves to infra project
- ADR-020: AXFR over NetBird — moves to infra project
- ADR-021: NetBird Redundancy — moves to infra project

---

## ADR-023: NGINX Default, Apache Optional — Dual Web Server Support

**Date:** 2026-03-24
**Status:** Accepted
**Deciders:** Platform Architect, User

### Context

Documentation contradicted itself — PLATFORM_ARCHITECTURE.md, WORKLOAD_DEPLOYMENT.md, and HOSTING_PLANS.md described Apache + PHP, while SHARED_POD_IMPLEMENTATION.md (the implementation guide) used NGINX + PHP-FPM throughout.

Additionally, the platform already documents zero-downtime web server switching between Apache and NGINX with automatic .htaccess conversion.

### Decision

**NGINX + PHP-FPM is the default web server** for both shared and dedicated pods. **Apache + PHP-FPM is available as a per-domain option** for clients who need native `.htaccess` support.

**Default (NGINX):**
- Lower memory footprint (~2-5MB per connection vs Apache's 10-25MB) — critical on resource-constrained single-node clusters
- Event-driven concurrency model handles more connections with fixed memory
- Better static file serving performance
- PHP runs as separate PHP-FPM process pools per client (better isolation)
- Server block configs generated by Management API

**Optional (Apache):**
- Native `.htaccess` support for WordPress and legacy PHP applications
- Available per domain via admin/client panel toggle
- Zero-downtime switching between NGINX and Apache per WEB_SERVER_PHP_VERSION_SWITCHING.md
- Apache + PHP-FPM (not mod_php) for consistent isolation model

### Consequences

- SHARED_POD_IMPLEMENTATION.md is already correct (NGINX throughout)
- Container catalog includes both nginx-php-fpm and apache-php-fpm images
- Clients can switch per domain without admin intervention
- Default new deployments use NGINX; Apache must be explicitly selected

---

## ADR-024: Dedicated Workloads Only — Remove Shared Pods, Database as Premium Add-On

**Date:** 2026-03-27
**Status:** ACCEPTED
**Deciders:** Platform Owner

### Context

The original architecture used a **hybrid workload model**: Starter-plan clients shared NGINX+PHP-FPM pods (20-50 clients per pod) with application-level isolation, while Business/Premium clients got dedicated pods with full namespace isolation. Database services (MariaDB, PostgreSQL, Redis) were shared instances with per-client database/user isolation and ProxySQL connection pooling.

This hybrid model optimized for density but introduced significant complexity:

1. **Two provisioning paths** — shared pod assignment vs. dedicated namespace creation
2. **Application-level isolation** for shared pods — PHP-FPM `open_basedir`, `chroot`, `disable_functions`, POSIX permissions, per-client FPM pools, ConfigMap-based VirtualHost management
3. **Explicit security risk acceptance** — a kernel-level container escape in a shared pod would expose all co-tenant clients
4. **ProxySQL connection pooling** — 10:1 multiplexing layer between application pods and shared MariaDB
5. **Redis ACL management** — per-client key prefix restrictions on shared Redis
6. **Complex plan upgrade path** — migrating a client from a shared pod to a dedicated pod required multi-step orchestration (provision new pod → remount PV → remove VirtualHost → update Ingress)
7. **Shared pod rebalancing** — monitoring client density, migrating clients between pools at capacity
8. **Two namespace strategies** — Starter clients in shared `hosting` namespace vs. Business/Premium in `client-{id}` namespaces

Additionally, real-world client data shows that **~90% of clients (45/50) do not use databases at all**. The 5 clients who use databases are already on higher-paying plans. Provisioning shared database infrastructure for all clients is unnecessary overhead.

### Decision

1. **Eliminate shared pods entirely.** Every client — regardless of plan — gets a dedicated pod in their own `client-{id}` namespace with full Kubernetes-native isolation (ResourceQuota, NetworkPolicy, RBAC).

2. **Make database services a premium add-on.** Database (MariaDB) is not included in the base Starter plan. Clients who need a database pay for the add-on, which provisions a dedicated MariaDB StatefulSet (~100-150Mi RAM) in their namespace.

3. **Eliminate ProxySQL, shared Redis ACLs, and shared database user hierarchy.** Each database client gets their own MariaDB instance — no shared connection pooling or multi-tenant database isolation needed.

4. **Plan differentiation shifts to resource limits and features**, not workload isolation model. Starter gets lower CPU/memory limits; Business/Premium get higher limits plus included database and other features.

### Rationale

1. **Complexity reduction.** Removing shared pods eliminates ~60% of the provisioning codebase: VirtualHost generation, PHP-FPM pool management, ConfigMap reload orchestration, shared pod rebalancing, and the dual-path provisioning logic. One provisioning path instead of two.

2. **Security posture.** Every client gets full namespace isolation. The explicit risk acceptance for shared-pod container escape is eliminated. No cross-tenant blast radius.

3. **Operational simplicity.** Plan upgrades become ResourceQuota edits, not multi-step pod migrations. Backup/restore is per-namespace. Monitoring is per-namespace.

4. **Database reality.** With only 5/50 clients using databases, provisioning shared MariaDB + ProxySQL + Redis for all clients wastes resources and adds complexity for a feature most clients don't use. A dedicated MariaDB StatefulSet per database client costs ~100-150Mi RAM each — negligible at 5 instances (~750Mi total).

5. **Resource impact is acceptable.** 50 dedicated web pods at 0.1vCPU/128Mi each = 5vCPU/6.4Gi. Combined with platform overhead (~2vCPU/4Gi), the total fits on 2× CX31 nodes (4vCPU/8Gi, ~$10/month each) = ~$20/month for compute. Well within the <$200/month budget.

6. **Implementation timing.** The shared pod implementation was fully specified but never built (all implementation checklists were unchecked). This decision removes planned complexity before it's coded, not after.

### Consequences

**Positive:**
- Single provisioning path for all clients
- Full namespace isolation for every client (security improvement)
- No shared pod ConfigMap management, FPM pool generation, or VirtualHost orchestration
- Plan upgrades are resource limit changes, not pod migrations
- ProxySQL, shared Redis ACLs, and shared database user hierarchy eliminated
- Simpler backup strategy (per-namespace snapshots)
- Simpler monitoring (per-namespace metrics)

**Negative:**
- Higher per-client resource consumption (~128Mi per web pod vs. near-zero marginal cost in shared pod)
- Starter plan marginal cost increases (dedicated pod vs. shared resource slice)
- More Kubernetes objects to manage (50 namespaces × ~8 objects each vs. 1 shared namespace)
- Database is no longer "included" in all plans — clients who assumed they'd get a database may need education

**Mitigations:**
- Resource overcommit (Burstable QoS, low requests/higher limits) keeps actual node utilization efficient
- Scale-to-zero via KEDA for inactive dedicated pods reduces idle resource consumption
- At 50-100 clients, the k3s API server handles 50-100 namespaces with ease (<500 namespace concern threshold)
- Database add-on provisioning is automated and instant — no manual steps for clients who need it

### Documents Affected

| Document | Change |
|----------|--------|
| `PLATFORM_ARCHITECTURE.md` | Remove shared pod references; update workload model to dedicated-only; update data/storage to reflect DB-as-add-on |
| `HOSTING_PLANS.md` | Remove shared pod workload model; revise plan defaults (all dedicated, DB as add-on); update key differences table |
| `INFRASTRUCTURE_SIZING.md` | Remove `hosting` namespace; all clients get `client-{id}`; revise resource budget and cost estimates |
| `SHARED_POD_IMPLEMENTATION.md` | Mark as **SUPERSEDED** by this ADR (retain as historical reference) |
| `STORAGE_DATABASES.md` | Simplify — remove shared DB user hierarchy, ProxySQL, Redis ACL sections |
| `DATABASE_ACCESS_CONTROL.md` | Simplify — per-client dedicated DB model replaces shared privilege matrix |

### Alternatives Considered

1. **Keep hybrid model (shared + dedicated)** — Maximum cost efficiency, but highest complexity. Rejected because the shared pod was never implemented and the complexity cost outweighs the density benefit at 50-100 client scale.

2. **Dedicated pods, shared database** — Eliminates shared pod complexity but keeps ProxySQL and shared DB user management. Considered viable but rejected because only 5/50 clients use databases — the shared DB infrastructure is wasted on 90% of clients.

3. **Shared database as default, dedicated DB as upgrade** — Middle ground where all clients get a database on a shared instance, with dedicated DB as premium upgrade. Rejected because provisioning shared MariaDB + ProxySQL for 45 clients who don't use databases adds unnecessary infrastructure.

### Related ADRs

- **ADR-001:** Multi-Tenancy via Kubernetes Namespaces — now applies uniformly to all clients, not just Business/Premium
- **ADR-003:** Database Selection — MariaDB remains the primary database engine, but deployment model changes from shared instance to per-client StatefulSet
- **ADR-023:** NGINX Default, Apache Optional — still applies; shared pod references in ADR-023 consequences are superseded

---

## ADR-025: Workload Catalog Sourced from External GitHub Repositories

**Date:** 2026-03-27
**Status:** ACCEPTED
**Deciders:** Platform Owner

### Context

The original architecture assumed workload container images (Dockerfiles, build pipelines, catalog metadata) were maintained **inside this monorepo** under a `catalog-images/` directory, built by an internal CI pipeline, and pushed to Harbor by the platform admin (see PLATFORM_ARCHITECTURE.md Section 2.4, WORKLOAD_DEPLOYMENT.md "Image Build & Maintenance").

This approach tightly couples workload definition maintenance to the platform release cycle:

1. **Slow iteration** — adding or updating a workload image (e.g., PHP 8.5, a new Node.js LTS) requires a commit to the platform repo, a platform CI run, and a platform release
2. **Single maintainer bottleneck** — only platform repo committers can add or update images
3. **Monorepo bloat** — Dockerfiles, test fixtures, and image build tooling add noise to a codebase focused on API, frontend, and infrastructure
4. **No third-party catalogs** — community or vendor-maintained workload sets cannot be consumed without forking

### Decision

**Workload definitions live in external GitHub repositories** ("workload catalog repos"). The platform syncs them on demand and stores the results in the `container_images` table.

**Catalog repository structure:**

```
<repo-root>/
├── catalog.json              # Index: array of workload entries or { workloads: [...] }
├── apache-php84/
│   └── manifest.json         # Per-workload manifest (name, code, image, type, resources, env_vars, tags)
├── nginx-php84/
│   └── manifest.json
├── node22/
│   └── manifest.json
└── ...
```

**Platform behavior:**

1. Admins register workload catalog repos via `POST /api/v1/admin/workload-repos` (GitHub URL, branch, optional auth token, sync interval)
2. The platform fetches `catalog.json` from the repo's raw GitHub URL, then fetches each workload's `manifest.json`
3. Container images are upserted into the `container_images` table with a `source_repo_id` FK back to `workload_repositories`
4. Unique constraint `(code, source_repo_id)` allows the same workload code from different repos without collision
5. An official default catalog (`https://github.com/phoenixtechnam/hosting-platform-workload-catalog`) is pre-registered and can be restored via `POST /api/v1/admin/workload-repos/restore-default`
6. Admins can trigger manual sync via `POST /api/v1/admin/workload-repos/:id/sync`; automatic sync runs on the configured interval

**Database tables:**

- `workload_repositories` — stores registered repos (URL, branch, auth token, sync interval, sync status, last error)
- `container_images` — stores synced workload definitions (code, name, image type, registry URL, manifest URL, resources, env vars, tags); FK `source_repo_id` → `workload_repositories.id`

### Rationale

1. **Decoupled release cycles** — workload image updates (new PHP version, security patch) ship independently of platform releases
2. **Multiple maintainers** — different teams or vendors can maintain their own catalog repos; the platform admin curates which repos to trust
3. **Community catalogs** — third-party or open-source workload sets can be consumed by registering their repo URL
4. **Clean monorepo** — the platform repo focuses on API, frontend, infrastructure, and k8s manifests; no Dockerfiles or image build tooling
5. **Proven pattern** — similar to Helm chart repositories, Homebrew taps, and VS Code extension registries

### Consequences

**Positive:**
- Platform repo stays focused; workload definitions evolve independently
- Adding a new workload type is a PR to the catalog repo, not the platform repo
- Multiple catalog repos can coexist (e.g., official + custom client-specific)
- Sync status and errors are visible in the admin panel

**Negative:**
- External dependency on GitHub raw content API for sync (mitigated by caching synced data in DB)
- Auth token management required for private repos
- Catalog format (`catalog.json` + `manifest.json`) is a custom convention that must be documented
- Sync failures are not immediately visible to clients (only to admins)

**Neutral:**
- The `catalog-images/` directory referenced in PHASE_1_ROADMAP.md is superseded — Dockerfiles live in the external catalog repo
- Image build and push to registry still happens in the catalog repo's own CI, not in the platform CI
- The admin panel container lifecycle management (enable/disable/deprecate/force-migrate) remains unchanged — it operates on `container_images` rows regardless of source

### Related ADRs

- **ADR-022:** Architectural Separation — established the pattern of consuming external services via API; this ADR extends the same pattern to workload definitions
- **ADR-023:** NGINX Default, Apache Optional — catalog repos include both `nginx-php*` and `apache-php*` workload manifests
- **ADR-024:** Dedicated Workloads Only — all clients get dedicated pods running images sourced from catalog repos

---

## ADR-026: Workloads vs Applications — Two Catalog Architecture

**Date:** 2026-03-28
**Status:** ACCEPTED
**Deciders:** Platform Owner

### Context

The platform needs to support two fundamentally different deployment models:

1. **Composable environments** — A client assembles their own stack: picks a PHP runtime, adds a database, uploads their files via SFTP/Git Deploy, and manages their own application (e.g., installs WordPress manually, connects it to the database, manages plugins). This is the traditional hosting model (cPanel/Plesk).

2. **Managed application stacks** — A client clicks "Install Nextcloud" and gets a fully configured, multi-container application with its own database, cache, cron jobs, and ingress. No manual setup required.

These models have conflicting requirements:

- Composable environments need **shared services** — one MariaDB instance serving multiple workloads (a PHP app and a Node.js API sharing the same database). The platform must manage database lifecycle, credential injection, and cross-workload bindings.
- Managed applications need **isolated stacks** — Nextcloud bundles its own MariaDB and Redis. Deleting Nextcloud removes everything cleanly. No sharing with other apps.

An earlier proposal to unify both models into Helm charts was rejected because Helm releases are isolated — they have no cross-release awareness for shared databases, credential injection, or multi-workload bindings.

Additionally, a `wordpress-php84` entry existed in the Workload Catalog as a pre-installed WordPress image. This was a hybrid that fit neither model well: it wasn't a clean runtime (had WordPress baked in, couldn't be used for Laravel) and it wasn't a managed app (no auto-DB setup, no WP-CLI integration).

### Decision

**Two separate catalogs with different deployment mechanisms:**

**1. Workload Catalog** — Composable building blocks

- **Contents:** Runtimes (`nginx-php84`, `node22`, `static-nginx`), Databases (`mariadb-106`, `postgresql-16`), Services (`redis-7`)
- **Repository:** `hosting-platform-workload-catalog` (manifest.json per entry, validated by JSON Schema)
- **Deployment:** Platform generates Kubernetes manifests (Deployment/StatefulSet, Service, PVC, Ingress, Secrets) from manifest fields
- **Database model:** Shared — platform manages MariaDB/PostgreSQL instances, creates databases and users, injects credentials into workloads via `services.database.env_mapping`
- **Target user:** Developer, agency, power user who manages their own software
- **Platform tables:** `container_images` + `workloads` + `databases`
- **Sync:** `POST /api/v1/admin/workload-repos/:id/sync`

**2. Application Catalog** — Self-contained managed stacks

- **Contents:** WordPress, Nextcloud, Jitsi, Moodle, Gitea, Matomo, Keycloak, etc.
- **Repository:** `hosting-platform-application-catalog` (manifest.json + Helm chart per entry)
- **Deployment:** `helm install` with values derived from admin-configurable parameters
- **Database model:** Bundled — each application chart includes its own database StatefulSet
- **Target user:** Non-technical client who wants a working app with zero setup
- **Platform tables:** `application_catalog` + `application_instances`
- **Sync:** `POST /api/v1/admin/application-repos/:id/sync`

**3. Remove `wordpress-php84` from Workload Catalog**

WordPress is a managed application, not a generic runtime. It belongs in the Application Catalog where it can auto-provision its database, configure wp-config.php, and offer one-click updates via WP-CLI. The Workload Catalog retains `apache-php84` as the generic PHP runtime that clients can use to manually install any PHP application including WordPress.

### Rationale

1. **Shared database support** — A client running a PHP site and a Node.js API on the same database is only possible when the platform controls database lifecycle and credential injection. Helm charts are release-isolated and cannot share databases across releases.

2. **Clean separation of concerns** — Workloads are infrastructure building blocks; applications are complete products. Different deployment mechanisms (platform-generated manifests vs. Helm) match the different abstraction levels.

3. **Different update models** — Workload runtimes update via image tag changes (security patches). Applications update via Helm chart version bumps that may include database migrations, config changes, and multi-container coordination.

4. **Different target users** — Power users want composability and control. Non-technical users want one-click deploys. Forcing both through the same mechanism serves neither well.

5. **WordPress clarity** — `wordpress-php84` as a workload was confusing: it pre-installed WordPress into the image, but the client still had to set up the database manually. As a managed application, WordPress auto-provisions everything and provides a better experience.

### Consequences

**Positive:**
- Clear mental model: "Workloads = I build my stack" vs. "Applications = I install a product"
- Platform can manage shared databases, cross-workload bindings, and credential rotation for workloads
- Helm handles the complexity of multi-container application lifecycle (upgrades, rollbacks, hooks)
- Each catalog can evolve independently with its own release cycle
- Client panel can present two distinct UX sections: "My Environment" (workloads) and "My Applications"

**Negative:**
- Two deployment mechanisms to build and maintain (platform manifest generator + Helm integration)
- Two catalog repositories with different sync logic
- Some overlap: a client could run WordPress both ways (manual install on `apache-php84` workload, or managed via Application Catalog)

**Neutral:**
- The `application_catalog` and `application_instances` tables already exist in the database schema
- The `container_images` table continues to store workload definitions synced from the workload catalog
- `wordpress-php84` removed from workload catalog; WordPress will be added to Application Catalog in a future phase

### Documents Affected

| Document | Change |
|----------|--------|
| `PLATFORM_ARCHITECTURE.md` Section 2 | Clarify workloads are composable runtimes/databases/services only |
| `PLATFORM_ARCHITECTURE.md` Section 3 | Clarify applications are Helm-deployed managed stacks |
| `WORKLOAD_DEPLOYMENT.md` | Remove WordPress references; clarify workloads are generic runtimes |
| `ADMIN_PANEL_REQUIREMENTS.md` | Distinguish workload management (W.0-W.2) from application management |
| Workload catalog repo | Remove `wordpress-php84`; update README and catalog.json |

### Related ADRs

- **ADR-024:** Dedicated Workloads Only — every client gets a namespace; workloads and applications both deploy into `client-{id}` namespaces
- **ADR-025:** Workload Catalog in External Repos — established the manifest.json sync pattern for workloads; the same pattern extends to application catalog repos

---

## ADR-027: OAuth2-Proxy Scope — Platform Panels Only

See [ADR-027-OAUTH2-PROXY-SCOPE.md](ADR-027-OAUTH2-PROXY-SCOPE.md).

---

## ADR-028: Backup Architecture — Component Model, Tiered Initiators, Multi-Target Storage

See [ADR-028-backup-architecture.md](ADR-028-backup-architecture.md).

Summary: A backup is a component-oriented directory (`files`, `mailboxes`,
`config`, `secrets`) on one of three mandatory storage backends
(`hostpath`, `s3`, `ssh`). Four initiators (`client`, `admin`, `system`,
`cluster`) share the same bundle format; ACL is driven by a
`meta.json.initiator` field. Per-database logical dumps are dropped (DB
datadir lives on the tenant PVC). Mailbox restore granularity is whole
mailbox with replace semantics. Per-file restore is supported via a
`tree.jsonl.gz` index sidecar. Cluster-wide DR is deferred to Velero.

### Related Docs

- `docs/06-features/BACKUP_COMPONENT_MODEL.md` — canonical bundle spec
- `docs/02-operations/BACKUP_STRATEGY.md` — three-tier strategy
- `docs/02-operations/BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md` — capture pipelines
- `docs/06-features/RESTORE_SPECIFICATION.md` — restore API + granularity

---

## References

- ADR Format: https://adr.github.io/
- Example ADRs: https://github.com/joelparkerhenderson/architecture_decision_record
- AWS Architecture Patterns: https://aws.amazon.com/architecture/
- CQRS & Event Sourcing: https://martinfowler.com/bliki/CQRS.html
