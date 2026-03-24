# Monitoring & Observability

## Observability Stack

The platform implements a complete observability system for metrics, logs, dashboards, and alerting.

| Pillar | Tool | Purpose |
| --- | --- | --- |
| **Metrics** | **Prometheus** (via kube-prometheus-stack) | Cluster, node, pod, and app metrics |
| **Logs** | **Loki** + **Promtail** | Centralized log aggregation |
| **Dashboards** | **Grafana** | Platform ops + per-client dashboards |
| **Alerting** | **Alertmanager** | Integrated with Prometheus |
| **Traces** | **Tempo** (Phase 2 — planned post-MVP) | Low resource usage, Loki integration, deferred for Phase 2 |

## What Gets Monitored

### System & Infrastructure

| Category | Metrics / Signals |
| --- | --- |
| **Cluster health** | Node status, CPU/mem/disk per node, pod restarts, OOM kills |
| **Ingress** | Request rate, error rate (4xx/5xx), latency per host, TLS cert expiry |
| **Storage** | PVC utilization, Longhorn replication lag, backup size |

### Per-Client & Workload

| Category | Metrics / Signals |
| --- | --- |
| **Per-client** | CPU/mem usage vs. quota, storage usage, HTTP errors, response time |
| **Shared databases** | Connections per client, query latency, replication lag, total storage |
| **Shared Redis** | Total memory used vs. `maxmemory` (alert at >80%), eviction rate (alert if non-zero sustained), hit/miss ratio, connections per client prefix, key count per prefix (alert if any prefix >10,000 keys — indicates misbehaving client) |
| **Catalog images** | Clients per image version, deprecated image usage count |
| **Scale-to-zero** | Cold start latency, idle client count, wake-up success rate |

### Security & Operations

| Category | Metrics / Signals |
| --- | --- |
| **Email** | Queue length, delivery success/failure, spam score |
| **Security** | fail2ban triggers, WAF blocks, auth failures, suspicious patterns |
| **Admin VPN (NetBird)** | Mesh peer count, management API reachability (external service health check) |
| **DNS (PowerDNS)** | External API reachability, zone operation success rate, query latency (via external API health endpoint) |
| **Backups** | Last successful backup time, backup size, restore test results |
| **Certificates** | Days until expiry, renewal failures |

## Alerting

| Parameter | Value |
| --- | --- |
| Alerting tool | Alertmanager (with Prometheus rules) |
| Notification channels | **Email + SMS** (PagerDuty integration in Phase 2) |
| Critical alerts | Node down, cluster unhealthy, shared DB down, backup failure, cert expiry < 7d, disk > 90%, external PowerDNS API unreachable, external OIDC provider unreachable |
| Warning alerts | Client near quota, high error rate, deprecated image still in use, DB connection saturation |
| On-call support | **Business hours only (MVP)** — no 24/7 on-call initially |
| Escalation policy | **Single level: immediately page primary engineer** (direct escalation, minimal delay) |

### External Service Health Checks (ADR-022)

The platform depends on three external services. The Management API must implement health checks and graceful degradation for each.

| External Service | Health Check | Degradation Behavior | Alert |
|-----------------|-------------|---------------------|-------|
| **PowerDNS API** | `GET /api/v1/servers/localhost` every 60s | DNS zone/record operations queued; existing domains continue working | `ExternalDNSAPIUnreachable` (CRITICAL after 5 min) |
| **OIDC Provider** | Fetch `/.well-known/openid-configuration` every 60s | Existing valid tokens continue working; new logins fail; JWKS cache used (1hr TTL) | `ExternalOIDCUnreachable` (CRITICAL after 5 min) |
| **NetBird Mesh** | Ping management API every 60s (if configured) | Admin access unaffected if mesh peers are cached; new peer enrollment fails | `ExternalNetBirdUnreachable` (WARNING after 5 min) |

**Circuit breaker pattern:** After 3 consecutive failures, mark the external service as "degraded" in the admin panel health dashboard. Queue non-critical operations (DNS record updates, new domain provisioning). Continue serving existing traffic. Alert the admin. Resume automatically when health check passes.

## SLOs & SLIs

The platform commits to specific availability and performance targets:

| Service | SLI (Indicator) | SLO (Objective) | Error Budget (per month) |
| --- | --- | --- | --- |
| Client web hosting | Availability (uptime) | **99.5%** (~4.3 hours downtime) | 3.6 hours |
| Client web hosting | Latency (p95) | **< 1000ms** (relaxed, admin tools acceptable) | N/A |
| Management panel | Availability | **99.5%** (~4.3 hours downtime) | 3.6 hours |
| Shared MariaDB | Availability | **99.5%** (no HA initially; upgrade later) | 3.6 hours |
| Shared PostgreSQL | Availability | **99.5%** (no HA initially; upgrade later) | 3.6 hours |
| Email delivery | Delivery success rate | **99%** (acceptable, some mail loss tolerated) | 4.3 hours equivalent |
| DNS resolution | Query success rate | **99.5%** (external PowerDNS) | 3.6 hours |

## Log Retention

| Environment / Source | Retention Period |
| --- | --- |
| Client access logs | 30 days |
| Platform service logs | 90 days |
| Security / audit logs | 1 year |
| Backup logs | 90 days |

## Client-Facing Metrics

Clients see basic metrics in their control panel:

- **Bandwidth usage** (monthly)
- **Storage usage** (files + DB)
- **CPU / memory utilization** vs. plan limits
- **Recent HTTP error rates**
- **Last backup timestamp**
- **Current container image version** (with upgrade available indicator)

## Notification System

The management panel sends configurable email notifications to admins and clients for all relevant events.

### Architecture

| Component | Description |
| --- | --- |
| **Notification Service** | Platform microservice that processes events and dispatches emails |
| **Event bus** | Internal event stream — all platform services emit events (K8s events, API actions, metric thresholds) |
| **Template engine** | Renders email content from configurable templates (subject, body, variables) |
| **SMTP delivery** | Sends via platform mail stack (Docker-Mailserver) or external SMTP relay (SendGrid, Mailgun, etc.) |
| **Notification log** | All sent notifications logged in DB for audit trail |
| **Digest mode** | Option to batch low-priority notifications into a daily/weekly digest instead of individual emails |

### Event Categories

Every event can be **individually enabled/disabled** per recipient in the admin panel.

**Client Account Events:**
- `client.created` — New client account provisioned
- `client.deleted` — Client account removed
- `client.plan_changed` — Client switched plans or overrides changed
- `client.plan_expiry_warning` — Plan expiry approaching (configurable: 30/14/7/1 days before)
- `client.plan_expired` — Plan has expired
- `client.suspended` — Client account suspended (non-payment, abuse, etc.)
- `client.reactivated` — Client account reactivated after suspension
- `client.login` — Client logged into management panel (optional)
- `client.password_reset` — OIDC password/account recovery triggered

**Resource & Quota Events:**
- `resource.storage_warning` — Storage usage approaching limit (configurable: 80%/90%/95%)
- `resource.storage_full` — Storage at 100% — writes may fail
- `resource.cpu_sustained` — CPU usage sustained above limit
- `resource.memory_sustained` — Memory usage sustained above limit
- `resource.db_storage_warning` — Database storage approaching limit
- `resource.db_connections_high` — Database connections near max for client
- `resource.bandwidth_warning` — Monthly bandwidth approaching limit (if metered)
- `resource.bandwidth_exceeded` — Monthly bandwidth limit exceeded

**Email Sending Events:**
- `email.sending_limit_warning` — Client approaching daily/hourly email sending limit
- `email.sending_limit_reached` — Client hit email sending limit
- `email.bounce_rate_high` — Bounce rate exceeds threshold
- `email.spam_report` — Client's emails flagged as spam
- `email.queue_stalled` — Mail queue not draining (system-wide)
- `email.blacklist_detected` — Server IP detected on email blacklist

**Security Events:**
- `security.fail2ban_ban` — IP banned by fail2ban (any layer)
- `security.brute_force` — Brute force attack detected
- `security.waf_block` — WAF blocked a malicious request
- `security.waf_attack_surge` — WAF blocks exceed threshold (possible attack)
- `security.unauthorized_access` — Unauthorized API call or kubectl access attempt
- `security.client_compromise` — Suspected client site compromise (malware, defacement)
- `security.ssl_cert_expiry` — TLS certificate expiring within 7 days (renewal failed)

**System & Infrastructure Events:**
- `system.node_down` — K8s node unreachable
- `system.node_disk_pressure` — Node disk usage > 85%
- `system.pod_crash_loop` — Platform service pod in CrashLoopBackOff

## Grafana Dashboards

**Platform Operations Dashboards:**
- Cluster health (nodes, pods, resources)
- Ingress and routing (request rates, errors, latency)
- Database health (connections, storage, query performance)
- Email queue and delivery stats
- Backup status and sizes
- Storage utilization and growth trends

**Per-Client Dashboards:**
- Client resource usage (CPU, memory, storage)
- Client HTTP traffic (requests, errors, latency)
- Client backup history
- Email account usage and sending limits

## Metrics Retention

- **Local Prometheus:** 15 days (configurable)
- **Long-term storage:** Optional — export to offsite backup server for compliance/audit
- **Custom metrics:** Prometheus supports any custom application metrics emitted by client workloads

## Related Documentation

- **BACKUP_STRATEGY.md**: Backup monitoring and alerting
- **INFRASTRUCTURE_SIZING.md**: Resource monitoring and capacity planning
- **SECURITY_ARCHITECTURE.md**: Security event monitoring and logging
- **EMAIL_SERVICES.md**: Email system monitoring and metrics
- **EMAIL_SENDING_LIMITS_AND_MONITORING.md**: Email rate limiting, quota enforcement, mailqueue health, IP reputation tracking
