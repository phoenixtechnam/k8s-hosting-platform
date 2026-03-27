# Kubernetes Web Hosting Platform - Infrastructure Documentation

> **Created:** 2026-02-27
> **Last Updated:** 2026-03-24 (v3.0 - Documentation reorganized into directories)
> **Status:** Complete planning phase + Advanced features documented
> **Target Platforms:** Plesk, cPanel, Virtualmin migration support
> **Deployment Model:** Geographic sharding with centralized management + Customer co-hosting

---

## Documentation Structure

All documentation has been reorganized into topic-based directories. See **[QUICKSTART.md](QUICKSTART.md)** for role-based navigation paths.

> **Note (ADR-022):** DNS (PowerDNS), VPN mesh (NetBird), and IAM (Dex/OIDC) are **external services**
> provided by a separate infrastructure project. This platform consumes their APIs.

| Directory | Contents | Files |
|-----------|----------|-------|
| **[01-core/](01-core/)** | Platform architecture, hosting plans, billing, DNS, workload deployment | 11 |
| **[02-operations/](02-operations/)** | Cluster maintenance, backup, monitoring, sizing, admin/client panels | 16 |
| **[03-security/](03-security/)** | Auth, RBAC, secrets, TLS, compliance, database access control | 6 |
| **[04-deployment/](04-deployment/)** | CI/CD, k3s setup, API spec, frontend deployment, incident response | 13 |
| **[05-advanced/](05-advanced/)** | Multi-cloud, DR, geographic sharding, IPv4/IPv6, conflict resolution | 6 |
| **[06-features/](06-features/)** | Email, FTP/SFTP, cron jobs, WAF, app catalog, AI editor, DB management | 16 |
| **[07-reference/](07-reference/)** | ADRs, FAQ, glossary, tech stack, migration plan | 7 |
| **[08-admin-panel-mockups/](08-admin-panel-mockups/)** | Interactive HTML mockups, design system | 5 |
| **[archived/](archived/)** | Outsourced docs (DNS deployment, NetBird, NS ops) — see infrastructure project | 5 |

**Master reference:** [INFRASTRUCTURE_PLAN.md](INFRASTRUCTURE_PLAN.md) (292 KB) contains the original comprehensive plan. Note: some sections are superseded by ADR-022 (DNS/NetBird/IAM now external).

---

## Detailed File Index

### 1. **INFRASTRUCTURE_PLAN.md** (223 KB) — `./INFRASTRUCTURE_PLAN.md`
The comprehensive master plan for the entire platform.

**Contents:**
- Section 0: All architectural decisions (k3s, Hetzner, Dex, etc.)
- Section 1: Overview & goals, success criteria, constraints
- Section 2: Workload container catalog (Apache+PHP, Node, Python, Ruby, etc.)
- Section 3: Application catalog (Nextcloud, Jitsi, BigBlueButton, etc.)
- Section 4: Architecture diagrams and platform service inventory
- **Section 5: Compute, networking & cost optimization**
  - **Section 5.6: Geographic sharding with centralized management** ⭐ NEW
- Section 6: Storage & databases (Longhorn, MariaDB/PostgreSQL)
- Section 7: Security & access control (OIDC, Sealed Secrets, fail2ban)
- Section 8: CI/CD & deployment (Harbor, Trivy, Flux v2)
- Section 9: Management panels (admin + client, React, Vite, Tailwind)
- Section 10: Monitoring & logging (Prometheus, Grafana, Loki)
- Section 11: Email & webmail (Docker-Mailserver, Roundcube, OIDC)
- Section 12: Disaster recovery & HA
- Section 13: Migration plan (multi-panel: Plesk, cPanel, Virtualmin)
- Section 14: Infrastructure provider & cost analysis (Hetzner recommended)
- Appendix: Decision log, open questions, tech stack

**When to read:** Start here for complete understanding of the platform

---

### 2. **GEOGRAPHIC_SHARDING_SUMMARY.md** (11 KB) — `./05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md`
Quick reference for geographic sharding implementation.

**Contents:**
- Design decisions implemented
- Multi-master database replication with app-level conflict resolution
- Centralized PowerDNS with regional caching
- Per-region external backup storage
- Full Management API replication
- Complete regional independence
- Failover scenarios and RTO/RPO targets
- Operational responsibilities per region
- Implementation roadmap
- Clarity checks

**When to read:** After INFRASTRUCTURE_PLAN.md, for detailed geographic sharding specifics

**Read if:** You want to understand how regions work independently yet share management

---

### 3. **MULTI_CLOUD_STRATEGY.md** (32 KB) — `./05-advanced/MULTI_CLOUD_STRATEGY.md`
Strategy for mixing multiple cloud providers across regions.

**Contents:**
- Executive summary: Yes, absolutely mix providers ✅
- Four deployment phases:
  - Phase 1: Single cloud (months 0-3)
  - Phase 2: Primary + warm standby (months 3-6)
  - Phase 3: Geographic distribution (months 6-12)
  - Phase 4: Full disaster recovery (months 12+)
- Architecture options:
  - Geographic sharding (recommended)
  - Active-active across providers
  - Active-passive (cold standby)
- Cost analysis: Single vs multi-cloud
- Operational complexity per phase
- Migration path from single → multi-cloud
- Terraform code examples
- Risk analysis and mitigation
- Decision matrix: When to adopt multi-cloud

**When to read:** When planning geographic expansion, for multi-cloud strategy

**Read if:** You want to add redundancy or serve multiple regions

---

### 4. **RESTORE_SPECIFICATION.md** (36 KB) — `./06-features/RESTORE_SPECIFICATION.md`
Comprehensive specification for granular backup restore functionality.

**Contents:**
- Granular restore design for Admin & Client panels
- Restorable object types (websites, databases, mail accounts, files)
- Backup version discovery and browsing
- Website restore workflow and API
- Database restore (MariaDB/PostgreSQL) with table selection
- Mail account restore with date range support
- File/folder restore with browser tree and search
- UI component mockups (version selector, file browser, progress screen)
- Admin-only features (cross-client restore, skip checks)
- Error handling & automatic rollback
- Complete API reference (11 endpoints)
- Security & compliance (access control, audit logging)
- WebSocket real-time progress tracking
- Implementation checklist

**Key Features:**
- ✅ All backup versions visible (hourly/daily/weekly snapshots)
- ✅ Non-destructive by default (rename/alternate locations)
- ✅ Both Admin and Client can initiate restores
- ✅ Async processing with real-time WebSocket updates
- ✅ File browser with search and tree navigation
- ✅ Automatic rollback on failure
- ✅ Comprehensive audit trail for compliance

**When to read:** When implementing restore functionality in admin/client panels

---

### 5. **PHASE_1_ROADMAP.md** (32 KB) — `./04-deployment/PHASE_1_ROADMAP.md` ⭐ NEW - GITHUB INTEGRATED
Week-by-week implementation roadmap with complete GitHub integration.

**Contents:**
- Weeks 1-12: Detailed tasks, deliverables, dependencies
- GitHub repository structure (monorepo layout with all directories)
- GitHub Actions CI/CD pipelines (backend, frontend, terraform, deployment)
- Branch strategy (Git Flow: main, staging, production, feature/*)
- Pull request workflow and approval process
- Issue tracking with labels and templates
- GitHub Project board setup (Kanban columns, automation)
- Secrets management (all required GitHub secrets)
- Team roles and access control
- Weekly synchronization procedures
- Dependency mapping (what blocks what)
- Risk mitigations for all critical risks

**GitHub Features Included:**
- ✅ 5 complete GitHub Actions workflows (lint, test, build, deploy-staging, deploy-production)
- ✅ PR template and issue templates (bug, feature)
- ✅ Branch protection rules
- ✅ Code review checklist
- ✅ Docker registry integration
- ✅ Kubernetes deployment automation
- ✅ Slack notifications on deployment
- ✅ Codecov integration for test coverage

**When to read:** FIRST - Before any development starts, to set up GitHub properly

---

### 6. **CONFLICT_RESOLUTION_MATRIX.md** (20 KB) — `./05-advanced/CONFLICT_RESOLUTION_MATRIX.md` ⭐ NEW
Database conflict resolution rules for multi-master PostgreSQL (Phase 2+).

**Contents:**
- 5 conflict types: Last-Write-Wins, Business Logic, Local Wins, Delete Wins, Disable Wins
- Conflict resolution rules for 8 database tables (clients, domains, email_accounts, databases, websites, backups, audit_log, billing_invoices)
- SQL trigger implementations (PostgreSQL)
- Test cases (Vitest format, ready to copy-paste)
- Conflict detection & logging strategies
- Monitoring & alerting with Prometheus
- Prevention strategies (optimistic locking, event sourcing)

**Key Features:**
- ✅ Comprehensive matrix of all tables + conflict resolution rules
- ✅ Real SQL code ready to deploy
- ✅ Test suite for all conflict scenarios
- ✅ Monitoring setup for conflict rates
- ✅ Business logic rules (plan upgrades, suspension, resource limits)

**When to read:** When designing Phase 2 geographic sharding with multi-master database

---

### 7. **GITHUB_INTEGRATION_SUMMARY.md** (20 KB) — `./04-deployment/GITHUB_INTEGRATION_SUMMARY.md` ⭐ NEW
Quick reference guide for GitHub setup and workflows.

**Contents:**
- GitHub repository creation steps
- GitHub Actions workflow file examples (complete and copy-paste ready)
- GitHub secrets setup
- Branch protection configuration
- Pull request templates
- Issue templates
- GitHub Project board setup
- Weekly workflow procedures
- Code review checklist
- Monitoring GitHub Actions

**When to read:** When setting up the GitHub repository for the first time

---

### 8. **CICD_PIPELINE_REQUIREMENTS.md** (65 KB) — `./04-deployment/CICD_PIPELINE_REQUIREMENTS.md` ⭐ NEW - DEVELOPMENT WORKFLOW
Complete CI/CD pipeline specification for development and production deployment.

**Coverage:**
- **Phase 1 (Weeks 1-12):** Basic CI (lint, test, build), manual staging/prod deployments
- **Phase 1.5 (Week 13):** Auto staging deployments, DB migration testing, load testing, performance benchmarking
- **Phase 2+ (Weeks 14+):** Canary deployments, GitOps, security scanning, automated rollbacks
- **Ongoing:** Deployment frequency targets, monitoring dashboards, troubleshooting

**Includes:**
- ✅ Local development setup (Docker Compose)
- ✅ 5 complete GitHub Actions workflows (backend CI, frontend CI, Terraform validate, deploy staging, deploy production)
- ✅ Database migration testing pipeline
- ✅ Load testing (k6)
- ✅ Security scanning (SonarQube, Trivy, OWASP ZAP)
- ✅ Deployment automation (Kubernetes, Docker)
- ✅ Secrets management (GitHub Secrets)
- ✅ Monitoring & metrics tracking
- ✅ Rollback procedures
- ✅ RBAC & access control

**Key Metrics:**
- Test Coverage: 60% (Phase 1) → 80%+ (ongoing)
- Build Time: < 10 min
- Deploy Time: < 5 min
- Test Pass Rate: 95%+ → 99%+
- Deploy Frequency: 2x/week → 20+x/week (at scale)
- MTTR: < 30 min → < 15 min

**When to read:** Before starting development (Week 1) and during implementation

---

### 9. **ADMIN_PANEL_REQUIREMENTS.md** (55 KB) — `./02-operations/ADMIN_PANEL_REQUIREMENTS.md` ⭐ COMPREHENSIVE & COMPLETE
**Complete admin panel specification extracted from ALL sections of INFRASTRUCTURE_PLAN.md**

**Coverage:** 100+ features across 16 major areas:

**Cluster & Region Management:**
- ✅ Cluster status dashboard (all regions)
- ✅ Node management (drain, cordon, scale)
- ✅ Cluster networking (ingress, network policies)
- ✅ Region failover management
- ✅ Cluster auto-scaling

**Workload Catalog Management:**
- ✅ Container image management (Apache+PHP, Node, Python, Ruby, Java, .NET, static)
- ✅ Container lifecycle management (deploy, upgrade, rollback)
- ✅ Health checks & resource limits
- ✅ Image security scanning (Trivy)

**Application Catalog & Instances:**
- ✅ Application catalog (Nextcloud, WordPress, Jitsi, Gitea, Mattermost, etc.)
- ✅ Application deployment wizard
- ✅ Application instance management (deploy, update, scale, delete)
- ✅ Application configuration management

**Client & Plan Management:**
- ✅ Client account management (create, edit, suspend, delete)
- ✅ Client overrides (custom resource limits, pricing)
- ✅ Plan management (create, edit, clone, deprecate)
- ✅ Bulk client operations (8 types)

**Infrastructure & Resource Management:**
- ✅ Namespace management per client
- ✅ Pod management (view, logs, restart, delete)
- ✅ Persistent volume management (expand, snapshot, restore)
- ✅ Resource quota management

**Storage & Database Management:**
- ✅ MariaDB/PostgreSQL database management
- ✅ Backup management (Velero, rsync --archive)
- ✅ Backup scheduling & retention
- ✅ Shared Redis cache management

**VPS Auto-Provisioning:**
- ✅ Cloud provider credential management (Hetzner, AWS, OVH, NetCup, Azure)
- ✅ VPS provisioning wizard (master/worker, auto/manual bootstrap)
- ✅ Live provisioning progress (15+ steps)
- ✅ Server decommissioning

**Networking & DNS Management:**
- ✅ PowerDNS zone management
- ✅ DNS record management (A, CNAME, MX, TXT, SPF, DKIM)
- ✅ Regional DNS caching management
- ✅ SSL certificate management (Let's Encrypt)

**Security & Access Control:**
- ✅ OIDC authentication provider management
- ✅ Admin accounts & roles (6+ predefined roles)
- ✅ 2FA/MFA (TOTP, U2F, SMS)
- ✅ IP whitelist for admin access
- ✅ Session management
- ✅ fail2ban intrusion detection
- ✅ ModSecurity WAF management

**Monitoring, Logging & Alerts:**
- ✅ Prometheus metrics (CPU, memory, disk, network)
- ✅ Grafana dashboards (cluster, per-client, per-node)
- ✅ Loki log aggregation & search
- ✅ Alertmanager configuration
- ✅ Health scoring & anomaly detection
- ✅ Alert acknowledgment & routing

**CI/CD & Container Registry:**
- ✅ Harbor registry management
- ✅ Image vulnerability scanning
- ✅ Image replication
- ✅ Flux v2 GitOps management
- ✅ Deployment history & rollbacks

**Email & Communication:**
- ✅ Docker-Mailserver management
- ✅ Email account management
- ✅ Email forwarding & filtering
- ✅ Roundcube webmail configuration
- ✅ DKIM/SPF/DMARC configuration

**Backup & Disaster Recovery:**
- ✅ Velero backup management
- ✅ rsync --archive file backups
- ✅ Cross-region backup sync
- ✅ Backup verification & testing
- ✅ Recovery procedures

**Billing & Revenue:**
- ✅ Plan pricing management
- ✅ Invoice generation & payment tracking
- ✅ Subscription management
- ✅ Refunds & credits
- ✅ Revenue analytics (MRR, ARR, churn, CLTV)

**Audit & Compliance:**
- ✅ Audit logging (all admin actions)
- ✅ GDPR compliance (data requests, consent, retention)
- ✅ Data privacy management
- ✅ Compliance reporting

**Advanced Search & Filtering:**
- ✅ Client search (simple & advanced)
- ✅ Saved filter presets
- ✅ Custom tag support
- ✅ Bulk export

**All sections include:**
- Complete feature list
- Detailed specifications
- UI mockups/examples
- API endpoint definitions
- Phase allocation (1, 1.5, 2, 3+)

**When to read:** THIS IS YOUR DEFINITIVE ADMIN PANEL SPECIFICATION

**Use this for:** 
- Development (build feature-by-feature)
- Project tracking (100+ features to implement)
- Testing (comprehensive test cases)
- Architecture decisions (what APIs needed, database schema, etc.)

---

### 10. **CLUSTER_MAINTENANCE_AND_UPGRADES.md** (85 KB) — `./02-operations/CLUSTER_MAINTENANCE_AND_UPGRADES.md` ⭐ NEW

**Comprehensive cluster maintenance and upgrade procedures**

**Coverage:** Complete operational procedures for:

**k3s Cluster Upgrades:**
- ✅ Patch upgrades (1.28.0 → 1.28.1)
- ✅ Minor upgrades (1.28 → 1.29)
- ✅ Major upgrades (1.x → 2.x)
- ✅ Single-node and HA upgrade procedures
- ✅ Automatic rollback on failure

**Control Plane OS Upgrades:**
- ✅ In-place OS upgrade (Debian 13 → 14)
- ✅ Node replacement strategy (safer alternative)
- ✅ etcd backup and restoration
- ✅ HA control plane rolling upgrades
- ✅ Debian EOL lifecycle management

**Worker Node Upgrades:**
- ✅ Single node upgrade with pod rescheduling
- ✅ Rolling worker node upgrades (zero downtime)
- ✅ N+1 redundancy strategy
- ✅ Graceful cordon and drain procedures

**Security & Patching:**
- ✅ Critical vs. non-critical patch strategy
- ✅ Weekly security patch cycle
- ✅ Automated patch application
- ✅ Vulnerability management

**Backup & Restore:**
- ✅ Full cluster etcd snapshots (daily)
- ✅ External backup (offsite disaster recovery)
- ✅ Restore from backup procedures
- ✅ Point-in-time recovery
- ✅ Namespace/pod-level restore

**Testing & Validation:**
- ✅ Pre-production staging cluster
- ✅ Smoke test scripts
- ✅ Load testing (before/after)
- ✅ Health verification checklists
- ✅ Failure scenario testing

**Failure Scenarios:**
- ✅ k3s fails to start after upgrade
- ✅ Pod rescheduling hangs
- ✅ etcd corruption recovery
- ✅ API server OOMKilled
- ✅ Recovery procedures for all scenarios

**Operational Runbooks:**
- ✅ Monthly k3s patch update
- ✅ OS security patch (worker node)
- ✅ Emergency cluster restore
- ✅ Step-by-step procedures
- ✅ Estimated downtime per scenario

**When to read:** Before deploying to production and during all cluster maintenance

---

### 11. **CUSTOMER_CRON_JOBS.md** (65 KB) — `./06-features/CUSTOMER_CRON_JOBS.md` ⭐ NEW

**Comprehensive cron job scheduling and execution specification**

**Coverage:** Complete customer cron job support:

**Architecture & Design:**
- ✅ Kubernetes CronJob resources with per-customer namespace isolation
- ✅ Execution model with script type support (PHP, Shell, Python, Node.js)
- ✅ Resource limits per plan (CPU, memory, execution timeout)
- ✅ Job concurrency management (1 per cron job, no overlaps)
- ✅ Automatic retry with exponential backoff (up to 3 retries)

**Database Schema:**
- ✅ `cron_jobs` table (configuration storage)
- ✅ `cron_job_runs` table (execution history)
- ✅ `cron_job_audit_log` table (compliance tracking)
- ✅ Full normalization with indexes for performance

**API Specification:**
- ✅ 13 endpoints (customer + admin)
- ✅ List, create, read, update, delete operations
- ✅ Execution history and last-run queries
- ✅ Manual trigger for on-demand execution
- ✅ Schedule validation endpoint
- ✅ Admin-only endpoints (force run, disable all, global dashboard)

**Plan-Based Limits:**
- ✅ Starter: 2 jobs, 5-min timeout, 30-day history
- ✅ Business: 10 jobs, 15-min timeout, 90-day history
- ✅ Premium: Unlimited jobs, 30-min timeout, 365-day history

**Client Panel Features:**
- ✅ Cron jobs dashboard with list view
- ✅ Create/edit form with schedule builder and crontab validation
- ✅ Execution history with pagination and filtering
- ✅ Last run details with stdout/stderr output
- ✅ Webhook integration for external notifications
- ✅ Manual job trigger button
- ✅ Plan usage indicator
- ✅ Email alerts on job failures

**Admin Panel Features:**
- ✅ Global cron job dashboard (all customers)
- ✅ Customer-specific job management
- ✅ Debug tools (force run, view logs, Kubernetes metadata)
- ✅ Audit trail for all changes (who, what, when, why)
- ✅ Performance monitoring (success rates, slowest jobs, failures)
- ✅ Migration tracking (from Plesk, cPanel, Virtualmin)
- ✅ Bulk operations (disable all, force run all, delete all)

**Migration Support:**
- ✅ Automated extraction from Plesk (RPC API + SSH)
- ✅ Automated extraction from cPanel (API + SSH)
- ✅ Automated extraction from Virtualmin (API + SSH)
- ✅ Manual migration option for special cases
- ✅ Migration validation (check compatibility)
- ✅ Script path transformation (legacy → K8s)
- ✅ Customer notification on successful migration

**Webhook Integration:**
- ✅ Optional webhook notifications on job completion
- ✅ HMAC-SHA256 signature verification
- ✅ Automatic retry with exponential backoff (3 retries)
- ✅ Full webhook delivery tracking

**Failure Handling:**
- ✅ Exit code tracking (success/failure)
- ✅ Timeout handling (forceful termination)
- ✅ Automatic retry with backoff
- ✅ Comprehensive error logging
- ✅ Admin recovery options (manual retry, edit config, rollback)

**Security & Isolation:**
- ✅ Per-namespace isolation (each customer's own namespace)
- ✅ RBAC enforcement (no cross-customer access)
- ✅ Webhook secret management (HMAC-SHA256)
- ✅ Audit logging for compliance
- ✅ Data retention by plan (30/90/365 days)

**Monitoring & Observability:**
- ✅ Prometheus metrics (duration, status, CPU, memory)
- ✅ Success rate tracking
- ✅ Resource usage monitoring
- ✅ Failure alerts
- ✅ Webhook delivery status

**When to read:** When implementing customer job scheduling features; referenced by MIGRATION_PLAN.md (line 123)

**Filled Critical Gap:** MIGRATION_PLAN.md mentioned "cron jobs (extracted as scripts)" but had no implementation specification — now fully documented.

---

### 12. **EMAIL_SENDING_LIMITS_AND_MONITORING.md** (95 KB) — `./06-features/EMAIL_SENDING_LIMITS_AND_MONITORING.md` ⭐ NEW

**Comprehensive email rate limiting and delivery monitoring specification**

**Coverage:** Complete email quota enforcement and monitoring:

**Email Sending Limits (Defense-in-Depth):**
- ✅ Application-level quota tracking (warns before limits)
- ✅ Postfix-level hard limits (rejects emails when limits exceeded)
- ✅ Plan-based hourly & daily limits (Starter: 50/200, Business: 500/5000, Premium: 2000/50000)
- ✅ Per-customer limits (not per-account; prevents circumvention)
- ✅ Custom policy daemon (Python) for Postfix integration
- ✅ Quota database schema with hourly/daily rolling windows

**Database Schema:**
- ✅ `email_sending_quota` (hourly/daily tracking)
- ✅ `email_messages` (message status, bounce tracking)
- ✅ `email_blacklist_checks` (DNSBL monitoring)
- ✅ `email_auth_failures` (DKIM/SPF/DMARC validation)

**Customer-Facing Monitoring:**
- ✅ Email statistics dashboard (sent/bounced/failed/pending counts)
- ✅ Message-level view (search by recipient, filter by status)
- ✅ Bounce analysis with recommendations
- ✅ Quota progress bars with countdown timers
- ✅ Download message history as CSV
- ✅ API endpoints for email status queries

**Admin-Level Monitoring:**
- ✅ Postfix queue health dashboard (active/deferred/hold/corrupt)
- ✅ Delivery stats (success rate, bounce rate, failure rate)
- ✅ Per-customer breakdown (who's sending most, hitting limits, bouncing)
- ✅ IP/Domain reputation tracking:
  - Blacklist detection (Spamhaus, Barracuda, Sorbs, Invaluement)
  - DKIM/SPF/DMARC validation failures
  - Spam complaint tracking
- ✅ Queue alerts (size exceeded, stalled delivery, stuck messages)

**Event Notifications:**
- ✅ `email.hourly_limit_warning` (80% of hourly quota)
- ✅ `email.hourly_limit_reached` (customer hit limit)
- ✅ `email.bounce_rate_high` (>5% bounce rate)
- ✅ `email.queue_stalled` (delivery not progressing)
- ✅ `email.ip_blacklisted` (critical: server IP on blacklist)
- ✅ `email.dkim_invalid` / `email.spf_misconfigured` (auth failures)

**Postfix Configuration:**
- ✅ Complete `/etc/postfix/main.cf` configuration
- ✅ Policy daemon (Python, ready to deploy)
- ✅ Kubernetes sidecar deployment manifests
- ✅ Rate limiting per customer (not just per IP)
- ✅ Queue limits (prevent stuck emails)

**Monitoring & Alerting:**
- ✅ Prometheus metrics export (queue size, delivery rate, bounce rate)
- ✅ Alert rules (queue too large, bounce rate high, IP blacklisted)
- ✅ Grafana dashboard specification
- ✅ Log aggregation (Loki) for mail logs

**When to read:** When implementing email quota enforcement and customer/admin monitoring features

**Filled Critical Gap:** EMAIL_SERVICES.md mentioned "sending limits enforced by Postfix" but had no implementation details — now fully specified.

---

### 13. **WEBMAIL_ACCESS_SPECIFICATION.md** (260 KB) — `./06-features/WEBMAIL_ACCESS_SPECIFICATION.md` ⭐ NEW

**Comprehensive webmail access specification with multi-domain support, admin email masquerading, AND staff role management**

**Coverage:** Complete webmail feature definition:

**Architecture:**
- ✅ Single shared Roundcube instance (all customers via smart routing)
- ✅ One webmail domain per customer domain (webmail.example.com, webmail.shop.example.com, etc.)
- ✅ Automatic domain generation and SSL provisioning (Let's Encrypt)
- ✅ Email account isolation (each user logs into only their own account)
- ✅ Domain-agnostic Roundcube configuration (no per-domain config needed)

**Webmail Domain Management:**
- ✅ Automatic generation (webmail.{customer-domain})
- ✅ Per-domain SSL certificates (cert-manager automation)
- ✅ Enable/disable toggle per domain
- ✅ Certificate renewal monitoring and alerts
- ✅ Automatic renewal 30 days before expiration

**Authentication Options:**
- ✅ App password login (primary method)
- ✅ OIDC login (Google/Apple; optional per customer)
- ✅ Secure session management (30-min timeout, CSRF protection)
- ✅ User isolation at Dovecot IMAP level (enforced)

**Customer Customization:**
- ✅ Theme selection (default, classic, larry, monochrome)
- ✅ Language support (50+ languages)
- ✅ Timezone and date format settings
- ✅ Editor mode (HTML vs plain text)
- ✅ No branding customization (platform-managed)

**Database Schema:**
- ✅ `domain_webmail_config` (per-domain settings, certs, usage)
- ✅ `webmail_sessions` (session tracking, IP/UA validation)
- ✅ `webmail_usage_daily` (analytics for reporting)

**Customer Panel Features:**
- ✅ Webmail domains list (one per domain)
- ✅ Quick links to open webmail (separate for each domain)
- ✅ Email account management (create/delete/view details)
- ✅ App password management
- ✅ Webmail preferences link (theme, language, timezone)

**Admin Panel Features (EC.2):**
- ✅ Webmail dashboard (pod health, active users, response time)
- ✅ Domain management table (list all, certificate status, user stats)
- ✅ Per-domain settings (theme defaults, OIDC config, cert management)
- ✅ Customer webmail toggle (enable/disable per customer)
- ✅ Certificate monitoring (expiration alerts, manual renewal)
- ✅ Usage statistics (unique users, login trends, failed logins)
- ✅ Active sessions viewer (real-time active users, kick sessions)
- ✅ Roundcube configuration (plugins, features, resource limits)

**API Endpoints:**
- ✅ 6 customer endpoints (list/get domains, list/create/update/delete accounts)
- ✅ 8 admin endpoints (list/manage domains, manage sessions, view stats)

**Plan-Based Features:**
- ✅ Starter: Platform default webmail domain only (1 email account)
- ✅ Business: One custom webmail domain per domain (5 email accounts)
- ✅ Premium: Full control, unlimited domains and accounts

**Security & Isolation:**
- ✅ User isolation enforced at IMAP level (cannot access other users' mail)
- ✅ SSL/TLS for all traffic (HTTPS only, HSTS headers)
- ✅ Session hardening (HttpOnly cookies, CSRF tokens, IP validation)
- ✅ High-entropy app passwords (32-char random, bcrypt hashing)

**Certificate Management:**
- ✅ Automatic provisioning (cert-manager + Let's Encrypt)
- ✅ Auto-renewal (30 days before expiration)
- ✅ Manual renewal button for emergencies
- ✅ Expiration monitoring and admin alerts

**Monitoring:**
- ✅ Health checks (pod, database, IMAP connectivity)
- ✅ Usage metrics (unique users, login events, session duration)
- ✅ Error tracking (failed logins, session timeouts, certificate errors)
- ✅ Performance metrics (response time, peak concurrent users)

**Admin Email Access (EC.3 - New!):**
- ✅ Masquerade as customer (admin can temporarily log into any email account)
- ✅ Role-based permissions (support staff read-only, senior admins full access)
- ✅ Secure one-time tokens (auto-login, 60-min expiration, IP-bound)
- ✅ Detailed audit logging (every action tracked: read, send, delete, search)
- ✅ Action confirmation (require confirmation for sends and deletions)
- ✅ Session management (timeout, revocation, active session monitoring)
- ✅ Compliance-ready (GDPR/HIPAA/SOX audit trails, immutable logs)
- ✅ Admin dashboard (active sessions, sensitive actions, per-admin metrics)
- ✅ Database tables (sessions, audit log, summary stats)
- ✅ 5 API endpoints (generate token, list sessions, view logs, revoke, history)

**Staff Role Management System (NEW!):**
- ✅ Fully customizable staff roles (not preset hierarchies)
- ✅ Per-role configuration: permission level (read-only vs full)
- ✅ Customer access restrictions by tag/group (e.g., 'Enterprise', 'SMB')
- ✅ Customer access restrictions by region (US, EU, APAC, etc.)
- ✅ Combine tag + region restrictions (e.g., Enterprise customers in US only)
- ✅ Configurable action approvals (some actions require supervisor approval)
- ✅ Per-staff overrides (customize role permissions for individuals)
- ✅ Approval workflow (request → review → approve/reject)
- ✅ Pending approvals dashboard (for supervisors)
- ✅ Staff role management UI (create, edit, delete roles)
- ✅ Staff member assignment & override UI
- ✅ 4 new database tables (roles, actions, staff members, approval requests)
- ✅ 8+ API endpoints (role CRUD, staff assignment, approvals)

**When to read:** When implementing customer webmail access, admin controls, and multi-team support structures

**Filled Critical Gap:** EMAIL_SERVICES.md mentioned webmail but lacked domain routing, SSL management, and admin controls — now fully specified with comprehensive admin email access, full audit logging, and enterprise staff role management for support teams.

---

### 14. **FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md** (125 KB) — `./06-features/FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md` ⭐ NEW

**Comprehensive FTP/FTPS/SSH/SFTP file transfer specification with security-first design**

**Coverage:** Complete file transfer feature definition:

**Protocols:**
- ✅ SSH/SFTP (default, encrypted, recommended)
- ✅ FTPS with explicit TLS (backward compatible)
- ✅ FTP legacy (optional, disabled by default, documented security risk)

**Architecture:**
- ✅ OpenSSH server for SFTP (2-4 replicas per region)
- ✅ vsftpd server for FTP/FTPS (2-4 replicas per region)
- ✅ Chroot jail isolation per customer (cannot escape via `../` or symlinks)
- ✅ PAM/MariaDB authentication (validates against ftp_users table)
- ✅ Shared storage with per-customer quotas

**File Access Users:**
- ✅ Create multiple FTP/SFTP users per customer
- ✅ Per-user permissions (read, write, delete, rename, mkdir)
- ✅ Expiring credentials (optional account expiration)
- ✅ IP whitelisting per user
- ✅ Session timeouts and max concurrent sessions
- ✅ Password rotation and credential reset

**Quota Management:**
- ✅ Storage quota per customer (enforced)
- ✅ Monthly bandwidth limits per user (upload/download)
- ✅ Soft quota warnings at 80% usage
- ✅ Hard quota enforcement at 100%
- ✅ Monthly quota reset and usage tracking

**Audit Logging:**
- ✅ All file operations logged (upload, download, delete, rename, mkdir)
- ✅ Session tracking (login, logout, IP, duration, bytes transferred)
- ✅ Bandwidth usage tracking per user per month
- ✅ Immutable, append-only audit log
- ✅ Real-time event streaming with microsecond precision
- ✅ Compliance retention (1+ year configurable)

**Security & Isolation:**
- ✅ User isolation: chroot jail to /home/customer/public_html/
- ✅ Cross-customer access prevention (enforced at DB level)
- ✅ Encryption enforced (SSH/SFTP or FTPS TLS 1.2+)
- ✅ Strong password generation (20+ char, system-generated)
- ✅ Rate limiting (3 failed auth attempts per minute)
- ✅ Connection limits (max 10 per IP, max 100 global)
- ✅ IP-based rate limiting and DDoS protection
- ✅ Admin oversight (disable/enable users, force password reset)

**Database Schema:**
- ✅ `ftp_users` (user credentials, permissions, quotas, expiration)
- ✅ `ftp_file_audit_log` (all file operations with metadata)
- ✅ `ftp_bandwidth_quota_usage` (monthly usage tracking)
- ✅ `ftp_session_log` (login/logout with session details)
- ✅ `ftp_event_log` (real-time streaming for alerts/monitoring)

**Customer API Endpoints:**
- ✅ List/get/create/update/delete FTP users (5 endpoints)
- ✅ Rotate password (1 endpoint)
- ✅ View audit log with filtering (1 endpoint)
- ✅ View bandwidth usage per month (1 endpoint)
- ✅ Get connection info (SFTP/FTPS/FTP details) (1 endpoint)
- ✅ Enable/disable protocols (SFTP/FTPS/FTP) (1 endpoint)
- ✅ Total: 10 customer endpoints

**Admin API Endpoints:**
- ✅ List all FTP users across all customers (1 endpoint)
- ✅ Disable/enable users (1 endpoint)
- ✅ Force password reset (1 endpoint)
- ✅ View customer audit logs (1 endpoint)
- ✅ Bulk actions (disable multiple users) (1 endpoint)
- ✅ Total: 5 admin endpoints

**Customer Panel Features:**
- ✅ Users management table (list all users with status and last login)
- ✅ Create user dialog (with auto password generation or custom)
- ✅ Edit user permissions panel (read/write/delete/rename/mkdir toggles)
- ✅ Set usage limits (upload/download MB per month)
- ✅ Session management (timeout, max concurrent, IP whitelist)
- ✅ Credential expiration dates
- ✅ Password rotation dialog
- ✅ Connection info page (SFTP/FTPS/FTP details with client guides)
- ✅ File browser (optional; upload, download, delete, rename, mkdir)
- ✅ Bandwidth usage chart (current month, per-user breakdown)
- ✅ Audit log viewer (searchable, filterable, exportable)

**Admin Panel Features:**
- ✅ Global FTP users dashboard
- ✅ List all users across all customers
- ✅ Disable/enable user accounts
- ✅ Force password resets
- ✅ Monitor suspicious activity
- ✅ View customer audit trails
- ✅ Bulk user actions
- ✅ Protocol configuration (enable/disable FTP, FTPS, SFTP)

**Compliance & Regulatory:**
- ✅ GDPR: Data subject access requests, audit trail, erasure support
- ✅ HIPAA: Encryption in transit/at rest, access controls, immutable audit log (6-year retention)
- ✅ SOX: Change tracking, segregation of duties, audit trail, compliance reporting

**Implementation Checklist:**
- ✅ Phase 1: SSH/SFTP + FTP/FTPS server deployment (Weeks 1-2)
- ✅ Phase 2: API endpoints for user management (Weeks 3-4)
- ✅ Phase 3: Web UI (users, connection info, file browser, audit log) (Weeks 5-6)
- ✅ Phase 4: Security hardening and rate limiting (Weeks 7-8)
- ✅ Phase 5: Testing and documentation (Weeks 9-10)

**Performance & Scalability:**
- ✅ Stateless pods (horizontal scaling)
- ✅ Load balancer support (sticky sessions optional)
- ✅ Per-region deployment
- ✅ Bandwidth throttling per user (10 MB/s, configurable)
- ✅ Supports 100+ concurrent connections per pod

**Monitoring & Alerts:**
- ✅ Active connections per protocol
- ✅ Failed login attempts (credential stuffing detection)
- ✅ Quota usage alerts (80% and 100%)
- ✅ Pod health checks
- ✅ Audit log write latency
- ✅ Suspicious activity (bulk deletes, failed auths, etc.)

**Operational Deployment:**
- ✅ StatefulSet per protocol (SFTP, FTP/FTPS)
- ✅ 2-4 replicas per region
- ✅ NFS/Longhorn shared storage
- ✅ ConfigMap for server configs (sshd_config, vsftpd.conf)
- ✅ Secret for TLS certificates and host keys
- ✅ Kubernetes Service with NodePort / hostPort

**Future Enhancements:**
- SSH key-based authentication (in addition to passwords)
- Two-factor authentication (TOTP/U2F)
- Fine-grained ACLs per directory
- WebDAV protocol support
- Resumable uploads
- Automatic compression
- Ransomware detection
- Zero-knowledge encryption

**When to read:** When implementing file transfer capabilities for customers, enabling developers/teams to upload/download files, and for backup/restore integration

**Filled Critical Gap:** INFRASTRUCTURE_PLAN.md mentioned file access but lacked protocol specs, user management, security isolation, quota enforcement, and audit logging — now fully specified with production-ready implementation guide.

---

### 15. **MAILBOX_IMPORT_EXPORT_SPECIFICATION.md** (145 KB) — `./06-features/MAILBOX_IMPORT_EXPORT_SPECIFICATION.md` ⭐ NEW

**Comprehensive mailbox import/export specification for IMAP data migration and consolidation**

**Coverage:** Complete mailbox import/export feature definition:

**Workflows:**
- ✅ Create new email account (import to new account)
- ✅ Merge to existing account (consolidate multiple accounts)
- ✅ Incremental sync (one-time or recurring)
- ✅ Scheduled sync (daily, weekly, monthly)

**Import Features:**
- ✅ Import from any IMAP server (Gmail, Outlook, cPanel, Plesk, custom)
- ✅ OAuth2 support (Gmail, Outlook; no passwords stored)
- ✅ Folder discovery and smart mapping
- ✅ Selective folder import (choose which folders to import)
- ✅ Preserve email flags (Seen, Flagged, Deleted, Draft, etc.)
- ✅ Preserve original timestamps
- ✅ Pause/resume capability (resume from last position)

**Export Features:**
- ✅ Export to external IMAP server
- ✅ Folder mapping to destination
- ✅ Scheduled backups (daily, weekly, monthly)
- ✅ Selective folder export
- ✅ Flag preservation
- ✅ Pause/resume support

**Deduplication:**
- ✅ Message-ID detection (primary)
- ✅ Content hash verification (SHA256, fallback)
- ✅ Duplicate skipping (prevents double imports)
- ✅ Dedup cache (tracks imported emails)

**Conflict Resolution:**
- ✅ Folder name conflicts (merge, rename, skip, map)
- ✅ Duplicate email detection and skipping
- ✅ Timestamp conflict handling (preserve vs use import time)

**Progress Tracking:**
- ✅ Real-time progress percentage (0-100%)
- ✅ Per-folder progress (emails transferred, skipped, failed)
- ✅ Estimated completion time
- ✅ Email statistics (total, transferred, skipped, failed)

**Database Schema:**
- ✅ `mailbox_import_export_jobs` (job metadata, status, progress)
- ✅ `mailbox_import_export_credentials` (encrypted IMAP credentials, Vault-encrypted)
- ✅ `mailbox_import_export_log` (audit trail of all operations)
- ✅ `mailbox_dedup_cache` (Message-ID and content hash tracking)

**Customer API Endpoints:**
- ✅ Create import job (POST, workflow selection)
- ✅ Create export job (POST, scheduling)
- ✅ List import/export jobs (GET, with filtering)
- ✅ Get job details (GET, with progress)
- ✅ Pause/resume/cancel job (POST)
- ✅ View job audit log (GET)
- ✅ Test IMAP connection (POST, pre-import validation)
- ✅ Total: 9 customer endpoints

**Admin API Endpoints:**
- ✅ List all import/export jobs across customers (GET)
- ✅ Pause/resume/cancel job (any customer) (POST)
- ✅ Disable import/export per customer (PATCH)
- ✅ Total: 3 admin endpoints

**Customer Panel Features:**
- ✅ Import/Export dashboard (active and recent jobs)
- ✅ Create import job wizard (5 steps: workflow, IMAP config, folder mapping, options, schedule)
- ✅ Create export job wizard (similar workflow)
- ✅ Job progress page (progress bar, folder breakdown, event log)
- ✅ Pause/resume/cancel buttons
- ✅ Job statistics (transferred, skipped, failed counts)
- ✅ Test IMAP connection button (validate before creating job)
- ✅ Audit log viewer (searchable, filterable)

**Admin Panel Features:**
- ✅ Global import/export dashboard (all jobs across customers)
- ✅ Job management (pause, resume, cancel, view details)
- ✅ Customer settings (enable/disable import/export, max concurrent jobs)
- ✅ Activity monitoring (successful imports, failed jobs, error trends)

**Security Features:**
- ✅ Credential encryption (Vault transit, AES-256-GCM)
- ✅ Auto-deletion of credentials after job (unless recurring)
- ✅ TLS/SSL enforcement on external IMAP connections
- ✅ OAuth2 token support (Gmail, Outlook)
- ✅ Rate limiting (max 5 concurrent jobs per customer)
- ✅ Audit logging (all imports/exports logged, immutable)
- ✅ Job timeout (24 hours max)
- ✅ Folder filtering (exclude sensitive folders like Spam, Trash)

**Credential Management:**
- ✅ Vault-encrypted credentials (stored encrypted, never plaintext)
- ✅ Password/OAuth2 authentication support
- ✅ Credential validation (test connection before import)
- ✅ Auto-cleanup (delete credentials after job completes)
- ✅ OAuth2 token refresh (for recurring exports)

**Job Execution:**
- ✅ Stateless worker pods (3+ replicas, horizontally scalable)
- ✅ Job state persisted in database (can resume after pod restart)
- ✅ Batch email fetching (100 emails per batch for performance)
- ✅ Error handling and auto-retry (3 retries max)
- ✅ Progress updates every 5-10 seconds

**Implementation Checklist:**
- ✅ Phase 1: Core infrastructure (Weeks 1-3)
- ✅ Phase 2: IMAP client + deduplication (Weeks 4-6)
- ✅ Phase 3: API endpoints (Weeks 7-8)
- ✅ Phase 4: Web UI (Weeks 9-10)
- ✅ Phase 5: Security & hardening (Weeks 11-12)
- ✅ Phase 6: Testing & documentation (Weeks 13-14)

**Compliance & Regulatory:**
- ✅ GDPR: Email portability, audit trails, right to erasure
- ✅ HIPAA: TLS encryption, Vault credentials, access controls, audit logging
- ✅ SOX: Change tracking, segregation of duties, immutable audit log

**Use Cases:**
- ✅ Migration from legacy hosting (cPanel, Plesk, Virtualmin)
- ✅ Email consolidation (merge multiple accounts)
- ✅ Provider migration (switch hosting providers)
- ✅ Backup to external service (auto-sync to Backblaze, etc.)
- ✅ Personal archival (export to personal IMAP server)
- ✅ Disaster recovery (restore from external backup)

**Performance & Scalability:**
- ✅ Horizontal scaling (stateless workers)
- ✅ Batch processing (100 emails per batch)
- ✅ Bandwidth throttling (10 MB/s per job)
- ✅ Database query optimization (dedup cache indexes)
- ✅ Large mailbox support (50,000+ emails tested)

**Monitoring & Alerts:**
- ✅ Job completion rate (success/failure)
- ✅ Duplicate detection rate
- ✅ Failed auth attempts (invalid credentials)
- ✅ Job timeout detection (auto-cancel > 24 hours)
- ✅ Database latency monitoring
- ✅ Worker pod health checks

**Future Enhancements:**
- Two-way sync (bidirectional mailbox sync)
- Webhook notifications (job completion/failure)
- Folder templates (pre-configured mappings for Gmail, Outlook, etc.)
- Bulk operations (import/export multiple accounts)
- Zero-knowledge encryption (customer-encrypted emails)
- POP3 support (in addition to IMAP)
- S3 export (direct to Amazon S3 bucket)
- Ransomware detection (alert on suspicious email deletion)

**When to read:** When implementing email migration features, supporting customer onboarding from legacy platforms, and for backup/consolidation workflows

**Filled Critical Gap:** EMAIL_SERVICES.md and WEBMAIL_ACCESS_SPECIFICATION.md lacked import/export capabilities — now fully specified with production-ready IMAP migration workflows, comprehensive deduplication, and compliance-ready audit logging.

---

### 16. **WEB_APPLICATION_FIREWALL_SPECIFICATION.md** (165 KB) — `./06-features/WEB_APPLICATION_FIREWALL_SPECIFICATION.md` ⭐ NEW

**Comprehensive Web Application Firewall (WAF) specification with per-customer optional configuration**

**Coverage:** Complete WAF feature definition:

**Operational Modes:**
- ✅ OFF (no protection, all requests pass through)
- ✅ DETECTION_ONLY (log attacks, allow requests through)
- ✅ ON (block attacks, active production protection)

**Rule Management:**
- ✅ OWASP CRS v4.0 (industry-standard ruleset, 247+ rules)
- ✅ Rule exclusions by ID (disable specific rule, e.g., 941100)
- ✅ Rule exclusions by TAG (disable category, e.g., 'sqli')
- ✅ Rule exclusions by REGEX pattern (disable for specific paths)
- ✅ Auto-expiring exclusions (re-enable rule after date)
- ✅ Monthly auto-updates of OWASP CRS
- ✅ Paranoia levels (1=default, 2=medium, 3=strict, 4=paranoid)

**Security Features:**
- ✅ SQL injection detection and blocking
- ✅ XSS (Cross-site scripting) protection
- ✅ RFI/LFI (Remote/local file inclusion) blocking
- ✅ Path traversal prevention
- ✅ Remote code execution (RCE) detection
- ✅ Bot/scanner detection
- ✅ Protocol violation detection
- ✅ Exploit/vulnerability detection (CVE patterns)

**Database Schema:**
- ✅ `waf_customer_config` (per-customer WAF settings, mode, paranoia)
- ✅ `waf_rule_exclusions` (excluded rules by ID, tag, or regex)
- ✅ `waf_request_log` (all WAF decisions, high-volume log)
- ✅ `waf_alert_log` (high-severity attacks, auto-responses)
- ✅ `waf_rule_audit_log` (rule exclusion changes, audit trail)

**Customer API Endpoints:**
- ✅ Get/update WAF status (GET, PATCH)
- ✅ Update WAF mode (PATCH: OFF/DETECTION_ONLY/ON)
- ✅ Update WAF config (paranoia, performance settings)
- ✅ List/add/enable/disable/delete rule exclusions (6 endpoints)
- ✅ Get WAF logs with advanced filtering (GET)
- ✅ Get available rules and rule details (GET)
- ✅ Total: 14 customer endpoints

**Admin API Endpoints:**
- ✅ List all WAF configurations across customers (GET)
- ✅ Enable/disable WAF per customer (PATCH)
- ✅ View global WAF alerts (GET)
- ✅ Acknowledge alerts (POST)
- ✅ View global statistics and attack trends (GET)
- ✅ Total: 5 admin endpoints

**Customer Panel Features:**
- ✅ WAF dashboard (status, mode, stats, recent blocks)
- ✅ WAF settings page (enable/disable, mode selection, paranoia level)
- ✅ Rule exclusions management (list, add, edit, delete, soft-disable)
- ✅ Add exclusion wizard (exclusion type, rule ID/tag/pattern, reason, auto-expire)
- ✅ WAF logs viewer (filter by action, severity, rule, IP, date range)
- ✅ Available rules browser (search, filter by category/tag)
- ✅ Rule detail page (name, description, false positive rate, documentation)

**Admin Panel Features:**
- ✅ Global WAF dashboard (all customers, status overview)
- ✅ Per-customer WAF management (enable/disable, view config)
- ✅ Alert management (list, acknowledge, resolve)
- ✅ Global attack analytics (trends, top rules, top IPs, geo distribution)
- ✅ Rule update history and rollback capability

**Rule Exclusion Management:**
- ✅ By rule ID (disable specific rule, e.g., "941100")
- ✅ By tag (disable all rules in category, e.g., "sqli")
- ✅ By regex pattern (disable for specific paths, e.g., "/admin/*")
- ✅ Combination: disable rule 941100 only for /api/search path
- ✅ Safety warnings (warn before disabling critical rules)
- ✅ Admin approval workflow (optional)
- ✅ Auto-expiry (re-enable rule after date)
- ✅ Audit trail (who changed what, when, why)

**Monitoring & Alerting:**
- ✅ Real-time request logging (action, triggered rules, client IP, timestamp)
- ✅ Block rate monitoring (requests/second, blocks/second)
- ✅ Attack pattern detection (multiple blocks from one IP)
- ✅ Scanner/bot detection alerts
- ✅ Critical rule triggered alerts
- ✅ Performance monitoring (WAF processing time per request)
- ✅ Automatic alerts for anomalies

**Performance Optimization:**
- ✅ Target SLA: < 5ms WAF processing per request
- ✅ Rule caching per customer
- ✅ Exclusion list caching
- ✅ Batch rule processing
- ✅ Performance monitoring and alerts (if > 10ms)

**Security Considerations:**
- ✅ False positive management (DETECTION_ONLY mode for tuning)
- ✅ Rule tuning guides and best practices
- ✅ Rollout procedure (Week 1: detect-only, Week 2: tune, Week 3: enable)
- ✅ Admin approval for critical rule disabling (optional)
- ✅ Audit trail for all WAF changes
- ✅ Immutable logs (tamper-proof)
- ✅ Role-based access control

**Compliance & Regulatory:**
- ✅ GDPR: Audit trails, configurable log retention, right to erasure
- ✅ HIPAA: Encryption in transit, audit logging, access controls
- ✅ SOX: Change tracking, segregation of duties, audit trails

**Plan-Based Tiers:**
- ✅ Starter: WAF not available
- ✅ Business: WAF available, 5 rule exclusions max, 7-day log retention
- ✅ Premium: WAF available, unlimited exclusions, 90-day retention, paranoia levels 1-4

**Implementation Checklist:**
- ✅ Phase 1: ModSecurity + OWASP CRS setup (Weeks 1-2)
- ✅ Phase 2: Core WAF functionality, logging (Weeks 3-4)
- ✅ Phase 3: API endpoints (Weeks 5-6)
- ✅ Phase 4: Web UI (Weeks 7-8)
- ✅ Phase 5: Security hardening, approvals (Weeks 9-10)
- ✅ Phase 6: Testing, rollout (Weeks 11-12)

**Key Features:**
- ✅ Optional per-customer (WAF disabled by default)
- ✅ Easy mode switching (OFF → DETECTION_ONLY → ON)
- ✅ Granular rule control (ID, tag, regex)
- ✅ Zero false positives (extensive tuning support)
- ✅ Industry-standard protection (OWASP CRS v4.0)
- ✅ Real-time monitoring and alerts
- ✅ Compliance-ready audit logging
- ✅ Admin oversight and control

**When to read:** When implementing security features, protecting customer applications from web attacks, and for compliance requirements

**Filled Critical Gap:** INFRASTRUCTURE_PLAN.md Section 7 mentioned WAF (ModSecurity) but lacked per-customer configuration, rule exclusion management, and operational modes — now fully specified with production-ready implementation including three modes (OFF/DETECTION_ONLY/ON), flexible rule exclusions (ID/tag/regex), and comprehensive monitoring.

---

### 17. **HOSTING_SETTINGS_SPECIFICATION.md** (155 KB) — `./06-features/HOSTING_SETTINGS_SPECIFICATION.md` ⭐ NEW

**Comprehensive hosting settings specification for domain configuration and redirects**

**Coverage:** Complete domain hosting configuration:

**Operational Modes:**
- ✅ REDIRECT_TO_WWW (www ↔ non-www normalization)
- ✅ REDIRECT_TO_HTTPS (HTTP → HTTPS enforcement)
- ✅ FORWARD_TO_EXTERNAL (redirect to external URL)
- ✅ DISABLE_WEB_HOSTING (temporary suspension, files preserved)
- ✅ EDIT_WEBROOT_PATH (serve from subdirectory like /public/)

**Database Schema:**
- ✅ `domain_hosting_config` (per-domain settings and redirects)
- ✅ `domain_config_audit_log` (change history with audit trail)
- ✅ `webroot_validation_log` (path validation tracking)
- ✅ `domain_redirect_stats` (redirect performance metrics)

**Features:**
- ✅ Per-domain independent configuration
- ✅ Subdomain support (blog.example.com, api.example.com, etc.)
- ✅ WWW redirect options (add www, remove www, or none)
- ✅ HTTPS redirect with configurable status code (301/302/307/308)
- ✅ External forwarding with path/query preservation options
- ✅ Webroot path validation (security checks, symlink prevention)
- ✅ Disable hosting (503 response, files preserved)
- ✅ Instant application (changes effective in seconds)
- ✅ Conflict detection and prevention
- ✅ Audit logging (all changes tracked)

**Customer API Endpoints:**
- ✅ Get/update hosting configuration (GET, PATCH)
- ✅ Disable/enable web hosting (POST)
- ✅ Set WWW redirection (PATCH)
- ✅ Set HTTPS redirection (PATCH)
- ✅ Set/remove external forward (PATCH, DELETE)
- ✅ Set webroot path (PATCH)
- ✅ Validate webroot path (POST)
- ✅ Get configuration history (GET)
- ✅ Get redirect statistics (GET)
- ✅ Total: 12 customer endpoints

**Admin API Endpoints:**
- ✅ List all domain configs (GET)
- ✅ Get domain config (GET)
- ✅ Update domain config (PATCH)
- ✅ Validate all webroots (POST, admin-wide)
- ✅ Total: 4 admin endpoints

**Customer Panel Features:**
- ✅ Hosting settings dashboard (status, current config summary)
- ✅ Hosting settings editor (enable/disable, redirects, forwarding, webroot)
- ✅ Disable web hosting modal (temporary suspension with message)
- ✅ Webroot path selector (directory browser, validation)
- ✅ Configuration history page (audit trail of all changes)
- ✅ Redirect statistics page (traffic breakdown by redirect type)

**Redirect Implementation:**
- ✅ REDIRECT_TO_WWW: NGINX rewrite rules for ADD_WWW / REMOVE_WWW
- ✅ REDIRECT_TO_HTTPS: NGINX rewrite rules with status code selection
- ✅ FORWARD_TO_EXTERNAL: NGINX redirect with path/query preservation
- ✅ DISABLE_WEB_HOSTING: Return 503 Service Unavailable
- ✅ EDIT_WEBROOT_PATH: Dynamic NGINX root directive

**Security Features:**
- ✅ Path traversal prevention (normalize, realpath, block `../`)
- ✅ Symlink escape detection (prevent escaping storage root)
- ✅ Redirect loop prevention (conflict detection)
- ✅ Rate limiting on config changes (max 10/hour per domain)
- ✅ Access control (only domain owner or admin)
- ✅ IP restrictions (optional)
- ✅ Audit logging (user, IP, timestamp)

**Validation & Error Handling:**
- ✅ Directory existence checks
- ✅ Readable permission checks
- ✅ Path length limits (max 512 chars)
- ✅ URL format validation (for external forwards)
- ✅ Conflict detection (incompatible settings)
- ✅ Helpful error messages and suggestions

**Configuration Cache:**
- ✅ Redis/memory cache with 5-minute TTL
- ✅ Version-based invalidation (increment on change)
- ✅ Sub-10-second invalidation time

**Monitoring & Metrics:**
- ✅ Config change tracking (spike detection)
- ✅ Redirect latency monitoring (p95, p99)
- ✅ Disabled domains count
- ✅ Failed webroot validations
- ✅ Alerts on suspicious patterns

**Implementation Checklist:**
- ✅ Phase 1: Database + NGINX config generation (Weeks 1-2)
- ✅ Phase 2: Core functionality + validation (Weeks 3-4)
- ✅ Phase 3: API endpoints (Weeks 5-6)
- ✅ Phase 4: Web UI (Weeks 7-8)
- ✅ Phase 5: Testing + documentation (Weeks 9-10)

**Use Cases:**
- ✅ WWW normalization (consistent URL)
- ✅ HTTPS enforcement (security requirement)
- ✅ Domain parking (forward unused domain)
- ✅ External forwarding (Shopify, WordPress.com, etc.)
- ✅ Subdomain routing (blog, api, shop subdomains)
- ✅ Temporary migration (forward during migration)
- ✅ Maintenance mode (suspend without deleting)
- ✅ Multi-site setup (different subdomains, different webroots)

**When to read:** When implementing domain configuration, redirects, external forwarding, or webroot management

**Filled Critical Gap:** INFRASTRUCTURE_PLAN.md and CLIENT_PANEL_FEATURES.md lacked granular domain configuration options — now fully specified with production-ready NGINX integration, comprehensive validation, and security-first design for redirect rules and webroot management.

---

### 18. **EMAIL_ENHANCEMENTS_SPECIFICATION.md** (115 KB) — `./06-features/EMAIL_ENHANCEMENTS_SPECIFICATION.md` ⭐ NEW

**Comprehensive email service enhancements: DKIM, Autodiscover, SRV records, service control, SMTP error handling, website sendmail**

**Coverage:** Advanced email features:

**DKIM (DomainKeys Identified Mail):**
- ✅ Automatic key generation (RSA 2048/4096)
- ✅ Enabled by default for all domains
- ✅ Annual key rotation (selectable schedule)
- ✅ Key deprecation period (30+ days for old keys)
- ✅ Vault encryption (private key storage)
- ✅ DNS publishing (automated or manual)
- ✅ Postfix/OpenDKIM integration
- ✅ Key revocation capability
- ✅ Multi-selector support (for rotation)

**Email Autodiscover:**
- ✅ Outlook auto-configuration (Exchange ActiveSync)
- ✅ Apple Mail/iOS/iPad auto-setup
- ✅ Mozilla Thunderbird discovery
- ✅ Android native mail app support
- ✅ SRV records (RFC 6186)
- ✅ Autodiscover XML endpoint (.well-known/autoconfig.xml)
- ✅ HTTPS enforcement (secure autodiscover)
- ✅ Customizable server settings per domain

**SRV Records:**
- ✅ _imap._tcp / _imaps._tcp records
- ✅ _smtp._tcp / _smtps._tcp records
- ✅ _pop3._tcp / _pop3s._tcp records
- ✅ Automatic DNS publishing
- ✅ Load balancing support
- ✅ Fallback servers

**Email Service Management:**
- ✅ Enable/disable email service per customer
- ✅ Soft suspend (keep data, users blocked)
- ✅ Hard delete (permanent mailbox deletion)
- ✅ Data backup before deletion
- ✅ Restore from suspension
- ✅ Audit trail of all service changes
- ✅ Admin-controlled enabling/disabling

**SMTP Error Handling:**
- ✅ Reject invalid recipients at SMTP time (no bounces)
- ✅ 550 error codes during RCPT conversation
- ✅ Recipient validation before acceptance
- ✅ Silent discard option (no bounce)
- ✅ Configurable bounce handling per customer

**Website Sendmail Integration:**
- ✅ PHP mail() function support
- ✅ WordPress/WP Mail SMTP integration
- ✅ Custom sendmail wrapper
- ✅ From: header rewriting (from customer domain)
- ✅ SMTP relay routing
- ✅ DKIM signing for website emails
- ✅ Rate limiting (emails/hour)
- ✅ SMTP authentication (optional)
- ✅ Per-domain sender configuration

**Database Schema:**
- ✅ `email_service_config` (service settings, toggles)
- ✅ `email_dkim_keys` (key management, rotation)
- ✅ `email_autodiscover_config` (autodiscover settings)
- ✅ `email_sendmail_audit_log` (website sendmail audit)
- ✅ `email_service_audit_log` (service change history)

**Customer API Endpoints:**
- ✅ Get email service configuration (GET)
- ✅ Update email service config (PATCH)
- ✅ Get DKIM keys per domain (GET)
- ✅ Rotate DKIM key (POST)
- ✅ Get autodiscover config (GET)
- ✅ Disable email service (POST)
- ✅ Enable email service (POST)
- ✅ Get sendmail statistics (GET)
- ✅ Total: 8 customer endpoints

**Admin API Endpoints:**
- ✅ List all email service configs (GET)
- ✅ Get customer email config (GET)
- ✅ Disable/enable service (PATCH)
- ✅ View sendmail audit log (GET)
- ✅ Validate all DKIM keys (POST)
- ✅ Total: 5 admin endpoints

**Customer Panel Features:**
- ✅ Email service dashboard (status, features, domains)
- ✅ DKIM management page (view key, rotate, verify DNS)
- ✅ Autodiscover configuration page
- ✅ Website sendmail settings (rate limit, auth, bounce handling)
- ✅ Service suspension/deletion modal
- ✅ Sendmail statistics page

**Admin Panel Features:**
- ✅ Global email service overview
- ✅ Service enable/disable per customer
- ✅ Sendmail audit log viewer
- ✅ DKIM key validation and repair
- ✅ Suspension/deletion history

**Security Features:**
- ✅ Vault-encrypted DKIM private keys
- ✅ Key access audit logging
- ✅ Annual key rotation recommended
- ✅ Rate limiting on website sendmail
- ✅ SMTP authentication option
- ✅ IP whitelisting for sendmail pods
- ✅ Bounce rejection (no NDRs)
- ✅ Audit trail (all service changes)

**Implementation Checklist:**
- ✅ Phase 1: DKIM (Weeks 1-2)
- ✅ Phase 2: Autodiscover + SRV records (Weeks 3-4)
- ✅ Phase 3: Service enable/disable (Weeks 5-6)
- ✅ Phase 4: SMTP error handling (Weeks 7-8)
- ✅ Phase 5: Website sendmail (Weeks 9-10)
- ✅ Phase 6: Testing + documentation (Weeks 11-12)

**Compliance:**
- ✅ GDPR: Audit logs, data export, erasure
- ✅ HIPAA: DKIM integrity, key encryption, audit trail
- ✅ SOX: Retention policies, change tracking, sendmail audit

**When to read:** When implementing professional email features, configuring auto-discovery, enabling website sendmail, or managing DKIM

**Filled Critical Gap:** EMAIL_SERVICES.md and WEBMAIL_ACCESS_SPECIFICATION.md lacked DKIM implementation, autodiscover configuration, service suspension, and website sendmail integration — now fully specified with production-ready key management, DNS discovery, and SMTP error handling.

---

### 19. **DATABASE_MANAGEMENT_UI_SPECIFICATION.md** (250+ KB) — `./06-features/DATABASE_MANAGEMENT_UI_SPECIFICATION.md` ⭐ NEW

**Complete web-based database management interface for accessing, editing, importing, and exporting databases**

**Coverage:** Full database lifecycle management:

**Database Browser:**
- ✅ List all customer databases (MariaDB/PostgreSQL)
- ✅ View database statistics (size, tables, rows, charset)
- ✅ Display backup status and history
- ✅ Per-plan database limits (Starter: 2, Business: 5, Premium: 10)

**Table Management:**
- ✅ Browse tables with full structure view
- ✅ View columns, types, indexes, constraints
- ✅ Create new tables (wizard with DDL)
- ✅ Modify table structure (add/edit/drop columns)
- ✅ Manage indexes (add/drop)
- ✅ Edit table options (charset, collation, engine)

**Data Viewer & Editor:**
- ✅ Paginated data display (configurable rows per page)
- ✅ Searchable and sortable rows
- ✅ Inline row editing (modal forms)
- ✅ Add new rows (form validation)
- ✅ Delete rows (with confirmation)
- ✅ Bulk operations (delete multiple rows)
- ✅ Full-text search across all columns

**SQL Console:**
- ✅ Query editor with syntax highlighting
- ✅ Autocomplete for table/column names
- ✅ Query history (searchable, persistent)
- ✅ Execute arbitrary SQL queries
- ✅ Results display (table or raw)
- ✅ Export results (CSV, JSON)
- ✅ Query timeout limits (per plan)

**Import/Export:**
- ✅ Import SQL dumps (file upload or paste)
- ✅ Import CSV (with field mapping)
- ✅ Import JSON (normalized)
- ✅ Export as SQL (full dump with structure)
- ✅ Export as CSV (per table)
- ✅ Export as JSON (per table)
- ✅ Scheduled recurring exports
- ✅ File size limits per plan

**Database User Management:**
- ✅ Create database users (MariaDB/PostgreSQL)
- ✅ Set password (with strength validation)
- ✅ Configure host access (localhost, %, specific IP)
- ✅ Manage permissions (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, GRANT)
- ✅ Preset permission templates (app user, read-only, admin)
- ✅ Reset password (user-initiated or admin-initiated)
- ✅ Delete user (with confirmation)
- ✅ Per-table permissions (advanced)

**Backup Integration:**
- ✅ List available backups (with timestamps)
- ✅ Restore from backup (3 modes: drop/restore, merge, prefix)
- ✅ Point-in-time recovery (daily backups)
- ✅ Verify checksums after restore
- ✅ Automatic optimization post-restore

**Security & Isolation:**
- ✅ Per-customer database isolation (customers can only access their own)
- ✅ Admin access to all databases (with audit logging)
- ✅ All queries logged (user, timestamp, query, result)
- ✅ Encryption at rest (Longhorn volumes)
- ✅ Encryption in transit (TLS for network connections)
- ✅ Query timeout limits (DDoS/runaway query protection)
- ✅ Audit trail of all DDL/DML operations

**Plan-Based Limits:**
- Starter: 2 databases, 25 tables/db, 500 MB storage, 100 MB export, 30 sec timeout
- Business: 5 databases, 100 tables/db, 5 GB storage, 500 MB export, 60 sec timeout
- Premium: 10 databases, Unlimited tables, 25 GB storage, 2 GB export, 120 sec timeout

**API Endpoints:**
- 25+ endpoints for database CRUD operations
- Database access, listing, statistics
- Table operations (create, modify, delete)
- Row operations (insert, update, delete, bulk)
- SQL query execution
- Import/export jobs
- User management
- Backup/restore

**Admin Panel Features:**
- View all customers' databases
- Execute queries on behalf of customers
- Full audit log access
- Database optimization tools (analyze, optimize, repair)
- Restore from backup (advanced options)

**Customer Panel Features:**
- Full CRUD access to own databases
- SQL console for custom queries
- Import/export capability
- Database user management
- Backup restore (limited to own backups)

**When to read:** When implementing database management for customers, supporting multiple database types, enabling data import/export, or building database user management features.

**Implementation Checklist:**
- ✅ Week 1-2: Database browser and structure viewer
- ✅ Week 3: Data editing (CRUD)
- ✅ Week 4: SQL console
- ✅ Week 5: Table editor (DDL)
- ✅ Week 6: Import/export
- ✅ Week 7: Database user management
- ✅ Week 8: Backup integration
- ✅ Week 9: Testing and documentation

---

## 🎯 Quick Start

### For Platform Overview
1. Read `./INFRASTRUCTURE_PLAN.md` (full document)
2. Focus on: Sections 0, 1, 5.6 (geographic sharding), 9.5.7 (restore), 13 (migration)

### For Infrastructure Setup
1. Read `./INFRASTRUCTURE_PLAN.md` Section 14 (cost analysis - Hetzner recommended)
2. Deploy minimal cluster on Hetzner (€50/mo)

### For Regional Resilience
1. Read `./05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md` (overview)
2. Read `./INFRASTRUCTURE_PLAN.md` Section 5.6 (detailed design)
3. Plan multi-region setup using provided architecture

### For Backup & Restore Features
1. Read `./06-features/RESTORE_SPECIFICATION.md` (UI/UX flows, API design)
2. Review `./INFRASTRUCTURE_PLAN.md` Section 9.5.7 (management panel overview)
3. Use implementation checklist for development

### For Multi-Cloud Expansion
1. Read `./05-advanced/MULTI_CLOUD_STRATEGY.md` (full strategy)
2. Follow the 4-phase roadmap

### For Cluster Maintenance & Upgrades
1. Read `./02-operations/CLUSTER_MAINTENANCE_AND_UPGRADES.md` (complete procedures)
2. Review pre-upgrade checklist and runbooks
3. Set up staging cluster for testing upgrades
4. Document your specific maintenance windows
3. Reference Terraform code examples

### For Email Sending Limits & Monitoring
1. Read `./06-features/EMAIL_SENDING_LIMITS_AND_MONITORING.md` (complete specification)
2. Review rate limiting architecture (application + Postfix layers)
3. Review customer & admin monitoring dashboards
4. Deploy policy daemon (Python sidecar in mail pod)
5. Configure Postfix for policy enforcement
6. Set up Prometheus alerts and Grafana dashboards

### For Webmail Access & Configuration
1. Read `./06-features/WEBMAIL_ACCESS_SPECIFICATION.md` (complete specification)
2. Review multi-domain architecture (one Roundcube, multiple domains)
3. Plan webmail domain naming (`webmail.{customer-domain}`)
4. Review SSL certificate automation (cert-manager)
5. Configure Roundcube (IMAP/SMTP backends, plugins, OIDC)
6. Plan customer & admin panel features
7. Set up database schema and API endpoints

### For Admin Email Access & Staff Roles
1. Read "Admin Email Access" section in `./06-features/WEBMAIL_ACCESS_SPECIFICATION.md`
2. Review staff role management system (customizable roles, permissions, approval workflows)
3. Plan staff role structure for your support team (examples provided)
4. Define customer access restrictions (tags, regions, or both)
5. Configure action approval requirements (send/delete need approval?)
6. Set up staff role management UI (create roles, assign staff, overrides)
7. Implement approval workflow (request → review → approve/reject)
8. Configure detailed audit logging for compliance

### For File Transfer (FTP/FTPS/SFTP)
1. Read `./06-features/FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md` (complete specification)
2. Review protocol selection (SSH/SFTP recommended; FTPS for compatibility; FTP disabled by default)
3. Plan deployment topology (OpenSSH + vsftpd pods, load balancer configuration)
4. Review security model (chroot isolation, encryption, audit logging)
5. Plan user management (per-customer users, quotas, permissions)
6. Review quota enforcement (storage + bandwidth limits)
7. Set up database schema (5 tables for users, audit log, sessions, events)
8. Implement API endpoints (10 customer + 5 admin endpoints)
9. Build customer UI (user management, connection info, file browser, audit log)
10. Configure monitoring and alerts (suspicious activity, quota warnings, failed logins)
11. Test security isolation (chroot jail, cross-customer access prevention)

### For Mailbox Import/Export (IMAP Migration)
1. Read `./06-features/MAILBOX_IMPORT_EXPORT_SPECIFICATION.md` (complete specification)
2. Review IMAP workflows (create new account, merge, incremental sync, scheduled sync)
3. Plan OAuth2 integration (Gmail, Outlook; no password storage)
4. Review credential encryption (Vault transit, auto-deletion)
5. Understand deduplication strategy (Message-ID + content hash)
6. Plan folder mapping and conflict resolution
7. Set up database schema (4 tables: jobs, credentials, audit log, dedup cache)
8. Implement API endpoints (9 customer + 3 admin endpoints)
9. Build job wizard UI (workflow, IMAP config, folder mapping, options, scheduling)
10. Build job progress page (real-time updates, pause/resume, audit log)
11. Configure job worker pods (stateless, horizontally scalable)
12. Test IMAP connections with various providers (Gmail, Outlook, cPanel, Plesk)
13. Test deduplication and resume capability

### For Web Application Firewall (WAF)
1. Read `./06-features/WEB_APPLICATION_FIREWALL_SPECIFICATION.md` (complete specification)
2. Review three operational modes (OFF, DETECTION_ONLY, ON)
3. Plan rule exclusion strategy (by rule ID, tag, or regex pattern)
4. Understand OWASP CRS v4.0 ruleset structure and rule IDs (941xxx=SQLi, 942xxx=RFI/LFI, etc.)
5. Set up database schema (5 tables: config, exclusions, request log, alerts, audit log)
6. Deploy ModSecurity v3 module in NGINX
7. Configure rule set loading and customer exclusions
8. Implement API endpoints (14 customer + 5 admin endpoints)
9. Build WAF settings page (mode selector, paranoia level, config options)
10. Build rule exclusions manager (add/edit/delete, auto-expire, safety warnings)
11. Build WAF logs viewer (advanced filtering, export, attack analytics)
12. Configure monitoring and alerting (block rate, processing time, attack patterns)
13. Create rollout procedure (Week 1: DETECTION_ONLY → analyze → Week 2: tune rules → Week 3: ON)
14. Test with actual attack patterns (SQLi, XSS, scanner detection)

### For Hosting Settings (Domain Configuration)
1. Read `./06-features/HOSTING_SETTINGS_SPECIFICATION.md` (complete specification)
2. Understand redirect rule priority (disable → external → https → www → serve)
3. Plan NGINX config generation system (per-domain rule application)
4. Set up database schema (4 tables: config, audit log, validation log, stats)
5. Implement path validation (security: symlink escape, traversal, permissions)
6. Implement conflict detection (prevent incompatible settings)
7. Set up configuration caching (Redis/memory with version-based invalidation)
8. Implement API endpoints (12 customer + 4 admin endpoints)
9. Build hosting settings page (enable/disable, redirects, forwarding, webroot)
10. Build webroot path selector UI (directory browser, validation feedback)
11. Build configuration history page (audit trail of all changes)
12. Implement NGINX rule application (dynamic rewrite rules per domain)
13. Configure monitoring (config changes, redirect latency, disabled domains)
14. Test each redirect mode (WWW, HTTPS, external, disabled, webroot changes)

### For Email Service Enhancements (DKIM, Autodiscover, Sendmail)
1. Read `./06-features/EMAIL_ENHANCEMENTS_SPECIFICATION.md` (complete specification)
2. Plan DKIM key generation, rotation, and Vault encryption
3. Understand DKIM lifecycle (ACTIVE → DEPRECATED → deprecated)
4. Set up Postfix/OpenDKIM integration for email signing
5. Plan autodiscover implementation (SRV records + XML endpoint)
6. Set up database schema (5 tables: service config, DKIM keys, autodiscover, sendmail audit, service audit)
7. Implement service enable/disable logic (soft suspend vs hard delete)
8. Implement SMTP error handling (reject invalid recipients at RCPT time)
9. Configure website sendmail integration (PHP mail wrapper, SMTP routing)
10. Implement API endpoints (8 customer + 5 admin endpoints)
11. Build email service dashboard (status, features, domain list)
12. Build DKIM management page (view key, rotate, DNS publishing)
13. Build website sendmail settings (rate limit, allowed domains, bounce handling)
14. Configure rate limiting and audit logging for all sendmail
15. Test DKIM signing (verify signatures in email headers)
16. Test autodiscover with clients (Outlook, Thunderbird, iOS)
17. Test service suspension/deletion (with backup and restore)

---

## 🏗️ Architecture Summary

### Geographic Sharding Model

The platform uses **geographic sharding** to distribute clients across multiple independent cloud regions (Hetzner Frankfurt, OVH Strasbourg, Linode Ashburn, Hetzner Singapore). Each client is assigned to a home region based on their billing country, admin override, or capacity availability. All regions share the same management database via pglogical replication, but each region's k3s cluster runs independently — a full regional outage affects only that region's clients. A centralised PowerDNS instance in Frankfurt acts as the DNS master, with AXFR slaves in each additional region providing local query serving and resilience. Client migration between regions is admin-triggered and takes effect after a 60-second DNS TTL drain (ADR-014). Full specification: `05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md` and `05-advanced/MULTI_CLOUD_STRATEGY.md`.

### Key Features
- ✅ Each region completely independent (can operate for weeks alone)
- ✅ Multi-master database (all regions can write)
- ✅ Application-level conflict resolution
- ✅ DNS caching (continues working if sync fails)
- ✅ Per-region backups + cross-region sync
- ✅ Client auto-failover (< 60 min RTO)
- ✅ Zero-downtime DNS updates
- ✅ Full Management API in every region

---

## 📊 Deployment Roadmap

### Phase 1: Single Cloud (Months 0-3)
- Deploy to Hetzner Frankfurt only
- Cost: €50/mo
- Clients: 0-100
- SLA: Best effort

### Phase 2: Primary + Standby (Months 3-6)
- Add OVH Strasbourg warm standby
- Cost: €90/mo
- Clients: 50-150
- SLA: 15-60 min failover

### Phase 3: Geographic Distribution (Months 6-12)
- Add Linode US + Hetzner APAC
- Cost: €180-250/mo
- Clients: 120-300
- SLA: Regional redundancy

### Phase 4: Full Disaster Recovery (Months 12+)
- Full multi-region with real-time replication
- Cost: €300-400/mo
- Clients: 300+
- SLA: 99.95%+ (automatic failover)

---

## 🔑 Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **K8s Distribution** | k3s | Lightweight, resource-efficient, ideal for learning |
| **VPS Provider** | Hetzner Cloud | Best price (€50/mo), K8s-friendly, EU-compliant |
| **OS** | Debian 13 | Lightweight, cutting-edge stable |
| **Database Strategy** | Multi-master PostgreSQL | All regions can write, app-level conflict resolution |
| **DNS** | Three flexible modes | **Primary** (full delegation), **CNAME** (customer DNS), **Secondary** (backup DNS) |
| **DNS Infrastructure** | Centralized PowerDNS | Primary in Frankfurt, replicas everywhere, supports all three modes |
| **Regional Backups** | External SFTP servers | Each region independent, cross-region sync nightly |
| **Management API** | Full replicas everywhere | No single point of failure |
| **OIDC** | Dex | Lightweight, low overhead |
| **Secrets** | Sealed Secrets | GitOps-friendly, self-hosted |
| **WAF** | ModSecurity | Industry standard, NGINX integrated |

---

## 📈 Expected Growth

| Month | Clients | Revenue | Infrastructure Cost | Margin |
|---|---|---|---|---|
| 1 | 7 | $60 | €50 | -17% |
| 3 | 42 | $380 | €50 | 83% |
| 6 | 120 | $1,100 | €90 | 91% |
| 12 | 272 | $2,600 | €180 | 93% |
| 18 | 400 | $3,800 | €250 | 93% |
| 24 | 600+ | $5,000+ | €350 | 93%+ |

---

## ✅ What's Included

### Platform Features
- ✅ Dedicated pod per client (all plans, ADR-024)
- ✅ Namespace-level isolation (`client-{id}` per client)
- ✅ Centralized workload catalog (Apache+PHP, Node, Python, Ruby, Java, .NET, static)
- ✅ Application catalog (Nextcloud, Jitsi, BigBlueButton, Gitea, Mattermost, etc.)
- ✅ Hybrid email (self-hosted + external provider option)
- ✅ Webmail (Roundcube with OIDC + app passwords)
- ✅ SFTP + Git deploy + web file manager
- ✅ cert-manager with Let's Encrypt (automated SSL)
- ✅ fail2ban (intrusion prevention)
- ✅ WAF (ModSecurity, optional)
- ✅ Password-protected directories (HTTP Basic Auth with user/password management)
- ✅ Zero-downtime web server/PHP version switching (Apache ↔ NGINX, PHP 8.3 ↔ 8.4)

### Migration Support
- ✅ Native Plesk migration (API + SSH)
- ✅ Native cPanel migration (API + SSH)
- ✅ Native Virtualmin migration (RPC + SSH)
- ✅ Automated data extraction (files, databases, email, DNS, SSL)
- ✅ Automated client re-provisioning
- ✅ Zero-downtime DNS cutover

### Monitoring & Operations
- ✅ Prometheus + Grafana (metrics)
- ✅ Loki (log aggregation)
- ✅ Alertmanager (alerting)
- ✅ Notification service (event-driven emails)
- ✅ Health monitoring per region
- ✅ Backup verification

### Cost Optimization
- ✅ Resource overcommit (Burstable QoS)
- ✅ Scale-to-zero for idle clients (KEDA)
- ✅ ResourceQuota-based plan differentiation
- ✅ Transparent pricing (no bandwidth surprises)

---

## 🚀 Implementation Checklist

### Immediate (Week 1)
- [ ] Review all 5 documentation files (including RESTORE_SPECIFICATION.md)
- [ ] Create Hetzner account
- [ ] Deploy initial k3s cluster (Frankfurt)
- [ ] Set up Longhorn storage
- [ ] Configure external SFTP backup

### Short Term (Weeks 2-4)
- [ ] Install Management API
- [ ] Deploy admin + client panels
- [ ] Set up PowerDNS
- [ ] Implement Migration Service
- [ ] Build granular restore backend (API endpoints)
- [ ] Test Plesk migration (pilot)

### Medium Term (Months 2-3)
- [ ] Implement restore UI components (version selector, file browser, progress screen)
- [ ] Build WebSocket progress tracking for restores
- [ ] Migrate 10-20 clients from Plesk
- [ ] Deploy OVH Strasbourg (warm standby)
- [ ] Set up nightly backup sync
- [ ] Test failover procedures
- [ ] Test restore workflows (all object types)

### Long Term (Months 4-12)
- [ ] Deploy US region (Linode)
- [ ] Implement geographic routing
- [ ] Deploy APAC region (optional)
- [ ] Implement real-time replication
- [ ] Add advanced restore features (scheduled restores, bulk operations)
- [ ] Achieve 99.95%+ SLA

---

## 📖 Reading Order

### Phase 0: Before You Start (GitHub Setup)
1. **PHASE_1_ROADMAP.md** (`./04-deployment/PHASE_1_ROADMAP.md`, 32 KB, 20 min) - Overview of 12-week plan
2. **GITHUB_INTEGRATION_SUMMARY.md** (`./04-deployment/GITHUB_INTEGRATION_SUMMARY.md`, 20 KB, 15 min) - Set up GitHub repository
3. **ADMIN_PANEL_REQUIREMENTS.md** (`./02-operations/ADMIN_PANEL_REQUIREMENTS.md`, 55 KB, 30 min) - What to build (admin panel)

### First Time (Platform Understanding)
1. **GEOGRAPHIC_SHARDING_SUMMARY.md** (`./05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md`, 11 KB, 5 min) - Understand the regional model
2. **INFRASTRUCTURE_PLAN.md** (`./INFRASTRUCTURE_PLAN.md` Sections 0, 1, 5, 30 min) - Core concepts

### Deep Dive (Complete Design)
1. **INFRASTRUCTURE_PLAN.md** (`./INFRASTRUCTURE_PLAN.md`) - Full document (all sections)
2. **ADMIN_PANEL_REQUIREMENTS.md** (`./02-operations/ADMIN_PANEL_REQUIREMENTS.md`) - Admin panel feature list (100+ features)
3. **RESTORE_SPECIFICATION.md** (`./06-features/RESTORE_SPECIFICATION.md`) - Granular backup restore design
4. **MULTI_CLOUD_STRATEGY.md** (`./05-advanced/MULTI_CLOUD_STRATEGY.md`) - Multi-cloud expansion
5. **GEOGRAPHIC_SHARDING_SUMMARY.md** (`./05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md`) - Regional details

### Implementation (Start Building)
1. **PHASE_1_ROADMAP.md** (`./04-deployment/PHASE_1_ROADMAP.md`) - Week-by-week tasks and GitHub setup
2. **ADMIN_PANEL_REQUIREMENTS.md** (`./02-operations/ADMIN_PANEL_REQUIREMENTS.md`) - Build admin panel features (Sections 1-16)
3. **GITHUB_INTEGRATION_SUMMARY.md** (`./04-deployment/GITHUB_INTEGRATION_SUMMARY.md`) - Set up CI/CD workflows
4. **RESTORE_SPECIFICATION.md** (`./06-features/RESTORE_SPECIFICATION.md`) - Restore backend & frontend (Week 5-6)
5. **CONFLICT_RESOLUTION_MATRIX.md** (`./05-advanced/CONFLICT_RESOLUTION_MATRIX.md`) - Database rules (Phase 2+)
6. **GEOGRAPHIC_SHARDING_SUMMARY.md** (`./05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md`) - Regional failover (Phase 2+)

---

## ❓ Questions?

All key clarifications are documented:

### **Multi-Master Database**
See: `./05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md` → "Conflict Resolution Examples"

### **PowerDNS Architecture & DNS Modes**
See: 
- `./INFRASTRUCTURE_PLAN.md` Section 5.6.4 → "Centralized PowerDNS with Regional Caching"
- `./01-core/POWERDNS_INTEGRATION.md` → Complete PowerDNS setup & configuration
- `./01-core/DNS_MODE_SELECTION.md` → **NEW** — Three DNS modes (Primary, CNAME, Secondary)

### **Regional Independence**
See: `./05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md` → "What Still Works If..."

### **Client Failover**
See: `./INFRASTRUCTURE_PLAN.md` Section 5.6.7 → "Regional Failover and Client Re-Deployment"

### **Backup Strategy**
See: `./INFRASTRUCTURE_PLAN.md` Section 5.6.5 → "Per-Region External Backup Storage"

### **Granular Restore Features**
See: `./06-features/RESTORE_SPECIFICATION.md` → "Overview" & "Part 1-7" (complete workflows)

### **Restore API Design**
See: `./06-features/RESTORE_SPECIFICATION.md` → "Part 10: API Reference Summary"

### **Restore UI Components**
See: `./06-features/RESTORE_SPECIFICATION.md` → "Part 7: UI Components" (mockups & specifications)

### **Cost Analysis**
See: `./INFRASTRUCTURE_PLAN.md` Section 14 → "Cost Analysis"

---

## 📝 File Manifest

### Root Documents

| File | Description |
|------|-------------|
| `README.md` | This file — platform overview, architecture summary, quick-start index |
| `QUICKSTART.md` | Fast-path setup guide for getting the platform running locally and in staging |
| `INFRASTRUCTURE_PLAN.md` | Master architecture document — all sections, decisions, and cross-references |
| `DATABASE_SCHEMA.md` | Full PostgreSQL + MariaDB schema DDL for all platform tables |
| `ARCHITECTURE_DECISION_RECORDS.md` | ADR-001 through ADR-014 — architectural decisions with rationale and consequences |
| `AUTHORIZATION_MATRIX.md` | Role-based access control matrix for all API endpoints and panel features |
| `API_ERROR_HANDLING.md` | Standard error response format, HTTP status codes, error code catalogue |
| `API_PAGINATION_STRATEGY.md` | Cursor-based and offset pagination conventions for all list endpoints |
| `CACHING_STRATEGY.md` | Redis caching layers, TTLs, cache invalidation patterns |
| `SECRETS_MANAGEMENT.md` | Sealed Secrets workflow, Vault integration, secret rotation schedule |
| `EVENT_LOGGING_STRATEGY.md` | Audit log schema, event type catalogue, Loki integration |
| `TESTING_STRATEGY.md` | Unit, integration, e2e, load test approach; coverage targets; CI gate rules |
| `SLI_SLO_DEFINITION.md` | Service Level Indicators and Objectives per service; error budget policy |
| `DEPENDENCIES_AND_RISKS.md` | External dependency inventory; risk register with mitigations |
| `FRONTEND_DEPLOYMENT_ARCHITECTURE.md` | Admin and client panel build, CDN, Vite config, static serving |
| `FRONTEND_INGRESS_CONFIGURATIONS.md` | NGINX Ingress rules for admin panel, client panel, and API |
| `IMPLEMENTATION_ANALYSIS_AND_RECOMMENDATIONS.md` | Gap analysis and implementation priority recommendations |
| `MARIADB_MIGRATION_SUMMARY.md` | Summary of the MariaDB vs PostgreSQL split decision and migration steps |
| `REORGANIZATION_INSTRUCTIONS.md` | Instructions for the documentation reorganization structure |

### 01-core/ — Platform Core Architecture

| File | Description |
|------|-------------|
| `BILLING_MODEL_CHANGES.md` | External billing integration model; plan tier pricing; billing event flow |
| `DISPERSED_DNS_ARCHITECTURE.md` | Multi-A record DNS load balancing with NGINX DaemonSet (ADR-010 detail) |
| `DNS_MODE_SELECTION.md` | Three DNS modes: Primary, CNAME, Secondary — selection logic and client UX |
| `DNS_ZONE_TEMPLATES.md` | Default DNS zone templates for each DNS mode; record type defaults |
| `EXTERNAL_BILLING_INTEGRATION.md` | Webhooks, billing system integration API, invoice sync, plan-change flow |
| `HOSTING_PLANS.md` | Plan tier definitions (Starter, Business, Premium); resource limits; add-ons |
| `PLATFORM_ARCHITECTURE.md` | High-level architecture overview with component diagram |
| `POWERDNS_INTEGRATION.md` | PowerDNS REST API integration; zone management; AXFR replication config |
| `SHARED_POD_IMPLEMENTATION.md` | Superseded by ADR-024 — historical reference only |
| `WEB_SERVER_PHP_VERSION_SWITCHING.md` | PHP version switching mechanism; catalog image change workflow |
| `WORKLOAD_DEPLOYMENT.md` | Client workload types (dedicated pods for all plans); deployment triggers; rollout strategy |

### 02-operations/ — Day-to-Day Operations

| File | Description |
|------|-------------|
| `ADMIN_PANEL_REQUIREMENTS.md` | Full admin panel feature specification with API endpoints per section |
| `BACKUP_EXPORT_MIGRATION_GUIDE.md` | Client-facing backup export and self-service data migration guide |
| `BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md` | Technical implementation of backup jobs, SSHFS mounts, retention policy |
| `BACKUP_STRATEGY.md` | Backup scope, frequency, storage topology, restore SLAs |
| `CLIENT_PANEL_FEATURES.md` | Client self-service panel feature list and UI requirements |
| `CLUSTER_MAINTENANCE_AND_UPGRADES.md` | k3s upgrade procedure, node drain/cordon, rolling update strategy |
| `HA_MIGRATION_RUNBOOK.md` | Step-by-step runbook to upgrade single-instance services to HA |
| `INFRASTRUCTURE_SIZING.md` | Node sizing recommendations by client count; capacity planning formulas |
| `MONITORING_OBSERVABILITY.md` | Prometheus, Grafana, Loki, Alertmanager setup; dashboard inventory |
| `NODE_RUNTIME_SPECIFICATION.md` | Node.js workload runtime spec; Business/Premium plan requirement |
| `REQUIREMENTS_UPDATE_SUMMARY.md` | Changelog of significant requirement changes from initial spec |
| `STORAGE_DATABASES.md` | Longhorn storage configuration; shared MariaDB + PostgreSQL instance specs |

### 03-security/ — Security Architecture

| File | Description |
|------|-------------|
| `COMPLIANCE_MATRIX.md` | GDPR, SOC 2, ISO 27001 control mapping; data residency requirements |
| `DATABASE_ACCESS_CONTROL.md` | Database user roles, NetworkPolicy rules, per-client credential isolation |
| `SECURITY_ARCHITECTURE.md` | Platform-wide security model; threat model; attack surface analysis |
| `TLS_CERTIFICATE_MANAGEMENT.md` | cert-manager setup; DNS-01 and HTTP-01 challenge flows; wildcard cert policy |

### 04-deployment/ — Deployment & Operations

| File | Description |
|------|-------------|
| `CICD_PIPELINE_REQUIREMENTS.md` | All GitHub Actions workflows — backend CI, frontend CI, staging deploy, production deploy, security scanning |
| `DEPLOYMENT_PROCESS.md` | Deployment flow for client workloads; blue/green; rollback procedure |
| `GITHUB_INTEGRATION_SUMMARY.md` | Monorepo structure, branch protection, secrets, issue templates, project board |
| `INCIDENT_RESPONSE_RUNBOOK.md` | On-call runbook; severity levels; escalation matrix; common incident playbooks |
| `MANAGEMENT_API_SPEC.md` | OpenAPI-style spec for the management API — all endpoints, request/response schemas |
| `PHASE_1_ROADMAP.md` | 12-week Phase 1 plan with 65 GitHub Issues, Terraform setup, CI/CD pipeline |
| `SUBSCRIPTION_EXPIRY_NOTIFICATIONS.md` | Email notification schedule for subscription expiry; grace period policy |

### 05-advanced/ — Advanced Architecture Topics

| File | Description |
|------|-------------|
| `CONFLICT_RESOLUTION_MATRIX.md` | Multi-master PostgreSQL conflict resolution rules per table, with trigger implementations |
| `DISASTER_RECOVERY.md` | DR runbook; RTO/RPO targets; full cluster rebuild procedure |
| `GEOGRAPHIC_SHARDING_SUMMARY.md` | Multi-region architecture; client assignment algorithm; conflict resolution examples |
| `IPV4_IPV6_REQUIREMENTS.md` | Complete IPv4/IPv6 dual-stack specification — k3s config, CNI, DNS, monitoring, testing |
| `MULTI_CLOUD_STRATEGY.md` | Multi-provider strategy; Phase 1/2/3 setup; cost analysis; geographic client assignment |
| `MULTI_REGION_ADMIN_AND_COHOSTING.md` | Multi-region admin panel architecture; co-hosting add-on; volume ownership transfer |

### 06-features/ — Feature Specifications

| File | Description |
|------|-------------|
| `AI_WEBSITE_EDITOR.md` | AI-powered site editor feature spec (Phase 2+) |
| `APPLICATION_CATALOG.md` | One-click application catalog — supported apps, Helm chart management, instance lifecycle |
| `CUSTOMER_CRON_JOBS.md` | Cron job management — Kubernetes CronJob per client; limits; management UI |
| `DATABASE_MANAGEMENT_UI_SPECIFICATION.md` | Web-based database manager (phpMyAdmin/pgAdmin equivalent) feature spec |
| `EMAIL_DELIVERABILITY.md` | SPF, DKIM, DMARC setup; reputation management; spam score monitoring |
| `EMAIL_ENHANCEMENTS_SPECIFICATION.md` | Advanced email features — aliases, catch-all, autoresponders, filters |
| `EMAIL_SENDING_LIMITS_AND_MONITORING.md` | Per-account hourly/daily sending limits; abuse detection; Postfix integration |
| `EMAIL_SERVICES.md` | Docker-Mailserver architecture; Dovecot/Postfix config; Roundcube integration |
| `FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md` | SFTP/FTPS file transfer feature spec; per-client isolation; key auth |
| `HOSTING_SETTINGS_SPECIFICATION.md` | Client-configurable hosting settings — .htaccess, PHP ini, redirects, GZip |
| `MAILBOX_IMPORT_EXPORT_SPECIFICATION.md` | Mailbox migration import/export — MBOX, EML formats; IMAP migration |
| `PASSWORD_PROTECTED_DIRECTORIES.md` | HTTP Basic Auth directory protection — htpasswd management; admin and client UI |
| `PHP_COMPOSER_SUPPORT.md` | Composer integration — composer.json detection; package install on deploy |
| `RESTORE_SPECIFICATION.md` | Full restore feature spec — website, database, mail, file restore; WebSocket progress |
| `WEB_APPLICATION_FIREWALL_SPECIFICATION.md` | WAF feature spec — ModSecurity/Coraza rules; custom rule management; admin UI |
| `WEBMAIL_ACCESS_SPECIFICATION.md` | Roundcube webmail integration; custom webmail domain; OIDC login |

### 07-reference/ — Reference Documents

| File | Description |
|------|-------------|
| `FAQ.md` | Frequently asked questions about platform design decisions |
| `MIGRATION_PLAN.md` | Phased Plesk → Kubernetes migration plan; rollback procedure; client communication |
| `TECH_STACK_SUMMARY.md` | Condensed technology stack reference card |
| `TERMINOLOGY.md` | Glossary of platform-specific terms and abbreviations |

### 08-admin-panel-mockups/ — Admin Panel Design

| File | Description |
|------|-------------|
| `ADMIN_PANEL_MOCKUP_GUIDE.md` | Guide to reading and using the admin panel mockup files |
| `FILE_MANIFEST.md` | Inventory of all mockup files and their corresponding panel sections |
| `INTERACTIVE_MOCKUP_GUIDE.md` | Instructions for running/viewing interactive mockups |
| `KEY_PAGES_SPECIFICATION.md` | Detailed spec for the most critical admin panel pages |
| `README.md` | Admin panel mockups section overview |

---

## 🎓 Learning Path

### For Architects
- Read: All sections of `./INFRASTRUCTURE_PLAN.md`
- Focus: Sections 0, 1, 4, 5, 12
- Time: 2-3 hours

### For DevOps Engineers
- Read: `./INFRASTRUCTURE_PLAN.md` (Sections 5, 6, 7, 8, 14)
- Read: `./05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md` (failover procedures)
- Time: 3-4 hours

### For Frontend Developers
- Read: `./INFRASTRUCTURE_PLAN.md` Section 9 (management panels)
- Focus: UI/UX specs, tech stack, performance targets
- Time: 1-2 hours

### For DevOps + Platform Engineers
- Read: Everything (all documents)
- Focus: Implementation details, monitoring, migration
- Time: 5-6 hours

---

**Status:** ✅ Planning phase complete. Ready for implementation.

**Next Step:** Choose your focus (infrastructure setup, migration service, frontend, or restore features) and begin implementation.

---

**Document Index Version:** 2.0 (Added DATABASE_MANAGEMENT_UI_SPECIFICATION.md, MULTI_REGION_ADMIN_AND_COHOSTING.md, and updated INFRASTRUCTURE_PLAN.md Section 5.6.11; Previous: CUSTOMER_CRON_JOBS.md, EMAIL_SENDING_LIMITS_AND_MONITORING.md, WEBMAIL_ACCESS_SPECIFICATION.md, FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md, MAILBOX_IMPORT_EXPORT_SPECIFICATION.md, WEB_APPLICATION_FIREWALL_SPECIFICATION.md, HOSTING_SETTINGS_SPECIFICATION.md, EMAIL_ENHANCEMENTS_SPECIFICATION.md)
**Last Updated:** 2026-03-01
**Maintained By:** Platform Team
