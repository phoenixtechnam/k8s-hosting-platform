# Competitive Analysis & Adoptable Patterns

> Last updated: 2026-04-16

This document captures features, patterns, and reusable code from competing hosting panels and PaaS platforms that are worth implementing in this project.

## Market Positioning

This platform occupies an unserved niche: **Kubernetes-native hosting panel with full traditional hosting features** (email, DNS, files, databases, multi-tenant admin/client split). No existing project combines all of these.

```
                        Full Hosting Panel Features
                    (email, DNS, files, DB, client UI)
                    ┌──────────────┬────────────────────┐
                    │  HestiaCP    │                    │
                    │  CyberPanel  │  THIS PLATFORM     │
  Bare metal / VPS  │  ISPConfig   │  (only occupant)   │  Kubernetes
                    │  Virtualmin  │                    │
                    │  DirectAdmin │                    │
                    ├──────────────┼────────────────────┤
                    │  Cloudron    │  Kubero            │
                    │              │  KubeSphere        │
                    └──────────────┴────────────────────┘
                         Developer PaaS / Infra tools
```

## Competitor Overview

### Traditional Hosting Panels (no K8s)

| Panel | License | Multi-tenant | Email | DNS | Files | DB | Admin/Client | Stack |
|-------|---------|-------------|-------|-----|-------|----|-------------|-------|
| HestiaCP | GPLv3 | Yes | Yes | Yes | Yes | Yes | Yes | Shell/PHP |
| CyberPanel | GPLv3 | Yes | Yes | Yes | Yes | Yes | Yes | Python/Django |
| ISPConfig | BSD | Yes | Yes | Yes | Yes | Yes | Yes | PHP |
| Virtualmin | GPL | Yes | Yes | Yes | Yes | Yes | Yes | Perl |
| DirectAdmin | $$$ | Yes | Yes | Yes | Yes | Yes | Yes | C++ |
| Cloudron | $15-90/mo | No (single-tenant) | Yes | Yes | Yes | Yes | No | Node.js |

All hit 6/8 criteria but none have K8s orchestration or modern stacks.

### Self-Hosted PaaS (container-native, not hosting panels)

| Platform | License | Multi-tenant | Email | DNS | DB | Stack |
|----------|---------|-------------|-------|-----|-----|-------|
| Coolify | Apache 2.0 | Unsafe | No | No | Yes | PHP/Laravel |
| Dokploy | MIT | No | No | No | Yes | TypeScript |
| CapRover | Apache 2.0 | No | No | No | Yes | Node.js |
| Dokku | MIT | No | No | No | Yes | Shell/Go |

Developer self-hosting tools. No operator/client split, no email, no DNS.

### K8s-Native (closest competitors)

| Platform | License | Multi-tenant | Email | DNS | Admin/Client | Stack |
|----------|---------|-------------|-------|-----|-------------|-------|
| Kubero | GPL-3.0 | Yes (pipelines) | Partial (Haraka) | No | No | TypeScript/NestJS + Vue |
| KuberLogic | Apache 2.0 | Yes | No | No | No | Go (ARCHIVED) |

Kubero is closest — K8s-native, TypeScript, some hosting features — but lacks DNS, file management, and admin/client UI split.

---

## Adoptable Patterns (Priority Order)

### P1: Backup Scheduling + S3 Storage

**Source:** Cloudron (design), Dokploy (code reference)

**Pattern:** Per-deployment backup isolation with S3-compatible storage.

Cloudron's approach:
- Each app backs up independently (enables single-app restore/clone/migration)
- rsync incremental mode: tracks previously uploaded files, issues remote S3 copy for unchanged data
- AES-256-CBC encryption with scrypt key derivation (4 separate keys)
- Multi-destination rotation with per-destination retention policies (e.g. 7 daily, 4 weekly)
- Automatic pre-update snapshots retained for 3 weeks

Dokploy's code (MIT, TypeScript, same stack):
- Location: `packages/server/src/utils/backups/*.ts`
- Per-DB-type dump files: `postgres.ts`, `mariadb.ts`, `mongo.ts`
- S3-compatible destinations with cron-expression scheduling
- `keepLatestCount` retention policy
- BullMQ job queue for async backup execution

**Implementation approach for this project:**
- Use Velero + Restic for K8s-native PVC backups to S3
- CronJob per deployment (label-selected PVCs by `deployment-id`)
- Per-tenant S3 prefix for isolation
- Study Dokploy's TypeScript backup service as implementation reference
- Add backup configuration to admin panel (schedule, retention, destination)

**Effort:** Medium | **Impact:** Critical for production

---

### P2: Addon Auto-Provisioning on Deploy

**Source:** Cloudron (gold standard), Coolify (simpler variant)

**Cloudron pattern:**
- App manifest declares: `"addons": {"mysql": {}, "redis": {}}`
- Platform automatically creates database, user, and injects connection env vars:
  - `CLOUDRON_MYSQL_HOST`, `CLOUDRON_MYSQL_DATABASE`, `CLOUDRON_MYSQL_USERNAME`, `CLOUDRON_MYSQL_PASSWORD`
- Supported addons: mysql, postgresql, mongodb, redis, email, ldap, oidc, localstorage, scheduler, sendmail, recvmail

**Coolify pattern (simpler):**
- Magic env var prefixes: `SERVICE_PASSWORD_MYSQL`, `SERVICE_URL_GHOST_2368`, `SERVICE_BASE64_64_PLAUSIBLE`
- Auto-generates secrets and URLs at deploy time without separate schema

**Implementation approach:**
- Extend `manifest.json` component spec with `autoProvision` section:
  ```json
  {
    "name": "mariadb",
    "type": "statefulset",
    "database": "mariadb",
    "autoProvision": {
      "secrets": ["DB_PASSWORD", "DB_ROOT_PASSWORD"],
      "envMapping": {
        "DB_HOST": "{{service.name}}.{{namespace}}.svc.cluster.local",
        "DB_NAME": "{{deployment.name}}",
        "DB_USER": "{{deployment.name}}"
      }
    }
  }
  ```
- Backend generates values and injects as K8s Secrets + env vars
- Replaces hardcoded defaults in catalog entries

**Effort:** Medium | **Impact:** High (differentiator for one-click deploys)

---

### P3: WebSocket Log Streaming

**Source:** Dokploy (MIT, TypeScript)

**Pattern:**
- 5 dedicated WebSocket endpoints:
  - `/docker-stats-monitoring` — real-time CPU/RAM metrics
  - `/docker-container-logs` — live log tailing
  - `/listen-deployment` — deployment progress events
  - `/docker-container-terminal` — interactive shell
  - `/terminal` — host terminal access
- Uses `node-pty` for local terminal spawning, `ssh2` for remote
- 45-second keep-alive pings
- Configurable tail lines (50-5000), time range filters, regex search
- ANSI rendering via `fancy-ansi`

**Code location:** `apps/dokploy/server/wss/` (WebSocket handlers)

**Implementation approach:**
- Fastify WebSocket plugin + `kubectl logs --follow` streaming
- Expose via client panel: per-deployment log viewer
- Use K8s `exec` API (already used by SFTP gateway) for container terminal
- Add to admin panel: cluster-wide log aggregation view

**Effort:** Low-Medium | **Impact:** High (clients need live logs)

---

### P4: Client Resource Usage Dashboard

**Source:** Plesk (cgroups), Dokploy (WebSocket metrics)

**Plesk pattern:**
- Uses Linux cgroups to enforce and monitor per-subscription CPU/RAM limits
- Threshold notifications when consumption exceeds configured percentages
- Side-by-side comparison of up to 10 subscriptions

**Dokploy pattern:**
- Container metrics via `docker stats --no-stream` at 20s intervals
- Collects: CPU %, memory usage/limit, network I/O, block I/O, PID count
- WebSocket streaming to dashboard
- Traefik access log parsing for request metrics

**Implementation approach:**
- Use K8s `metrics-server` + Prometheus (already industry standard)
- Per-namespace ResourceQuotas (scaffold exists at `k8s/overlays/staging/resource-quotas-patch.yaml`)
- Lightweight API endpoint querying Prometheus for client-facing metrics
- Client panel dashboard: CPU, RAM, disk (PVC), bandwidth per deployment
- Admin panel: aggregate view across all clients

**Effort:** Medium | **Impact:** High

---

### P5: Security Audit CronJob

**Source:** Dokploy (MIT, TypeScript)

**Pattern:**
- 6-point automated server security audit:
  1. UFW firewall (installed, active, default policies)
  2. SSH hardening (key auth, root login disabled, password auth disabled, PAM)
  3. Non-root sudo user exists
  4. Unattended security upgrades enabled
  5. Fail2ban (installed, SSH jail active)
  6. Docker infrastructure (Swarm init, overlay network, version)
- Returns structured JSON with boolean `installed`/`enabled`/`active` flags per component
- Code: `packages/server/src/setup/server-audit.ts`, `server-validate.ts`

**Implementation approach:**
- K8s CronJob running against each node via SSH or DaemonSet
- Structured JSON output → stored in DB → surfaced in admin panel
- Adapt checks for k3s: replace Docker Swarm checks with k3s-specific ones (kubelet TLS, RBAC enabled, pod security standards, network policy enforcement)
- Alert on degraded security posture

**Effort:** Low | **Impact:** Medium

---

### P6: Post-Install Messages

**Source:** Cloudron

**Pattern:**
- `postInstallMessage` field in app manifest with template variables:
  - `{{FQDN}}` — the deployed app's URL
  - `{{ADMIN_URL}}` — admin panel URL
  - SSO-aware conditional blocks
- Shown to client after successful deployment as a dismissible banner
- Includes first-login credentials, setup instructions, links

**Implementation approach:**
- Add `postInstallMessage` field to catalog `manifest.json`
- Backend renders template with actual deployment values after provisioning
- Client panel displays in a dismissible card on the deployment detail page
- Support markdown formatting

**Effort:** Low | **Impact:** Medium (improves onboarding UX)

---

### P7: Billing / Plan Enforcement

**Source:** cPanel + WHMCS (design pattern), Stripe (implementation)

**WHMCS package schema (reference for plan fields):**
```
Package = {
  diskQuotaMB,
  bandwidthLimitMB,
  maxDomains,
  maxDatabases,
  maxEmailAccounts,
  maxFtpAccounts,
  cpuLimit,
  memoryLimit
}
```

The panel enforces limits; WHMCS tracks usage and bills. Metric billing reads actual resource consumption from the panel API.

**Implementation approach:**
- Define plan tiers as K8s ResourceQuota templates (already have `hosting_plans` DB table)
- Enforce via ResourceQuota per client namespace
- Integrate with Stripe subscriptions + metered billing API directly (skip WHMCS — PHP/legacy)
- Admin panel: plan management, usage reports
- Client panel: current usage vs. plan limits, upgrade prompt

**Effort:** High | **Impact:** Medium (needed before paid clients, not before MVP)

---

## Reusable Open-Source Code

| Component | Source | License | Why reusable |
|-----------|--------|---------|-------------|
| Backup service | Dokploy `packages/server/src/utils/backups/*.ts` | MIT | Same stack (TS + Drizzle + tRPC). Per-DB dump + S3 + cron + retention |
| Security audit | Dokploy `packages/server/src/setup/server-audit.ts` | MIT | SSH-based node validation, structured JSON output |
| WebSocket streaming | Dokploy `apps/dokploy/server/wss/` | MIT | `node-pty` + `ssh2` for container logs/terminal |
| Template catalog index | Kubero `github.com/kubero-dev/templates/index.json` | GPL-3.0 | 172-entry JSON catalog with addon deps, categories |
| K8s PVC backup | Velero (`velero.io`) | Apache 2.0 | Production-grade incremental PVC snapshots to S3 |

**Dokploy is the highest-value code reference** — MIT-licensed, TypeScript, Drizzle ORM, PostgreSQL, BullMQ job queue. Nearly identical stack.

---

## What NOT to Adopt

| Pattern | Source | Why skip |
|---------|--------|----------|
| Docker Compose as catalog format | Coolify | K8s-native; compose adds a translation layer |
| base64-encoded catalog blob | Coolify | Our `manifest.json` + Helm is more structured |
| WHMCS integration | cPanel/CyberPanel | PHP/legacy; use Stripe directly |
| Bash CLI scripts (`v-*`) | HestiaCP | Good pattern but our Fastify API already fills this role |
| Extension marketplace | Plesk | Too early; built-in catalog first |
| Single-tenant architecture | Cloudron | Fundamentally incompatible with multi-tenant hosting |
