# Dependencies & Risk Management

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** Architecture & Program Management Team

## Overview

This document maps component dependencies and identifies risks that could impact Phase 1 delivery. Mitigation strategies ensure success.

---

## Component Dependency Map

```
┌─────────────────────────────────────────────────────────────────┐
│                  API Gateway / DNS-Based Ingress                │
│          (NGINX Ingress Controller — DaemonSet per worker)      │
└───────────────┬──────────────────────────────────────┬──────────┘
                │                                      │
                v                                      v
        ┌─────────────────┐              ┌──────────────────────┐
        │   Admin Panel   │              │   Management API     │
        │   (React 18+)   │              │   (Node.js Fastify)  │
        └────────┬────────┘              └────────┬─────────────┘
                 │                               │
                 ├───────────────────────┬───────┘
                 │                       │
                 v                       v
        ┌─────────────────────────────────────────┐
        │         Authentication Layer            │
        │  (Dex OIDC + Google/GitHub/Apple)      │
        │  (JWT tokens + Sealed Secrets)         │
        └────────┬────────────────────────────────┘
                 │
    ┌────────────┴────────────────────────┐
    │                                     │
    v                                     v
┌─────────────────┐          ┌──────────────────────┐
│  MariaDB 10.6      │          │  PostgreSQL 16       │
│  (Clients,      │          │  (Analytics,         │
│   workloads,    │          │   audit logs,        │
│   domains)      │          │   full-text search)  │
└────────┬────────┘          └──────────┬───────────┘
         │                              │
         └──────────────┬───────────────┘
                        │
        ┌───────────────┴──────────────┐
        │                              │
        v                              v
    ┌────────┐              ┌──────────────────┐
    │  Redis │              │  Sealed Secrets  │
    │(cache) │              │  (Credentials)   │
    └────────┘              └──────────────────┘
        │                              │
        └──────────────┬───────────────┘
                       │
       ┌───────────────┴──────────────────┐
       │                                  │
       v                                  v
┌───────────────────┐        ┌──────────────────────┐
│  Kubernetes       │        │  Storage Layer       │
│  (k3s cluster)    │        │  Longhorn            │
│  CoreDNS          │        │  (block storage)     │
│  Flannel (CNI, k3s default)│        │                      │
└───────┬───────────┘        └──────────┬───────────┘
        │                              │
        └──────────────┬───────────────┘
                       │
    ┌──────────────────┼──────────────────┐
    │                  │                  │
    v                  v                  v
┌──────────┐  ┌─────────────────┐  ┌────────────┐
│Container │  │Docker-Mailserver│  │ PowerDNS   │
│Registry  │  │(email service)  │  │(DNS mgmt)  │
│ (Harbor) │  │                 │  │            │
└──────────┘  └─────────────────┘  └────────────┘
    │                  │                  │
    └──────────────────┼──────────────────┘
                       │
    ┌──────────────────┴───────────────┐
    │                                  │
    v                                  v
┌───────────────────────┐  ┌──────────────────────┐
│ Observability Stack   │  │  CI/CD Pipeline      │
│ Prometheus + Grafana  │  │  (GitHub Actions)    │
│ Loki (logs)           │  │  (Flux v2 GitOps)    │
└───────────────────────┘  └──────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                External Infrastructure (2 VPS + Home)                 │
│                                                                      │
│  VPS 1 (ns1 — Falkenstein)        VPS 2 (ns2 — Helsinki)            │
│  ├── PowerDNS PRIMARY             ├── PowerDNS SECONDARY             │
│  ├── NetBird PRIMARY              ├── NetBird SECONDARY              │
│  └── PostgreSQL (zones+state)     └── PostgreSQL (replica)           │
│                                                                      │
│  Home Server (tertiary)                                              │
│  └── NetBird Signal + TURN (fallback)                                │
│                                                                      │
│  DNS: port 53 public | PowerDNS API: mesh only | Admin SSH: mesh only│
└──────────────────────────────────────────────────────────────────────┘
```

---

## Critical Path Dependencies

### Database Readiness (Critical)
**Risk Level:** MEDIUM  
**Impact:** BLOCKING

Chain: Code → Migrations → Database Schema → API Tests → Deployment

```timeline
Week 1: Database schema finalized ✓ (DATABASE_SCHEMA.md)
Week 2: Migrations implemented
Week 2: Sample data seeded
Week 3: API integration tests passing
```

**Mitigation:**
- Schema finalized before coding starts
- Use Flyway for automated migrations
- Test migrations with production-like data volumes

### Kubernetes Cluster (Critical)
**Risk Level:** LOW  
**Impact:** BLOCKING

```timeline
Week -1: k3s cluster provisioned
         Longhorn storage configured
          Flannel networking ready (k3s default)
Week 1: Storage classes tested
        Network policies working
```

**Mitigation:**
- Use provided k3s installation script
- Pre-prod cluster for testing
- Backup/restore validation

### Authentication System (Critical)
**Risk Level:** MEDIUM  
**Impact:** BLOCKING

```timeline
Week 2: Dex deployed to cluster
Week 3: JWT token generation working
Week 3: Frontend login flow integrated
```

**Mitigation:**
- Simple OIDC implementation first (Google only)
- Support passwordless as Phase 1.5
- Emergency fallback: temporary password reset

### API Pagination & Error Handling (Critical)
**Risk Level:** LOW  
**Impact:** BLOCKING for frontend

```timeline
Week 1: Pagination standardized (API_PAGINATION_STRATEGY.md)
Week 1: Error handling finalized (API_ERROR_HANDLING.md)
Week 2: All endpoints follow standards
```

**Mitigation:**
- Decision made (documentation complete)
- Code templates provided
- Code review checklist enforces standards

---

## Risk Register

### 1. Database Query Performance

**Risk:** Slow queries on large datasets (audit logs, usage metrics)

| Aspect | Detail |
| --- | --- |
| **Probability** | MEDIUM (80%+ of performance issues are database) |
| **Impact** | HIGH (SLO miss, 99.5% availability target) |
| **Detection** | p95 latency > 500ms in monitoring |
| **Mitigation** | Index strategy (DATABASE_SCHEMA.md), query optimization, caching (CACHING_STRATEGY.md) |
| **Contingency** | Denormalization, read replicas, query result caching |

### 2. Kubernetes API Server Overload

**Risk:** Too many namespaces/resources cause API server slowness

| Aspect | Detail |
| --- | --- |
| **Probability** | LOW (issue at 500+ namespaces, Phase 1 has < 50) |
| **Impact** | HIGH (deployments fail, scaling stops) |
| **Detection** | API server response time > 1s, kubectl slow |
| **Mitigation** | Monitor etcd size, ETCD backup size tracking |
| **Contingency** | Horizontal scaling of control plane (Phase 2+) |

### 3. Redis Failure (Cache Loss)

**Risk:** Redis becomes unavailable, cache lost, database overloaded

| Aspect | Detail |
| --- | --- |
| **Probability** | MEDIUM (hardware failure, container restart) |
| **Impact** | MEDIUM (degraded performance, not critical) |
| **Detection** | Cache hit ratio drops from 80% to 0% |
| **Mitigation** | Redis replication, persistent volume backup |
| **Contingency** | Graceful degradation (work without cache), fast recovery |

### 4. Database Replication Lag (Phase 2)

**Risk:** Multi-region replication delays cause data consistency issues

| Aspect | Detail |
| --- | --- |
| **Probability** | MEDIUM (network latency, high write volume) |
| **Impact** | MEDIUM (eventual consistency is acceptable) |
| **Detection** | Replication lag > 10 seconds |
| **Mitigation** | One primary writer, eventual consistency model |
| **Contingency** | Read from primary for critical data, strong consistency where needed |

### 5. Sealed Secrets Key Loss

**Risk:** Sealing key backup lost, can't decrypt secrets on recovery

| Aspect | Detail |
| --- | --- |
| **Probability** | LOW (deliberate backup/disaster recovery flaw) |
| **Impact** | CRITICAL (cluster unrecoverable without manual intervention) |
| **Detection** | Disaster recovery test fails |
| **Mitigation** | Daily backup, offline storage, quarterly DR test |
| **Contingency** | Recreate all secrets manually (manual recovery) |

### 6. Docker Hub Rate Limiting

**Risk:** Pull images from Docker Hub during peak hours, rate limited

| Aspect | Detail |
| --- | --- |
| **Probability** | MEDIUM (shared rate limit across all users) |
| **Impact** | MEDIUM (pod startup delays, deployment slow) |
| **Detection** | Image pull errors "429 Too Many Requests" |
| **Mitigation** | Use Harbor registry (ADR-002) for local caching |
| **Contingency** | Configure image pull secrets, implement backoff |

### 7. OIDC Provider Outage (Google/GitHub)

**Risk:** External OIDC provider unavailable, users can't login

| Aspect | Detail |
| --- | --- |
| **Probability** | LOW (Google/GitHub > 99.9% uptime) |
| **Impact** | HIGH (critical feature, affects all users) |
| **Detection** | Login fails with provider error |
| **Mitigation** | Support multiple providers (Google + GitHub + custom), offline token support |
| **Contingency** | Temporary password reset via admin panel, local Dex only |

### 8. Certificate Expiry

**Risk:** TLS certificate expires, HTTPS breaks

| Aspect | Detail |
| --- | --- |
| **Probability** | LOW (cert-manager automates renewal) |
| **Impact** | CRITICAL (API becomes unreachable) |
| **Detection** | Browser/SSL alert 14 days before expiry |
| **Mitigation** | cert-manager, monitoring alerts (14 days before), weekly email |
| **Contingency** | Emergency manual renewal, graceful degradation to HTTP (not recommended) |

### 9. Kubernetes Cluster Failure

**Risk:** Node failure, etcd corruption, cluster becomes unavailable

| Aspect | Detail |
| --- | --- |
| **Probability** | MEDIUM (hardware failure, software bugs) |
| **Impact** | Depends on HA stage (see below) |
| **Detection** | Nodes become NotReady, pods fail to schedule |
| **Mitigation** | HA control plane (3 master nodes), multi-node worker pool, etcd backup |
| **Contingency** | Cluster rebuild from backup (30 minutes RTO) |

**Impact by HA stage** (see `HA_MIGRATION_RUNBOOK.md`):

| Stage | Single node failure impact | RTO | Data loss risk |
| --- | --- | --- | --- |
| **0** (1 node) | Complete outage — rebuild from backup | 30-60 min | Up to 24h (last backup) |
| **1** (CP + Worker) | CP down: no management, traffic continues. Worker down: full outage. | 5-30 min | Worker: up to 24h |
| **2** (CP + 2 Workers) | Worker down: pods reschedule, Longhorn serves replica. 60-90s disruption. | 60-90 sec | Zero (Longhorn replica) |
| **3** (3 CP + 2 Workers) | Any node: zero downtime, zero data loss | 0 | Zero |
| **4** (Stage 3 + DB HA) | Any node + DB pod failure: zero downtime | 0 | Zero |

### 10. Audit Log Storage Exhausted

**Risk:** Audit logs grow unbounded, disk fills up, system fails

| Aspect | Detail |
| --- | --- |
| **Probability** | MEDIUM (7-year retention is large) |
| **Impact** | MEDIUM (database performance degrades, inserts slow) |
| **Detection** | Database disk usage > 80% capacity |
| **Mitigation** | Partitioning (DATABASE_SCHEMA.md), archival to offsite server after 90 days |
| **Contingency** | Emergency cleanup of old logs, database optimization |

### 11. Frontend Bundle Size

**Risk:** React app too large (> 1MB), slow load times

| Aspect | Detail |
| --- | --- |
| **Probability** | HIGH (React + Tailwind + dependencies) |
| **Impact** | MEDIUM (poor UX, especially on mobile/slow connections) |
| **Detection** | Bundle size > 500KB, LCP > 3 seconds |
| **Mitigation** | Code splitting, lazy loading, tree-shaking, minification |
| **Contingency** | Deferring non-critical features to Phase 2 |

### 12. NetBird VPN Infrastructure Failure

**Risk:** NetBird management/signal/relay servers unavailable, admin can't establish new mesh connections

| Aspect | Detail |
| --- | --- |
| **Probability** | LOW (redundant deployment: Hetzner primary + home secondary) |
| **Impact** | MEDIUM (existing WireGuard P2P tunnels survive; only new connections affected) |
| **Detection** | NetBird dashboard unreachable, `netbird status` shows disconnected on admin workstation |
| **Mitigation** | Dual Signal + TURN servers (agents auto-failover). Management standby on home server. Pre-authenticated setup keys bypass OIDC. |
| **Contingency** | If all NetBird infra down: temporarily open SSH port on Hetzner Cloud Console, SSH directly, restore NetBird, close port. |

### 13. API Endpoint Explosion

**Risk:** 175+ features → 100+ API endpoints, hard to maintain

| Aspect | Detail |
| --- | --- |
| **Probability** | HIGH (natural for large platform) |
| **Impact** | MEDIUM (slower development, more bugs) |
| **Detection** | API tests take > 5 minutes, endpoint documentation outdated |
| **Mitigation** | OpenAPI generation (MANAGEMENT_API_SPEC.md), code generation tools |
| **Contingency** | Focus Phase 1 on core 60 features, defer advanced to Phase 2 |

---

## Risk Mitigation Timeline

```
Pre-Phase 1 (Week 0):
  ✓ Review ADRs and dependencies (this document)
  ✓ Identify architecture gaps
  ✓ Provision k3s cluster
  ✓ Set up storage (Longhorn) and networking (Flannel)
  ✓ Database schema finalized

Week 1-3 (First sprint):
  □ Database migrations working
  □ Authentication (Dex) operational
  □ API pagination/error handling standardized
  □ Core API endpoints (30% of Phase 1)
  □ Critical paths working

Week 4-6:
  □ Database performance tested (query optimization)
  □ Caching strategy validated
  □ Frontend scaffold with auth integration
  □ More API endpoints (60% of Phase 1)

Week 7-10:
  □ Admin panel features (40% complete)
  □ Monitoring/alerting (Prometheus/Grafana)
  □ Load testing begins
  □ Risk review #2

Week 11-13:
  □ Final features (remaining 40%)
  □ Performance optimization
  □ Security hardening
  □ Disaster recovery drill
  □ Final risk review
```

---

## Dependencies on External Services

### Google OIDC

**Risk:** Service unavailable, account issues  
**Mitigation:** Fallback to GitHub + custom OIDC  
**Monitoring:** Login success rate per provider  
**Contingency:** Email-based password reset

### GitHub (Source Code, Actions)

**Risk:** Service outage (rare), API rate limiting  
**Mitigation:** GitHub Enterprise with SLA (future), local Gitea (Phase 2)  
**Monitoring:** CI/CD pipeline success rate  
**Contingency:** Manual deployment from local Git

### Stripe/Chargebee (Billing)

**Risk:** Service outage, webhook delays  
**Mitigation:** Webhook retries, scheduled reconciliation  
**Monitoring:** Billing sync success rate  
**Contingency:** Manual invoice issuance, grace period for failed payments

### Email Service (Docker-Mailserver)

**Risk:** Self-hosted, disk full, network issues  
**Mitigation:** Monitoring disk usage, queue emails  
**Monitoring:** Email delivery success rate  
**Contingency:** Graceful retry, admin notification of failures

### PowerDNS (DNS — 2 VPS: ns1 Falkenstein + ns2 Helsinki)

**Risk:** VPS failure, misconfiguration, zone sync failure  
**Mitigation:** Two geographically diversified servers (Falkenstein + Helsinki). Primary/secondary AXFR replication. Either server can serve DNS independently.  
**Monitoring:** DNS query success rate per server, AXFR sync lag, zone serial mismatch alerts  
**Contingency:** If both VPS fail: update customer domain registrar NS records to a temporary external DNS provider (Cloudflare secondary via AXFR). If primary (ns1) fails: ns2 serves all queries; new zone creation waits for ns1 recovery.

### NetBird (Admin VPN)

**Risk:** Self-hosted, management server failure, Signal/TURN outage  
**Mitigation:** Redundant deployment (Hetzner primary + home secondary). Dual Signal + TURN servers with automatic agent failover. WireGuard P2P tunnels persist without server.  
**Monitoring:** NetBird management API health check, Signal server reachability, peer connection count  
**Contingency:** Pre-authenticated setup keys (bypass OIDC). Temporary public SSH via Hetzner Cloud Console as last resort.

---

## Dependency Check

Before Phase 1 starts, verify:

```yaml
✓ Kubernetes:
  - k3s version 1.25+
  - Longhorn storage working
  - Flannel networking active (k3s default, Calico upgrade path)
  - Ingress controller (NGINX Ingress) ready (k3s Traefik disabled via --disable traefik)
  - Default storage class set

✓ Databases:
  - MariaDB 10.6 initialized
  - PostgreSQL 16 initialized
  - Replication tested (MariaDB → MariaDB, if multi-region)
  - Backup tested
  - Connection pooling configured

✓ Authentication:
  - Dex deployed
  - Google/GitHub OAuth apps created
  - Sealed Secrets controller running
  - JWT signing key generated

✓ Storage:
  - Harbor registry deployed, tested
  - Longhorn PVC working
  - Offsite backup server accessible via SSHFS

✓ Monitoring:
  - Prometheus scraping metrics
  - Grafana dashboards accessible
  - Loki receiving logs
  - Alerting rules loaded

✓ CI/CD:
  - GitHub Actions runners available
  - Flux v2 deployed
  - Git webhook configured
  - Container scanning (Trivy) enabled

✓ External Infrastructure (DNS + Admin VPN):
  - VPS 1 (ns1.platform.com, Falkenstein): PowerDNS primary + NetBird primary deployed
  - VPS 2 (ns2.platform.com, Helsinki): PowerDNS secondary + NetBird secondary deployed
  - Home server: NetBird tertiary (Signal + TURN fallback)
  - PowerDNS AXFR replication verified (zone serial match)
  - PowerDNS API accessible from k3s cluster via NetBird mesh
  - Glue records registered at domain registrar (ns1 + ns2 IPs)
  - NetBird agent installed on all cluster nodes + admin workstations
  - OIDC integration with Dex configured
  - Pre-authenticated setup keys generated and stored offline
  - Public SSH (22) and K8s API (6443) closed on cluster node firewalls
  - WireGuard port (51820/UDP) open on all mesh participants
  - DNS port (53 TCP+UDP) open on both VPS

✓ Development Environment:
  - Node.js 18 LTS
  - Docker/container runtime
  - kubectl configured (via NetBird mesh)
  - Helm installed
  - k6 for load testing
```

---

## Escalation Path for Risks

```
Risk Level    Alert Threshold    Owner           Action
─────────────────────────────────────────────────────────
CRITICAL      Immediate          Tech Lead       Page on-call
HIGH          Within 4 hours      Engineering Mgr  Priority fix
MEDIUM        Within 24 hours     Team Lead       Schedule fix
LOW           Backlog             Team            Next sprint
```

---

## Quarterly Risk Review

Every 3 months:

1. **Reassess probabilities** - What changed?
2. **Update mitigations** - Still valid?
3. **Identify new risks** - What emerged?
4. **Review contingencies** - Still achievable?
5. **Lessons learned** - From incidents
6. **Update documentation** - Keep current

---

## Checklist

- [ ] All dependencies documented in component map
- [ ] Critical path identified and scheduled
- [ ] Risk register reviewed with team
- [ ] Mitigation strategies understood by owners
- [ ] Contingency procedures documented
- [ ] External service dependencies assessed
- [ ] Disaster recovery procedures in place
- [ ] Monitoring configured for all critical paths
- [ ] Team trained on incident response
- [ ] Quarterly review scheduled

---

## References

- Risk Management ISO 31000: https://www.iso.org/iso-31000-risk-management.html
- SRE Workbook - Risk Management: https://sre.google/books/
- Kubernetes Failure Scenarios: https://kubernetes.io/docs/tasks/run-application/run-replicated-stateful-application/
